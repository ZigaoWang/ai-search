require('dotenv').config();  // Load environment variables from .env
const express = require('express');
const axios = require('axios');
const util = require('util');
const sleep = util.promisify(setTimeout);

const app = express();
const port = process.env.PORT || 3000;

// Add middleware to parse JSON bodies
app.use(express.json());

// Enable CORS for all routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Serve static files from 'public' directory
app.use(express.static('public'));

// Semantic Scholar API endpoint for paper search
const SEMSCHOLAR_BASE_URL = 'https://api.semanticscholar.org/graph/v1/paper/search';

// Use the new UniAPI endpoint for chat completions
const OPENAI_BASE_URL = 'https://api.uniapi.io/v1/chat/completions';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // Ensure your .env file has your UniAPI key

// Configure logging
const logLevels = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
};

const currentLogLevel = process.env.LOG_LEVEL ? 
  logLevels[process.env.LOG_LEVEL.toUpperCase()] : 
  logLevels.INFO;

function logger(level, ...args) {
  if (logLevels[level.toUpperCase()] <= currentLogLevel) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level.toUpperCase()}]`, ...args);
  }
}

/**
 * Searches Semantic Scholar for papers matching the query.
 * Retries if rate-limited.
 *
 * @param {string} query - The search query.
 * @param {number} limit - Number of results to fetch.
 * @param {number} retries - Number of retries if rate-limited.
 * @returns {Promise<Array>} - Resolves to an array of paper objects.
 */
async function searchPapers(query, limit = 5, retries = 3) {
  logger('INFO', `Searching Semantic Scholar for: "${query}" (limit: ${limit})`);
  
  try {
    logger('DEBUG', `Making request to Semantic Scholar API`);
    const response = await axios.get(SEMSCHOLAR_BASE_URL, {
      params: {
        query: query,
        limit: limit,
        fields: "paperId,title,authors,year,abstract,citationCount,referenceCount"
      }
    });

    if (response.status === 200 && response.data && response.data.data) {
      const papers = response.data.data;
      logger('INFO', `Found ${papers.length} papers matching query`);
      logger('DEBUG', `Paper titles: ${papers.map(p => p.title).join(', ')}`);
      return papers;
    } else {
      logger('ERROR', `Unexpected response from Semantic Scholar API`, response.status, response.data);
      throw new Error("Error: Unable to fetch data from Semantic Scholar API.");
    }
  } catch (error) {
    if (error.response && error.response.status === 429 && retries > 0) {
      logger('WARN', `Rate limit reached (429). Retrying in 3 seconds... (${retries} retries left)`);
      await sleep(3000);
      return searchPapers(query, limit, retries - 1);
    } else {
      logger('ERROR', `Semantic Scholar API error:`, error.message);
      throw error;
    }
  }
}

/**
 * Calls the UniAPI (OpenAI) endpoint to decide whether the query can be answered internally.
 * The prompt forces a JSON response in one of two forms:
 *  - { "canAnswer": true, "answer": "<your answer>" }
 *  - { "canAnswer": false, "queryWord": "<suggested keyword>" }
 *
 * @param {string} question - The user question.
 * @returns {Promise<Object>} - Resolves to the parsed JSON result.
 */
async function decideAnswer(question) {
  logger('INFO', `Determining if question can be answered internally: "${question}"`);
  
  const prompt = `
You are an expert AI assistant. Determine if you can answer the following question using your internal knowledge without needing external citations.

IMPORTANT: Be very conservative in your assessment. If you have even the slightest doubt about providing a complete, accurate answer without citations, respond with canAnswer: false.

Return ONLY raw, parseable JSON in one of these two formats:
1. {"canAnswer": true, "answer": "your answer here"}
2. {"canAnswer": false, "queryWord": "suggested search keyword"}

Do not include backticks, markdown formatting, or any other text.
Question: "${question}"
`;

  try {
    logger('DEBUG', `Making request to OpenAI API for decision`);
    const response = await axios.post(OPENAI_BASE_URL, {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are a helpful assistant. Always provide raw JSON without backticks or markdown." },
        { role: "user", content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 300,
    }, {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      }
    });

    // Clean any markdown formatting from the response
    let reply = response.data.choices[0].message.content.trim();
    logger('DEBUG', `Raw OpenAI response: ${reply}`);
    
    // Remove markdown code blocks if present
    reply = reply.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
    
    try {
      const parsedResponse = JSON.parse(reply);
      logger('INFO', `Decision: ${parsedResponse.canAnswer ? 'Can answer internally' : 'Needs external research'}`);
      if (!parsedResponse.canAnswer) {
        logger('INFO', `Suggested search term: "${parsedResponse.queryWord}"`);
      }
      return parsedResponse;
    } catch (parseError) {
      logger('ERROR', `Failed to parse AI response as JSON:`, reply);
      throw new Error("Invalid JSON response from OpenAI API");
    }
  } catch (error) {
    logger('ERROR', `OpenAI API error:`, error.message);
    throw new Error("OpenAI API error: " + error.message);
  }
}

/**
 * Generates a comprehensive answer with citations using a two-step process:
 * 1. Analyze papers and extract key points
 * 2. Generate answer using only the extracted information
 * 
 * @param {string} question - The original question.
 * @param {Array} citations - Array of citation objects.
 * @returns {Promise<Object>} - The generated answer, analysis, and citation mapping.
 */
async function generateAnswerWithCitations(question, citations) {
  logger('INFO', `Generating answer with citations for question: "${question}"`);
  logger('INFO', `Processing ${citations.length} citations`);
  
  // Extract key information from each citation
  const citationsWithKeys = citations.map((citation, index) => {
    // Create a unique citation key based on first author's last name and year
    const authorLastName = citation.authors && citation.authors.length > 0 
      ? citation.authors[0].split(' ').pop() 
      : 'Unknown';
    const citationKey = `${authorLastName}${citation.year || ''}`;
    
    return {
      ...citation,
      citationKey,
      index: index + 1
    };
  });

  logger('DEBUG', `Created citation keys: ${citationsWithKeys.map(c => c.citationKey).join(', ')}`);

  // Format citations for the prompt
  const citationsText = citationsWithKeys.map((citation) => {
    return `Citation [${citation.citationKey}]:
Title: ${citation.title}
Abstract: ${citation.abstract}
Authors: ${citation.authors.join(', ')}
Year: ${citation.year}
Key Points: Please extract 3-5 key points from this paper relevant to the question.
`;
  }).join('\n\n');

  // First prompt: Extract and understand the key information from papers
  const analysisPrompt = `
You are a professional academic researcher analyzing scientific papers. Your task is to:
1. Carefully read each paper abstract below
2. Extract the most relevant information to the question: "${question}"
3. For each paper, identify 3-5 key claims or findings that address the question
4. Note any limitations or contradictions between papers

${citationsText}

Format your analysis as follows:
PAPER ANALYSIS:
[CitationKey1]: 
- Key finding 1
- Key finding 2
...

[CitationKey2]:
...

SYNTHESIS:
Briefly summarize how these papers collectively address the question.
`;

  try {
    // First API call: Analyze the papers
    logger('INFO', `STEP 1/2: Analyzing papers and extracting key information`);
    logger('DEBUG', `Sending analysis prompt to OpenAI`);
    
    const analysisResponse = await axios.post(OPENAI_BASE_URL, {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are a professional scientific researcher with expertise in analyzing academic papers." },
        { role: "user", content: analysisPrompt }
      ],
      temperature: 0.2,
      max_tokens: 1500,
    }, {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      }
    });

    const paperAnalysis = analysisResponse.data.choices[0].message.content;
    logger('INFO', `Paper analysis complete (${paperAnalysis.length} characters)`);
    logger('DEBUG', `Paper analysis: ${paperAnalysis.substring(0, 500)}...`);

    // Second prompt: Generate the final answer with proper citations
    const answerPrompt = `
You are writing an academic response to the question: "${question}"

You must use the following paper analysis to craft your response:
${paperAnalysis}

Important requirements:
1. Every claim must be supported by a specific citation using the format [AuthorYear] inline
2. Only include information that is directly supported by the papers in the analysis
3. Do not introduce new information not found in the papers
4. Maintain academic rigor and precision
5. Include a properly formatted Works Cited section at the end using MLA format
6. Structure your answer with clear sections and paragraphs

The citation keys to use are: ${citationsWithKeys.map(c => `[${c.citationKey}]`).join(', ')}
`;

    // Second API call: Generate the final answer
    logger('INFO', `STEP 2/2: Generating final answer with proper citations`);
    logger('DEBUG', `Sending answer prompt to OpenAI`);
    
    const answerResponse = await axios.post(OPENAI_BASE_URL, {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are a professional academic writer crafting a response based solely on provided research." },
        { role: "user", content: answerPrompt }
      ],
      temperature: 0.3,
      max_tokens: 1500,
    }, {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      }
    });

    const finalAnswer = answerResponse.data.choices[0].message.content;
    logger('INFO', `Answer generation complete (${finalAnswer.length} characters)`);
    
    // Final answer with proper citations
    logger('INFO', `Answer generation process complete`);
    return {
      answer: finalAnswer,
      analysis: paperAnalysis,
      citationMapping: citationsWithKeys.map(c => ({ 
        key: c.citationKey, 
        title: c.title,
        authors: c.authors,
        year: c.year,
        link: c.link
      }))
    };
  } catch (error) {
    logger('ERROR', `OpenAI API error in generating answer:`, error.message);
    throw new Error("Failed to generate answer with citations: " + error.message);
  }
}

/**
 * Process a question through the research pipeline
 * 
 * @param {string} question - The user question
 * @returns {Promise<Object>} - The result object with answer and metadata
 */
async function processQuestion(question) {
  logger('INFO', `Starting research process for question: "${question}"`);
  
  try {
    // Step 1: Determine if the question can be answered internally
    logger('INFO', `PROCESS STAGE 1: Evaluating question scope`);
    const decision = await decideAnswer(question);
    
    if (decision.canAnswer) {
      logger('INFO', `Question can be answered with internal knowledge - no research needed`);
      return {
        answer: decision.answer,
        citations: [],
        note: "Answer provided solely based on internal knowledge; no citations required.",
        processSteps: ["Evaluated question scope", "Determined internal knowledge sufficient", "Generated answer"]
      };
    } else {
      // Step 2: Fetch relevant papers
      logger('INFO', `PROCESS STAGE 2: Retrieving relevant research papers`);
      const queryWord = decision.queryWord;
      const papers = await searchPapers(queryWord);
      
      if (!papers || papers.length === 0) {
        logger('WARN', `No papers found for query: "${queryWord}"`);
        return {
          answer: `I couldn't find relevant scholarly articles for "${question}" using the search term "${queryWord}".`,
          queryWord: queryWord,
          citations: [],
          processSteps: ["Evaluated question scope", "Determined research needed", "Retrieved 0 papers", "Generated response"]
        };
      }
      
      const citations = papers.map(paper => ({
        title: paper.title || 'N/A',
        abstract: paper.abstract || 'No abstract available',
        year: paper.year || 'N/A',
        citationCount: (paper.citationCount !== undefined) ? paper.citationCount : 0,
        referenceCount: (paper.referenceCount !== undefined) ? paper.referenceCount : 0,
        authors: paper.authors ? paper.authors.map(author => author.name) : [],
        link: paper.paperId ? `https://semanticscholar.org/paper/${paper.paperId}` : 'N/A'
      }));
      
      logger('INFO', `Retrieved ${citations.length} papers for analysis`);
      
      // Step 3: Generate a comprehensive answer using the citations
      logger('INFO', `PROCESS STAGE 3: Generating comprehensive answer with citations`);
      const result = await generateAnswerWithCitations(question, citations);
      
      logger('INFO', `Research process completed successfully`);
      return {
        answer: result.answer,
        queryWord: queryWord,
        citations: citations,
        paperAnalysis: result.analysis,
        citationMapping: result.citationMapping,
        processSteps: [
          "Evaluated question scope", 
          "Determined research needed", 
          `Retrieved ${citations.length} papers`,
          "Analyzed paper content",
          "Generated comprehensive answer with citations"
        ]
      };
    }
  } catch (error) {
    logger('ERROR', `Error in research process:`, error.message);
    throw error;
  }
}

/**
 * GET /question?query=<user question>
 * 
 * Process a question through the research pipeline with GET
 */
app.get('/question', async (req, res) => {
  const requestId = Math.random().toString(36).substring(2, 15);
  const question = req.query.query;
  
  logger('INFO', `[${requestId}] Received GET request for question: "${question}"`);
  
  if (!question) {
    logger('WARN', `[${requestId}] Missing query parameter`);
    return res.status(400).json({ error: 'Missing query parameter' });
  }
  
  // Enable SSE (Server-Sent Events) if requested
  const useSSE = req.query.sse === 'true';
  if (useSSE) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    // Send initial event
    res.write(`data: ${JSON.stringify({ status: 'processing', message: 'Starting research process...' })}\n\n`);
  }
  
  try {
    if (useSSE) {
      // Process with progress updates
      const sendUpdate = (message) => {
        res.write(`data: ${JSON.stringify({ status: 'processing', message })}\n\n`);
      };
      
      // Override logger to send updates
      const originalLogger = logger;
      global.logger = function(level, ...args) {
        originalLogger(level, ...args);
        if (level.toUpperCase() === 'INFO') {
          sendUpdate(args.join(' '));
        }
      };
      
      // Process the question
      const result = await processQuestion(question);
      
      // Send final result
      res.write(`data: ${JSON.stringify({ status: 'complete', result })}\n\n`);
      res.end();
      
      // Restore original logger
      global.logger = originalLogger;
    } else {
      // Process normally for JSON response
      const result = await processQuestion(question);
      res.json(result);
    }
  } catch (error) {
    logger('ERROR', `[${requestId}] Error processing request:`, error);
    
    if (useSSE) {
      res.write(`data: ${JSON.stringify({ status: 'error', error: error.message })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ 
        error: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  }
});

/**
 * POST /question
 * 
 * Process a question through the research pipeline with POST
 */
app.post('/question', async (req, res) => {
  const requestId = Math.random().toString(36).substring(2, 15);
  const question = req.body.query;
  
  logger('INFO', `[${requestId}] Received POST request for question: "${question}"`);
  
  if (!question) {
    logger('WARN', `[${requestId}] Missing query in request body`);
    return res.status(400).json({ error: 'Missing query in request body' });
  }
  
  try {
    const result = await processQuestion(question);
    res.json(result);
  } catch (error) {
    logger('ERROR', `[${requestId}] Error processing request:`, error);
    res.status(500).json({ 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

/**
 * Streams a response from OpenAI API token-by-token
 * 
 * @param {string} prompt - The prompt to send to OpenAI
 * @param {object} res - Express response object for SSE
 * @param {string} stage - Current processing stage
 * @param {string} model - OpenAI model to use
 * @returns {Promise<string>} - Complete text response
 */
async function streamOpenAIResponse(prompt, res, stage, model = "gpt-4o") {
  const systemMessage = {
    role: "system",
    content: "You are a professional academic writer crafting a response based solely on provided research."
  };

  try {
    // Signal start of streaming for this stage
    res.write(`data: ${JSON.stringify({
      status: 'streaming',
      stage: stage,
      message: `Starting ${stage}...`
    })}\n\n`);
    
    // Accumulate the complete response
    let completeResponse = '';
    
    const response = await axios.post(
      OPENAI_BASE_URL, 
      {
        model: model,
        messages: [
          systemMessage,
          { role: "user", content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 1500,
        stream: true // Enable streaming
      },
      {
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        responseType: 'stream'
      }
    );

    return new Promise((resolve, reject) => {
      // Process the stream
      response.data.on('data', (chunk) => {
        try {
          // Convert chunk to string and split by 'data: ' prefix
          const chunkStr = chunk.toString();
          const dataChunks = chunkStr.split('data: ').filter(Boolean);
          
          for (const dataChunk of dataChunks) {
            if (dataChunk.trim() === '[DONE]') continue;
            
            try {
              const parsedChunk = JSON.parse(dataChunk);
              if (parsedChunk.choices && parsedChunk.choices[0].delta && parsedChunk.choices[0].delta.content) {
                const content = parsedChunk.choices[0].delta.content;
                completeResponse += content;
                
                // Send the token to the client
                res.write(`data: ${JSON.stringify({
                  status: 'token',
                  stage: stage,
                  token: content
                })}\n\n`);
              }
            } catch (parseError) {
              // Skip unparseable chunks
              logger('WARN', `Could not parse chunk: ${dataChunk}`);
            }
          }
        } catch (error) {
          logger('ERROR', 'Error processing stream chunk:', error);
          // Don't reject here, just log the error and continue
        }
      });
      
      response.data.on('end', () => {
        // Signal completion of this streaming phase
        res.write(`data: ${JSON.stringify({
          status: 'chunk_complete',
          stage: stage,
          message: `${stage} complete`,
          content: completeResponse
        })}\n\n`);
        
        resolve(completeResponse);
      });
      
      response.data.on('error', (error) => {
        logger('ERROR', 'Stream error:', error);
        reject(error);
      });
    });
  } catch (error) {
    logger('ERROR', `OpenAI API streaming error:`, error.message);
    throw error;
  }
}

/**
 * GET /stream-question?query=<user question>
 * 
 * Process a question with detailed streaming updates and token-by-token streaming
 */
app.get('/stream-question', (req, res) => {
  const requestId = Math.random().toString(36).substring(2, 15);
  const question = req.query.query;
  
  logger('INFO', `[${requestId}] Received streaming request for question: "${question}"`);
  
  if (!question) {
    logger('WARN', `[${requestId}] Missing query parameter`);
    return res.status(400).json({ error: 'Missing query parameter' });
  }
  
  // Setup SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // Send initial connection confirmation
  res.write(`data: ${JSON.stringify({ 
    status: 'connected', 
    message: 'Stream connection established' 
  })}\n\n`);
  
  // Process function with streaming updates
  (async () => {
    try {
      // Step 1: Determine if question can be answered internally
      res.write(`data: ${JSON.stringify({ 
        status: 'stage_update', 
        stage: 'evaluation',
        message: 'Evaluating if your question requires external research...' 
      })}\n\n`);
      
      const decision = await decideAnswer(question);
      
      // Update on decision result
      res.write(`data: ${JSON.stringify({ 
        status: 'substage_update', 
        stage: 'evaluation_complete',
        message: decision.canAnswer 
          ? 'Your question can be answered directly without research.' 
          : 'Your question requires searching external research papers.',
        canAnswer: decision.canAnswer
      })}\n\n`);
      
      if (decision.canAnswer) {
        // Direct answer from AI, use token-by-token streaming
        const prompt = `Provide a comprehensive answer to the following question: "${question}"`;
        
        // Stream the direct answer token by token
        const finalAnswer = await streamOpenAIResponse(prompt, res, 'generating_answer');
        
        // Send final metadata
        res.write(`data: ${JSON.stringify({ 
          status: 'complete', 
          result: {
            answer: finalAnswer,
            citations: [],
            note: "Answer provided solely based on internal knowledge; no citations required.",
            processSteps: ["Evaluated question scope", "Determined internal knowledge sufficient", "Generated answer"]
          }
        })}\n\n`);
        res.end();
      } else {
        // Step 2: Show search keyword being used
        const queryWord = decision.queryWord;
        
        res.write(`data: ${JSON.stringify({ 
          status: 'substage_update', 
          stage: 'search_term_selected',
          message: `Using search term: "${queryWord}"`,
          queryWord: queryWord
        })}\n\n`);
        
        // Step 3: Fetch papers
        res.write(`data: ${JSON.stringify({ 
          status: 'stage_update', 
          stage: 'paper_retrieval',
          message: `Searching for relevant scientific papers...` 
        })}\n\n`);
        
        const papers = await searchPapers(queryWord);
        
        // Update with paper search results
        if (!papers || papers.length === 0) {
          res.write(`data: ${JSON.stringify({ 
            status: 'stage_update', 
            stage: 'no_papers_found',
            message: `No relevant papers found for search term "${queryWord}".`
          })}\n\n`);
          
          res.write(`data: ${JSON.stringify({ 
            status: 'complete', 
            result: {
              answer: `I couldn't find relevant scholarly articles for "${question}" using the search term "${queryWord}".`,
              queryWord: queryWord,
              citations: [],
              processSteps: ["Evaluated question scope", "Determined research needed", "Retrieved 0 papers", "Generated response"]
            }
          })}\n\n`);
          res.end();
          return;
        }
        
        // We found papers, inform the user
        const citations = papers.map(paper => ({
          title: paper.title || 'N/A',
          abstract: paper.abstract || 'No abstract available',
          year: paper.year || 'N/A',
          citationCount: (paper.citationCount !== undefined) ? paper.citationCount : 0,
          referenceCount: (paper.referenceCount !== undefined) ? paper.referenceCount : 0,
          authors: paper.authors ? paper.authors.map(author => author.name) : [],
          link: paper.paperId ? `https://semanticscholar.org/paper/${paper.paperId}` : 'N/A'
        }));
        
        // Show found papers
        res.write(`data: ${JSON.stringify({ 
          status: 'substage_update', 
          stage: 'papers_found',
          message: `Found ${citations.length} relevant papers.`,
          papers: citations.map(p => ({ 
            title: p.title, 
            authors: p.authors,
            year: p.year,
            link: p.link 
          }))
        })}\n\n`);
        
        // Step 4: Paper analysis stage with citation keys
        res.write(`data: ${JSON.stringify({ 
          status: 'stage_update', 
          stage: 'paper_analysis',
          message: `Analyzing ${citations.length} research papers...` 
        })}\n\n`);
        
        // Extract citation keys
        const citationsWithKeys = citations.map((citation, index) => {
          const authorLastName = citation.authors && citation.authors.length > 0 
            ? citation.authors[0].split(' ').pop() 
            : 'Unknown';
          const citationKey = `${authorLastName}${citation.year || ''}`;
          
          return {
            ...citation,
            citationKey,
            index: index + 1
          };
        });
        
        // Show citation keys being used
        res.write(`data: ${JSON.stringify({ 
          status: 'substage_update', 
          stage: 'citations_prepared',
          message: `Prepared citation keys for analysis`,
          citationKeys: citationsWithKeys.map(c => ({ 
            key: c.citationKey, 
            title: c.title 
          }))
        })}\n\n`);
        
        // Format citations for analysis
        const citationsText = citationsWithKeys.map((citation) => {
          return `Citation [${citation.citationKey}]:
Title: ${citation.title}
Abstract: ${citation.abstract}
Authors: ${citation.authors.join(', ')}
Year: ${citation.year}
Key Points: Please extract 3-5 key points from this paper relevant to the question.
`;
        }).join('\n\n');
        
        // Analysis prompt
        const analysisPrompt = `
You are a professional academic researcher analyzing scientific papers. Your task is to:
1. Carefully read each paper abstract below
2. Extract the most relevant information to the question: "${question}"
3. For each paper, identify 3-5 key claims or findings that address the question
4. Note any limitations or contradictions between papers

${citationsText}

Format your analysis as follows:
PAPER ANALYSIS:
[CitationKey1]: 
- Key finding 1
- Key finding 2
...

[CitationKey2]:
...

SYNTHESIS:
Briefly summarize how these papers collectively address the question.
`;
        
        // Stream the paper analysis process
        const paperAnalysis = await streamOpenAIResponse(analysisPrompt, res, 'analyzing_papers', "gpt-4o");
        
        // Step 5: Final answer generation with token-by-token streaming
        res.write(`data: ${JSON.stringify({ 
          status: 'stage_update', 
          stage: 'answer_generation',
          message: 'Preparing your final answer with citations...' 
        })}\n\n`);
        
        // Answer prompt
        const answerPrompt = `
You are writing an academic response to the question: "${question}"

You must use the following paper analysis to craft your response:
${paperAnalysis}

Important requirements:
1. Every claim must be supported by a specific citation using the format [AuthorYear] inline
2. Only include information that is directly supported by the papers in the analysis
3. Do not introduce new information not found in the papers
4. Maintain academic rigor and precision
5. Include a properly formatted Works Cited section at the end using MLA format
6. Structure your answer with clear sections and paragraphs

The citation keys to use are: ${citationsWithKeys.map(c => `[${c.citationKey}]`).join(', ')}
`;
        
        // Generate final answer with token-by-token streaming
        const finalAnswer = await streamOpenAIResponse(answerPrompt, res, 'generating_answer', "gpt-4o");
        
        // Send final result metadata
        res.write(`data: ${JSON.stringify({ 
          status: 'complete', 
          result: {
            answer: finalAnswer,
            queryWord: queryWord,
            citations: citations,
            paperAnalysis: paperAnalysis,
            citationMapping: citationsWithKeys.map(c => ({ 
              key: c.citationKey, 
              title: c.title,
              authors: c.authors,
              year: c.year,
              link: c.link
            })),
            processSteps: [
              "Evaluated question scope", 
              "Determined research needed", 
              `Retrieved ${citations.length} papers`,
              "Analyzed paper content",
              "Generated comprehensive answer with citations"
            ]
          }
        })}\n\n`);
        
        res.end();
      }
    } catch (error) {
      logger('ERROR', `[${requestId}] Streaming error:`, error);
      res.write(`data: ${JSON.stringify({ 
        status: 'error', 
        error: error.message,
        stage: 'error'
      })}\n\n`);
      res.end();
    }
  })();
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString()
  });
});

/**
 * GET / - Root route with API information
 */
app.get('/api', (req, res) => {
  res.json({
    name: "AI Research Assistant API",
    version: "1.0.0",
    endpoints: [
      { path: "/question", method: "GET/POST", description: "Process a research question" },
      { path: "/stream-question", method: "GET", description: "Process a research question with streaming updates" },
      { path: "/health", method: "GET", description: "API health check" }
    ],
    ui: [
      { path: "/", description: "Demo client home" },
      { path: "/demo-client.html", description: "Interactive demo interface" }
    ]
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger('ERROR', 'Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// Start the server
app.listen(port, () => {
  logger('INFO', `Server is listening on port ${port}`);
  logger('INFO', `Health check available at http://localhost:${port}/health`);
  logger('INFO', `Question endpoint available at http://localhost:${port}/question`);
  logger('INFO', `Streaming endpoint available at http://localhost:${port}/stream-question`);
  logger('INFO', `Log level set to: ${Object.keys(logLevels).find(key => logLevels[key] === currentLogLevel) || 'INFO'}`);
});
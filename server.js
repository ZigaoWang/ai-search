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
    logger('DEBUG', `Making request to OpenAI`);
    
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
    logger('DEBUG', `Making request to OpenAI`);
    
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
 * Filter papers to select only the most relevant ones for the question.
 * 
 * @param {string} question - The research question
 * @param {Array} papers - Retrieved papers with title and abstract
 * @param {number} maxPapers - Maximum number of papers to select
 * @returns {Promise<Array>} - Array of selected papers
 */
async function filterRelevantPapers(question, papers, maxPapers = 5) {
  logger('INFO', `Filtering ${papers.length} papers for relevance to question: "${question}"`);
  
  // If we have few papers already, no need to filter
  if (papers.length <= maxPapers) {
    logger('INFO', `Only ${papers.length} papers retrieved, using all without filtering`);
    return papers;
  }
  
  // Prepare paper summaries for evaluation
  const paperSummaries = papers.map((paper, index) => {
    return {
      id: index,
      title: paper.title || 'No title available',
      abstract: paper.abstract || 'No abstract available',
      year: paper.year || 'Unknown',
      authors: paper.authors ? paper.authors.map(a => a).join(', ') : 'Unknown'
    };
  });
  
  const filterPrompt = `
You are a research librarian helping to find the most relevant papers for a research question.

Research question: "${question}"

Below are summaries of ${papers.length} papers. Your task is to:
1. Evaluate each paper's relevance to the research question based on its title and abstract
2. Select only the most relevant papers (maximum ${maxPapers})
3. Prefer papers with substantive content addressing the question directly

Output ONLY a JSON array of paper IDs in order of relevance, like this:
[0, 3, 5]

Paper summaries:
${JSON.stringify(paperSummaries, null, 2)}
`;

  try {
    logger('DEBUG', `Sending filter prompt to OpenAI`);
    
    const response = await axios.post(OPENAI_BASE_URL, {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are a research librarian helping to select the most relevant papers. Respond ONLY with a JSON array of paper IDs." },
        { role: "user", content: filterPrompt }
      ],
      temperature: 0.2,
      max_tokens: 150,
    }, {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      }
    });

    let reply = response.data.choices[0].message.content.trim();
    // Clean any markdown code blocks if present
    reply = reply.replace(/```json|```/g, '').trim();
    
    try {
      // Parse the array of selected paper IDs
      const selectedIds = JSON.parse(reply);
      
      if (!Array.isArray(selectedIds)) {
        logger('WARN', 'Response is not an array, using all papers');
        return papers;
      }
      
      // Get the selected papers
      const selectedPapers = selectedIds.map(id => papers[id]).filter(Boolean);
      
      if (selectedPapers.length === 0) {
        logger('WARN', 'No papers selected, using all papers');
        return papers;
      }
      
      logger('INFO', `Selected ${selectedPapers.length} most relevant papers out of ${papers.length}`);
      return selectedPapers;
    } catch (parseError) {
      logger('ERROR', `Failed to parse paper selection response:`, reply);
      // Fall back to using all papers
      return papers;
    }
  } catch (error) {
    logger('ERROR', `Error in paper filtering:`, error.message);
    // Fall back to using all papers
    return papers;
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
        
        // Show all found papers
        const allCitations = papers.map(paper => ({
          title: paper.title || 'N/A',
          abstract: paper.abstract || 'No abstract available',
          year: paper.year || 'N/A',
          citationCount: (paper.citationCount !== undefined) ? paper.citationCount : 0,
          referenceCount: (paper.referenceCount !== undefined) ? paper.referenceCount : 0,
          authors: paper.authors ? paper.authors.map(author => author.name) : [],
          link: paper.paperId ? `https://semanticscholar.org/paper/${paper.paperId}` : 'N/A'
        }));
        
        // Show all found papers in the UI
        res.write(`data: ${JSON.stringify({ 
          status: 'substage_update', 
          stage: 'papers_found',
          message: `Found ${allCitations.length} papers to evaluate.`,
          papers: allCitations.map(p => ({ 
            title: p.title, 
            authors: p.authors,
            year: p.year,
            link: p.link 
          }))
        })}\n\n`);
        
        // NEW STEP: Filter papers for relevance
        res.write(`data: ${JSON.stringify({ 
          status: 'substage_update', 
          stage: 'filtering_papers',
          message: `Evaluating papers for relevance to your question...`
        })}\n\n`);
        
        const filteredPapers = await filterRelevantPapers(question, papers);
        const filteredCitations = filteredPapers.map(paper => ({
          title: paper.title || 'N/A',
          abstract: paper.abstract || 'No abstract available',
          year: paper.year || 'N/A',
          citationCount: (paper.citationCount !== undefined) ? paper.citationCount : 0,
          referenceCount: (paper.referenceCount !== undefined) ? paper.referenceCount : 0,
          authors: paper.authors ? paper.authors.map(author => author.name) : [],
          link: paper.paperId ? `https://semanticscholar.org/paper/${paper.paperId}` : 'N/A'
        }));
        
        // Inform which papers were selected
        res.write(`data: ${JSON.stringify({ 
          status: 'substage_update', 
          stage: 'papers_selected',
          message: `Selected ${filteredCitations.length} most relevant papers for detailed analysis.`,
          selectedPapers: filteredCitations.map(p => ({ 
            title: p.title, 
            authors: p.authors,
            year: p.year,
            link: p.link 
          }))
        })}\n\n`);
        
        // Step 4: Paper analysis stage with filtered citation keys
        res.write(`data: ${JSON.stringify({ 
          status: 'stage_update', 
          stage: 'paper_analysis',
          message: `Analyzing ${filteredCitations.length} selected research papers...` 
        })}\n\n`);
        
        // Continue with existing code but using filteredCitations instead of all citations
        const citationsWithKeys = filteredCitations.map((citation, index) => {
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
            citations: filteredCitations,
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
              `Retrieved ${filteredCitations.length} papers`,
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

// ZhiDao API endpoints for AI learning tool

// Store user learning goals and preferences
let userGoals = {};
let userLearningHistory = {};
let userKnowledgeGraph = {};

/**
 * Create or update a user learning goal
 */
app.post('/api/goals', async (req, res) => {
  try {
    const { userId, goal, timeframe, priority } = req.body;
    
    if (!userId || !goal) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    if (!userGoals[userId]) {
      userGoals[userId] = [];
    }
    
    const goalId = Date.now().toString();
    userGoals[userId].push({
      id: goalId,
      goal,
      timeframe: timeframe || '1 month',
      priority: priority || 'medium',
      createdAt: new Date().toISOString(),
      progress: 0,
      relatedTopics: await generateRelatedTopics(goal)
    });
    
    res.status(201).json({ 
      message: 'Goal created successfully',
      goalId,
      suggestedLearningPath: await generateLearningPath(goal)
    });
  } catch (error) {
    logger('ERROR', `Error creating goal:`, error.message);
    res.status(500).json({ error: 'Failed to create goal' });
  }
});

/**
 * Generate related topics for a learning goal
 */
async function generateRelatedTopics(goal) {
  try {
    const prompt = `
For the learning goal "${goal}", identify 5-7 closely related topics that would be valuable to explore.
Format as a JSON array of strings.
`;

    const response = await axios.post(OPENAI_BASE_URL, {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are a knowledgeable education expert. Return only JSON." },
        { role: "user", content: prompt }
      ],
      temperature: 0.3,
    }, {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      }
    });

    // Extract and parse the JSON array
    const content = response.data.choices[0].message.content.trim();
    const cleanedContent = content.replace(/```json|```/g, '').trim();
    return JSON.parse(cleanedContent);
  } catch (error) {
    logger('ERROR', `Error generating related topics:`, error.message);
    return [];
  }
}

/**
 * Generate a learning path for a goal
 */
async function generateLearningPath(goal) {
  try {
    const prompt = `
Create a structured learning path for someone who wants to achieve the following goal: "${goal}".
The learning path should include:
1. Foundational concepts that need to be understood first
2. Intermediate topics to explore
3. Advanced areas to master
4. Practical applications or projects to reinforce learning

Format the response as a JSON object with these keys: foundational, intermediate, advanced, projects.
Each value should be an array of strings.
`;

    const response = await axios.post(OPENAI_BASE_URL, {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are an expert curriculum designer. Return only JSON." },
        { role: "user", content: prompt }
      ],
      temperature: 0.3,
    }, {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      }
    });

    // Extract and parse the JSON object
    const content = response.data.choices[0].message.content.trim();
    const cleanedContent = content.replace(/```json|```/g, '').trim();
    return JSON.parse(cleanedContent);
  } catch (error) {
    logger('ERROR', `Error generating learning path:`, error.message);
    return {
      foundational: [],
      intermediate: [],
      advanced: [],
      projects: []
    };
  }
}

/**
 * Get the latest content for a specific topic
 */
app.get('/api/content', async (req, res) => {
  try {
    const { topic, count = 5 } = req.query;
    
    if (!topic) {
      return res.status(400).json({ error: 'Topic is required' });
    }
    
    // Get latest content for the topic
    const latestContent = await fetchLatestContent(topic, parseInt(count));
    
    res.json({ 
      topic,
      content: latestContent,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger('ERROR', `Error fetching content:`, error.message);
    res.status(500).json({ error: 'Failed to fetch content' });
  }
});

/**
 * Fetch latest content for a topic
 */
async function fetchLatestContent(topic, count = 5) {
  // First try to get academic papers
  try {
    const papers = await searchPapers(topic, count);
    if (papers && papers.length > 0) {
      return papers.map(paper => ({
        type: 'academic',
        title: paper.title,
        summary: paper.abstract,
        authors: paper.authors,
        year: paper.year,
        relevanceScore: calculateRelevanceScore(paper),
        tags: generateTagsForContent(paper)
      }));
    }
  } catch (error) {
    logger('WARN', `Error fetching papers for ${topic}:`, error.message);
  }
  
  // If no papers or error, generate synthetic content
  return generateSyntheticContent(topic, count);
}

/**
 * Calculate relevance score for content
 */
function calculateRelevanceScore(content) {
  // Simple scoring algorithm based on citation count and recency
  if (content.citationCount && content.year) {
    const currentYear = new Date().getFullYear();
    const yearsOld = currentYear - content.year;
    const recencyFactor = Math.max(0, 1 - (yearsOld / 10)); // Older content gets lower score
    
    // Normalize citation count (assume max citations is around 1000)
    const normalizedCitations = Math.min(content.citationCount / 1000, 1);
    
    return (normalizedCitations * 0.7) + (recencyFactor * 0.3);
  }
  
  return 0.5; // Default middle score
}

/**
 * Generate tags for content
 */
function generateTagsForContent(content) {
  const tags = [];
  
  // Add tags based on year
  const currentYear = new Date().getFullYear();
  if (content.year) {
    if (currentYear - content.year <= 2) {
      tags.push('recent');
    }
    if (currentYear - content.year <= 5) {
      tags.push('relevant');
    }
  }
  
  // Add tags based on citation count
  if (content.citationCount) {
    if (content.citationCount > 100) {
      tags.push('highly-cited');
    }
    if (content.citationCount > 500) {
      tags.push('seminal');
    }
  }
  
  return tags;
}

/**
 * Generate synthetic content when real content isn't available
 */
async function generateSyntheticContent(topic, count = 5) {
  try {
    const prompt = `
Create ${count} synthetic educational content items about "${topic}". Each item should feel like a real-world article or paper.

For each item, provide:
1. A realistic, specific title
2. A 2-3 sentence abstract/summary
3. 1-3 fictional author names
4. A fictional publication year (between 2020-2025)
5. 2-4 relevant tags

Format as a JSON array with objects containing: title, summary, authors, year, tags.
`;

    const response = await axios.post(OPENAI_BASE_URL, {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are an expert content creator. Return only JSON." },
        { role: "user", content: prompt }
      ],
      temperature: 0.7,
    }, {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      }
    });

    // Extract and parse the JSON array
    const content = response.data.choices[0].message.content.trim();
    const cleanedContent = content.replace(/```json|```/g, '').trim();
    const items = JSON.parse(cleanedContent);
    
    // Add relevance scores to each item
    return items.map(item => ({
      ...item,
      type: 'synthetic',
      relevanceScore: Math.random() * 0.3 + 0.7 // Random score between 0.7 and 1
    }));
  } catch (error) {
    logger('ERROR', `Error generating synthetic content:`, error.message);
    return [];
  }
}

/**
 * Generate deep questions about a topic
 */
app.get('/api/questions', async (req, res) => {
  try {
    const { topic } = req.query;
    
    if (!topic) {
      return res.status(400).json({ error: 'Topic is required' });
    }
    
    const questions = await generateDeepQuestions(topic);
    
    res.json({ 
      topic,
      questions,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger('ERROR', `Error generating questions:`, error.message);
    res.status(500).json({ error: 'Failed to generate questions' });
  }
});

/**
 * Generate deep, thought-provoking questions about a topic
 */
async function generateDeepQuestions(topic) {
  try {
    const prompt = `
Generate 5 deep, thought-provoking questions about "${topic}" that would challenge experts in the field.
The questions should:
1. Explore nuanced aspects of the topic
2. Connect to broader implications
3. Identify potential controversies or evolving perspectives
4. Encourage critical thinking

Format as a JSON array of objects with: question, category, difficulty (1-5).
`;

    const response = await axios.post(OPENAI_BASE_URL, {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are a socratic educator. Return only JSON." },
        { role: "user", content: prompt }
      ],
      temperature: 0.7,
    }, {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      }
    });

    // Extract and parse the JSON array
    const content = response.data.choices[0].message.content.trim();
    const cleanedContent = content.replace(/```json|```/g, '').trim();
    return JSON.parse(cleanedContent);
  } catch (error) {
    logger('ERROR', `Error generating deep questions:`, error.message);
    return [];
  }
}

/**
 * Record user learning progress
 */
app.post('/api/progress', (req, res) => {
  try {
    const { userId, contentId, action, duration } = req.body;
    
    if (!userId || !contentId || !action) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    if (!userLearningHistory[userId]) {
      userLearningHistory[userId] = [];
    }
    
    // Record the learning activity
    userLearningHistory[userId].push({
      contentId,
      action, // 'viewed', 'completed', 'saved', etc.
      duration: duration || null,
      timestamp: new Date().toISOString()
    });
    
    // Update goals progress if relevant
    if (userGoals[userId]) {
      // Implementation would depend on how we match content to goals
      // This is a simplified placeholder
      userGoals[userId].forEach(goal => {
        if (goal.progress < 100) {
          goal.progress += 1;
        }
      });
    }
    
    res.status(200).json({ 
      message: 'Progress recorded successfully',
      recommendedNext: generateNextRecommendation(userId)
    });
  } catch (error) {
    logger('ERROR', `Error recording progress:`, error.message);
    res.status(500).json({ error: 'Failed to record progress' });
  }
});

/**
 * Generate next content recommendation for user
 */
function generateNextRecommendation(userId) {
  // This would normally use a recommendation algorithm
  // For now, return a placeholder
  return {
    type: 'content',
    reason: 'Based on your recent learning activity',
    recommendation: 'Explore more about the fundamentals of this topic'
  };
}

/**
 * Get cross-disciplinary recommendations
 */
app.get('/api/recommendations/cross-disciplinary', async (req, res) => {
  try {
    const { userId, currentTopic } = req.query;
    
    if (!userId || !currentTopic) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const recommendations = await generateCrossDisciplinaryRecommendations(userId, currentTopic);
    
    res.json({
      currentTopic,
      recommendations,
      explorationPercentage: calculateExplorationPercentage(userId, currentTopic)
    });
  } catch (error) {
    logger('ERROR', `Error generating cross-disciplinary recommendations:`, error.message);
    res.status(500).json({ error: 'Failed to generate recommendations' });
  }
});

/**
 * Generate cross-disciplinary recommendations
 */
async function generateCrossDisciplinaryRecommendations(userId, currentTopic) {
  try {
    const prompt = `
Based on the topic "${currentTopic}", recommend 3 cross-disciplinary areas that might provide valuable insights.
For each recommendation, explain the potential connection and why exploring this connection might be valuable.

Format as a JSON array of objects with:
- area (string): The cross-disciplinary area
- connection (string): Brief explanation of the connection
- valueProposition (string): Why this connection is valuable
- explorationDifficulty (number): 1-5 scale of how challenging this exploration would be
`;

    const response = await axios.post(OPENAI_BASE_URL, {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are an interdisciplinary education expert. Return only JSON." },
        { role: "user", content: prompt }
      ],
      temperature: 0.6,
    }, {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      }
    });

    // Extract and parse the JSON array
    const content = response.data.choices[0].message.content.trim();
    const cleanedContent = content.replace(/```json|```/g, '').trim();
    return JSON.parse(cleanedContent);
  } catch (error) {
    logger('ERROR', `Error generating cross-disciplinary recommendations:`, error.message);
    return [];
  }
}

/**
 * Calculate what percentage of a domain the user has explored
 */
function calculateExplorationPercentage(userId, topic) {
  // This would normally use actual user data
  // For now, return a placeholder random percentage
  return Math.floor(Math.random() * 30); // 0-30%
}

// Add new health check endpoint that includes system status
app.get('/api/system-status', (req, res) => {
  res.json({
    status: 'healthy',
    version: '1.0.0',
    apiStatus: {
      search: 'operational',
      recommendations: 'operational',
      goalTracking: 'operational'
    },
    memoryUsage: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});
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

// CORE API endpoint for paper search
const CORE_BASE_URL = 'https://api.core.ac.uk/v3/search/works';
const CORE_API_KEY = process.env.CORE_API_KEY; // Make sure to add this to your .env file

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
 * Searches academic databases for papers matching the query.
 * Retries if rate-limited.
 *
 * @param {string} query - The search query.
 * @param {number} limit - Number of results to fetch.
 * @param {number} retries - Number of retries if rate-limited.
 * @returns {Promise<Array>} - Resolves to an array of paper objects.
 */
async function searchPapers(query, limit = 5, retries = 3) {
  logger('INFO', `Searching academic databases for: "${query}" (limit: ${limit})`);
  
  // Check cache first
  const cacheKey = query.toLowerCase().trim();
  if (searchCache.has(cacheKey)) {
    const cachedItem = searchCache.get(cacheKey);
    if (Date.now() - cachedItem.timestamp < CACHE_TTL) {
      logger('INFO', `Using cached results for query: "${query}"`);
      return cachedItem.results;
    } else {
      searchCache.delete(cacheKey); // Remove expired item
    }
  }
  
  // Translate query to English if it's not in English
  let englishQuery = query;
  if (await detectNonEnglishQuery(query)) {
    englishQuery = await translateToEnglish(query);
    logger('INFO', `Translated query from non-English to: "${englishQuery}"`);
  }

  // Generate alternative search terms
  const searchTerms = await generateAlternativeSearchTerms(englishQuery);
  logger('INFO', `Generated search terms: ${searchTerms.join(', ')}`);
  
  // Results from different APIs and search terms
  let allResults = [];
  
  // Execute searches in parallel
  const searchPromises = [];
  
  // First search with the primary term to get quick results
  const primaryPromises = [
    searchSemanticScholar(searchTerms[0], Math.ceil(limit/2), retries)
      .catch(err => {
        logger('WARN', `Primary Semantic Scholar search failed: ${err.message}`);
        return [];
      })
  ];
  
  if (CORE_API_KEY) {
    primaryPromises.push(
      searchCore(searchTerms[0], Math.ceil(limit/2))
        .catch(err => {
          logger('WARN', `Primary CORE search failed: ${err.message}`);
          return [];
        })
    );
  }
  
  // Wait for primary results first
  const primaryResultsArrays = await Promise.all(primaryPromises);
  for (const results of primaryResultsArrays) {
    allResults = allResults.concat(results);
  }
  
  // Now search with all the alternative terms in parallel
  for (const term of searchTerms.slice(1)) {  // Skip the first term (already searched)
    searchPromises.push(
      searchSemanticScholar(term, Math.ceil(limit/searchTerms.length), retries)
        .catch(err => {
          logger('WARN', `Semantic Scholar search failed for term "${term}": ${err.message}`);
          return [];
        })
    );
    
    if (CORE_API_KEY) {
      searchPromises.push(
        searchCore(term, Math.ceil(limit/searchTerms.length))
          .catch(err => {
            logger('WARN', `CORE search failed for term "${term}": ${err.message}`);
            return [];
          })
      );
    }
  }
  
  // Wait for all additional searches to complete
  const searchResults = await Promise.all(searchPromises);
  
  // Combine results
  for (const results of searchResults) {
    allResults = allResults.concat(results);
  }
  
  // Remove duplicates based on title similarity
  const uniqueResults = removeDuplicatePapers(allResults);
  
  // Log sources of all unique results
  const sourceCount = uniqueResults.reduce((counts, paper) => {
    counts[paper.source] = (counts[paper.source] || 0) + 1;
    return counts;
  }, {});
  logger('INFO', `Sources breakdown: ${JSON.stringify(sourceCount)}`);
  
  // Rank and limit results
  const rankedResults = rankPapersByRelevance(uniqueResults, englishQuery)
    .slice(0, limit);
  
  logger('INFO', `Found ${rankedResults.length} papers across all academic databases`);
  
  // Cache the results
  searchCache.set(cacheKey, { results: rankedResults, timestamp: Date.now() });
  
  return rankedResults;
}

// Add a simple in-memory cache for search results
const searchCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour in milliseconds

/**
 * Detects if a query is in a language other than English
 * @param {string} query - The query to check
 * @returns {Promise<boolean>} - True if query is non-English
 */
async function detectNonEnglishQuery(query) {
  try {
    // Simple heuristic: check if query contains non-ASCII characters
    return /[^\x00-\x7F]/.test(query);
    
    // For a more sophisticated approach, we could use the OpenAI API:
    /*
    const response = await axios.post(OPENAI_BASE_URL, {
      model: "gpt-4o",
      messages: [
        { 
          role: "system", 
          content: "You are a language detection system. Respond with a single word: either 'english' or 'non-english'." 
        },
        { role: "user", content: `Detect language: "${query}"` }
      ],
      temperature: 0.1,
      max_tokens: 10
    }, {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      }
    });
    
    const result = response.data.choices[0].message.content.trim().toLowerCase();
    return result !== "english";
    */
  } catch (error) {
    logger('WARN', `Language detection error: ${error.message}`);
    return false; // Default to assuming English on error
  }
}

/**
 * Translates a query to English using OpenAI
 * @param {string} query - The query to translate
 * @returns {Promise<string>} - English translation
 */
async function translateToEnglish(query) {
  try {
    const response = await axios.post(OPENAI_BASE_URL, {
      model: "gpt-4o",
      messages: [
        { 
          role: "system", 
          content: "You are a translation system. Translate the input text to English, maintaining the academic and technical terminology." 
        },
        { role: "user", content: query }
      ],
      temperature: 0.1,
      max_tokens: 100
    }, {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      }
    });
    
    return response.data.choices[0].message.content.trim();
  } catch (error) {
    logger('ERROR', `Translation error: ${error.message}`);
    return query; // Fall back to original query on error
  }
}

/**
 * Generates alternative search terms for a query to maximize search coverage
 * @param {string} query - The original search query
 * @returns {Promise<Array<string>>} - Array of search terms including the original
 */
async function generateAlternativeSearchTerms(query) {
  try {
    // Start with the original query
    const searchTerms = [query];
    
    // For shorter queries, use the OpenAI API to generate alternatives
    if (query.length <= 100) {
      const response = await axios.post(OPENAI_BASE_URL, {
        model: "gpt-4o",
        messages: [
          { 
            role: "system", 
            content: "You are a research assistant helping to optimize academic searches. Generate 2-3 alternative academic search queries that would help find relevant papers on this topic. Focus on using precise academic terminology and different phrasings. Respond with just a JSON array of strings with no explanation." 
          },
          { role: "user", content: query }
        ],
        temperature: 0.7,
        max_tokens: 150
      }, {
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      });
      
      // Parse the response to get alternative search terms
      const content = response.data.choices[0].message.content.trim();
      const cleanedContent = content.replace(/```json|```/g, '').trim();
      
      try {
        const alternatives = JSON.parse(cleanedContent);
        if (Array.isArray(alternatives)) {
          // Add alternatives to the search terms
          alternatives.forEach(term => {
            if (term && typeof term === 'string' && !searchTerms.includes(term)) {
              searchTerms.push(term);
            }
          });
        }
      } catch (parseError) {
        logger('WARN', `Failed to parse alternative search terms: ${parseError.message}`);
      }
    }
    
    // Return unique search terms
    return [...new Set(searchTerms)];
  } catch (error) {
    logger('WARN', `Error generating alternative search terms: ${error.message}`);
    return [query]; // Fall back to just the original query
  }
}

/**
 * Searches Semantic Scholar API with a specific query term
 */
async function searchSemanticScholar(query, limit = 5, retries = 3) {
  logger('DEBUG', `Searching Semantic Scholar for: "${query}"`);
  
  try {
    const response = await axios.get(SEMSCHOLAR_BASE_URL, {
      params: {
        query: query,
        limit: limit,
        fields: "paperId,title,authors,year,abstract,citationCount,referenceCount"
      }
    });

    if (response.status === 200 && response.data && response.data.data) {
      const papers = response.data.data;
      logger('DEBUG', `Found ${papers.length} papers on Semantic Scholar`);
      
      return papers.map(paper => ({
        title: paper.title || 'No title available',
        abstract: paper.abstract || 'No abstract available',
        year: paper.year || 'Unknown',
        citationCount: paper.citationCount || 0,
        referenceCount: paper.referenceCount || 0,
        // Handle authors consistently
        authors: typeof paper.authors === 'string' ? paper.authors : 
                 (Array.isArray(paper.authors) ? 
                   paper.authors.map(author => {
                     if (typeof author === 'string') return author;
                     return (author && author.name) ? author.name : 'Unknown';
                   }).join(', ') 
                 : 'Unknown'),
        link: paper.url || `https://www.semanticscholar.org/paper/${paper.paperId}`,
        source: 'Semantic Scholar'
      }));
    } else {
      logger('ERROR', `Unexpected response from Semantic Scholar API`, response.status, response.data);
      return [];
    }
  } catch (error) {
    if (error.response && error.response.status === 429 && retries > 0) {
      logger('WARN', `Rate limit reached (429). Retrying in 3 seconds... (${retries} retries left)`);
      await sleep(3000);
      return searchSemanticScholar(query, limit, retries - 1);
    } else {
      logger('ERROR', `Semantic Scholar API error:`, error.message);
      throw error;
    }
  }
}

/**
 * Searches CORE API with a specific query term
 */
async function searchCore(query, limit = 5) {
  logger('INFO', `Searching CORE for: "${query}"`);
  
  try {
    if (!CORE_API_KEY) {
      logger('ERROR', 'CORE API key not provided');
      return [];
    }
    
    logger('INFO', `Calling CORE API with URL: ${CORE_BASE_URL} and API key ${CORE_API_KEY ? 'is present' : 'is missing'}`);
    const response = await axios.post(CORE_BASE_URL, {
      q: query,
      limit: limit,
      scroll: false
    }, {
      headers: {
        "Authorization": `Bearer ${CORE_API_KEY}`,
        "Content-Type": "application/json"
      }
    });

    if (response.status === 200 && response.data && response.data.results) {
      const papers = response.data.results;
      logger('INFO', `Found ${papers.length} papers on CORE`);
      
      return papers.map(paper => ({
        title: paper.title || 'N/A',
        abstract: paper.abstract || 'No abstract available',
        year: paper.yearPublished ? paper.yearPublished.toString() : 'N/A',
        citationCount: 0, // CORE doesn't provide citation count in basic response
        referenceCount: 0,
        authors: typeof paper.authors === 'string' ? paper.authors : 
                 (Array.isArray(paper.authors) ? paper.authors.map(author => typeof author === 'string' ? author : (author.name || 'Unknown')).join(', ') : 'Unknown'),
        link: paper.downloadUrl || paper.identifiers.find(id => id.includes('doi.org')) || paper.repositoryDocument?.pdfUrl || 'Unknown',
        source: 'CORE'
      }));
    } else {
      logger('ERROR', `Unexpected response from CORE API`, response.status, response.data);
      return [];
    }
  } catch (error) {
    logger('ERROR', `CORE API error:`, error.message);
    throw error;
  }
}

/**
 * Removes duplicate papers based on title similarity
 */
function removeDuplicatePapers(papers) {
  const uniquePapers = [];
  const processedTitles = new Set();
  
  // Helper function to normalize titles for comparison
  const normalizeTitle = (title) => {
    return title.toLowerCase()
      .replace(/[^\w\s]/g, '') // Remove punctuation
      .replace(/\s+/g, ' ')    // Normalize whitespace
      .trim();
  };
  
  for (const paper of papers) {
    const normalizedTitle = normalizeTitle(paper.title);
    
    // Check if we've already seen a very similar title
    let isDuplicate = false;
    for (const existingTitle of processedTitles) {
      // Simple similarity check - can be enhanced with more sophisticated algorithms
      if (normalizedTitle.length > 0 && 
          (normalizedTitle.includes(existingTitle) || 
           existingTitle.includes(normalizedTitle))) {
        isDuplicate = true;
        break;
      }
    }
    
    if (!isDuplicate) {
      processedTitles.add(normalizedTitle);
      uniquePapers.push(paper);
    }
  }
  
  logger('INFO', `Removed ${papers.length - uniquePapers.length} duplicate papers`);
  return uniquePapers;
}

/**
 * Ranks papers by relevance to the query
 */
function rankPapersByRelevance(papers, query) {
  // Create a simple scoring system
  const scoredPapers = papers.map(paper => {
    let score = 0;
    
    // Base score components
    const hasAbstract = paper.abstract && paper.abstract !== 'No abstract available';
    const hasCitations = paper.citationCount > 0;
    const hasAuthors = paper.authors && paper.authors.length > 0;
    
    // Recent papers get higher scores (max 5 points for current year)
    const currentYear = new Date().getFullYear();
    const yearDiff = paper.year && !isNaN(paper.year) ? currentYear - parseInt(paper.year) : 10;
    const recencyScore = Math.max(0, 5 - yearDiff); // 5 points for current year, decreasing by 1 each year
    
    // Citation count (normalized, max 10 points)
    const citationScore = Math.min(10, Math.log(paper.citationCount + 1) * 2);
    
    // Content relevance (basic implementation)
    const titleRelevance = paper.title.toLowerCase().includes(query.toLowerCase()) ? 5 : 0;
    const abstractRelevance = hasAbstract && paper.abstract.toLowerCase().includes(query.toLowerCase()) ? 3 : 0;
    
    // Completeness score (max 5 points)
    const completenessScore = (hasAbstract ? 2 : 0) + (hasCitations ? 1 : 0) + (hasAuthors ? 2 : 0);
    
    // Calculate final score
    score = recencyScore + citationScore + titleRelevance + abstractRelevance + completenessScore;
    
    return { ...paper, relevanceScore: score };
  });
  
  // Sort by score (descending)
  return scoredPapers.sort((a, b) => b.relevanceScore - a.relevanceScore);
}

/**
 * Calls the UniAPI (OpenAI) endpoint to decide whether the query can be answered internally.
 * The prompt forces a JSON response in one of two forms:
 *  - { "canAnswer": true, "answer": "<your answer>" }
 *  - { "canAnswer": false, "queryWord": "<suggested keyword>" }
 *
 * @param {string} question - The user question.
 * @returns {Promise<Object>} - The parsed JSON result.
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
    reply = reply.replace(/```json|```/g, '').trim();
    
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
    throw error;
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
    let authorLastName = 'Unknown';
    
    if (typeof citation.authors === 'string') {
      // If authors is already a string, extract the first author's last name
      const firstAuthor = citation.authors.split(',')[0];
      authorLastName = firstAuthor ? firstAuthor.split(' ').pop() : 'Unknown';
    } else if (Array.isArray(citation.authors) && citation.authors.length > 0) {
      // If authors is an array, get the first author
      const firstAuthor = citation.authors[0];
      if (typeof firstAuthor === 'string') {
        authorLastName = firstAuthor.split(' ').pop();
      } else if (firstAuthor && firstAuthor.name) {
        authorLastName = firstAuthor.name.split(' ').pop();
      }
    }
    
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
Authors: ${typeof citation.authors === 'string' ? citation.authors : (Array.isArray(citation.authors) ? citation.authors.map(a => typeof a === 'string' ? a : (a.name || 'Unknown')).join(', ') : 'Unknown')}
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
    throw error;
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
        authors: (typeof paper.authors === 'string') ? paper.authors : 
                 (Array.isArray(paper.authors) ? paper.authors.map(a => typeof a === 'string' ? a : (a.name || 'Unknown')).join(', ') : 'Unknown'),
        link: paper.link || 'N/A'
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
      authors: typeof paper.authors === 'string' ? paper.authors : (Array.isArray(paper.authors) ? paper.authors.map(author => typeof author === 'string' ? author : (author.name || 'Unknown')).join(', ') : 'Unknown')
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
    // Clean any markdown formatting from the response
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
app.get('/stream-question', async (req, res) => {
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
        // Stage 2: Academic search
        res.write(`data: ${JSON.stringify({ 
          status: 'stage_update', 
          stage: 'paper_retrieval',
          message: `Searching for relevant scientific papers...` 
        })}\n\n`);

        // Initiate paper search
        let hasSentInitialResults = false;
        const paperSearchPromise = searchPapers(decision.queryWord, 5, 3).then(papers => {
          // Get the first batch of results and send them immediately
          if (!hasSentInitialResults && papers.length > 0) {
            hasSentInitialResults = true;
            
            // Format papers for an initial quick response
            const formattedPapers = formatPapersForClientResponse(papers);
            
            // Let the client know that papers are being found
            res.write(`data: ${JSON.stringify({ 
              status: 'papers_finding', 
              papers: formattedPapers,
              count: formattedPapers.length,
              message: 'Found papers, evaluating relevance...'
            })}\n\n`);
          }
          return papers;
        });
        
        // Get final papers
        const papers = await paperSearchPromise;
        
        // Update with paper search results
        if (!papers || papers.length === 0) {
          res.write(`data: ${JSON.stringify({ 
            status: 'stage_update', 
            stage: 'no_papers_found',
            message: `No relevant papers found for search term "${decision.queryWord}".`
          })}\n\n`);
          
          res.write(`data: ${JSON.stringify({ 
            status: 'complete', 
            result: {
              answer: `I couldn't find relevant scholarly articles for "${question}" using the search term "${decision.queryWord}".`,
              queryWord: decision.queryWord,
              citations: [],
              processSteps: ["Evaluated question scope", "Determined research needed", "Retrieved 0 papers", "Generated response"]
            }
          })}\n\n`);
          res.end();
          return;
        }
        
        // Format papers for client response
        const formattedPapers = formatPapersForClientResponse(papers);
        
        // Show all found papers
        res.write(`data: ${JSON.stringify({ 
          status: 'substage_update', 
          stage: 'papers_found',
          message: `Found ${formattedPapers.length} papers to evaluate.`,
          papers: formattedPapers
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
          authors: typeof paper.authors === 'string' ? paper.authors : (Array.isArray(paper.authors) ? paper.authors.map(author => typeof author === 'string' ? author : (author.name || 'Unknown')).join(', ') : 'Unknown'),
          link: paper.link || 'N/A'
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
          let authorLastName = 'Unknown';
          
          if (typeof citation.authors === 'string') {
            // If authors is already a string, extract the first author's last name
            const firstAuthor = citation.authors.split(',')[0];
            authorLastName = firstAuthor ? firstAuthor.split(' ').pop() : 'Unknown';
          } else if (Array.isArray(citation.authors) && citation.authors.length > 0) {
            // If authors is an array, get the first author
            const firstAuthor = citation.authors[0];
            if (typeof firstAuthor === 'string') {
              authorLastName = firstAuthor.split(' ').pop();
            } else if (firstAuthor && firstAuthor.name) {
              authorLastName = firstAuthor.name.split(' ').pop();
            }
          }
          
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
Authors: ${typeof citation.authors === 'string' ? citation.authors : (Array.isArray(citation.authors) ? citation.authors.join(', ') : 'Unknown')}
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
            queryWord: decision.queryWord,
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

function formatPapersForClientResponse(papers) {
  return papers.map(paper => {
    return {
      title: paper.title || 'No title available',
      abstract: paper.abstract || 'No abstract available',
      year: paper.year || 'Unknown',
      authors: typeof paper.authors === 'string' ? paper.authors : (Array.isArray(paper.authors) ? paper.authors.map(a => typeof a === 'string' ? a : (a.name || 'Unknown')).join(', ') : 'Unknown'),
      source: paper.source || 'Unknown Source',
      link: paper.link || '#'
    };
  });
}
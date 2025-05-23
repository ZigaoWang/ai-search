require('dotenv').config();  // Load environment variables from .env
const express = require('express');
const axios = require('axios');
const util = require('util');
const sleep = util.promisify(setTimeout);
const { nanoid } = require('nanoid');

const app = express();
const port = process.env.PORT || 3000;
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';

// Add middleware to parse JSON bodies
app.use(express.json());

// Enable CORS only for the frontend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', frontendUrl);
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Backend API endpoints only - no static file serving

// Semantic Scholar API endpoint for paper search
const SEMSCHOLAR_BASE_URL = 'https://api.semanticscholar.org/graph/v1/paper/search';

// CORE API endpoint for paper search
const CORE_BASE_URL = 'https://api.core.ac.uk/v3/search/works';
const CORE_API_KEY = process.env.CORE_API_KEY; // Make sure to add this to your .env file

// arXiv API endpoint for paper search
const ARXIV_BASE_URL = 'http://export.arxiv.org/api/query';

// PubMed API endpoint for paper search
const PUBMED_BASE_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const PUBMED_SUMMARY_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';
const PUBMED_API_KEY = process.env.PUBMED_API_KEY;

// Use the new UniAPI endpoint for chat completions
const OPENAI_BASE_URL = 'https://api.uniapi.io/v1/chat/completions';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // Ensure your .env file has your UniAPI key

// Define model constants for different tasks
const MODEL_BASIC = "gpt-4o-mini"; // For simpler tasks: evaluation, keyword generation, filtering
const MODEL_PREMIUM = "gpt-4o";    // For final high-quality response generation

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
 * Expands a search query into multiple search terms
 * Uses either alternative generation via API or simple expansion rules
 *
 * @param {string} query - The original search query
 * @returns {Promise<Array<string>>} - Array of search terms
 */
async function expandSearchTerms(query) {
  try {
    // Check if query is in a non-English language
    const isNonEnglish = await detectNonEnglishQuery(query);
    
    // If non-English, translate to English first
    let englishQuery = query;
    if (isNonEnglish) {
      logger('INFO', `Detected non-English query, translating...`);
      englishQuery = await translateToEnglish(query);
      logger('INFO', `Translated query: "${englishQuery}"`);
    }
    
    // Generate alternative search terms using the API
    const searchTerms = await generateAlternativeSearchTerms(englishQuery);
    logger('INFO', `Expanded search terms: ${searchTerms.join(', ')}`);
    
    return searchTerms;
  } catch (error) {
    logger('WARN', `Error expanding search terms: ${error.message}`);
    // If there's an error, just return the original query
    return [query];
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
async function searchPapers(query, limit = 30, retries = 3) {
  logger('INFO', `Searching academic databases for: "${query}" (limit: ${limit})`);
  
  // Expand the query to multiple search terms if needed
  const searchTerms = await expandSearchTerms(query);
  logger('INFO', `Expanded search terms: ${searchTerms.join(', ')}`);
  
  // Store all search promises
  const searchPromises = [];
  
  // Search for each term
  for (const term of searchTerms) {
    // Search arXiv
    searchPromises.push(
      searchArXiv(term, Math.ceil(limit/searchTerms.length))
        .catch(err => {
          logger('WARN', `ArXiv search failed for term "${term}": ${err.message}`);
          return [];
        })
    );
    
    // Search PubMed
    searchPromises.push(
      searchPubMed(term, Math.ceil(limit/searchTerms.length))
        .catch(err => {
          logger('WARN', `PubMed search failed for term "${term}": ${err.message}`);
          return [];
        })
    );
    
    // Search Semantic Scholar
    searchPromises.push(
      searchSemanticScholar(term, Math.ceil(limit/searchTerms.length))
        .catch(err => {
          logger('WARN', `Semantic Scholar search failed for term "${term}": ${err.message}`);
          return [];
        })
    );
    
    // Search CORE
    searchPromises.push(
      searchCORE(term, Math.ceil(limit/searchTerms.length))
        .catch(err => {
          logger('WARN', `CORE search failed for term "${term}": ${err.message}`);
          return [];
        })
    );
  }
  
  // Wait for all additional searches to complete
  const searchResults = await Promise.all(searchPromises);
  
  // Combine all search results
  let allPapers = [];
  searchResults.forEach(papers => {
    allPapers = [...allPapers, ...papers];
  });
  
  logger('INFO', `Found ${allPapers.length} papers in total before deduplication`);
  
  // Remove duplicates
  const uniquePapers = removeDuplicatePapers(allPapers);
  logger('INFO', `Found ${uniquePapers.length} unique papers`);
  
  // Sort papers by relevance (currently using citation count as a proxy for relevance)
  const sortedPapers = uniquePapers.sort((a, b) => {
    // Use citation count as primary sort criteria if available
    const citationDiff = (b.citationCount || 0) - (a.citationCount || 0);
    if (citationDiff !== 0) return citationDiff;
    
    // If citation counts are the same, use recency (publication year) as secondary criteria
    const yearA = parseInt(a.year) || 0;
    const yearB = parseInt(b.year) || 0;
    return yearB - yearA;
  });
  
  // Limit the number of papers
  const limitedPapers = sortedPapers.slice(0, limit);
  logger('INFO', `Returning ${limitedPapers.length} papers`);
  
  return limitedPapers;
}

/**
 * Balances the results to ensure a good mix of sources
 */
function balanceResultSources(papers, targetTotal) {
  if (!papers || papers.length === 0) return [];
  
  // Count papers by source
  const bySource = {};
  papers.forEach(paper => {
    const source = paper.source || 'Unknown';
    if (!bySource[source]) bySource[source] = [];
    bySource[source].push(paper);
  });
  
  // Get list of sources
  const sources = Object.keys(bySource);
  if (sources.length <= 1) return papers; // No balancing needed for single source
  
  // Prepare the balanced output
  const balanced = [];
  const perSourceTarget = Math.ceil(targetTotal / sources.length);
  
  // First round: take up to perSourceTarget from each source
  sources.forEach(source => {
    const sourcePapers = bySource[source];
    for (let i = 0; i < Math.min(perSourceTarget, sourcePapers.length); i++) {
      balanced.push(sourcePapers[i]);
    }
  });
  
  // Second round: fill with any remaining papers from any source
  // to reach targetTotal if we didn't get enough in first round
  if (balanced.length < targetTotal) {
    const remaining = [];
    sources.forEach(source => {
      const taken = Math.min(perSourceTarget, bySource[source].length);
      remaining.push(...bySource[source].slice(taken));
    });
    
    // Add remaining papers until we reach targetTotal
    remaining.sort((a, b) => {
      // Sort by relevance, citation count, etc. if available
      return (b.citationCount || 0) - (a.citationCount || 0);
    });
    
    for (let i = 0; i < Math.min(remaining.length, targetTotal - balanced.length); i++) {
      balanced.push(remaining[i]);
    }
  }
  
  return balanced;
}

// Add a simple in-memory cache for search results
const searchCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour in milliseconds

// 添加每日摘要缓存
const dailyDigestCache = {};

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
      model: MODEL_BASIC, // Use the cheaper model for translation
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
        model: MODEL_BASIC, // Use the cheaper model for generating search terms
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
 * Searches arXiv API with a specific query term
 */
async function searchArXiv(query, limit = 5) {
  logger('INFO', `Searching arXiv for: "${query}"`);
  
  try {
    const response = await axios.get(ARXIV_BASE_URL, {
      params: {
        search_query: `all:${query}`,
        start: 0,
        max_results: limit
      }
    });

    if (response.status === 200 && response.data) {
      // arXiv returns XML, we need to parse it
      const xml = response.data;
      
      // Simple extraction of entries (simplified approach)
      let entries = [];
      const matches = xml.match(/<entry>[\s\S]*?<\/entry>/g);
      
      if (matches && matches.length > 0) {
        entries = matches.map(entry => {
          // Extract title
          const titleMatch = entry.match(/<title>(([\s\S]*?))<\/title>/);
          const title = titleMatch ? titleMatch[1].trim() : 'N/A';
          
          // Extract summary
          const summaryMatch = entry.match(/<summary>(([\s\S]*?))<\/summary>/);
          const abstract = summaryMatch ? summaryMatch[1].trim() : 'No abstract available';
          
          // Extract published date
          const publishedMatch = entry.match(/<published>(([\s\S]*?))<\/published>/);
          const year = publishedMatch ? publishedMatch[1].slice(0, 4) : 'N/A';
          
          // Extract authors - improved approach to get actual author names
          let authors = [];
          const authorMatches = entry.match(/<author>[\s\S]*?<\/author>/g);
          if (authorMatches && authorMatches.length > 0) {
            authorMatches.forEach(authorXml => {
              const nameMatch = authorXml.match(/<name>([^<]+)<\/name>/);
              if (nameMatch && nameMatch[1]) {
                authors.push(nameMatch[1].trim());
              }
            });
          }
          
          // Join author names or provide a fallback
          const authorString = authors.length > 0 ? authors.join(', ') : 'Unknown';
          
          // Extract link
          const idMatch = entry.match(/<id>(([\s\S]*?))<\/id>/);
          const link = idMatch ? idMatch[1].trim() : 'Unknown';
          
          return {
            title,
            abstract,
            year,
            citationCount: 0,
            referenceCount: 0,
            authors: authorString,
            link,
            source: 'arXiv'
          };
        });
      }
      
      logger('INFO', `Found ${entries.length} papers on arXiv`);
      return entries;
    } else {
      logger('ERROR', `Unexpected response from arXiv API`, response.status);
      return [];
    }
  } catch (error) {
    logger('ERROR', `arXiv API error: ${error.message}`);
    // Return empty array instead of throwing an error
    return [];
  }
}

/**
 * Searches PubMed API with a specific query term
 */
async function searchPubMed(query, limit = 5) {
  logger('INFO', `Searching PubMed for: "${query}"`);
  
  try {
    // Add delay to avoid rate limiting
    const maxRetries = 3;
    let retries = 0;
    let success = false;
    let idList = [];
    
    // First step: Use esearch to get paper IDs with retry logic
    while (!success && retries < maxRetries) {
      try {
        const searchUrl = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
        const searchResponse = await axios.get(searchUrl, {
          params: {
            db: 'pubmed',
            term: query,
            retmax: limit,
            retmode: 'json',
            sort: 'relevance',
            // Add API key if available to increase rate limits
            api_key: PUBMED_API_KEY || undefined
          }
        });

        if (searchResponse.status !== 200 || !searchResponse.data || !searchResponse.data.esearchresult) {
          logger('WARN', `PubMed search returned unexpected response format`);
          return [];
        }

        idList = searchResponse.data.esearchresult.idlist || [];
        logger('INFO', `Found ${idList.length} paper IDs on PubMed`);
        success = true;
      } catch (error) {
        retries++;
        if (error.response && error.response.status === 429) {
          logger('WARN', `PubMed API rate limit hit, retrying in ${retries * 2} seconds... (Attempt ${retries}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, retries * 2000)); // Exponential backoff
        } else {
          throw error; // If it's not a rate limit error, rethrow
        }
      }
    }
    
    if (idList.length === 0) {
      return [];
    }

    // Reset for second API call
    retries = 0;
    success = false;
    let papers = [];
    
    // Second step: Use esummary to get paper metadata with retry logic
    while (!success && retries < maxRetries) {
      try {
        const summaryUrl = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';
        const summaryResponse = await axios.get(summaryUrl, {
          params: {
            db: 'pubmed',
            id: idList.join(','),
            retmode: 'json',
            // Add API key if available
            api_key: PUBMED_API_KEY || undefined
          }
        });

        if (summaryResponse.status !== 200 || !summaryResponse.data || !summaryResponse.data.result) {
          logger('WARN', `PubMed summary returned unexpected response format`);
          return [];
        }

        // Process paper data
        const result = summaryResponse.data.result;
        const uids = result.uids || [];
        
        for (const id of uids) {
          if (result[id]) {
            const paper = result[id];
            
            // Extract author information
            let authors = 'Unknown';
            if (paper.authors && paper.authors.length > 0) {
              authors = paper.authors.map(author => `${author.name}`).join(', ');
            }
            
            // Extract year
            let year = 'N/A';
            if (paper.pubdate) {
              const dateMatch = paper.pubdate.match(/(\d{4})/);
              year = dateMatch ? dateMatch[1] : 'N/A';
            }
            
            papers.push({
              title: paper.title || 'No title available',
              abstract: paper.abstract || paper.booktitle || 'No abstract available',
              year: year,
              citationCount: 0, // PubMed doesn't provide citation count
              referenceCount: 0,
              authors: authors,
              link: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
              source: 'PubMed'
            });
          }
        }
        
        success = true;
      } catch (error) {
        retries++;
        if (error.response && error.response.status === 429) {
          logger('WARN', `PubMed API rate limit hit, retrying in ${retries * 2} seconds... (Attempt ${retries}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, retries * 2000)); // Exponential backoff
        } else {
          throw error; // If it's not a rate limit error, rethrow
        }
      }
    }
    
    logger('INFO', `Successfully processed ${papers.length} papers from PubMed`);
    return papers;
  } catch (error) {
    logger('ERROR', `PubMed API error: ${error.message}`);
    // Return empty array instead of throwing an error so the program can continue
    return [];
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

IMPORTANT: Be liberal in your assessment. Only respond with canAnswer: true if the question is extremely simple and straightforward, and you are absolutely certain you can provide a complete and accurate answer without citations. Otherwise, respond with canAnswer: false.

Return ONLY raw, parseable JSON in one of these two formats:
1. {"canAnswer": true, "answer": "your answer here"}
2. {"canAnswer": false, "queryWord": "suggested search keyword"}

Do not include backticks, markdown formatting, or any other text.
Question: "${question}"
`;

  try {
    logger('DEBUG', `Making request to OpenAI API for decision`);
    const response = await axios.post(OPENAI_BASE_URL, {
      model: MODEL_BASIC, // Use the cheaper model for this simpler task
      messages: [
        { role: "system", content: "You are a helpful assistant. Always provide raw JSON without backticks or markdown. Please use the language the user is using in their question." },
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
  
  // Prepare citation keys for references
  const citationsWithKeys = citations.map((citation, index) => {
    let authorLastName = 'Unknown';
    
    if (typeof citation.authors === 'string') {
      // If authors is already a string, extract the first author's last name
      const authorParts = citation.authors.split(',')[0].trim().split(' ');
      authorLastName = authorParts[authorParts.length - 1];
    } else if (Array.isArray(citation.authors) && citation.authors.length > 0) {
      // If authors is an array, get the last name of the first author
      const firstAuthor = citation.authors[0];
      if (typeof firstAuthor === 'string') {
        const authorParts = firstAuthor.trim().split(' ');
        authorLastName = authorParts[authorParts.length - 1];
      } else if (firstAuthor && firstAuthor.name) {
        const authorParts = firstAuthor.name.trim().split(' ');
        authorLastName = authorParts[authorParts.length - 1];
      }
    }
    
    // Use year if available
    const year = citation.year || 'n.d.';
    
    // Create citation key
    const citationKey = `[${authorLastName}${year}]`;
    
    return {
      ...citation,
      citationKey
    };
  });
  
  // Split citations into batches for parallel processing
  const BATCH_SIZE = 5;
  const citationBatches = [];
  
  for (let i = 0; i < citationsWithKeys.length; i += BATCH_SIZE) {
    citationBatches.push(citationsWithKeys.slice(i, i + BATCH_SIZE));
  }
  
  logger('INFO', `Split ${citationsWithKeys.length} citations into ${citationBatches.length} batches`);
  
  // Process each batch sequentially
  const batchResults = [];
  for (const batch of citationBatches) {
    // Format citations for analysis
    const citationsText = batch.map((citation) => {
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
5. Please use the language the user is using in their question.

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
      logger('DEBUG', `Making request to OpenAI API for analysis`);
      // 使用改进的流式处理方法
      const paperAnalysis = await streamOpenAIResponse(analysisPrompt, null, 'analysis', MODEL_BASIC); // Use cheaper model for paper analysis
      
      logger('INFO', `Paper analysis complete (${paperAnalysis.length} characters)`);
      logger('DEBUG', `Paper analysis: ${paperAnalysis.substring(0, 500)}...`);
      
      batchResults.push(paperAnalysis);
    } catch (error) {
      logger('ERROR', `OpenAI API error in generating analysis:`, error.message);
      throw error;
    }
  }
  
  // Combine batch results
  const combinedAnalysis = batchResults.join('\n\n');
  
  // Step 2: Generate the final answer using the combined analysis
  logger('INFO', `Generating final answer with combined analysis`);
  
  // Answer prompt
  const answerPrompt = `
You are writing an academic response to the question: "${question}"

You must use the following paper analysis to craft your response:
${combinedAnalysis}

Important requirements:
1. Every claim must be supported by a specific citation using the format [AuthorYear] inline
2. Only include information that is directly supported by the papers in the analysis
3. Do not introduce new information not found in the papers
4. Maintain academic rigor and precision
5. Include a properly formatted Works Cited section at the end using MLA format
6. Structure your answer with clear sections and paragraphs

The citation keys to use are: ${citationsWithKeys.map(c => `[${c.citationKey}]`).join(', ')}
Please use the language the user is using in their question.
`;
  
  try {
    logger('DEBUG', `Making request to OpenAI API for final answer`);
    // 使用改进的流式处理方法
    const finalAnswer = await streamOpenAIResponse(answerPrompt, null, 'final_answer', MODEL_PREMIUM); // Use premium model for final answer generation
      
    logger('INFO', `Answer generation complete (${finalAnswer.length} characters)`);
    
    // Final answer with proper citations
    logger('INFO', `Answer generation process complete`);
    return {
      answer: finalAnswer,
      analysis: combinedAnalysis,
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
          answer: `我无法找到与"${question}"相关的学术文章，使用搜索词"${queryWord}"。`,
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
        link: paper.link || paper.url || paper.externalIds?.DOI || '',
        id: paper.paperId || paper.id || Math.random().toString(36).substring(2, 15)
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
    res.write(`data: ${JSON.stringify({
      status: 'processing',
      message: 'Starting research process...'
    })}\n\n`);
  }
  
  try {
    if (useSSE) {
      // Process with progress updates
      const sendUpdate = (message) => {
        res.write(`data: ${JSON.stringify({
          status: 'processing',
          message
        })}\n\n`);
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
      res.write(`data: ${JSON.stringify({
        status: 'complete',
        result
      })}\n\n`);
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
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ 
          status: 'error', 
          error: error.message,
          stage: 'error'
        })}\n\n`);
        res.end();
      }
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
 * Searches Semantic Scholar API with a specific query term
 */
async function searchSemanticScholar(query, limit = 5) {
  logger('INFO', `Searching Semantic Scholar for: "${query}"`);
  
  try {
    // Implement rate limit handling with retry logic
    const maxRetries = 3;
    let retries = 0;
    let success = false;
    let papers = [];
    
    while (!success && retries < maxRetries) {
      try {
        const response = await axios.get(SEMSCHOLAR_BASE_URL, {
          params: {
            query: query,
            limit: limit,
            fields: 'title,abstract,authors,year,citationCount,referenceCount,url'
          },
          headers: {
            'x-api-key': process.env.SEMSCHOLAR_API_KEY || ''
          }
        });
        
        if (response.status === 200 && response.data && response.data.data) {
          // Process results
          papers = response.data.data.map(paper => {
            // Extract authors - properly format as a string
            let authorString = 'Unknown';
            if (paper.authors && Array.isArray(paper.authors) && paper.authors.length > 0) {
              authorString = paper.authors
                .map(author => (author && typeof author === 'object' && author.name) ? author.name : 'Unknown')
                .join(', ');
            }
            
            // Make sure year is properly formatted
            let yearString = 'Unknown';
            if (paper.year && paper.year !== 'N/A') {
              yearString = paper.year.toString();
            }
            
            return {
              title: paper.title || 'No title available',
              abstract: paper.abstract || 'No abstract available',
              year: yearString,
              citationCount: paper.citationCount || 0,
              referenceCount: paper.referenceCount || 0,
              authors: authorString,
              link: paper.url || 'No link available',
              source: 'Semantic Scholar'
            };
          });
          success = true;
        } else {
          logger('WARN', `Unexpected response from Semantic Scholar API: ${response.status}`);
          return [];
        }
      } catch (error) {
        retries++;
        // Handle rate limiting specifically
        if (error.response && (error.response.status === 429 || error.response.status === 403)) {
          logger('WARN', `Semantic Scholar API rate limit hit, retrying in ${retries * 2} seconds... (Attempt ${retries}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, retries * 2000)); // Exponential backoff
        } else {
          throw error; // If it's not a rate limit error, rethrow
        }
      }
    }
    
    logger('INFO', `Found ${papers.length} papers on Semantic Scholar`);
    return papers;
  } catch (error) {
    logger('ERROR', `Semantic Scholar API error: ${error.message}`);
    return [];
  }
}

/**
 * Searches CORE API with a specific query term
 */
async function searchCORE(query, limit = 5) {
  logger('INFO', `Searching CORE for: "${query}"`);
  
  try {
    // Implement rate limit handling with retry logic
    const maxRetries = 3;
    let retries = 0;
    let success = false;
    let papers = [];
    
    while (!success && retries < maxRetries) {
      try {
        const response = await axios.post(CORE_BASE_URL, {
          q: query,
          size: limit,
          offset: 0
        }, {
          headers: {
            'Authorization': `Bearer ${CORE_API_KEY}`,
            'Content-Type': 'application/json'
          }
        });
        
        if (response.status === 200 && response.data && response.data.results) {
          // Process results
          papers = response.data.results.map(paper => {
            // Process authors properly
            let authorString = 'Unknown';
            if (paper.authors && Array.isArray(paper.authors) && paper.authors.length > 0) {
              authorString = paper.authors
                .map(author => typeof author === 'string' ? author : 
                  (author && typeof author === 'object' && author.name) ? author.name : 'Unknown')
                .join(', ');
            }
            
            // Make sure year is properly formatted
            let yearString = 'Unknown';
            if (paper.year && paper.year !== 'N/A') {
              yearString = paper.year.toString();
            }
            
            return {
              title: paper.title || 'No title available',
              abstract: paper.abstract || paper.description || 'No abstract available',
              year: yearString,
              citationCount: 0, // CORE doesn't provide citation count
              referenceCount: 0,
              authors: authorString,
              link: paper.downloadUrl || paper.url || paper.externalIds?.DOI || '',
              source: 'CORE'
            };
          });
          success = true;
        } else {
          logger('WARN', `Unexpected response from CORE API: ${response.status}`);
          return [];
        }
      } catch (error) {
        retries++;
        // Handle rate limiting specifically
        if (error.response && (error.response.status === 429 || error.response.status === 403)) {
          logger('WARN', `CORE API rate limit hit, retrying in ${retries * 2} seconds... (Attempt ${retries}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, retries * 2000)); // Exponential backoff
        } else {
          throw error; // If it's not a rate limit error, rethrow
        }
      }
    }
    
    logger('INFO', `Found ${papers.length} papers on CORE`);
    return papers;
  } catch (error) {
    logger('ERROR', `CORE API error: ${error.message}`);
    return [];
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
    return res.status(400).json({ error: '缺少查询参数' });
  }
  
  // Setup SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // Send initial connection confirmation
  res.write(`data: ${JSON.stringify({ 
    status: 'connected', 
    message: '流式连接已建立' 
  })}\n\n`);
  
  // Process function with streaming updates
  (async () => {
    try {
      // Store original logger for later restoration
      const originalLogger = global.logger || logger;
      
      // Step 1: Determine if question can be answered internally
      res.write(`data: ${JSON.stringify({ 
        status: 'stage_update', 
        stage: 'evaluation',
        message: '正在评估您的问题是否需要外部研究...' 
      })}\n\n`);
      
      const decision = await decideAnswer(question);
      
      // Update on decision result
      res.write(`data: ${JSON.stringify({ 
        status: 'substage_update', 
        stage: 'evaluation_complete',
        message: decision.canAnswer 
          ? '您的问题可以直接回答，不需要外部研究。' 
          : '您的问题需要搜索外部研究论文。',
        canAnswer: decision.canAnswer
      })}\n\n`);
      
      if (decision.canAnswer) {
        // Direct answer from AI, use token-by-token streaming
        const prompt = `Provide a comprehensive answer to the following question: "${question}"
        Please use the language the user is using in their question.`;
        
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
        
        // Restore original logger
        global.logger = originalLogger;
      } else {
        // Stage 2: Academic search
        res.write(`data: ${JSON.stringify({ 
          status: 'stage_update', 
          stage: 'paper_retrieval',
          message: '正在搜索相关学术论文...' 
        })}\n\n`);

        // Initiate paper search
        let hasSentInitialResults = false;
        const paperSearchPromise = searchPapers(decision.queryWord, 30, 3).then(papers => {
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
              message: '找到论文，正在评估相关性...'
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
            message: `未找到与搜索词"${decision.queryWord}"相关的论文。`
          })}\n\n`);
          
          res.write(`data: ${JSON.stringify({ 
            status: 'complete', 
            result: {
              answer: `我无法找到与"${question}"相关的学术文章，使用搜索词"${decision.queryWord}"。`,
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
          message: `找到${formattedPapers.length}篇论文进行评估。`,
          papers: formattedPapers
        })}\n\n`);
        
        // NEW STEP: Filter papers for relevance
        res.write(`data: ${JSON.stringify({ 
          status: 'substage_update', 
          stage: 'filtering_papers',
          message: '正在评估论文与您问题的相关性...'
        })}\n\n`);
        
        const filteredPapers = await filterRelevantPapers(question, papers);
        const filteredCitations = filteredPapers.map(paper => ({
          title: paper.title || 'N/A',
          abstract: paper.abstract || 'No abstract available',
          year: paper.year || 'N/A',
          citationCount: (paper.citationCount !== undefined) ? paper.citationCount : 0,
          referenceCount: (paper.referenceCount !== undefined) ? paper.referenceCount : 0,
          authors: typeof paper.authors === 'string' ? paper.authors : (Array.isArray(paper.authors) ? paper.authors.join(', ') : 'Unknown'),
          link: paper.link || paper.url || paper.externalIds?.DOI || '',
          id: paper.paperId || paper.id || Math.random().toString(36).substring(2, 15)
        }));
        
        // Inform which papers were selected
        res.write(`data: ${JSON.stringify({ 
          status: 'substage_update', 
          stage: 'papers_selected',
          message: `选择了${filteredCitations.length}篇最相关的论文进行详细分析。`,
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
          message: '正在分析所选研究论文...' 
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
          message: '已准备引用键用于分析',
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
5. Please use the language the user is using in their question.

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
        const paperAnalysis = await streamOpenAIResponse(analysisPrompt, res, 'analyzing_papers', MODEL_BASIC); // Use cheaper model for paper analysis
        
        // Step 5: Final answer generation with token-by-token streaming
        res.write(`data: ${JSON.stringify({ 
          status: 'stage_update', 
          stage: 'answer_generation',
          message: '正在准备您的最终答案...' 
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
Please use the language the user is using in their question.
`;
        
        // Generate final answer with token-by-token streaming
        const finalAnswer = await streamOpenAIResponse(answerPrompt, res, 'generating_answer', MODEL_PREMIUM); // Use premium model for final answer generation
        
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
      
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ 
          status: 'error', 
          error: error.message,
          stage: 'error'
        })}\n\n`);
        res.end();
      }
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
    // 处理作者信息，统一格式
    let formattedAuthors = '未知作者';
    if (typeof paper.authors === 'string') {
      formattedAuthors = paper.authors;
    } else if (Array.isArray(paper.authors)) {
      // 处理数组形式的作者，可能是对象数组或字符串数组
      formattedAuthors = paper.authors.map(author => {
        if (typeof author === 'string') {
          return author;
        } else if (author && author.name) {
          return author.name;
        }
        return 'Unknown';
      }).join(', ');
    }

    // 确保所有必要的字段都有值
    return {
      title: paper.title || '无标题',
      abstract: paper.abstract || '无摘要',
      authors: formattedAuthors,
      year: paper.year || '未知年份',
      source: paper.source || (paper.venue ? paper.venue.name : '未知来源'),
      link: paper.link || paper.url || paper.externalIds?.DOI || '',
      id: paper.paperId || paper.id || Math.random().toString(36).substring(2, 15)
    };
  });
}

/**
 * GET /stream-daily-digest?topics=<topic1 OR topic2>
 * 
 * Process topic subscriptions and generate a daily digest
 * with detailed streaming updates
 */
app.get('/stream-daily-digest', async (req, res) => {
  const requestId = Math.random().toString(36).substring(2, 15);
  const topics = req.query.topics;
  const useCache = req.query.cache !== 'false'; // 默认使用缓存
  
  logger('INFO', `[${requestId}] Received request for daily digest on topics: "${topics}"`);
  
  if (!topics) {
    logger('WARN', `[${requestId}] Missing topics parameter`);
    return res.status(400).json({ error: '缺少主题参数' });
  }
  
  // Setup SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // Send initial connection confirmation
  res.write(`data: ${JSON.stringify({ 
    status: 'connected', 
    message: '流式连接已建立' 
  })}\n\n`);
  
  // Process function with streaming updates
  (async () => {
    try {
      // 检查缓存
      if (useCache && dailyDigestCache[topics]) {
        logger('INFO', `[${requestId}] Found cached digest for "${topics}"`);
        
        // 发送缓存的搜索步骤
        for (const step of dailyDigestCache[topics].searchSteps) {
          res.write(`data: ${JSON.stringify({
            status: 'searchStep',
            step
          })}\n\n`);
          // 添加小延迟，使步骤显示更自然
          await new Promise(resolve => setTimeout(resolve, 300));
        }
        
        // 发送缓存的结果
        res.write(`data: ${JSON.stringify({ 
          status: 'complete', 
          result: dailyDigestCache[topics].result,
          fromCache: true
        })}\n\n`);
        
        res.end();
        return;
      }
      
      // 如果没有今日文章，返回提示信息
      return res.json({
        status: 'waiting',
        message: '今日文章尚未生成，请先选择主题',
        isNew: true
      });
    } catch (error) {
      logger('ERROR', `[${requestId}] 获取每日文章失败:`, error);
      
      if (!res.writableEnded) {
        res.status(500).json({
          status: 'error',
          message: '获取每日文章时出错：' + error.message
        });
      }
    }
  })();
});

// 检查是否为同一天（用于每日文章限制）
function isSameDay(date1, date2) {
  return date1.getFullYear() === date2.getFullYear() &&
         date1.getMonth() === date2.getMonth() &&
         date1.getDate() === date2.getDate();
}

// 获取今日日期的格式化字符串 YYYY-MM-DD
function getTodayDateString() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}

// 随机从多个主题中选择一个
function getRandomTopic(topics) {
  if (!topics.includes(' OR ')) {
    return topics;
  }
  const topicsArray = topics.split(' OR ').map(t => t.trim());
  return topicsArray[Math.floor(Math.random() * topicsArray.length)];
}

// 添加今日摘要API端点
app.get('/api/daily-article', async (req, res) => {
  const requestId = nanoid();
  const userId = req.query.userId || 'anonymous';
  const userCacheKey = `${userId}_daily_article`;
  const todayString = getTodayDateString();
  
  try {
    // 检查用户是否已有今日文章
    if (dailyDigestCache[userCacheKey] && 
        isSameDay(new Date(dailyDigestCache[userCacheKey].timestamp), new Date())) {
      // 返回今日已有文章
      console.log(`[${requestId}] 用户 ${userId} 获取今日已生成的文章`);
      return res.json({
        status: 'success',
        message: '今日文章已就绪',
        article: dailyDigestCache[userCacheKey].result,
        timestamp: dailyDigestCache[userCacheKey].timestamp,
        topic: dailyDigestCache[userCacheKey].topic,
        isNew: false
      });
    }
    
    // 如果没有今日文章，返回提示信息
    return res.json({
      status: 'waiting',
      message: '今日文章尚未生成，请先选择主题',
      isNew: true
    });
  } catch (error) {
    console.error(`[${requestId}] 获取每日文章失败:`, error);
    
    if (!res.writableEnded) {
      res.status(500).json({
        status: 'error',
        message: '获取每日文章时出错: ' + error.message
      });
    }
  }
});

// OpenAI API流式响应处理
async function streamOpenAIResponse(prompt, res, stage, model = MODEL_PREMIUM) {
  const systemMessage = {
    role: "system",
    content: "You are a professional academic writer crafting a response based solely on provided research."
  };

  try {
    // Signal start of streaming for this stage
    if (res) {
      res.write(`data: ${JSON.stringify({
        status: 'streaming',
        stage: stage,
        message: `Starting ${stage}...`
      })}\n\n`);
    }
    
    // Accumulate the complete response
    let completeResponse = '';
    
    const apiUrl = OPENAI_BASE_URL;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    };
    
    const body = {
      model: model,
      messages: [
        systemMessage,
        { role: "user", content: prompt }
      ],
      temperature: 0.7,
      stream: true
    };
    
    // Make streaming API call
    try {
      const response = await axios.post(apiUrl, body, {
        headers: headers,
        responseType: 'stream'
      });
      
      return new Promise((resolve, reject) => {
        let buffer = '';
        
        response.data.on('data', (chunk) => {
          // Add the new chunk to our buffer
          buffer += chunk.toString();
          
          // Process complete messages from the buffer
          let processBuffer = () => {
            // Find the position of the next data prefix
            const dataPrefix = 'data: ';
            const prefixIndex = buffer.indexOf(dataPrefix);
            
            if (prefixIndex === -1) return false; // No complete message yet
            
            // Find the end of this message
            const messageEnd = buffer.indexOf('\n', prefixIndex + dataPrefix.length);
            if (messageEnd === -1) return false; // Message not complete yet
            
            // Extract the message
            const message = buffer.substring(prefixIndex + dataPrefix.length, messageEnd).trim();
            
            // Remove the processed message from the buffer
            buffer = buffer.substring(messageEnd + 1);
            
            // Skip [DONE] messages
            if (message === '[DONE]') return true;
            
            try {
              // Parse the JSON data
              const parsedData = JSON.parse(message);
              const content = parsedData.choices[0]?.delta?.content;
              
              if (content) {
                completeResponse += content;
                
                // Send the token to the client
                if (res) {
                  res.write(`data: ${JSON.stringify({
                    status: 'token',
                    stage: stage,
                    token: content
                  })}\n\n`);
                }
              }
              return true; // Successfully processed a message
            } catch (parseError) {
              // Log the error but continue processing
              logger('WARN', `Received non-JSON data from OpenAI: ${message.substring(0, 50)}...`);
              return true; // Continue to next message
            }
          };
          
          // Process as many complete messages as we can
          while (processBuffer()) {}
        });
        
        response.data.on('end', () => {
          // Signal completion of this streaming phase
          if (res) {
            res.write(`data: ${JSON.stringify({
              status: 'chunk_complete',
              stage: stage,
              message: `${stage} complete`,
              content: completeResponse
            })}\n\n`);
          }
          
          resolve(completeResponse);
        });
        
        response.data.on('error', (err) => {
          logger('ERROR', `Stream error in ${stage}:`, err);
          reject(err);
        });
      });
      
    } catch (apiError) {
      logger('ERROR', `API error in ${stage}:`, apiError.message);
      
      // Fallback to non-streaming API if streaming fails
      const nonStreamingBody = {
        model: model,
        messages: [
          systemMessage,
          { role: "user", content: prompt }
        ],
        temperature: 0.7,
        stream: false
      };
      
      try {
        const nonStreamResponse = await axios.post(apiUrl, nonStreamingBody, {
          headers: headers
        });
        
        const content = nonStreamResponse.data.choices[0].message.content;
        return content;
      } catch (fallbackError) {
        logger('ERROR', 'Fallback API call also failed:', fallbackError);
        throw fallbackError;
      }
    }
  } catch (error) {
    logger('ERROR', `Error in streamOpenAIResponse for ${stage}:`, error);
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
async function filterRelevantPapers(question, papers, maxPapers = 25) {
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
      authors: typeof paper.authors === 'string' ? paper.authors : 
               (Array.isArray(paper.authors) ? paper.authors.map(a => typeof a === 'string' ? a : (a.name || 'Unknown')).join(', ') : 'Unknown')
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
      model: MODEL_BASIC, // Use the cheaper model for paper filtering
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
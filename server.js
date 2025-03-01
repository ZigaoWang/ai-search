const express = require('express');
const axios = require('axios');
const util = require('util');
const sleep = util.promisify(setTimeout);

const app = express();
const port = process.env.PORT || 3000;

// Semantic Scholar API endpoint for paper search
const BASE_URL = 'https://api.semanticscholar.org/graph/v1/paper/search';

/**
 * Searches Semantic Scholar for papers matching the query.
 * Implements a simple retry mechanism for HTTP 429 errors.
 *
 * @param {string} query - The search query.
 * @param {number} limit - Number of results to fetch.
 * @param {number} retries - Number of remaining retries.
 * @returns {Promise<Array>} - Resolves to an array of raw paper objects.
 */
async function searchPapers(query, limit = 5, retries = 3) {
  try {
    const response = await axios.get(BASE_URL, {
      params: {
        query: query, 
        limit: limit,
        // Request the fields we need
        fields: "paperId,title,authors,year,abstract,citationCount,referenceCount"
      }
    });

    if (response.status === 200 && response.data && response.data.data) {
      return response.data.data;
    } else {
      throw new Error("Error: Unable to fetch data from Semantic Scholar API.");
    }
  } catch (error) {
    if (error.response && error.response.status === 429) {
      if (retries > 0) {
        console.warn('Rate limit reached (429). Retrying in 3 seconds...');
        await sleep(3000);
        return searchPapers(query, limit, retries - 1);
      } else {
        throw new Error('Rate limit reached. Please try again later.');
      }
    } else {
      throw error;
    }
  }
}

// API endpoint: GET /search?query=...
app.get('/search', async (req, res) => {
  const query = req.query.query;
  if (!query) {
    return res.status(400).json({ error: 'Missing query parameter' });
  }
  try {
    const rawPapers = await searchPapers(query);
    // Transform raw results to include only the relevant fields
    const papers = rawPapers.map(paper => {
      return {
        title: paper.title || 'N/A',
        abstract: paper.abstract || 'No abstract available',
        year: paper.year || 'N/A',
        citationCount: (paper.citationCount !== undefined) ? paper.citationCount : 'N/A',
        referenceCount: (paper.referenceCount !== undefined) ? paper.referenceCount : 'N/A',
        authors: paper.authors ? paper.authors.map(author => author.name) : [],
        // Construct a link using the paperId
        link: paper.paperId ? `https://semanticscholar.org/paper/${paper.paperId}` : 'N/A'
      }
    });
    res.json({ papers });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Semantic Scholar API server is listening on port ${port}`);
});

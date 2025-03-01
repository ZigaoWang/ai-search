# AI Search API

This API provides endpoints for processing research questions using Semantic Scholar and UniAPI (OpenAI) to generate comprehensive answers with citations.

## Endpoints

### GET /question

Process a question through the research pipeline.

**Query Parameters:**
- `query` (string): The user question to be processed.
- `sse` (boolean, optional): If set to `true`, enables Server-Sent Events (SSE) for real-time updates.

**Response:**
- `200 OK`: Returns the result object with the answer and metadata.
- `400 Bad Request`: Missing query parameter.
- `500 Internal Server Error`: Error processing the request.

### POST /question

Process a question through the research pipeline using a POST request.

**Request Body:**
- `query` (string): The user question to be processed.

**Response:**
- `200 OK`: Returns the result object with the answer and metadata.
- `400 Bad Request`: Missing query in request body.
- `500 Internal Server Error`: Error processing the request.

### GET /stream-question

Process a question with streaming updates.

**Query Parameters:**
- `query` (string): The user question to be processed.

**Response:**
- `200 OK`: Returns streaming updates and the final result object with the answer and metadata.
- `400 Bad Request`: Missing query parameter.
- `500 Internal Server Error`: Error processing the request.

### GET /health

Health check endpoint to verify the server status.

**Response:**
- `200 OK`: Returns the server status, version, environment, and timestamp.

## Environment Variables

- `PORT`: The port on which the server will listen (default: 3000).
- `OPENAI_API_KEY`: The API key for accessing the UniAPI (OpenAI) endpoint.
- `LOG_LEVEL`: The logging level (e.g., `ERROR`, `WARN`, `INFO`, `DEBUG`).

## Logging

The server uses a custom logging function with the following log levels:
- `ERROR`
- `WARN`
- `INFO`
- `DEBUG`

The current log level is determined by the `LOG_LEVEL` environment variable.

## Usage

1. Ensure you have a `.env` file with the necessary environment variables.
2. Start the server:
   ```bash
   node server.js
   ```
3. Access the endpoints as described above.


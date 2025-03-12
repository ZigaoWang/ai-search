# ZhiDao AI API Documentation

**Version**: 1.0.0  
**Base URL**: `http://localhost:3000`  
**Date**: March 12, 2025

This document describes the `GET /stream-question` endpoint of the AI Research Assistant API, which processes a research question with detailed streaming updates and token-by-token answer generation. It integrates with academic databases (e.g., arXiv, PubMed, Semantic Scholar, CORE) and uses AI to generate comprehensive answers with citations.

---

## Table of Contents

1. [Endpoint Overview](#endpoint-overview)
2. [GET /stream-question](#get-stream-question)
   - [Description](#description)
   - [URL](#url)
   - [Method](#method)
   - [Query Parameters](#query-parameters)
   - [Response](#response)
   - [Event Types](#event-types)
   - [Status Codes](#status-codes)
   - [Example](#example)
3. [Error Handling](#error-handling)
4. [Example Usage](#example-usage)

---

## Endpoint Overview

The `GET /stream-question` endpoint is designed for real-time interaction, providing a stream of Server-Sent Events (SSE) to update the client on the progress of processing a research question. It evaluates whether a question can be answered internally, searches academic databases if needed, filters relevant papers, analyzes them, and generates a comprehensive answer with citations—all streamed in stages.

---

## GET /stream-question

### Description

Processes a research question with detailed streaming updates, including token-by-token generation of the answer. The process involves:
1. Evaluating if the question can be answered internally.
2. Searching academic databases if external research is required.
3. Filtering papers for relevance.
4. Analyzing selected papers.
5. Generating a final answer with citations.

### URL

`/stream-question`

### Method

`GET`

### Query Parameters

- **`query`** (string, required): The research question to process.
  - Example: `What is the impact of AI on healthcare`

### Response

- **Content-Type**: `text/event-stream`
- **Format**: SSE events with `data: {JSON}` payloads, where each event represents a stage, sub-stage, token, or final result.

### Event Types

The endpoint streams various event types to keep the client informed:

1. **`connected`**  
   - Signals that the SSE connection is established.
   - **Payload**:
     ```json
     {
       "status": "connected",
       "message": "流式连接已建立"
     }
     ```

2. **`stage_update`**  
   - Indicates a new major processing stage.
   - **Payload**:
     ```json
     {
       "status": "stage_update",
       "stage": "evaluation | paper_retrieval | paper_analysis | answer_generation | no_papers_found",
       "message": "string"
     }
     ```
   - Examples: `evaluation`, `paper_retrieval`

3. **`substage_update`**  
   - Provides updates within a stage.
   - **Payload**:
     ```json
     {
       "status": "substage_update",
       "stage": "evaluation_complete | papers_found | papers_selected | citations_prepared",
       "message": "string",
       "canAnswer": boolean (optional),
       "papers": array (optional),
       "selectedPapers": array (optional),
       "citationKeys": array (optional)
     }
     ```

4. **`papers_finding`**  
   - Initial batch of papers found during search.
   - **Payload**:
     ```json
     {
       "status": "papers_finding",
       "papers": [
         {
           "title": "string",
           "abstract": "string",
           "authors": "string",
           "year": "string",
           "source": "string",
           "link": "string",
           "id": "string"
         }
       ],
       "count": number,
       "message": "string"
     }
     ```

5. **`streaming`**  
   - Marks the start of token-by-token streaming for a stage (e.g., paper analysis or answer generation).
   - **Payload**:
     ```json
     {
       "status": "streaming",
       "stage": "analyzing_papers | generating_answer",
       "message": "string"
     }
     ```

6. **`token`**  
   - Individual token of the streamed content (e.g., part of the analysis or answer).
   - **Payload**:
     ```json
     {
       "status": "token",
       "stage": "analyzing_papers | generating_answer",
       "token": "string"
     }
     ```

7. **`chunk_complete`**  
   - Indicates the end of a streaming phase with the full content.
   - **Payload**:
     ```json
     {
       "status": "chunk_complete",
       "stage": "analyzing_papers | generating_answer",
       "message": "string",
       "content": "string"
     }
     ```

8. **`complete`**  
   - Final result with the answer and metadata.
   - **Payload**:
     ```json
     {
       "status": "complete",
       "result": {
         "answer": "string",
         "queryWord": "string" (optional),
         "citations": [
           {
             "title": "string",
             "abstract": "string",
             "year": "string",
             "citationCount": number,
             "referenceCount": number,
             "authors": "string",
             "link": "string",
             "id": "string"
           }
         ],
         "paperAnalysis": "string" (optional),
         "citationMapping": [
           {
             "key": "string",
             "title": "string",
             "authors": "string",
             "year": "string",
             "link": "string"
           }
         ],
         "processSteps": ["string"]
       }
     }
     ```

9. **`error`**  
   - Indicates an error occurred during processing.
   - **Payload**:
     ```json
     {
       "status": "error",
       "error": "string",
       "stage": "string"
     }
     ```

### Status Codes

- **`200`**: Success (streaming begins)
- **`400`**: Missing `query` parameter
- **`500`**: Server error (streamed as an `error` event)

### Example

**Request**:
```
GET /stream-question?query=What%20is%20the%20impact%20of%20AI%20on%20healthcare
```

**Sample Response Stream**:
```
data: {"status":"connected","message":"流式连接已建立"}
data: {"status":"stage_update","stage":"evaluation","message":"正在评估您的问题是否需要外部研究..."}
data: {"status":"substage_update","stage":"evaluation_complete","message":"您的问题需要搜索外部研究论文。","canAnswer":false}
data: {"status":"stage_update","stage":"paper_retrieval","message":"正在搜索相关学术论文..."}
data: {"status":"papers_finding","papers":[{"title":"AI in Healthcare","authors":"Smith","year":"2023","source":"arXiv","link":"http://arxiv.org/123","id":"abc123"}],"count":1,"message":"找到论文，正在评估相关性..."}
data: {"status":"substage_update","stage":"papers_selected","message":"选择了1篇最相关的论文进行详细分析。","selectedPapers":[{"title":"AI in Healthcare","authors":"Smith","year":"2023","link":"http://arxiv.org/123"}]}
data: {"status":"streaming","stage":"analyzing_papers","message":"Starting analyzing_papers..."}
data: {"status":"token","stage":"analyzing_papers","token":"[Smith2023]: "}
data: {"status":"token","stage":"analyzing_papers","token":"- AI improves diagnosis\n"}
data: {"status":"chunk_complete","stage":"analyzing_papers","message":"analyzing_papers complete","content":"[Smith2023]: - AI improves diagnosis..."}
data: {"status":"streaming","stage":"generating_answer","message":"Starting generating_answer..."}
data: {"status":"token","stage":"generating_answer","token":"AI has a significant impact"}
data: {"status":"complete","result":{"answer":"AI has a significant impact...","queryWord":"AI healthcare","citations":[{"title":"AI in Healthcare"}],"paperAnalysis":"[Smith2023]: ...","citationMapping":[{"key":"Smith2023","title":"AI in Healthcare"}],"processSteps":["Evaluated question scope","Retrieved 1 papers"]}}
```

---

## Error Handling

- **Missing Parameter**: Returns a `400` status with a JSON error:
  ```json
  {"error": "缺少查询参数"}
  ```
- **Processing Errors**: Streamed as an `error` event:
  ```json
  {
    "status": "error",
    "error": "Internal server error",
    "stage": "paper_retrieval"
  }
  ```

---

## Example Usage

### Using cURL
```bash
curl "http://localhost:3000/stream-question?query=What%20is%20the%20impact%20of%20AI%20on%20healthcare"
```

### Using JavaScript (EventSource)
```javascript
const source = new EventSource('http://localhost:3000/stream-question?query=What%20is%20the%20impact%20of%20AI%20on%20healthcare');

source.onmessage = (event) => {
  const data = JSON.parse(event.data);
  switch (data.status) {
    case 'connected':
      console.log('Connected:', data.message);
      break;
    case 'stage_update':
      console.log(`Stage: ${data.stage} - ${data.message}`);
      break;
    case 'token':
      process.stdout.write(data.token); // Stream tokens in real-time
      break;
    case 'complete':
      console.log('\nFinal Answer:', data.result.answer);
      source.close();
      break;
    case 'error':
      console.error('Error:', data.error);
      source.close();
      break;
  }
};

source.onerror = () => {
  console.error('Stream error occurred');
  source.close();
};
```

### Using Python (sseclient)
```python
import requests
from sseclient import SSEClient

url = 'http://localhost:3000/stream-question?query=What%20is%20the%20impact%20of%20AI%20on%20healthcare'
response = requests.get(url, stream=True)
client = SSEClient(response)

for event in client.events():
    data = json.loads(event.data)
    if data['status'] == 'token':
        print(data['token'], end='', flush=True)
    elif data['status'] == 'complete':
        print('\nFinal Answer:', data['result']['answer'])
    elif data['status'] == 'error':
        print('Error:', data['error'])
    else:
        print(f"{data['status']}: {data.get('message', '')}")
```

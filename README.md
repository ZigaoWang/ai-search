# AI Research Assistant

An intelligent research assistant that combines the power of large language models with academic search capabilities to provide well-cited answers to complex questions.

![AI Research Demo](https://via.placeholder.com/800x400?text=AI+Research+Assistant+Demo)

## Features

- **Intelligent Question Assessment**: Determines if a question needs external research or can be answered directly
- **Academic Research**: Searches academic papers from Semantic Scholar to find relevant information
- **Paper Analysis**: Analyzes and extracts key points from research papers
- **Citation Generation**: Creates properly formatted citations with links to source materials
- **Interactive References**: Click on citations to see the referenced paper details
- **Real-time Streaming**: Watch the answer being generated token-by-token with live markdown rendering
- **Process Transparency**: Visualize the entire research process from question to final answer

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) (v14 or newer)
- OpenAI API key or UniAPI key

### Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/ai-search.git
   cd ai-search
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file in the project root with your API key:
   ```
   OPENAI_API_KEY=your_api_key_here
   PORT=3000
   LOG_LEVEL=INFO
   ```

## Usage

1. Start the server:
   ```bash
   node server.js
   ```

2. Open your browser and navigate to:
   ```
   http://localhost:3000/
   ```

3. Enter a research question and watch as the system:
   - Evaluates whether the question requires research
   - Searches for relevant academic papers
   - Analyzes the papers for key information
   - Generates a comprehensive answer with proper citations

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/question` | GET/POST | Process a research question (JSON response) |
| `/stream-question` | GET | Process a question with streaming updates (SSE) |
| `/health` | GET | API health check |
| `/api` | GET | API documentation |

## Technology Stack

- **Backend**: Node.js with Express
- **APIs**: Semantic Scholar API, OpenAI/UniAPI
- **Frontend**: Vanilla JavaScript with Server-Sent Events (SSE) for streaming
- **Rendering**: Marked.js for real-time markdown rendering

## How It Works

1. **Question Analysis**: The system first determines if your question requires research or can be answered directly.
2. **Research**: For research questions, it generates relevant search terms and queries Semantic Scholar.
3. **Paper Analysis**: It extracts and synthesizes key information from the papers' abstracts.
4. **Answer Generation**: Using the extracted information, it creates a comprehensive answer with proper citations.

## License

MIT


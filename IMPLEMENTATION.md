# Workers AI Implementation

## Overview

The InsertaBot worker now uses **Cloudflare Workers AI** with the **Kimi K2.5** and **Kimi K2.6** models for chat completions.

## What Was Implemented

### 1. Chat Handler (`src/handlers/chat.ts`)

- **Non-streaming mode**: Calls `env.AI.run()` with the Kimi model and returns a complete response
- **Streaming mode**: Calls `env.AI.run()` with `stream: true` and streams chunks via Server-Sent Events (SSE)
- **OpenAI-compatible**: Returns responses in OpenAI's chat completion format

### 2. Durable Object (`src/lib/durable.ts`)

- **Conversation history**: Stores messages in Durable Object storage
- **AI integration**: Calls Workers AI with full conversation context
- **State management**: Persists chat state across requests

## Model Configuration

The default model is `@cf/moonshotai/kimi-k2.6`. You can specify different models per request:

```json
{
  "model": "@cf/moonshotai/kimi-k2.5",
  "messages": [...]
}
```

Available Kimi models:
- `@cf/moonshotai/kimi-k2.5` - Kimi K2.5 (Plus tier)
- `@cf/moonshotai/kimi-k2.6` - Kimi K2.6 (Agent/Demo tier)

## API Usage

### Streaming Request

```bash
curl -X POST https://cfworker.insertabot.io/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "@cf/moonshotai/kimi-k2.6",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ],
    "stream": true
  }'
```

### Non-Streaming Request

```bash
curl -X POST https://cfworker.insertabot.io/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "@cf/moonshotai/kimi-k2.6",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ],
    "stream": false
  }'
```

## Environment Variables

Set these in your Cloudflare Worker:

- `SYSTEM_PROMPT` (optional): Default system prompt for the AI
- `GITHUB_TOKEN` (optional): For GitHub MCP tools
- `TAVILY_API_KEY` (optional): For Tavily search tool

## Testing Locally

```bash
npm run dev
```

Then test with:

```bash
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "@cf/moonshotai/kimi-k2.6",
    "messages": [{"role": "user", "content": "What is 2+2?"}],
    "stream": false
  }'
```

## Deployment

```bash
npm run deploy
```

## Next Steps

1. **Add tool calling**: Integrate the MCP tools (GitHub, Tavily) with the AI responses
2. **Add plan-based routing**: Implement the tiered plan system (Light/Plus/Agent)
3. **Add rate limiting**: Implement daily conversation limits per plan
4. **Add image support**: Enable vision capabilities for image inputs
5. **Add scheduling**: Implement task scheduling for Agent tier

## Technical Notes

- Uses native Workers AI binding (`env.AI`) - no external API keys needed
- Streaming uses async iterators over the AI response
- Messages are stored in Durable Object SQLite storage
- CORS headers are included for browser access
- OpenAI-compatible response format for easy client integration

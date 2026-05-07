# MCP Tool Calling Implementation

## ✅ Full MCP Integration Complete!

Your InsertaBot now has **real-time web search** and **GitHub repository access** fully integrated with the AI.

## How It Works

### Tool Calling Loop

The AI can now:
1. **Decide** when it needs external information
2. **Call tools** automatically (Tavily search, GitHub API)
3. **Receive results** and incorporate them into responses
4. **Continue** the conversation with enriched context

### Architecture

```
User Question
    ↓
AI analyzes and decides if tools are needed
    ↓
[Tool Call] → Execute → [Tool Result]
    ↓
AI receives results and formulates response
    ↓
Final Answer to User
```

## Available Tools

### 1. Tavily Web Search (`tavily_search`)
Real-time web search for current information.

**Parameters:**
- `query` (required): Search query
- `max_results` (optional): Number of results (default: 5)
- `include_answer` (optional): Include AI-generated answer (default: true)

**Example AI Usage:**
```
User: "What's the latest news about Cloudflare Workers?"
AI: [Calls tavily_search with query="Cloudflare Workers latest news"]
AI: [Receives search results]
AI: "Based on recent information, Cloudflare Workers..."
```

### 2. GitHub Repository Info (`github_repo_info`)
Get information about a GitHub repository.

**Parameters:**
- `owner` (required): Repository owner (user or org)
- `repo` (required): Repository name

**Example AI Usage:**
```
User: "Tell me about the cloudflare/workers-sdk repo"
AI: [Calls github_repo_info with owner="cloudflare", repo="workers-sdk"]
AI: [Receives repo data: stars, language, description, etc.]
AI: "The cloudflare/workers-sdk repository has 2.5k stars..."
```

### 3. GitHub List Issues (`github_list_issues`)
List issues in a GitHub repository.

**Parameters:**
- `owner` (required): Repository owner
- `repo` (required): Repository name
- `state` (optional): "open", "closed", or "all" (default: "open")
- `per_page` (optional): Number of issues (default: 10)

**Example AI Usage:**
```
User: "What are the open issues in my repo?"
AI: [Calls github_list_issues with owner="M1ztick", repo="insertabot-cfworker"]
AI: [Receives list of issues]
AI: "Here are the current open issues: 1. Bug in streaming..."
```

## Configuration

### Required Environment Variables

Set these in Cloudflare Dashboard or via `wrangler secret put`:

```bash
# For Tavily web search
wrangler secret put TAVILY_API_KEY
# Enter your Tavily API key from https://tavily.com

# For GitHub tools
wrangler secret put GITHUB_TOKEN
# Enter your GitHub personal access token
```

### Optional: Custom System Prompt

```bash
wrangler secret put SYSTEM_PROMPT
# Example: "You are InsertaBot, an AI assistant with real-time web search and GitHub access. Always search for current information when needed."
```

## Testing MCP Tools

### Test Web Search

```bash
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "@cf/moonshotai/kimi-k2.6",
    "messages": [
      {"role": "user", "content": "What is the current weather in San Francisco? Use web search."}
    ],
    "stream": false
  }'
```

The AI will:
1. Recognize it needs current information
2. Call `tavily_search` with query about SF weather
3. Return an answer based on real search results

### Test GitHub Integration

```bash
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "@cf/moonshotai/kimi-k2.6",
    "messages": [
      {"role": "user", "content": "Tell me about the cloudflare/workers-sdk repository"}
    ],
    "stream": false
  }'
```

The AI will:
1. Call `github_repo_info` with owner="cloudflare", repo="workers-sdk"
2. Receive repo stats (stars, language, description, etc.)
3. Provide a detailed summary

### Test Streaming with Tools

```bash
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "@cf/moonshotai/kimi-k2.6",
    "messages": [
      {"role": "user", "content": "Search for the latest AI news and summarize"}
    ],
    "stream": true
  }'
```

You'll see:
1. `event: tool_call` - AI decides to search
2. `event: tool_result` - Search results received
3. `data: {...}` - Streaming response with summary

## Tool Calling Events (Streaming Mode)

When streaming, you'll receive special events:

### Tool Call Event
```
event: tool_call
data: {"type":"tool_call","tool_name":"tavily_search","tool_args":"{\"query\":\"latest AI news\"}"}
```

### Tool Result Event
```
event: tool_result
data: {"type":"tool_result","tool_call_id":"call_abc123","result":"[search results JSON]"}
```

### Regular Streaming Chunks
```
data: {"id":"chat-xyz","object":"chat.completion.chunk","created":1234567890,"model":"@cf/moonshotai/kimi-k2.6","choices":[{"index":0,"delta":{"content":"Based on"},"finish_reason":null}]}
```

## Safety Features

### Max Iterations
- Tool calling loop limited to **5 iterations** to prevent infinite loops
- Prevents runaway tool calls if AI gets stuck

### Error Handling
- Tool execution errors are caught and returned to the AI
- AI can handle errors gracefully and inform the user

### Logging
- All tool calls logged to console with iteration number
- Easy debugging: `wrangler tail` to see tool activity

## Adding More Tools

Want to add more capabilities? Here's how:

### 1. Define the Tool

Edit `src/lib/mcp.ts`:

```typescript
export const MY_TOOLS: ToolDefinition[] = [
  {
    name: 'get_weather',
    description: 'Get current weather for a location',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City name' },
      },
      required: ['location'],
    },
  },
];

// Add to allTools()
export function allTools(): ToolDefinition[] {
  return [...GITHUB_TOOLS, ...TAVILY_TOOLS, ...MY_TOOLS];
}
```

### 2. Implement the Tool

```typescript
async function getWeather(
  { location }: { location: string },
  env: Env
): Promise<string> {
  const res = await fetch(`https://api.weather.com/v1/current?location=${location}`);
  const data = await res.json();
  return JSON.stringify(data);
}
```

### 3. Add to Dispatcher

```typescript
async function dispatchSingleTool(call: ToolCall, env: Env): Promise<ToolResult> {
  const args = safeJsonParse<Record<string, unknown>>(call.function.arguments, {});

  switch (call.function.name) {
    // ... existing cases
    case 'get_weather':
      return {
        tool_call_id: call.id,
        role: 'tool',
        content: await getWeather(args as { location: string }, env),
      };
    // ...
  }
}
```

That's it! The AI will automatically discover and use your new tool.

## Performance

### Build Size
- **21.4KB** (dist/index.js) - includes full MCP integration

### Latency
- Tool calls add ~200-500ms per tool execution
- Multiple tools can be called in parallel (future optimization)
- Streaming provides immediate feedback to users

## Comparison: Before vs After

### Before
```
User: "What's the latest on Cloudflare Workers?"
AI: "I don't have access to current information..."
```

### After
```
User: "What's the latest on Cloudflare Workers?"
AI: [Searches web via Tavily]
AI: "Based on recent articles from cloudflare.com and techcrunch.com, 
     Cloudflare Workers recently announced..."
```

## Next Steps

1. ✅ **MCP Tools** - COMPLETE!
2. **Plan-based Tool Access** - Limit tools by tier (Light/Plus/Agent)
3. **Tool Result Caching** - Cache frequent searches
4. **Parallel Tool Execution** - Call multiple tools simultaneously
5. **More Tools** - Add file operations, database queries, etc.

## Troubleshooting

### "TAVILY_API_KEY not configured"
```bash
wrangler secret put TAVILY_API_KEY
# Get your key from https://tavily.com
```

### "GITHUB_TOKEN not configured"
```bash
wrangler secret put GITHUB_TOKEN
# Create a token at https://github.com/settings/tokens
```

### Tool calls not working
- Check logs: `wrangler tail`
- Verify model supports tool calling (Kimi K2.6 does)
- Ensure tools are passed to `env.AI.run()`

### Max iterations reached
- AI is stuck in a loop
- Check tool responses are valid JSON
- Simplify the user query

---

**Status**: ✅ **COMPLETE** - Full MCP tool calling with Tavily search and GitHub integration!

Your InsertaBot now has the "meat and potatoes" - real-time search and repo access! 🎉

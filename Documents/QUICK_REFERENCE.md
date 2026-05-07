# Quick Reference Card

## 🚀 Deploy Commands

```bash
# Build
npm run build

# Test locally
npm run dev

# Deploy to production
npm run deploy

# View logs
wrangler tail
```

## 🔑 Required Secrets

```bash
wrangler secret put TAVILY_API_KEY    # https://tavily.com
wrangler secret put GITHUB_TOKEN      # https://github.com/settings/tokens
wrangler secret put SYSTEM_PROMPT     # Optional
```

## 📡 API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/chat/completions` | POST | Chat with AI (streaming/non-streaming) |
| `/health` | GET | Health check |
| `/github` | POST | Direct GitHub API calls |
| `/tavily` | POST | Direct Tavily search |

## 🤖 Models

- `@cf/moonshotai/kimi-k2.5` - Kimi K2.5 (Plus tier)
- `@cf/moonshotai/kimi-k2.6` - Kimi K2.6 (Agent/Demo tier, default)

## 🛠️ Available Tools

| Tool | Purpose | Auto-Used By AI |
|------|---------|-----------------|
| `tavily_search` | Real-time web search | ✅ Yes |
| `github_repo_info` | Get repo information | ✅ Yes |
| `github_list_issues` | List repo issues | ✅ Yes |

## 📝 Example Request

```bash
curl -X POST https://cfworker.insertabot.io/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "@cf/moonshotai/kimi-k2.6",
    "messages": [
      {"role": "user", "content": "Search for latest AI news"}
    ],
    "stream": false
  }'
```

## 🔍 Testing

```bash
./test.sh                              # Test local
./test.sh https://cfworker.insertabot.io  # Test production
```

## 📊 Build Info

- **Size**: 21.4KB
- **Platform**: Cloudflare Workers
- **Runtime**: V8 isolate
- **Storage**: Durable Objects (SQLite)

## 🐛 Debug

```bash
# View real-time logs
wrangler tail

# Check secrets
wrangler secret list

# Regenerate types
npm run types
```

## 📚 Documentation

- `FINAL_SUMMARY.md` - Complete overview
- `MCP_IMPLEMENTATION.md` - Tool calling details
- `IMPLEMENTATION.md` - Workers AI setup
- `BEFORE_AFTER.md` - What changed

## ✅ Status

- [x] Workers AI (Kimi K2.5/K2.6)
- [x] Streaming responses
- [x] MCP tool calling
- [x] Real-time web search
- [x] GitHub integration
- [x] Conversation history
- [x] Production ready

## 🎯 Quick Test

```bash
# Test basic chat
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"@cf/moonshotai/kimi-k2.6","messages":[{"role":"user","content":"Hello!"}],"stream":false}'

# Test web search
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"@cf/moonshotai/kimi-k2.6","messages":[{"role":"user","content":"Search for Cloudflare news"}],"stream":false}'
```

---

**Ready to deploy!** Run `npm run deploy` 🚀

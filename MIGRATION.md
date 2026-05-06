# Migration Guide: Monolith → Modular

## What happened

The 1.46MB `src/index.js` monolith has been deleted. In its place is a modular TypeScript source tree that compiles back down to a single `dist/index.js` via esbuild (managed by Wrangler).

## New file layout

```
src/
├── index.ts               # Worker entry point — thin router
├── types.ts               # Shared types (Messages, ToolCalls, etc.)
├── worker-configuration.d.ts  # Env bindings types
├── lib/
│   ├── utils.ts           # generateId, jsonResponse, SSE helpers, CORS
│   ├── mcp.ts             # MCP tool definitions + GitHub/Tavily dispatch
│   └── durable.ts         # ChatAgent Durable Object class
└── handlers/
    ├── chat.ts            # OpenAI-compatible /v1/chat/completions
    ├── health.ts          # GET /health — quick status
    ├── github.ts          # POST /github — direct GitHub actions
    └── tavily.ts          # POST /tavily — direct web search
```

## Your next steps

1. **Install deps**
   ```bash
   npm install
   ```

2. **Generate Wrangler types** (if bindings changed)
   ```bash
   npx wrangler types
   ```

3. **Port your LLM inference logic**
   - Open `src/handlers/chat.ts`
   - Replace the placeholder responses with your actual Workers AI or external API call
   - The streaming path skeleton is ready — just swap the fake `chunks` loop with real inference streaming

4. **Port any extras from the old bundle**
   - Custom auth logic
   - KV caching
   - RAG / vector embedding
   - Stripe webhooks
   - Cron handlers (see `src/index.ts` — add a `scheduled` export)

5. **Build & deploy**
   ```bash
   npm run build    # escompile into dist/index.js
   npm run dev      # local dev
   npm run deploy   # push to Cloudflare
   ```

## Important notes

- **Wrangler now points to `dist/index.js`**, not `src/index.js`. The old `src/index.js` was a manually maintained bundle — now it's a build artifact.
- **Commit `src/` to git, ignore `dist/`**. This is standard practice.
- **Keep `AGENTS.md` updated** — it's a great pattern for context-aware AI assistants working on this codebase.
- **The Durable Object is wired** but uses placeholder echo-logic. Wire it up to your actual chat flow when ready.

## Rollback

If anything breaks, the old `src/index.js` monolith still exists in git history on `master`. You can always check it out:

```bash
git checkout master -- src/index.js
```

But ideally, migrate incrementally rather than reverting.

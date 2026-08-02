# InsertaBot — Cloudflare Worker

A chat assistant built on **Cloudflare Workers AI**, the **Agents SDK**, and
**Durable Objects**. Users can attach images, connect their own **MCP
servers** as tool add-ons, and chat over a resumable WebSocket connection.

## Architecture

```
public/index.html + index.js   Vanilla JS frontend (no framework/build step)
        │  WebSocket  /agents/chat-agent/:instanceId
        ▼
src/index.ts                   Worker entry point (routing, health, CORS)
        │  routeAgentRequest()
        ▼
src/lib/durable.ts             ChatAgent — Durable Object (extends AIChatAgent)
        │  streamText()
        ▼
Workers AI binding (env.AI)    Kimi K2.6 (research) / Kimi K2.7-code (coding)
```

- **`src/index.ts`** — thin `fetch` handler. Hands off to
  [`routeAgentRequest`](https://developers.cloudflare.com/agents/) for all
  `/agents/*` traffic (WebSocket upgrades, RPC calls, MCP OAuth callbacks),
  and serves `/health` for basic liveness checks. Static assets under
  `public/` are served directly by the Workers Assets binding.
- **`src/lib/durable.ts`** — the `ChatAgent` Durable Object. One instance per
  browser session (`instanceId`, persisted in `localStorage`). Streams model
  responses via the AI SDK's `streamText`, exposes `@callable()` RPC methods
  (`addServer`, `removeServer`, `setModelLane`) that the frontend invokes over
  the WebSocket, and picks a **model lane** automatically based on which MCP
  servers are connected (a GitHub-flavored server routes to the coding model;
  everything else uses the research model). Users can override the lane with
  `setModelLane('coding' | 'research' | 'auto')`.
- **`src/lib/utils.ts`** — small shared helpers (CORS headers, JSON
  responses, error formatting).
- **`public/`** — a dependency-free frontend: a hand-rolled Markdown
  renderer, capped-retry WebSocket reconnection, client-side image
  compression before upload, and an "Add-ons" panel for connecting/removing
  MCP servers at runtime.

Tools are **not hard-coded** — anything the user connects through the
Add-ons panel (`addServer(name, url, token?)`) becomes available to the model
automatically via `this.mcp.getAITools()`.

## Requirements

- Node.js 22+ (AI SDK 7 requirement)
- A Cloudflare account with Workers AI enabled

## Setup

```bash
npm install
npm run types    # generates worker-configuration.d.ts from wrangler.jsonc — run again after editing bindings
```

## Local development

```bash
npm run dev       # wrangler dev — http://localhost:8787
```

Open `public/index.html` in a browser pointed at that origin (or just hit the
worker's dev URL directly — it serves the assets too).

## Type checking & build

```bash
npm run typecheck   # tsc --noEmit
npm run build        # wrangler deploy --dry-run --outdir=dist (bundle check, no deploy)
```

## Deploy

```bash
npm run deploy
```

Deploys to the custom domain configured in `wrangler.jsonc`
(`cfworker.insertabot.io`).

## Configuration

| Setting | Where | Notes |
|---|---|---|
| `SYSTEM_PROMPT` | `wrangler.jsonc` → `vars` | Override with `wrangler secret put SYSTEM_PROMPT` for a value that shouldn't be committed. |
| Model lanes | `src/lib/durable.ts` → `MODEL_LANES` | Add/rename lanes and the heuristic in `inferLane()` here. |
| MCP servers | Runtime, via the Add-ons UI | Nothing to configure ahead of time — each browser session connects its own servers, persisted per Durable Object instance. |

## Notes for future changes

- This project's knowledge of Cloudflare Workers/Agents/AI SDK APIs can go
  stale fast — see `AGENTS.md` before touching bindings, MCP, or Durable
  Object code.
- Keep `src/index.ts` and `src/lib/durable.ts` as the source of truth for
  architecture; older design docs describing a REST `/v1/chat/completions`
  API with hard-coded Tavily/GitHub tools have been removed as they no
  longer reflect this codebase.

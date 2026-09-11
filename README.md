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
- **`public/`** — a dependency-free frontend: capped-retry WebSocket
  reconnection, client-side image compression before upload, and an
  "Add-ons" panel for connecting/removing MCP servers at runtime.
- **`public/markdown.js`** — the hand-rolled Markdown renderer, kept in its
  own module so its escaping logic is unit-testable without a DOM. Output is
  assigned via `innerHTML`, so `escHtml()` and `safeUrl()` are a security
  boundary: model output is untrusted (MCP tool results flow straight into
  it). `public/_headers` adds a CSP as defence in depth.
- **`test/`** — Vitest unit tests. The two suites cover the code paths where a
  silent regression is most costly: the streaming placeholder filter
  (`sanitize.ts`) and the Markdown renderer's XSS defences.

Tools are **not hard-coded** — anything the user connects through the
Add-ons panel (`addServer(name, url, token?)`) becomes available to the model
automatically via `this.mcp.getAITools()`.

## Requirements

- Node.js 22+ (AI SDK 7 requirement; enforced via `engines`)
- A Cloudflare account with Workers AI enabled

## Setup

```bash
npm install
```

`worker-configuration.d.ts` is generated, not committed. `npm run typecheck`
and `npm run build` both regenerate it first, so a fresh clone typechecks
without any extra step. Run `npm run types` by hand after editing bindings in
`wrangler.jsonc` if you want your editor to pick them up immediately.

## Local development

```bash
npm run dev       # wrangler dev — http://localhost:8787
```

Open `public/index.html` in a browser pointed at that origin (or just hit the
worker's dev URL directly — it serves the assets too).

## Type checking, tests & build

```bash
npm run typecheck   # wrangler types && tsc --noEmit
npm test            # vitest run
npm run test:watch  # vitest (watch mode)
npm run build       # wrangler deploy --dry-run --outdir=dist (bundle check, no deploy)
npm run check       # all three, in order — run this before opening a PR
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
- **`sanitize.ts` sits on the main text stream.** Any whitespace normalisation
  there must stay local to a removed placeholder. A global whitespace collapse
  looks harmless but flattens the indentation of every fenced code block the
  model streams — and because the transform runs before `onFinish`, the
  mangled text is what gets persisted. `test/sanitize.test.ts` guards this.
- **`markdown.js` renders untrusted model output via `innerHTML`.** Escape
  quotes as well as `&<>` (an `href` is built from a captured group), and keep
  link targets behind `safeUrl()`'s scheme allowlist.
- Known gaps not yet addressed: the PWA manifest and service worker are not
  referenced from `index.html`, the DO SQLite memory store in
  `src/lib/memory.ts` is not reachable from either the UI or the model, and
  the client-side `?plan=` gating is cosmetic (the Worker never reads it).
- Keep `src/index.ts` and `src/lib/durable.ts` as the source of truth for
  architecture; older design docs describing a REST `/v1/chat/completions`
  API with hard-coded Tavily/GitHub tools have been removed as they no
  longer reflect this codebase.

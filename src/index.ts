/**
 * InsertaBot Cloudflare Worker — Entry Point
 *
 * Routes:
 *   POST /v1/chat/completions    → Chat completions (OpenAI-compatible)
 *   GET  /health                 → Status check
 *   POST /github                 → Direct GitHub MCP actions
 *   POST /tavily                 → Direct Tavily search
 *   *    /                       → Public assets (from ./public)
 */

import { handleChat } from './handlers/chat';
import { handleHealth } from './handlers/health';
import { handleGithub } from './handlers/github';
import { handleTavily } from './handlers/tavily';
import { corsHeaders } from './lib/utils';

// Importing DO class so Wrangler knows to register it
export { ChatAgent } from './lib/durable';

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// ---- CORS preflight for all routes ----
		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders() });
		}

		try {
			switch (url.pathname) {
				case '/v1/chat/completions':
					return await handleChat(request, env);

				case '/health':
					return await handleHealth(request, env);

				case '/github':
					return await handleGithub(request, env);

				case '/tavily':
					return await handleTavily(request, env);

				default:
					// Fallback: serve static assets from ./public (handled by wrangler assets)
					return new Response('Not Found', { status: 404 });
			}
		} catch (err) {
			console.error('Unhandled worker error:', err);
			return new Response(
				JSON.stringify({ error: 'Internal Server Error', detail: (err as Error).message }),
				{ status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
			);
		}
	},
};

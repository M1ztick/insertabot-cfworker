/**
 * InsertaBot Cloudflare Worker — Entry Point
 *
 * Routes:
 *   /agents/chat-agent/:id  → ChatAgent Durable Object (WebSocket + MCP, handled by agents SDK)
 *   POST /v1/chat/completions → Simple OpenAI-compatible REST endpoint (no MCP tools)
 *   GET  /health             → Status check
 *   POST /github             → Direct GitHub API actions
 *   POST /tavily             → Direct Tavily search
 */

import { routeAgentRequest } from 'agents';
import type { Env } from './worker-configuration';
import { handleChat } from './handlers/chat';
import { handleHealth } from './handlers/health';
import { handleGithub } from './handlers/github';
import { handleTavily } from './handlers/tavily';
import { corsHeaders } from './lib/utils';

export { ChatAgent } from './lib/durable';

export default {
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		const safeCron = event.cron.replace(/[\r\n]/g, '');
		console.log(`Scheduled cron fired: ${safeCron} at ${new Date(event.scheduledTime).toISOString()}`);
	},

	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders() });
		}

		// Agents SDK handles all /agents/* WebSocket + HTTP routing
		const agentResponse = await routeAgentRequest(request, env);
		if (agentResponse) return agentResponse;

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
				case '/favicon.ico':
					return new Response(null, { status: 204 });
				default:
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

import { routeAgentRequest } from 'agents';
import { ChatAgent } from './lib/durable';
import { corsHeaders, jsonResponse } from './lib/utils';
import type { Env } from './worker-configuration';
import { handleSaigeRequest } from "./saige-routes";

function handleHealth(_request: Request, env: Env): Response {
  return jsonResponse(
    {
      status: 'ok',
      worker: 'insertabot-cfworker',
      version: '0.2.0',
      timestamp: new Date().toISOString(),
      bindings: {
        ai: !!env.AI,
        chatAgent: !!env.ChatAgent,
      },
    },
    200,
    corsHeaders(),
  );
}

// Re-export the Durable Object class — required by wrangler
export { ChatAgent };

export default {
  // Placeholder: no scheduled work yet. Remove the cron trigger in wrangler.jsonc when no longer needed.
  async scheduled(event: ScheduledEvent, _env: Env, _ctx: ExecutionContext) {
    const safeCron = event.cron.replace(/[\r\n]/g, '');
    console.log(`Scheduled cron fired: ${safeCron} at ${new Date(event.scheduledTime).toISOString()}`);
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    // Parse URL early to get pathname for routing
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Handle CORS preflight for all routes
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // Check SAIGE routes FIRST (before agents route)
    // SAIGE handles its own CORS internally
    if (pathname.startsWith("/saige")) {
      return handleSaigeRequest(request, env, pathname);
    }

    // Hand off to the Agents SDK — handles WebSocket upgrades, agent RPC,
    // MCP OAuth callbacks, and all /agents/* routing automatically
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    try {
      switch (pathname) {
        case '/health':
          return handleHealth(request, env);
        case '/favicon.ico':
          return new Response(null, { status: 204 });
        default:
          return new Response('Not Found', { status: 404 });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Unhandled worker error:', err);
      return new Response(
        JSON.stringify({ error: 'Internal Server Error', detail: message }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders() } },
      );
    }
  },
};
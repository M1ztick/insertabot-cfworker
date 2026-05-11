import { routeAgentRequest } from 'agents';
import { ChatAgent } from './lib/durable';

export interface Env {
  AI: Ai;
  ChatAgent: DurableObjectNamespace;
  SYSTEM_PROMPT?: string;
}

function corsHeaders(origin = '*') {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function jsonResponse(data: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

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
  async scheduled(event: ScheduledEvent, _env: Env, _ctx: ExecutionContext) {
    const safeCron = event.cron.replace(/[\r\n]/g, '');
    console.log(`Scheduled cron fired: ${safeCron} at ${new Date(event.scheduledTime).toISOString()}`);
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    // Handle CORS preflight for all routes
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // Hand off to the Agents SDK — handles WebSocket upgrades, agent RPC,
    // MCP OAuth callbacks, and all /agents/* routing automatically
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    const url = new URL(request.url);

    try {
      switch (url.pathname) {
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

/**
 * Health & status endpoints — useful for quick checks
 * without burning tokens on a full chat completion.
 */

import { jsonResponse, corsHeaders } from '../lib/utils';

export async function handleHealth(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') {
		return new Response(null, { headers: corsHeaders() });
	}

	return jsonResponse(
		{
			status: 'ok',
			worker: 'insertabot-cfworker',
			version: '0.1.0',
			timestamp: new Date().toISOString(),
			bindings: {
				ai: !!env.AI,
				chatAgent: !!env.ChatAgent,
				github: !!env.GITHUB_TOKEN,
				tavily: !!env.TAVILY_API_KEY,
			},
		},
		200,
		corsHeaders()
	);
}

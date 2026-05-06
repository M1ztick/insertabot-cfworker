/**
 * Direct Tavily search handler
 * Also serves as the implementation backing the `tavily_search` MCP tool.
 */

import { jsonResponse, corsHeaders } from '../lib/utils';
import type { TavilySearchResponse } from '../types';

export async function handleTavily(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') {
		return new Response(null, { headers: corsHeaders() });
	}
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 });
	}

	const apiKey = env.TAVILY_API_KEY;
	if (!apiKey) {
		return jsonResponse({ error: 'TAVILY_API_KEY not configured' }, 500, corsHeaders());
	}

	const body = (await request.json()) as {
		query: string;
		max_results?: number;
		include_answer?: boolean;
	};

	try {
		const res = await fetch('https://api.tavily.com/search', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				api_key: apiKey,
				query: body.query,
				max_results: body.max_results ?? 5,
				include_answer: body.include_answer ?? true,
			}),
		});

		if (!res.ok) {
			return jsonResponse(
				{ error: `Tavily API error: ${res.status} ${res.statusText}` },
				res.status,
				corsHeaders()
			);
		}

		const data = (await res.json()) as TavilySearchResponse;
		return jsonResponse(data, 200, corsHeaders());
	} catch (err) {
		console.error('Tavily handler error:', err);
		return jsonResponse({ error: (err as Error).message }, 500, corsHeaders());
	}
}

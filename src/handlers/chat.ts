/**
 * OpenAI-compatible REST endpoint — /v1/chat/completions
 * Simple stateless passthrough to Workers AI. No MCP tools.
 * For MCP tool access use the WebSocket path (/agents/chat-agent/:id) instead.
 */

import type { ChatRequest, ChatResponseChunk } from '../types';
import type { Env } from '../worker-configuration';
import { generateId, jsonResponse, corsHeaders } from '../lib/utils';

export async function handleChat(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') {
		return new Response(null, { headers: corsHeaders() });
	}
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 });
	}

	const body = (await request.json()) as ChatRequest;
	const model = body.model || '@cf/moonshotai/kimi-k2.6';
	const systemPrompt =
		env.SYSTEM_PROMPT ?? 'You are InsertaBot, a helpful AI assistant.';

	const messages = [
		{ role: 'system' as const, content: systemPrompt },
		...body.messages,
	];

	try {
		if (body.stream) {
			const rawStream = (await env.AI.run(model as Parameters<typeof env.AI.run>[0], {
				messages,
				stream: true,
				max_tokens: body.max_tokens,
			})) as unknown as ReadableStream;

			return new Response(rawStream, {
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					Connection: 'keep-alive',
					...corsHeaders(),
				},
			});
		}

		const response = (await env.AI.run(model as Parameters<typeof env.AI.run>[0], {
			messages,
			max_tokens: body.max_tokens,
			temperature: body.temperature,
		})) as unknown as { response?: string };

		const result: ChatResponseChunk = {
			id: generateId('chat'),
			object: 'chat.completion',
			created: Math.floor(Date.now() / 1000),
			model,
			choices: [
				{
					index: 0,
					message: { role: 'assistant', content: response.response ?? '' },
					finish_reason: 'stop',
				},
			],
		};

		return jsonResponse(result, 200, corsHeaders());
	} catch (err) {
		console.error('Chat handler error:', err);
		return jsonResponse({ error: (err as Error).message }, 500, corsHeaders());
	}
}

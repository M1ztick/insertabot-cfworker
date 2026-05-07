/**
 * Chat completion handler
 * Supports streaming + non-streaming responses.
 * Integrates Durable Objects for conversation history.
 */

import type { ChatRequest, ChatResponseChunk, Message } from '../types';
import { generateId, jsonResponse, corsHeaders } from '../lib/utils';

export async function handleChat(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') {
		return new Response(null, { headers: corsHeaders() });
	}
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 });
	}

	const body = (await request.json()) as ChatRequest;
	const isStreaming = body.stream ?? false;

	// ---- Durable Object routing for conversation state ----
	// For now, we use a fixed DO ID per request (you may want per-user or per-session IDs).
	// You can pass `conversationId` in the request body to isolate threads.
	const conversationId = (body as Record<string, unknown>).conversationId as string | undefined;
	const doId = env.ChatAgent.idFromName(conversationId ?? 'default');
	const agent = env.ChatAgent.get(doId);

	// If you want pure stateless (no DO), comment the above and proceed below directly.

	try {
		if (isStreaming) {
			return await handleStreamingChat(body, env, agent);
		}
		return await handleNonStreamingChat(body, env, agent);
	} catch (err) {
		console.error('Chat handler error:', err);
		return jsonResponse({ error: (err as Error).message }, 500, corsHeaders());
	}
}

// ------------------------------------------------------------------
// Non-streaming path
// ------------------------------------------------------------------

async function handleNonStreamingChat(
	req: ChatRequest,
	env: Env,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	_agent: any
): Promise<Response> {
	const systemPrompt = env.SYSTEM_PROMPT ?? 'You are InsertaBot, a helpful coding assistant.';
	const model = req.model || '@cf/moonshotai/kimi-k2.6';

	// Prepare messages with system prompt
	const messages = [
		{ role: 'system', content: systemPrompt },
		...req.messages,
	];

	try {
		// Call Workers AI directly
		const response = await env.AI.run(model, {
			messages,
			max_tokens: req.max_tokens,
			temperature: req.temperature,
			top_p: req.top_p,
			stream: false,
		});

		const result: ChatResponseChunk = {
			id: generateId('chat'),
			object: 'chat.completion',
			created: Math.floor(Date.now() / 1000),
			model,
			choices: [
				{
					index: 0,
					message: { role: 'assistant', content: response.response || '' },
					finish_reason: 'stop',
				},
			],
		};

		return jsonResponse(result, 200, corsHeaders());
	} catch (err) {
		console.error('Non-streaming chat error:', err);
		return jsonResponse({ error: (err as Error).message }, 500, corsHeaders());
	}
}

// ------------------------------------------------------------------
// Streaming path (SSE)
// ------------------------------------------------------------------

async function handleStreamingChat(
	req: ChatRequest,
	env: Env,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	_agent: any
): Promise<Response> {
	const encoder = new TextEncoder();
	const systemPrompt = env.SYSTEM_PROMPT ?? 'You are InsertaBot, a helpful coding assistant.';
	const model = req.model || '@cf/moonshotai/kimi-k2.6';

	// Prepare messages with system prompt
	const messages = [
		{ role: 'system', content: systemPrompt },
		...req.messages,
	];

	const stream = new ReadableStream({
		async start(controller) {
			try {
				// Call Workers AI with streaming enabled
				const response = await env.AI.run(model, {
					messages,
					max_tokens: req.max_tokens,
					temperature: req.temperature,
					top_p: req.top_p,
					stream: true,
				});

				const chatId = generateId('chat');
				const created = Math.floor(Date.now() / 1000);

				// Stream the response
				if (response && typeof response[Symbol.asyncIterator] === 'function') {
					for await (const chunk of response as AsyncIterable<any>) {
						if (chunk.response) {
							const event: ChatResponseChunk = {
								id: chatId,
								object: 'chat.completion.chunk',
								created,
								model,
								choices: [
									{
										index: 0,
										delta: { content: chunk.response },
										finish_reason: null,
									},
								],
							};
							controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
						}
					}
				}

				// Final chunk with finish reason
				const finalChunk: ChatResponseChunk = {
					id: chatId,
					object: 'chat.completion.chunk',
					created,
					model,
					choices: [
						{
							index: 0,
							delta: {},
							finish_reason: 'stop',
						},
					],
				};
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
				controller.enqueue(encoder.encode('data: [DONE]\n\n'));
			} catch (err) {
				console.error('Streaming error:', err);
				const errorEvent = {
					error: {
						message: (err as Error).message,
						type: 'server_error',
					},
				};
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`));
			} finally {
				controller.close();
			}
		},
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			...corsHeaders(),
		},
	});
}

/**
 * Chat completion handler
 * Supports streaming + non-streaming responses.
 * Integrates Durable Objects for conversation history.
 */

import type { ChatRequest, ChatResponseChunk, Message } from '../types';
import { generateId, jsonResponse, sseStream, corsHeaders, safeJsonParse } from '../lib/utils';
import { allTools, executeToolCalls } from '../lib/mcp';

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
	_agent: any // DurableObjectStub — typed properly when DO class is imported
): Promise<Response> {
	// TODO: Replace this placeholder with your actual inference pipeline.
	// Right now it just echoes back using a system prompt + the last user message.

	const systemPrompt = env.SYSTEM_PROMPT ?? 'You are InsertaBot, a helpful coding assistant.';
	const messagesWithSystem: Message[] = [{ role: 'system', content: systemPrompt }, ...req.messages];

	// Placeholder response until you wire Workers AI or external API
	const assistantContent = `[Placeholder response] Received ${req.messages.length} messages. System prompt: "${systemPrompt}"`;

	const response: ChatResponseChunk = {
		id: generateId('chat'),
		object: 'chat.completion',
		created: Math.floor(Date.now() / 1000),
		model: req.model || 'insertabot-cfworker',
		choices: [
			{
				index: 0,
				message: { role: 'assistant', content: assistantContent },
				finish_reason: 'stop',
			},
		],
	};

	return jsonResponse(response, 200, corsHeaders());
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

	const stream = new ReadableStream({
		async start(controller) {
			dispatchEvent(controller, 'connected', { status: 'stream open' });

			try {
				// TODO: Replace with actual LLM streaming call.
				// For now, emit a few placeholder chunks so the client sees streaming works.
				const chunks = [
					'Hello',
					' from',
					' InsertaBot!',
					' (Streaming is wired — replace this with Workers AI or OpenAI stream)',
				];

				for (const text of chunks) {
					const event: ChatResponseChunk = {
						id: generateId('chat'),
						object: 'chat.completion.chunk',
						created: Math.floor(Date.now() / 1000),
						model: req.model || 'insertabot-cfworker',
						choices: [
							{
								index: 0,
								delta: { role: 'assistant', content: text },
								finish_reason: null,
							},
						],
					};
					dispatchEvent(controller, 'data', event);
					// Fake word-by-word delay
					await new Promise((r) => setTimeout(r, 80));
				}

				// Final [DONE] event (OpenAI compatibility)
				controller.enqueue(encoder.encode('data: [DONE]\n\n'));
			} catch (err) {
				dispatchEvent(controller, 'error', { message: (err as Error).message });
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

// ------------------------------------------------------------------
// SSE helpers
// ------------------------------------------------------------------

function dispatchEvent(
	controller: ReadableStreamDefaultController<Uint8Array>,
	event: string,
	data: unknown
): void {
	const encoder = new TextEncoder();
	const payload = typeof data === 'string' ? data : JSON.stringify(data);
	controller.enqueue(encoder.encode(`event: ${event}\ndata: ${payload}\n\n`));
}

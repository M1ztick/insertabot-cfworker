/**
 * Chat completion handler
 * Supports streaming + non-streaming responses with MCP tool calling.
 * Integrates Durable Objects for conversation history.
 */

import type { ChatRequest, ChatResponseChunk, Message, ToolCall } from '../types';
import { generateId, jsonResponse, corsHeaders } from '../lib/utils';
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
// Non-streaming path with tool calling
// ------------------------------------------------------------------

async function handleNonStreamingChat(
	req: ChatRequest,
	env: Env,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	_agent: any
): Promise<Response> {
	const systemPrompt = env.SYSTEM_PROMPT ?? 'You are InsertaBot, a helpful coding assistant with access to real-time web search and GitHub repository information.';
	const model = req.model || '@cf/moonshotai/kimi-k2.6';
	const tools = allTools();

	// Prepare messages with system prompt
	const messages: Message[] = [
		{ role: 'system', content: systemPrompt },
		...req.messages,
	];

	try {
		// Tool calling loop - max 5 iterations to prevent infinite loops
		const maxIterations = 5;
		let iteration = 0;
		let finalResponse: any = null;

		while (iteration < maxIterations) {
			iteration++;

			// Call Workers AI with tools
			const response = await env.AI.run(model, {
				messages,
				tools,
				max_tokens: req.max_tokens,
				temperature: req.temperature,
				top_p: req.top_p,
				stream: false,
			});

			// Check if the model wants to call tools
			if (response.tool_calls && response.tool_calls.length > 0) {
				console.log(`Tool calls requested (iteration ${iteration}):`, response.tool_calls);

				// Add assistant message with tool calls to history
				messages.push({
					role: 'assistant',
					content: response.response || '',
					tool_calls: response.tool_calls,
				});

				// Execute all tool calls
				const toolResults = await executeToolCalls(response.tool_calls, env);

				// Add tool results to messages
				for (const result of toolResults) {
					messages.push({
						role: 'tool',
						content: result.content,
						tool_call_id: result.tool_call_id,
					});
				}

				// Continue loop to get final response
				continue;
			}

			// No tool calls - we have the final response
			finalResponse = response;
			break;
		}

		if (!finalResponse) {
			throw new Error('Max tool calling iterations reached');
		}

		const result: ChatResponseChunk = {
			id: generateId('chat'),
			object: 'chat.completion',
			created: Math.floor(Date.now() / 1000),
			model,
			choices: [
				{
					index: 0,
					message: { role: 'assistant', content: finalResponse.response || '' },
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
// Streaming path with tool calling (SSE)
// ------------------------------------------------------------------

async function handleStreamingChat(
	req: ChatRequest,
	env: Env,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	_agent: any
): Promise<Response> {
	const encoder = new TextEncoder();
	const systemPrompt = env.SYSTEM_PROMPT ?? 'You are InsertaBot, a helpful coding assistant with access to real-time web search and GitHub repository information.';
	const model = req.model || '@cf/moonshotai/kimi-k2.6';
	const tools = allTools();

	// Prepare messages with system prompt
	const messages: Message[] = [
		{ role: 'system', content: systemPrompt },
		...req.messages,
	];

	const stream = new ReadableStream({
		async start(controller) {
			const chatId = generateId('chat');
			const created = Math.floor(Date.now() / 1000);

			try {
				// Tool calling loop for streaming
				const maxIterations = 5;
				let iteration = 0;

				while (iteration < maxIterations) {
					iteration++;

					// Call Workers AI with tools (non-streaming for tool detection)
					const response = await env.AI.run(model, {
						messages,
						tools,
						max_tokens: req.max_tokens,
						temperature: req.temperature,
						top_p: req.top_p,
						stream: false, // Use non-streaming for tool detection
					});

					// Check if the model wants to call tools
					if (response.tool_calls && response.tool_calls.length > 0) {
						console.log(`Tool calls requested (streaming iteration ${iteration}):`, response.tool_calls);

						// Emit tool call events
						for (const toolCall of response.tool_calls) {
							const toolEvent = {
								type: 'tool_call',
								tool_name: toolCall.function.name,
								tool_args: toolCall.function.arguments,
							};
							controller.enqueue(encoder.encode(`event: tool_call\ndata: ${JSON.stringify(toolEvent)}\n\n`));
						}

						// Add assistant message with tool calls
						messages.push({
							role: 'assistant',
							content: response.response || '',
							tool_calls: response.tool_calls,
						});

						// Execute tool calls
						const toolResults = await executeToolCalls(response.tool_calls, env);

						// Add tool results and emit events
						for (const result of toolResults) {
							messages.push({
								role: 'tool',
								content: result.content,
								tool_call_id: result.tool_call_id,
							});

							const toolResultEvent = {
								type: 'tool_result',
								tool_call_id: result.tool_call_id,
								result: result.content,
							};
							controller.enqueue(encoder.encode(`event: tool_result\ndata: ${JSON.stringify(toolResultEvent)}\n\n`));
						}

						// Continue loop
						continue;
					}

					// No tool calls - stream the final response
					const finalResponse = await env.AI.run(model, {
						messages,
						max_tokens: req.max_tokens,
						temperature: req.temperature,
						top_p: req.top_p,
						stream: true,
					});

					// Stream the response
					if (finalResponse && typeof finalResponse[Symbol.asyncIterator] === 'function') {
						for await (const chunk of finalResponse as AsyncIterable<any>) {
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

					// Done - exit loop
					break;
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

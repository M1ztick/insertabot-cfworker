/**
 * ChatAgent Durable Object
 * Handles per-conversation state: message history, context window, tool results.
 */

import type { AiResponse, Message, ChatRequest } from '../types';
import type { Env } from '../worker-configuration';
import { allTools, executeToolCalls, normalizeToolCalls } from './mcp';

export interface ChatAgentState {
	messages: Message[];
	createdAt: number;
	lastActiveAt: number;
	metadata?: Record<string, unknown>;
}

export class ChatAgent implements DurableObject {
	private state: DurableObjectState;
	private env: Env;
	private _cache: ChatAgentState | null = null;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	/** Main request handler invoked by the Workers runtime */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// Handle WebSocket upgrade for Agents SDK UI
		if (request.headers.get('Upgrade') === 'websocket') {
			return this.handleWebSocket(request);
		}

		switch (url.pathname) {
			case '/chat': {
				if (request.method !== 'POST') return methodNotAllowed();
				const body = (await request.json()) as ChatRequest;
				return this.handleChat(body);
			}
			case '/history': {
				if (request.method !== 'GET') return methodNotAllowed();
				return this.getHistory();
			}
			case '/clear': {
				if (request.method !== 'POST') return methodNotAllowed();
				return this.clearHistory();
			}
			default:
				return new Response('Not Found', { status: 404 });
		}
	}

	/** Append messages and return full history with tool calling */
	async handleChat(req: ChatRequest): Promise<Response> {
		const stored = await this.getStoredState();

		// Append new user messages
		stored.messages.push(...req.messages);
		stored.lastActiveAt = Date.now();

		// Call Workers AI with conversation history and tools
		const systemPrompt = this.env.SYSTEM_PROMPT ?? 'You are InsertaBot, a helpful coding assistant with access to real-time web search and GitHub repository information.';
		const model = req.model || '@cf/moonshotai/kimi-k2.6';
		const tools = allTools();

		// Prepare messages with system prompt
		const messages: Message[] = [
			{ role: 'system', content: systemPrompt },
			...stored.messages,
		];

		try {
			// Tool calling loop
			const maxIterations = 5;
			let iteration = 0;
			let finalResponse: any = null;

			while (iteration < maxIterations) {
				iteration++;

				const rawResponse = await this.env.AI.run(model, {
					messages,
					tools,
					max_tokens: req.max_tokens,
					temperature: req.temperature,
					top_p: req.top_p,
					stream: false,
				}) as AiResponse;
				const response: AiResponse = {
					response: rawResponse.response,
					tool_calls: rawResponse.tool_calls
						? normalizeToolCalls(rawResponse.tool_calls as unknown[])
						: undefined,
				};

				// Check for tool calls
				if (response.tool_calls && response.tool_calls.length > 0) {
					console.log(`DO: Tool calls requested (iteration ${iteration}):`, response.tool_calls);

					// Add assistant message with tool calls
					const assistantMsg: Message = {
						role: 'assistant',
						content: null,
						tool_calls: response.tool_calls,
					};
					stored.messages.push(assistantMsg);
					messages.push(assistantMsg);

					// Execute tool calls
					const toolResults = await executeToolCalls(response.tool_calls, this.env);

					// Add tool results
					for (const result of toolResults) {
						const toolMsg: Message = {
							role: 'tool',
							content: result.content,
							tool_call_id: result.tool_call_id,
							name: result.tool_call_id,
						};
						stored.messages.push(toolMsg);
						messages.push(toolMsg);
					}

					// If every tool call failed, stop looping
					const allFailed = toolResults.every(r => r.content.startsWith('Error executing tool:'));
					if (allFailed) {
						finalResponse = { response: toolResults.map(r => r.content).join('\n') };
						break;
					}

					// Continue loop
					continue;
				}

				// No tool calls - final response
				finalResponse = response;
				break;
			}

			if (!finalResponse) {
				throw new Error('Max tool calling iterations reached');
			}

			const assistantMsg: Message = {
				role: 'assistant',
				content: finalResponse.response || '',
			};
			stored.messages.push(assistantMsg);

			await this.saveState(stored);
			return new Response(JSON.stringify({ messages: stored.messages }), {
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (err) {
			console.error('ChatAgent inference error:', err);
			return new Response(
				JSON.stringify({ error: (err as Error).message }),
				{ status: 500, headers: { 'Content-Type': 'application/json' } }
			);
		}
	}

	async getHistory(): Promise<Response> {
		const stored = await this.getStoredState();
		return new Response(JSON.stringify({ messages: stored.messages }), {
			headers: { 'Content-Type': 'application/json' },
		});
	}

	async clearHistory(): Promise<Response> {
		const empty: ChatAgentState = {
			messages: [],
			createdAt: Date.now(),
			lastActiveAt: Date.now(),
		};
		await this.saveState(empty);
		return new Response(JSON.stringify({ cleared: true }));
	}

	// ---- Storage helpers ----

	/** Handle WebSocket connection for Agents SDK UI */
	async handleWebSocket(request: Request): Promise<Response> {
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);

		this.state.acceptWebSocket(server);

		// Send initial state
		const stored = await this.getStoredState();
		server.send(JSON.stringify({
			type: 'cf_agent_chat_messages',
			messages: stored.messages,
		}));

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	/** Handle incoming WebSocket messages */
	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		if (typeof message !== 'string') return;

		try {
			const data = JSON.parse(message);

			if (data.type === 'cf_agent_use_chat_request') {
				const body = JSON.parse(data.init.body);
				const userMessages = body.messages || [];

				// Process the chat request
				const stored = await this.getStoredState();
				stored.messages.push(...userMessages.filter((m: Message) => m.role === 'user'));
				stored.lastActiveAt = Date.now();

				// Call AI with tool calling
				const systemPrompt = this.env.SYSTEM_PROMPT ?? 'You are InsertaBot, a helpful coding assistant with access to real-time web search and GitHub repository information.';
				const model = '@cf/moonshotai/kimi-k2.6';
				const tools = allTools();

				const messages: Message[] = [
					{ role: 'system', content: systemPrompt },
					...stored.messages,
				];

				// Send start event
				const messageId = `msg-${Date.now()}`;
				ws.send(JSON.stringify({
					type: 'cf_agent_use_chat_response',
					id: data.id,
					body: JSON.stringify({ type: 'start', messageId }),
					done: false,
				}));

				// Tool calling loop
				const maxIterations = 5;
				let iteration = 0;
				let finalText = '';

				while (iteration < maxIterations) {
					iteration++;

					const rawWsResponse = await this.env.AI.run(model, {
						messages,
						tools,
						stream: false,
					}) as AiResponse;
					const response: AiResponse = {
						response: rawWsResponse.response,
						tool_calls: rawWsResponse.tool_calls
							? normalizeToolCalls(rawWsResponse.tool_calls as unknown[])
							: undefined,
					};

					if (response.tool_calls && response.tool_calls.length > 0) {
						// Send tool call events
						for (const toolCall of response.tool_calls) {
							ws.send(JSON.stringify({
								type: 'cf_agent_use_chat_response',
								id: data.id,
								body: JSON.stringify({ type: 'tool-call', toolName: toolCall.function.name }),
								done: false,
							}));
						}

						// Execute tools
						const assistantMsg: Message = {
							role: 'assistant',
							content: null,
							tool_calls: response.tool_calls,
						};
						stored.messages.push(assistantMsg);
						messages.push(assistantMsg);

						const toolResults = await executeToolCalls(response.tool_calls, this.env);
						for (const result of toolResults) {
							const toolMsg: Message = {
								role: 'tool',
								content: result.content,
								tool_call_id: result.tool_call_id,
								name: result.tool_call_id,
							};
							stored.messages.push(toolMsg);
							messages.push(toolMsg);
						}

						// If every tool call failed, stop looping
						if (toolResults.every(r => r.content.startsWith('Error executing tool:'))) break;

						continue;
					}

					// No tool calls - stream final response
					finalText = response.response || '';
					break;
				}

				// Stream the final text
				const words = finalText.split(' ');
				for (const word of words) {
					ws.send(JSON.stringify({
						type: 'cf_agent_use_chat_response',
						id: data.id,
						body: JSON.stringify({ type: 'text-delta', delta: word + ' ' }),
						done: false,
					}));
				}

				// Send finish event
				ws.send(JSON.stringify({
					type: 'cf_agent_use_chat_response',
					id: data.id,
					body: JSON.stringify({ type: 'finish' }),
					done: true,
				}));

				// Save final message
				const assistantMsg: Message = {
					role: 'assistant',
					content: finalText,
				};
				stored.messages.push(assistantMsg);
				await this.saveState(stored);

				// Send updated messages
				ws.send(JSON.stringify({
					type: 'cf_agent_chat_messages',
					messages: stored.messages,
				}));
			}
		} catch (err) {
			console.error('WebSocket message error:', err);
			ws.send(JSON.stringify({
				type: 'cf_agent_use_chat_response',
				id: 'error',
				body: JSON.stringify({ type: 'error', errorText: (err as Error).message }),
				done: true,
			}));
		}
	}

	/** Handle WebSocket close */
	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
		// Cleanup if needed
		ws.close();
	}

	// ---- Storage helpers ----

	private async getStoredState(): Promise<ChatAgentState> {
		if (this._cache) return this._cache;
		const stored = await this.state.storage.get<ChatAgentState>('state');
		if (stored) {
			this._cache = stored;
			return stored;
		}
		const fresh: ChatAgentState = {
			messages: [],
			createdAt: Date.now(),
			lastActiveAt: Date.now(),
		};
		this._cache = fresh;
		return fresh;
	}

	private async saveState(state: ChatAgentState): Promise<void> {
		this._cache = state;
		await this.state.storage.put('state', state);
	}
}

function methodNotAllowed(): Response {
	return new Response('Method Not Allowed', { status: 405 });
}

/**
 * ChatAgent Durable Object
 * Handles per-conversation state: message history, context window, tool results.
 */

import type { Message, ChatRequest } from '../types';

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

	/** Append messages and return full history */
	async handleChat(req: ChatRequest): Promise<Response> {
		const stored = await this.getStoredState();

		// Append new user messages
		stored.messages.push(...req.messages);
		stored.lastActiveAt = Date.now();

		// Call Workers AI with conversation history
		const systemPrompt = this.env.SYSTEM_PROMPT ?? 'You are InsertaBot, a helpful coding assistant.';
		const model = req.model || '@cf/moonshotai/kimi-k2.6';

		// Prepare messages with system prompt
		const messages = [
			{ role: 'system', content: systemPrompt },
			...stored.messages,
		];

		try {
			const response = await this.env.AI.run(model, {
				messages,
				max_tokens: req.max_tokens,
				temperature: req.temperature,
				top_p: req.top_p,
				stream: false,
			});

			const assistantMsg: Message = {
				role: 'assistant',
				content: response.response || '',
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

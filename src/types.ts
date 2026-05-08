/**
 * Shared types for the InsertaBot worker.
 * AI chat types (UIMessage, ToolCall, etc.) come from @cloudflare/ai-chat and ai.
 */

export interface Message {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | null;
	name?: string;
	tool_call_id?: string;
}

export interface ChatRequest {
	model: string;
	messages: Message[];
	stream?: boolean;
	max_tokens?: number;
	temperature?: number;
	top_p?: number;
	[key: string]: unknown;
}

export interface ChatResponseChunk {
	id: string;
	object: 'chat.completion' | 'chat.completion.chunk';
	created: number;
	model: string;
	choices: Array<{
		index: number;
		delta?: Partial<Message>;
		message?: Message;
		finish_reason: string | null;
	}>;
	usage?: {
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
	};
}

export interface TavilySearchResult {
	title: string;
	url: string;
	content: string;
	score: number;
}

export interface TavilySearchResponse {
	query: string;
	results: TavilySearchResult[];
	answer?: string;
}

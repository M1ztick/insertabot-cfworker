/**
 * Shared types across the InsertaBot worker.
 * Keep this file lightweight — it's imported by almost every module.
 */

export interface Message {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	name?: string;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
}

export interface ToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
}

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: {
		type: 'object';
		properties: Record<string, unknown>;
		required?: string[];
	};
}

export interface ChatRequest {
	model: string;
	messages: Message[];
	stream?: boolean;
	max_tokens?: number;
	temperature?: number;
	top_p?: number;
	presence_penalty?: number;
	frequency_penalty?: number;
	tools?: ToolDefinition[];
	tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
	// Forward-compat for reasoning, etc.
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
}

export interface GithubToolCall {
	owner: string;
	repo: string;
	// ... expand per GitHub MCP tool signatures you use
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

/**
 * ChatAgent — Durable Object backed by AIChatAgent
 * Handles WebSocket chat, MCP server management, and streaming AI inference.
 */

import { AIChatAgent } from '@cloudflare/ai-chat';
import { callable } from 'agents';
import { createWorkersAI } from 'workers-ai-provider';
import { streamText, convertToModelMessages } from 'ai';
import type { ToolSet, StreamTextOnFinishCallback } from 'ai';
import type { Env } from '../worker-configuration';

export class ChatAgent extends AIChatAgent<Env> {
	/** Wait up to 8 s for MCP connections to settle after hibernation */
	waitForMcpConnections = { timeout: 8_000 };

	/** Connect to an external MCP server. Called by the UI via RPC. */
	@callable()
	async addServer(name: string, url: string, token?: string): Promise<void> {
		await this.addMcpServer(name, url, {
			...(token ? { transport: { headers: { Authorization: `Bearer ${token}` } } } : {}),
		});
	}

	/** Disconnect an MCP server by name. Called by the UI via RPC. */
	@callable()
	async removeServer(name: string): Promise<void> {
		await this.removeMcpServer(name);
	}

	/** Main chat handler — called by AIChatAgent for each user turn */
	async onChatMessage(
		onFinish: StreamTextOnFinishCallback<ToolSet>
	): Promise<Response | undefined> {
		const workersai = createWorkersAI({ binding: this.env.AI });
		const rawTools = this.mcp.getAITools();
		const hasTools = Object.keys(rawTools).length > 0;

		// Wrap each tool's execute to truncate large results before they hit the model.
		// GitHub "list repositories" and similar broad queries can return 500 KB+,
		// which overflows Kimi K2.6's context and causes a silent fail.
		const TOOL_RESULT_LIMIT = 12_000; // ~3 k tokens
		const tools: ToolSet = hasTools
			? Object.fromEntries(
					Object.entries(rawTools).map(([name, tool]) => {
						if (!tool.execute) return [name, tool];
						return [
							name,
							{
								...tool,
								execute: async (args: unknown, opts: unknown) => {
									// biome-ignore lint: dynamic MCP tool signature
									const result = await (tool.execute as Function)(args, opts);
									const text = JSON.stringify(result);
									if (text.length <= TOOL_RESULT_LIMIT) return result;
									return (
										text.slice(0, TOOL_RESULT_LIMIT) +
										'\n…[truncated — response too large for model context]'
									);
								},
							},
						];
					})
			  )
			: {};

		const result = streamText({
			model: workersai('@cf/moonshotai/kimi-k2.6'),
			system:
				this.env.SYSTEM_PROMPT ??
				'You are InsertaBot, a helpful AI assistant with access to tools via MCP servers.',
			messages: await convertToModelMessages(this.messages),
			...(hasTools ? { tools, maxSteps: 5 } : {}),
			onFinish,
		});

		return result.toUIMessageStreamResponse();
	}
}

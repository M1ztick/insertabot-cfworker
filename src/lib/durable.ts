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
		const tools = this.mcp.getAITools();

		const result = streamText({
			model: workersai('@cf/moonshotai/kimi-k2.6'),
			system:
				this.env.SYSTEM_PROMPT ??
				'You are InsertaBot, a helpful AI assistant with access to tools via MCP servers.',
			messages: convertToModelMessages(this.messages),
			tools,
			onFinish,
		});

		return result.toUIMessageStreamResponse();
	}
}

import { AIChatAgent, callable } from 'agents';
import { streamText, convertToModelMessages, stepCountIs } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import type { Env } from '../index';

const TOOL_RESULT_LIMIT = 12_000;

// Use a Workers AI model slug that actually exists in your account/catalog.
const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const DEFAULT_SYSTEM_PROMPT =
  'You are InsertaBot, a helpful AI assistant with access to tools via MCP servers.';

function truncateToolResult(result: unknown): unknown {
  if (typeof result === 'string') {
    return result.length <= TOOL_RESULT_LIMIT
      ? result
      : `${result.slice(0, TOOL_RESULT_LIMIT)}\n…[truncated — response too large for model context]`;
  }

  try {
    const text = JSON.stringify(result);

    if (text.length <= TOOL_RESULT_LIMIT) {
      return result;
    }

    return {
      truncated: true,
      preview: text.slice(0, TOOL_RESULT_LIMIT),
      message: 'Tool result truncated — response too large for model context',
    };
  } catch {
    const text = String(result);

    return text.length <= TOOL_RESULT_LIMIT
      ? text
      : `${text.slice(0, TOOL_RESULT_LIMIT)}\n…[truncated — response too large for model context]`;
  }
}

export class ChatAgent extends AIChatAgent<Env> {
  /**
   * Connect to an MCP server by URL.
   * Exposed as an RPC method so the UI can call it directly.
   *
   * If a prior connection for the same name is stuck in FAILED, remove it
   * before reconnecting.
   */
  @callable()
  async addServer(name: string, url: string, token?: string): Promise<void> {
    const existing = this.mcp.listServers().find((s) => s.name === name);

    if (existing) {
      if (existing.state === 'failed') {
        console.log(`[MCP] Clearing stale FAILED connection for "${name}" before retrying`);
        await this.removeMcpServer(existing.id);
      } else {
        // Already connected, connecting, or otherwise not failed.
        return;
      }
    }

    await this.addMcpServer(name, url, {
      ...(token
        ? { transport: { headers: { Authorization: `Bearer ${token}` } } }
        : {}),
    });

    console.log(`[MCP] Connected to "${name}" at ${url}`);
  }

  /**
   * Disconnect an MCP server by friendly name.
   */
  @callable()
  async removeServer(name: string): Promise<void> {
    const server = this.mcp.listServers().find((s) => s.name === name);

    if (!server) {
      console.warn(`[MCP] removeServer: no server named "${name}" found`);
      return;
    }

    await this.removeMcpServer(server.id);
    console.log(`[MCP] Disconnected "${name}"`);
  }

  /**
   * Main chat handler.
   * All connected MCP tools are exposed to the model.
   */
  async onChatMessage(
    onFinish: Parameters<AIChatAgent<Env>['onChatMessage']>[0],
  ) {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const rawTools = this.mcp.getAITools();
    const hasTools = Object.keys(rawTools).length > 0;

    const tools = hasTools
      ? Object.fromEntries(
          Object.entries(rawTools).map(([toolName, tool]: [string, any]) => {
            if (typeof tool?.execute !== 'function') {
              return [toolName, tool];
            }

            return [
              toolName,
              {
                ...tool,
                execute: async (args: unknown, opts: unknown) => {
                  const result = await tool.execute(args, opts);
                  return truncateToolResult(result);
                },
              },
            ];
          }),
        )
      : {};

    const result = streamText({
      model: workersai(DEFAULT_MODEL),
      system: this.env.SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT,
      messages: convertToModelMessages(this.messages),
      ...(hasTools ? { tools, stopWhen: stepCountIs(5) } : {}),
      onFinish,
    });

    return result.toUIMessageStreamResponse();
  }
}

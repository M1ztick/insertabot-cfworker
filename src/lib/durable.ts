import { AIChatAgent, callable, createWorkersAI, MCPConnectionState } from 'agents';
import { streamText } from 'ai';
import { convertToModelMessages } from 'agents';
import type { Env } from '../index';

const TOOL_RESULT_LIMIT = 12_000;
const DEFAULT_MODEL = '@cf/moonshotai/kimi-k2.6';
const DEFAULT_SYSTEM_PROMPT =
  'You are InsertaBot, a helpful AI assistant with access to tools via MCP servers.';

export class ChatAgent extends AIChatAgent<Env> {
  /**
   * Wait up to 8s for MCP connections to settle after hibernation.
   * Keeps chat snappy while still giving remote servers time to reconnect.
   */
  waitForMcpConnections = { timeout: 8_000 };

  /**
   * Connect to an MCP server by URL.
   * Exposed as an RPC method via @callable() so the UI can call it directly.
   *
   * Clears any stale FAILED connection before retrying — DO instances survive
   * deploys, so without this a failed connection blocks all future attempts
   * until the DO instance is evicted.
   */
  @callable()
  async addServer(name: string, url: string, token?: string): Promise<void> {
    const existing = this.mcp.listServers().find(s => s.name === name);

    if (existing) {
      const conn = this.mcp.mcpConnections[existing.id];

      if (conn?.connectionState === MCPConnectionState.FAILED) {
        console.log(`[MCP] Clearing stale FAILED connection for "${name}" before retrying`);
        await this.removeMcpServer(existing.id);
      } else {
        // Already connected or connecting — nothing to do
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
   * Disconnect an MCP server by name.
   * Note: the underlying removeMcpServer() takes an ID, not a name —
   * this method handles the lookup so callers just pass the friendly name.
   */
  @callable()
  async removeServer(name: string): Promise<void> {
    const server = this.mcp.listServers().find(s => s.name === name);
    if (!server) {
      console.warn(`[MCP] removeServer: no server named "${name}" found`);
      return;
    }
    await this.removeMcpServer(server.id);
    console.log(`[MCP] Disconnected "${name}"`);
  }

  /**
   * Main chat handler — called by AIChatAgent on every user turn.
   * All connected MCP tools are automatically available to the model.
   */
  async onChatMessage(onFinish: Parameters<AIChatAgent<Env>['onChatMessage']>[0]) {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const rawTools = this.mcp.getAITools();
    const hasTools = Object.keys(rawTools).length > 0;

    // Wrap each tool's execute() to truncate oversized results that would
    // blow the model's context window
    const tools = hasTools
      ? Object.fromEntries(
          Object.entries(rawTools).map(([toolName, tool]) => {
            if (!tool.execute) return [toolName, tool];
            return [
              toolName,
              {
                ...tool,
                execute: async (args: unknown, opts: unknown) => {
                  const result = await tool.execute!(args, opts);
                  const text = JSON.stringify(result);
                  return text.length <= TOOL_RESULT_LIMIT
                    ? result
                    : text.slice(0, TOOL_RESULT_LIMIT) +
                        '\n…[truncated — response too large for model context]';
                },
              },
            ];
          }),
        )
      : {};

    const result = streamText({
      model: workersai(DEFAULT_MODEL),
      system: this.env.SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT,
      messages: await convertToModelMessages(this.messages),
      ...(hasTools ? { tools, maxSteps: 5 } : {}),
      onFinish,
    });

    return result.toUIMessageStreamResponse();
  }
}

import { AIChatAgent } from '@cloudflare/ai-chat';
import { callable } from 'agents';
import { streamText, convertToModelMessages, stepCountIs } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import type { Env } from '../worker-configuration';

const TOOL_RESULT_LIMIT = 12_000;
const sanitize = (s: string) => s.replace(/[\r\n]/g, ' ');
const DEFAULT_SYSTEM_PROMPT =
  'You are InsertaBot, a helpful AI assistant with access to tools via MCP servers.';

type ModelLane = 'research' | 'coding';

// Which model handles a turn depends on what the session is for. Sessions
// are already isolated per named DO instance, so the MCP servers attached
// to a session are a natural signal of intent (a session with GitHub's MCP
// server attached is a coding session) — no separate classification step
// needed. `setModelLane` below is the manual override for sessions that mix
// tools and need a hint stronger than that inference.
const MODEL_LANES: Record<ModelLane, { modelId: string; options: Record<string, unknown> }> = {
  research: {
    modelId: '@cf/moonshotai/kimi-k2.6',
    options: {
      // kimi-k2.6 renamed enable_thinking → thinking; disable it to avoid the
      // 8005 "Internal server error" that triggers when the backend tries to stream
      // reasoning tokens through a path that isn't fully stable yet.
      // Types still reflect k2.5 (enable_thinking); cast to send the k2.6 param name.
      chat_template_kwargs: { thinking: false },
    },
  },
  coding: {
    modelId: '@cf/moonshotai/kimi-k2.7-code',
    options: {},
  },
};

function inferLane(servers: { name: string; server_url: string }[]): ModelLane {
  const isCodingServer = (s: { name: string; server_url: string }) =>
    /github/i.test(s.name) || /github/i.test(s.server_url);
  return servers.some(isCodingServer) ? 'coding' : 'research';
}

interface ChatAgentState {
  modelLane: ModelLane | 'auto';
}

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

export class ChatAgent extends AIChatAgent<Env, ChatAgentState> {
  // Wait for any MCP connections that are still restoring after DO
  // hibernation before running the chat turn. Without this, getAITools()
  // can return tool *schemas* whose underlying transport isn't ready yet,
  // and the second-or-later tool call fails silently inside execute().
  waitForMcpConnections: boolean | { timeout: number } = { timeout: 10_000 };

  initialState: ChatAgentState = { modelLane: 'auto' };

  /**
   * Manually pin the model lane for this session, overriding inference
   * from attached MCP servers. Pass 'auto' to revert to inference.
   */
  @callable()
  setModelLane(lane: ModelLane | 'auto'): void {
    if (lane !== 'auto' && !(lane in MODEL_LANES)) {
      throw new Error(`Invalid model lane: "${lane}"`);
    }
    this.setState({ modelLane: lane });
  }

  /**
   * Connect to an MCP server by URL.
   * Exposed as an RPC method so the UI can call it directly.
   *
   * If a prior connection for the same name is stuck in FAILED, remove it
   * before reconnecting.
   */
  @callable()
  async addServer(name: string, url: string, token?: string): Promise<void> {
    try {
      new URL(url);
    } catch {
      throw new Error(`Invalid server URL: "${url}"`);
    }

    if (token) {
      try {
        new URL(token);
        // If this succeeds, the user pasted a URL into the token field
        throw new Error(
          'The access token field contains a URL. If your MCP server uses a query-parameter API key (e.g. ?tavilyApiKey=…), include it in the Server URL field and leave the token field empty.',
        );
      } catch (e) {
        // Re-throw our own validation error; ignore URL parse failures (expected for real tokens)
        if ((e as Error).message.startsWith('The access token field')) throw e;
      }
    }

    const existing = this.mcp.listServers().find((s) => s.name === name);
    if (existing) {
      const conn = this.mcp.mcpConnections[existing.id];
      if (conn?.connectionState === 'failed') {
        console.log(`[MCP] Clearing stale FAILED connection for "${sanitize(name)}" before retrying`);
        await this.removeMcpServer(existing.id);
      } else {
        return;
      }
    }

    await this.addMcpServer(name, url, {
      ...(token ? { transport: { headers: { Authorization: `Bearer ${token}` } } } : {}),
    });
    console.log(`[MCP] Connected to "${sanitize(name)}" at ${sanitize(url)}`);
  }

  /**
   * Disconnect an MCP server by friendly name.
   */
  @callable()
  async removeServer(nameOrId: string): Promise<void> {
    const server = this.mcp.listServers().find((s) => s.id === nameOrId || s.name === nameOrId);
    if (!server) {
      console.warn(`[MCP] removeServer: no server matching "${sanitize(nameOrId)}" found`);
      return;
    }
    await this.removeMcpServer(server.id);
    console.log(`[MCP] Disconnected "${sanitize(server.name)}"`);
  }

  /**
   * Main chat handler.
   * All connected MCP tools are exposed to the model.
   */
  async onChatMessage(
    onFinish: Parameters<AIChatAgent<Env>['onChatMessage']>[0],
  ) {
    const workersai = createWorkersAI({ binding: this.env.AI, gateway: { id: 'insertabot-cfworker' } });
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
                  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
                    throw new Error(`Tool "${toolName}" received invalid arguments: expected a plain object`);
                  }
                  const result = await tool.execute(args, opts);
                  return truncateToolResult(result);
                },
              },
            ];
          }),
        )
      : {};

    const lane = this.state.modelLane === 'auto' ? inferLane(this.mcp.listServers()) : this.state.modelLane;
    const { modelId, options } = MODEL_LANES[lane];

    const result = streamText({
      model: workersai(modelId, options),
      system: this.env.SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT,
      messages: await convertToModelMessages(this.messages),
      // stopWhen must be set whenever tools are even *possible*, otherwise
      // ai@6 defaults to stepCountIs(1) which terminates after the first
      // tool-call step — that's why "the AI only works for a singular
      // tool use before it stops responding". 5 multi-step rounds is a
      // safe default.
      ...(hasTools ? { tools, stopWhen: stepCountIs(5) } : {}),
      // Surface tool execution + provider errors to the UI stream instead
      // of letting them disappear into the void.
      onError({ error }) {
        console.error('[streamText error]', error);
      },
      onFinish,
    });

    return result.toUIMessageStreamResponse({
      // Send error details over the stream so the front-end can render
      // them. Without this, errors are replaced with a generic message
      // and the UI just stops.
      onError(error) {
        console.error('[uiMessageStream error]', error);
        return error instanceof Error ? error.message : String(error);
      },
    });
  }
}

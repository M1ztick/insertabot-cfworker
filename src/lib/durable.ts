import { AIChatAgent } from '@cloudflare/ai-chat';
import { callable } from 'agents';
import { streamText, convertToModelMessages, stepCountIs } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import type { Env } from '../worker-configuration';
import { isEthicalModerationEnabled } from './ethical-moderation';

const TOOL_RESULT_LIMIT = 12_000;
const DEFAULT_MODEL = '@cf/moonshotai/kimi-k2.6';
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
  // Wait for any MCP connections that are still restoring after DO
  // hibernation before running the chat turn. Without this, getAITools()
  // can return tool *schemas* whose underlying transport isn't ready yet,
  // and the second-or-later tool call fails silently inside execute().
  waitForMcpConnections: boolean | { timeout: number } = { timeout: 10_000 };

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
        console.log(`[MCP] Clearing stale FAILED connection for "${name}" before retrying`);
        await this.removeMcpServer(existing.id);
      } else {
        return;
      }
    }

    await this.addMcpServer(name, url, {
      ...(token ? { transport: { headers: { Authorization: `Bearer ${token}` } } } : {}),
    });
    console.log(`[MCP] Connected to "${name}" at ${url}`);
  }

  /**
   * Disconnect an MCP server by friendly name.
   */
  @callable()
  async removeServer(nameOrId: string): Promise<void> {
    const server = this.mcp.listServers().find((s) => s.id === nameOrId || s.name === nameOrId);
    if (!server) {
      console.warn(`[MCP] removeServer: no server matching "${nameOrId}" found`);
      return;
    }
    await this.removeMcpServer(server.id);
    console.log(`[MCP] Disconnected "${server.name}"`);
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
                  const result = await tool.execute(args, opts);
                  return truncateToolResult(result);
                },
              },
            ];
          }),
        )
      : {};

    // Get the last user message for ethical evaluation
    const lastUserMessage = this.messages
      .filter(m => m.role === 'user')
      .pop()
      ?.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map(p => p.text)
      .join('') ?? '';

    const result = streamText({
      model: workersai(DEFAULT_MODEL, {
        // kimi-k2.6 renamed enable_thinking → thinking; disable it to avoid the
        // 8005 "Internal server error" that triggers when the backend tries to stream
        // reasoning tokens through a path that isn't fully stable yet.
        // Types still reflect k2.5 (enable_thinking); cast to send the k2.6 param name.
        chat_template_kwargs: { thinking: false } as Record<string, unknown>,
      }),
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
      onFinish: async (event) => {
        // Run SAIGE ethics evaluation on the completed response if enabled
        if (isEthicalModerationEnabled(this.env) && lastUserMessage) {
          // Note: We can't easily get the full response text here from the event
          // In a production implementation, you might want to store this in the 
          // message history and evaluate on the next turn, or use a different approach
          console.log('[SAIGE] Ethics evaluation would run here on completed response');
        }
        
        onFinish?.(event);
      },
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

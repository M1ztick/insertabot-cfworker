import { AIChatAgent } from '@cloudflare/ai-chat';
import { callable } from 'agents';
import { streamText, convertToModelMessages, stepCountIs } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import type { Env } from '../worker-configuration';
import { evaluateEthics, isEthicalModerationEnabled, formatEthicsLog, type EthicsEvaluationResult } from './ethical-moderation';

const TOOL_RESULT_LIMIT = 12_000;
// NOTE: Workers AI does NOT have kimi-k2.6 — that's the AI Gateway id.
// The Workers AI binding id is kimi-k2.5. Using a bogus id makes the
// binding throw, which streamText folds into a stream-error chunk that
// the front-end currently ignores (hence the silent fail).
const DEFAULT_MODEL = '@cf/moonshotai/kimi-k2.5';
const DEFAULT_SYSTEM_PROMPT =
  'You are InsertaBot, a helpful AI assistant with access to tools via MCP servers.';

// SAIGE integration constants
const ETHICS_SUFFIX = '\n\n[Response evaluated by SAIGE ethical framework]';

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
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
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
   * Evaluate a response using SAIGE ethics framework.
   * Returns the evaluation result and optionally regenerates if it fails ethics.
   */
  private async evaluateAndRegenerateIfNeeded(
    userMessage: string,
    assistantResponse: string
  ): Promise<{ response: string; ethics?: EthicsEvaluationResult }> {
    if (!isEthicalModerationEnabled(this.env)) {
      return { response: assistantResponse };
    }

    const ethics = await evaluateEthics(
      userMessage,
      assistantResponse,
      this.env.SAIGE_ENDPOINT
    );

    // Log ethics scores for observability
    console.log('[SAIGE] Ethics evaluation:', formatEthicsLog(ethics));

    if (ethics.passed) {
      return { 
        response: assistantResponse + ETHICS_SUFFIX,
        ethics 
      };
    }

    console.warn('[SAIGE] Response failed ethics check:', ethics.failureReason);

    // Regenerate with ethical guidance
    const ethicalPrompt = `${this.env.SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT}

IMPORTANT: Your previous response did not meet ethical standards.
Guidance for improvement: ${ethics.guidance}

Please provide a response that better embodies:
- Ahimsa (non-harm): Avoid causing suffering
- Sacca (truthfulness): Be honest and accurate
- Karuna (compassion): Show genuine care
- Panna (wisdom): Consider context deeply
- Upekkha (equanimity): Remain calm and balanced`;

    const workersai = createWorkersAI({ binding: this.env.AI });
    const messages = await convertToModelMessages(this.messages);
    
    // Remove last assistant message and regenerate
    const messagesWithoutLast = messages.slice(0, -1);
    
    const result = streamText({
      model: workersai(DEFAULT_MODEL),
      system: ethicalPrompt,
      messages: messagesWithoutLast,
    });

    // Collect the regenerated response
    let regeneratedText = '';
    for await (const chunk of result.textStream) {
      regeneratedText += chunk;
    }

    // Re-evaluate the regenerated response
    const secondEthics = await evaluateEthics(userMessage, regeneratedText, this.env.SAIGE_ENDPOINT);
    
    return {
      response: regeneratedText + ETHICS_SUFFIX + '\n[Ethically regenerated]',
      ethics: secondEthics,
    };
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

    // Get the last user message for ethical evaluation
    const lastUserMessage = this.messages
      .filter(m => m.role === 'user')
      .pop()?.content || '';

    const result = streamText({
      model: workersai(DEFAULT_MODEL),
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

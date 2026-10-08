/**
 * Conversation context windowing.
 *
 * `onChatMessage` used to hand the model `convertToModelMessages(this.messages)`
 * — the ENTIRE conversation, every turn, with no cap anywhere in this repo or in
 * @cloudflare/ai-chat. A long-lived thread therefore degrades in three ways at
 * once:
 *
 *   1. Cost: every turn re-bills the whole history as input tokens, so spend
 *      grows quadratically with conversation length, not linearly.
 *   2. Quality: the current question ends up buried under thousands of tokens
 *      of stale context. Attention spreads thin, the model starts answering
 *      from old turns, confuses superseded facts for current ones, and
 *      hallucinates.
 *   3. Hard failure: past the model's context limit the request simply fails,
 *      which strands the whole thread — there is no way to send one more
 *      message to a conversation that no longer fits.
 *
 * This module keeps a bounded, recent window and drops the middle. It windows
 * `UIMessage`s BEFORE `convertToModelMessages`, which matters: conversion
 * expands one tool call into an `assistant` + `tool` message PAIR, so slicing
 * the converted list can orphan a `tool` result whose originating tool-call is
 * gone. Providers reject that. Windowing upstream keeps each message's parts
 * together by construction.
 *
 * Nothing here deletes anything. Full history stays in Durable Object storage
 * and is still what the UI renders; this only bounds what the MODEL sees.
 */

/** Minimal shape this module needs. Structural, so it accepts ai@7 UIMessage. */
export interface WindowableMessage {
	role: string;
	parts?: unknown[];
	content?: unknown;
}

export interface ContextWindowOptions {
	/**
	 * Approximate input-token ceiling for replayed history. Deliberately well
	 * under the model's true limit to leave room for the system prompt, the
	 * memory block, tool schemas, and the response itself.
	 */
	maxTokens?: number;
	/**
	 * Always keep at least this many of the most recent messages, even if the
	 * estimate says they exceed the budget. Without a floor, one enormous
	 * message could starve the window down to nothing and the model would lose
	 * the question it is supposed to answer.
	 */
	minRecentMessages?: number;
	/**
	 * Hard cap on replayed messages regardless of token estimate. Guards against
	 * a long tail of tiny messages that cost little individually but bloat the
	 * request and slow every turn.
	 */
	maxMessages?: number;
}

export const DEFAULT_CONTEXT_WINDOW: Required<ContextWindowOptions> = {
	// Kimi K2.x advertises a large window, but usable quality falls off well
	// before the documented ceiling, and input tokens are the dominant cost
	// here. ~24k characters-worth of budget keeps a long, useful window while
	// bounding spend per turn.
	maxTokens: 6_000,
	minRecentMessages: 4,
	maxMessages: 40,
};

/** Rough chars-per-token ratio for English prose and code. */
const CHARS_PER_TOKEN = 4;

/** Fixed per-message overhead (role, delimiters) the provider adds. */
const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * Attachments are referenced, not inlined, so their cost is not proportional to
 * the data-URL length. Charging a flat estimate stops one pasted image from
 * evicting the entire conversation.
 */
const FILE_PART_TOKENS = 260;

function textOf(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/**
 * Estimate the token cost of a single message.
 *
 * An estimate is the right tool here: a real tokenizer for Kimi is not
 * available in the Workers runtime, and the budget is a soft guard rail rather
 * than a hard provider limit. Over-estimating slightly is the safe direction.
 */
export function estimateMessageTokens(message: WindowableMessage): number {
	let chars = 0;
	let tokens = MESSAGE_OVERHEAD_TOKENS;

	const parts = Array.isArray(message.parts) ? message.parts : [];
	for (const rawPart of parts) {
		const part = rawPart as { type?: string; text?: unknown; input?: unknown; output?: unknown };
		const type = typeof part.type === 'string' ? part.type : '';

		if (type === 'file' || type === 'reasoning-file') {
			tokens += FILE_PART_TOKENS;
			continue;
		}

		if (type === 'text' || type === 'reasoning') {
			chars += textOf(part.text).length;
			continue;
		}

		// Tool parts (`tool-<name>` / `dynamic-tool`) carry an input object and
		// often a large output. Both are serialised into the request.
		if (type.startsWith('tool-') || type === 'dynamic-tool') {
			for (const payload of [part.input, part.output]) {
				if (payload === undefined || payload === null) continue;
				if (typeof payload === 'string') {
					chars += payload.length;
				} else {
					try {
						chars += JSON.stringify(payload).length;
					} catch {
						chars += 200; // Unserialisable; charge a nominal amount.
					}
				}
			}
			continue;
		}

		// Unknown part types still occupy space; charge their serialised size.
		try {
			chars += JSON.stringify(rawPart).length;
		} catch {
			chars += 50;
		}
	}

	// Legacy/plain shape: a bare string `content` with no parts array.
	if (parts.length === 0) chars += textOf(message.content).length;

	return tokens + Math.ceil(chars / CHARS_PER_TOKEN);
}

export interface WindowResult<T> {
	/** The messages to send to the model, in original order. */
	messages: T[];
	/** How many leading messages were dropped. */
	droppedCount: number;
	/** Estimated tokens for the kept window. */
	estimatedTokens: number;
}

/**
 * Select a bounded, recent window of messages.
 *
 * Walks backwards from the newest message so the current question and its
 * immediate context are never the thing that gets dropped, then restores
 * chronological order.
 */
export function windowMessages<T extends WindowableMessage>(
	messages: readonly T[],
	options: ContextWindowOptions = {},
): WindowResult<T> {
	const { maxTokens, minRecentMessages, maxMessages } = { ...DEFAULT_CONTEXT_WINDOW, ...options };

	if (messages.length === 0) {
		return { messages: [], droppedCount: 0, estimatedTokens: 0 };
	}

	const kept: T[] = [];
	let total = 0;

	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		const cost = estimateMessageTokens(message);
		const withinMinimum = kept.length < minRecentMessages;

		if (!withinMinimum) {
			if (kept.length >= maxMessages) break;
			if (total + cost > maxTokens) break;
		}

		kept.push(message);
		total += cost;
	}

	kept.reverse();

	return {
		messages: kept,
		droppedCount: messages.length - kept.length,
		estimatedTokens: total,
	};
}

/**
 * Note prepended to the system prompt when history was truncated.
 *
 * Without this the model cannot distinguish "this is the whole conversation"
 * from "you are seeing the tail of a longer one", and will confidently answer
 * questions about earlier turns it can no longer see. Telling it to say so
 * converts a silent hallucination into an honest answer the user can act on.
 */
export function truncationNotice(droppedCount: number): string {
	return [
		'',
		`Note: ${droppedCount} earlier message${droppedCount === 1 ? '' : 's'} in this conversation`,
		'have been omitted to stay within the context limit. You are seeing only the most',
		'recent portion. If the user refers to something you cannot see, say so plainly and',
		'ask them to restate it rather than guessing.',
	].join('\n');
}

import { describe, it, expect } from 'vitest';
import { convertToModelMessages, pruneMessages } from 'ai';
import {
	windowMessages,
	estimateMessageTokens,
	truncationNotice,
	DEFAULT_CONTEXT_WINDOW,
	type WindowableMessage,
} from '../src/lib/context';

function textMessage(role: string, text: string, id = crypto.randomUUID()): WindowableMessage & { id: string } {
	return { id, role, parts: [{ type: 'text', text }] };
}

/** `n` alternating turns, each `chars` long. */
function conversation(n: number, chars = 40): (WindowableMessage & { id: string })[] {
	return Array.from({ length: n }, (_, i) =>
		textMessage(i % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(chars), `m${i}`),
	);
}

describe('estimateMessageTokens', () => {
	it('scales with text length', () => {
		const small = estimateMessageTokens(textMessage('user', 'hi'));
		const large = estimateMessageTokens(textMessage('user', 'x'.repeat(4000)));
		expect(large).toBeGreaterThan(small);
		expect(large).toBeGreaterThan(900); // ~4000/4
	});

	it('charges a flat rate for file parts rather than data-URL length', () => {
		const tiny = { role: 'user', parts: [{ type: 'file', url: 'data:image/png;base64,AAA' }] };
		const huge = { role: 'user', parts: [{ type: 'file', url: `data:image/png;base64,${'A'.repeat(500_000)}` }] };
		expect(estimateMessageTokens(tiny)).toBe(estimateMessageTokens(huge));
	});

	it('counts tool input and output payloads', () => {
		const bare = { role: 'assistant', parts: [{ type: 'tool-search', toolCallId: 't1' }] };
		const withPayload = {
			role: 'assistant',
			parts: [{ type: 'tool-search', toolCallId: 't1', input: { q: 'x' }, output: 'y'.repeat(2000) }],
		};
		expect(estimateMessageTokens(withPayload)).toBeGreaterThan(estimateMessageTokens(bare) + 400);
	});

	it('handles a legacy bare-string content message', () => {
		expect(estimateMessageTokens({ role: 'user', content: 'x'.repeat(400) })).toBeGreaterThan(90);
	});

	it('does not throw on circular or exotic parts', () => {
		const circular: Record<string, unknown> = { type: 'weird' };
		circular.self = circular;
		expect(() => estimateMessageTokens({ role: 'user', parts: [circular] })).not.toThrow();
	});
});

describe('windowMessages', () => {
	it('returns everything when the conversation is small', () => {
		const msgs = conversation(6);
		const out = windowMessages(msgs);
		expect(out.messages).toHaveLength(6);
		expect(out.droppedCount).toBe(0);
	});

	it('drops the oldest messages once over budget, keeping the newest', () => {
		const msgs = conversation(400, 400);
		const out = windowMessages(msgs);

		expect(out.droppedCount).toBeGreaterThan(0);
		expect(out.messages.length).toBeLessThan(msgs.length);
		// The newest message must always survive — it is the current question.
		expect(out.messages.at(-1)).toBe(msgs.at(-1));
		// And the oldest must be the thing that went.
		expect(out.messages[0]).not.toBe(msgs[0]);
	});

	it('preserves chronological order', () => {
		const msgs = conversation(200, 300);
		const out = windowMessages(msgs);
		const ids = out.messages.map((m) => (m as { id: string }).id);
		expect(ids).toEqual([...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
	});

	it('respects maxMessages even when every message is tiny', () => {
		const out = windowMessages(conversation(500, 1), { maxTokens: 10_000_000 });
		expect(out.messages.length).toBeLessThanOrEqual(DEFAULT_CONTEXT_WINDOW.maxMessages);
	});

	it('keeps minRecentMessages even when a single message blows the budget', () => {
		const msgs = [
			textMessage('user', 'old'),
			textMessage('assistant', 'old reply'),
			textMessage('user', 'x'.repeat(500_000)),
		];
		const out = windowMessages(msgs, { maxTokens: 100, minRecentMessages: 2 });
		// The floor guarantees the model still receives the question.
		expect(out.messages.length).toBeGreaterThanOrEqual(2);
		expect(out.messages.at(-1)).toBe(msgs.at(-1));
	});

	it('never returns an empty window for a non-empty conversation', () => {
		const out = windowMessages(conversation(50, 10_000), { maxTokens: 1 });
		expect(out.messages.length).toBeGreaterThan(0);
	});

	it('handles an empty conversation', () => {
		const out = windowMessages([]);
		expect(out).toEqual({ messages: [], droppedCount: 0, estimatedTokens: 0 });
	});

	it('reports an estimate consistent with the kept messages', () => {
		const out = windowMessages(conversation(100, 200));
		const recomputed = out.messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
		expect(out.estimatedTokens).toBe(recomputed);
	});

	it('bounds cost: a 1000-turn thread replays a small fraction', () => {
		const out = windowMessages(conversation(1000, 500));
		expect(out.estimatedTokens).toBeLessThanOrEqual(DEFAULT_CONTEXT_WINDOW.maxTokens + 200);
		expect(out.messages.length).toBeLessThan(100);
	});
});

/**
 * Regression guard for the reason this windows UIMessages rather than
 * ModelMessages: conversion expands one tool call into an assistant + tool
 * message PAIR, so slicing after conversion can orphan a `tool` result whose
 * originating tool-call is no longer present. Providers reject that.
 */
describe('tool-call pair integrity through conversion', () => {
	const withToolCall = [
		textMessage('user', 'search for x', 'u1'),
		{
			id: 'a1',
			role: 'assistant',
			parts: [
				{
					type: 'tool-search',
					toolCallId: 't1',
					state: 'output-available',
					input: { q: 'x' },
					output: 'result text',
				},
			],
		},
		textMessage('user', 'thanks', 'u2'),
	];

	it('every tool message is preceded by an assistant message after windowing', async () => {
		const windowed = windowMessages(withToolCall, { minRecentMessages: 1, maxTokens: 100_000 });
		const converted = await convertToModelMessages(windowed.messages);

		converted.forEach((msg, i) => {
			if (msg.role === 'tool') {
				expect(i, 'a tool message must never be first').toBeGreaterThan(0);
				expect(converted[i - 1].role).toBe('assistant');
			}
		});
	});

	it('survives the prune settings used in production', async () => {
		const windowed = windowMessages(withToolCall, { maxTokens: 100_000 });
		const pruned = pruneMessages({
			messages: await convertToModelMessages(windowed.messages),
			reasoning: 'before-last-message',
			toolCalls: 'before-last-2-messages',
		});
		expect(pruned.length).toBeGreaterThan(0);
		pruned.forEach((msg, i) => {
			if (msg.role === 'tool') expect(pruned[i - 1]?.role).toBe('assistant');
		});
	});

	it('a truncated window still converts without throwing', async () => {
		const long = [...conversation(300, 400), ...withToolCall];
		const windowed = windowMessages(long);
		await expect(convertToModelMessages(windowed.messages)).resolves.toBeDefined();
	});
});

describe('truncationNotice', () => {
	it('tells the model history is partial and not to guess', () => {
		const notice = truncationNotice(42);
		expect(notice).toContain('42 earlier messages');
		expect(notice).toMatch(/say so/i);
	});

	it('uses the singular for one dropped message', () => {
		expect(truncationNotice(1)).toContain('1 earlier message in');
	});
});

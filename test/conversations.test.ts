import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach } from 'vitest';
import {
	SCHEMA_STATEMENTS,
	TITLE_MAX,
	PREVIEW_MAX,
	MAX_PAGE_SIZE,
	UNTITLED,
	clampLimit,
	clip,
	decodeCursor,
	deleteConversation,
	encodeCursor,
	ensureSchema,
	getConversation,
	isValidConversationId,
	listConversations,
	normalizeTitle,
	renameConversation,
	summarize,
	upsertConversation,
} from '../src/lib/conversations';
import { createTestD1 } from './helpers/d1';

const ALICE = 'a'.repeat(32);
const BOB = 'b'.repeat(32);

const user = (text: string) => ({ role: 'user', parts: [{ type: 'text', text }] });
const bot = (text: string) => ({ role: 'assistant', parts: [{ type: 'text', text }] });

describe('summarize', () => {
	it('titles a thread with its first user turn and previews the latest', () => {
		const s = summarize([user('How do I bake bread?'), bot('Start with flour.'), user('Thanks!')]);
		expect(s).toEqual({ title: 'How do I bake bread?', preview: 'Thanks!', messageCount: 3 });
	});

	it('ignores system messages in the count and title', () => {
		const s = summarize([{ role: 'system', parts: [{ type: 'text', text: 'sys' }] }, user('hi')]);
		expect(s.messageCount).toBe(1);
		expect(s.title).toBe('hi');
	});

	it('labels an image-only turn instead of leaving it blank', () => {
		const s = summarize([{ role: 'user', parts: [{ type: 'file' }] }]);
		expect(s.title).toBe('[Image]');
	});

	it('skips an empty trailing turn when choosing the preview', () => {
		// e.g. an assistant message that is only a tool call so far
		const s = summarize([user('q'), bot('real answer'), { role: 'assistant', parts: [{ type: 'tool-x' }] }]);
		expect(s.preview).toBe('real answer');
	});

	it('falls back to v4 `content`', () => {
		expect(summarize([{ role: 'user', content: 'legacy' }]).title).toBe('legacy');
	});

	it('bounds and flattens long text', () => {
		const s = summarize([user(`line one\n\n${'x'.repeat(500)}`)]);
		expect(s.title.length).toBe(TITLE_MAX);
		expect(s.title.endsWith('…')).toBe(true);
		expect(s.title).not.toContain('\n');
		expect(s.preview.length).toBe(PREVIEW_MAX);
	});

	it('reports an empty thread as zero messages', () => {
		expect(summarize([])).toEqual({ title: '', preview: '', messageCount: 0 });
	});
});

describe('clip / normalizeTitle', () => {
	it('leaves short text alone apart from whitespace', () => {
		expect(clip('  a \n b  ', 10)).toBe('a b');
	});
	it('rejects non-strings and blank titles', () => {
		expect(normalizeTitle(42)).toBe('');
		expect(normalizeTitle('   ')).toBe('');
		expect(normalizeTitle(' My thread ')).toBe('My thread');
	});
});

describe('isValidConversationId', () => {
	it.each(['3f2b1c9e-8d7a-4b6c-9e5f-1a2b3c4d5e6f', 'abc_DEF-123'])('accepts %s', (id) => {
		expect(isValidConversationId(id)).toBe(true);
	});
	it.each(['', 'a~b', 'a/b', '../x', 'a b', 'x'.repeat(129), null, 7])('rejects %s', (id) => {
		expect(isValidConversationId(id)).toBe(false);
	});
});

describe('cursor', () => {
	it('round-trips', () => {
		const c = encodeCursor({ updatedAt: 1700000000123, id: 'abc-1' });
		expect(decodeCursor(c)).toEqual({ updatedAt: 1700000000123, id: 'abc-1' });
	});
	it.each(['', '!!!', btoa('nope'), btoa('12:a~b'), btoa('x:abc')])('rejects garbage %s', (c) => {
		expect(decodeCursor(c)).toBeNull();
	});
});

describe('clampLimit', () => {
	it('defaults, floors and caps', () => {
		expect(clampLimit(undefined)).toBe(30);
		expect(clampLimit('0')).toBe(30);
		expect(clampLimit('-5')).toBe(30);
		expect(clampLimit('7.9')).toBe(7);
		expect(clampLimit(10_000)).toBe(MAX_PAGE_SIZE);
	});
});

/**
 * The runtime DDL in conversations.ts exists so a deploy that skipped
 * `d1 migrations apply` still works. If it drifts from the migration, the
 * two environments silently end up with different tables.
 */
describe('schema', () => {
	const norm = (s: string) =>
		s
			.replace(/--.*$/gm, '')
			.replace(/\s+/g, ' ')
			.replace(/\s*([(),;])\s*/g, '$1')
			.trim()
			.toLowerCase();

	it('runtime DDL matches migrations/0001_conversations.sql', () => {
		const migration = readFileSync(new URL('../migrations/0001_conversations.sql', import.meta.url), 'utf8');
		const fromFile = norm(migration).split(';').filter(Boolean);
		expect(SCHEMA_STATEMENTS.map(norm)).toEqual(fromFile);
	});

	it('is idempotent', async () => {
		const db = createTestD1();
		await ensureSchema(db);
		await db.batch(SCHEMA_STATEMENTS.map((s) => db.prepare(s)));
	});
});

describe('conversation index (D1)', () => {
	let db: ReturnType<typeof createTestD1>;

	beforeEach(async () => {
		db = createTestD1();
		await ensureSchema(db);
	});

	it('creates, then updates in place', async () => {
		await upsertConversation(db, ALICE, 'c1', summarize([user('first')]), 1000);
		await upsertConversation(db, ALICE, 'c1', summarize([user('first'), bot('reply')]), 2000);
		const c = await getConversation(db, ALICE, 'c1');
		expect(c).toEqual({
			id: 'c1',
			title: 'first',
			preview: 'reply',
			messageCount: 2,
			createdAt: 1000,
			updatedAt: 2000,
		});
	});

	it('does not bump updatedAt when nothing changed (reconnect / backfill)', async () => {
		const s = summarize([user('q'), bot('a')]);
		await upsertConversation(db, ALICE, 'c1', s, 1000);
		await upsertConversation(db, ALICE, 'c1', s, 9999);
		expect((await getConversation(db, ALICE, 'c1'))?.updatedAt).toBe(1000);
	});

	it('keeps a renamed title through later turns', async () => {
		await upsertConversation(db, ALICE, 'c1', summarize([user('auto title')]), 1000);
		await renameConversation(db, ALICE, 'c1', 'My name');
		await upsertConversation(db, ALICE, 'c1', summarize([user('auto title'), bot('x')]), 2000);
		expect((await getConversation(db, ALICE, 'c1'))?.title).toBe('My name');
	});

	it('never replaces a real title with an empty one', async () => {
		await upsertConversation(db, ALICE, 'c1', summarize([user('keep me')]), 1000);
		await upsertConversation(db, ALICE, 'c1', { title: '', preview: '', messageCount: 0 }, 2000);
		expect((await getConversation(db, ALICE, 'c1'))?.title).toBe('keep me');
	});

	it('shows a placeholder for an untitled row', async () => {
		await upsertConversation(db, ALICE, 'c1', { title: '', preview: '', messageCount: 1 }, 1000);
		expect((await getConversation(db, ALICE, 'c1'))?.title).toBe(UNTITLED);
	});

	it('isolates owners on every operation', async () => {
		await upsertConversation(db, ALICE, 'shared-id', summarize([user('alice')]), 1000);
		await upsertConversation(db, BOB, 'shared-id', summarize([user('bob')]), 1000);

		expect((await listConversations(db, BOB)).conversations.map((c) => c.title)).toEqual(['bob']);
		expect(await renameConversation(db, BOB, 'only-alice-has-this', 'x')).toBeNull();

		await renameConversation(db, BOB, 'shared-id', 'renamed by bob');
		expect((await getConversation(db, ALICE, 'shared-id'))?.title).toBe('alice');

		expect(await deleteConversation(db, BOB, 'shared-id')).toBe(true);
		expect(await getConversation(db, ALICE, 'shared-id')).not.toBeNull();
	});

	it('lists newest first and pages with a stable cursor', async () => {
		for (let i = 0; i < 7; i++) {
			await upsertConversation(db, ALICE, `c${i}`, summarize([user(`t${i}`)]), 1000 + i);
		}
		// Two rows sharing a timestamp exercise the id tiebreak.
		await upsertConversation(db, ALICE, 'tie-a', summarize([user('ta')]), 1003);

		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const page = await listConversations(db, ALICE, { limit: 3, cursor });
			seen.push(...page.conversations.map((c) => c.id));
			cursor = page.nextCursor;
			pages++;
		} while (cursor && pages < 10);

		expect(pages).toBe(3);
		expect(seen).toEqual(['c6', 'c5', 'c4', 'tie-a', 'c3', 'c2', 'c1', 'c0']);
		expect(new Set(seen).size).toBe(seen.length);
	});

	it('returns no cursor on an exact final page', async () => {
		await upsertConversation(db, ALICE, 'c1', summarize([user('a')]), 1);
		await upsertConversation(db, ALICE, 'c2', summarize([user('b')]), 2);
		expect((await listConversations(db, ALICE, { limit: 2 })).nextCursor).toBeNull();
	});

	it('reports whether a delete removed anything', async () => {
		await upsertConversation(db, ALICE, 'c1', summarize([user('a')]), 1);
		expect(await deleteConversation(db, ALICE, 'c1')).toBe(true);
		expect(await deleteConversation(db, ALICE, 'c1')).toBe(false);
	});
});

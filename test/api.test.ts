import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestD1 } from './helpers/d1';

// The real getAgentByName needs a Workers runtime. Record which Durable
// Object name the route asks for, which is what the delete path must get right.
const purged: string[] = [];
vi.mock('agents', () => ({
	getAgentByName: async (_ns: unknown, name: string) => ({
		purge: async () => {
			purged.push(name);
		},
	}),
}));

const { handleApi, matchRoute, isApiRoute, DELETE_ALL_BATCH } = await import('../src/lib/api');
const { ensureSchema, upsertConversation, summarize, getConversation } = await import('../src/lib/conversations');

const alice = { userId: 'usr:alice@example.com', owner: 'a'.repeat(32), isService: false };
const bob = { userId: 'usr:bob@example.com', owner: 'b'.repeat(32), isService: false };
const BASE = 'https://cfworker.insertabot.io';

function call(principal: typeof alice, method: string, path: string, body?: unknown, env?: object) {
	const req = new Request(`${BASE}${path}`, {
		method,
		...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
	});
	return handleApi(req, (env ?? currentEnv) as never, principal, {});
}

let currentEnv: { DB: ReturnType<typeof createTestD1>; ChatAgent: object };

beforeEach(async () => {
	purged.length = 0;
	const DB = createTestD1();
	await ensureSchema(DB);
	currentEnv = { DB, ChatAgent: {} };
	const msgs = [
		{ role: 'user', parts: [{ type: 'text', text: 'hello' }] },
		{ role: 'assistant', parts: [{ type: 'text', text: 'hi there' }] },
	];
	await upsertConversation(DB, alice.owner, 'c1', summarize(msgs), 1000);
});

describe('routing', () => {
	it('recognises API paths', () => {
		expect(isApiRoute('/api/conversations')).toBe(true);
		expect(isApiRoute('/apix')).toBe(false);
		expect(matchRoute('/api/conversations')).toEqual({ kind: 'collection' });
		expect(matchRoute('/api/conversations/')).toEqual({ kind: 'collection' });
		expect(matchRoute('/api/conversations/abc')).toEqual({ kind: 'item', id: 'abc' });
		expect(matchRoute('/api/conversations/a/b')).toBeNull();
		expect(matchRoute('/api/conversations/%E0%A4%A')).toBeNull();
		expect(matchRoute('/api/other')).toBeNull();
	});
});

describe('handleApi', () => {
	it('lists the caller’s conversations', async () => {
		const res = await call(alice, 'GET', '/api/conversations');
		expect(res.status).toBe(200);
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		const body = await res.json();
		expect(body.nextCursor).toBeNull();
		expect(body.conversations).toHaveLength(1);
		expect(body.conversations[0]).toMatchObject({ id: 'c1', title: 'hello', preview: 'hi there', messageCount: 2 });
	});

	it('never shows one user another user’s list', async () => {
		const body = await (await call(bob, 'GET', '/api/conversations')).json();
		expect(body.conversations).toEqual([]);
		expect((await call(bob, 'GET', '/api/conversations/c1')).status).toBe(404);
	});

	it('renames', async () => {
		const res = await call(alice, 'PATCH', '/api/conversations/c1', { title: '  Greeting  ' });
		expect(res.status).toBe(200);
		expect((await res.json()).title).toBe('Greeting');
	});

	it.each([[{}], [{ title: '' }], [{ title: 3 }], ['not json']])('rejects a bad rename body %j', async (body) => {
		expect((await call(alice, 'PATCH', '/api/conversations/c1', body)).status).toBe(400);
	});

	it('404s a rename of someone else’s conversation', async () => {
		expect((await call(bob, 'PATCH', '/api/conversations/c1', { title: 'x' })).status).toBe(404);
	});

	it('deletes the caller’s own Durable Object, then the index row', async () => {
		const res = await call(alice, 'DELETE', '/api/conversations/c1');
		expect(res.status).toBe(204);
		expect(res.headers.get('X-Conversation-Indexed')).toBe('1');
		// Same owner-scoped name the WebSocket route derives (auth.scopedInstanceId).
		expect(purged).toEqual([`${alice.owner}~c1`]);
		expect(await getConversation(currentEnv.DB, alice.owner, 'c1')).toBeNull();
	});

	it('scopes a delete to the caller even for an id another user owns', async () => {
		const res = await call(bob, 'DELETE', '/api/conversations/c1');
		expect(res.status).toBe(204);
		expect(res.headers.get('X-Conversation-Indexed')).toBe('0');
		expect(purged).toEqual([`${bob.owner}~c1`]);
		expect(await getConversation(currentEnv.DB, alice.owner, 'c1')).not.toBeNull();
	});

	it('rejects ids that could escape the owner prefix', async () => {
		expect((await call(alice, 'DELETE', '/api/conversations/x~y')).status).toBe(400);
		expect(purged).toEqual([]);
	});

	it('405s unsupported methods', async () => {
		const res = await call(alice, 'POST', '/api/conversations');
		expect(res.status).toBe(405);
		expect(res.headers.get('Allow')).toBe('GET, DELETE');
		expect((await call(alice, 'PUT', '/api/conversations/c1')).status).toBe(405);
	});

	it('503s when the D1 binding is absent', async () => {
		const res = await call(alice, 'GET', '/api/conversations', undefined, { ChatAgent: {} });
		expect(res.status).toBe(503);
	});

	it('404s unknown API paths', async () => {
		expect((await call(alice, 'GET', '/api/nope')).status).toBe(404);
	});
});

describe('delete all my data', () => {
	const msgs = [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }];

	it('refuses without the explicit confirmation', async () => {
		const res = await call(alice, 'DELETE', '/api/conversations');
		expect(res.status).toBe(400);
		expect(purged).toEqual([]);
		expect(await getConversation(currentEnv.DB, alice.owner, 'c1')).not.toBeNull();
	});

	it("deletes every one of the caller's threads and nobody else's", async () => {
		await upsertConversation(currentEnv.DB, alice.owner, 'c2', summarize(msgs), 2000);
		await upsertConversation(currentEnv.DB, alice.owner, 'c3', summarize(msgs), 3000);
		await upsertConversation(currentEnv.DB, bob.owner, 'b1', summarize(msgs), 1500);

		const res = await call(alice, 'DELETE', '/api/conversations?confirm=all');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ deleted: 3, remaining: 0 });
		expect(purged.sort()).toEqual([`${alice.owner}~c1`, `${alice.owner}~c2`, `${alice.owner}~c3`]);
		expect(await getConversation(currentEnv.DB, alice.owner, 'c2')).toBeNull();
		expect(await getConversation(currentEnv.DB, bob.owner, 'b1')).not.toBeNull();
	});

	it('works in batches and reports what remains', async () => {
		for (let i = 0; i < DELETE_ALL_BATCH + 5; i++) {
			await upsertConversation(currentEnv.DB, alice.owner, `t${i}`, summarize(msgs), 2000 + i);
		}
		const first = await (await call(alice, 'DELETE', '/api/conversations?confirm=all')).json();
		expect(first).toEqual({ deleted: DELETE_ALL_BATCH, remaining: 6 });
		const second = await (await call(alice, 'DELETE', '/api/conversations?confirm=all')).json();
		expect(second).toEqual({ deleted: 6, remaining: 0 });
	});
});

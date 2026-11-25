import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestD1 } from './helpers/d1';
import {
	TOOLS_SCHEMA_STATEMENTS,
	adoptable,
	attachedToolOf,
	deleteAllTools,
	ensureToolsSchema,
	planSync,
	readRegistry,
	removeTool,
	saveTool,
	seal,
	toolsKey,
	unseal,
	type AttachedTool,
} from '../src/lib/tools';

const SECRET = 'test-secret-value-at-least-16';
const alice = 'a'.repeat(32);
const bob = 'b'.repeat(32);

const tavily = { name: 'Tavily', url: 'https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-1', token: null };
const github = { name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', token: 'ghp_1' };

const attached = (t: { name: string; url: string; token: string | null }, id = t.name.toLowerCase()): AttachedTool => ({
	id,
	...t,
});

describe('sealing', () => {
	it('round-trips and never stores plaintext', async () => {
		const key = (await toolsKey(SECRET))!;
		const sealed = await seal(key, 'https://x/?apiKey=secret');
		expect(sealed).not.toContain('secret');
		expect(await unseal(key, sealed)).toBe('https://x/?apiKey=secret');
		// Fresh IV each time.
		expect(await seal(key, 'same')).not.toBe(await seal(key, 'same'));
	});

	it('is off without a usable secret', () => {
		expect(toolsKey(undefined)).toBeNull();
		expect(toolsKey('')).toBeNull();
		expect(toolsKey('short')).toBeNull();
	});

	it('cannot be opened with a different secret', async () => {
		const sealed = await seal((await toolsKey(SECRET))!, 'x');
		await expect(unseal((await toolsKey('another-secret-entirely'))!, sealed)).rejects.toThrow();
	});
});

describe('schema', () => {
	const norm = (s: string) =>
		s
			.replace(/--.*$/gm, '')
			.replace(/\s+/g, ' ')
			.replace(/\s*([(),;])\s*/g, '$1')
			.trim()
			.toLowerCase();

	it('runtime DDL matches migrations/0002_account_tools.sql', () => {
		const migration = readFileSync(new URL('../migrations/0002_account_tools.sql', import.meta.url), 'utf8');
		expect(TOOLS_SCHEMA_STATEMENTS.map(norm)).toEqual(norm(migration).split(';').filter(Boolean));
	});
});

describe('registry (D1)', () => {
	let db: ReturnType<typeof createTestD1>;
	let key: CryptoKey;

	beforeEach(async () => {
		db = createTestD1();
		await ensureToolsSchema(db);
		key = (await toolsKey(SECRET))!;
	});

	it('saves sealed, reads back decrypted, scoped to the owner', async () => {
		await saveTool(db, key, alice, tavily, 1);
		await saveTool(db, key, alice, github, 2);
		await saveTool(db, key, bob, { ...github, token: 'ghp_bob' }, 3);

		const raw = db.raw.prepare('SELECT sealed FROM account_tools').all() as { sealed: string }[];
		for (const row of raw) {
			expect(row.sealed).not.toContain('tvly');
			expect(row.sealed).not.toContain('ghp_');
		}
		const reg = await readRegistry(db, key, alice);
		expect(reg.tools).toEqual([tavily, github]);
		expect((await readRegistry(db, key, bob)).tools).toEqual([{ ...github, token: 'ghp_bob' }]);
	});

	it('removal leaves a tombstone: gone from the list, still known', async () => {
		await saveTool(db, key, alice, tavily, 1);
		await removeTool(db, alice, 'Tavily', 2);
		const reg = await readRegistry(db, key, alice);
		expect(reg.tools).toEqual([]);
		expect(reg.known.has('Tavily')).toBe(true);
		const row = db.raw.prepare('SELECT sealed FROM account_tools').get() as { sealed: string };
		expect(row.sealed).toBe('');
	});

	it('adding again revives a removed tool', async () => {
		await removeTool(db, alice, 'Tavily', 1);
		await saveTool(db, key, alice, tavily, 2);
		expect((await readRegistry(db, key, alice)).tools).toEqual([tavily]);
	});

	it('skips rows sealed under another key instead of failing', async () => {
		await saveTool(db, (await toolsKey('a-rotated-old-secret-value'))!, alice, tavily, 1);
		await saveTool(db, key, alice, github, 2);
		expect((await readRegistry(db, key, alice)).tools).toEqual([github]);
	});

	it('delete-all removes every row for the owner only', async () => {
		await saveTool(db, key, alice, tavily, 1);
		await removeTool(db, alice, 'Old', 2);
		await saveTool(db, key, bob, github, 3);
		expect(await deleteAllTools(db, alice)).toBe(2);
		expect((await readRegistry(db, key, alice)).known.size).toBe(0);
		expect((await readRegistry(db, key, bob)).tools).toEqual([github]);
	});
});

describe('attachedToolOf', () => {
	it('recovers the Bearer token the SDK persisted', () => {
		const row = {
			id: 's1',
			name: 'GitHub',
			server_url: github.url,
			server_options: JSON.stringify({ transport: { headers: { Authorization: 'Bearer ghp_1' } } }),
		};
		expect(attachedToolOf(row)).toEqual({ id: 's1', ...github });
	});

	it('treats missing or unreadable options as keyless', () => {
		expect(attachedToolOf({ id: 'x', name: 'Exa', server_url: 'https://mcp.exa.ai/mcp', server_options: null }).token).toBeNull();
		expect(attachedToolOf({ id: 'x', name: 'Exa', server_url: 'https://mcp.exa.ai/mcp', server_options: '{bad' }).token).toBeNull();
	});
});

describe('planSync', () => {
	it('attaches what a new chat is missing', () => {
		expect(planSync([tavily, github], [])).toEqual({ remove: [], add: [tavily, github] });
	});

	it('leaves matching servers alone', () => {
		expect(planSync([tavily, github], [attached(tavily), attached(github)])).toEqual({ remove: [], add: [] });
	});

	it('drops servers the account no longer has', () => {
		const old = attached({ name: 'Firecrawl', url: 'https://mcp.firecrawl.dev/v2/mcp', token: null });
		expect(planSync([tavily], [attached(tavily), old])).toEqual({ remove: [old], add: [] });
	});

	it('replaces a server whose key or address changed', () => {
		const stale = attached({ ...github, token: 'ghp_old' });
		expect(planSync([github], [stale])).toEqual({ remove: [stale], add: [github] });
		const moved = attached({ ...tavily, url: 'https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-old' });
		expect(planSync([tavily], [moved])).toEqual({ remove: [moved], add: [tavily] });
	});

	it('drops duplicate copies of one tool', () => {
		const a = attached(tavily, 'a');
		const b = attached(tavily, 'b');
		expect(planSync([tavily], [a, b])).toEqual({ remove: [b], add: [] });
	});
});

describe('adoptable', () => {
	it("brings an old chat's tools into the account once", () => {
		expect(adoptable([attached(tavily), attached(github)], new Set())).toEqual([tavily, github]);
	});

	it('never revives a tool the user removed, or duplicates a known one', () => {
		expect(adoptable([attached(tavily), attached(github)], new Set(['Tavily']))).toEqual([github]);
		expect(adoptable([attached(tavily, 'a'), attached(tavily, 'b')], new Set())).toEqual([tavily]);
	});
});

/**
 * Account-level tools: the MCP servers a user attaches follow them into every
 * conversation, on every client, instead of belonging to the one thread they
 * were added in.
 *
 * Each conversation is its own Durable Object with its own MCP connections, so
 * the account's list lives here, in D1, keyed by the same owner hash as the
 * conversation index. Every ChatAgent reconciles its connections against it
 * (see ChatAgent.syncAccountTools): it adds what's missing and drops what the
 * account no longer has.
 *
 * Tool URLs and tokens are API keys more often than not (Tavily and Exa take
 * theirs in the query string), and D1 rows can be read from the Cloudflare
 * dashboard's console. So they are sealed with AES-GCM under a Worker secret,
 * TOOLS_ENCRYPTION_KEY, before they are written. Without that secret the
 * feature is off and tools stay per-conversation, as before.
 */

export interface AccountTool {
	name: string;
	url: string;
	/** Sent as `Authorization: Bearer <token>`; null for keyless or URL-keyed servers. */
	token: string | null;
}

/** An MCP server as attached to one conversation, read back from the Agents SDK. */
export interface AttachedTool extends AccountTool {
	id: string;
}

/**
 * Mirrored in migrations/0002_account_tools.sql (a test keeps them in step).
 *
 * `removed` rows are tombstones: a tool the user deleted. They keep the name
 * so that an old conversation still carrying that tool does not "adopt" it
 * back into the account the first time it syncs. Adding the tool again
 * clears the tombstone.
 */
export const TOOLS_SCHEMA_STATEMENTS: readonly string[] = Object.freeze([
	`CREATE TABLE IF NOT EXISTS account_tools (
	owner TEXT NOT NULL,
	name TEXT NOT NULL,
	sealed TEXT NOT NULL DEFAULT '',
	removed INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (owner, name)
)`,
]);

const schemaReady = new WeakMap<D1Database, Promise<void>>();

export function ensureToolsSchema(db: D1Database): Promise<void> {
	let ready = schemaReady.get(db);
	if (!ready) {
		ready = db
			.batch(TOOLS_SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)))
			.then(() => undefined)
			.catch((err: unknown) => {
				schemaReady.delete(db);
				throw err;
			});
		schemaReady.set(db, ready);
	}
	return ready;
}

// ── Sealing ──────────────────────────────────────────────────────────────────

const MIN_SECRET_LENGTH = 16;
const keyCache = new Map<string, Promise<CryptoKey>>();

/**
 * The AES-256-GCM key for TOOLS_ENCRYPTION_KEY, or null when the secret is
 * missing or too short to be one, which turns the feature off. Any string
 * works; a random 32-byte value (`openssl rand -base64 32`) is what to use.
 */
export function toolsKey(secret: string | undefined): Promise<CryptoKey> | null {
	if (!secret || secret.length < MIN_SECRET_LENGTH) return null;
	let key = keyCache.get(secret);
	if (!key) {
		key = crypto.subtle
			.digest('SHA-256', new TextEncoder().encode(secret))
			.then((raw) => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']));
		keyCache.set(secret, key);
	}
	return key;
}

export async function seal(key: CryptoKey, plaintext: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const cipher = new Uint8Array(
		await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)),
	);
	const out = new Uint8Array(iv.length + cipher.length);
	out.set(iv);
	out.set(cipher, iv.length);
	return toBase64(out);
}

export async function unseal(key: CryptoKey, sealed: string): Promise<string> {
	const bytes = fromBase64(sealed);
	const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
	return new TextDecoder().decode(plain);
}

function toBase64(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

function fromBase64(text: string): Uint8Array {
	const s = atob(text);
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
}

// ── Storage ──────────────────────────────────────────────────────────────────

export interface ToolRegistry {
	/** Live tools, in the order they were last saved. */
	tools: AccountTool[];
	/** Every name the account has ever had, live or removed; adoption skips these. */
	known: Set<string>;
}

export async function readRegistry(db: D1Database, key: CryptoKey, owner: string): Promise<ToolRegistry> {
	const { results } = await db
		.prepare(`SELECT name, sealed, removed FROM account_tools WHERE owner = ?1 ORDER BY updated_at ASC, name ASC`)
		.bind(owner)
		.all<{ name: string; sealed: string; removed: number }>();
	const tools: AccountTool[] = [];
	const known = new Set<string>();
	for (const row of results ?? []) {
		known.add(row.name);
		if (row.removed) continue;
		try {
			const { url, token } = JSON.parse(await unseal(key, row.sealed)) as { url: string; token: string | null };
			tools.push({ name: row.name, url, token: token ?? null });
		} catch {
			// Sealed under a different key (the secret was rotated): unusable,
			// so skip it rather than fail every chat. Re-adding replaces it.
			console.warn('[tools] skipping a tool that could not be decrypted');
		}
	}
	return { tools, known };
}

export async function saveTool(
	db: D1Database,
	key: CryptoKey,
	owner: string,
	tool: AccountTool,
	now = Date.now(),
): Promise<void> {
	const sealed = await seal(key, JSON.stringify({ url: tool.url, token: tool.token }));
	await db
		.prepare(
			`INSERT INTO account_tools (owner, name, sealed, removed, updated_at) VALUES (?1, ?2, ?3, 0, ?4)
			 ON CONFLICT (owner, name) DO UPDATE SET sealed = excluded.sealed, removed = 0, updated_at = excluded.updated_at`,
		)
		.bind(owner, tool.name, sealed, now)
		.run();
}

/** Tombstone a tool: its URL and token are wiped, its name is kept (see schema). */
export async function removeTool(db: D1Database, owner: string, name: string, now = Date.now()): Promise<void> {
	await db
		.prepare(
			`INSERT INTO account_tools (owner, name, sealed, removed, updated_at) VALUES (?1, ?2, '', 1, ?3)
			 ON CONFLICT (owner, name) DO UPDATE SET sealed = '', removed = 1, updated_at = excluded.updated_at`,
		)
		.bind(owner, name, now)
		.run();
}

/** Part of "delete all my data": every row, tombstones included. */
export async function deleteAllTools(db: D1Database, owner: string): Promise<number> {
	const result = await db.prepare(`DELETE FROM account_tools WHERE owner = ?1`).bind(owner).run();
	return result.meta.changes;
}

// ── Reconciliation ───────────────────────────────────────────────────────────

/** Minimal shape of the Agents SDK's MCPServerRow that this module reads. */
export interface ServerRowLike {
	id: string;
	name: string;
	server_url: string;
	server_options: string | null;
}

/**
 * Read a conversation's attached server back as a tool, recovering the Bearer
 * token the SDK persisted in its transport headers.
 */
export function attachedToolOf(row: ServerRowLike): AttachedTool {
	let token: string | null = null;
	try {
		const options = row.server_options ? JSON.parse(row.server_options) : null;
		const headers = options?.transport?.headers;
		const auth = headers && typeof headers === 'object' ? (headers.Authorization ?? headers.authorization) : null;
		if (typeof auth === 'string' && auth.startsWith('Bearer ')) token = auth.slice('Bearer '.length) || null;
	} catch {
		// Unreadable options: treat as keyless; reconciliation will replace it if needed.
	}
	return { id: row.id, name: row.name, url: row.server_url, token };
}

export function sameUrl(a: string, b: string): boolean {
	try {
		return new URL(a).href === new URL(b).href;
	} catch {
		return a === b;
	}
}

/**
 * What a conversation must change to match the account: servers to drop (no
 * longer in the account, or attached with a different URL or key) and tools
 * to attach. A changed tool appears in both lists, so it is replaced.
 */
export function planSync(
	account: readonly AccountTool[],
	attached: readonly AttachedTool[],
): { remove: AttachedTool[]; add: AccountTool[] } {
	const wanted = new Map(account.map((t) => [t.name, t]));
	const remove: AttachedTool[] = [];
	const kept = new Set<string>();
	for (const server of attached) {
		const want = wanted.get(server.name);
		if (want && sameUrl(want.url, server.url) && (want.token ?? null) === (server.token ?? null) && !kept.has(server.name)) {
			kept.add(server.name);
		} else {
			remove.push(server);
		}
	}
	const add = account.filter((t) => !kept.has(t.name));
	return { remove, add };
}

/**
 * Tools an existing conversation brings with it the first time it syncs:
 * anything attached there whose name the account has never seen. A name the
 * user removed is "seen", so a stale copy in an old thread can't revive it.
 */
export function adoptable(attached: readonly AttachedTool[], known: ReadonlySet<string>): AccountTool[] {
	const seen = new Set<string>();
	const out: AccountTool[] = [];
	for (const s of attached) {
		if (known.has(s.name) || seen.has(s.name)) continue;
		seen.add(s.name);
		out.push({ name: s.name, url: s.url, token: s.token });
	}
	return out;
}

/**
 * The cross-device conversation index, stored in D1.
 *
 * Message bodies stay in each conversation's ChatAgent Durable Object — the
 * Agents SDK owns that storage, and it is what streams, resumes and replays
 * history to the model. Durable Objects cannot be enumerated, however, so on
 * their own they only let a client reopen the single conversation id it
 * happens to remember. This module maintains one D1 row per conversation so
 * every client signed in as the same identity (web and Android alike) can
 * list, resume, rename and delete the same set of threads.
 *
 * Every query is keyed on `owner`, the digest derived from the VERIFIED Access
 * identity in src/lib/auth.ts. Nothing here accepts an owner from a client.
 */

/** Minimal structural view of an AI SDK `UIMessage` — all this module reads. */
export interface MessageLike {
	role: string;
	parts?: ReadonlyArray<{ type: string; text?: string }>;
	content?: unknown;
}

export interface ConversationSummary {
	id: string;
	title: string;
	preview: string;
	messageCount: number;
	/** Epoch milliseconds. */
	createdAt: number;
	/** Epoch milliseconds. */
	updatedAt: number;
}

export interface ConversationPage {
	conversations: ConversationSummary[];
	/** Opaque cursor for the next page, or null when this is the last one. */
	nextCursor: string | null;
}

interface ConversationRow {
	id: string;
	title: string;
	preview: string;
	message_count: number;
	created_at: number;
	updated_at: number;
}

export const TITLE_MAX = 80;
export const PREVIEW_MAX = 140;
export const DEFAULT_PAGE_SIZE = 30;
export const MAX_PAGE_SIZE = 100;
export const UNTITLED = 'New conversation';

/**
 * Conversation ids name a Durable Object and travel in URL paths. Both clients
 * generate UUIDs; this is looser than that so a future client is not locked
 * out, but excludes `~` (the owner separator in auth.ts) and anything that
 * would need escaping.
 */
const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidConversationId(id: unknown): id is string {
	return typeof id === 'string' && CONVERSATION_ID_RE.test(id);
}

/** Collapse whitespace and cut to `max` characters, ending in an ellipsis. */
export function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	if (flat.length <= max) return flat;
	return `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** The text a message displays, mirroring extractText() in public/index.js. */
export function messageText(message: MessageLike): string {
	if (Array.isArray(message.parts)) {
		const text = message.parts
			.filter((p) => p.type === 'text' && typeof p.text === 'string')
			.map((p) => p.text)
			.join('');
		if (text.trim()) return text;
	}
	return typeof message.content === 'string' ? message.content : '';
}

function hasAttachment(message: MessageLike): boolean {
	return Array.isArray(message.parts) && message.parts.some((p) => p.type === 'file');
}

/** Text for a list row: the message text, or a marker for an image-only turn. */
function displayLine(message: MessageLike): string {
	const text = messageText(message).trim();
	if (text) return text;
	return hasAttachment(message) ? '[Image]' : '';
}

export interface DerivedSummary {
	title: string;
	preview: string;
	messageCount: number;
}

/**
 * Derive a list entry from a conversation's messages.
 *
 * The title is the first user turn — free, deterministic, and what most chat
 * apps show. Asking the model for one would cost an inference call per thread
 * and could leak a placeholder token into the list. The preview is the latest
 * turn with anything to show, so the list reflects where the thread left off.
 */
export function summarize(messages: ReadonlyArray<MessageLike>): DerivedSummary {
	const visible = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
	const firstUser = visible.find((m) => m.role === 'user' && displayLine(m));
	let preview = '';
	for (let i = visible.length - 1; i >= 0; i--) {
		const line = displayLine(visible[i]);
		if (line) {
			preview = line;
			break;
		}
	}
	return {
		title: firstUser ? clip(displayLine(firstUser), TITLE_MAX) : '',
		preview: clip(preview, PREVIEW_MAX),
		messageCount: visible.length,
	};
}

/** A user-supplied title: trimmed, flattened, bounded. Empty means "invalid". */
export function normalizeTitle(raw: unknown): string {
	return typeof raw === 'string' ? clip(raw, TITLE_MAX) : '';
}

/**
 * DDL mirrored from migrations/0001_conversations.sql (a test keeps the two in
 * step). The migration is the canonical record; this exists so a deploy whose
 * operator skipped `wrangler d1 migrations apply` still works rather than
 * failing every index write with "no such table".
 */
export const SCHEMA_STATEMENTS: readonly string[] = Object.freeze([
	`CREATE TABLE IF NOT EXISTS conversations (
	owner TEXT NOT NULL,
	id TEXT NOT NULL,
	title TEXT NOT NULL DEFAULT '',
	title_locked INTEGER NOT NULL DEFAULT 0,
	preview TEXT NOT NULL DEFAULT '',
	message_count INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (owner, id)
)`,
	`CREATE INDEX IF NOT EXISTS conversations_owner_updated ON conversations (owner, updated_at DESC, id DESC)`,
]);

/** Once per isolate per binding; a failure is retried on the next call. */
const schemaReady = new WeakMap<D1Database, Promise<void>>();

export function ensureSchema(db: D1Database): Promise<void> {
	let ready = schemaReady.get(db);
	if (!ready) {
		ready = db
			.batch(SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)))
			.then(() => undefined)
			.catch((err: unknown) => {
				schemaReady.delete(db);
				throw err;
			});
		schemaReady.set(db, ready);
	}
	return ready;
}

function toSummary(row: ConversationRow): ConversationSummary {
	return {
		id: row.id,
		title: row.title || UNTITLED,
		preview: row.preview,
		messageCount: row.message_count,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/**
 * Record a conversation's current state.
 *
 * A user-set title (`title_locked`) is never overwritten, and an empty derived
 * title never replaces a real one — a conversation whose messages were cleared
 * keeps its name in the list rather than reverting to "New conversation".
 */
export async function upsertConversation(
	db: D1Database,
	owner: string,
	id: string,
	summary: DerivedSummary,
	now: number = Date.now(),
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO conversations (owner, id, title, preview, message_count, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
			 ON CONFLICT (owner, id) DO UPDATE SET
				title = CASE
					WHEN conversations.title_locked = 1 OR excluded.title = '' THEN conversations.title
					ELSE excluded.title
				END,
				preview = excluded.preview,
				message_count = excluded.message_count,
				updated_at = CASE
					-- Re-indexing an unchanged thread (a reconnect, a backfill) must
					-- not bump it to the top of everyone's list.
					WHEN conversations.message_count = excluded.message_count
						AND conversations.preview = excluded.preview
					THEN conversations.updated_at
					ELSE excluded.updated_at
				END`,
		)
		.bind(owner, id, summary.title, summary.preview, summary.messageCount, now)
		.run();
}

/**
 * Cursors encode the (updated_at, id) of the last row returned. Keyset paging
 * stays correct while new turns reorder the list, where an OFFSET would skip or
 * repeat rows.
 */
export function encodeCursor(row: { updatedAt: number; id: string }): string {
	return btoa(`${row.updatedAt}:${row.id}`).replace(/=+$/, '');
}

export function decodeCursor(cursor: string | null | undefined): { updatedAt: number; id: string } | null {
	if (!cursor) return null;
	let decoded: string;
	try {
		decoded = atob(cursor);
	} catch {
		return null;
	}
	const sep = decoded.indexOf(':');
	if (sep <= 0) return null;
	const updatedAt = Number(decoded.slice(0, sep));
	const id = decoded.slice(sep + 1);
	if (!Number.isSafeInteger(updatedAt) || !isValidConversationId(id)) return null;
	return { updatedAt, id };
}

export function clampLimit(raw: string | number | null | undefined): number {
	const n = typeof raw === 'number' ? raw : Number.parseInt(raw ?? '', 10);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
	return Math.min(Math.floor(n), MAX_PAGE_SIZE);
}

/** One owner's conversations, most recently active first. */
export async function listConversations(
	db: D1Database,
	owner: string,
	options: { limit?: number; cursor?: string | null } = {},
): Promise<ConversationPage> {
	const limit = clampLimit(options.limit);
	const after = decodeCursor(options.cursor);
	// Fetch one extra row to learn whether another page exists.
	const stmt = after
		? db
				.prepare(
					`SELECT id, title, preview, message_count, created_at, updated_at
					 FROM conversations
					 WHERE owner = ?1 AND (updated_at < ?2 OR (updated_at = ?2 AND id < ?3))
					 ORDER BY updated_at DESC, id DESC
					 LIMIT ?4`,
				)
				.bind(owner, after.updatedAt, after.id, limit + 1)
		: db
				.prepare(
					`SELECT id, title, preview, message_count, created_at, updated_at
					 FROM conversations
					 WHERE owner = ?1
					 ORDER BY updated_at DESC, id DESC
					 LIMIT ?2`,
				)
				.bind(owner, limit + 1);

	const { results } = await stmt.all<ConversationRow>();
	const rows = results ?? [];
	const page = rows.slice(0, limit).map(toSummary);
	const last = page[page.length - 1];
	return {
		conversations: page,
		nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
	};
}

export async function getConversation(
	db: D1Database,
	owner: string,
	id: string,
): Promise<ConversationSummary | null> {
	const row = await db
		.prepare(
			`SELECT id, title, preview, message_count, created_at, updated_at
			 FROM conversations WHERE owner = ?1 AND id = ?2`,
		)
		.bind(owner, id)
		.first<ConversationRow>();
	return row ? toSummary(row) : null;
}

/** Rename a conversation and pin the title against auto-titling. */
export async function renameConversation(
	db: D1Database,
	owner: string,
	id: string,
	title: string,
): Promise<ConversationSummary | null> {
	const result = await db
		.prepare(`UPDATE conversations SET title = ?3, title_locked = 1 WHERE owner = ?1 AND id = ?2`)
		.bind(owner, id, title)
		.run();
	if (!result.meta.changes) return null;
	return getConversation(db, owner, id);
}

/** Returns true when a row was removed. */
export async function deleteConversation(db: D1Database, owner: string, id: string): Promise<boolean> {
	const result = await db
		.prepare(`DELETE FROM conversations WHERE owner = ?1 AND id = ?2`)
		.bind(owner, id)
		.run();
	return result.meta.changes > 0;
}

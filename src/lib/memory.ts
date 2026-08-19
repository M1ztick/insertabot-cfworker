/**
 * Durable Object SQLite memory store.
 *
 * Each ChatAgent instance gets its own isolated SQLite database, so memories are
 * scoped to a single conversation (`instanceId`). This is perfect for session
 * context, tool result caching, and per-thread notes without adding D1.
 */

export interface Memory {
	id: string;
	category: string;
	content: string;
	source?: string;
	createdAt: number;
}

/** Create the memory table and useful indexes if they don't exist. */
export function ensureMemorySchema(sql: SqlStorage): void {
	sql.exec(`
		CREATE TABLE IF NOT EXISTS memory (
			id TEXT PRIMARY KEY,
			category TEXT NOT NULL,
			content TEXT NOT NULL,
			source TEXT,
			created_at INTEGER NOT NULL
		);
	`);
	sql.exec(`CREATE INDEX IF NOT EXISTS idx_memory_category ON memory(category);`);
	sql.exec(`CREATE INDEX IF NOT EXISTS idx_memory_created ON memory(created_at);`);
}

/** Insert a new memory. */
export function remember(
	sql: SqlStorage,
	input: { category: string; content: string; source?: string },
): Memory {
	ensureMemorySchema(sql);
	const id = crypto.randomUUID();
	const createdAt = Date.now();
	sql.exec(
		`INSERT INTO memory (id, category, content, source, created_at) VALUES (?, ?, ?, ?, ?)`,
		id,
		input.category,
		input.content,
		input.source ?? null,
		createdAt,
	);
	return { id, ...input, createdAt };
}

/** List memories, optionally filtered by category. */
export function listMemories(sql: SqlStorage, category?: string, limit = 100): Memory[] {
	ensureMemorySchema(sql);
	const cursor = category
		? sql.exec(
				`SELECT id, category, content, source, created_at FROM memory WHERE category = ? ORDER BY created_at DESC LIMIT ?`,
				category,
				limit,
			)
		: sql.exec(
				`SELECT id, category, content, source, created_at FROM memory ORDER BY created_at DESC LIMIT ?`,
				limit,
			);
	return [...cursor].map(rowFromDb);
}

/** Full-text-ish search over memory content. */
export function recall(sql: SqlStorage, query: string, limit = 10): Memory[] {
	ensureMemorySchema(sql);
	const safeQuery = query.trim();
	if (!safeQuery) return [];

	// Escape LIKE wildcards so the user's tokens are treated literally.
	const like = `%${safeQuery.replace(/[%_]/g, '\\$&')}%`;
	const cursor = sql.exec(
		`SELECT id, category, content, source, created_at FROM memory
		 WHERE content LIKE ? ESCAPE '\\'
		 ORDER BY created_at DESC LIMIT ?`,
		like,
		Math.min(limit, 100),
	);
	return [...cursor].map(rowFromDb);
}

/** Delete a memory by id. Returns true if a row was removed. */
export function forget(sql: SqlStorage, id: string): boolean {
	ensureMemorySchema(sql);
	const cursor = sql.exec(`DELETE FROM memory WHERE id = ?`, id);
	return cursor.rowsRead > 0 || cursor.rowsWritten > 0;
}

/** Delete old memories or cap total count. Useful for DO storage hygiene. */
export function pruneMemories(
	sql: SqlStorage,
	{ maxAgeMs, maxCount }: { maxAgeMs?: number; maxCount?: number },
): number {
	ensureMemorySchema(sql);
	let removed = 0;
	if (maxAgeMs !== undefined) {
		const cutoff = Date.now() - maxAgeMs;
		removed += [...sql.exec(`DELETE FROM memory WHERE created_at < ?`, cutoff)].length;
	}
	if (maxCount !== undefined && maxCount > 0) {
		removed += [
			...sql.exec(
				`DELETE FROM memory WHERE id NOT IN (
					SELECT id FROM memory ORDER BY created_at DESC LIMIT ?
				)`,
				maxCount,
			),
		].length;
	}
	return removed;
}

function rowFromDb(row: unknown): Memory {
	const r = row as Record<string, unknown>;
	return {
		id: String(r.id),
		category: String(r.category),
		content: String(r.content),
		source: r.source == null ? undefined : String(r.source),
		createdAt: Number(r.created_at),
	};
}

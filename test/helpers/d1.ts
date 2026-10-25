/**
 * A minimal D1Database over node:sqlite, so the conversation index's real SQL
 * (upsert, keyset paging, owner scoping) runs in unit tests instead of being
 * mocked away. Implements only what src/lib/conversations.ts uses.
 */
import { DatabaseSync } from 'node:sqlite';

type Bindable = string | number | null;

class Statement {
	constructor(
		private readonly db: DatabaseSync,
		private readonly sql: string,
		private readonly params: Bindable[] = [],
	) {}

	bind(...params: Bindable[]): Statement {
		return new Statement(this.db, this.sql, params);
	}

	/** D1 numbers `?1..?N`; node:sqlite binds those positionally too. */
	async run() {
		const info = this.db.prepare(this.sql).run(...this.params);
		return { success: true, meta: { changes: Number(info.changes) } };
	}

	async all<T>() {
		const rows = this.db.prepare(this.sql).all(...this.params) as T[];
		return { success: true, results: rows.map((r) => ({ ...r })) as T[], meta: {} };
	}

	async first<T>(): Promise<T | null> {
		const row = this.db.prepare(this.sql).get(...this.params);
		return row ? ({ ...row } as T) : null;
	}
}

export function createTestD1(): D1Database & { raw: DatabaseSync } {
	const raw = new DatabaseSync(':memory:');
	const db = {
		raw,
		prepare: (sql: string) => new Statement(raw, sql),
		batch: async (stmts: Statement[]) => Promise.all(stmts.map((s) => s.run())),
		exec: async (sql: string) => {
			raw.exec(sql);
			return { count: 0, duration: 0 };
		},
	};
	return db as unknown as D1Database & { raw: DatabaseSync };
}

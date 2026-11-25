-- Account-level tools (see src/lib/tools.ts). Mirrored by TOOLS_SCHEMA_STATEMENTS,
-- which a test keeps in step with this file.
CREATE TABLE IF NOT EXISTS account_tools (
	owner TEXT NOT NULL,
	name TEXT NOT NULL,
	sealed TEXT NOT NULL DEFAULT '',
	removed INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (owner, name)
);

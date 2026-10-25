-- Conversation index: one row per conversation, shared by every client.
--
-- Message bodies are NOT stored here. Each conversation's full history lives in
-- its own ChatAgent Durable Object (the Agents SDK owns that table, and it is
-- what streams, resumes and replays to the model). Durable Objects cannot be
-- enumerated, though, so without this index a client can only ever reopen the
-- one conversation id it happens to remember locally. This table is what lets
-- the web client and the Android app list, resume, rename and delete the same
-- set of conversations.
--
-- `owner` is the 32-hex digest derived from the verified Cloudflare Access
-- identity (src/lib/auth.ts). It is never taken from the client.
CREATE TABLE IF NOT EXISTS conversations (
	owner         TEXT    NOT NULL,
	id            TEXT    NOT NULL,
	title         TEXT    NOT NULL DEFAULT '',
	-- 1 once a user has renamed the thread; auto-titling stops touching it.
	title_locked  INTEGER NOT NULL DEFAULT 0,
	preview       TEXT    NOT NULL DEFAULT '',
	message_count INTEGER NOT NULL DEFAULT 0,
	created_at    INTEGER NOT NULL,
	updated_at    INTEGER NOT NULL,
	PRIMARY KEY (owner, id)
);

-- The list endpoint pages a single owner's threads newest-first.
CREATE INDEX IF NOT EXISTS conversations_owner_updated
	ON conversations (owner, updated_at DESC, id DESC);

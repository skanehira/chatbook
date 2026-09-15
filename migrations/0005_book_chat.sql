-- Let a conversation hang off the book itself rather than only off a highlight:
-- selection_id becomes nullable, and pdf_id says which book every message
-- belongs to. SQLite cannot drop a NOT NULL, so the table is rebuilt; the
-- migration runner runs a file as one transaction (wrangler's executeSql
-- against a remote database, a batch locally and under test), so no reader
-- ever sees it half way through.
--
-- PRAGMA foreign_keys=off would do nothing here — it is a no-op inside a
-- transaction, and defer_foreign_keys is the one that works there. Nothing
-- violates a foreign key either way: every row copied has its parent, and no
-- table references chat_messages, so the implicit DELETE behind DROP TABLE has
-- nothing to cascade into.
--
-- Unlike the column additions before it, this migration is not harmless to the
-- code already deployed: an older Worker writes no pdf_id and would fall foul
-- of NOT NULL. The window is this migration to the next `wrangler deploy`, and
-- the only cost inside it is an answer that cannot be saved.
PRAGMA defer_foreign_keys = true;

CREATE TABLE chat_messages_new (
  id                  TEXT PRIMARY KEY,
  selection_id        TEXT REFERENCES selections(id) ON DELETE CASCADE,
  pdf_id              TEXT NOT NULL REFERENCES pdfs(id) ON DELETE CASCADE,
  role                TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content             TEXT NOT NULL,
  citations           TEXT,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  cached_input_tokens INTEGER,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every row that exists is hanging off a highlight, that being all this table
-- held before.
INSERT INTO chat_messages_new
  (id, selection_id, pdf_id, role, content, citations,
   input_tokens, output_tokens, cached_input_tokens, created_at)
SELECT m.id, m.selection_id, s.pdf_id, m.role, m.content, m.citations,
       m.input_tokens, m.output_tokens, m.cached_input_tokens, m.created_at
  FROM chat_messages m
  JOIN selections s ON s.id = m.selection_id;

DROP TABLE chat_messages;
ALTER TABLE chat_messages_new RENAME TO chat_messages;

CREATE INDEX idx_chat_messages_selection_id ON chat_messages(selection_id);
CREATE INDEX idx_chat_messages_selection_time ON chat_messages(selection_id, created_at);
-- Partial: only the book's own conversation is looked up this way, so it holds
-- a row per message of that conversation and none of the highlight chats.
CREATE INDEX idx_chat_messages_pdf_time ON chat_messages(pdf_id, created_at)
  WHERE selection_id IS NULL;

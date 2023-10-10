CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  addr        TEXT NOT NULL,
  sender      TEXT NOT NULL DEFAULT '',
  sender_name TEXT NOT NULL DEFAULT '',
  subject     TEXT NOT NULL DEFAULT '',
  intro       TEXT NOT NULL DEFAULT '',
  text        TEXT NOT NULL DEFAULT '',
  html        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_addr ON messages (addr, created_at DESC);

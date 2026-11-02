-- a shell: one project's memory, owned by a wallet or by whoever holds its key
CREATE TABLE IF NOT EXISTS shells (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner TEXT,                             -- wallet, null until claimed
  public INTEGER NOT NULL DEFAULT 0,      -- 1: anyone may read it
  seq INTEGER NOT NULL DEFAULT 0,         -- last entry written
  head TEXT NOT NULL,                     -- hash of that entry
  anchored INTEGER NOT NULL DEFAULT 0,    -- last entry covered by a confirmed anchor
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS shells_owner ON shells (owner);

CREATE TABLE IF NOT EXISTS keys (
  hash TEXT PRIMARY KEY,                  -- sha256 of an hk_ key (the key itself is never stored)
  prefix TEXT NOT NULL,                   -- first characters, to tell keys apart
  shell TEXT NOT NULL,
  label TEXT NOT NULL,
  created INTEGER NOT NULL,
  last_used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS keys_shell ON keys (shell);

-- the log: append-only. Forgetting clears text and leaves the hashes, so the chain still checks out
CREATE TABLE IF NOT EXISTS entries (
  shell TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,                     -- fact | constraint | lesson | decision | plan | handoff | forget
  text TEXT,                              -- null once forgotten
  agent TEXT NOT NULL,
  supersedes INTEGER,                     -- entry this one replaces
  superseded_by INTEGER,                  -- set when a later entry replaces this one
  created INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  prev TEXT NOT NULL,
  hash TEXT NOT NULL,
  indexed INTEGER NOT NULL DEFAULT 0,     -- 1 once it has a vector
  PRIMARY KEY (shell, seq)
);
CREATE INDEX IF NOT EXISTS entries_live ON entries (shell, superseded_by, kind, seq);
CREATE INDEX IF NOT EXISTS entries_unindexed ON entries (indexed, created);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5 (shell UNINDEXED, seq UNINDEXED, text);

-- one Memo transaction: the root of all the chain heads that moved since the last one
CREATE TABLE IF NOT EXISTS anchors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root TEXT NOT NULL,
  signature TEXT NOT NULL,
  status TEXT NOT NULL,                   -- pending | confirmed | failed
  entries INTEGER NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS anchors_status ON anchors (status, id);

CREATE TABLE IF NOT EXISTS anchor_leaves (
  anchor INTEGER NOT NULL,
  shell TEXT NOT NULL,
  seq INTEGER NOT NULL,
  head TEXT NOT NULL,
  PRIMARY KEY (anchor, shell)
);
CREATE INDEX IF NOT EXISTS anchor_leaves_shell ON anchor_leaves (shell, seq);

CREATE TABLE IF NOT EXISTS wallets (
  addr TEXT PRIMARY KEY,
  holds REAL NOT NULL DEFAULT 0,          -- $HERMIT held, cached
  hold_checked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tokens (
  hash TEXT PRIMARY KEY,                  -- sha256 of a sess_ token (the token itself is never stored)
  wallet TEXT NOT NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
);

-- daily counters: who is "s:<shell>", "ip:<address>"
CREATE TABLE IF NOT EXISTS usage (
  who TEXT NOT NULL,
  kind TEXT NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (who, kind, day)
);

-- One row per flow (latest version), every version kept in flow_versions.
CREATE TABLE IF NOT EXISTS flows (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,            -- SHA-256 of the publisher's contributor token
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  sites TEXT NOT NULL,            -- JSON array
  tags TEXT NOT NULL DEFAULT '[]',
  inputs TEXT NOT NULL,           -- "query:string, limit?:number"
  acts INTEGER NOT NULL DEFAULT 0,
  uses_ai INTEGER NOT NULL DEFAULT 0,
  calls TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL,
  def TEXT NOT NULL,              -- the flow JSON
  author TEXT,
  search TEXT NOT NULL,           -- lower-case text searched by ?q=
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  runs INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS flow_versions (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  def TEXT NOT NULL,
  created TEXT NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE TABLE IF NOT EXISTS rate (
  k TEXT NOT NULL,
  win TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (k, win)
);
CREATE INDEX IF NOT EXISTS flows_updated ON flows (hidden, updated);

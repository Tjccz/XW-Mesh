import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data')

fs.mkdirSync(DATA_DIR, { recursive: true })

export const db = new DatabaseSync(path.join(DATA_DIR, 'xiangwang.db'))

db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS networks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  secret      TEXT NOT NULL,
  cidr        TEXT NOT NULL DEFAULT '10.144.144.0/24',
  peers       TEXT NOT NULL DEFAULT 'tcp://public.easytier.cn:11010',
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  network_id     INTEGER NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  virtual_ip     TEXT NOT NULL,
  token          TEXT NOT NULL UNIQUE,
  status         TEXT NOT NULL DEFAULT 'pending',
  last_seen      TEXT,
  core_version   TEXT,
  peer_count     INTEGER NOT NULL DEFAULT 0,
  platform       TEXT,
  reported_ip    TEXT,
  config_version INTEGER NOT NULL DEFAULT 1,
  note           TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS node_configs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_by  TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  detail      TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nodes_network ON nodes(network_id);
CREATE INDEX IF NOT EXISTS idx_configs_node ON node_configs(node_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
`)

export const now = () => new Date().toISOString()
export const orNull = (v) => (v === undefined ? null : v)

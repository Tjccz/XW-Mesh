import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data')

fs.mkdirSync(DATA_DIR, { recursive: true })

const rawDb = new DatabaseSync(path.join(DATA_DIR, 'xiangwang.db'))

// ---------------------------------------------------------------------------
// 绑定参数兜底：把 undefined 归一为 null
//
// node:sqlite 不接受 undefined 作为绑定值，会直接抛
//   TypeError: Provided value cannot be bound to SQLite parameter N
// 而「没有这个值」在 SQL 里的正确表达是 NULL。
//
// 少了这层兜底，「请求漏传某个字段」会穿过路由的参数校验，
// 变成 500「服务器内部错误」—— 排查时看不出是哪个字段缺了，
// 只有翻服务端日志才能看到那次 TypeError。
//
// 归一为 null 后，查询正常返回空结果，交给路由里既有的
// `if (!row) return res.status(400)...` 给出可读提示。
//
// 边界：INSERT 时若该列是 NOT NULL，仍会抛约束错误（同样是 500，不更糟）；
//       命名为参数/数组形式本仓库未使用，故只处理位置参数。
// ---------------------------------------------------------------------------
const bindNull = (args) => args.map((v) => (v === undefined ? null : v))

const wrapStatement = (stmt) =>
  new Proxy(stmt, {
    get(target, prop) {
      const value = Reflect.get(target, prop)
      if (typeof value !== 'function') return value
      if (prop === 'run' || prop === 'get' || prop === 'all' || prop === 'iterate') {
        return (...args) => value.apply(target, bindNull(args))
      }
      return value.bind(target)
    },
  })

export const db = new Proxy(rawDb, {
  get(target, prop) {
    if (prop === 'prepare') {
      return (sql) => wrapStatement(target.prepare(sql))
    }
    const value = Reflect.get(target, prop)
    return typeof value === 'function' ? value.bind(target) : value
  },
})

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

CREATE TABLE IF NOT EXISTS workspaces (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  plan        TEXT NOT NULL DEFAULT 'free',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS access_keys (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  network_id  INTEGER NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  key         TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'active',
  expires_at  TEXT,
  max_nodes   INTEGER NOT NULL DEFAULT 0,
  used_count  INTEGER NOT NULL DEFAULT 0,
  note        TEXT NOT NULL DEFAULT '',
  created_by  TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subnet_routes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  network_id  INTEGER NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  node_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  cidr        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS acl_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  network_id  INTEGER NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  action      TEXT NOT NULL DEFAULT 'allow',
  protocol    TEXT NOT NULL DEFAULT 'tcp',
  chain_type  TEXT NOT NULL DEFAULT 'forward',
  src_cidr    TEXT NOT NULL DEFAULT '0.0.0.0/0',
  dst_cidr    TEXT NOT NULL DEFAULT '0.0.0.0/0',
  ports       TEXT NOT NULL DEFAULT '',
  priority    INTEGER NOT NULL DEFAULT 100,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS traffic_samples (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  rx_bytes    INTEGER NOT NULL DEFAULT 0,
  tx_bytes    INTEGER NOT NULL DEFAULT 0,
  peer_count  INTEGER NOT NULL DEFAULT 0,
  sampled_at  TEXT NOT NULL
);

-- 通知渠道：webhook / wecom（企业微信机器人）/ dingtalk（钉钉机器人）/ email
CREATE TABLE IF NOT EXISTS alert_channels (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'webhook',
  config_json  TEXT NOT NULL DEFAULT '{}',
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_status  TEXT NOT NULL DEFAULT '',
  last_error   TEXT NOT NULL DEFAULT '',
  last_test_at TEXT,
  created_at   TEXT NOT NULL
);

-- 告警规则：事件类型 + 阈值 + 作用范围 + 通知渠道
CREATE TABLE IF NOT EXISTS alert_rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id    INTEGER NOT NULL,
  name            TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  threshold       INTEGER NOT NULL DEFAULT 10,
  network_id      INTEGER,
  level           TEXT NOT NULL DEFAULT 'warning',
  channel_ids     TEXT NOT NULL DEFAULT '',
  silence_minutes INTEGER NOT NULL DEFAULT 30,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL
);

-- 告警事件：firing（触发中）/ resolved（已恢复）
CREATE TABLE IF NOT EXISTS alert_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  rule_id      INTEGER,
  rule_name    TEXT NOT NULL DEFAULT '',
  event_type   TEXT NOT NULL,
  level        TEXT NOT NULL DEFAULT 'warning',
  target_type  TEXT NOT NULL DEFAULT '',
  target_id    TEXT NOT NULL DEFAULT '',
  target_name  TEXT NOT NULL DEFAULT '',
  message      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'firing',
  deliveries   TEXT NOT NULL DEFAULT '[]',
  fired_at     TEXT NOT NULL,
  resolved_at  TEXT,
  ack_at       TEXT,
  ack_by       TEXT,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nodes_network ON nodes(network_id);
CREATE INDEX IF NOT EXISTS idx_configs_node ON node_configs(node_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_traffic_node_time ON traffic_samples(node_id, sampled_at DESC);
CREATE INDEX IF NOT EXISTS idx_keys_network ON access_keys(network_id);
CREATE INDEX IF NOT EXISTS idx_acl_network ON acl_rules(network_id, priority);
CREATE INDEX IF NOT EXISTS idx_subnet_network ON subnet_routes(network_id);
`)

/** 为老库补列，保证已部署实例可平滑升级 */
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

ensureColumn('users', 'workspace_id', 'INTEGER')
ensureColumn('users', 'display_name', "TEXT NOT NULL DEFAULT ''")
ensureColumn('networks', 'workspace_id', 'INTEGER')
ensureColumn('networks', 'template', "TEXT NOT NULL DEFAULT 'custom'")
ensureColumn('networks', 'region', "TEXT NOT NULL DEFAULT 'cn'")
ensureColumn('networks', 'relay_mode', "TEXT NOT NULL DEFAULT 'auto'")
ensureColumn('nodes', 'workspace_id', 'INTEGER')
ensureColumn('nodes', 'access_key_id', 'INTEGER')
ensureColumn('nodes', 'rx_bytes', 'INTEGER NOT NULL DEFAULT 0')
ensureColumn('nodes', 'tx_bytes', 'INTEGER NOT NULL DEFAULT 0')
ensureColumn('nodes', 'subnet_proxy', "TEXT NOT NULL DEFAULT ''")
ensureColumn('nodes', 'identity', "TEXT NOT NULL DEFAULT ''")
ensureColumn('nodes', 'dev_name', "TEXT NOT NULL DEFAULT 'xwtun0'")
ensureColumn('nodes', 'last_traffic_at', 'TEXT')
ensureColumn('nodes', 'registered_at', 'TEXT')
ensureColumn('audit_logs', 'workspace_id', 'INTEGER')
ensureColumn('subnet_routes', 'workspace_id', 'INTEGER')
ensureColumn('acl_rules', 'workspace_id', 'INTEGER')
ensureColumn('acl_rules', 'chain_type', "TEXT NOT NULL DEFAULT 'forward'")
ensureColumn('access_keys', 'register_count', 'INTEGER NOT NULL DEFAULT 0')

// 依赖补列完成的索引（老库的 workspace_id 列由上面的 ensureColumn 补齐）
db.exec(`
CREATE INDEX IF NOT EXISTS idx_networks_ws ON networks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_nodes_ws ON nodes(workspace_id);
CREATE INDEX IF NOT EXISTS idx_nodes_key ON nodes(access_key_id);
CREATE INDEX IF NOT EXISTS idx_audit_ws ON audit_logs(workspace_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_keys_ws ON access_keys(workspace_id);
CREATE INDEX IF NOT EXISTS idx_subnet_ws ON subnet_routes(workspace_id);
CREATE INDEX IF NOT EXISTS idx_acl_ws ON acl_rules(workspace_id, priority);
CREATE INDEX IF NOT EXISTS idx_channels_ws ON alert_channels(workspace_id);
CREATE INDEX IF NOT EXISTS idx_alert_rules_ws ON alert_rules(workspace_id, enabled);
CREATE INDEX IF NOT EXISTS idx_alert_events_ws ON alert_events(workspace_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_alert_events_open ON alert_events(rule_id, target_id, status);
`)

export const now = () => new Date().toISOString()
export const orNull = (v) => (v === undefined ? null : v)

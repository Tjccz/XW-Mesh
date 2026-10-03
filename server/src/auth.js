import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, db, now } from './db.js'

const SECRET_FILE = path.join(DATA_DIR, 'session.secret')
let SESSION_SECRET = process.env.SESSION_SECRET || ''

if (!SESSION_SECRET) {
  if (fs.existsSync(SECRET_FILE)) {
    SESSION_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim()
  } else {
    SESSION_SECRET = crypto.randomBytes(32).toString('hex')
    fs.writeFileSync(SECRET_FILE, SESSION_SECRET, { mode: 0o600 })
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url')

export function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex')
}

/** 角色等级，数值越大权限越高 */
export const ROLE_RANK = { viewer: 1, member: 2, admin: 3, owner: 4 }

export const ROLE_LABEL = {
  owner: '拥有者',
  admin: '管理员',
  member: '成员',
  viewer: '只读',
}

export function createUser(username, password, role = 'member', workspaceId = null, displayName = '') {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = hashPassword(password, salt)
  const stmt = db.prepare(
    `INSERT INTO users (username, password_hash, salt, role, workspace_id, display_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const info = stmt.run(username, hash, salt, role, workspaceId, displayName, now())
  return Number(info.lastInsertRowid)
}

export function verifyUser(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username)
  if (!user) return null
  const hash = hashPassword(password, user.salt)
  const a = Buffer.from(hash, 'hex')
  const b = Buffer.from(user.password_hash, 'hex')
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  return user
}

export function signToken(payload, ttlSeconds = 60 * 60 * 24 * 7) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }
  const data = b64url(JSON.stringify(body))
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url')
  return `${data}.${sig}`
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null
  const [data, sig] = token.split('.')
  if (!data || !sig) return null
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const body = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'))
    if (body.exp && body.exp < Math.floor(Date.now() / 1000)) return null
    return body
  } catch {
    return null
  }
}

export function requireAuth(req, res, next) {
  const header = req.get('authorization') || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  const payload = verifyToken(token)
  if (!payload) return res.status(401).json({ error: '未登录或登录已过期' })
  req.user = payload
  next()
}

/** 要求当前用户达到某个最低角色等级 */
export function requireMinRole(min) {
  return (req, res, next) => {
    const rank = ROLE_RANK[req.user?.role] || 0
    if (rank < ROLE_RANK[min]) {
      return res.status(403).json({ error: '当前角色没有该操作权限' })
    }
    next()
  }
}

/**
 * 首次启动引导：确保存在默认工作区与拥有者账号，并为老数据补齐工作区归属
 * 自建部署默认使用 selfhost 套餐（不限量），可在「工作区设置」中切换为试用版/专业版演示配额
 */
export function ensureBootstrap() {
  let workspace = db.prepare('SELECT * FROM workspaces ORDER BY id LIMIT 1').get()

  if (!workspace) {
    const info = db
      .prepare(
        'INSERT INTO workspaces (name, slug, plan, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run('长沙湘网智能科技', 'xiangwang', 'selfhost', now(), now())
    workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(Number(info.lastInsertRowid))
  }

  db.prepare('UPDATE networks SET workspace_id = ? WHERE workspace_id IS NULL').run(workspace.id)
  db.prepare('UPDATE nodes SET workspace_id = ? WHERE workspace_id IS NULL').run(workspace.id)
  db.prepare('UPDATE subnet_routes SET workspace_id = ? WHERE workspace_id IS NULL').run(workspace.id)
  db.prepare('UPDATE acl_rules SET workspace_id = ? WHERE workspace_id IS NULL').run(workspace.id)
  db.prepare('UPDATE access_keys SET workspace_id = ? WHERE workspace_id IS NULL').run(workspace.id)
  db.prepare('UPDATE audit_logs SET workspace_id = ? WHERE workspace_id IS NULL').run(workspace.id)

  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c
  if (count > 0) {
    db.prepare('UPDATE users SET workspace_id = ? WHERE workspace_id IS NULL').run(workspace.id)

    // 老版本没有「拥有者」角色，把最早的管理员提升为拥有者，否则工作区设置与成员管理会无人可用
    const hasOwner = db
      .prepare("SELECT COUNT(*) AS c FROM users WHERE workspace_id = ? AND role = 'owner'")
      .get(workspace.id).c
    if (!hasOwner) {
      const firstAdmin = db
        .prepare(
          "SELECT id FROM users WHERE workspace_id = ? ORDER BY (role = 'admin') DESC, id LIMIT 1"
        )
        .get(workspace.id)
      if (firstAdmin) db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(firstAdmin.id)
    }
    return { workspace, created: null }
  }

  const username = process.env.ADMIN_USER || 'admin'
  const password = process.env.ADMIN_PASSWORD || 'xiangwang@2026'
  createUser(username, password, 'owner', workspace.id, '管理员')
  return { workspace, created: { username, password } }
}

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

export function createUser(username, password, role = 'admin') {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = hashPassword(password, salt)
  const stmt = db.prepare(
    'INSERT INTO users (username, password_hash, salt, role, created_at) VALUES (?, ?, ?, ?, ?)'
  )
  const info = stmt.run(username, hash, salt, role, now())
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

export function ensureDefaultAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c
  if (count > 0) return null
  const username = process.env.ADMIN_USER || 'admin'
  const password = process.env.ADMIN_PASSWORD || 'xiangwang@2026'
  createUser(username, password)
  return { username, password }
}

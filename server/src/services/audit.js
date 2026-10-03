import { db, now, orNull } from '../db.js'

export function logAudit({ username, action, targetType, targetId, detail, ip }) {
  db.prepare(
    `INSERT INTO audit_logs (username, action, target_type, target_id, detail, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    orNull(username),
    action,
    orNull(targetType),
    targetId === undefined || targetId === null ? null : String(targetId),
    orNull(detail),
    orNull(ip),
    now()
  )
}

export function clientIp(req) {
  return (
    req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    ''
  )
}

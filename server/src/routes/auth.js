import express from 'express'
import {
  verifyUser,
  signToken,
  requireAuth,
  hashPassword,
  ROLE_LABEL,
} from '../auth.js'
import { db, now } from '../db.js'
import { logAudit, clientIp } from '../services/audit.js'

const router = express.Router()

function shapeUser(user) {
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(user.workspace_id)
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name || user.username,
    role: user.role,
    roleLabel: ROLE_LABEL[user.role] || user.role,
    workspace: workspace
      ? { id: workspace.id, name: workspace.name, slug: workspace.slug, plan: workspace.plan }
      : null,
  }
}

router.post('/login', (req, res) => {
  const { username, password } = req.body || {}
  if (!username || !password) {
    return res.status(400).json({ error: '请输入用户名和密码' })
  }

  const user = verifyUser(username, password)
  if (!user) {
    logAudit({
      username,
      action: 'login_failed',
      detail: '用户名或密码错误',
      ip: clientIp(req),
    })
    return res.status(401).json({ error: '用户名或密码错误' })
  }

  const token = signToken({
    uid: user.id,
    username: user.username,
    role: user.role,
    ws: user.workspace_id,
  })

  logAudit({
    username: user.username,
    action: 'login',
    detail: '登录成功',
    ip: clientIp(req),
    workspaceId: user.workspace_id,
  })

  res.json({ token, user: shapeUser(user) })
})

router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.uid)
  if (!user) return res.status(401).json({ error: '账号不存在' })
  res.json({ user: shapeUser(user) })
})

/** 修改自己的登录密码 */
router.post('/password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {}
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: '请填写原密码与新密码' })
  }
  if (String(newPassword).length < 8) {
    return res.status(400).json({ error: '新密码至少 8 位' })
  }

  const user = verifyUser(req.user.username, oldPassword)
  if (!user) return res.status(400).json({ error: '原密码不正确' })

  const salt = user.salt
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
    hashPassword(newPassword, salt),
    user.id
  )

  logAudit({
    username: user.username,
    action: 'password_change',
    detail: '修改登录密码',
    ip: clientIp(req),
    workspaceId: user.workspace_id,
  })

  res.json({ ok: true })
})

/** 修改显示名称 */
router.patch('/profile', requireAuth, (req, res) => {
  const { displayName } = req.body || {}
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(
    String(displayName || '').slice(0, 32),
    req.user.uid
  )
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.uid)
  res.json({ user: shapeUser(user) })
})

export default router

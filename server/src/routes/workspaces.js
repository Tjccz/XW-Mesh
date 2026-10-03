import express from 'express'
import { db, now } from '../db.js'
import {
  requireAuth,
  requireMinRole,
  createUser,
  hashPassword,
  ROLE_LABEL,
  ROLE_RANK,
} from '../auth.js'
import { logAudit, clientIp } from '../services/audit.js'
import { quotaOverview } from '../services/quota.js'

const router = express.Router()
router.use(requireAuth)

function getWorkspace(id) {
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id)
}

function shapeMember(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name || user.username,
    role: user.role,
    roleLabel: ROLE_LABEL[user.role] || user.role,
    createdAt: user.created_at,
    isSelf: false,
  }
}

/** 工作区信息与配额用量 */
router.get('/', (req, res) => {
  const workspace = getWorkspace(req.user.ws)
  if (!workspace) return res.status(404).json({ error: '工作区不存在' })
  res.json({
    item: {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      plan: workspace.plan,
      createdAt: workspace.created_at,
    },
    quota: quotaOverview(workspace.id, workspace.plan),
    myRole: req.user.role,
    myRoleLabel: ROLE_LABEL[req.user.role] || req.user.role,
  })
})

router.patch('/', requireMinRole('owner'), (req, res) => {
  const workspace = getWorkspace(req.user.ws)
  const { name, plan } = req.body || {}
  if (plan && !['selfhost', 'pro', 'free'].includes(plan)) {
    return res.status(400).json({ error: '套餐取值不合法' })
  }
  db.prepare('UPDATE workspaces SET name = ?, plan = ?, updated_at = ? WHERE id = ?').run(
    name ? String(name).slice(0, 40) : workspace.name,
    plan || workspace.plan,
    now(),
    workspace.id
  )
  logAudit({
    username: req.user.username,
    action: 'workspace_update',
    targetType: 'workspace',
    targetId: workspace.id,
    detail: `更新工作区设置（名称 ${name || workspace.name}，套餐 ${plan || workspace.plan}）`,
    ip: clientIp(req),
    workspaceId: workspace.id,
  })
  res.json({ ok: true })
})

/** 成员列表 */
router.get('/members', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM users WHERE workspace_id = ? ORDER BY id')
    .all(req.user.ws)
  res.json({
    items: rows.map((u) => ({ ...shapeMember(u), isSelf: u.id === req.user.uid })),
  })
})

/** 邀请成员：直接创建账号 */
router.post('/members', requireMinRole('owner'), (req, res) => {
  const { username, password, role, displayName } = req.body || {}
  if (!/^[A-Za-z0-9_.@-]{3,40}$/.test(username || '')) {
    return res.status(400).json({ error: '用户名需为 3-40 位字母、数字或 _ . @ -' })
  }
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: '密码至少 8 位' })
  }
  if (!ROLE_RANK[role]) return res.status(400).json({ error: '角色不合法' })
  if (role === 'owner') return res.status(400).json({ error: '不能通过邀请创建拥有者' })

  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: '该用户名已被占用' })
  }

  const id = createUser(username, password, role, req.user.ws, displayName || username)

  logAudit({
    username: req.user.username,
    action: 'member_invite',
    targetType: 'user',
    targetId: id,
    detail: `添加成员 ${username}（${ROLE_LABEL[role]}）`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id)
  res.status(201).json({ item: shapeMember(user) })
})

/** 调整成员角色 */
router.patch('/members/:id', requireMinRole('owner'), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ? AND workspace_id = ?').get(
    req.params.id,
    req.user.ws
  )
  if (!target) return res.status(404).json({ error: '成员不存在' })
  if (target.role === 'owner') return res.status(400).json({ error: '不能修改拥有者角色' })

  const { role, displayName } = req.body || {}
  if (role && !ROLE_RANK[role]) return res.status(400).json({ error: '角色不合法' })
  if (role === 'owner') return res.status(400).json({ error: '不能把成员提升为拥有者' })

  db.prepare('UPDATE users SET role = ?, display_name = ? WHERE id = ?').run(
    role || target.role,
    displayName !== undefined ? String(displayName).slice(0, 32) : target.display_name,
    target.id
  )

  logAudit({
    username: req.user.username,
    action: 'member_update',
    targetType: 'user',
    targetId: target.id,
    detail: `调整成员 ${target.username} 的角色为 ${ROLE_LABEL[role || target.role]}`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(target.id)
  res.json({ item: shapeMember(user) })
})

/** 重置成员密码 */
router.post('/members/:id/password', requireMinRole('owner'), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ? AND workspace_id = ?').get(
    req.params.id,
    req.user.ws
  )
  if (!target) return res.status(404).json({ error: '成员不存在' })

  const { password } = req.body || {}
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: '密码至少 8 位' })
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
    hashPassword(password, target.salt),
    target.id
  )

  logAudit({
    username: req.user.username,
    action: 'member_reset_password',
    targetType: 'user',
    targetId: target.id,
    detail: `重置成员 ${target.username} 的密码`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })

  res.json({ ok: true })
})

/** 移除成员 */
router.delete('/members/:id', requireMinRole('owner'), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ? AND workspace_id = ?').get(
    req.params.id,
    req.user.ws
  )
  if (!target) return res.status(404).json({ error: '成员不存在' })
  if (target.role === 'owner') return res.status(400).json({ error: '不能移除拥有者' })
  if (target.id === req.user.uid) return res.status(400).json({ error: '不能移除自己' })

  db.prepare('DELETE FROM users WHERE id = ?').run(target.id)

  logAudit({
    username: req.user.username,
    action: 'member_remove',
    targetType: 'user',
    targetId: target.id,
    detail: `移除成员 ${target.username}`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })

  res.json({ ok: true })
})

export default router

import express from 'express'
import { db } from '../db.js'
import { requireAuth } from '../auth.js'

const router = express.Router()
router.use(requireAuth)

const ACTION_LABEL = {
  login: '登录',
  login_failed: '登录失败',
  logout: '退出登录',
  password_change: '修改密码',
  workspace_update: '更新工作区',
  member_invite: '添加成员',
  member_update: '调整成员角色',
  member_remove: '移除成员',
  member_reset_password: '重置成员密码',
  network_create: '创建网络',
  network_update: '更新网络',
  network_delete: '删除网络',
  node_create: '添加设备',
  node_update: '更新设备',
  node_delete: '删除设备',
  node_block: '停止设备',
  node_unblock: '恢复设备',
  node_resync: '重发配置',
  node_rollback: '回滚配置',
  node_provision: '获取接入材料',
  node_register: '设备自助接入',
  node_report: '设备上报',
  key_create: '创建接入密钥',
  key_update: '更新接入密钥',
  key_revoke: '吊销接入密钥',
  key_restore: '恢复接入密钥',
  key_delete: '删除接入密钥',
  subnet_create: '添加子网路由',
  subnet_delete: '删除子网路由',
  acl_create: '添加访问控制',
  acl_update: '更新访问控制',
  acl_delete: '删除访问控制',
}

function shape(r) {
  return {
    id: r.id,
    username: r.username,
    action: r.action,
    actionLabel: ACTION_LABEL[r.action] || r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    detail: r.detail,
    ip: r.ip,
    createdAt: r.created_at,
  }
}

function query(req) {
  const where = ['workspace_id = ?']
  const params = [req.user.ws]
  if (req.query.action) {
    where.push('action = ?')
    params.push(String(req.query.action))
  }
  if (req.query.username) {
    where.push('username LIKE ?')
    params.push(`%${req.query.username}%`)
  }
  if (req.query.keyword) {
    where.push('detail LIKE ?')
    params.push(`%${req.query.keyword}%`)
  }
  if (req.query.since) {
    where.push('created_at >= ?')
    params.push(String(req.query.since))
  }
  return { where: where.join(' AND '), params }
}

router.get('/', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500)
  const offset = Math.max(Number(req.query.offset) || 0, 0)
  const { where, params } = query(req)

  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM audit_logs WHERE ${where}`)
    .get(...params).c

  const rows = db
    .prepare(`SELECT * FROM audit_logs WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset)

  res.json({ items: rows.map(shape), total, limit, offset })
})

/** 供筛选下拉使用的动作清单 */
router.get('/actions', (req, res) => {
  const rows = db
    .prepare('SELECT DISTINCT action FROM audit_logs WHERE workspace_id = ? ORDER BY action')
    .all(req.user.ws)
  res.json({
    items: rows.map((r) => ({ value: r.action, label: ACTION_LABEL[r.action] || r.action })),
  })
})

/** 导出审计日志 CSV */
router.get('/export.csv', (req, res) => {
  const { where, params } = query(req)
  const rows = db
    .prepare(`SELECT * FROM audit_logs WHERE ${where} ORDER BY id DESC LIMIT 5000`)
    .all(...params)

  const lines = ['时间,操作者,动作,对象类型,对象ID,详情,来源IP']
  for (const r of rows) {
    lines.push(
      [
        r.created_at,
        r.username || '',
        ACTION_LABEL[r.action] || r.action,
        r.target_type || '',
        r.target_id || '',
        r.detail || '',
        r.ip || '',
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    )
  }

  res
    .type('text/csv; charset=utf-8')
    .set('Content-Disposition', 'attachment; filename="xiangwang-audit.csv"')
    .send('\uFEFF' + lines.join('\n') + '\n')
})

export default router

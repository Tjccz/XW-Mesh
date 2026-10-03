import express from 'express'
import crypto from 'node:crypto'
import { db, now } from '../db.js'
import { requireAuth, requireMinRole } from '../auth.js'
import { logAudit, clientIp } from '../services/audit.js'
import { checkQuota } from '../services/quota.js'

const router = express.Router()
router.use(requireAuth)

function getWorkspace(id) {
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id)
}

function deriveStatus(row) {
  if (row.status === 'revoked') return 'revoked'
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return 'expired'
  if (row.max_nodes > 0 && row.used_count >= row.max_nodes) return 'exhausted'
  return 'active'
}

function shape(row, network) {
  const status = deriveStatus(row)
  return {
    id: row.id,
    networkId: row.network_id,
    networkName: network?.name || '',
    name: row.name,
    key: row.key,
    status,
    expiresAt: row.expires_at,
    maxNodes: row.max_nodes,
    usedCount: row.used_count,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }
}

function consoleUrl(req) {
  return (process.env.CONSOLE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')
}

function buildCommands(req, item, network) {
  const base = consoleUrl(req)
  const peers = String(network.peers || '').split(',')[0].trim()

  return {
    linux: {
      title: 'Linux 服务器 / NAS（systemd）',
      desc: '在目标设备上执行，脚本会自动安装核心、注册服务并接入控制台',
      command: `curl -fsSL "${base}/api/agent/install.sh?key=${item.key}" | sudo sh`,
    },
    docker: {
      title: 'Docker',
      desc: '轻量接入：容器直接组网，配置变更需重建容器',
      command: [
        `docker run -d --name xiangwang-node --restart unless-stopped \\`,
        `  --cap-add NET_ADMIN --device /dev/net/tun \\`,
        `  easytier/easytier:latest easytier-core \\`,
        `  --network-name ${network.name} \\`,
        `  --network-secret ${network.secret} \\`,
        `  --peers ${peers} \\`,
        `  --hostname $(hostname)`,
      ].join('\n'),
    },
    openwrt: {
      title: 'OpenWrt / iStoreOS',
      desc: '使用官方 LuCI 插件接入，填写的网络名与密钥需与下方一致',
      command: [
        `# 1. 安装插件（详见 luci-app-easytier 文档）`,
        `opkg update && opkg install luci-app-easytier`,
        `# 2. 在「VPN → EasyTier → 上传程序」上传官方核心`,
        `# 3. 网络名 / 密钥填写：`,
        `#    --network-name ${network.name}`,
        `#    --network-secret ${network.secret}`,
        `#    --peers ${peers}`,
      ].join('\n'),
    },
    windows: {
      title: 'Windows / macOS',
      desc: '使用官方图形客户端，按下列参数新建网络',
      command: [
        `网络名称：${network.name}`,
        `网络密钥：${network.secret}`,
        `对等节点：${peers}`,
        ``,
        `图形客户端下载：${base}/api/agent/redirect/download`,
      ].join('\n'),
    },
  }
}

/** 列表 */
router.get('/', (req, res) => {
  const { networkId } = req.query
  let sql = 'SELECT * FROM access_keys WHERE workspace_id = ?'
  const params = [req.user.ws]
  if (networkId) {
    sql += ' AND network_id = ?'
    params.push(Number(networkId))
  }
  sql += ' ORDER BY id DESC'

  const rows = db.prepare(sql).all(...params)
  const networks = {}
  for (const n of db.prepare('SELECT * FROM networks WHERE workspace_id = ?').all(req.user.ws)) {
    networks[n.id] = n
  }

  res.json({
    items: rows.map((r) => shape(r, networks[r.network_id])),
    summary: {
      total: rows.length,
      active: rows.filter((r) => deriveStatus(r) === 'active').length,
      revoked: rows.filter((r) => deriveStatus(r) === 'revoked').length,
    },
  })
})

/** 创建密钥 */
router.post('/', requireMinRole('admin'), (req, res) => {
  const { networkId, name, expiresInDays, maxNodes, note } = req.body || {}
  const workspace = getWorkspace(req.user.ws)

  const quotaError = checkQuota(req.user.ws, workspace.plan, 'keys')
  if (quotaError) return res.status(403).json({ error: quotaError })

  const network = db
    .prepare('SELECT * FROM networks WHERE id = ? AND workspace_id = ?')
    .get(networkId, req.user.ws)
  if (!network) return res.status(400).json({ error: '请选择有效的网络' })
  if (!name || !String(name).trim()) return res.status(400).json({ error: '请填写密钥用途名称' })

  const days = Number(expiresInDays)
  const expiresAt =
    Number.isFinite(days) && days > 0
      ? new Date(Date.now() + days * 86400000).toISOString()
      : null

  const key = 'ek_' + crypto.randomBytes(16).toString('hex')
  const info = db
    .prepare(
      `INSERT INTO access_keys
         (workspace_id, network_id, name, key, status, expires_at, max_nodes, note, created_by, created_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
    )
    .run(
      req.user.ws,
      network.id,
      String(name).trim(),
      key,
      expiresAt,
      Math.max(0, Number(maxNodes) || 0),
      note || '',
      req.user.username,
      now()
    )

  logAudit({
    username: req.user.username,
    action: 'key_create',
    targetType: 'access_key',
    targetId: info.lastInsertRowid,
    detail: `为网络 ${network.name} 创建接入密钥「${name}」`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })

  const row = db.prepare('SELECT * FROM access_keys WHERE id = ?').get(Number(info.lastInsertRowid))
  res.status(201).json({ item: shape(row, network) })
})

/** 修改密钥（名称、有效期、数量上限） */
router.patch('/:id', requireMinRole('admin'), (req, res) => {
  const row = db
    .prepare('SELECT * FROM access_keys WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.user.ws)
  if (!row) return res.status(404).json({ error: '密钥不存在' })

  const { name, expiresInDays, maxNodes, note } = req.body || {}
  const days = Number(expiresInDays)
  const expiresAt =
    Number.isFinite(days) && days > 0
      ? new Date(Date.now() + days * 86400000).toISOString()
      : days === 0
        ? null
        : row.expires_at

  db.prepare(
    'UPDATE access_keys SET name = ?, expires_at = ?, max_nodes = ?, note = ? WHERE id = ?'
  ).run(
    name ? String(name).trim() : row.name,
    expiresAt,
    maxNodes !== undefined ? Math.max(0, Number(maxNodes) || 0) : row.max_nodes,
    note ?? row.note,
    row.id
  )

  logAudit({
    username: req.user.username,
    action: 'key_update',
    targetType: 'access_key',
    targetId: row.id,
    detail: `更新接入密钥「${row.name}」`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })

  const fresh = db.prepare('SELECT * FROM access_keys WHERE id = ?').get(row.id)
  const network = db.prepare('SELECT * FROM networks WHERE id = ?').get(row.network_id)
  res.json({ item: shape(fresh, network) })
})

/** 吊销密钥：立即生效，已接入设备会在下一次心跳后被要求下线 */
router.post('/:id/revoke', requireMinRole('admin'), (req, res) => {
  const row = db
    .prepare('SELECT * FROM access_keys WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.user.ws)
  if (!row) return res.status(404).json({ error: '密钥不存在' })

  db.prepare("UPDATE access_keys SET status = 'revoked' WHERE id = ?").run(row.id)

  const affected = db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE access_key_id = ?').get(row.id).c

  logAudit({
    username: req.user.username,
    action: 'key_revoke',
    targetType: 'access_key',
    targetId: row.id,
    detail: `吊销接入密钥「${row.name}」，影响 ${affected} 台设备`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })

  const fresh = db.prepare('SELECT * FROM access_keys WHERE id = ?').get(row.id)
  const network = db.prepare('SELECT * FROM networks WHERE id = ?').get(row.network_id)
  res.json({ item: shape(fresh, network), affectedNodes: affected })
})

/** 恢复密钥 */
router.post('/:id/restore', requireMinRole('admin'), (req, res) => {
  const row = db
    .prepare('SELECT * FROM access_keys WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.user.ws)
  if (!row) return res.status(404).json({ error: '密钥不存在' })

  db.prepare("UPDATE access_keys SET status = 'active' WHERE id = ?").run(row.id)
  logAudit({
    username: req.user.username,
    action: 'key_restore',
    targetType: 'access_key',
    targetId: row.id,
    detail: `恢复接入密钥「${row.name}」`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })

  const fresh = db.prepare('SELECT * FROM access_keys WHERE id = ?').get(row.id)
  const network = db.prepare('SELECT * FROM networks WHERE id = ?').get(row.network_id)
  res.json({ item: shape(fresh, network) })
})

router.delete('/:id', requireMinRole('admin'), (req, res) => {
  const row = db
    .prepare('SELECT * FROM access_keys WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.user.ws)
  if (!row) return res.status(404).json({ error: '密钥不存在' })

  db.prepare('DELETE FROM access_keys WHERE id = ?').run(row.id)
  logAudit({
    username: req.user.username,
    action: 'key_delete',
    targetType: 'access_key',
    targetId: row.id,
    detail: `删除接入密钥「${row.name}」`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })
  res.json({ ok: true })
})

/** 各平台接入方式 */
router.get('/:id/commands', (req, res) => {
  const row = db
    .prepare('SELECT * FROM access_keys WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.user.ws)
  if (!row) return res.status(404).json({ error: '密钥不存在' })

  const network = db.prepare('SELECT * FROM networks WHERE id = ?').get(row.network_id)
  res.json({
    item: shape(row, network),
    methods: buildCommands(req, row, network),
  })
})

export default router

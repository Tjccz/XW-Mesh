import express from 'express'
import crypto from 'node:crypto'
import { db, now } from '../db.js'
import { requireAuth } from '../auth.js'
import { logAudit, clientIp } from '../services/audit.js'
import { buildInstallScript, buildConfigEnv, allocateVirtualIp } from '../services/provision.js'

const router = express.Router()
router.use(requireAuth)

const ONLINE_WINDOW_MS = 120 * 1000
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/

function deriveStatus(node) {
  if (!node.last_seen) return 'pending'
  const diff = Date.now() - new Date(node.last_seen).getTime()
  return diff <= ONLINE_WINDOW_MS ? 'online' : 'offline'
}

function shape(node, network) {
  return {
    id: node.id,
    networkId: node.network_id,
    networkName: network?.name || '',
    name: node.name,
    virtualIp: node.virtual_ip,
    token: node.token,
    status: deriveStatus(node),
    lastSeen: node.last_seen,
    coreVersion: node.core_version,
    peerCount: node.peer_count,
    platform: node.platform,
    reportedIp: node.reported_ip,
    configVersion: node.config_version,
    note: node.note,
    createdAt: node.created_at,
    updatedAt: node.updated_at,
  }
}

function getNode(id) {
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(id)
}

function getNetwork(id) {
  return db.prepare('SELECT * FROM networks WHERE id = ?').get(id)
}

function consoleUrl(req) {
  return (
    process.env.CONSOLE_URL ||
    `${req.protocol}://${req.get('host')}`
  ).replace(/\/$/, '')
}

function snapshot(node, network, note, author) {
  db.prepare(
    `INSERT INTO node_configs (node_id, version, config_json, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    node.id,
    node.config_version,
    JSON.stringify({
      networkName: network.name,
      networkSecret: network.secret,
      peers: network.peers,
      virtualIp: node.virtual_ip,
      nodeName: node.name,
    }),
    note,
    author,
    now()
  )
}

router.get('/', (req, res) => {
  const { networkId, keyword } = req.query
  let sql = 'SELECT * FROM nodes'
  const params = []
  const where = []
  if (networkId) {
    where.push('network_id = ?')
    params.push(Number(networkId))
  }
  if (keyword) {
    where.push('(name LIKE ? OR virtual_ip LIKE ?)')
    params.push(`%${keyword}%`, `%${keyword}%`)
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ')
  sql += ' ORDER BY id DESC'

  const nodes = db.prepare(sql).all(...params)
  const networks = {}
  for (const n of db.prepare('SELECT * FROM networks').all()) networks[n.id] = n

  const items = nodes.map((n) => shape(n, networks[n.network_id]))
  res.json({
    items,
    summary: {
      total: items.length,
      online: items.filter((i) => i.status === 'online').length,
      offline: items.filter((i) => i.status === 'offline').length,
      pending: items.filter((i) => i.status === 'pending').length,
    },
  })
})

router.post('/', (req, res) => {
  const { networkId, name, virtualIp, note } = req.body || {}
  const network = getNetwork(networkId)
  if (!network) return res.status(400).json({ error: '请选择有效的网络' })
  if (!name || !String(name).trim()) return res.status(400).json({ error: '请填写节点名称' })

  const used = db
    .prepare('SELECT virtual_ip FROM nodes WHERE network_id = ?')
    .all(network.id)
    .map((r) => r.virtual_ip)

  let ip = virtualIp || allocateVirtualIp(network.cidr, used)
  if (!IP_RE.test(ip || '')) return res.status(400).json({ error: '虚拟 IP 格式不正确' })
  if (used.includes(ip)) return res.status(409).json({ error: `虚拟 IP ${ip} 已被占用` })

  const token = crypto.randomBytes(24).toString('hex')
  const info = db
    .prepare(
      `INSERT INTO nodes (network_id, name, virtual_ip, token, status, config_version, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 1, ?, ?, ?)`
    )
    .run(network.id, String(name).trim(), ip, token, note || '', now(), now())

  const node = getNode(Number(info.lastInsertRowid))
  snapshot(node, network, '初始配置', req.user.username)

  logAudit({
    username: req.user.username,
    action: 'node_create',
    targetType: 'node',
    targetId: node.id,
    detail: `在网络 ${network.name} 中新增节点 ${node.name}（${ip}）`,
    ip: clientIp(req),
  })

  res.status(201).json({ item: shape(node, network) })
})

router.get('/:id', (req, res) => {
  const node = getNode(req.params.id)
  if (!node) return res.status(404).json({ error: '节点不存在' })
  res.json({ item: shape(node, getNetwork(node.network_id)) })
})

router.patch('/:id', (req, res) => {
  const node = getNode(req.params.id)
  if (!node) return res.status(404).json({ error: '节点不存在' })
  const network = getNetwork(node.network_id)

  const { name, virtualIp, note } = req.body || {}
  if (virtualIp && virtualIp !== node.virtual_ip) {
    if (!IP_RE.test(virtualIp)) return res.status(400).json({ error: '虚拟 IP 格式不正确' })
    const dup = db
      .prepare('SELECT id FROM nodes WHERE network_id = ? AND virtual_ip = ? AND id != ?')
      .get(network.id, virtualIp, node.id)
    if (dup) return res.status(409).json({ error: `虚拟 IP ${virtualIp} 已被占用` })
  }

  const changedConfig = (name && name !== node.name) || (virtualIp && virtualIp !== node.virtual_ip)
  const nextVersion = changedConfig ? node.config_version + 1 : node.config_version

  db.prepare(
    `UPDATE nodes SET name = ?, virtual_ip = ?, note = ?, config_version = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    name ? String(name).trim() : node.name,
    virtualIp || node.virtual_ip,
    note ?? node.note,
    nextVersion,
    now(),
    node.id
  )

  const updated = getNode(node.id)
  if (changedConfig) {
    snapshot(updated, network, '节点参数变更', req.user.username)
  }

  logAudit({
    username: req.user.username,
    action: 'node_update',
    targetType: 'node',
    targetId: node.id,
    detail: changedConfig
      ? `更新节点 ${updated.name}，配置版本提升至 v${nextVersion}`
      : `更新节点 ${updated.name} 的备注`,
    ip: clientIp(req),
  })

  res.json({ item: shape(updated, network) })
})

router.delete('/:id', (req, res) => {
  const node = getNode(req.params.id)
  if (!node) return res.status(404).json({ error: '节点不存在' })
  db.prepare('DELETE FROM nodes WHERE id = ?').run(node.id)
  logAudit({
    username: req.user.username,
    action: 'node_delete',
    targetType: 'node',
    targetId: node.id,
    detail: `删除节点 ${node.name}`,
    ip: clientIp(req),
  })
  res.json({ ok: true })
})

/** 获取接入脚本 */
router.get('/:id/provision', (req, res) => {
  const node = getNode(req.params.id)
  if (!node) return res.status(404).json({ error: '节点不存在' })
  const network = getNetwork(node.network_id)

  const script = buildInstallScript({ network, node, consoleUrl: consoleUrl(req) })
  logAudit({
    username: req.user.username,
    action: 'node_provision',
    targetType: 'node',
    targetId: node.id,
    detail: `获取节点 ${node.name} 的接入脚本`,
    ip: clientIp(req),
  })

  res.json({
    filename: `xiangwang-${node.name}.sh`,
    script,
    configEnv: buildConfigEnv(network, node),
    consoleUrl: consoleUrl(req),
  })
})

/** 配置快照列表 */
router.get('/:id/configs', (req, res) => {
  const node = getNode(req.params.id)
  if (!node) return res.status(404).json({ error: '节点不存在' })
  const rows = db
    .prepare('SELECT * FROM node_configs WHERE node_id = ? ORDER BY version DESC, id DESC LIMIT 50')
    .all(node.id)
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      version: r.version,
      config: JSON.parse(r.config_json),
      note: r.note,
      createdBy: r.created_by,
      createdAt: r.created_at,
      isCurrent: r.version === node.config_version,
    })),
    currentVersion: node.config_version,
  })
})

/** 回滚节点参数到某个历史版本 */
router.post('/:id/rollback', (req, res) => {
  const node = getNode(req.params.id)
  if (!node) return res.status(404).json({ error: '节点不存在' })
  const network = getNetwork(node.network_id)

  const { version } = req.body || {}
  const target = db
    .prepare('SELECT * FROM node_configs WHERE node_id = ? AND version = ? ORDER BY id DESC LIMIT 1')
    .get(node.id, Number(version))

  if (!target) return res.status(404).json({ error: '该配置版本不存在' })

  const config = JSON.parse(target.config_json)
  const nextVersion = node.config_version + 1

  db.prepare(
    'UPDATE nodes SET name = ?, virtual_ip = ?, config_version = ?, updated_at = ? WHERE id = ?'
  ).run(config.nodeName || node.name, config.virtualIp || node.virtual_ip, nextVersion, now(), node.id)

  const updated = getNode(node.id)
  snapshot(updated, network, `回滚自 v${version}`, req.user.username)

  logAudit({
    username: req.user.username,
    action: 'node_rollback',
    targetType: 'node',
    targetId: node.id,
    detail: `节点 ${updated.name} 参数回滚到 v${version}（新版本 v${nextVersion}）`,
    ip: clientIp(req),
  })

  res.json({ item: shape(updated, network), restoredFrom: Number(version) })
})

export default router

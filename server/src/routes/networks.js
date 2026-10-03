import express from 'express'
import { db, now } from '../db.js'
import { requireAuth, requireMinRole } from '../auth.js'
import { logAudit, clientIp } from '../services/audit.js'
import { bumpNetworkNodesConfig } from '../services/config.js'
import { checkQuota } from '../services/quota.js'

const router = express.Router()
router.use(requireAuth)

const NAME_RE = /^[A-Za-z0-9_-]{3,64}$/
const SECRET_RE = /^[A-Za-z0-9_.:-]{8,128}$/
const CIDR_RE = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/
const REGIONS = ['cn', 'hk', 'sg', 'jp', 'us', 'eu']
const RELAY_MODES = ['auto', 'relay', 'p2p']

function getNetwork(id, workspaceId) {
  return db
    .prepare('SELECT * FROM networks WHERE id = ? AND workspace_id = ?')
    .get(id, workspaceId)
}

function networkExtras(networkId) {
  const nodeStats = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) AS online,
              SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked
       FROM nodes WHERE network_id = ?`
    )
    .get(networkId)
  const keys = db
    .prepare("SELECT COUNT(*) AS c FROM access_keys WHERE network_id = ? AND status = 'active'")
    .get(networkId).c
  const subnets = db
    .prepare('SELECT COUNT(*) AS c FROM subnet_routes WHERE network_id = ?')
    .get(networkId).c
  const acl = db
    .prepare('SELECT COUNT(*) AS c FROM acl_rules WHERE network_id = ? AND enabled = 1')
    .get(networkId).c
  return {
    nodeTotal: nodeStats.total || 0,
    nodeOnline: nodeStats.online || 0,
    nodeBlocked: nodeStats.blocked || 0,
    keyCount: keys,
    subnetCount: subnets,
    aclCount: acl,
  }
}

function shape(row) {
  return {
    id: row.id,
    name: row.name,
    secret: row.secret,
    cidr: row.cidr,
    peers: row.peers,
    region: row.region || 'cn',
    relayMode: row.relay_mode || 'auto',
    template: row.template || 'custom',
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...networkExtras(row.id),
  }
}

/** 安装/接入指引：控制台地址与对等节点 */
function networkHints(network) {
  const peers = String(network.peers || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  return {
    peerList: peers,
    listenPorts: [11010, 11011],
    tunDevice: 'xwtun0',
  }
}

router.get('/', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM networks WHERE workspace_id = ? ORDER BY id DESC')
    .all(req.user.ws)
  res.json({ items: rows.map(shape) })
})

router.get('/regions', (req, res) => {
  res.json({ items: REGIONS, relayModes: RELAY_MODES })
})

router.post('/', requireMinRole('admin'), (req, res) => {
  const { name, secret, cidr, peers, description, region, relayMode } = req.body || {}
  if (!NAME_RE.test(name || '')) {
    return res.status(400).json({ error: '网络名需为 3-64 位字母、数字、下划线或连字符' })
  }
  if (!SECRET_RE.test(secret || '')) {
    return res.status(400).json({ error: '密钥需为 8-128 位字母、数字或 _ . : - 字符' })
  }
  if (cidr && !CIDR_RE.test(cidr)) {
    return res.status(400).json({ error: '网段格式不正确，例如 10.144.144.0/24' })
  }
  if (region && !REGIONS.includes(region)) return res.status(400).json({ error: '区域取值不合法' })
  if (relayMode && !RELAY_MODES.includes(relayMode)) {
    return res.status(400).json({ error: '中继模式取值不合法' })
  }
  if (db.prepare('SELECT id FROM networks WHERE name = ?').get(name)) {
    return res.status(409).json({ error: '该网络名已存在' })
  }

  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.user.ws)
  const quotaError = checkQuota(req.user.ws, workspace.plan, 'networks')
  if (quotaError) return res.status(403).json({ error: quotaError })

  const info = db
    .prepare(
      `INSERT INTO networks
         (workspace_id, name, secret, cidr, peers, description, region, relay_mode, template, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.user.ws,
      name,
      secret,
      cidr || '10.144.144.0/24',
      peers || 'tcp://public.easytier.cn:11010',
      description || '',
      region || 'cn',
      relayMode || 'auto',
      'custom',
      now(),
      now()
    )

  logAudit({
    username: req.user.username,
    action: 'network_create',
    targetType: 'network',
    targetId: info.lastInsertRowid,
    detail: `创建网络 ${name}（${cidr || '10.144.144.0/24'}）`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })

  res.status(201).json({ item: shape(getNetwork(Number(info.lastInsertRowid), req.user.ws)) })
})

router.get('/:id', (req, res) => {
  const network = getNetwork(req.params.id, req.user.ws)
  if (!network) return res.status(404).json({ error: '网络不存在' })
  res.json({ item: shape(network), hints: networkHints(network) })
})

router.patch('/:id', requireMinRole('admin'), (req, res) => {
  const network = getNetwork(req.params.id, req.user.ws)
  if (!network) return res.status(404).json({ error: '网络不存在' })

  const { name, secret, cidr, peers, description, region, relayMode } = req.body || {}
  if (name && name !== network.name) {
    if (!NAME_RE.test(name)) return res.status(400).json({ error: '网络名格式不正确' })
    if (db.prepare('SELECT id FROM networks WHERE name = ? AND id != ?').get(name, network.id)) {
      return res.status(409).json({ error: '该网络名已存在' })
    }
  }
  if (secret && !SECRET_RE.test(secret)) return res.status(400).json({ error: '密钥格式不正确' })
  if (cidr && !CIDR_RE.test(cidr)) return res.status(400).json({ error: '网段格式不正确' })
  if (region && !REGIONS.includes(region)) return res.status(400).json({ error: '区域取值不合法' })
  if (relayMode && !RELAY_MODES.includes(relayMode)) {
    return res.status(400).json({ error: '中继模式取值不合法' })
  }

  db.prepare(
    `UPDATE networks SET name = ?, secret = ?, cidr = ?, peers = ?, description = ?,
       region = ?, relay_mode = ?, updated_at = ? WHERE id = ?`
  ).run(
    name ?? network.name,
    secret ?? network.secret,
    cidr ?? network.cidr,
    peers ?? network.peers,
    description ?? network.description,
    region ?? network.region ?? 'cn',
    relayMode ?? network.relay_mode ?? 'auto',
    now(),
    network.id
  )

  const affected = bumpNetworkNodesConfig(
    network.id,
    `网络参数变更：${name ?? network.name}`,
    req.user.username
  )

  logAudit({
    username: req.user.username,
    action: 'network_update',
    targetType: 'network',
    targetId: network.id,
    detail: `更新网络 ${network.name}，${affected} 台设备待同步`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })

  res.json({ item: shape(getNetwork(network.id, req.user.ws)), affectedNodes: affected })
})

router.delete('/:id', requireMinRole('admin'), (req, res) => {
  const network = getNetwork(req.params.id, req.user.ws)
  if (!network) return res.status(404).json({ error: '网络不存在' })

  const nodeCount = db
    .prepare('SELECT COUNT(*) AS c FROM nodes WHERE network_id = ?')
    .get(network.id).c
  if (nodeCount > 0 && req.query.force !== '1') {
    return res.status(409).json({
      error: `该网络下仍有 ${nodeCount} 台设备，请先移除设备，或确认后使用强制删除`,
    })
  }

  db.prepare('DELETE FROM networks WHERE id = ?').run(network.id)
  logAudit({
    username: req.user.username,
    action: 'network_delete',
    targetType: 'network',
    targetId: network.id,
    detail: `删除网络 ${network.name}（含 ${nodeCount} 台设备）`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })
  res.json({ ok: true, removedNodes: nodeCount })
})

export default router

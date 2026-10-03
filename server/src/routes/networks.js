import express from 'express'
import { db, now } from '../db.js'
import { requireAuth } from '../auth.js'
import { logAudit, clientIp } from '../services/audit.js'

const router = express.Router()
router.use(requireAuth)

const NAME_RE = /^[A-Za-z0-9_-]{3,64}$/
const SECRET_RE = /^[A-Za-z0-9_.:-]{8,128}$/
const CIDR_RE = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/

function shape(row, nodeStats) {
  const stats = nodeStats?.[row.id] || { total: 0, online: 0 }
  return {
    id: row.id,
    name: row.name,
    secret: row.secret,
    cidr: row.cidr,
    peers: row.peers,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nodeTotal: stats.total,
    nodeOnline: stats.online,
  }
}

function nodeStatsMap() {
  const rows = db
    .prepare(
      `SELECT network_id, COUNT(*) AS total,
              SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) AS online
       FROM nodes GROUP BY network_id`
    )
    .all()
  const map = {}
  for (const r of rows) map[r.network_id] = { total: r.total, online: r.online || 0 }
  return map
}

function getNetwork(id) {
  return db.prepare('SELECT * FROM networks WHERE id = ?').get(id)
}

/** 网络参数变化会影响其下所有节点，统一提升配置版本以触发节点同步 */
function bumpNodesConfig(networkId, note) {
  const nodes = db.prepare('SELECT * FROM nodes WHERE network_id = ?').all(networkId)
  const update = db.prepare('UPDATE nodes SET config_version = config_version + 1, updated_at = ? WHERE id = ?')
  const snapshot = db.prepare(
    `INSERT INTO node_configs (node_id, version, config_json, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  const network = getNetwork(networkId)
  for (const n of nodes) {
    const nextVersion = n.config_version + 1
    update.run(now(), n.id)
    snapshot.run(
      n.id,
      nextVersion,
      JSON.stringify({
        networkName: network.name,
        networkSecret: network.secret,
        peers: network.peers,
        virtualIp: n.virtual_ip,
        nodeName: n.name,
      }),
      note,
      'system',
      now()
    )
  }
  return nodes.length
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM networks ORDER BY id DESC').all()
  const stats = nodeStatsMap()
  res.json({ items: rows.map((r) => shape(r, stats)) })
})

router.post('/', (req, res) => {
  const { name, secret, cidr, peers, description } = req.body || {}
  if (!NAME_RE.test(name || '')) {
    return res.status(400).json({ error: '网络名需为 3-64 位字母、数字、下划线或连字符' })
  }
  if (!SECRET_RE.test(secret || '')) {
    return res.status(400).json({ error: '密钥需为 8-128 位字母、数字或 _ . : - 字符' })
  }
  if (cidr && !CIDR_RE.test(cidr)) {
    return res.status(400).json({ error: '网段格式不正确，例如 10.144.144.0/24' })
  }
  if (db.prepare('SELECT id FROM networks WHERE name = ?').get(name)) {
    return res.status(409).json({ error: '该网络名已存在' })
  }

  const info = db
    .prepare(
      `INSERT INTO networks (name, secret, cidr, peers, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      name,
      secret,
      cidr || '10.144.144.0/24',
      peers || 'tcp://public.easytier.cn:11010',
      description || '',
      now(),
      now()
    )

  logAudit({
    username: req.user.username,
    action: 'network_create',
    targetType: 'network',
    targetId: info.lastInsertRowid,
    detail: `创建网络 ${name}`,
    ip: clientIp(req),
  })

  res.status(201).json({ item: shape(getNetwork(Number(info.lastInsertRowid))) })
})

router.get('/:id', (req, res) => {
  const network = getNetwork(req.params.id)
  if (!network) return res.status(404).json({ error: '网络不存在' })
  const stats = nodeStatsMap()
  res.json({ item: shape(network, stats) })
})

router.patch('/:id', (req, res) => {
  const network = getNetwork(req.params.id)
  if (!network) return res.status(404).json({ error: '网络不存在' })

  const { name, secret, cidr, peers, description } = req.body || {}
  if (name && name !== network.name) {
    if (!NAME_RE.test(name)) return res.status(400).json({ error: '网络名格式不正确' })
    if (db.prepare('SELECT id FROM networks WHERE name = ? AND id != ?').get(name, network.id)) {
      return res.status(409).json({ error: '该网络名已存在' })
    }
  }
  if (secret && !SECRET_RE.test(secret)) {
    return res.status(400).json({ error: '密钥格式不正确' })
  }
  if (cidr && !CIDR_RE.test(cidr)) return res.status(400).json({ error: '网段格式不正确' })

  db.prepare(
    `UPDATE networks SET name = ?, secret = ?, cidr = ?, peers = ?, description = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    name ?? network.name,
    secret ?? network.secret,
    cidr ?? network.cidr,
    peers ?? network.peers,
    description ?? network.description,
    now(),
    network.id
  )

  const affected = bumpNodesConfig(
    network.id,
    `网络参数变更：${name ?? network.name}`
  )

  logAudit({
    username: req.user.username,
    action: 'network_update',
    targetType: 'network',
    targetId: network.id,
    detail: `更新网络 ${network.name}，${affected} 个节点待同步`,
    ip: clientIp(req),
  })

  res.json({ item: shape(getNetwork(network.id)), affectedNodes: affected })
})

router.delete('/:id', (req, res) => {
  const network = getNetwork(req.params.id)
  if (!network) return res.status(404).json({ error: '网络不存在' })
  db.prepare('DELETE FROM networks WHERE id = ?').run(network.id)
  logAudit({
    username: req.user.username,
    action: 'network_delete',
    targetType: 'network',
    targetId: network.id,
    detail: `删除网络 ${network.name}`,
    ip: clientIp(req),
  })
  res.json({ ok: true })
})

export default router

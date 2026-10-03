import express from 'express'
import { db, now } from '../db.js'
import { requireAuth, requireMinRole } from '../auth.js'
import { logAudit, clientIp } from '../services/audit.js'
import { bumpNetworkNodesConfig, compileAcl } from '../services/config.js'
import { checkQuota } from '../services/quota.js'

const router = express.Router()
router.use(requireAuth)

const CIDR_RE = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/
const CHAIN_TYPES = ['forward', 'inbound', 'outbound']
const PROTOCOLS = ['any', 'tcp', 'udp', 'icmp', 'icmpv6']

function ownNetwork(req, networkId) {
  return db
    .prepare('SELECT * FROM networks WHERE id = ? AND workspace_id = ?')
    .get(networkId, req.user.ws)
}

/* ------------------------------ 子网路由 ------------------------------ */

router.get('/subnets', (req, res) => {
  const { networkId } = req.query
  let sql = `SELECT sr.*, n.name AS node_name, net.name AS network_name
             FROM subnet_routes sr
             JOIN nodes n ON n.id = sr.node_id
             JOIN networks net ON net.id = sr.network_id
             WHERE sr.workspace_id = ?`
  const params = [req.user.ws]
  if (networkId) {
    sql += ' AND sr.network_id = ?'
    params.push(Number(networkId))
  }
  sql += ' ORDER BY sr.id DESC'

  const rows = db.prepare(sql).all(...params)
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      networkId: r.network_id,
      networkName: r.network_name,
      nodeId: r.node_id,
      nodeName: r.node_name,
      cidr: r.cidr,
      description: r.description,
      createdAt: r.created_at,
    })),
  })
})

router.post('/subnets', requireMinRole('admin'), (req, res) => {
  const { networkId, nodeId, cidr, description } = req.body || {}
  const network = ownNetwork(req, networkId)
  if (!network) return res.status(400).json({ error: '请选择有效的网络' })
  if (!CIDR_RE.test(cidr || '')) return res.status(400).json({ error: '网段格式不正确，例如 192.168.1.0/24' })

  const node = db
    .prepare('SELECT * FROM nodes WHERE id = ? AND network_id = ?')
    .get(nodeId, network.id)
  if (!node) return res.status(400).json({ error: '请选择承担代理的节点' })

  const dup = db
    .prepare('SELECT id FROM subnet_routes WHERE network_id = ? AND cidr = ?')
    .get(network.id, cidr)
  if (dup) return res.status(409).json({ error: `网段 ${cidr} 已存在` })

  const info = db
    .prepare(
      `INSERT INTO subnet_routes (workspace_id, network_id, node_id, cidr, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(req.user.ws, network.id, node.id, cidr, description || '', now())

  const affected = bumpNetworkNodesConfig(network.id, `新增子网路由 ${cidr}`, req.user.username)

  logAudit({
    username: req.user.username,
    action: 'subnet_create',
    targetType: 'subnet',
    targetId: info.lastInsertRowid,
    detail: `为网络 ${network.name} 添加子网路由 ${cidr}（代理节点 ${node.name}），${affected} 台设备待同步`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })

  res.status(201).json({ ok: true, affectedNodes: affected })
})

router.delete('/subnets/:id', requireMinRole('admin'), (req, res) => {
  const row = db
    .prepare('SELECT * FROM subnet_routes WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.user.ws)
  if (!row) return res.status(404).json({ error: '子网路由不存在' })

  db.prepare('DELETE FROM subnet_routes WHERE id = ?').run(row.id)
  const affected = bumpNetworkNodesConfig(row.network_id, `移除子网路由 ${row.cidr}`, req.user.username)

  logAudit({
    username: req.user.username,
    action: 'subnet_delete',
    targetType: 'subnet',
    targetId: row.id,
    detail: `移除子网路由 ${row.cidr}，${affected} 台设备待同步`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })

  res.json({ ok: true, affectedNodes: affected })
})

/* ------------------------------ 访问控制 ------------------------------ */

function shapeRule(row) {
  return {
    id: row.id,
    networkId: row.network_id,
    name: row.name,
    action: row.action,
    protocol: row.protocol,
    chainType: row.chain_type || 'forward',
    srcCidr: row.src_cidr,
    dstCidr: row.dst_cidr,
    ports: row.ports,
    priority: row.priority,
    enabled: !!row.enabled,
    createdAt: row.created_at,
  }
}

router.get('/acl', (req, res) => {
  const { networkId } = req.query
  let sql = 'SELECT * FROM acl_rules WHERE workspace_id = ?'
  const params = [req.user.ws]
  if (networkId) {
    sql += ' AND network_id = ?'
    params.push(Number(networkId))
  }
  sql += ' ORDER BY priority, id'

  const rows = db.prepare(sql).all(...params)
  res.json({
    items: rows.map(shapeRule),
    preview: networkId ? compileAcl(Number(networkId)) : '',
  })
})

router.post('/acl', requireMinRole('admin'), (req, res) => {
  const { networkId, name, action, protocol, chainType, srcCidr, dstCidr, ports, priority } =
    req.body || {}
  const network = ownNetwork(req, networkId)
  if (!network) return res.status(400).json({ error: '请选择有效的网络' })
  if (!name || !String(name).trim()) return res.status(400).json({ error: '请填写规则名称' })
  if (!['allow', 'deny'].includes(action)) return res.status(400).json({ error: '动作只能是允许或拒绝' })
  if (srcCidr && !CIDR_RE.test(srcCidr)) return res.status(400).json({ error: '源地址段格式不正确' })
  if (dstCidr && !CIDR_RE.test(dstCidr)) return res.status(400).json({ error: '目标地址段格式不正确' })
  if (chainType && !CHAIN_TYPES.includes(chainType)) {
    return res.status(400).json({ error: '作用于取值不合法' })
  }

  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.user.ws)
  const quotaError = checkQuota(req.user.ws, workspace.plan, 'aclRules')
  if (quotaError) return res.status(403).json({ error: quotaError })

  const info = db
    .prepare(
      `INSERT INTO acl_rules
         (workspace_id, network_id, name, action, protocol, chain_type, src_cidr, dst_cidr,
          ports, priority, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    )
    .run(
      req.user.ws,
      network.id,
      String(name).trim(),
      action,
      protocol || 'tcp',
      chainType || 'forward',
      srcCidr || '0.0.0.0/0',
      dstCidr || '0.0.0.0/0',
      ports || '',
      Number(priority) || 100,
      now()
    )

  const affected = bumpNetworkNodesConfig(network.id, `新增访问控制规则 ${name}`, req.user.username)

  logAudit({
    username: req.user.username,
    action: 'acl_create',
    targetType: 'acl',
    targetId: info.lastInsertRowid,
    detail: `网络 ${network.name} 新增规则「${name}」（${action}），${affected} 台设备待同步`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })

  res.status(201).json({ ok: true, affectedNodes: affected })
})

router.patch('/acl/:id', requireMinRole('admin'), (req, res) => {
  const row = db
    .prepare('SELECT * FROM acl_rules WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.user.ws)
  if (!row) return res.status(404).json({ error: '规则不存在' })

  const { name, action, protocol, chainType, srcCidr, dstCidr, ports, priority, enabled } =
    req.body || {}
  if (action && !['allow', 'deny'].includes(action)) {
    return res.status(400).json({ error: '动作只能是允许或拒绝' })
  }
  if (protocol && !PROTOCOLS.includes(protocol)) {
    return res.status(400).json({ error: '协议取值不合法' })
  }
  if (chainType && !CHAIN_TYPES.includes(chainType)) {
    return res.status(400).json({ error: '作用于取值不合法' })
  }

  db.prepare(
    `UPDATE acl_rules SET name = ?, action = ?, protocol = ?, chain_type = ?, src_cidr = ?,
       dst_cidr = ?, ports = ?, priority = ?, enabled = ? WHERE id = ?`
  ).run(
    name ? String(name).trim() : row.name,
    action || row.action,
    protocol || row.protocol,
    chainType || row.chain_type || 'forward',
    srcCidr || row.src_cidr,
    dstCidr || row.dst_cidr,
    ports ?? row.ports,
    priority !== undefined ? Number(priority) : row.priority,
    enabled === undefined ? row.enabled : enabled ? 1 : 0,
    row.id
  )

  const affected = bumpNetworkNodesConfig(row.network_id, `更新访问控制规则 ${row.name}`, req.user.username)

  logAudit({
    username: req.user.username,
    action: 'acl_update',
    targetType: 'acl',
    targetId: row.id,
    detail: `更新规则「${row.name}」，${affected} 台设备待同步`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })

  res.json({ ok: true, affectedNodes: affected })
})

router.delete('/acl/:id', requireMinRole('admin'), (req, res) => {
  const row = db
    .prepare('SELECT * FROM acl_rules WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.user.ws)
  if (!row) return res.status(404).json({ error: '规则不存在' })

  db.prepare('DELETE FROM acl_rules WHERE id = ?').run(row.id)
  const affected = bumpNetworkNodesConfig(row.network_id, `删除访问控制规则 ${row.name}`, req.user.username)

  logAudit({
    username: req.user.username,
    action: 'acl_delete',
    targetType: 'acl',
    targetId: row.id,
    detail: `删除规则「${row.name}」，${affected} 台设备待同步`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })

  res.json({ ok: true, affectedNodes: affected })
})

/** 查看某个网络的 ACL 编译结果 */
router.get('/acl/:networkId/preview', (req, res) => {
  const network = ownNetwork(req, req.params.networkId)
  if (!network) return res.status(404).json({ error: '网络不存在' })
  res.type('text/plain').send(compileAcl(network.id) || '# 当前网络没有启用的访问控制规则\n')
})

export default router

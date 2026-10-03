import express from 'express'
import { db } from '../db.js'
import { requireAuth } from '../auth.js'
import { quotaOverview, quotaOf } from '../services/quota.js'
import { nodeIdsOf, diffSamples, sinceISO, samplesBetween, statusOf, bucketKey } from '../services/traffic.js'

const router = express.Router()
router.use(requireAuth)

function localDayStart(daysAgo = 0) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - daysAgo)
  return d.toISOString()
}

function workspaceOf(id) {
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id)
}

/** 用量总览：套餐配额 + 流量 + 资源分布 */
router.get('/', (req, res) => {
  const workspace = workspaceOf(req.user.ws)
  if (!workspace) return res.status(404).json({ error: '工作区不存在' })

  const ids = nodeIdsOf(req.user.ws)
  const nodes = ids.length
    ? db
        .prepare(`SELECT * FROM nodes WHERE id IN (${ids.map(() => '?').join(',')})`)
        .all(...ids)
    : []

  const windowOf = (since) => {
    const deltas = diffSamples(samplesBetween(ids, since))
    return {
      rx: deltas.reduce((s, d) => s + d.rx, 0),
      tx: deltas.reduce((s, d) => s + d.tx, 0),
      samples: deltas.length,
    }
  }

  const today = windowOf(localDayStart(0))
  const week = windowOf(localDayStart(6))
  const month = windowOf(sinceISO(30 * 24))

  const totalRx = nodes.reduce((s, n) => s + (Number(n.rx_bytes) || 0), 0)
  const totalTx = nodes.reduce((s, n) => s + (Number(n.tx_bytes) || 0), 0)

  // 按网络分布
  const networks = db
    .prepare('SELECT * FROM networks WHERE workspace_id = ? ORDER BY id')
    .all(req.user.ws)
  const networkUsage = networks.map((net) => {
    const netIds = ids.filter((id) => nodes.find((n) => n.id === id)?.network_id === net.id)
    const deltas = diffSamples(samplesBetween(netIds, localDayStart(6)))
    return {
      id: net.id,
      name: net.name,
      cidr: net.cidr,
      nodeTotal: netIds.length,
      nodeOnline: nodes.filter((n) => n.network_id === net.id && statusOf(n) === 'online').length,
      weekRx: deltas.reduce((s, d) => s + d.rx, 0),
      weekTx: deltas.reduce((s, d) => s + d.tx, 0),
      subnetRoutes: db
        .prepare('SELECT COUNT(*) AS c FROM subnet_routes WHERE network_id = ?')
        .get(net.id).c,
      aclRules: db
        .prepare('SELECT COUNT(*) AS c FROM acl_rules WHERE network_id = ? AND enabled = 1')
        .get(net.id).c,
    }
  })

  const keys = db
    .prepare("SELECT COUNT(*) AS c FROM access_keys WHERE workspace_id = ? AND status = 'active'")
    .get(req.user.ws)
  const keyRegistrations = db
    .prepare('SELECT COALESCE(SUM(register_count), 0) AS c FROM access_keys WHERE workspace_id = ?')
    .get(req.user.ws)

  const audit7d = db
    .prepare('SELECT COUNT(*) AS c FROM audit_logs WHERE workspace_id = ? AND created_at >= ?')
    .get(req.user.ws, sinceISO(7 * 24)).c

  const plan = quotaOf(workspace.plan)
  res.json({
    workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug, plan: workspace.plan, planLabel: plan.label },
    quota: quotaOverview(workspace.id, workspace.plan),
    traffic: { today, week, month, totalRx, totalTx, total: totalRx + totalTx },
    networks: networkUsage,
    keys: { active: keys.c, registrations: keyRegistrations.c },
    members: db.prepare('SELECT COUNT(*) AS c FROM users WHERE workspace_id = ?').get(req.user.ws).c,
    audit7d,
  })
})

/** 按天流量明细 */
router.get('/daily', (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 90)
  const ids = nodeIdsOf(req.user.ws, req.query.networkId)
  const deltas = diffSamples(samplesBetween(ids, sinceISO(days, 'day')))

  const map = new Map()
  for (const d of deltas) {
    const key = bucketKey(d.at, 'day')
    const cur = map.get(key) || { label: key, rx: 0, tx: 0 }
    cur.rx += d.rx
    cur.tx += d.tx
    map.set(key, cur)
  }

  const buckets = [...map.values()].sort((a, b) => (a.label < b.label ? -1 : 1))
  res.json({ unit: 'day', days, buckets })
})

/** 导出用量 CSV（便于对账） */
router.get('/export.csv', (req, res) => {
  const ids = nodeIdsOf(req.user.ws)
  const nodes = ids.length
    ? db
        .prepare(`SELECT * FROM nodes WHERE id IN (${ids.map(() => '?').join(',')})`)
        .all(...ids)
    : []
  const networks = {}
  for (const n of db.prepare('SELECT id, name FROM networks').all()) networks[n.id] = n.name

  const deltas = diffSamples(samplesBetween(ids, sinceISO(30 * 24)))
  const perNode = new Map()
  for (const d of deltas) {
    const cur = perNode.get(d.nodeId) || { rx: 0, tx: 0 }
    cur.rx += d.rx
    cur.tx += d.tx
    perNode.set(d.nodeId, cur)
  }

  const lines = ['节点名称,所属网络,虚拟IP,状态,近30天接收字节,近30天发送字节,累计接收字节,累计发送字节,最近上报']
  for (const n of nodes) {
    const a = perNode.get(n.id) || { rx: 0, tx: 0 }
    lines.push(
      [
        n.name,
        networks[n.network_id] || '',
        n.virtual_ip,
        statusOf(n),
        a.rx,
        a.tx,
        Number(n.rx_bytes) || 0,
        Number(n.tx_bytes) || 0,
        n.last_seen || '',
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    )
  }

  res
    .type('text/csv; charset=utf-8')
    .set('Content-Disposition', 'attachment; filename="xiangwang-usage.csv"')
    .send('\uFEFF' + lines.join('\n') + '\n')
})

export default router

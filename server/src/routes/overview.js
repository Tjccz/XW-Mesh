import express from 'express'
import { db } from '../db.js'
import { requireAuth } from '../auth.js'
import { statusOf, nodeIdsOf, diffSamples, samplesBetween, sinceISO } from '../services/traffic.js'
import { quotaOverview, quotaOf } from '../services/quota.js'
import { DEFAULT_ET_VERSION } from '../services/provision.js'

const router = express.Router()
router.use(requireAuth)

function localDayStart(daysAgo = 0) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - daysAgo)
  return d.toISOString()
}

router.get('/', (req, res) => {
  const ws = req.user.ws
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(ws)
  const ids = nodeIdsOf(ws)
  const nodes = ids.length
    ? db.prepare(`SELECT * FROM nodes WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
    : []

  const byStatus = { online: 0, offline: 0, pending: 0, blocked: 0 }
  for (const n of nodes) byStatus[statusOf(n)] += 1

  const networks = db
    .prepare('SELECT * FROM networks WHERE workspace_id = ? ORDER BY id DESC')
    .all(ws)

  const networkRows = networks.slice(0, 8).map((net) => {
    const inNet = nodes.filter((n) => n.network_id === net.id)
    return {
      id: net.id,
      name: net.name,
      cidr: net.cidr,
      region: net.region || 'cn',
      nodeTotal: inNet.length,
      nodeOnline: inNet.filter((n) => statusOf(n) === 'online').length,
    }
  })

  const todayDeltas = diffSamples(samplesBetween(ids, localDayStart(0)))
  const weekDeltas = diffSamples(samplesBetween(ids, sinceISO(7 * 24)))

  const recentAudit = db
    .prepare('SELECT * FROM audit_logs WHERE workspace_id = ? ORDER BY id DESC LIMIT 8')
    .all(ws)
    .map((r) => ({
      id: r.id,
      username: r.username,
      action: r.action,
      detail: r.detail,
      createdAt: r.created_at,
    }))

  const topNodes = nodes
    .map((n) => ({ n, total: (Number(n.rx_bytes) || 0) + (Number(n.tx_bytes) || 0) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5)
    .map(({ n, total }) => ({
      id: n.id,
      name: n.name,
      networkName: networks.find((x) => x.id === n.network_id)?.name || '',
      status: statusOf(n),
      virtualIp: n.virtual_ip,
      peerCount: n.peer_count,
      traffic: total,
    }))

  const plan = quotaOf(workspace?.plan || 'selfhost')

  res.json({
    stats: {
      networks: networks.length,
      nodes: nodes.length,
      online: byStatus.online,
      offline: byStatus.offline,
      pending: byStatus.pending,
      blocked: byStatus.blocked,
      keys: db
        .prepare("SELECT COUNT(*) AS c FROM access_keys WHERE workspace_id = ? AND status = 'active'")
        .get(ws).c,
      aclRules: db
        .prepare('SELECT COUNT(*) AS c FROM acl_rules WHERE workspace_id = ? AND enabled = 1')
        .get(ws).c,
      subnets: db.prepare('SELECT COUNT(*) AS c FROM subnet_routes WHERE workspace_id = ?').get(ws).c,
      members: db.prepare('SELECT COUNT(*) AS c FROM users WHERE workspace_id = ?').get(ws).c,
    },
    traffic: {
      todayRx: todayDeltas.reduce((s, d) => s + d.rx, 0),
      todayTx: todayDeltas.reduce((s, d) => s + d.tx, 0),
      weekRx: weekDeltas.reduce((s, d) => s + d.rx, 0),
      weekTx: weekDeltas.reduce((s, d) => s + d.tx, 0),
      totalRx: nodes.reduce((s, n) => s + (Number(n.rx_bytes) || 0), 0),
      totalTx: nodes.reduce((s, n) => s + (Number(n.tx_bytes) || 0), 0),
    },
    workspace: workspace
      ? {
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
          plan: workspace.plan,
          planLabel: plan.label,
        }
      : null,
    quota: workspace ? quotaOverview(ws, workspace.plan) : [],
    networks: networkRows,
    topNodes,
    recentAudit,
    system: {
      version: process.env.XW_VERSION || '1.1.0',
      etVersion: DEFAULT_ET_VERSION,
      uptimeSeconds: Math.floor(process.uptime()),
      nodeVersion: process.version,
    },
  })
})

export default router

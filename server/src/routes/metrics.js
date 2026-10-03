import express from 'express'
import { db } from '../db.js'
import { requireAuth } from '../auth.js'
import {
  statusOf,
  nodeIdsOf,
  diffSamples,
  bucketKey,
  sinceISO,
  samplesBetween,
} from '../services/traffic.js'

const router = express.Router()
router.use(requireAuth)

function nodesIn(ids) {
  if (!ids.length) return []
  return db
    .prepare(`SELECT * FROM nodes WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids)
}

/* ------------------------------ 概览 ------------------------------ */

router.get('/summary', (req, res) => {
  const ids = nodeIdsOf(req.user.ws)
  const nodes = nodesIn(ids)

  const byStatus = { online: 0, offline: 0, pending: 0, blocked: 0 }
  for (const n of nodes) byStatus[statusOf(n)] += 1

  const totalRx = nodes.reduce((s, n) => s + (Number(n.rx_bytes) || 0), 0)
  const totalTx = nodes.reduce((s, n) => s + (Number(n.tx_bytes) || 0), 0)
  const activeTunnels = nodes
    .filter((n) => statusOf(n) === 'online')
    .reduce((s, n) => s + (Number(n.peer_count) || 0), 0)

  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 720)
  const deltas = diffSamples(samplesBetween(ids, sinceISO(hours)))

  const lastSampleAt = ids.length
    ? db
        .prepare(
          `SELECT MAX(sampled_at) AS t FROM traffic_samples WHERE node_id IN (${ids
            .map(() => '?')
            .join(',')})`
        )
        .get(...ids)?.t || null
    : null

  res.json({
    nodes: { total: nodes.length, ...byStatus },
    totalRx,
    totalTx,
    totalTraffic: totalRx + totalTx,
    periodRx: deltas.reduce((s, d) => s + d.rx, 0),
    periodTx: deltas.reduce((s, d) => s + d.tx, 0),
    periodHours: hours,
    activeTunnels,
    lastSampleAt,
    onlineRate: nodes.length ? Math.round((byStatus.online / nodes.length) * 100) : 0,
  })
})

/* ------------------------------ 时间序列 ------------------------------ */

router.get('/series', (req, res) => {
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 720)
  const unit = req.query.unit === 'day' || hours > 72 ? 'day' : 'hour'
  const ids = nodeIdsOf(req.user.ws, req.query.networkId)

  const deltas = diffSamples(samplesBetween(ids, sinceISO(hours)))
  const map = new Map()
  for (const d of deltas) {
    const key = bucketKey(d.at, unit)
    const cur = map.get(key) || { label: key, rx: 0, tx: 0 }
    cur.rx += d.rx
    cur.tx += d.tx
    map.set(key, cur)
  }
  const buckets = [...map.values()].sort((a, b) => (a.label < b.label ? -1 : 1))

  res.json({
    unit,
    buckets,
    totalRx: buckets.reduce((s, b) => s + b.rx, 0),
    totalTx: buckets.reduce((s, b) => s + b.tx, 0),
  })
})

/* ------------------------------ 节点排行 ------------------------------ */

router.get('/nodes', (req, res) => {
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 720)
  const ids = nodeIdsOf(req.user.ws, req.query.networkId)
  const deltas = diffSamples(samplesBetween(ids, sinceISO(hours)))

  const agg = new Map()
  for (const d of deltas) {
    const cur = agg.get(d.nodeId) || { rx: 0, tx: 0, samples: 0 }
    cur.rx += d.rx
    cur.tx += d.tx
    cur.samples += 1
    agg.set(d.nodeId, cur)
  }

  const networks = {}
  for (const n of db.prepare('SELECT id, name FROM networks').all()) networks[n.id] = n.name

  const items = nodesIn(ids)
    .map((n) => {
      const a = agg.get(n.id) || { rx: 0, tx: 0, samples: 0 }
      return {
        id: n.id,
        name: n.name,
        networkId: n.network_id,
        networkName: networks[n.network_id] || '',
        virtualIp: n.virtual_ip,
        status: statusOf(n),
        peerCount: n.peer_count,
        coreVersion: n.core_version,
        lastSeen: n.last_seen,
        periodRx: a.rx,
        periodTx: a.tx,
        periodTotal: a.rx + a.tx,
        totalRx: Number(n.rx_bytes) || 0,
        totalTx: Number(n.tx_bytes) || 0,
        samples: a.samples,
      }
    })
    .sort((a, b) => b.periodTotal - a.periodTotal)

  res.json({ items, hours })
})

/** 单节点曲线 */
router.get('/nodes/:id/series', (req, res) => {
  const node = db
    .prepare('SELECT * FROM nodes WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.user.ws)
  if (!node) return res.status(404).json({ error: '节点不存在' })

  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 720)
  const unit = hours > 72 ? 'day' : 'hour'

  const rows = db
    .prepare('SELECT * FROM traffic_samples WHERE node_id = ? AND sampled_at >= ? ORDER BY sampled_at')
    .all(node.id, sinceISO(hours))
  const deltas = diffSamples(rows)

  const map = new Map()
  for (const d of deltas) {
    const key = bucketKey(d.at, unit)
    const cur = map.get(key) || { label: key, rx: 0, tx: 0 }
    cur.rx += d.rx
    cur.tx += d.tx
    map.set(key, cur)
  }

  res.json({
    unit,
    node: {
      id: node.id,
      name: node.name,
      virtualIp: node.virtual_ip,
      status: statusOf(node),
      peerCount: node.peer_count,
    },
    buckets: [...map.values()].sort((a, b) => (a.label < b.label ? -1 : 1)),
  })
})

/** 节点最近采样明细 */
router.get('/nodes/:id/samples', (req, res) => {
  const node = db
    .prepare('SELECT * FROM nodes WHERE id = ? AND workspace_id = ?')
    .get(req.params.id, req.user.ws)
  if (!node) return res.status(404).json({ error: '节点不存在' })

  const rows = db
    .prepare('SELECT * FROM traffic_samples WHERE node_id = ? ORDER BY sampled_at DESC LIMIT 60')
    .all(node.id)

  res.json({
    items: rows.map((r) => ({
      rxBytes: r.rx_bytes,
      txBytes: r.tx_bytes,
      peerCount: r.peer_count,
      sampledAt: r.sampled_at,
    })),
  })
})

export default router

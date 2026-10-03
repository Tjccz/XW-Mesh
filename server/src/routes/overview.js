import express from 'express'
import { db } from '../db.js'
import { requireAuth } from '../auth.js'

const router = express.Router()
router.use(requireAuth)

const ONLINE_WINDOW_MS = 120 * 1000

router.get('/', (req, res) => {
  const networkCount = db.prepare('SELECT COUNT(*) AS c FROM networks').get().c
  const nodes = db.prepare('SELECT * FROM nodes').all()

  const online = nodes.filter(
    (n) => n.last_seen && Date.now() - new Date(n.last_seen).getTime() <= ONLINE_WINDOW_MS
  )
  const offline = nodes.filter(
    (n) => n.last_seen && Date.now() - new Date(n.last_seen).getTime() > ONLINE_WINDOW_MS
  )
  const pending = nodes.filter((n) => !n.last_seen)

  const recentAudit = db
    .prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 8')
    .all()
    .map((r) => ({
      id: r.id,
      username: r.username,
      action: r.action,
      detail: r.detail,
      createdAt: r.created_at,
    }))

  const networkRows = db.prepare('SELECT * FROM networks ORDER BY id DESC LIMIT 6').all()
  const stat = {}
  for (const n of nodes) {
    stat[n.network_id] = stat[n.network_id] || { total: 0, online: 0 }
    stat[n.network_id].total += 1
    if (n.last_seen && Date.now() - new Date(n.last_seen).getTime() <= ONLINE_WINDOW_MS) {
      stat[n.network_id].online += 1
    }
  }

  res.json({
    stats: {
      networks: networkCount,
      nodes: nodes.length,
      online: online.length,
      offline: offline.length,
      pending: pending.length,
    },
    networks: networkRows.map((n) => ({
      id: n.id,
      name: n.name,
      cidr: n.cidr,
      nodeTotal: stat[n.id]?.total || 0,
      nodeOnline: stat[n.id]?.online || 0,
    })),
    recentAudit,
  })
})

export default router

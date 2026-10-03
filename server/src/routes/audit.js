import express from 'express'
import { db } from '../db.js'
import { requireAuth } from '../auth.js'

const router = express.Router()
router.use(requireAuth)

router.get('/', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500)
  const rows = db
    .prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?')
    .all(limit)

  res.json({
    items: rows.map((r) => ({
      id: r.id,
      username: r.username,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      detail: r.detail,
      ip: r.ip,
      createdAt: r.created_at,
    })),
  })
})

export default router

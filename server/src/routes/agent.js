import express from 'express'
import { db, now, orNull } from '../db.js'
import { buildConfigEnv } from '../services/provision.js'

const router = express.Router()

function findByToken(token) {
  if (!token) return null
  return db.prepare('SELECT * FROM nodes WHERE token = ?').get(String(token))
}

/** 节点心跳：上报运行状态 */
router.post('/heartbeat', (req, res) => {
  const { token, hostname, coreVersion, peerCount, platform, reportedIp } = req.body || {}
  const node = findByToken(token)
  if (!node) return res.status(401).json({ error: '节点令牌无效' })

  db.prepare(
    `UPDATE nodes
     SET status = 'online', last_seen = ?, core_version = ?, peer_count = ?,
         platform = ?, reported_ip = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    now(),
    orNull(coreVersion),
    Number(peerCount) || 0,
    orNull(platform || hostname),
    orNull(reportedIp),
    now(),
    node.id
  )

  const fresh = db.prepare('SELECT config_version FROM nodes WHERE id = ?').get(node.id)
  res.json({ ok: true, configVersion: fresh.config_version })
})

/** 节点拉取当前配置（纯文本，便于节点侧直接比对覆盖） */
router.get('/config', (req, res) => {
  const node = findByToken(req.query.token)
  if (!node) return res.status(401).type('text/plain').send('invalid token')
  const network = db.prepare('SELECT * FROM networks WHERE id = ?').get(node.network_id)
  if (!network) return res.status(404).type('text/plain').send('network missing')
  res.type('text/plain').send(buildConfigEnv(network, node) + '\n')
})

export default router

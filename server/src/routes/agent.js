import express from 'express'
import crypto from 'node:crypto'
import { db, now, orNull } from '../db.js'
import { buildNodeConfigToml, subnetProxyOf, snapshotNode } from '../services/config.js'
import { buildInstallScript, allocateVirtualIp, DEFAULT_RPC_PORT } from '../services/provision.js'
import { logAudit, clientIp } from '../services/audit.js'
import { checkQuota } from '../services/quota.js'

const router = express.Router()

const TRAFFIC_INTERVAL_MS = 55 * 1000

function consoleUrl(req) {
  return (process.env.CONSOLE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')
}

function findByToken(token) {
  if (!token) return null
  return db.prepare('SELECT * FROM nodes WHERE token = ?').get(String(token))
}

function findByKey(key) {
  if (!key) return null
  return db.prepare('SELECT * FROM access_keys WHERE key = ?').get(String(key))
}

/** 接入密钥是否仍可用；返回 null 表示可用，否则返回原因 */
function keyBlockReason(keyRow) {
  if (!keyRow) return '密钥不存在'
  if (keyRow.status === 'revoked') return '密钥已被吊销'
  if (keyRow.expires_at && new Date(keyRow.expires_at).getTime() < Date.now()) return '密钥已过期'
  if (keyRow.max_nodes > 0 && keyRow.used_count >= keyRow.max_nodes) return '密钥已达设备上限'
  return null
}

/* ---------------------------- 接入脚本分发 ---------------------------- */

/**
 * 统一接入脚本入口：
 *   /api/agent/install.sh?token=xxx  预置节点模式
 *   /api/agent/install.sh?key=ek_xxx 密钥自助模式
 */
router.get('/install.sh', (req, res) => {
  const token = req.query.token
  const key = req.query.key

  if (token) {
    const node = findByToken(token)
    if (!node) return res.status(401).type('text/plain; charset=utf-8').send('error=节点令牌无效\n')
    const network = db.prepare('SELECT * FROM networks WHERE id = ?').get(node.network_id)
    if (!network) return res.status(404).type('text/plain; charset=utf-8').send('error=网络不存在\n')
    return res
      .type('text/plain; charset=utf-8')
      .send(buildInstallScript({ network, node, consoleUrl: consoleUrl(req) }))
  }

  if (key) {
    const keyRow = findByKey(key)
    const reason = keyBlockReason(keyRow)
    if (reason) return res.status(403).type('text/plain; charset=utf-8').send(`error=${reason}\n`)
    const network = db.prepare('SELECT * FROM networks WHERE id = ?').get(keyRow.network_id)
    if (!network) return res.status(404).type('text/plain; charset=utf-8').send('error=网络不存在\n')
    return res
      .type('text/plain; charset=utf-8')
      .send(buildInstallScript({ network, accessKey: keyRow.key, consoleUrl: consoleUrl(req) }))
  }

  return res.status(400).type('text/plain; charset=utf-8').send('error=缺少 token 或 key 参数\n')
})

/* ------------------------------ 节点注册 ------------------------------ */

function uniqueNodeName(networkId, base) {
  const clean = String(base || 'device')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'device'
  if (!db.prepare('SELECT id FROM nodes WHERE network_id = ? AND name = ?').get(networkId, clean)) {
    return clean
  }
  for (let i = 2; i < 200; i++) {
    const candidate = `${clean}-${i}`
    if (!db.prepare('SELECT id FROM nodes WHERE network_id = ? AND name = ?').get(networkId, candidate)) {
      return candidate
    }
  }
  return `${clean}-${crypto.randomBytes(3).toString('hex')}`
}

/** 以接入密钥自助注册，返回纯文本 KEY=VALUE，方便 shell 直接解析 */
function handleRegister(req, res) {
  const keyValue = req.query.key || req.body?.key
  const keyRow = findByKey(keyValue)
  const reason = keyBlockReason(keyRow)
  if (reason) {
    return res.status(403).type('text/plain; charset=utf-8').send(`error=${reason}\n`)
  }

  const network = db.prepare('SELECT * FROM networks WHERE id = ?').get(keyRow.network_id)
  if (!network) return res.status(404).type('text/plain; charset=utf-8').send('error=网络不存在\n')

  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(keyRow.workspace_id)
  const quotaError = checkQuota(keyRow.workspace_id, workspace?.plan || 'selfhost', 'nodes')
  if (quotaError) {
    return res.status(403).type('text/plain; charset=utf-8').send(`error=${quotaError}\n`)
  }

  const hostname = String(req.query.hostname || req.body?.hostname || '').trim()
  const arch = String(req.query.arch || req.body?.arch || '').trim()
  const reportedIp = String(req.query.reportedIp || req.body?.reportedIp || '').trim()

  const name = uniqueNodeName(network.id, hostname || `device-${keyRow.id}`)
  const used = db
    .prepare('SELECT virtual_ip FROM nodes WHERE network_id = ?')
    .all(network.id)
    .map((r) => r.virtual_ip)
  const ip = allocateVirtualIp(network.cidr, used)
  if (!ip) {
    return res.status(409).type('text/plain; charset=utf-8').send('error=网段内已无可用地址\n')
  }

  const token = crypto.randomBytes(24).toString('hex')
  const info = db
    .prepare(
      `INSERT INTO nodes
         (workspace_id, network_id, access_key_id, name, virtual_ip, token, status,
          config_version, platform, reported_ip, registered_at, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      keyRow.workspace_id,
      network.id,
      keyRow.id,
      name,
      ip,
      token,
      orNull(arch),
      orNull(reportedIp),
      now(),
      `由接入密钥「${keyRow.name}」自动注册`,
      now(),
      now()
    )

  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(Number(info.lastInsertRowid))
  db.prepare(
    'UPDATE access_keys SET used_count = used_count + 1, register_count = register_count + 1 WHERE id = ?'
  ).run(keyRow.id)

  snapshotNode(node, network, `密钥「${keyRow.name}」自助注册`, keyRow.name, keyRow.workspace_id)

  logAudit({
    username: `key:${keyRow.name}`,
    action: 'node_register',
    targetType: 'node',
    targetId: node.id,
    detail: `设备 ${hostname || arch || 'unknown'} 通过密钥「${keyRow.name}」接入网络 ${network.name}，分配 IP ${ip}`,
    ip: clientIp(req),
    workspaceId: keyRow.workspace_id,
  })

  res
    .type('text/plain; charset=utf-8')
    .send(
      [
        `NODE_TOKEN=${token}`,
        `NODE_NAME=${node.name}`,
        `VIRTUAL_IP=${ip}`,
        `NETWORK_NAME=${network.name}`,
        `RPC_PORT=${DEFAULT_RPC_PORT}`,
        `CONFIG_URL=${consoleUrl(req)}/api/agent/config?token=${token}`,
        '',
      ].join('\n')
    )
}

router.get('/register', handleRegister)
router.post('/register', handleRegister)

/* ------------------------------ 心跳上报 ------------------------------ */

router.post('/heartbeat', (req, res) => {
  const { token, hostname, coreVersion, peerCount, platform, reportedIp, rxBytes, txBytes } =
    req.body || {}
  const node = findByToken(token)
  if (!node) return res.status(401).json({ error: '节点令牌无效' })

  // 密钥被吊销 / 过期 / 超限，或节点被控制台踢下线：通知节点停止服务
  if (node.access_key_id) {
    const keyRow = db.prepare('SELECT * FROM access_keys WHERE id = ?').get(node.access_key_id)
    if (keyBlockReason(keyRow)) {
      db.prepare("UPDATE nodes SET status = 'blocked', updated_at = ? WHERE id = ?").run(now(), node.id)
      return res.json({ ok: false, revoked: true, reason: keyBlockReason(keyRow) })
    }
  }
  if (node.status === 'blocked') {
    return res.json({ ok: false, revoked: true, reason: '节点已被管理员停止' })
  }

  const rx = Math.max(0, Number(rxBytes) || 0)
  const tx = Math.max(0, Number(txBytes) || 0)
  const peers = Math.max(0, Number(peerCount) || 0)
  const stamp = now()

  db.prepare(
    `UPDATE nodes
     SET status = 'online', last_seen = ?, core_version = ?, peer_count = ?,
         platform = ?, reported_ip = ?, rx_bytes = ?, tx_bytes = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    stamp,
    orNull(coreVersion),
    peers,
    orNull(platform || hostname),
    orNull(reportedIp),
    rx,
    tx,
    stamp,
    node.id
  )

  // 采样入库：限制最小间隔，避免心跳过密把库写大
  const last = node.last_traffic_at ? new Date(node.last_traffic_at).getTime() : 0
  if (Date.now() - last >= TRAFFIC_INTERVAL_MS) {
    db.prepare(
      `INSERT INTO traffic_samples (node_id, rx_bytes, tx_bytes, peer_count, sampled_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(node.id, rx, tx, peers, stamp)
    db.prepare('UPDATE nodes SET last_traffic_at = ? WHERE id = ?').run(stamp, node.id)
  }

  const fresh = db.prepare('SELECT config_version FROM nodes WHERE id = ?').get(node.id)
  res.json({
    ok: true,
    revoked: false,
    configVersion: fresh.config_version,
    serverTime: stamp,
    syncInterval: 30,
  })
})

/* ------------------------------ 配置下发 ------------------------------ */

/** 节点拉取当前配置（TOML 纯文本，节点侧直接比对覆盖） */
router.get('/config', (req, res) => {
  const node = findByToken(req.query.token)
  if (!node) return res.status(401).type('text/plain; charset=utf-8').send('# invalid token\n')

  if (node.access_key_id) {
    const keyRow = db.prepare('SELECT * FROM access_keys WHERE id = ?').get(node.access_key_id)
    if (keyBlockReason(keyRow)) {
      return res.status(403).type('text/plain; charset=utf-8').send('# access key revoked\n')
    }
  }
  if (node.status === 'blocked') {
    return res.status(403).type('text/plain; charset=utf-8').send('# node blocked\n')
  }

  const network = db.prepare('SELECT * FROM networks WHERE id = ?').get(node.network_id)
  if (!network) return res.status(404).type('text/plain; charset=utf-8').send('# network missing\n')

  res.type('text/plain; charset=utf-8').send(
    buildNodeConfigToml(network, node, { rpcPort: DEFAULT_RPC_PORT })
  )
})

/* ------------------------------ 运维辅助 ------------------------------ */

/** 节点上报一次性的诊断信息（预留） */
router.post('/report', (req, res) => {
  const node = findByToken(req.body?.token)
  if (!node) return res.status(401).json({ error: '节点令牌无效' })
  const detail = JSON.stringify(req.body?.detail || {}).slice(0, 2000)
  logAudit({
    username: `node:${node.name}`,
    action: 'node_report',
    targetType: 'node',
    targetId: node.id,
    detail,
    ip: clientIp(req),
    workspaceId: node.workspace_id,
  })
  res.json({ ok: true })
})

export default router

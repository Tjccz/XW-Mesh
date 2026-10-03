import express from 'express'
import crypto from 'node:crypto'
import { db, now } from '../db.js'
import { requireAuth, requireMinRole } from '../auth.js'
import { logAudit, clientIp } from '../services/audit.js'
import { allocateVirtualIp, buildInstallScript, buildConfigEnv, DEFAULT_RPC_PORT } from '../services/provision.js'
import { snapshotNode, subnetCidrsOf, identityOf } from '../services/config.js'
import { checkQuota } from '../services/quota.js'
import { statusOf } from '../services/traffic.js'

const router = express.Router()
router.use(requireAuth)

const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/

function getNode(id, workspaceId) {
  return db
    .prepare('SELECT * FROM nodes WHERE id = ? AND workspace_id = ?')
    .get(id, workspaceId)
}

function getNetwork(id) {
  return db.prepare('SELECT * FROM networks WHERE id = ?').get(id)
}

function consoleUrl(req) {
  return (process.env.CONSOLE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')
}

function shape(node, network) {
  const keyRow = node.access_key_id
    ? db.prepare('SELECT name, key FROM access_keys WHERE id = ?').get(node.access_key_id)
    : null
  return {
    id: node.id,
    networkId: node.network_id,
    networkName: network?.name || '',
    name: node.name,
    virtualIp: node.virtual_ip,
    token: node.token,
    identity: identityOf(node),
    status: statusOf(node),
    lastSeen: node.last_seen,
    coreVersion: node.core_version,
    peerCount: node.peer_count,
    platform: node.platform,
    reportedIp: node.reported_ip,
    configVersion: node.config_version,
    devName: node.dev_name || 'xwtun0',
    subnetProxy: subnetCidrsOf(node.id),
    accessKeyName: keyRow?.name || '',
    registeredAt: node.registered_at,
    note: node.note,
    rxBytes: Number(node.rx_bytes) || 0,
    txBytes: Number(node.tx_bytes) || 0,
    createdAt: node.created_at,
    updatedAt: node.updated_at,
  }
}

/** 各平台接入方式（预置节点，令牌已在脚本中） */
function provisionMethods(req, node, network) {
  const base = consoleUrl(req)
  const peers = String(network.peers || '').split(',')[0].trim()
  return {
    linux: {
      title: 'Linux 服务器 / NAS（systemd）',
      desc: '一条命令完成安装：下载核心、写配置、注册服务、开启心跳同步',
      command: `curl -fsSL "${base}/api/agent/install.sh?token=${node.token}" | sudo sh`,
    },
    docker: {
      title: 'Docker',
      desc: '容器内组网，需挂载 TUN 设备并授予网络权限',
      command: [
        `docker run -d --name xiangwang-${node.name} --restart unless-stopped \\`,
        `  --cap-add NET_ADMIN --cap-add NET_RAW \\`,
        `  --device /dev/net/tun:/dev/net/tun \\`,
        `  easytier/easytier:latest easytier-core \\`,
        `  --network-name ${network.name} \\`,
        `  --network-secret ${network.secret} \\`,
        `  --peers ${peers} \\`,
        `  --hostname ${node.name} \\`,
        `  --ipv4 ${node.virtual_ip}`,
      ].join('\n'),
    },
    openwrt: {
      title: 'OpenWrt / iStoreOS',
      desc: '在 LuCI 插件中按下面参数新建网络（密钥取自「网络管理」页）',
      command: [
        `opkg update && opkg install luci-app-easytier`,
        ``,
        `# 在「VPN → EasyTier」中填写：`,
        `#   network-name   : ${network.name}`,
        `#   network-secret : ${network.secret}`,
        `#   peers          : ${peers}`,
        `#   ipv4           : ${node.virtual_ip}`,
        `#   rpc-portal     : 127.0.0.1:${DEFAULT_RPC_PORT}`,
      ].join('\n'),
    },
    windows: {
      title: 'Windows / macOS 图形客户端',
      desc: '使用官方 GUI，新建网络后填入以下参数',
      command: [
        `网络名称：${network.name}`,
        `网络密钥：${network.secret}`,
        `对等节点：${peers}`,
        `虚拟 IP ：${node.virtual_ip}`,
        ``,
        `客户端下载：https://github.com/EasyTier/EasyTier/releases`,
      ].join('\n'),
    },
  }
}

router.get('/', (req, res) => {
  const { networkId, keyword, status } = req.query
  const where = ['workspace_id = ?']
  const params = [req.user.ws]
  if (networkId) {
    where.push('network_id = ?')
    params.push(Number(networkId))
  }
  if (keyword) {
    where.push('(name LIKE ? OR virtual_ip LIKE ? OR platform LIKE ?)')
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
  }

  const nodes = db
    .prepare(`SELECT * FROM nodes WHERE ${where.join(' AND ')} ORDER BY id DESC`)
    .all(...params)

  const networks = {}
  for (const n of db.prepare('SELECT * FROM networks WHERE workspace_id = ?').all(req.user.ws)) {
    networks[n.id] = n
  }

  let items = nodes.map((n) => shape(n, networks[n.network_id]))
  if (status) items = items.filter((i) => i.status === status)

  res.json({
    items,
    summary: {
      total: items.length,
      online: items.filter((i) => i.status === 'online').length,
      offline: items.filter((i) => i.status === 'offline').length,
      pending: items.filter((i) => i.status === 'pending').length,
      blocked: items.filter((i) => i.status === 'blocked').length,
    },
  })
})

router.post('/', requireMinRole('admin'), (req, res) => {
  const { networkId, name, virtualIp, note } = req.body || {}
  const network = db
    .prepare('SELECT * FROM networks WHERE id = ? AND workspace_id = ?')
    .get(networkId, req.user.ws)
  if (!network) return res.status(400).json({ error: '请选择有效的网络' })
  if (!name || !String(name).trim()) return res.status(400).json({ error: '请填写节点名称' })

  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.user.ws)
  const quotaError = checkQuota(req.user.ws, workspace.plan, 'nodes')
  if (quotaError) return res.status(403).json({ error: quotaError })

  const used = db
    .prepare('SELECT virtual_ip FROM nodes WHERE network_id = ?')
    .all(network.id)
    .map((r) => r.virtual_ip)

  const ip = virtualIp || allocateVirtualIp(network.cidr, used)
  if (!IP_RE.test(ip || '')) return res.status(400).json({ error: '虚拟 IP 格式不正确' })
  if (used.includes(ip)) return res.status(409).json({ error: `虚拟 IP ${ip} 已被占用` })

  const dupName = db
    .prepare('SELECT id FROM nodes WHERE network_id = ? AND name = ?')
    .get(network.id, String(name).trim())
  if (dupName) return res.status(409).json({ error: '该网络下已存在同名节点' })

  const token = crypto.randomBytes(24).toString('hex')
  const info = db
    .prepare(
      `INSERT INTO nodes
         (workspace_id, network_id, name, virtual_ip, token, status, config_version, note,
          dev_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 1, ?, 'xwtun0', ?, ?)`
    )
    .run(req.user.ws, network.id, String(name).trim(), ip, token, note || '', now(), now())

  const node = getNode(Number(info.lastInsertRowid), req.user.ws)
  snapshotNode(node, network, '初始配置', req.user.username, req.user.ws)

  logAudit({
    username: req.user.username,
    action: 'node_create',
    targetType: 'node',
    targetId: node.id,
    detail: `在网络 ${network.name} 中新增设备 ${node.name}（${ip}）`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })

  res.status(201).json({ item: shape(node, network) })
})

router.get('/:id', (req, res) => {
  const node = getNode(req.params.id, req.user.ws)
  if (!node) return res.status(404).json({ error: '节点不存在' })
  const network = getNetwork(node.network_id)
  res.json({
    item: shape(node, network),
    network: network
      ? { id: network.id, name: network.name, cidr: network.cidr, peers: network.peers, secret: network.secret }
      : null,
  })
})

router.patch('/:id', requireMinRole('admin'), (req, res) => {
  const node = getNode(req.params.id, req.user.ws)
  if (!node) return res.status(404).json({ error: '节点不存在' })
  const network = getNetwork(node.network_id)

  const { name, virtualIp, note } = req.body || {}
  if (virtualIp && virtualIp !== node.virtual_ip) {
    if (!IP_RE.test(virtualIp)) return res.status(400).json({ error: '虚拟 IP 格式不正确' })
    const dup = db
      .prepare('SELECT id FROM nodes WHERE network_id = ? AND virtual_ip = ? AND id != ?')
      .get(network.id, virtualIp, node.id)
    if (dup) return res.status(409).json({ error: `虚拟 IP ${virtualIp} 已被占用` })
  }
  if (name && name !== node.name) {
    const dup = db
      .prepare('SELECT id FROM nodes WHERE network_id = ? AND name = ? AND id != ?')
      .get(network.id, String(name).trim(), node.id)
    if (dup) return res.status(409).json({ error: '该网络下已存在同名节点' })
  }

  const changedConfig = (name && name !== node.name) || (virtualIp && virtualIp !== node.virtual_ip)
  const nextVersion = changedConfig ? node.config_version + 1 : node.config_version

  db.prepare(
    `UPDATE nodes SET name = ?, virtual_ip = ?, note = ?, config_version = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    name ? String(name).trim() : node.name,
    virtualIp || node.virtual_ip,
    note ?? node.note,
    nextVersion,
    now(),
    node.id
  )

  const updated = getNode(node.id, req.user.ws)
  if (changedConfig) snapshotNode(updated, network, '节点参数变更', req.user.username, req.user.ws)

  logAudit({
    username: req.user.username,
    action: 'node_update',
    targetType: 'node',
    targetId: node.id,
    detail: changedConfig
      ? `更新设备 ${updated.name}，配置版本提升至 v${nextVersion}`
      : `更新设备 ${updated.name} 的备注`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })

  res.json({ item: shape(updated, network) })
})

/** 停止 / 恢复设备：停止后节点代理会在下一次心跳时收到指令并下线 */
router.post('/:id/block', requireMinRole('admin'), (req, res) => {
  const node = getNode(req.params.id, req.user.ws)
  if (!node) return res.status(404).json({ error: '节点不存在' })
  db.prepare("UPDATE nodes SET status = 'blocked', updated_at = ? WHERE id = ?").run(now(), node.id)
  logAudit({
    username: req.user.username,
    action: 'node_block',
    targetType: 'node',
    targetId: node.id,
    detail: `停止设备 ${node.name}`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })
  res.json({ ok: true })
})

router.post('/:id/unblock', requireMinRole('admin'), (req, res) => {
  const node = getNode(req.params.id, req.user.ws)
  if (!node) return res.status(404).json({ error: '节点不存在' })
  db.prepare("UPDATE nodes SET status = 'offline', updated_at = ? WHERE id = ?").run(now(), node.id)
  logAudit({
    username: req.user.username,
    action: 'node_unblock',
    targetType: 'node',
    targetId: node.id,
    detail: `恢复设备 ${node.name}`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })
  res.json({ ok: true })
})

/** 重发配置：提升版本号，节点会在 30 秒内重新拉取 */
router.post('/:id/resync', requireMinRole('admin'), (req, res) => {
  const node = getNode(req.params.id, req.user.ws)
  if (!node) return res.status(404).json({ error: '节点不存在' })
  const network = getNetwork(node.network_id)

  db.prepare('UPDATE nodes SET config_version = config_version + 1, updated_at = ? WHERE id = ?').run(
    now(),
    node.id
  )
  const updated = getNode(node.id, req.user.ws)
  snapshotNode(updated, network, '管理员触发配置重发', req.user.username, req.user.ws)

  logAudit({
    username: req.user.username,
    action: 'node_resync',
    targetType: 'node',
    targetId: node.id,
    detail: `向设备 ${node.name} 重发配置（v${updated.config_version}）`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })
  res.json({ item: shape(updated, network) })
})

router.delete('/:id', requireMinRole('admin'), (req, res) => {
  const node = getNode(req.params.id, req.user.ws)
  if (!node) return res.status(404).json({ error: '节点不存在' })
  db.prepare('DELETE FROM nodes WHERE id = ?').run(node.id)
  logAudit({
    username: req.user.username,
    action: 'node_delete',
    targetType: 'node',
    targetId: node.id,
    detail: `删除设备 ${node.name}`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })
  res.json({ ok: true })
})

/** 节点接入材料：脚本 + 各平台命令 */
router.get('/:id/provision', (req, res) => {
  const node = getNode(req.params.id, req.user.ws)
  if (!node) return res.status(404).json({ error: '节点不存在' })
  const network = getNetwork(node.network_id)
  if (!network) return res.status(404).json({ error: '网络不存在' })

  logAudit({
    username: req.user.username,
    action: 'node_provision',
    targetType: 'node',
    targetId: node.id,
    detail: `获取设备 ${node.name} 的接入材料`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })

  res.json({
    filename: `xiangwang-${node.name}.sh`,
    script: buildInstallScript({ network, node, consoleUrl: consoleUrl(req) }),
    configEnv: buildConfigEnv(network, node),
    consoleUrl: consoleUrl(req),
    methods: provisionMethods(req, node, network),
  })
})

/** 配置快照列表 */
router.get('/:id/configs', (req, res) => {
  const node = getNode(req.params.id, req.user.ws)
  if (!node) return res.status(404).json({ error: '节点不存在' })
  const rows = db
    .prepare('SELECT * FROM node_configs WHERE node_id = ? ORDER BY version DESC, id DESC LIMIT 50')
    .all(node.id)
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      version: r.version,
      config: JSON.parse(r.config_json),
      note: r.note,
      createdBy: r.created_by,
      createdAt: r.created_at,
      isCurrent: r.version === node.config_version,
    })),
    currentVersion: node.config_version,
  })
})

/** 回滚节点参数到某个历史版本 */
router.post('/:id/rollback', requireMinRole('admin'), (req, res) => {
  const node = getNode(req.params.id, req.user.ws)
  if (!node) return res.status(404).json({ error: '节点不存在' })
  const network = getNetwork(node.network_id)

  const { version } = req.body || {}
  const target = db
    .prepare('SELECT * FROM node_configs WHERE node_id = ? AND version = ? ORDER BY id DESC LIMIT 1')
    .get(node.id, Number(version))
  if (!target) return res.status(404).json({ error: '该配置版本不存在' })

  const config = JSON.parse(target.config_json)
  const nextVersion = node.config_version + 1

  db.prepare(
    'UPDATE nodes SET name = ?, virtual_ip = ?, config_version = ?, updated_at = ? WHERE id = ?'
  ).run(config.nodeName || node.name, config.virtualIp || node.virtual_ip, nextVersion, now(), node.id)

  const updated = getNode(node.id, req.user.ws)
  snapshotNode(updated, network, `回滚自 v${version}`, req.user.username, req.user.ws)

  logAudit({
    username: req.user.username,
    action: 'node_rollback',
    targetType: 'node',
    targetId: node.id,
    detail: `设备 ${updated.name} 参数回滚到 v${version}（新版本 v${nextVersion}）`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })

  res.json({ item: shape(updated, network), restoredFrom: Number(version) })
})

export default router

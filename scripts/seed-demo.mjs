#!/usr/bin/env node
/**
 * 演示数据脚本：为本地开发库补齐一套贴近真实场景的数据，便于查看控制台效果。
 * 幂等设计：网络存在则复用，只重建由本脚本产生的设备、密钥、子网与规则。
 *
 *   node --experimental-sqlite scripts/seed-demo.mjs          创建/刷新演示数据
 *   node --experimental-sqlite scripts/seed-demo.mjs --clean   只清理演示数据
 *
 * 流量采样会直接写入 SQLite 并回溯 7 天，便于观察 24 小时 / 7 天曲线。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

const BASE = (process.env.BASE || 'http://localhost:8080').replace(/\/$/, '') + '/api'
const USER = process.env.ADMIN_USER || 'admin'
const PASS = process.env.ADMIN_PASSWORD || 'xiangwang@2026'
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'server', 'data', 'xiangwang.db')
const CLEAN_ONLY = process.argv.includes('--clean')

const MARK = '演示数据'
const NETWORK_NAME = 'xiangwang-office'
const ACL_NAMES = ['允许办公网访问 NAS', '拒绝外网访问数据库端口']
const DEMO_NODE_NAMES = ['hq-gateway', 'changsha-nas', 'yueyang-pc', 'shenzhen-edge']
const ALERT_CHANNEL_NAMES = [
  '运维告警群 · 企业微信（演示）',
  '值班 Webhook（演示）',
  '周报邮件（演示）',
]
const ALERT_RULE_NAMES = [
  '设备离线超过 10 分钟（演示）',
  '接入密钥 7 天内到期（演示）',
  '配额用量超过 80%（演示）',
]

let token = ''

async function api(method, path, body, auth = true) {
  const headers = {}
  if (auth && token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const type = res.headers.get('content-type') || ''
  const data = type.includes('application/json') ? await res.json().catch(() => null) : await res.text()
  return { status: res.status, data }
}

async function clean() {
  // 告警规则先删（引用渠道），再删渠道
  const { data: alertRules } = await api('GET', '/alerts/rules')
  for (const r of alertRules?.items || []) {
    if (ALERT_RULE_NAMES.includes(r.name)) {
      await api('DELETE', `/alerts/rules/${r.id}`)
      console.log(`  清理告警规则 ${r.name}`)
    }
  }
  const { data: alertChannels } = await api('GET', '/alerts/channels')
  for (const c of alertChannels?.items || []) {
    if (ALERT_CHANNEL_NAMES.includes(c.name)) {
      await api('DELETE', `/alerts/channels/${c.id}`)
      console.log(`  清理通知渠道 ${c.name}`)
    }
  }

  const { data: keys } = await api('GET', '/access-keys')
  for (const k of keys?.items || []) {
    if (k.note?.includes(MARK)) {
      await api('DELETE', `/access-keys/${k.id}`)
      console.log(`  清理密钥 ${k.name}`)
    }
  }

  const { data: nets } = await api('GET', '/networks')
  for (const net of nets?.items || []) {
    const { data: subnets } = await api('GET', `/policies/subnets?networkId=${net.id}`)
    for (const s of subnets?.items || []) {
      if (s.description?.includes(MARK)) {
        await api('DELETE', `/policies/subnets/${s.id}`)
        console.log(`  清理子网路由 ${s.cidr}`)
      }
    }

    const { data: acl } = await api('GET', `/policies/acl?networkId=${net.id}`)
    for (const r of acl?.items || []) {
      if (ACL_NAMES.includes(r.name)) {
        await api('DELETE', `/policies/acl/${r.id}`)
        console.log(`  清理访问控制规则 ${r.name}`)
      }
    }

    const { data: nodes } = await api('GET', `/nodes?networkId=${net.id}`)
    for (const n of nodes?.items || []) {
      if (n.note?.includes(MARK) || DEMO_NODE_NAMES.includes(n.name)) {
        await api('DELETE', `/nodes/${n.id}`)
        console.log(`  清理设备 ${n.name}`)
      }
    }
  }
}

async function ensureNetwork() {
  const { data } = await api('GET', '/networks')
  const existing = (data?.items || []).find((n) => n.name === NETWORK_NAME)
  if (existing) {
    console.log(`  复用已有网络 ${existing.name} #${existing.id}（${existing.cidr}）`)
    return existing
  }
  const { status, data: created } = await api('POST', '/networks', {
    name: NETWORK_NAME,
    secret: 'XwOffice-2026-Secure',
    cidr: '10.144.144.0/24',
    peers: 'tcp://public.easytier.cn:11010',
    region: 'cn',
    relayMode: 'auto',
    description: '总部办公室内网',
  })
  if (status !== 201) throw new Error(`创建网络失败：${JSON.stringify(created)}`)
  console.log(`  新建网络 ${created.item.name} #${created.item.id}`)
  return created.item
}

/**
 * 直接写库生成回溯流量：每 30 分钟一个采样点，覆盖 7 天。
 * 离线设备在最后 4 小时停止增长，贴近真实观感。
 */
async function writeTraffic(nodes) {
  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    console.log('  跳过历史流量：当前 Node 需要 --experimental-sqlite 参数')
    return
  }
  if (!fs.existsSync(DB_PATH)) {
    console.log(`  跳过历史流量：未找到数据库 ${DB_PATH}`)
    return
  }

  const db = new DatabaseSync(DB_PATH)
  db.exec('PRAGMA busy_timeout = 8000')

  const STEP_MS = 30 * 60 * 1000
  const POINTS = 7 * 48 // 7 天 × 48 个半小时点
  const now = Date.now()

  const del = db.prepare('DELETE FROM traffic_samples WHERE node_id = ?')
  const ins = db.prepare(
    'INSERT INTO traffic_samples (node_id, rx_bytes, tx_bytes, peer_count, sampled_at) VALUES (?, ?, ?, ?, ?)'
  )
  const upd = db.prepare(
    'UPDATE nodes SET rx_bytes = ?, tx_bytes = ?, peer_count = ?, core_version = ?, platform = ?, last_seen = ?, last_traffic_at = ?, status = ? WHERE id = ?'
  )

  let rows = 0
  for (const node of nodes) {
    del.run(node.id)
    let rx = 512 * 1024
    let tx = 220 * 1024
    let lastRx = rx
    let lastTx = tx

    for (let i = POINTS; i >= 0; i--) {
      const at = now - i * STEP_MS
      const offlineTail = !node.up && i < 8 // 离线设备最后 4 小时不再增长
      if (!offlineTail) {
        // 每天白天流量高、深夜低，叠加一点随机
        const hour = new Date(at).getHours()
        const dayCurve = hour >= 8 && hour <= 22 ? 1.6 : 0.45
        const jitter = 0.55 + Math.random() * 0.95
        rx += Math.round(node.rx * dayCurve * jitter)
        tx += Math.round(node.tx * dayCurve * jitter)
      }
      lastRx = rx
      lastTx = tx
      ins.run(node.id, rx, tx, offlineTail ? 0 : node.peers, new Date(at).toISOString())
      rows++
    }

    const status = node.up ? 'online' : node.up === false ? 'offline' : 'pending'
    upd.run(
      lastRx,
      lastTx,
      node.up ? node.peers : 0,
      node.up === null ? null : '2.6.4',
      node.up === null ? null : 'Linux x86_64',
      node.up === null ? null : new Date(now - (node.up ? 0 : 5 * 3600) * 1000).toISOString(),
      new Date(now).toISOString(),
      status,
      node.id
    )
  }

  db.close()
  console.log(`  已回溯写入 ${rows} 条流量采样（7 天 · 30 分钟粒度）`)
}

/**
 * 告警演示数据：走接口建渠道与规则（顺带跑一遍校验），再直接写库回填历史事件。
 * 事件覆盖三档级别、触发中/已恢复、已确认/未确认，以及投递成功与失败两种结果。
 */
async function seedAlerts(nodes, network) {
  const channels = {}
  const chans = [
    {
      key: 'wecom',
      name: ALERT_CHANNEL_NAMES[0],
      type: 'wecom',
      config: { url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=demo-0000-1111' },
    },
    {
      key: 'webhook',
      name: ALERT_CHANNEL_NAMES[1],
      type: 'webhook',
      config: { url: 'https://ops.example.com/hooks/xw-mesh', token: 'demo-ops-token' },
    },
    {
      key: 'email',
      name: ALERT_CHANNEL_NAMES[2],
      type: 'email',
      config: {
        host: 'smtp.exmail.qq.com',
        port: 465,
        secure: true,
        user: 'alert@xiangwang.local',
        pass: 'demo-smtp-pass',
        from: 'alert@xiangwang.local',
        fromName: '湘网组网',
        to: 'ops@xiangwang.local',
      },
    },
  ]

  for (const c of chans) {
    const { status, data } = await api('POST', '/alerts/channels', {
      name: c.name,
      type: c.type,
      config: c.config,
    })
    if (status !== 201) {
      console.log(`  通知渠道 ${c.name} 创建失败：${data?.error}`)
      continue
    }
    channels[c.key] = data.item.id
    console.log(`  通知渠道 ${data.item.name}（${data.item.typeLabel}）`)
  }

  const allIds = Object.values(channels)
  if (!allIds.length) {
    console.log('  跳过告警演示数据：没有可用的通知渠道')
    return
  }

  const rules = [
    {
      key: 'offline',
      name: ALERT_RULE_NAMES[0],
      eventType: 'node_offline',
      threshold: 10,
      level: 'critical',
      silenceMinutes: 30,
      channelIds: [channels.wecom, channels.email].filter(Boolean),
    },
    {
      key: 'expiring',
      name: ALERT_RULE_NAMES[1],
      eventType: 'key_expiring',
      threshold: 7,
      level: 'warning',
      silenceMinutes: 720,
      channelIds: [channels.wecom, channels.webhook, channels.email].filter(Boolean),
    },
    {
      key: 'quota',
      name: ALERT_RULE_NAMES[2],
      eventType: 'quota_usage',
      threshold: 80,
      level: 'warning',
      silenceMinutes: 1440,
      channelIds: [channels.email].filter(Boolean),
    },
  ]

  const ruleIds = {}
  for (const r of rules) {
    const { status, data } = await api('POST', '/alerts/rules', { ...r, networkId: undefined })
    if (status !== 201) {
      console.log(`  告警规则 ${r.name} 创建失败：${data?.error}`)
      continue
    }
    ruleIds[r.key] = data.item.id
    console.log(`  告警规则 ${data.item.name}（${data.item.eventLabel} ≥ ${data.item.threshold}${data.item.unit}）`)
  }

  /* 演示事件必须与「真实成立的条件」对齐，否则 60 秒一轮的对账扫描会立刻把它们恢复掉。
     因此这里取真实设备 id，并专门造一个 5 天后到期的密钥（规则阈值 7 天 → 必然命中）。 */
  const nodeByName = (name) => (nodes || []).find((n) => n.name === name) || null
  const offlineNode = nodeByName('yueyang-pc')
  const pendingNode = nodeByName('shenzhen-edge')

  const { data: shortKeyRes } = await api('POST', '/access-keys', {
    networkId: network.id,
    name: '访客临时密钥',
    expiresInDays: 5,
    maxNodes: 2,
    note: `短期访客使用，到期自动告警（${MARK}）`,
  })
  const shortKey = shortKeyRes?.item
  if (shortKey) console.log(`  接入密钥 ${shortKey.name}（5 天后到期，用于演示到期告警）`)

  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    console.log('  跳过告警历史事件：当前 Node 需要 --experimental-sqlite 参数')
    return
  }
  if (!fs.existsSync(DB_PATH)) return

  const db = new DatabaseSync(DB_PATH)
  db.exec('PRAGMA busy_timeout = 8000')

  const placeholders = ALERT_RULE_NAMES.map(() => '?').join(',')
  // 同时清掉冒烟测试产生的历史事件，保持演示库干净
  db.prepare(`DELETE FROM alert_events WHERE rule_name IN (${placeholders}) OR rule_name LIKE '冒烟%'`).run(
    ...ALERT_RULE_NAMES
  )

  const wsRow = db.prepare('SELECT id FROM workspaces ORDER BY id LIMIT 1').get()
  if (!wsRow) {
    db.close()
    return
  }
  const ws = wsRow.id

  const mins = (n) => new Date(Date.now() - n * 60000).toISOString()
  const delivery = (name, type, ok, error = '', detail = '已投递') => ({
    channelId: channels[type] || 0,
    channelName: name,
    type,
    ok,
    error,
    detail: ok ? detail : error,
    at: mins(1),
  })

  const wecom = (ok = true, error = '') => delivery(ALERT_CHANNEL_NAMES[0], 'wecom', ok, error)
  const webhook = (ok = true, error = '') => delivery(ALERT_CHANNEL_NAMES[1], 'webhook', ok, error)
  const email = (ok = true, error = '') => delivery(ALERT_CHANNEL_NAMES[2], 'email', ok, error)

  const events = [
    // yueyang-pc 确实处于离线状态 → 该事件会持续保持「触发中」，与对账扫描结果一致
    offlineNode && {
      rule: 'offline',
      eventType: 'node_offline',
      level: 'critical',
      targetType: 'node',
      targetId: String(offlineNode.id),
      targetName: offlineNode.name,
      message: `设备「${offlineNode.name}」已离线 23 分钟（阈值 10 分钟），最后在线时间 ${new Date(
        Date.now() - 23 * 60000
      ).toLocaleString('zh-CN')}`,
      status: 'firing',
      firedAt: mins(23),
      resolvedAt: null,
      ackAt: null,
      ackBy: null,
      // 最近一次邮件投递失败：让「通知渠道静默失效」在界面上看得见
      deliveries: [wecom(), email(false, 'SMTP 认证失败：535 Authentication credentials invalid')],
    },
    // shenzhen-edge 尚未完成首次接入，属于「已处置的历史事件」
    pendingNode && {
      rule: 'offline',
      eventType: 'node_offline',
      level: 'critical',
      targetType: 'node',
      targetId: String(pendingNode.id),
      targetName: pendingNode.name,
      message: `设备「${pendingNode.name}」超过 48 小时未上报心跳，现场排查为施工未完成，已确认关闭`,
      status: 'resolved',
      firedAt: mins(2880),
      resolvedAt: mins(1440),
      ackAt: mins(2820),
      ackBy: 'admin',
      deliveries: [wecom(), email()],
    },
    // 5 天后到期的密钥 → 规则阈值 7 天，条件真实成立
    shortKey && {
      rule: 'expiring',
      eventType: 'key_expiring',
      level: 'warning',
      targetType: 'access_key',
      targetId: String(shortKey.id),
      targetName: shortKey.name,
      message: `接入密钥「${shortKey.name}」将在 5 天后（${new Date(
        Date.now() + 5 * 86400000
      ).toLocaleString('zh-CN')}）到期，请及时续期或更换`,
      status: 'firing',
      firedAt: mins(305),
      resolvedAt: null,
      ackAt: null,
      ackBy: null,
      deliveries: [wecom(), webhook(true), email()],
    },
    {
      rule: 'expiring',
      eventType: 'key_expiring',
      level: 'critical',
      targetType: 'access_key',
      targetId: '9001',
      targetName: '临时访客密钥',
      message: '接入密钥「临时访客密钥」已过期约 2 天，当前状态仍为启用',
      status: 'resolved',
      firedAt: mins(2880),
      resolvedAt: mins(2760),
      ackAt: mins(2860),
      ackBy: 'admin',
      deliveries: [wecom(), webhook(), email()],
    },
    {
      rule: 'quota',
      eventType: 'quota_usage',
      level: 'warning',
      targetType: 'quota',
      targetId: 'nodes',
      targetName: '设备配额',
      message: '设备用量已达 82/99（83%），超过告警阈值 80%',
      status: 'resolved',
      firedAt: mins(4320),
      resolvedAt: mins(3000),
      ackAt: mins(4260),
      ackBy: 'admin',
      deliveries: [email()],
    },
    {
      rule: 'quota',
      eventType: 'quota_usage',
      level: 'info',
      targetType: 'quota',
      targetId: 'keys',
      targetName: '接入密钥配额',
      message: '接入密钥用量已达 12/99（12%），月度巡检提示，无需处理',
      status: 'resolved',
      firedAt: mins(8640),
      resolvedAt: mins(7200),
      ackAt: null,
      ackBy: null,
      deliveries: [email()],
    },
  ].filter(Boolean)

  const insEvent = db.prepare(
    `INSERT INTO alert_events
       (workspace_id, rule_id, rule_name, event_type, level, target_type, target_id,
        target_name, message, status, deliveries, fired_at, resolved_at, ack_at, ack_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )

  let count = 0
  // 渠道的「最近投递」由回填的事件派生，保证渠道状态与事件明细互相印证
  const lastByChannel = new Map()
  for (const e of events) {
    const ruleName = rules.find((r) => r.key === e.rule).name
    const ruleId = ruleIds[e.rule] ?? null
    const stamp = e.resolvedAt || e.ackAt || e.firedAt
    insEvent.run(
      ws,
      ruleId,
      ruleName,
      e.eventType,
      e.level,
      e.targetType,
      e.targetId,
      e.targetName,
      e.message,
      e.status,
      JSON.stringify(e.deliveries),
      e.firedAt,
      e.resolvedAt,
      e.ackAt,
      e.ackBy,
      stamp
    )
    for (const d of e.deliveries) {
      d.at = e.firedAt
      const prev = lastByChannel.get(d.channelId)
      if (!prev || new Date(d.at) > new Date(prev.at)) lastByChannel.set(d.channelId, d)
    }
    count++
  }

  // 只回写「最近投递」结果；last_test_at 留给真实的「测试」按钮，不伪造
  const updChannel = db.prepare('UPDATE alert_channels SET last_status = ?, last_error = ? WHERE id = ?')
  for (const [cid, d] of lastByChannel) {
    if (!cid) continue
    updChannel.run(d.ok ? 'ok' : 'failed', d.ok ? '' : d.error || '投递失败', cid)
  }

  db.close()
  console.log(`  已回填 ${count} 条告警历史事件（含触发中 / 已恢复 / 已确认）`)
}

async function seed() {
  const network = await ensureNetwork()

  const { data: existingNodes } = await api('GET', `/nodes?networkId=${network.id}`)
  const takenIps = new Set((existingNodes?.items || []).map((n) => n.virtualIp))

  const plan = [
    { name: 'hq-gateway', rx: 42 * 1024, tx: 16 * 1024, peers: 3, up: true },
    { name: 'changsha-nas', rx: 6 * 1024, tx: 46 * 1024, peers: 3, up: true },
    { name: 'yueyang-pc', rx: 2 * 1024, tx: 900, peers: 0, up: false },
    { name: 'shenzhen-edge', rx: 0, tx: 0, peers: 0, up: null },
  ]

  const created = []
  for (const item of plan) {
    const existing = (existingNodes?.items || []).find((n) => n.name === item.name)
    if (existing) {
      console.log(`  设备 ${item.name} 已存在，沿用`)
      created.push({ ...item, ...existing })
      continue
    }
    let ip = ''
    for (let i = 2; i < 255; i++) {
      const candidate = `10.144.144.${i}`
      if (!takenIps.has(candidate)) {
        ip = candidate
        break
      }
    }
    const { status, data } = await api('POST', '/nodes', {
      networkId: network.id,
      name: item.name,
      virtualIp: ip || undefined,
      note: `${item.name}（${MARK}）`,
    })
    if (status !== 201) {
      console.log(`  设备 ${item.name} 创建失败：${data?.error}`)
      continue
    }
    takenIps.add(data.item.virtualIp)
    created.push({ ...item, ...data.item })
    console.log(`  设备 ${data.item.name} ${data.item.virtualIp}`)
  }

  if (created.length) {
    // 一并给库里其他设备补上流量，保证总览与监控视图完整
    const { data: all } = await api('GET', '/nodes')
    const weights = new Map(plan.map((p) => [p.name, p]))
    const extra = (all?.items || [])
      .filter((n) => !created.some((c) => c.id === n.id))
      .map((n) => {
        const w = weights.get(n.name)
        return w
          ? { ...w, ...n }
          : { name: n.name, rx: 14 * 1024, tx: 6 * 1024, peers: 2, up: true, ...n }
      })
    await writeTraffic([...created, ...extra])
  }

  await api('POST', '/access-keys', {
    networkId: network.id,
    name: '长沙办公室新设备',
    expiresInDays: 30,
    maxNodes: 5,
    note: `发给设备管理员自助接入（${MARK}）`,
  })

  const gateway = created.find((n) => n.name === 'hq-gateway') || created[0]

  if (gateway) {
    const r1 = await api('POST', '/policies/subnets', {
      networkId: network.id,
      nodeId: gateway.id,
      cidr: '192.168.10.0/24',
      description: `总部办公内网（${MARK}）`,
    })
    console.log(
      `  子网路由 192.168.10.0/24 → ${gateway.name}${r1.status === 201 ? '' : `（${r1.data?.error}）`}`
    )
  }

  await api('POST', '/policies/acl', {
    networkId: network.id,
    name: ACL_NAMES[0],
    action: 'allow',
    protocol: 'tcp',
    chainType: 'forward',
    srcCidr: '10.144.144.0/24',
    dstCidr: '192.168.10.0/24',
    ports: '5000,445',
    priority: 1000,
  })
  await api('POST', '/policies/acl', {
    networkId: network.id,
    name: ACL_NAMES[1],
    action: 'deny',
    protocol: 'tcp',
    chainType: 'forward',
    srcCidr: '0.0.0.0/0',
    dstCidr: '10.144.144.0/24',
    ports: '3306,5432',
    priority: 800,
  })
  console.log('  访问控制规则已下发')

  await seedAlerts(created, network)
}

async function main() {
  const login = await api('POST', '/auth/login', { username: USER, password: PASS }, false)
  if (login.status !== 200) throw new Error(`登录失败：${JSON.stringify(login.data)}`)
  token = login.data.token

  console.log('清理旧的演示数据 ...')
  await clean()

  if (!CLEAN_ONLY) {
    console.log('创建演示数据 ...')
    await seed()
  }

  console.log(CLEAN_ONLY ? '\n清理完成。' : '\n演示数据准备完成。')
}

main().catch((err) => {
  console.error('执行失败：', err.message)
  process.exit(1)
})


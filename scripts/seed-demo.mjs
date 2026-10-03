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


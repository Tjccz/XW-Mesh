/**
 * 湘网组网 · 接口冒烟测试
 *
 * 覆盖：登录 → 建网络 → 加节点 → 取接入脚本 → 模拟心跳 → 改参数 → 快照 → 回滚 → 审计 → 清理
 *
 * 用法：
 *   node scripts/smoke-test.mjs
 *   BASE=http://localhost:8080/api ADMIN_USER=admin ADMIN_PASSWORD=xxx node scripts/smoke-test.mjs
 */

const BASE = (process.env.BASE || 'http://localhost:8080/api').replace(/\/$/, '')
const USER = process.env.ADMIN_USER || 'admin'
const PASS = process.env.ADMIN_PASSWORD || 'xiangwang@2026'

let token = ''
let passed = 0
const failures = []

function ok(name, detail = '') {
  passed += 1
  console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? '  \x1b[90m' + detail + '\x1b[0m' : ''}`)
}

function bad(name, err) {
  failures.push(name)
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err}`)
}

async function api(method, path, body, withAuth = true) {
  const headers = { 'Content-Type': 'application/json' }
  if (withAuth && token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text }
  }
  return { status: res.status, data, text }
}

async function step(name, fn) {
  try {
    await fn()
  } catch (e) {
    bad(name, e.message)
  }
}

const suffix = Math.random().toString(36).slice(2, 7)
const netName = `smoke-${suffix}`
let networkId = null
let nodeId = null

console.log(`\n湘网组网 · 冒烟测试\n目标：${BASE}\n`)

await step('健康检查', async () => {
  const { status, data } = await api('GET', '/health', undefined, false)
  if (status !== 200 || !data.ok) throw new Error(`状态 ${status}`)
  ok('健康检查', data.service)
})

await step('登录', async () => {
  const { status, data } = await api('POST', '/auth/login', { username: USER, password: PASS }, false)
  if (status !== 200 || !data.token) throw new Error(`状态 ${status}：${data.error || '未返回令牌'}`)
  token = data.token
  ok('登录', `用户 ${data.user.username}`)
})

await step('未授权访问被拒绝', async () => {
  const saved = token
  token = ''
  const { status } = await api('GET', '/networks', undefined, false)
  token = saved
  if (status !== 401) throw new Error(`预期 401，实际 ${status}`)
  ok('未授权访问被拒绝')
})

await step('创建网络', async () => {
  const { status, data } = await api('POST', '/networks', {
    name: netName,
    secret: `secret-${suffix}-98765`,
    cidr: '10.144.144.0/24',
    description: '冒烟测试网络',
  })
  if (status !== 201) throw new Error(`状态 ${status}：${data.error}`)
  networkId = data.item.id
  ok('创建网络', `${data.item.name} / ${data.item.cidr}`)
})

await step('重复网络名被拒绝', async () => {
  const { status } = await api('POST', '/networks', {
    name: netName,
    secret: 'secret-duplicate-1234',
  })
  if (status !== 409) throw new Error(`预期 409，实际 ${status}`)
  ok('重复网络名被拒绝')
})

await step('弱密钥被拒绝', async () => {
  const { status } = await api('POST', '/networks', { name: `weak-${suffix}`, secret: '123' })
  if (status !== 400) throw new Error(`预期 400，实际 ${status}`)
  ok('弱密钥被拒绝')
})

await step('新增节点（自动分配 IP）', async () => {
  const { status, data } = await api('POST', '/nodes', {
    networkId,
    name: 'smoke-node-1',
    note: '测试节点',
  })
  if (status !== 201) throw new Error(`状态 ${status}：${data.error}`)
  nodeId = data.item.id
  if (!data.item.virtualIp) throw new Error('未分配虚拟 IP')
  ok('新增节点', `${data.item.name} → ${data.item.virtualIp}`)
})

await step('获取接入脚本', async () => {
  const { status, data } = await api('GET', `/nodes/${nodeId}/provision`)
  if (status !== 200) throw new Error(`状态 ${status}`)
  if (!data.script.includes('easytier-core')) throw new Error('脚本内容异常')
  if (!data.script.includes(netName)) throw new Error('脚本未包含网络名')
  ok('获取接入脚本', `${data.filename}，${data.script.length} 字符`)
})

await step('模拟节点心跳', async () => {
  const { data: detail } = await api('GET', `/nodes/${nodeId}`)
  const nodeToken = detail.item.token
  const { status, data } = await api(
    'POST',
    '/agent/heartbeat',
    {
      token: nodeToken,
      hostname: 'smoke-node-1',
      coreVersion: '2.6.4',
      peerCount: 2,
      platform: 'Linux x86_64',
      reportedIp: '203.0.113.10',
    },
    false
  )
  if (status !== 200 || !data.ok) throw new Error(`状态 ${status}`)
  ok('模拟节点心跳', `配置版本 v${data.configVersion}`)
})

await step('节点状态变为在线', async () => {
  const { data } = await api('GET', `/nodes/${nodeId}`)
  if (data.item.status !== 'online') throw new Error(`状态为 ${data.item.status}`)
  ok('节点状态变为在线', `核心 ${data.item.coreVersion}，邻居 ${data.item.peerCount}`)
})

await step('节点拉取配置', async () => {
  const { data: detail } = await api('GET', `/nodes/${nodeId}`)
  const res = await fetch(`${BASE}/agent/config?token=${detail.item.token}`)
  const text = await res.text()
  if (!text.includes(`NETWORK_NAME=${netName}`)) throw new Error('配置内容不正确')
  if (!text.includes('VIRTUAL_IP=')) throw new Error('缺少虚拟 IP')
  ok('节点拉取配置', `${text.split('\n').length} 行`)
})

await step('无效令牌被拒绝', async () => {
  const { status } = await api('POST', '/agent/heartbeat', { token: 'invalid-token' }, false)
  if (status !== 401) throw new Error(`预期 401，实际 ${status}`)
  ok('无效令牌被拒绝')
})

let firstVersion = 0
await step('修改节点参数提升配置版本', async () => {
  const { data: before } = await api('GET', `/nodes/${nodeId}`)
  firstVersion = before.item.configVersion
  const { status, data } = await api('PATCH', `/nodes/${nodeId}`, { virtualIp: '10.144.144.88' })
  if (status !== 200) throw new Error(`状态 ${status}`)
  if (data.item.configVersion !== firstVersion + 1) {
    throw new Error(`版本未提升：${firstVersion} → ${data.item.configVersion}`)
  }
  ok('修改节点参数提升配置版本', `v${firstVersion} → v${data.item.configVersion}`)
})

await step('虚拟 IP 冲突被拒绝', async () => {
  const { status, data } = await api('POST', '/nodes', {
    networkId,
    name: 'smoke-node-2',
    virtualIp: '10.144.144.88',
  })
  if (status !== 409) throw new Error(`预期 409，实际 ${status}：${data.error || ''}`)
  ok('虚拟 IP 冲突被拒绝')
})

await step('配置快照留档', async () => {
  const { data } = await api('GET', `/nodes/${nodeId}/configs`)
  if (data.items.length < 2) throw new Error(`快照数量不足：${data.items.length}`)
  ok('配置快照留档', `${data.items.length} 条快照`)
})

await step('回滚到历史版本', async () => {
  const { status, data } = await api('POST', `/nodes/${nodeId}/rollback`, { version: firstVersion })
  if (status !== 200) throw new Error(`状态 ${status}`)
  if (data.item.virtualIp === '10.144.144.88') throw new Error('回滚后参数未恢复')
  ok('回滚到历史版本', `v${firstVersion} → 虚拟 IP ${data.item.virtualIp}`)
})

await step('审计日志完整', async () => {
  const { data } = await api('GET', '/audit', undefined)
  const actions = new Set(data.items.map((i) => i.action))
  for (const need of ['login', 'network_create', 'node_create', 'node_rollback']) {
    if (!actions.has(need)) throw new Error(`缺少动作记录：${need}`)
  }
  ok('审计日志完整', `${data.items.length} 条记录`)
})

await step('总览统计正确', async () => {
  const { data } = await api('GET', '/overview')
  if (data.stats.networks < 1 || data.stats.nodes < 1) throw new Error('统计数据异常')
  ok('总览统计正确', `网络 ${data.stats.networks}，节点 ${data.stats.nodes}，在线 ${data.stats.online}`)
})

await step('清理测试数据', async () => {
  const { status } = await api('DELETE', `/networks/${networkId}`)
  if (status !== 200) throw new Error(`状态 ${status}`)
  ok('清理测试数据')
})

console.log('')
if (failures.length) {
  console.log(`\x1b[31m${failures.length} 项失败：\x1b[0m ${failures.join('、')}`)
  console.log(`\x1b[32m${passed} 项通过\x1b[0m\n`)
  process.exit(1)
} else {
  console.log(`\x1b[32m全部 ${passed} 项检查通过\x1b[0m\n`)
}

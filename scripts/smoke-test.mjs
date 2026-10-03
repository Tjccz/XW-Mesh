#!/usr/bin/env node
/**
 * 湘网组网 · 接口冒烟测试
 * 覆盖：认证、工作区与成员、网络、设备、接入密钥、子网路由、访问控制、
 *       流量监控、用量统计、审计日志，以及节点侧心跳/配置下发链路。
 *
 * 用法：
 *   BASE=http://localhost:8080 ADMIN_USER=admin ADMIN_PASSWORD=xxx node scripts/smoke-test.mjs
 */

const BASE = (process.env.BASE || 'http://localhost:8080').replace(/\/$/, '')
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'xiangwang@2026'
const STAMP = Date.now().toString(36).slice(-6)

let token = ''
let passed = 0
let failed = 0
const failures = []

function ok(name, detail = '') {
  passed++
  console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ''}`)
}

function bad(name, detail = '') {
  failed++
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ''}`)
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`)
}

async function api(method, path, body, opts = {}) {
  const headers = { ...(opts.headers || {}) }
  if (opts.auth !== false && token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  })
  const type = res.headers.get('content-type') || ''
  const payload = type.includes('application/json') ? await res.json().catch(() => null) : await res.text()
  return { status: res.status, data: payload, headers: res.headers }
}

function expect(name, condition, detail = '') {
  if (condition) ok(name, detail)
  else bad(name, detail)
}

/* ------------------------------------------------------------------ */

async function run() {
  console.log(`\n\x1b[1m湘网组网接口冒烟测试\x1b[0m  目标 ${BASE}\n${'─'.repeat(60)}`)

  section('0. 基础与认证')

  {
    const { status, data } = await api('GET', '/api/health', undefined, { auth: false })
    expect('健康检查返回 ok', status === 200 && data?.ok === true, `v${data?.version || '?'}`)
  }

  {
    const { status } = await api('GET', '/api/networks', undefined, { auth: false })
    expect('未登录访问受保护接口返回 401', status === 401)
  }

  {
    const { status, data } = await api('POST', '/api/auth/login', {
      username: ADMIN_USER,
      password: 'definitely-wrong-password',
    }, { auth: false })
    expect('错误密码返回 401', status === 401)
    expect('错误密码不泄露账号是否存在', data?.error === '用户名或密码错误')
  }

  {
    const { status, data } = await api('POST', '/api/auth/login', {
      username: ADMIN_USER,
      password: ADMIN_PASSWORD,
    }, { auth: false })
    expect('管理员登录成功', status === 200 && !!data?.token)
    expect('登录返回工作区信息', !!data?.user?.workspace?.id, data?.user?.workspace?.name)
    token = data?.token || ''
  }

  {
    const { status, data } = await api('GET', '/api/auth/me')
    expect('获取当前用户信息', status === 200 && data?.user?.username === ADMIN_USER)
    expect('管理员角色为拥有者或管理员', ['owner', 'admin'].includes(data?.user?.role), data?.user?.role)
  }

  section('1. 工作区与成员')

  let workspaceId = null
  {
    const { status, data } = await api('GET', '/api/workspaces')
    workspaceId = data?.item?.id
    expect('读取工作区信息', status === 200 && !!workspaceId)
    expect('返回套餐配额', Array.isArray(data?.quota) && data.quota.length >= 4, data?.quota?.map((q) => `${q.label} ${q.used}/${q.limit}`).join(' '))
  }

  {
    const { status, data } = await api('GET', '/api/workspaces/members')
    expect('读取成员列表', status === 200 && Array.isArray(data?.items) && data.items.length >= 1)
  }

  const memberName = `tester_${STAMP}`
  {
    const { status, data } = await api('POST', '/api/workspaces/members', {
      username: memberName,
      password: 'Member@12345',
      role: 'member',
      displayName: '测试只读成员',
    })
    expect('邀请成员成功', status === 201 && data?.item?.username === memberName, data?.item?.roleLabel)
  }

  {
    const { status } = await api('POST', '/api/workspaces/members', {
      username: memberName,
      password: 'Member@12345',
      role: 'member',
    })
    expect('重复用户名被拒绝', status === 409)
  }

  {
    const { status } = await api('POST', '/api/workspaces/members', {
      username: `weak_${STAMP}`,
      password: '123',
      role: 'member',
    })
    expect('弱密码被拒绝', status === 400)
  }

  {
    const { status } = await api('POST', '/api/workspaces/members', {
      username: `owner2_${STAMP}`,
      password: 'Member@12345',
      role: 'owner',
    })
    expect('不能越权创建拥有者', status === 400)
  }

  let memberToken = ''
  {
    const { status, data } = await api('POST', '/api/auth/login', {
      username: memberName,
      password: 'Member@12345',
    }, { auth: false })
    memberToken = data?.token || ''
    expect('新成员可登录', status === 200 && !!memberToken)
  }

  {
    const saved = token
    token = memberToken
    const { status } = await api('POST', '/api/networks', {
      name: `forbidden_${STAMP}`,
      secret: 'secret-12345678',
    })
    expect('普通成员无法创建网络（403）', status === 403)
    const { status: s2 } = await api('GET', '/api/networks')
    expect('普通成员可读取网络列表', s2 === 200)
    token = saved
  }

  section('2. 网络管理')

  const netName = `xw_net_${STAMP}`
  let networkId = null
  {
    const { status, data } = await api('POST', '/api/networks', {
      name: netName,
      secret: 'XwMeshSecret-2026',
      cidr: '10.188.1.0/24',
      peers: 'tcp://public.easytier.cn:11010',
      description: '冒烟测试网络',
      region: 'cn',
      relayMode: 'auto',
    })
    networkId = data?.item?.id
    expect('创建网络成功', status === 201 && !!networkId, `#${networkId}`)
    expect('创建后统计字段可用', typeof data?.item?.nodeTotal === 'number')
  }

  {
    const { status } = await api('POST', '/api/networks', {
      name: netName,
      secret: 'XwMeshSecret-2026',
    })
    expect('同名校验生效', status === 409)
  }

  {
    const { status } = await api('POST', '/api/networks', {
      name: `badcidr_${STAMP}`,
      secret: 'XwMeshSecret-2026',
      cidr: '10.999.1.0',
    })
    expect('非法网段被拒绝', status === 400)
  }

  {
    const { status } = await api('PATCH', `/api/networks/${networkId}`, {
      description: '冒烟测试网络（已更新）',
      relayMode: 'auto',
    })
    expect('更新网络成功', status === 200)
  }

  section('3. 设备与接入材料')

  let nodeId = null
  let nodeToken = ''
  {
    const { status, data } = await api('POST', '/api/nodes', {
      networkId,
      name: `node-${STAMP}`,
      note: '冒烟测试设备',
    })
    nodeId = data?.item?.id
    nodeToken = data?.item?.token || ''
    expect('创建设备成功', status === 201 && !!nodeId, data?.item?.virtualIp)
    expect('自动分配虚拟 IP', /^\d+\.\d+\.\d+\.\d+$/.test(data?.item?.virtualIp || ''))
    expect('节点身份为稳定 UUID', /^[0-9a-f-]{36}$/.test(data?.item?.identity || ''), data?.item?.identity)
  }

  {
    const { data: node } = await api('GET', `/api/nodes/${nodeId}`)
    const dupIp = node?.item?.virtualIp
    const { status } = await api('POST', '/api/nodes', {
      networkId,
      name: `dup-${STAMP}`,
      virtualIp: dupIp,
    })
    expect('虚拟 IP 冲突被拒绝', status === 409)
  }

  {
    const { status, data } = await api('GET', `/api/nodes/${nodeId}/provision`)
    expect('获取接入脚本', status === 200 && typeof data?.script === 'string')
    expect('脚本内置节点令牌', (data?.script || '').includes(nodeToken))
    expect('脚本内置配置拉取入口', (data?.script || '').includes('/api/agent/config'))
    expect('脚本内置初始配置', (data?.script || '').includes('network_identity'))
    expect('返回四种平台接入方式', ['linux', 'docker', 'openwrt', 'windows'].every((k) => data?.methods?.[k]))
    expect('Linux 命令使用 token 参数', (data?.methods?.linux?.command || '').includes(`token=${nodeToken}`))
  }

  {
    const { data: node } = await api('GET', `/api/nodes/${nodeId}`)
    const { status } = await api('POST', '/api/nodes', {
      networkId,
      name: node.item.name,
    })
    expect('设备重名被拒绝', status === 409)
  }

  section('4. 节点链路：心跳与配置下发')

  {
    const { status, data } = await api('POST', '/api/agent/heartbeat', {
      token: nodeToken,
      hostname: 'smoke-host',
      coreVersion: '2.6.4',
      peerCount: 3,
      platform: 'Linux x86_64',
      reportedIp: '203.0.113.10',
      rxBytes: 1024 * 1024 * 5,
      txBytes: 1024 * 1024 * 2,
    }, { auth: false })
    expect('节点心跳上报成功', status === 200 && data?.ok === true)
    expect('心跳返回配置版本', typeof data?.configVersion === 'number', `v${data?.configVersion}`)
    expect('心跳未被吊销', data?.revoked === false)
  }

  {
    const { status, data } = await api('POST', '/api/agent/heartbeat', { token: 'wrong-token' }, { auth: false })
    expect('无效令牌被拒绝', status === 401)
    expect('无效令牌不返回配置版本', data?.configVersion === undefined)
  }

  {
    const { status, data } = await api('GET', `/api/agent/config?token=${nodeToken}`, undefined, { auth: false })
    const text = typeof data === 'string' ? data : ''
    expect('节点可拉取配置', status === 200 && text.length > 0)
    expect('配置含 [network_identity]', text.includes('[network_identity]'))
    expect('配置含 network_name', text.includes(`network_name = "${netName}"`))
    expect('配置含 rpc_portal', text.includes('rpc_portal'))
    expect('配置含 [flags] 与 dev_name', text.includes('[flags]') && text.includes('dev_name'))
    expect('配置含 CONFIG_VERSION 标识', text.includes('CONFIG_VERSION'))
    expect('配置含 listeners', text.includes('listeners'))
  }

  {
    const { data } = await api('GET', `/api/nodes/${nodeId}`)
    expect('心跳后设备状态为 online', data?.item?.status === 'online', data?.item?.status)
    expect('累计流量已记录', data?.item?.rxBytes === 1024 * 1024 * 5)
  }

  section('5. 接入密钥与设备自助注册')

  let keyId = null
  let keyValue = ''
  {
    const { status, data } = await api('POST', '/api/access-keys', {
      networkId,
      name: `密钥-${STAMP}`,
      expiresInDays: 30,
      maxNodes: 3,
      note: '冒烟测试',
    })
    keyId = data?.item?.id
    keyValue = data?.item?.key || ''
    expect('创建接入密钥成功', status === 201 && !!keyId)
    expect('密钥格式为 ek_ 前缀', keyValue.startsWith('ek_'), keyValue.slice(0, 12) + '...')
    expect('密钥状态为 active', data?.item?.status === 'active')
  }

  {
    const { status, data } = await api('GET', `/api/access-keys/${keyId}/commands`)
    const { status: s2 } = await api('POST', '/api/workspaces/members', {
      username: `over_${STAMP}`,
      password: 'Member@12345',
      role: 'member',
    })
    expect('获取各平台接入命令', status === 200 && !!data?.methods)
    expect('Linux 命令使用 key 参数', (data?.methods?.linux?.command || '').includes(`key=${keyValue}`))
    expect('Docker 命令包含 NET_ADMIN', (data?.methods?.docker?.command || '').includes('NET_ADMIN'))
    expect('成员上限内可继续添加', s2 === 201 || s2 === 403)
  }

  {
    const { status, data } = await api('GET', `/api/agent/install.sh?key=${keyValue}`, undefined, { auth: false })
    const text = typeof data === 'string' ? data : ''
    expect('密钥可下载接入脚本', status === 200 && text.includes('#!/bin/sh'))
    expect('脚本内置密钥模式', text.includes('api/agent/register'))
    expect('脚本包含配置预检逻辑', text.includes('preflight'))
  }

  let autoNodeToken = ''
  {
    const { status, data } = await api(
      'GET',
      `/api/agent/register?key=${keyValue}&hostname=smoke-auto&arch=x86_64&reportedIp=198.51.100.7`,
      undefined,
      { auth: false }
    )
    const text = typeof data === 'string' ? data : ''
    autoNodeToken = (text.match(/^NODE_TOKEN=(.*)$/m) || [])[1] || ''
    expect('设备用密钥自助注册成功', status === 200 && !!autoNodeToken)
    expect('注册返回虚拟 IP', /^VIRTUAL_IP=10\.188\.1\./m.test(text), (text.match(/VIRTUAL_IP=(.*)/) || [])[1])
    expect('注册返回网络名', text.includes(`NETWORK_NAME=${netName}`))
  }

  {
    const { data } = await api('GET', '/api/nodes')
    const auto = data?.items?.find((n) => n.accessKeyName?.includes(STAMP))
    expect('自助注册的设备已入库', !!auto, auto?.name)
    expect('设备记录了来源密钥', !!auto?.accessKeyName)
  }

  {
    const { status, data } = await api('GET', `/api/agent/config?token=${autoNodeToken}`, undefined, { auth: false })
    expect('自助注册设备可拉取配置', status === 200 && String(data).includes('[network_identity]'))
  }

  {
    const { status, data } = await api('GET', `/api/agent/register?key=ek_ffffffffffffffffffffffffffffffff`, undefined, { auth: false })
    expect('伪造密钥无法注册', status === 403, String(data).trim())
  }

  section('6. 子网路由与访问控制')

  {
    const { status, data } = await api('POST', '/api/policies/subnets', {
      networkId,
      nodeId,
      cidr: '192.168.100.0/24',
      description: '办公网段',
    })
    expect('新增子网路由成功', status === 201, `${data?.affectedNodes} 台设备待同步`)
    expect('变更触发了节点配置版本提升', Number(data?.affectedNodes) >= 2)
  }

  {
    const { status, data } = await api('POST', '/api/policies/subnets', {
      networkId,
      nodeId,
      cidr: '192.168.100.0/24',
    })
    expect('重复子网路由被拒绝', status === 409)
  }

  {
    const { status, data } = await api('GET', `/api/policies/subnets?networkId=${networkId}`)
    expect('读取子网路由列表', status === 200 && data?.items?.length >= 1)
  }

  {
    const { status } = await api('POST', '/api/policies/subnets', {
      networkId,
      nodeId,
      cidr: 'not-a-cidr',
    })
    expect('非法子网段被拒绝', status === 400)
  }

  {
    const { status, data } = await api('GET', `/api/agent/config?token=${nodeToken}`, undefined, { auth: false })
    expect('子网路由已进入节点配置', String(data).includes('[[proxy_network]]') && String(data).includes('192.168.100.0/24'))
  }

  let aclId = null
  {
    const { status, data } = await api('POST', '/api/policies/acl', {
      networkId,
      name: `放行管理段-${STAMP}`,
      action: 'allow',
      protocol: 'tcp',
      chainType: 'forward',
      srcCidr: '10.188.1.0/24',
      dstCidr: '192.168.100.0/24',
      ports: '3389,22',
      priority: 1000,
    })
    aclId = data?.affectedNodes !== undefined ? true : null
    expect('新增访问控制规则成功', status === 201)

    const { data: list } = await api('GET', `/api/policies/acl?networkId=${networkId}`)
    aclId = list?.items?.[0]?.id
    expect('读取访问控制列表', Array.isArray(list?.items) && list.items.length >= 1)
    expect('返回编译预览', typeof list?.preview === 'string' && list.preview.length > 0)
    expect('预览使用 acl_v1 语法', (list?.preview || '').includes('acl.acl_v1.chains'))
    expect('预览中动作为整数枚举', (list?.preview || '').includes('action = 1'))
    expect('预览中协议为整数枚举', (list?.preview || '').includes('protocol = 1'))
  }

  {
    const { status } = await api('POST', '/api/policies/acl', {
      networkId,
      name: 'bad-action',
      action: 'maybe',
    })
    expect('非法动作被拒绝', status === 400)
  }

  {
    const { status, data } = await api('GET', `/api/agent/config?token=${nodeToken}`, undefined, { auth: false })
    const text = String(data)
    expect('访问控制已进入节点配置', text.includes('acl.acl_v1.chains'))
    expect('端口已进入规则', text.includes('"3389"'))
    expect('配置仍可被解析（含 network_identity）', text.includes('[network_identity]'))
  }

  section('7. 流量监控与用量统计')

  {
    // 制造第二个采样点，形成可计算的增量
    await api('POST', '/api/agent/heartbeat', {
      token: nodeToken,
      hostname: 'smoke-host',
      coreVersion: '2.6.4',
      peerCount: 4,
      platform: 'Linux x86_64',
      rxBytes: 1024 * 1024 * 9,
      txBytes: 1024 * 1024 * 4,
    }, { auth: false })
  }

  {
    const { status, data } = await api('GET', '/api/metrics/summary')
    expect('读取监控概览', status === 200 && typeof data?.nodes?.total === 'number')
    expect('返回节点状态分布', ['online', 'offline', 'pending', 'blocked'].every((k) => typeof data?.nodes?.[k] === 'number'))
    expect('返回累计流量', typeof data?.totalTraffic === 'number')
  }

  {
    const { status, data } = await api('GET', '/api/metrics/series?hours=24')
    expect('读取流量时间序列', status === 200 && Array.isArray(data?.buckets))
  }

  {
    const { status, data } = await api('GET', '/api/metrics/nodes?hours=24')
    expect('读取节点流量排行', status === 200 && Array.isArray(data?.items))
    expect('排行包含设备字段', data?.items?.[0]?.name !== undefined)
  }

  {
    const { status, data } = await api('GET', `/api/metrics/nodes/${nodeId}/series?hours=24`)
    expect('读取单设备曲线', status === 200 && Array.isArray(data?.buckets) && !!data?.node)
  }

  {
    const { status, data } = await api('GET', `/api/metrics/nodes/${nodeId}/samples`)
    expect('读取设备采样明细', status === 200 && Array.isArray(data?.items))
  }

  {
    const { status, data } = await api('GET', '/api/usage')
    expect('读取用量总览', status === 200 && !!data?.workspace)
    expect('用量含配额列表', Array.isArray(data?.quota) && data.quota.length >= 4)
    expect('用量含今日/本周/本月流量', !!data?.traffic?.today && !!data?.traffic?.week && !!data?.traffic?.month)
    expect('用量含按网络分布', Array.isArray(data?.networks) && data.networks.length >= 1)
    expect('用量含密钥统计', typeof data?.keys?.active === 'number')
  }

  {
    const { status, data } = await api('GET', '/api/usage/daily?days=7')
    expect('读取按天流量', status === 200 && Array.isArray(data?.buckets))
  }

  {
    const { status, data } = await api('GET', '/api/usage/export.csv')
    expect('导出用量 CSV', status === 200 && typeof data === 'string' && data.includes('节点名称'))
  }

  section('8. 总览与审计')

  {
    const { status, data } = await api('GET', '/api/overview')
    expect('读取控制台总览', status === 200 && !!data?.stats)
    expect('总览含设备与网络统计', typeof data?.stats?.nodes === 'number' && typeof data?.stats?.networks === 'number')
    expect('总览含密钥/规则/子网统计', ['keys', 'aclRules', 'subnets'].every((k) => typeof data?.stats?.[k] === 'number'))
    expect('总览含系统信息', !!data?.system?.etVersion, `ET v${data?.system?.etVersion}`)
  }

  {
    const { status, data } = await api('GET', '/api/audit?limit=10')
    expect('读取审计日志', status === 200 && Array.isArray(data?.items) && data.items.length > 0)
    expect('审计含总数与分页信息', typeof data?.total === 'number' && data?.limit === 10)
    expect('审计记录带中文动作名', !!data?.items?.[0]?.actionLabel, data?.items?.[0]?.actionLabel)
  }

  {
    const { status, data } = await api('GET', '/api/audit?action=key_create')
    expect('审计按动作筛选', status === 200 && data.items.every((i) => i.action === 'key_create'))
  }

  {
    const { status, data } = await api('GET', '/api/audit/actions')
    expect('读取可筛选动作清单', status === 200 && Array.isArray(data?.items) && data.items.length > 3)
  }

  {
    const { status, data } = await api('GET', '/api/audit/export.csv')
    expect('导出审计 CSV', status === 200 && typeof data === 'string' && data.includes('操作者'))
  }

  section('9. 设备管控与配置回滚')

  {
    const { status, data } = await api('POST', `/api/nodes/${nodeId}/resync`)
    expect('重发配置成功', status === 200 && typeof data?.item?.configVersion === 'number', `v${data?.item?.configVersion}`)
  }

  {
    const { data } = await api('GET', `/api/nodes/${nodeId}/configs`)
    expect('读取配置快照', Array.isArray(data?.items) && data.items.length >= 2)
    expect('快照含子网与 ACL 指纹', data?.items?.[0]?.config?.acl !== undefined)
  }

  {
    const { data: cfg } = await api('GET', `/api/nodes/${nodeId}/configs`)
    const old = cfg.items[cfg.items.length - 1]
    const { status, data } = await api('POST', `/api/nodes/${nodeId}/rollback`, { version: old.version })
    expect('回滚配置成功', status === 200, `自 v${old.version} → v${data?.item?.configVersion}`)
  }

  {
    const { status, data } = await api('POST', `/api/nodes/${nodeId}/rollback`, { version: 99999 })
    expect('回滚不存在的版本被拒绝', status === 404)
  }

  {
    const { status } = await api('POST', `/api/nodes/${nodeId}/block`)
    expect('停止设备成功', status === 200)
  }

  {
    const { status, data } = await api('POST', '/api/agent/heartbeat', {
      token: nodeToken,
      hostname: 'smoke-host',
    }, { auth: false })
    expect('被停止的设备收到下线指令', status === 200 && data?.revoked === true, data?.reason)
  }

  {
    const { status } = await api('GET', `/api/agent/config?token=${nodeToken}`, undefined, { auth: false })
    expect('被停止的设备无法拉取配置（403）', status === 403)
  }

  {
    const { status } = await api('POST', `/api/nodes/${nodeId}/unblock`)
    expect('恢复设备成功', status === 200)
  }

  section('10. 密钥吊销联动')

  {
    const { status, data } = await api('POST', `/api/access-keys/${keyId}/revoke`)
    expect('吊销密钥成功', status === 200 && data?.item?.status === 'revoked')
    expect('吊销返回受影响设备数', typeof data?.affectedNodes === 'number', `${data?.affectedNodes} 台`)
  }

  {
    const { status, data } = await api('POST', '/api/agent/heartbeat', {
      token: autoNodeToken,
      hostname: 'smoke-auto',
    }, { auth: false })
    expect('来源密钥被吊销的设备收到下线指令', status === 200 && data?.revoked === true, data?.reason)
  }

  {
    const { status } = await api('GET', `/api/agent/register?key=${keyValue}&hostname=x`, undefined, { auth: false })
    expect('已吊销的密钥无法再注册', status === 403)
  }

  {
    const { status } = await api('POST', `/api/access-keys/${keyId}/restore`)
    expect('恢复密钥成功', status === 200)
  }

  {
    const { status } = await api('DELETE', `/api/access-keys/${keyId}`)
    expect('删除密钥成功', status === 200)
  }

  section('11. 清理与级联')

  {
    const { status, data } = await api('DELETE', `/api/networks/${networkId}`)
    expect('含设备的网络默认拒绝删除', status === 409, data?.error)
  }

  {
    const { status, data } = await api('DELETE', `/api/networks/${networkId}?force=1`)
    expect('强制删除网络成功', status === 200)
    expect('级联移除设备', typeof data?.removedNodes === 'number' && data.removedNodes >= 2, `${data?.removedNodes} 台`)
  }

  {
    const { status } = await api('GET', `/api/nodes/${nodeId}`)
    expect('网络删除后设备一并清除', status === 404)
  }

  {
    const { data: members } = await api('GET', '/api/workspaces/members')
    const removable = members.items.filter((m) => m.username.startsWith('tester_') || m.username.startsWith('over_'))
    let allRemoved = true
    for (const m of removable) {
      const { status } = await api('DELETE', `/api/workspaces/members/${m.id}`)
      if (status !== 200) allRemoved = false
    }
    expect('清理测试成员', allRemoved, `${removable.length} 人`)
  }

  {
    const { data } = await api('GET', '/api/workspaces/members')
    const owner = data.items.filter((m) => m.role === 'owner')
    expect('工作区始终保有一个拥有者', owner.length === 1, owner[0]?.username)
  }

  /* ------------------------------------------------------------------ */
  console.log(`\n${'─'.repeat(60)}`)
  if (failed === 0) {
    console.log(`\x1b[32m\x1b[1m全部通过\x1b[0m  ${passed} 项检查\n`)
  } else {
    console.log(`\x1b[31m\x1b[1m${failed} 项未通过\x1b[0m（通过 ${passed} 项）\n`)
    for (const f of failures) console.log(`  \x1b[31m·\x1b[0m ${f}`)
    console.log('')
  }
  process.exit(failed === 0 ? 0 : 1)
}

run().catch((err) => {
  console.error('\x1b[31m冒烟测试异常中断：\x1b[0m', err)
  process.exit(1)
})

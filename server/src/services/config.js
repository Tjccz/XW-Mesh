import crypto from 'node:crypto'
import { db, now } from '../db.js'

export function getNetwork(id) {
  return db.prepare('SELECT * FROM networks WHERE id = ?').get(id)
}

export function getNode(id) {
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(id)
}

/* ----------------------------- 节点身份 ----------------------------- */

/**
 * 由节点令牌推导出稳定的 UUID，作为 EasyTier 的 instance_id。
 * 好处：不用新增字段，且节点重启、重装后身份不变；换令牌即换身份。
 */
export function identityOf(node) {
  if (node.identity) return node.identity
  const hex = crypto.createHash('sha256').update(`xw-mesh:${node.token}`).digest('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    '4' + hex.slice(13, 16),
    ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-')
}

/* ----------------------------- 子网路由 ----------------------------- */

/** 汇总某节点承担的子网代理 CIDR，返回数组 */
export function subnetCidrsOf(nodeId) {
  return db
    .prepare('SELECT cidr FROM subnet_routes WHERE node_id = ? ORDER BY id')
    .all(nodeId)
    .map((r) => r.cidr)
}

/** 逗号拼接形式，写入 nodes.subnet_proxy 便于列表展示 */
export function subnetProxyOf(nodeId) {
  return subnetCidrsOf(nodeId).join(',')
}

/* ----------------------------- 访问控制 ----------------------------- */

export function aclRulesOf(networkId) {
  return db
    .prepare('SELECT * FROM acl_rules WHERE network_id = ? AND enabled = 1 ORDER BY priority DESC, id')
    .all(networkId)
}

const PROTOCOL_CODE = { any: 5, tcp: 1, udp: 2, icmp: 3, icmpv6: 4 }
const ACTION_CODE = { allow: 1, deny: 2 }
const CHAIN_TYPE = { inbound: 1, outbound: 2, forward: 3 }

/**
 * 把控制台的访问控制规则编译成 EasyTier 的 ACL 配置片段（TOML）。
 * 语法依据官方文档 https://easytier.cn/guide/config/acl.html：
 *   [[acl.acl_v1.chains]]  chain_type 1=入站 2=出站 3=转发；default_action 1=允许 2=拒绝
 *   [[acl.acl_v1.chains.rules]] action 1=允许 2=拒绝；protocol 0/1/2/3/4/5（5=任意）
 * 说明：控制台只做基于 IP 段的策略，不使用 EasyTier 的 group 身份体系（需要全网分发 group_secret）。
 * 无启用规则时返回空字符串，节点侧会跳过该片段。
 */
export function compileAcl(networkId) {
  const rules = aclRulesOf(networkId)
  if (!rules.length) return ''

  const lines = [
    '# 由湘网组网控制台下发，请勿手工修改',
    '# 规则按 priority 从大到小匹配，命中即停止',
  ]

  // 按链类型分组：默认全部落到「转发链」，不做入站/出站的区分时最贴近「网络访问控制」的直觉
  for (const rule of rules) {
    const chainType = CHAIN_TYPE[rule.chain_type] || CHAIN_TYPE.forward
    lines.push('')
    lines.push('[[acl.acl_v1.chains]]')
    lines.push(`name = "xw-rule-${rule.id}"`)
    lines.push(`chain_type = ${chainType}`)
    lines.push(`description = "${escapeToml(rule.name)}"`)
    lines.push('enabled = true')
    lines.push(`default_action = ${rule.action === 'deny' ? 1 : 2}`)
    lines.push('')
    lines.push('[[acl.acl_v1.chains.rules]]')
    lines.push(`name = "xw-rule-${rule.id}-match"`)
    lines.push(`description = "${escapeToml(rule.name)}"`)
    lines.push(`priority = ${Math.min(Math.max(Number(rule.priority) || 100, 1), 65535)}`)
    lines.push('enabled = true')
    lines.push(`action = ${ACTION_CODE[rule.action] || 1}`)
    lines.push(`protocol = ${PROTOCOL_CODE[rule.protocol] ?? PROTOCOL_CODE.any}`)
    lines.push(`source_ips = [${cidrList(rule.src_cidr)}]`)
    lines.push(`destination_ips = [${cidrList(rule.dst_cidr)}]`)
    lines.push(`ports = [${portList(rule.ports)}]`)
    lines.push('source_ports = []')
    lines.push('rate_limit = 0')
    lines.push('burst_limit = 0')
    lines.push('stateful = true')
  }

  return lines.join('\n') + '\n'
}

/** ACL 规则的指纹，用于判断网络策略是否变化 */
export function aclFingerprint(networkId) {
  const text = compileAcl(networkId)
  if (!text) return ''
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12)
}

function cidrList(value) {
  const raw = String(value || '').trim()
  if (!raw || raw === '0.0.0.0/0') return ''
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `"${s}"`)
    .join(', ')
}

function portList(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `"${s}"`)
    .join(', ')
}

export function escapeToml(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ')
}

/* ----------------------------- 节点 TOML ----------------------------- */

/**
 * 生成节点的完整 EasyTier 配置文件（TOML）。
 * 字段依据官方示例：instance_name / hostname / instance_id / ipv4 / dhcp /
 * listeners / rpc_portal / [network_identity] / [[peer]] / [[proxy_network]] / [flags]
 */
export function buildNodeConfigToml(network, node, options = {}) {
  const peers = String(network.peers || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)

  const lines = [
    '# ============================================================',
    '#  湘网组网 · 节点配置文件（由控制台下发，手工修改会被覆盖）',
    `#  CONFIG_VERSION=${node.config_version}`,
    `#  网络：${network.name}  节点：${node.name}`,
    '# ============================================================',
    '',
    'instance_name = "default"',
    `hostname = "${escapeToml(node.name)}"`,
    `instance_id = "${identityOf(node)}"`,
    `ipv4 = "${node.virtual_ip}"`,
    'dhcp = false',
    '',
    'listeners = [',
    '  "tcp://0.0.0.0:11010",',
    '  "udp://0.0.0.0:11010",',
    '  "wg://0.0.0.0:11011",',
    '  "ws://0.0.0.0:11011/",',
    ']',
    'exit_nodes = []',
    `rpc_portal = "127.0.0.1:${options.rpcPort || 15888}"`,
    '',
    '[network_identity]',
    `network_name = "${escapeToml(network.name)}"`,
    `network_secret = "${escapeToml(network.secret)}"`,
  ]

  for (const uri of peers) {
    lines.push('')
    lines.push('[[peer]]')
    lines.push(`uri = "${uri}"`)
  }

  for (const cidr of subnetCidrsOf(node.id)) {
    lines.push('')
    lines.push('[[proxy_network]]')
    lines.push(`cidr = "${cidr}"`)
  }

  lines.push('')
  lines.push('[flags]')
  lines.push('default_protocol = "tcp"')
  lines.push(`dev_name = "${node.dev_name || 'xwtun0'}"`)
  lines.push('enable_encryption = true')
  lines.push('enable_ipv6 = true')
  lines.push('mtu = 1380')
  lines.push('latency_first = true')
  lines.push('enable_exit_node = false')
  lines.push('no_tun = false')
  lines.push('use_smoltcp = false')
  lines.push('foreign_network_whitelist = "*"')
  lines.push(`disable_p2p = ${network.relay_mode === 'relay' ? 'true' : 'false'}`)
  lines.push('relay_all_peer_rpc = false')
  lines.push('disable_udp_hole_punching = false')

  const acl = compileAcl(network.id)
  if (acl) {
    lines.push('')
    lines.push(...acl.trimEnd().split('\n'))
  }

  // 子网代理节点需要转发链，保证 ACL 对代理流量生效
  return lines.join('\n') + '\n'
}

/* ----------------------------- 快照与版本 ----------------------------- */

/** 为节点当前配置留一份快照 */
export function snapshotNode(node, network, note, author, workspaceId = null) {
  db.prepare(
    `INSERT INTO node_configs (node_id, version, config_json, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    node.id,
    node.config_version,
    JSON.stringify({
      networkName: network.name,
      networkSecret: network.secret,
      peers: network.peers,
      virtualIp: node.virtual_ip,
      nodeName: node.name,
      subnetProxy: node.subnet_proxy || '',
      acl: aclFingerprint(network.id),
      workspaceId,
    }),
    note,
    author,
    now()
  )
}

/**
 * 网络级参数（含子网路由、ACL）变化时，提升其下所有节点的配置版本，
 * 节点代理会在下一次心跳时拉到新配置并自动重启核心
 */
export function bumpNetworkNodesConfig(networkId, note, author = 'system') {
  const network = getNetwork(networkId)
  if (!network) return 0

  const nodes = db.prepare('SELECT * FROM nodes WHERE network_id = ?').all(networkId)
  const bump = db.prepare(
    'UPDATE nodes SET config_version = config_version + 1, updated_at = ? WHERE id = ?'
  )

  for (const node of nodes) {
    bump.run(now(), node.id)
    const fresh = getNode(node.id)
    fresh.subnet_proxy = subnetProxyOf(node.id)
    snapshotNode(fresh, network, note, author, network.workspace_id)
  }
  return nodes.length
}

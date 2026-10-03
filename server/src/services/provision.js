import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildNodeConfigToml, subnetCidrsOf } from './config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const INSTALL_TEMPLATE = fs.readFileSync(
  path.join(__dirname, '..', 'templates', 'node-install.sh'),
  'utf8'
)

export const DEFAULT_ET_VERSION = process.env.ET_VERSION || '2.6.4'
export const DEFAULT_RPC_PORT = Number(process.env.RPC_PORT || 15888)

/**
 * 生成下发到节点的配置（纯 KEY=VALUE，节点代理直接比对覆盖，仅用于运维查看与回退）
 */
export function buildConfigEnv(network, node) {
  return [
    '# ===== 湘网组网 · 节点配置 =====',
    '# 由控制台下发，手工修改会在下次同步时被覆盖',
    `CONFIG_VERSION=${node.config_version}`,
    `CONSOLE_URL=${process.env.CONSOLE_URL || ''}`,
    `NODE_TOKEN=${node.token}`,
    `NETWORK_NAME=${network.name}`,
    `NETWORK_SECRET=${network.secret}`,
    `VIRTUAL_IP=${node.virtual_ip}`,
    `NODE_NAME=${node.name}`,
    `PEERS=${network.peers}`,
    `SUBNET_PROXY=${subnetCidrsOf(node.id).join(',')}`,
    `RPC_PORT=${DEFAULT_RPC_PORT}`,
  ].join('\n')
}

/**
 * 渲染节点接入脚本。
 * 两种模式共用同一份模板：
 *   1) 预置节点模式：传 node，脚本内置令牌，设备无需注册
 *   2) 密钥自助模式：传 accessKey，脚本在设备上调用 /api/agent/register 领取身份
 */
export function buildInstallScript({ network, node, accessKey, consoleUrl }) {
  let toml = ''
  if (node && network) {
    try {
      toml = buildNodeConfigToml(network, node, { rpcPort: DEFAULT_RPC_PORT })
    } catch {
      toml = ''
    }
  }

  return INSTALL_TEMPLATE
    .replaceAll('{{CONSOLE_URL}}', consoleUrl)
    .replaceAll('{{NODE_TOKEN}}', node?.token || '')
    .replaceAll('{{ACCESS_KEY}}', accessKey || '')
    .replaceAll('{{ET_VERSION}}', DEFAULT_ET_VERSION)
    .replaceAll('{{RPC_PORT}}', String(DEFAULT_RPC_PORT))
    .replaceAll('{{NODE_CONFIG_TOML}}', toml)
    .replaceAll('{{NETWORK_NAME}}', network?.name || '')
    .replaceAll('{{NODE_NAME}}', node?.name || '')
    .replaceAll('{{VIRTUAL_IP}}', node?.virtual_ip || '')
}

/**
 * 简易 IP 分配：在网段内找第一个未占用的地址（跳过网络号与网关）
 */
export function allocateVirtualIp(cidr, used) {
  const base = String(cidr).split('/')[0]
  const parts = base.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return ''
  const usedSet = new Set(used)
  for (let i = 2; i < 255; i++) {
    const ip = `${parts[0]}.${parts[1]}.${parts[2]}.${i}`
    if (!usedSet.has(ip)) return ip
  }
  return ''
}

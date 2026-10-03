import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE = fs.readFileSync(
  path.join(__dirname, '..', 'templates', 'node-install.sh'),
  'utf8'
)

export const DEFAULT_ET_VERSION = process.env.ET_VERSION || '2.6.4'
export const DEFAULT_RPC_PORT = 15888

/**
 * 生成下发到节点的配置（纯 KEY=VALUE，节点代理直接比对覆盖）
 */
export function buildConfigEnv(network, node) {
  return [
    '# ===== 湘网组网 · 节点配置 =====',
    '# 由控制台下发，手工修改会在下次同步时被覆盖',
    `CONFIG_VERSION=${node.config_version}`,
    `NETWORK_NAME=${network.name}`,
    `NETWORK_SECRET=${network.secret}`,
    `VIRTUAL_IP=${node.virtual_ip}`,
    `NODE_NAME=${node.name}`,
    `PEERS=${network.peers}`,
    `RPC_PORT=${DEFAULT_RPC_PORT}`,
  ].join('\n')
}

/**
 * 生成节点接入脚本（一次性执行，装核心 + 主服务 + 心跳代理）
 */
export function buildInstallScript({ network, node, consoleUrl }) {
  return TEMPLATE
    .replaceAll('{{CONSOLE_URL}}', consoleUrl)
    .replaceAll('{{NODE_TOKEN}}', node.token)
    .replaceAll('{{ET_VERSION}}', DEFAULT_ET_VERSION)
    .replaceAll('{{CONFIG_ENV}}', buildConfigEnv(network, node))
    .replaceAll('{{NETWORK_NAME}}', network.name)
    .replaceAll('{{NODE_NAME}}', node.name)
    .replaceAll('{{VIRTUAL_IP}}', node.virtual_ip)
}

/**
 * 简易 IP 分配：在网段内找第一个未占用的地址
 */
export function allocateVirtualIp(cidr, used) {
  const base = String(cidr).split('/')[0]
  const parts = base.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return ''
  const usedSet = new Set(used)
  for (let i = 2; i < 255; i++) {
    const ip = `${parts[0]}.${parts[1]}.${parts[2]}.${i}`
    if (!usedSet.has(ip)) return ip
  }
  return ''
}

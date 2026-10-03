/** 显示格式化工具 */

export function formatBytes(bytes, digits = 1) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let value = n / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value >= 100 ? 0 : digits)} ${units[i]}`
}

export function formatNumber(n) {
  return (Number(n) || 0).toLocaleString('zh-CN')
}

export function formatTime(t) {
  return t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—'
}

export function formatDate(t) {
  return t ? new Date(t).toLocaleDateString('zh-CN') : '—'
}

/** 紧凑时间：09-28 13:17 */
export function formatShortTime(t) {
  if (!t) return '—'
  const d = new Date(t)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 相对时间，例如「32 秒前」 */
export function fromNow(t) {
  if (!t) return '从未'
  const diff = Date.now() - new Date(t).getTime()
  if (diff < 0) return '刚刚'
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec} 秒前`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  return formatDate(t)
}

export const NODE_STATUS = {
  online: { text: '在线', type: 'success' },
  offline: { text: '离线', type: 'danger' },
  pending: { text: '待接入', type: 'info' },
  blocked: { text: '已停止', type: 'warning' },
}

export const KEY_STATUS = {
  active: { text: '可用', type: 'success' },
  revoked: { text: '已吊销', type: 'danger' },
  expired: { text: '已过期', type: 'warning' },
  exhausted: { text: '已达上限', type: 'warning' },
}

export const CHAIN_TYPE = {
  forward: '转发流量（子网代理）',
  inbound: '入站流量',
  outbound: '出站流量',
}

export const PROTOCOL = { any: '任意', tcp: 'TCP', udp: 'UDP', icmp: 'ICMP', icmpv6: 'ICMPv6' }

export const RELAY_MODE = {
  auto: '自动（先打洞，失败走中继）',
  relay: '仅中继（禁用 P2P）',
  p2p: '仅 P2P',
}

export function download(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

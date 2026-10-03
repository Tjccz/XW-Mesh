import { db } from '../db.js'

export const ONLINE_WINDOW_MS = 120 * 1000

export function statusOf(node) {
  if (node.status === 'blocked') return 'blocked'
  if (!node.last_seen) return 'pending'
  return Date.now() - new Date(node.last_seen).getTime() <= ONLINE_WINDOW_MS ? 'online' : 'offline'
}

/** 当前工作区下的节点 id 列表 */
export function nodeIdsOf(workspaceId, networkId) {
  let sql = 'SELECT id FROM nodes WHERE workspace_id = ?'
  const params = [workspaceId]
  if (networkId) {
    sql += ' AND network_id = ?'
    params.push(Number(networkId))
  }
  return db.prepare(sql).all(...params).map((r) => r.id)
}

/**
 * traffic_samples 存的是累计字节数（网卡计数器），
 * 相邻两次采样做差分即得该时段真实流量；计数器回绕（设备重启）时按新值计算。
 */
export function diffSamples(rows) {
  const out = []
  let prev = null
  for (const r of rows) {
    const rx = Number(r.rx_bytes) || 0
    const tx = Number(r.tx_bytes) || 0
    if (prev && prev.nodeId === r.node_id) {
      out.push({
        nodeId: r.node_id,
        at: r.sampled_at,
        rx: rx >= prev.rx ? rx - prev.rx : rx,
        tx: tx >= prev.tx ? tx - prev.tx : tx,
        peerCount: r.peer_count,
      })
    }
    prev = { nodeId: r.node_id, rx, tx }
  }
  return out
}

export function bucketKey(iso, unit) {
  const d = new Date(iso)
  const pad = (n) => String(n).padStart(2, '0')
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return unit === 'day' ? day : `${day} ${pad(d.getHours())}:00`
}

export function sinceISO(hoursOrDays, unit = 'hour') {
  const ms = unit === 'day' ? hoursOrDays * 86400 * 1000 : hoursOrDays * 3600 * 1000
  return new Date(Date.now() - ms).toISOString()
}

export function samplesBetween(ids, since) {
  if (!ids.length) return []
  return db
    .prepare(
      `SELECT * FROM traffic_samples
       WHERE node_id IN (${ids.map(() => '?').join(',')}) AND sampled_at >= ?
       ORDER BY node_id, sampled_at`
    )
    .all(...ids, since)
}

/** 指定时间窗内的流量合计（含时间序列） */
export function trafficBetween(workspaceId, since, networkId) {
  const ids = nodeIdsOf(workspaceId, networkId)
  const deltas = diffSamples(samplesBetween(ids, since))
  return {
    rx: deltas.reduce((s, d) => s + d.rx, 0),
    tx: deltas.reduce((s, d) => s + d.tx, 0),
    samples: deltas.length,
    series: deltas,
  }
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let value = n / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`
}

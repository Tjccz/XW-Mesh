/**
 * 告警扫描引擎
 *
 * 工作方式：周期性地把「规则」与「当前状态」做一次对账（reconcile），
 * 而不是在业务写入路径上埋钩子。这样有三个好处：
 *   1. 规则改了、新建设备、恢复历史数据，下一轮扫描自动纠偏
 *   2. 漏一次扫描不会丢事件，下次仍能发现
 *   3. 业务代码（心跳、CRUD）保持干净，不被告警逻辑侵入
 *
 * 事件生命周期：
 *   异常出现 → 建 firing 事件 + 通知
 *   异常持续 → 不重复通知（天然静默）
 *   异常消失 → 事件转 resolved + 通知恢复
 *   抖动重发 → 静默期内不再触发（防刷屏）
 */
import { db, now } from '../db.js'
import { deliver } from './notify.js'
import { quotaOf, usageOf } from './quota.js'
import { statusOf } from './traffic.js'

export const EVENT_TYPES = ['node_offline', 'key_expiring', 'quota_usage']
export const LEVELS = ['info', 'warning', 'critical']

export const EVENT_META = {
  node_offline: {
    label: '设备离线',
    unit: '分钟',
    hint: '设备最后心跳距今超过该时长即触发',
    defaultThreshold: 10,
    min: 1,
    max: 10080,
  },
  key_expiring: {
    label: '密钥即将到期',
    unit: '天',
    hint: '接入密钥距离有效期结束不足该天数即触发；已过期会升级为「严重」',
    defaultThreshold: 7,
    min: 1,
    max: 365,
  },
  quota_usage: {
    label: '配额使用率',
    unit: '%',
    hint: '设备数或密钥数达到套餐上限的该比例即触发',
    defaultThreshold: 80,
    min: 1,
    max: 100,
  },
}

const DEFAULT_SILENCE_MINUTES = 30
const targetKey = (type, id) => `${type}:${id}`

/* ------------------------------ 规则求值 ------------------------------ */

function evalNodeOffline(rule, ctx) {
  const out = []
  const thresholdMs = rule.threshold * 60 * 1000
  for (const node of ctx.nodes) {
    if (rule.network_id && node.network_id !== rule.network_id) continue
    const status = statusOf(node)
    if (status !== 'offline' || !node.last_seen) continue
    const idle = Date.now() - new Date(node.last_seen).getTime()
    if (idle < thresholdMs) continue
    const minutes = Math.floor(idle / 60000)
    out.push({
      targetType: 'node',
      targetId: node.id,
      targetName: node.name,
      level: rule.level,
      message: `设备「${node.name}」已离线 ${minutes} 分钟（阈值 ${rule.threshold} 分钟），最后在线时间 ${new Date(node.last_seen).toLocaleString('zh-CN')}`,
    })
  }
  return out
}

function evalKeyExpiring(rule, ctx) {
  const out = []
  for (const key of ctx.keys) {
    if (rule.network_id && key.network_id !== rule.network_id) continue
    if (key.status !== 'active' || !key.expires_at) continue
    const leftMs = new Date(key.expires_at).getTime() - Date.now()
    const leftDays = leftMs / 86400000

    if (leftMs <= 0) {
      const overdue = Math.max(1, Math.ceil(-leftDays))
      out.push({
        targetType: 'access_key',
        targetId: key.id,
        targetName: key.name,
        level: 'critical',
        message: `接入密钥「${key.name}」已于 ${new Date(key.expires_at).toLocaleString('zh-CN')} 过期（${
          overdue === 1 ? '约 1 天' : `约 ${overdue} 天`
        }前），当前状态仍为启用`,
      })
      continue
    }
    if (leftDays > rule.threshold) continue
    out.push({
      targetType: 'access_key',
      targetId: key.id,
      targetName: key.name,
      level: rule.level,
      message: `接入密钥「${key.name}」将在 ${Math.max(1, Math.floor(leftDays))} 天后（${new Date(
        key.expires_at
      ).toLocaleString('zh-CN')}）到期，请及时续期或更换`,
    })
  }
  return out
}

function evalQuotaUsage(rule, ctx) {
  const out = []
  const quota = quotaOf(ctx.workspace.plan)
  const used = usageOf(ctx.workspace.id)
  const targets = [
    { key: 'nodes', label: '设备', limit: quota.nodes },
    { key: 'keys', label: '接入密钥', limit: quota.keys },
  ]
  for (const t of targets) {
    if (!t.limit) continue
    const pct = Math.round((used[t.key] / t.limit) * 100)
    if (pct < rule.threshold) continue
    out.push({
      targetType: 'quota',
      targetId: t.key,
      targetName: `${t.label}配额`,
      level: pct >= 100 ? 'critical' : rule.level,
      message: `${t.label}用量已达 ${used[t.key]}/${t.limit}（${pct}%），超过告警阈值 ${rule.threshold}%`,
    })
  }
  return out
}

const EVALUATORS = {
  node_offline: evalNodeOffline,
  key_expiring: evalKeyExpiring,
  quota_usage: evalQuotaUsage,
}

/* ------------------------------ 事件投递 ------------------------------ */

async function dispatch(event, rule, workspace) {
  const ids = String(rule.channel_ids || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)

  if (!ids.length) return []

  const channels = db
    .prepare(
      `SELECT * FROM alert_channels
       WHERE workspace_id = ? AND enabled = 1 AND id IN (${ids.map(() => '?').join(',')})`
    )
    .all(workspace.id, ...ids)

  const results = []
  for (const ch of channels) {
    const res = await deliver(ch, event, workspace.name)
    results.push({
      channelId: ch.id,
      channelName: ch.name,
      type: ch.type,
      ok: res.ok,
      error: res.error || '',
      detail: res.detail || '',
      attempts: res.attempts || 1,
      at: now(),
    })
    // 渠道最近一次投递结果回写到渠道本身——通知渠道静默失效必须可见
    db.prepare('UPDATE alert_channels SET last_status = ?, last_error = ? WHERE id = ?').run(
      res.ok ? 'ok' : 'failed',
      res.ok ? '' : res.error || '投递失败',
      ch.id
    )
  }
  return results
}

/** 真正创建事件并投递，返回事件 id */
async function fireEvent({ workspace, rule, item, kind = 'fired' }) {
  const stamp = now()
  const info = db
    .prepare(
      `INSERT INTO alert_events
         (workspace_id, rule_id, rule_name, event_type, level, target_type, target_id,
          target_name, message, status, deliveries, fired_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'firing', '[]', ?, ?)`
    )
    .run(
      workspace.id,
      rule.id,
      rule.name,
      rule.event_type,
      item.level || rule.level,
      item.targetType,
      String(item.targetId),
      item.targetName || '',
      item.message,
      stamp,
      stamp
    )

  const eventId = Number(info.lastInsertRowid)
  const event = db.prepare('SELECT * FROM alert_events WHERE id = ?').get(eventId)

  const deliveries = await dispatch(event, rule, workspace)
  db.prepare('UPDATE alert_events SET deliveries = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(deliveries),
    now(),
    eventId
  )

  return { eventId, deliveries, kind }
}

/* ------------------------------ 对账主流程 ------------------------------ */

/**
 * 扫描单个工作区
 * @param {number} workspaceId
 * @param {object} [opts]
 * @param {boolean} [opts.notify=true] 是否真的投递通知（测试时可关）
 * @returns {Promise<{fired:number, resolved:number, checked:number}>}
 */
export async function scanWorkspace(workspaceId, opts = {}) {
  const { notify = true } = opts
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId)
  if (!workspace) return { fired: 0, resolved: 0, checked: 0 }

  const rules = db
    .prepare('SELECT * FROM alert_rules WHERE workspace_id = ? AND enabled = 1')
    .all(workspaceId)
  if (!rules.length) return { fired: 0, resolved: 0, checked: 0 }

  const ctx = {
    workspace,
    nodes: db.prepare('SELECT * FROM nodes WHERE workspace_id = ?').all(workspaceId),
    keys: db.prepare('SELECT * FROM access_keys WHERE workspace_id = ?').all(workspaceId),
  }

  // 当前应当处于触发状态的目标
  const expected = new Map()
  for (const rule of rules) {
    const evaluate = EVALUATORS[rule.event_type]
    if (!evaluate) continue
    for (const item of evaluate(rule, ctx)) {
      expected.set(`${rule.id}|${targetKey(item.targetType, item.targetId)}`, { rule, item })
    }
  }

  // 数据库里仍标记为触发中的事件
  const firing = db
    .prepare("SELECT * FROM alert_events WHERE workspace_id = ? AND status = 'firing'")
    .all(workspaceId)
  const firingMap = new Map(firing.map((e) => [`${e.rule_id}|${targetKey(e.target_type, e.target_id)}`, e]))

  let firedCount = 0
  let resolvedCount = 0

  // ① 已触发但条件已消失 → 恢复
  for (const [key, event] of firingMap) {
    if (expected.has(key)) continue
    const stamp = now()
    db.prepare(
      "UPDATE alert_events SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?"
    ).run(stamp, stamp, event.id)
    resolvedCount += 1

    if (notify) {
      const rule = rules.find((r) => r.id === event.rule_id)
      const resolvedEvent = db.prepare('SELECT * FROM alert_events WHERE id = ?').get(event.id)
      if (rule) {
        const deliveries = await dispatch(resolvedEvent, rule, workspace)
        db.prepare('UPDATE alert_events SET deliveries = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify(deliveries),
          now(),
          event.id
        )
      }
    }
  }

  // ② 新出现的异常 → 触发（带抖动抑制）
  for (const [key, { rule, item }] of expected) {
    if (firingMap.has(key)) continue

    const last = db
      .prepare(
        `SELECT * FROM alert_events
         WHERE rule_id = ? AND target_type = ? AND target_id = ?
         ORDER BY id DESC LIMIT 1`
      )
      .get(rule.id, item.targetType, String(item.targetId))

    if (last?.resolved_at) {
      const since = Date.now() - new Date(last.resolved_at).getTime()
      if (since < (rule.silence_minutes || DEFAULT_SILENCE_MINUTES) * 60000) continue
    }

    if (notify) {
      await fireEvent({ workspace, rule, item })
    } else {
      const stamp = now()
      db.prepare(
        `INSERT INTO alert_events
           (workspace_id, rule_id, rule_name, event_type, level, target_type, target_id,
            target_name, message, status, deliveries, fired_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'firing', '[]', ?, ?)`
      ).run(
        workspace.id, rule.id, rule.name, rule.event_type, item.level || rule.level,
        item.targetType, String(item.targetId), item.targetName || '', item.message, stamp, stamp
      )
    }
    firedCount += 1
  }

  return { fired: firedCount, resolved: resolvedCount, checked: expected.size }
}

/** 扫描所有工作区 */
export async function scanAll(opts = {}) {
  const workspaces = db.prepare('SELECT id FROM workspaces').all()
  const total = { fired: 0, resolved: 0, checked: 0 }
  for (const w of workspaces) {
    try {
      const r = await scanWorkspace(w.id, opts)
      total.fired += r.fired
      total.resolved += r.resolved
      total.checked += r.checked
    } catch (err) {
      console.error(`[alerts] 工作区 ${w.id} 扫描失败：`, err?.message || err)
    }
  }
  return total
}

/* ------------------------------ 定时器 ------------------------------ */

let timer = null
let scanning = false

export function startAlertScanner(intervalMs = 60 * 1000) {
  if (timer) return
  timer = setInterval(async () => {
    if (scanning) return // 上一轮还没跑完，跳过本轮，避免叠加
    scanning = true
    try {
      const r = await scanAll()
      if (r.fired || r.resolved) {
        console.log(`[alerts] 触发 ${r.fired} 条，恢复 ${r.resolved} 条，监控目标 ${r.checked} 个`)
      }
    } catch (err) {
      console.error('[alerts] 扫描异常：', err?.message || err)
    } finally {
      scanning = false
    }
  }, intervalMs)
  timer.unref?.()
  console.log(`  告警扫描已启动（每 ${Math.round(intervalMs / 1000)} 秒一次）`)
}

export function stopAlertScanner() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

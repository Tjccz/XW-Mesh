import express from 'express'
import { db, now } from '../db.js'
import { requireAuth, requireMinRole } from '../auth.js'
import { logAudit, clientIp } from '../services/audit.js'
import {
  CHANNEL_TYPES,
  CHANNEL_META,
  validateConfig,
  maskConfig,
  stripMasked,
  deliver,
} from '../services/notify.js'
import { EVENT_TYPES, EVENT_META, LEVELS, scanWorkspace } from '../services/alerts.js'

const router = express.Router()
router.use(requireAuth)

/* ------------------------------ 形状 ------------------------------ */

function findChannel(id, workspaceId) {
  return db
    .prepare('SELECT * FROM alert_channels WHERE id = ? AND workspace_id = ?')
    .get(id, workspaceId)
}

function findRule(id, workspaceId) {
  return db.prepare('SELECT * FROM alert_rules WHERE id = ? AND workspace_id = ?').get(id, workspaceId)
}

function shapeChannel(row, { withSecret = false } = {}) {
  let config = {}
  try {
    config = JSON.parse(row.config_json || '{}')
  } catch {
    config = {}
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    typeLabel: CHANNEL_META[row.type]?.label || row.type,
    config: withSecret ? config : maskConfig(row.type, config),
    enabled: !!row.enabled,
    lastStatus: row.last_status || '',
    lastError: row.last_error || '',
    lastTestAt: row.last_test_at,
    createdAt: row.created_at,
  }
}

function channelNames(ids, workspaceId) {
  const list = String(ids || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
  if (!list.length) return []
  return db
    .prepare(
      `SELECT id, name, type FROM alert_channels
       WHERE workspace_id = ? AND id IN (${list.map(() => '?').join(',')})`
    )
    .all(workspaceId, ...list)
}

function shapeRule(row, workspaceId) {
  const meta = EVENT_META[row.event_type] || {}
  const channels = channelNames(row.channel_ids, workspaceId)
  const network = row.network_id
    ? db.prepare('SELECT id, name FROM networks WHERE id = ?').get(row.network_id)
    : null
  return {
    id: row.id,
    name: row.name,
    eventType: row.event_type,
    eventLabel: meta.label || row.event_type,
    threshold: row.threshold,
    unit: meta.unit || '',
    networkId: row.network_id,
    networkName: network?.name || '（全部网络）',
    level: row.level,
    channelIds: channels.map((c) => c.id),
    channelNames: channels.map((c) => c.name),
    silenceMinutes: row.silence_minutes,
    enabled: !!row.enabled,
    createdAt: row.created_at,
  }
}

function shapeEvent(row, { detail = false } = {}) {
  let deliveries = []
  try {
    deliveries = JSON.parse(row.deliveries || '[]')
  } catch {
    deliveries = []
  }
  const okCount = deliveries.filter((d) => d.ok).length
  const base = {
    id: row.id,
    ruleId: row.rule_id,
    ruleName: row.rule_name,
    eventType: row.event_type,
    eventLabel: EVENT_META[row.event_type]?.label || row.event_type,
    level: row.level,
    targetType: row.target_type,
    targetId: row.target_id,
    targetName: row.target_name,
    message: row.message,
    status: row.status,
    acknowledged: !!row.ack_at,
    ackAt: row.ack_at,
    ackBy: row.ack_by,
    firedAt: row.fired_at,
    resolvedAt: row.resolved_at,
    deliveryTotal: deliveries.length,
    deliveryOk: okCount,
  }
  if (detail) base.deliveries = deliveries
  return base
}

/* ------------------------------ 元数据 ------------------------------ */

router.get('/meta', (req, res) => {
  res.json({
    eventTypes: EVENT_TYPES.map((key) => ({ key, ...EVENT_META[key] })),
    channelTypes: CHANNEL_TYPES.map((key) => ({ key, ...CHANNEL_META[key] })),
    levels: LEVELS,
  })
})

/* ------------------------------ 概览 ------------------------------ */

router.get('/summary', (req, res) => {
  const ws = req.user.ws
  const count = (sql, ...args) => db.prepare(sql).get(...args)?.c || 0

  const firing = count(
    "SELECT COUNT(*) AS c FROM alert_events WHERE workspace_id = ? AND status = 'firing'",
    ws
  )
  const critical = count(
    "SELECT COUNT(*) AS c FROM alert_events WHERE workspace_id = ? AND status = 'firing' AND level = 'critical'",
    ws
  )
  const unacked = count(
    "SELECT COUNT(*) AS c FROM alert_events WHERE workspace_id = ? AND status = 'firing' AND ack_at IS NULL",
    ws
  )
  const resolved24h = count(
    "SELECT COUNT(*) AS c FROM alert_events WHERE workspace_id = ? AND status = 'resolved' AND resolved_at >= ?",
    ws,
    new Date(Date.now() - 86400000).toISOString()
  )
  const total24h = count(
    'SELECT COUNT(*) AS c FROM alert_events WHERE workspace_id = ? AND fired_at >= ?',
    ws,
    new Date(Date.now() - 86400000).toISOString()
  )
  const channels = db
    .prepare('SELECT * FROM alert_channels WHERE workspace_id = ? ORDER BY id')
    .all(ws)
  const rules = db
    .prepare('SELECT * FROM alert_rules WHERE workspace_id = ? ORDER BY id')
    .all(ws)

  res.json({
    firing,
    critical,
    unacked,
    resolved24h,
    total24h,
    channelTotal: channels.length,
    channelEnabled: channels.filter((c) => c.enabled).length,
    channelFailed: channels.filter((c) => c.last_status === 'failed').length,
    ruleTotal: rules.length,
    ruleEnabled: rules.filter((r) => r.enabled).length,
    channels: channels.map((c) => shapeChannel(c)),
  })
})

/* ------------------------------ 通知渠道 ------------------------------ */

router.get('/channels', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM alert_channels WHERE workspace_id = ? ORDER BY id DESC')
    .all(req.user.ws)
  res.json({ items: rows.map((r) => shapeChannel(r)) })
})

router.post('/channels', requireMinRole('admin'), (req, res) => {
  const { name, type, config, enabled } = req.body || {}
  if (!String(name || '').trim()) return res.status(400).json({ error: '请填写渠道名称' })
  if (!CHANNEL_TYPES.includes(type)) return res.status(400).json({ error: '不支持的渠道类型' })

  const err = validateConfig(type, config || {})
  if (err) return res.status(400).json({ error: err })

  const info = db
    .prepare(
      `INSERT INTO alert_channels (workspace_id, name, type, config_json, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(req.user.ws, String(name).trim(), type, JSON.stringify(config || {}), enabled === false ? 0 : 1, now())

  const row = db.prepare('SELECT * FROM alert_channels WHERE id = ?').get(Number(info.lastInsertRowid))
  logAudit({
    username: req.user.username,
    action: 'alert.channel.create',
    targetType: 'alert_channel',
    targetId: row.id,
    detail: `新建通知渠道「${row.name}」（${CHANNEL_META[type]?.label || type}）`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })
  res.status(201).json({ item: shapeChannel(row) })
})

router.patch('/channels/:id', requireMinRole('admin'), (req, res) => {
  const row = findChannel(Number(req.params.id), req.user.ws)
  if (!row) return res.status(404).json({ error: '通知渠道不存在' })

  const { name, type, config, enabled } = req.body || {}
  const nextType = type || row.type
  if (!CHANNEL_TYPES.includes(nextType)) return res.status(400).json({ error: '不支持的渠道类型' })

  let existing = {}
  try {
    existing = JSON.parse(row.config_json || '{}')
  } catch {
    existing = {}
  }
  // 前端回传的 ****** 表示「沿用旧值」，不能真的存进去
  const nextConfig = config === undefined ? existing : stripMasked(nextType, config, existing)

  const err = validateConfig(nextType, nextConfig)
  if (err) return res.status(400).json({ error: err })

  db.prepare(
    'UPDATE alert_channels SET name = ?, type = ?, config_json = ?, enabled = ? WHERE id = ?'
  ).run(
    name === undefined ? row.name : String(name).trim() || row.name,
    nextType,
    JSON.stringify(nextConfig),
    enabled === undefined ? row.enabled : enabled ? 1 : 0,
    row.id
  )

  const fresh = db.prepare('SELECT * FROM alert_channels WHERE id = ?').get(row.id)
  logAudit({
    username: req.user.username,
    action: 'alert.channel.update',
    targetType: 'alert_channel',
    targetId: row.id,
    detail: `修改通知渠道「${fresh.name}」`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })
  res.json({ item: shapeChannel(fresh) })
})

router.delete('/channels/:id', requireMinRole('admin'), (req, res) => {
  const row = findChannel(Number(req.params.id), req.user.ws)
  if (!row) return res.status(404).json({ error: '通知渠道不存在' })

  // 从引用它的规则里摘掉，避免留下悬空引用
  const rules = db
    .prepare('SELECT * FROM alert_rules WHERE workspace_id = ?')
    .all(req.user.ws)
  for (const rule of rules) {
    const ids = String(rule.channel_ids || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
    if (!ids.includes(row.id)) continue
    db.prepare('UPDATE alert_rules SET channel_ids = ? WHERE id = ?').run(
      ids.filter((n) => n !== row.id).join(','),
      rule.id
    )
  }

  db.prepare('DELETE FROM alert_channels WHERE id = ?').run(row.id)
  logAudit({
    username: req.user.username,
    action: 'alert.channel.delete',
    targetType: 'alert_channel',
    targetId: row.id,
    detail: `删除通知渠道「${row.name}」`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })
  res.json({ ok: true })
})

router.post('/channels/:id/test', requireMinRole('admin'), async (req, res) => {
  const row = findChannel(Number(req.params.id), req.user.ws)
  if (!row) return res.status(404).json({ error: '通知渠道不存在' })

  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.user.ws)
  const sample = {
    event_type: 'node_offline',
    level: 'info',
    target_type: 'node',
    target_id: '0',
    target_name: '测试设备',
    message: '这是一条来自湘网组网控制台的测试消息，收到即表示该通知渠道配置正确。',
    rule_id: 0,
    rule_name: '渠道连通性测试',
    status: 'firing',
    fired_at: now(),
  }

  const result = await deliver(row, sample, workspace?.name || '')
  db.prepare('UPDATE alert_channels SET last_status = ?, last_error = ?, last_test_at = ? WHERE id = ?').run(
    result.ok ? 'ok' : 'failed',
    result.ok ? '' : result.error || '测试失败',
    now(),
    row.id
  )

  logAudit({
    username: req.user.username,
    action: 'alert.channel.test',
    targetType: 'alert_channel',
    targetId: row.id,
    detail: `测试通知渠道「${row.name}」：${result.ok ? '成功' : `失败（${result.error}）`}`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })

  const fresh = db.prepare('SELECT * FROM alert_channels WHERE id = ?').get(row.id)
  res.json({
    ok: result.ok,
    error: result.error || '',
    detail: result.detail || '',
    attempts: result.attempts || 1,
    item: shapeChannel(fresh),
  })
})

/* ------------------------------ 告警规则 ------------------------------ */

router.get('/rules', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM alert_rules WHERE workspace_id = ? ORDER BY id DESC')
    .all(req.user.ws)
  res.json({ items: rows.map((r) => shapeRule(r, req.user.ws)) })
})

function validateRuleInput(body, { partial = false } = {}) {
  const { name, eventType, threshold, networkId, level, channelIds, silenceMinutes, enabled } = body
  if (!partial && !String(name || '').trim()) return '请填写规则名称'
  if (!partial && !EVENT_TYPES.includes(eventType)) return '不支持的事件类型'
  if (eventType !== undefined && !EVENT_TYPES.includes(eventType)) return '不支持的事件类型'
  if (level !== undefined && !LEVELS.includes(level)) return '不支持的告警级别'

  if (threshold !== undefined) {
    const meta = EVENT_META[eventType] || {}
    const n = Number(threshold)
    if (!Number.isFinite(n) || n < (meta.min ?? 1)) return `阈值需为不小于 ${meta.min ?? 1} 的数字`
    if (n > (meta.max ?? 100000)) return `阈值不能超过 ${meta.max ?? 100000}`
  }
  if (silenceMinutes !== undefined) {
    const n = Number(silenceMinutes)
    if (!Number.isInteger(n) || n < 0 || n > 10080) return '静默期需为 0-10080 的整数（分钟）'
  }
  return null
}

router.post('/rules', requireMinRole('admin'), (req, res) => {
  const body = req.body || {}
  const err = validateRuleInput(body)
  if (err) return res.status(400).json({ error: err })

  const { name, eventType, networkId, level, channelIds, silenceMinutes, enabled } = body
  const meta = EVENT_META[eventType]
  const threshold = body.threshold === undefined ? meta.defaultThreshold : Number(body.threshold)

  if (networkId) {
    const network = db
      .prepare('SELECT id FROM networks WHERE id = ? AND workspace_id = ?')
      .get(Number(networkId), req.user.ws)
    if (!network) return res.status(400).json({ error: '请选择有效的网络' })
  }

  const ids = Array.isArray(channelIds)
    ? channelIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : []
  if (!ids.length) return res.status(400).json({ error: '请至少选择一个通知渠道' })
  const known = channelNames(ids.join(','), req.user.ws).length
  if (known !== ids.length) return res.status(400).json({ error: '包含不存在的通知渠道' })

  const info = db
    .prepare(
      `INSERT INTO alert_rules
         (workspace_id, name, event_type, threshold, network_id, level, channel_ids, silence_minutes, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.user.ws,
      String(name).trim(),
      eventType,
      threshold,
      networkId ? Number(networkId) : null,
      level || 'warning',
      ids.join(','),
      silenceMinutes === undefined ? 30 : Number(silenceMinutes),
      enabled === false ? 0 : 1,
      now()
    )

  const row = db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(Number(info.lastInsertRowid))
  logAudit({
    username: req.user.username,
    action: 'alert.rule.create',
    targetType: 'alert_rule',
    targetId: row.id,
    detail: `新建告警规则「${row.name}」（${meta.label} ≥ ${threshold}${meta.unit}）`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })
  res.status(201).json({ item: shapeRule(row, req.user.ws) })
})

router.patch('/rules/:id', requireMinRole('admin'), (req, res) => {
  const row = findRule(Number(req.params.id), req.user.ws)
  if (!row) return res.status(404).json({ error: '告警规则不存在' })

  const body = req.body || {}
  const nextType = body.eventType ?? row.event_type
  const err = validateRuleInput({ ...body, eventType: nextType }, { partial: true })
  if (err) return res.status(400).json({ error: err })

  let nextChannelIds = row.channel_ids
  if (body.channelIds !== undefined) {
    const ids = Array.isArray(body.channelIds)
      ? body.channelIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : []
    if (!ids.length) return res.status(400).json({ error: '请至少选择一个通知渠道' })
    if (channelNames(ids.join(','), req.user.ws).length !== ids.length) {
      return res.status(400).json({ error: '包含不存在的通知渠道' })
    }
    nextChannelIds = ids.join(',')
  }

  let nextNetworkId = row.network_id
  if (body.networkId !== undefined) {
    if (!body.networkId) {
      nextNetworkId = null
    } else {
      const network = db
        .prepare('SELECT id FROM networks WHERE id = ? AND workspace_id = ?')
        .get(Number(body.networkId), req.user.ws)
      if (!network) return res.status(400).json({ error: '请选择有效的网络' })
      nextNetworkId = Number(body.networkId)
    }
  }

  db.prepare(
    `UPDATE alert_rules
     SET name = ?, event_type = ?, threshold = ?, network_id = ?, level = ?,
         channel_ids = ?, silence_minutes = ?, enabled = ?
     WHERE id = ?`
  ).run(
    body.name === undefined ? row.name : String(body.name).trim() || row.name,
    nextType,
    body.threshold === undefined ? row.threshold : Number(body.threshold),
    nextNetworkId,
    body.level === undefined ? row.level : body.level,
    nextChannelIds,
    body.silenceMinutes === undefined ? row.silence_minutes : Number(body.silenceMinutes),
    body.enabled === undefined ? row.enabled : body.enabled ? 1 : 0,
    row.id
  )

  const fresh = db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(row.id)
  logAudit({
    username: req.user.username,
    action: 'alert.rule.update',
    targetType: 'alert_rule',
    targetId: row.id,
    detail: `修改告警规则「${fresh.name}」`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })
  res.json({ item: shapeRule(fresh, req.user.ws) })
})

router.delete('/rules/:id', requireMinRole('admin'), (req, res) => {
  const row = findRule(Number(req.params.id), req.user.ws)
  if (!row) return res.status(404).json({ error: '告警规则不存在' })

  db.prepare('DELETE FROM alert_rules WHERE id = ?').run(row.id)
  logAudit({
    username: req.user.username,
    action: 'alert.rule.delete',
    targetType: 'alert_rule',
    targetId: row.id,
    detail: `删除告警规则「${row.name}」`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })
  res.json({ ok: true })
})

/* ------------------------------ 告警事件 ------------------------------ */

router.get('/events', (req, res) => {
  const { status, level, eventType, keyword } = req.query
  const limit = Math.min(Number(req.query.limit) || 50, 200)
  const offset = Math.max(Number(req.query.offset) || 0, 0)

  const where = ['workspace_id = ?']
  const params = [req.user.ws]

  if (status) {
    where.push('status = ?')
    params.push(String(status))
  }
  if (level) {
    where.push('level = ?')
    params.push(String(level))
  }
  if (eventType) {
    where.push('event_type = ?')
    params.push(String(eventType))
  }
  if (keyword) {
    where.push('(target_name LIKE ? OR message LIKE ? OR rule_name LIKE ?)')
    const like = `%${keyword}%`
    params.push(like, like, like)
  }

  const clause = where.join(' AND ')
  const total = db.prepare(`SELECT COUNT(*) AS c FROM alert_events WHERE ${clause}`).get(...params).c
  const rows = db
    .prepare(`SELECT * FROM alert_events WHERE ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset)

  const summary = {
    firing: db
      .prepare("SELECT COUNT(*) AS c FROM alert_events WHERE workspace_id = ? AND status = 'firing'")
      .get(req.user.ws).c,
    resolved: db
      .prepare("SELECT COUNT(*) AS c FROM alert_events WHERE workspace_id = ? AND status = 'resolved'")
      .get(req.user.ws).c,
  }

  res.json({ items: rows.map((r) => shapeEvent(r)), total, limit, offset, summary })
})

router.get('/events/:id', (req, res) => {
  const row = db
    .prepare('SELECT * FROM alert_events WHERE id = ? AND workspace_id = ?')
    .get(Number(req.params.id), req.user.ws)
  if (!row) return res.status(404).json({ error: '告警事件不存在' })
  res.json({ item: shapeEvent(row, { detail: true }) })
})

router.post('/events/:id/ack', requireMinRole('admin'), (req, res) => {
  const row = db
    .prepare('SELECT * FROM alert_events WHERE id = ? AND workspace_id = ?')
    .get(Number(req.params.id), req.user.ws)
  if (!row) return res.status(404).json({ error: '告警事件不存在' })
  if (row.status === 'resolved') return res.status(400).json({ error: '该告警已恢复，无需确认' })

  db.prepare('UPDATE alert_events SET ack_at = ?, ack_by = ?, updated_at = ? WHERE id = ?').run(
    now(),
    req.user.username,
    now(),
    row.id
  )
  logAudit({
    username: req.user.username,
    action: 'alert.ack',
    targetType: 'alert_event',
    targetId: row.id,
    detail: `确认告警「${row.target_name || row.target_id}」`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })
  const fresh = db.prepare('SELECT * FROM alert_events WHERE id = ?').get(row.id)
  res.json({ item: shapeEvent(fresh, { detail: true }) })
})

router.post('/events/ack-all', requireMinRole('admin'), (req, res) => {
  const info = db
    .prepare(
      "UPDATE alert_events SET ack_at = ?, ack_by = ?, updated_at = ? WHERE workspace_id = ? AND status = 'firing' AND ack_at IS NULL"
    )
    .run(now(), req.user.username, now(), req.user.ws)
  if (info.changes) {
    logAudit({
      username: req.user.username,
      action: 'alert.ack',
      targetType: 'alert_event',
      targetId: '*',
      detail: `批量确认 ${info.changes} 条告警`,
      ip: clientIp(req),
      workspaceId: req.user.ws,
    })
  }
  res.json({ ok: true, acked: info.changes })
})

/* ------------------------------ 手动扫描 ------------------------------ */

router.post('/scan', requireMinRole('admin'), async (req, res) => {
  const result = await scanWorkspace(req.user.ws)
  logAudit({
    username: req.user.username,
    action: 'alert.scan',
    targetType: 'alert_rule',
    targetId: '*',
    detail: `手动执行告警扫描：触发 ${result.fired} 条，恢复 ${result.resolved} 条`,
    ip: clientIp(req),
    workspaceId: req.user.ws,
  })
  res.json(result)
})

export default router

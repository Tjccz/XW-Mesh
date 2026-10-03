/**
 * 通知渠道投递
 *
 * 四类渠道：
 *   webhook   通用 JSON POST，给自建系统对接
 *   wecom     企业微信群机器人
 *   dingtalk  钉钉群机器人（支持加签）
 *   email     SMTP 邮件
 *
 * 设计要点：
 *   - 每条渠道的配置结构不同，用 validateConfig() 统一校验，路由层无需关心细节
 *   - 凭据类字段（SMTP 密码、加签密钥）出参一律脱敏，避免在接口里泄漏
 *   - 投递失败返回结构化错误而非抛异常，让上层能记录「哪个渠道失败、为什么」
 */
import crypto from 'node:crypto'
import { sendMail, parseAddress } from './smtp.js'

export const CHANNEL_TYPES = ['webhook', 'wecom', 'dingtalk', 'email']

export const CHANNEL_META = {
  webhook: {
    label: '通用 Webhook',
    hint: '向指定地址 POST 一条 JSON，用于对接自有系统',
    fields: [
      { key: 'url', label: '回调地址', required: true, placeholder: 'https://example.com/hook' },
      { key: 'token', label: 'Bearer 令牌', placeholder: '可选，会以 Authorization 头发送' },
    ],
    secrets: ['token'],
  },
  wecom: {
    label: '企业微信机器人',
    hint: '群机器人 Webhook 地址，形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx',
    fields: [{ key: 'url', label: '机器人 Webhook', required: true, placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...' }],
    secrets: [],
  },
  dingtalk: {
    label: '钉钉机器人',
    hint: '群机器人 Webhook；若安全设置选「加签」，需同时填加签密钥',
    fields: [
      { key: 'url', label: '机器人 Webhook', required: true, placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=...' },
      { key: 'secret', label: '加签密钥', placeholder: 'SEC 开头，安全设置为「加签」时必填' },
    ],
    secrets: ['secret'],
  },
  email: {
    label: '邮件（SMTP）',
    hint: '支持 465（SSL）与 587（STARTTLS）；用 25 端口且服务器不支持加密时需显式勾选允许明文认证',
    fields: [
      { key: 'host', label: 'SMTP 服务器', required: true, placeholder: 'smtp.example.com' },
      { key: 'port', label: '端口', required: true, type: 'number', placeholder: '465' },
      { key: 'secure', label: '使用 SSL（465）', type: 'boolean' },
      { key: 'user', label: '用户名', placeholder: '登录账号，留空表示匿名投递' },
      { key: 'pass', label: '密码 / 授权码', secret: true },
      { key: 'from', label: '发件人地址', required: true, placeholder: 'alert@example.com' },
      { key: 'fromName', label: '发件人显示名', placeholder: '湘网组网' },
      { key: 'to', label: '收件人', required: true, placeholder: '多个用英文逗号分隔' },
      { key: 'allowInsecureAuth', label: '允许明文认证', type: 'boolean' },
      { key: 'allowSelfSigned', label: '接受自签证书', type: 'boolean' },
    ],
    secrets: ['pass'],
  },
}

const EVENT_LABEL = {
  node_offline: '设备离线',
  key_expiring: '密钥到期',
  quota_usage: '配额告警',
}

const LEVEL_LABEL = { info: '提示', warning: '警告', critical: '严重' }
const LEVEL_ICON = { info: 'ℹ️', warning: '⚠️', critical: '🔴' }

/* ------------------------------ 校验 ------------------------------ */

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim())
const isHttpUrl = (v) => /^https?:\/\/\S+$/i.test(String(v || '').trim())

/** 校验渠道配置，返回错误文本或 null */
export function validateConfig(type, config = {}) {
  if (!CHANNEL_TYPES.includes(type)) return `不支持的渠道类型：${type}`

  if (type === 'webhook') {
    if (!isHttpUrl(config.url)) return '请填写合法的回调地址（http/https）'
  }
  if (type === 'wecom') {
    if (!isHttpUrl(config.url)) return '请填写合法的企业微信机器人地址'
    if (!/qyapi\.weixin\.qq\.com/.test(config.url) && !/weixin\.qq\.com/.test(config.url)) {
      return '企业微信机器人地址应包含 qyapi.weixin.qq.com'
    }
  }
  if (type === 'dingtalk') {
    if (!isHttpUrl(config.url)) return '请填写合法的钉钉机器人地址'
    if (!/oapi\.dingtalk\.com/.test(config.url)) return '钉钉机器人地址应包含 oapi.dingtalk.com'
    if (config.secret && String(config.secret).includes(' ')) return '加签密钥不应包含空格'
  }
  if (type === 'email') {
    if (!String(config.host || '').trim()) return '请填写 SMTP 服务器地址'
    const port = Number(config.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 'SMTP 端口需为 1-65535 的整数'
    if (!isEmail(config.from)) return '请填写合法的发件人地址'
    const list = String(config.to || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!list.length) return '请至少填写一个收件人'
    const bad = list.find((a) => !isEmail(a))
    if (bad) return `收件人格式不正确：${bad}`
  }
  return null
}

/** 出参脱敏：把密码、加签密钥替换为掩码，但保留「已设置」的信息 */
export function maskConfig(type, config = {}) {
  const meta = CHANNEL_META[type]
  if (!meta) return config
  const out = { ...config }
  for (const key of meta.secrets) {
    if (out[key]) out[key] = '******'
  }
  if (type === 'email' && out.pass) out.pass = '******'
  return out
}

/** 判断前端提交的配置是否包含未修改的掩码值（避免把 ****** 存进库里） */
export function stripMasked(type, incoming = {}, existing = {}) {
  const meta = CHANNEL_META[type]
  if (!meta) return incoming
  const out = { ...incoming }
  for (const key of meta.secrets) {
    if (out[key] === '******') {
      if (existing[key] !== undefined) out[key] = existing[key]
      else delete out[key]
    }
  }
  return out
}

/* ------------------------------ 内容构造 ------------------------------ */

function describe(event, workspaceName) {
  const eventLabel = EVENT_LABEL[event.event_type] || event.event_type
  const levelLabel = LEVEL_LABEL[event.level] || event.level
  const icon = LEVEL_ICON[event.level] || 'ℹ️'
  const action = event.status === 'resolved' ? '已恢复' : '告警'
  return { eventLabel, levelLabel, icon, action, workspaceName }
}

/** 通用 webhook 的 JSON 载荷 */
export function buildWebhookPayload(event, workspaceName) {
  return {
    source: 'xiangwang-mesh',
    event: event.status === 'resolved' ? 'alert.resolved' : 'alert.fired',
    eventType: event.event_type,
    level: event.level,
    target: {
      type: event.target_type,
      id: event.target_id,
      name: event.target_name,
    },
    message: event.message,
    ruleId: event.rule_id,
    ruleName: event.rule_name,
    workspace: workspaceName || '',
    timestamp: new Date().toISOString(),
  }
}

/** 企业微信 / 钉钉 的 markdown 文案 */
export function buildMarkdown(event, workspaceName) {
  const { eventLabel, levelLabel, icon, action } = describe(event, workspaceName)
  const title = `${icon} 【${action}】${eventLabel} · ${levelLabel}`
  const lines = [
    `**${title}**`,
    '',
    `> 对象：${event.target_name || event.target_id || '-'}`,
    `> 规则：${event.rule_name || '-'}`,
    `> 说明：${event.message}`,
  ]
  if (workspaceName) lines.push(`> 工作区：${workspaceName}`)
  lines.push('', `发生时间：${new Date(event.fired_at || Date.now()).toLocaleString('zh-CN')}`)
  if (event.status === 'resolved' && event.resolved_at) {
    lines.push(`恢复时间：${new Date(event.resolved_at).toLocaleString('zh-CN')}`)
  }
  return { title, content: lines.join('\n') }
}

/* ------------------------------ 投递实现 ------------------------------ */

async function postJson(url, payload, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  })
  const text = await res.text().catch(() => '')
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ''}`)
  }
  // 企业微信 / 钉钉 都返回 HTTP 200 + 业务错误码，必须再判一层
  try {
    const body = JSON.parse(text)
    if (body.errcode !== undefined && body.errcode !== 0) {
      throw new Error(`平台返回错误 ${body.errcode}：${body.errmsg || ''}`)
    }
  } catch (err) {
    if (err instanceof SyntaxError) return text
    throw err
  }
  return text
}

/** 钉钉加签：sign = base64(HMAC-SHA256(timestamp + "\n" + secret, secret)) */
function dingTalkSignedUrl(url, secret) {
  const timestamp = Date.now()
  const stringToSign = `${timestamp}\n${secret}`
  const sign = crypto.createHmac('sha256', secret).update(stringToSign).digest('base64')
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`
}

/**
 * 投递一条告警到指定渠道。
 *
 * 失败会自动重试：通知渠道抖一下不该等于漏报，但重试必须有界——
 * 否则一台黑洞地址的 webhook 会把整轮扫描拖住。
 *
 * @returns {Promise<{ok: boolean, error?: string, detail?: string, attempts?: number}>}
 */
export async function deliver(channel, event, workspaceName, { attempts = 2, retryDelayMs = 1500 } = {}) {
  let last = { ok: false, error: '未执行' }
  const total = Math.max(1, attempts)

  for (let i = 1; i <= total; i++) {
    last = await attemptDeliver(channel, event, workspaceName)
    if (last.ok) return { ...last, attempts: i }
    // 最后一次失败就不再等待了
    if (i < total) await new Promise((r) => setTimeout(r, retryDelayMs * i))
  }
  return { ...last, attempts: total }
}

async function attemptDeliver(channel, event, workspaceName) {
  let config = {}
  try {
    config = JSON.parse(channel.config_json || '{}')
  } catch {
    return { ok: false, error: '渠道配置不是合法 JSON' }
  }

  const check = validateConfig(channel.type, config)
  if (check) return { ok: false, error: check }

  try {
    if (channel.type === 'webhook') {
      const headers = config.token ? { Authorization: `Bearer ${config.token}` } : {}
      await postJson(config.url, buildWebhookPayload(event, workspaceName), headers)
      return { ok: true, detail: '已投递' }
    }

    if (channel.type === 'wecom') {
      const { content } = buildMarkdown(event, workspaceName)
      await postJson(config.url, { msgtype: 'markdown', markdown: { content } })
      return { ok: true, detail: '已投递' }
    }

    if (channel.type === 'dingtalk') {
      const { title, content } = buildMarkdown(event, workspaceName)
      const url = config.secret ? dingTalkSignedUrl(config.url, config.secret) : config.url
      await postJson(url, { msgtype: 'markdown', markdown: { title, text: content } })
      return { ok: true, detail: '已投递' }
    }

    if (channel.type === 'email') {
      const { eventLabel, levelLabel, action } = describe(event, workspaceName)
      const to = String(config.to || '')
        .split(',')
        .map((s) => parseAddress(s))
        .filter(Boolean)
      const subject = `[湘网组网] 【${action}】${eventLabel} - ${event.target_name || event.target_id || ''}`.trim()
      const body = [
        `事件类型：${eventLabel}`,
        `级别：${levelLabel}`,
        `状态：${action}`,
        `对象：${event.target_name || event.target_id || '-'}`,
        `规则：${event.rule_name || '-'}`,
        `说明：${event.message}`,
        workspaceName ? `工作区：${workspaceName}` : '',
        '',
        `发生时间：${new Date(event.fired_at || Date.now()).toLocaleString('zh-CN')}`,
        event.status === 'resolved' && event.resolved_at
          ? `恢复时间：${new Date(event.resolved_at).toLocaleString('zh-CN')}`
          : '',
        '',
        '—— 本邮件由湘网组网控制台自动发送，请勿直接回复。',
      ]
        .filter((l) => l !== '')
        .join('\n')

      await sendMail({
        host: config.host,
        port: Number(config.port) || (config.secure ? 465 : 587),
        secure: !!config.secure,
        user: config.user || '',
        pass: config.pass || '',
        from: config.from,
        fromName: config.fromName || '湘网组网',
        to,
        subject,
        text: body,
        allowInsecureAuth: !!config.allowInsecureAuth,
        allowSelfSigned: !!config.allowSelfSigned,
      })
      return { ok: true, detail: `已投递给 ${to.length} 个收件人` }
    }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }

  return { ok: false, error: `不支持的渠道类型：${channel.type}` }
}

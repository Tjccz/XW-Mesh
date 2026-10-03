/**
 * 极简 SMTP 客户端
 *
 * 为什么自己写而不是引入 nodemailer：
 *   本项目对外承诺「不引入需要编译的原生依赖」，nodemailer 虽然满足这点，
 *   但这一个功能用不到它 1% 的能力，为它增加一个长期依赖不划算。
 *   SMTP 的发送侧协议非常稳定（RFC 5321），实现成本可控。
 *
 * 支持：
 *   - 明文（25 端口）+ STARTTLS 升级（587 端口，主流做法）
 *   - 隐式 TLS（465 端口）
 *   - AUTH LOGIN 认证
 *   - 多收件人、UTF-8 主题与正文
 *
 * 不支持（有意为之）：附件、HTML 富文本、AUTH PLAIN/XOAUTH2、DKIM 签名。
 * 告警邮件不需要这些。
 */
import net from 'node:net'
import tls from 'node:tls'

/** 把 socket 上的数据流切成一条条完整的 SMTP 回复 */
function makeReader(socket) {
  let buf = ''
  let cur = []
  const queue = []
  let waiter = null
  let failure = null

  const deliver = () => {
    while (queue.length && waiter) {
      const reply = queue.shift()
      const w = waiter
      waiter = null
      w.resolve(reply)
    }
    if (failure && waiter) {
      const w = waiter
      waiter = null
      w.reject(failure)
    }
  }

  socket.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    let idx
    while ((idx = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      cur.push(line)
      // "250-xxx" 是续行，"250 xxx" 才是回复结束
      if (/^\d{3} /.test(line)) {
        queue.push(cur.join('\n'))
        cur = []
      }
    }
    deliver()
  })
  socket.on('error', (e) => {
    failure = failure || e
    deliver()
  })
  socket.on('close', () => {
    failure = failure || new Error('SMTP 连接被对方关闭')
    deliver()
  })

  return () => {
    if (queue.length) return Promise.resolve(queue.shift())
    if (failure) return Promise.reject(failure)
    return new Promise((resolve, reject) => {
      waiter = { resolve, reject }
    })
  }
}

/** 从 "250 abc" / "250-abc" 中取状态码 */
const codeOf = (reply) => Number(String(reply).slice(0, 3))
/** 取可读文本（去掉状态码与续行标记） */
const textOf = (reply) =>
  String(reply)
    .split('\n')
    .map((l) => l.replace(/^\d{3}[- ]/, ''))
    .join(' ')
    .trim()

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** RFC 5322 推荐的 Header 编码方式：非 ASCII 用 Base64 折叠编码 */
function encodeHeader(value) {
  const text = String(value ?? '')
  if (/^[\x20-\x7e]*$/.test(text)) return text
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`
}

/** 正文按 base64 编码，避免行首 "." / 长行 / 8bit 传输带来的兼容问题 */
function encodeBody(text) {
  const b64 = Buffer.from(String(text), 'utf8').toString('base64')
  return b64.replace(/(.{76})/g, '$1\r\n')
}

function buildMessage({ from, fromName, to, subject, text, messageId }) {
  const headers = [
    `From: ${fromName ? `${encodeHeader(fromName)} <${from}>` : from}`,
    `To: ${to.join(', ')}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
  ]
  return `${headers.join('\r\n')}\r\n\r\n${encodeBody(text)}`
}

/**
 * 发送一封纯文本邮件
 * @param {object} opts
 * @param {string} opts.host       SMTP 服务器
 * @param {number} opts.port       端口（25 / 465 / 587）
 * @param {boolean} opts.secure    是否隐式 TLS（465 用 true，587 用 false 走 STARTTLS）
 * @param {string} [opts.user]     用户名，留空表示匿名投递
 * @param {string} [opts.pass]     密码
 * @param {string} opts.from       发件人地址
 * @param {string} [opts.fromName] 发件人显示名
 * @param {string[]} opts.to       收件人列表
 * @param {string} opts.subject    主题
 * @param {string} opts.text       正文
 * @param {boolean} [opts.allowInsecureAuth] 允许在明文连接上发送凭据（默认禁止；内部中继才需要）
 * @param {boolean} [opts.allowSelfSigned]   接受自签证书（默认禁止；内部服务器常自签）
 * @param {number} [opts.timeoutMs]
 */
export async function sendMail({
  host,
  port = 465,
  secure = true,
  user = '',
  pass = '',
  from,
  fromName = '',
  to = [],
  subject,
  text,
  allowInsecureAuth = false,
  allowSelfSigned = false,
  timeoutMs = 20000,
}) {
  if (!host) throw new Error('未配置 SMTP 服务器地址')
  if (!from) throw new Error('未配置发件人地址')
  if (!to.length) throw new Error('未配置收件人')

  const run = async () => {
    // IP 不能作为 TLS SNI（RFC 6066），内网 SMTP 直填 IP 时要去掉该字段
    const tlsOptions = {
      servername: net.isIP(host) ? undefined : host,
      rejectUnauthorized: !allowSelfSigned,
    }
    let socket = secure ? tls.connect({ host, port, ...tlsOptions }) : net.connect({ host, port })
    socket.setTimeout(0)
    let read = makeReader(socket)

    const expect = async (cmd, wanted, label) => {
      if (cmd) socket.write(`${cmd}\r\n`)
      const reply = await read()
      const code = codeOf(reply)
      if (!wanted.includes(code)) {
        throw new Error(`${label} 失败：${code} ${textOf(reply)}`)
      }
      return reply
    }

    try {
      // 服务端问候
      const greeting = await read()
      if (codeOf(greeting) !== 220) {
        throw new Error(`SMTP 服务端拒绝连接：${codeOf(greeting)} ${textOf(greeting)}`)
      }

      const ehloName = from.split('@')[1] || 'localhost'
      let ehlo = await expect(`EHLO ${ehloName}`, [250], 'EHLO')

      // 明文连接下若服务端支持 STARTTLS，则升级（否则凭据会明文传输）
      let encrypted = secure
      if (!secure && /STARTTLS/i.test(ehlo)) {
        await expect('STARTTLS', [220], 'STARTTLS')
        socket.removeAllListeners('data')
        socket = tls.connect({ socket, ...tlsOptions })
        read = makeReader(socket)
        ehlo = await expect(`EHLO ${ehloName}`, [250], 'STARTTLS 后的 EHLO')
        encrypted = true
      }

      if (user && !encrypted && !allowInsecureAuth) {
        throw new Error(
          'SMTP 服务器不支持 STARTTLS，为避免密码明文传输已中止。' +
            '请改用 465（SSL）或 587（STARTTLS）端口；若确认内网可信，可显式开启「允许明文认证」'
        )
      }

      if (user) {
        await expect('AUTH LOGIN', [334], 'AUTH LOGIN')
        await expect(Buffer.from(user, 'utf8').toString('base64'), [334], '发送用户名')
        await expect(Buffer.from(pass, 'utf8').toString('base64'), [235], '认证')
      }

      await expect(`MAIL FROM:<${from}>`, [250], 'MAIL FROM')
      for (const rcpt of to) {
        await expect(`RCPT TO:<${rcpt}>`, [250, 251], 'RCPT TO')
      }

      await expect('DATA', [354], 'DATA')

      const message = buildMessage({
        from,
        fromName,
        to,
        subject,
        text,
        messageId: `${Date.now()}.${Math.random().toString(36).slice(2, 10)}@xiangwang-mesh`,
      })
      socket.write(`${message}\r\n.\r\n`)
      await expect(null, [250], '邮件正文投递')

      socket.write('QUIT\r\n')
      socket.end()
    } catch (err) {
      try {
        socket.destroy()
      } catch {
        /* 忽略清理异常 */
      }
      throw err
    }
  }

  return withTimeout(run(), timeoutMs, '发送邮件')
}

/** 解析 "名称 <a@b.c>" 或 "a@b.c" 形式，失败返回 null */
export function parseAddress(raw) {
  const text = String(raw || '').trim()
  const angled = text.match(/<([^>]+)>/)
  const addr = (angled ? angled[1] : text).trim()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) ? addr : null
}

#!/usr/bin/env node
/**
 * SMTP 客户端自测：起一个模拟 SMTP 服务器，把 client 的完整对话跑一遍。
 *
 * 覆盖：
 *   1.  匿名投递（无认证）
 *   2.  隐式 TLS（465 端口场景）
 *   3.  STARTTLS 升级（587 端口场景，主流做法）
 *   4.  中文主题/正文/显示名的 Base64 折叠编码
 *   5.  安全保护：明文连接带认证且服务端不支持 STARTTLS 时必须拒绝
 *   6.  安全保护：显式开启 allowInsecureAuth 后放行（内部中继场景）
 *   7.  多收件人
 *   8.  错误处理：RCPT 被拒 / 问候码非 220 / 缺配置
 *
 * 证书用 openssl 现场生成自签证书（缺失则跳过 TLS 相关用例）。
 * 运行：node scripts/test-smtp.mjs
 */
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { sendMail } from '../server/src/services/smtp.js'

const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? `  ${extra}` : ''}`)
}
const skip = (name, why) => console.log(`  – ${name}（跳过：${why}）`)

/* ---------------- 自签证书 ---------------- */
function ensureCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xw-smtp-'))
  const key = path.join(dir, 'mock.key')
  const crt = path.join(dir, 'mock.crt')
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', crt, '-days', '2', '-nodes',
       '-subj', '/CN=localhost'],
      { stdio: 'ignore' }
    )
    return { key: fs.readFileSync(key), cert: fs.readFileSync(crt), dir }
  } catch {
    return null
  }
}

/* ---------------- 模拟 SMTP 服务器 ---------------- */
function startMockServer(opts = {}, cert) {
  const {
    requireAuth = false,
    failRcpt = false,
    greeting = 220,
    starttls = false,
    implicitTls = false,
  } = opts

  const state = {
    message: null, user: null, pass: null, from: null,
    rcpts: [], helo: [], quit: false, starttlsUsed: false, encrypted: false,
  }
  let onMessage
  const messageReady = new Promise((r) => (onMessage = r))
  let onQuit
  const quitSeen = new Promise((r) => (onQuit = r))

  const conn = { sock: null }

  function attach(sock, resetHandshake) {
    conn.sock = sock
    let buf = ''
    let inData = false
    let dataLines = []
    let authStage = 0
    if (resetHandshake) {
      inData = false
      dataLines = []
      authStage = 0
    }

    const send = (line) => conn.sock.write(`${line}\r\n`)

    const handle = (line) => {
      if (inData) {
        if (line === '.') {
          inData = false
          state.message = dataLines.join('\r\n')
          send('250 2.0.0 Ok: queued as ABC123')
          onMessage(state)
        } else {
          dataLines.push(line)
        }
        return
      }
      if (authStage === 1) {
        state.user = Buffer.from(line, 'base64').toString('utf8')
        authStage = 2
        send('334 UGFzc3dvcmQ6')
        return
      }
      if (authStage === 2) {
        state.pass = Buffer.from(line, 'base64').toString('utf8')
        authStage = 0
        send('235 2.7.0 Authentication successful')
        return
      }

      const upper = line.toUpperCase()
      if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
        state.helo.push(line)
        send('250-mock.local')
        send('250-SIZE 10485760')
        if (starttls && !state.encrypted) send('250-STARTTLS')
        if (requireAuth) send('250-AUTH LOGIN PLAIN')
        send('250 8BITMIME')
      } else if (upper === 'STARTTLS') {
        send('220 2.0.0 Ready to start TLS')
        state.starttlsUsed = true
        const raw = conn.sock
        raw.removeAllListeners('data')
        raw.removeAllListeners('error')
        const secure = new tls.TLSSocket(raw, { isServer: true, ...cert })
        secure.on('secure', () => {
          state.encrypted = true
          attach(secure, true)
        })
        secure.on('error', () => {})
      } else if (upper === 'AUTH LOGIN') {
        authStage = 1
        send('334 VXNlcm5hbWU6')
      } else if (upper.startsWith('MAIL FROM:')) {
        state.from = line.slice(10).trim().replace(/^<|>$/g, '')
        send('250 2.1.0 Ok')
      } else if (upper.startsWith('RCPT TO:')) {
        if (failRcpt) {
          send('550 5.1.1 收件人不存在')
        } else {
          state.rcpts.push(line.slice(8).trim().replace(/^<|>$/g, ''))
          send('250 2.1.5 Ok')
        }
      } else if (upper === 'DATA') {
        inData = true
        send('354 End data with <CR><LF>.<CR><LF>')
      } else if (upper === 'QUIT') {
        state.quit = true
        send('221 2.0.0 Bye')
        conn.sock.end()
        onQuit(state)
      } else {
        send('500 5.5.1 未知命令')
      }
    }

    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      let idx
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        handle(line)
      }
    })
    sock.on('error', () => {})
  }

  const server = implicitTls
    ? tls.createServer(cert, (sock) => {
        state.encrypted = true
        sock.write(`${greeting} mock.local ESMTP ready\r\n`)
        attach(sock, false)
      })
    : net.createServer((sock) => {
        sock.write(`${greeting} mock.local ESMTP ready\r\n`)
        attach(sock, false)
      })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: server.address().port, state, messageReady, quitSeen })
    )
  })
}

/* ---------------- 报文解析 ---------------- */
const decodeBody = (msg) =>
  Buffer.from((msg.split('\r\n\r\n')[1] || '').replace(/\r\n/g, ''), 'base64').toString('utf8')

function decodeSubject(msg) {
  const line = msg.split('\r\n').find((l) => l.startsWith('Subject: ')) || ''
  const raw = line.slice(9)
  const m = raw.match(/^=\?UTF-8\?B\?(.+)\?=$/)
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : raw
}

const base = {
  host: '127.0.0.1',
  port: 0,
  secure: false,
  from: 'alert@xiangwang.local',
  fromName: '湘网组网告警',
  to: ['admin@example.com'],
  subject: '测试告警',
  text: '这是一条测试消息',
}

/* ---------------- 开跑 ---------------- */
console.log('')
console.log('='.repeat(64))
console.log('  SMTP 客户端自测')
console.log('='.repeat(64))

const cert = ensureCert()
if (!cert) console.log('\n  ⚠ 未找到 openssl，TLS 相关用例将跳过')

/* 1. 匿名投递 */
console.log('\n1. 匿名投递（无认证，明文连接）')
{
  const mock = await startMockServer({}, cert)
  await sendMail({ ...base, port: mock.port })
  const st = await mock.messageReady
  check('EHLO 握手成功', /^EHLO /.test(st.helo[0] || ''), st.helo[0])
  check('发件人地址正确', st.from === 'alert@xiangwang.local', st.from)
  check('收件人地址正确', st.rcpts[0] === 'admin@example.com', st.rcpts.join(','))
  check('报文含 MIME 与编码头', /MIME-Version: 1\.0/.test(st.message) && /base64/.test(st.message))
  check('中文正文可还原', decodeBody(st.message) === '这是一条测试消息', JSON.stringify(decodeBody(st.message)))
  check('中文主题可还原', decodeSubject(st.message) === '测试告警', decodeSubject(st.message))
  check('中文显示名已 RFC2047 编码', /=\?UTF-8\?B\?/.test(st.message.split('\r\n')[0]))
  check('含 Message-ID', /Message-ID: <.+@.+-mesh>/.test(st.message))
  check('Auto-Submitted 头（防自动回复循环）', /Auto-Submitted: auto-generated/.test(st.message))
  const qst = await mock.quitSeen
  check('QUIT 优雅关闭', qst.quit === true)
  mock.server.close()
}

/* 2. 隐式 TLS（465） */
console.log('\n2. 隐式 TLS（465 端口场景）')
if (!cert) {
  skip('隐式 TLS 投递', '无 openssl')
} else {
  const mock = await startMockServer({ implicitTls: true, requireAuth: true }, cert)
  await sendMail({
    ...base, port: mock.port, secure: true, allowSelfSigned: true,
    user: 'xw@example.com', pass: 's3cr3t',
  })
  const st = await mock.messageReady
  check('连接已加密', st.encrypted === true)
  check('用户名解码正确', st.user === 'xw@example.com', st.user)
  check('密码解码正确', st.pass === 's3cr3t')
  check('邮件正文投递成功', decodeBody(st.message) === '这是一条测试消息')
  mock.server.close()
}

/* 3. STARTTLS 升级（587） */
console.log('\n3. STARTTLS 升级（587 端口场景）')
if (!cert) {
  skip('STARTTLS 投递', '无 openssl')
} else {
  const mock = await startMockServer({ starttls: true, requireAuth: true }, cert)
  await sendMail({
    ...base, port: mock.port, secure: false, allowSelfSigned: true,
    user: 'xw@example.com', pass: 'p@ss word 中文',
  })
  const st = await mock.messageReady
  check('执行了 STARTTLS', st.starttlsUsed === true)
  check('升级后连接已加密', st.encrypted === true)
  check('升级后重新 EHLO', st.helo.length === 2, `EHLO ${st.helo.length} 次`)
  check('用户名在加密通道内发送', st.user === 'xw@example.com')
  check('含特殊字符的密码解码正确', st.pass === 'p@ss word 中文', st.pass)
  mock.server.close()
}

/* 4. 安全保护：明文 + 认证默认被拒 */
console.log('\n4. 安全保护：明文连接不允许发送密码')
{
  const mock = await startMockServer({}, cert) // 不提供 STARTTLS
  let err = null
  try {
    await sendMail({ ...base, port: mock.port, user: 'u', pass: 'p' })
  } catch (e) {
    err = e
  }
  check('默认拒绝明文认证', !!err)
  check('错误信息给出可行建议', /465|587|STARTTLS/.test(err?.message || ''), err?.message)
  mock.server.close()
}

/* 5. 显式放行明文认证（内部中继） */
console.log('\n5. 内部中继：显式允许明文认证')
{
  const mock = await startMockServer({ requireAuth: true }, cert)
  await sendMail({
    ...base, port: mock.port, user: 'relay@internal', pass: 'internal-pass',
    allowInsecureAuth: true,
  })
  const st = await mock.messageReady
  check('放行后投递成功', decodeBody(st.message) === '这是一条测试消息')
  check('凭据传递正确', st.user === 'relay@internal' && st.pass === 'internal-pass')
  mock.server.close()
}

/* 6. 多收件人 */
console.log('\n6. 多收件人投递')
{
  const mock = await startMockServer({ requireAuth: true }, cert)
  await sendMail({
    ...base, port: mock.port, user: 'u', pass: 'p', allowInsecureAuth: true,
    to: ['a@example.com', 'b@example.com'],
  })
  const st = await mock.messageReady
  check('两个收件人都收到', st.rcpts.length === 2, st.rcpts.join(','))
  mock.server.close()
}

/* 7. 错误处理 */
console.log('\n7. 错误处理')
{
  const mock = await startMockServer({ failRcpt: true }, cert)
  let err = null
  try {
    await sendMail({ ...base, port: mock.port })
  } catch (e) {
    err = e
  }
  check('RCPT 被拒时抛异常', !!err)
  check('错误含阶段名', /RCPT TO 失败/.test(err?.message || ''), err?.message)
  check('错误含服务端原文', /收件人不存在/.test(err?.message || ''))
  mock.server.close()
}
{
  const mock = await startMockServer({ greeting: 554 }, cert)
  let err = null
  try {
    await sendMail({ ...base, port: mock.port })
  } catch (e) {
    err = e
  }
  check('服务端拒连时抛异常', !!err)
  check('错误含状态码 554', /554/.test(err?.message || ''), err?.message)
  mock.server.close()
}
{
  let err = null
  try {
    await sendMail({ ...base, host: '' })
  } catch (e) {
    err = e
  }
  check('缺 SMTP 地址时立即报错', /未配置 SMTP 服务器/.test(err?.message || ''), err?.message)
}
{
  let err = null
  try {
    await sendMail({ ...base, to: [] })
  } catch (e) {
    err = e
  }
  check('缺收件人时立即报错', /未配置收件人/.test(err?.message || ''), err?.message)
}

/* ---------------- 汇总 ---------------- */
const failed = results.filter((r) => !r.ok)
console.log('')
console.log('='.repeat(64))
console.log(`  SMTP 自测：${results.length - failed.length}/${results.length} 通过`)
console.log('='.repeat(64))
if (failed.length) {
  console.log('')
  for (const f of failed) console.log(`  失败：${f.name}${f.extra ? `  ${f.extra}` : ''}`)
  process.exit(1)
}
console.log('')

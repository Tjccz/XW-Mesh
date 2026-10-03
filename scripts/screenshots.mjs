#!/usr/bin/env node
/**
 * 界面截图脚本：用真实浏览器打开控制台各页面并截图到 docs/screenshots/
 * 前置：后端已启动、前端已构建（web/dist）
 * 用法：node scripts/screenshots.mjs
 *
 * 说明：本机 Chrome/Edge 的 headless --print-to-pdf 不落盘，因此统一使用 Playwright。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots')

const BASE = process.env.BASE || 'http://localhost:8080'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'xiangwang@2026'

const PW_PATH = process.env.PW_PATH || 'file:///C:/Users/Tjc/.workbuddy/binaries/node/workspace/node_modules/playwright/index.js'

const pw = (await import(PW_PATH)).default
const chromium = pw.chromium

const VIEWPORT = { width: 1560, height: 980 }

async function api(pathname) {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }),
  }).then((r) => r.json())
  const res = await fetch(`${BASE}/api${pathname}`, {
    headers: { Authorization: `Bearer ${login.token}` },
  })
  return res.json()
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const nodes = await api('/nodes')
  const node = nodes.items.find((n) => n.status === 'online') || nodes.items[0]

  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1.5 })
  const page = await context.newPage()

  const errors = []
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console] ${m.text()}`)
  })

  const shot = async (name, wait = 900) => {
    await page.waitForTimeout(wait)
    await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: false })
    console.log(`  ✓ ${name}.png`)
  }

  // 登录页
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await shot('01-login')

  // 登录
  await page.fill('input[placeholder="用户名"]', ADMIN_USER)
  await page.fill('input[placeholder="密码"]', ADMIN_PASSWORD)
  await page.click('button:has-text("登 录")')
  await page.waitForURL('**/dashboard', { timeout: 15000 })
  await page.waitForLoadState('networkidle')
  await shot('02-dashboard', 1400)

  const pages = [
    ['networks', '03-networks'],
    ['nodes', '04-nodes'],
    ['access-keys', '06-access-keys'],
    ['subnets', '08-subnets'],
    ['acl', '09-acl'],
    ['metrics', '10-metrics'],
    ['usage', '11-usage'],
    ['alerts', '17-alerts'],
    ['audit', '12-audit'],
    ['members', '13-members'],
    ['workspace', '14-workspace'],
  ]

  for (const [route, name] of pages) {
    await page.goto(`${BASE}/${route}`, { waitUntil: 'networkidle' })
    await shot(name, 1100)
  }

  // 设备详情
  if (node) {
    await page.goto(`${BASE}/nodes/${node.id}`, { waitUntil: 'networkidle' })
    await shot('05-node-detail', 1400)
  }

  // 接入密钥 → 接入方式弹窗
  await page.goto(`${BASE}/access-keys`, { waitUntil: 'networkidle' })
  const cmdBtn = page.locator('button:has-text("接入方式")').first()
  if (await cmdBtn.count()) {
    await cmdBtn.click()
    await page.waitForTimeout(1200)
    await shot('07-access-key-commands', 800)
    await page.keyboard.press('Escape')
  }

  // 访问控制 → 编译预览弹窗
  await page.goto(`${BASE}/acl`, { waitUntil: 'networkidle' })
  const previewBtn = page.locator('button:has-text("查看编译结果")').first()
  if ((await previewBtn.count()) && (await previewBtn.isEnabled().catch(() => false))) {
    await previewBtn.click()
    await page.waitForTimeout(900)
    await shot('15-acl-preview', 700)
    await page.keyboard.press('Escape')
  } else {
    console.log('  · 跳过编译预览（当前网络无规则）')
  }

  // 告警中心：规则标签页 / 渠道标签页 / 新建渠道弹窗
  await page.goto(`${BASE}/alerts`, { waitUntil: 'networkidle' })
  for (const [label, name] of [
    ['告警规则', '18-alert-rules'],
    ['通知渠道', '19-alert-channels'],
  ]) {
    const tabItem = page.locator('.el-tabs__item', { hasText: label }).first()
    if (await tabItem.count()) {
      await tabItem.click()
      await shot(name, 1000)
    }
  }
  const newChanBtn = page.locator('button:has-text("新建渠道")').first()
  if (await newChanBtn.count()) {
    await newChanBtn.click()
    await page.waitForTimeout(900)
    const dialog = page.locator('.el-dialog:visible').first()
    const select = dialog.locator('.el-select').first()
    if (await select.count()) {
      await select.click()
      await page.waitForTimeout(500)
      const opt = page.locator('.el-select-dropdown__item:visible', { hasText: '邮件' }).first()
      if (await opt.count()) await opt.click()
    }
    await shot('20-alert-channel-form', 900)
    await page.keyboard.press('Escape')
  }

  // 设备详情 → 流量曲线滚动位置
  if (node) {
    await page.goto(`${BASE}/nodes/${node.id}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(800)
    await page.evaluate(() => window.scrollTo(0, 620))
    await shot('16-node-traffic', 700)
  }

  await browser.close()

  const real = errors.filter((e) => !e.includes('favicon') && !e.includes('404'))
  if (real.length) {
    console.log('\n页面报错：')
    for (const e of real.slice(0, 20)) console.log('  ' + e)
    process.exitCode = 1
  } else {
    console.log('\n页面无 JS 报错。')
  }
}

main().catch((err) => {
  console.error('截图失败：', err)
  process.exit(1)
})

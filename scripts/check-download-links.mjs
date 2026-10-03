#!/usr/bin/env node
/**
 * 校验「图形客户端下载跳转」指向的安装包**真实存在**。
 *
 * 起因：接入密钥弹窗里的下载链接曾经指向一个从未实现的路由，用户点开得到
 * `{"error":"接口不存在"}`。修复时顺带发现「照着 release 资产名手写文件名」
 * 这件事本身就是死链的温床 —— 所以把断言补上。
 *
 * 两层校验：
 *   1. 离线：跳转逻辑本身（UA 识别、参数覆盖、未知平台回退）
 *   2. 在线：GUI_ASSETS 里每个文件名都能在 v<ET_VERSION> 的 release 资产里找到
 *
 * 用法：node scripts/check-download-links.mjs [--offline]
 * 在线部分依赖 api.github.com；不可达时会明确报"跳过"而不是假装通过。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GUI_ASSETS,
  PLATFORMS,
  assetName,
  detectOs,
  resolveDownloadUrl,
  RELEASE_BASE,
} from '../server/src/services/download.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const OFFLINE = process.argv.includes('--offline')

let pass = 0
let fail = 0
const failures = []

function expect(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✔ ${name}`)
  } else {
    fail++
    failures.push(`${name}${detail ? ' —— ' + detail : ''}`)
    console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
  console.log('-'.repeat(title.length))
}

/* ---- 版本号：不能 import provision.js，它会连带初始化数据库 ---- */

const provisionSrc = fs.readFileSync(path.join(root, 'server/src/services/provision.js'), 'utf8')
const version =
  process.env.ET_VERSION ||
  (provisionSrc.match(
    /DEFAULT_ET_VERSION\s*=\s*process\.env\.ET_VERSION\s*\|\|\s*'([^']+)'/
  ) || [])[1]

console.log('图形客户端下载跳转 · 自检')
console.log(`目标版本：v${version}`)

section(`1. 离线：跳转逻辑（${PLATFORMS.length} 个平台 / v${version}）`)

expect('从 provision.js 取到 ET_VERSION', Boolean(version), String(version))
expect('平台列表非空', PLATFORMS.length === 3, PLATFORMS.join(','))

for (const os of PLATFORMS) {
  for (const [arch, tpl] of Object.entries(GUI_ASSETS[os])) {
    expect(`模板含 {v} 占位符：${os}/${arch}`, tpl.includes('{v}'), tpl)
  }
}

const UA_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'
const UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17 Safari/605'
const UA_LINUX = 'Mozilla/5.0 (X11; Linux x86_64) Firefox/121.0'

expect('UA 识别 Windows', detectOs(UA_WIN) === 'windows', detectOs(UA_WIN))
expect('UA 识别 macOS', detectOs(UA_MAC) === 'macos', detectOs(UA_MAC))
expect('UA 识别 Linux', detectOs(UA_LINUX) === 'linux', detectOs(UA_LINUX))
expect('认不出的 UA 回退发布页', detectOs('curl/8.4.0') === 'page', detectOs('curl/8.4.0'))

const winUrl = resolveDownloadUrl({ ua: UA_WIN, version })
expect(
  'Windows 浏览器拿到 .exe 直链',
  winUrl === `${RELEASE_BASE}/download/v${version}/easytier-gui_${version}_x64-setup.exe`,
  winUrl
)
const macUrl = resolveDownloadUrl({ ua: UA_MAC, version })
expect('macOS 浏览器拿到 .dmg 直链', macUrl.endsWith('.dmg'), macUrl)
expect('macOS 默认 x64（Safari UA 不可靠，交给 Rosetta）', macUrl.includes('_x64.dmg'), macUrl)

const armUrl = resolveDownloadUrl({ os: 'macos', arch: 'aarch64', version })
expect('?arch=aarch64 能覆盖默认架构', armUrl.includes('_aarch64.dmg'), armUrl)

const pageUrl = resolveDownloadUrl({ os: 'page', version })
expect('os=page 回落发布页', pageUrl === `${RELEASE_BASE}/tag/v${version}`, pageUrl)
const badUrl = resolveDownloadUrl({ os: 'plan9', version })
expect('未知平台回落发布页（不甩错文件）', badUrl === `${RELEASE_BASE}/tag/v${version}`, badUrl)

/* ---- 在线：资产名是否真实存在 ---- */

section(`2. 在线：v${version} 的 release 资产比对`)

if (OFFLINE) {
  console.log('  （--offline，跳过）')
} else {
  let assets = null
  try {
    const r = await fetch(
      `https://api.github.com/repos/EasyTier/EasyTier/releases/tags/v${version}`,
      {
        headers: {
          'User-Agent': 'xw-mesh-check',
          Accept: 'application/vnd.github+json',
        },
        signal: AbortSignal.timeout(20000),
      }
    )
    if (r.status === 200) {
      assets = (await r.json()).assets?.map((a) => a.name) || []
    } else {
      console.log(`  ⚠ 跳过：GitHub API 返回 HTTP ${r.status}`)
    }
  } catch (e) {
    console.log(`  ⚠ 跳过：网络不可达（${e.name}: ${e.message}）`)
  }

  if (assets) {
    const want = []
    for (const os of PLATFORMS) {
      for (const arch of Object.keys(GUI_ASSETS[os])) {
        want.push([`${os}/${arch}`, assetName(os, arch, version)])
      }
    }
    expect(`拉到官方资产清单（${assets.length} 项）`, assets.length > 0)
    for (const [label, name] of want) {
      expect(`资产存在：${label} → ${name}`, assets.includes(name))
    }
  }
}

console.log(`\n${'='.repeat(48)}`)
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
if (fail) {
  console.log('\n失败明细：')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')

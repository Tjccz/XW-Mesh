/**
 * 图形客户端（EasyTier 官方 GUI）下载地址解析。
 *
 * 为什么单独一个模块：路由文件会连带初始化数据库，校验脚本 import 不了。
 * 这里只做纯字符串推导，没有任何副作用，方便离线 / 在线两种校验。
 * 自检：node scripts/check-download-links.mjs
 */

export const RELEASE_BASE = 'https://github.com/EasyTier/EasyTier/releases'

/**
 * 各平台安装包文件名模板。
 *
 * ⚠️ 这些文件名是照 EasyTier v2.6.4 的 release 资产逐条核对过的
 *    （2026-10-03 用 GitHub API 拉全量资产列表比对）。
 *    升级 ET_VERSION 时必须重新核对 —— 资产一旦改名，跳转就变成死链。
 *    核对办法：node scripts/check-download-links.mjs
 */
export const GUI_ASSETS = {
  windows: {
    x64: 'easytier-gui_{v}_x64-setup.exe',
    arm64: 'easytier-gui_{v}_arm64-setup.exe',
    x86: 'easytier-gui_{v}_x86-setup.exe',
  },
  macos: {
    x64: 'easytier-gui_{v}_x64.dmg',
    arm64: 'easytier-gui_{v}_aarch64.dmg',
    aarch64: 'easytier-gui_{v}_aarch64.dmg',
  },
  linux: {
    x64: 'easytier-gui_{v}_amd64.AppImage',
    amd64: 'easytier-gui_{v}_amd64.AppImage',
    arm64: 'easytier-gui_{v}_aarch64.AppImage',
    aarch64: 'easytier-gui_{v}_aarch64.AppImage',
  },
}

export const PLATFORMS = Object.keys(GUI_ASSETS)

export function detectOs(ua) {
  if (/Windows/i.test(ua)) return 'windows'
  if (/Macintosh|Mac OS X|Darwin/i.test(ua)) return 'macos'
  if (/Linux|X11|Android/i.test(ua)) return 'linux'
  return 'page'
}

export function detectArch(ua, os) {
  if (os === 'windows') {
    if (/ARM64/i.test(ua)) return 'arm64'
    if (/WOW64|Win64|x64|x86_64/i.test(ua)) return 'x64'
    return 'x86'
  }
  // Safari 的 UA 一律报 Intel —— M 系机器上 x64 包靠 Rosetta 也能装，
  // 所以默认 x64 而不是去猜 Apple Silicon。要精确指定用 ?arch=aarch64。
  return 'x64'
}

/** 某平台在某架构下的安装包文件名；未收录返回 null */
export function assetName(os, arch, version) {
  const map = GUI_ASSETS[os]
  if (!map) return null
  const tpl = map[arch] || map[Object.keys(map)[0]]
  return tpl.replaceAll('{v}', version)
}

/** 发布页地址（认不出平台时的兜底，也是「全部版本」入口） */
export function releasePageUrl(version) {
  return `${RELEASE_BASE}/tag/v${version}`
}

/**
 * 解析最终跳转地址。
 * 平台认不出就退回发布页 —— 宁可让用户自己挑，也不要甩错文件。
 */
export function resolveDownloadUrl({ os, arch, ua = '', version }) {
  const platform = String(os || '').toLowerCase() || detectOs(ua)
  const name = assetName(platform, String(arch || '').toLowerCase() || detectArch(ua, platform), version)
  return name ? `${RELEASE_BASE}/download/v${version}/${name}` : releasePageUrl(version)
}

import express from 'express'
import cors from 'cors'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ensureBootstrap } from './auth.js'
import authRoutes from './routes/auth.js'
import networkRoutes from './routes/networks.js'
import nodeRoutes from './routes/nodes.js'
import auditRoutes from './routes/audit.js'
import overviewRoutes from './routes/overview.js'
import agentRoutes from './routes/agent.js'
import workspaceRoutes from './routes/workspaces.js'
import accessKeyRoutes from './routes/accessKeys.js'
import policyRoutes from './routes/policies.js'
import metricsRoutes from './routes/metrics.js'
import usageRoutes from './routes/usage.js'
import alertRoutes from './routes/alerts.js'
import { startAlertScanner } from './services/alerts.js'
import { DEFAULT_ET_VERSION } from './services/provision.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8080)
const VERSION = process.env.XW_VERSION || '1.1.0'

const app = express()
app.disable('x-powered-by')
app.set('trust proxy', true)
app.use(cors())
app.use(express.json({ limit: '1mb' }))

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'xiangwang-mesh',
    version: VERSION,
    etVersion: DEFAULT_ET_VERSION,
    time: new Date().toISOString(),
  })
})

app.use('/api/auth', authRoutes)
app.use('/api/overview', overviewRoutes)
app.use('/api/workspaces', workspaceRoutes)
app.use('/api/networks', networkRoutes)
app.use('/api/nodes', nodeRoutes)
app.use('/api/access-keys', accessKeyRoutes)
app.use('/api/policies', policyRoutes)
app.use('/api/metrics', metricsRoutes)
app.use('/api/usage', usageRoutes)
app.use('/api/alerts', alertRoutes)
app.use('/api/audit', auditRoutes)
app.use('/api/agent', agentRoutes)

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }))

// 生产模式下托管前端构建产物
const webDist = path.join(__dirname, '..', '..', 'web', 'dist')
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist))
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next()
    res.sendFile(path.join(webDist, 'index.html'))
  })
}

app.use((err, req, res, next) => {
  console.error('[error]', err)
  res.status(500).json({ error: '服务器内部错误' })
})

const bootstrap = ensureBootstrap()

app.listen(PORT, () => {
  console.log('')
  console.log('  湘网组网 · 控制台服务已启动')
  console.log(`  版本：v${VERSION}   内置核心：v${DEFAULT_ET_VERSION}`)
  console.log(`  地址：http://localhost:${PORT}`)
  if (bootstrap?.created) {
    console.log('')
    console.log('  已创建初始拥有者账号：')
    console.log(`    用户名：${bootstrap.created.username}`)
    console.log(`    密码：  ${bootstrap.created.password}`)
    console.log('  请登录后立即在「工作区设置 → 修改密码」中更换。')
  }
  if (bootstrap?.workspace) {
    console.log(`  工作区：${bootstrap.workspace.name}（套餐 ${bootstrap.workspace.plan}）`)
  }
  if (!fs.existsSync(webDist)) {
    console.log('')
    console.log('  提示：未检测到前端构建产物，开发时请另开终端运行 web 的 dev server。')
  }
  console.log('')

  // 告警扫描：与控制台共进程，周期性对账「规则 vs 现状」
  startAlertScanner(Number(process.env.ALERT_SCAN_INTERVAL_MS) || 60 * 1000)
  console.log('')
})

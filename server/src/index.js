import express from 'express'
import cors from 'cors'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ensureDefaultAdmin } from './auth.js'
import authRoutes from './routes/auth.js'
import networkRoutes from './routes/networks.js'
import nodeRoutes from './routes/nodes.js'
import auditRoutes from './routes/audit.js'
import overviewRoutes from './routes/overview.js'
import agentRoutes from './routes/agent.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8080)

const app = express()
app.disable('x-powered-by')
app.use(cors())
app.use(express.json({ limit: '1mb' }))

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'xiangwang-mesh', time: new Date().toISOString() })
})

app.use('/api/auth', authRoutes)
app.use('/api/networks', networkRoutes)
app.use('/api/nodes', nodeRoutes)
app.use('/api/audit', auditRoutes)
app.use('/api/overview', overviewRoutes)
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

const bootstrap = ensureDefaultAdmin()

app.listen(PORT, () => {
  console.log('')
  console.log('  湘网组网 · 控制台服务已启动')
  console.log(`  地址：http://localhost:${PORT}`)
  if (bootstrap) {
    console.log('')
    console.log('  已创建初始管理员账号：')
    console.log(`    用户名：${bootstrap.username}`)
    console.log(`    密码：  ${bootstrap.password}`)
    console.log('  请登录后立即在设置中修改密码。')
  }
  if (!fs.existsSync(webDist)) {
    console.log('')
    console.log('  提示：未检测到前端构建产物，开发时请另开一个终端运行 web 的 dev server。')
  }
  console.log('')
})

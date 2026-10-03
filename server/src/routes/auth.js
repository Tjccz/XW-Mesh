import express from 'express'
import { verifyUser, signToken, requireAuth } from '../auth.js'
import { logAudit, clientIp } from '../services/audit.js'

const router = express.Router()

router.post('/login', (req, res) => {
  const { username, password } = req.body || {}
  if (!username || !password) {
    return res.status(400).json({ error: '请输入用户名和密码' })
  }

  const user = verifyUser(username, password)
  if (!user) {
    logAudit({
      username,
      action: 'login_failed',
      detail: '用户名或密码错误',
      ip: clientIp(req),
    })
    return res.status(401).json({ error: '用户名或密码错误' })
  }

  const token = signToken({ uid: user.id, username: user.username, role: user.role })
  logAudit({ username: user.username, action: 'login', detail: '登录成功', ip: clientIp(req) })
  res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role },
  })
})

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.uid, username: req.user.username, role: req.user.role } })
})

export default router

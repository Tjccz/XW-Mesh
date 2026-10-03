import axios from 'axios'
import { ElMessage } from 'element-plus'

const api = axios.create({ baseURL: '/api', timeout: 20000 })
const TOKEN_KEY = 'xw_token'

export const getToken = () => localStorage.getItem(TOKEN_KEY)
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t)
export const clearToken = () => localStorage.removeItem(TOKEN_KEY)

api.interceptors.request.use((config) => {
  const token = getToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  (res) => res,
  (err) => {
    const status = err.response?.status
    const message = err.response?.data?.error || err.message || '请求失败'

    if (status === 401 && !location.pathname.startsWith('/login')) {
      clearToken()
      location.href = '/login'
    } else if (status !== 401) {
      ElMessage.error(message)
    }
    return Promise.reject(err)
  }
)

export default api

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessageBox } from 'element-plus'
import api, { clearToken } from '../api.js'

const route = useRoute()
const router = useRouter()

const me = ref(null)
const workspace = ref(null)

const groups = [
  {
    title: '总览',
    items: [{ path: '/dashboard', label: '控制台总览', icon: 'Odometer' }],
  },
  {
    title: '组网',
    items: [
      { path: '/networks', label: '网络管理', icon: 'Share' },
      { path: '/subnets', label: '子网路由', icon: 'Guide' },
      { path: '/acl', label: '访问控制', icon: 'Lock' },
    ],
  },
  {
    title: '设备',
    items: [
      { path: '/nodes', label: '设备管理', icon: 'Monitor' },
      { path: '/access-keys', label: '接入密钥', icon: 'Key' },
    ],
  },
  {
    title: '观测',
    items: [
      { path: '/metrics', label: '流量监控', icon: 'TrendCharts' },
      { path: '/usage', label: '用量统计', icon: 'PieChart' },
      { path: '/alerts', label: '告警中心', icon: 'Bell' },
      { path: '/audit', label: '审计日志', icon: 'Tickets' },
    ],
  },
  {
    title: '组织',
    items: [
      { path: '/workspace', label: '工作区设置', icon: 'OfficeBuilding' },
      { path: '/members', label: '成员管理', icon: 'UserFilled' },
    ],
  },
]

const activePath = computed(() => {
  const p = route.path
  if (p.startsWith('/nodes')) return '/nodes'
  return p
})

const roleLabel = computed(() => me.value?.roleLabel || '')
const planLabel = computed(() => {
  const plan = workspace.value?.plan
  return { selfhost: '自建版', pro: '专业版', free: '试用版' }[plan] || plan || ''
})

async function logout() {
  try {
    await ElMessageBox.confirm('确定要退出登录吗？', '提示', { type: 'warning' })
  } catch {
    return
  }
  clearToken()
  localStorage.removeItem('xw_user')
  router.push('/login')
}

onMounted(async () => {
  try {
    const { data } = await api.get('/auth/me')
    me.value = data.user
    workspace.value = data.user?.workspace || null
    localStorage.setItem('xw_user', data.user.username)
  } catch {
    /* 拦截器已处理 */
  }
})
</script>

<template>
  <div class="xw-shell">
    <aside class="xw-side">
      <div class="xw-brand">
        <div class="xw-brand-mark">湘</div>
        <div>
          <div class="xw-brand-name">湘网组网</div>
          <div class="xw-brand-sub">XIANGWANG MESH</div>
        </div>
      </div>

      <div v-if="workspace" class="xw-ws-badge">
        <div class="xw-ws-name" :title="workspace.name">{{ workspace.name }}</div>
        <div class="xw-ws-plan">{{ planLabel }}</div>
      </div>

      <nav class="xw-nav">
        <template v-for="group in groups" :key="group.title">
          <div class="xw-nav-group">{{ group.title }}</div>
          <router-link
            v-for="item in group.items"
            :key="item.path"
            :to="item.path"
            class="xw-nav-item"
            :class="{ active: activePath === item.path }"
          >
            <el-icon><component :is="item.icon" /></el-icon>
            <span>{{ item.label }}</span>
          </router-link>
        </template>
      </nav>

      <div class="xw-side-foot">
        <div class="xw-user">
          <el-icon><UserFilled /></el-icon>
          <div class="xw-user-info">
            <span class="xw-user-name">{{ me?.displayName || me?.username || '—' }}</span>
            <span class="xw-user-role">{{ roleLabel }}</span>
          </div>
        </div>
        <el-button text size="small" class="xw-logout" @click="logout">
          <el-icon><SwitchButton /></el-icon>
        </el-button>
      </div>
    </aside>

    <main class="xw-main">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.xw-shell {
  display: flex;
  min-height: 100vh;
}

.xw-side {
  width: 222px;
  flex: 0 0 222px;
  background: linear-gradient(180deg, #0f2b33 0%, #123640 100%);
  color: #cfe6e4;
  display: flex;
  flex-direction: column;
  padding: 18px 14px 14px;
  position: sticky;
  top: 0;
  height: 100vh;
}

.xw-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 8px 14px;
}

.xw-brand-mark {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background: #0d9488;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 17px;
  font-weight: 600;
  flex: 0 0 34px;
}

.xw-brand-name {
  font-size: 15px;
  font-weight: 600;
  color: #fff;
  letter-spacing: 1px;
}

.xw-brand-sub {
  font-size: 10px;
  color: #6f9aa1;
  letter-spacing: 1.2px;
  margin-top: 2px;
}

.xw-ws-badge {
  margin: 0 8px 14px;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.07);
}

.xw-ws-name {
  font-size: 12.5px;
  color: #e6f4f2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.xw-ws-plan {
  font-size: 10.5px;
  color: #7fb3b6;
  margin-top: 2px;
}

.xw-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  overflow-y: auto;
  padding-right: 2px;
}

.xw-nav-group {
  font-size: 10.5px;
  letter-spacing: 1px;
  color: #5c8b91;
  padding: 12px 12px 5px;
}

.xw-nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 8px;
  color: #a9c9cc;
  text-decoration: none;
  font-size: 13.5px;
  transition: background 0.15s, color 0.15s;
}

.xw-nav-item:hover {
  background: rgba(255, 255, 255, 0.06);
  color: #e6f4f2;
}

.xw-nav-item.active {
  background: #0d9488;
  color: #fff;
  font-weight: 500;
}

.xw-side-foot {
  border-top: 1px solid rgba(255, 255, 255, 0.09);
  padding-top: 12px;
  margin-top: 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.xw-user {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.xw-user-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.xw-user-name {
  font-size: 12.5px;
  color: #cfe6e4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.xw-user-role {
  font-size: 10.5px;
  color: #6f9aa1;
}

.xw-logout {
  color: #a9c9cc !important;
}

.xw-logout:hover {
  color: #fff !important;
}

.xw-main {
  flex: 1;
  min-width: 0;
}
</style>

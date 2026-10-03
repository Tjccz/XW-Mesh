<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessageBox } from 'element-plus'
import { clearToken } from '../api.js'

const route = useRoute()
const router = useRouter()
const username = ref(localStorage.getItem('xw_user') || 'admin')

const menu = [
  { path: '/dashboard', label: '总览', icon: 'DataLine' },
  { path: '/networks', label: '网络管理', icon: 'Share' },
  { path: '/nodes', label: '节点管理', icon: 'Monitor' },
  { path: '/audit', label: '审计日志', icon: 'Tickets' },
]

const activePath = computed(() =>
  route.path.startsWith('/nodes') ? '/nodes' : route.path
)

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

      <nav class="xw-nav">
        <router-link
          v-for="item in menu"
          :key="item.path"
          :to="item.path"
          class="xw-nav-item"
          :class="{ active: activePath === item.path }"
        >
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
        </router-link>
      </nav>

      <div class="xw-side-foot">
        <div class="xw-user">
          <el-icon><UserFilled /></el-icon>
          <span>{{ username }}</span>
        </div>
        <el-button text size="small" class="xw-logout" @click="logout">
          <el-icon><SwitchButton /></el-icon>
          <span style="margin-left: 4px">退出</span>
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
  width: 216px;
  flex: 0 0 216px;
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
  padding: 4px 8px 18px;
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

.xw-nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}

.xw-nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  color: #a9c9cc;
  text-decoration: none;
  font-size: 14px;
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
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.xw-user {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #a9c9cc;
  overflow: hidden;
  white-space: nowrap;
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

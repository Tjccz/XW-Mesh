<script setup>
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api.js'

const router = useRouter()
const loading = ref(true)
const stats = ref({ networks: 0, nodes: 0, online: 0, offline: 0, pending: 0 })
const networks = ref([])
const recent = ref([])

const actionLabel = {
  login: '登录',
  login_failed: '登录失败',
  network_create: '创建网络',
  network_update: '更新网络',
  network_delete: '删除网络',
  node_create: '新增节点',
  node_update: '更新节点',
  node_delete: '删除节点',
  node_rollback: '回滚配置',
  node_provision: '获取接入脚本',
}

const fmt = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—')

onMounted(async () => {
  try {
    const { data } = await api.get('/overview')
    stats.value = data.stats
    networks.value = data.networks
    recent.value = data.recentAudit
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="xw-page" v-loading="loading">
    <div class="xw-page-head">
      <div>
        <h1 class="xw-page-title">总览</h1>
        <p class="xw-page-desc">当前组网与设备接入的整体情况</p>
      </div>
      <el-button type="primary" @click="router.push('/nodes')">
        <el-icon style="margin-right: 4px"><Plus /></el-icon>接入新节点
      </el-button>
    </div>

    <div class="xw-stat-grid">
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><Share /></el-icon>网络</div>
        <div class="xw-stat-value">{{ stats.networks }}<small>张</small></div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><Monitor /></el-icon>节点总数</div>
        <div class="xw-stat-value">{{ stats.nodes }}<small>台</small></div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><CircleCheck /></el-icon>在线</div>
        <div class="xw-stat-value" style="color: #0d9488">
          {{ stats.online }}<small>台</small>
        </div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><Warning /></el-icon>待接入 / 离线</div>
        <div class="xw-stat-value" style="color: #b45309">
          {{ stats.pending + stats.offline }}<small>台</small>
        </div>
      </div>
    </div>

    <div class="grid-two">
      <div class="xw-card">
        <div class="card-head">
          <h3>网络概览</h3>
          <el-button text type="primary" size="small" @click="router.push('/networks')">
            查看全部
          </el-button>
        </div>

        <el-table :data="networks" size="default" style="width: 100%">
          <el-table-column prop="name" label="网络名称" min-width="140">
            <template #default="{ row }">
              <span class="xw-mono" style="font-weight: 600; color: #0f2b33">{{ row.name }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="cidr" label="虚拟网段" min-width="140" />
          <el-table-column label="节点" width="110" align="center">
            <template #default="{ row }">
              <span style="color: #0d9488; font-weight: 600">{{ row.nodeOnline }}</span>
              <span style="color: #9ca3af"> / {{ row.nodeTotal }}</span>
            </template>
          </el-table-column>
          <el-table-column label="" width="90" align="right">
            <template #default="{ row }">
              <el-button text type="primary" size="small" @click="router.push('/nodes')">
                管理
              </el-button>
            </template>
          </el-table-column>
          <template #empty>
            <div class="xw-empty">还没有创建任何网络，先去「网络管理」建一张吧</div>
          </template>
        </el-table>
      </div>

      <div class="xw-card">
        <div class="card-head">
          <h3>最近操作</h3>
          <el-button text type="primary" size="small" @click="router.push('/audit')">
            全部日志
          </el-button>
        </div>

        <div v-if="!recent.length" class="xw-empty">暂无操作记录</div>
        <ul v-else class="feed">
          <li v-for="item in recent" :key="item.id">
            <span class="feed-dot" :class="{ warn: item.action === 'login_failed' }"></span>
            <div class="feed-body">
              <div class="feed-line">
                <el-tag size="small" effect="plain" type="info">
                  {{ actionLabel[item.action] || item.action }}
                </el-tag>
                <span class="feed-user">{{ item.username || '系统' }}</span>
              </div>
              <div class="feed-detail">{{ item.detail }}</div>
              <div class="feed-time">{{ fmt(item.createdAt) }}</div>
            </div>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.grid-two {
  display: grid;
  grid-template-columns: 1.35fr 1fr;
  gap: 16px;
  align-items: start;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.card-head h3 {
  margin: 0;
  font-size: 15px;
  color: #0f2b33;
  font-weight: 600;
}

.feed {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 420px;
  overflow: auto;
}

.feed li {
  display: flex;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px dashed #eef2f3;
}

.feed li:last-child {
  border-bottom: none;
}

.feed-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #0d9488;
  margin-top: 7px;
  flex: 0 0 7px;
}

.feed-dot.warn {
  background: #e11d48;
}

.feed-body {
  min-width: 0;
  flex: 1;
}

.feed-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.feed-user {
  font-size: 12px;
  color: #6b7280;
}

.feed-detail {
  font-size: 13px;
  color: #374151;
  margin-top: 4px;
  line-height: 1.55;
}

.feed-time {
  font-size: 11.5px;
  color: #a1a8ae;
  margin-top: 3px;
}

@media (max-width: 1080px) {
  .grid-two {
    grid-template-columns: 1fr;
  }
}
</style>

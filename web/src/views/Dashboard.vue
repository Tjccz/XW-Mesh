<script setup>
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api.js'
import BarChart from '../components/BarChart.vue'
import { formatBytes, formatNumber, formatTime, NODE_STATUS } from '../format.js'

const router = useRouter()
const loading = ref(true)
const data = ref(null)
const buckets = ref([])

const ACTION_LABEL = {
  login: '登录',
  login_failed: '登录失败',
  workspace_update: '更新工作区',
  member_invite: '添加成员',
  member_update: '调整角色',
  member_remove: '移除成员',
  network_create: '创建网络',
  network_update: '更新网络',
  network_delete: '删除网络',
  node_create: '添加设备',
  node_update: '更新设备',
  node_delete: '删除设备',
  node_block: '停止设备',
  node_unblock: '恢复设备',
  node_resync: '重发配置',
  node_rollback: '回滚配置',
  node_register: '设备接入',
  key_create: '创建密钥',
  key_revoke: '吊销密钥',
  subnet_create: '添加子网',
  subnet_delete: '删除子网',
  acl_create: '添加规则',
  acl_update: '更新规则',
  acl_delete: '删除规则',
}

onMounted(async () => {
  try {
    const [overview, series] = await Promise.all([
      api.get('/overview'),
      api.get('/metrics/series', { params: { hours: 24 } }),
    ])
    data.value = overview.data
    buckets.value = series.data.buckets
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="xw-page" v-loading="loading">
    <div class="xw-page-head">
      <div>
        <h1 class="xw-page-title">控制台总览</h1>
        <p class="xw-page-desc">
          {{ data?.workspace?.name || '工作区' }} ·
          {{ data?.workspace?.planLabel || '自建版' }} · 核心 v{{ data?.system?.etVersion || '—' }}
        </p>
      </div>
      <div style="display: flex; gap: 8px">
        <el-button @click="router.push('/access-keys')">
          <el-icon style="margin-right: 4px"><Key /></el-icon>生成接入密钥
        </el-button>
        <el-button type="primary" @click="router.push('/nodes')">
          <el-icon style="margin-right: 4px"><Plus /></el-icon>接入设备
        </el-button>
      </div>
    </div>

    <div class="xw-stat-grid">
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><Share /></el-icon>网络</div>
        <div class="xw-stat-value">{{ data?.stats?.networks ?? 0 }}<small>张</small></div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><Monitor /></el-icon>设备总数</div>
        <div class="xw-stat-value">{{ data?.stats?.nodes ?? 0 }}<small>台</small></div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><CircleCheck /></el-icon>在线</div>
        <div class="xw-stat-value" style="color: #0d9488">
          {{ data?.stats?.online ?? 0 }}<small>台</small>
        </div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><Warning /></el-icon>离线 / 待接入</div>
        <div class="xw-stat-value" style="color: #b45309">
          {{ (data?.stats?.offline ?? 0) + (data?.stats?.pending ?? 0) }}<small>台</small>
        </div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><Key /></el-icon>可用密钥</div>
        <div class="xw-stat-value">{{ data?.stats?.keys ?? 0 }}<small>个</small></div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><Lock /></el-icon>访问控制规则</div>
        <div class="xw-stat-value">{{ data?.stats?.aclRules ?? 0 }}<small>条</small></div>
      </div>
    </div>

    <div class="xw-card">
      <div class="xw-card-head">
        <h3>近 24 小时流量<span class="sub">按小时聚合，来自设备网卡计数</span></h3>
        <div class="traffic-sum">
          <span>
            今日接收
            <b>{{ formatBytes(data?.traffic?.todayRx) }}</b>
            发送
            <b>{{ formatBytes(data?.traffic?.todayTx) }}</b>
          </span>
          <el-button text type="primary" size="small" @click="router.push('/metrics')">
            详情
          </el-button>
        </div>
      </div>
      <BarChart :buckets="buckets" :height="200" />
    </div>

    <div class="grid-two">
      <div class="xw-card">
        <div class="xw-card-head">
          <h3>网络概览</h3>
          <el-button text type="primary" size="small" @click="router.push('/networks')">
            全部网络
          </el-button>
        </div>

        <el-table :data="data?.networks || []" size="default" style="width: 100%">
          <el-table-column prop="name" label="网络名称" min-width="150">
            <template #default="{ row }">
              <span class="xw-mono xw-strong">{{ row.name }}</span>
              <div class="sub-line xw-mono">{{ row.cidr }}</div>
            </template>
          </el-table-column>
          <el-table-column label="设备" width="100" align="center">
            <template #default="{ row }">
              <span style="color: #0d9488; font-weight: 600">{{ row.nodeOnline }}</span>
              <span class="xw-dim"> / {{ row.nodeTotal }}</span>
            </template>
          </el-table-column>
          <el-table-column label="区域" width="80" align="center">
            <template #default="{ row }">
              <el-tag size="small" effect="plain" type="info">{{ row.region }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="" width="86" align="right">
            <template #default="{ row }">
              <el-button text type="primary" size="small" @click="router.push(`/nodes?networkId=${row.id}`)">
                设备
              </el-button>
            </template>
          </el-table-column>
          <template #empty>
            <div class="xw-empty">还没有网络，先去「网络管理」建一张</div>
          </template>
        </el-table>
      </div>

      <div class="xw-card">
        <div class="xw-card-head">
          <h3>流量 Top 5</h3>
          <el-button text type="primary" size="small" @click="router.push('/metrics')">
            全部
          </el-button>
        </div>
        <div v-if="!data?.topNodes?.length" class="xw-empty">暂无设备</div>
        <ul v-else class="top-list">
          <li v-for="(n, i) in data.topNodes" :key="n.id">
            <span class="rank" :class="{ hot: i < 3 }">{{ i + 1 }}</span>
            <div class="top-body">
              <div class="top-name">
                {{ n.name }}
                <el-tag
                  size="small"
                  effect="plain"
                  :type="NODE_STATUS[n.status]?.type || 'info'"
                >
                  {{ NODE_STATUS[n.status]?.text || n.status }}
                </el-tag>
              </div>
              <div class="top-sub xw-mono">{{ n.networkName }} · {{ n.virtualIp }}</div>
            </div>
            <span class="top-val xw-mono">{{ formatBytes(n.traffic) }}</span>
          </li>
        </ul>
      </div>
    </div>

    <div class="xw-card">
      <div class="xw-card-head">
        <h3>最近操作</h3>
        <el-button text type="primary" size="small" @click="router.push('/audit')">
          全部日志
        </el-button>
      </div>
      <div v-if="!data?.recentAudit?.length" class="xw-empty">暂无操作记录</div>
      <ul v-else class="feed">
        <li v-for="item in data.recentAudit" :key="item.id">
          <span class="feed-dot" :class="{ warn: item.action === 'login_failed' }"></span>
          <div class="feed-body">
            <div class="feed-line">
              <el-tag size="small" effect="plain" type="info">
                {{ ACTION_LABEL[item.action] || item.action }}
              </el-tag>
              <span class="feed-user">{{ item.username || '系统' }}</span>
            </div>
            <div class="feed-detail">{{ item.detail }}</div>
            <div class="feed-time">{{ formatTime(item.createdAt) }}</div>
          </div>
        </li>
      </ul>
    </div>

    <div class="sys-line">
      控制台 v{{ data?.system?.version }} · 内置核心 v{{ data?.system?.etVersion }} ·
      Node {{ data?.system?.nodeVersion }} · 已运行
      {{ Math.floor((data?.system?.uptimeSeconds || 0) / 60) }} 分钟 · 设备总数
      {{ formatNumber(data?.stats?.nodes) }}
    </div>
  </div>
</template>

<style scoped>
.grid-two {
  display: grid;
  grid-template-columns: 1.3fr 1fr;
  gap: 16px;
  align-items: start;
  margin-top: 16px;
}

.traffic-sum {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12.5px;
  color: #6b7280;
}

.traffic-sum b {
  color: #0d9488;
  margin: 0 8px 0 3px;
  font-variant-numeric: tabular-nums;
}

.sub-line {
  font-size: 11.5px;
  color: #9ca3af;
  margin-top: 2px;
}

.top-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.top-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 0;
  border-bottom: 1px dashed #eef2f3;
}

.top-list li:last-child {
  border-bottom: none;
}

.rank {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: #f1f5f6;
  color: #9ca3af;
  font-size: 11.5px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 20px;
}

.rank.hot {
  background: #e2f2f0;
  color: #0d9488;
  font-weight: 600;
}

.top-body {
  flex: 1;
  min-width: 0;
}

.top-name {
  font-size: 13px;
  color: #0f2b33;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 6px;
}

.top-sub {
  font-size: 11.5px;
  color: #9ca3af;
  margin-top: 2px;
}

.top-val {
  font-size: 12.5px;
  color: #0f766e;
  font-variant-numeric: tabular-nums;
}

.feed {
  list-style: none;
  margin: 0;
  padding: 0;
}

.feed li {
  display: flex;
  gap: 10px;
  padding: 9px 0;
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

.sys-line {
  margin-top: 16px;
  font-size: 11.5px;
  color: #a1a8ae;
  text-align: center;
}

@media (max-width: 1080px) {
  .grid-two {
    grid-template-columns: 1fr;
  }
}
</style>

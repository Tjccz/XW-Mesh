<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api.js'
import BarChart from '../components/BarChart.vue'
import { formatBytes } from '../format.js'

const router = useRouter()
const loading = ref(true)
const data = ref(null)
const daily = ref([])
const days = ref(14)

const dayOptions = [
  { label: '近 7 天', value: 7 },
  { label: '近 14 天', value: 14 },
  { label: '近 30 天', value: 30 },
  { label: '近 90 天', value: 90 },
]

const totalTraffic = computed(
  () => (data.value?.traffic?.totalRx || 0) + (data.value?.traffic?.totalTx || 0)
)

const weekTotal = computed(
  () => (data.value?.traffic?.week?.rx || 0) + (data.value?.traffic?.week?.tx || 0)
)

const monthTotal = computed(
  () => (data.value?.traffic?.month?.rx || 0) + (data.value?.traffic?.month?.tx || 0)
)

const todayTotal = computed(
  () => (data.value?.traffic?.today?.rx || 0) + (data.value?.traffic?.today?.tx || 0)
)

const dailyAvg = computed(() => {
  if (!daily.value.length) return 0
  const sum = daily.value.reduce((s, b) => s + b.rx + b.tx, 0)
  return sum / daily.value.length
})

function quotaPercent(row) {
  if (!row.limit) return 0
  return Math.min(100, Math.round((row.used / row.limit) * 100))
}

function quotaColor(row) {
  const p = quotaPercent(row)
  if (p >= 90) return '#e11d48'
  if (p >= 70) return '#d97706'
  return '#0d9488'
}

async function load() {
  loading.value = true
  try {
    const [overview, dailyRes] = await Promise.all([
      api.get('/usage'),
      api.get('/usage/daily', { params: { days: days.value } }),
    ])
    data.value = overview.data
    daily.value = dailyRes.data.buckets
  } finally {
    loading.value = false
  }
}

async function exportCsv() {
  const res = await api.get('/usage/export.csv', { responseType: 'blob' })
  const url = URL.createObjectURL(new Blob([res.data], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'xiangwang-usage.csv'
  a.click()
  URL.revokeObjectURL(url)
}

onMounted(load)
</script>

<template>
  <div class="xw-page" v-loading="loading">
    <div class="xw-page-head">
      <div>
        <h1 class="xw-page-title">用量统计</h1>
        <p class="xw-page-desc">
          工作区资源占用与流量消耗，用于对账与容量规划
        </p>
      </div>
      <div style="display: flex; gap: 8px">
        <el-button @click="exportCsv">
          <el-icon style="margin-right: 4px"><Download /></el-icon>导出 CSV
        </el-button>
        <el-button type="primary" @click="router.push('/workspace')">工作区设置</el-button>
      </div>
    </div>

    <div class="xw-stat-grid">
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><Calendar /></el-icon>今日流量</div>
        <div class="xw-stat-value" style="font-size: 22px">{{ formatBytes(todayTotal) }}</div>
        <div class="xw-hint">接收 {{ formatBytes(data?.traffic?.today?.rx) }}</div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><DataLine /></el-icon>近 7 天</div>
        <div class="xw-stat-value" style="font-size: 22px">{{ formatBytes(weekTotal) }}</div>
        <div class="xw-hint">日均 {{ formatBytes(dailyAvg) }}</div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><TrendCharts /></el-icon>近 30 天</div>
        <div class="xw-stat-value" style="font-size: 22px">{{ formatBytes(monthTotal) }}</div>
        <div class="xw-hint">按自然日聚合</div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><Histogram /></el-icon>累计总量</div>
        <div class="xw-stat-value" style="font-size: 22px">{{ formatBytes(totalTraffic) }}</div>
        <div class="xw-hint">含全部历史采样</div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><Key /></el-icon>密钥接入设备</div>
        <div class="xw-stat-value">{{ data?.keys?.registrations ?? 0 }}<small>台</small></div>
        <div class="xw-hint">可用密钥 {{ data?.keys?.active ?? 0 }} 个</div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><UserFilled /></el-icon>工作区成员</div>
        <div class="xw-stat-value">{{ data?.members ?? 0 }}<small>人</small></div>
        <div class="xw-hint">近 7 天 {{ data?.audit7d ?? 0 }} 条操作记录</div>
      </div>
    </div>

    <div class="grid-two">
      <div class="xw-card">
        <div class="xw-card-head">
          <h3>按天流量</h3>
          <el-select v-model="days" style="width: 130px" size="small" @change="load">
            <el-option v-for="o in dayOptions" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </div>
        <BarChart :buckets="daily" :height="220" />
      </div>

      <div class="xw-card">
        <div class="xw-card-head">
          <h3>套餐配额<span class="sub">{{ data?.workspace?.planLabel }}</span></h3>
        </div>
        <div class="xw-quota">
          <div v-for="q in data?.quota || []" :key="q.key" class="xw-quota-row">
            <span class="name">{{ q.label }}</span>
            <div class="bar-track">
              <div
                class="bar-fill"
                :style="{ width: quotaPercent(q) + '%', background: quotaColor(q) }"
              ></div>
            </div>
            <span class="num"><b>{{ q.used }}</b> / {{ q.limit }}</span>
          </div>
        </div>
        <div class="xw-hint" style="margin-top: 14px">
          自建版不限量。切换套餐可在「工作区设置」中完成，用于演示或限制租户规模。
        </div>
      </div>
    </div>

    <div class="xw-card">
      <div class="xw-card-head">
        <h3>按网络分布<span class="sub">近 7 天流量</span></h3>
      </div>
      <el-table :data="data?.networks || []" style="width: 100%">
        <el-table-column label="网络" min-width="170">
          <template #default="{ row }">
            <div class="xw-strong">{{ row.name }}</div>
            <div class="sub-line xw-mono">{{ row.cidr }}</div>
          </template>
        </el-table-column>
        <el-table-column label="设备" width="100" align="center">
          <template #default="{ row }">
            <span style="color: #0d9488; font-weight: 600">{{ row.nodeOnline }}</span>
            <span class="xw-dim"> / {{ row.nodeTotal }}</span>
          </template>
        </el-table-column>
        <el-table-column label="子网路由" width="100" align="center">
          <template #default="{ row }">
            <span>{{ row.subnetRoutes }}</span>
          </template>
        </el-table-column>
        <el-table-column label="访问控制" width="100" align="center">
          <template #default="{ row }">
            <span>{{ row.aclRules }}</span>
          </template>
        </el-table-column>
        <el-table-column label="接收" width="120" align="right">
          <template #default="{ row }">
            <span class="xw-mono">{{ formatBytes(row.weekRx) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="发送" width="120" align="right">
          <template #default="{ row }">
            <span class="xw-mono">{{ formatBytes(row.weekTx) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="合计" width="120" align="right">
          <template #default="{ row }">
            <span class="xw-mono xw-strong">{{ formatBytes(row.weekRx + row.weekTx) }}</span>
          </template>
        </el-table-column>
        <template #empty>
          <div class="xw-empty">还没有网络用量数据</div>
        </template>
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.grid-two {
  display: grid;
  grid-template-columns: 1.4fr 1fr;
  gap: 16px;
  align-items: start;
  margin-top: 16px;
}

.sub-line {
  font-size: 11.5px;
  color: #9ca3af;
  margin-top: 2px;
}

.bar-track {
  height: 8px;
  background: #f1f5f6;
  border-radius: 4px;
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.3s;
}

@media (max-width: 1080px) {
  .grid-two {
    grid-template-columns: 1fr;
  }
}
</style>

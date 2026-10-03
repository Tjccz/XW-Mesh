<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import api from '../api.js'
import BarChart from '../components/BarChart.vue'
import { formatBytes, fromNow, NODE_STATUS } from '../format.js'

const router = useRouter()
const loading = ref(true)
const summary = ref(null)
const buckets = ref([])
const nodeRows = ref([])
const networks = ref([])
const hours = ref(24)
const networkId = ref(null)
const detailVisible = ref(false)
const detail = ref({ node: null, buckets: [], loading: false })

const hourOptions = [
  { label: '近 6 小时', value: 6 },
  { label: '近 24 小时', value: 24 },
  { label: '近 3 天', value: 72 },
  { label: '近 7 天', value: 168 },
  { label: '近 30 天', value: 720 },
]

const periodTotal = computed(() => (summary.value?.periodRx || 0) + (summary.value?.periodTx || 0))
const maxNodeTraffic = computed(() =>
  Math.max(1, ...nodeRows.value.map((n) => n.periodTotal || 0))
)

async function load() {
  loading.value = true
  try {
    const params = { hours: hours.value }
    const nodeParams = { ...params }
    if (networkId.value) {
      nodeParams.networkId = networkId.value
      params.networkId = networkId.value
    }
    const [sumRes, seriesRes, nodesRes] = await Promise.all([
      api.get('/metrics/summary', { params: { hours: hours.value } }),
      api.get('/metrics/series', { params }),
      api.get('/metrics/nodes', { params: nodeParams }),
    ])
    summary.value = sumRes.data
    buckets.value = seriesRes.data.buckets
    nodeRows.value = nodesRes.data.items
  } finally {
    loading.value = false
  }
}

async function openDetail(row) {
  detailVisible.value = true
  detail.value = { node: row, buckets: [], loading: true }
  try {
    const { data } = await api.get(`/metrics/nodes/${row.id}/series`, {
      params: { hours: hours.value },
    })
    detail.value = { node: { ...row, ...data.node }, buckets: data.buckets, loading: false }
  } catch {
    detailVisible.value = false
  }
}

onMounted(async () => {
  const { data } = await api.get('/networks')
  networks.value = data.items
  await load()
})
</script>

<template>
  <div class="xw-page" v-loading="loading">
    <div class="xw-page-head">
      <div>
        <h1 class="xw-page-title">流量监控</h1>
        <p class="xw-page-desc">数据来自每台设备每 30 秒一次的心跳采样，按网卡计数差分统计</p>
      </div>
      <div style="display: flex; gap: 8px">
        <el-select v-model="networkId" placeholder="全部网络" clearable style="width: 180px" @change="load">
          <el-option v-for="n in networks" :key="n.id" :label="n.name" :value="n.id" />
        </el-select>
        <el-select v-model="hours" style="width: 140px" @change="load">
          <el-option v-for="o in hourOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
      </div>
    </div>

    <div class="xw-stat-grid">
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><Monitor /></el-icon>设备在线率</div>
        <div class="xw-stat-value" style="color: #0d9488">
          {{ summary?.onlineRate ?? 0 }}<small>%</small>
        </div>
        <div class="xw-hint">{{ summary?.nodes?.online ?? 0 }} / {{ summary?.nodes?.total ?? 0 }} 台在线</div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><Connection /></el-icon>活跃邻居连接</div>
        <div class="xw-stat-value">{{ summary?.activeTunnels ?? 0 }}<small>条</small></div>
        <div class="xw-hint">所有在线设备已建立的隧道数之和</div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><Download /></el-icon>周期接收</div>
        <div class="xw-stat-value" style="font-size: 22px">
          {{ formatBytes(summary?.periodRx) }}
        </div>
        <div class="xw-hint">覆盖所选时间范围</div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><Upload /></el-icon>周期发送</div>
        <div class="xw-stat-value" style="font-size: 22px">
          {{ formatBytes(summary?.periodTx) }}
        </div>
        <div class="xw-hint">周期合计 {{ formatBytes(periodTotal) }}</div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><DataLine /></el-icon>累计流量</div>
        <div class="xw-stat-value" style="font-size: 22px">
          {{ formatBytes(summary?.totalTraffic) }}
        </div>
        <div class="xw-hint">自设备接入以来的总量</div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><Clock /></el-icon>最后采样</div>
        <div class="xw-stat-value" style="font-size: 18px">
          {{ fromNow(summary?.lastSampleAt) }}
        </div>
        <div class="xw-hint">设备心跳周期 30 秒</div>
      </div>
    </div>

    <div class="xw-card">
      <div class="xw-card-head">
        <h3>全网流量趋势</h3>
        <span class="xw-hint">接收 {{ formatBytes(buckets.reduce((s, b) => s + b.rx, 0)) }} · 发送
          {{ formatBytes(buckets.reduce((s, b) => s + b.tx, 0)) }}</span>
      </div>
      <BarChart :buckets="buckets" :height="230" />
    </div>

    <div class="xw-card">
      <div class="xw-card-head">
        <h3>设备流量明细<span class="sub">按周期流量排序</span></h3>
      </div>

      <el-table :data="nodeRows" style="width: 100%">
        <el-table-column label="设备" min-width="170">
          <template #default="{ row }">
            <div class="xw-strong">{{ row.name }}</div>
            <div class="sub-line xw-mono">{{ row.networkName }} · {{ row.virtualIp }}</div>
          </template>
        </el-table-column>

        <el-table-column label="状态" width="96">
          <template #default="{ row }">
            <el-tag :type="NODE_STATUS[row.status]?.type || 'info'" size="small" effect="light">
              {{ NODE_STATUS[row.status]?.text || row.status }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="邻居" width="76" align="center">
          <template #default="{ row }">
            <span v-if="row.status === 'online'">{{ row.peerCount }}</span>
            <span v-else class="xw-dim">—</span>
          </template>
        </el-table-column>

        <el-table-column label="周期流量占比" min-width="200">
          <template #default="{ row }">
            <div class="bar-wrap">
              <div class="bar-track">
                <div
                  class="bar-fill"
                  :style="{ width: Math.max((row.periodTotal / maxNodeTraffic) * 100, row.periodTotal ? 2 : 0) + '%' }"
                ></div>
              </div>
              <span class="bar-text xw-mono">{{ formatBytes(row.periodTotal) }}</span>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="接收" width="110" align="right">
          <template #default="{ row }">
            <span class="xw-mono">{{ formatBytes(row.periodRx) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="发送" width="110" align="right">
          <template #default="{ row }">
            <span class="xw-mono">{{ formatBytes(row.periodTx) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="累计" width="110" align="right">
          <template #default="{ row }">
            <span class="xw-mono xw-dim">{{ formatBytes(row.totalRx + row.totalTx) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="最后上报" width="120">
          <template #default="{ row }">
            <span style="font-size: 12.5px; color: #6b7280">{{ fromNow(row.lastSeen) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="" width="76" align="right">
          <template #default="{ row }">
            <el-button text type="primary" size="small" @click="openDetail(row)">曲线</el-button>
          </template>
        </el-table-column>

        <template #empty>
          <div class="xw-empty">还没有设备上报流量。设备接入后 1 分钟内会出现首条采样。</div>
        </template>
      </el-table>
    </div>

    <el-dialog
      v-model="detailVisible"
      :title="`流量曲线 · ${detail.node?.name || ''}`"
      width="760px"
      destroy-on-close
    >
      <div v-loading="detail.loading">
        <div class="xw-kv" style="margin-bottom: 14px">
          <div class="xw-kv-item">
            <div class="xw-kv-label">虚拟 IP</div>
            <div class="xw-kv-value xw-mono">{{ detail.node?.virtualIp || '—' }}</div>
          </div>
          <div class="xw-kv-item">
            <div class="xw-kv-label">当前邻居数</div>
            <div class="xw-kv-value">{{ detail.node?.peerCount ?? 0 }}</div>
          </div>
          <div class="xw-kv-item">
            <div class="xw-kv-label">采样点数</div>
            <div class="xw-kv-value">{{ detail.buckets.length }}</div>
          </div>
        </div>
        <BarChart :buckets="detail.buckets" :height="220" />
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.sub-line {
  font-size: 11.5px;
  color: #9ca3af;
  margin-top: 2px;
}

.bar-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
}

.bar-track {
  flex: 1;
  height: 7px;
  background: #f1f5f6;
  border-radius: 4px;
  overflow: hidden;
  min-width: 60px;
}

.bar-fill {
  height: 100%;
  background: linear-gradient(90deg, #0d9488, #4fb3a9);
  border-radius: 4px;
  transition: width 0.3s;
}

.bar-text {
  font-size: 12px;
  color: #6b7280;
  min-width: 72px;
  text-align: right;
}
</style>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api.js'
import BarChart from '../components/BarChart.vue'
import { NODE_STATUS, formatBytes, formatTime, fromNow, copyText } from '../format.js'

const route = useRoute()
const router = useRouter()
const nodeId = route.params.id

const loading = ref(true)
const node = ref(null)
const network = ref(null)
const configs = ref([])
const currentVersion = ref(0)
const buckets = ref([])
const samples = ref([])
const hours = ref(24)

const editVisible = ref(false)
const submitting = ref(false)
const form = reactive({ name: '', virtualIp: '', note: '' })

const hourOptions = [
  { label: '近 6 小时', value: 6 },
  { label: '近 24 小时', value: 24 },
  { label: '近 7 天', value: 168 },
  { label: '近 30 天', value: 720 },
]

async function load() {
  loading.value = true
  try {
    const [detail, configData, series, sampleData] = await Promise.all([
      api.get(`/nodes/${nodeId}`),
      api.get(`/nodes/${nodeId}/configs`),
      api.get(`/metrics/nodes/${nodeId}/series`, { params: { hours: hours.value } }),
      api.get(`/metrics/nodes/${nodeId}/samples`),
    ])
    node.value = detail.data.item
    network.value = detail.data.network
    configs.value = configData.data.items
    currentVersion.value = configData.data.currentVersion
    buckets.value = series.data.buckets
    samples.value = sampleData.data.items
  } finally {
    loading.value = false
  }
}

async function loadSeries() {
  const { data } = await api.get(`/metrics/nodes/${nodeId}/series`, {
    params: { hours: hours.value },
  })
  buckets.value = data.buckets
}

function openEdit() {
  Object.assign(form, {
    name: node.value.name,
    virtualIp: node.value.virtualIp,
    note: node.value.note,
  })
  editVisible.value = true
}

async function submitEdit() {
  if (!form.name.trim()) {
    ElMessage.warning('请填写设备名称')
    return
  }
  submitting.value = true
  try {
    await api.patch(`/nodes/${nodeId}`, {
      name: form.name.trim(),
      virtualIp: form.virtualIp,
      note: form.note,
    })
    ElMessage.success('已保存，设备将在 30 秒内自动应用新配置')
    editVisible.value = false
    await load()
  } finally {
    submitting.value = false
  }
}

async function resync() {
  const { data } = await api.post(`/nodes/${nodeId}/resync`)
  ElMessage.success(`已提升配置版本至 v${data.item.configVersion}`)
  await load()
}

async function toggleBlock() {
  const blocking = node.value.status !== 'blocked'
  try {
    await ElMessageBox.confirm(
      blocking
        ? '停止后设备会在 30 秒内断开组网（程序不卸载）。确定继续？'
        : '恢复后设备会重新上线。确定继续？',
      blocking ? '停止设备' : '恢复设备',
      { type: 'warning' }
    )
  } catch {
    return
  }
  await api.post(`/nodes/${nodeId}/${blocking ? 'block' : 'unblock'}`)
  ElMessage.success(blocking ? '已下发停止指令' : '已下发恢复指令')
  await load()
}

async function rollback(row) {
  try {
    await ElMessageBox.confirm(
      `将设备参数回滚到 v${row.version}？当前配置会保留为历史记录，回滚本身也会生成新版本。`,
      '确认回滚',
      { type: 'warning' }
    )
  } catch {
    return
  }
  await api.post(`/nodes/${nodeId}/rollback`, { version: row.version })
  ElMessage.success(`已回滚到 v${row.version}`)
  await load()
}

async function copy(text) {
  const okDone = await copyText(text)
  ElMessage[okDone ? 'success' : 'warning'](okDone ? '已复制' : '复制失败')
}

onMounted(load)
</script>

<template>
  <div class="xw-page" v-loading="loading">
    <div class="xw-page-head">
      <div>
        <el-button text @click="router.push('/nodes')" style="padding-left: 0; margin-bottom: 6px">
          <el-icon><ArrowLeft /></el-icon>
          <span style="margin-left: 4px">返回设备列表</span>
        </el-button>
        <h1 class="xw-page-title">{{ node?.name || '设备详情' }}</h1>
        <p class="xw-page-desc">
          {{ node?.networkName }} · {{ node?.virtualIp }} · 配置 v{{ currentVersion }}
        </p>
      </div>
      <div style="display: flex; gap: 8px">
        <el-button @click="resync">
          <el-icon style="margin-right: 4px"><Refresh /></el-icon>重发配置
        </el-button>
        <el-button @click="openEdit">编辑参数</el-button>
        <el-button :type="node?.status === 'blocked' ? 'primary' : 'warning'" @click="toggleBlock">
          {{ node?.status === 'blocked' ? '恢复设备' : '停止设备' }}
        </el-button>
      </div>
    </div>

    <div class="xw-stat-grid">
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><CircleCheck /></el-icon>状态</div>
        <div class="xw-stat-value" style="font-size: 20px">
          {{ NODE_STATUS[node?.status]?.text || '—' }}
        </div>
        <div class="xw-hint">最后上报 {{ fromNow(node?.lastSeen) }}</div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><Connection /></el-icon>邻居连接</div>
        <div class="xw-stat-value">{{ node?.peerCount ?? 0 }}<small>条</small></div>
        <div class="xw-hint">与网络中其他设备建立的隧道</div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><Download /></el-icon>累计接收</div>
        <div class="xw-stat-value" style="font-size: 22px">{{ formatBytes(node?.rxBytes) }}</div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><Upload /></el-icon>累计发送</div>
        <div class="xw-stat-value" style="font-size: 22px">{{ formatBytes(node?.txBytes) }}</div>
      </div>
    </div>

    <div class="xw-card">
      <div class="xw-card-head">
        <h3>基本信息</h3>
      </div>
      <div class="xw-kv">
        <div class="xw-kv-item">
          <div class="xw-kv-label">虚拟 IP</div>
          <div class="xw-kv-value xw-mono">{{ node?.virtualIp }}</div>
        </div>
        <div class="xw-kv-item">
          <div class="xw-kv-label">实例 ID（instance_id）</div>
          <div class="xw-kv-value xw-mono" style="font-size: 12px">
            {{ node?.identity }}
            <el-button text type="primary" size="small" @click="copy(node?.identity)">复制</el-button>
          </div>
        </div>
        <div class="xw-kv-item">
          <div class="xw-kv-label">网卡名（dev_name）</div>
          <div class="xw-kv-value xw-mono">{{ node?.devName }}</div>
        </div>
        <div class="xw-kv-item">
          <div class="xw-kv-label">核心版本</div>
          <div class="xw-kv-value xw-mono">{{ node?.coreVersion || '—' }}</div>
        </div>
        <div class="xw-kv-item">
          <div class="xw-kv-label">运行平台</div>
          <div class="xw-kv-value">{{ node?.platform || '—' }}</div>
        </div>
        <div class="xw-kv-item">
          <div class="xw-kv-label">出口 IP</div>
          <div class="xw-kv-value xw-mono">{{ node?.reportedIp || '—' }}</div>
        </div>
        <div class="xw-kv-item">
          <div class="xw-kv-label">接入来源</div>
          <div class="xw-kv-value">{{ node?.accessKeyName || '控制台手动添加' }}</div>
        </div>
        <div class="xw-kv-item">
          <div class="xw-kv-label">接入时间</div>
          <div class="xw-kv-value">{{ node?.registeredAt ? formatTime(node.registeredAt) : '—' }}</div>
        </div>
      </div>

      <div v-if="node?.subnetProxy?.length" style="margin-top: 16px">
        <div class="xw-kv-label" style="margin-bottom: 6px">承担的子网代理</div>
        <el-tag
          v-for="cidr in node.subnetProxy"
          :key="cidr"
          class="xw-mono"
          effect="plain"
          style="margin-right: 8px"
        >
          {{ cidr }}
        </el-tag>
      </div>

      <div class="xw-hint" style="margin-top: 14px">
        所属网络 {{ network?.name }}（{{ network?.cidr }}），接入点 {{ network?.peers }}
      </div>
    </div>

    <div class="xw-card">
      <div class="xw-card-head">
        <h3>流量曲线</h3>
        <el-select v-model="hours" size="small" style="width: 130px" @change="loadSeries">
          <el-option v-for="o in hourOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
      </div>
      <BarChart :buckets="buckets" :height="210" />
    </div>

    <div class="xw-card">
      <div class="xw-card-head">
        <h3>配置快照<span class="sub">每次变更都会留档，可随时回退</span></h3>
      </div>

      <el-table :data="configs" style="width: 100%">
        <el-table-column label="版本" width="100">
          <template #default="{ row }">
            <span class="xw-mono">v{{ row.version }}</span>
            <el-tag v-if="row.isCurrent" size="small" type="success" style="margin-left: 6px">
              当前
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="note" label="变更说明" min-width="180" />
        <el-table-column label="虚拟 IP" width="130">
          <template #default="{ row }">
            <span class="xw-mono">{{ row.config.virtualIp }}</span>
          </template>
        </el-table-column>
        <el-table-column label="子网代理" width="130">
          <template #default="{ row }">
            <span class="xw-mono xw-dim">{{ row.config.subnetProxy || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="ACL 指纹" width="120">
          <template #default="{ row }">
            <span class="xw-mono xw-dim">{{ row.config.acl || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作人" width="110" prop="createdBy" />
        <el-table-column label="时间" width="170">
          <template #default="{ row }">
            <span style="font-size: 12.5px; color: #6b7280">{{ formatTime(row.createdAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130" align="right">
          <template #default="{ row }">
            <el-button text type="primary" size="small" :disabled="row.isCurrent" @click="rollback(row)">
              回滚到此版本
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <div class="xw-empty">暂无配置快照</div>
        </template>
      </el-table>
    </div>

    <div class="xw-card">
      <div class="xw-card-head">
        <h3>最近采样<span class="sub">最近 60 次心跳记录</span></h3>
      </div>
      <el-table :data="samples.slice(0, 15)" style="width: 100%">
        <el-table-column label="采样时间" min-width="180">
          <template #default="{ row }">
            <span class="xw-mono" style="font-size: 12px">{{ formatTime(row.sampledAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="累计接收" width="140" align="right">
          <template #default="{ row }">
            <span class="xw-mono">{{ formatBytes(row.rxBytes) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="累计发送" width="140" align="right">
          <template #default="{ row }">
            <span class="xw-mono">{{ formatBytes(row.txBytes) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="邻居数" width="100" align="center">
          <template #default="{ row }">
            <span>{{ row.peerCount }}</span>
          </template>
        </el-table-column>
        <template #empty>
          <div class="xw-empty">设备尚未上报采样。设备上线后约 1 分钟出现首条记录。</div>
        </template>
      </el-table>
    </div>

    <el-dialog v-model="editVisible" title="编辑设备参数" width="520px" destroy-on-close>
      <el-form :model="form" label-width="92px">
        <el-form-item label="设备名称" required>
          <el-input v-model="form.name" class="xw-mono" />
        </el-form-item>
        <el-form-item label="虚拟 IP">
          <el-input v-model="form.virtualIp" class="xw-mono" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" type="textarea" :rows="2" />
        </el-form-item>
        <el-alert
          type="info"
          :closable="false"
          title="修改名称或虚拟 IP 会提升配置版本，设备将在 30 秒内自动应用并重启核心服务。"
        />
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

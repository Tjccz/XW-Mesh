<script setup>
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api.js'

const router = useRouter()
const loading = ref(true)
const items = ref([])
const networks = ref([])
const summary = ref({ total: 0, online: 0, offline: 0, pending: 0 })
const filter = reactive({ networkId: null, keyword: '' })

const dialogVisible = ref(false)
const submitting = ref(false)
const formRef = ref()
const currentNetwork = ref(null)
const form = reactive({ networkId: null, name: '', virtualIp: '', note: '' })

const provisionVisible = ref(false)
const provision = ref({ script: '', filename: '', loading: false })
const provisionNode = ref(null)

const statusMeta = {
  online: { text: '在线', type: 'success' },
  offline: { text: '离线', type: 'danger' },
  pending: { text: '待接入', type: 'info' },
}

const fmt = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—')

async function loadNetworks() {
  const { data } = await api.get('/networks')
  networks.value = data.items
}

async function load() {
  loading.value = true
  try {
    const params = {}
    if (filter.networkId) params.networkId = filter.networkId
    if (filter.keyword) params.keyword = filter.keyword
    const { data } = await api.get('/nodes', { params })
    items.value = data.items
    summary.value = data.summary
  } finally {
    loading.value = false
  }
}

function openCreate() {
  if (!networks.value.length) {
    ElMessage.warning('请先创建一张网络')
    router.push('/networks')
    return
  }
  form.networkId = filter.networkId || networks.value[0].id
  form.name = ''
  form.virtualIp = ''
  form.note = ''
  syncNetwork()
  dialogVisible.value = true
}

function syncNetwork() {
  currentNetwork.value = networks.value.find((n) => n.id === form.networkId) || null
}

async function submit() {
  if (!form.name.trim()) {
    ElMessage.warning('请填写节点名称')
    return
  }
  submitting.value = true
  try {
    await api.post('/nodes', {
      networkId: form.networkId,
      name: form.name.trim(),
      virtualIp: form.virtualIp || undefined,
      note: form.note,
    })
    ElMessage.success('节点已创建，接下来获取接入脚本')
    dialogVisible.value = false
    await load()
  } finally {
    submitting.value = false
  }
}

async function showProvision(row) {
  provisionNode.value = row
  provision.value = { script: '', filename: '', loading: true }
  provisionVisible.value = true
  try {
    const { data } = await api.get(`/nodes/${row.id}/provision`)
    provision.value = { script: data.script, filename: data.filename, loading: false }
  } catch {
    provisionVisible.value = false
  }
}

async function copyScript() {
  try {
    await navigator.clipboard.writeText(provision.value.script)
    ElMessage.success('脚本已复制')
  } catch {
    ElMessage.warning('复制失败，请手动选择文本复制')
  }
}

function downloadScript() {
  const blob = new Blob([provision.value.script], { type: 'text/x-shellscript' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = provision.value.filename || 'xiangwang-node.sh'
  a.click()
  URL.revokeObjectURL(url)
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(
      `确定移除节点「${row.name}」吗？该设备上的服务不会被卸载，但会失去配置下发。`,
      '提示',
      { type: 'warning' }
    )
  } catch {
    return
  }
  await api.delete(`/nodes/${row.id}`)
  ElMessage.success('已移除')
  await load()
}

onMounted(async () => {
  await loadNetworks()
  await load()
})
</script>

<template>
  <div class="xw-page">
    <div class="xw-page-head">
      <div>
        <h1 class="xw-page-title">节点管理</h1>
        <p class="xw-page-desc">
          共 {{ summary.total }} 台设备，在线 {{ summary.online }} 台，待接入 {{ summary.pending }} 台
        </p>
      </div>
      <el-button type="primary" @click="openCreate">
        <el-icon style="margin-right: 4px"><Plus /></el-icon>新增节点
      </el-button>
    </div>

    <div class="xw-card">
      <div class="filters">
        <el-select
          v-model="filter.networkId"
          placeholder="全部网络"
          clearable
          style="width: 200px"
          @change="load"
        >
          <el-option v-for="n in networks" :key="n.id" :label="n.name" :value="n.id" />
        </el-select>
        <el-input
          v-model="filter.keyword"
          placeholder="搜索节点名称或 IP"
          clearable
          style="width: 240px"
          @keyup.enter="load"
          @clear="load"
        />
        <el-button @click="load">查询</el-button>
      </div>

      <el-table :data="items" v-loading="loading" style="width: 100%">
        <el-table-column label="节点" min-width="170">
          <template #default="{ row }">
            <div class="node-name">{{ row.name }}</div>
            <div class="node-net xw-mono">{{ row.networkName }}</div>
          </template>
        </el-table-column>

        <el-table-column label="虚拟 IP" width="140">
          <template #default="{ row }">
            <span class="xw-mono">{{ row.virtualIp }}</span>
          </template>
        </el-table-column>

        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="statusMeta[row.status].type" size="small" effect="light">
              {{ statusMeta[row.status].text }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="核心版本" width="110">
          <template #default="{ row }">
            <span class="xw-mono" style="font-size: 12px">{{ row.coreVersion || '—' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="邻居" width="80" align="center">
          <template #default="{ row }">
            <span v-if="row.status === 'online'">{{ row.peerCount }}</span>
            <span v-else style="color: #cbd5e1">—</span>
          </template>
        </el-table-column>

        <el-table-column label="最后上报" width="170">
          <template #default="{ row }">
            <span style="font-size: 12.5px; color: #6b7280">{{ fmt(row.lastSeen) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="210" align="right">
          <template #default="{ row }">
            <el-button text type="primary" size="small" @click="showProvision(row)">
              接入脚本
            </el-button>
            <el-button text type="primary" size="small" @click="router.push(`/nodes/${row.id}`)">
              详情
            </el-button>
            <el-button text type="danger" size="small" @click="remove(row)">移除</el-button>
          </template>
        </el-table-column>

        <template #empty>
          <div class="xw-empty">
            还没有节点。点击右上角「新增节点」，生成脚本后到目标设备上执行即可接入。
          </div>
        </template>
      </el-table>
    </div>

    <el-dialog v-model="dialogVisible" title="新增节点" width="560px" destroy-on-close>
      <el-form :model="form" label-width="92px">
        <el-form-item label="所属网络" required>
          <el-select v-model="form.networkId" style="width: 100%" @change="syncNetwork">
            <el-option v-for="n in networks" :key="n.id" :label="n.name" :value="n.id" />
          </el-select>
        </el-form-item>

        <el-form-item label="节点名称" required>
          <el-input v-model="form.name" placeholder="例如 office-nas" class="xw-mono" />
        </el-form-item>

        <el-form-item label="虚拟 IP">
          <el-input
            v-model="form.virtualIp"
            :placeholder="currentNetwork ? `留空则自动分配（网段 ${currentNetwork.cidr}）` : '留空则自动分配'"
            class="xw-mono"
          />
        </el-form-item>

        <el-form-item label="备注">
          <el-input v-model="form.note" type="textarea" :rows="2" placeholder="可选，例如：办公室群晖 NAS" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">创建并生成脚本</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="provisionVisible"
      :title="`接入脚本 · ${provisionNode?.name || ''}`"
      width="760px"
      destroy-on-close
    >
      <div v-loading="provision.loading">
        <div class="script-hint">
          在目标设备上以 root 权限执行以下脚本，脚本会自动安装核心程序、注册服务，并持续同步配置。
        </div>
        <pre class="xw-script">{{ provision.script }}</pre>
        <div class="script-foot">
          <el-button type="primary" @click="copyScript">
            <el-icon style="margin-right: 4px"><DocumentCopy /></el-icon>复制脚本
          </el-button>
          <el-button @click="downloadScript">
            <el-icon style="margin-right: 4px"><Download /></el-icon>下载 .sh
          </el-button>
          <span class="script-tip">脚本内含节点专属令牌，请勿外传</span>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  gap: 10px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}

.node-name {
  font-weight: 600;
  color: #0f2b33;
}

.node-net {
  font-size: 12px;
  color: #9ca3af;
  margin-top: 2px;
}

.script-hint {
  font-size: 13px;
  color: #6b7280;
  line-height: 1.7;
  margin-bottom: 12px;
}

.script-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
}

.script-tip {
  font-size: 12px;
  color: #9ca3af;
  margin-left: auto;
}
</style>

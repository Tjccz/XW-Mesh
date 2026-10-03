<script setup>
import { onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api.js'

const route = useRoute()
const router = useRouter()
const nodeId = route.params.id

const loading = ref(true)
const node = ref(null)
const configs = ref([])
const currentVersion = ref(0)

const editVisible = ref(false)
const submitting = ref(false)
const form = reactive({ name: '', virtualIp: '', note: '' })

const statusMeta = {
  online: { text: '在线', type: 'success' },
  offline: { text: '离线', type: 'danger' },
  pending: { text: '待接入', type: 'info' },
}

const fmt = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—')

async function load() {
  loading.value = true
  try {
    const [{ data: nodeData }, { data: configData }] = await Promise.all([
      api.get(`/nodes/${nodeId}`),
      api.get(`/nodes/${nodeId}/configs`),
    ])
    node.value = nodeData.item
    configs.value = configData.items
    currentVersion.value = configData.currentVersion
  } finally {
    loading.value = false
  }
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
    ElMessage.warning('请填写节点名称')
    return
  }
  submitting.value = true
  try {
    await api.patch(`/nodes/${nodeId}`, {
      name: form.name.trim(),
      virtualIp: form.virtualIp,
      note: form.note,
    })
    ElMessage.success('已保存，节点将在 30 秒内自动应用新配置')
    editVisible.value = false
    await load()
  } finally {
    submitting.value = false
  }
}

async function rollback(row) {
  try {
    await ElMessageBox.confirm(
      `将节点参数回滚到 v${row.version}？当前配置会保留为历史记录，回滚本身也会生成新版本。`,
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

onMounted(load)
</script>

<template>
  <div class="xw-page" v-loading="loading">
    <div class="xw-page-head">
      <div>
        <el-button text @click="router.push('/nodes')" style="padding-left: 0; margin-bottom: 6px">
          <el-icon><ArrowLeft /></el-icon>
          <span style="margin-left: 4px">返回节点列表</span>
        </el-button>
        <h1 class="xw-page-title">{{ node?.name || '节点详情' }}</h1>
        <p class="xw-page-desc">
          所属网络 {{ node?.networkName }} · 虚拟 IP {{ node?.virtualIp }}
        </p>
      </div>
      <div style="display: flex; gap: 8px">
        <el-button @click="openEdit">编辑参数</el-button>
      </div>
    </div>

    <div class="xw-card" style="margin-bottom: 16px">
      <el-descriptions :column="3" border>
        <el-descriptions-item label="状态">
          <el-tag v-if="node" :type="statusMeta[node.status].type" size="small">
            {{ statusMeta[node.status].text }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="虚拟 IP">
          <span class="xw-mono">{{ node?.virtualIp }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="核心版本">
          <span class="xw-mono">{{ node?.coreVersion || '—' }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="邻居节点数">{{ node?.peerCount ?? '—' }}</el-descriptions-item>
        <el-descriptions-item label="平台">{{ node?.platform || '—' }}</el-descriptions-item>
        <el-descriptions-item label="上报出口 IP">
          <span class="xw-mono">{{ node?.reportedIp || '—' }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="最后上报">{{ fmt(node?.lastSeen) }}</el-descriptions-item>
        <el-descriptions-item label="当前配置版本">v{{ currentVersion }}</el-descriptions-item>
        <el-descriptions-item label="创建时间">{{ fmt(node?.createdAt) }}</el-descriptions-item>
        <el-descriptions-item label="备注" :span="3">{{ node?.note || '—' }}</el-descriptions-item>
      </el-descriptions>
    </div>

    <div class="xw-card">
      <div class="card-head">
        <h3>配置快照</h3>
        <span class="head-tip">
          每次参数变更都会留下快照，出问题时可以退回任何一版
        </span>
      </div>

      <el-table :data="configs" style="width: 100%">
        <el-table-column label="版本" width="90">
          <template #default="{ row }">
            <span class="xw-mono">v{{ row.version }}</span>
            <el-tag v-if="row.isCurrent" size="small" type="success" style="margin-left: 6px">
              当前
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="note" label="变更说明" min-width="180" />
        <el-table-column label="虚拟 IP" width="140">
          <template #default="{ row }">
            <span class="xw-mono">{{ row.config.virtualIp }}</span>
          </template>
        </el-table-column>
        <el-table-column label="网络名" min-width="150">
          <template #default="{ row }">
            <span class="xw-mono">{{ row.config.networkName }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作人" width="110" prop="createdBy" />
        <el-table-column label="时间" width="170">
          <template #default="{ row }">
            <span style="font-size: 12.5px; color: #6b7280">{{ fmt(row.createdAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100" align="right">
          <template #default="{ row }">
            <el-button
              text
              type="primary"
              size="small"
              :disabled="row.isCurrent"
              @click="rollback(row)"
            >
              回滚到此版本
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <div class="xw-empty">暂无配置快照</div>
        </template>
      </el-table>
    </div>

    <el-dialog v-model="editVisible" title="编辑节点参数" width="520px" destroy-on-close>
      <el-form :model="form" label-width="92px">
        <el-form-item label="节点名称" required>
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
          title="修改名称或虚拟 IP 会提升配置版本，节点将在 30 秒内自动应用并重启核心服务。"
        />
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.card-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 12px;
}

.card-head h3 {
  margin: 0;
  font-size: 15px;
  color: #0f2b33;
  font-weight: 600;
}

.head-tip {
  font-size: 12.5px;
  color: #9ca3af;
}
</style>

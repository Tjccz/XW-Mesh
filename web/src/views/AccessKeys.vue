<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api.js'
import { KEY_STATUS, formatDate, formatTime, copyText, download } from '../format.js'

const loading = ref(true)
const items = ref([])
const networks = ref([])
const summary = ref({ total: 0, active: 0, revoked: 0 })
const filter = reactive({ networkId: null })

const dialogVisible = ref(false)
const submitting = ref(false)
const form = reactive({ networkId: null, name: '', expiresInDays: 30, maxNodes: 0, note: '' })

const cmdVisible = ref(false)
const cmdLoading = ref(false)
const cmdData = ref({ item: null, methods: {} })
const activeMethod = ref('linux')
const me = ref(null)

const canManage = computed(() => ['owner', 'admin'].includes(me.value?.role))

const methodOrder = ['linux', 'docker', 'openwrt', 'windows']
const methodList = computed(() =>
  methodOrder
    .filter((k) => cmdData.value.methods?.[k])
    .map((k) => ({ key: k, ...cmdData.value.methods[k] }))
)

async function load() {
  loading.value = true
  try {
    const params = filter.networkId ? { networkId: filter.networkId } : {}
    const { data } = await api.get('/access-keys', { params })
    items.value = data.items
    summary.value = data.summary
  } finally {
    loading.value = false
  }
}

async function loadNetworks() {
  const { data } = await api.get('/networks')
  networks.value = data.items
}

function openCreate() {
  if (!networks.value.length) {
    ElMessage.warning('请先创建一张网络')
    return
  }
  Object.assign(form, {
    networkId: filter.networkId || networks.value[0].id,
    name: '',
    expiresInDays: 30,
    maxNodes: 0,
    note: '',
  })
  dialogVisible.value = true
}

async function submit() {
  if (!form.name.trim()) {
    ElMessage.warning('请填写密钥用途名称')
    return
  }
  submitting.value = true
  try {
    await api.post('/access-keys', { ...form, name: form.name.trim() })
    ElMessage.success('密钥已创建，可发给需要接入的设备')
    dialogVisible.value = false
    await load()
  } finally {
    submitting.value = false
  }
}

async function showCommands(row) {
  cmdVisible.value = true
  cmdLoading.value = true
  activeMethod.value = 'linux'
  try {
    const { data } = await api.get(`/access-keys/${row.id}/commands`)
    cmdData.value = data
  } finally {
    cmdLoading.value = false
  }
}

async function copyCmd(text) {
  const okDone = await copyText(text)
  ElMessage[okDone ? 'success' : 'warning'](okDone ? '已复制到剪贴板' : '复制失败，请手动选择')
}

async function copyKey(key) {
  const okDone = await copyText(key)
  ElMessage[okDone ? 'success' : 'warning'](okDone ? '密钥已复制' : '复制失败')
}

async function revoke(row) {
  try {
    await ElMessageBox.confirm(
      `吊销后，使用该密钥接入的设备会在 30 秒内被要求下线。确定吊销「${row.name}」？`,
      '吊销接入密钥',
      { type: 'warning', confirmButtonText: '确认吊销' }
    )
  } catch {
    return
  }
  const { data } = await api.post(`/access-keys/${row.id}/revoke`)
  ElMessage.success(`已吊销，影响 ${data.affectedNodes} 台设备`)
  await load()
}

async function restore(row) {
  await api.post(`/access-keys/${row.id}/restore`)
  ElMessage.success('密钥已恢复')
  await load()
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`删除密钥「${row.name}」后无法恢复。确定继续？`, '提示', {
      type: 'warning',
    })
  } catch {
    return
  }
  await api.delete(`/access-keys/${row.id}`)
  ElMessage.success('已删除')
  await load()
}

onMounted(async () => {
  try {
    const { data } = await api.get('/auth/me')
    me.value = data.user
  } catch {
    /* 拦截器已处理 */
  }
  await loadNetworks()
  await load()
})
</script>

<template>
  <div class="xw-page">
    <div class="xw-page-head">
      <div>
        <h1 class="xw-page-title">接入密钥</h1>
        <p class="xw-page-desc">
          把一条命令发给设备管理员即可完成接入，无需在控制台预建设备；支持有效期与设备数量上限
        </p>
      </div>
      <el-button type="primary" :disabled="!canManage" @click="openCreate">
        <el-icon style="margin-right: 4px"><Plus /></el-icon>创建密钥
      </el-button>
    </div>

    <div class="xw-stat-grid">
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><Key /></el-icon>密钥总数</div>
        <div class="xw-stat-value">{{ summary.total }}<small>个</small></div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><CircleCheck /></el-icon>可用</div>
        <div class="xw-stat-value" style="color: #0d9488">{{ summary.active }}<small>个</small></div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><CircleClose /></el-icon>已吊销</div>
        <div class="xw-stat-value" style="color: #b45309">{{ summary.revoked }}<small>个</small></div>
      </div>
    </div>

    <div class="xw-card">
      <div class="xw-toolbar">
        <el-select
          v-model="filter.networkId"
          placeholder="全部网络"
          clearable
          style="width: 200px"
          @change="load"
        >
          <el-option v-for="n in networks" :key="n.id" :label="n.name" :value="n.id" />
        </el-select>
        <el-button @click="load">刷新</el-button>
      </div>

      <el-table :data="items" v-loading="loading" style="width: 100%">
        <el-table-column label="用途" min-width="170">
          <template #default="{ row }">
            <div class="xw-strong">{{ row.name }}</div>
            <div class="sub-line xw-mono">{{ row.networkName }}</div>
          </template>
        </el-table-column>

        <el-table-column label="密钥" min-width="230">
          <template #default="{ row }">
            <div class="key-row">
              <span class="xw-mono key-text">{{ row.key }}</span>
              <el-button text type="primary" size="small" @click="copyKey(row.key)">复制</el-button>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="KEY_STATUS[row.status]?.type || 'info'" size="small" effect="light">
              {{ KEY_STATUS[row.status]?.text || row.status }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="设备用量" width="110" align="center">
          <template #default="{ row }">
            <span class="xw-strong">{{ row.usedCount }}</span>
            <span class="xw-dim"> / {{ row.maxNodes > 0 ? row.maxNodes : '不限' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="有效期" width="120">
          <template #default="{ row }">
            <span style="font-size: 12.5px; color: #6b7280">
              {{ row.expiresAt ? formatDate(row.expiresAt) : '长期有效' }}
            </span>
          </template>
        </el-table-column>

        <el-table-column label="创建" width="160">
          <template #default="{ row }">
            <span style="font-size: 12px; color: #9ca3af">{{ formatTime(row.createdAt) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="230" align="right">
          <template #default="{ row }">
            <el-button text type="primary" size="small" @click="showCommands(row)">接入方式</el-button>
            <el-button
              v-if="row.status === 'revoked'"
              text
              type="primary"
              size="small"
              @click="restore(row)"
            >
              恢复
            </el-button>
            <el-button v-else text type="warning" size="small" @click="revoke(row)">吊销</el-button>
            <el-button text type="danger" size="small" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>

        <template #empty>
          <div class="xw-empty">
            还没有接入密钥。创建一条后，把命令发给设备管理员即可自助接入。
          </div>
        </template>
      </el-table>
    </div>

    <el-dialog v-model="dialogVisible" title="创建接入密钥" width="540px" destroy-on-close>
      <el-form :model="form" label-width="96px">
        <el-form-item label="所属网络" required>
          <el-select v-model="form.networkId" style="width: 100%">
            <el-option v-for="n in networks" :key="n.id" :label="n.name" :value="n.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="用途名称" required>
          <el-input v-model="form.name" placeholder="例如：长沙办公室新设备" />
        </el-form-item>
        <el-form-item label="有效期">
          <el-input-number v-model="form.expiresInDays" :min="0" :max="3650" />
          <span class="xw-hint" style="margin-left: 10px">填 0 表示长期有效</span>
        </el-form-item>
        <el-form-item label="设备上限">
          <el-input-number v-model="form.maxNodes" :min="0" :max="9999" />
          <span class="xw-hint" style="margin-left: 10px">填 0 表示不限制</span>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" type="textarea" :rows="2" placeholder="可选" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="cmdVisible"
      :title="`接入方式 · ${cmdData.item?.name || ''}`"
      width="780px"
      destroy-on-close
    >
      <div v-loading="cmdLoading">
        <div class="xw-toolbar" style="margin-bottom: 12px">
          <el-tag :type="KEY_STATUS[cmdData.item?.status]?.type" effect="light">
            {{ KEY_STATUS[cmdData.item?.status]?.text }}
          </el-tag>
          <span class="xw-mono key-text">{{ cmdData.item?.key }}</span>
          <el-button text type="primary" size="small" @click="copyKey(cmdData.item?.key)">
            复制密钥
          </el-button>
        </div>

        <el-tabs v-model="activeMethod">
          <el-tab-pane
            v-for="m in methodList"
            :key="m.key"
            :label="m.title"
            :name="m.key"
          >
            <div class="xw-method-desc">{{ m.desc }}</div>
            <pre class="xw-script-sm">{{ m.command }}</pre>
            <div class="method-foot">
              <el-button type="primary" size="small" @click="copyCmd(m.command)">
                <el-icon style="margin-right: 4px"><DocumentCopy /></el-icon>复制命令
              </el-button>
              <el-button
                size="small"
                @click="download(`xiangwang-${m.key}.txt`, m.command)"
              >
                <el-icon style="margin-right: 4px"><Download /></el-icon>另存为文本
              </el-button>
            </div>
          </el-tab-pane>
        </el-tabs>

        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="密钥等同于该网络的入场券，请通过安全渠道分发；设备接入后可在「设备管理」中单独停止。"
          style="margin-top: 6px"
        />
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

.key-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.key-text {
  font-size: 12px;
  color: #0f766e;
  word-break: break-all;
}

.method-foot {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
</style>

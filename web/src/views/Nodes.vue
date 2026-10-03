<script setup>
import { onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api.js'
import { NODE_STATUS, formatBytes, fromNow, copyText, download } from '../format.js'

const route = useRoute()
const router = useRouter()
const loading = ref(true)
const items = ref([])
const networks = ref([])
const summary = ref({ total: 0, online: 0, offline: 0, pending: 0, blocked: 0 })
const filter = reactive({
  networkId: route.query.networkId ? Number(route.query.networkId) : null,
  keyword: '',
  status: null,
})

const dialogVisible = ref(false)
const submitting = ref(false)
const formRef = ref()
const currentNetwork = ref(null)
const form = reactive({ networkId: null, name: '', virtualIp: '', note: '' })

const provisionVisible = ref(false)
const provision = ref({ script: '', filename: '', methods: {}, loading: false })
const provisionNode = ref(null)
const activeMethod = ref('linux')

const statusOptions = [
  { label: '在线', value: 'online' },
  { label: '离线', value: 'offline' },
  { label: '待接入', value: 'pending' },
  { label: '已停止', value: 'blocked' },
]

const methodOrder = ['linux', 'docker', 'openwrt', 'windows']

const rules = {
  name: [{ required: true, message: '请填写设备名称', trigger: 'blur' }],
}

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
    if (filter.status) params.status = filter.status
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
  try {
    await formRef.value.validate()
  } catch {
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
    ElMessage.success('设备已创建，接下来把接入命令发到目标机器')
    dialogVisible.value = false
    await Promise.all([load(), loadNetworks()])
  } finally {
    submitting.value = false
  }
}

async function showProvision(row) {
  provisionNode.value = row
  provision.value = { script: '', filename: '', methods: {}, loading: true }
  activeMethod.value = 'linux'
  provisionVisible.value = true
  try {
    const { data } = await api.get(`/nodes/${row.id}/provision`)
    provision.value = {
      script: data.script,
      filename: data.filename,
      methods: data.methods,
      loading: false,
    }
  } catch {
    provisionVisible.value = false
  }
}

async function copyScript(text) {
  const okDone = await copyText(text)
  ElMessage[okDone ? 'success' : 'warning'](okDone ? '已复制到剪贴板' : '复制失败，请手动选择')
}

async function toggleBlock(row) {
  const blocking = row.status !== 'blocked'
  try {
    await ElMessageBox.confirm(
      blocking
        ? `停止后，设备会在 30 秒内收到指令并断开组网（不卸载程序）。确定停止「${row.name}」？`
        : `恢复后，设备会重新拉取配置并上线。确定恢复「${row.name}」？`,
      blocking ? '停止设备' : '恢复设备',
      { type: 'warning' }
    )
  } catch {
    return
  }
  await api.post(`/nodes/${row.id}/${blocking ? 'block' : 'unblock'}`)
  ElMessage.success(blocking ? '已下发停止指令' : '已下发恢复指令')
  await load()
}

async function resync(row) {
  const { data } = await api.post(`/nodes/${row.id}/resync`)
  ElMessage.success(`已提升配置版本至 v${data.item.configVersion}，设备将在 30 秒内同步`)
  await load()
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(
      `移除「${row.name}」后，该设备上的服务不会被卸载，但会失去配置下发。确定继续？`,
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
        <h1 class="xw-page-title">设备管理</h1>
        <p class="xw-page-desc">
          共 {{ summary.total }} 台，在线 {{ summary.online }}，离线 {{ summary.offline }}，待接入
          {{ summary.pending }}<template v-if="summary.blocked">，已停止 {{ summary.blocked }}</template>
        </p>
      </div>
      <el-button type="primary" @click="openCreate">
        <el-icon style="margin-right: 4px"><Plus /></el-icon>添加设备
      </el-button>
    </div>

    <div class="xw-card">
      <div class="xw-toolbar">
        <el-select
          v-model="filter.networkId"
          placeholder="全部网络"
          clearable
          style="width: 190px"
          @change="load"
        >
          <el-option v-for="n in networks" :key="n.id" :label="n.name" :value="n.id" />
        </el-select>
        <el-select
          v-model="filter.status"
          placeholder="全部状态"
          clearable
          style="width: 140px"
          @change="load"
        >
          <el-option v-for="o in statusOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
        <el-input
          v-model="filter.keyword"
          placeholder="搜索设备名 / IP / 平台"
          clearable
          style="width: 230px"
          @keyup.enter="load"
          @clear="load"
        />
        <el-button @click="load">查询</el-button>
        <div class="spacer"></div>
        <span class="xw-hint">配置变更后设备会在 30 秒内自动同步并重启核心</span>
      </div>

      <el-table :data="items" v-loading="loading" style="width: 100%">
        <el-table-column label="设备" min-width="180">
          <template #default="{ row }">
            <div class="xw-strong">{{ row.name }}</div>
            <div class="sub-line xw-mono">{{ row.networkName }}</div>
          </template>
        </el-table-column>

        <el-table-column label="虚拟 IP" width="134">
          <template #default="{ row }">
            <span class="xw-mono">{{ row.virtualIp }}</span>
          </template>
        </el-table-column>

        <el-table-column label="状态" width="96">
          <template #default="{ row }">
            <el-tag :type="NODE_STATUS[row.status]?.type || 'info'" size="small" effect="light">
              {{ NODE_STATUS[row.status]?.text || row.status }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="来源" width="130">
          <template #default="{ row }">
            <span v-if="row.accessKeyName" class="xw-hint">{{ row.accessKeyName }}</span>
            <span v-else class="xw-dim">手动添加</span>
          </template>
        </el-table-column>

        <el-table-column label="子网" width="70" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.subnetProxy?.length" size="small" effect="plain" type="success">
              {{ row.subnetProxy.length }}
            </el-tag>
            <span v-else class="xw-dim">—</span>
          </template>
        </el-table-column>

        <el-table-column label="邻居" width="66" align="center">
          <template #default="{ row }">
            <span v-if="row.status === 'online'">{{ row.peerCount }}</span>
            <span v-else class="xw-dim">—</span>
          </template>
        </el-table-column>

        <el-table-column label="流量" width="110" align="right">
          <template #default="{ row }">
            <span class="xw-mono">{{ formatBytes(row.rxBytes + row.txBytes) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="配置版本" width="90" align="center">
          <template #default="{ row }">
            <span class="xw-mono" style="font-size: 12px">v{{ row.configVersion }}</span>
          </template>
        </el-table-column>

        <el-table-column label="最后上报" width="110">
          <template #default="{ row }">
            <span style="font-size: 12.5px; color: #6b7280">{{ fromNow(row.lastSeen) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="230" align="right">
          <template #default="{ row }">
            <el-button text type="primary" size="small" @click="showProvision(row)">接入</el-button>
            <el-button text type="primary" size="small" @click="router.push(`/nodes/${row.id}`)">
              详情
            </el-button>
            <el-dropdown trigger="click" style="margin-left: 8px">
              <el-button text size="small">
                更多<el-icon style="margin-left: 2px"><ArrowDown /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item @click="resync(row)">
                    <el-icon><Refresh /></el-icon>重发配置
                  </el-dropdown-item>
                  <el-dropdown-item @click="toggleBlock(row)">
                    <el-icon><SwitchButton /></el-icon>
                    {{ row.status === 'blocked' ? '恢复设备' : '停止设备' }}
                  </el-dropdown-item>
                  <el-dropdown-item divided @click="remove(row)">
                    <el-icon><Delete /></el-icon>移除设备
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </el-table-column>

        <template #empty>
          <div class="xw-empty">
            还没有设备。点击右上角「添加设备」生成接入命令，或直接在「接入密钥」里创建一条密钥。
          </div>
        </template>
      </el-table>
    </div>

    <el-dialog v-model="dialogVisible" title="添加设备" width="560px" destroy-on-close>
      <el-form ref="formRef" :model="form" :rules="rules" label-width="92px">
        <el-form-item label="所属网络" required>
          <el-select v-model="form.networkId" style="width: 100%" @change="syncNetwork">
            <el-option v-for="n in networks" :key="n.id" :label="n.name" :value="n.id" />
          </el-select>
        </el-form-item>

        <el-form-item label="设备名称" prop="name">
          <el-input v-model="form.name" placeholder="例如 office-nas" class="xw-mono" />
        </el-form-item>

        <el-form-item label="虚拟 IP">
          <el-input
            v-model="form.virtualIp"
            :placeholder="currentNetwork ? `留空自动分配（网段 ${currentNetwork.cidr}）` : '留空自动分配'"
            class="xw-mono"
          />
        </el-form-item>

        <el-form-item label="备注">
          <el-input v-model="form.note" type="textarea" :rows="2" placeholder="可选，例如：办公室群晖 NAS" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">创建并获取接入命令</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="provisionVisible"
      :title="`接入方式 · ${provisionNode?.name || ''}`"
      width="800px"
      destroy-on-close
    >
      <div v-loading="provision.loading">
        <el-tabs v-model="activeMethod">
          <el-tab-pane
            v-for="key in methodOrder"
            :key="key"
            :label="provision.methods?.[key]?.title || key"
            :name="key"
            :disabled="!provision.methods?.[key]"
          >
            <template v-if="provision.methods?.[key]">
              <div class="xw-method-desc">{{ provision.methods[key].desc }}</div>
              <pre class="xw-script-sm">{{ provision.methods[key].command }}</pre>
              <div class="method-foot">
                <el-button type="primary" size="small" @click="copyScript(provision.methods[key].command)">
                  <el-icon style="margin-right: 4px"><DocumentCopy /></el-icon>复制命令
                </el-button>
              </div>
            </template>
          </el-tab-pane>

          <el-tab-pane label="完整脚本（可下载）" name="script">
            <div class="xw-method-desc">
              一键脚本会安装核心程序、写入配置、注册 systemd 服务并开启心跳同步。适合离线分发。
            </div>
            <pre class="xw-script">{{ provision.script }}</pre>
            <div class="method-foot">
              <el-button type="primary" size="small" @click="copyScript(provision.script)">
                <el-icon style="margin-right: 4px"><DocumentCopy /></el-icon>复制脚本
              </el-button>
              <el-button size="small" @click="download(provision.filename, provision.script, 'text/x-shellscript')">
                <el-icon style="margin-right: 4px"><Download /></el-icon>下载 .sh
              </el-button>
              <span class="xw-hint" style="margin-left: auto">脚本内含设备专属令牌，请勿外传</span>
            </div>
          </el-tab-pane>
        </el-tabs>
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

.method-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}
</style>

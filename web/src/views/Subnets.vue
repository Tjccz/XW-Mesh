<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api.js'
import { formatTime } from '../format.js'

const loading = ref(true)
const items = ref([])
const networks = ref([])
const nodes = ref([])
const filter = reactive({ networkId: null })

const dialogVisible = ref(false)
const submitting = ref(false)
const form = reactive({ networkId: null, nodeId: null, cidr: '', description: '' })

const candidateNodes = computed(() =>
  nodes.value.filter((n) => !form.networkId || n.networkId === form.networkId)
)

function nodeOptionsFor(networkId) {
  return nodes.value.filter((n) => n.networkId === networkId)
}

async function load() {
  loading.value = true
  try {
    const params = filter.networkId ? { networkId: filter.networkId } : {}
    const { data } = await api.get('/policies/subnets', { params })
    items.value = data.items
  } finally {
    loading.value = false
  }
}

async function bootstrap() {
  const [netRes, nodeRes] = await Promise.all([api.get('/networks'), api.get('/nodes')])
  networks.value = netRes.data.items
  nodes.value = nodeRes.data.items
}

function openCreate() {
  if (!networks.value.length) {
    ElMessage.warning('请先创建一张网络')
    return
  }
  Object.assign(form, {
    networkId: filter.networkId || networks.value[0].id,
    nodeId: null,
    cidr: '',
    description: '',
  })
  const first = nodeOptionsFor(form.networkId)[0]
  form.nodeId = first ? first.id : null
  dialogVisible.value = true
}

function syncNodes() {
  const list = nodeOptionsFor(form.networkId)
  form.nodeId = list.length ? list[0].id : null
}

async function submit() {
  if (!form.nodeId) {
    ElMessage.warning('请选择承担代理的设备')
    return
  }
  if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(form.cidr)) {
    ElMessage.warning('网段格式不正确，例如 192.168.1.0/24')
    return
  }
  submitting.value = true
  try {
    const { data } = await api.post('/policies/subnets', form)
    ElMessage.success(`已下发，${data.affectedNodes} 台设备将在 30 秒内同步`)
    dialogVisible.value = false
    await Promise.all([load(), bootstrap()])
  } finally {
    submitting.value = false
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(
      `移除后，其他设备将无法再通过本网络访问 ${row.cidr}。确定继续？`,
      '移除子网路由',
      { type: 'warning' }
    )
  } catch {
    return
  }
  const { data } = await api.delete(`/policies/subnets/${row.id}`)
  ElMessage.success(`已移除，${data.affectedNodes} 台设备待同步`)
  await load()
}

onMounted(async () => {
  await bootstrap()
  // 默认选中已有子网路由的网络
  const withSubnets = networks.value.find((n) => n.subnetCount > 0)
  if (networks.value.length) filter.networkId = (withSubnets || networks.value[0]).id
  await load()
})
</script>

<template>
  <div class="xw-page">
    <div class="xw-page-head">
      <div>
        <h1 class="xw-page-title">子网路由</h1>
        <p class="xw-page-desc">
          让某台设备充当「网关」，把对端内网（如 192.168.1.0/24）共享给整个虚拟网络
        </p>
      </div>
      <el-button type="primary" @click="openCreate">
        <el-icon style="margin-right: 4px"><Plus /></el-icon>添加子网
      </el-button>
    </div>

    <el-alert type="info" :closable="false" show-icon style="margin-bottom: 16px">
      <template #title>
        工作原理：承担代理的设备会把本机可到达的网段宣告给全网，其他设备访问该网段时流量会经隧道转发。
        代理设备需打开内核 IP 转发，并放行对应网段的出入流量。
      </template>
    </el-alert>

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
        <el-table-column label="目标网段" min-width="160">
          <template #default="{ row }">
            <span class="xw-mono xw-strong">{{ row.cidr }}</span>
          </template>
        </el-table-column>

        <el-table-column label="代理设备" min-width="160">
          <template #default="{ row }">
            <div>{{ row.nodeName }}</div>
            <div class="sub-line xw-mono">{{ row.networkName }}</div>
          </template>
        </el-table-column>

        <el-table-column prop="description" label="说明" min-width="180">
          <template #default="{ row }">
            <span class="xw-dim">{{ row.description || '—' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="创建时间" width="170">
          <template #default="{ row }">
            <span style="font-size: 12.5px; color: #6b7280">{{ formatTime(row.createdAt) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="90" align="right">
          <template #default="{ row }">
            <el-button text type="danger" size="small" @click="remove(row)">移除</el-button>
          </template>
        </el-table-column>

        <template #empty>
          <div class="xw-empty">
            还没有子网路由。添加后，办公网、机房内网等真实网段就能被隧道内的设备访问。
          </div>
        </template>
      </el-table>
    </div>

    <el-dialog v-model="dialogVisible" title="添加子网路由" width="540px" destroy-on-close>
      <el-form :model="form" label-width="96px">
        <el-form-item label="所属网络" required>
          <el-select v-model="form.networkId" style="width: 100%" @change="syncNodes">
            <el-option v-for="n in networks" :key="n.id" :label="n.name" :value="n.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="代理设备" required>
          <el-select v-model="form.nodeId" style="width: 100%" placeholder="选择承担代理的设备">
            <el-option
              v-for="n in candidateNodes"
              :key="n.id"
              :label="`${n.name}（${n.virtualIp}）`"
              :value="n.id"
            />
          </el-select>
          <div class="xw-hint">该设备需要本身能访问目标网段</div>
        </el-form-item>
        <el-form-item label="目标网段" required>
          <el-input v-model="form.cidr" placeholder="192.168.1.0/24" class="xw-mono" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="form.description" placeholder="例如：长沙办公室内网" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">下发</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.sub-line {
  font-size: 11.5px;
  color: #9ca3af;
  margin-top: 2px;
}
</style>

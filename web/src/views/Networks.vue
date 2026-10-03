<script setup>
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api.js'
import { RELAY_MODE, formatShortTime, copyText } from '../format.js'

const router = useRouter()
const loading = ref(true)
const items = ref([])
const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref(null)
const formRef = ref()

const form = reactive({
  name: '',
  secret: '',
  cidr: '10.144.144.0/24',
  peers: 'tcp://public.easytier.cn:11010',
  region: 'cn',
  relayMode: 'auto',
  description: '',
})

const rules = {
  name: [
    { required: true, message: '请填写网络名称', trigger: 'blur' },
    {
      pattern: /^[A-Za-z0-9_-]{3,64}$/,
      message: '3-64 位字母、数字、下划线或连字符',
      trigger: 'blur',
    },
  ],
  secret: [
    { required: true, message: '请填写网络密钥', trigger: 'blur' },
    {
      pattern: /^[A-Za-z0-9_.:-]{8,128}$/,
      message: '至少 8 位，可用字母、数字及 _ . : -',
      trigger: 'blur',
    },
  ],
  cidr: [
    { required: true, message: '请填写虚拟网段', trigger: 'blur' },
    {
      pattern: /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/,
      message: '格式如 10.144.144.0/24',
      trigger: 'blur',
    },
  ],
}

async function load() {
  loading.value = true
  try {
    const { data } = await api.get('/networks')
    items.value = data.items
  } finally {
    loading.value = false
  }
}

function openCreate() {
  editingId.value = null
  Object.assign(form, {
    name: '',
    secret: '',
    cidr: '10.144.144.0/24',
    peers: 'tcp://public.easytier.cn:11010',
    region: 'cn',
    relayMode: 'auto',
    description: '',
  })
  dialogVisible.value = true
}

function openEdit(row) {
  editingId.value = row.id
  Object.assign(form, {
    name: row.name,
    secret: row.secret,
    cidr: row.cidr,
    peers: row.peers,
    region: row.region || 'cn',
    relayMode: row.relayMode || 'auto',
    description: row.description,
  })
  dialogVisible.value = true
}

function genSecret() {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  const arr = new Uint32Array(20)
  crypto.getRandomValues(arr)
  for (const n of arr) out += chars[n % chars.length]
  form.secret = out
}

async function submit() {
  try {
    await formRef.value.validate()
  } catch {
    return
  }
  submitting.value = true
  try {
    if (editingId.value) {
      const { data } = await api.patch(`/networks/${editingId.value}`, form)
      ElMessage.success(`已保存，${data.affectedNodes} 台设备将在 30 秒内同步`)
    } else {
      await api.post('/networks', form)
      ElMessage.success('网络创建成功')
    }
    dialogVisible.value = false
    await load()
  } finally {
    submitting.value = false
  }
}

async function remove(row) {
  const hasNodes = row.nodeTotal > 0
  try {
    await ElMessageBox.confirm(
      hasNodes
        ? `网络「${row.name}」下仍有 ${row.nodeTotal} 台设备，删除将一并移除这些设备。确定继续？`
        : `确定删除网络「${row.name}」？该操作无法撤销。`,
      '危险操作',
      { type: 'warning', confirmButtonText: '确认删除', confirmButtonClass: 'el-button--danger' }
    )
  } catch {
    return
  }
  await api.delete(`/networks/${row.id}${hasNodes ? '?force=1' : ''}`)
  ElMessage.success('已删除')
  await load()
}

async function copySecret(secret) {
  const okDone = await copyText(secret)
  ElMessage[okDone ? 'success' : 'warning'](okDone ? '密钥已复制' : '复制失败')
}

onMounted(load)
</script>

<template>
  <div class="xw-page">
    <div class="xw-page-head">
      <div>
        <h1 class="xw-page-title">网络管理</h1>
        <p class="xw-page-desc">
          每张网络由「网络名 + 密钥」唯一标识，同网设备自动互相发现并直连
        </p>
      </div>
      <el-button type="primary" @click="openCreate">
        <el-icon style="margin-right: 4px"><Plus /></el-icon>新建网络
      </el-button>
    </div>

    <div class="xw-card">
      <el-table :data="items" v-loading="loading" style="width: 100%">
        <el-table-column label="网络" min-width="160">
          <template #default="{ row }">
            <div class="net-name xw-mono">{{ row.name }}</div>
            <div class="net-desc">{{ row.description || '—' }}</div>
          </template>
        </el-table-column>

        <el-table-column label="虚拟网段" width="130">
          <template #default="{ row }">
            <span class="xw-mono">{{ row.cidr }}</span>
          </template>
        </el-table-column>

        <el-table-column label="密钥" min-width="190">
          <template #default="{ row }">
            <div class="key-row">
              <span class="xw-mono key-text">{{ row.secret }}</span>
              <el-button text type="primary" size="small" @click="copySecret(row.secret)">复制</el-button>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="设备" width="86" align="center">
          <template #default="{ row }">
            <span style="color: #0d9488; font-weight: 600">{{ row.nodeOnline }}</span>
            <span class="xw-dim"> / {{ row.nodeTotal }}</span>
          </template>
        </el-table-column>

        <el-table-column label="密钥" width="70" align="center">
          <template #default="{ row }">{{ row.keyCount }}</template>
        </el-table-column>

        <el-table-column label="子网" width="64" align="center">
          <template #default="{ row }">{{ row.subnetCount }}</template>
        </el-table-column>

        <el-table-column label="规则" width="64" align="center">
          <template #default="{ row }">{{ row.aclCount }}</template>
        </el-table-column>

        <el-table-column label="中继" width="90">
          <template #default="{ row }">
            <el-tooltip :content="RELAY_MODE[row.relayMode]" placement="top">
              <el-tag size="small" effect="plain" type="info">
                {{ { auto: '自动', relay: '仅中继', p2p: '仅 P2P' }[row.relayMode] || row.relayMode }}
              </el-tag>
            </el-tooltip>
          </template>
        </el-table-column>

        <el-table-column label="创建时间" width="118">
          <template #default="{ row }">
            <span style="font-size: 12px; color: #6b7280">{{ formatShortTime(row.createdAt) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="152" align="right">
          <template #default="{ row }">
            <el-button text type="primary" size="small" @click="router.push(`/nodes?networkId=${row.id}`)">
              设备
            </el-button>
            <el-button text type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button text type="danger" size="small" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>

        <template #empty>
          <div class="xw-empty">还没有网络。点击右上角「新建网络」开始。</div>
        </template>
      </el-table>
    </div>

    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑网络' : '新建网络'"
      width="580px"
      destroy-on-close
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="96px">
        <el-form-item label="网络名称" prop="name">
          <el-input v-model="form.name" placeholder="例如 xiangwang-office" class="xw-mono" />
        </el-form-item>

        <el-form-item label="网络密钥" prop="secret">
          <el-input v-model="form.secret" placeholder="至少 8 位" class="xw-mono">
            <template #append>
              <el-button @click="genSecret">随机生成</el-button>
            </template>
          </el-input>
          <div class="xw-hint">密钥等同于网络的钥匙，同网所有设备必须完全一致才能互通</div>
        </el-form-item>

        <el-form-item label="虚拟网段" prop="cidr">
          <el-input v-model="form.cidr" placeholder="10.144.144.0/24" class="xw-mono" />
        </el-form-item>

        <el-form-item label="接入点">
          <el-input v-model="form.peers" class="xw-mono" placeholder="tcp://public.easytier.cn:11010" />
          <div class="xw-hint">
            节点间用于互相发现的地址。可填公共节点，也可填自己的服务器，多个用逗号分隔
          </div>
        </el-form-item>

        <el-form-item label="中继模式">
          <el-select v-model="form.relayMode" style="width: 100%">
            <el-option
              v-for="(label, value) in RELAY_MODE"
              :key="value"
              :label="label"
              :value="value"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="区域">
          <el-select v-model="form.region" style="width: 100%">
            <el-option label="中国大陆" value="cn" />
            <el-option label="中国香港" value="hk" />
            <el-option label="新加坡" value="sg" />
            <el-option label="日本" value="jp" />
            <el-option label="美国" value="us" />
            <el-option label="欧洲" value="eu" />
          </el-select>
          <div class="xw-hint">仅用于标记与统计口径，不改变实际链路</div>
        </el-form-item>

        <el-form-item label="描述">
          <el-input v-model="form.description" type="textarea" :rows="2" placeholder="可选，便于区分用途" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">
          {{ editingId ? '保存' : '创建' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.net-name {
  font-weight: 600;
  color: #0f2b33;
}

.net-desc {
  font-size: 12px;
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
</style>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api.js'

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

const fmt = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—')

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
      await api.patch(`/networks/${editingId.value}`, form)
      ElMessage.success('已保存，相关节点的配置将在 30 秒内自动同步')
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
  try {
    await ElMessageBox.confirm(
      `删除网络「${row.name}」会同时移除其下 ${row.nodeTotal} 个节点，且无法撤销。确定继续？`,
      '危险操作',
      { type: 'warning', confirmButtonText: '确认删除', confirmButtonClass: 'el-button--danger' }
    )
  } catch {
    return
  }
  await api.delete(`/networks/${row.id}`)
  ElMessage.success('已删除')
  await load()
}

onMounted(load)
</script>

<template>
  <div class="xw-page">
    <div class="xw-page-head">
      <div>
        <h1 class="xw-page-title">网络管理</h1>
        <p class="xw-page-desc">
          每张网络由「网络名 + 密钥」唯一标识，同一张网络内的设备会自动互相发现
        </p>
      </div>
      <el-button type="primary" @click="openCreate">
        <el-icon style="margin-right: 4px"><Plus /></el-icon>新建网络
      </el-button>
    </div>

    <div class="xw-card">
      <el-table :data="items" v-loading="loading" style="width: 100%">
        <el-table-column prop="name" label="网络名称" min-width="150">
          <template #default="{ row }">
            <div class="net-name xw-mono">{{ row.name }}</div>
            <div class="net-desc">{{ row.description || '—' }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="cidr" label="虚拟网段" min-width="140">
          <template #default="{ row }">
            <span class="xw-mono">{{ row.cidr }}</span>
          </template>
        </el-table-column>
        <el-table-column label="节点" width="110" align="center">
          <template #default="{ row }">
            <span style="color: #0d9488; font-weight: 600">{{ row.nodeOnline }}</span>
            <span style="color: #9ca3af"> / {{ row.nodeTotal }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="peers" label="接入点" min-width="220">
          <template #default="{ row }">
            <span class="xw-mono" style="color: #6b7280">{{ row.peers }}</span>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="170">
          <template #default="{ row }">
            <span style="font-size: 12.5px; color: #6b7280">{{ fmt(row.createdAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130" align="right">
          <template #default="{ row }">
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
      width="560px"
      destroy-on-close
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="92px">
        <el-form-item label="网络名称" prop="name">
          <el-input v-model="form.name" placeholder="例如 xiangwang-office" class="xw-mono" />
        </el-form-item>

        <el-form-item label="网络密钥" prop="secret">
          <el-input v-model="form.secret" placeholder="至少 8 位" class="xw-mono">
            <template #append>
              <el-button @click="genSecret">随机生成</el-button>
            </template>
          </el-input>
          <div class="tip">密钥等同于网络的钥匙，所有节点必须完全一致才能互通</div>
        </el-form-item>

        <el-form-item label="虚拟网段" prop="cidr">
          <el-input v-model="form.cidr" placeholder="10.144.144.0/24" class="xw-mono" />
        </el-form-item>

        <el-form-item label="接入点">
          <el-input v-model="form.peers" class="xw-mono" placeholder="tcp://public.easytier.cn:11010" />
          <div class="tip">
            节点间用于互相发现的地址。可填公共节点，也可填你自己的服务器地址，多个用逗号分隔
          </div>
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

.tip {
  font-size: 12px;
  color: #9ca3af;
  line-height: 1.6;
  margin-top: 4px;
}
</style>

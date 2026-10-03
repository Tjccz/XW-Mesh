<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api.js'
import { CHAIN_TYPE, PROTOCOL, copyText, download } from '../format.js'

const loading = ref(true)
const items = ref([])
const networks = ref([])
const preview = ref('')
const filter = reactive({ networkId: null })

const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref(null)
const form = reactive({
  networkId: null,
  name: '',
  action: 'allow',
  protocol: 'tcp',
  chainType: 'forward',
  srcCidr: '10.144.144.0/24',
  dstCidr: '0.0.0.0/0',
  ports: '',
  priority: 100,
  enabled: true,
})

const previewVisible = ref(false)

async function load() {
  loading.value = true
  try {
    const params = filter.networkId ? { networkId: filter.networkId } : {}
    const { data } = await api.get('/policies/acl', { params })
    items.value = data.items
    preview.value = data.preview || ''
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
  editingId.value = null
  const net = networks.value.find((n) => n.id === filter.networkId) || networks.value[0]
  Object.assign(form, {
    networkId: net.id,
    name: '',
    action: 'allow',
    protocol: 'tcp',
    chainType: 'forward',
    srcCidr: net.cidr,
    dstCidr: '0.0.0.0/0',
    ports: '',
    priority: 100,
    enabled: true,
  })
  dialogVisible.value = true
}

function openEdit(row) {
  editingId.value = row.id
  Object.assign(form, {
    networkId: row.networkId,
    name: row.name,
    action: row.action,
    protocol: row.protocol,
    chainType: row.chainType || 'forward',
    srcCidr: row.srcCidr,
    dstCidr: row.dstCidr,
    ports: row.ports,
    priority: row.priority,
    enabled: row.enabled,
  })
  dialogVisible.value = true
}

async function submit() {
  if (!form.name.trim()) {
    ElMessage.warning('请填写规则名称')
    return
  }
  submitting.value = true
  try {
    if (editingId.value) {
      await api.patch(`/policies/acl/${editingId.value}`, form)
      ElMessage.success('已保存并下发')
    } else {
      const { data } = await api.post('/policies/acl', form)
      ElMessage.success(`已下发，${data.affectedNodes} 台设备将在 30 秒内同步`)
    }
    dialogVisible.value = false
    await load()
  } finally {
    submitting.value = false
  }
}

async function toggle(row) {
  await api.patch(`/policies/acl/${row.id}`, { enabled: !row.enabled })
  ElMessage.success(row.enabled ? '规则已停用' : '规则已启用')
  await load()
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`删除规则「${row.name}」后将立即恢复为默认放行。确定继续？`, '提示', {
      type: 'warning',
    })
  } catch {
    return
  }
  await api.delete(`/policies/acl/${row.id}`)
  ElMessage.success('已删除')
  await load()
}

async function copyPreview() {
  const okDone = await copyText(preview.value)
  ElMessage[okDone ? 'success' : 'warning'](okDone ? '已复制配置片段' : '复制失败')
}

onMounted(async () => {
  await loadNetworks()
  // 默认选中已有规则的网络，避免一进来就是空页
  const withRules = networks.value.find((n) => n.aclCount > 0)
  if (networks.value.length) filter.networkId = (withRules || networks.value[0]).id
  await load()
})
</script>

<template>
  <div class="xw-page">
    <div class="xw-page-head">
      <div>
        <h1 class="xw-page-title">访问控制</h1>
        <p class="xw-page-desc">
          按「源网段 → 目标网段 + 端口」控制网络内可达性，规则会编译进每台设备的核心配置
        </p>
      </div>
      <div style="display: flex; gap: 8px">
        <el-button :disabled="!preview" @click="previewVisible = true">
          <el-icon style="margin-right: 4px"><Document /></el-icon>查看编译结果
        </el-button>
        <el-button type="primary" @click="openCreate">
          <el-icon style="margin-right: 4px"><Plus /></el-icon>新建规则
        </el-button>
      </div>
    </div>

    <el-alert type="warning" :closable="false" show-icon style="margin-bottom: 16px">
      <template #title>
        规则按「优先级」从大到小匹配，命中即停止：先写的拒绝规则会覆盖后面的放行规则。
        控制台采用基于 IP 网段的策略（不依赖设备组身份），便于在任意设备上统一生效。
      </template>
    </el-alert>

    <div class="xw-card">
      <div class="xw-toolbar">
        <el-select
          v-model="filter.networkId"
          placeholder="全部网络"
          clearable
          style="width: 220px"
          @change="load"
        >
          <el-option v-for="n in networks" :key="n.id" :label="n.name" :value="n.id" />
        </el-select>
        <el-button @click="load">刷新</el-button>
      </div>

      <el-table :data="items" v-loading="loading" style="width: 100%">
        <el-table-column label="优先级" width="86" align="center">
          <template #default="{ row }">
            <span class="xw-mono xw-strong">{{ row.priority }}</span>
          </template>
        </el-table-column>

        <el-table-column label="规则名称" min-width="150">
          <template #default="{ row }">
            <div class="xw-strong">{{ row.name }}</div>
            <div class="sub-line">{{ CHAIN_TYPE[row.chainType] || row.chainType }}</div>
          </template>
        </el-table-column>

        <el-table-column label="动作" width="90">
          <template #default="{ row }">
            <el-tag :type="row.action === 'allow' ? 'success' : 'danger'" size="small" effect="light">
              {{ row.action === 'allow' ? '放行' : '拒绝' }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="协议" width="80">
          <template #default="{ row }">
            <span class="xw-mono" style="font-size: 12px">{{ PROTOCOL[row.protocol] || row.protocol }}</span>
          </template>
        </el-table-column>

        <el-table-column label="源网段" min-width="150">
          <template #default="{ row }">
            <span class="xw-mono" style="font-size: 12px">{{ row.srcCidr }}</span>
          </template>
        </el-table-column>

        <el-table-column label="目标网段" min-width="150">
          <template #default="{ row }">
            <span class="xw-mono" style="font-size: 12px">{{ row.dstCidr }}</span>
          </template>
        </el-table-column>

        <el-table-column label="端口" width="110">
          <template #default="{ row }">
            <span class="xw-mono" style="font-size: 12px">{{ row.ports || '全部' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="状态" width="86">
          <template #default="{ row }">
            <el-switch :model-value="row.enabled" size="small" @change="toggle(row)" />
          </template>
        </el-table-column>

        <el-table-column label="操作" width="110" align="right">
          <template #default="{ row }">
            <el-button text type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button text type="danger" size="small" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>

        <template #empty>
          <div class="xw-empty">
            暂无规则。没有规则时网络内设备默认互通，适合先跑通再逐步收紧。
          </div>
        </template>
      </el-table>
    </div>

    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑规则' : '新建规则'"
      width="580px"
      destroy-on-close
    >
      <el-form :model="form" label-width="96px">
        <el-form-item label="所属网络" required>
          <el-select v-model="form.networkId" style="width: 100%" :disabled="!!editingId">
            <el-option v-for="n in networks" :key="n.id" :label="n.name" :value="n.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="规则名称" required>
          <el-input v-model="form.name" placeholder="例如：只允许办公网访问数据库" />
        </el-form-item>
        <el-form-item label="动作" required>
          <el-radio-group v-model="form.action">
            <el-radio-button value="allow">放行</el-radio-button>
            <el-radio-button value="deny">拒绝</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="作用于">
          <el-select v-model="form.chainType" style="width: 100%">
            <el-option
              v-for="(label, value) in CHAIN_TYPE"
              :key="value"
              :label="label"
              :value="value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="协议">
          <el-select v-model="form.protocol" style="width: 100%">
            <el-option v-for="(label, value) in PROTOCOL" :key="value" :label="label" :value="value" />
          </el-select>
        </el-form-item>
        <el-form-item label="源网段">
          <el-input v-model="form.srcCidr" class="xw-mono" placeholder="0.0.0.0/0 表示任意" />
        </el-form-item>
        <el-form-item label="目标网段">
          <el-input v-model="form.dstCidr" class="xw-mono" placeholder="0.0.0.0/0 表示任意" />
        </el-form-item>
        <el-form-item label="端口">
          <el-input v-model="form.ports" class="xw-mono" placeholder="留空表示全部端口，多个用英文逗号分隔" />
        </el-form-item>
        <el-form-item label="优先级">
          <el-input-number v-model="form.priority" :min="1" :max="65535" />
          <span class="xw-hint" style="margin-left: 10px">数值越大越先匹配</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">
          {{ editingId ? '保存' : '下发' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="previewVisible" title="下发给设备的核心配置片段" width="720px">
      <div class="xw-hint" style="margin-bottom: 10px">
        该片段会附加到每台设备 config.toml 末尾，节点代理检测到变化后自动重启核心生效。
      </div>
      <pre class="xw-script">{{ preview }}</pre>
      <template #footer>
        <el-button @click="copyPreview">
          <el-icon style="margin-right: 4px"><DocumentCopy /></el-icon>复制
        </el-button>
        <el-button @click="download('xiangwang-acl.toml', preview)">
          <el-icon style="margin-right: 4px"><Download /></el-icon>下载 .toml
        </el-button>
        <el-button type="primary" @click="previewVisible = false">关闭</el-button>
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

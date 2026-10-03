<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api.js'
import { formatTime } from '../format.js'

const loading = ref(true)
const workspace = ref(null)
const quota = ref([])
const me = ref(null)
const system = ref(null)

const editing = ref(false)
const saving = ref(false)
const form = reactive({ name: '', plan: 'selfhost' })

const profileName = ref('')
const savingProfile = ref(false)

const pwd = reactive({ oldPassword: '', newPassword: '', confirm: '' })
const savingPwd = ref(false)

const PLAN_DESC = {
  selfhost: '自建部署默认套餐，不限制网络、设备与密钥数量',
  pro: '对照商业版专业版：5 张网络 / 50 台设备 / 20 个密钥 / 5 条访问控制',
  free: '对照商业版免费版：2 张网络 / 20 台设备 / 5 个密钥 / 1 条访问控制',
}

const isOwner = computed(() => me.value?.role === 'owner')

function quotaPercent(row) {
  if (!row.limit) return 0
  return Math.min(100, Math.round((row.used / row.limit) * 100))
}

function quotaColor(row) {
  const p = quotaPercent(row)
  if (p >= 90) return '#e11d48'
  if (p >= 70) return '#d97706'
  return '#0d9488'
}

async function load() {
  loading.value = true
  try {
    const [wsRes, meRes, ovRes] = await Promise.all([
      api.get('/workspaces'),
      api.get('/auth/me'),
      api.get('/overview'),
    ])
    workspace.value = wsRes.data.item
    quota.value = wsRes.data.quota
    me.value = meRes.data.user
    system.value = ovRes.data.system
    form.name = wsRes.data.item.name
    form.plan = wsRes.data.item.plan
    profileName.value = meRes.data.user.displayName || meRes.data.user.username
  } finally {
    loading.value = false
  }
}

function startEdit() {
  form.name = workspace.value.name
  form.plan = workspace.value.plan
  editing.value = true
}

async function saveWorkspace() {
  if (!form.name.trim()) {
    ElMessage.warning('工作区名称不能为空')
    return
  }
  saving.value = true
  try {
    await api.patch('/workspaces', { name: form.name.trim(), plan: form.plan })
    ElMessage.success('已保存')
    editing.value = false
    await load()
  } finally {
    saving.value = false
  }
}

async function saveProfile() {
  savingProfile.value = true
  try {
    const { data } = await api.patch('/auth/profile', { displayName: profileName.value })
    me.value = data.user
    ElMessage.success('显示名称已更新')
  } finally {
    savingProfile.value = false
  }
}

async function changePassword() {
  if (!pwd.oldPassword || !pwd.newPassword) {
    ElMessage.warning('请填写原密码与新密码')
    return
  }
  if (pwd.newPassword.length < 8) {
    ElMessage.warning('新密码至少 8 位')
    return
  }
  if (pwd.newPassword !== pwd.confirm) {
    ElMessage.warning('两次输入的新密码不一致')
    return
  }
  savingPwd.value = true
  try {
    await api.post('/auth/password', {
      oldPassword: pwd.oldPassword,
      newPassword: pwd.newPassword,
    })
    ElMessage.success('密码已修改，请牢记新密码')
    pwd.oldPassword = ''
    pwd.newPassword = ''
    pwd.confirm = ''
  } finally {
    savingPwd.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="xw-page" v-loading="loading">
    <div class="xw-page-head">
      <div>
        <h1 class="xw-page-title">工作区设置</h1>
        <p class="xw-page-desc">工作区是资源与成员的边界，套餐决定可用的网络、设备与策略数量</p>
      </div>
      <el-button v-if="isOwner && !editing" @click="startEdit">
        <el-icon style="margin-right: 4px"><Edit /></el-icon>编辑
      </el-button>
      <div v-else-if="editing" style="display: flex; gap: 8px">
        <el-button @click="editing = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveWorkspace">保存</el-button>
      </div>
    </div>

    <div class="grid-two">
      <div class="xw-card">
        <div class="xw-card-head"><h3>工作区信息</h3></div>

        <el-form v-if="editing" :model="form" label-width="96px">
          <el-form-item label="工作区名称">
            <el-input v-model="form.name" maxlength="40" show-word-limit />
          </el-form-item>
          <el-form-item label="套餐">
            <el-select v-model="form.plan" style="width: 100%">
              <el-option v-for="(desc, key) in PLAN_DESC" :key="key" :label="key" :value="key">
                <span>{{ key }}</span>
                <span class="xw-dim" style="float: right; font-size: 12px"> {{ desc }}</span>
              </el-option>
            </el-select>
          </el-form-item>
        </el-form>

        <div v-else class="xw-kv">
          <div class="xw-kv-item">
            <div class="xw-kv-label">工作区名称</div>
            <div class="xw-kv-value">{{ workspace?.name }}</div>
          </div>
          <div class="xw-kv-item">
            <div class="xw-kv-label">标识 slug</div>
            <div class="xw-kv-value xw-mono">{{ workspace?.slug }}</div>
          </div>
          <div class="xw-kv-item">
            <div class="xw-kv-label">套餐</div>
            <div class="xw-kv-value">{{ workspace?.plan }}</div>
          </div>
          <div class="xw-kv-item">
            <div class="xw-kv-label">创建时间</div>
            <div class="xw-kv-value">{{ formatTime(workspace?.createdAt) }}</div>
          </div>
          <div class="xw-kv-item">
            <div class="xw-kv-label">我的角色</div>
            <div class="xw-kv-value">{{ me?.roleLabel }}</div>
          </div>
          <div class="xw-kv-item">
            <div class="xw-kv-label">控制台版本</div>
            <div class="xw-kv-value">v{{ system?.version }} / 核心 v{{ system?.etVersion }}</div>
          </div>
        </div>

        <div class="xw-hint" style="margin-top: 14px">
          {{ PLAN_DESC[workspace?.plan] || '' }}
        </div>
      </div>

      <div class="xw-card">
        <div class="xw-card-head"><h3>资源用量</h3></div>
        <div class="xw-quota">
          <div v-for="q in quota" :key="q.key" class="xw-quota-row">
            <span class="name">{{ q.label }}</span>
            <div class="bar-track">
              <div
                class="bar-fill"
                :style="{ width: quotaPercent(q) + '%', background: quotaColor(q) }"
              ></div>
            </div>
            <span class="num"><b>{{ q.used }}</b> / {{ q.limit }}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="grid-two">
      <div class="xw-card">
        <div class="xw-card-head"><h3>我的账号</h3></div>
        <el-form label-width="96px">
          <el-form-item label="登录用户名">
            <el-input :model-value="me?.username" disabled class="xw-mono" />
          </el-form-item>
          <el-form-item label="显示名称">
            <el-input v-model="profileName" maxlength="32" />
          </el-form-item>
          <el-form-item>
            <el-button :loading="savingProfile" @click="saveProfile">保存显示名称</el-button>
          </el-form-item>
        </el-form>
      </div>

      <div class="xw-card">
        <div class="xw-card-head"><h3>修改登录密码</h3></div>
        <el-form label-width="96px">
          <el-form-item label="原密码">
            <el-input v-model="pwd.oldPassword" type="password" show-password class="xw-mono" />
          </el-form-item>
          <el-form-item label="新密码">
            <el-input v-model="pwd.newPassword" type="password" show-password class="xw-mono" />
          </el-form-item>
          <el-form-item label="确认新密码">
            <el-input v-model="pwd.confirm" type="password" show-password class="xw-mono" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :loading="savingPwd" @click="changePassword">
              修改密码
            </el-button>
          </el-form-item>
        </el-form>
      </div>
    </div>
  </div>
</template>

<style scoped>
.grid-two {
  display: grid;
  grid-template-columns: 1.3fr 1fr;
  gap: 16px;
  align-items: start;
  margin-bottom: 16px;
}

.bar-track {
  height: 8px;
  background: #f1f5f6;
  border-radius: 4px;
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.3s;
}

@media (max-width: 1080px) {
  .grid-two {
    grid-template-columns: 1fr;
  }
}
</style>

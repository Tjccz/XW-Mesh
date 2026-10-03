<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api.js'
import { formatTime } from '../format.js'

const loading = ref(true)
const members = ref([])
const me = ref(null)

const inviteVisible = ref(false)
const submitting = ref(false)
const form = reactive({ username: '', password: '', role: 'member', displayName: '' })

const pwdVisible = ref(false)
const pwdTarget = ref(null)
const newPassword = ref('')
const pwdSubmitting = ref(false)

const ROLE_META = {
  owner: { text: '拥有者', type: 'danger', desc: '全部权限，含工作区设置与成员管理' },
  admin: { text: '管理员', type: 'warning', desc: '可管理网络、设备、密钥、子网与访问控制' },
  member: { text: '成员', type: 'primary', desc: '可查看全部信息，不能执行变更操作' },
  viewer: { text: '只读', type: 'info', desc: '仅可查看，适合审计与演示' },
}

const isOwner = computed(() => me.value?.role === 'owner')

function genPassword() {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789@#%'
  let out = ''
  const arr = new Uint32Array(16)
  crypto.getRandomValues(arr)
  for (const n of arr) out += chars[n % chars.length]
  return out
}

async function load() {
  loading.value = true
  try {
    const [memberRes, meRes] = await Promise.all([
      api.get('/workspaces/members'),
      api.get('/auth/me'),
    ])
    members.value = memberRes.data.items
    me.value = meRes.data.user
  } finally {
    loading.value = false
  }
}

function openInvite() {
  Object.assign(form, { username: '', password: genPassword(), role: 'member', displayName: '' })
  inviteVisible.value = true
}

async function submitInvite() {
  if (!/^[A-Za-z0-9_.@-]{3,40}$/.test(form.username)) {
    ElMessage.warning('用户名需为 3-40 位字母、数字或 _ . @ -')
    return
  }
  if (form.password.length < 8) {
    ElMessage.warning('密码至少 8 位')
    return
  }
  submitting.value = true
  try {
    await api.post('/workspaces/members', form)
    ElMessage.success('成员已创建，请把账号密码转交给他')
    inviteVisible.value = false
    await load()
  } finally {
    submitting.value = false
  }
}

async function changeRole(row, role) {
  try {
    await api.patch(`/workspaces/members/${row.id}`, { role })
    ElMessage.success('角色已更新')
  } catch {
    /* 拦截器已提示，下面重新拉取以还原选择框 */
  } finally {
    await load()
  }
}

function openResetPwd(row) {
  pwdTarget.value = row
  newPassword.value = genPassword()
  pwdVisible.value = true
}

async function submitResetPwd() {
  if (newPassword.value.length < 8) {
    ElMessage.warning('密码至少 8 位')
    return
  }
  pwdSubmitting.value = true
  try {
    await api.post(`/workspaces/members/${pwdTarget.value.id}/password`, {
      password: newPassword.value,
    })
    ElMessage.success('密码已重置')
    pwdVisible.value = false
  } finally {
    pwdSubmitting.value = false
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`移除成员「${row.username}」后其账号将立即失效。确定继续？`, '提示', {
      type: 'warning',
    })
  } catch {
    return
  }
  await api.delete(`/workspaces/members/${row.id}`)
  ElMessage.success('已移除')
  await load()
}

onMounted(load)
</script>

<template>
  <div class="xw-page" v-loading="loading">
    <div class="xw-page-head">
      <div>
        <h1 class="xw-page-title">工作区与成员</h1>
        <p class="xw-page-desc">
          工作区下的所有资源（网络、设备、密钥、策略）由成员共享，操作全程留痕
        </p>
      </div>
      <el-button type="primary" :disabled="!isOwner" @click="openInvite">
        <el-icon style="margin-right: 4px"><Plus /></el-icon>添加成员
      </el-button>
    </div>

    <div class="xw-card">
      <div class="xw-card-head">
        <h3>成员列表<span class="sub">共 {{ members.length }} 人</span></h3>
      </div>

      <el-table :data="members" style="width: 100%">
        <el-table-column label="成员" min-width="180">
          <template #default="{ row }">
            <div class="member-cell">
              <div class="avatar">{{ (row.displayName || row.username).slice(0, 1).toUpperCase() }}</div>
              <div>
                <div class="xw-strong">
                  {{ row.displayName || row.username }}
                  <el-tag v-if="row.isSelf" size="small" effect="plain" type="success">我</el-tag>
                </div>
                <div class="sub-line xw-mono">{{ row.username }}</div>
              </div>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="角色" width="150">
          <template #default="{ row }">
            <el-select
              v-if="isOwner && row.role !== 'owner'"
              :model-value="row.role"
              size="small"
              style="width: 110px"
              @change="(v) => changeRole(row, v)"
            >
              <el-option label="管理员" value="admin" />
              <el-option label="成员" value="member" />
              <el-option label="只读" value="viewer" />
            </el-select>
            <el-tag v-else :type="ROLE_META[row.role]?.type" size="small" effect="light">
              {{ ROLE_META[row.role]?.text || row.role }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="权限范围" min-width="230">
          <template #default="{ row }">
            <span class="xw-hint">{{ ROLE_META[row.role]?.desc }}</span>
          </template>
        </el-table-column>

        <el-table-column label="加入时间" width="170">
          <template #default="{ row }">
            <span style="font-size: 12.5px; color: #6b7280">{{ formatTime(row.createdAt) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="160" align="right">
          <template #default="{ row }">
            <el-button
              v-if="isOwner"
              text
              type="primary"
              size="small"
              @click="openResetPwd(row)"
            >
              重置密码
            </el-button>
            <el-button
              v-if="isOwner && row.role !== 'owner' && !row.isSelf"
              text
              type="danger"
              size="small"
              @click="remove(row)"
            >
              移除
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-alert
        v-if="!isOwner"
        type="info"
        :closable="false"
        show-icon
        title="只有工作区「拥有者」可以添加或移除成员、调整角色。"
        style="margin-top: 14px"
      />
    </div>

    <el-dialog v-model="inviteVisible" title="添加成员" width="520px" destroy-on-close>
      <el-form :model="form" label-width="92px">
        <el-form-item label="登录用户名" required>
          <el-input v-model="form.username" class="xw-mono" placeholder="例如 zhangsan" />
        </el-form-item>
        <el-form-item label="显示名称">
          <el-input v-model="form.displayName" placeholder="例如 张三" />
        </el-form-item>
        <el-form-item label="初始密码" required>
          <el-input v-model="form.password" class="xw-mono">
            <template #append>
              <el-button @click="form.password = genPassword()">随机生成</el-button>
            </template>
          </el-input>
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="form.role" style="width: 100%">
            <el-option label="管理员（可管理全部资源）" value="admin" />
            <el-option label="成员（只读，可查看全部信息）" value="member" />
            <el-option label="只读（仅查看）" value="viewer" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="inviteVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitInvite">创建成员</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="pwdVisible" :title="`重置密码 · ${pwdTarget?.username || ''}`" width="480px">
      <el-form label-width="92px">
        <el-form-item label="新密码">
          <el-input v-model="newPassword" class="xw-mono">
            <template #append>
              <el-button @click="newPassword = genPassword()">随机生成</el-button>
            </template>
          </el-input>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pwdVisible = false">取消</el-button>
        <el-button type="primary" :loading="pwdSubmitting" @click="submitResetPwd">确认重置</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.member-cell {
  display: flex;
  align-items: center;
  gap: 10px;
}

.avatar {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: #e2f2f0;
  color: #0d9488;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 32px;
}

.sub-line {
  font-size: 11.5px;
  color: #9ca3af;
  margin-top: 2px;
}
</style>

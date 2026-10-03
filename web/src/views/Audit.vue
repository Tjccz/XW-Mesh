<script setup>
import { onMounted, reactive, ref } from 'vue'
import api from '../api.js'
import { formatTime } from '../format.js'

const loading = ref(true)
const items = ref([])
const total = ref(0)
const actions = ref([])
const page = ref(1)
const pageSize = ref(50)

const filter = reactive({ action: null, username: '', keyword: '' })

const actionType = {
  login: 'success',
  login_failed: 'danger',
  network_delete: 'danger',
  node_delete: 'danger',
  node_block: 'warning',
  key_revoke: 'warning',
  member_remove: 'danger',
  node_rollback: 'warning',
  network_update: 'warning',
  node_update: 'warning',
  acl_delete: 'danger',
  subnet_delete: 'danger',
  workspace_update: 'warning',
}

async function load() {
  loading.value = true
  try {
    const params = { limit: pageSize.value, offset: (page.value - 1) * pageSize.value }
    if (filter.action) params.action = filter.action
    if (filter.username) params.username = filter.username
    if (filter.keyword) params.keyword = filter.keyword
    const { data } = await api.get('/audit', { params })
    items.value = data.items
    total.value = data.total
  } finally {
    loading.value = false
  }
}

function search() {
  page.value = 1
  load()
}

function reset() {
  filter.action = null
  filter.username = ''
  filter.keyword = ''
  search()
}

async function exportCsv() {
  const params = {}
  if (filter.action) params.action = filter.action
  if (filter.username) params.username = filter.username
  if (filter.keyword) params.keyword = filter.keyword
  const res = await api.get('/audit/export.csv', { params, responseType: 'blob' })
  const url = URL.createObjectURL(new Blob([res.data], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'xiangwang-audit.csv'
  a.click()
  URL.revokeObjectURL(url)
}

onMounted(async () => {
  const { data } = await api.get('/audit/actions')
  actions.value = data.items
  await load()
})
</script>

<template>
  <div class="xw-page">
    <div class="xw-page-head">
      <div>
        <h1 class="xw-page-title">审计日志</h1>
        <p class="xw-page-desc">
          谁在什么时候改了哪个网络、哪台设备，全部留痕，共 {{ total }} 条记录
        </p>
      </div>
      <el-button @click="exportCsv">
        <el-icon style="margin-right: 4px"><Download /></el-icon>导出 CSV
      </el-button>
    </div>

    <div class="xw-card">
      <div class="xw-toolbar">
        <el-select
          v-model="filter.action"
          placeholder="全部动作"
          clearable
          filterable
          style="width: 190px"
          @change="search"
        >
          <el-option v-for="a in actions" :key="a.value" :label="a.label" :value="a.value" />
        </el-select>
        <el-input
          v-model="filter.username"
          placeholder="操作者"
          clearable
          style="width: 160px"
          @keyup.enter="search"
          @clear="search"
        />
        <el-input
          v-model="filter.keyword"
          placeholder="详情关键词"
          clearable
          style="width: 220px"
          @keyup.enter="search"
          @clear="search"
        />
        <el-button type="primary" @click="search">查询</el-button>
        <el-button @click="reset">重置</el-button>
      </div>

      <el-table :data="items" v-loading="loading" style="width: 100%">
        <el-table-column label="时间" width="176">
          <template #default="{ row }">
            <span class="xw-mono" style="font-size: 12px">{{ formatTime(row.createdAt) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="操作者" width="130">
          <template #default="{ row }">
            <span :class="{ 'xw-mono': row.username?.startsWith('key:') || row.username?.startsWith('node:') }">
              {{ row.username || '系统' }}
            </span>
          </template>
        </el-table-column>

        <el-table-column label="动作" width="140">
          <template #default="{ row }">
            <el-tag :type="actionType[row.action] || 'info'" size="small" effect="light">
              {{ row.actionLabel || row.action }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column prop="detail" label="详情" min-width="300" />

        <el-table-column label="对象" width="140">
          <template #default="{ row }">
            <span class="xw-mono xw-dim" style="font-size: 11.5px">
              {{ row.targetType ? `${row.targetType}#${row.targetId}` : '—' }}
            </span>
          </template>
        </el-table-column>

        <el-table-column label="来源 IP" width="150">
          <template #default="{ row }">
            <span class="xw-mono" style="font-size: 12px; color: #6b7280">{{ row.ip || '—' }}</span>
          </template>
        </el-table-column>

        <template #empty>
          <div class="xw-empty">暂无日志</div>
        </template>
      </el-table>

      <div class="pager">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :total="total"
          :page-sizes="[20, 50, 100, 200]"
          layout="total, sizes, prev, pager, next"
          background
          @current-change="load"
          @size-change="search"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}
</style>

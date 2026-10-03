<script setup>
import { onMounted, ref } from 'vue'
import api from '../api.js'

const loading = ref(true)
const items = ref([])

const actionLabel = {
  login: '登录',
  login_failed: '登录失败',
  network_create: '创建网络',
  network_update: '更新网络',
  network_delete: '删除网络',
  node_create: '新增节点',
  node_update: '更新节点',
  node_delete: '删除节点',
  node_rollback: '回滚配置',
  node_provision: '获取接入脚本',
}

const actionType = {
  login: 'success',
  login_failed: 'danger',
  network_delete: 'danger',
  node_delete: 'danger',
  node_rollback: 'warning',
  network_update: 'warning',
  node_update: 'warning',
}

const fmt = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—')

onMounted(async () => {
  try {
    const { data } = await api.get('/audit', { params: { limit: 200 } })
    items.value = data.items
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="xw-page">
    <div class="xw-page-head">
      <div>
        <h1 class="xw-page-title">审计日志</h1>
        <p class="xw-page-desc">谁在什么时候改了哪个网络的什么参数，全部留痕</p>
      </div>
    </div>

    <div class="xw-card">
      <el-table :data="items" v-loading="loading" style="width: 100%">
        <el-table-column label="时间" width="180">
          <template #default="{ row }">
            <span class="xw-mono" style="font-size: 12px">{{ fmt(row.createdAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作人" width="110" prop="username" />
        <el-table-column label="动作" width="130">
          <template #default="{ row }">
            <el-tag :type="actionType[row.action] || 'info'" size="small" effect="light">
              {{ actionLabel[row.action] || row.action }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="detail" label="详情" min-width="260" />
        <el-table-column label="来源 IP" width="160">
          <template #default="{ row }">
            <span class="xw-mono" style="font-size: 12px; color: #6b7280">{{ row.ip || '—' }}</span>
          </template>
        </el-table-column>
        <template #empty>
          <div class="xw-empty">暂无日志</div>
        </template>
      </el-table>
    </div>
  </div>
</template>

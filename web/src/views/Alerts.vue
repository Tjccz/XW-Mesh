<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api.js'
import {
  formatShortTime,
  formatTime,
  fromNow,
  copyText,
  NODE_STATUS,
} from '../format.js'

const me = ref(null)
const canManage = computed(() => ['owner', 'admin'].includes(me.value?.role))

const tab = ref('events')
const meta = ref({ eventTypes: [], channelTypes: [], levels: [] })

const summary = ref({
  firing: 0, critical: 0, unacked: 0, resolved24h: 0, total24h: 0,
  channelTotal: 0, channelEnabled: 0, channelFailed: 0, ruleTotal: 0, ruleEnabled: 0,
  channels: [],
})

/* ------------------------------ 事件 ------------------------------ */
const events = ref([])
const eventTotal = ref(0)
const eventQuery = reactive({ status: '', level: '', eventType: '', keyword: '', page: 1, size: 20 })
const loadingEvents = ref(false)
const detailVisible = ref(false)
const detailEvent = ref(null)
const scanning = ref(false)

const LEVEL_META = {
  info: { text: '提示', type: 'info' },
  warning: { text: '警告', type: 'warning' },
  critical: { text: '严重', type: 'danger' },
}
const EVENT_STATE = {
  firing: { text: '触发中', type: 'danger' },
  resolved: { text: '已恢复', type: 'success' },
}

async function loadEvents() {
  loadingEvents.value = true
  try {
    const { data } = await api.get('/alerts/events', {
      params: {
        status: eventQuery.status || undefined,
        level: eventQuery.level || undefined,
        eventType: eventQuery.eventType || undefined,
        keyword: eventQuery.keyword || undefined,
        limit: eventQuery.size,
        offset: (eventQuery.page - 1) * eventQuery.size,
      },
    })
    events.value = data.items
    eventTotal.value = data.total
  } finally {
    loadingEvents.value = false
  }
}

async function loadSummary() {
  const { data } = await api.get('/alerts/summary')
  summary.value = data
}

async function loadMe() {
  try {
    const { data } = await api.get('/auth/me')
    me.value = data.user
  } catch {
    /* 拦截器已处理 */
  }
}

function resetFilters() {
  eventQuery.status = ''
  eventQuery.level = ''
  eventQuery.eventType = ''
  eventQuery.keyword = ''
  eventQuery.page = 1
  loadEvents()
}

async function openDetail(row) {
  const { data } = await api.get(`/alerts/events/${row.id}`)
  detailEvent.value = data.item
  detailVisible.value = true
}

async function ackEvent(row) {
  try {
    await api.post(`/alerts/events/${row.id}/ack`)
    ElMessage.success('已确认')
    await refresh()
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || '操作失败')
  }
}

async function ackAll() {
  try {
    await api.post('/alerts/events/ack-all')
    ElMessage.success('已全部确认')
    await refresh()
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || '操作失败')
  }
}

async function runScan() {
  scanning.value = true
  try {
    const { data } = await api.post('/alerts/scan')
    ElMessage.success(`扫描完成：触发 ${data.fired} 条，恢复 ${data.resolved} 条`)
    await refresh()
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || '扫描失败')
  } finally {
    scanning.value = false
  }
}

/* ------------------------------ 渠道 ------------------------------ */
const channels = ref([])
const channelVisible = ref(false)
const channelEditing = ref(null)
const channelForm = reactive({ name: '', type: 'webhook', config: {}, enabled: true })
const testingId = ref(0)

function channelTypeMeta(type) {
  return meta.value.channelTypes.find((t) => t.key === type) || { fields: [], secrets: [], label: type }
}

function openChannelCreate() {
  channelEditing.value = null
  channelForm.name = ''
  channelForm.type = 'webhook'
  channelForm.config = { secure: true, port: 465 }
  channelForm.enabled = true
  channelVisible.value = true
}

function openChannelEdit(row) {
  channelEditing.value = row
  channelForm.name = row.name
  channelForm.type = row.type
  channelForm.config = { ...row.config }
  channelForm.enabled = row.enabled
  channelVisible.value = true
}

async function saveChannel() {
  try {
    const payload = { name: channelForm.name, type: channelForm.type, config: channelForm.config, enabled: channelForm.enabled }
    if (channelEditing.value) {
      await api.patch(`/alerts/channels/${channelEditing.value.id}`, payload)
      ElMessage.success('渠道已更新')
    } else {
      await api.post('/alerts/channels', payload)
      ElMessage.success('渠道已创建')
    }
    channelVisible.value = false
    await refresh()
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || '保存失败')
  }
}

async function removeChannel(row) {
  try {
    await ElMessageBox.confirm(
      `确定删除通知渠道「${row.name}」吗？引用它的告警规则会同时被解除关联。`,
      '删除确认',
      { type: 'warning' }
    )
  } catch {
    return
  }
  try {
    await api.delete(`/alerts/channels/${row.id}`)
    ElMessage.success('已删除')
    await refresh()
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || '删除失败')
  }
}

async function testChannel(row) {
  testingId.value = row.id
  try {
    const { data } = await api.post(`/alerts/channels/${row.id}/test`)
    if (data.ok) ElMessage.success(`测试消息已发出：${data.detail || '成功'}`)
    else ElMessage.error(`测试失败：${data.error}`)
    await refresh()
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || '测试失败')
  } finally {
    testingId.value = 0
  }
}

/* ------------------------------ 规则 ------------------------------ */
const rules = ref([])
const ruleVisible = ref(false)
const ruleEditing = ref(null)
const ruleForm = reactive({
  name: '', eventType: 'node_offline', threshold: 10, networkId: null,
  level: 'warning', channelIds: [], silenceMinutes: 30, enabled: true,
})
const networks = ref([])

const currentEventMeta = computed(
  () => meta.value.eventTypes.find((t) => t.key === ruleForm.eventType) || { unit: '', defaultThreshold: 10, hint: '' }
)

function openRuleCreate() {
  ruleEditing.value = null
  ruleForm.name = ''
  ruleForm.eventType = 'node_offline'
  ruleForm.threshold = currentEventMeta.value.defaultThreshold
  ruleForm.networkId = null
  ruleForm.level = 'warning'
  ruleForm.channelIds = []
  ruleForm.silenceMinutes = 30
  ruleForm.enabled = true
  ruleVisible.value = true
}

function openRuleEdit(row) {
  ruleEditing.value = row
  ruleForm.name = row.name
  ruleForm.eventType = row.eventType
  ruleForm.threshold = row.threshold
  ruleForm.networkId = row.networkId || null
  ruleForm.level = row.level
  ruleForm.channelIds = [...row.channelIds]
  ruleForm.silenceMinutes = row.silenceMinutes
  ruleForm.enabled = row.enabled
  ruleVisible.value = true
}

function onEventTypeChange() {
  ruleForm.threshold = currentEventMeta.value.defaultThreshold
}

async function saveRule() {
  try {
    const payload = { ...ruleForm, networkId: ruleForm.networkId || null }
    if (ruleEditing.value) {
      await api.patch(`/alerts/rules/${ruleEditing.value.id}`, payload)
      ElMessage.success('规则已更新')
    } else {
      await api.post('/alerts/rules', payload)
      ElMessage.success('规则已创建')
    }
    ruleVisible.value = false
    await refresh()
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || '保存失败')
  }
}

async function toggleRule(row) {
  try {
    await api.patch(`/alerts/rules/${row.id}`, { enabled: !row.enabled })
    await refresh()
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || '操作失败')
  }
}

async function removeRule(row) {
  try {
    await ElMessageBox.confirm(`确定删除告警规则「${row.name}」吗？`, '删除确认', { type: 'warning' })
  } catch {
    return
  }
  try {
    await api.delete(`/alerts/rules/${row.id}`)
    ElMessage.success('已删除')
    await refresh()
  } catch (err) {
    ElMessage.error(err?.response?.data?.error || '删除失败')
  }
}

/* ------------------------------ 通用 ------------------------------ */
async function refresh() {
  await Promise.all([loadSummary(), loadEvents(), loadChannels(), loadRules()])
}

async function loadChannels() {
  const { data } = await api.get('/alerts/channels')
  channels.value = data.items
}

async function loadRules() {
  const { data } = await api.get('/alerts/rules')
  rules.value = data.items
}

async function copyEvent(row) {
  const text = `【${EVENT_STATE[row.status]?.text || row.status}】${row.eventLabel} · ${
    LEVEL_META[row.level]?.text || row.level
  }\n对象：${row.targetName || row.targetId}\n规则：${row.ruleName}\n说明：${row.message}\n时间：${formatTime(row.firedAt)}`
  const ok = await copyText(text)
  ElMessage[ok ? 'success' : 'error'](ok ? '已复制' : '复制失败')
}

onMounted(async () => {
  const [m] = await Promise.all([api.get('/alerts/meta'), loadMe()])
  meta.value = m.data
  try {
    const { data } = await api.get('/networks')
    networks.value = data.items
  } catch {
    networks.value = []
  }
  await refresh()
})
</script>

<template>
  <div class="xw-page">
    <div class="xw-page-head">
      <div>
        <div class="xw-page-title">告警中心</div>
        <div class="xw-page-desc">
          设备离线、密钥到期、配额超限等异常将按规则主动推送到你配置的通知渠道
        </div>
      </div>
      <div class="xw-toolbar">
        <el-button :loading="scanning" :disabled="!canManage" @click="runScan">
          <el-icon style="margin-right: 4px"><Refresh /></el-icon>立即扫描
        </el-button>
        <el-button
          type="primary"
          :disabled="!canManage || !summary.unacked"
          @click="ackAll"
        >
          <el-icon style="margin-right: 4px"><Select /></el-icon>
          全部确认<template v-if="summary.unacked">（{{ summary.unacked }}）</template>
        </el-button>
      </div>
    </div>

    <!-- 触发中的严重告警横幅 -->
    <el-alert
      v-if="summary.critical > 0"
      type="error"
      show-icon
      :closable="false"
      style="margin-bottom: 14px"
      :title="`当前有 ${summary.critical} 条严重告警处于触发状态`"
      description="请前往下方「告警事件」查看详情并处理；处理完成后系统会在条件消失时自动发送恢复通知。"
    />
    <el-alert
      v-else-if="summary.channelFailed > 0"
      type="warning"
      show-icon
      :closable="false"
      style="margin-bottom: 14px"
      :title="`有 ${summary.channelFailed} 个通知渠道最近一次投递失败`"
      description="通知渠道本身故障会导致告警静默失效，请到「通知渠道」标签页点击测试排查。"
    />

    <div class="xw-stat-grid">
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><Bell /></el-icon>触发中</div>
        <div class="xw-stat-value" :class="{ 'is-danger': summary.firing > 0 }">
          {{ summary.firing }}<small>条</small>
        </div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><WarnTriangleFilled /></el-icon>严重</div>
        <div class="xw-stat-value" :class="{ 'is-danger': summary.critical > 0 }">
          {{ summary.critical }}<small>条</small>
        </div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><BellFilled /></el-icon>未确认</div>
        <div class="xw-stat-value">{{ summary.unacked }}<small>条</small></div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><CircleCheck /></el-icon>24h 已恢复</div>
        <div class="xw-stat-value">{{ summary.resolved24h }}<small>条</small></div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><Connection /></el-icon>通知渠道</div>
        <div class="xw-stat-value">
          {{ summary.channelEnabled }}<small>/ {{ summary.channelTotal }}</small>
        </div>
      </div>
      <div class="xw-stat">
        <div class="xw-stat-label"><el-icon><SetUp /></el-icon>启用规则</div>
        <div class="xw-stat-value">{{ summary.ruleEnabled }}<small>/ {{ summary.ruleTotal }}</small></div>
      </div>
    </div>

    <el-tabs v-model="tab" class="xw-tabs">
      <!-- ------------------------------ 事件 ------------------------------ -->
      <el-tab-pane :label="`告警事件（${summary.firing}）`" name="events">
        <div class="xw-card">
          <div class="xw-toolbar" style="margin-bottom: 12px">
            <el-select v-model="eventQuery.status" placeholder="全部状态" clearable style="width: 130px" @change="eventQuery.page = 1; loadEvents()">
              <el-option label="触发中" value="firing" />
              <el-option label="已恢复" value="resolved" />
            </el-select>
            <el-select v-model="eventQuery.level" placeholder="全部级别" clearable style="width: 130px" @change="eventQuery.page = 1; loadEvents()">
              <el-option v-for="l in meta.levels" :key="l" :label="LEVEL_META[l]?.text || l" :value="l" />
            </el-select>
            <el-select v-model="eventQuery.eventType" placeholder="全部类型" clearable style="width: 160px" @change="eventQuery.page = 1; loadEvents()">
              <el-option v-for="t in meta.eventTypes" :key="t.key" :label="t.label" :value="t.key" />
            </el-select>
            <el-input
              v-model="eventQuery.keyword"
              placeholder="搜索设备名 / 说明"
              clearable
              style="width: 220px"
              @keyup.enter="eventQuery.page = 1; loadEvents()"
            />
            <el-button @click="eventQuery.page = 1; loadEvents()">查询</el-button>
            <el-button text @click="resetFilters">重置</el-button>
          </div>

          <el-table :data="events" v-loading="loadingEvents" size="small" border stripe>
            <el-table-column label="状态" width="86">
              <template #default="{ row }">
                <el-tag :type="EVENT_STATE[row.status]?.type" size="small" effect="dark">
                  {{ EVENT_STATE[row.status]?.text || row.status }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="级别" width="76">
              <template #default="{ row }">
                <el-tag :type="LEVEL_META[row.level]?.type" size="small">
                  {{ LEVEL_META[row.level]?.text || row.level }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="eventLabel" label="类型" width="104" />
            <el-table-column label="对象" width="140" show-overflow-tooltip>
              <template #default="{ row }">{{ row.targetName || row.targetId || '—' }}</template>
            </el-table-column>
            <el-table-column prop="message" label="说明" min-width="300" show-overflow-tooltip />
            <el-table-column label="规则" width="140" show-overflow-tooltip>
              <template #default="{ row }">{{ row.ruleName || '—' }}</template>
            </el-table-column>
            <el-table-column label="通知" width="90" align="center">
              <template #default="{ row }">
                <el-tooltip
                  v-if="row.deliveryTotal"
                  :content="`已投递 ${row.deliveryOk}/${row.deliveryTotal} 个渠道`"
                >
                  <el-tag
                    size="small"
                    :type="row.deliveryOk === row.deliveryTotal ? 'success' : 'danger'"
                    effect="plain"
                  >
                    {{ row.deliveryOk }}/{{ row.deliveryTotal }}
                  </el-tag>
                </el-tooltip>
                <span v-else class="xw-dim">—</span>
              </template>
            </el-table-column>
            <el-table-column label="确认" width="90" align="center">
              <template #default="{ row }">
                <el-tag v-if="row.acknowledged" type="info" size="small" effect="plain">
                  {{ row.ackBy || '已确认' }}
                </el-tag>
                <span v-else class="xw-dim">—</span>
              </template>
            </el-table-column>
            <el-table-column label="时间" width="122">
              <template #default="{ row }">
                <el-tooltip :content="formatTime(row.firedAt)">
                  <span>{{ fromNow(row.firedAt) }}</span>
                </el-tooltip>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="150" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="openDetail(row)">详情</el-button>
                <el-button link size="small" @click="copyEvent(row)">复制</el-button>
                <el-button
                  v-if="row.status === 'firing' && !row.acknowledged"
                  link
                  type="warning"
                  size="small"
                  :disabled="!canManage"
                  @click="ackEvent(row)"
                >
                  确认
                </el-button>
              </template>
            </el-table-column>
            <template #empty>
              <div class="xw-empty">
                暂无告警记录。系统每 60 秒自动巡检一次，也可点右上角「立即扫描」手动触发。
              </div>
            </template>
          </el-table>

          <el-pagination
            v-if="eventTotal > eventQuery.size"
            style="margin-top: 12px; justify-content: flex-end"
            layout="total, prev, pager, next"
            :total="eventTotal"
            :page-size="eventQuery.size"
            :current-page="eventQuery.page"
            @current-change="(p) => { eventQuery.page = p; loadEvents() }"
          />
        </div>
      </el-tab-pane>

      <!-- ------------------------------ 规则 ------------------------------ -->
      <el-tab-pane :label="`告警规则（${summary.ruleTotal}）`" name="rules">
        <div class="xw-card">
          <div class="xw-card-head">
            <div>
              <div class="xw-strong">告警规则</div>
              <div class="xw-hint">
                规则决定「什么情况要通知」。同一目标的告警在恢复前不会重复推送，恢复后会发一次恢复通知。
              </div>
            </div>
            <el-button type="primary" size="small" :disabled="!canManage" @click="openRuleCreate">
              <el-icon style="margin-right: 4px"><Plus /></el-icon>新建规则
            </el-button>
          </div>

          <el-table :data="rules" size="small" border stripe>
            <el-table-column prop="name" label="规则名称" min-width="150" show-overflow-tooltip />
            <el-table-column prop="eventLabel" label="事件类型" width="118" />
            <el-table-column label="阈值" width="118">
              <template #default="{ row }">
                <span class="xw-mono">{{ row.threshold }}{{ row.unit }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="networkName" label="作用范围" width="130" show-overflow-tooltip />
            <el-table-column label="级别" width="76">
              <template #default="{ row }">
                <el-tag :type="LEVEL_META[row.level]?.type" size="small">
                  {{ LEVEL_META[row.level]?.text || row.level }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="通知渠道" min-width="170">
              <template #default="{ row }">
                <el-tag v-for="n in row.channelNames" :key="n" size="small" effect="plain" style="margin-right: 4px">
                  {{ n }}
                </el-tag>
                <span v-if="!row.channelNames.length" class="xw-dim">未关联渠道</span>
              </template>
            </el-table-column>
            <el-table-column label="静默期" width="90" align="center">
              <template #default="{ row }">
                <span class="xw-mono">{{ row.silenceMinutes }}分</span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="86" align="center">
              <template #default="{ row }">
                <el-switch
                  :model-value="row.enabled"
                  size="small"
                  :disabled="!canManage"
                  @change="toggleRule(row)"
                />
              </template>
            </el-table-column>
            <el-table-column label="操作" width="118" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" size="small" :disabled="!canManage" @click="openRuleEdit(row)">
                  编辑
                </el-button>
                <el-button link type="danger" size="small" :disabled="!canManage" @click="removeRule(row)">
                  删除
                </el-button>
              </template>
            </el-table-column>
            <template #empty>
              <div class="xw-empty">还没有告警规则。点「新建规则」配置第一条，例如「设备离线超过 10 分钟」。 </div>
            </template>
          </el-table>
        </div>
      </el-tab-pane>

      <!-- ------------------------------ 渠道 ------------------------------ -->
      <el-tab-pane :label="`通知渠道（${summary.channelTotal}）`" name="channels">
        <div class="xw-card">
          <div class="xw-card-head">
            <div>
              <div class="xw-strong">通知渠道</div>
              <div class="xw-hint">
                支持通用 Webhook、企业微信机器人、钉钉机器人与邮件。建议创建后先点「测试」确认能收到。
              </div>
            </div>
            <el-button type="primary" size="small" :disabled="!canManage" @click="openChannelCreate">
              <el-icon style="margin-right: 4px"><Plus /></el-icon>新建渠道
            </el-button>
          </div>

          <el-table :data="channels" size="small" border stripe>
            <el-table-column prop="name" label="渠道名称" min-width="150" show-overflow-tooltip />
            <el-table-column prop="typeLabel" label="类型" width="140" />
            <el-table-column label="最近测试" width="126">
              <template #default="{ row }">
                {{ row.lastTestAt ? formatShortTime(row.lastTestAt) : '—' }}
              </template>
            </el-table-column>
            <el-table-column label="最近投递" width="110">
              <template #default="{ row }">
                <el-tag v-if="row.lastStatus === 'ok'" type="success" size="small">成功</el-tag>
                <el-tooltip v-else-if="row.lastStatus === 'failed'" :content="row.lastError">
                  <el-tag type="danger" size="small">失败</el-tag>
                </el-tooltip>
                <span v-else class="xw-dim">未投递</span>
              </template>
            </el-table-column>
            <el-table-column label="失败原因" min-width="200" show-overflow-tooltip>
              <template #default="{ row }">
                <span :class="{ 'xw-dim': !row.lastError }">{{ row.lastError || '—' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="86" align="center">
              <template #default="{ row }">
                <el-tag :type="row.enabled ? 'success' : 'info'" size="small" effect="plain">
                  {{ row.enabled ? '启用' : '停用' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="178" fixed="right">
              <template #default="{ row }">
                <el-button
                  link
                  type="primary"
                  size="small"
                  :loading="testingId === row.id"
                  :disabled="!canManage"
                  @click="testChannel(row)"
                >
                  测试
                </el-button>
                <el-button link type="primary" size="small" :disabled="!canManage" @click="openChannelEdit(row)">
                  编辑
                </el-button>
                <el-button link type="danger" size="small" :disabled="!canManage" @click="removeChannel(row)">
                  删除
                </el-button>
              </template>
            </el-table-column>
            <template #empty>
              <div class="xw-empty">
                还没有通知渠道。先建一个渠道（如企业微信群机器人），再建规则把告警指向它。
              </div>
            </template>
          </el-table>
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- ------------------------------ 事件详情 ------------------------------ -->
    <el-dialog v-model="detailVisible" title="告警详情" width="680px">
      <template v-if="detailEvent">
        <div class="xw-kv">
          <div class="xw-kv-item">
            <div class="xw-kv-label">状态</div>
            <div class="xw-kv-value">
              <el-tag :type="EVENT_STATE[detailEvent.status]?.type" size="small" effect="dark">
                {{ EVENT_STATE[detailEvent.status]?.text }}
              </el-tag>
            </div>
          </div>
          <div class="xw-kv-item">
            <div class="xw-kv-label">级别</div>
            <div class="xw-kv-value">
              <el-tag :type="LEVEL_META[detailEvent.level]?.type" size="small">
                {{ LEVEL_META[detailEvent.level]?.text }}
              </el-tag>
            </div>
          </div>
          <div class="xw-kv-item">
            <div class="xw-kv-label">事件类型</div>
            <div class="xw-kv-value">{{ detailEvent.eventLabel }}</div>
          </div>
          <div class="xw-kv-item">
            <div class="xw-kv-label">告警对象</div>
            <div class="xw-kv-value">{{ detailEvent.targetName || detailEvent.targetId }}</div>
          </div>
          <div class="xw-kv-item">
            <div class="xw-kv-label">触发规则</div>
            <div class="xw-kv-value">{{ detailEvent.ruleName || '—' }}</div>
          </div>
          <div class="xw-kv-item">
            <div class="xw-kv-label">确认人</div>
            <div class="xw-kv-value">{{ detailEvent.ackBy || '未确认' }}</div>
          </div>
          <div class="xw-kv-item">
            <div class="xw-kv-label">触发时间</div>
            <div class="xw-kv-value">{{ formatTime(detailEvent.firedAt) }}</div>
          </div>
          <div class="xw-kv-item">
            <div class="xw-kv-label">恢复时间</div>
            <div class="xw-kv-value">{{ formatTime(detailEvent.resolvedAt) }}</div>
          </div>
        </div>

        <div style="margin: 14px 0 6px" class="xw-strong">说明</div>
        <div class="xw-hint" style="line-height: 1.7">{{ detailEvent.message }}</div>

        <div style="margin: 16px 0 6px" class="xw-strong">
          通知投递（{{ detailEvent.deliveries?.length || 0 }} 个渠道）
        </div>
        <el-table v-if="detailEvent.deliveries?.length" :data="detailEvent.deliveries" size="small" border>
          <el-table-column prop="channelName" label="渠道" min-width="130" />
          <el-table-column prop="type" label="类型" width="100" />
          <el-table-column label="结果" width="86">
            <template #default="{ row }">
              <el-tag :type="row.ok ? 'success' : 'danger'" size="small">
                {{ row.ok ? '成功' : '失败' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="尝试" width="72" align="center">
            <template #default="{ row }">
              <span :class="{ 'xw-dim': (row.attempts || 1) <= 1 }">{{ row.attempts || 1 }} 次</span>
            </template>
          </el-table-column>
          <el-table-column label="说明" min-width="180" show-overflow-tooltip>
            <template #default="{ row }">
              <span :class="{ 'xw-dim': !row.error }">{{ row.error || row.detail || '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="时间" width="120">
            <template #default="{ row }">{{ formatShortTime(row.at) }}</template>
          </el-table-column>
        </el-table>
        <div v-else class="xw-hint">该规则未关联通知渠道，仅记录在告警中心。</div>
      </template>
      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button
          v-if="detailEvent?.status === 'firing' && !detailEvent?.acknowledged"
          type="primary"
          :disabled="!canManage"
          @click="ackEvent(detailEvent); detailVisible = false"
        >
          确认已处理
        </el-button>
      </template>
    </el-dialog>

    <!-- ------------------------------ 渠道编辑 ------------------------------ -->
    <el-dialog
      v-model="channelVisible"
      :title="channelEditing ? '编辑通知渠道' : '新建通知渠道'"
      width="620px"
    >
      <el-form label-width="158px" size="default">
        <el-form-item label="渠道名称" required>
          <el-input v-model="channelForm.name" placeholder="例如：运维群机器人" />
        </el-form-item>
        <el-form-item label="渠道类型" required>
          <el-select v-model="channelForm.type" style="width: 100%" :disabled="!!channelEditing">
            <el-option v-for="t in meta.channelTypes" :key="t.key" :label="t.label" :value="t.key" />
          </el-select>
        </el-form-item>

        <div class="xw-hint" style="margin: 0 0 12px 158px">
          {{ channelTypeMeta(channelForm.type).hint }}
        </div>

        <el-form-item
          v-for="f in channelTypeMeta(channelForm.type).fields"
          :key="f.key"
          :label="f.label"
          :required="!!f.required"
        >
          <el-switch
            v-if="f.type === 'boolean'"
            v-model="channelForm.config[f.key]"
          />
          <el-input
            v-else
            v-model="channelForm.config[f.key]"
            :placeholder="f.placeholder"
            :type="f.secret || f.key === 'pass' ? 'password' : 'text'"
            :show-password="f.secret || f.key === 'pass'"
            :autocomplete="f.secret || f.key === 'pass' ? 'new-password' : 'off'"
          />
          <div v-if="f.key === 'to' || f.key === 'url'" class="xw-hint" style="margin-top: 4px">
            {{ f.key === 'to' ? '支持多个收件人，用英文逗号分隔' : '' }}
          </div>
        </el-form-item>

        <el-form-item label="启用">
          <el-switch v-model="channelForm.enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="channelVisible = false">取消</el-button>
        <el-button type="primary" @click="saveChannel">保存</el-button>
      </template>
    </el-dialog>

    <!-- ------------------------------ 规则编辑 ------------------------------ -->
    <el-dialog
      v-model="ruleVisible"
      :title="ruleEditing ? '编辑告警规则' : '新建告警规则'"
      width="620px"
    >
      <el-form label-width="112px" size="default">
        <el-form-item label="规则名称" required>
          <el-input v-model="ruleForm.name" placeholder="例如：门店设备离线告警" />
        </el-form-item>
        <el-form-item label="事件类型" required>
          <el-select v-model="ruleForm.eventType" style="width: 100%" @change="onEventTypeChange">
            <el-option v-for="t in meta.eventTypes" :key="t.key" :label="t.label" :value="t.key" />
          </el-select>
        </el-form-item>
        <div class="xw-hint" style="margin: 0 0 12px 112px">{{ currentEventMeta.hint }}</div>

        <el-form-item :label="`阈值（${currentEventMeta.unit}）`" required>
          <el-input-number
            v-model="ruleForm.threshold"
            :min="currentEventMeta.min || 1"
            :max="currentEventMeta.max || 100000"
            style="width: 220px"
          />
        </el-form-item>

        <el-form-item label="作用范围">
          <el-select v-model="ruleForm.networkId" clearable placeholder="全部网络" style="width: 100%">
            <el-option v-for="n in networks" :key="n.id" :label="n.name" :value="n.id" />
          </el-select>
        </el-form-item>

        <el-form-item label="告警级别">
          <el-select v-model="ruleForm.level" style="width: 220px">
            <el-option v-for="l in meta.levels" :key="l" :label="LEVEL_META[l]?.text || l" :value="l" />
          </el-select>
        </el-form-item>

        <el-form-item label="通知渠道" required>
          <el-select v-model="ruleForm.channelIds" multiple style="width: 100%" placeholder="选择要接收告警的渠道">
            <el-option v-for="c in channels" :key="c.id" :label="`${c.name}（${c.typeLabel}）`" :value="c.id" />
          </el-select>
          <div v-if="!channels.length" class="xw-hint" style="margin-top: 4px">
            还没有通知渠道，请先到「通知渠道」标签页创建一个。
          </div>
        </el-form-item>

        <el-form-item label="静默期（分钟）">
          <el-input-number v-model="ruleForm.silenceMinutes" :min="0" :max="10080" style="width: 220px" />
          <div class="xw-hint" style="margin-top: 4px">
            同一目标恢复后，在静默期内再次异常不会重复告警，用于抑制网络抖动导致的刷屏。
          </div>
        </el-form-item>

        <el-form-item label="启用">
          <el-switch v-model="ruleForm.enabled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="ruleVisible = false">取消</el-button>
        <el-button type="primary" @click="saveRule">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.xw-stat-value.is-danger {
  color: #dc2626;
}
</style>

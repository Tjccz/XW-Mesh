<script setup>
import { computed } from 'vue'
import { formatBytes } from '../format.js'

const props = defineProps({
  buckets: { type: Array, default: () => [] },
  height: { type: Number, default: 190 },
  showReceiving: { type: Boolean, default: true },
})

const max = computed(() => {
  const values = props.buckets.flatMap((b) => [b.rx || 0, b.tx || 0])
  return Math.max(1, ...values)
})

const bars = computed(() => {
  const n = props.buckets.length
  const slot = n > 0 ? 100 / n : 100
  return props.buckets.map((b, i) => ({
    label: b.label,
    rx: b.rx || 0,
    tx: b.tx || 0,
    x: i * slot + slot * 0.12,
    rxW: (b.rx || 0) / max.value,
    txW: (b.tx || 0) / max.value,
    slot,
    total: (b.rx || 0) + (b.tx || 0),
  }))
})

const ticks = computed(() => {
  const step = max.value / 2
  return [max.value, step, 0].map((v) => ({ value: v, text: formatBytes(v, 0) }))
})
</script>

<template>
  <div class="chart-wrap" :style="{ height: height + 'px' }">
    <div v-if="!buckets.length" class="chart-empty">所选时间段内暂无流量采样</div>

    <template v-else>
      <div class="chart-axis">
        <span v-for="t in ticks" :key="t.text">{{ t.text }}</span>
      </div>

      <svg class="chart-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        <line v-for="y in [0, 50, 99.5]" :key="y" x1="0" :y1="y" x2="100" :y2="y" class="grid" />
        <g v-for="b in bars" :key="b.label">
          <rect
            :x="b.x"
            :y="100 - b.rxW * 96"
            :width="b.slot * (showReceiving ? 0.34 : 0.68)"
            :height="Math.max(b.rxW * 96, b.rx ? 0.5 : 0)"
            class="bar-rx"
          >
            <title>{{ b.label }} 接收 {{ formatBytes(b.rx) }}</title>
          </rect>
          <rect
            :x="b.x + b.slot * (showReceiving ? 0.4 : 0)"
            :y="100 - b.txW * 96"
            :width="b.slot * (showReceiving ? 0.34 : 0.68)"
            :height="Math.max(b.txW * 96, b.tx ? 0.5 : 0)"
            class="bar-tx"
          >
            <title>{{ b.label }} 发送 {{ formatBytes(b.tx) }}</title>
          </rect>
        </g>
      </svg>

      <div class="chart-legend">
        <span><i class="dot dot-rx"></i>接收</span>
        <span><i class="dot dot-tx"></i>发送</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.chart-wrap {
  position: relative;
  width: 100%;
  padding: 6px 0 22px;
}

.chart-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #9ca3af;
  font-size: 13px;
}

.chart-axis {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: space-between;
  font-size: 10.5px;
  color: #b6bcc2;
  pointer-events: none;
}

.chart-svg {
  width: 100%;
  height: 100%;
  display: block;
  overflow: visible;
}

.grid {
  stroke: #eef2f3;
  stroke-width: 0.4;
  vector-effect: non-scaling-stroke;
}

.bar-rx {
  fill: #0d9488;
}

.bar-tx {
  fill: #7cc9c2;
}

.chart-legend {
  position: absolute;
  right: 0;
  bottom: -4px;
  display: flex;
  gap: 14px;
  font-size: 11.5px;
  color: #6b7280;
}

.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 2px;
  margin-right: 5px;
}

.dot-rx {
  background: #0d9488;
}

.dot-tx {
  background: #7cc9c2;
}
</style>

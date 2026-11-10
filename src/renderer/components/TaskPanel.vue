<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { BulkAction, TaskStatus, TransferTask } from '@shared/types'
import { displayBytes, formatClock, formatDateTime, formatEta, formatSpeed } from '@shared/format'
import { api } from '../api'

const props = defineProps<{ tasks: TransferTask[] }>()
const emit = defineEmits<{ refresh: []; notify: [message: string]; collapse: [] }>()

const STATUS_LABELS: Record<TaskStatus, string> = {
  queued: '排队中',
  running: '传输中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
}

const busy = ref(false)
const clearMenuOpen = ref(false)
const confirmClearAll = ref(false)
const narrow = ref(false)
const smoothSpeeds = ref<Record<string, number>>({})
let narrowQuery: MediaQueryList | null = null
const onNarrowChange = (e: MediaQueryListEvent): void => {
  narrow.value = e.matches
}

const activeCount = computed(
  () => props.tasks.filter((t) => t.status === 'running' || t.status === 'queued').length,
)
const finishedCount = computed(() =>
  props.tasks.filter((t) => ['completed', 'failed', 'canceled'].includes(t.status)).length,
)
const pausedCount = computed(() => props.tasks.filter((t) => t.status === 'paused').length)

/** 速度是 3 秒滑动窗口，直接算 ETA 会每 200ms 乱跳；先做指数平滑再派生。 */
watch(
  () => props.tasks,
  (list) => {
    const next: Record<string, number> = {}
    for (const task of list) {
      const prev = smoothSpeeds.value[task.id] ?? 0
      const target = task.status === 'running' ? task.speed : 0
      next[task.id] = target > 0 ? prev * 0.7 + target * 0.3 : prev * 0.5
    }
    smoothSpeeds.value = next
  },
  { deep: true, immediate: true },
)

function nameOf(task: TransferTask): string {
  const p = task.direction === 'download' ? task.remotePath : task.localPath
  return p.split(/[\\/]/).pop() || p
}

function directionLabel(task: TransferTask): string {
  return task.direction === 'download' ? '下载' : '上传'
}

function percent(task: TransferTask): number {
  if (!task.size) return 0
  return Math.min(100, Math.round((task.transferred / task.size) * 100))
}

function etaSeconds(task: TransferTask): number {
  if (task.status !== 'running' || !task.size) return 0
  const speed = smoothSpeeds.value[task.id] ?? 0
  if (speed < 1) return 0
  return Math.max(0, (task.size - task.transferred) / speed)
}

function etaText(task: TransferTask): string {
  const seconds = etaSeconds(task)
  return seconds > 0 ? `剩余 ${formatEta(seconds)}` : ''
}

function etaClock(task: TransferTask): string {
  const seconds = etaSeconds(task)
  return seconds > 0 ? `预计 ${formatClock(Date.now() + seconds * 1000)} 完成` : ''
}

async function action(task: TransferTask, kind: 'pause' | 'resume' | 'cancel' | 'remove'): Promise<void> {
  try {
    if (kind === 'remove') await api.removeTask(task.id)
    else await api.taskAction(task.id, kind)
    emit('refresh')
  } catch (err) {
    emit('notify', err instanceof Error ? err.message : String(err))
  }
}

/** 四个批量动作共用一个 API：一次请求、一次广播、一次落盘。 */
async function bulk(kind: BulkAction, label: string): Promise<void> {
  clearMenuOpen.value = false
  busy.value = true
  try {
    const result = await api.bulkTasks(kind)
    emit('notify', `${label}：已处理 ${result.affected} 个任务`)
    emit('refresh')
  } catch (err) {
    emit('notify', err instanceof Error ? err.message : String(err))
  } finally {
    busy.value = false
  }
}

async function clearFinished(): Promise<void> {
  await bulk('clear-finished', '清除已完成')
}

function openClearAllConfirm(): void {
  clearMenuOpen.value = false
  confirmClearAll.value = true
}

async function doClearAll(): Promise<void> {
  confirmClearAll.value = false
  await bulk('clear-all', '清除全部')
}

onMounted(() => {
  narrowQuery = window.matchMedia?.('(max-width: 900px)') ?? null
  narrow.value = Boolean(narrowQuery?.matches)
  narrowQuery?.addEventListener?.('change', onNarrowChange)
})
onBeforeUnmount(() => narrowQuery?.removeEventListener?.('change', onNarrowChange))
</script>

<template>
  <div class="panel-head">
    <h2>传输队列</h2>
    <span class="sub">并发 3 · 断点续传 · {{ activeCount }} 个进行中</span>
    <div class="spacer"></div>

    <!-- 桌面：全部暂停 / 全部开始 / 清除 ▾ -->
    <div v-if="!narrow" class="queue-actions">
      <button class="btn small" :disabled="busy || !activeCount" @click="bulk('pause-all', '全部暂停')">全部暂停</button>
      <button class="btn small" :disabled="busy || !pausedCount" @click="bulk('resume-all', '全部开始')">全部开始</button>
      <div class="clear-menu">
        <button class="btn small" :disabled="busy" @click="clearMenuOpen = !clearMenuOpen">清除 ▾</button>
        <div v-if="clearMenuOpen" class="clear-pop">
          <button class="btn small" :disabled="!finishedCount" @click="clearFinished">
            清除已完成 ({{ finishedCount }})
          </button>
          <button class="btn small danger" :disabled="!tasks.length" @click="openClearAllConfirm">
            清除全部 ({{ tasks.length }})
          </button>
        </div>
      </div>
    </div>

    <!-- 窄屏：批量动作收进菜单 -->
    <details class="queue-more clear-menu">
      <summary class="btn small">批量操作 ▾</summary>
      <div class="clear-pop">
        <button class="btn small" :disabled="busy || !activeCount" @click="bulk('pause-all', '全部暂停')">全部暂停</button>
        <button class="btn small" :disabled="busy || !pausedCount" @click="bulk('resume-all', '全部开始')">全部开始</button>
        <button class="btn small" :disabled="!finishedCount" @click="clearFinished">清除已完成</button>
        <button class="btn small danger" @click="confirmClearAll = true">清除全部</button>
      </div>
    </details>

    <button class="btn small ghost collapse-btn" title="收起传输队列" aria-label="收起传输队列" @click="emit('collapse')">∨</button>
  </div>

  <div class="panel-body" style="padding: 0; overflow: auto">
    <div v-if="tasks.length" class="task-head">
      <span>名称</span>
      <span>传输类型</span>
      <span>进度</span>
      <span>速度</span>
      <span>状态</span>
      <span>操作</span>
    </div>
    <div v-if="!tasks.length" class="empty">
      暂无任务。选择远程文件点「↓ 下载」，或选择本地文件点「↑ 上传」即可加入队列。
    </div>
    <div v-for="task in tasks" :key="task.id" class="task-row">
      <div class="task-name">
        <span>{{ nameOf(task) }}</span>
        <small>{{ task.remotePath }}</small>
        <div class="task-sub">
          <span>创建 {{ formatDateTime(task.createdAt) }}</span>
          <span class="dir-inline dir-badge" :class="task.direction">
            {{ task.direction === 'download' ? '↓' : '↑' }} {{ directionLabel(task) }}
          </span>
          <span v-if="etaText(task)"><b>{{ etaText(task) }}</b> · {{ etaClock(task) }}</span>
        </div>
        <small v-if="task.error" style="color: var(--danger)">{{ task.error }}</small>
      </div>

      <div class="task-direction">
        <span class="dir-badge" :class="task.direction">
          {{ task.direction === 'download' ? '↓' : '↑' }} {{ directionLabel(task) }}
        </span>
      </div>

      <div class="progress-wrap">
        <div class="progress">
          <i :class="{ done: task.status === 'completed' }" :style="{ width: `${percent(task)}%` }"></i>
        </div>
        <div class="hint" style="margin-top: 4px">
          {{ percent(task) }}% · {{ displayBytes(task.transferred) }} / {{ displayBytes(task.size) }}
        </div>
      </div>

      <div class="hint">{{ task.status === 'running' ? formatSpeed(task.speed) : '-' }}</div>

      <div><span class="status" :class="task.status">{{ STATUS_LABELS[task.status] }}</span></div>

      <div class="actions" style="display: flex; gap: 4px; justify-content: flex-end">
        <button
          v-if="task.status === 'running' || task.status === 'queued'"
          class="btn small"
          @click="action(task, 'pause')"
        >暂停</button>
        <button
          v-else-if="['paused', 'failed', 'canceled'].includes(task.status)"
          class="btn small"
          @click="action(task, 'resume')"
        >继续</button>
        <button
          v-if="task.status !== 'completed'"
          class="btn small danger"
          @click="action(task, 'cancel')"
        >取消</button>
        <button class="btn small ghost" @click="action(task, 'remove')">移除</button>
      </div>
    </div>
  </div>

  <!-- 清除全部：真清空需二次确认，并列出将受影响的任务数 -->
  <Teleport to="body">
    <div v-if="confirmClearAll" class="modal-backdrop" @click.self="confirmClearAll = false">
      <div class="modal-card" role="dialog" aria-modal="true" style="width: min(420px, 100%)">
        <div class="panel-head">
          <h2>确认清除全部任务</h2>
          <div class="spacer"></div>
          <button class="btn small ghost" @click="confirmClearAll = false">✕</button>
        </div>
        <div class="panel-body">
          <p style="margin: 0 0 12px; font-size: 13px; line-height: 1.7">
            将移除 <b>{{ tasks.length }}</b> 条队列记录，其中
            <b>{{ activeCount }}</b> 个正在传输的任务会被中止，并删除已下载的 <code>.part</code> 临时文件。
            已完成任务的成品文件<b>不会</b>被删除。此操作不可撤销。
          </p>
          <div class="modal-footer">
            <button class="btn" @click="confirmClearAll = false">取消</button>
            <button class="btn danger" :disabled="busy" @click="doClearAll">确认清除全部</button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

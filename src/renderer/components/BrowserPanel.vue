<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { ConnectionView, RemoteEntry, TransferTask } from '@shared/types'
import { displayBytes, entryTypeLabel, formatDateTime } from '@shared/format'
import { api } from '../api'
import { connectionIdentityKey, nextRemotePath } from '../browser-path'
import {
  ALL_COLUMNS,
  BROWSER_LIMITS,
  COLUMN_LABELS,
  DEFAULT_COLUMN_WIDTHS,
  DEFAULT_VISIBLE_COLUMNS,
  SORTABLE_COLUMNS,
  clampBrowserRatio,
  clampColumnWidth,
  columnsForNarrow,
  fitColumnWidths,
  gridTemplateColumns,
  leftPaneWidth,
  loadBrowserPrefs,
  saveBrowserPrefs,
  type ColumnKey,
} from '../browser-layout'

type Side = 'local' | 'remote'
type SortKey = 'name' | 'size' | 'createdAt' | 'modifiedAt' | 'type'
interface SortState { key: SortKey; asc: boolean }
interface Box { x1: number; y1: number; x2: number; y2: number }

const props = defineProps<{
  connection: ConnectionView | null
  isDesktop: boolean
  downloadsDir: string
}>()
const emit = defineEmits<{
  notify: [message: string]
  'tasks-added': [tasks: TransferTask[]]
}>()

const localPath = ref(props.downloadsDir || '/')
const remotePath = ref('/')
const localEntries = ref<RemoteEntry[]>([])
const remoteEntries = ref<RemoteEntry[]>([])
const selectedLocal = ref<Set<string>>(new Set())
const selectedRemote = ref<Set<string>>(new Set())
const anchorLocal = ref('')
const anchorRemote = ref('')
const sortLocal = ref<SortState>({ key: 'name', asc: true })
const sortRemote = ref<SortState>({ key: 'name', asc: true })
const scanning = ref(false)
const remoteError = ref('')
const marquee = ref<Box | null>(null)
const isTouch = ref(false)
let scanController: AbortController | null = null
let suppressClick = false
let dragCleanup: (() => void) | null = null
const coarseQuery: MediaQueryList | null = window.matchMedia?.('(pointer: coarse)') ?? null

/* ---------- 浏览区内部布局：左右分栏比例 / 列显隐 / 列宽 ---------- */
const prefs = reactive(loadBrowserPrefs())
const browserEl = ref<HTMLElement | null>(null)
const browserWidth = ref(0)
const columnsMenuEl = ref<HTMLElement | null>(null)
const columnsMenuOpen = ref(false)
const isNarrow = ref(false)
const dragging = ref<'panes' | ColumnKey | null>(null)
let narrowQuery: MediaQueryList | null = null
let resizeObserver: ResizeObserver | null = null
let resizeCleanup: (() => void) | null = null
let outsideHandler: ((e: PointerEvent) => void) | null = null

const onNarrowChange = (e: MediaQueryListEvent): void => {
  isNarrow.value = e.matches
}
function updateBrowserWidth(): void {
  browserWidth.value = browserEl.value?.clientWidth ?? 0
}

const visibleColumns = computed(() => columnsForNarrow(prefs.visibleColumns, isNarrow.value))
const columnDefs = computed(() =>
  visibleColumns.value.map((key) => ({
    key,
    label: COLUMN_LABELS[key],
    sortable: SORTABLE_COLUMNS.includes(key),
    resizable: key !== 'name' && !isNarrow.value,
  })),
)
const gridTemplate = computed(() =>
  gridTemplateColumns(
    visibleColumns.value,
    fitColumnWidths(visibleColumns.value, prefs.columnWidths, narrowestPaneWidth()),
  ),
)
const leftPaneStyle = computed(() => ({
  '--cols': gridTemplate.value,
  ...(isNarrow.value || browserWidth.value <= 0
    ? {}
    : { width: `${leftPaneWidth(prefs.browserRatio, browserWidth.value)}px`, flex: '0 0 auto' }),
}))
const rightPaneStyle = computed(() => ({ '--cols': gridTemplate.value }))

function persistBrowser(): void {
  saveBrowserPrefs({
    browserRatio: prefs.browserRatio,
    columnWidths: { ...prefs.columnWidths },
    visibleColumns: [...prefs.visibleColumns],
  })
}

/** 列宽按「较窄那一栏」收敛，保证两侧表头与行都不会各自横向滚动。 */
function narrowestPaneWidth(): number {
  if (isNarrow.value || browserWidth.value <= 0) return browserWidth.value
  const usable = Math.max(0, browserWidth.value - BROWSER_LIMITS.splitter)
  const left = usable * clampBrowserRatio(prefs.browserRatio, browserWidth.value)
  return Math.round(Math.min(left, usable - left))
}

function toggleColumn(key: ColumnKey): void {
  if (key === 'name') return
  const next = new Set(prefs.visibleColumns)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  prefs.visibleColumns = ALL_COLUMNS.filter((c) => next.has(c))
  // 排序键被隐藏时回到文件名升序，避免用户看不见当前按什么排
  if (!prefs.visibleColumns.includes(sortLocal.value.key)) {
    setSortState('local', { key: 'name', asc: true })
  }
  if (!prefs.visibleColumns.includes(sortRemote.value.key)) {
    setSortState('remote', { key: 'name', asc: true })
  }
  persistBrowser()
}

function resetColumns(): void {
  prefs.visibleColumns = [...DEFAULT_VISIBLE_COLUMNS]
  prefs.columnWidths = { ...DEFAULT_COLUMN_WIDTHS }
  persistBrowser()
}

/** 统一挂 pointer 监听：拖拽中禁用选中文本，松手后一次性落盘。 */
function beginResize(onMove: (ev: PointerEvent) => void, done: () => void): void {
  resizeCleanup?.()
  const move = (ev: PointerEvent): void => onMove(ev)
  let up: () => void
  const cleanup = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
    document.body.classList.remove('resizing', 'resizing-col')
    dragging.value = null
    resizeCleanup = null
  }
  up = (): void => {
    cleanup()
    done()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
  document.body.classList.add('resizing', 'resizing-col')
  resizeCleanup = cleanup
}

/** 拖动两栏中间的分隔条：只改比例，窗口变化时自动等比缩放。 */
function startPaneResize(e: PointerEvent): void {
  if (isNarrow.value || e.button !== 0) return
  e.preventDefault()
  const width = browserWidth.value
  const usable = Math.max(1, width - BROWSER_LIMITS.splitter)
  const startX = e.clientX
  const startLeft = usable * clampBrowserRatio(prefs.browserRatio, width)
  dragging.value = 'panes'
  beginResize(
    (ev) => {
      prefs.browserRatio = clampBrowserRatio(
        (startLeft + ev.clientX - startX) / usable,
        width,
      )
    },
    persistBrowser,
  )
}

function onPaneKey(e: KeyboardEvent): void {
  if (isNarrow.value || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
  e.preventDefault()
  const width = browserWidth.value
  const usable = Math.max(1, width - BROWSER_LIMITS.splitter)
  const step = e.shiftKey ? 48 : 16
  const current = leftPaneWidth(prefs.browserRatio, width)
  prefs.browserRatio = clampBrowserRatio(
    (current + (e.key === 'ArrowRight' ? step : -step)) / usable,
    width,
  )
  persistBrowser()
}

function resetPaneSize(): void {
  prefs.browserRatio = 0.5
  persistBrowser()
}

/** 拖动表头右边缘调整列宽；名称列吃掉剩余空间，故不提供手柄。 */
function startColumnResize(key: ColumnKey, e: PointerEvent): void {
  if (isNarrow.value || key === 'name' || e.button !== 0) return
  e.preventDefault()
  e.stopPropagation()
  const startX = e.clientX
  const startWidth = prefs.columnWidths[key]
  dragging.value = key
  beginResize(
    (ev) => {
      prefs.columnWidths[key] = clampColumnWidth(
        key,
        startWidth + ev.clientX - startX,
        prefs.columnWidths,
        visibleColumns.value,
        narrowestPaneWidth(),
      )
    },
    persistBrowser,
  )
}

function onColumnKey(key: ColumnKey, e: KeyboardEvent): void {
  if (isNarrow.value || key === 'name') return
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  const step = e.shiftKey ? 48 : 16
  const desired = prefs.columnWidths[key] + (e.key === 'ArrowRight' ? step : -step)
  prefs.columnWidths[key] = clampColumnWidth(
    key,
    desired,
    prefs.columnWidths,
    visibleColumns.value,
    narrowestPaneWidth(),
  )
  persistBrowser()
}

function resetColumnWidth(key: ColumnKey): void {
  if (key === 'name') return
  prefs.columnWidths[key] = clampColumnWidth(
    key,
    DEFAULT_COLUMN_WIDTHS[key],
    prefs.columnWidths,
    visibleColumns.value,
    narrowestPaneWidth(),
  )
  persistBrowser()
}

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })
const remoteReady = computed(() => props.connection?.state === 'connected')
const marqueeStyle = computed(() => {
  const b = marquee.value
  if (!b) return {}
  return {
    left: `${Math.min(b.x1, b.x2)}px`,
    top: `${Math.min(b.y1, b.y2)}px`,
    width: `${Math.abs(b.x2 - b.x1)}px`,
    height: `${Math.abs(b.y2 - b.y1)}px`,
  }
})

function entriesOf(side: Side): RemoteEntry[] {
  return side === 'local' ? localEntries.value : remoteEntries.value
}
function selectedOf(side: Side): Set<string> {
  return side === 'local' ? selectedLocal.value : selectedRemote.value
}
function setSelected(side: Side, next: Set<string>): void {
  if (side === 'local') selectedLocal.value = next
  else selectedRemote.value = next
}
function anchorOf(side: Side): string {
  return side === 'local' ? anchorLocal.value : anchorRemote.value
}
function setAnchor(side: Side, value: string): void {
  if (side === 'local') anchorLocal.value = value
  else anchorRemote.value = value
}
function sortStateOf(side: Side): SortState {
  return side === 'local' ? sortLocal.value : sortRemote.value
}
function setSortState(side: Side, next: SortState): void {
  if (side === 'local') sortLocal.value = next
  else sortRemote.value = next
}

function sortValue(e: RemoteEntry, key: SortKey): string | number {
  switch (key) {
    case 'name': return e.name
    case 'size': return e.size
    case 'createdAt': return e.createdAt ?? -1
    case 'modifiedAt': return e.modifiedAt ?? -1
    case 'type': return entryTypeLabel(e.name, e.type === 'dir')
  }
}

/** 目录始终置顶；中文用 Intl.Collator 自然排序；默认文件名升序。 */
function sorted(list: RemoteEntry[], state: SortState): RemoteEntry[] {
  return [...list].sort((a, b) => {
    const ad = a.type === 'dir'
    const bd = b.type === 'dir'
    if (ad !== bd) return ad ? -1 : 1
    const av = sortValue(a, state.key)
    const bv = sortValue(b, state.key)
    let r =
      typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : collator.compare(String(av), String(bv))
    if (!r) r = collator.compare(a.name, b.name)
    return state.asc ? r : -r
  })
}

function rowsOf(side: Side): RemoteEntry[] {
  return sorted(entriesOf(side), sortStateOf(side))
}

function toggleSort(side: Side, key: SortKey): void {
  const current = sortStateOf(side)
  setSortState(
    side,
    current.key === key ? { key, asc: !current.asc } : { key, asc: true },
  )
}

function toggleSortColumn(side: Side, key: ColumnKey): void {
  if (SORTABLE_COLUMNS.includes(key)) toggleSort(side, key as SortKey)
}

function sortMark(side: Side, key: SortKey): string {
  const s = sortStateOf(side)
  return s.key === key ? (s.asc ? '▲' : '▼') : '⇅'
}

function sortMarkColumn(side: Side, key: ColumnKey): string {
  return SORTABLE_COLUMNS.includes(key) ? sortMark(side, key as SortKey) : ''
}

function parentOf(p: string): string {
  const normalized = p.replace(/[\\/]+$/, '')
  const i = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (i <= 0) return p.startsWith('/') ? '/' : normalized
  return normalized.slice(0, i) || '/'
}

function toggle(set: Set<string>, entryPath: string, side: Side): void {
  const next = new Set(set)
  next.has(entryPath) ? next.delete(entryPath) : next.add(entryPath)
  setSelected(side, next)
}

/** 单击单选；Ctrl/⌘ 增减；Shift 连选；触屏由复选框处理。 */
function onRowClick(side: Side, entry: RemoteEntry, e: MouseEvent): void {
  if (suppressClick || isTouch.value) return
  const set = selectedOf(side)
  const additive = e.ctrlKey || e.metaKey
  if (e.shiftKey && anchorOf(side)) {
    const list = rowsOf(side).map((x) => x.path)
    const a = list.indexOf(anchorOf(side))
    const b = list.indexOf(entry.path)
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a]
      const next = new Set<string>(additive ? set : [])
      for (let i = lo; i <= hi; i++) next.add(list[i])
      setSelected(side, next)
    }
    return
  }
  if (additive) {
    toggle(set, entry.path, side)
    setAnchor(side, entry.path)
    return
  }
  setSelected(side, new Set([entry.path]))
  setAnchor(side, entry.path)
}

/** 双击才进入目录：否则目录既无法被选中，也无法点它的传输按钮。 */
function onRowDblClick(side: Side, entry: RemoteEntry): void {
  if (entry.type !== 'dir') return
  if (side === 'local') {
    localPath.value = entry.path
    void loadLocal()
  } else {
    remotePath.value = entry.path
    void loadRemote()
  }
}

function onCheckbox(side: Side, entry: RemoteEntry): void {
  toggle(selectedOf(side), entry.path, side)
}

function selectAll(side: Side): void {
  setSelected(side, new Set(rowsOf(side).map((e) => e.path)))
}

function clearSelection(side: Side): void {
  setSelected(side, new Set())
  setAnchor(side, '')
}

/** 按住左键拖出矩形框选；Ctrl/⌘ + 拖拽把结果追加到已有选择。 */
function onPaneMouseDown(side: Side, e: MouseEvent): void {
  if (isTouch.value || e.button !== 0) return
  const target = e.target
  if (target instanceof HTMLElement && target.closest('button, input, label')) return
  const startX = e.clientX
  const startY = e.clientY
  const additive = e.ctrlKey || e.metaKey
  const base = new Set(selectedOf(side))
  let active = false

  const onMove = (ev: MouseEvent): void => {
    if (!active && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return
    active = true
    marquee.value = { x1: startX, y1: startY, x2: ev.clientX, y2: ev.clientY }
  }
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    dragCleanup = null
    const box = marquee.value
    if (active && box) {
      suppressClick = true
      const minX = Math.min(box.x1, box.x2)
      const maxX = Math.max(box.x1, box.x2)
      const minY = Math.min(box.y1, box.y2)
      const maxY = Math.max(box.y1, box.y2)
      const pane = document.querySelector(`.file-rows[data-side="${side}"]`)
      const hits = new Set<string>()
      pane?.querySelectorAll<HTMLElement>('.file-row').forEach((el) => {
        const r = el.getBoundingClientRect()
        if (r.right > minX && r.left < maxX && r.bottom > minY && r.top < maxY) {
          const p = el.dataset.path
          if (p) hits.add(p)
        }
      })
      setSelected(side, additive ? new Set([...base, ...hits]) : hits)
      window.setTimeout(() => (suppressClick = false), 0)
    }
    marquee.value = null
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
  dragCleanup = () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    marquee.value = null
  }
}

async function loadLocal(): Promise<void> {
  try {
    localEntries.value = await api.browseLocal(localPath.value)
    clearSelection('local')
  } catch (err) {
    emit('notify', err instanceof Error ? err.message : String(err))
  }
}

async function loadRemote(): Promise<void> {
  remoteError.value = ''
  if (!props.connection || !remoteReady.value) {
    remoteEntries.value = []
    clearSelection('remote')
    return
  }
  try {
    remoteEntries.value = await api.browseRemote(props.connection.id, remotePath.value)
    clearSelection('remote')
  } catch (err) {
    remoteError.value = err instanceof Error ? err.message : String(err)
    remoteEntries.value = []
    clearSelection('remote')
  }
}

function goLocalUp(): void {
  localPath.value = parentOf(localPath.value)
  void loadLocal()
}

function goRemoteUp(): void {
  remotePath.value = parentOf(remotePath.value)
  void loadRemote()
}

async function chooseDirectory(): Promise<void> {
  const picked = await window.tunnelDesktop?.selectDirectory()
  if (picked) {
    localPath.value = picked
    await loadLocal()
  }
}

/**
 * 文件与文件夹都走服务端展开接口：下载展开远程目录，上传展开本地目录，
 * 都保持「一个任务 = 一个文件」与整批统一的同名后缀。
 */
async function runExpand(kind: 'download' | 'upload', paths: string[]): Promise<void> {
  if (!props.connection || !paths.length || scanning.value) return
  if (kind === 'upload' && !props.isDesktop) return
  scanning.value = true
  scanController = new AbortController()
  try {
    const result =
      kind === 'download'
        ? await api.expandTasks(
            {
              connectionId: props.connection.id,
              paths,
              localDir: localPath.value,
            },
            scanController.signal,
          )
        : await api.expandUploadTasks(
            {
              connectionId: props.connection.id,
              paths,
              remoteDir: remotePath.value,
            },
            scanController.signal,
          )
    if (!result.files) {
      emit('notify', result.errors.length ? result.errors[0] : '所选内容没有可传输的文件')
      return
    }
    const bits = [`已加入 ${result.files} 个${kind === 'download' ? '下载' : '上传'}任务`]
    if (result.suffix) bits.push(`目标重名，整批统一使用后缀「${result.suffix}」`)
    if (result.skipped) bits.push(`跳过 ${result.skipped} 个链接 / 未知类型`)
    if (result.emptyDirs) bits.push(`${result.emptyDirs} 个空目录未创建`)
    if (result.truncated) bits.push(`达到 ${result.limit} 个文件上限，请分批传输`)
    if (result.errors.length) bits.push(`${result.errors.length} 项读取失败（其余不受影响）`)
    emit('notify', bits.join('；'))
    emit('tasks-added', result.tasks ?? [])
    clearSelection(kind === 'download' ? 'remote' : 'local')
  } catch (err) {
    emit(
      'notify',
      scanController?.signal.aborted
        ? '已取消展开'
        : err instanceof Error ? err.message : String(err),
    )
  } finally {
    scanning.value = false
    scanController = null
  }
}

function cancelScan(): void {
  scanController?.abort()
}

function downloadSelected(): void {
  if (!props.connection) return
  void runExpand('download', rowsOf('remote').filter((e) => selectedRemote.value.has(e.path)).map((e) => e.path))
}

function downloadOne(entry: RemoteEntry): void {
  void runExpand('download', [entry.path])
}

function uploadSelected(): void {
  if (!props.connection) return
  void runExpand('upload', rowsOf('local').filter((e) => selectedLocal.value.has(e.path)).map((e) => e.path))
}

function uploadOne(entry: RemoteEntry): void {
  void runExpand('upload', [entry.path])
}

/**
 * 只在「连接身份的业务字段」变化时更新远程目录。
 * 后端每次刷新连接列表都会返回全新的 ConnectionView 对象，
 * 用 watch(() => [id, state]) 这类每次生成新数组的 getter 会被 Vue 判定为永远变化，
 * 导致下载后刷新被误当成切换连接、右栏被打回根目录。
 */
const connectionKey = computed(() => connectionIdentityKey(props.connection))
let lastConnection: ConnectionView | null = null
watch(
  connectionKey,
  () => {
    const next = props.connection
    remotePath.value = nextRemotePath(remotePath.value, lastConnection, next)
    lastConnection = next ? { ...next } : null
    void loadRemote()
  },
  { immediate: true },
)

onMounted(() => {
  isTouch.value = Boolean(coarseQuery?.matches)
  narrowQuery = window.matchMedia?.('(max-width: 900px)') ?? null
  isNarrow.value = Boolean(narrowQuery?.matches)
  narrowQuery?.addEventListener?.('change', onNarrowChange)
  if (typeof ResizeObserver !== 'undefined' && browserEl.value) {
    resizeObserver = new ResizeObserver(updateBrowserWidth)
    resizeObserver.observe(browserEl.value)
  }
  window.addEventListener('resize', updateBrowserWidth)
  requestAnimationFrame(updateBrowserWidth)
  outsideHandler = (e: PointerEvent) => {
    if (
      columnsMenuOpen.value &&
      columnsMenuEl.value &&
      !columnsMenuEl.value.contains(e.target as Node)
    ) {
      columnsMenuOpen.value = false
    }
  }
  document.addEventListener('pointerdown', outsideHandler)
  // 远程列表由上面的 immediate watch 负责首次拉取，这里只加载本地目录
  void loadLocal()
})
onBeforeUnmount(() => {
  narrowQuery?.removeEventListener?.('change', onNarrowChange)
  resizeObserver?.disconnect()
  window.removeEventListener('resize', updateBrowserWidth)
  if (outsideHandler) document.removeEventListener('pointerdown', outsideHandler)
  scanController?.abort()
  dragCleanup?.()
  resizeCleanup?.()
  document.body.classList.remove('resizing', 'resizing-col')
})
</script>

<template>
  <div class="panel-head">
    <h2>文件浏览</h2>
    <span class="sub">左侧本地 · 右侧远程 · 双击进入文件夹</span>
    <div class="spacer"></div>
    <template v-if="scanning">
      <span class="scan-status">正在展开目录…</span>
      <button class="btn small danger" @click="cancelScan">取消扫描</button>
    </template>

    <!-- 列显隐：名称列必选，其余可自由勾选；窄屏仍强制隐藏创建时间 / 类型 -->
    <div ref="columnsMenuEl" class="clear-menu columns-menu">
      <button class="btn small" title="选择要显示的列" @click="columnsMenuOpen = !columnsMenuOpen">列 ▾</button>
      <div v-if="columnsMenuOpen" class="columns-pop">
        <div class="columns-title">显示列</div>
        <label
          v-for="col in ALL_COLUMNS"
          :key="col"
          class="column-option"
          :class="{ locked: col === 'name' }"
        >
          <input
            type="checkbox"
            :checked="prefs.visibleColumns.includes(col)"
            :disabled="col === 'name'"
            @change="toggleColumn(col)"
          />
          <span>{{ COLUMN_LABELS[col] }}</span>
          <small v-if="col === 'name'">必选</small>
        </label>
        <div class="columns-foot">
          <button class="btn small ghost" @click="resetColumns">恢复默认</button>
        </div>
      </div>
    </div>

    <button
      class="btn small"
      :disabled="scanning || !selectedRemote.size || !remoteReady"
      @click="downloadSelected"
    >↓ 下载所选 ({{ selectedRemote.size }})</button>
    <button
      v-if="isDesktop"
      class="btn small"
      :disabled="scanning || !selectedLocal.size || !remoteReady"
      @click="uploadSelected"
    >↑ 上传所选 ({{ selectedLocal.size }})</button>
  </div>

  <div ref="browserEl" class="browser" style="flex: 1; min-height: 0">
    <!-- 本地目录：操作列提供「上传」 -->
    <div class="browser-pane" :style="leftPaneStyle">
      <div class="pathbar">
        <button class="btn small" title="上级目录" @click="goLocalUp">↑</button>
        <input v-model="localPath" class="input" @keyup.enter="loadLocal()" />
        <button class="btn small" @click="loadLocal()">刷新</button>
        <button v-if="isDesktop" class="btn small" title="选择目录" @click="chooseDirectory">选目录</button>
      </div>
      <div class="list-toolbar">
        <button class="btn small" @click="selectAll('local')">全选</button>
        <button class="btn small" @click="clearSelection('local')">取消选择</button>
        <span class="sub">已选 {{ selectedLocal.size }} 项</span>
      </div>
      <div class="file-head">
        <div
          v-for="col in columnDefs"
          :key="col.key"
          class="col-cell"
          :class="[`col-cell-${col.key}`, { active: sortLocal.key === col.key }]"
        >
          <button
            v-if="col.sortable"
            class="col-btn"
            :class="{ active: sortLocal.key === col.key }"
            :title="`按${col.label}排序`"
            @click="toggleSortColumn('local', col.key)"
          >{{ col.label }}<span class="arrow">{{ sortMarkColumn('local', col.key) }}</span></button>
          <span v-else class="col-static">{{ col.label }}</span>
          <span
            v-if="col.resizable"
            class="col-resizer"
            role="separator"
            tabindex="0"
            :aria-label="`拖动调整${col.label}列宽`"
            :title="`拖动调整列宽 · 双击复位 · ←/→ 微调`"
            @pointerdown="startColumnResize(col.key, $event)"
            @dblclick="resetColumnWidth(col.key)"
            @keydown="onColumnKey(col.key, $event)"
          ><i></i></span>
        </div>
      </div>
      <div class="file-rows" data-side="local" @mousedown="onPaneMouseDown('local', $event)">
        <div v-if="!localEntries.length" class="empty">目录为空或不可访问</div>
        <div
          v-for="entry in rowsOf('local')"
          :key="entry.path"
          class="file-row"
          :data-path="entry.path"
          :class="{ selected: selectedLocal.has(entry.path) }"
          @click="onRowClick('local', entry, $event)"
          @dblclick="onRowDblClick('local', entry)"
        >
          <template v-for="col in columnDefs" :key="col.key">
            <div v-if="col.key === 'name'" class="name-cell">
              <input
                v-if="isTouch"
                class="row-check"
                type="checkbox"
                :checked="selectedLocal.has(entry.path)"
                @click.stop
                @change="onCheckbox('local', entry)"
              />
              <span class="icon">{{ entry.type === 'dir' ? '📁' : '📄' }}</span>
              <span class="grow">{{ entry.name }}</span>
            </div>
            <span v-else-if="col.key === 'size'" class="cell cell-size">{{ entry.type === 'dir' ? '' : displayBytes(entry.size) }}</span>
            <span v-else-if="col.key === 'createdAt'" class="cell cell-created">{{ formatDateTime(entry.createdAt) }}</span>
            <span v-else-if="col.key === 'modifiedAt'" class="cell cell-modified">{{ formatDateTime(entry.modifiedAt) }}</span>
            <span v-else-if="col.key === 'type'" class="cell cell-type">{{ entryTypeLabel(entry.name, entry.type === 'dir') }}</span>
            <span v-else class="cell cell-actions row-actions">
              <button
                class="btn small"
                :disabled="!isDesktop || scanning || !remoteReady"
                :title="isDesktop ? '上传该文件或整个文件夹' : 'Web 端不支持上传'"
                @click.stop="uploadOne(entry)"
              >↑ 上传</button>
            </span>
          </template>
        </div>
      </div>
    </div>

    <!-- 左右两栏之间的可拖拽分隔条 -->
    <div
      v-if="!isNarrow"
      class="splitter splitter-v browser-splitter"
      :class="{ active: dragging === 'panes' }"
      role="separator"
      tabindex="0"
      aria-orientation="vertical"
      aria-label="拖动调整文件浏览左右两栏宽度"
      title="拖动调整左右栏宽度 · 双击复位 · ←/→ 微调"
      @pointerdown="startPaneResize($event)"
      @dblclick="resetPaneSize"
      @keydown="onPaneKey"
    ><span class="grip"></span></div>

    <!-- 远程目录：操作列提供「下载」 -->
    <div class="browser-pane" :style="rightPaneStyle">
      <div class="pathbar">
        <button class="btn small" title="上级目录" @click="goRemoteUp">↑</button>
        <input v-model="remotePath" class="input" @keyup.enter="loadRemote()" />
        <button class="btn small" @click="loadRemote()">刷新</button>
      </div>
      <div class="list-toolbar">
        <button class="btn small" @click="selectAll('remote')">全选</button>
        <button class="btn small" @click="clearSelection('remote')">取消选择</button>
        <span class="sub">已选 {{ selectedRemote.size }} 项</span>
      </div>
      <div class="file-head">
        <div
          v-for="col in columnDefs"
          :key="col.key"
          class="col-cell"
          :class="[`col-cell-${col.key}`, { active: sortRemote.key === col.key }]"
        >
          <button
            v-if="col.sortable"
            class="col-btn"
            :class="{ active: sortRemote.key === col.key }"
            :title="col.key === 'createdAt' ? 'FTP / SFTP 协议层不提供创建时间，显示「—」' : `按${col.label}排序`"
            @click="toggleSortColumn('remote', col.key)"
          >{{ col.label }}<span class="arrow">{{ sortMarkColumn('remote', col.key) }}</span></button>
          <span v-else class="col-static">{{ col.label }}</span>
          <span
            v-if="col.resizable"
            class="col-resizer"
            role="separator"
            tabindex="0"
            :aria-label="`拖动调整${col.label}列宽`"
            :title="`拖动调整列宽 · 双击复位 · ←/→ 微调`"
            @pointerdown="startColumnResize(col.key, $event)"
            @dblclick="resetColumnWidth(col.key)"
            @keydown="onColumnKey(col.key, $event)"
          ><i></i></span>
        </div>
      </div>
      <div class="file-rows" data-side="remote" @mousedown="onPaneMouseDown('remote', $event)">
        <div v-if="!remoteReady" class="empty">
          请先在左侧选中一个连接并点击「连接」<br />
          <span class="hint">手机 Web 端可浏览已建立的连接与任务进度</span>
        </div>
        <div v-else-if="remoteError" class="error" style="padding: 12px">{{ remoteError }}</div>
        <div v-else-if="!remoteEntries.length" class="empty">远程目录为空</div>
        <div
          v-for="entry in rowsOf('remote')"
          :key="entry.path"
          class="file-row"
          :data-path="entry.path"
          :class="{ selected: selectedRemote.has(entry.path) }"
          @click="onRowClick('remote', entry, $event)"
          @dblclick="onRowDblClick('remote', entry)"
        >
          <template v-for="col in columnDefs" :key="col.key">
            <div v-if="col.key === 'name'" class="name-cell">
              <input
                v-if="isTouch"
                class="row-check"
                type="checkbox"
                :checked="selectedRemote.has(entry.path)"
                @click.stop
                @change="onCheckbox('remote', entry)"
              />
              <span class="icon">{{ entry.type === 'dir' ? '📁' : '📄' }}</span>
              <span class="grow">{{ entry.name }}</span>
            </div>
            <span v-else-if="col.key === 'size'" class="cell cell-size">{{ entry.type === 'dir' ? '' : displayBytes(entry.size) }}</span>
            <span v-else-if="col.key === 'createdAt'" class="cell cell-created">{{ formatDateTime(entry.createdAt) }}</span>
            <span v-else-if="col.key === 'modifiedAt'" class="cell cell-modified">{{ formatDateTime(entry.modifiedAt) }}</span>
            <span v-else-if="col.key === 'type'" class="cell cell-type">{{ entryTypeLabel(entry.name, entry.type === 'dir') }}</span>
            <span v-else class="cell cell-actions row-actions">
              <button
                class="btn small"
                title="下载该文件或整个文件夹"
                :disabled="scanning"
                @click.stop="downloadOne(entry)"
              >↓ 下载</button>
            </span>
          </template>
        </div>
      </div>
    </div>
  </div>

  <div v-if="marquee" class="marquee" :style="marqueeStyle"></div>
</template>

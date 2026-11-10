<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { ConnectionView, TransferTask, WsMessage } from '@shared/types'
import {
  api,
  connectWebSocket,
  initAuth,
  isDesktop,
  login as apiLogin,
  loginWithToken,
  onUnauthorized,
  type Bootstrap,
} from './api'
import {
  DEFAULT_LAYOUT,
  clampQueueHeight,
  clampSidebarWidth,
  loadLayoutPrefs,
  saveLayoutPrefs,
} from './layout'
import ConnectionPanel from './components/ConnectionPanel.vue'
import BrowserPanel from './components/BrowserPanel.vue'
import TaskPanel from './components/TaskPanel.vue'
import SettingsPanel from './components/SettingsPanel.vue'

const ready = ref(false)
const needsLogin = ref(false)
const loginPassword = ref('')
const loginError = ref('')
const localToken = ref('')
const bootstrap = ref<Bootstrap | null>(null)
const connections = ref<ConnectionView[]>([])
const tasks = ref<TransferTask[]>([])
const selectedId = ref('')
const activeTab = ref<'connections' | 'browser' | 'tasks'>('browser')
const settingsOpen = ref(false)
const notice = ref('')
let stopWs: (() => void) | null = null
let noticeTimer: number | undefined

/* ---------- 三区域布局：尺寸 / 收起状态持久化到本机浏览器偏好 ---------- */
const prefs = reactive(loadLayoutPrefs())
const workspaceEl = ref<HTMLElement | null>(null)
const mainEl = ref<HTMLElement | null>(null)
const dragging = ref<'sidebar' | 'queue' | null>(null)
const isNarrow = ref(false)
let narrowQuery: MediaQueryList | null = null

// 窄屏是 Tab 布局，没有「收起」概念，因此忽略持久化的收起状态。
const sidebarHidden = computed(() => !isNarrow.value && prefs.sidebarCollapsed)
const queueHidden = computed(() => !isNarrow.value && prefs.queueCollapsed)

function persistLayout(): void {
  saveLayoutPrefs({ ...prefs })
}

/** 窗口尺寸变化后重新收敛，避免大窗口保存的尺寸把小窗口挤溢出。 */
function clampToViewport(): void {
  const w = workspaceEl.value?.clientWidth ?? 0
  const h = mainEl.value?.clientHeight ?? 0
  if (w > 0) prefs.sidebarWidth = clampSidebarWidth(prefs.sidebarWidth, w)
  if (h > 0) prefs.queueHeight = clampQueueHeight(prefs.queueHeight, h)
}

function setCollapsed(kind: 'sidebar' | 'queue', value: boolean): void {
  if (kind === 'sidebar') prefs.sidebarCollapsed = value
  else prefs.queueCollapsed = value
  persistLayout()
}

/** 有任务创建时自动展开传输队列；窄屏 Tab 布局下等价于切到「任务」Tab。 */
function ensureQueueVisible(): void {
  if (isNarrow.value) {
    activeTab.value = 'tasks'
    return
  }
  if (!prefs.queueCollapsed) return
  prefs.queueCollapsed = false
  persistLayout()
}

function startResize(kind: 'sidebar' | 'queue', e: PointerEvent): void {
  if (isNarrow.value || e.button !== 0) return
  e.preventDefault()
  const startX = e.clientX
  const startY = e.clientY
  const startWidth = prefs.sidebarWidth
  const startHeight = prefs.queueHeight
  dragging.value = kind
  document.body.classList.add('resizing', kind === 'sidebar' ? 'resizing-col' : 'resizing-row')

  const onMove = (ev: PointerEvent): void => {
    if (kind === 'sidebar') {
      const w = workspaceEl.value?.clientWidth ?? 0
      if (w > 0) prefs.sidebarWidth = clampSidebarWidth(startWidth + ev.clientX - startX, w)
    } else {
      const h = mainEl.value?.clientHeight ?? 0
      if (h > 0) prefs.queueHeight = clampQueueHeight(startHeight - (ev.clientY - startY), h)
    }
  }
  const onUp = (): void => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
    document.body.classList.remove('resizing', 'resizing-col', 'resizing-row')
    dragging.value = null
    persistLayout()
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
}

/** 分隔条支持键盘微调，Shift 加大步长。 */
function onSplitterKey(kind: 'sidebar' | 'queue', e: KeyboardEvent): void {
  const step = e.shiftKey ? 48 : 16
  if (kind === 'sidebar' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault()
    const w = workspaceEl.value?.clientWidth ?? 1200
    prefs.sidebarWidth = clampSidebarWidth(
      prefs.sidebarWidth + (e.key === 'ArrowRight' ? step : -step), w,
    )
    persistLayout()
  } else if (kind === 'queue' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault()
    const h = mainEl.value?.clientHeight ?? 800
    prefs.queueHeight = clampQueueHeight(
      prefs.queueHeight + (e.key === 'ArrowUp' ? step : -step), h,
    )
    persistLayout()
  }
}

function resetSize(kind: 'sidebar' | 'queue'): void {
  if (kind === 'sidebar') prefs.sidebarWidth = DEFAULT_LAYOUT.sidebarWidth
  else prefs.queueHeight = DEFAULT_LAYOUT.queueHeight
  clampToViewport()
  persistLayout()
}

const selectedConnection = computed(
  () => connections.value.find((c) => c.id === selectedId.value) ?? null,
)
const runningCount = computed(
  () => tasks.value.filter((t) => t.status === 'running').length,
)

function flash(message: string): void {
  notice.value = message
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => (notice.value = ''), 3200)
}

function applyMessage(msg: WsMessage): void {
  if (msg.type === 'snapshot') {
    connections.value = msg.connections
    tasks.value = msg.tasks
  } else if (msg.type === 'task') {
    const i = tasks.value.findIndex((t) => t.id === msg.task.id)
    const isNew = i < 0
    if (isNew) tasks.value.unshift(msg.task)
    else tasks.value[i] = msg.task
    // 只在「新建任务」时展开；进度广播、全量刷新不会反复弹出面板
    if (isNew) ensureQueueVisible()
  } else if (msg.type === 'task-removed') {
    tasks.value = tasks.value.filter((t) => t.id !== msg.id)
  } else if (msg.type === 'tasks-removed') {
    const ids = new Set(msg.ids)
    tasks.value = tasks.value.filter((t) => !ids.has(t.id))
  } else if (msg.type === 'connection') {
    const i = connections.value.findIndex((c) => c.id === msg.connection.id)
    if (i >= 0) connections.value[i] = msg.connection
    else connections.value.push(msg.connection)
  }
}

async function load(): Promise<void> {
  const [info, conns, list] = await Promise.all([
    api.bootstrap(),
    api.connections(),
    api.tasks(),
  ])
  bootstrap.value = info
  connections.value = conns
  tasks.value = list
  if (!conns.some((c) => c.id === selectedId.value)) {
    selectedId.value = conns[0]?.id ?? ''
  }
  stopWs?.()
  stopWs = connectWebSocket(applyMessage)
}

async function boot(): Promise<void> {
  try {
    const authed = await initAuth()
    if (!isDesktop && !authed) {
      needsLogin.value = true
      ready.value = true
      return
    }
    await load()
    ready.value = true
  } catch (err) {
    flash(err instanceof Error ? err.message : String(err))
    ready.value = true
    needsLogin.value = !isDesktop
  }
}

async function doLogin(): Promise<void> {
  loginError.value = ''
  try {
    await apiLogin(loginPassword.value)
    needsLogin.value = false
    loginPassword.value = ''
    await load()
  } catch (err) {
    loginError.value = err instanceof Error ? err.message : String(err)
  }
}

async function doTokenLogin(): Promise<void> {
  loginError.value = ''
  try {
    const ok = await loginWithToken(localToken.value)
    if (!ok) throw new Error('token 无效或已过期')
    needsLogin.value = false
    localToken.value = ''
    await load()
  } catch (err) {
    loginError.value = err instanceof Error ? err.message : String(err)
  }
}

async function refreshAll(): Promise<void> {
  try {
    await load()
  } catch (err) {
    flash(err instanceof Error ? err.message : String(err))
  }
}

/** 展开接口返回的任务快照并入队列：按 id 去重，后续进度仍由 WS 广播驱动。 */
function mergeTasks(incoming: TransferTask[]): void {
  if (!incoming?.length) return
  const known = new Set(tasks.value.map((t) => t.id))
  const fresh = incoming.filter((t) => !known.has(t.id))
  if (fresh.length) tasks.value = [...fresh, ...tasks.value]
}

/**
 * 浏览区创建任务成功时立即展开队列。
 * 这里刻意不做 refreshAll()：全量刷新会重新拉取连接列表、重连 WS 并推送 snapshot，
 * 既浪费也会让浏览区拿到全新的连接对象（历史上正是它把右栏打回根目录）。
 */
function onTasksAdded(created: TransferTask[]): void {
  ensureQueueVisible()
  mergeTasks(created)
}

function onNarrowChange(e: MediaQueryListEvent): void {
  isNarrow.value = e.matches
  if (!e.matches) requestAnimationFrame(clampToViewport)
}

// 登录 / 加载完成前 workspace 还没渲染，等它出现后再按当前视口收敛一次
watch(ready, (value) => {
  if (value) void nextTick(clampToViewport)
})

onUnauthorized(() => {
  needsLogin.value = true
  stopWs?.()
})

onMounted(() => {
  narrowQuery = window.matchMedia?.('(max-width: 900px)') ?? null
  isNarrow.value = Boolean(narrowQuery?.matches)
  narrowQuery?.addEventListener?.('change', onNarrowChange)
  window.addEventListener('resize', clampToViewport)
  requestAnimationFrame(clampToViewport)
  void boot()
})
onBeforeUnmount(() => {
  narrowQuery?.removeEventListener?.('change', onNarrowChange)
  window.removeEventListener('resize', clampToViewport)
  document.body.classList.remove('resizing', 'resizing-col', 'resizing-row')
  if (noticeTimer) clearTimeout(noticeTimer)
  stopWs?.()
})
</script>

<template>
  <div v-if="!ready" class="login">
    <div class="login-card">正在连接本地服务…</div>
  </div>

  <div v-else-if="needsLogin" class="login">
    <div class="login-card">
      <h1>Tunnel <span style="color: var(--accent)">Web</span></h1>
      <p>这是桌面端开放的管理接口。请输入在桌面客户端「设置 → Web 访问」中设置的密码。</p>
      <form @submit.prevent="doLogin">
        <div class="field">
          <label for="pw">访问密码</label>
          <input id="pw" v-model="loginPassword" class="input" type="password" autocomplete="current-password" required />
        </div>
        <div v-if="loginError" class="error">{{ loginError }}</div>
        <button class="btn primary" style="width: 100%" type="submit">登录</button>
      </form>
      <div class="divider"></div>
      <div class="section-title">本机开发 / CLI 模式</div>
      <div class="field">
        <label for="tk">本机一次性 token</label>
        <input id="tk" v-model="localToken" class="input" placeholder="粘贴服务启动时打印的 token" />
      </div>
      <button class="btn" style="width: 100%" @click="doTokenLogin">使用 token 接入</button>
      <div class="divider"></div>
      <div class="hint">仅限可信局域网使用；桌面端保持运行时本服务才可用。</div>
    </div>
  </div>

  <div v-else class="app">
    <header class="topbar">
      <div class="brand">Tunnel <span>·</span> 文件传输器</div>
      <span class="badge" :class="{ on: runningCount > 0 }">{{ runningCount }} 个任务运行中</span>
      <span v-if="!isDesktop" class="badge">Web 轻管理</span>
      <span v-if="bootstrap && !bootstrap.secretStoreSecure" class="badge warn">凭据存储降级</span>
      <div class="spacer"></div>
      <span v-if="notice" class="hint">{{ notice }}</span>
      <button class="btn small" @click="settingsOpen = true">设置 / Web 访问</button>
    </header>

    <div class="mobile-tabs">
      <button class="btn small" :class="{ active: activeTab === 'connections' }" @click="activeTab = 'connections'">连接</button>
      <button class="btn small" :class="{ active: activeTab === 'browser' }" @click="activeTab = 'browser'">浏览</button>
      <button class="btn small" :class="{ active: activeTab === 'tasks' }" @click="activeTab = 'tasks'">任务</button>
    </div>

    <div ref="workspaceEl" class="workspace" :class="[`show-${activeTab}`, { 'sidebar-hidden': sidebarHidden, 'queue-hidden': queueHidden }]">
      <aside v-if="!sidebarHidden" class="sidebar" :style="isNarrow ? undefined : { width: `${prefs.sidebarWidth}px` }">
        <ConnectionPanel
          :connections="connections"
          :protocols="bootstrap?.protocols ?? ['ftp', 'sftp', 'smb']"
          :selected-id="selectedId"
          :downloads-dir="bootstrap?.downloadsDir ?? ''"
          @select="(id: string) => (selectedId = id)"
          @refresh="refreshAll"
          @notify="flash"
          @collapse="setCollapsed('sidebar', true)"
        />
      </aside>
      <!-- 收起后保留一条窄边栏，随时可以重新展开 -->
      <div v-else class="rail rail-v">
        <button class="rail-btn" title="展开连接管理" aria-label="展开连接管理" @click="setCollapsed('sidebar', false)">»</button>
        <span class="rail-label">连接管理 · {{ connections.length }}</span>
      </div>

      <div
        v-if="!sidebarHidden && !isNarrow"
        class="splitter splitter-v"
        :class="{ active: dragging === 'sidebar' }"
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        aria-label="拖动调整连接管理宽度"
        title="拖动调整宽度 · 双击复位 · ←/→ 微调"
        @pointerdown="startResize('sidebar', $event)"
        @dblclick="resetSize('sidebar')"
        @keydown="onSplitterKey('sidebar', $event)"
      ><span class="grip"></span></div>

      <div ref="mainEl" class="main">
        <section class="panel browser-panel">
          <BrowserPanel
            :connection="selectedConnection"
            :is-desktop="isDesktop"
            :downloads-dir="bootstrap?.downloadsDir ?? ''"
            @notify="flash"
            @tasks-added="onTasksAdded"
          />
        </section>

        <template v-if="!isNarrow">
          <div v-if="queueHidden" class="rail rail-h">
            <button class="rail-btn" title="展开传输队列" aria-label="展开传输队列" @click="setCollapsed('queue', false)">∧</button>
            <span class="rail-label-h">传输队列 · {{ runningCount }} 个运行中 / {{ tasks.length }} 个任务</span>
            <button class="btn small rail-expand" @click="setCollapsed('queue', false)">展开队列</button>
          </div>
          <div
            v-else
            class="splitter splitter-h"
            :class="{ active: dragging === 'queue' }"
            role="separator"
            tabindex="0"
            aria-orientation="horizontal"
            aria-label="拖动调整传输队列高度"
            title="拖动调整高度 · 双击复位 · ↑/↓ 微调"
            @pointerdown="startResize('queue', $event)"
            @dblclick="resetSize('queue')"
            @keydown="onSplitterKey('queue', $event)"
          ><span class="grip"></span></div>
        </template>

        <section v-if="!queueHidden" class="panel queue-panel" :style="isNarrow ? undefined : { height: `${prefs.queueHeight}px` }">
          <TaskPanel
            :tasks="tasks"
            @refresh="refreshAll"
            @notify="flash"
            @collapse="setCollapsed('queue', true)"
          />
        </section>
      </div>
    </div>

    <SettingsPanel
      v-if="settingsOpen"
      :bootstrap="bootstrap"
      @close="settingsOpen = false"
      @notify="flash"
    />
  </div>
</template>

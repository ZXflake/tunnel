/**
 * 三区域布局偏好：连接管理宽度、传输队列高度、两处收起状态。
 *
 * 刻意保持为不依赖 Vue / 浏览器全局的纯逻辑：尺寸收敛规则与持久化格式
 * 可以直接在 Node 下的端到端自测里验证（scripts/e2e.ts）。
 */

export const LAYOUT_STORAGE_KEY = 'tunnel.layout.v1'

/** 拖拽边界：保证另一侧区域不会被压到不可用。 */
export const LAYOUT_LIMITS = {
  sidebarMin: 220,
  sidebarMax: 560,
  /** 右侧主区（文件浏览）至少保留的宽度 */
  mainMin: 360,
  queueMin: 120,
  queueMax: 600,
  /** 上方文件浏览区至少保留的高度 */
  browserMin: 180,
  /** 分隔条占位，参与上限计算，避免累计溢出 */
  splitter: 6,
} as const

export interface LayoutPrefs {
  sidebarWidth: number
  queueHeight: number
  sidebarCollapsed: boolean
  queueCollapsed: boolean
}

export const DEFAULT_LAYOUT: LayoutPrefs = {
  sidebarWidth: 304,
  queueHeight: 252,
  sidebarCollapsed: false,
  queueCollapsed: false,
}

export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * 侧栏宽度收敛。窗口变窄时上限会跟着下降，读取持久化值时同样调用本函数，
 * 避免上次的大窗口尺寸把新窗口挤压到溢出。
 */
export function clampSidebarWidth(width: number, workspaceWidth: number): number {
  const byViewport = workspaceWidth - LAYOUT_LIMITS.mainMin - LAYOUT_LIMITS.splitter
  const max = Math.max(
    LAYOUT_LIMITS.sidebarMin,
    Math.min(LAYOUT_LIMITS.sidebarMax, byViewport),
  )
  return Math.round(clamp(finiteOr(width, DEFAULT_LAYOUT.sidebarWidth), LAYOUT_LIMITS.sidebarMin, max))
}

/** 队列高度收敛：上方浏览区始终至少留下 browserMin。 */
export function clampQueueHeight(height: number, mainHeight: number): number {
  const byViewport = mainHeight - LAYOUT_LIMITS.browserMin - LAYOUT_LIMITS.splitter
  const max = Math.max(
    LAYOUT_LIMITS.queueMin,
    Math.min(LAYOUT_LIMITS.queueMax, byViewport),
  )
  return Math.round(clamp(finiteOr(height, DEFAULT_LAYOUT.queueHeight), LAYOUT_LIMITS.queueMin, max))
}

function browserStore(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    // 隐私模式 / 禁用存储时不应影响界面
    return null
  }
}

/** 读取偏好；格式损坏、缺字段或存取受限时一律退回默认值。 */
export function loadLayoutPrefs(store: KeyValueStore | null = browserStore()): LayoutPrefs {
  const fallback = { ...DEFAULT_LAYOUT }
  if (!store) return fallback
  try {
    const raw = store.getItem(LAYOUT_STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<LayoutPrefs> | null
    if (!parsed || typeof parsed !== 'object') return fallback
    return {
      // 这里先只做数值 / 布尔合法性校验，尺寸再按当前视口在 App 里二次收敛
      sidebarWidth: clamp(finiteOr(parsed.sidebarWidth, DEFAULT_LAYOUT.sidebarWidth), LAYOUT_LIMITS.sidebarMin, LAYOUT_LIMITS.sidebarMax),
      queueHeight: clamp(finiteOr(parsed.queueHeight, DEFAULT_LAYOUT.queueHeight), LAYOUT_LIMITS.queueMin, LAYOUT_LIMITS.queueMax),
      sidebarCollapsed: parsed.sidebarCollapsed === true,
      queueCollapsed: parsed.queueCollapsed === true,
    }
  } catch {
    return fallback
  }
}

export function saveLayoutPrefs(
  prefs: LayoutPrefs,
  store: KeyValueStore | null = browserStore(),
): void {
  if (!store) return
  try {
    store.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // 存储配额 / 权限问题不应打断拖拽或收起操作
  }
}

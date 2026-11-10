/**
 * 文件浏览区内部布局：左右两栏比例、列显隐、列宽。
 *
 * 与 layout.ts（三区域）刻意拆开：两份偏好用不同的 storage key，
 * App.vue 与 BrowserPanel.vue 各自读写，不会互相覆盖对方保存的字段。
 * 本模块不依赖 Vue / DOM，尺寸与持久化规则可直接在 Node 下的 e2e 中验证。
 */

export const BROWSER_STORAGE_KEY = 'tunnel.browser.v1'

export type ColumnKey = 'name' | 'size' | 'createdAt' | 'modifiedAt' | 'type' | 'actions'

export const ALL_COLUMNS: ColumnKey[] = [
  'name',
  'size',
  'createdAt',
  'modifiedAt',
  'type',
  'actions',
]

export const COLUMN_LABELS: Record<ColumnKey, string> = {
  name: '名称',
  size: '大小',
  createdAt: '创建时间',
  modifiedAt: '更新时间',
  type: '类型',
  actions: '操作',
}

/** 操作列没有可比较的数据，不参与排序。 */
export const SORTABLE_COLUMNS: ColumnKey[] = [
  'name',
  'size',
  'createdAt',
  'modifiedAt',
  'type',
]

export interface ColumnLimit {
  min: number
  max: number
}

export const COLUMN_LIMITS: Record<ColumnKey, ColumnLimit> = {
  name: { min: 140, max: 600 },
  size: { min: 56, max: 220 },
  createdAt: { min: 100, max: 240 },
  modifiedAt: { min: 100, max: 240 },
  type: { min: 56, max: 200 },
  actions: { min: 64, max: 180 },
}

export const DEFAULT_COLUMN_WIDTHS: Record<ColumnKey, number> = {
  name: 180,
  size: 76,
  createdAt: 128,
  modifiedAt: 128,
  type: 72,
  actions: 76,
}

/** 默认展示名称、大小、更新时间、类型、操作；创建时间默认隐藏。 */
export const DEFAULT_VISIBLE_COLUMNS: ColumnKey[] = [
  'name',
  'size',
  'modifiedAt',
  'type',
  'actions',
]

/** 窄屏（≤900px）沿用既有约定：隐藏这两列，横向不滚动。 */
export const NARROW_HIDDEN_COLUMNS: ColumnKey[] = ['createdAt', 'type']

export const BROWSER_LIMITS = {
  /** 左右两栏各自的最小宽度 */
  paneMin: 240,
  minRatio: 0.2,
  maxRatio: 0.8,
  splitter: 6,
  /** 名称列至少保留的宽度，列宽收敛时也要为它让路 */
  nameMin: 140,
  /** 与 CSS 的 gap / padding 保持一致 */
  gap: 6,
  padding: 16,
} as const

export interface BrowserPrefs {
  /** 左栏占可用宽度的比例（0.2–0.8，且两侧都不小于 paneMin） */
  browserRatio: number
  columnWidths: Record<ColumnKey, number>
  visibleColumns: ColumnKey[]
}

export const DEFAULT_BROWSER_PREFS: BrowserPrefs = {
  browserRatio: 0.5,
  columnWidths: { ...DEFAULT_COLUMN_WIDTHS },
  visibleColumns: [...DEFAULT_VISIBLE_COLUMNS],
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

function round(value: number, digits = 0): number {
  const f = 10 ** digits
  return Math.round(value * f) / f
}

function browserStore(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** 比例收敛：窗口变窄时自动让出另一侧的最小宽度。 */
export function clampBrowserRatio(ratio: unknown, browserWidth: number): number {
  const value = finiteOr(ratio, DEFAULT_BROWSER_PREFS.browserRatio)
  const usable = Math.max(0, browserWidth - BROWSER_LIMITS.splitter)
  const loByPane = usable >= 2 * BROWSER_LIMITS.paneMin ? BROWSER_LIMITS.paneMin / usable : 0
  const hiByPane = usable >= 2 * BROWSER_LIMITS.paneMin ? 1 - BROWSER_LIMITS.paneMin / usable : 1
  const lo = Math.max(BROWSER_LIMITS.minRatio, loByPane)
  const hi = Math.min(BROWSER_LIMITS.maxRatio, hiByPane)
  if (lo > hi) return 0.5
  return round(clamp(value, lo, hi), 3)
}

/** 左栏像素宽度；窄屏由 CSS 接管，这里仍返回左栏应有的宽度供计算使用。 */
export function leftPaneWidth(ratio: unknown, browserWidth: number): number {
  const usable = Math.max(0, browserWidth - BROWSER_LIMITS.splitter)
  return Math.round(usable * clampBrowserRatio(ratio, browserWidth))
}

/** 名称列必选且恒在第一列；过滤非法值、去重、按固定顺序输出。 */
export function normalizeVisibleColumns(input: unknown): ColumnKey[] {
  if (input === undefined || input === null) return [...DEFAULT_VISIBLE_COLUMNS]
  if (!Array.isArray(input)) return [...DEFAULT_VISIBLE_COLUMNS]
  const wanted = new Set<ColumnKey>(['name'])
  for (const key of input) {
    if (typeof key === 'string' && (ALL_COLUMNS as string[]).includes(key)) {
      wanted.add(key as ColumnKey)
    }
  }
  return ALL_COLUMNS.filter((key) => wanted.has(key))
}

export function columnsForNarrow(columns: ColumnKey[], narrow: boolean): ColumnKey[] {
  const base = normalizeVisibleColumns(columns)
  return narrow ? base.filter((key) => !NARROW_HIDDEN_COLUMNS.includes(key)) : base
}

/**
 * 列宽收敛：除了自身上下限，还要保证「名称列 + 其它固定列 + 间隙」不超出
 * 较窄那一栏的宽度，否则表头与行会各自横向滚动而错位。
 */
export function clampColumnWidth(
  key: ColumnKey,
  width: unknown,
  widths: Record<ColumnKey, number>,
  columns: ColumnKey[],
  paneWidth: number,
): number {
  const { min, max } = COLUMN_LIMITS[key]
  const desired = finiteOr(width, DEFAULT_COLUMN_WIDTHS[key])
  if (key === 'name' || paneWidth <= 0) return Math.round(clamp(desired, min, max))
  const others = columns
    .filter((c) => c !== 'name' && c !== key)
    .reduce((sum, c) => sum + finiteOr(widths[c], DEFAULT_COLUMN_WIDTHS[c]), 0)
  const occupied =
    BROWSER_LIMITS.nameMin +
    others +
    BROWSER_LIMITS.gap * Math.max(0, columns.length - 1) +
    BROWSER_LIMITS.padding
  const room = Math.max(min, paneWidth - occupied)
  return Math.round(clamp(desired, min, Math.min(max, room)))
}

/**
 * 渲染时按当前栏宽收敛列宽：先对每列做独立上下限收敛，再在总宽超出时等比压缩。
 * 表头与数据行分别滚动会错位，因此固定列之和必须始终装得进较窄的那一栏。
 * 只影响渲染，不改写用户保存的宽度偏好。
 */
export function fitColumnWidths(
  columns: ColumnKey[],
  widths: Record<ColumnKey, number>,
  paneWidth: number,
): Record<ColumnKey, number> {
  const next = { ...widths }
  if (paneWidth <= 0) {
    for (const key of ALL_COLUMNS) {
      next[key] = clampColumnWidth(key, next[key], next, columns, 0)
    }
    return next
  }
  for (const key of columns) {
    if (key !== 'name') {
      next[key] = clampColumnWidth(key, next[key], next, columns, paneWidth)
    }
  }
  const fixed = columns.filter((c) => c !== 'name')
  const overhead =
    BROWSER_LIMITS.nameMin +
    BROWSER_LIMITS.gap * Math.max(0, columns.length - 1) +
    BROWSER_LIMITS.padding
  const available = Math.max(0, paneWidth - overhead)
  const total = fixed.reduce((sum, key) => sum + next[key], 0)
  if (total > available && total > 0) {
    const scale = available / total
    for (const key of fixed) next[key] = Math.max(36, Math.round(next[key] * scale))
  }
  return next
}

/** 名称列吃掉剩余空间，其余列按持久化宽度固定，避免表头与行错位。 */
export function gridTemplateColumns(
  columns: ColumnKey[],
  widths: Record<ColumnKey, number>,
): string {
  return columns
    .map((key) =>
      key === 'name'
        ? 'minmax(0, 1fr)'
        : `${clampColumnWidth(key, widths[key], widths, columns, 0)}px`,
    )
    .join(' ')
}

/** 读取偏好；缺字段、类型非法、JSON 损坏或存储不可用时一律安全回退。 */
export function loadBrowserPrefs(store: KeyValueStore | null = browserStore()): BrowserPrefs {
  const fallback: BrowserPrefs = {
    browserRatio: DEFAULT_BROWSER_PREFS.browserRatio,
    columnWidths: { ...DEFAULT_COLUMN_WIDTHS },
    visibleColumns: [...DEFAULT_VISIBLE_COLUMNS],
  }
  if (!store) return fallback
  try {
    const raw = store.getItem(BROWSER_STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<BrowserPrefs> | null
    if (!parsed || typeof parsed !== 'object') return fallback
    const columnWidths = { ...DEFAULT_COLUMN_WIDTHS }
    const saved = parsed.columnWidths
    if (saved && typeof saved === 'object') {
      for (const key of ALL_COLUMNS) {
        columnWidths[key] = clampColumnWidth(
          key,
          (saved as Record<string, unknown>)[key],
          columnWidths,
          ALL_COLUMNS,
          0,
        )
      }
    }
    return {
      browserRatio: clampBrowserRatio(parsed.browserRatio, 0),
      columnWidths,
      visibleColumns: normalizeVisibleColumns(parsed.visibleColumns),
    }
  } catch {
    return fallback
  }
}

export function saveBrowserPrefs(
  prefs: BrowserPrefs,
  store: KeyValueStore | null = browserStore(),
): void {
  if (!store) return
  try {
    store.setItem(
      BROWSER_STORAGE_KEY,
      JSON.stringify({
        browserRatio: prefs.browserRatio,
        columnWidths: { ...prefs.columnWidths },
        visibleColumns: [...prefs.visibleColumns],
      }),
    )
  } catch {
    // 存储配额 / 权限问题不应打断拖拽
  }
}

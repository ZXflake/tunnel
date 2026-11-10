/** 纯展示用格式化，不依赖 node:* 模块，渲染层可安全复用。 */
export function displayBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!bytesPerSecond || bytesPerSecond < 1) return '-'
  return `${displayBytes(bytesPerSecond)}/s`
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`
  const m = Math.floor(seconds / 60)
  const s = Math.ceil(seconds % 60)
  return m < 60 ? `${m} 分 ${s} 秒` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

/** 列表与任务副行用的紧凑时间：2026-11-10 13:05 */
export function formatDateTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 预计完成时刻：13:24:08 */
export function formatClock(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 文件类型：目录 / 扩展名 / 无扩展名归为「文件」。 */
export function entryTypeLabel(name: string, isDir: boolean): string {
  if (isDir) return '文件夹'
  const i = name.lastIndexOf('.')
  if (i <= 0 || i === name.length - 1) return '文件'
  const ext = name.slice(i + 1)
  return ext.length <= 6 ? ext.toUpperCase() : ext.slice(0, 6).toUpperCase()
}

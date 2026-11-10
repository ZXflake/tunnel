import type { ConnectionView } from '@shared/types'

/**
 * 远程目录路径的纯逻辑：判断「连接是否真的变了」。
 *
 * 后端每次 GET /api/connections、每条 WS snapshot 都会返回全新的 ConnectionView 对象。
 * 曾经用 watch(() => [id, state]) 监听：getter 每次生成新数组，Vue 一律判定为变化，
 * 于是「下载后刷新连接列表」被误当成切换连接，右栏路径被重置回根目录。
 * 这里改用只含业务字段的稳定键，对象引用变化不再影响浏览位置。
 */
export interface ConnectionIdentity {
  id: string
  state: ConnectionView['state']
  /** 归一化后的根目录；未配置视为 '/' */
  basePath: string
}

export function connectionIdentity(view: ConnectionView | null): ConnectionIdentity | null {
  if (!view) return null
  return { id: view.id, state: view.state, basePath: view.basePath || '/' }
}

/** watch 用的稳定键：只包含业务字段，刷新带来的全新对象不会让它改变。 */
export function connectionIdentityKey(view: ConnectionView | null): string {
  const c = connectionIdentity(view)
  return c ? `${c.id}\u0000${c.state}\u0000${c.basePath}` : ''
}

/**
 * 决定远程目录路径：
 * - 首次拿到连接 / 切换连接 / 该连接根目录配置变化 → 回到（新的）根目录；
 * - 同一连接仅状态变化，或刷新带来的全新对象 → 保留当前正在浏览的目录。
 */
export function nextRemotePath(
  current: string,
  previous: ConnectionView | null,
  next: ConnectionView | null,
): string {
  const a = connectionIdentity(previous)
  const b = connectionIdentity(next)
  if (!b) return current
  if (!a || a.id !== b.id || a.basePath !== b.basePath) return b.basePath
  return current || b.basePath
}

import type {
  BulkAction,
  BulkResult,
  ConnectionInput,
  ConnectionView,
  CreateTaskInput,
  ExpandInput,
  ExpandOutcome,
  ExpandUploadInput,
  RemoteEntry,
  TransferTask,
  WebSettings,
  WsMessage,
} from '@shared/types'

declare global {
  interface Window {
    tunnelDesktop?: {
      isDesktop: boolean
      getToken(): Promise<string>
      getAppInfo(): Promise<Record<string, unknown>>
      selectDirectory(): Promise<string | null>
    }
  }
}

export interface Bootstrap {
  platform: string
  protocols: string[]
  dataDir: string
  downloadsDir: string
  homeDir: string
  lanAddresses: string[]
  port: number
  lanEnabled: boolean
  credentialStore: string
  secretStoreSecure: boolean
  isDesktop: boolean
}

export interface SettingsResponse extends WebSettings {
  lanAddresses: string[]
  bindHost: string
  restarted?: boolean
}

export interface ExpandResponse extends ExpandOutcome {
  tasks: TransferTask[]
  limit: number
}

let token = ''
let unauthorizedHandler: (() => void) | null = null

export const isDesktop = Boolean(window.tunnelDesktop)

export function onUnauthorized(handler: () => void): void {
  unauthorizedHandler = handler
}

/** 桌面端从 preload 拿一次性 token；Web 端从 localStorage 读登录态。 */
export async function initAuth(): Promise<boolean> {
  if (window.tunnelDesktop) {
    token = await window.tunnelDesktop.getToken()
    return true
  }
  token = localStorage.getItem('tunnel.token') ?? ''
  if (!token) return false
  const status = await fetch('/api/auth/status', {
    headers: { Authorization: `Bearer ${token}` },
  })
    .then((r) => r.json())
    .catch(() => ({ authenticated: false }))
  return Boolean(status.authenticated)
}

export async function login(password: string): Promise<void> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? '登录失败')
  token = data.token
  localStorage.setItem('tunnel.token', token)
}

/** 开发 / CLI 模式下，可用启动时打印的一次性本机 token 直接接入。 */
export async function loginWithToken(value: string): Promise<boolean> {
  token = value.trim()
  const status = await fetch('/api/auth/status', {
    headers: { Authorization: `Bearer ${token}` },
  })
    .then((r) => r.json())
    .catch(() => ({ authenticated: false }))
  if (status.authenticated) {
    localStorage.setItem('tunnel.token', token)
    return true
  }
  token = ''
  return false
}

export function logout(): void {
  token = ''
  localStorage.removeItem('tunnel.token')
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { error: '服务端返回了非 JSON 内容' }
  }
  if (res.status === 401) {
    unauthorizedHandler?.()
    throw new Error('登录状态已失效，请重新登录')
  }
  if (!res.ok) {
    const message = (data as { error?: string })?.error ?? `请求失败（${res.status}）`
    throw new Error(message)
  }
  return data as T
}

export const api = {
  bootstrap: () => request<Bootstrap>('/api/bootstrap'),
  health: () => request<{ ok: boolean }>('/api/health'),

  connections: () => request<ConnectionView[]>('/api/connections'),
  saveConnection: (input: ConnectionInput) =>
    request<ConnectionView>('/api/connections', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  removeConnection: (id: string) =>
    request<{ ok: boolean }>(`/api/connections/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  connect: (id: string) =>
    request<ConnectionView>(`/api/connections/${encodeURIComponent(id)}/connect`, {
      method: 'POST',
    }),
  disconnect: (id: string) =>
    request<ConnectionView>(`/api/connections/${encodeURIComponent(id)}/disconnect`, {
      method: 'POST',
    }),

  browseRemote: (connectionId: string, remotePath: string) =>
    request<RemoteEntry[]>(
      `/api/browse?connectionId=${encodeURIComponent(connectionId)}&path=${encodeURIComponent(remotePath)}`,
    ),
  browseLocal: (localPath?: string) =>
    request<RemoteEntry[]>(
      `/api/local${localPath ? `?path=${encodeURIComponent(localPath)}` : ''}`,
    ),

  tasks: () => request<TransferTask[]>('/api/tasks'),
  addTasks: (tasks: CreateTaskInput[]) =>
    request<TransferTask[]>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ tasks }),
    }),
  taskAction: (id: string, action: 'pause' | 'resume' | 'cancel') =>
    request<TransferTask>(`/api/tasks/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
    }),
  removeTask: (id: string) =>
    request<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  /** 递归展开选中的文件 / 文件夹；signal 用于「扫描中取消」。 */
  expandTasks: (input: ExpandInput, signal?: AbortSignal) =>
    request<ExpandResponse>('/api/tasks/expand', {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    }),
  /** 递归展开选中的本地文件 / 文件夹成上传任务；signal 用于「扫描中取消」。 */
  expandUploadTasks: (input: ExpandUploadInput, signal?: AbortSignal) =>
    request<ExpandResponse>('/api/tasks/expand-upload', {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    }),
  bulkTasks: (action: BulkAction) =>
    request<BulkResult>('/api/tasks/bulk', {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),

  settings: () => request<SettingsResponse>('/api/settings'),
  saveSettings: (body: { lanEnabled?: boolean; port?: number; password?: string }) =>
    request<SettingsResponse>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
}

/** WS 认证无法设置自定义头，因此用 ?token= 传同一凭据；断开后由 App.vue 自动重连。 */
export function connectWebSocket(onMessage: (msg: WsMessage) => void): () => void {
  let closed = false
  let socket: WebSocket | null = null
  let timer: number | undefined

  const open = () => {
    if (closed || !token) return
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    socket = new WebSocket(
      `${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`,
    )
    socket.onmessage = (event) => {
      try {
        onMessage(JSON.parse(String(event.data)) as WsMessage)
      } catch {
        /* 忽略非法消息 */
      }
    }
    socket.onclose = () => {
      if (!closed) timer = window.setTimeout(open, 2000)
    }
    socket.onerror = () => socket?.close()
  }
  open()
  return () => {
    closed = true
    if (timer) clearTimeout(timer)
    socket?.close()
  }
}

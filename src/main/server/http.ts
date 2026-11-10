import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import type {
  BulkAction,
  ConnectionInput,
  CreateTaskInput,
  ExpandInput,
  ExpandUploadInput,
  RemoteEntry,
} from '../../shared/types'
import { expandLocalPaths, expandRemotePaths, MAX_EXPAND_FILES } from '../core/expand'
import type { ConnectionManager } from '../core/connections'
import type { TransferEngine } from '../core/transfer-engine'
import type { EventHub } from '../core/event-hub'
import type { AppStore } from '../store'
import { AccessControl, lanAddresses } from './access'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

export interface WebServerDeps {
  store: AppStore
  connections: ConnectionManager
  engine: TransferEngine
  hub: EventHub
  access: AccessControl
  /** Vue SPA 构建产物目录 */
  staticDir: string
  secretStoreLabel: string
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > 1_000_000) throw new Error('请求体过大')
    chunks.push(buf)
  }
  if (!total) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

/** REST + WebSocket 服务。桌面渲染层与手机浏览器共用这一套 API。 */
export class WebServer {
  private server: http.Server | null = null
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 4096 })
  private readonly clients = new Set<WebSocket>()
  private unsubscribe: (() => void) | null = null
  private host = '127.0.0.1'
  private port = 8787
  private lanEnabled = false

  constructor(private readonly deps: WebServerDeps) {}

  get address(): { host: string; port: number; lanEnabled: boolean } {
    return { host: this.host, port: this.port, lanEnabled: this.lanEnabled }
  }

  async start(): Promise<void> {
    this.unsubscribe = this.deps.hub.subscribe((message) => {
      const data = JSON.stringify(message)
      for (const client of this.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(data)
      }
    })
    this.wss.on('connection', (ws) => {
      this.clients.add(ws)
      ws.send(
        JSON.stringify({
          type: 'snapshot',
          tasks: this.deps.engine.list(),
          connections: this.deps.connections.list(),
        }),
      )
      ws.on('close', () => this.clients.delete(ws))
      ws.on('error', () => this.clients.delete(ws))
    })
    await this.listen()
  }

  private async listen(): Promise<void> {
    const settings = await this.deps.store.loadSettings()
    this.port = settings.port
    // 安全兜底：开启局域网但未设密码时，强制退回仅本机监听
    this.lanEnabled = settings.lanEnabled && Boolean(settings.passwordHash)
    this.host = this.lanEnabled ? '0.0.0.0' : '127.0.0.1'

    const server = http.createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        if (!res.headersSent) {
          json(res, 500, { error: err instanceof Error ? err.message : String(err) })
        }
      })
    })
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== '/ws') {
        socket.destroy()
        return
      }
      const loopback = this.deps.access.isLoopback(req)
      const token = url.searchParams.get('token')
      const ok =
        this.deps.access.validateHost(req, this.lanEnabled) &&
        this.deps.access.validateOrigin(req, this.lanEnabled) &&
        this.deps.access.authenticateToken(token, loopback)
      if (!ok) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws))
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.port, this.host, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    this.server = server
  }

  /** 修改端口 / 局域网开关后原地重启，客户端 WS 断开后自动重连。 */
  async restart(): Promise<void> {
    for (const client of this.clients) client.close(1012, 'service restart')
    this.clients.clear()
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    }
    this.server = null
    await this.listen()
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (
      !this.deps.access.validateHost(req, this.lanEnabled) ||
      !this.deps.access.validateOrigin(req, this.lanEnabled)
    ) {
      json(res, 403, { error: '不允许的 Host / Origin' })
      return
    }

    if (url.pathname === '/api/health') {
      json(res, 200, { ok: true, name: 'tunnel', lan: this.lanEnabled })
      return
    }
    if (url.pathname === '/api/auth/status') {
      const settings = await this.deps.store.webSettings()
      json(res, 200, { ...settings, authenticated: this.deps.access.authenticate(req) })
      return
    }
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await readBody(req)
      const ip = req.socket.remoteAddress ?? 'unknown'
      const token = await this.deps.access.login(String(body.password ?? ''), ip)
      json(res, 200, { token })
      return
    }

    if (url.pathname.startsWith('/api/')) {
      if (!this.deps.access.authenticate(req)) {
        json(res, 401, { error: '未授权，请先登录', code: 'UNAUTHORIZED' })
        return
      }
      await this.api(req, res, url)
      return
    }

    if (url.pathname === '/ws') {
      res.writeHead(426).end('Expect WebSocket upgrade')
      return
    }
    await this.serveStatic(res, url.pathname)
  }

  private async api(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const method = req.method ?? 'GET'
    const p = url.pathname
    const { connections, engine, store, access } = this.deps
    // 手机 Web 端只做轻管理：上传与远程管理仅限桌面本机客户端
    const isDesktop = access.isLoopback(req)
    const body =
      method === 'GET' || method === 'DELETE' ? {} : await readBody(req)

    if (p === '/api/bootstrap' && method === 'GET') {
      json(res, 200, {
        platform: process.platform,
        protocols: connections.protocols(),
        dataDir: store.dataDir,
        downloadsDir: path.join(os.homedir(), 'Downloads'),
        homeDir: os.homedir(),
        lanAddresses: lanAddresses(),
        port: this.port,
        lanEnabled: this.lanEnabled,
        credentialStore: this.deps.secretStoreLabel,
        secretStoreSecure: store.credentialStore.secure,
        isDesktop,
      })
      return
    }

    if (p === '/api/settings') {
      if (method === 'GET') {
        json(res, 200, {
          ...(await store.webSettings()),
          lanAddresses: lanAddresses(),
          bindHost: this.host,
        })
      } else if (method === 'PUT') {
        const current = await store.loadSettings()
        const nextLan = (body.lanEnabled as boolean | undefined) ?? current.lanEnabled
        const nextPort = Number(body.port ?? current.port)
        const password = body.password ? String(body.password) : undefined
        if (nextLan && !password && !current.passwordHash) {
          json(res, 400, { error: '开启局域网访问前必须先设置 Web 访问密码' })
          return
        }
        if (password) await access.setPassword(password)
        await store.saveSettings({
          lanEnabled: nextLan,
          port: nextPort,
          passwordHash: (await store.loadSettings()).passwordHash,
        })
        const needRestart = nextPort !== this.port || nextLan !== (this.host === '0.0.0.0')
        if (needRestart) await this.restart()
        json(res, 200, { ...(await store.webSettings()), restarted: needRestart })
      } else json(res, 405, { error: 'Method Not Allowed' })
      return
    }

    if (p === '/api/connections') {
      if (method === 'GET') json(res, 200, connections.list())
      else if (method === 'POST') {
        const view = await connections.upsert(body as unknown as ConnectionInput)
        json(res, 201, view)
      } else json(res, 405, { error: 'Method Not Allowed' })
      return
    }

    let match = p.match(/^\/api\/connections\/([^/]+)$/)
    if (match && method === 'DELETE') {
      await connections.remove(decodeURIComponent(match[1]))
      json(res, 200, { ok: true })
      return
    }
    match = p.match(/^\/api\/connections\/([^/]+)\/(connect|disconnect)$/)
    if (match && method === 'POST') {
      const id = decodeURIComponent(match[1])
      if (match[2] === 'connect') await connections.connect(id)
      else await connections.disconnect(id)
      json(res, 200, connections.list().find((c) => c.id === id) ?? null)
      return
    }

    if (p === '/api/browse' && method === 'GET') {
      const id = url.searchParams.get('connectionId') ?? ''
      const remotePath = url.searchParams.get('path') ?? '/'
      json(res, 200, await connections.browse(id, remotePath))
      return
    }

    if (p === '/api/local' && method === 'GET') {
      json(res, 200, await this.localEntries(url.searchParams.get('path')))
      return
    }

    if (p === '/api/tasks') {
      if (method === 'GET') json(res, 200, engine.list())
      else if (method === 'POST') {
        const inputs = (Array.isArray(body.tasks) ? body.tasks : [body]) as CreateTaskInput[]
        if (inputs.some((t) => t.direction === 'upload') && !isDesktop) {
          json(res, 403, { error: 'Web 端不支持上传，请在桌面客户端操作' })
          return
        }
        json(res, 201, engine.addTasks(inputs))
      } else json(res, 405, { error: 'Method Not Allowed' })
      return
    }

    // 文件夹下载：服务端递归展开成一批单文件任务，传输引擎模型不变；
    // 客户端断开请求即中止扫描，实现「扫描中可取消」。
    if (p === '/api/tasks/expand' && method === 'POST') {
      const controller = new AbortController()
      req.once('aborted', () => controller.abort())
      res.once('close', () => {
        if (!res.writableEnded) controller.abort()
      })
      const outcome = await expandRemotePaths(
        connections,
        body as unknown as ExpandInput,
        controller.signal,
      )
      const created = engine.addTasks(outcome.inputs, true)
      json(res, 201, { ...outcome, tasks: created, limit: MAX_EXPAND_FILES })
      return
    }

    // 文件夹上传：本地递归展开 + 远程父目录补建；与 /api/tasks 一致，仅桌面本机可用
    if (p === '/api/tasks/expand-upload' && method === 'POST') {
      if (!isDesktop) {
        json(res, 403, { error: 'Web 端不支持上传，请在桌面客户端操作' })
        return
      }
      const controller = new AbortController()
      req.once('aborted', () => controller.abort())
      res.once('close', () => {
        if (!res.writableEnded) controller.abort()
      })
      const outcome = await expandLocalPaths(
        connections,
        body as unknown as ExpandUploadInput,
        controller.signal,
      )
      const created = engine.addTasks(outcome.inputs, true)
      json(res, 201, { ...outcome, tasks: created, limit: MAX_EXPAND_FILES })
      return
    }

    // 队列批量动作：一次请求、一次广播、一次落盘
    if (p === '/api/tasks/bulk' && method === 'POST') {
      const action = String(body.action ?? '') as BulkAction
      json(res, 200, await engine.bulk(action))
      return
    }

    match = p.match(/^\/api\/tasks\/([^/]+)\/(pause|resume|cancel)$/)
    if (match && method === 'POST') {
      const id = decodeURIComponent(match[1])
      const action = match[2]
      const task =
        action === 'pause'
          ? engine.pause(id)
          : action === 'resume'
            ? engine.resume(id)
            : await engine.cancel(id)
      json(res, 200, task)
      return
    }
    match = p.match(/^\/api\/tasks\/([^/]+)$/)
    if (match && method === 'DELETE') {
      await engine.remove(decodeURIComponent(match[1]))
      json(res, 200, { ok: true })
      return
    }

    json(res, 404, { error: `未知接口：${method} ${p}` })
  }

  /** 本地目录浏览：限制在用户主目录 / 临时目录内，避免 Web 端任意读盘。 */
  private async localEntries(input: string | null): Promise<RemoteEntry[]> {
    const home = os.homedir()
    const target = path.resolve(input || path.join(home, 'Downloads'))
    const allowed = [path.resolve(home), path.resolve(os.tmpdir())]
    if (!allowed.some((root) => target === root || target.startsWith(root + path.sep))) {
      throw new Error('本地路径不在允许范围内')
    }
    const items = await fsp.readdir(target, { withFileTypes: true })
    return Promise.all(
      items
        .filter((i) => !i.name.startsWith('.'))
        .map(async (item) => {
          const full = path.join(target, item.name)
          const st = await fsp.stat(full).catch(() => null)
          return {
            name: item.name,
            path: full,
            type: item.isDirectory()
              ? ('dir' as const)
              : item.isFile()
                ? ('file' as const)
                : ('unknown' as const),
            size: st?.size ?? 0,
            modifiedAt: st ? st.mtimeMs : null,
            createdAt: st && st.birthtimeMs > 0 ? st.birthtimeMs : null,
          }
        }),
    )
  }

  private async serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    const root = path.resolve(this.deps.staticDir)
    let rel = decodeURIComponent(pathname)
    if (rel === '/' || !rel) rel = '/index.html'
    const file = path.resolve(root, '.' + rel)
    if (file !== root && !file.startsWith(root + path.sep)) {
      json(res, 403, { error: 'Forbidden' })
      return
    }
    const stat = await fsp.stat(file).catch(() => null)
    const target = stat?.isFile() ? file : path.join(root, 'index.html')
    const content = await fsp.readFile(target).catch(() => null)
    if (!content) {
      json(res, 404, { error: '前端产物未构建，请先运行 npm run build:web' })
      return
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target)] ?? 'application/octet-stream',
      'Cache-Control': target.endsWith('index.html') ? 'no-store' : 'public, max-age=3600',
    })
    res.end(content)
  }

  async stop(): Promise<void> {
    this.unsubscribe?.()
    for (const client of this.clients) client.terminate()
    this.clients.clear()
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this.server = null
  }
}

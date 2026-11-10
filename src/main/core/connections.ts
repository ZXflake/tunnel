import crypto from 'node:crypto'
import type {
  ConnectionConfig,
  ConnectionInput,
  ConnectionState,
  ConnectionView,
  ProtocolAdapter,
  RemoteEntry,
  StatResult,
} from '../../shared/types'
import { normalizeRemotePath, withinBase } from '../../shared/path'
import { createAdapter, supportedProtocols } from '../protocols/registry'
import type { AppStore } from '../store'
import type { EventHub } from './event-hub'

const DEFAULT_PORTS: Record<ConnectionConfig['protocol'], number> = {
  ftp: 21,
  sftp: 22,
  smb: 445,
}

function toView(config: ConnectionConfig, state: ConnectionState, error?: string): ConnectionView {
  return {
    id: config.id,
    name: config.name,
    protocol: config.protocol,
    host: config.host,
    port: config.port,
    username: config.username,
    hasPassword: Boolean(config.password),
    savePassword: config.savePassword,
    basePath: config.basePath,
    options: config.options,
    createdAt: config.createdAt,
    state,
    error,
  }
}

/** 连接管理：配置持久化 + 长连接会话（用于浏览），传输任务另建独立会话避免争用。 */
export class ConnectionManager {
  private configs = new Map<string, ConnectionConfig>()
  private states = new Map<string, { state: ConnectionState; error?: string }>()
  private adapters = new Map<string, ProtocolAdapter>()

  constructor(
    private readonly store: AppStore,
    private readonly hub: EventHub,
  ) {}

  async init(): Promise<void> {
    for (const c of await this.store.loadConnections()) {
      this.configs.set(c.id, c)
      this.states.set(c.id, { state: 'disconnected' })
    }
  }

  protocols(): string[] {
    return supportedProtocols()
  }

  list(): ConnectionView[] {
    return [...this.configs.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((c) => {
        const s = this.states.get(c.id) ?? { state: 'disconnected' as const }
        return toView(c, s.state, s.error)
      })
  }

  getConfig(id: string): ConnectionConfig {
    const config = this.configs.get(id)
    if (!config) throw new Error(`连接不存在：${id}`)
    return config
  }

  /** 供传输引擎创建独立会话：返回含解密密码的完整配置。 */
  createSessionAdapter(id: string): ProtocolAdapter {
    return createAdapter(this.getConfig(id))
  }

  private async persist(): Promise<void> {
    await this.store.saveConnections([...this.configs.values()])
  }

  private emit(config: ConnectionConfig): void {
    const s = this.states.get(config.id) ?? { state: 'disconnected' as const }
    this.hub.broadcast({ type: 'connection', connection: toView(config, s.state, s.error) })
  }

  async upsert(input: ConnectionInput): Promise<ConnectionView> {
    const id = input.id || crypto.randomUUID()
    const previous = this.configs.get(id)
    const config: ConnectionConfig = {
      id,
      name: input.name ?? previous?.name ?? input.host,
      protocol: input.protocol,
      host: input.host,
      port: input.port ?? DEFAULT_PORTS[input.protocol],
      username: input.username,
      // 未传密码时沿用已保存的密码，避免编辑连接时把凭据清掉
      password: input.password !== undefined ? input.password : previous?.password,
      savePassword: input.savePassword ?? previous?.savePassword ?? false,
      basePath: input.basePath ?? previous?.basePath,
      options: { ...(previous?.options ?? {}), ...(input.options ?? {}) },
      createdAt: previous?.createdAt ?? Date.now(),
    }
    if (this.states.get(id)?.state === 'connected') await this.disconnect(id)
    this.configs.set(id, config)
    this.states.set(id, { state: 'disconnected' })
    await this.persist()
    this.emit(config)
    return toView(config, 'disconnected')
  }

  async remove(id: string): Promise<void> {
    await this.disconnect(id)
    this.configs.delete(id)
    this.states.delete(id)
    await this.persist()
  }

  async connect(id: string): Promise<ConnectionView> {
    const config = this.getConfig(id)
    this.states.set(id, { state: 'connecting' })
    this.emit(config)
    let adapter: ProtocolAdapter | null = null
    try {
      adapter = createAdapter(config)
      await adapter.connect()
      this.adapters.set(id, adapter)
      this.states.set(id, { state: 'connected' })
    } catch (err) {
      await adapter?.close().catch(() => undefined)
      const message = err instanceof Error ? err.message : String(err)
      this.states.set(id, { state: 'error', error: message })
      this.emit(config)
      throw err
    }
    this.emit(config)
    return toView(config, 'connected')
  }

  async disconnect(id: string): Promise<void> {
    const adapter = this.adapters.get(id)
    this.adapters.delete(id)
    await adapter?.close().catch(() => undefined)
    const config = this.configs.get(id)
    if (config) {
      this.states.set(id, { state: 'disconnected' })
      this.emit(config)
    }
  }

  private session(id: string): ProtocolAdapter {
    const adapter = this.adapters.get(id)
    if (!adapter) throw new Error('连接尚未建立，请先点击「连接」')
    return adapter
  }

  private scoped(id: string, remotePath: string): string {
    const config = this.getConfig(id)
    const p = normalizeRemotePath(remotePath || config.basePath || '/')
    if (!withinBase(config.basePath, p)) {
      throw new Error('路径超出该连接配置的根目录范围')
    }
    return p
  }

  async browse(id: string, remotePath: string): Promise<RemoteEntry[]> {
    return this.session(id).list(this.scoped(id, remotePath))
  }

  async stat(id: string, remotePath: string): Promise<StatResult> {
    return this.session(id).stat(this.scoped(id, remotePath))
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.adapters.keys()]) await this.disconnect(id)
  }
}

import type { SecretStore } from '../store/secrets'
import { AppStore } from '../store'
import { EventHub } from './event-hub'
import { ConnectionManager } from './connections'
import { TransferEngine } from './transfer-engine'
import { AccessControl } from '../server/access'
import { WebServer } from '../server/http'
import { cleanupStaleSmbState } from '../protocols/smb'

export interface CoreOptions {
  dataDir: string
  staticDir: string
  secretStore: SecretStore
  concurrency?: number
}

/**
 * 核心组装层：不依赖 electron，因此既可由 Electron 主进程启动，
 * 也可由纯 Node CLI 启动（便于本地端到端验证 / 未来的无界面服务版）。
 */
export class TunnelCore {
  readonly store: AppStore
  readonly hub = new EventHub()
  readonly connections: ConnectionManager
  readonly engine: TransferEngine
  readonly access: AccessControl
  readonly server: WebServer

  constructor(private readonly options: CoreOptions) {
    this.store = new AppStore(options.dataDir, options.secretStore)
    this.connections = new ConnectionManager(this.store, this.hub)
    this.engine = new TransferEngine(
      this.store,
      this.connections,
      this.hub,
      options.concurrency ?? 3,
    )
    this.access = new AccessControl(this.store)
    this.server = new WebServer({
      store: this.store,
      connections: this.connections,
      engine: this.engine,
      hub: this.hub,
      access: this.access,
      staticDir: options.staticDir,
      secretStoreLabel: options.secretStore.label,
    })
  }

  async start(): Promise<void> {
    await cleanupStaleSmbState()
    await this.connections.init()
    await this.engine.init()
    await this.server.start()
  }

  async stop(): Promise<void> {
    await this.engine.shutdown()
    await this.connections.shutdown()
    await this.server.stop()
  }

  get token(): string {
    return this.access.localToken
  }

  get endpoint(): { host: string; port: number; lanEnabled: boolean } {
    return this.server.address
  }

  get credentialStore(): SecretStore {
    return this.options.secretStore
  }
}

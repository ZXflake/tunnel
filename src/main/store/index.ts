import type { ConnectionConfig, TransferTask, WebSettings } from '../../shared/types'
import { JsonFile } from './json-file'
import type { SecretStore } from './secrets'

type StoredConnection = Omit<ConnectionConfig, 'password'>

export interface SettingsData {
  lanEnabled: boolean
  port: number
  /** scrypt 派生结果，绝不存明文 */
  passwordHash?: { salt: string; hash: string }
}

export const DEFAULT_PORT = 8787

/** 连接配置、任务状态、Web 设置的本地持久化。密码单独加密存放。 */
export class AppStore {
  private readonly connections: JsonFile<StoredConnection[]>
  private readonly secrets: JsonFile<Record<string, string>>
  private readonly tasks: JsonFile<TransferTask[]>
  private readonly settingsFile: JsonFile<SettingsData>

  constructor(
    private readonly dir: string,
    private readonly secretStore: SecretStore,
  ) {
    this.connections = new JsonFile<StoredConnection[]>(`${dir}/connections.json`, [])
    this.secrets = new JsonFile<Record<string, string>>(`${dir}/secrets.json`, {})
    this.tasks = new JsonFile<TransferTask[]>(`${dir}/tasks.json`, [])
    this.settingsFile = new JsonFile<SettingsData>(`${dir}/settings.json`, {
      lanEnabled: false,
      port: DEFAULT_PORT,
    })
  }

  get dataDir(): string {
    return this.dir
  }

  get credentialStore(): SecretStore {
    return this.secretStore
  }

  async loadConnections(): Promise<ConnectionConfig[]> {
    const [configs, encrypted] = await Promise.all([
      this.connections.read(),
      this.secrets.read(),
    ])
    return Promise.all(
      configs.map(async (c) => {
        const payload = encrypted[c.id]
        let password: string | undefined
        if (payload) {
          password = await this.secretStore.decrypt(payload).catch(() => undefined)
        }
        return { ...c, password } as ConnectionConfig
      }),
    )
  }

  async saveConnections(configs: ConnectionConfig[]): Promise<void> {
    const plain: StoredConnection[] = []
    const encrypted: Record<string, string> = {}
    for (const c of configs) {
      const { password, ...rest } = c
      plain.push(rest)
      if (c.savePassword && password) {
        encrypted[c.id] = await this.secretStore.encrypt(password)
      }
    }
    await Promise.all([this.connections.write(plain), this.secrets.write(encrypted)])
  }

  loadTasks(): Promise<TransferTask[]> {
    return this.tasks.read()
  }

  saveTasks(tasks: TransferTask[]): Promise<void> {
    return this.tasks.write(tasks)
  }

  loadSettings(): Promise<SettingsData> {
    return this.settingsFile.read()
  }

  saveSettings(settings: SettingsData): Promise<void> {
    return this.settingsFile.write(settings)
  }

  async webSettings(): Promise<WebSettings> {
    const s = await this.loadSettings()
    return { lanEnabled: s.lanEnabled, port: s.port, passwordSet: Boolean(s.passwordHash) }
  }
}

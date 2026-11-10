import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import type {
  AdapterCapabilities,
  ConnectionConfig,
  ProtocolAdapter,
  RemoteEntry,
  StatResult,
  ReadOptions,
  WriteOptions,
} from '../../../shared/types'
import { normalizeRemotePath } from '../../../shared/path'

/**
 * Linux NAPI 后端的加载契约。
 *
 * Rust 侧（基于 smb2 crate）只需实现这组方法并导出一个 .node 模块：
 *   native/smb-linux-x64.node、native/smb-linux-arm64.node
 * 由 electron-builder 的 extraResources 随包分发，加载失败不影响 FTP/SFTP。
 *
 * 采用「分块读写」而不是跨语言传递流对象，避免 NAPI/Rust 与 Node stream 生命周期耦合。
 * 返回空 Buffer 表示到达文件末尾。
 * list() 需返回含 createdAt 的 RemoteEntry：SMB2 提供创建时间时填上，否则为 null，不得用 mtime 冒充。
 */
export interface SmbNapiBinding {
  connect(options: {
    host: string
    port: number
    share: string
    username?: string
    password?: string
    domain?: string
    minDialect: string
    timeoutMs: number
  }): Promise<number>
  disconnect(handle: number): Promise<void>
  list(handle: number, remotePath: string): Promise<RemoteEntry[]>
  stat(handle: number, remotePath: string): Promise<StatResult>
  mkdir(handle: number, remotePath: string): Promise<void>
  rename(handle: number, from: string, to: string): Promise<void>
  remove(handle: number, remotePath: string, recursive: boolean): Promise<void>
  read(handle: number, remotePath: string, offset: number, length: number): Promise<Buffer>
  write(handle: number, remotePath: string, offset: number, data: Buffer): Promise<void>
}

const CHUNK_SIZE = 256 * 1024

export function loadNapiBinding(): SmbNapiBinding {
  const filename = `smb-${process.platform}-${process.arch}.node`
  // Electron 主进程注入的 resourcesPath（@types/node 不含该字段）
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const roots = [
    process.env.TUNNEL_NATIVE_DIR,
    // 打包后 extraResources 落在 resources/native
    resourcesPath ? path.join(resourcesPath, 'native') : undefined,
    path.resolve(process.cwd(), 'native'),
    path.resolve(__dirname, '../../../../native'),
    path.resolve(__dirname, '../../../native'),
  ].filter(Boolean) as string[]

  const require = createRequire(__filename)
  for (const root of roots) {
    const file = path.join(root, filename)
    try {
      return require(file) as SmbNapiBinding
    } catch (err) {
      if (fs.existsSync(file)) {
        throw new Error(`SMB 原生模块加载失败（${file}）：${String(err)}`)
      }
    }
  }
  throw new Error(
    `当前安装包缺少 Linux SMB 原生模块（${filename}）。` +
      '请确认该平台的 native 资源已随包分发；FTP / SFTP 功能不受影响。',
  )
}

/** 把 NAPI 绑定包装成统一适配器。上层只看见 ProtocolAdapter，不感知原生实现。 */
export class NapiSmbAdapter implements ProtocolAdapter {
  readonly kind = 'smb' as const
  private readonly config: ConnectionConfig
  private readonly binding: SmbNapiBinding
  private handle = -1
  private closed = false

  constructor(config: ConnectionConfig, binding?: SmbNapiBinding) {
    this.config = config
    this.binding = binding ?? loadNapiBinding()
  }

  async connect(): Promise<void> {
    if (!this.config.options.share) {
      throw new Error('SMB 连接需要填写共享名（share）')
    }
    this.handle = await this.binding.connect({
      host: this.config.host,
      port: this.config.port ?? 445,
      share: this.config.options.share,
      username: this.config.username,
      password: this.config.password,
      domain: this.config.options.domain,
      // 不允许协商降级到 SMB1
      minDialect: this.config.options.minDialect ?? 'SMB2_02',
      timeoutMs: this.config.options.timeoutMs ?? 30_000,
    })
  }

  private h(): number {
    if (this.closed || this.handle < 0) throw new Error('SMB 会话未建立或已关闭')
    return this.handle
  }

  async list(dir: string): Promise<RemoteEntry[]> {
    return this.binding.list(this.h(), normalizeRemotePath(dir))
  }

  async stat(filePath: string): Promise<StatResult> {
    return this.binding.stat(this.h(), normalizeRemotePath(filePath))
  }

  async mkdir(dir: string): Promise<void> {
    await this.binding.mkdir(this.h(), normalizeRemotePath(dir))
  }

  async read(filePath: string, opts: ReadOptions = {}): Promise<Readable> {
    const handle = this.h()
    const target = normalizeRemotePath(filePath)
    let offset = opts.offset ?? 0
    const signal = opts.signal
    return Readable.from(
      (async function* (binding: SmbNapiBinding) {
        while (true) {
          if (signal?.aborted) throw new Error('传输已中止')
          const chunk = await binding.read(handle, target, offset, CHUNK_SIZE)
          if (chunk.length === 0) break
          offset += chunk.length
          yield chunk
        }
      })(this.binding),
    )
  }

  async write(filePath: string, opts: WriteOptions = {}): Promise<Writable> {
    const handle = this.h()
    const target = normalizeRemotePath(filePath)
    let offset = opts.offset ?? 0
    const binding = this.binding
    return new Writable({
      async write(chunk: Buffer, _enc, cb) {
        try {
          await binding.write(handle, target, offset, chunk)
          offset += chunk.length
          cb()
        } catch (err) {
          cb(err as Error)
        }
      },
    })
  }

  async rename(from: string, to: string): Promise<void> {
    await this.binding.rename(this.h(), normalizeRemotePath(from), normalizeRemotePath(to))
  }

  async remove(target: string, recursive = false): Promise<void> {
    await this.binding.remove(this.h(), normalizeRemotePath(target), recursive)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.handle >= 0) await this.binding.disconnect(this.handle).catch(() => undefined)
    this.handle = -1
  }

  capabilities(): AdapterCapabilities {
    return { uploadResume: true, remoteManagement: true }
  }
}

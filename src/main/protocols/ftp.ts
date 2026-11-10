import { Client, FileType } from 'basic-ftp'
import { PassThrough, type Readable, type Writable } from 'node:stream'
import type {
  AdapterCapabilities,
  ConnectionConfig,
  ProtocolAdapter,
  RemoteEntry,
  StatResult,
  ReadOptions,
  WriteOptions,
} from '../../shared/types'
import { joinRemote, normalizeRemotePath, remoteBasename, remoteDirname } from '../../shared/path'

/** FTP / FTPS 适配器。basic-ftp 是 push 模型，这里用 PassThrough 桥接成统一的可读/可写流。 */
export class FtpAdapter implements ProtocolAdapter {
  readonly kind = 'ftp' as const
  private readonly client: Client
  private readonly config: ConnectionConfig
  private uploadResume = false
  private closed = false
  private pendingWrites: Array<Promise<void>> = []

  constructor(config: ConnectionConfig) {
    this.config = config
    this.client = new Client(config.options.timeoutMs ?? 30_000)
    const charset = config.options.charset
    if (charset) this.client.ftp.encoding = charset as typeof this.client.ftp.encoding
  }

  async connect(): Promise<void> {
    const ftps = this.config.options.ftps
    await this.client.access({
      host: this.config.host,
      port: this.config.port ?? (ftps === 'implicit' ? 990 : 21),
      user: this.config.username ?? 'anonymous',
      password: this.config.password ?? 'anonymous@',
      secure: !ftps ? false : ftps === 'implicit' ? 'implicit' : true,
      secureOptions: ftps ? { rejectUnauthorized: false } : undefined,
    })
    if (this.config.options.passive !== false) {
      // basic-ftp 默认被动模式；显式声明便于后续扩展主动模式
      await this.client.send('TYPE I').catch(() => undefined)
    }
    this.uploadResume = await this.detectAppendSupport()
  }

  /** FTP 续传依赖 APPE / REST STREAM；服务器支持度不一，需探测后决定。 */
  private async detectAppendSupport(): Promise<boolean> {
    try {
      const feat = await this.client.send('FEAT')
      const text = String(feat.message ?? '').toUpperCase()
      return text.includes('APPE') || text.includes('REST STREAM')
    } catch {
      return false
    }
  }

  private guard(): void {
    if (this.closed) throw new Error('FTP 连接已关闭')
  }

  async list(dir: string): Promise<RemoteEntry[]> {
    this.guard()
    const target = normalizeRemotePath(dir)
    const infos = await this.client.list(target)
    return infos
      .filter((f) => f.name !== '.' && f.name !== '..')
      .map((f) => ({
        name: f.name,
        path: joinRemote(target, f.name),
        type:
          f.type === FileType.Directory
            ? ('dir' as const)
            : f.type === FileType.File
              ? ('file' as const)
              : f.type === FileType.SymbolicLink
                ? ('link' as const)
                : ('unknown' as const),
        size: f.size ?? 0,
        modifiedAt: f.modifiedAt ? new Date(f.modifiedAt).getTime() : null,
        // FTP LIST / MLSD 不提供创建时间，留空而不拿 mtime 冒充
        createdAt: null,
      }))
  }

  async stat(filePath: string): Promise<StatResult> {
    this.guard()
    const target = normalizeRemotePath(filePath)
    if (target === '/') return { size: 0, modifiedAt: null, isDirectory: true }

    // 不能只靠 SIZE 判断目录：不少服务器（含 ftp-srv）对目录返回 0 且不报错，
    // 会把文件夹误判成 0 字节文件。先列父目录拿到真实类型。
    const entries = await this.list(remoteDirname(target)).catch(() => [] as RemoteEntry[])
    const found = entries.find((e) => e.name === remoteBasename(target))
    if (found?.type === 'dir') {
      return { size: 0, modifiedAt: found.modifiedAt, isDirectory: true }
    }
    try {
      const size = await this.client.size(target)
      const lastMod = await this.client.lastMod(target).catch(() => undefined)
      return {
        size,
        modifiedAt: lastMod ? lastMod.getTime() : (found?.modifiedAt ?? null),
        isDirectory: false,
      }
    } catch {
      // 少数服务器不支持 SIZE / MDTM，退回父目录 LIST 的结果
      if (!found) throw new Error(`远程文件不存在：${target}`)
      return {
        size: found.size,
        modifiedAt: found.modifiedAt,
        // 上面已排除目录类型
        isDirectory: false,
      }
    }
  }

  async mkdir(dir: string): Promise<void> {
    this.guard()
    await this.client.ensureDir(normalizeRemotePath(dir))
  }

  async read(filePath: string, opts: ReadOptions = {}): Promise<Readable> {
    this.guard()
    const target = normalizeRemotePath(filePath)
    const stream = new PassThrough()
    let ended = false
    const finish = () => {
      if (!ended) {
        ended = true
        stream.end()
      }
    }
    stream.on('close', () => {
      ended = true
    })
    const abort = () => {
      stream.destroy(new Error('传输已中止'))
      void this.client.close()
    }
    if (opts.signal) {
      if (opts.signal.aborted) abort()
      else opts.signal.addEventListener('abort', abort, { once: true })
    }
    void this.client
      .downloadTo(stream, target, opts.offset ?? 0)
      .then(finish)
      .catch((err) => {
        if (!ended) stream.destroy(err instanceof Error ? err : new Error(String(err)))
      })
    return stream
  }

  async write(filePath: string, opts: WriteOptions = {}): Promise<Writable> {
    this.guard()
    const target = normalizeRemotePath(filePath)
    const stream = new PassThrough()
    const offset = opts.offset ?? 0
    let ended = false
    stream.on('close', () => {
      ended = true
    })
    const abort = () => {
      stream.destroy(new Error('传输已中止'))
      void this.client.close()
    }
    if (opts.signal) {
      if (opts.signal.aborted) abort()
      else opts.signal.addEventListener('abort', abort, { once: true })
    }
    const task =
      offset > 0
        ? this.client.appendFrom(stream, target) // APPE；不支持时引擎会降级为全量重传
        : this.client.uploadFrom(stream, target)
    void task.catch((err) => {
      if (!ended) stream.destroy(err instanceof Error ? err : new Error(String(err)))
    })
    this.pendingWrites.push(task.then(() => undefined))
    return stream
  }

  /** uploadFrom / appendFrom 在后台执行，必须等它们真正结束才算上传完成。 */
  async flush(): Promise<void> {
    const pending = this.pendingWrites.splice(0)
    await Promise.all(pending)
  }

  async rename(from: string, to: string): Promise<void> {
    this.guard()
    await this.client.rename(normalizeRemotePath(from), normalizeRemotePath(to))
  }

  async remove(target: string, recursive = false): Promise<void> {
    this.guard()
    const p = normalizeRemotePath(target)
    const s = await this.stat(p).catch(() => null)
    // basic-ftp 的 removeDir 本身是递归删除；非递归场景先检查目录是否为空
    if (s?.isDirectory) {
      if (!recursive && (await this.list(p)).length > 0) {
        throw new Error('目录非空，需要递归删除')
      }
      await this.client.removeDir(p)
    } else await this.client.remove(p)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.client.close()
  }

  capabilities(): AdapterCapabilities {
    return { uploadResume: this.uploadResume, remoteManagement: true }
  }
}

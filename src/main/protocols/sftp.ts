import { Client, type SFTPWrapper, type Stats } from 'ssh2'
import type { Readable, Writable } from 'node:stream'
import type {
  AdapterCapabilities,
  ConnectionConfig,
  ProtocolAdapter,
  RemoteEntry,
  StatResult,
  ReadOptions,
  WriteOptions,
} from '../../shared/types'
import { joinRemote, normalizeRemotePath } from '../../shared/path'

function fromStats(name: string, fullPath: string, attrs: Stats): RemoteEntry {
  return {
    name,
    path: fullPath,
    type: attrs.isDirectory()
      ? 'dir'
      : attrs.isSymbolicLink()
        ? 'link'
        : attrs.isFile()
          ? 'file'
          : 'unknown',
    size: Number(attrs.size ?? 0),
    modifiedAt: attrs.mtime ? Number(attrs.mtime) * 1000 : null,
    // SFTP Stats 只有 atime / mtime，没有创建时间
    createdAt: null,
  }
}

/** SFTP 适配器（ssh2）。原生支持 offset 读写，因此下载/上传续传都可靠。 */
export class SftpAdapter implements ProtocolAdapter {
  readonly kind = 'sftp' as const
  private readonly config: ConnectionConfig
  private readonly client: Client
  private sftp: SFTPWrapper | null = null
  private closed = false

  constructor(config: ConnectionConfig) {
    this.config = config
    this.client = new Client()
  }

  async connect(): Promise<void> {
    const opts = this.config.options
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err)
      this.client.once('error', onError)
      this.client.once('ready', () => {
        this.client.removeListener('error', onError)
        resolve()
      })
      this.client.connect({
        host: this.config.host,
        port: this.config.port ?? 22,
        username: this.config.username,
        password: this.config.password,
        privateKey: opts.privateKey,
        passphrase: opts.passphrase,
        readyTimeout: opts.timeoutMs ?? 20_000,
        keepaliveInterval: 15_000,
      })
    })
    this.sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      this.client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)))
    })
  }

  private sftpOrThrow(): SFTPWrapper {
    if (this.closed || !this.sftp) throw new Error('SFTP 会话未建立或已关闭')
    return this.sftp
  }

  async list(dir: string): Promise<RemoteEntry[]> {
    const sftp = this.sftpOrThrow()
    const target = normalizeRemotePath(dir)
    const entries = await new Promise<
      Array<{ filename: string; longname: string; attrs: Stats }>
    >((resolve, reject) => {
      sftp.readdir(target, (err, list) => (err ? reject(err) : resolve(list)))
    })
    return entries
      .filter((e) => e.filename !== '.' && e.filename !== '..')
      .map((e) => fromStats(e.filename, joinRemote(target, e.filename), e.attrs))
  }

  async stat(filePath: string): Promise<StatResult> {
    const sftp = this.sftpOrThrow()
    const attrs = await new Promise<Stats>((resolve, reject) => {
      sftp.stat(normalizeRemotePath(filePath), (err, stats) =>
        err ? reject(err) : resolve(stats),
      )
    })
    return {
      size: Number(attrs.size ?? 0),
      modifiedAt: attrs.mtime ? Number(attrs.mtime) * 1000 : null,
      isDirectory: attrs.isDirectory(),
    }
  }

  async mkdir(dir: string): Promise<void> {
    const sftp = this.sftpOrThrow()
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(normalizeRemotePath(dir), (err) => (err ? reject(err) : resolve()))
    })
  }

  async read(filePath: string, opts: ReadOptions = {}): Promise<Readable> {
    const sftp = this.sftpOrThrow()
    const stream = sftp.createReadStream(normalizeRemotePath(filePath), {
      start: opts.offset ?? 0,
      autoClose: true,
    })
    if (opts.signal) {
      const onAbort = () => stream.destroy(new Error('传输已中止'))
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }
    return stream
  }

  async write(filePath: string, opts: WriteOptions = {}): Promise<Writable> {
    const sftp = this.sftpOrThrow()
    const offset = opts.offset ?? 0
    const stream = sftp.createWriteStream(normalizeRemotePath(filePath), {
      flags: offset > 0 ? 'r+' : 'w',
      start: offset,
      autoClose: true,
    }) as unknown as Writable
    if (opts.signal) {
      const onAbort = () => stream.destroy(new Error('传输已中止'))
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }
    return stream
  }

  async rename(from: string, to: string): Promise<void> {
    const sftp = this.sftpOrThrow()
    await new Promise<void>((resolve, reject) => {
      sftp.rename(normalizeRemotePath(from), normalizeRemotePath(to), (err) =>
        err ? reject(err) : resolve(),
      )
    })
  }

  async remove(target: string, recursive = false): Promise<void> {
    const sftp = this.sftpOrThrow()
    const p = normalizeRemotePath(target)
    const s = await this.stat(p)
    if (s.isDirectory) {
      if (recursive) {
        const children = await this.list(p)
        for (const child of children) await this.remove(child.path, true)
      }
      await new Promise<void>((resolve, reject) => {
        sftp.rmdir(p, (err) => (err ? reject(err) : resolve()))
      })
    } else {
      await new Promise<void>((resolve, reject) => {
        sftp.unlink(p, (err) => (err ? reject(err) : resolve()))
      })
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.sftp?.end()
    this.client.end()
  }

  capabilities(): AdapterCapabilities {
    return { uploadResume: true, remoteManagement: true }
  }
}

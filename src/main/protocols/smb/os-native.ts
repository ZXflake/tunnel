import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
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

function dataDir(): string {
  return process.env.TUNNEL_DATA_DIR || path.join(os.homedir(), '.tunnel')
}

function mountRoot(connectionId: string): string {
  return path.join(dataDir(), 'mounts', connectionId)
}

function uncRoot(config: ConnectionConfig): string {
  const share = config.options.share
  if (!share) throw new Error('SMB 连接需要填写共享名（share）')
  return `\\\\${config.host}\\${share}`
}

function run(
  command: string,
  args: string[],
  opts: { stdin?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: opts.env,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 30_000)
    child.stdout?.on('data', (c) => (stdout += String(c)))
    child.stderr?.on('data', (c) => (stderr += String(c)))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(`${command} 退出码 ${code}：${(stderr || stdout).trim()}`))
    })
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin)
      child.stdin.end()
    } else {
      child.stdin.end()
    }
  })
}

/**
 * Windows / macOS 的 SMB 后端：把共享映射成本地路径，之后所有操作都是普通 fs 读写。
 * 断点续传因此退化为 createReadStream({start}) / createWriteStream({start})。
 * 挂载、卸载、临时凭据清理全部由应用内完成，用户无需提前挂载、无需盘符、无需管理员权限。
 */
export class OsNativeSmbAdapter implements ProtocolAdapter {
  readonly kind = 'smb' as const
  private readonly config: ConnectionConfig
  private localRoot = ''
  private createdSession = false
  private tempCredentialFile: string | null = null
  private closed = false

  constructor(config: ConnectionConfig) {
    this.config = config
  }

  async connect(): Promise<void> {
    if (process.platform === 'win32') await this.connectWindows()
    else if (process.platform === 'darwin') await this.connectMac()
    else throw new Error('OS 原生 SMB 后端仅用于 Windows / macOS，Linux 请使用 NAPI 后端')
    // 校验挂载/共享可访问
    await fs.access(this.localRoot).catch(() => {
      throw new Error(`SMB 共享不可访问：${this.localRoot}`)
    })
  }

  private async connectWindows(): Promise<void> {
    const root = uncRoot(this.config)
    this.localRoot = root
    if (!this.config.username || !this.config.password) {
      // 用当前登录凭据直连 UNC，无需建会话
      return
    }
    const user = this.config.options.domain
      ? `${this.config.options.domain}\\${this.config.username}`
      : this.config.username
    // 密码从 stdin 传入，绝不拼进命令行（否则会出现在进程列表里）
    await run('net', ['use', root, `/user:${user}`, '*', '/persistent:no'], {
      stdin: `${this.config.password}\n`,
      timeoutMs: this.config.options.timeoutMs ?? 30_000,
    }).catch((err: Error) => {
      if (/1219|1326|multiple connections/i.test(err.message)) {
        throw new Error(
          'Windows 已存在到该服务器的其他凭据会话（错误 1219）。' +
            '请断开资源管理器中的连接，或改用 IP / DNS 别名，或复用当前登录凭据。',
        )
      }
      throw err
    })
    this.createdSession = true
  }

  private async connectMac(): Promise<void> {
    const target = mountRoot(this.config.id)
    await fs.mkdir(target, { recursive: true })
    this.localRoot = target

    const user = this.config.username ?? 'guest'
    const share = this.config.options.share
    if (!share) throw new Error('SMB 连接需要填写共享名（share）')
    const remote = `//${encodeURIComponent(user)}@${this.config.host}/${share}`

    // -N：不弹交互提示，密码由 600 权限的临时 nsmb.conf 提供（用完即删）
    let confDir: string | null = null
    let env = process.env
    if (this.config.password) {
      confDir = path.join(dataDir(), 'nsmb', this.config.id)
      await fs.mkdir(confDir, { recursive: true })
      const confPath = path.join(confDir, 'Library', 'Preferences', 'nsmb.conf')
      await fs.mkdir(path.dirname(confPath), { recursive: true })
      await fs.writeFile(
        confPath,
        `[default]\nminauth=none\n\n[${this.config.host.toUpperCase()}:${user.toUpperCase()}]\npassword=${this.config.password}\n`,
        { mode: 0o600 },
      )
      this.tempCredentialFile = confPath
      env = { ...process.env, HOME: confDir }
    }

    try {
      await run('mount_smbfs', ['-N', '-o', 'nosuid,nodev', remote, target], {
        env,
        timeoutMs: this.config.options.timeoutMs ?? 30_000,
      })
    } catch (err) {
      await this.cleanup()
      throw new Error(`挂载 SMB 共享失败：${String(err)}`)
    }
    this.createdSession = true
  }

  private toLocal(remotePath: string): string {
    const rel = normalizeRemotePath(remotePath).replace(/^\/+/, '')
    if (process.platform === 'win32') {
      return path.win32.join(this.localRoot, rel.replace(/\//g, '\\'))
    }
    return path.join(this.localRoot, rel)
  }

  async list(dir: string): Promise<RemoteEntry[]> {
    const local = this.toLocal(dir)
    const items = await fs.readdir(local, { withFileTypes: true })
    return Promise.all(
      items.map(async (item) => {
        const full = path.join(local, item.name)
        const st = await fs.stat(full).catch(() => null)
        return {
          name: item.name,
          path: normalizeRemotePath(`${dir}/${item.name}`),
          type: item.isDirectory()
            ? ('dir' as const)
            : item.isSymbolicLink()
              ? ('link' as const)
              : item.isFile()
                ? ('file' as const)
                : ('unknown' as const),
          size: st?.size ?? 0,
          modifiedAt: st ? st.mtimeMs : null,
          // 本地文件系统挂载点能提供 birthtimeMs；部分系统返回 0 时视为未知
          createdAt: st && st.birthtimeMs > 0 ? st.birthtimeMs : null,
        }
      }),
    )
  }

  async stat(filePath: string): Promise<StatResult> {
    const st = await fs.stat(this.toLocal(filePath))
    return { size: st.size, modifiedAt: st.mtimeMs, isDirectory: st.isDirectory() }
  }

  async mkdir(dir: string): Promise<void> {
    await fs.mkdir(this.toLocal(dir), { recursive: true })
  }

  async read(filePath: string, opts: ReadOptions = {}): Promise<Readable> {
    const stream = (await import('node:fs')).createReadStream(this.toLocal(filePath), {
      start: opts.offset ?? 0,
    })
    if (opts.signal) {
      const onAbort = () => stream.destroy(new Error('传输已中止'))
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }
    return stream
  }

  async write(filePath: string, opts: WriteOptions = {}): Promise<Writable> {
    const offset = opts.offset ?? 0
    const stream = (await import('node:fs')).createWriteStream(this.toLocal(filePath), {
      flags: offset > 0 ? 'r+' : 'w',
      start: offset,
    })
    if (opts.signal) {
      const onAbort = () => stream.destroy(new Error('传输已中止'))
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }
    return stream
  }

  async rename(from: string, to: string): Promise<void> {
    await fs.rename(this.toLocal(from), this.toLocal(to))
  }

  async remove(target: string, recursive = false): Promise<void> {
    await fs.rm(this.toLocal(target), { recursive, force: false })
  }

  private async cleanup(): Promise<void> {
    if (this.tempCredentialFile) {
      await fs.rm(this.tempCredentialFile, { force: true }).catch(() => undefined)
      this.tempCredentialFile = null
    }
    if (process.platform === 'darwin' && this.createdSession) {
      await run('umount', [this.localRoot]).catch(() => undefined)
      await fs.rmdir(this.localRoot).catch(() => undefined)
    }
    if (process.platform === 'win32' && this.createdSession) {
      await run('net', ['use', this.localRoot, '/delete', '/y']).catch(() => undefined)
    }
    this.createdSession = false
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.cleanup()
  }

  capabilities(): AdapterCapabilities {
    return { uploadResume: true, remoteManagement: true }
  }
}

/** 启动时清理上次崩溃残留的 macOS 挂载点与临时凭据文件。 */
export async function cleanupStaleSmbState(): Promise<void> {
  if (process.platform !== 'darwin') return
  const root = path.join(dataDir(), 'mounts')
  const dirs = await fs.readdir(root).catch(() => [] as string[])
  for (const dir of dirs) {
    const mp = path.join(root, dir)
    await run('umount', [mp]).catch(() => undefined)
    await fs.rmdir(mp).catch(() => undefined)
  }
  await fs.rm(path.join(dataDir(), 'nsmb'), { recursive: true, force: true }).catch(() => undefined)
}

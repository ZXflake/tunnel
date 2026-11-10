import crypto from 'node:crypto'
import os from 'node:os'
import { promisify } from 'node:util'
import type { IncomingMessage } from 'node:http'
import type { AppStore, SettingsData } from '../store'

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>

const SESSION_TTL = 12 * 60 * 60 * 1000
const MAX_FAILURES = 5
const LOCK_MS = 60_000

/** 先哈希成定长再比较，避免 timingSafeEqual 的长度异常与长度侧信道。 */
function constantTimeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest()
  const hb = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(ha, hb)
}

export function lanAddresses(): string[] {
  const result: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal) result.push(item.address)
    }
  }
  return result
}

/**
 * 访问策略：默认仅 127.0.0.1；局域网需手动开启且必须设置密码。
 * - 本机客户端：启动时注入的一次性 localToken 免登录
 * - 外部访问：密码登录换取短期 session token，WebSocket 同样校验
 * - Host / Origin 白名单防 DNS rebinding 与 CSRF
 */
export class AccessControl {
  /** 每次启动随机生成，仅注入桌面客户端 */
  readonly localToken = crypto.randomBytes(32).toString('hex')
  private sessions = new Map<string, number>()
  private failures = new Map<string, { count: number; until: number }>()

  constructor(private readonly store: AppStore) {}

  private async settings(): Promise<SettingsData> {
    return this.store.loadSettings()
  }

  private allowedHosts(lanEnabled: boolean): Set<string> {
    const hosts = new Set([
      'localhost',
      '127.0.0.1',
      '::1',
      '[::1]',
      os.hostname().toLowerCase(),
    ])
    if (lanEnabled) {
      for (const ip of lanAddresses()) hosts.add(ip)
      hosts.add(`${os.hostname().toLowerCase()}.local`)
    }
    return hosts
  }

  /** 拒绝用任意域名指向本机（DNS rebinding），只放行白名单 Host。 */
  validateHost(req: IncomingMessage, lanEnabled: boolean): boolean {
    const raw = req.headers.host
    if (!raw) return false
    let host = raw.toLowerCase()
    if (host.startsWith('[')) host = host.slice(1, host.indexOf(']'))
    else host = host.split(':')[0]
    return this.allowedHosts(lanEnabled).has(host)
  }

  validateOrigin(req: IncomingMessage, lanEnabled: boolean): boolean {
    const origin = req.headers.origin
    if (!origin) return true // curl / 无 Origin 的本机调用由 Host 校验兜底
    try {
      const host = new URL(origin).hostname.toLowerCase()
      return this.allowedHosts(lanEnabled).has(host)
    } catch {
      return false
    }
  }

  isLoopback(req: IncomingMessage): boolean {
    const addr = req.socket.remoteAddress ?? ''
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  }

  private bearer(req: IncomingMessage): string | null {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) return null
    return header.slice(7).trim() || null
  }

  /** 浏览器 WebSocket API 无法设置自定义头，因此 WS 用 ?token= 传递同一凭据。 */
  authenticateToken(token: string | null, loopback: boolean): boolean {
    if (!token) return false
    if (constantTimeEqual(token, this.localToken) && loopback) return true
    const expires = this.sessions.get(token)
    if (expires && expires > Date.now()) return true
    this.sessions.delete(token)
    return false
  }

  /** 校验请求是否携带有效凭据；本机允许 localToken，外部只认 session token。 */
  authenticate(req: IncomingMessage): boolean {
    return this.authenticateToken(this.bearer(req), this.isLoopback(req))
  }

  async setPassword(plain: string): Promise<void> {
    if (plain.length < 8) throw new Error('访问密码至少 8 位')
    const salt = crypto.randomBytes(16).toString('hex')
    const derived = await scrypt(plain, salt, 64)
    const settings = await this.settings()
    await this.store.saveSettings({
      ...settings,
      passwordHash: { salt, hash: derived.toString('hex') },
    })
  }

  async login(plain: string, clientIp: string): Promise<string> {
    const now = Date.now()
    const state = this.failures.get(clientIp)
    if (state?.until && state.until > now) {
      throw new Error('尝试次数过多，请稍后再试')
    }
    const settings = await this.settings()
    if (!settings.passwordHash) throw new Error('尚未设置 Web 访问密码')
    const derived = await scrypt(plain, settings.passwordHash.salt, 64)
    const expected = Buffer.from(settings.passwordHash.hash, 'hex')
    const ok =
      derived.length === expected.length && crypto.timingSafeEqual(derived, expected)
    if (!ok) {
      const count = (state?.count ?? 0) + 1
      this.failures.set(clientIp, {
        count,
        until: count >= MAX_FAILURES ? now + LOCK_MS : 0,
      })
      throw new Error('密码错误')
    }
    this.failures.delete(clientIp)
    const token = crypto.randomBytes(32).toString('hex')
    this.sessions.set(token, now + SESSION_TTL)
    return token
  }
}

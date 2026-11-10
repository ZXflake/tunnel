import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/** 凭据加密抽象：Electron 用系统钥匙串，纯 Node CLI 用本地密钥（仅开发用途）。 */
export interface SecretStore {
  readonly label: string
  readonly secure: boolean
  encrypt(plain: string): Promise<string>
  decrypt(payload: string): Promise<string>
}

/** safeStorage 由 Electron 侧注入 encryptString/decryptString，避免 core 依赖 electron 模块。 */
export class SafeStorageSecretStore implements SecretStore {
  readonly label = '系统安全存储（safeStorage）'
  readonly secure = true

  constructor(
    private readonly impl: {
      isEncryptionAvailable(): boolean
      encryptString(s: string): Buffer
      decryptString(b: Buffer): string
    },
  ) {
    // Electron safeStorage 的方法名是 isEncryptionAvailable，不是 isAvailable。
    // 名字写错会抛 TypeError 并被上层 catch 吞掉，导致凭据静默降级成本地密钥。
    if (typeof impl.isEncryptionAvailable !== 'function' || !impl.isEncryptionAvailable()) {
      throw new Error('当前系统的安全存储不可用（Linux 可能缺少 libsecret / keyring）')
    }
  }

  async encrypt(plain: string): Promise<string> {
    return this.impl.encryptString(plain).toString('base64')
  }

  async decrypt(payload: string): Promise<string> {
    return this.impl.decryptString(Buffer.from(payload, 'base64'))
  }
}

/**
 * 开发/CLI 模式下的降级实现：AES-256-GCM + 本地密钥文件。
 * 明确不是系统级保护，仅用于不启动 Electron 的本地调试，不外发。
 */
export class DevSecretStore implements SecretStore {
  readonly label = '开发模式本地密钥（非系统钥匙串）'
  readonly secure = false
  private keyPromise: Promise<Buffer>

  constructor(private readonly dir: string) {
    this.keyPromise = this.loadKey()
  }

  private async loadKey(): Promise<Buffer> {
    const file = path.join(this.dir, '.dev-key')
    try {
      return await fs.readFile(file)
    } catch {
      const key = crypto.randomBytes(32)
      await fs.mkdir(this.dir, { recursive: true })
      await fs.writeFile(file, key, { mode: 0o600 })
      return key
    }
  }

  async encrypt(plain: string): Promise<string> {
    const key = await this.keyPromise
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(
      ':',
    )
  }

  async decrypt(payload: string): Promise<string> {
    const key = await this.keyPromise
    const [iv, tag, data] = payload.split(':')
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  }
}

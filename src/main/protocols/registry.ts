import type { ConnectionConfig, ProtocolAdapter, ProtocolKind } from '../../shared/types'
import { FtpAdapter } from './ftp'
import { SftpAdapter } from './sftp'
import { createSmbAdapter } from './smb'

/**
 * 协议工厂：新增协议 = 实现 ProtocolAdapter + 在下方注册一行。
 * 传输引擎 / Web API / UI 不感知具体协议。
 */
export type AdapterFactory = (config: ConnectionConfig) => ProtocolAdapter

const factories = new Map<ProtocolKind, AdapterFactory>()

export function registerProtocol(kind: ProtocolKind, factory: AdapterFactory): void {
  factories.set(kind, factory)
}

export function createAdapter(config: ConnectionConfig): ProtocolAdapter {
  const factory = factories.get(config.protocol)
  if (!factory) {
    throw new Error(`未注册的协议类型：${config.protocol}`)
  }
  return factory(config)
}

export function supportedProtocols(): ProtocolKind[] {
  return [...factories.keys()]
}

registerProtocol('ftp', (config) => new FtpAdapter(config))
registerProtocol('sftp', (config) => new SftpAdapter(config))
registerProtocol('smb', (config) => createSmbAdapter(config))

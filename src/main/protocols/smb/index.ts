import type { ConnectionConfig, ProtocolAdapter } from '../../../shared/types'
import { OsNativeSmbAdapter, cleanupStaleSmbState } from './os-native'
import { NapiSmbAdapter } from './napi'

/**
 * SMB 按平台分派后端，差异完全封闭在适配器内部：
 *   Windows / macOS → OS 原生（零额外依赖）
 *   Linux           → 随包分发的 NAPI 原生模块（不依赖 GVfs / D-Bus / root）
 * 上层看到的始终是同一个 ProtocolAdapter 接口。
 */
export function createSmbAdapter(config: ConnectionConfig): ProtocolAdapter {
  switch (process.platform) {
    case 'win32':
    case 'darwin':
      return new OsNativeSmbAdapter(config)
    case 'linux':
      return new NapiSmbAdapter(config)
    default:
      throw new Error(`不支持的操作系统：${process.platform}`)
  }
}

export { cleanupStaleSmbState }
export { NapiSmbAdapter, type SmbNapiBinding } from './napi'
export { OsNativeSmbAdapter } from './os-native'

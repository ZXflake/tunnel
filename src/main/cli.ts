import os from 'node:os'
import path from 'node:path'
import { DevSecretStore } from './store/secrets'
import { TunnelCore } from './core'
import { lanAddresses } from './server/access'

/**
 * 纯 Node 启动入口：不启动 Electron 也能跑完整后端 + Web UI。
 * 用途：本地开发、端到端自测、以及未来的无界面服务版。
 * 注意：此模式用本地密钥加密凭据，不是系统钥匙串；正式桌面版请用 Electron 入口。
 */
async function main(): Promise<void> {
  const dataDir = process.env.TUNNEL_DATA_DIR || path.join(os.homedir(), '.tunnel')
  const staticDir =
    process.env.TUNNEL_STATIC_DIR || path.resolve(process.cwd(), 'dist/renderer')
  process.env.TUNNEL_DATA_DIR = dataDir

  const core = new TunnelCore({
    dataDir,
    staticDir,
    secretStore: new DevSecretStore(dataDir),
  })
  await core.start()

  const { port, lanEnabled } = core.endpoint
  console.log('\n  Tunnel 核心服务已启动')
  console.log(`  桌面 / 本机访问 : http://127.0.0.1:${port}`)
  if (lanEnabled) {
    for (const ip of lanAddresses()) console.log(`  局域网访问      : http://${ip}:${port}`)
  }
  console.log(`  本机一次性 token: ${core.token}`)
  console.log(`  数据目录        : ${dataDir}`)
  console.log(`  凭据存储        : ${core.credentialStore.label}`)
  console.log('  浏览器打开上面地址，在登录页「本机一次性 token」处粘贴该 token 即可\n')

  const shutdown = async () => {
    await core.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

void main().catch((err) => {
  console.error('启动失败：', err)
  process.exit(1)
})

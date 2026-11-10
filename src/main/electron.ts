import path from 'node:path'
import { TunnelCore } from './core'
import { DevSecretStore, SafeStorageSecretStore, type SecretStore } from './store/secrets'

// 动态加载：core / cli 不依赖 electron，纯 Node 环境也能直接跑。
// 桌面端启动前由 scripts/ensure-electron.mjs 保证 electron 包与运行时二进制都已就绪。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const electron = require('electron') as any

const TRAY_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

async function main(): Promise<void> {
  const { app, BrowserWindow, ipcMain, dialog, safeStorage, Tray, Menu, nativeImage } = electron
  await app.whenReady()

  const userData = app.getPath('userData')
  process.env.TUNNEL_DATA_DIR = userData

  let secretStore: SecretStore
  try {
    secretStore = new SafeStorageSecretStore(safeStorage)
  } catch (err) {
    // Linux 缺 libsecret / keyring 时降级，并在界面上给出提示
    console.warn('[tunnel] 系统安全存储不可用，已降级：', err)
    secretStore = new DevSecretStore(userData)
  }

  // dist/main/main/electron.js → dist/renderer
  const staticDir = path.resolve(__dirname, '../../renderer')
  const core = new TunnelCore({ dataDir: userData, staticDir, secretStore })
  await core.start()

  // IPC 只保留桌面专属能力；业务数据一律走 HTTP/WS
  ipcMain.handle('auth:token', () => core.token)
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    dataDir: userData,
    credentialStore: secretStore.label,
    credentialStoreSecure: secretStore.secure,
  }))
  ipcMain.handle('dialog:select-directory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    title: 'Tunnel · 文件传输器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win.loadURL(`http://127.0.0.1:${core.endpoint.port}`)

  let quitting = false
  app.on('before-quit', () => {
    quitting = true
    void core.stop()
  })
  win.on('close', (event: { preventDefault: () => void }) => {
    if (!quitting) {
      // 关窗不等于退出：桌面端保持运行，手机 Web 端才可用
      event.preventDefault()
      win.hide()
    }
  })

  try {
    const tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON))
    tray.setToolTip('Tunnel · 本地文件传输服务')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示主界面', click: () => win.show() },
        { label: '退出 Tunnel', click: () => app.quit() },
      ]),
    )
  } catch (err) {
    console.warn('[tunnel] 托盘不可用：', err)
  }

  app.on('activate', () => win.show())
  // 不监听 window-all-closed：服务需要常驻，退出只能靠托盘菜单
}

void main().catch((err) => {
  console.error('[tunnel] 启动失败：', err)
  electron.app.quit()
})

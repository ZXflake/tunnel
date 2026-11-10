// 启动 Electron 桌面端，并清理会破坏运行模式的环境变量。
//
// 从另一个 Electron 宿主（WorkBuddy / VS Code 等）派生的终端常带有
// ELECTRON_RUN_AS_NODE=1。继承它时 Electron 会退化成纯 Node 进程：
// 主进程里 require('electron') 拿到的是可执行路径字符串而非模块对象，
// 于是 app.whenReady() 抛 "Cannot read properties of undefined"。
// 这里显式剔除该变量，保证始终以 GUI 应用模式启动。
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const binary = require('electron')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const args = process.argv.slice(2)
// 受限环境（CI / 容器 / 外层沙箱）里 Chromium 无法创建自己的沙箱，
// GPU 与 network service 会反复崩溃。仅显式 opt-in 时关闭，正常桌面运行不要开启：
//   TUNNEL_ELECTRON_NO_SANDBOX=1 npm run dev:electron
if (env.TUNNEL_ELECTRON_NO_SANDBOX === '1') {
  args.unshift('--no-sandbox', '--disable-gpu')
  console.warn('[dev:electron] 已在显式 opt-in 下关闭 Chromium 沙箱与 GPU，请勿用于日常使用')
}

const child = spawn(binary, args, {
  stdio: 'inherit',
  env,
  windowsHide: false,
})

child.on('error', (err) => {
  console.error('[dev:electron] 无法启动 Electron：', err)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})

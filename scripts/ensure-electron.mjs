// dev:electron 的前置检查：Electron 的 npm 包与二进制是两回事。
// 包存在但二进制（dist/ + path.txt）没下载完时，直接跑 electron 只会得到
// "sh: electron: command not found"，这里给出可操作的原因与修复命令。
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

function fail(reason) {
  console.error(`\n[dev:electron] ${reason}`)
  console.error('请在项目根目录执行：npm install')
  console.error('项目 .npmrc 已把 Electron 二进制指向 npmmirror 镜像；若仍超时，请检查网络代理。')
  console.error('只想跑纯 Node 核心服务（不开桌面窗口）时，用 npm run dev:core 即可。\n')
  process.exit(1)
}

let pkgPath
try {
  pkgPath = require.resolve('electron/package.json')
} catch {
  fail('未找到 electron 依赖包')
}

const root = path.dirname(pkgPath)
if (!existsSync(path.join(root, 'dist')) || !existsSync(path.join(root, 'path.txt'))) {
  fail('electron 依赖包已安装，但运行时二进制未下载完整（缺少 dist/ 或 path.txt）')
}

const version = require(pkgPath).version
console.log(`[dev:electron] Electron ${version} 运行时就绪`)

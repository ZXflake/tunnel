/**
 * 端到端自测：本地起一个临时 FTP 服务器 + 纯 Node 核心服务，
 * 走真实 HTTP/WS API 验证「连接 → 浏览 → 下载 → 断点续传 → 暂停 → 认证」。
 * 运行：npm run test:e2e（需先 npm run build:web 生成前端产物）
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const FtpSrv = require('ftp-srv')
const WebSocket = require('ws')

import { TunnelCore } from '../src/main/core'
import { DevSecretStore } from '../src/main/store/secrets'
import type { ConnectionView, TransferTask } from '../src/shared/types'
import {
  DEFAULT_LAYOUT,
  LAYOUT_LIMITS,
  LAYOUT_STORAGE_KEY,
  clampQueueHeight,
  clampSidebarWidth,
  loadLayoutPrefs,
  saveLayoutPrefs,
  type KeyValueStore,
  type LayoutPrefs,
} from '../src/renderer/layout'
import {
  ALL_COLUMNS,
  BROWSER_LIMITS,
  BROWSER_STORAGE_KEY,
  COLUMN_LIMITS,
  DEFAULT_BROWSER_PREFS,
  DEFAULT_COLUMN_WIDTHS,
  DEFAULT_VISIBLE_COLUMNS,
  clampBrowserRatio,
  clampColumnWidth,
  columnsForNarrow,
  fitColumnWidths,
  gridTemplateColumns,
  leftPaneWidth,
  loadBrowserPrefs,
  normalizeVisibleColumns,
  saveBrowserPrefs,
  type BrowserPrefs,
  type ColumnKey,
} from '../src/renderer/browser-layout'
import {
  connectionIdentityKey,
  nextRemotePath,
} from '../src/renderer/browser-path'

const FTP_PORT = 22121
const WEB_PORT = 18787
const PASSWORD = 'e2e-test-password'

let passed = 0
let failed = 0
function check(ok: boolean, label: string, detail = ''): void {
  if (ok) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')

async function findPartFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await findPartFiles(full)))
    else if (full.endsWith('.part')) out.push(full)
  }
  return out
}

async function main(): Promise<void> {
  // 每次用唯一目录，避免上轮残留文件触发同名自动重命名策略而读到旧文件
  const tmp = path.resolve(process.cwd(), `.tunnel-e2e-${crypto.randomBytes(4).toString('hex')}`)
  await fsp.mkdir(tmp, { recursive: true })
  // 上传展开的本地样本必须落在允许读盘的白名单内（主目录 / 临时目录）
  const uploadSrc = path.join(os.tmpdir(), `tunnel-e2e-upload-${crypto.randomBytes(4).toString('hex')}`)
  const remoteRoot = path.join(tmp, 'remote')
  const localRoot = path.join(tmp, 'local')
  const dataDir = path.join(tmp, 'data')
  for (const dir of [remoteRoot, localRoot, dataDir]) await fsp.mkdir(dir, { recursive: true })

  const hello = Buffer.from('hello tunnel!\n中文文件名测试\n')
  const big = crypto.randomBytes(6 * 1024 * 1024)
  await fsp.writeFile(path.join(remoteRoot, 'hello.txt'), hello)
  await fsp.writeFile(path.join(remoteRoot, 'big.bin'), big)
  // 目录递归展开用的样本（含一层子目录）
  await fsp.mkdir(path.join(remoteRoot, 'dir', 'sub'), { recursive: true })
  await fsp.writeFile(path.join(remoteRoot, 'dir', 'a.txt'), Buffer.from('AAA'))
  await fsp.writeFile(path.join(remoteRoot, 'dir', 'sub', 'b.txt'), Buffer.from('BBB'))
  await fsp.writeFile(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({ lanEnabled: false, port: WEB_PORT }),
  )
  process.env.TUNNEL_DATA_DIR = dataDir

  const ftp = new FtpSrv({
    url: `ftp://127.0.0.1:${FTP_PORT}`,
    anonymous: true,
    pasv_url: '127.0.0.1',
    pasv_min: 22300,
    pasv_max: 22340,
  })
  ftp.on('login', (_data: unknown, resolve: (v: unknown) => void) => resolve({ root: remoteRoot }))
  await ftp.listen()

  const core = new TunnelCore({
    dataDir,
    staticDir: path.resolve(process.cwd(), 'dist/renderer'),
    secretStore: new DevSecretStore(dataDir),
  })

  try {
    await core.start()
    const base = `http://127.0.0.1:${WEB_PORT}`
    const token = core.token

    const req = async <T>(
      p: string,
      init: RequestInit = {},
      withAuth = true,
    ): Promise<{ status: number; data: T }> => {
      const res = await fetch(base + p, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(withAuth ? { Authorization: `Bearer ${token}` } : {}),
          ...(init.headers ?? {}),
        },
      })
      const text = await res.text()
      let data: T
      try {
        data = text ? (JSON.parse(text) as T) : (null as T)
      } catch {
        data = text as T
      }
      return { status: res.status, data }
    }

    console.log('\n[1] 服务与访问认证')
    const health = await req<{ ok: boolean }>('/api/health', {}, false)
    check(health.status === 200 && health.data.ok === true, '健康检查可匿名访问')
    const denied = await req('/api/connections', {}, false)
    check(denied.status === 401, '未授权的业务接口返回 401')
    const bootstrap = await req<{ protocols: string[]; platform: string }>('/api/bootstrap')
    check(
      bootstrap.status === 200 && bootstrap.data.protocols.includes('ftp'),
      'bootstrap 返回协议注册表',
    )
    const spa = await fetch(base + '/')
    const html = await spa.text()
    check(spa.status === 200 && html.includes('<div id="app">'), '静态托管 Vue SPA 产物')

    // 防 DNS rebinding：伪造 Host 应被拒绝
    const badHost = await new Promise<number>((resolve) => {
      const r = http.request(
        { host: '127.0.0.1', port: WEB_PORT, path: '/api/health', headers: { Host: 'evil.example.com' } },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      r.on('error', () => resolve(0))
      r.end()
    })
    check(badHost === 403, '非法 Host 被拒绝（防 DNS rebinding）')

    console.log('\n[2] 连接管理与凭据加密')
    const created = await req<ConnectionView>('/api/connections', {
      method: 'POST',
      body: JSON.stringify({
        name: '本地测试 FTP',
        protocol: 'ftp',
        host: '127.0.0.1',
        port: FTP_PORT,
        username: 'tester',
        password: PASSWORD,
        savePassword: true,
        basePath: '/',
        options: { passive: true, charset: 'utf8' },
      }),
    })
    check(created.status === 201, '创建 FTP 连接', JSON.stringify(created.data))
    const connId = created.data.id
    const secrets = await fsp.readFile(path.join(dataDir, 'secrets.json'), 'utf8')
    check(!secrets.includes(PASSWORD), '密码未以明文落盘')

    const connected = await req<ConnectionView>(`/api/connections/${connId}/connect`, { method: 'POST' })
    check(connected.status === 200 && connected.data.state === 'connected', '连接 FTP 服务器成功', JSON.stringify(connected.data))

    console.log('\n[3] 远程目录浏览')
    const browse = await req<Array<{ name: string; size: number; createdAt: number | null }>>(
      `/api/browse?connectionId=${connId}&path=/`,
    )
    check(
      browse.status === 200 && browse.data.some((e) => e.name === 'hello.txt'),
      '列出远程目录',
      JSON.stringify(browse.data),
    )
    check(
      browse.status === 200 && browse.data.every((e) => e.createdAt === null),
      'FTP 远程条目 createdAt 为 null（不拿 mtime 冒充创建时间）',
    )

    console.log('\n[4] 下载、完成落盘与进度广播')
    const ws = new WebSocket(`ws://127.0.0.1:${WEB_PORT}/ws?token=${token}`)
    const wsMessages: Array<{ type: string }> = []
    ws.on('message', (raw: Buffer) => {
      try {
        wsMessages.push(JSON.parse(raw.toString()))
      } catch {
        /* ignore */
      }
    })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })

    const target1 = path.join(localRoot, 'hello.txt')
    const added = await req<TransferTask[]>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        tasks: [
          { connectionId: connId, direction: 'download', remotePath: '/hello.txt', localPath: target1 },
        ],
      }),
    })
    check(added.status === 201 && added.data.length === 1, '创建下载任务')

    const waitFor = async (id: string, predicate: (t: TransferTask) => boolean, timeout = 20000) => {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        const list = await req<TransferTask[]>('/api/tasks')
        const task = list.data.find((t) => t.id === id)
        if (task && predicate(task)) return task
        await sleep(80)
      }
      throw new Error(`等待任务状态超时：${id}`)
    }
    const done = await waitFor(added.data[0].id, (t) => t.status === 'completed')
    check(done.status === 'completed', '任务完成')
    const downloaded = await fsp.readFile(target1)
    check(sha256(downloaded) === sha256(hello), '下载文件内容与远端完全一致')
    check(!fs.existsSync(`${target1}.part`), '完成后 .part 临时文件已原子 rename')
    check(
      wsMessages.some((m) => m.type === 'snapshot') && wsMessages.some((m) => m.type === 'task'),
      'WebSocket 收到快照与进度广播',
    )

    console.log('\n[5] 断点续传（预置 .part + 远端 stat 校验）')
    const target2 = path.join(localRoot, 'big.bin')
    const partial = big.subarray(0, Math.floor(big.length / 3))
    await fsp.writeFile(`${target2}.part`, partial)
    const resumed = await req<TransferTask[]>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        tasks: [
          { connectionId: connId, direction: 'download', remotePath: '/big.bin', localPath: target2 },
        ],
      }),
    })
    const finished = await waitFor(resumed.data[0].id, (t) => t.status === 'completed')
    const resumedBytes = await fsp.readFile(target2)
    check(
      sha256(resumedBytes) === sha256(big),
      `从 ${partial.length} 字节处续传后文件完整`,
      `期望 ${big.length} 字节，实际 ${resumedBytes.length}`,
    )
    check(finished.transferred === big.length, '进度计数收敛到远端 size')

    console.log('\n[6] 暂停 / 继续 / 取消')
    const target3 = path.join(localRoot, 'big-pause.bin')
    const pauseTask = await req<TransferTask[]>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        tasks: [
          { connectionId: connId, direction: 'download', remotePath: '/big.bin', localPath: target3 },
        ],
      }),
    })
    const partBeforePause = fs.existsSync(`${target3}.part`)
    const paused = await req<TransferTask>(`/api/tasks/${pauseTask.data[0].id}/pause`, { method: 'POST' })
    if (paused.data.status === 'paused') {
      // 若任务尚未写出任何字节，.part 不存在是合法的；关键是暂停不得删除已有的 .part
      check(
        !partBeforePause || fs.existsSync(`${target3}.part`),
        '暂停不会删除已有的 .part 临时文件',
      )
      const continued = await req<TransferTask>(`/api/tasks/${pauseTask.data[0].id}/resume`, { method: 'POST' })
      check(continued.data.status === 'queued' || continued.data.status === 'running', '继续任务重新入队')
      const reDone = await waitFor(pauseTask.data[0].id, (t) => t.status === 'completed')
      check(sha256(await fsp.readFile(target3)) === sha256(big), '暂停后续传完成且内容完整')
      check(reDone.status === 'completed', '续传任务状态完成')
    } else {
      console.log('  ⚠ 本地回环传输过快，暂停窗口未命中；已由 [5] 覆盖续传路径')
    }
    await req(`/api/tasks/${pauseTask.data[0].id}/cancel`, { method: 'POST' })

    console.log('\n[7] Web 访问设置')
    const settings = await req<{ passwordSet: boolean; restarted: boolean }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ lanEnabled: false, port: WEB_PORT, password: 'web-pass-1234' }),
    })
    check(settings.status === 200 && settings.data.passwordSet, '设置 Web 访问密码（哈希存储）')
    const login = await req<{ token: string }>(
      '/api/auth/login',
      { method: 'POST', body: JSON.stringify({ password: 'web-pass-1234' }) },
      false,
    )
    check(login.status === 200 && typeof login.data.token === 'string', '密码登录换取 session token')
    const withSession = await fetch(base + '/api/connections', {
      headers: { Authorization: `Bearer ${login.data.token}` },
    })
    check(withSession.status === 200, 'session token 可访问业务接口')

    console.log('\n[8] 文件夹递归展开与整树同名后缀')
    const expandBody = JSON.stringify({
      connectionId: connId,
      paths: ['/dir'],
      localDir: localRoot,
    })
    type ExpandReply = {
      files: number
      suffix: string
      skipped: number
      truncated: boolean
      tasks: TransferTask[]
      errors: string[]
    }
    const expand1 = await req<ExpandReply>('/api/tasks/expand', {
      method: 'POST',
      body: expandBody,
    })
    check(
      expand1.status === 201 && expand1.data.files === 2,
      '文件夹递归展开成 2 个单文件任务',
      JSON.stringify(expand1.data),
    )
    const treeRoot = path.join(localRoot, 'dir')
    check(
      expand1.data.tasks.every((t) => t.localPath.startsWith(treeRoot + path.sep)),
      '本地保留相对目录结构（含子目录）',
    )
    for (const t of expand1.data.tasks) {
      await waitFor(t.id, (x) => x.status === 'completed')
    }
    check(
      sha256(await fsp.readFile(path.join(treeRoot, 'a.txt'))) === sha256(Buffer.from('AAA')) &&
        sha256(await fsp.readFile(path.join(treeRoot, 'sub', 'b.txt'))) ===
          sha256(Buffer.from('BBB')),
      '展开后的整棵目录树下载内容一致',
    )
    const expand2 = await req<ExpandReply>('/api/tasks/expand', {
      method: 'POST',
      body: expandBody,
    })
    check(expand2.data.suffix === ' (1)', '同名时整批得到一个统一后缀', expand2.data.suffix)
    check(
      expand2.data.files === 2 && expand2.data.tasks.every((t) => t.localPath.includes('dir (1)')),
      '同一后缀未把目录树拆散到不同目录',
      JSON.stringify(expand2.data.tasks.map((t) => t.localPath)),
    )
    for (const t of expand2.data.tasks) {
      await waitFor(t.id, (x) => x.status === 'completed')
    }

    console.log('\n[9] 取消删 .part 与已完成成品保护')
    const cancelCompleted = await req<TransferTask>(`/api/tasks/${done.id}/cancel`, {
      method: 'POST',
    })
    check(
      cancelCompleted.data.status === 'completed' && fs.existsSync(target1),
      '已完成任务不可取消，成品文件保留',
    )
    check(
      sha256(await fsp.readFile(target1)) === sha256(hello),
      '已完成任务的文件内容未被破坏',
    )
    const target4 = path.join(localRoot, 'cancel-me.bin')
    await fsp.writeFile(`${target4}.part`, big.subarray(0, 1024 * 1024))
    const cancelTask = await req<TransferTask[]>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        tasks: [
          {
            connectionId: connId,
            direction: 'download',
            remotePath: '/big.bin',
            localPath: target4,
          },
        ],
      }),
    })
    const canceled = await req<TransferTask>(`/api/tasks/${cancelTask.data[0].id}/cancel`, {
      method: 'POST',
    })
    if (canceled.data.status === 'canceled') {
      check(!fs.existsSync(`${target4}.part`), '取消后删除已下载的 .part 临时文件')
      check(!fs.existsSync(target4), '取消后不会留下半成品成品文件')
    } else {
      check(
        canceled.data.status === 'completed' &&
          sha256(await fsp.readFile(target4)) === sha256(big),
        '取消竞态下任务已完成，成品保持完整',
        canceled.data.status,
      )
    }

    console.log('\n[10] 批量暂停 / 开始 / 清除与广播')
    // 一次创建 12 个小任务：并发 3，必然留下一批 queued，使批量暂停可稳定命中
    const bulkTargets = Array.from({ length: 12 }, (_, i) =>
      path.join(localRoot, `bulk-${i}.txt`),
    )
    const bulkAdded = await req<TransferTask[]>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        tasks: bulkTargets.map((localPath) => ({
          connectionId: connId,
          direction: 'download',
          remotePath: '/hello.txt',
          localPath,
        })),
      }),
    })
    check(bulkAdded.status === 201 && bulkAdded.data.length === 12, '一次创建 12 个任务')
    const pausedAll = await req<{ tasks: TransferTask[]; affected: number }>('/api/tasks/bulk', {
      method: 'POST',
      body: JSON.stringify({ action: 'pause-all' }),
    })
    check(
      pausedAll.status === 200 &&
        pausedAll.data.tasks.length > 0 &&
        pausedAll.data.tasks.every((t) => t.status === 'paused'),
      '全部暂停把运行 / 排队中的任务置为 paused',
      JSON.stringify(pausedAll.data),
    )
    const resumedAll = await req<{ tasks: TransferTask[]; affected: number }>('/api/tasks/bulk', {
      method: 'POST',
      body: JSON.stringify({ action: 'resume-all' }),
    })
    check(
      resumedAll.status === 200 &&
        resumedAll.data.tasks.length > 0 &&
        resumedAll.data.tasks.every((t) => t.status === 'queued' || t.status === 'running'),
      '全部开始只恢复已暂停的任务',
      JSON.stringify(resumedAll.data),
    )
    for (const t of bulkAdded.data) {
      await waitFor(t.id, (x) => x.status === 'completed')
    }
    const clearedFinished = await req<{ removedIds: string[] }>('/api/tasks/bulk', {
      method: 'POST',
      body: JSON.stringify({ action: 'clear-finished' }),
    })
    check(
      clearedFinished.status === 200 && clearedFinished.data.removedIds.length >= 12,
      '清除已完成一次请求移除全部终态记录',
    )
    // 再放几条任务，验证「真清空」会中止运行中的任务
    await req<TransferTask[]>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        tasks: ['x', 'y', 'z'].map((n) => ({
          connectionId: connId,
          direction: 'download',
          remotePath: '/hello.txt',
          localPath: path.join(localRoot, `clear-all-${n}.txt`),
        })),
      }),
    })
    const clearedAll = await req<{ removedIds: string[]; affected: number }>('/api/tasks/bulk', {
      method: 'POST',
      body: JSON.stringify({ action: 'clear-all' }),
    })
    const remaining = await req<TransferTask[]>('/api/tasks')
    check(
      clearedAll.status === 200 && remaining.data.length === 0,
      '清除全部连运行中一起清空队列',
      JSON.stringify(clearedAll.data),
    )
    check(fs.existsSync(target1), '清除全部后已完成任务的成品文件仍保留')
    const partsLeft = await findPartFiles(localRoot)
    check(partsLeft.length === 0, '清除全部后无 .part 残留', partsLeft.join(', '))
    check(
      wsMessages.some((m) => m.type === 'tasks-removed'),
      '批量移除通过一条 WS 消息广播',
    )

    console.log('\n[11] 三区域布局：尺寸收敛、持久化与样式产物')
    const layoutStore = new Map<string, string>()
    const fakeStore: KeyValueStore = {
      getItem: (k) => layoutStore.get(k) ?? null,
      setItem: (k, v) => { layoutStore.set(k, v) },
    }
    check(
      clampSidebarWidth(9999, 1400) === LAYOUT_LIMITS.sidebarMax,
      '侧栏宽度不超过上限 560',
    )
    check(
      clampSidebarWidth(9999, 700) === 700 - LAYOUT_LIMITS.mainMin - LAYOUT_LIMITS.splitter,
      '窄窗口时侧栏上限让出主区最小宽度',
    )
    check(clampSidebarWidth(1, 1200) === LAYOUT_LIMITS.sidebarMin, '侧栏宽度不低于下限 220')
    check(
      clampSidebarWidth(Number.NaN, 1200) === DEFAULT_LAYOUT.sidebarWidth,
      '非法宽度退回默认值',
    )
    check(clampQueueHeight(9999, 900) === LAYOUT_LIMITS.queueMax, '队列高度不超过上限 600')
    check(
      clampQueueHeight(9999, 700) === 700 - LAYOUT_LIMITS.browserMin - LAYOUT_LIMITS.splitter,
      '队列高度上限为文件浏览区留足空间',
    )
    check(clampQueueHeight(1, 700) === LAYOUT_LIMITS.queueMin, '队列高度不低于下限 120')
    check(
      clampQueueHeight(9999, 300) === LAYOUT_LIMITS.queueMin,
      '极小窗口仍保证队列最小高度且不溢出',
    )

    const sample: LayoutPrefs = {
      sidebarWidth: 380,
      queueHeight: 300,
      sidebarCollapsed: true,
      queueCollapsed: true,
    }
    saveLayoutPrefs(sample, fakeStore)
    const restored = loadLayoutPrefs(fakeStore)
    check(JSON.stringify(restored) === JSON.stringify(sample), '尺寸与收起状态可持久化并原样恢复')
    saveLayoutPrefs({ ...restored, queueCollapsed: false }, fakeStore)
    check(
      loadLayoutPrefs(fakeStore).queueCollapsed === false,
      '新建任务自动展开后的状态会持久化',
    )
    layoutStore.set(LAYOUT_STORAGE_KEY, '{broken json')
    check(
      JSON.stringify(loadLayoutPrefs(fakeStore)) === JSON.stringify(DEFAULT_LAYOUT),
      '损坏的布局偏好退回默认值',
    )
    layoutStore.set(LAYOUT_STORAGE_KEY, JSON.stringify({ sidebarWidth: 'oops', queueCollapsed: 'yes' }))
    const layoutPartial = loadLayoutPrefs(fakeStore)
    check(
      layoutPartial.sidebarWidth === DEFAULT_LAYOUT.sidebarWidth && layoutPartial.queueCollapsed === false,
      '非法字段被过滤，不影响界面',
    )
    check(
      JSON.stringify(loadLayoutPrefs(null)) === JSON.stringify(DEFAULT_LAYOUT),
      '存储不可用时布局仍能正常工作',
    )
    // 覆盖式构建会留下历史产物，必须按 index.html 实际引用的文件名读取
    const rendererIndex = await fsp.readFile(
      path.resolve(process.cwd(), 'dist/renderer/index.html'),
      'utf8',
    )
    const assetDir = path.resolve(process.cwd(), 'dist/renderer/assets')
    const cssName = rendererIndex.match(/href="[^"]*\/([^"/]+\.css)"/)?.[1] ?? ''
    const jsName = rendererIndex.match(/src="[^"]*\/([^"/]+\.js)"/)?.[1] ?? ''
    const css = cssName ? await fsp.readFile(path.join(assetDir, cssName), 'utf8') : ''
    const bundle = jsName ? await fsp.readFile(path.join(assetDir, jsName), 'utf8') : ''
    check(
      css.includes('.splitter-v') && css.includes('.splitter-h') && css.includes('.rail-h'),
      '分隔条与收起边栏样式已打进前端产物',
    )

    console.log('\n[12] 本地目录上传展开与真实 FTP 写入')
    const uploadTree = path.join(uploadSrc, 'tree')
    await fsp.mkdir(path.join(uploadTree, 'sub'), { recursive: true })
    await fsp.writeFile(path.join(uploadTree, 'a.txt'), 'UP-A')
    await fsp.writeFile(path.join(uploadTree, 'sub', 'b.txt'), 'UP-B')
    await fsp
      .symlink(path.join(uploadTree, 'a.txt'), path.join(uploadTree, 'link.txt'))
      .catch(() => undefined)
    const uploadBody = JSON.stringify({
      connectionId: connId,
      paths: [uploadTree],
      remoteDir: '/',
    })
    const up1 = await req<ExpandReply>('/api/tasks/expand-upload', {
      method: 'POST',
      body: uploadBody,
    })
    check(
      up1.status === 201 && up1.data.files === 2,
      '本地目录递归展开成 2 个上传任务',
      JSON.stringify(up1.data),
    )
    check(
      (up1.data.tasks ?? []).every((t) => t.direction === 'upload'),
      '上传展开产出的任务方向为 upload',
    )
    check(
      (up1.data.tasks ?? []).some((t) => t.remotePath === '/tree/a.txt') &&
        (up1.data.tasks ?? []).some((t) => t.remotePath === '/tree/sub/b.txt'),
      '上传后远程保留相对目录结构（含子目录）',
      JSON.stringify((up1.data.tasks ?? []).map((t) => t.remotePath)),
    )
    check(up1.data.skipped >= 1, '上传展开跳过符号链接', String(up1.data.skipped))

    const waitUploadDone = async (id: string): Promise<TransferTask> => {
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        const list = await req<TransferTask[]>('/api/tasks')
        const t = list.data.find((x) => x.id === id)
        if (t && ['completed', 'failed', 'canceled'].includes(t.status)) return t
        await sleep(80)
      }
      throw new Error(`等待上传任务终态超时：${id}`)
    }
    const upResults: TransferTask[] = []
    for (const t of up1.data.tasks ?? []) upResults.push(await waitUploadDone(t.id))
    check(
      upResults.length === 2 && upResults.every((t) => t.status === 'completed'),
      '上传任务全部完成',
      JSON.stringify(upResults.map((t) => ({ status: t.status, error: t.error }))),
    )
    const remoteA = await fsp.readFile(path.join(remoteRoot, 'tree', 'a.txt'), 'utf8').catch(() => '')
    const remoteB = await fsp
      .readFile(path.join(remoteRoot, 'tree', 'sub', 'b.txt'), 'utf8')
      .catch(() => '')
    check(
      remoteA === 'UP-A' && remoteB === 'UP-B',
      '真实 FTP 上传后的远端目录与内容一致',
      `${remoteA} / ${remoteB}`,
    )
    const up2 = await req<ExpandReply>('/api/tasks/expand-upload', {
      method: 'POST',
      body: uploadBody,
    })
    check(up2.data.suffix === ' (1)', '上传同名时整批使用统一后缀', up2.data.suffix)
    check(
      (up2.data.tasks ?? []).length === 2 &&
        (up2.data.tasks ?? []).every((t) => t.remotePath.startsWith('/tree (1)/')),
      '上传后缀未把目录树拆散',
      JSON.stringify((up2.data.tasks ?? []).map((t) => t.remotePath)),
    )
    const upResults2: TransferTask[] = []
    for (const t of up2.data.tasks ?? []) upResults2.push(await waitUploadDone(t.id))
    check(
      upResults2.length === 2 && upResults2.every((t) => t.status === 'completed'),
      '带后缀的第二批上传任务同样完成',
      JSON.stringify(upResults2.map((t) => ({ status: t.status, error: t.error }))),
    )

    console.log('\n[13] 文件浏览布局：分栏比例 / 列显隐 / 列宽 / 持久化')
    check(
      DEFAULT_VISIBLE_COLUMNS.join(',') === 'name,size,modifiedAt,type,actions',
      '默认展示名称、大小、更新时间、类型、操作，隐藏创建时间',
    )
    check(
      clampBrowserRatio(0.95, 1000) <= BROWSER_LIMITS.maxRatio &&
        leftPaneWidth(0.95, 1000) >= BROWSER_LIMITS.paneMin,
      '左右分栏比例不超过上限且左栏不小于最小值',
    )
    const narrowRatio = clampBrowserRatio(0.95, 600)
    check(
      leftPaneWidth(narrowRatio, 600) >= BROWSER_LIMITS.paneMin &&
        600 - BROWSER_LIMITS.splitter - leftPaneWidth(narrowRatio, 600) >= BROWSER_LIMITS.paneMin,
      '窗口变窄时两侧都保留最小宽度',
    )
    check(
      clampBrowserRatio(0.01, 1000) >= BROWSER_LIMITS.minRatio &&
        clampBrowserRatio(Number.NaN, 1000) === DEFAULT_BROWSER_PREFS.browserRatio,
      '比例下限与非法值回退',
    )
    check(
      JSON.stringify(normalizeVisibleColumns(['actions', 'bogus', 'size'])) ===
        JSON.stringify(['name', 'size', 'actions']),
      '列显隐过滤非法项、保证名称必选并保持固定顺序',
    )
    check(
      JSON.stringify(normalizeVisibleColumns(undefined)) === JSON.stringify(DEFAULT_VISIBLE_COLUMNS),
      '缺少列配置时退回默认列',
    )
    const narrowCols = columnsForNarrow(ALL_COLUMNS, true)
    check(
      !narrowCols.includes('createdAt') && !narrowCols.includes('type'),
      '窄屏强制隐藏创建时间与类型两列',
    )
    const template = gridTemplateColumns(DEFAULT_VISIBLE_COLUMNS, DEFAULT_COLUMN_WIDTHS)
    check(
      template.startsWith('minmax(0, 1fr)') && (template.match(/px/g) ?? []).length === 4,
      '列模板以名称列自适应开头且固定列数匹配',
      template,
    )
    check(
      clampColumnWidth('size', 9999, DEFAULT_COLUMN_WIDTHS, DEFAULT_VISIBLE_COLUMNS, 0) ===
        COLUMN_LIMITS.size.max &&
        clampColumnWidth('size', 1, DEFAULT_COLUMN_WIDTHS, DEFAULT_VISIBLE_COLUMNS, 0) ===
          COLUMN_LIMITS.size.min,
      '列宽收敛到上下限',
    )
    check(
      clampColumnWidth('size', Number.NaN, DEFAULT_COLUMN_WIDTHS, DEFAULT_VISIBLE_COLUMNS, 0) ===
        DEFAULT_COLUMN_WIDTHS.size,
      '非法列宽退回默认值',
    )
    const fitted = fitColumnWidths(ALL_COLUMNS, DEFAULT_COLUMN_WIDTHS, 500)
    const fittedTotal = ALL_COLUMNS.filter((c: ColumnKey) => c !== 'name').reduce(
      (sum, key) => sum + fitted[key],
      0,
    )
    const fittedRoom =
      500 -
      BROWSER_LIMITS.nameMin -
      BROWSER_LIMITS.gap * (ALL_COLUMNS.length - 1) -
      BROWSER_LIMITS.padding
    check(
      fittedTotal <= fittedRoom + 4,
      '窄栏下固定列等比收敛，表头与行不会各自横向滚动',
      `${fittedTotal} vs ${fittedRoom}`,
    )
    const browserSample: BrowserPrefs = {
      browserRatio: 0.62,
      columnWidths: { ...DEFAULT_COLUMN_WIDTHS, size: 96, type: 88 },
      visibleColumns: ['name', 'size', 'createdAt', 'actions'],
    }
    saveBrowserPrefs(browserSample, fakeStore)
    const browserRestored = loadBrowserPrefs(fakeStore)
    check(
      JSON.stringify(browserRestored) === JSON.stringify(browserSample),
      '分栏比例 / 列宽 / 列显隐可持久化并原样恢复',
      JSON.stringify(browserRestored),
    )
    layoutStore.set(BROWSER_STORAGE_KEY, '{broken json')
    check(
      JSON.stringify(loadBrowserPrefs(fakeStore)) === JSON.stringify(DEFAULT_BROWSER_PREFS),
      '损坏的浏览区偏好退回默认值',
    )
    layoutStore.set(
      BROWSER_STORAGE_KEY,
      JSON.stringify({
        browserRatio: 'oops',
        columnWidths: { size: 'bad' },
        visibleColumns: ['huh', 'name'],
      }),
    )
    const browserPartial = loadBrowserPrefs(fakeStore)
    check(
      browserPartial.browserRatio === DEFAULT_BROWSER_PREFS.browserRatio &&
        browserPartial.columnWidths.size === DEFAULT_COLUMN_WIDTHS.size &&
        JSON.stringify(browserPartial.visibleColumns) === JSON.stringify(['name']),
      '非法字段被过滤，不影响界面',
    )
    check(
      JSON.stringify(loadBrowserPrefs(null)) === JSON.stringify(DEFAULT_BROWSER_PREFS),
      '存储不可用时浏览区仍能正常工作',
    )
    check(
      css.includes('.col-resizer') &&
        css.includes('.columns-pop') &&
        css.includes('.task-head') &&
        css.includes('.dir-badge'),
      '列宽手柄 / 列设置 / 队列表头 / 类型徽标样式已打进产物',
    )
    check(
      bundle.includes('拖动调整文件浏览左右两栏宽度') &&
        bundle.includes('列 ▾') &&
        bundle.includes('上传该文件或整个文件夹') &&
        bundle.includes('传输类型'),
      '左右分栏拖拽 / 列设置 / 本地上传入口 / 传输类型列已打进 JS 产物',
    )

    console.log('\n[14] 下载后右栏保持当前远程目录（缺陷回归）')
    const view = (over: Partial<ConnectionView> = {}): ConnectionView => ({
      id: 'conn-1',
      name: '测试连接',
      protocol: 'ftp',
      host: '127.0.0.1',
      hasPassword: true,
      options: {},
      createdAt: 1,
      state: 'connected',
      basePath: '/',
      ...over,
    })
    const beforeRefresh = view()
    const afterRefresh = view()
    check(
      beforeRefresh !== afterRefresh &&
        connectionIdentityKey(beforeRefresh) === connectionIdentityKey(afterRefresh),
      '刷新连接列表返回全新对象，但连接身份键不变',
    )
    check(
      nextRemotePath('/dir/sub', beforeRefresh, afterRefresh) === '/dir/sub',
      '下载后刷新不会把右栏打回根目录',
    )
    check(
      nextRemotePath('/dir/sub', null, beforeRefresh) === '/',
      '首次载入回到连接根目录',
    )
    check(
      nextRemotePath('/dir/sub', beforeRefresh, view({ id: 'conn-2', basePath: '/data' })) ===
        '/data',
      '切换连接回到新连接的根目录',
    )
    check(
      nextRemotePath('/dir/sub', beforeRefresh, view({ state: 'connecting' })) === '/dir/sub',
      '仅连接状态变化仍保留当前目录',
    )
    check(
      nextRemotePath('/dir/sub', beforeRefresh, view({ basePath: '/new-root' })) === '/new-root',
      '根目录配置变化回到新根目录',
    )
    check(
      nextRemotePath('/dir/sub', beforeRefresh, null) === '/dir/sub' &&
        nextRemotePath('', beforeRefresh, afterRefresh) === '/',
      '连接被移除时保留路径；路径为空时回落到根目录',
    )

    const findConn = (list: ConnectionView[]): ConnectionView | null =>
      list.find((c) => c.id === connId) ?? null
    const regressionDir = path.join(localRoot, 'path-regression')
    await fsp.mkdir(regressionDir, { recursive: true })
    const connsBefore = await req<ConnectionView[]>('/api/connections')
    const regressionDownload = await req<ExpandReply>('/api/tasks/expand', {
      method: 'POST',
      body: JSON.stringify({
        connectionId: connId,
        paths: ['/hello.txt'],
        localDir: regressionDir,
      }),
    })
    const connsAfter = await req<ConnectionView[]>('/api/connections')
    check(
      regressionDownload.status === 201 && regressionDownload.data.files === 1,
      '真实下载任务创建成功',
      JSON.stringify(regressionDownload.data),
    )
    check(
      connectionIdentityKey(findConn(connsBefore.data)) ===
        connectionIdentityKey(findConn(connsAfter.data)),
      '真实服务：下载前后重复拉取连接列表，身份键一致',
    )
    check(
      nextRemotePath('/dir/sub', findConn(connsBefore.data), findConn(connsAfter.data)) ===
        '/dir/sub',
      '真实服务：下载后的全量刷新仍保留当前远程目录',
    )
    for (const t of regressionDownload.data.tasks ?? []) {
      await waitFor(t.id, (x) => x.status === 'completed' || x.status === 'failed')
    }
    const snapshot = wsMessages.find((m) => m.type === 'snapshot') as
      | { type: string; connections?: ConnectionView[] }
      | undefined
    check(
      Boolean(snapshot?.connections?.length) &&
        connectionIdentityKey(findConn(snapshot?.connections ?? [])) ===
          connectionIdentityKey(findConn(connsAfter.data)),
      'WS 快照中的连接身份键与 REST 一致，重连也不会重置路径',
    )

    const appSource = await fsp.readFile(
      path.resolve(process.cwd(), 'src/renderer/App.vue'),
      'utf8',
    )
    const addedBody = appSource.match(/function onTasksAdded\([\s\S]*?\n}/)?.[0] ?? ''
    check(
      addedBody.includes('ensureQueueVisible') && !addedBody.includes('refreshAll'),
      '创建任务后只展开队列，不再做全量刷新',
    )
    const browserSource = await fsp.readFile(
      path.resolve(process.cwd(), 'src/renderer/components/BrowserPanel.vue'),
      'utf8',
    )
    check(
      browserSource.includes('connectionIdentityKey') &&
        browserSource.includes('nextRemotePath') &&
        !browserSource.includes('() => [props.connection?.id, props.connection?.state]'),
      '浏览区按业务字段判断连接变化，不再使用对象引用 / 新数组 getter',
    )

    ws.close()
  } finally {
    await core.stop().catch(() => undefined)
    await ftp.close().catch(() => undefined)
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
    await fsp.rm(uploadSrc, { recursive: true, force: true }).catch(() => undefined)
  }

  console.log(`\n结果：${passed} 项通过，${failed} 项失败\n`)
  if (failed) process.exit(1)
}

void main().catch((err) => {
  console.error('\n端到端自测异常：', err)
  process.exit(1)
})

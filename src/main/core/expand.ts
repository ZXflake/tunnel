import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  CreateTaskInput,
  ExpandInput,
  ExpandOutcome,
  ExpandUploadInput,
  RemoteEntry,
} from '../../shared/types'
import {
  joinRemote,
  normalizeRemotePath,
  remoteBasename,
  remoteDirname,
  withinBase,
} from '../../shared/path'
import type { ConnectionManager } from './connections'

/** 单批展开上限，超出提示用户分批下载。 */
export const MAX_EXPAND_FILES = 5000

interface ScannedFile {
  remotePath: string
  /** 相对该顶层目录的路径；顶层单文件时为文件名 */
  relative: string
  size: number
  rootIndex: number
}

interface Root {
  /** 顶层目标在本地的名字（目录名或文件名） */
  name: string
  isDir: boolean
}

interface ScanState {
  files: ScannedFile[]
  skipped: number
  emptyDirs: number
  truncated: boolean
  errors: string[]
}

function withSuffix(root: string, index: number, isDir: boolean): string {
  if (index <= 0) return root
  const suffix = ` (${index})`
  if (isDir) return `${root}${suffix}`
  const ext = path.extname(root)
  return `${root.slice(0, root.length - ext.length)}${suffix}${ext}`
}

/**
 * 把选中的远程文件 / 文件夹展开成「一个任务 = 一个文件」的输入列表。
 *
 * 传输引擎、续传、并发、进度与协议工厂都不感知目录概念：
 * 目录只是服务端递归 list() 后生成的一批单文件任务，本地路径保留相对目录结构。
 */
export async function expandRemotePaths(
  connections: ConnectionManager,
  input: ExpandInput,
  signal?: AbortSignal,
): Promise<ExpandOutcome> {
  const paths = (input.paths ?? []).filter(Boolean)
  if (!paths.length) throw new Error('请先选择要下载的文件或文件夹')
  if (!input.localDir) throw new Error('请先选择本地保存目录')

  const config = connections.getConfig(input.connectionId)
  const localDir = path.resolve(input.localDir)
  const roots: Root[] = []
  const state: ScanState = {
    files: [],
    skipped: 0,
    emptyDirs: 0,
    truncated: false,
    errors: [],
  }

  const adapter = connections.createSessionAdapter(input.connectionId)
  await adapter.connect()
  try {
    for (const raw of paths) {
      if (signal?.aborted) throw new Error('扫描已取消')
      const remotePath = normalizeRemotePath(raw)
      if (!withinBase(config.basePath, remotePath)) {
        state.errors.push(`${remotePath}：超出该连接配置的根目录范围`)
        continue
      }
      const rootIndex = roots.length
      const rootName = remotePath === '/' ? '' : remoteBasename(remotePath)

      let isDir = false
      try {
        isDir = (await adapter.stat(remotePath)).isDirectory
      } catch (err) {
        state.errors.push(`${remotePath}：${err instanceof Error ? err.message : String(err)}`)
        continue
      }

      roots.push({ name: rootName, isDir })
      if (!isDir) {
        state.files.push({
          remotePath,
          relative: rootName,
          size: 0,
          rootIndex,
        })
        continue
      }

      // 显式栈遍历，避免深层目录递归爆栈；同时便于在中途按上限截断
      const stack: Array<{ remote: string; relative: string }> = [
        { remote: remotePath, relative: '' },
      ]
      const before = state.files.length
      while (stack.length) {
        if (signal?.aborted) throw new Error('扫描已取消')
        if (state.files.length >= MAX_EXPAND_FILES) {
          state.truncated = true
          break
        }
        const current = stack.pop()!
        let entries: RemoteEntry[]
        try {
          entries = await adapter.list(current.remote)
        } catch (err) {
          state.errors.push(`${current.remote}：${err instanceof Error ? err.message : String(err)}`)
          continue
        }
        let children = 0
        for (const entry of entries) {
          if (state.files.length >= MAX_EXPAND_FILES) {
            state.truncated = true
            break
          }
          const relative = current.relative
            ? `${current.relative}/${entry.name}`
            : entry.name
          if (entry.type === 'dir') {
            stack.push({ remote: entry.path, relative })
            children++
          } else if (entry.type === 'file') {
            state.files.push({
              remotePath: entry.path,
              relative,
              size: entry.size,
              rootIndex,
            })
            children++
          } else {
            // 符号链接一律跳过，避免循环引用把扫描拖死
            state.skipped++
          }
        }
        if (children === 0 && current.relative) state.emptyDirs++
        if (state.truncated) break
      }
      if (state.files.length === before && !state.truncated) {
        // 顶层目录内没有任何可下载文件：单文件任务模型下不创建空目录
        state.emptyDirs++
      }
    }
  } finally {
    await adapter.close().catch(() => undefined)
  }

  // 整批共用一个后缀：逐文件重命名会把同一棵目录树拆散到不同的 (1)、(2) 目录里
  const rootPaths = roots.map((r) =>
    r.name ? path.join(localDir, r.name) : localDir,
  )
  let suffixIndex = 0
  if (rootPaths.some((p) => p !== localDir && fs.existsSync(p))) {
    suffixIndex = 1
    while (
      roots.some((r, i) =>
        rootPaths[i] === localDir
          ? false
          : fs.existsSync(withSuffix(rootPaths[i], suffixIndex, r.isDir)),
      )
    ) {
      suffixIndex++
    }
  }

  const inputs: CreateTaskInput[] = []
  for (const file of state.files) {
    const root = roots[file.rootIndex]
    const rootPath = rootPaths[file.rootIndex]
    // 选中连接根目录（/）时输出目标就是 localDir 本身，不参与重命名
    const targetRoot =
      rootPath === localDir ? localDir : withSuffix(rootPath, suffixIndex, root.isDir)
    const localPath = root.isDir ? path.resolve(targetRoot, file.relative) : targetRoot
    // 远程文件名理论上不含路径分隔符；仍做一次越界校验，避免写出目标目录之外
    if (!localPath.startsWith(path.resolve(targetRoot) + path.sep) && localPath !== targetRoot) {
      state.errors.push(`${file.remotePath}：本地路径越界，已跳过`)
      continue
    }
    inputs.push({
      connectionId: input.connectionId,
      direction: 'download',
      remotePath: file.remotePath,
      localPath,
      size: file.size,
    })
  }

  return {
    inputs,
    files: inputs.length,
    skipped: state.skipped,
    emptyDirs: state.emptyDirs,
    truncated: state.truncated,
    suffix: suffixIndex > 0 ? ` (${suffixIndex})` : '',
    errors: state.errors,
  }
}

interface LocalFile {
  localPath: string
  /** 相对该顶层目录的路径；顶层单文件时为文件名 */
  relative: string
  size: number
  rootIndex: number
}

interface LocalScanState {
  files: LocalFile[]
  skipped: number
  emptyDirs: number
  truncated: boolean
  errors: string[]
}

function suffixedName(name: string, index: number, isDir: boolean): string {
  if (index <= 0) return name
  const suffix = ` (${index})`
  if (isDir) return `${name}${suffix}`
  const ext = path.extname(name)
  return `${name.slice(0, name.length - ext.length)}${suffix}${ext}`
}

/**
 * 把选中的本地文件 / 文件夹展开成一批上传任务，远程保留相对目录结构。
 * 与 expandRemotePaths 对称：符号链接跳过、空目录不创建、单批上限、整批统一后缀、可取消。
 * 传输引擎仍是「一个任务 = 一个文件」，目录只体现在 remotePath 上；父目录在此提前补建，
 * 否则 FTP / SFTP 的 write() 遇到不存在的目录会直接失败。
 */
export async function expandLocalPaths(
  connections: ConnectionManager,
  input: ExpandUploadInput,
  signal?: AbortSignal,
): Promise<ExpandOutcome> {
  const paths = (input.paths ?? []).filter(Boolean)
  if (!paths.length) throw new Error('请先选择要上传的文件或文件夹')
  const config = connections.getConfig(input.connectionId)
  const remoteDir = normalizeRemotePath(input.remoteDir || '/')
  if (!withinBase(config.basePath, remoteDir)) {
    throw new Error('远程目标目录超出该连接配置的根目录范围')
  }

  // 与 /api/local 保持一致：只允许读用户主目录与临时目录，避免 Web 端任意读盘
  const allowed = [path.resolve(os.homedir()), path.resolve(os.tmpdir())]
  const withinLocal = (target: string): boolean =>
    allowed.some((root) => target === root || target.startsWith(root + path.sep))

  const roots: Root[] = []
  const state: LocalScanState = {
    files: [],
    skipped: 0,
    emptyDirs: 0,
    truncated: false,
    errors: [],
  }

  for (const raw of paths) {
    if (signal?.aborted) throw new Error('扫描已取消')
    const localPath = path.resolve(raw)
    if (!withinLocal(localPath)) {
      state.errors.push(`${localPath}：本地路径不在允许范围内`)
      continue
    }
    const stat = await fsp.lstat(localPath).catch((err) => {
      state.errors.push(`${localPath}：${err instanceof Error ? err.message : String(err)}`)
      return null
    })
    if (!stat) continue
    if (stat.isSymbolicLink()) {
      state.skipped++
      continue
    }
    if (!stat.isFile() && !stat.isDirectory()) {
      state.skipped++
      continue
    }

    const rootIndex = roots.length
    const name = path.basename(localPath)
    const isDir = stat.isDirectory()
    roots.push({ name, isDir })
    if (stat.isFile()) {
      state.files.push({ localPath, relative: name, size: stat.size, rootIndex })
      continue
    }

    // 显式栈遍历，避免深层目录爆栈；同时便于按上限截断
    const stack: Array<{ local: string; relative: string }> = [
      { local: localPath, relative: '' },
    ]
    const before = state.files.length
    while (stack.length) {
      if (signal?.aborted) throw new Error('扫描已取消')
      if (state.files.length >= MAX_EXPAND_FILES) {
        state.truncated = true
        break
      }
      const current = stack.pop()!
      const items = await fsp
        .readdir(current.local, { withFileTypes: true })
        .catch((err) => {
          state.errors.push(`${current.local}：${err instanceof Error ? err.message : String(err)}`)
          return null
        })
      if (!items) continue
      let children = 0
      for (const item of items) {
        if (state.files.length >= MAX_EXPAND_FILES) {
          state.truncated = true
          break
        }
        const full = path.join(current.local, item.name)
        const relative = current.relative ? `${current.relative}/${item.name}` : item.name
        if (item.isSymbolicLink()) {
          // 与下载侧一致：跳过符号链接，避免循环引用与越出所选目录
          state.skipped++
          continue
        }
        if (item.isDirectory()) {
          stack.push({ local: full, relative })
          children++
        } else if (item.isFile()) {
          const st = await fsp.stat(full).catch(() => null)
          if (!st) {
            state.skipped++
            continue
          }
          state.files.push({ localPath: full, relative, size: st.size, rootIndex })
          children++
        } else {
          state.skipped++
        }
      }
      if (children === 0 && current.relative) state.emptyDirs++
      if (state.truncated) break
    }
    if (state.files.length === before && !state.truncated) state.emptyDirs++
  }

  const adapter = connections.createSessionAdapter(input.connectionId)
  await adapter.connect()
  try {
    // 远端同名检查：整批统一后缀，避免把同一棵目录树拆散到不同的 (1)、(2) 目录
    let existing = new Set<string>()
    try {
      existing = new Set((await adapter.list(remoteDir)).map((e) => e.name))
    } catch {
      // 目标目录不存在时由下面的 mkdir 补建
    }
    let suffixIndex = 0
    if (roots.some((r) => existing.has(r.name))) {
      suffixIndex = 1
      while (
        roots.some((r) => existing.has(suffixedName(r.name, suffixIndex, r.isDir)))
      ) {
        suffixIndex++
      }
    }
    const rootNames = roots.map((r) => suffixedName(r.name, suffixIndex, r.isDir))

    const inputs: CreateTaskInput[] = []
    for (const file of state.files) {
      const root = roots[file.rootIndex]
      const rootName = rootNames[file.rootIndex]
      const remotePath = root.isDir
        ? joinRemote(remoteDir, rootName, file.relative)
        : joinRemote(remoteDir, rootName)
      if (!withinBase(config.basePath, remotePath)) {
        state.errors.push(`${remotePath}：超出该连接配置的根目录范围`)
        continue
      }
      inputs.push({
        connectionId: input.connectionId,
        direction: 'upload',
        remotePath,
        localPath: file.localPath,
        size: file.size,
      })
    }

    // 逐层补建远程父目录：FTP ensureDir 幂等；SFTP mkdir 重复创建会报错，忽略即可，
    // 真正的权限 / 路径问题会在上传 write() 时暴露。
    const dirs = new Set<string>()
    if (remoteDir !== '/') dirs.add(remoteDir)
    for (const item of inputs) {
      let dir = remoteDirname(item.remotePath)
      while (dir !== '/') {
        dirs.add(dir)
        if (dir === remoteDir) break
        dir = remoteDirname(dir)
      }
    }
    const ordered = [...dirs].sort(
      (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b),
    )
    for (const dir of ordered) {
      if (signal?.aborted) throw new Error('扫描已取消')
      await adapter.mkdir(dir).catch(() => undefined)
    }

    return {
      inputs,
      files: inputs.length,
      skipped: state.skipped,
      emptyDirs: state.emptyDirs,
      truncated: state.truncated,
      suffix: suffixIndex > 0 ? ` (${suffixIndex})` : '',
      errors: state.errors,
    }
  } finally {
    await adapter.close().catch(() => undefined)
  }
}

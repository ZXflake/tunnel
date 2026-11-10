import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type {
  BulkAction,
  BulkResult,
  CreateTaskInput,
  ProtocolAdapter,
  TransferTask,
} from '../../shared/types'
import { normalizeRemotePath, withinBase } from '../../shared/path'
import type { AppStore } from '../store'
import type { ConnectionManager } from './connections'
import type { EventHub } from './event-hub'

const FLUSH_INTERVAL = 200
const SPEED_WINDOW_MS = 3000
const PERSIST_INTERVAL = 1000

interface Sample {
  t: number
  bytes: number
}

/**
 * 传输引擎：与协议解耦，只依赖 ProtocolAdapter 的 stat / read(offset) / write(offset)。
 * 负责并发队列、断点续传、暂停 / 取消、状态持久化与节流后的进度广播。
 */
export class TransferEngine {
  private readonly tasks = new Map<string, TransferTask>()
  private readonly controllers = new Map<string, AbortController>()
  /** 正在执行的 runTask Promise：取消 / 清空必须等写入流真正关闭后再删 .part */
  private readonly running = new Map<string, Promise<void>>()
  private readonly samples = new Map<string, Sample[]>()
  private readonly dirty = new Set<string>()
  private readonly concurrency: number
  private active = 0
  private timer: NodeJS.Timeout | null = null
  private lastPersist = 0

  constructor(
    private readonly store: AppStore,
    private readonly connections: ConnectionManager,
    private readonly hub: EventHub,
    concurrency = 3,
  ) {
    this.concurrency = concurrency
  }

  async init(): Promise<void> {
    for (const saved of await this.store.loadTasks()) {
      // 进程重启时，运行中的任务回到队列；.part 文件由续传校验决定是否复用
      const task: TransferTask = {
        ...saved,
        speed: 0,
        status: saved.status === 'running' ? 'queued' : saved.status,
      }
      this.tasks.set(task.id, task)
    }
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL)
    this.timer.unref()
    this.pump()
  }

  list(): TransferTask[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  private partPath(task: TransferTask): string {
    return `${task.localPath}.part`
  }

  private touch(task: TransferTask): void {
    task.updatedAt = Date.now()
    this.dirty.add(task.id)
    const arr = this.samples.get(task.id) ?? []
    arr.push({ t: Date.now(), bytes: task.transferred })
    this.samples.set(task.id, arr)
  }

  /** 200ms 节流：速度用滑动窗口计算，多客户端共享同一份状态。 */
  private flush(): void {
    const now = Date.now()
    for (const task of this.tasks.values()) {
      const prevSpeed = task.speed
      const arr = this.samples.get(task.id)
      if (arr) {
        while (arr.length && now - arr[0].t > SPEED_WINDOW_MS) arr.shift()
        if (task.status === 'running' && arr.length >= 2) {
          const dt = (arr[arr.length - 1].t - arr[0].t) / 1000
          task.speed = dt > 0 ? Math.max(0, (arr[arr.length - 1].bytes - arr[0].bytes) / dt) : 0
          if (now - arr[arr.length - 1].t > 2000) task.speed = 0
        } else {
          task.speed = 0
        }
      }
      if (Math.abs(prevSpeed - task.speed) > 1) this.dirty.add(task.id)
      if (this.dirty.has(task.id)) {
        this.hub.broadcast({ type: 'task', task: { ...task } })
      }
    }
    if (this.dirty.size) this.maybePersist()
    this.dirty.clear()
  }

  private maybePersist(): void {
    const now = Date.now()
    if (now - this.lastPersist < PERSIST_INTERVAL) return
    this.lastPersist = now
    void this.store.saveTasks(this.list()).catch(() => undefined)
  }

  private persistNow(): Promise<void> {
    this.lastPersist = Date.now()
    return this.store.saveTasks(this.list())
  }

  /** 同名冲突默认自动重命名；该策略是骨架默认，可在 UI 里改成覆盖 / 询问。 */
  private resolveConflict(localPath: string): string {
    if (!fs.existsSync(localPath)) return localPath
    const ext = path.extname(localPath)
    const base = localPath.slice(0, localPath.length - ext.length)
    let i = 1
    while (fs.existsSync(`${base} (${i})${ext}`)) i++
    return `${base} (${i})${ext}`
  }

  /**
   * @param skipConflictCheck 目录展开场景：整批已统一算好同名后缀，
   * 不能再逐文件 resolveConflict，否则会把同一棵目录树拆散到不同后缀的目录里。
   */
  addTasks(inputs: CreateTaskInput[], skipConflictCheck = false): TransferTask[] {
    const created: TransferTask[] = []
    for (const input of inputs) {
      const config = this.connections.getConfig(input.connectionId)
      const remotePath = normalizeRemotePath(input.remotePath)
      if (!withinBase(config.basePath, remotePath)) {
        throw new Error('远程路径超出该连接配置的根目录范围')
      }
      const localPath = path.resolve(
        input.direction === 'download' && !skipConflictCheck
          ? this.resolveConflict(input.localPath)
          : input.localPath,
      )
      const duplicate = [...this.tasks.values()].find(
        (t) =>
          t.connectionId === input.connectionId &&
          t.remotePath === remotePath &&
          t.localPath === localPath &&
          t.direction === input.direction &&
          !['completed', 'canceled', 'failed'].includes(t.status),
      )
      if (duplicate) {
        created.push(duplicate)
        continue
      }
      const now = Date.now()
      const task: TransferTask = {
        id: crypto.randomUUID(),
        connectionId: input.connectionId,
        direction: input.direction,
        remotePath,
        localPath,
        size: input.size ?? 0,
        transferred: 0,
        status: 'queued',
        speed: 0,
        createdAt: now,
        updatedAt: now,
      }
      this.tasks.set(task.id, task)
      created.push({ ...task })
      this.hub.broadcast({ type: 'task', task: { ...task } })
    }
    void this.persistNow()
    this.pump()
    return created
  }

  private pump(): void {
    while (this.active < this.concurrency) {
      // 暂停 → 立即继续时，旧的 runTask 可能还在收尾；等它结束后由 finally 里的 pump 再拉起，
      // 避免两个 runTask 同时写同一个 .part
      const next = [...this.tasks.values()].find(
        (t) => t.status === 'queued' && !this.running.has(t.id),
      )
      if (!next) break
      next.status = 'running'
      next.error = undefined
      this.touch(next)
      this.active++
      const promise = this.runTask(next)
      this.running.set(next.id, promise)
      void promise.finally(() => {
        this.running.delete(next.id)
        // 旧任务彻底结束后，再拉起「暂停 → 继续」期间被挡住的 queued 任务
        this.pump()
      })
    }
  }

  private counter(task: TransferTask): Transform {
    const engine = this
    return new Transform({
      transform(chunk: Buffer, _enc, cb) {
        task.transferred += chunk.length
        engine.touch(task)
        cb(null, chunk)
      },
    })
  }

  private async runTask(task: TransferTask): Promise<void> {
    const controller = new AbortController()
    this.controllers.set(task.id, controller)
    let adapter: ProtocolAdapter | null = null
    try {
      adapter = this.connections.createSessionAdapter(task.connectionId)
      await adapter.connect()
      if (task.direction === 'download') {
        await this.download(task, adapter, controller.signal)
      } else {
        await this.upload(task, adapter, controller.signal)
      }
      task.status = 'completed'
      task.transferred = task.size
      task.error = undefined
    } catch (err) {
      if (!controller.signal.aborted) {
        task.status = 'failed'
        task.error = err instanceof Error ? err.message : String(err)
      }
    } finally {
      await adapter?.close().catch(() => undefined)
      this.controllers.delete(task.id)
      this.active--
      this.samples.delete(task.id)
      task.speed = 0
      this.touch(task)
      void this.persistNow()
      this.pump()
    }
  }

  private async download(
    task: TransferTask,
    adapter: ProtocolAdapter,
    signal: AbortSignal,
  ): Promise<void> {
    const stat = await adapter.stat(task.remotePath)
    if (stat.isDirectory) throw new Error('不能下载目录，请选择文件')

    const part = this.partPath(task)
    // 续传校验：远端 size / mtime 变了就作废 .part，避免静默生成损坏文件
    const changed =
      task.size > 0 &&
      (task.size !== stat.size ||
        (task.remoteModifiedAt != null &&
          stat.modifiedAt != null &&
          Math.abs(task.remoteModifiedAt - stat.modifiedAt) > 1000))
    if (changed) {
      await fsp.rm(part, { force: true })
      task.transferred = 0
    }

    task.size = stat.size
    task.remoteModifiedAt = stat.modifiedAt
    await fsp.mkdir(path.dirname(task.localPath), { recursive: true })

    const partStat = await fsp.stat(part).catch(() => null)
    let offset = partStat?.size ?? 0
    if (offset > stat.size) {
      await fsp.rm(part, { force: true })
      offset = 0
    }
    task.transferred = offset
    this.touch(task)

    if (offset >= stat.size) {
      if (!partStat) await fsp.writeFile(part, '')
      await fsp.rename(part, task.localPath)
      return
    }

    const remote = await adapter.read(task.remotePath, { offset, signal })
    const local = fs.createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' })
    await pipeline(remote, this.counter(task), local, { signal })
    await adapter.flush?.()
    await fsp.rename(part, task.localPath)
  }

  private async upload(
    task: TransferTask,
    adapter: ProtocolAdapter,
    signal: AbortSignal,
  ): Promise<void> {
    const localStat = await fsp.stat(task.localPath)
    if (!localStat.isFile()) throw new Error('只能上传文件，不能上传目录')
    task.size = localStat.size

    // 上传续传需能力探测：不支持 offset 写入的协议降级为全量重传
    let offset = 0
    if (adapter.capabilities().uploadResume) {
      const remoteStat = await adapter.stat(task.remotePath).catch(() => null)
      if (
        remoteStat &&
        !remoteStat.isDirectory &&
        remoteStat.size < localStat.size &&
        (task.remoteModifiedAt == null ||
          Math.abs(task.remoteModifiedAt - localStat.mtimeMs) < 1000)
      ) {
        offset = remoteStat.size
      }
    }
    task.remoteModifiedAt = localStat.mtimeMs
    task.transferred = offset
    this.touch(task)

    const source = fs.createReadStream(task.localPath, { start: offset })
    const dest = await adapter.write(task.remotePath, { offset, signal })
    await pipeline(source, this.counter(task), dest, { signal })
    await adapter.flush?.()
    task.transferred = task.size
  }

  private pauseOne(task: TransferTask): TransferTask {
    if (['completed', 'canceled', 'failed'].includes(task.status)) return { ...task }
    const controller = this.controllers.get(task.id)
    if (controller) {
      task.status = 'paused' // 先定状态，避免 catch 把它改成 failed
      controller.abort()
    } else if (task.status === 'queued') {
      task.status = 'paused'
    }
    this.touch(task)
    return { ...task }
  }

  pause(id: string): TransferTask {
    const result = this.pauseOne(this.require(id))
    void this.persistNow()
    return result
  }

  private resumeOne(task: TransferTask): TransferTask {
    if (!['paused', 'failed', 'canceled'].includes(task.status)) return { ...task }
    task.status = 'queued'
    task.error = undefined
    this.touch(task)
    return { ...task }
  }

  resume(id: string): TransferTask {
    const result = this.resumeOne(this.require(id))
    void this.persistNow()
    this.pump()
    return result
  }

  /** 只删 .part 临时文件；completed 的成品文件永远不碰。 */
  private async deletePart(task: TransferTask): Promise<void> {
    if (task.direction !== 'download' || task.status === 'completed') return
    await fsp.rm(this.partPath(task), { force: true }).catch(() => undefined)
  }

  /** 取消默认删除 .part；暂停则保留 .part 供续传；已完成任务不可取消。 */
  async cancel(id: string, keepPart = false): Promise<TransferTask> {
    const task = this.require(id)
    if (task.status === 'completed') return { ...task }
    const controller = this.controllers.get(id)
    task.status = 'canceled'
    controller?.abort()
    this.touch(task)
    // 等 runTask 的 finally 走完（写入流已关闭）再删，否则 Windows 上会删除失败或留残留
    await this.running.get(id)?.catch(() => undefined)
    if (!keepPart) await this.deletePart(task)
    void this.persistNow()
    return { ...task }
  }

  async remove(id: string): Promise<void> {
    const task = this.require(id)
    if (task.status === 'running') throw new Error('运行中的任务不能删除，请先暂停或取消')
    await this.running.get(id)?.catch(() => undefined)
    // 移除只清队列记录与未完成的 .part，绝不删成品
    await this.deletePart(task)
    this.tasks.delete(id)
    this.hub.broadcast({ type: 'task-removed', id })
    await this.persistNow()
  }

  /** 四个批量动作共用一次请求、一次广播、一次落盘。 */
  async bulk(action: BulkAction): Promise<BulkResult> {
    const result: BulkResult = { action, tasks: [], removedIds: [], affected: 0 }
    const snapshot = this.list()

    if (action === 'pause-all') {
      for (const t of snapshot) {
        if (t.status === 'running' || t.status === 'queued') {
          result.tasks.push(this.pauseOne(this.tasks.get(t.id)!))
        }
      }
      await this.persistNow()
    } else if (action === 'resume-all') {
      // 只恢复 paused：失败 / 已取消的任务用单条「继续」，避免一键反复重排错误任务
      for (const t of snapshot) {
        if (t.status === 'paused') result.tasks.push(this.resumeOne(this.tasks.get(t.id)!))
      }
      await this.persistNow()
      this.pump()
    } else if (action === 'clear-finished' || action === 'clear-all') {
      const targets =
        action === 'clear-all'
          ? snapshot
          : snapshot.filter((t) => ['completed', 'failed', 'canceled'].includes(t.status))
      // 真清空：先中止运行中的任务并等写入流关闭，再删 .part，最后删记录
      const activeTasks = targets.filter(
        (t) => t.status === 'running' || t.status === 'queued',
      )
      for (const t of activeTasks) {
        const current = this.tasks.get(t.id)
        if (current) {
          current.status = 'canceled'
          this.touch(current)
        }
        this.controllers.get(t.id)?.abort()
      }
      await Promise.all(
        activeTasks.map((t) => this.running.get(t.id)?.catch(() => undefined)),
      )
      for (const t of targets) {
        const current = this.tasks.get(t.id)
        if (!current) continue
        await this.deletePart(current)
        this.tasks.delete(t.id)
        result.removedIds.push(t.id)
      }
      if (result.removedIds.length) {
        this.hub.broadcast({ type: 'tasks-removed', ids: result.removedIds })
      }
      await this.persistNow()
      this.pump()
    } else {
      throw new Error(`未知的批量操作：${action}`)
    }

    result.affected = result.tasks.length || result.removedIds.length
    return result
  }

  private require(id: string): TransferTask {
    const task = this.tasks.get(id)
    if (!task) throw new Error(`任务不存在：${id}`)
    return task
  }

  shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    for (const controller of this.controllers.values()) controller.abort()
    return this.persistNow()
  }
}

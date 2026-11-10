import type { Readable, Writable } from 'node:stream'

/** 支持的协议种类。新增协议时：实现 ProtocolAdapter 并在注册表里注册即可。 */
export type ProtocolKind = 'ftp' | 'sftp' | 'smb'

export type Direction = 'download' | 'upload'

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'canceled'

/** 按协议展开的选项，取代原来笼统的「协议版本」字段。 */
export interface ConnectionOptions {
  /** FTP: explicit / implicit TLS；false 为明文 */
  ftps?: 'explicit' | 'implicit' | false
  passive?: boolean
  /** 文件名编码，中文 FTP 常见 utf8 / gbk */
  charset?: string
  timeoutMs?: number
  /** SFTP: 私钥（PEM）与口令，替代密码登录 */
  privateKey?: string
  passphrase?: string
  /** SMB: 共享名、域、dialect 下限（不低于 SMB 2.02） */
  share?: string
  domain?: string
  minDialect?: string
}

export interface ConnectionConfig {
  id: string
  name: string
  protocol: ProtocolKind
  host: string
  port?: number
  username?: string
  /** 仅存在于内存与安全存储中；对外 API 一律不返回 */
  password?: string
  savePassword?: boolean
  basePath?: string
  options: ConnectionOptions
  createdAt: number
}

/** 新建 / 编辑连接时的入参；密码为空表示不修改已保存的凭据。 */
export type ConnectionInput = Partial<ConnectionConfig> & {
  protocol: ProtocolKind
  host: string
  name?: string
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface ConnectionView {
  id: string
  name: string
  protocol: ProtocolKind
  host: string
  port?: number
  username?: string
  hasPassword: boolean
  savePassword?: boolean
  basePath?: string
  options: ConnectionOptions
  createdAt: number
  state: ConnectionState
  error?: string
}

export interface RemoteEntry {
  name: string
  path: string
  type: 'file' | 'dir' | 'link' | 'unknown'
  size: number
  /** epoch ms；服务器未提供时为 null */
  modifiedAt: number | null
  /**
   * epoch ms；协议层通常拿不到创建时间（FTP LIST 只有 mtime、SFTP Stats 只有 atime/mtime），
   * 此时为 null，界面显示「—」，不得用 modifiedAt 冒充。
   */
  createdAt: number | null
}

export interface StatResult {
  size: number
  modifiedAt: number | null
  isDirectory: boolean
}

export interface ReadOptions {
  offset?: number
  signal?: AbortSignal
}

export interface WriteOptions {
  offset?: number
  signal?: AbortSignal
}

export interface AdapterCapabilities {
  /** 是否支持从指定 offset 续写；FTP 视服务器 APPE/REST 支持而定 */
  uploadResume: boolean
  /** 是否支持远程文件管理（后期迭代） */
  remoteManagement: boolean
}

/**
 * 协议适配器统一契约。所有协议差异必须封装在此接口内部：
 * 传输引擎、Web API、UI 只依赖这组方法，不感知具体协议。
 */
export interface ProtocolAdapter {
  readonly kind: ProtocolKind
  connect(): Promise<void>
  list(path: string): Promise<RemoteEntry[]>
  stat(path: string): Promise<StatResult>
  mkdir(path: string): Promise<void>
  /** 从 offset 开始读取，返回可读流；断点续传的基础 */
  read(path: string, opts?: ReadOptions): Promise<Readable>
  /** 从 offset 开始写入，返回可写流；上传续传的基础 */
  write(path: string, opts?: WriteOptions): Promise<Writable>
  rename(from: string, to: string): Promise<void>
  remove(path: string, recursive?: boolean): Promise<void>
  /** 等待异步写操作真正完成（FTP 的 uploadFrom/appendFrom 是后台任务，必须等待） */
  flush?(): Promise<void>
  close(): Promise<void>
  capabilities(): AdapterCapabilities
}

export interface TransferTask {
  id: string
  connectionId: string
  direction: Direction
  remotePath: string
  localPath: string
  size: number
  transferred: number
  status: TaskStatus
  error?: string
  /** 远端 mtime 快照，用于续传前校验 */
  remoteModifiedAt?: number | null
  speed: number
  createdAt: number
  updatedAt: number
}

export interface CreateTaskInput {
  connectionId: string
  direction: Direction
  remotePath: string
  localPath: string
  /** 批量下载时由服务端补全，前端可不传 */
  size?: number
}

/** 队列批量操作。四个动作共用一个接口，一次请求、一次广播、一次落盘。 */
export type BulkAction = 'pause-all' | 'resume-all' | 'clear-finished' | 'clear-all'

export interface BulkResult {
  action: BulkAction
  /** 状态被改变的任务快照（暂停 / 继续） */
  tasks: TransferTask[]
  /** 被移除的任务 id（清除类动作） */
  removedIds: string[]
  /** 受影响的任务总数，供二次确认文案与提示使用 */
  affected: number
}

/** 把选中的远程文件 / 文件夹递归展开成「一个任务 = 一个文件」的输入列表。 */
export interface ExpandInput {
  connectionId: string
  /** 选中的远程路径，可同时包含文件与目录 */
  paths: string[]
  /** 本地目标目录 */
  localDir: string
}

/** 把选中的本地文件 / 文件夹递归展开成一批上传任务。 */
export interface ExpandUploadInput {
  connectionId: string
  /** 选中的本地绝对路径，可同时包含文件与目录 */
  paths: string[]
  /** 远程目标目录 */
  remoteDir: string
}

export interface ExpandOutcome {
  inputs: CreateTaskInput[]
  /** 实际展开出的文件数 */
  files: number
  /** 跳过的符号链接 / 未知类型条目数 */
  skipped: number
  /** 空目录数（单文件任务模型下不创建） */
  emptyDirs: number
  /** 是否触发 5000 文件上限而被截断 */
  truncated: boolean
  /** 整批统一使用的同名后缀；空串表示无冲突 */
  suffix: string
  /** 单个路径扫描失败的原因，不影响其余路径 */
  errors: string[]
}

export interface WebSettings {
  lanEnabled: boolean
  port: number
  /** 外部访问密码是否已设置（不返回明文/哈希） */
  passwordSet: boolean
}

export type WsMessage =
  | { type: 'snapshot'; tasks: TransferTask[]; connections: ConnectionView[] }
  | { type: 'task'; task: TransferTask }
  | { type: 'task-removed'; id: string }
  | { type: 'tasks-removed'; ids: string[] }
  | { type: 'connection'; connection: ConnectionView }

export interface ApiError {
  error: string
  code?: string
}

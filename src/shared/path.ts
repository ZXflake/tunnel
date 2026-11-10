import path from 'node:path'

/** 远程路径一律用 POSIX 风格，避免 Windows 分隔符混进协议层。 */
export function normalizeRemotePath(input: string): string {
  const raw = (input || '/').replace(/\\/g, '/')
  const parts: string[] = []
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return '/' + parts.join('/')
}

export function joinRemote(...parts: string[]): string {
  return normalizeRemotePath(parts.join('/'))
}

export function remoteDirname(p: string): string {
  const n = normalizeRemotePath(p)
  if (n === '/') return '/'
  const i = n.lastIndexOf('/')
  return i === 0 ? '/' : n.slice(0, i)
}

export function remoteBasename(p: string): string {
  const n = normalizeRemotePath(p)
  return n === '/' ? '/' : n.slice(n.lastIndexOf('/') + 1)
}

/** 防止 ../ 越出连接配置的根目录。 */
export function withinBase(base: string | undefined, target: string): boolean {
  const b = normalizeRemotePath(base || '/')
  const t = normalizeRemotePath(target)
  return b === '/' || t === b || t.startsWith(b + '/')
}

/** 把用户传入的相对路径限制在所选本地目录内。 */
export function safeLocalPath(baseDir: string, relative: string): string {
  const resolved = path.resolve(baseDir, relative)
  const base = path.resolve(baseDir)
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error('本地路径越出允许的目录范围')
  }
  return resolved
}

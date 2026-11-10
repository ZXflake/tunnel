import fs from 'node:fs/promises'
import path from 'node:path'

/** 原子写入的 JSON 文件存储，避免崩溃时留下半截文件。 */
export class JsonFile<T> {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly fallback: T,
  ) {}

  async read(): Promise<T> {
    try {
      const text = await fs.readFile(this.file, 'utf8')
      return JSON.parse(text) as T
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(this.fallback)
      throw err
    }
  }

  /** 串行化写入，防止并发覆盖。 */
  write(value: T): Promise<void> {
    const job = this.queue.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
      await fs.rename(tmp, this.file)
    })
    this.queue = job.catch(() => undefined)
    return job
  }
}

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type RendererErrorInput = { message?: unknown; stack?: unknown; url?: unknown }
export type RendererErrorEntry = { ts: number; version: string; message: string; stack: string; url: string }

const text = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback

/** Main-owned bounded renderer diagnostics. Calls serialise so simultaneous window crashes cannot
 *  race the read-trim-write cycle or leave a partially-written log. */
export class RendererErrorLog {
  #pending = Promise.resolve()

  constructor(readonly path: string, private readonly version: () => string) {}

  capture(input: RendererErrorInput, ts = Date.now()): Promise<void> {
    const entry: RendererErrorEntry = {
      ts,
      version: this.version(),
      message: text(input?.message, 'Unknown renderer error'),
      stack: text(input?.stack),
      url: text(input?.url),
    }
    const write = this.#pending.then(() => this.#write(entry))
    this.#pending = write.catch(() => {})
    return write
  }

  async #write(entry: RendererErrorEntry): Promise<void> {
    let existing: string[] = []
    try { existing = (await readFile(this.path, 'utf8')).split('\n').filter(Boolean) } catch {}
    const lines = [...existing, JSON.stringify(entry)].slice(-200)
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, `${lines.join('\n')}\n`, 'utf8')
    await rename(temporary, this.path)
  }
}

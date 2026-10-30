import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type CleanupWaitResult = 'completed' | 'timed-out'

export async function waitForCleanupWithTimeout(
  cleanup: Promise<unknown>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<CleanupWaitResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<CleanupWaitResult>((resolve) => {
    timer = setTimeout(() => {
      onTimeout()
      resolve('timed-out')
    }, timeoutMs)
  })
  const completed = cleanup.then(
    (): CleanupWaitResult => 'completed',
    (): CleanupWaitResult => 'completed',
  )
  const result = await Promise.race([completed, timeout])
  if (timer) clearTimeout(timer)
  return result
}

/** Bounded, serialised main-process lifecycle diagnostics. This mirrors renderer-errors.log but records
 *  Electron window/agent/quit boundaries so a live hang reveals the last settled await. */
export class MainProcessDiagnostics {
  #pending = Promise.resolve()

  /** `maxLines` bounds the file; the oldest lines go first. 400 is the lifecycle log's own bound. */
  constructor(readonly path: string, readonly maxLines = 400) {}

  record(event: string, details: Record<string, unknown> = {}, ts = Date.now()): Promise<void> {
    const write = this.#pending.then(() => this.#write({ ts, event, ...details }))
    this.#pending = write.catch(() => {})
    return write
  }

  async #write(entry: Record<string, unknown>): Promise<void> {
    let existing: string[] = []
    try { existing = (await readFile(this.path, 'utf8')).split('\n').filter(Boolean) } catch {}
    const lines = [...existing, JSON.stringify(entry)].slice(-this.maxLines)
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, `${lines.join('\n')}\n`, 'utf8')
    await rename(temporary, this.path)
  }
}

let diagnostics: MainProcessDiagnostics | null = null

export function configureMainProcessDiagnostics(path: string): void {
  diagnostics = new MainProcessDiagnostics(path)
}

export function recordMainProcessDiagnostic(event: string, details: Record<string, unknown> = {}): Promise<void> {
  return diagnostics?.record(event, details).catch(() => {}) ?? Promise.resolve()
}

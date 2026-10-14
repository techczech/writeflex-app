import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { posix } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'
import type { Workspace } from './workspace'
import {
  matchesVersionScope,
  parseVersionLine,
  sortVersionsNewestFirst,
  type AuthorIdentity,
  type Version,
  type VersionScope,
} from '../engine'

export {
  matchesVersionScope,
  parseVersionLine,
  sortVersionsNewestFirst,
  type AuthorIdentity,
  type Version,
  type VersionScope,
} from '../engine'

export const WRITEFLEX_AGENT_AUTHOR: AuthorIdentity = { name: 'WriteFlex Agent' }

const STORE_DIR = '.writeflex'
const JOURNAL_REL = `${STORE_DIR}/versions.jsonl`
const execFileAsync = promisify(execFile)

const makeVersionId = (): string =>
  `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

/**
 * Append-only version journal. This deliberately lives beside, not inside, ChangeStore: versions are
 * first-class named records with authors, while changes remain the per-edit ledger stamped by a
 * version id. Keeping the files separate preserves both invariants and keeps git merges line-based.
 */
export class VersionStore {
  #queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly ws: Workspace) {}

  #run<T>(op: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(() => op())
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  #assertWellFormed(version: Version): void {
    if (!parseVersionLine(JSON.stringify(version))) {
      throw new Error('Refusing to persist a malformed version record.')
    }
  }

  async append(input: Omit<Version, 'id' | 'ts'> & { id?: string; ts?: number }): Promise<Version> {
    return this.#run(async () => {
      const version: Version = {
        ...input,
        id: input.id ?? makeVersionId(),
        ts: input.ts ?? Date.now(),
      }
      this.#assertWellFormed(version)
      await mkdir(this.ws.absolute(STORE_DIR), { recursive: true })
      await appendFile(this.ws.absolute(JOURNAL_REL), `${JSON.stringify(version)}\n`, 'utf8')
      return version
    })
  }

  /**
   * Append a document's foundation version only while it has no version records. The existence check,
   * snapshot callback and append share the store queue, so two close events cannot create two automatic
   * versions. Returning null from `build` records nothing (the empty-document path).
   */
  async appendFirstForPath(
    path: string,
    build: () => Promise<Omit<Version, 'id' | 'ts' | 'path'> | null>,
  ): Promise<Version | null> {
    return this.#run(async () => {
      if ((await this.#readLatest()).some((version) => version.path === path)) return null
      const input = await build()
      if (!input) return null
      const version: Version = {
        ...input,
        id: makeVersionId(),
        path,
        ts: Date.now(),
      }
      this.#assertWellFormed(version)
      await mkdir(this.ws.absolute(STORE_DIR), { recursive: true })
      await appendFile(this.ws.absolute(JOURNAL_REL), `${JSON.stringify(version)}\n`, 'utf8')
      return version
    })
  }

  async list(scope?: VersionScope): Promise<Version[]> {
    return this.#run(async () => {
      const versions = await this.#readLatest()
      return sortVersionsNewestFirst(versions.filter((version) => matchesVersionScope(version, scope)))
    })
  }

  async rename(id: string, name: string, opts: { ts?: number; author?: AuthorIdentity } = {}): Promise<Version> {
    const nextName = name.trim()
    if (nextName === '') throw new Error('Version name cannot be blank.')
    return this.#run(async () => {
      const current = (await this.#readLatest()).find((version) => version.id === id)
      if (!current) throw new Error(`No version with id ${id}.`)
      const renamed: Version = {
        ...current,
        name: nextName,
        author: opts.author ?? current.author,
        ts: current.ts,
      }
      this.#assertWellFormed(renamed)
      await mkdir(this.ws.absolute(STORE_DIR), { recursive: true })
      await appendFile(this.ws.absolute(JOURNAL_REL), `${JSON.stringify(renamed)}\n`, 'utf8')
      return renamed
    })
  }

  async #readLatest(): Promise<Version[]> {
    const abs = this.ws.absolute(JOURNAL_REL)
    if (!existsSync(abs)) return []
    const raw = await readFile(abs, 'utf8')
    const latest = new Map<string, Version>()
    for (const line of raw.split('\n')) {
      const version = parseVersionLine(line)
      if (!version) continue
      const current = latest.get(version.id)
      if (!current || version.ts > current.ts || (version.ts === current.ts && version.id.localeCompare(current.id) >= 0)) {
        latest.set(version.id, version)
      }
    }
    return Array.from(latest.values())
  }
}

async function gitConfig(root: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'config', '--get', key])
    const value = stdout.trim()
    return value === '' ? null : value
  } catch {
    return null
  }
}

export async function humanAuthorForWorkspace(root: string): Promise<AuthorIdentity> {
  const [name, email] = await Promise.all([
    gitConfig(root, 'user.name'),
    gitConfig(root, 'user.email'),
  ])
  const fallback = userInfo().username || 'Writer'
  return {
    name: name ?? fallback,
    ...(email ? { email } : {}),
  }
}

export function versionsJournalPath(): string {
  return posix.normalize(JOURNAL_REL)
}

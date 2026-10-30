import { readMovedVersions, settleVersionMoves } from './version-moves'
import { mkdir } from 'node:fs/promises'
import { posix } from 'node:path'
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
import { WRITEFLEX_SELF_AUTHOR_NAME } from '../shared/part-title-proposal'
import { assertCollectionWritable } from './collection-write-gate'
import { runBounded, type BoundedOptions } from './bounded-child'
import { appendStoreLine, StoreAppendRefused } from './checked-store-append'

export const WRITEFLEX_AGENT_AUTHOR: AuthorIdentity = { name: 'WriteFlex Agent' }

/** WriteFlex's own proposals (folio-part-proposals.ts only): never the agent's author, never given from outside. */
export const WRITEFLEX_SELF_AUTHOR: AuthorIdentity = { name: WRITEFLEX_SELF_AUTHOR_NAME }

const STORE_DIR = '.writeflex'
const JOURNAL_REL = `${STORE_DIR}/versions.jsonl`

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

  /** The Collection this journal belongs to. */
  get root(): string {
    return this.ws.root
  }

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

  /**
   * Every line this journal gains goes through the checked append (checked-store-append.ts): never
   * through a link at `versions.jsonl`, never into a file with a second name. Refused, nothing is written.
   */
  async #appendLine(version: Version, what: string): Promise<void> {
    try {
      await appendStoreLine(this.ws.root, JOURNAL_REL, `${JSON.stringify(version)}\n`)
    } catch (error) {
      if (error instanceof StoreAppendRefused) throw new Error(`WriteFlex did not ${what}: ${error.message}`)
      throw error
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
      assertCollectionWritable(this.ws.root)
      settleVersionMoves(this.ws.root)
      await mkdir(this.ws.absolute(STORE_DIR), { recursive: true })
      await this.#appendLine(version, 'record this version')
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
      assertCollectionWritable(this.ws.root)
      settleVersionMoves(this.ws.root)
      await mkdir(this.ws.absolute(STORE_DIR), { recursive: true })
      await this.#appendLine(version, 'record this version')
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
      assertCollectionWritable(this.ws.root)
      settleVersionMoves(this.ws.root)
      await mkdir(this.ws.absolute(STORE_DIR), { recursive: true })
      await this.#appendLine(renamed, 'rename this version')
      return renamed
    })
  }

  async #readLatest(): Promise<Version[]> {
    return readMovedVersions(this.ws.root)
  }
}

/** How long `git config` is given. It is reachable from a requested version save, made while the Collection is held. */
export const GIT_CONFIG_WAIT_MS = 3_000

/** Git, by its own path: never looked up on `PATH`, which the command line inherits from the agent
 *  that runs it and which may name a folder inside the Collection first. */
export const GIT_PATH = '/usr/bin/git'

/** @internal Test seams: another program in place of `git`, and the limit without the clock. */
export type AuthorSeams = { command?: string; expired?: BoundedOptions['expired'] }

/** One value from git's configuration, or null when there is none, git is not there, or it did not
 *  answer in time (the child is then killed: bounded-child.ts). */
async function gitConfig(root: string, key: string, seams: AuthorSeams): Promise<string | null> {
  const run = await runBounded(seams.command ?? GIT_PATH, ['-C', root, 'config', '--get', key], { timeoutMs: GIT_CONFIG_WAIT_MS, ...(seams.expired ? { expired: seams.expired } : {}) })
  if (run.kind !== 'exited' || run.code !== 0) return null
  const value = run.stdout.trim()
  return value === '' ? null : value
}

/**
 * Who a version is by: git's `user.name` and `user.email` for the Collection when it has them. The
 * wait for git is bounded; with no answer the author is the fallback, this computer's user name, and
 * the version is saved all the same.
 */
export async function humanAuthorForWorkspace(root: string, seams: AuthorSeams = {}): Promise<AuthorIdentity> {
  const [name, email] = await Promise.all([
    gitConfig(root, 'user.name', seams),
    gitConfig(root, 'user.email', seams),
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

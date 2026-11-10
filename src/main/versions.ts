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
import { folioSaveOf } from '../shared/folio-version-records'
import { assertCollectionWritable } from './collection-write-gate'
import { runBounded, type BoundedOptions } from './bounded-child'
import { appendStoreLine, StoreAppendRefused } from './checked-store-append'
import { isReplicaVersionId } from './replica-versions'
import { FOLIO_SAVE_COMMITS_JOURNAL_REL, folioSaveCommitLine, withoutUnfinishedFolioSaves } from './folio-save-commit'

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

  /** `extra`: versions listed beside the journal's that it does not keep (a OneDrive Collection's texts
   *  held only in this Mac's local recovery, sync-replica-session.ts `localVersions`). Listed only. */
  constructor(private readonly ws: Workspace, private readonly opts: { extra?: () => Version[] } = {}) {}

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
    if ('folioSave' in version && folioSaveOf(version) === undefined) throw new Error('Refusing to persist a version record with a malformed Folio save marker.')
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

  /**
   * `folioSave`: set only by a Folio save (folio-version-save.ts) on each per-file version it writes; the
   * version counts only once the Folio journal holds a Folio version with that id (folio-save-commit.ts).
   */
  async append(input: Omit<Version, 'id' | 'ts'> & { id?: string; ts?: number; folioSave?: string }): Promise<Version> {
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
   * The commit line of a finished Folio save (folio-save-commit.ts): "the save with this id is complete",
   * appended to `.writeflex/folio-save-commits.jsonl` (never to `versions.jsonl`, whose unknown kinds an older
   * backup helper rejects) right after the save's Folio version record. It holds no content; the backup
   * projection carries it so a restored copy keeps the save's per-file versions visible.
   */
  async commitFolioSave(saveId: string): Promise<void> {
    if (folioSaveOf({ folioSave: saveId }) === undefined) throw new Error('Refusing to record a commit for a malformed Folio save id.')
    return this.#run(async () => {
      assertCollectionWritable(this.ws.root)
      await mkdir(this.ws.absolute(STORE_DIR), { recursive: true })
      try {
        await appendStoreLine(this.ws.root, FOLIO_SAVE_COMMITS_JOURNAL_REL, folioSaveCommitLine(saveId, Date.now()))
      } catch (error) {
        if (error instanceof StoreAppendRefused) throw new Error(`WriteFlex did not record that this Folio version was saved: ${error.message}`)
        throw error
      }
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
      // Neither unfinished Folio saves nor replica checkpoints suppress the named foundation.
      const existing = await withoutUnfinishedFolioSaves(this.ws.root, await this.#readLatest())
      if (existing.some((version) => version.path === path && !isReplicaVersionId(version.id))) return null
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

  /**
   * The per-file versions, newest first. A version written by a Folio save that never finished (its
   * `folioSave` has no Folio version in the Folio journal) is an orphan and is not listed: it is no
   * version of that Folio and must not be offered, or reused, as one. `including` names a Folio save
   * still under way, whose own versions count already.
   */
  async list(scope?: VersionScope, opts: { includingFolioSave?: string } = {}): Promise<Version[]> {
    return this.#run(async () => {
      const versions = await this.#readLatest()
      const ids = new Set(versions.map((version) => version.id))
      let extra: Version[] = []
      try { extra = (this.opts.extra?.() ?? []).filter((version) => !ids.has(version.id)) } catch { extra = [] }
      const matching = sortVersionsNewestFirst([...versions, ...extra].filter((version) => matchesVersionScope(version, scope)))
      return withoutUnfinishedFolioSaves(this.ws.root, matching, opts.includingFolioSave)
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

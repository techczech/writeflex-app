import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { posix } from 'node:path'
import { isHiddenWorkspacePath, type Workspace } from './workspace'
import { minimiseProposedReplacement } from './proposed-replacement'
import {
  createChangeIdFactory,
  matchesScope,
  parseChangeLine,
  serializeChanges,
  type Change,
  type ChangeIdFactory,
  type ChangeScope,
  type ChangeStatus,
  type EditClass,
  type NewChange,
} from '../engine'

export {
  createChangeIdFactory,
  matchesScope,
  parseChangeLine,
  serializeChanges,
  type Change,
  type ChangeIdFactory,
  type ChangeScope,
  type ChangeStatus,
  type EditClass,
  type EditSession,
  type EditSessionStatus,
  type NewChange,
  type Provenance,
} from '../engine'

/**
 * A NEW FILE that accepting a Change also writes (the agent's widgets.create: an HTML file beside the document).
 * It rides on the Change record so the Review pane shows the writer the file's workspace-relative path and its
 * full content, and so the accept can be bound to it: the verb writes only bytes whose SHA-256 is `sha256`.
 */
export type NewFilePart = { path: string; content: string; sha256: string }

/** The new-file part of a Change, only if it is intact: strings, and `content` really hashes to `sha256`. */
export function newFilePartOf(change: Change | undefined): NewFilePart | undefined {
  const part = (change as (Change & { newFile?: unknown }) | undefined)?.newFile as Partial<NewFilePart> | undefined
  if (!part || typeof part.path !== 'string' || typeof part.content !== 'string' || typeof part.sha256 !== 'string') return undefined
  if (createHash('sha256').update(Buffer.from(part.content, 'utf8')).digest('hex') !== part.sha256) return undefined
  return { path: part.path, content: part.content, sha256: part.sha256 }
}

const WIDGETS_CREATE = 'widgets.create'

/** Whether a Change is the agent's widgets.create proposal. The record says so by its verb, not by still having
 *  its file part: a record that lost `newFile` is still a widget proposal and is still never applied as a plain edit. */
export function createsAFile(change: Change | undefined): boolean {
  const record = change as (Change & { capability?: unknown; newFile?: unknown }) | undefined
  return record?.capability === WIDGETS_CREATE || record?.newFile !== undefined
}

/** No Change, from any door, targets a hidden folder: `.writeflex/` (this journal lives there), `.bridle/`, `.git/`... */
export function assertChangeTargetsADocument(path: unknown): void {
  if (isHiddenWorkspacePath(path)) throw new Error('A change can only be recorded for a document in a visible folder of the Workspace.')
}

/** Hidden per-workspace store dir (WriteFlex-owned metadata, like `.bridle` is Bridle-owned). */
const STORE_DIR = '.writeflex'
const JOURNAL_REL = `${STORE_DIR}/changes.jsonl`
const defaultIdFactory = createChangeIdFactory({ now: () => Date.now(), random: () => Math.random() })

/**
 * File-native Change store (ADR-0010/0011). One JSONL journal per Workspace at `.writeflex/changes.jsonl`,
 * the source of truth for every ledger surface. All writes go through the Workspace guard and are atomic
 * (temp-file + rename); every operation is SERIALISED through one promise chain (`#run`) so concurrent
 * captures — fire-and-forget writer edits, agent suggestion ingest, accept/reject from the dock — never
 * race and lose a record. A lost change record is lost history, so the same care ScrapStore takes applies.
 */
export class ChangeStore {
  #queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly ws: Workspace,
    private readonly makeId: ChangeIdFactory = defaultIdFactory,
  ) {}

  /** The write-side mirror of `parseChangeLine`: never persist a record a later read would reject as
   *  corrupt (and silently drop). A mutation reached through IPC carries only TypeScript's word that its
   *  enums are in-union; a stale or hand-rolled caller passing `status:'done'` or `editClass:'style'`
   *  would otherwise orphan the record on the next list/reopen. Validating here, before any write, means
   *  a bad payload fails loudly instead of eating history — and covers every caller, not just the bridge. */
  #assertWellFormed(change: Change): void {
    if (!parseChangeLine(JSON.stringify(change))) {
      throw new Error('Refusing to persist a malformed change record.')
    }
  }

  #run<T>(op: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(() => op())
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** Read + parse the journal (skips corrupt lines). Empty when the store has never been written. */
  async #readAll(): Promise<Change[]> {
    const abs = this.ws.absolute(JOURNAL_REL)
    if (!existsSync(abs)) return []
    const raw = await readFile(abs, 'utf8')
    const out: Change[] = []
    for (const line of raw.split('\n')) {
      const change = parseChangeLine(line)
      if (change) out.push(change)
    }
    return out
  }

  /** Atomic journal write: stage to a sibling temp file, then rename over the target (atomic on one
   *  filesystem), so a crash mid-write can never leave a truncated journal. */
  async #writeAll(changes: Change[]): Promise<void> {
    const abs = this.ws.absolute(JOURNAL_REL)
    await mkdir(this.ws.absolute(STORE_DIR), { recursive: true })
    const tmp = `${abs}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`
    await writeFile(tmp, serializeChanges(changes), 'utf8')
    await rename(tmp, abs)
  }

  /** Every change in the store (newest last, as recorded), narrowed by `scope`. */
  async list(scope?: ChangeScope): Promise<Change[]> {
    return this.#run(async () => (await this.#readAll()).filter((c) => matchesScope(c, scope)))
  }

  async get(id: string): Promise<Change | undefined> {
    return this.#run(async () => (await this.#readAll()).find((c) => c.id === id))
  }

  /** Append a new change, assigning a unique id, a timestamp, and a default 'pending' status. A `newFile`
   *  part on the input is dropped: only addWithNewFile attaches one (the renderer's changes:add cannot). */
  async add(input: NewChange): Promise<Change> {
    const { newFile: _dropped, capability: _verb, ...plain } = input as NewChange & { newFile?: unknown; capability?: unknown }
    return this.#add(plain as NewChange)
  }

  /** The agent's proposal that also creates a file: the Change plus the file the writer must be shown. In-process only. */
  async addWithNewFile(input: NewChange, newFile: NewFilePart): Promise<Change> {
    const { newFile: _dropped, capability: _verb, ...plain } = input as NewChange & { newFile?: unknown; capability?: unknown }
    return this.#add({ ...plain, capability: WIDGETS_CREATE, newFile: { path: newFile.path, content: newFile.content, sha256: newFile.sha256 } } as NewChange)
  }

  async #add(input: NewChange): Promise<Change> {
    assertChangeTargetsADocument(input.path)
    return this.#run(async () => {
      const existing = await this.#readAll()
      const taken = new Set(existing.map((c) => c.id))
      const change: Change = {
        ...input,
        id: this.makeId(taken),
        ts: input.ts ?? Date.now(),
        category: input.category ?? null,
        status: input.status ?? 'pending',
      }
      this.#assertWellFormed(change)
      await this.#writeAll([...existing, change])
      return change
    })
  }

  /** Proposed replacements pass through one store-owned seam before they become ledger records. */
  async addProposedReplacement(input: NewChange): Promise<Change | null> {
    const minimal = minimiseProposedReplacement(input)
    return minimal ? this.add(minimal) : null
  }

  async updateWriterChange(id: string, input: NewChange): Promise<Change> {
    assertChangeTargetsADocument(input.path)
    return this.#run(async () => {
      const all = await this.#readAll()
      const index = all.findIndex((c) => c.id === id)
      if (index === -1) throw new Error(`No change with id ${id}.`)
      const current = all[index]
      if (current.provenance !== 'writer') throw new Error('Only writer changes can be refreshed from live writer marks.')
      if (current.snapshotId) return current
      const updated: Change = {
        ...current,
        path: input.path,
        provenance: 'writer',
        editClass: input.editClass,
        category: input.category ?? null,
        summary: input.summary,
        oldText: input.oldText,
        newText: input.newText,
        anchor: input.anchor,
        isCorrection: input.isCorrection,
      }
      this.#assertWellFormed(updated)
      all[index] = updated
      await this.#writeAll(all)
      return updated
    })
  }

  /** Move a change to a new status (accept/reject from the dock). Throws if the id is unknown. */
  async setStatus(id: string, status: ChangeStatus): Promise<Change> {
    return this.#run(async () => {
      const all = await this.#readAll()
      const index = all.findIndex((c) => c.id === id)
      if (index === -1) throw new Error(`No change with id ${id}.`)
      const updated: Change = { ...all[index], status }
      this.#assertWellFormed(updated)
      all[index] = updated
      await this.#writeAll(all)
      return updated
    })
  }

  /** Re-anchor a still-pending move after another recorded move changes the buffer. This updates only
   *  positional metadata; the reviewed source/destination meaning and status remain unchanged. */
  async rebaseMove(
    id: string,
    moveFrom: { from: number; to: number },
    moveTo: { from: number; to: number },
    anchor: { from: number; to: number },
  ): Promise<Change> {
    return this.#run(async () => {
      const all = await this.#readAll()
      const index = all.findIndex((change) => change.id === id)
      if (index === -1) throw new Error(`No change with id ${id}.`)
      const current = all[index]
      if (current.editClass !== 'move' || current.status !== 'pending') {
        throw new Error('Only pending move changes can be re-anchored.')
      }
      const updated: Change = { ...current, moveFrom, moveTo, anchor }
      this.#assertWellFormed(updated)
      all[index] = updated
      await this.#writeAll(all)
      return updated
    })
  }

  /** Lazily classify a writer edit (ADR-0011 D2). Throws if the id is unknown. */
  async setEditClass(id: string, editClass: EditClass): Promise<Change> {
    return this.#run(async () => {
      const all = await this.#readAll()
      const index = all.findIndex((c) => c.id === id)
      if (index === -1) throw new Error(`No change with id ${id}.`)
      const updated: Change = { ...all[index], editClass }
      this.#assertWellFormed(updated)
      all[index] = updated
      await this.#writeAll(all)
      return updated
    })
  }

  /** Finalise a review run into one version snapshot. The caller passes only explicit resolved statuses:
   *  accepted rows are stamped with the version, rejected rows are marked rejected but not stamped, and
   *  rows with no status stay pending for a future version. Rows already assigned to an earlier version
   *  are left untouched. */
  async saveVersion(ids: string[], versionId: string, statusById: Record<string, ChangeStatus>): Promise<Change[]> {
    return this.#run(async () => {
      const wanted = new Set(ids)
      const all = await this.#readAll()
      const updated: Change[] = []
      for (let i = 0; i < all.length; i += 1) {
        const current = all[i]
        if (!wanted.has(current.id)) continue
        if (current.snapshotId) continue
        const status = statusById[current.id]
        if (!status) continue
        const next: Change = status === 'accepted'
          ? { ...current, status, snapshotId: versionId, versionId }
          : { ...current, status }
        this.#assertWellFormed(next)
        all[i] = next
        if (status === 'accepted') updated.push(next)
      }
      const missing = ids.filter((id) => !all.some((change) => change.id === id))
      if (missing.length > 0) throw new Error('One or more changes disappeared before saving the version.')
      await this.#writeAll(all)
      return updated
    })
  }
}

/** Whether a workspace-relative path names the Change journal (any case, any `./` or doubled separators). The
 *  editor's save refuses it: the journal is written by ChangeStore alone. */
export function isChangeJournalPath(path: string): boolean {
  return typeof path === 'string' && posix.normalize(path.replace(/\\/g, '/')).replace(/^\.\//, '').toLowerCase() === JOURNAL_REL
}

/** The workspace-relative journal path (exported for tests + tooling). */
export function changeJournalPath(): string {
  return posix.normalize(JOURNAL_REL)
}

/**
 * The Folio version journal (ADR-0052 § Storage model): `.writeflex/folio-versions.jsonl`, append-only,
 * one JSON object per line, plus the write-once object area (folio-version-objects.ts).
 *
 * Folio versions hold REFERENCES and marks only. The text of every file stays in Bridle's store, one
 * per-file version per file (`VersionStore`), and this journal points at those versions by id. This
 * module never writes `.writeflex/versions.jsonl` and never writes `.bridle/`: it reads the per-file
 * history (`readMovedVersions`, which never writes) and nothing more.
 *
 * Identity. A Folio is its Index Note's per-file history, not a folder path. `list(indexPath)` asks
 * which per-file versions the Index Note has NOW (the version-move projection follows an app-owned
 * rename or move of the Folio folder) and returns the Folio versions whose `index.versionId` is one
 * of them. Paths held in records are labels as of the time; nothing resolves by them.
 *
 * Every line is added through the checked append (checked-store-append.ts), after the write gate, in
 * this store's queue. Every record is rebuilt by the one parser (shared/folio-version-records.ts)
 * before it is written, so a field the parser does not know, an absolute path or a malformed value
 * never reaches the disk. A malformed line already in the file is ignored on read.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { assertCollectionWritable } from './collection-write-gate'
import { appendStoreLine, StoreAppendRefused } from './checked-store-append'
import { readStoreFile } from './checked-store-write'
import { readMovedVersions } from './version-moves'
import { getFolioObject, putFolioObject } from './folio-version-objects'
import {
  parseFolioJournalLine,
  parseFolioJournalRecord,
  type FolioJournalRecord,
  type FolioDecision,
  type FolioDecisionIntent,
  type FolioDecisionRecord,
  parseFolioDecisionLine,
  parseFolioDecisionRecord,
  type FolioRestore,
  type FolioVersion,
  type FolioVersionMark,
  foldFolioMarks,
  type FolioMarkState,
} from '../shared/folio-version-records'

export const FOLIO_VERSIONS_JOURNAL_REL = '.writeflex/folio-versions.jsonl'
/**
 * The writer's decisions about an incoming revision, and the intents that come before a new part's file (ticket 16). A file of its own,
 * never lines in the Folio journal: the backup helper of 0.28.0-alpha.9 reads that journal and rejects a kind it does not know, which
 * would stop the backup of ordinary writing on every Mac that runs it. Nothing that predates this file reads it.
 */
export const FOLIO_DECISIONS_JOURNAL_REL = '.writeflex/folio-decisions.jsonl'

/** A Folio version as the lists show it: the latest mark applied. `name` is the current name; `sentTo` and `withdrawn` come from the mark. */
export type ListedFolioVersion = FolioVersion & { sentTo?: string; withdrawn?: true }

export type NewFolioVersion = Omit<FolioVersion, 'kind' | 'id' | 'ts'> & { id?: string; ts?: number }
export type NewFolioRestore = Omit<FolioRestore, 'kind' | 'id' | 'ts'> & { id?: string; ts?: number }
/** What a mark changes. A name replaces the name; `sentTo: null` and `withdrawn: false` clear. Anything not mentioned is carried over. */
export type FolioMarkChange = { name?: string; sentTo?: string | null; withdrawn?: boolean }

const makeId = (prefix: 'fv' | 'fr'): string => `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`

/** A fresh Folio version id: a Folio save fixes it before its first write, to mark the per-file versions it writes. */
export const newFolioVersionId = (): string => makeId('fv')

/**
 * Whether two decisions are the same decision: the same row. A three-text row (`text:`, ticket 17) is final only over the three texts it was made over, so there
 * the digest `seen` and the part must match too: the writer who edits her paragraph after keeping it has a new row to decide, with a new decision, and the
 * earlier line stays as history.
 */
const sameDecision = (a: Pick<FolioDecision, 'row' | 'seen' | 'part'>, b: Pick<FolioDecision, 'row' | 'seen' | 'part'>): boolean =>
  a.row === b.row && (!a.row.startsWith('text:') || (a.seen === b.seen && a.part === b.part))

type Read = { versions: Map<string, FolioVersion>; order: Map<string, number>; marks: Map<string, FolioMarkState>; restores: Map<string, FolioRestore> }
type DecisionRead = { decisions: Map<string, FolioDecision[]>; intents: Map<string, FolioDecisionIntent[]> }
export type NewFolioDecision = Omit<FolioDecision, 'kind' | 'ts'> & { ts?: number }
export type NewFolioDecisionIntent = Omit<FolioDecisionIntent, 'kind' | 'ts'> & { ts?: number }

export class FolioVersionStore {
  #queue: Promise<unknown> = Promise.resolve()

  /** `ws` is anything with the Collection's `root` (a `Workspace`). */
  constructor(private readonly ws: { readonly root: string }) {}

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

  /**
   * The journal as it stands. No file: empty. A link or non-regular file at the journal path is
   * refused with a sentence (an empty history would be a false answer). A line that does not parse
   * has no authority. A Folio version id seen twice keeps its first record (records are immutable);
   * a restore's latest line per id wins; a version's mark lines are folded in journal order (delta lines
   * add to what came before, an older full line replaces it).
   */
  async #read(): Promise<Read> {
    const out: Read = { versions: new Map(), order: new Map(), marks: new Map(), restores: new Map() }
    const markLines = new Map<string, FolioVersionMark[]>()
    const file = await readStoreFile(this.ws.root, FOLIO_VERSIONS_JOURNAL_REL)
    if (file.state === 'absent') return out
    if (file.state === 'refused') throw new Error(`WriteFlex could not read the Folio version history: ${file.message}`)
    let index = 0
    for (const line of file.bytes.toString('utf8').split('\n')) {
      const record = parseFolioJournalLine(line)
      if (!record) continue
      index += 1
      if (record.kind === 'folio-version') {
        if (!out.versions.has(record.id)) {
          out.versions.set(record.id, record)
          out.order.set(record.id, index)
        }
      } else if (record.kind === 'folio-version-mark') markLines.set(record.id, [...(markLines.get(record.id) ?? []), record])
      else out.restores.set(record.id, record)
    }
    for (const [id, lines] of markLines) out.marks.set(id, foldFolioMarks(lines))
    return out
  }

  /**
   * The decisions file as it stands. No file: nothing decided. A refused file (a link, a non-regular file) is an error, never an empty answer.
   * A decision is final: the first record for a row stands, a later one has no authority (a three-text row: the first per row and digest, `sameDecision`). Intents are kept in file order.
   */
  async #readDecisions(): Promise<DecisionRead> {
    const out: DecisionRead = { decisions: new Map(), intents: new Map() }
    const file = await readStoreFile(this.ws.root, FOLIO_DECISIONS_JOURNAL_REL)
    if (file.state === 'absent') return out
    if (file.state === 'refused') throw new Error(`WriteFlex could not read the decisions about incoming revisions: ${file.message}`)
    for (const line of file.bytes.toString('utf8').split('\n')) {
      const record = parseFolioDecisionLine(line)
      if (!record) continue
      if (record.kind === 'folio-decision') {
        const held = out.decisions.get(record.id) ?? []
        if (!held.some((entry) => sameDecision(entry, record))) out.decisions.set(record.id, [...held, record])
      } else out.intents.set(record.id, [...(out.intents.get(record.id) ?? []), record])
    }
    return out
  }

  async #appendRecord(record: FolioJournalRecord | FolioDecisionRecord, what: string, rel: string = FOLIO_VERSIONS_JOURNAL_REL): Promise<void> {
    assertCollectionWritable(this.ws.root)
    // Non-recursive: a link at `.writeflex` fails EEXIST here and is refused by the checked append.
    await mkdir(join(await realpath(this.ws.root), '.writeflex')).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
    try {
      await appendStoreLine(this.ws.root, rel, `${JSON.stringify(record)}\n`)
    } catch (error) {
      if (error instanceof StoreAppendRefused) throw new Error(`WriteFlex did not ${what}: ${error.message}`)
      throw error
    }
  }

  /** The record, rebuilt by the one parser; a value the parser refuses is never written. */
  #wellFormed<T extends FolioJournalRecord>(candidate: T): T {
    const record = parseFolioJournalRecord(candidate)
    if (!record || record.kind !== candidate.kind) throw new Error('Refusing to persist a malformed Folio version record.')
    return record as T
  }

  #wellFormedDecision<T extends FolioDecisionRecord>(candidate: T): T {
    const record = parseFolioDecisionRecord(candidate)
    if (!record || record.kind !== candidate.kind) throw new Error('Refusing to persist a malformed Folio version record.')
    return record as T
  }

  /**
   * Add a Folio version. Refused with nothing written when: the record is malformed or carries a path that
   * is not Collection-relative; the id is already used; the Index Note's `versionId` is not among the
   * per-file versions the Index Note has now; or any member's `versionId` is not a per-file version
   * of this Collection. A Folio version that points nowhere is never recorded.
   */
  async append(input: NewFolioVersion): Promise<FolioVersion> {
    return this.#run(async () => {
      const version = this.#wellFormed<FolioVersion>({ ...input, kind: 'folio-version', id: input.id ?? makeId('fv'), ts: input.ts ?? Date.now() })
      const history = readMovedVersions(this.ws.root)
      if (!history.some((v) => v.path === version.index.path && v.id === version.index.versionId)) {
        throw new Error('WriteFlex did not record this Folio version: its Index Note has no such file version.')
      }
      const known = new Set(history.map((v) => v.id))
      if (version.members.some((m) => m.role !== 'reference' && !known.has(m.versionId))) {
        throw new Error('WriteFlex did not record this Folio version: one of its files points at a file version that is not in this Collection.')
      }
      if ((await this.#read()).versions.has(version.id)) throw new Error(`WriteFlex did not record this Folio version: ${version.id} is already used.`)
      await this.#appendRecord(version, 'record this Folio version')
      return version
    })
  }

  /**
   * The Folio versions, newest first, latest mark applied. With `indexPath` (the Index Note's path
   * now): those of that Folio, found through the Index Note's per-file history so they survive a
   * move of the Folio folder. Without it: every Folio version in the journal.
   */
  async list(indexPath?: string): Promise<ListedFolioVersion[]> {
    return this.#run(async () => {
      const read = await this.#read()
      const own = indexPath === undefined ? null : new Set(readMovedVersions(this.ws.root).filter((v) => v.path === indexPath).map((v) => v.id))
      return [...read.versions.values()]
        .filter((version) => own === null || own.has(version.index.versionId))
        .sort((a, b) => b.ts - a.ts || (read.order.get(b.id) ?? 0) - (read.order.get(a.id) ?? 0))
        .map((version) => applyMark(version, read.marks.get(version.id)))
    })
  }

  async get(id: string): Promise<ListedFolioVersion | null> {
    return this.#run(async () => {
      const read = await this.#read()
      const version = read.versions.get(id)
      return version ? applyMark(version, read.marks.get(id)) : null
    })
  }

  /**
   * Rename, mark as sent, or withdraw a Folio version. Appends one delta record carrying only the
   * fields this call changes; the earlier lines stay, and the state is every mark line folded in
   * journal order. Another store over the same Collection appending its own change at the same time
   * therefore loses nothing: the two deltas compose. Refused when the version is not here.
   */
  async mark(id: string, change: FolioMarkChange, opts: { ts?: number } = {}): Promise<ListedFolioVersion> {
    return this.#run(async () => {
      const before = await this.#read()
      if (!before.versions.has(id)) throw new Error(`No Folio version with id ${id}.`)
      const name = change.name === undefined ? undefined : change.name.trim()
      if (name === '') throw new Error('Folio version name cannot be blank.')
      const mark = this.#wellFormed<FolioVersionMark>({
        kind: 'folio-version-mark',
        id,
        ts: opts.ts ?? Date.now(),
        delta: true,
        ...(name !== undefined ? { name } : {}),
        ...(change.sentTo === undefined ? {} : { sentTo: change.sentTo === null ? null : change.sentTo.trim() }),
        ...(change.withdrawn === undefined ? {} : { withdrawn: change.withdrawn }),
      })
      await this.#appendRecord(mark, 'record this change to a Folio version')
      const after = await this.#read()
      return applyMark(after.versions.get(id) ?? before.versions.get(id)!, after.marks.get(id))
    })
  }

  /**
   * Record the state of a whole-Folio restore. `from` and `safety` must be Folio versions here. An id
   * that is already `done` or `cancelled` takes no further record.
   */
  async recordRestore(input: NewFolioRestore): Promise<FolioRestore> {
    return this.#run(async () => {
      const restore = this.#wellFormed<FolioRestore>({ ...input, kind: 'folio-restore', id: input.id ?? makeId('fr'), ts: input.ts ?? Date.now() })
      const read = await this.#read()
      if (!read.versions.has(restore.from) || !read.versions.has(restore.safety)) throw new Error('WriteFlex did not record this restore: it names a Folio version that is not here.')
      const state = read.restores.get(restore.id)?.state
      if (state === 'done' || state === 'cancelled') throw new Error(`WriteFlex did not record this restore: ${restore.id} is already ${state}.`)
      await this.#appendRecord(restore, 'record this restore')
      return restore
    })
  }

  /**
   * Record the writer's decision about one thing in an incoming revision (ticket 16), in the decisions file. Refused, with nothing written, when the version is not
   * an incoming revision here, is withdrawn, or the row is already decided: a decision is final, so a second one for the same row never lands (a three-text row
   * is decided over its three texts: a decision over texts that have changed since is a new one).
   */
  async recordDecision(input: NewFolioDecision): Promise<FolioDecision> {
    return this.#run(async () => {
      const decision = this.#wellFormedDecision<FolioDecision>({ ...input, kind: 'folio-decision', ts: input.ts ?? Date.now() })
      await this.#openRevision(decision.id, 'record this decision')
      if (((await this.#readDecisions()).decisions.get(decision.id) ?? []).some((entry) => sameDecision(entry, decision))) throw new Error('WriteFlex did not record this decision: that row is already decided.')
      await this.#appendRecord(decision, 'record this decision', FOLIO_DECISIONS_JOURNAL_REL)
      return decision
    })
  }

  /**
   * Record, BEFORE the file is made, that the decision for `row` will make `file` holding bytes with this hash. Refused, with nothing written, under the
   * same rules as a decision. Several intents for a row are fine (a retry that chose a fresh name); only the file one names is ever adopted.
   */
  async recordDecisionIntent(input: NewFolioDecisionIntent): Promise<FolioDecisionIntent> {
    return this.#run(async () => {
      const intent = this.#wellFormedDecision<FolioDecisionIntent>({ ...input, kind: 'folio-decision-intent', ts: input.ts ?? Date.now() })
      await this.#openRevision(intent.id, 'note what this decision will make')
      if (((await this.#readDecisions()).decisions.get(intent.id) ?? []).some((entry) => entry.row === intent.row)) throw new Error('WriteFlex did not note what this decision will make: that row is already decided.')
      await this.#appendRecord(intent, 'note what this decision will make', FOLIO_DECISIONS_JOURNAL_REL)
      return intent
    })
  }

  /** The revision must be an incoming one here and not withdrawn. */
  async #openRevision(id: string, what: string): Promise<void> {
    const read = await this.#read()
    const version = read.versions.get(id)
    if (!version?.incoming) throw new Error(`WriteFlex did not ${what}: it names a revision that is not here.`)
    if (read.marks.get(id)?.withdrawn) throw new Error(`WriteFlex did not ${what}: that revision is withdrawn.`)
  }

  /** The decisions made about one incoming revision, oldest first (the first record per row). */
  async listDecisions(id: string): Promise<FolioDecision[]> {
    return this.#run(async () => (await this.#readDecisions()).decisions.get(id) ?? [])
  }

  /** The intents recorded for one incoming revision, in the order they were written. */
  async listDecisionIntents(id: string): Promise<FolioDecisionIntent[]> {
    return this.#run(async () => (await this.#readDecisions()).intents.get(id) ?? [])
  }

  /** Each restore at its latest state, oldest first; `unfinished` keeps those still `begun`. */
  async listRestores(opts: { unfinished?: boolean } = {}): Promise<FolioRestore[]> {
    return this.#run(async () => {
      const all = [...(await this.#read()).restores.values()]
      return opts.unfinished ? all.filter((restore) => restore.state === 'begun') : all
    })
  }

  /** Keep bytes in the write-once object area. Writing an object that is already there changes nothing. */
  putObject(bytes: Uint8Array): Promise<{ sha256: string; created: boolean }> {
    return putFolioObject(this.ws.root, bytes)
  }

  /** The bytes of an object, or null when there is none. An object that does not hash to its name is refused (throws). */
  getObject(sha256: string): Promise<Buffer | null> {
    return getFolioObject(this.ws.root, sha256)
  }
}

function applyMark(version: FolioVersion, mark: FolioMarkState | undefined): ListedFolioVersion {
  if (!mark) return version
  return {
    ...version,
    ...(mark.name !== undefined ? { name: mark.name } : {}),
    ...(mark.sentTo !== undefined ? { sentTo: mark.sentTo } : {}),
    ...(mark.withdrawn ? { withdrawn: true as const } : {}),
  }
}

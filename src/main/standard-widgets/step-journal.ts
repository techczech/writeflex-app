/**
 * The step journal of a widget step that moves documents (the own-folder step of Create and insert), so that a step
 * stopped by a crash or a quit can be seen and cleaned up at the next launch. Main process only.
 *
 * While the step runs, `.writeflex/widget-step-<id>.json` lists what it has done so far: the folders it made, the
 * files it made (with the SHA-256 of what it left in them), the files it rewrote (what they held before and after)
 * and the files it removed; and its phase: `copying` (the originals are all still there) or `removing` (the last
 * part, the old names being removed). It is rewritten in the tick of every write the step commits, by a guarded
 * write (the `.writeflex` folder a real folder directly in the Workspace's real folder, the same folder before the
 * temporary file is opened and before it takes the journal's name; the temporary file opened O_EXCL|O_NOFOLLOW),
 * and removed when the step is done or put back.
 *
 * At launch (`readLeftoverSteps`) a journal left behind is shown to the writer, never acted on by itself. Its
 * Clean up (`cleanUpLeftoverStep`) puts the step back with the step's own guarded put-back: the links it rewrote
 * first (only where they still hold what the step wrote), then the files it made, each only while it holds exactly
 * what the step left; nothing it made is removed if anything before could not be put back. A step stopped while
 * `removing` is past its commit point: the documents are in their new place, and Clean up removes nothing; the old
 * copies still standing are named for the writer.
 */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, posix } from 'node:path'
import { realpath } from 'node:fs/promises'
import { walkNoFollowSync } from '../widget-file'
import type { OperationWrite, Workspace } from '../workspace'
import { putBackStep, putBackMessage, sha256, type FolderId, type StepChange } from './step-put-back'
import { folderIdentity, removeMadeFolders, type MadeFolder } from './step-folders'

const STORE = '.writeflex'
const PREFIX = 'widget-step-'
const JOURNAL_NAME = /^widget-step-[a-z0-9-]{1,80}\.json$/

export type StepPhase = 'copying' | 'removing'
export type JournalRecord = {
  version: 1
  kind: 'widget-own-folder-step'
  id: string
  startedAt: string
  /** The document the widget went into, where it was. */
  document: string
  /** The new folder the documents went into. */
  folder: string
  phase: StepPhase
  /** The files the step moves (copied first; the old names removed in the `removing` phase). */
  moves: Array<{ from: string; to: string }>
  /** Every copy the step makes, with the evidence of its original: the original's path and the SHA-256 of its bytes
   *  as they were read for the copy. Written to the journal before the copy is. Clean up removes copies only while
   *  every original is still there, a plain file holding exactly those bytes. */
  copies: Array<{ from: string; to: string; sha256: string }>
  /** Every folder a file of the step is in, with the identity the step recorded. */
  folders: Array<{ path: string; dev: number; ino: number }>
  made: MadeFolder[]
  created: Array<{ path: string; sha256: string }>
  rewritten: Array<{ path: string; before: string; after: string }>
  removed: string[]
}

class JournalRefused extends Error {}

/** The `.writeflex` folder of the Workspace: a real folder directly in its real folder (made when missing). */
function storeFolder(realRoot: string, make: boolean): { path: string; dev: number; ino: number } | null {
  const path = join(realRoot, STORE)
  let info = (() => { try { return lstatSync(path) } catch { return null } })()
  if (!info && make) {
    try { mkdirSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    info = lstatSync(path)
  }
  if (!info) return null
  if (!info.isDirectory()) throw new JournalRefused(`${STORE} is not a real folder, so WriteFlex keeps no step journal there`)
  return { path, dev: info.dev, ino: info.ino }
}

/** Write `text` as `.writeflex/<name>` by the guarded write in the module note, synchronously (in a commit's tick). */
function writeGuardedSync(realRoot: string, name: string, text: string): Buffer {
  const folder = storeFolder(realRoot, true)!
  const bytes = Buffer.from(text, 'utf8')
  const temp = join(folder.path, `${name}.${randomBytes(6).toString('hex')}.tmp`)
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  let ours: { dev: number; ino: number }
  try {
    writeSync(fd, bytes)
    fsyncSync(fd)
    const opened = fstatSync(fd)
    ours = { dev: opened.dev, ino: opened.ino }
  } finally { closeSync(fd) }
  const removeTemp = (): void => { try { const entry = lstatSync(temp); if (entry.dev === ours.dev && entry.ino === ours.ino) unlinkSync(temp) } catch { /* gone */ } }
  const now = (() => { try { return lstatSync(folder.path) } catch { return null } })()
  const entry = (() => { try { return lstatSync(temp) } catch { return null } })()
  const target = (() => { try { return lstatSync(join(folder.path, name)) } catch { return null } })()
  if (!now || !now.isDirectory() || now.dev !== folder.dev || now.ino !== folder.ino || !entry || !entry.isFile() || entry.nlink !== 1 || entry.dev !== ours.dev || entry.ino !== ours.ino || (target && !target.isFile())) {
    removeTemp()
    throw new JournalRefused(`${STORE}/${name} could not be written safely`)
  }
  renameSync(temp, join(folder.path, name))
  return bytes
}

/** The journal of one running step. */
export class StepJournal {
  readonly name: string
  #last: Buffer | null = null
  readonly record: JournalRecord

  constructor(private readonly realRoot: string, document: string, folder: string, moves: ReadonlyArray<{ from: string; to: string }>, readonly folders: Map<string, FolderId>, readonly made: MadeFolder[]) {
    const id = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
    this.name = `${PREFIX}${id}.json`
    this.record = { version: 1, kind: 'widget-own-folder-step', id, startedAt: new Date().toISOString(), document, folder, phase: 'copying', moves: moves.map((move) => ({ ...move })), copies: [], folders: [], made: [], created: [], rewritten: [], removed: [] }
    // A folder the step makes is in the journal from the tick it is checked to be the step's.
    made.push = (...folders: MadeFolder[]): number => {
      const count = Array.prototype.push.apply(made, folders)
      for (const folder of folders) this.folders.set(folder.path, { dev: folder.dev, ino: folder.ino })
      this.sync()
      return count
    }
  }

  #log: OperationWrite[] = []

  /** The step's record of writes, kept as the Workspace commits them: each write also notes its folder's identity
   *  (the first seen) and rewrites the journal, in the tick of the commit. */
  log(): OperationWrite[] {
    const log: OperationWrite[] = this.#log
    log.push = (...writes: OperationWrite[]): number => {
      const count = Array.prototype.push.apply(log, writes)
      for (const write of writes) {
        const folder = posix.dirname(write.path) === '.' ? '' : posix.dirname(write.path)
        if (!this.folders.has(folder)) { const id = folderIdentity(this.realRoot, folder); if (id) this.folders.set(folder, id) }
      }
      this.sync(log)
      return count
    }
    return log
  }

  /** Rewrite the journal from `log` (and the made folders, the phase). Throws when it cannot be written safely. */
  sync(log: readonly OperationWrite[] = this.#log): void {
    const byPath = new Map<string, { before: string | null; after: string | null }>()
    for (const write of log) {
      const known = byPath.get(write.path)
      if (known) known.after = write.after
      else byPath.set(write.path, { before: write.before, after: write.after })
    }
    const record = this.record
    record.folders = [...this.folders].map(([path, id]) => ({ path, dev: id.dev, ino: id.ino }))
    record.made = [...this.made]
    record.created = []
    record.rewritten = []
    record.removed = []
    for (const [path, { before, after }] of byPath) {
      if (before === null && after !== null) record.created.push({ path, sha256: sha256(after) })
      else if (before !== null && after !== null && before !== after) record.rewritten.push({ path, before, after })
      else if (before !== null && after === null) record.removed.push(path)
    }
    this.#last = writeGuardedSync(this.realRoot, this.name, `${JSON.stringify(record)}\n`)
  }

  /** Note the original of a copy about to be written (its bytes as read), in the journal before the copy exists. */
  noteCopy(from: string, to: string, read: Buffer): void {
    this.record.copies.push({ from, to, sha256: sha256(read) })
    this.sync()
  }

  setPhase(phase: StepPhase): void {
    this.record.phase = phase
    this.sync()
  }

  /** Remove the journal, only while it still holds what this step last wrote. */
  finish(): void {
    if (this.#last) removeJournal(this.realRoot, this.name, this.#last)
  }
}

/** Remove `.writeflex/<name>` (only while it holds `expected`, when given). Never throws: a journal that cannot be
 *  removed is shown again at the next launch, which is safe. */
function removeJournal(realRoot: string, name: string, expected?: Buffer): void {
  let folder: ReturnType<typeof storeFolder>
  try { folder = storeFolder(realRoot, false) } catch { return }
  if (!folder) return
  const path = join(folder.path, name)
  try {
    const entry = lstatSync(path)
    if (!entry.isFile()) return
    if (expected && !readFileSync(path).equals(expected)) return
    unlinkSync(path)
  } catch { /* gone */ }
}

export type LeftoverStep = {
  id: string
  phase: StepPhase
  startedAt: string
  document: string
  folder: string
  /** Files the step made that are still there (copies of documents, the widget's files). */
  leftover: string[]
  /** Copies of documents whose old names were not removed (a step stopped while `removing`), with where they went. */
  oldCopies: Array<{ from: string; to: string }>
  /** The notice's sentence. */
  message: string
}

function readJournal(realRoot: string, name: string): JournalRecord | null {
  if (!JOURNAL_NAME.test(name)) return null
  try {
    const path = join(realRoot, STORE, name)
    if (!lstatSync(path).isFile()) return null
    const record = JSON.parse(readFileSync(path, 'utf8')) as JournalRecord
    if (record?.version !== 1 || record.kind !== 'widget-own-folder-step' || `${PREFIX}${record.id}.json` !== name) return null
    if (![record.moves, record.copies, record.folders, record.made, record.created, record.rewritten, record.removed].every(Array.isArray)) return null
    return record
  } catch { return null }
}

const named = (paths: string[]): string => (paths.length <= 2 ? paths.join(' and ') : `${paths.slice(0, -1).join(', ')} and ${paths.at(-1)}`)

/** The copies Clean up must not remove: a copy still on disk whose original is missing, not a plain file reached
 *  without a link, or no longer holding the bytes it was copied from. A copy the journal has no evidence for (a file
 *  the step made in the documents' new folder or the widget's folder from a move or copy) counts as such too. */
function copiesWithoutOriginal(realRoot: string, record: JournalRecord): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = []
  // Every recorded original, whether or not its copy is still there.
  for (const copy of record.copies) if (!originalHolds(realRoot, copy)) out.push({ from: copy.from, to: copy.to })
  // A file standing where a move was going with no evidence recorded for it.
  for (const move of record.moves) {
    if (record.copies.some((copy) => copy.to === move.to)) continue
    if (walkNoFollowSync(realRoot, move.to).kind !== 'missing') out.push(move)
  }
  return out
}

/** Whether the original of `copy` is at its recorded path, a plain file reached without a link, holding exactly the
 *  bytes it was copied from. Synchronous: a caller may check it in the tick of an unlink. */
function originalHolds(realRoot: string, copy: { from: string; sha256: string }): boolean {
  if (walkNoFollowSync(realRoot, copy.from).kind !== 'file') return false
  try { return sha256(readFileSync(join(realRoot, ...copy.from.split('/')))) === copy.sha256 } catch { return false }
}

const keptSentence = (kept: Array<{ from: string; to: string }>): string =>
  kept.map((copy) => `${copy.to} was kept because its original ${copy.from} is missing or changed.`).join(' ')

function leftoverOf(realRoot: string, record: JournalRecord): LeftoverStep {
  const leftover = record.created.map((file) => file.path).filter((path) => walkNoFollowSync(realRoot, path).kind !== 'missing')
  const removed = new Set(record.removed)
  // A step stopped while removing: the old names not yet removed, each with where its copy is.
  const oldCopies = record.phase === 'removing' ? record.moves.filter((move) => !removed.has(move.from) && walkNoFollowSync(realRoot, move.from).kind === 'file') : []
  const orphaned = record.phase === 'copying' ? copiesWithoutOriginal(realRoot, record) : []
  const message = record.phase === 'copying'
    ? orphaned.length
      ? `WriteFlex stopped part-way through putting ${record.document} and a widget into ${record.folder}. The files it had made are still there: ${named(leftover)}. ${keptSentence(orphaned)} Clean up will not remove anything while that is so.`
      : `WriteFlex stopped part-way through putting ${record.document} and a widget into ${record.folder}. Your documents are where they were. The files it had made are still there: ${named(leftover)}. Clean up removes them and puts back the links it had changed.`
    : `WriteFlex stopped while finishing moving ${record.document} into ${record.folder}. The documents are in their new place.${oldCopies.length ? ` Their old copies are still there: ${named(oldCopies.map((copy) => copy.from))}. WriteFlex does not remove them; remove them yourself when you no longer need them.` : ''}`
  return { id: record.id, phase: record.phase, startedAt: record.startedAt, document: record.document, folder: record.folder, leftover, oldCopies, message }
}

/** The steps left by a crash or a quit in this Workspace, for the launch notice. Reads only. */
export async function readLeftoverSteps(ws: Workspace): Promise<LeftoverStep[]> {
  // In the Collection's write turn: a step running in this app is never mistaken for one left behind.
  return ws.exclusiveAll(() => readLeftovers(ws))
}

async function readLeftovers(ws: Workspace): Promise<LeftoverStep[]> {
  const realRoot = await realpath(ws.root)
  let folder: ReturnType<typeof storeFolder>
  try { folder = storeFolder(realRoot, false) } catch { return [] }
  if (!folder) return []
  let names: string[]
  try { names = readdirSync(folder.path).filter((name) => JOURNAL_NAME.test(name)).sort() } catch { return [] }
  return names.map((name) => readJournal(realRoot, name)).filter((record): record is JournalRecord => record !== null).map((record) => leftoverOf(realRoot, record))
}

export type CleanUpResult = { ok: true; message: string; restored: string[] } | { ok: false; message: string; restored: string[] }

/** The notice's Clean up (see the module note); a step past its commit point only has its journal put away. */
export async function cleanUpLeftoverStep(ws: Workspace, id: string): Promise<CleanUpResult> {
  if (typeof id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(id)) return { ok: false, message: 'There is no such step to clean up.', restored: [] }
  return ws.exclusiveAll(async () => {
    const realRoot = await realpath(ws.root)
    const name = `${PREFIX}${id}.json`
    const record = readJournal(realRoot, name)
    if (!record) return { ok: false, message: 'There is no such step to clean up.', restored: [] }
    if (record.phase === 'removing') {
      removeJournal(realRoot, name)
      return { ok: true, message: 'Nothing was removed. The documents stay in their new place.', restored: [] }
    }
    // All or nothing: while any copy's original is missing or changed, nothing is removed or put back.
    const orphaned = copiesWithoutOriginal(realRoot, record)
    if (orphaned.length) return { ok: false, message: `Nothing was removed or put back. ${keptSentence(orphaned)}`, restored: [] }
    const folders = new Map<string, FolderId>(record.folders.map((folder) => [folder.path, { dev: folder.dev, ino: folder.ino }]))
    // Each copy is removed only while its original holds, checked again in the tick of the copy's unlink: the links
    // are put back first (awaited writes), and an original may go meanwhile.
    const evidence = new Map(record.copies.map((copy) => [copy.to, copy]))
    const refusedCopies: Array<{ from: string; to: string }> = []
    const guardOf = (path: string): StepChange['guard'] => {
      const copy = evidence.get(path)
      if (!copy) return undefined
      return () => {
        if (originalHolds(realRoot, copy)) return null
        refusedCopies.push({ from: copy.from, to: copy.to })
        return `its original ${copy.from} is missing or changed`
      }
    }
    // Oldest first, as the step wrote them; the put-back orders them itself.
    const changes: StepChange[] = [
      ...record.rewritten.map((file) => ({ path: file.path, before: file.before, after: { text: file.after } })),
      ...record.created.map((file) => ({ path: file.path, before: null, after: { sha256: file.sha256 }, guard: guardOf(file.path) })),
    ]
    const outcome = await putBackStep(ws, realRoot, changes, folders, record.moves)
    // Stopped by a guard: no further removal of any kind, the step's folders included.
    if (refusedCopies.length) {
      // Stopped at a copy whose original went: the journal keeps what is still there, for another Clean up.
      record.created = record.created.filter((file) => walkNoFollowSync(realRoot, file.path).kind !== 'missing')
      try { writeGuardedSync(realRoot, name, `${JSON.stringify(record)}\n`) } catch { /* the older journal stands: it only lists more */ }
      const kept = outcome.kept.length ? ` ${named(outcome.kept)} ${outcome.kept.length === 1 ? 'was' : 'were'} kept too.` : ''
      return { ok: false, message: `Clean up stopped. ${keptSentence(refusedCopies)}${kept}`, restored: outcome.restored }
    }
    const left = removeMadeFolders(realRoot, record.made)
    if (outcome.failed.length || outcome.kept.length) {
      return { ok: false, message: putBackMessage('some of the step could not be put back.', outcome, left), restored: outcome.restored }
    }
    removeJournal(realRoot, name)
    const parts = [`Cleaned up: ${outcome.restored.length ? `${named(outcome.restored)} ${outcome.restored.length === 1 ? 'was' : 'were'} put back or removed.` : 'nothing was left to remove.'}`]
    if (outcome.changed.length) parts.push(`${named(outcome.changed)} changed after WriteFlex wrote ${outcome.changed.length === 1 ? 'it, so it was' : 'them, so they were'} left as ${outcome.changed.length === 1 ? 'it is' : 'they are'}.`)
    return { ok: true, message: parts.join(' '), restored: outcome.restored }
  })
}

/** Put a journal away without acting on it (the writer read the notice of a step past its commit point). */
export async function forgetLeftoverStep(ws: Workspace, id: string): Promise<void> {
  if (typeof id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(id)) return
  const realRoot = await realpath(ws.root)
  const record = readJournal(realRoot, `${PREFIX}${id}.json`)
  if (record && record.phase === 'removing') removeJournal(realRoot, `${PREFIX}${id}.json`)
}

export { JournalRefused }

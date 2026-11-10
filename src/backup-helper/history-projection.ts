/**
 * WriteFlex named-version history for the backup helper's capture projection (vault-sync projection.ts).
 * Capture runs in the separate helper. Main reuses the same read-only validator for explicit location confirmation; never in a renderer.
 *
 * What it projects, at the files' own paths and in their own formats (no new history format):
 * - `.writeflex/versions.jsonl`: the latest visible version records (parseVersionLine plus the app's
 *   shared move fold, with strict move-record validation at this boundary) whose
 *   document, after completed moves or unfinished physical evidence, is a strict vault-relative path (vaultPath:
 *   checked BEFORE the scope test, so a traversal or absolute name is never matched by a glob) in the
 *   vault's ordinary backup scope. Each line keeps only the record's own fields (id, path, name, author,
 *   ts, note, snapshotId, versionId, and a valid `folioSave` marker). A per-file version of a Folio save that never finished
 *   (an orphan: neither a Folio version nor a commit line has its `folioSave` id) is an ordinary kept version
 *   here and never makes the projection unavailable; its marker travels with it, so a restored copy hides it as this Mac does.
 * - `.writeflex/folio-save-commits.jsonl` (ADR-0052 § Compatibility): for a COMPLETED Folio save, one content-free commit line
 *   `{kind: 'folio-save-committed', id}` per save whose versions are kept (whether this Mac holds the commit line, or only the
 *   Folio record, after a crash between the two appends), so a restored copy keeps those versions visible even when the Folio
 *   record itself is left out of the backup (a member outside scope). It is a file of its own, never a line of
 *   `.writeflex/versions.jsonl`: a backup helper that predates it rejects a `kind` it does not know in that journal, and one Folio
 *   save would stop its backup. A helper that predates it never reads this file. A damaged line makes the projection unavailable.
 * - `.bridle/journal.jsonl`: for those versions only, the snapshot entry each names (`snapshotId`) and the
 *   restore point each names (`versionId`), in the journal's own order. Source identity is exact: a
 *   snapshot's `file` must be this folder's real root joined with the version's original snapshot-owner path, or exactly that
 *   path (the portable form this projection writes, with its fixed session id; a restored copy carries
 *   it). The checked move fold maps that owner to the current document path in the emitted copy.
 *   Unresolved held-back IDs are omitted, as in the app's visible reader. An external-root snapshot needs a private app-owned approval of its exact checked version/snapshot identity and current real root.
 *   Removing an exact original owner path only proposes a location; it never grants authority.
 *   Without approval the whole projection is unavailable; no external root is ever read. Every retained versionId needs its restore point, and the first write the
 *   journal records after that point must be the version's own snapshot, so the restore-point reader
 *   finds the same snapshot in the copy as on this Mac; a missing, discarded or otherwise-first point
 *   makes the whole projection unavailable (never a version kept with its point left out). Session ids
 *   are replaced by one fixed id and `file` by the document's vault-relative path: no machine path or
 *   session reaches a backup, and a restored copy gives no write authority outside its folder (Bridle's
 *   restore refuses a path that is not absolute). Capability, tool-call, attempt and proposal fields are
 *   not kept; the content readers never read them. A restored projection plus new local records is
 *   projected again in the same way.
 * - `.bridle/objects/<sha256>`: exactly the objects those snapshot entries name, each checked against its
 *   name. Nothing else of `.bridle` (agent sessions, other snapshots, undo records) and nothing of
 *   `changes.jsonl` (pending changes and the review ledger are not part of named versions).
 *
 * - `.writeflex/folio-versions.jsonl` (ADR-0052 § History projection and Git backup): the Folio version
 *   journal, every record rebuilt by the one parser (src/shared/folio-version-records.ts) so a field it
 *   does not know never leaves the Mac, in the journal's own order; and `.writeflex/folio-objects/<sha256>`:
 *   exactly the objects those records name (her original `.docx`, her converted sections), each checked
 *   against its name. A Folio version holds references only: each of its files (and its Index Note) must
 *   be among the per-file versions this projection keeps, and that version must have its saved text
 *   (a snapshot, which the loop above already requires to exist). A restored copy lists the same Folio
 *   versions. A vault with no Folio journal projects exactly what it projected before this was added.
 *   `canProjectFolioMembers` is the same rule asked before a save: a Folio version a backup would hold
 *   back is not created.
 *
 * - `.writeflex/folio-decisions.jsonl` (Folio versions ticket 16): the writer's decisions about an incoming revision, and the intents
 *   written before a decided new part's file is made. A file of its own, not lines of the Folio journal: the helper of 0.28.0-alpha.9
 *   rejects a kind it does not know in that journal and would stop the backup of ordinary writing. Every line is rebuilt by the one parser,
 *   must name a Folio version in the Folio journal, and goes with that version (left out with it). A damaged line, an unknown kind or a
 *   record naming a version that is not there makes the whole projection unavailable.
 *
 * Whole or nothing: a damaged line in any journal, an unknown record kind in the Folio journal, a
 * Folio version, mark or restore that names something not kept, a version naming a snapshot that is
 * missing, repeated or of another document, a missing or wrong object (history store or Folio), a link
 * or non-regular file anywhere on the way, a folder on the way swapped for a link or another folder
 * while it is read (every folder is bound by dev/ino, checked around each open and before acceptance), an
 * object with a second name that is not the Folio object store's own crash-orphan temporary name for it
 * (src/shared/folio-object-names.ts; the temporary names are never backed up), an object above the limit,
 * a count or byte limit passed (Folio objects count too), or any journal changing while it is read makes
 * the whole projection "unavailable"; capture then holds back (vault-sync capture.ts) and Turn on is
 * refused. A vault with no named versions is a complete, empty projection. Nothing here writes.
 *
 * Whole or nothing PER FOLIO VERSION, not per vault (ADR-0052 amendment, ticket 02): a Folio version with
 * a file whose document is outside ordinary backup scope (for example a part moved to the bin) is left out
 * entirely: record, marks, restores and objects. It is listed on the result (`folioLeftOut`) with a plain
 * reason. Everything else, including all ordinary writing and the other Folio versions, is still captured.
 * A member with no saved text (no snapshot) stays a refusal. Only the scope case degrades.
 *
 * Inserted files travel frozen (ADR-0052 amendment, 3 Nov 2026, option A): an `inserted` member (a table, an image, a widget page; not
 * Markdown, so outside ordinary scope) does not leave its Folio version out. The per-file version it names is carried as any per-file
 * version is (its record in `.writeflex/versions.jsonl`, its snapshot entry and restore point in `.bridle/journal.jsonl`, its
 * saved copy in `.bridle/objects/<sha256>`), but only for a Folio version that is itself carried, and only when `isInsertedFile`
 * (insertedFileScopeTest: the scope's exclusions without its includes, and never `.writeflex/`) accepts the version's current
 * path. The WORKING file is never sent: it is not in the projection, and capture's include list still matches Markdown only. An
 * inserted file in the bin still leaves the version out, with the plain reason. `reference` members hold a hash and are not carried.
 * Without `isInsertedFile` no inserted file outside ordinary scope is carried, which is how a caller that names none behaved before.
 *
 * Residual check/use window (accepted, ADR-0052 amendment, ticket 02): Node has no `openat`, so every identity check here is by
 * pathname (lstat of a folder or file, then open by path). A swap that is still in place at any check, or at the final lstat of the
 * file against the opened handle and the re-check of every pinned folder after it, is caught. A local process with write access to the vault
 * that races at syscall granularity (swap `.writeflex` for a link while a file is opened, put it back before the folder is re-checked,
 * swap it again around the file's lstat) can still get an external Folio journal read. The most it injects is content that parses as a
 * valid Folio journal, which such a process could write into the vault directly; so no native `openat` binding is built, and no
 * further pathname re-checks are added.
 *
 * Bounded: the engine owns the time budget and ignores a late answer; `signal` (aborted at the budget's
 * end or the caller's abort) stops the reads and every loop here. Lookups are by index, linear in the
 * journals. All emitted bytes (objects and both projected journals) count against `maxTotalBytes`.
 */
import { absoluteHistoryRoot, approvalBytes, historyCohort, historyDigest, loadHistoryApprovals, type EarlierLocations, type EarlierRecord } from './history-approvals'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { onlyOwnNames } from '../shared/folio-object-names'
import { parseVersionLine, type Version } from '../engine'
import { FOLIO_SAVE_COMMITTED, folioSaveOf, foldFolioMarks, parseFolioDecisionRecord, parseFolioJournalRecord, parseFolioSaveCommit, type FolioDecisionRecord, type FolioJournalRecord, type FolioMember, type FolioVersionMark } from '../shared/folio-version-records'
import { finishState, projectVersionRows, type JournalRecord, type MoveRecord, type MoveState } from '../engine/version-move-projection'
import { moveEvidence } from '../main/version-move-evidence'

export const WRITEFLEX_HISTORY_NAME = 'writeflex-named-versions'
export const VERSIONS_PATH = '.writeflex/versions.jsonl'
export const JOURNAL_PATH = '.bridle/journal.jsonl'
export const OBJECTS_PREFIX = '.bridle/objects/'
export const FOLIO_JOURNAL_PATH = '.writeflex/folio-versions.jsonl'
export const FOLIO_OBJECTS_PREFIX = '.writeflex/folio-objects/'
/** The writer's decisions about incoming revisions (folio-versions.ts); a file of its own so that a helper which reads only the Folio journal never meets them. */
export const FOLIO_DECISIONS_PATH = '.writeflex/folio-decisions.jsonl'
/** The commit lines of finished Folio saves (folio-save-commit.ts); a file of its own so that an older helper, which reads only `versions.jsonl`, never meets them. */
export const FOLIO_SAVE_COMMITS_PATH = '.writeflex/folio-save-commits.jsonl'
/** What a helper that predates Folio versions declares; kept so a test can state what such a helper sends. */
export const PER_FILE_HISTORY_NAMESPACES: readonly string[] = [VERSIONS_PATH, JOURNAL_PATH, OBJECTS_PREFIX]
export const HISTORY_NAMESPACES: readonly string[] = [...PER_FILE_HISTORY_NAMESPACES, FOLIO_JOURNAL_PATH, FOLIO_OBJECTS_PREFIX, FOLIO_SAVE_COMMITS_PATH, FOLIO_DECISIONS_PATH]
/** The one session id every projected journal entry carries instead of the session it came from. */
export const PROJECTED_SESSION = 'writeflex-backup'
const ABSENT = 'ABSENT'
const OBJECT_NAME = /^[0-9a-f]{64}$/

export type HistoryLimits = { maxJournalBytes: number; maxObjectBytes: number; maxTotalBytes: number; maxObjects: number }
export const DEFAULT_HISTORY_LIMITS: HistoryLimits = { maxJournalBytes: 64 * 1024 * 1024, maxObjectBytes: 100 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024, maxObjects: 50_000 }

export type ProjectedFile = { path: string; content: Buffer }
/**
 * A Folio version a backup leaves out whole because one of its files is outside the ordinary backup scope
 * (for example moved to the bin). `reason` is a plain sentence naming the version and the file and what to do.
 * Nothing of the version (its record, marks, restores or objects) is in the projection.
 */
export type FolioLeftOut = { id: string; name: string; file: string; reason: string; withdrawn?: true }
/**
 * `folioVersions` is present only when the vault has Folio versions, so a vault without any reads exactly as before.
 * `summary` stays numbers only (the vault-sync engine's `ProjectionRead.summary` is `Record<string, number>`): `folioLeftOut`
 * counts the Folio versions left out, and the list itself is `folioLeftOut` on the result (present only when not empty).
 * The engine does not carry that list; the backup status UI (tickets 03 and 05) reads it from the main-side call of this reader.
 */
export type HistoryRead = { state: 'complete'; files: ProjectedFile[]; summary: { namedVersions: number; folioVersions?: number; folioLeftOut?: number }; folioLeftOut?: FolioLeftOut[] } | { state: 'unavailable'; reason: string; earlier?: EarlierLocations }
export type HistoryProjection = { name: string; namespaces: readonly string[]; read(root: string, signal?: AbortSignal): Promise<HistoryRead> }
/** The default for a caller that names no frozen-copy scope: no inserted file outside ordinary scope is carried (a Folio version with one is left out, as before option A). */
const NO_INSERTED_FILES = (): boolean => false
/** A version's document path, as it must be before any scope test: vault-relative, plain, bounded. */
const MAX_DOCUMENT_PATH = 4096

/**
 * @internal Test seams. `afterFirstRead` runs between the first read of the journals and their re-read.
 * `beforeOpen` runs after a file's folder has been judged and immediately before the file is opened, with the
 * file's absolute path (so a test can change the folder at that exact instant).
 */
export const historySeams: { afterFirstRead?: (root: string) => void | Promise<void>; beforeOpen?: (abs: string) => void | Promise<void> } = {}

class Unavailable extends Error {}
const unavailable = (reason: string): never => { throw new Unavailable(reason) }

/** A folder judged once: its path as shown, and the identity every later read must still find at that path. */
type Pinned = { abs: string; shown: string; dev: number; ino: number }

/** A folder on the way, if present, must be a real folder (not a link). Returns its identity, or null when it does not exist. */
async function realFolder(abs: string, shown: string): Promise<Pinned | null> {
  let info
  try { info = await lstat(abs) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return unavailable(`${shown} cannot be read`)
  }
  if (!info.isDirectory()) unavailable(`${shown} is not an ordinary folder`)
  return { abs, shown, dev: info.dev, ino: info.ino }
}

/** The folder is still the real folder judged: not swapped for a link or for another folder since. */
async function stillThere(folder: Pinned): Promise<void> {
  let info
  try { info = await lstat(folder.abs) } catch { return unavailable(`${folder.shown} changed while named versions were read`) }
  if (!info.isDirectory() || info.dev !== folder.dev || info.ino !== folder.ino) unavailable(`${folder.shown} changed while named versions were read`)
}

/**
 * The bytes of a regular file with one name, never through a link; null when it does not exist. `O_NOFOLLOW`
 * guards only the last name, so the folders on the way are bound by identity: each is checked before the
 * open, again after it (the opened file is then known to have been reached through the judged folders) and
 * again by the caller before the projection is accepted. `ownTempsOf` names an object whose own crash-orphan
 * temporary names (src/shared/folio-object-names.ts) may account for extra links; none of them is ever read.
 */
async function readRegular(abs: string, shown: string, max: number, signal?: AbortSignal, folders: readonly Pinned[] = [], ownTempsOf?: string): Promise<Buffer | null> {
  signal?.throwIfAborted()
  for (const folder of folders) await stillThere(folder)
  await historySeams.beforeOpen?.(abs)
  let handle
  try {
    handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') { for (const folder of folders) await stillThere(folder); return null }
    return unavailable(code === 'ELOOP' ? `${shown} is a link` : `${shown} cannot be read`)
  }
  try {
    for (const folder of folders) await stillThere(folder)
    const info = await handle.stat()
    if (!info.isFile()) unavailable(`${shown} is not an ordinary file with one name`)
    if (info.nlink !== 1 && !(ownTempsOf !== undefined && await onlyOwnNames(dirname(abs), ownTempsOf, info))) unavailable(`${shown} is not an ordinary file with one name`)
    if (info.size > max) unavailable(`${shown} is larger than the backup limit`)
    const bytes = await handle.readFile(signal ? { signal } : {})
    if (bytes.length > max) unavailable(`${shown} is larger than the backup limit`)
    // The name still leads to the file that was read, and the folders are still the ones judged. The handle is asked again
    // after the read, so the identity compared with the path is the handle's own at this moment, not the one taken at the start.
    const after = await handle.stat()
    const named = await lstat(abs).catch(() => null)
    if (after.dev !== info.dev || after.ino !== info.ino || !named || !named.isFile() || named.dev !== after.dev || named.ino !== after.ino) unavailable(`${shown} changed while named versions were read`)
    for (const folder of folders) await stillThere(folder)
    return bytes
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * A strict vault-relative document path: POSIX, not absolute, no drive letter, backslash or NUL, no
 * empty, "." or ".." part, no ".git" part, at most MAX_DOCUMENT_PATH characters.
 */
export function vaultPath(path: unknown): path is string {
  if (typeof path !== 'string' || path === '' || path.length > MAX_DOCUMENT_PATH) return false
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0') || /^[A-Za-z]:/.test(path)) return false
  return path.split('/').every((p) => p !== '' && p !== '.' && p !== '..' && p.toLowerCase() !== '.git')
}

/** One file of a Folio version, as the save knows it: its vault-relative path and, when known, its size in bytes. */
export type FolioMemberFile = { path: string; bytes?: number; /** An inserted file: judged by the frozen-copy scope (`isInsertedFile`), not the ordinary document scope. */ inserted?: true }
export type FolioProjectable = { ok: true } | { ok: false; file: string; reason: 'bad-path' | 'outside-scope' | 'too-large'; message: string }

/**
 * Can a Folio version made of these files be sent by backup? `files` are the members that carry saved
 * text (not `reference` members, which hold a hash only). False when a file's path is not a strict
 * vault-relative one, when the vault's ordinary backup scope (`isDocument`) would not capture it, or
 * when it, or the files together, are larger than the backup's object or total limit. The message is a
 * plain sentence naming the file; the save refuses with it before writing anything.
 */
export function canProjectFolioMembers(files: readonly FolioMemberFile[], isDocument: (path: string) => boolean, limits: HistoryLimits = DEFAULT_HISTORY_LIMITS, isInsertedFile: (path: string) => boolean = NO_INSERTED_FILES): FolioProjectable {
  let total = 0
  for (const file of files) {
    const shown = typeof file.path === 'string' ? file.path : String(file.path)
    if (!vaultPath(file.path)) return { ok: false, file: shown, reason: 'bad-path', message: `"${shown}" is not a path inside this folder, so a version that includes it could not be backed up.` }
    // The ordinary scope is asked only about paths vaultPath accepts (the same order the projection uses).
    if (!(file.inserted ? isInsertedFile(file.path) : isDocument(file.path))) return { ok: false, file: shown, reason: 'outside-scope', message: `"${shown}" is outside what backup sends, so a Folio version that includes it would be held back from your backup.` }
    if (file.bytes !== undefined) {
      total += file.bytes
      if (file.bytes > limits.maxObjectBytes) return { ok: false, file: shown, reason: 'too-large', message: `"${shown}" is larger than the ${Math.floor(limits.maxObjectBytes / (1024 * 1024))} MiB a backup holds for one file, so a Folio version that includes it would be held back from your backup.` }
      if (total > limits.maxTotalBytes) return { ok: false, file: shown, reason: 'too-large', message: `With "${shown}", the files of this Folio version are larger together than the ${Math.floor(limits.maxTotalBytes / (1024 * 1024))} MiB a backup holds, so it would be held back from your backup.` }
    }
  }
  return { ok: true }
}

const digest = (bytes: Buffer | null): string => bytes === null ? 'absent' : createHash('sha256').update(bytes).digest('hex')

/** The record's own fields only, in the order VersionStore writes them. */
function projectedVersion(v: Version): string {
  return JSON.stringify({
    path: v.path, name: v.name, author: v.author.email === undefined ? { name: v.author.name } : { name: v.author.name, email: v.author.email },
    ...(v.note !== undefined ? { note: v.note } : {}), ...(v.snapshotId !== undefined ? { snapshotId: v.snapshotId } : {}), ...(v.versionId !== undefined ? { versionId: v.versionId } : {}),
    // A Folio save's marker (folio-save-commit.ts): kept, so a restored copy treats an unfinished save's versions as the orphans they are.
    ...(folioSaveOf(v) !== undefined ? { folioSave: folioSaveOf(v) } : {}),
    id: v.id, ts: v.ts,
  })
}

type Entry = Record<string, unknown> & { kind?: unknown; id?: unknown }

/**
 * Reads the projection of `root` (the folder's real path, as the engine passes it). `isDocument(path)` is
 * the vault's ordinary backup scope for a vault-relative path (the same scope the helper captures
 * documents with); it is asked only about paths vaultPath accepts.
 */
export async function readHistoryProjection(root: string, isDocument: (path: string) => boolean, limits: HistoryLimits = DEFAULT_HISTORY_LIMITS, signal?: AbortSignal, approvalFile?: string, isInsertedFile: (path: string) => boolean = NO_INSERTED_FILES): Promise<HistoryRead> {
  try {
    return await read(root, isDocument, limits, signal, approvalFile, isInsertedFile)
  } catch (error) {
    // Aborted: the engine has already stopped waiting; say so rather than describe a damaged history.
    if (signal?.aborted) return { state: 'unavailable', reason: 'reading named versions was stopped' }
    if (error instanceof Unavailable) return { state: 'unavailable', reason: error.message }
    return { state: 'unavailable', reason: `named versions could not be read (${String((error as Error)?.message ?? error).slice(0, 200)})` }
  }
}

const isWrite = (e: Entry): boolean => e.kind === 'snapshot' || e.kind === 'undo-action'

async function read(root: string, isDocument: (path: string) => boolean, limits: HistoryLimits, signal?: AbortSignal, approvalFile?: string, isInsertedFile: (path: string) => boolean = NO_INSERTED_FILES): Promise<HistoryRead> {
  // Unrelated vaults need no approval authority and must not depend on this Mac's ledger.
  let approvals: ReturnType<typeof loadHistoryApprovals> | undefined
  const approvalAuthority = () => {
    if (!approvals) {
      try { approvals = loadHistoryApprovals(approvalFile) }
      catch { unavailable('the earlier-location approval record on this Mac cannot be read') }
    }
    return approvals!
  }
  const earlier: EarlierRecord[] = []
  const versionsAbs = join(root, '.writeflex', 'versions.jsonl')
  const journalAbs = join(root, '.bridle', 'journal.jsonl')
  const writeflexDir = await realFolder(join(root, '.writeflex'), '.writeflex')
  if (!writeflexDir) return { state: 'complete', files: [], summary: { namedVersions: 0 } }
  // Every folder judged here is bound by identity: each read below is bracketed by a check that the folder is still it,
  // and all are checked again before the projection is accepted (a folder swapped for a link to another store is never read).
  const pinned: Pinned[] = [writeflexDir]
  const versionsBytes = await readRegular(versionsAbs, VERSIONS_PATH, limits.maxJournalBytes, signal, [writeflexDir])
  const bridleDir = await realFolder(join(root, '.bridle'), '.bridle')
  const hasBridle = bridleDir !== null
  if (bridleDir) pinned.push(bridleDir)
  const journalBytes = bridleDir ? await readRegular(journalAbs, JOURNAL_PATH, limits.maxJournalBytes, signal, [bridleDir]) : null
  const folioAbs = join(root, '.writeflex', 'folio-versions.jsonl')
  const folioBytes = await readRegular(folioAbs, FOLIO_JOURNAL_PATH, limits.maxJournalBytes, signal, [writeflexDir])
  const commitsAbs = join(root, '.writeflex', 'folio-save-commits.jsonl')
  const commitsBytes = await readRegular(commitsAbs, FOLIO_SAVE_COMMITS_PATH, limits.maxJournalBytes, signal, [writeflexDir])
  const decisionsAbs = join(root, '.writeflex', 'folio-decisions.jsonl')
  const decisionsBytes = await readRegular(decisionsAbs, FOLIO_DECISIONS_PATH, limits.maxJournalBytes, signal, [writeflexDir])

  // Strict boundary around the app's shared fold: its forgiving disk reader is not a validator.
  const rows: JournalRecord[] = []
  const recordedIds = new Set<string>()
  const commits = new Set<string>()
  const sourcePaths = new Map<string, string>()
  const snapshotKey = (v: Version) => `${v.id}\0${v.snapshotId ?? ''}`
  const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
  const ids = (v: unknown): boolean => Array.isArray(v) && v.every(x => typeof x === 'string' && x.length > 0) && new Set(v).size === v.length
  const bad = () => unavailable(`${VERSIONS_PATH} has a damaged line or unsupported move record`)
  for (const line of (versionsBytes?.toString('utf8') ?? '').split('\n')) {
    signal?.throwIfAborted()
    if (!line.trim()) continue
    let row: unknown
    try { row = JSON.parse(line) } catch { bad() }
    if (!object(row)) bad()
    const r = row as Record<string, any>
    if (r.kind === undefined) {
      const version = parseVersionLine(line)
      if (!version) bad()
      if (!vaultPath(version!.path)) unavailable('a named version names a document path that is not inside this folder')
      recordedIds.add(version!.id)
      rows.push(version!)
    } else if (r.kind === 'version-paths') {
      if (typeof r.id !== 'string' || !r.id || !Array.isArray(r.assignments)
        || !r.assignments.every(a => object(a) && typeof a.id === 'string' && recordedIds.has(a.id) && vaultPath(a.from) && vaultPath(a.to))
        || new Set(r.assignments.map(a => a.id)).size !== r.assignments.length) bad()
      if (r.ts !== undefined && (typeof r.ts !== 'number' || !Number.isFinite(r.ts))) bad()
      for (const key of ['destinationIds', 'reattachedIds', 'heldBackIds']) if (r[key] !== undefined && !ids(r[key])) bad()
      if (r.undoes !== undefined && (typeof r.undoes !== 'string' || !r.undoes)) bad()
      if (r.evidence !== undefined) {
        const e = r.evidence
        if (!object(e) || !vaultPath(e.from) || !vaultPath(e.to) || !Number.isSafeInteger(e.dev) || !Number.isSafeInteger(e.ino) || e.dev < 0 || e.ino < 0) bad()
        for (const key of ['hash', 'beforeHash']) if (e[key] !== undefined && (typeof e[key] !== 'string' || !OBJECT_NAME.test(e[key]))) bad()
      }
      rows.push(r as MoveRecord)
    } else if (r.kind === 'version-paths-finish' && typeof r.id === 'string' && r.id && (r.state === 'done' || r.state === 'cancelled')) {
      rows.push(r as JournalRecord)
    } else if (r.kind === FOLIO_SAVE_COMMITTED) {
      // Only an early build of the Folio save wrote its commit line here (it now writes `folio-save-commits.jsonl`); a vault it saved in
      // must still project. Read as the commit line it is; never written back here.
      const commit = parseFolioSaveCommit(r)
      if (!commit) bad()
      commits.add(commit!.id)
    } else bad()
  }
  for (const line of (commitsBytes?.toString('utf8') ?? '').split('\n')) {
    signal?.throwIfAborted()
    if (!line.trim()) continue
    let row: unknown
    try { row = JSON.parse(line) } catch { unavailable(`${FOLIO_SAVE_COMMITS_PATH} has a damaged line`) }
    const commit = parseFolioSaveCommit(row)
    if (!commit) unavailable(`${FOLIO_SAVE_COMMITS_PATH} has a damaged line`)
    commits.add(commit!.id)
  }
  const intents = new Set(rows.flatMap(r => 'kind' in r && r.kind === 'version-paths' ? [r.id] : []))
  if (intents.size !== rows.filter(r => 'kind' in r && r.kind === 'version-paths').length
    || rows.some(r => 'kind' in r && r.kind === 'version-paths-finish' && !intents.has(r.id))) bad()
  const evidenceStates = new Map<NonNullable<MoveRecord['evidence']>, MoveState>()
  const finished = finishState(rows)
  for (const row of rows) {
    signal?.throwIfAborted()
    if ('kind' in row && row.kind === 'version-paths' && row.evidence && !finished.has(row.id)) {
      // Yield between bounded physical reads so the helper's projection budget can abort the fold.
      await setImmediate(undefined, signal ? { signal } : {})
      evidenceStates.set(row.evidence, moveEvidence(root, row.evidence))
    }
  }
  const moved = projectVersionRows(rows, e => evidenceStates.get(e)!, (v, current) => {
    const key = snapshotKey(v), source = sourcePaths.get(key)
    // A renamed label may carry the current mapped path; it cannot invent a new snapshot owner.
    if (source !== undefined && v.path !== source && v.path !== current?.path) unavailable('a named version has conflicting snapshot ownership')
    if (source === undefined) sourcePaths.set(key, v.path)
  }, () => signal?.throwIfAborted())
  const inScope = new Map<string, Version>()
  for (const v of moved.visible) if (isDocument(v.path)) inScope.set(v.id, v)
  // The Folio journal is judged here, before the per-file versions to keep are fixed: a Folio version it carries brings the frozen
  // per-file versions of its inserted files with it (ADR-0052 amendment, option A), which are outside ordinary scope by themselves.
  const visibleById = new Map<string, Version>()
  for (const v of moved.visible) visibleById.set(v.id, v)
  const folio = folioBytes === null ? null : projectFolioJournal(folioBytes, inScope, visibleById, isInsertedFile, signal)
  const decisions = decisionsBytes === null ? null : projectDecisions(decisionsBytes, folio?.ids ?? new Set<string>(), new Set((folio?.leftOut ?? []).map((entry) => entry.id)), signal)
  const selected = new Map<string, Version>()
  for (const v of moved.visible) if (inScope.has(v.id) || folio?.frozen.has(v.id)) selected.set(v.id, v)
  // Per-file versions of a left-out Folio version that no kept version sends: not emitted, but their snapshot entries and objects are
  // judged exactly as a carried one's, so an integrity failure there is never hidden by the scope omission.
  const checkOnly: Version[] = []
  for (const v of moved.visible) if (folio?.validate.has(v.id) && !selected.has(v.id)) checkOnly.push(v)
  // Materialise the resolved public view. Move intents are not replayed in a restored copy: their
  // inodes are machine-local, and held-back IDs must never become visible there.
  const keptLines = [...selected.values()]

  // Bridle's journal as SnapshotStore reads it: JSON objects per line; discarded restore points are not public.
  const records: Entry[] = []
  for (const line of (journalBytes?.toString('utf8') ?? '').split('\n')) {
    signal?.throwIfAborted()
    if (line.trim() === '') continue
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { parsed = null }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) unavailable(`${JOURNAL_PATH} has a damaged line`)
    records.push(parsed as Entry)
  }
  const discarded = new Set(records.flatMap((e) => e.kind === 'discard-restore-point' && typeof e.restorePointId === 'string' ? [e.restorePointId] : []))
  const visible = records.filter((e) => !(e.kind === 'discard-restore-point' || e.kind === 'turn-undo-intent' || e.kind === 'turn-undo-settled') && !(e.kind === 'restore-point' && discarded.has(String(e.id))))
  const byId = new Map<string, number[]>()
  visible.forEach((e, i) => {
    if (typeof e.id !== 'string') return
    const at = byId.get(e.id)
    if (at) at.push(i)
    else byId.set(e.id, [i])
  })
  // The first write after each entry (Bridle's snapshotRestorePointPath), in one backward pass.
  const nextWrite = new Array<number>(visible.length)
  for (let i = visible.length - 1, next = -1; i >= 0; i--) {
    nextWrite[i] = next
    if (isWrite(visible[i]!)) next = i
  }

  const keep = new Map<number, Entry>()
  const hashes = new Set<string>()
  const verifyOnly = new Set<string>()
  for (const [v, emit] of [...keptLines.map((v) => [v, true] as const), ...checkOnly.map((v) => [v, false] as const)]) {
    signal?.throwIfAborted()
    const path = v.path
    if (v.snapshotId === undefined) {
      if (v.versionId !== undefined) unavailable(`a named version names a restore point but no snapshot`)
      continue
    }
    const at = byId.get(v.snapshotId) ?? []
    if (at.length !== 1) unavailable(at.length === 0 ? `a named version's snapshot is missing from ${JOURNAL_PATH}` : `a named version's snapshot id is not unique in ${JOURNAL_PATH}`)
    const e = visible[at[0]!]!
    if (e.kind !== 'snapshot') unavailable(`a named version names a journal entry that is not a snapshot`)
    const hash = e.hash
    if (typeof hash !== 'string' || (hash !== ABSENT && !OBJECT_NAME.test(hash))) unavailable(`a named version's snapshot names something that is not one of the history store's objects`)
    // Exact source identity: this folder's real root and the version's path, or the portable form this
    // projection writes (a restored copy). Any other root is refused, never matched by its last names.
    const owner = sourcePaths.get(snapshotKey(v))!
    const portable = e.file === owner && e.sessionId === PROJECTED_SESSION
    if (!portable && e.file !== `${root}/${owner}`) {
      // Exact owner removal proposes a location only. Authority is an exact checked record digest.
      const suffix = `/${owner}`
      const oldRoot = typeof e.file === 'string' && e.file.endsWith(suffix) ? e.file.slice(0, -suffix.length) : null
      if (!absoluteHistoryRoot(oldRoot) || oldRoot === root || oldRoot.startsWith(`${root}/`)) unavailable("a named version's snapshot is of another file than its document")
      const identity = historyDigest(JSON.stringify([v.id, v.snapshotId, v.versionId ?? null, owner, e]))
      if (!approvalAuthority().records.get(root)?.has(identity)) earlier.push({ identity, oldRoot: oldRoot! })
    }
    if (typeof e.ts !== 'number' || !Number.isFinite(e.ts)) unavailable(`a named version's snapshot has no time`)
    if (emit) {
      const already = keep.get(at[0]!)
      if (already && already.file !== path) unavailable('named versions map one snapshot to different documents')
      keep.set(at[0]!, { kind: 'snapshot', id: e.id, ts: e.ts, sessionId: PROJECTED_SESSION, file: path, hash, origin: 'host' })
    }
    if (hash !== ABSENT) (emit ? hashes : verifyOnly).add(hash as string)
    if (v.versionId === undefined) continue
    // The restore point is part of what the version means: it must exist, be unique and lead to this snapshot.
    const points = (byId.get(v.versionId) ?? []).filter((i) => visible[i]!.kind === 'restore-point')
    if (points.length === 0) unavailable(`a named version's restore point is missing or discarded in ${JOURNAL_PATH}`)
    if (points.length > 1) unavailable(`a named version's restore point is not unique in ${JOURNAL_PATH}`)
    const p = points[0]!
    if (nextWrite[p] !== at[0]) unavailable(`a named version's restore point leads first to another write than the version's own snapshot`)
    const point = visible[p]!
    if (typeof point.ts !== 'number' || !Number.isFinite(point.ts)) unavailable(`a named version's restore point has no time`)
    if (emit) keep.set(p, { kind: 'restore-point', id: point.id, ts: point.ts, sessionId: PROJECTED_SESSION, label: `version: ${path}` })
  }
  for (const hash of hashes) verifyOnly.delete(hash)
  if (hashes.size + verifyOnly.size + (folio?.checked.size ?? 0) > limits.maxObjects) unavailable(`named versions name more than ${limits.maxObjects} history objects`)

  const files: ProjectedFile[] = []
  let total = 0
  const count = (bytes: number): void => {
    total += bytes
    if (total > limits.maxTotalBytes) unavailable('named versions are larger in total than the backup limit')
  }
  const objectsDir = hashes.size + verifyOnly.size > 0 ? await realFolder(join(root, '.bridle', 'objects'), '.bridle/objects') : null
  if (hashes.size + verifyOnly.size > 0 && !objectsDir) unavailable(`${OBJECTS_PREFIX} is missing`)
  if (objectsDir) pinned.push(objectsDir)
  for (const hash of [...new Set([...hashes, ...verifyOnly])].sort()) {
    const bytes = await readRegular(join(root, '.bridle', 'objects', hash), `${OBJECTS_PREFIX}${hash}`, limits.maxObjectBytes, signal, [bridleDir!, objectsDir!])
    if (bytes === null) unavailable(`a named version's object ${hash.slice(0, 12)}… is missing`)
    if (createHash('sha256').update(bytes!).digest('hex') !== hash) unavailable(`a named version's object ${hash.slice(0, 12)}… does not match its name`)
    if (!hashes.has(hash)) continue
    count(bytes!.length)
    files.push({ path: `${OBJECTS_PREFIX}${hash}`, content: bytes! })
  }
  const folioDir = folio && folio.checked.size > 0 ? await realFolder(join(root, '.writeflex', 'folio-objects'), '.writeflex/folio-objects') : null
  if (folio && folio.checked.size > 0 && !folioDir) unavailable(`${FOLIO_OBJECTS_PREFIX} is missing`)
  if (folioDir) pinned.push(folioDir)
  // Every object a Folio record names is read and checked against its name; only those a kept version needs are sent (and counted).
  for (const hash of [...(folio?.checked ?? [])].sort()) {
    // The object's own crash-orphan temporary names may account for extra links (the store tolerates them); no other second name.
    const bytes = await readRegular(join(root, '.writeflex', 'folio-objects', hash), `${FOLIO_OBJECTS_PREFIX}${hash}`, limits.maxObjectBytes, signal, [writeflexDir, folioDir!], hash)
    if (bytes === null) unavailable(`a Folio version's object ${hash.slice(0, 12)}… is missing`)
    if (createHash('sha256').update(bytes!).digest('hex') !== hash) unavailable(`a Folio version's object ${hash.slice(0, 12)}… does not match its name`)
    if (!folio!.objects.has(hash)) continue
    count(bytes!.length)
    files.push({ path: `${FOLIO_OBJECTS_PREFIX}${hash}`, content: bytes! })
  }

  // Both journals must be exactly as first read: a version saved meanwhile is taken by the next capture.
  await historySeams.afterFirstRead?.(root)
  for (const [e, state] of evidenceStates) {
    await setImmediate(undefined, signal ? { signal } : {})
    signal?.throwIfAborted()
    if (moveEvidence(root, e) !== state) unavailable('version move evidence changed while named versions were read')
  }

  if (digest(await readRegular(versionsAbs, VERSIONS_PATH, limits.maxJournalBytes, signal, [writeflexDir])) !== digest(versionsBytes)) unavailable('named versions changed while they were read')
  if (bridleDir && digest(await readRegular(journalAbs, JOURNAL_PATH, limits.maxJournalBytes, signal, [bridleDir])) !== digest(journalBytes)) unavailable('the history journal changed while it was read')
  if (digest(await readRegular(folioAbs, FOLIO_JOURNAL_PATH, limits.maxJournalBytes, signal, [writeflexDir])) !== digest(folioBytes)) unavailable('the Folio version history changed while it was read')
  if (digest(await readRegular(commitsAbs, FOLIO_SAVE_COMMITS_PATH, limits.maxJournalBytes, signal, [writeflexDir])) !== digest(commitsBytes)) unavailable('the Folio save commit lines changed while they were read')
  if (digest(await readRegular(decisionsAbs, FOLIO_DECISIONS_PATH, limits.maxJournalBytes, signal, [writeflexDir])) !== digest(decisionsBytes)) unavailable('the decisions about incoming revisions changed while they were read')
  // Last look before anything is accepted: every folder read from is still the one judged.
  for (const folder of pinned) await stillThere(folder)

  if (keptLines.length > 0) {
    const content = Buffer.from(keptLines.map((v) => `${projectedVersion(v)}\n`).join(''), 'utf8')
    count(content.length)
    files.push({ path: VERSIONS_PATH, content })
  }
  // A kept version of a Folio save stays visible in a restored copy when its save is complete, whichever journal says so
  // (folio-save-commit.ts): a commit line, or the Folio record (a crash between the two appends). The Folio record may itself
  // be left out of the projection (a member outside scope); the content-free commit line travels all the same, in its own file
  // (never in versions.jsonl: an older helper rejects an unknown kind there). An unfinished save gets none, and its versions
  // stay hidden orphans here and in the copy.
  const completed = new Set([...commits, ...(folio?.ids ?? [])])
  const commitLines = [...new Set(keptLines.flatMap((v) => folioSaveOf(v) ?? []))].filter((id) => completed.has(id)).map((id) => `${JSON.stringify({ kind: FOLIO_SAVE_COMMITTED, id })}\n`)
  if (commitLines.length > 0) {
    const content = Buffer.from(commitLines.join(''), 'utf8')
    count(content.length)
    files.push({ path: FOLIO_SAVE_COMMITS_PATH, content })
  }
  const entries = [...keep.keys()].sort((a, b) => a - b).map((i) => `${JSON.stringify(keep.get(i))}\n`)
  if (entries.length > 0) {
    const content = Buffer.from(entries.join(''), 'utf8')
    count(content.length)
    files.push({ path: JOURNAL_PATH, content })
  }
  if (folio && folio.lines.length > 0) {
    const content = Buffer.from(folio.lines.join(''), 'utf8')
    count(content.length)
    files.push({ path: FOLIO_JOURNAL_PATH, content })
  }
  if (decisions && decisions.length > 0) {
    const content = Buffer.from(decisions.join(''), 'utf8')
    count(content.length)
    files.push({ path: FOLIO_DECISIONS_PATH, content })
  }
  if (approvals && approvalBytes(approvalFile).state !== approvals.state) unavailable('history approvals changed while named versions were read')
  if (earlier.length) {
    const counts = new Map<string, number>()
    for (const r of earlier) counts.set(r.oldRoot, (counts.get(r.oldRoot) ?? 0) + 1)
    if (counts.size > 32 || earlier.length > 50000) unavailable('too many earlier locations or named versions to confirm')
    return { state: 'unavailable', reason: 'snapshots recorded outside this folder need confirmation of a possible earlier location', earlier: {
      cohort: historyCohort(root, versionsBytes, journalBytes), records: earlier,
      roots: [...counts].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([root,namedVersions]) => ({ root, namedVersions })), approvalState: approvalAuthority().state,
    } }
  }
  const leftOut = folio?.leftOut ?? []
  return {
    state: 'complete', files,
    summary: { namedVersions: inScope.size, ...(folio && folio.versions > 0 ? { folioVersions: folio.versions } : {}), ...(leftOut.length > 0 ? { folioLeftOut: leftOut.length } : {}) },
    ...(leftOut.length > 0 ? { folioLeftOut: leftOut } : {}),
  }
}

/** The sha256 names of the objects a Folio version record keeps in `.writeflex/folio-objects/`. */
function folioObjects(record: FolioJournalRecord): string[] {
  if (record.kind !== 'folio-version' || !record.incoming) return []
  return [record.incoming.docx.sha256, ...record.incoming.sections.flatMap((section) => section.object === undefined ? [] : [section.object])]
}

const BIN_FOLDER = '.trash'
const ROLE_WORD: Record<string, string> = { index: 'Index Note', part: 'part', unlisted: 'file', inserted: 'inserted file' }

/** Why a Folio version is left out: names the version and the file and says what to do. */
function leftOutReason(name: string, role: string, path: string, withdrawn: boolean): string {
  const file = path.split('/').pop() ?? path
  const what = `${ROLE_WORD[role] ?? 'file'} ${file}`
  // `.trash` is a folder of the vault (an Obsidian-style trash), not the Folio bin (`<folio>/.folio-bin`, which stays in backup scope and shows in the Binder), so it is named as the folder it is.
  const where = path.split('/')[0] === BIN_FOLDER ? `is in the ${BIN_FOLDER} folder` : `is outside what backup sends (${path})`
  const fix = `Move the ${ROLE_WORD[role] ?? 'file'} back into your writing to back it up.`
  return `'${name}' is not in the backup because ${what} ${where}.${withdrawn ? ` You withdrew this version, so you can leave it, or ${fix.charAt(0).toLowerCase()}${fix.slice(1)}` : ` ${fix}`}`
}

/**
 * The Folio journal as it is projected: each line rebuilt by the one parser (nothing it does not know
 * survives), in the journal's own order, plus the objects those records name.
 *
 * Whole or nothing for the journal: a line that does not parse, a line of an unknown kind, a Folio
 * version whose Index Note or file is not among the per-file versions at all (or has no saved text), a
 * mark or restore naming a Folio version that is not in the journal, make the projection unavailable.
 *
 * Whole or nothing for each Folio version (ADR-0052 amendment, ticket 02): a Folio version with a file whose per-file version
 * is kept out of ordinary backup scope (a part in the bin) is left out entirely, never partly and never by
 * bypassing scope: its record, its marks, any restore naming it, and objects only it names. It is listed in
 * `leftOut` with a plain reason; everything else is still projected. Integrity failures are never degraded: every object any record names is validated, left out or not.
 */
function projectFolioJournal(bytes: Buffer, kept: ReadonlyMap<string, Version>, visible: ReadonlyMap<string, Version>, isInsertedFile: (path: string) => boolean, signal?: AbortSignal): { lines: string[]; objects: Set<string>; checked: Set<string>; ids: Set<string>; frozen: Set<string>; validate: Set<string>; versions: number; leftOut: FolioLeftOut[] } {
  const records: FolioJournalRecord[] = []
  for (const line of bytes.toString('utf8').split('\n')) {
    signal?.throwIfAborted()
    if (line.trim() === '') continue
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { parsed = null }
    const record = parseFolioJournalRecord(parsed)
    if (!record) {
      const kind = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { kind?: unknown }).kind : undefined
      const known = kind === 'folio-version' || kind === 'folio-version-mark' || kind === 'folio-restore'
      return unavailable(!known && typeof kind === 'string' ? `${FOLIO_JOURNAL_PATH} has a line of a kind this version of WriteFlex does not know` : `${FOLIO_JOURNAL_PATH} has a damaged line`)
    }
    records.push(record)
  }
  const ids = new Set(records.flatMap((r) => r.kind === 'folio-version' ? [r.id] : []))
  const marks = new Map<string, FolioVersionMark[]>()
  for (const r of records) if (r.kind === 'folio-version-mark') marks.set(r.id, [...(marks.get(r.id) ?? []), r])
  const leftOutIds = new Map<string, FolioLeftOut>()
  // The per-file versions of inserted files that are outside ordinary scope, of the Folio versions that are carried (never of a left-out one).
  const frozen = new Set<string>()
  // The per-file versions of members outside ordinary scope (a binned part, a binned or other inserted file) of the Folio versions that are
  // left out: nothing of theirs is sent, but their saved text is checked like a carried version's.
  const validate = new Set<string>()
  for (const record of records) {
    signal?.throwIfAborted()
    if (record.kind === 'folio-version') {
      let first: { role: string; path: string } | null = null
      const frozenHere: string[] = []
      const awayHere: string[] = []
      const files = [{ role: 'index', versionId: record.index.versionId, what: 'Index Note' }, ...(record.members as FolioMember[]).filter((m) => m.role !== 'reference').map((m) => ({ role: m.role, versionId: (m as { versionId: string }).versionId, what: `file ${m.path}` }))]
      for (const f of files) {
        const version = kept.get(f.versionId)
        if (version) {
          if (version.snapshotId === undefined) unavailable(`a Folio version's ${f.what} has no saved text in the history`)
          continue
        }
        const away = visible.get(f.versionId)
        if (!away) unavailable(`a Folio version's ${f.what} is not among the file versions a backup keeps`)
        // Saved text is required of every member, in scope or not: a version without it is never safely "left out".
        if (away!.snapshotId === undefined) unavailable(`a Folio version's ${f.what} has no saved text in the history`)
        awayHere.push(f.versionId)
        // An inserted file is carried as the frozen copy this per-file version holds (never as the working file), wherever it sits
        // unless it is in the bin or another place the backup never sends from.
        if (f.role === 'inserted' && isInsertedFile(away!.path)) { frozenHere.push(f.versionId); continue }
        // The file's version exists but its document is outside ordinary scope now: only this Folio version is held back.
        first ??= { role: f.role, path: away!.path }
      }
      if (!first) for (const id of frozenHere) frozen.add(id)
      if (first) for (const id of awayHere) validate.add(id)
      if (first) {
        const state = foldFolioMarks(marks.get(record.id) ?? [])
        const withdrawn = state.withdrawn === true
        const name = state.name ?? record.name
        leftOutIds.set(record.id, { id: record.id, name, file: first.path, reason: leftOutReason(name, first.role, first.path, withdrawn), ...(withdrawn ? { withdrawn: true as const } : {}) })
      }
    } else if (record.kind === 'folio-version-mark') {
      if (!ids.has(record.id)) unavailable('a change to a Folio version names a Folio version that is not in the journal')
    } else if (!ids.has(record.from) || !ids.has(record.safety)) unavailable('a Folio restore names a Folio version that is not in the journal')
  }
  const lines: string[] = []
  // `checked`: every object any record names, kept or left out, so a damaged object cannot hide behind a scope omission.
  // `objects`: only what the kept records need, which is all that is sent.
  const objects = new Set<string>()
  const checked = new Set<string>()
  for (const record of records) {
    for (const object of folioObjects(record)) checked.add(object)
    const dropped = record.kind === 'folio-version' || record.kind === 'folio-version-mark' ? leftOutIds.has(record.id) : leftOutIds.has(record.from) || leftOutIds.has(record.safety)
    if (dropped) continue
    lines.push(`${JSON.stringify(record)}\n`)
    for (const object of folioObjects(record)) objects.add(object)
  }
  return { lines, objects, checked, ids, frozen, validate, versions: ids.size - leftOutIds.size, leftOut: [...leftOutIds.values()] }
}

/**
 * The decisions file as it is projected: each line rebuilt by the one parser (nothing it does not know survives), in the file's own order.
 * Whole or nothing: a line that does not parse, a line of an unknown kind, or a record naming a Folio version that is not in the Folio journal
 * makes the projection unavailable. A record of a Folio version that is left out goes with it.
 */
function projectDecisions(bytes: Buffer, versionIds: ReadonlySet<string>, leftOut: ReadonlySet<string>, signal?: AbortSignal): string[] {
  const lines: string[] = []
  for (const line of bytes.toString('utf8').split('\n')) {
    signal?.throwIfAborted()
    if (line.trim() === '') continue
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { parsed = null }
    const record: FolioDecisionRecord | null = parseFolioDecisionRecord(parsed)
    if (!record) {
      const kind = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { kind?: unknown }).kind : undefined
      return unavailable(typeof kind === 'string' && !kind.startsWith('folio-decision') ? `${FOLIO_DECISIONS_PATH} has a line of a kind this version of WriteFlex does not know` : `${FOLIO_DECISIONS_PATH} has a damaged line`)
    }
    if (!versionIds.has(record.id)) return unavailable('a decision about a revision names a Folio version that is not in the journal')
    if (leftOut.has(record.id)) continue
    lines.push(`${JSON.stringify(record)}\n`)
  }
  return lines
}

/** The projection for one vault, given its ordinary scope test. */
export function writeflexHistoryProjection(isDocument: (path: string) => boolean, limits: HistoryLimits = DEFAULT_HISTORY_LIMITS, approvalFile?: string, isInsertedFile: (path: string) => boolean = NO_INSERTED_FILES): HistoryProjection {
  return { name: WRITEFLEX_HISTORY_NAME, namespaces: HISTORY_NAMESPACES, read: (root, signal) => readHistoryProjection(root, isDocument, limits, signal, approvalFile, isInsertedFile) }
}

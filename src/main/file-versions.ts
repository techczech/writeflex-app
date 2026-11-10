/**
 * Versions of an inserted file: a table, a widget page, an image or any other file that is not Markdown (Folio versions ticket 19, ADR-0052
 * § How members reference per-file versions). One headless module the app's panel, the command line and the agent's verbs all call.
 *
 * WHAT IT READS AND WRITES. A file version is an ordinary per-file version: one restore point and one snapshot in Bridle's store (`.bridle/journal.jsonl`,
 * `.bridle/objects/<sha256>`, written by `snapshotVersionOfSavedText`, so identical bytes are one object) and one line in `.writeflex/versions.jsonl`.
 * Nothing new is added to the Folio journal or to `versions.jsonl`: the Folio versions that used a file version are DERIVED, by reverse lookup over
 * `members[].versionId`, and a restore or a copy writes no record of a kind an older backup helper does not know (the alpha.9 helper calls `bad()` on
 * any row of an unknown kind in `versions.jsonl`). What this module appends is only plain version lines, as ⇧⌘S does.
 *
 * THE RULES (the review lessons of tickets 09 to 16, applied):
 *  - Every operation runs under the Collection's write turn (`workspace.exclusive`), asks `confirmOwner` and the write gate before each store or file
 *    it writes, and judges the path first: a Collection-relative name, not Markdown, not in a hidden folder, no link in the way (the guarded read and
 *    write refuse a final link and a folder swapped for a link).
 *  - The size cap (25 MiB) is checked from the file's size BEFORE its bytes are read, and a saved copy is read with a bounded read (at most the cap plus
 *    one byte). Above the cap a file is not given file versions: a Folio version lists it as a reference.
 *  - A snapshot stores the bytes this module judged (`snapshotBytes`), never a second read of the file by name, so no object over the cap can be made, and
 *    nothing in the history store is ever deleted here.
 *  - A restore is bound to what the writer saw: the saved copy's hash and the working copy's hash (or "no file"). If either differs now, nothing is written.
 *  - Whole or nothing: bytes go to a temporary file beside the file and take its name by rename (a rewrite) or by a hard link (a new file: fails if the name is
 *    taken). Nothing is written in place.
 *  - A restore APPENDS a new file version and deletes nothing. If the working copy is not held by any version, it is saved first ("Before restoring …").
 *  - "Save as a copy" creates one new ordinary file by exclusive create and never overwrites; it keeps the file's type and stays in the file's folder; it
 *    writes no version record.
 *
 * Electron-free.
 */
import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { posix } from 'node:path'
import {
  FILE_VERSION_CAP_BYTES, FILE_VERSION_CAP_LABEL, WORKING_COPY, compareFileBytes, fileKindOf, isMarkdownDocument, restoredName,
  type FileCompare, type FileVersionRefusal, type FolioInsertedFile, type FileVersionRow, type FileVersionsListing, type FileWorking, type RestoreFileVersionResult, type SaveFileCopyResult, type SaveFileVersionResult,
} from '../shared/file-versions'
import { cellsDiffering } from '../shared/folio-version-changes'
import { folioSaveOf } from '../shared/folio-version-records'
import type { VersionSnapshotResult } from './agent'
import { FolioGatherRefused, gatherFolio } from './folio-version-members'
import { assertCollectionWritable } from './collection-write-gate'
import type { FolioVersionStore } from './folio-versions'
import { DocumentReadRefused, readDocumentBytesGuarded } from './guarded-document-read'
import { GuardedWriteRefused, writeDocumentGuarded, type WriteSeams } from './guarded-document-write'
import type { AuthorIdentity, Version, VersionStore } from './versions'
import type { Workspace } from './workspace'

/** A refusal of a file-version operation, in words for the person; nothing was written when it is thrown before the first write. */
export class FileVersionRefused extends Error {
  override readonly name = 'FileVersionRefused'
  constructor(message: string, readonly code: FileVersionRefusal = 'refused') {
    super(message)
  }
}

/** The seams, so a test can run the operations over a synthetic Collection without a window. */
export type FileVersionStores = {
  workspace: Workspace
  versions: Pick<VersionStore, 'list' | 'append'>
  folioVersions: Pick<FolioVersionStore, 'list'>
  /**
   * Take a per-file version's snapshot of EXACTLY these bytes (`snapshotBytesOfSavedText`, or the agent's method that calls it): the bytes this module read,
   * capped and judged. The file is never read again for a snapshot, so what is stored is what was judged, whatever the file became in between.
   */
  snapshotBytes: (path: string, bytes: Uint8Array) => Promise<VersionSnapshotResult>
  /** The SHA-256 each snapshot holds, from one read of the journal (`snapshotHashesOf`). */
  snapshotHashes: (snapshotIds: readonly string[]) => Promise<Map<string, string>>
  /** The exact bytes a snapshot holds, refused (`'too-large'`) from the object's size before it is read; null when there is none. */
  readSnapshotBytes: (snapshotId: string, maxBytes: number) => Promise<Buffer | 'too-large' | null>
  author: AuthorIdentity
  /** Throws when this process does not hold the Collection now. Asked before each store or file is written. */
  confirmOwner: () => Promise<void>
  /**
   * SYNCHRONOUS: throws when the Collection binding this operation was made for (its window, its generation, its root) no longer stands. Run in the tick
   * of the rename or link that commits a restore or a copy (the guarded writer's `beforeCommit`), because `confirmOwner` is asked before the writer awaits
   * its path checks, staging and fingerprint, and the binding can be lost during that wait. Absent: only `confirmOwner` guards the write.
   */
  assertBound?: () => void
  /** Default `FILE_VERSION_CAP_BYTES`. */
  cap?: number
  seams?: WriteSeams
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const refuse = (message: string, code: FileVersionRefusal = 'refused'): never => { throw new FileVersionRefused(message, code) }
const capOf = (stores: Pick<FileVersionStores, 'cap'>): number => stores.cap ?? FILE_VERSION_CAP_BYTES
const mib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
const nameOf = (path: string): string => path.split('/').pop() ?? path

/** A path the operations will work on: written the way the Collection writes one, not Markdown, and a document of the Collection (not in a hidden folder, not outside it). */
export function checkedFilePath(workspace: Pick<Workspace, 'classifyPath'>, input: unknown): string {
  if (typeof input !== 'string' || input === '' || input.length > 1000 || input.includes('\0') || input.includes('\\') || input.startsWith('/')) return refuse('That is not a file of this Collection. Nothing was changed.')
  const path = posix.normalize(input)
  if (path !== input || path === '..' || path.startsWith('../') || path.endsWith('/')) return refuse('That is not a file of this Collection. Nothing was changed.')
  if (isMarkdownDocument(path)) return refuse(`${nameOf(path)} is a Markdown document: its versions are kept in the editor (Save version…), where its waiting changes are settled. Nothing was changed.`, 'markdown')
  const verdict = workspace.classifyPath(path, 'file')
  if (verdict === 'hidden') return refuse(`${path} is in a folder WriteFlex keeps for itself or hides, so it has no file versions.`)
  if (verdict !== 'document') return refuse(`${path} is outside this Collection.`)
  return path
}

/** What stands at the file's name now, read without reading more than the cap. */
type Working = { kind: 'missing' } | { kind: 'unreadable'; why: string } | { kind: 'too-large'; bytes: number } | { kind: 'ok'; bytes: Buffer; sha256: string }

async function readWorking(workspace: Workspace, path: string, cap: number): Promise<Working> {
  const info = await lstat(workspace.absolute(path)).catch(() => null)
  if (info === null) return { kind: 'missing' }
  if (info.isSymbolicLink()) return { kind: 'unreadable', why: `${nameOf(path)} is a link, not a file of its own, so it has no file versions.` }
  if (!info.isFile()) return { kind: 'unreadable', why: `${nameOf(path)} is not an ordinary file, so it has no file versions.` }
  // The size is judged BEFORE a byte is read: a file over the cap is never pulled into memory.
  if (info.size > cap) return { kind: 'too-large', bytes: info.size }
  try {
    const read = await readDocumentBytesGuarded(workspace, path, { maxBytes: cap })
    return { kind: 'ok', bytes: read.bytes, sha256: sha256(read.bytes) }
  } catch (error) {
    if (error instanceof DocumentReadRefused) {
      if (error.code === 'missing') return { kind: 'missing' }
      if (error.code === 'too-large') return { kind: 'too-large', bytes: info.size }
      return { kind: 'unreadable', why: error.message }
    }
    throw error
  }
}

const tooLarge = (path: string, bytes: number): never => refuse(`${nameOf(path)} is ${mib(bytes)}, over ${FILE_VERSION_CAP_LABEL}, so it is not given file versions: a Folio version lists it as a reference and keeps no copy. Nothing was changed.`, 'too-large')

type Held = { version: Version; number: number }

/** The versions of `path` that hold a copy, newest first, with their numbers (1 for the oldest), as the cursor panel numbers them. */
async function heldVersions(stores: Pick<FileVersionStores, 'versions'>, path: string): Promise<Held[]> {
  const all = (await stores.versions.list({ path })).filter((version) => version.snapshotId !== undefined)
  const oldestFirst = [...all].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
  const number = new Map(oldestFirst.map((version, at) => [version.id, at + 1]))
  return all.map((version) => ({ version, number: number.get(version.id)! }))
}

/** The bytes of a version's saved copy, checked against its hash; refuses with a sentence when they cannot be had or are not what was seen. */
async function savedCopy(stores: Pick<FileVersionStores, 'snapshotHashes' | 'readSnapshotBytes' | 'cap'>, held: Held, expect?: string): Promise<Buffer> {
  const snapshotId = held.version.snapshotId!
  const hashes = await stores.snapshotHashes([snapshotId]).catch(() => new Map<string, string>())
  const hash = hashes.get(snapshotId)
  if (!hash) return refuse(`The saved copy of v${held.number} “${held.version.name}” is not in the history store, so it cannot be used.`, 'unavailable')
  if (expect !== undefined && hash !== expect) return refuse(`v${held.number} “${held.version.name}” is not the copy you were looking at. Nothing was written. Look at the list again and choose it once more.`, 'changed')
  const bytes = await stores.readSnapshotBytes(snapshotId, capOf(stores))
  if (bytes === 'too-large') return refuse(`The saved copy of v${held.number} “${held.version.name}” is over ${FILE_VERSION_CAP_LABEL}, so it is not used here.`, 'too-large')
  if (bytes === null || sha256(bytes) !== hash) return refuse(`The saved copy of v${held.number} “${held.version.name}” is not in the history store, or is damaged, so it cannot be used.`, 'unavailable')
  return bytes
}

/** Whether version `held`'s saved copy is really there: its object exists, is within the cap, and its bytes hash to the name the journal gives it. */
async function holdsCopy(stores: Pick<FileVersionStores, 'readSnapshotBytes' | 'cap'>, held: Held, hash: string): Promise<boolean> {
  const bytes = await stores.readSnapshotBytes(held.version.snapshotId!, capOf(stores)).catch(() => null)
  return bytes !== null && bytes !== 'too-large' && sha256(bytes) === hash
}

/** Some version in `held` that still HOLDS the bytes with this hash (journal says so and the object verifies), or undefined. A journal line alone is not a kept copy. */
async function versionHolding(stores: Pick<FileVersionStores, 'readSnapshotBytes' | 'cap'>, held: readonly Held[], hashes: ReadonlyMap<string, string>, hash: string): Promise<Held | undefined> {
  for (const entry of held) {
    if (hashes.get(entry.version.snapshotId!) === hash && await holdsCopy(stores, entry, hash)) return entry
  }
  return undefined
}

/** Whether snapshot `snapshotId` is a kept copy of the bytes with this `hash`: the journal names that hash and the object is there, within the cap, and hashes to its name. */
async function storedAs(stores: Pick<FileVersionStores, 'snapshotHashes' | 'readSnapshotBytes' | 'cap'>, snapshotId: string, hash: string): Promise<boolean> {
  const named = (await stores.snapshotHashes([snapshotId]).catch(() => new Map<string, string>())).get(snapshotId)
  if (named !== hash) return false
  const bytes = await stores.readSnapshotBytes(snapshotId, capOf(stores)).catch(() => null)
  return bytes !== null && bytes !== 'too-large' && sha256(bytes) === hash
}

/**
 * Store the bytes in hand as a snapshot and check what was stored is those bytes: the journal names their hash and the object reads back to it. Nothing
 * is recorded in `versions.jsonl` unless this passes. Used by a save, by the safety save of a restore and by the version a restore records.
 */
async function snapshotJudged(stores: FileVersionStores, path: string, bytes: Buffer, hash: string): Promise<VersionSnapshotResult> {
  await stores.confirmOwner()
  assertCollectionWritable(stores.workspace.root)
  const snapshot = await stores.snapshotBytes(path, bytes)
  if (!(await storedAs(stores, snapshot.snapshotId, hash))) {
    return refuse(`The copy of ${nameOf(path)} could not be verified in the history store, so no version was recorded. Nothing was changed. Try again.`, 'unavailable')
  }
  await stores.confirmOwner()
  return snapshot
}

// ---- Reading ----------------------------------------------------------------------------------

/** A file's versions, newest first, each with the Folio versions that used it, and what the working copy is against them. Reads only. */
export async function listFileVersions(stores: Pick<FileVersionStores, 'workspace' | 'versions' | 'folioVersions' | 'snapshotHashes' | 'readSnapshotBytes' | 'cap'>, input: unknown): Promise<FileVersionsListing> {
  const path = checkedFilePath(stores.workspace, input)
  const cap = capOf(stores)
  const held = await heldVersions(stores, path)
  const hashes = await stores.snapshotHashes(held.map((entry) => entry.version.snapshotId!)).catch(() => new Map<string, string>())
  // Reverse lookup: which Folio versions point at which per-file version. Never stored on the per-file record.
  const uses = new Map<string, Array<{ id: string; name: string; ts: number }>>()
  const wanted = new Set(held.map((entry) => entry.version.id))
  for (const folio of await stores.folioVersions.list().catch(() => [])) {
    if (folio.withdrawn) continue
    for (const member of folio.members) {
      if (member.role !== 'inserted' || !wanted.has(member.versionId)) continue
      const list = uses.get(member.versionId) ?? []
      if (!list.some((use) => use.id === folio.id)) list.push({ id: folio.id, name: folio.name, ts: folio.ts })
      uses.set(member.versionId, list)
    }
  }
  const working = await readWorking(stores.workspace, path, cap)
  const workingHash = working.kind === 'ok' ? working.sha256 : null
  const rows: FileVersionRow[] = held.map(({ version, number }) => {
    const hash = hashes.get(version.snapshotId!) ?? null
    return {
      id: version.id, number, name: version.name, ts: version.ts, author: version.author.name,
      ...(version.note !== undefined && version.note.trim() !== '' ? { note: version.note } : {}),
      automatic: folioSaveOf(version) !== undefined,
      sha256: hash,
      usedBy: (uses.get(version.id) ?? []).sort((a, b) => b.ts - a.ts),
      isWorking: workingHash !== null && hash === workingHash,
    }
  })
  let state: FileWorking
  if (working.kind === 'missing') state = { state: 'missing' }
  else if (working.kind === 'unreadable') state = { state: 'unreadable', why: working.why }
  else if (working.kind === 'too-large') state = { state: 'too-large', bytes: working.bytes }
  else if (rows.length === 0) state = { state: 'unversioned' }
  else {
    const equal = rows.find((row) => row.isWorking)
    if (equal) state = { state: 'same', as: { id: equal.id, number: equal.number, name: equal.name } }
    else {
      const latest = rows[0]!
      let cellsChanged: number | null = null
      if (fileKindOf(path) === 'table') {
        const saved = await stores.readSnapshotBytes(held[0]!.version.snapshotId!, cap).catch(() => null)
        if (saved !== null && saved !== 'too-large') cellsChanged = cellsDiffering(saved.toString('utf8'), working.bytes.toString('utf8'), path)
      }
      state = { state: 'changed', since: { id: latest.id, number: latest.number, name: latest.name }, cellsChanged }
    }
  }
  return { path, kind: fileKindOf(path), working: state, workingSha256: workingHash, versions: rows }
}

/** Two versions of a file, or a version and the working copy (`'working'`): a table cell by cell, anything else whether it differs. Reads only. */
export async function compareFileVersions(stores: Pick<FileVersionStores, 'workspace' | 'versions' | 'snapshotHashes' | 'readSnapshotBytes' | 'cap'>, input: { path: unknown; from: unknown; to: unknown }): Promise<FileCompare> {
  const path = checkedFilePath(stores.workspace, input.path)
  const cap = capOf(stores)
  const held = await heldVersions(stores, path)
  const end = async (id: unknown): Promise<{ label: string; bytes: Buffer }> => {
    if (id === WORKING_COPY) {
      const working = await readWorking(stores.workspace, path, cap)
      if (working.kind === 'missing') return refuse(`There is no file at ${path} now, so there is no working copy to compare.`, 'not-found')
      if (working.kind === 'unreadable') return refuse(working.why)
      if (working.kind === 'too-large') return tooLarge(path, working.bytes)
      return { label: 'Working copy', bytes: working.bytes }
    }
    const entry = typeof id === 'string' ? held.find((candidate) => candidate.version.id === id) : undefined
    if (!entry) return refuse(`${path} has no saved version with that id. Look at the list again.`, 'not-found')
    return { label: `v${entry.number} · ${entry.version.name}`, bytes: await savedCopy(stores, entry) }
  }
  const from = await end(input.from)
  const to = await end(input.to)
  return compareFileBytes(path, from.bytes, to.bytes, from.label, to.label)
}

/**
 * The files the text of the Folio at `dir` inserts (a table, a widget page, an image: where the Folio's own parts embed them, wherever they sit),
 * each with how many versions hold a copy of it, in the order the Folio's text first inserts them. Reads only. A Folio that cannot be gathered as it
 * stands (no Index Note file yet, an ambiguous running order) lists none and says why.
 */
export async function listInsertedFiles(stores: Pick<FileVersionStores, 'workspace' | 'versions'>, dir: unknown): Promise<{ files: FolioInsertedFile[]; unavailable?: string }> {
  if (typeof dir !== 'string' || dir.includes('\\') || dir.includes('\0') || dir.startsWith('/') || dir.split('/').includes('..')) return refuse('That is not a folder of this Collection.')
  let gathered
  try { gathered = await gatherFolio(stores.workspace, dir) } catch (error) {
    if (error instanceof FolioGatherRefused) return { files: [], unavailable: error.message }
    throw error
  }
  const files: FolioInsertedFile[] = []
  for (const file of gathered.files) {
    if (file.role !== 'inserted' || isMarkdownDocument(file.path)) continue
    files.push({ path: file.path, kind: fileKindOf(file.path), versions: (await heldVersions(stores, file.path)).length })
  }
  return { files }
}

// ---- Saving -----------------------------------------------------------------------------------

/**
 * Save a version of the file as it stands on disk: one restore point, one snapshot (an object already holding these bytes is not stored again) and one
 * line in `versions.jsonl`. Refused, writing nothing, for a blank name, a Markdown document, a file over the cap, a file with no change since its newest
 * version, and anything that is not an ordinary file of the Collection.
 */
export async function saveFileVersion(stores: FileVersionStores, input: { path: unknown; name: unknown; note?: unknown; author?: AuthorIdentity }): Promise<SaveFileVersionResult & { record: Version }> {
  const path = checkedFilePath(stores.workspace, input.path)
  return stores.workspace.exclusive(path, async () => {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (name === '') return refuse('Name the version before saving.')
    if (name.length > 300) return refuse('That version name is too long. Nothing was saved.')
    const note = typeof input.note === 'string' ? input.note.trim() : ''
    const working = await readWorking(stores.workspace, path, capOf(stores))
    if (working.kind === 'missing') return refuse(`There is no file at ${path} now, so there is nothing to save a version of.`, 'not-found')
    if (working.kind === 'unreadable') return refuse(working.why)
    if (working.kind === 'too-large') return tooLarge(path, working.bytes)
    const held = await heldVersions(stores, path)
    const hashes = await stores.snapshotHashes(held.map((entry) => entry.version.snapshotId!)).catch(() => new Map<string, string>())
    // "Nothing has changed" only when the newest version really still holds these bytes: a journal line whose object is gone is not a kept copy, so the bytes are saved again.
    const newest = held[0]
    if (newest && hashes.get(newest.version.snapshotId!) === working.sha256 && await holdsCopy(stores, newest, working.sha256)) return refuse(`Nothing has changed since v${newest.number} “${newest.version.name}”, so there is nothing new to save.`, 'unchanged')
    // The bytes judged above are the bytes stored: the file is not read again.
    const snapshot = await snapshotJudged(stores, path, working.bytes, working.sha256)
    const record = await stores.versions.append({
      path, name, author: input.author ?? stores.author, ...(note ? { note } : {}),
      snapshotId: snapshot.snapshotId, versionId: snapshot.versionId,
    })
    return { version: { id: record.id, name: record.name, ts: record.ts, number: held.length + 1 }, record }
  })
}

// ---- Restoring --------------------------------------------------------------------------------

/** The guarded writer's `beforeCommit`: in the tick of the rename or link, the Collection must still be writable and the binding the operation was made for must still stand. Safe to repeat. */
function stillBound(stores: Pick<FileVersionStores, 'workspace' | 'assertBound'>): () => void {
  return () => {
    assertCollectionWritable(stores.workspace.root)
    stores.assertBound?.()
  }
}

function writeRefusal(path: string, error: unknown): never {
  if (!(error instanceof GuardedWriteRefused)) throw error
  if (error.code === 'changed') return refuse(`${nameOf(path)} changed since you looked at it, so nothing was written. Look at it again and choose again.`, 'changed')
  if (error.code === 'exists') return refuse(`A file called ${nameOf(path)} is already there, so nothing was written. Choose another name.`, 'exists')
  if (error.code === 'is-a-link') return refuse(`${nameOf(path)} is a link, not a file of its own, so nothing was written.`)
  if (error.code === 'outside' || error.code === 'hidden') return refuse(`${path} is not in a folder of this Collection, so nothing was written.`)
  if (error.code === 'not-a-file') return refuse(`${nameOf(path)} is not an ordinary file, so nothing was written.`)
  if (error.code === 'no-folder') return refuse(`The folder for ${path} does not exist, so nothing was written.`)
  return refuse(`${nameOf(path)} was not written: its folder changed while it was being saved.`, 'changed')
}

/**
 * Put version `versionId`'s saved copy back as the working file, and APPEND a new file version holding it (named "Restored: <name>"); the version restored
 * and every earlier one stay. Bound to what the writer saw: the saved copy's hash (`expectVersionSha256`) and the working copy's (`expectWorkingSha256`, null
 * when the writer saw no file). If the working copy is not held by any version it is saved first, as "Before restoring v1", so replacing it loses nothing.
 * The file is written whole (temporary file and rename), never in place.
 */
export async function restoreFileVersion(stores: FileVersionStores, input: { path: unknown; versionId: unknown; expectVersionSha256: unknown; expectWorkingSha256: unknown; author?: AuthorIdentity }): Promise<RestoreFileVersionResult> {
  const path = checkedFilePath(stores.workspace, input.path)
  return stores.workspace.exclusive(path, async () => {
    const wantedVersion = input.expectVersionSha256
    const wantedWorking = input.expectWorkingSha256
    if (typeof input.versionId !== 'string' || typeof wantedVersion !== 'string' || !/^[0-9a-f]{64}$/.test(wantedVersion)) return refuse('That is not a version that can be restored. Nothing was changed.')
    if (wantedWorking !== null && (typeof wantedWorking !== 'string' || !/^[0-9a-f]{64}$/.test(wantedWorking))) return refuse('That is not a working copy that can be replaced. Nothing was changed.')
    const held = await heldVersions(stores, path)
    const entry = held.find((candidate) => candidate.version.id === input.versionId)
    if (!entry) return refuse(`${path} has no saved version with that id. Nothing was changed.`, 'not-found')
    const saved = await savedCopy(stores, entry, wantedVersion)

    const working = await readWorking(stores.workspace, path, capOf(stores))
    if (working.kind === 'unreadable') return refuse(working.why)
    if (working.kind === 'too-large') return tooLarge(path, working.bytes)
    const workingNow = working.kind === 'ok' ? working.sha256 : null
    if (workingNow !== wantedWorking) return refuse(`${nameOf(path)} changed since you looked at it, so nothing was restored. Look at it again and choose again.`, 'changed')
    if (workingNow === wantedVersion) return refuse(`${nameOf(path)} already holds the bytes of v${entry.number} “${entry.version.name}”, so there is nothing to restore.`, 'same')

    // The working copy that is about to be replaced is kept: unless some version already holds it, it is saved first.
    let safety: RestoreFileVersionResult['safety'] = null
    if (working.kind === 'ok') {
      const hashes = await stores.snapshotHashes(held.map((candidate) => candidate.version.snapshotId!)).catch(() => new Map<string, string>())
      // Kept means a version whose saved copy is really there and verifies, not one the journal merely names.
      const kept = await versionHolding(stores, held, hashes, workingNow!)
      if (!kept) {
        // The safety copy is the buffer read above, not a second read of the file: the file can have changed (and changed back) since, and replacing a
        // working copy that no version holds would lose it. It is checked in the store before anything is replaced.
        const snapshot = await snapshotJudged(stores, path, working.bytes, working.sha256)
        const before = await stores.versions.append({
          path, name: `Before restoring v${entry.number}`, author: input.author ?? stores.author,
          snapshotId: snapshot.snapshotId, versionId: snapshot.versionId,
        })
        safety = { id: before.id, name: before.name }
      }
    }

    await stores.confirmOwner()
    assertCollectionWritable(stores.workspace.root)
    try {
      await writeDocumentGuarded(stores.workspace, path, saved, working.kind === 'ok' ? 'replace' : 'create', { seams: stores.seams ?? {}, beforeCommit: stillBound(stores), ...(working.kind === 'ok' ? { expect: { fingerprint: working.sha256 } } : {}) })
    } catch (error) { return writeRefusal(path, error) }

    // The new version holds the bytes that were put back (`saved`, checked against their hash above), not a second read of the file.
    const snapshot = await snapshotJudged(stores, path, saved, wantedVersion)
    const name = restoredName({ name: entry.version.name, number: entry.number, automatic: folioSaveOf(entry.version) !== undefined })
    const record = await stores.versions.append({
      path, name, author: input.author ?? stores.author, note: `Put back from v${entry.number} “${entry.version.name}”.`,
      snapshotId: snapshot.snapshotId, versionId: snapshot.versionId,
    })
    return { restored: { id: record.id, name: record.name, number: held.length + (safety ? 1 : 0) + 1 }, safety }
  })
}

// ---- Save as a copy ---------------------------------------------------------------------------

/** A name for a copy: one file name (no folder, no hidden or dot name), with the original's extension. */
function copyNameOf(path: string, input: unknown): string {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (raw === '') return refuse('Name the copy before saving it.')
  if (raw.length > 200 || /[\\/\0\r\n:]/.test(raw) || raw.startsWith('.') || raw === '..') return refuse('A copy needs a plain file name, with no folder in it. Nothing was written.')
  const extension = (nameOf(path).match(/\.[^.]+$/) ?? [''])[0]
  const own = (raw.match(/\.[^.]+$/) ?? [''])[0]
  if (extension !== '' && own.toLowerCase() !== extension.toLowerCase()) return `${raw}${extension}`
  if (isMarkdownDocument(raw)) return refuse('A copy of a file stays the kind of file it is. Nothing was written.')
  return raw
}

/**
 * "Save v1 as a copy…": write version `versionId`'s saved copy as ONE new ordinary file beside the file, under the name given (it keeps the file's type).
 * Exclusive create: a name that is taken is refused and nothing is overwritten. The copy is an ordinary file, not a version, and no record is written.
 */
export async function saveFileVersionAsCopy(stores: FileVersionStores, input: { path: unknown; versionId: unknown; expectVersionSha256: unknown; name: unknown }): Promise<SaveFileCopyResult> {
  const path = checkedFilePath(stores.workspace, input.path)
  return stores.workspace.exclusive(path, async () => {
    if (typeof input.versionId !== 'string' || typeof input.expectVersionSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.expectVersionSha256)) return refuse('That is not a version that can be copied. Nothing was changed.')
    const file = copyNameOf(path, input.name)
    const folder = posix.dirname(path) === '.' ? '' : posix.dirname(path)
    const target = folder === '' ? file : `${folder}/${file}`
    // The copy lands where a document may: same checks as any new file.
    const verdict = stores.workspace.classifyPath(target, 'file')
    if (verdict !== 'document') return refuse(`${target} is not in a folder of this Collection, so nothing was written.`)
    const entry = (await heldVersions(stores, path)).find((candidate) => candidate.version.id === input.versionId)
    if (!entry) return refuse(`${path} has no saved version with that id. Nothing was changed.`, 'not-found')
    const saved = await savedCopy(stores, entry, input.expectVersionSha256)
    await stores.confirmOwner()
    assertCollectionWritable(stores.workspace.root)
    try {
      await writeDocumentGuarded(stores.workspace, target, saved, 'create', { seams: stores.seams ?? {}, beforeCommit: stillBound(stores) })
    } catch (error) { return writeRefusal(target, error) }
    return { path: target }
  })
}

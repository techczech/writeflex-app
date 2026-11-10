/**
 * AUTOMATIC RECONCILIATION OF COPIES MADE BY SYNC (OneDrive), without any lock. Contract:
 * docs/plans/2026-11-03-sync-replicas-and-duplicate-reconciliation.md rules 4, 5 and 6.
 * Run when a synced Collection is opened, when the watcher sees files arrive, and when the Mac wakes.
 * Nothing waits for another Mac; nothing here runs on a timer of its own.
 *
 * WHICH FILES ARE COPIES. Never the name alone (`shared/conflict-copy.ts` is deliberately broad and
 * `report-Methods.md` is a document of its own). A file `C` is handled as a sync copy of `X` only when:
 *  1. `C` is named as sync names a conflict copy of `X` (same folder, `X`'s name, `-` or a space, a
 *     suffix), AND
 *  2. that suffix is the name of a device known to have edited this Collection with WriteFlex (recorded
 *     in its replica versions, with each Mac's ComputerName alias beside its host name) or one of this
 *     Mac's own names; compared whole first (`MacBook Air (2)` is a real ComputerName), then with sync's
 *     own counter (`-1`, ` (2)`) set aside, AND
 *  3. content evidence decides what happens, below. Without evidence the files are only kept as versions.
 *
 * WHAT HAPPENS (always after both texts are kept as replica versions of `X` and read back):
 *  - identical bytes, or identical once a BOM and CRLF line endings are set aside: `C` is set aside.
 *  - `C` is a text `X` was saved from (recorded ancestry): `C` is set aside; it is in `X`'s history.
 *  - `X` is a text `C` was saved from: `X` is updated to `C` (a fast-forward), then `C` set aside.
 *  - both were saved from one known version (a single nearest common ancestor whose bytes are kept)
 *    and their changes do not touch (sync-merge.ts): `X` becomes the merge, kept as a version, and `C`
 *    is set aside.
 *  - anything else is DIVERGENT: both files stay exactly where they are, both texts are in `X`'s
 *    Versions, and the pair is reported to the writer. Nothing chooses the newer one.
 *
 * SET ASIDE means moved, never deleted, to `.writeflex/sync-copies/<id>/<its name>`, beside a record of
 * what was done and why. Both folders are pinned (pinned-folder-chain.ts); the move happens only if,
 * in one synchronous step after the last await, the pass is still alive, both folders are still the ones
 * pinned, and the file still holds the bytes that were kept. A file that changed after the move is kept
 * as a version too. Lineage comes only from the original's own records (never another document's).
 *
 * RACES. A file modified in the last `settleMs`, one whose two reads differ, one that is not valid UTF-8
 * or contains NUL bytes (a partial download), or one that is a link, is not touched in this pass
 * (`deferred`); the next arrival, open or wake tries again. `X` is written only through the Workspace's
 * guarded save over exactly the bytes read (a change meanwhile refuses it), never while this Mac is in
 * a run of saves to it (`busy`), and an open editor based on the old text cannot save over the merge:
 * its save is refused by the save fingerprint and the changed-on-disk banner shows both.
 * Repeated passes converge: versions are kept once per text, set-aside files are gone from the folder.
 */
import { closeSync, constants, fsyncSync, openSync, renameSync, rmdirSync, writeSync } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { join, posix } from 'node:path'
import { isConflictCopyOf } from '../shared/conflict-copy'
import { mergeThreeWay } from './sync-merge'
import { MAX_REPLICA_BYTES, sha256Hex, type ReplicaVersions } from './replica-versions'
import { chainStands, pinChain, readPinned, readPinnedSync, type PinnedChain } from './pinned-folder-chain'
import type { Workspace } from './workspace'

export const SYNC_COPIES_DIR = '.writeflex/sync-copies'
export const SETTLE_MS = 3_000

export type SetAsideReason = 'identical' | 'already-in-history' | 'fast-forward' | 'merged'
export type ReconcileReport = {
  setAside: Array<{ copy: string; original: string; reason: SetAsideReason; to: string }>
  divergent: Array<{ copy: string; original: string }>
  deferred: Array<{ path: string; reason: string; waitingForObject?: string }>
}

export type SettledRead = { kind: 'settled'; bytes: Buffer; text: string; sha: string } | { kind: 'absent' } | { kind: 'unsettled'; reason: string }

/** Exact text: a BOM is kept as a character (the default decoder drops it, and a write over the read must
 *  compare the file's own bytes, BOM included). Invalid UTF-8 throws: a partial download. */
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const READ_CHUNK = 1024 * 1024

/** The pass was stopped (the window closed the Collection or bound another): nothing more is written. */
export class ReconcileStopped extends Error {
  override readonly name = 'ReconcileStopped'
}

/** Exactly `size` bytes of the open file, never buffering more than `size + 1`: null when it holds any other number. */
async function readExactly(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<Buffer | null> {
  const buffer = Buffer.allocUnsafe(size + 1)
  let total = 0
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total)
    if (bytesRead === 0) break
    total += bytesRead
  }
  return total === size ? buffer.subarray(0, size) : null
}

/** The SHA-256 of exactly `size` bytes of the open file, read in chunks: null when it holds any other number. */
async function hashExactly(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<string | null> {
  const hash = createHash('sha256')
  const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK, size + 1))
  let total = 0
  for (;;) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, total)
    if (bytesRead === 0) break
    total += bytesRead
    if (total > size) return null
    hash.update(chunk.subarray(0, bytesRead))
  }
  return total === size ? hash.digest('hex') : null
}

/**
 * The file's bytes only if they are stable: not a link, at most `maxBytes` (checked before anything is
 * buffered, and again while reading), not modified in the last `settleMs`, the same size, time, inode and
 * content across two reads (the second only hashed, so one copy is held in memory), valid UTF-8 and free
 * of NUL bytes. A larger file is never read; it stays as it is and is reported as not kept.
 */
export async function readSettled(absolute: string, opts: { settleMs?: number; now?: () => number; maxBytes?: number } = {}): Promise<SettledRead> {
  const settleMs = opts.settleMs ?? SETTLE_MS
  const now = opts.now ?? Date.now
  const limit = opts.maxBytes ?? MAX_REPLICA_BYTES
  const look = async () => lstat(absolute, { bigint: true }).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : Promise.reject(error)))
  const first = await look()
  if (!first) return { kind: 'absent' }
  if (first.isSymbolicLink() || !first.isFile()) return { kind: 'unsettled', reason: 'not an ordinary file' }
  if (first.size > BigInt(limit)) return { kind: 'unsettled', reason: 'too large to keep as a version' }
  if (now() - Number(first.mtimeMs) < settleMs) return { kind: 'unsettled', reason: 'still being written' }
  const size = Number(first.size)
  const pass = async <T>(read: (handle: Awaited<ReturnType<typeof open>>) => Promise<T | null>): Promise<T | null> => {
    let handle
    try { handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch { return null }
    try {
      const info = await handle.stat({ bigint: true })
      if (!info.isFile() || info.ino !== first.ino || info.size !== first.size) return null
      return await read(handle)
    } catch { return null } finally { await handle.close().catch(() => {}) }
  }
  const a = await pass((handle) => readExactly(handle, size))
  const bHash = a ? await pass((handle) => hashExactly(handle, size)) : null
  const second = await look()
  if (!a || !bHash || !second) return { kind: 'unsettled', reason: 'changed while read' }
  const sha = sha256Hex(a)
  if (sha !== bHash || second.ino !== first.ino || second.size !== first.size || second.mtimeNs !== first.mtimeNs) return { kind: 'unsettled', reason: 'changed while read' }
  if (a.includes(0)) return { kind: 'unsettled', reason: 'not yet complete (contains empty bytes)' }
  let text: string
  try { text = decoder.decode(a) } catch { return { kind: 'unsettled', reason: 'not yet complete (not valid UTF-8)' } }
  return { kind: 'settled', bytes: a, text, sha }
}

/** A device name in the form sync puts it in a file name, for comparison. */
export function deviceKey(name: string): string {
  return name.toLocaleLowerCase().replace(/\.local$/, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
}

/** The suffix `copy` adds to `original`'s name, or null when it is not named as a copy of it. */
export function copySuffix(copy: string, original: string): string | null {
  if (!isConflictCopyOf(copy, original)) return null
  const stem = (path: string) => posix.basename(path).replace(/\.(?:md|markdown|mdx)$/i, '')
  if (posix.extname(copy).toLowerCase() !== posix.extname(original).toLowerCase()) return null
  return stem(copy).slice(stem(original).length + 1)
}

/**
 * Whether `suffix` names one of `devices`. The whole suffix is compared first: a device's real name may
 * itself end in what looks like a counter (the Air's ComputerName is `MacBook Air (2)`). Only then is a
 * trailing sync counter (`-1`, ` 2`, ` (2)`) set aside and the rest compared. Names are compared only
 * against recorded or local device names, never guessed.
 */
export function suffixNamesDevice(suffix: string, devices: readonly string[]): boolean {
  const keys = new Set(devices.map(deviceKey).filter(Boolean))
  const whole = deviceKey(suffix)
  if (whole !== '' && keys.has(whole)) return true
  const stripped = deviceKey(suffix.replace(/(?:[- ]\d+| \(\d+\))$/, ''))
  return stripped !== '' && stripped !== whole && keys.has(stripped)
}

const normalised = (text: string): string => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')

export type ReconcileInput = {
  workspace: Workspace
  store: ReplicaVersions
  /** Only pairs in these folders ('' is the top); every folder when absent. */
  folders?: readonly string[]
  /** This Mac is in a run of saves to `path`: do not write it in this pass. */
  busy?: (path: string) => boolean
  /** False once the pass must stop (the window closed the Collection): asked before every write. */
  alive?: () => boolean
  settleMs?: number
  now?: () => number
  /** Runs before a pair's texts are read: the session keeps this Mac's pending save of the original
   *  first, so its ancestry (what it was saved over) is recorded before the pair is judged. */
  beforePair?: (original: string) => Promise<void>
  /** @internal Test seam: runs immediately before a copy is set aside. */
  beforeSetAside?: (copy: string) => Promise<void>
}

const assertAlive = (input: ReconcileInput): void => {
  if (input.alive && !input.alive()) throw new ReconcileStopped('The Collection was closed in this window; reconciliation stopped.')
}

/** One reconciliation pass over the Collection (or `folders`). Writes only as described at the top. */
export async function reconcileSyncCopies(input: ReconcileInput): Promise<ReconcileReport> {
  const { workspace, store } = input
  const report: ReconcileReport = { setAside: [], divergent: [], deferred: [] }
  const devices = await store.devices()
  // Only the named folders are listed (a watcher burst names a few); a copy is always beside its original.
  const listed = input.folders
    ? (await Promise.all([...new Set(input.folders)].map((folder) => workspace.listFilesIn(folder, { recursive: false }).catch(() => [])))).flat()
    : await workspace.listFiles()
  if (input.alive && !input.alive()) return report
  const files = listed.map((file) => file.path)
  const inScope = (path: string) => !input.folders || input.folders.includes(posix.dirname(path) === '.' ? '' : posix.dirname(path))
  const pairs: Array<{ copy: string; original: string }> = []
  for (const copy of files) {
    if (!inScope(copy)) continue
    // The longest original wins: `a-b-Mac.md` is a copy of `a-b.md`, not of `a.md`.
    const original = files
      .filter((other) => other !== copy)
      .filter((other) => { const suffix = copySuffix(copy, other); return suffix !== null && suffixNamesDevice(suffix, devices) })
      .sort((a, b) => b.length - a.length)[0]
    if (original) pairs.push({ copy, original })
  }
  for (const pair of pairs) {
    try {
      assertAlive(input)
      await reconcilePair(input, pair, report)
    } catch (error) {
      if (error instanceof ReconcileStopped) break
      report.deferred.push({ path: pair.copy, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return report
}

async function reconcilePair(input: ReconcileInput, { copy, original }: { copy: string; original: string }, report: ReconcileReport): Promise<void> {
  const { workspace, store } = input
  const settle = { ...(input.settleMs !== undefined ? { settleMs: input.settleMs } : {}), ...(input.now ? { now: input.now } : {}) }
  await input.beforePair?.(original)
  const c = await readSettled(workspace.absolute(copy), settle)
  const x = await readSettled(workspace.absolute(original), settle)
  if (c.kind === 'absent' || x.kind === 'absent') return
  if (c.kind === 'unsettled') { report.deferred.push({ path: copy, reason: c.reason }); return }
  if (x.kind === 'unsettled') { report.deferred.push({ path: original, reason: x.reason }); return }

  // Both texts are kept, and read back, before anything is moved or written.
  assertAlive(input)
  await store.capture({ path: original, bytes: c.bytes, cause: 'sync-copy', from: copy, dedupe: 'path-hash' })
  assertAlive(input)
  await store.capture({ path: original, bytes: x.bytes, cause: 'before-reconcile', dedupe: 'path-hash' })
  if (!(await store.holds(c.sha)) || !(await store.holds(x.sha))) throw new Error('The two copies could not be kept as versions; nothing was moved.')

  if (c.sha === x.sha || normalised(c.text) === normalised(x.text)) {
    await setAside(input, copy, original, c.sha, 'identical', report)
    return
  }
  // Lineage only from this document's own records (replica-versions.ts `ancestors`).
  const ancestorsOfX = await store.ancestors(x.sha, original)
  const ancestorsOfC = await store.ancestors(c.sha, original)
  if (ancestorsOfX.has(c.sha)) {
    await setAside(input, copy, original, c.sha, 'already-in-history', report)
    return
  }
  if (ancestorsOfC.has(x.sha)) {
    if (input.busy?.(original)) { report.deferred.push({ path: original, reason: 'being edited on this Mac' }); return }
    assertAlive(input)
    // Checked again in the tick of the rename: a pass outlived by its session's disposal never commits.
    await workspace.saveFileOverRead(original, c.text, x.text, { beforeCommit: () => assertAlive(input) })
    await setAside(input, copy, original, c.sha, 'fast-forward', report)
    return
  }
  const base = await nearestCommonAncestor(store, original, ancestorsOfX, ancestorsOfC)
  const baseBytes = base ? await store.read(base) : null
  let baseText: string | null = null
  if (baseBytes) { try { baseText = decoder.decode(baseBytes) } catch { baseText = null } }
  if (base && baseText === null) {
    // Logical size alone does not prove a cloud object's bytes are readable. Its later arrival must
    // wake this pair even when neither the record ids nor the advertised file size changed.
    report.deferred.push({ path: copy, reason: 'shared version is not readable yet', waitingForObject: base })
    return
  }
  const merged = baseText !== null ? mergeThreeWay(baseText, x.text, c.text) : null
  if (merged !== null) {
    if (input.busy?.(original)) { report.deferred.push({ path: original, reason: 'being edited on this Mac' }); return }
    assertAlive(input)
    await store.capture({ path: original, bytes: merged, cause: 'merged', parents: [x.sha, c.sha], dedupe: 'path-hash' })
    assertAlive(input)
    await workspace.saveFileOverRead(original, merged, x.text, { beforeCommit: () => assertAlive(input) })
    await setAside(input, copy, original, c.sha, 'merged', report)
    return
  }
  report.divergent.push({ copy, original })
}

/** The one nearest version both texts were saved from, or null when there is none or more than one. */
async function nearestCommonAncestor(store: ReplicaVersions, path: string, a: Map<string, number>, b: Map<string, number>): Promise<string | null> {
  const common = [...a.keys()].filter((hash) => b.has(hash))
  if (!common.length) return null
  const nearest: string[] = []
  for (const hash of common) {
    // Not nearest when another common version was itself saved from it.
    let dominated = false
    for (const other of common) {
      if (other !== hash && (await store.ancestors(other, path)).has(hash)) { dominated = true; break }
    }
    if (!dominated) nearest.push(hash)
  }
  return nearest.length === 1 ? nearest[0] : null
}

function writeRecordSync(folder: PinnedChain, name: string, text: string): void {
  const fd = openSync(join(folder.real, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
  try {
    const bytes = Buffer.from(text, 'utf8')
    let at = 0
    while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at, at)
    fsyncSync(fd)
  } finally { closeSync(fd) }
}

/**
 * Move `copy` into `.writeflex/sync-copies/<id>/` (never a delete). The copy's folder and every folder on
 * the way to the new place are pinned first (pinned-folder-chain.ts). After the last await, in ONE
 * synchronous step, the pass must still be alive, both chains must still stand as pinned, and the copy
 * must still hold exactly the bytes kept; only then is it renamed through the pinned real folders and
 * its record written beside it. A folder moved aside or replaced by a link meanwhile refuses the move,
 * and nothing is moved, cleaned up or recorded through the replaced folder.
 */
async function setAside(input: ReconcileInput, copy: string, original: string, sha: string, reason: SetAsideReason, report: ReconcileReport): Promise<void> {
  const { workspace, store } = input
  assertAlive(input)
  const id = `sc_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`
  const name = posix.basename(copy)
  const copyFolder = posix.dirname(copy) === '.' ? '' : posix.dirname(copy)
  const source = pinChain(workspace.root, copyFolder, false)
  if (!source) { report.deferred.push({ path: copy, reason: 'its folder is gone' }); return }
  const holder = pinChain(workspace.root, `${SYNC_COPIES_DIR}/${id}`, true)!
  const to = `${SYNC_COPIES_DIR}/${id}/${name}`
  await input.beforeSetAside?.(copy)
  // ---- From here to the end of the move nothing is awaited. ----
  const dropHolder = (): void => {
    // Only the empty folder made for this copy, and only while it is still the one made.
    if (chainStands(holder)) { try { rmdirSync(holder.real) } catch { /* not empty or gone: left */ } }
  }
  if (input.alive && !input.alive()) { dropHolder(); throw new ReconcileStopped('The Collection was closed in this window; reconciliation stopped.') }
  if (!chainStands(source) || !chainStands(holder)) {
    report.deferred.push({ path: copy, reason: 'a folder on the way was moved or replaced; the copy was left where it is' })
    dropHolder()
    return
  }
  const now = readPinnedSync(source, name, MAX_REPLICA_BYTES)
  if (!now || sha256Hex(now) !== sha) {
    dropHolder()
    report.deferred.push({ path: copy, reason: 'changed while it was being reconciled' })
    return
  }
  workspace.recordOwnWrite(copy, 'absent')
  try {
    renameSync(join(source.real, name), join(holder.real, name))
  } catch (error) {
    workspace.forgetOwnWrites(copy)
    dropHolder()
    throw error
  }
  // The record of what was done, beside the file. An interrupted pass leaves the file in this folder and
  // its text in the original's Versions; nothing claims a move that did not happen.
  writeRecordSync(holder, 'record.json', `${JSON.stringify({
    kind: 'writeflex-sync-copy', format: 1, id, copy, original, sha256: sha, reason, device: store.device, ts: Date.now(), to,
  }, null, 2)}\n`)
  // ---- End of the synchronous step. ----
  report.setAside.push({ copy, original, reason, to })
  const moved = await readPinned(holder, name, MAX_REPLICA_BYTES)
  // Something written in the instant before the move is in the moved file: keep it as well.
  if (moved && sha256Hex(moved) !== sha) await store.capture({ path: original, bytes: moved, cause: 'sync-copy', from: copy })
}

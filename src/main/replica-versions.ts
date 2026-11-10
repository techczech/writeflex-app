/**
 * REPLICA VERSIONS: durable versions of documents in a OneDrive Collection, kept by WriteFlex itself on every Mac that edits a replica. Contract:
 * docs/plans/2026-11-03-sync-replicas-and-duplicate-reconciliation.md rules 3, 4 and 7.
 *
 * WHY A SEPARATE STORE. History (Bridle's `.bridle`) needs the agent and its journal is one append file;
 * `versions.jsonl` is one append file too. Two Macs appending to one file through OneDrive produce
 * conflict copies or interleaved histories, so neither can be the only authority across replicas. Here
 * every version is its own immutable pair of files, and no file is ever written by two Macs:
 *
 *   .writeflex/replica-versions/objects/<sha256>   the exact UTF-8 bytes; the name is their SHA-256
 *   .writeflex/replica-versions/records/<id>.json  one record: path, sha256, size, time, device, cause,
 *                                                  parents (the hashes it was saved over)
 *
 * An object's name is its content, so the same object written on two Macs is the same file. A record's
 * id carries random bytes, so two Macs never write the same record name. Bridle's retention sweep never
 * looks here (it would delete objects its own journal does not name).
 *
 * WRITE ORDER (recoverable if interrupted): the object first (temporary file, fsync, hard link into its
 * name), then the record (the same). A record whose object is absent or of the wrong size is not listed
 * (sync may deliver the record first: it appears when the object arrives); every read of an object
 * verifies its hash. An object without a record is an inert orphan.
 *
 * CONTAINMENT (pinned-folder-chain.ts). Every folder on the way is pinned (real path, device, inode) and
 * must be a real folder, never a link. Content is written and read asynchronously through descriptors
 * opened in the tick the chain was checked; the step that gives a file its name re-checks the chain and
 * links or renames in the same synchronous step, so a folder swapped for a link during any await never
 * receives a write. Files are opened without following a link, and reads are bounded before buffering.
 *
 * NO REMOTE GATE. Deciding whether a text is already kept compares record and object SIZES only; an
 * earlier object (which may be a cloud placeholder) is never read or downloaded to decide. Saving never
 * waits on this store at all: replica-save-cycles.ts keeps saves in local recovery first.
 *
 * LINEAGE (`ancestors`) is read only from the records of the one document path: matching text in another
 * document is never ancestry.
 *
 * This works with no agent, no model, no sign-in, no network and whatever `snapshots.frequency` says.
 * Records are read into the existing Versions surfaces (versions.ts lists them; version-content.ts
 * reads and restores them through `replica:<sha256>` snapshot ids).
 */
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { close, closeSync, constants, existsSync, fstatSync, fsync, fsyncSync, linkSync, lstatSync, openSync, readdirSync, realpathSync, renameSync, unlinkSync, write, writeSync } from 'node:fs'
import { promisify } from 'node:util'
import { hostname } from 'node:os'
import { join, posix } from 'node:path'
import type { Version } from '../engine'
import { chainStands, pinChain, readPinned, readPinnedSync, type PinnedChain } from './pinned-folder-chain'
import { isSyncedLocation } from './sync-location'
import { fileIdentityOf, OwnWriteTracker, type FileIdentity } from './workspace-watcher'

export const REPLICA_DIR = '.writeflex/replica-versions'
const OBJECTS = `${REPLICA_DIR}/objects`
const RECORDS = `${REPLICA_DIR}/records`
const SHA = /^[0-9a-f]{64}$/
const RECORD_ID = /^rv_[0-9a-z]{6,12}_[0-9a-f]{12}$/
const MAX_RECORD_BYTES = 16 * 1024
/** Documents larger than this are not kept as replica versions (the guarded document limit is similar). */
export const MAX_REPLICA_BYTES = 32 * 1024 * 1024
export const REPLICA_SNAPSHOT_PREFIX = 'replica:'

export type ReplicaCause =
  | 'baseline' | 'save' | 'incoming' | 'before-restore' | 'before-keep-mine' | 'preserve'
  | 'sync-copy' | 'merged' | 'before-reconcile' | 'before-command' | 'command'
const CAUSES = new Set<ReplicaCause>(['baseline', 'save', 'incoming', 'before-restore', 'before-keep-mine', 'preserve', 'sync-copy', 'merged', 'before-reconcile', 'before-command', 'command'])

export type ReplicaRecord = {
  kind: 'writeflex-replica-version'
  format: 1
  id: string
  path: string
  sha256: string
  bytes: number
  ts: number
  device: string
  /** Other names this computer is known by (its macOS ComputerName beside the host name), read locally. */
  aliases?: string[]
  cause: ReplicaCause
  /** The hashes this text was made from: the version a save replaced, both sides of a merge. */
  parents: string[]
  /** For a copy made by sync: the copy's own path when it was kept. */
  from?: string
  note?: string
}

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const bytesOf = (value: string | Uint8Array): Buffer => (typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value))

/** This computer's name as the network knows it (`example-computer` → `Example-Mac`). */
export function thisDevice(): string {
  return hostname().replace(/\.local$/i, '').trim() || 'this Mac'
}

let computerName: string | null | undefined
/**
 * This Mac's ComputerName (System Settings › General › About, e.g. `MacBook Air (2)`), which differs from
 * the host name and is the name OneDrive's support page says conflict copies
 * carry. Read once, locally, with a bounded call to `scutil` (no network, no credentials); null elsewhere
 * or on any failure.
 */
export function localComputerName(): string | null {
  if (computerName !== undefined) return computerName
  computerName = null
  if (process.platform !== 'darwin') return computerName
  try {
    const out = execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 1500, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (out && out.length <= 200 && !/[\0\r\n]/.test(out)) computerName = out
  } catch { /* no alias: matching falls back to the host name and recorded names */ }
  return computerName
}

export function isReplicaVersionId(id: string): boolean {
  return RECORD_ID.test(id)
}

export function replicaSnapshotHash(snapshotId: string | undefined | null): string | null {
  if (!snapshotId?.startsWith(REPLICA_SNAPSHOT_PREFIX)) return null
  const hash = snapshotId.slice(REPLICA_SNAPSHOT_PREFIX.length)
  return SHA.test(hash) ? hash : null
}

function validPath(path: unknown): path is string {
  return typeof path === 'string' && path !== '' && !path.includes('\\') && !path.startsWith('/') && !path.includes('\0')
    && posix.normalize(path) === path && path !== '..' && !path.startsWith('../') && !path.endsWith('/')
}

function parseRecord(text: string, name: string): ReplicaRecord | null {
  let raw: Record<string, unknown>
  try { raw = JSON.parse(text) } catch { return null }
  if (!raw || typeof raw !== 'object') return null
  if (raw.kind !== 'writeflex-replica-version' || raw.format !== 1) return null
  if (typeof raw.id !== 'string' || !RECORD_ID.test(raw.id) || `${raw.id}.json` !== name) return null
  if (!validPath(raw.path) || typeof raw.sha256 !== 'string' || !SHA.test(raw.sha256)) return null
  if (!Number.isSafeInteger(raw.bytes) || (raw.bytes as number) < 0 || !Number.isFinite(raw.ts)) return null
  if (typeof raw.device !== 'string' || raw.device.length > 200 || !CAUSES.has(raw.cause as ReplicaCause)) return null
  if (!Array.isArray(raw.parents) || raw.parents.length > 8 || !raw.parents.every((p) => typeof p === 'string' && SHA.test(p))) return null
  if (raw.from !== undefined && !validPath(raw.from)) return null
  if (raw.note !== undefined && (typeof raw.note !== 'string' || raw.note.length > 2000)) return null
  if (raw.aliases !== undefined && (!Array.isArray(raw.aliases) || raw.aliases.length > 4 || !raw.aliases.every((a) => typeof a === 'string' && a !== '' && a.length <= 200))) return null
  return {
    kind: 'writeflex-replica-version', format: 1, id: raw.id, path: raw.path, sha256: raw.sha256, bytes: raw.bytes as number,
    ts: raw.ts as number, device: raw.device, cause: raw.cause as ReplicaCause, parents: raw.parents as string[],
    ...(raw.aliases !== undefined ? { aliases: raw.aliases as string[] } : {}),
    ...(raw.from !== undefined ? { from: raw.from as string } : {}), ...(raw.note !== undefined ? { note: raw.note as string } : {}),
  }
}

const CAUSE_NAMES: Record<ReplicaCause, (r: ReplicaRecord) => string> = {
  baseline: (r) => `As it was before editing on ${r.device}`,
  save: (r) => `Saved on ${r.device}`,
  incoming: () => 'Arrived through sync',
  'before-restore': () => 'Before a version was restored',
  'before-keep-mine': () => 'The other copy, before Keep mine',
  preserve: () => 'Kept before merging',
  'sync-copy': (r) => `Copy made by sync${r.from ? ` (${posix.basename(r.from)})` : ''}`,
  merged: () => 'Two copies merged automatically',
  'before-reconcile': () => 'Before two copies were reconciled',
  'before-command': () => 'Before a command changed it',
  command: (r) => `Changed by a command on ${r.device}`,
}

/** A replica record as a Version, for the Versions list, Compare and Restore. */
export function versionOfReplica(record: ReplicaRecord): Version {
  return {
    id: record.id,
    path: record.path,
    name: CAUSE_NAMES[record.cause](record),
    author: { name: record.device },
    ts: record.ts,
    snapshotId: `${REPLICA_SNAPSHOT_PREFIX}${record.sha256}`,
    ...(record.note ? { note: record.note } : {}),
  }
}

export class ReplicaStoreRefused extends Error {
  override readonly name = 'ReplicaStoreRefused'
}

const NO_HARD_LINKS = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'])

function writeAllSync(fd: number, bytes: Uint8Array): void {
  let at = 0
  while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at, at)
}

const FOLDER_MOVED = 'A folder of the version store was moved or replaced while a version was being kept. Nothing was written there.'

const writeFd = promisify(write)
const fsyncFd = promisify(fsync)
const closeFd = promisify(close)

async function writeAllAsync(fd: number, bytes: Uint8Array): Promise<void> {
  let at = 0
  while (at < bytes.length) at += (await writeFd(fd, bytes, at, bytes.length - at, at)).bytesWritten
}

/**
 * Write `bytes` at `name` in the pinned folder. The bytes go to a temporary file made in the pinned
 * folder in the same tick as the check that every folder on the way is still the one pinned; they are
 * written and fsynced asynchronously (through the descriptor, so a folder moved meanwhile cannot redirect
 * them); then, in ONE synchronous step, the chain is checked again and the file takes its name.
 * `once`: only if nothing stands at the name (hard link; where the file system has no hard links, an
 * exclusive create). `replace`: rename over the name.
 */
export async function writePinned(
  chain: PinnedChain, name: string, bytes: Uint8Array, mode: 'once' | 'replace',
  /** Told, in the synchronous step that names the file, the identity of the file it named (taken from the
   *  staged descriptor before naming): the own-write record the watcher checks (`wasPublishedByThisApp`). */
  published?: (identity: FileIdentity) => void,
): Promise<'written' | 'exists'> {
  if (!chainStands(chain)) throw new ReplicaStoreRefused(FOLDER_MOVED)
  const target = join(chain.real, name)
  const staged = join(chain.real, `.${name}.${randomBytes(6).toString('hex')}.tmp`)
  const fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
  let complete = false
  let identity: FileIdentity | null = null
  try {
    await writeAllAsync(fd, bytes)
    await fsyncFd(fd)
    // What the file is (device, inode, size, time to the nanosecond), from its own descriptor: a link or a
    // rename keeps all four, so this is what stands at the name after this step and while nobody replaces it.
    identity = fileIdentityOf(fstatSync(fd, { bigint: true }))
    complete = true
  } finally {
    await closeFd(fd).catch(() => {})
    if (!complete && chainStands(chain)) { try { unlinkSync(staged) } catch { /* left inert */ } }
  }
  // ---- One synchronous step: check, then name. ----
  // Another program may have moved a folder meanwhile: the staged file is then left where it was made.
  if (!chainStands(chain)) throw new ReplicaStoreRefused(FOLDER_MOVED)
  if (mode === 'replace') {
    renameSync(staged, target)
    if (identity) published?.(identity)
    return 'written'
  }
  try {
    linkSync(staged, target)
    if (identity) published?.(identity)
    return 'written'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    if (code === 'EEXIST') return 'exists'
    if (!NO_HARD_LINKS.has(code)) throw error
    // No hard links here: an exclusive create (readers verify size and hash, so a torn file is never listed).
    let out: number
    try { out = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644) } catch (created) {
      if ((created as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
      throw created
    }
    try {
      writeAllSync(out, bytes); fsyncSync(out)
      published?.(fileIdentityOf(fstatSync(out, { bigint: true })))
    } finally { closeSync(out) }
    return 'written'
  } finally {
    try { unlinkSync(staged) } catch { /* already gone */ }
  }
}

export type CaptureInput = {
  path: string
  bytes: string | Uint8Array
  cause: ReplicaCause
  parents?: string[]
  from?: string
  note?: string
  /** `path-hash` (default): nothing new when any record already keeps these bytes for this path.
   *  `latest`: nothing new when the newest record for this path keeps them. `never`: always a record. */
  dedupe?: 'path-hash' | 'latest' | 'never'
}

export type CaptureResult = { record: ReplicaRecord; created: boolean }

const stores = new Map<string, ReplicaVersions>()

/**
 * What this process published into each Collection's store, per root: the OwnWriteTracker rule of the
 * Collection watcher (D-WATCH-1). A capture republishes its object even when the text is already kept, so
 * without this every pass would see its own objects arrive and ask for another pass. Only a path that
 * still holds exactly the file published there, within the dedupe window, counts as this app's own: a
 * replacement delivered by sync (another inode, size or time) is an arrival.
 */
const publications = new Map<string, OwnWriteTracker>()

function publicationsOf(root: string): OwnWriteTracker {
  let tracker = publications.get(root)
  if (!tracker) { tracker = new OwnWriteTracker((path) => join(root, path)); publications.set(root, tracker) }
  return tracker
}

/** `path` (Collection-relative) still holds exactly what this app published there, moments ago. */
export function wasPublishedByThisApp(root: string, path: string, at = Date.now()): boolean {
  return publications.get(root)?.isRecent(path, at) ?? false
}

/** The one store object for `root` in this process (its cache and write queue are shared). */
export function replicaVersionsFor(root: string, opts: { device?: string; aliases?: string[]; now?: () => number } = {}): ReplicaVersions {
  const key = `${root}\0${opts.device ?? ''}\0${(opts.aliases ?? []).join('\0')}`
  let store = stores.get(key)
  if (!store) { store = new ReplicaVersions(root, opts); stores.set(key, store) }
  return store
}

/** @internal Tests: forget cached store objects (each test makes its own roots). */
export function forgetReplicaStores(): void { stores.clear(); syncCache.clear(); publications.clear() }

export class ReplicaVersions {
  readonly device: string
  /** Other names of this computer (its ComputerName), recorded with each version for copy matching. */
  readonly aliases: string[]
  readonly #now: () => number
  #queue: Promise<unknown> = Promise.resolve()
  #lastTs = 0
  readonly #cache = new Map<string, ReplicaRecord>()

  constructor(readonly root: string, opts: { device?: string; aliases?: string[]; now?: () => number } = {}) {
    this.device = opts.device ?? thisDevice()
    // A device named by the caller (tests) has only the aliases it is given; otherwise the local ComputerName.
    const aliases = opts.aliases ?? (opts.device ? [] : [localComputerName()].filter((a): a is string => !!a))
    this.aliases = [...new Set(aliases.filter((a) => a !== this.device))].slice(0, 4)
    this.#now = opts.now ?? Date.now
  }

  #run<T>(op: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(op)
    this.#queue = result.then(() => undefined, () => undefined)
    return result
  }

  /** Every readable record, oldest first; with `present`, only those whose object is here and sized right. */
  async records(opts: { path?: string; present?: boolean } = {}): Promise<ReplicaRecord[]> {
    let folder: PinnedChain | null
    let objects: PinnedChain | null = null
    try {
      folder = pinChain(this.root, RECORDS, false)
      if (opts.present) objects = pinChain(this.root, OBJECTS, false)
    } catch { return [] }
    if (!folder || (opts.present && !objects)) return []
    let names: string[]
    try { names = chainStands(folder) ? readdirSync(folder.real) : [] } catch { names = [] }
    const out: ReplicaRecord[] = []
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue
      if (!this.#cache.has(name)) {
        // Not cached when unreadable or unsound: sync may still be delivering it.
        const bytes = await readPinned(folder, name, MAX_RECORD_BYTES)
        const parsed = bytes ? parseRecord(bytes.toString('utf8'), name) : null
        if (!parsed) continue
        this.#cache.set(name, parsed)
      }
      const record = this.#cache.get(name)
      if (!record || (opts.path && record.path !== opts.path)) continue
      if (objects) {
        const info = lstatSync(join(objects.real, record.sha256), { throwIfNoEntry: false })
        if (!info?.isFile() || info.size !== record.bytes) continue
      }
      out.push(record)
    }
    return out.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id))
  }

  /** The exact bytes kept under `sha`, or null (absent, unreadable, or not the bytes it is named for). */
  async read(sha: string): Promise<Buffer | null> {
    if (!SHA.test(sha)) return null
    let folder: PinnedChain | null
    try { folder = pinChain(this.root, OBJECTS, false) } catch { return null }
    return folder ? readObject(folder, sha) : null
  }

  /** Whether these exact bytes are kept: the object reads back and hashes to its name. Reads the object
   *  (which may make a cloud placeholder download): for checks off the save path only. */
  async holds(sha: string): Promise<boolean> {
    return (await this.read(sha)) !== null
  }

  /** Whether an object of `bytes` bytes stands under `sha`, looked at without reading it (a placeholder of
   *  an old version is never downloaded for this). Its content is verified whenever it is read. */
  #present(objects: PinnedChain, sha: string, bytes: number): boolean {
    if (!chainStands(objects)) return false
    const info = lstatSync(join(objects.real, sha), { throwIfNoEntry: false })
    return !!info?.isFile() && info.size === bytes
  }

  /** Keep `bytes` as a version of `path`. Publishes and fsyncs these known bytes before recording the version; readers verify their hash. */
  capture(input: CaptureInput): Promise<CaptureResult> {
    if (!validPath(input.path)) return Promise.reject(new ReplicaStoreRefused('A version can only be kept for a path inside the Collection.'))
    const bytes = bytesOf(input.bytes)
    if (bytes.length > MAX_REPLICA_BYTES) return Promise.reject(new ReplicaStoreRefused(`${input.path} is too large to keep as a version.`))
    const sha = sha256Hex(bytes)
    return this.#run(async () => {
      // Publish the bytes we actually hold before trusting any existing metadata. A same-size
      // object may be corrupt or a placeholder; replacing it from these known bytes needs no read
      // or download. Local recovery may be retired only after this fsynced publication succeeds.
      const objects = pinChain(this.root, OBJECTS, true)!
      const published = publicationsOf(this.root)
      await writePinned(objects, sha, bytes, 'replace', (identity) => published.record(`${OBJECTS}/${sha}`, identity))
      const dedupe = input.dedupe ?? 'path-hash'
      if (dedupe !== 'never') {
        const existing = await this.records({ path: input.path, present: true })
        // `present` compares sizes only: no earlier object is read (or downloaded) to decide.
        const match = dedupe === 'latest' ? existing.at(-1)?.sha256 === sha ? existing.at(-1) : undefined : existing.findLast((r) => r.sha256 === sha)
        if (match) return { record: match, created: false }
      }
      // Strictly increasing within this process, so versions kept in one moment keep their order.
      const ts = Math.max(this.#now(), this.#lastTs + 1)
      this.#lastTs = ts
      const record: ReplicaRecord = {
        kind: 'writeflex-replica-version', format: 1,
        id: `rv_${ts.toString(36)}_${randomBytes(6).toString('hex')}`,
        path: input.path, sha256: sha, bytes: bytes.length, ts, device: this.device,
        ...(this.aliases.length ? { aliases: this.aliases } : {}), cause: input.cause,
        parents: [...new Set((input.parents ?? []).filter((p) => SHA.test(p) && p !== sha))].slice(0, 8),
        ...(input.from ? { from: input.from } : {}), ...(input.note ? { note: input.note.slice(0, 2000) } : {}),
      }
      const recordsFolder = pinChain(this.root, RECORDS, true)!
      await writePinned(recordsFolder, `${record.id}.json`, Buffer.from(`${JSON.stringify(record)}\n`, 'utf8'), 'once',
        (identity) => published.record(`${RECORDS}/${record.id}.json`, identity))
      this.#cache.set(`${record.id}.json`, record)
      return { record, created: true }
    })
  }

  /**
   * The hashes `sha` was made from, transitively (itself included, at depth 0), counting only the records
   * of the one document `path`. Lineage is a claim a record makes about its own document: identical text
   * in another document says nothing about how this one came to be, so it is never used as ancestry. A
   * document renamed since keeps its earlier records under the earlier name; those are not followed (a
   * pair whose lineage is only there is left divergent, both texts kept: the conservative outcome).
   */
  async ancestors(sha: string, path: string): Promise<Map<string, number>> {
    const parents = new Map<string, Set<string>>()
    for (const r of await this.records({ path })) {
      const set = parents.get(r.sha256) ?? new Set<string>()
      for (const p of r.parents) set.add(p)
      parents.set(r.sha256, set)
    }
    const depth = new Map<string, number>([[sha, 0]])
    const queue = [sha]
    while (queue.length) {
      const next = queue.shift()!
      for (const p of parents.get(next) ?? []) {
        if (!depth.has(p)) { depth.set(p, depth.get(next)! + 1); queue.push(p) }
      }
    }
    return depth
  }

  /** Device names (and their recorded aliases) known to have edited this Collection with WriteFlex, this Mac's included. */
  async devices(): Promise<string[]> {
    const names = [this.device, ...this.aliases]
    for (const r of await this.records()) names.push(r.device, ...(r.aliases ?? []))
    return [...new Set(names)]
  }
}

/** The object `sha` in the pinned objects folder, only when it hashes to its name. Asynchronous. */
async function readObject(objects: PinnedChain, sha: string): Promise<Buffer | null> {
  const bytes = await readPinned(objects, sha, MAX_REPLICA_BYTES)
  return bytes && sha256Hex(bytes) === sha ? bytes : null
}

const syncCache = new Map<string, ReplicaRecord>()

/**
 * The replica records of `root` whose objects are present and sized right, read synchronously (the
 * version-history projection in version-moves.ts is synchronous). Never creates anything.
 */
export function readReplicaRecordsSync(root: string): ReplicaRecord[] {
  let records: PinnedChain | null
  let objects: PinnedChain | null
  try {
    records = pinChain(root, RECORDS, false)
    objects = pinChain(root, OBJECTS, false)
  } catch { return [] }
  if (!records || !objects) return []
  let names: string[]
  try { names = chainStands(records) ? readdirSync(records.real) : [] } catch { return [] }
  const out: ReplicaRecord[] = []
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue
    const key = `${records.real}/${name}`
    let record = syncCache.get(key)
    if (!record) {
      const bytes = readPinnedSync(records, name, MAX_RECORD_BYTES)
      const parsed = bytes ? parseRecord(bytes.toString('utf8'), name) : null
      if (!parsed) continue
      record = parsed
      syncCache.set(key, record)
    }
    const object = lstatSync(join(objects.real, record.sha256), { throwIfNoEntry: false })
    if (object?.isFile() && object.size === record.bytes) out.push(record)
  }
  return out.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id))
}

/** Exists only for callers that must not create the store when there is none. */
export function hasReplicaStore(root: string): boolean {
  try { return existsSync(join(realpathSync(root), RECORDS)) } catch { return false }
}

/** The text of a document as WriteFlex keeps it: Markdown documents in listed folders, never app metadata. */
export function isVersionedDocumentPath(path: string): boolean {
  if (!validPath(path) || !/\.(?:md|markdown|mdx)$/i.test(path)) return false
  // A dot-named document is a document; a dot-named FOLDER (.writeflex, .bridle, .git, …) is never listed.
  return !path.split('/').slice(0, -1).some((part) => part.startsWith('.'))
}

/** Direct document writes (the command line, app-carried requests) keep their versions through local
 *  recovery first: document-write-versions.ts `documentWriteVersionsFor`. */

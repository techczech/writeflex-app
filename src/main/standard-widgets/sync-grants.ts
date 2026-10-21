/**
 * Sync grants (contracts §1.1, §14 C4+C9): the app-local record of where a kept-in-sync resource's original is.
 * Main process only. The store is one JSON file in the app's data folder, never inside a Workspace and never
 * synced with a Folio: `{ version: 1, grants: [{ id, folio, resource, kind, origin, granted_at }] }`.
 *
 * What holds:
 * - The manifest never holds the original's location; the grant id is the only link.
 * - A grant is bound to the triple (Folio identity, resource id, origin) when it is written and is never edited.
 *   `lookupGrant` answers the origin only for an exact match of the building Folio's identity (the real path of its
 *   folder) and the declaring item's id; any other answer reads nothing. A grant id copied into another item, another
 *   Folio or a copied Folio therefore never reaches the original (`sync-grant-mismatch`).
 * - Writing: `SyncGrantStore.add` and `.undoAdd` are called ONLY by the native-picker intake (outside-files.ts), the
 *   one flow that writes grants. No IPC channel, content verb, agent tool or CLI command reaches them; a test reads
 *   the sources to keep it so.
 * - The original is read by `readOrigin` only: an open that follows no link anywhere on the path (O_NOFOLLOW_ANY on
 *   macOS; non-blocking, so a named pipe cannot hold the build), the descriptor checked to be a regular file within the size cap, the bytes read from that descriptor.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { constants } from 'node:fs'
import { OPEN_NOFOLLOW } from '../widget-file'

export type SyncGrant = { id: string; folio: string; resource: string; kind: 'file' | 'folder'; origin: string; granted_at: string }
export type GrantLookup =
  | { ok: true; origin: string; grant: SyncGrant }
  | { ok: false; code: 'resource-declaration-invalid' | 'origin-not-on-this-mac' | 'sync-grant-mismatch' }

export const GRANT_ID = /^g-[a-z2-7]{26}$/
/** The store holds at most this many grants; past it no new grant is written (the intake is refused). */
export const GRANT_STORE_MAX = 10_000
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** A new grant id: `g-` + 26 base32 characters (128 random bits; the last character carries 3 of them). */
export function newGrantId(): string {
  const bytes = randomBytes(17)
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5 && out.length < 26) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5 }
    value &= (1 << bits) - 1
  }
  return `g-${out}`
}

const isGrant = (value: unknown): value is SyncGrant => {
  if (typeof value !== 'object' || value === null) return false
  const grant = value as Record<string, unknown>
  return typeof grant.id === 'string' && GRANT_ID.test(grant.id) && typeof grant.folio === 'string' && typeof grant.resource === 'string'
    && (grant.kind === 'file' || grant.kind === 'folder') && typeof grant.origin === 'string' && typeof grant.granted_at === 'string'
}

/** What a grant write changed in the store, for its undo: the store's text before and after. */
export type GrantWrite = { id: string; before: string | null; after: string }

export class SyncGrantStore {
  constructor(readonly file: string) {}

  /** The store's text, or null when there is none. */
  text(): string | null {
    try { return readFileSync(this.file, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  /** The grants on this Mac. A store that cannot be read holds none (every lookup: `origin-not-on-this-mac`). */
  grants(): SyncGrant[] {
    try { return this.#parse(this.text()) } catch { return [] }
  }

  #parse(text: string | null): SyncGrant[] {
    if (text === null) return []
    const json = JSON.parse(text) as unknown
    if (typeof json !== 'object' || json === null || (json as { version?: unknown }).version !== 1 || !Array.isArray((json as { grants?: unknown }).grants)) throw new Error('The sync record is not one this WriteFlex reads.')
    return ((json as { grants: unknown[] }).grants).filter(isGrant)
  }

  #write(text: string | null): void {
    if (text === null) { try { unlinkSync(this.file) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } return }
    mkdirSync(dirname(this.file), { recursive: true })
    const staged = join(dirname(this.file), `.${randomBytes(8).toString('hex')}.writeflex-grants.tmp`)
    writeFileSync(staged, text, { flag: 'wx', mode: 0o600 })
    try { renameSync(staged, this.file) } catch (error) { try { unlinkSync(staged) } catch { /* gone */ } throw error }
  }

  /** ONLY the native-picker intake (outside-files.ts) calls this. A store that cannot be read is never overwritten. */
  add(grant: SyncGrant): GrantWrite {
    if (!isGrant(grant)) throw new Error('The sync record was not written: the grant is not complete.')
    const before = this.text()
    const grants = this.#parse(before)
    if (grants.length >= GRANT_STORE_MAX) throw new Error('WriteFlex keeps too many files in sync already, so this one was not added.')
    if (grants.some((known) => known.id === grant.id)) throw new Error('The sync record was not written: the grant id is taken.')
    const after = `${JSON.stringify({ version: 1, grants: [...grants, grant] }, null, 2)}\n`
    this.#write(after)
    return { id: grant.id, before, after }
  }

  /** Take back a grant this process wrote (the undo or rollback of its intake): the store as it was before when
   *  nothing else changed it since; otherwise only that grant is removed. ONLY outside-files.ts calls this. */
  undoAdd(write: GrantWrite): void {
    const now = this.text()
    if (now === write.after) { this.#write(write.before); return }
    if (now === null) return
    const grants = this.#parse(now)
    if (!grants.some((grant) => grant.id === write.id)) return
    this.#write(`${JSON.stringify({ version: 1, grants: grants.filter((grant) => grant.id !== write.id) }, null, 2)}\n`)
  }
}

/** §1.1 lookup, the only reader of a grant at build: the origin only for an exact binding. */
export function lookupGrant(store: SyncGrantStore | null, folioIdentity: string, resourceId: string, grantId: unknown): GrantLookup {
  if (typeof grantId !== 'string' || !GRANT_ID.test(grantId)) return { ok: false, code: 'resource-declaration-invalid' }
  const grant = store?.grants().find((known) => known.id === grantId)
  if (!grant) return { ok: false, code: 'origin-not-on-this-mac' }
  if (grant.kind !== 'file' || grant.folio !== folioIdentity || grant.resource !== resourceId) return { ok: false, code: 'sync-grant-mismatch' }
  return { ok: true, origin: grant.origin, grant }
}

/** The app's store, set once by the main process where its data folder is known (null: no grants on this Mac). */
let appStore: SyncGrantStore | null = null
export function setAppSyncGrantStore(store: SyncGrantStore | null): void { appStore = store }
export function appSyncGrantStore(): SyncGrantStore | null { return appStore }

export type OriginRead =
  | { ok: true; bytes: Buffer; dev: number; ino: number }
  | { ok: false; reason: 'missing' | 'link' | 'not-file' | 'too-large' | 'unreadable' }

/** TEST-ONLY: told each time an original is about to be opened (to prove a refused lookup never reads it). */
export const originSeams: { beforeOpen?: (origin: string) => void } = {}

/** Read an original outside the Workspace: no link followed anywhere on the path, a regular file only, at most
 *  `maxBytes`, the bytes read from the descriptor that was checked. */
export async function readOrigin(origin: string, maxBytes: number): Promise<OriginRead> {
  if (typeof origin !== 'string' || !origin.startsWith('/') || origin.includes('\0')) return { ok: false, reason: 'unreadable' }
  originSeams.beforeOpen?.(origin)
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    try { handle = await open(origin, constants.O_RDONLY | constants.O_NONBLOCK | OPEN_NOFOLLOW) } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return { ok: false, reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : code === 'ELOOP' ? 'link' : 'unreadable' }
    }
    const info = await handle.stat()
    if (!info.isFile()) return { ok: false, reason: 'not-file' }
    if (info.size > maxBytes) return { ok: false, reason: 'too-large' }
    const bytes = await handle.readFile()
    if (bytes.byteLength > maxBytes) return { ok: false, reason: 'too-large' }
    return { ok: true, bytes, dev: info.dev, ino: info.ino }
  } catch {
    return { ok: false, reason: 'unreadable' }
  } finally {
    await handle?.close().catch(() => {})
  }
}

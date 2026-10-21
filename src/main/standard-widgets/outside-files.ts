/**
 * Bringing a file from anywhere on the Mac into a widget (ticket 04c; design README lines 29 and 33, contracts §1,
 * §1.1, §14 C3/C4/C9). Main process only.
 *
 *   pickStandardWidgetSource   the workbench's Choose file…: the native picker (the dialog is passed in, so the e2e
 *                              run can stand in for it at that seam only). A file inside the document's folders is
 *                              answered by its workspace path and used in place. Any other file is read once, here,
 *                              without following a link, as a regular file within the size cap, and held under an
 *                              opaque token; the renderer gets the token, the name and the text, never the path.
 *   intakeOutsideFile          inside a widget step: the held bytes copied into the Folio's `resources/` by the
 *                              guarded write (never over anything), the item declared in the manifest (`copy`, or
 *                              `sync` with a grant id; never the original's path), and, for Keep in sync, the grant
 *                              written to the app-local store, bound to (Folio identity, resource id, origin). The
 *                              grant write is returned so the step's rollback and its one undo take it back.
 *
 * Only a pick made here can carry an origin: a pick is genuine only when this module made it (`isGenuinePick`), and
 * intake refuses any other object, so no request from the renderer or an agent can name a path for a grant.
 */
import { createHash, randomBytes } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { basename, dirname, extname, join, posix } from 'node:path'
import { parseManifest } from '../folio'
import { backupManifestDocument } from '../plan'
import { readContainedFile, walkNoFollowSync } from '../widget-file'
import { assertRelativeWorkspacePath, isHiddenWorkspacePath, type Workspace } from '../workspace'
import { MANIFEST_NAME } from '../../shared/folio-constants'
import { nativeSlug, SOURCE_MAX_BYTES, writeInWidgetFolder, writeManifestOver } from './build'
import { addResourceItemText, declaredResourceItems, type ResourceItem } from './resources-manifest'
import { ensureFolder, folderIdentity, type MadeFolder } from './step-folders'
import { newGrantId, readOrigin, type GrantWrite, type SyncGrantStore } from './sync-grants'

export const RESOURCES_DIR = 'resources'
const DATA_FILE = /\.(csv|json)$/i
const inFolder = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`)
const parentDir = (path: string): string => (posix.dirname(path) === '.' ? '' : posix.dirname(path))

/** The dialog seam: Electron's `dialog.showOpenDialog` in the app; a stand-in in tests. */
export type PickDialog = (options: { title: string; buttonLabel: string; properties: Array<'openFile'>; filters: Array<{ name: string; extensions: string[] }> }) => Promise<{ canceled: boolean; filePaths: string[] }>

/** A file picked outside the document's folders, held in main. Only this module makes one. */
export type OutsidePick = Readonly<{ name: string; origin: string; bytes: Buffer; kind: 'csv' | 'json'; /** The document the pick was made for: the only one whose Folio it may be brought into. */ documentPath: string; /** That document's Folio folder (or its own folder in no Folio) when it was picked, by path and identity. */ folder: Readonly<{ path: string; dev: number; ino: number }> }>
const genuine = new WeakSet<object>()
export const isGenuinePick = (pick: unknown): pick is OutsidePick => typeof pick === 'object' && pick !== null && genuine.has(pick)

export type PickAnswer =
  | { ok: true; inside: true; /** Workspace-relative; the file is used in place. */ path: string; name: string; text: string }
  | { ok: true; inside: false; /** Opaque: stands for the file in this window until it is used or forgotten. */ token: string; name: string; text: string }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: false; message: string }

type HeldPick = { pick: OutsidePick; owner: number; root: string; documentPath: string; at: number }

/** The picks of this process, newest kept: a token is good only for the window, Workspace and document it was made
 *  for, for an hour, and at most `limit` are held. */
export class PickDesk {
  readonly #held = new Map<string, HeldPick>()
  constructor(private readonly limit = 4, private readonly ttlMs = 60 * 60 * 1000) {}

  hold(pick: OutsidePick, owner: number, root: string, documentPath: string): string {
    const token = randomBytes(16).toString('hex')
    this.#held.set(token, { pick, owner, root, documentPath, at: Date.now() })
    while (this.#held.size > this.limit) this.#held.delete(this.#held.keys().next().value as string)
    return token
  }

  /** The pick behind `token`, for that window, Workspace and document only; null otherwise. Left held (a preview). */
  get(token: unknown, owner: number, root: string, documentPath: string): OutsidePick | null {
    return this.#find(token, owner, root, documentPath)?.pick ?? null
  }

  /** The pick behind `token`, taken out of the desk in the same tick (before any await), so two steps can never
   *  both use it. `handBack` returns it, for a step that wrote nothing. */
  take(token: unknown, owner: number, root: string, documentPath: string): { pick: OutsidePick; handBack: () => void } | null {
    const held = this.#find(token, owner, root, documentPath)
    if (!held) return null
    this.#held.delete(token as string)
    return { pick: held.pick, handBack: () => { if (!this.#held.has(token as string)) this.#held.set(token as string, held) } }
  }

  #find(token: unknown, owner: number, root: string, documentPath: string): HeldPick | null {
    if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) return null
    const held = this.#held.get(token)
    if (!held) return null
    if (Date.now() - held.at > this.ttlMs) { this.#held.delete(token); return null }
    if (held.owner !== owner || held.root !== root || held.documentPath !== documentPath) return null
    return held
  }

  forget(token: string): void { this.#held.delete(token) }
}

function decodeUtf8(bytes: Buffer): string | null {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return null }
}

/** `bytes` as text that encodes back to exactly these bytes (a byte-order mark kept as U+FEFF), or null when they
 *  are not UTF-8. Only for handing bytes to a text writer; the bytes stay the authority. */
export function exactUtf8(bytes: Buffer): string | null {
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { return null }
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null
}

/** Largest manifest the Folio resolver reads. */
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024

export type DocumentFolio = { ok: true; folder: string } | { ok: false; message: string }

/**
 * The one answer to "which Folio is this document in" for a file brought in from outside: the pick binds to it, the
 * check at the write repeats it, and the step's destination must be it. Read fresh from disk (never the Folio cache,
 * folio-place.ts): the nearest folder above the document holding a manifest, found by a no-follow walk and read by
 * `parseManifest`, the rule `folioContaining` reads by; else the document's own folder (no Folio, or a Folio by its
 * Index Note, which is that folder too). A manifest on the way that cannot be read as one (a link, not a plain file,
 * too large, or not a manifest by that rule) is refused by name: where `folioContaining` would pass over it, this
 * never guesses.
 */
export async function documentFolio(realRoot: string, documentPath: string): Promise<DocumentFolio> {
  for (let cursor = parentDir(documentPath); ; cursor = parentDir(cursor)) {
    const path = cursor === '' ? MANIFEST_NAME : `${cursor}/${MANIFEST_NAME}`
    const read = await readContainedFile(realRoot, path, MANIFEST_MAX_BYTES)
    if (read.ok) {
      if (parseManifest(cursor, read.bytes.toString('utf8')) !== null) return { ok: true, folder: cursor }
    } else if (read.reason === 'missing') {
      if (cursor === '') return { ok: true, folder: parentDir(documentPath) }
      continue
    }
    return { ok: false, message: `The manifest ${path} can't be read, so WriteFlex cannot tell which Folio ${documentPath} is in; nothing was written.` }
  }
}

/** Native picker → a file in place, or an outside file held under a token. Never throws for a refusal. */
export async function pickStandardWidgetSource(ws: Workspace, desk: PickDesk, owner: number, documentPath: string, dialog: PickDialog): Promise<PickAnswer> {
  try { assertRelativeWorkspacePath(documentPath) } catch { return { ok: false, message: 'The document must be a path inside the open Workspace.' } }
  if (!/\.(md|markdown)$/i.test(documentPath) || isHiddenWorkspacePath(documentPath)) return { ok: false, message: `${documentPath} is not a Markdown document in a visible folder.` }
  const realRoot = await realpath(ws.root)
  if (walkNoFollowSync(realRoot, documentPath).kind !== 'file') return { ok: false, message: `${documentPath} is not a real document in real folders of the open Workspace.` }
  const chosen = await dialog({ title: 'Choose the file the widget is built from', buttonLabel: 'Choose', properties: ['openFile'], filters: [{ name: 'CSV or JSON', extensions: ['csv', 'json'] }] })
  if (chosen.canceled || chosen.filePaths.length === 0) return { ok: false, cancelled: true }
  return pickedFile(ws, desk, owner, documentPath, realRoot, chosen.filePaths[0])
}

async function pickedFile(ws: Workspace, desk: PickDesk, owner: number, documentPath: string, realRoot: string, picked: string): Promise<PickAnswer> {
  const name = basename(picked)
  if (typeof picked !== 'string' || !picked.startsWith('/') || picked.includes('\0')) return { ok: false, message: 'That file cannot be read.' }
  if (!DATA_FILE.test(name)) return { ok: false, message: `${name} is not a CSV or JSON file.` }
  // The file itself, not what a link leads to.
  let info: ReturnType<typeof lstatSync>
  try { info = lstatSync(picked) } catch { return { ok: false, message: `${name} is not there any more.` } }
  if (info.isSymbolicLink()) return { ok: false, message: `${name} is a link. Choose the file it points to instead.` }
  if (!info.isFile()) return { ok: false, message: `${name} is not a plain file.` }
  // The original's real location: its folder's real path (system links such as /tmp resolved) and its own name.
  let origin: string
  try { origin = join(await realpath(dirname(picked)), name) } catch { return { ok: false, message: `${name} cannot be read.` } }
  const folio = await documentFolio(realRoot, documentPath)
  if (!folio.ok) return { ok: false, message: folio.message }
  const bundle = folio.folder
  const bundleId = folderIdentity(realRoot, bundle)
  if (!bundleId) return { ok: false, message: `${bundle || 'The Workspace folder'} is not a real folder of the open Workspace.` }
  const bundleReal = bundle === '' ? realRoot : join(realRoot, ...bundle.split('/'))
  if (origin.startsWith(`${bundleReal}/`)) {
    const path = origin.slice(realRoot.length + 1).split('/').join('/')
    if (!isHiddenWorkspacePath(path)) {
      const read = await readContainedFile(realRoot, path, SOURCE_MAX_BYTES)
      if (!read.ok) return { ok: false, message: read.reason === 'too-large' ? `${name} is larger than ${SOURCE_MAX_BYTES / 1024 / 1024} MiB.` : `${name} cannot be read without following a link.` }
      const text = decodeUtf8(read.bytes)
      if (text === null) return { ok: false, message: `${name} is not UTF-8 text.` }
      return { ok: true, inside: true, path, name, text }
    }
  }
  const read = await readOrigin(origin, SOURCE_MAX_BYTES)
  if (!read.ok) {
    return { ok: false, message: read.reason === 'too-large' ? `${name} is larger than ${SOURCE_MAX_BYTES / 1024 / 1024} MiB, so it cannot be brought in.`
      : read.reason === 'link' ? `${name} is reached through a link, which WriteFlex does not follow.`
      : read.reason === 'not-file' ? `${name} is not a plain file.` : `${name} cannot be read.` }
  }
  // The descriptor read is the file that was chosen (not one swapped in since).
  if (read.dev !== info.dev || read.ino !== info.ino) return { ok: false, message: `${name} changed while it was being read. Choose it again.` }
  const text = decodeUtf8(read.bytes)
  if (text === null) return { ok: false, message: `${name} is not UTF-8 text.` }
  const pick: OutsidePick = Object.freeze({ name, origin, bytes: read.bytes, kind: /\.json$/i.test(name) ? 'json' as const : 'csv' as const, documentPath, folder: Object.freeze({ path: bundle, ...bundleId }) })
  genuine.add(pick)
  return { ok: true, inside: false, token: desk.hold(pick, owner, ws.root, documentPath), name, text }
}

/**
 * Whether `pick` may still be brought in, checked in the write turn just before the intake (and before the step):
 * the document it was chosen for is still a plain file at its path, reached with no link anywhere on the way, and
 * its Folio folder (or own folder) is the very folder it was in at the pick (path and device/inode). Null when it
 * may; otherwise the refusal, naming what changed.
 */
export async function pickStillAuthorised(ws: Workspace, realRoot: string, pick: OutsidePick): Promise<string | null> {
  const document = pick.documentPath
  if (walkNoFollowSync(realRoot, document).kind !== 'file') return `${document}, the document ${pick.name} was chosen for, is no longer a plain file reached without a link, so nothing was written.`
  const changed = `${pick.folder.path || 'The Workspace folder'}, the folder ${document} was in when ${pick.name} was chosen, has changed since, so nothing was written. Choose the file again.`
  const now = folderIdentity(realRoot, pick.folder.path)
  if (!now || now.dev !== pick.folder.dev || now.ino !== pick.folder.ino) return changed
  // Fresh from disk at the write: a manifest added nearer the document since the pick makes it another Folio's.
  const folio = await documentFolio(realRoot, document)
  if (!folio.ok) return folio.message
  if (folio.folder !== pick.folder.path) return changed
  return null
}

/** TEST-ONLY: the picked-file path of `pickStandardWidgetSource` without a dialog. */
export const pickedFileForTest = pickedFile

/** §5: the id a new resource at `resources/<name>` gets: the native slug of the name without its extension, then
 *  `-<ext>`, then `-2`, `-3` … until no declared item has it. */
export function newResourceId(fileName: string, taken: ReadonlySet<string>): string {
  const ext = extname(fileName)
  const stem = nativeSlug(ext ? fileName.slice(0, -ext.length) : fileName).slice(0, 70).replace(/-+$/, '') || 'section'
  const extSlug = nativeSlug(ext.replace(/^\./, ''))
  const candidates = [stem, ...(extSlug && extSlug !== 'section' ? [`${stem}-${extSlug}`] : [])]
  for (const candidate of candidates) if (!taken.has(candidate)) return candidate
  const base = candidates.at(-1) as string
  for (let ordinal = 2; ; ordinal += 1) if (!taken.has(`${base}-${ordinal}`)) return `${base}-${ordinal}`
}

/** A free name for the copy in `folder`: the original's name, else `name-2.ext`, `name-3.ext` …; never over anything. */
function freeCopyName(realRoot: string, folder: string, name: string): string | null {
  const ext = extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  for (let ordinal = 1; ordinal <= 999; ordinal += 1) {
    const candidate = ordinal === 1 ? name : `${stem}-${ordinal}${ext}`
    if (walkNoFollowSync(realRoot, inFolder(folder, candidate)).kind === 'missing') return candidate
  }
  return null
}

export type Inclusion = 'copy' | 'sync'
export type IntakeResult = { id: string; /** Workspace-relative path of the copy. */ path: string; item: ResourceItem }

const timestamp = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z')

/**
 * Bring `pick` into the Folio at `bundle` (its manifest must exist), inside a recorded step: the copy, the item in
 * the manifest, and for `sync` the grant. Throws to stop the step; every write is the step's (recorded), and a grant
 * written is pushed onto `grants` before anything after it can fail, so the caller's rollback can take it back.
 */
export async function intakeOutsideFile(ws: Workspace, realRoot: string, bundle: string, made: MadeFolder[], pick: OutsidePick, inclusion: Inclusion, grants: GrantWrite[], context: { store: SyncGrantStore | null; now?: () => Date; manifestExisted: boolean; /** Where the document is in this step (its new name when the step moved it). */ document: string }): Promise<IntakeResult> {
  if (!isGenuinePick(pick)) throw new Error('The file was not chosen in WriteFlex\'s file picker, so it was not brought in')
  const unauthorised = await pickStillAuthorised(ws, realRoot, pick)
  if (unauthorised !== null) throw new Error(unauthorised)
  // The destination is the document's Folio by the same resolver: where it is now (its own new folder, when the step
  // moved it), and the pick's folder when it has not moved.
  const destination = await documentFolio(realRoot, context.document)
  if (!destination.ok) throw new Error(destination.message)
  if (destination.folder !== bundle || (context.document === pick.documentPath && bundle !== pick.folder.path)) {
    throw new Error(`${bundle || 'The Workspace folder'} is not the Folio ${context.document} is in, the document ${pick.name} was chosen for, so nothing was written`)
  }
  if (inclusion !== 'copy' && inclusion !== 'sync') throw new Error('Choose Copy or Keep in sync')
  if (inclusion === 'sync' && context.store === null) throw new Error('WriteFlex cannot keep files in sync on this Mac, so the file was not brought in')
  // The copy is the original's bytes exactly (a byte-order mark included); the text is only the writer's carrier.
  const text = exactUtf8(pick.bytes)
  if (text === null) throw new Error(`${pick.name} is not UTF-8 text, so it was not brought in`)
  const manifestPath = inFolder(bundle, MANIFEST_NAME)
  const manifestRead = await readContainedFile(realRoot, manifestPath, 4 * 1024 * 1024)
  if (!manifestRead.ok) throw new Error(`${manifestPath} cannot be read, so ${pick.name} was not brought in`)
  const manifestText = manifestRead.bytes.toString('utf8')
  const taken = new Set((declaredResourceItems(manifestText) ?? []).map((item) => item.id).filter((id): id is string => typeof id === 'string'))

  // The copy: the guarded write, as a new file, into the very `resources/` folder checked (made by the step if new).
  const folder = inFolder(bundle, RESOURCES_DIR)
  const folderId = ensureFolder(realRoot, folder, made)
  const copyName = freeCopyName(realRoot, folder, pick.name)
  if (copyName === null) throw new Error(`There are too many files called ${pick.name} in ${folder}`)
  const path = inFolder(folder, copyName)
  await writeInWidgetFolder(ws, realRoot, folder, folderId, path, text, { exclusive: true })
  const written = await readContainedFile(realRoot, path, SOURCE_MAX_BYTES)
  if (!written.ok || !written.bytes.equals(pick.bytes)) throw new Error(`The copy of ${pick.name} is not byte for byte the file chosen, so it was not brought in`)

  const id = newResourceId(copyName, taken)
  const now = (context.now ?? (() => new Date()))()
  const capture = { sha256: createHash('sha256').update(pick.bytes).digest('hex'), bytes: pick.bytes.byteLength, media_type: pick.kind === 'json' ? 'application/json' : 'text/csv', captured_at: timestamp(now) }
  let grantId: string | undefined
  if (inclusion === 'sync') grantId = newGrantId()
  const item: ResourceItem = { id, path: `${RESOURCES_DIR}/${copyName}`, inclusion, ...(grantId ? { grant: grantId } : {}), capture }
  const next = addResourceItemText(manifestText, item)
  if (context.manifestExisted) await backupManifestDocument(ws, bundle, manifestText)
  await writeManifestOver(ws, realRoot, bundle, manifestText, next)

  // Last: the grant, bound to (the Folio folder's real path, the item id, the original's real path).
  if (grantId) {
    const folio = bundle === '' ? realRoot : join(realRoot, ...bundle.split('/'))
    const write = context.store!.add({ id: grantId, folio, resource: id, kind: 'file', origin: pick.origin, granted_at: timestamp(now) })
    grants.push(write)
  }
  return { id, path, item }
}

/** Take back the grants a step wrote (its rollback or its undo), newest first; never throws. */
export function undoGrantWrites(store: SyncGrantStore | null, grants: readonly GrantWrite[]): string[] {
  const failed: string[] = []
  for (const write of [...grants].reverse()) {
    try { store?.undoAdd(write) } catch (error) { failed.push(error instanceof Error ? error.message : String(error)) }
  }
  return failed
}

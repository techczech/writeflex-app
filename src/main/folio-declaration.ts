/** Read-only folder identity; all application callers use this answer. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readStoreFile } from './checked-store-write'
import { isHiddenFolderName } from './document-path'
import { indexNotePath, MANIFEST_NAME, FOLIO_BACKUP_NAME } from './folio'
import type { Workspace } from './workspace'
import { declaresRunningOrder } from '../shared/folio-declaration'

export type FolioDeclaration = { isFolio: boolean; repairNeeded: boolean; manifest: boolean; runningOrder: boolean }
type DeclarationWorkspace = Pick<Workspace, 'root' | 'absolute'>
const absent: FolioDeclaration = { isFolio: false, repairNeeded: false, manifest: false, runningOrder: false }
export const declarationPathKey = (path: string): string => path.normalize('NFC').toLocaleLowerCase()
export const SET_ASIDE_FILE = '.writeflex/folio-declarations-set-aside.json'
type SetAside = { folder: string; file: string }
const entryKey = (folder: string, file: string) => `${declarationPathKey(folder)}\u0000${declarationPathKey(file)}`
function storeNotice(ws: DeclarationWorkspace, error: unknown): void {
  const message = 'The Folio declaration store could not be read or updated. Its file was left untouched.'
  console.warn(message, error instanceof Error ? error.message : String(error))
  noticeContext.getStore()?.push(message)
  const writer = ws as Partial<Workspace>
  writer.announceWriteNotice?.(message)
}
const lastGoodEntries = new Map<string, SetAside[]>()
const unreadableStores = new Set<string>()
const coldStartNotices = new Map<string, Set<string>>()
function setAsideEntries(ws: DeclarationWorkspace): SetAside[] | null {
  try {
    const read = readStoreFile(ws.root, SET_ASIDE_FILE, { sync: true })
    if (read.state === 'refused') throw new Error(read.message)
    const entries = parseSetAside(read.state === 'present' ? read.bytes.toString('utf8') : null)
    lastGoodEntries.set(ws.root, entries)
    unreadableStores.delete(ws.root)
    coldStartNotices.delete(ws.root)
    return entries
  } catch (error) { unreadableStores.add(ws.root); storeNotice(ws, error); return lastGoodEntries.get(ws.root) ?? null }
}
export function declarationIsSetAside(ws: DeclarationWorkspace, dir: string, file = indexNotePath(ws, dir)): boolean {
  try {
    if (!declaresRunningOrder(readFileSync(ws.absolute(file), 'utf8'))) return false
    return (setAsideEntries(ws)?.some(entry => entryKey(entry.folder, entry.file) === entryKey(dir, file)) ?? false) || (declarationRetries.get(ws.root)?.has(entryKey(dir, file)) ?? false)
  } catch { return false }
}

function parseSetAside(content: string | null): SetAside[] {
  const entries: unknown = content === null ? [] : JSON.parse(content)
  if (!Array.isArray(entries) || entries.some(e => !e || typeof e.folder !== 'string' || typeof e.file !== 'string')) throw new Error('The Folio declaration store could not be read.')
  return entries.map(({ folder, file }) => ({ folder, file }))
}
function storeWriter(ws: DeclarationWorkspace): FolioWriteOptions['writeStore'] {
  const writer = ws as DeclarationWorkspace & Partial<Pick<Workspace, 'writeAppStoreFile'>>
  return writer.writeAppStoreFile ? (path, update) => writer.writeAppStoreFile!(path, update) : undefined
}
async function changeSetAside(ws: DeclarationWorkspace, dir: string, file: string, aside: boolean, write = storeWriter(ws)): Promise<boolean> {
  const current = setAsideEntries(ws)
  if (!aside && !unreadableStores.has(ws.root) && current !== null && !current.some(entry => entryKey(entry.folder, entry.file) === entryKey(dir, file))) return true
  if (!write) return false
  try { await write(SET_ASIDE_FILE, content => {
    const kept = parseSetAside(content).filter(entry => entryKey(entry.folder, entry.file) !== entryKey(dir, file))
    if (aside) kept.push({ folder: declarationPathKey(dir), file: declarationPathKey(file) })
    return JSON.stringify(kept, null, 2) + '\n'
  }); setAsideEntries(ws); return true } catch (error) { storeNotice(ws, error); return false }
}
/** Clear only after bytes that no longer declare have actually committed. */
export async function finishFolioWrite(ws: DeclarationWorkspace, path: string, content: string | Uint8Array, options: FolioWriteOptions = {}, afterCommit?: () => Promise<void>): Promise<void> {
  invalidateFolioDeclarations(ws.root, path)
  await afterCommit?.()
  const dir = parent(path)
  if (declarationPathKey(path) !== declarationPathKey(indexNotePath(ws, dir))) return
  const stillDeclares = declaresRunningOrder(typeof content === 'string' ? content : Buffer.from(content).toString('utf8'))
  if (!stillDeclares) declarationRetries.get(ws.root)?.delete(entryKey(dir, path))
  if (!stillDeclares) await changeSetAside(ws, dir, path, false, options.writeStore ?? storeWriter(ws))
}
/** Only explicit Make Folio clears a still-declaring note, after the normal guard. */
export async function activateFolioDeclaration(ws: Workspace, dir: string): Promise<void> {
  await ws.exclusiveAll(async () => {
    await assertNoRelatedFolio(ws, dir)
    if (!await changeSetAside(ws, dir, indexNotePath(ws, dir), false, (path, content) => ws.writeAppStoreFile(path, content))) {
      throw new Error('The Folio declaration could not be activated because its set-aside record could not be cleared. Repair the declaration store and try Make Folio again.')
    }
    declarationRetries.get(ws.root)?.delete(entryKey(dir, indexNotePath(ws, dir)))
  })
}

const parent = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''

// One declaration algorithm. The two runners below supply only sync or async filesystem I/O.
function* declaration(ws: DeclarationWorkspace, dir: string): Generator<{ kind: 'stat' | 'read'; path: string }, FolioDeclaration, any> {
  if (dir.startsWith('/') || dir.split('/').includes('..')) throw new Error('Choose a folder inside the workspace.')
  for (let path = dir; path; path = parent(path)) {
    if ((yield { kind: 'stat', path })?.isSymbolicLink()) return { ...absent }
  }
  const path = (name: string) => dir ? `${dir}/${name}` : name
  const manifest = Boolean(yield { kind: 'stat', path: path(MANIFEST_NAME) })
  let runningOrder = false
  try {
    const index = indexNotePath(ws, dir)
    if ((yield { kind: 'stat', path: index })?.isFile()) runningOrder = declaresRunningOrder(yield { kind: 'read', path: index })
  } catch (error) { if (!manifest) throw error }
  const repairNeeded = !manifest && runningOrder && Boolean(yield { kind: 'stat', path: path(FOLIO_BACKUP_NAME) }) && !(yield { kind: 'stat', path: path('.folio-turn-back.json') })
  return { isFolio: manifest || (runningOrder && !repairNeeded), repairNeeded, manifest, runningOrder }
}
/** Physical declarations remain write boundaries even when a conflicting reader declaration is ignored. */
export function folioDeclarationOnDisk(ws: DeclarationWorkspace, dir: string): FolioDeclaration {
  const rule = declaration(ws, dir)
  let step = rule.next()
  while (!step.done) {
    const { kind, path } = step.value
    try { step = rule.next(kind === 'stat' ? lstatSync(join(ws.root, path), { throwIfNoEntry: false }) : readFileSync(ws.absolute(path), 'utf8')) }
    catch (error) { step = rule.throw(error) }
  }
  return step.value
}
async function declarationAsync(ws: DeclarationWorkspace, dir: string): Promise<FolioDeclaration> {
  const rule = declaration(ws, dir)
  let step = rule.next()
  while (!step.done) {
    const { kind, path } = step.value
    try {
      const value = kind === 'read' ? await readFile(ws.absolute(path), 'utf8') : await lstat(join(ws.root, path)).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
      step = rule.next(value)
    } catch (error) { step = rule.throw(error) }
  }
  return step.value
}

// The Collection watcher and app writes invalidate the declaration map. While watched, repeated
// queries traverse only memory. Fingerprints keep standalone read-only callers fresh as well.
type CachedFolder = { fingerprint: string; children: string[]; physical: FolioDeclaration }
const declarationMaps = new Map<string, Map<string, CachedFolder>>()
const watchedCollections = new Map<string, number>()
export function watchFolioDeclarations(root: string): () => void {
  watchedCollections.set(root, (watchedCollections.get(root) ?? 0) + 1)
  invalidateFolioDeclarations(root)
  return () => {
    const remaining = (watchedCollections.get(root) ?? 1) - 1
    if (remaining) watchedCollections.set(root, remaining)
    else watchedCollections.delete(root)
    invalidateFolioDeclarations(root)
  }
}
/** Drop only the changed folder and parent listing; hidden Folio sidecars still affect identity. */
export function invalidateFolioDeclarations(root: string, path?: string): void {
  if (path === undefined) { declarationMaps.delete(root); return }
  if (path.split('/').includes('.writeflex')) return
  const cache = declarationMaps.get(root)
  if (!cache) return
  const changed = declarationPathKey(path)
  const folder = declarationPathKey(parent(path))
  for (const key of cache.keys()) {
    const normalised = declarationPathKey(key)
    if (normalised === folder || normalised === changed || normalised.startsWith(changed + '/')) cache.delete(key)
  }
}
/** Drop declaration caches on close/rebind; recovery and last-good reads live for the process. */
export function clearFolioDeclarations(root: string): void {
  declarationMaps.delete(root)
}

function cachedFolder(ws: DeclarationWorkspace, dir: string, fresh = false): CachedFolder {
  let cache = declarationMaps.get(ws.root)
  if (!cache) { cache = new Map(); declarationMaps.set(ws.root, cache) }
  const previous = cache.get(dir)
  if (previous && !fresh && watchedCollections.has(ws.root)) return previous
  const paths = [dir, indexNotePath(ws, dir), dir ? `${dir}/${MANIFEST_NAME}` : MANIFEST_NAME,
    dir ? `${dir}/${FOLIO_BACKUP_NAME}` : FOLIO_BACKUP_NAME, dir ? `${dir}/.folio-turn-back.json` : '.folio-turn-back.json']
  const fingerprint = paths.map(path => {
    const stat = lstatSync(join(ws.root, path), { throwIfNoEntry: false, bigint: true })
    return stat ? `${stat.ino}/${stat.mode}/${stat.mtimeNs}/${stat.ctimeNs}/${stat.size}` : '-'
  }).join('|')
  if (previous?.fingerprint === fingerprint) return previous
  const physical = folioDeclarationOnDisk(ws, dir)
  const children = (lstatSync(join(ws.root, dir), { throwIfNoEntry: false })?.isDirectory()
    ? readdirSync(join(ws.root, dir), { withFileTypes: true }) : [])
    .filter(entry => entry.isDirectory() && !isHiddenFolderName(entry.name))
    .map(entry => dir ? `${dir}/${entry.name}` : entry.name)
  const folder = { fingerprint, children, physical }
  cache.set(dir, folder)
  return folder
}
function* descendantFolders(ws: DeclarationWorkspace, dir: string, fresh = false): Generator<string> {
  let children: string[]
  try { children = cachedFolder(ws, dir, fresh).children } catch { return }
  for (const child of children) {
    yield child
    yield* descendantFolders(ws, child, fresh)
  }
}
/** Related declarations use one precedence rule for readers and the write guard. */
export function folioDeclaration(ws: DeclarationWorkspace, dir: string): FolioDeclaration {
  return resolveDeclaration(ws, dir)
}
function resolveDeclaration(ws: DeclarationWorkspace, dir: string, withoutIndexIn?: string, fresh = false): FolioDeclaration {
  const physicalAt = (folder: string) => {
    const physical = cachedFolder(ws, folder, fresh).physical
    return folder === withoutIndexIn ? { ...physical, runningOrder: false, isFolio: physical.manifest } : physical
  }
  const own = physicalAt(dir)
  if (!own.isFolio) return own
  const records = setAsideEntries(ws)
  const recorded = (folder: string, physical: FolioDeclaration): boolean => {
    const key = entryKey(folder, indexNotePath(ws, folder))
    const persisted = records?.some(entry => entryKey(entry.folder, entry.file) === key) ?? false
    return physical.runningOrder && (persisted || (declarationRetries.get(ws.root)?.has(key) ?? false))
  }
  const losesTo = (other: string): boolean => {
    const declaration = physicalAt(other)
    if (!declaration.isFolio) return false
    if (own.manifest !== declaration.manifest) return declaration.manifest
    if (recorded(dir, own) !== recorded(other, declaration)) return recorded(dir, own)
    const otherIsOuter = dir.startsWith(other + '/') || other === ''
    if (records === null) {
      const pair = [dir || 'the workspace root', other || 'the workspace root'].sort().join(' and ')
      const message = `The Folio declaration store is unreadable and no session history is available for ${pair}. The precedence default is in use; repair the store, then use Turn back and Make Folio to choose the Folio.`
      noticeContext.getStore()?.push(message)
      if (!coldStartNotices.get(ws.root)?.has(pair)) {
        if (!coldStartNotices.has(ws.root)) coldStartNotices.set(ws.root, new Set())
        coldStartNotices.get(ws.root)!.add(pair)
        const writer = ws as Partial<Workspace>
        writer.announceWriteNotice?.(message)
      }
    }
    // Cold start with unreadable history retains the table's outer default.
    return own.manifest || records === null ? otherIsOuter : !otherIsOuter
  }
  for (let cursor = dir; cursor !== '';) {
    cursor = parent(cursor)
    try { if (losesTo(cursor)) return { ...own, isFolio: false } } catch { /* unreadable ancestor */ }
  }
  for (const child of descendantFolders(ws, dir, fresh)) {
    try { if (losesTo(child)) return { ...own, isFolio: false } } catch { /* unreadable descendant */ }
  }
  if (!own.manifest && recorded(dir, own)) return { ...own, isFolio: false }
  return own
}

const noticeContext = new AsyncLocalStorage<string[]>()
export async function withFolioNotices<T>(work: () => Promise<T>): Promise<{ result: T; notices: string[] }> {
  const notices: string[] = []
  const result = await noticeContext.run(notices, work)
  const unique = [...new Set(notices)]
  noticeContext.getStore()?.push(...unique)
  return { result, notices: unique }
}
class RelatedFolio extends Error {
  constructor(readonly existing: string) { super(relatedFolioMessage(existing)) }
}
export type FolioWriteOptions = {
  notice?: (message: string) => void
  writeStore?: (path: string, update: (previous: string | null) => string) => Promise<void>
}
/** Main-process editor authority; never accepted from serialised caller options. */
export class EditorFolioAuthority {
  #editor = true
  constructor(readonly notice: (message: string) => void, readonly writeStore: NonNullable<FolioWriteOptions['writeStore']>) {}
}
const isEditorFolioAuthority = (options: FolioWriteOptions) => options instanceof EditorFolioAuthority

// Explicit recovery queue for failed persistence, independent of write options. Only the running
// process knows which child was newly typed; a cold start cannot reconstruct a record never saved.
const declarationRetries = new Map<string, Map<string, { ws: DeclarationWorkspace; dir: string; file: string }>>()
export async function retryFolioDeclarations(root: string): Promise<void> {
  for (const [key, retry] of declarationRetries.get(root) ?? []) {
    try {
      if (!folioDeclarationOnDisk(retry.ws, retry.dir).runningOrder) { declarationRetries.get(root)?.delete(key); continue }
      if (await changeSetAside(retry.ws, retry.dir, retry.file, true)) declarationRetries.get(root)?.delete(key)
    } catch (error) { storeNotice(retry.ws, error) }
  }
  if (declarationRetries.get(root)?.size === 0) declarationRetries.delete(root)
}

function persistenceNotice(child: string, outer: string): string {
  return `The running order in ${child || 'the workspace root'} could not be set aside. ${outer || 'The workspace root'} may stop being the Folio after reopening. To keep it, remove the running-order heading in ${child || 'the workspace root'}, or Turn back one of the Folios. WriteFlex will retry at the next save and when the Collection is claimed again.`
}
/** Inside the collection write turn: Workspace atomic saves/creates/duplicates/images/rescues,
 * guarded document saves (CLI and accepted Changes), file renames/moves, folder renames/moves,
 * and organise move-folder's Index Note rename. Plans, proposals, widgets, version restore,
 * Make/Turn back/Undo use those writers. Deliberate exceptions: bin put-back of prior bytes,
 * user-chosen export, new example-collection files, app data/journals and gated e2e fixture hooks.
 * Only saveEditorText can construct the private Workspace editor authority. */
export async function guardFolioWrite(ws: DeclarationWorkspace, path: string, content: string | Uint8Array | (() => Promise<string | Uint8Array>), options: FolioWriteOptions = {}): Promise<(() => Promise<void>) | undefined> {
  await retryFolioDeclarations(ws.root)
  const dir = parent(path)
  const key = declarationPathKey(path)
  const index = indexNotePath(ws, dir)
  const isIndex = key === declarationPathKey(index)
  if (key !== declarationPathKey(dir ? `${dir}/${MANIFEST_NAME}` : MANIFEST_NAME) && !isIndex) return
  const next = typeof content === 'function' ? await content() : content
  if (isIndex && !declaresRunningOrder(typeof next === 'string' ? next : Buffer.from(next).toString('utf8'))) {
    // Non-editor removals share the Trash/move rule; editor saves remain unrestricted.
    if (!isEditorFolioAuthority(options)) guardFolioRemoval(ws, path)
    return
  }
  if (!isIndex) {
    const physical = await declarationAsync(ws, dir)
    // Rewriting any existing manifest, including a legacy loser, adds no declaration.
    if (physical.manifest) return
    await assertNoRelatedFolio(ws, dir)
    return
  }
  const own = await declarationAsync(ws, dir)
  // Existing text edits keep their decision; a new manifest never takes this shortcut.
  if (own.runningOrder && !isEditorFolioAuthority(options)) return
  try { if (resolveDeclaration(ws, dir, undefined, true).isFolio && (own.runningOrder || isEditorFolioAuthority(options))) return }
  catch (error) { if (!isEditorFolioAuthority(options)) throw error; options.notice?.(skippedFolioMessage(dir)) }
  try { await assertNoRelatedFolio(ws, dir, options.notice, isEditorFolioAuthority(options)) }
  catch (error) {
    if (!isEditorFolioAuthority(options) || !(error instanceof RelatedFolio)) throw error
    if (!own.runningOrder) {
      const persist = async () => {
        if (await changeSetAside(ws, dir, path, true, options.writeStore ?? storeWriter(ws))) {
          declarationRetries.get(ws.root)?.delete(entryKey(dir, path))
          return true
        } else {
          if (!declarationRetries.has(ws.root)) declarationRetries.set(ws.root, new Map())
          declarationRetries.get(ws.root)!.set(entryKey(dir, path), { ws, dir, file: path })
          options.notice?.(persistenceNotice(dir, error.existing))
          return false
        }
      }
      return async () => {
        const persisted = await persist()
        if (persisted) options.notice?.(setAsideNotice(error.existing))
        else await persist()
      }
    }
    options.notice?.(setAsideNotice(error.existing))
  }
}

/** Check the destination tree before any folder bytes change place. Includes declarations that
 * become active because a rename gives an existing note its conventional Index Note name. */
export async function guardFolioFolderMove(ws: DeclarationWorkspace, from: string, to: string, renameIndex = false): Promise<void> {
  if (declarationPathKey(from) === declarationPathKey(to)) return
  const mapped = { root: ws.root, absolute: (path: string) => ws.absolute(path) }
  const carriesDeclarationAt = async (source: string, destination: string): Promise<boolean> => {
    const index = indexNotePath(ws, destination).split('/').at(-1)!
    const sourceIndex = renameIndex && source === from ? indexNotePath(ws, source) : `${source}/${index}`
    if (declarationIsSetAside(ws, source, sourceIndex)) return false
    if ((await declarationAsync(ws, source)).manifest) return true
    try {
      if (!(await lstat(ws.absolute(sourceIndex))).isFile()) return false
      return declaresRunningOrder(await readFile(ws.absolute(sourceIndex), 'utf8'))
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }
  const declarations: { source: string; destination: string; alreadyDeclared: boolean }[] = []
  const visit = async (source: string, destination: string): Promise<void> => {
    if ((await lstat(ws.absolute(source))).isSymbolicLink()) return
    if (await carriesDeclarationAt(source, destination)) declarations.push({ source, destination, alreadyDeclared: folioDeclarationOnDisk(ws, source).isFolio })
    for (const entry of await readdir(ws.absolute(source), { withFileTypes: true })) {
      if (entry.isDirectory() && !isHiddenFolderName(entry.name)) await visit(`${source}/${entry.name}`, `${destination}/${entry.name}`)
    }
  }
  const changesIndexName = !renameIndex && declarationPathKey(indexNotePath(ws, from).split('/').at(-1)!) !== declarationPathKey(indexNotePath(ws, to).split('/').at(-1)!)
  if (changesIndexName) guardFolioRemoval(ws, indexNotePath(ws, from))
  await visit(from, to)
  if (!declarations.length) return
  // Only ancestors outside the moved subtree can conflict with any carried declaration.
  for (let cursor = parent(to); ; cursor = parent(cursor)) {
    const ancestorMovesWithSource = declarationPathKey(cursor) === declarationPathKey(from) || declarationPathKey(cursor).startsWith(declarationPathKey(from) + '/')
    const keepsLegacyOverlap = declarations.every(entry => entry.alreadyDeclared) && (declarationPathKey(from).startsWith(declarationPathKey(cursor) + '/') || cursor === '')
    if (!ancestorMovesWithSource && resolveDeclaration(mapped, cursor, undefined, true).isFolio && !keepsLegacyOverlap) throw new RelatedFolio(cursor)
    if (!cursor) break
  }
  for (const entry of declarations) {
    const enclosing = declarations.find(other => entry !== other && entry.destination.startsWith(other.destination + '/'))
    if (enclosing && (!entry.alreadyDeclared || !enclosing.alreadyDeclared)) throw new RelatedFolio(entry.alreadyDeclared ? entry.source : enclosing.source)
  }
}

/** Moves carry path decisions. Trash retains them so Put Back restores the same declaration. */
export async function finishFolioMove(ws: DeclarationWorkspace, from: string, to?: string): Promise<void> {
  invalidateFolioDeclarations(ws.root, from)
  if (to !== undefined) invalidateFolioDeclarations(ws.root, to)
  if (to === undefined) return
  const source = declarationPathKey(from)
  const entries = setAsideEntries(ws) ?? []
  if (!entries.some(entry => entry.file === source || entry.file.startsWith(source + '/'))) return
  const write = storeWriter(ws)
  if (!write) return
  try { await write(SET_ASIDE_FILE, content => {
    const moved = parseSetAside(content).flatMap(entry => {
      if (entry.file !== source && !entry.file.startsWith(source + '/')) return [entry]
      const file = declarationPathKey(to) + entry.file.slice(source.length)
      const folder = parent(file)
      return [{ ...entry, folder, file }]
    })
    return JSON.stringify(moved, null, 2) + '\n'
  }) } catch (error) { storeNotice(ws, error) }
}

/** A shared destination rule for sidebar and guarded file moves. */
export function carriesSetAsideIndex(ws: DeclarationWorkspace, from: string, to: string): boolean {
  return declarationPathKey(to) === declarationPathKey(indexNotePath(ws, parent(to))) && declarationIsSetAside(ws, parent(from), from)
}

/** Refuse only a removal that promotes a losing manifest over the established Folio. */
export function guardFolioRemoval(ws: DeclarationWorkspace, path: string): void {
  const dir = parent(path)
  if (declarationPathKey(path) !== declarationPathKey(indexNotePath(ws, dir))) return
  const own = folioDeclarationOnDisk(ws, dir)
  if (!own.manifest || !own.runningOrder || resolveDeclaration(ws, dir, undefined, true).isFolio) return
  if (!resolveDeclaration(ws, dir, dir, true).isFolio) return
  // Report the Folio readers actually use, rather than any physical loser.
  for (let cursor = dir; cursor !== '';) {
    cursor = parent(cursor)
    if (resolveDeclaration(ws, cursor, undefined, true).isFolio) throw new RelatedFolio(cursor)
  }
  for (const child of descendantFolders(ws, dir, true)) {
    if (resolveDeclaration(ws, child, undefined, true).isFolio) throw new RelatedFolio(child)
  }
}
const setAsideNotice = (existing: string) => `This note's running order is set aside: ${existing || 'the workspace root'} is already the Folio here. Turn that Folio back first, then use Make Folio here to use this one.`

const skippedFolioMessage = (folder: string) => `Skipped ${folder || 'the workspace root'} while checking for Folios because the folder or its Index Note could not be read.`

/** The same refusal for every route that can declare a Folio. */
export const relatedFolioMessage = (existing: string): string =>
  `The Folio in ${existing || 'the workspace root'} already occupies this folder tree. Folios cannot contain another Folio.`

/** One paper per folder tree. Yield to the main process between filesystem reads. */
export async function assertNoRelatedFolio(
  ws: Pick<Workspace, 'root' | 'absolute'>,
  dir: string,
  reportSkipped?: (message: string) => void,
  skipUnreadableAncestors = false,
): Promise<void> {
  // Validate once; use async filesystem operations for the walk itself. Never follow links.
  if (dir) ws.absolute(dir)
  const at = (path: string) => join(ws.root, path)
  const declares = async (folder: string): Promise<boolean> => {
    const physical = await declarationAsync(ws, folder)
    // An ignored outside manifest remains a physical boundary for new manifest/Make writes.
    return resolveDeclaration(ws, folder, undefined, true).isFolio || physical.manifest
  }
  const refuse = (existing: string): never => {
    for (let cursor = existing; ; cursor = parent(cursor)) {
      if (cursor !== dir && resolveDeclaration(ws, cursor, undefined, true).isFolio) throw new RelatedFolio(cursor)
      if (!cursor) break
    }
    throw new RelatedFolio(existing)
  }
  const skipped = (folder: string) => {
    const message = skippedFolioMessage(folder)
    noticeContext.getStore()?.push(message)
    if (reportSkipped) reportSkipped(message)
    else if (!noticeContext.getStore()) console.warn(message)
  }
  let ancestor = dir
  while (ancestor !== '') {
    ancestor = parent(ancestor)
    let declared = false
    try { declared = await declares(ancestor) }
    catch (error) { if (!skipUnreadableAncestors) throw error; skipped(ancestor) }
    if (declared) refuse(ancestor)
  }
  const visit = async (folder: string): Promise<string | null> => {
    let entries
    try { entries = await readdir(at(folder), { withFileTypes: true }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') skipped(folder)
      return null
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || isHiddenFolderName(entry.name)) continue
      const child = folder ? `${folder}/${entry.name}` : entry.name
      try { if (await declares(child)) return child }
      catch { skipped(child); continue }
      const found = await visit(child)
      if (found !== null) return found
    }
    return null
  }
  const found = await visit(dir)
  if (found !== null) refuse(found)
}

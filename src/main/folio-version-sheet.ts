/**
 * What the Save Folio version sheet shows before anything is written (Folio versions ticket 04):
 * which files a Folio version would hold and in what role, the version each inserted file would use,
 * what the writer's go-ahead would settle, what an agent's waiting changes leave out, what is never
 * copied, and which earlier Folio versions a backup leaves out. READ ONLY: it writes nothing and takes
 * no lock, so the sheet can be opened and cancelled freely ("Escape and Cancel write nothing").
 *
 * It asks the same questions the save asks, by the same code (`gatherFolio`, `changesAVersionWouldSettle`,
 * the snapshot hash), so the sheet cannot promise a version the save would not make. The numbers are a
 * preview: the save decides again, under the Folio's lock.
 *
 * Electron-free.
 */
import { readdir } from 'node:fs/promises'
import { posix } from 'node:path'
import { listFolioVersions, type FolioBackupState } from './folio-version-listing'
import { FolioGatherRefused, gatherFolio, type FolioFileRole, type GatheredFolio } from './folio-version-members'
import { FOLIO_INSERTED_FILE_CAP_BYTES, previewFolio, type FolioPreview, type InsertedHandling } from './folio-version-preview'
import type { ChangeStore } from './changes'
import type { FolioVersionStore } from './folio-versions'
import type { AuthorIdentity, VersionStore } from './versions'
import type { Workspace } from './workspace'

/** Counted folders stop at this many files: a number, not a walk of a huge tree. */
const COUNT_CAP = 20_000

export type FolioSheetInserted = {
  path: string
  /** The file name without its folder, for the list. */
  name: string
  kind: 'table' | 'image' | 'widget' | 'file'
  /** The per-file version this save would use: an existing one holding these bytes, or none (a new one is made with the Folio version). Always null for a file too large to keep. */
  version: { number: number; name: string } | null
  /** `too-large`: over the cap the save itself uses, so the version notes the file (its sha256) and keeps no copy. */
  handling: InsertedHandling
  bytes: number
  /** The sha256 of the bytes as they stand (null when too large to keep): the sheet's change report compares it. */
  hash: string | null
}

export type FolioSheetWaiting = {
  path: string
  role: Extract<FolioFileRole, 'index' | 'part' | 'unlisted'>
  /** The part's title and its place in the running order, for naming it in words. */
  title?: string
  order?: number
  /** The writer's own waiting changes: the go-ahead accepts these into the text first. */
  own: number
  /** An agent's pending proposals and held pairs: left pending, and left out of the saved text. */
  agent: number
}

/** Everything on the sheet that the "Not in the outline" tick box changes: the files those files insert, their waiting changes, what `data/` leaves out. */
export type FolioSheetChoice = {
  inserted: FolioSheetInserted[]
  /** Files only linked: listed, not kept. */
  linked: string[]
  waiting: FolioSheetWaiting[]
  /** Files in each folder a Folio version never copies; `data` is the files the text does not insert. */
  leftOut: { research: number; data: number; offcuts: number; archive: number; bin: number }
  /** What the go-ahead sends back; the save compares it under the Folio's lock and writes nothing if the Folio has moved on. */
  fingerprint: string
}

export type FolioSheetFacts = FolioSheetChoice & {
  dir: string
  indexPath: string
  /** The inserted-file size cap the save uses (bytes), for the words "over 25 MB". */
  insertedCapBytes: number
  /** The same facts as they would be with the "Not in the outline" box unticked; null when no file is outside the outline (nothing to untick). The top-level fields are the ticked state. */
  withoutUnlisted: FolioSheetChoice | null
  /** In running order: the parts that have a file. */
  parts: number
  /** The parts that have a file, in running order: the ⇧⌘S choice names the open one. */
  partList: Array<{ path: string; title: string; order: number }>
  /** In the running order with no file yet. */
  planned: number
  /** Words in the Index Note and the parts (the Folio room's header counts the parts only: `indexWords` is the difference). */
  words: number
  /** Of `words`, those in the Index Note. */
  indexWords: number
  unlisted: Array<{ path: string; title?: string }>
  /** Earlier Folio versions of this Folio that a backup leaves out, each with its plain reason; or why that could not be checked. */
  backup: FolioBackupState
  /** How many Folio versions this Folio already has. */
  versionCount: number
  author: string
  /** Why the sheet cannot be filled (not a Folio, no Index Note, ambiguous links): the words for the person. Every other field is empty then. */
  refused?: string
}

/** What the save answers, in place of a saved version, when the Folio is no longer what the sheet showed: nothing was written; these are the facts to show now. */
export type FolioSaveChangedAnswer = { changed: true; facts: FolioSheetFacts }

export type FolioSheetStores = {
  workspace: Workspace
  versions: Pick<VersionStore, 'list'>
  changes: Pick<ChangeStore, 'list'>
  folioVersions: Pick<FolioVersionStore, 'list'>
  snapshotHash: (snapshotId: string) => Promise<string | null>
  readBytes: (path: string) => Promise<Buffer>
  author: AuthorIdentity
  /** Default `FOLIO_INSERTED_FILE_CAP_BYTES`: the cap the save uses. */
  insertedFileCap?: number
}

const TABLE = /\.(csv|tsv)$/i
const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif)$/i
const WIDGET = /\.html?$/i
const kindOf = (path: string): FolioSheetInserted['kind'] => (TABLE.test(path) ? 'table' : IMAGE.test(path) ? 'image' : WIDGET.test(path) ? 'widget' : 'file')

/** Regular files below `absolute` (not following links, not looking into hidden folders), up to the cap. */
async function countFiles(absolute: string, skip: ReadonlySet<string>, relativeTo: string): Promise<number> {
  let count = 0
  const walk = async (folder: string, relative: string): Promise<void> => {
    let entries
    try { entries = await readdir(folder, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (count >= COUNT_CAP) return
      if (entry.name.startsWith('.')) continue
      const child = posix.join(relative, entry.name)
      if (entry.isDirectory()) await walk(`${folder}/${entry.name}`, child)
      else if (entry.isFile() && !skip.has(child)) count += 1
    }
  }
  await walk(absolute, relativeTo)
  return count
}

const EMPTY: Omit<FolioSheetFacts, 'dir' | 'indexPath' | 'author' | 'refused'> = {
  parts: 0, partList: [], planned: 0, words: 0, indexWords: 0, unlisted: [], inserted: [], linked: [], waiting: [],
  leftOut: { research: 0, data: 0, offcuts: 0, archive: 0, bin: 0 }, fingerprint: '', insertedCapBytes: FOLIO_INSERTED_FILE_CAP_BYTES, withoutUnlisted: null,
  backup: { state: 'ok', leftOut: [] }, versionCount: 0,
}

/** What depends on the tick box, from one gather and the preview of it. The inserted-file rules are the save's own (`previewFolio`). */
async function choiceOf(stores: FolioSheetStores, dir: string, preview: FolioPreview): Promise<FolioSheetChoice> {
  const { workspace } = stores
  const inserted: FolioSheetInserted[] = []
  const waiting: FolioSheetWaiting[] = []
  const linked: string[] = []
  for (const entry of preview.entries) {
    if (entry.kind === 'linked') linked.push(entry.path)
    else if (entry.kind === 'inserted') {
      if (!entry.present) continue
      inserted.push({
        path: entry.path, name: posix.basename(entry.path), kind: kindOf(entry.path),
        version: entry.version ? { number: entry.version.number, name: entry.version.name } : null,
        handling: entry.handling, bytes: entry.bytes, hash: entry.hash,
      })
    } else if (entry.ownIds.length + entry.agentIds.length > 0) {
      waiting.push({
        path: entry.path, role: entry.role, ...(entry.title !== undefined ? { title: entry.title } : {}), ...(entry.order !== undefined ? { order: entry.order } : {}),
        own: entry.ownIds.length, agent: entry.agentIds.length,
      })
    }
  }
  // Inserted files are kept (or noted) and only-linked files are listed: neither is "data the text does not insert".
  const insertedPaths = new Set([...inserted.map((entry) => entry.path), ...linked])
  const below = (name: string): string => (dir === '' ? name : posix.join(dir, name))
  const count = async (folder: string): Promise<number> => countFiles(workspace.absolute(below(folder)), insertedPaths, below(folder))
  const leftOut = {
    research: await count('research'), data: await count('data'), offcuts: await count('offcuts'), archive: await count('archive'),
    // The bin is hidden: counted from inside it, where the binned files are not hidden (its own index is).
    bin: await count('.folio-bin'),
  }
  return { inserted, linked, waiting, leftOut, fingerprint: preview.fingerprint }
}

/** What the sheet for the Folio at `dir` shows. Never throws for a Folio that cannot be saved: it answers `refused` in words. */
export async function folioSaveSheetFacts(stores: FolioSheetStores, dir: string): Promise<FolioSheetFacts> {
  const { workspace } = stores
  const cap = stores.insertedFileCap ?? FOLIO_INSERTED_FILE_CAP_BYTES
  let gathered: GatheredFolio
  try { gathered = await gatherFolio(workspace, dir) } catch (error) {
    if (error instanceof FolioGatherRefused) return { ...EMPTY, dir, indexPath: '', author: stores.author.name, refused: error.message }
    throw error
  }
  const preview = await previewFolio(stores, gathered, cap)
  const unlisted: FolioSheetFacts['unlisted'] = []
  const partList: FolioSheetFacts['partList'] = []
  let words = 0
  let indexWords = 0
  let parts = 0
  for (const entry of preview.entries) {
    if (entry.kind !== 'text') continue
    if (entry.role === 'part') { parts += 1; partList.push({ path: entry.path, title: entry.title ?? entry.path, order: entry.order ?? parts }) }
    if (entry.role === 'unlisted') unlisted.push({ path: entry.path, ...(entry.title !== undefined ? { title: entry.title } : {}) })
    if (entry.role === 'index') indexWords += entry.words ?? 0
    if (entry.role === 'index' || entry.role === 'part') words += entry.words ?? 0
  }
  const choice = await choiceOf(stores, dir, preview)
  // The same Folio as it would be saved with the box unticked: its own gather, its own preview and counts.
  let withoutUnlisted: FolioSheetChoice | null = null
  if (unlisted.length > 0) {
    const without = await gatherFolio(workspace, dir, { includeUnlisted: false })
    withoutUnlisted = await choiceOf(stores, dir, await previewFolio(stores, without, cap))
  }
  const listing = await listFolioVersions(workspace, stores.folioVersions, dir).catch(() => null)
  return {
    ...choice,
    dir, indexPath: gathered.indexPath, insertedCapBytes: cap, withoutUnlisted, parts, partList, planned: gathered.notWritten.length, words, indexWords, unlisted,
    backup: listing?.backup ?? { state: 'unavailable', reason: 'The backup could not be checked just now.' },
    versionCount: listing?.versions.length ?? 0,
    author: stores.author.name,
  }
}

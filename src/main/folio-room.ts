import { declaresSectionPage } from '../shared/folio-sections'
import { inheritWorkspaceFacts } from './file-facts'
import { folioDeclaration } from './folio-declaration'
import { outlineHeadings } from './folio-outline'
import { partTitle } from '../shared/folio-part-title'
import { readEvidence } from './folio-evidence'
import { createHash } from 'node:crypto'
import { findFlags, type Flag } from '../shared/markdown/flags'
/**
 * The Folio room's read (ADR-0048, spec § 4.6, § 7, § 11, § 12): the running order as parts with their synopsis, label,
 * priority, status and words, the binder's Research, Notes and Ideas groups, and the counts under the title. READ ONLY
 * (I-4, I-7): it asks the Plan (`readFolioPlan`, which writes nothing, and reads a manifest with no Index Note as its
 * first Index Note would), reads each part file once, and walks the Folio's own folders. Nothing is created, staged or
 * checkpointed, so an existing Folio opens as a room with no migration.
 *
 * Room UI state is not here: it lives in app state per Folio key (folio-room-state.ts, I-8).
 */

import { folioFiles as filesBeneath } from './folio-files'
import { readFolioBin } from './folio-bin'
import { readMap } from './folio-map'
import { posix } from 'node:path'
import { documentWordCount } from './collection'
import { folioKey } from './folio-dir'
import { indexNotePath } from './folio'
import { documentTitle, parseFrontmatter } from './frontmatter'
import { declaresRunningOrder, readFolioPlan, type PlanPart } from './plan'
import { isScrapsPath, scrapsInContent } from './scraps'
import type { Workspace } from './workspace'
import { UNSORTED_STATUS } from '../shared/collection-status'
import {
  labelOfTags, ordinaryTags, priorityOfTags, readLabelVocabulary, roomMeta, titleClashes,
  type FolioRoomModel, type RoomBinder, type RoomBinderItem, type RoomPart,
} from '../shared/folio-room'

/** Folder names the binder reads, anywhere inside the Folio (spec § 4.6). */
const RESEARCH_FOLDERS = new Set(['research', 'source'])
const NOTES_FOLDERS = new Set(['feedback', 'notes'])
/** The walk's bounds: a Folio's own support folders are small; a runaway tree never stalls the room. */
/** Part files read at once. */
const READ_BATCH = 16

/** The state key a Folio's room state is kept under: its root and one spelling (`folioKey`), as one string. */
export function roomStateKey(ws: Pick<Workspace, 'root'>, dir: string): string {
  const key = folioKey(ws.root, dir)
  return `${key.root}\u0000${key.dir}`
}

async function factsOf(ws: Workspace, path: string): Promise<{ content: string; status: string; words: number; flags: Array<Flag & { path: string; fingerprint: string }> } | null> {
  try {
    const { content } = await ws.readFile(path)
    const status = parseFrontmatter(content)?.status?.trim()
    return { content, status: status || UNSORTED_STATUS, words: documentWordCount(content), flags: findFlags(content).map(flag => ({ ...flag, path, fingerprint: createHash('sha256').update(content).digest('hex') })) }
  } catch {
    return null
  }
}

async function readAll<T>(items: readonly T[], read: (item: T) => Promise<unknown>): Promise<void> {
  for (let at = 0; at < items.length; at += READ_BATCH) await Promise.all(items.slice(at, at + READ_BATCH).map(read))
}

/** The segments of `path` below the Folio's folder. */
function below(dir: string, path: string): string[] {
  return (dir === '' ? path : path.slice(dir.length + 1)).split('/')
}

/** Research, Notes and Ideas (spec § 4.6): computed from the Folio's folders, never stored. Zotero items and orphan sections join in later tickets. */
export async function folioBinder(ws: Workspace, dir: string, walked?: readonly string[]): Promise<RoomBinder> {
  const files = [...(walked ?? await filesBeneath(ws, dir))].sort((a, b) => a.localeCompare(b))
  const item = (path: string): RoomBinderItem => ({ path, name: posix.basename(path), kind: 'file' })
  const folders = (path: string): string[] => below(dir, path).slice(0, -1)
  const research = files.filter((path) => folders(path).some((folder) => RESEARCH_FOLDERS.has(folder))).map(item)
  const notes = files.filter((path) => folders(path).some((folder) => NOTES_FOLDERS.has(folder))).map(item)
  const ideas: RoomBinderItem[] = []
  for (const path of files.filter(isScrapsPath)) {
    let scraps: number | undefined
    try { scraps = scrapsInContent((await ws.readFile(path)).content).length } catch { scraps = undefined }
    ideas.push({ path, name: posix.basename(path), kind: 'scrap-file', ...(scraps === undefined ? {} : { scraps }) })
  }
  return { research, notes, ideas }
}

/** The Folio's title from its Index Note (frontmatter title, else its heading); '' when it has neither. */
export function indexNoteTitle(indexSource: string | null, name: string): string {
  if (indexSource === null) return ''
  return parseFrontmatter(indexSource)?.title?.trim() || (/^#{1,6}\s/m.test(indexSource.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')) ? documentTitle(indexSource, name) : '')
}

/**
 * The room of the Folio at `dir`, or null when no Folio is there (no Index Note path and no manifest: the Folio
 * page's "Start a Folio outline" case, `readFolioPlan`).
 */
export async function readFolioRoom(workspace: Workspace, dir: string, essential = false): Promise<FolioRoomModel | null> {
  let listing: ReturnType<Workspace['listFiles']> | undefined
  const ws = new Proxy(workspace, { get(target, key) {
    if (key === 'listFiles') return () => listing ??= target.listFiles()
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  inheritWorkspaceFacts(ws, workspace)
  if (!folioDeclaration(ws, dir).isFolio) return null
  const plan = await readFolioPlan(ws, dir)
  if (!plan) return null
  const leftOut = plan.leftOut ?? []
  let indexSource: string | null = null
  try { indexSource = (await ws.readFile(indexNotePath(ws, dir))).content } catch { indexSource = null }
  const { labels, duplicates } = readLabelVocabulary(indexSource)

  const facts = new Map<string, Awaited<ReturnType<typeof factsOf>>>()
  const frontFiles = plan.unlisted.filter((part) => (part.titlePage || part.manifestTitlePage) && part.path !== null)
  const paths = [...plan.parts, ...frontFiles].flatMap((part) => (part.path ? [part.path] : []))
  await readAll([...new Set(paths)], async (path) => { facts.set(path, await factsOf(ws, path)) })

  const clashes = titleClashes(plan.parts.map((part) => part.path ?? part.title))
  const parts: RoomPart[] = plan.parts.map((part: PlanPart, index) => {
    const read = part.path ? facts.get(part.path) ?? null : null
    const written = part.path !== null && read !== null
    return {
      key: { title: part.title, path: part.path },
      card: { title: part.title, path: part.path, gloss: part.gloss, role: part.role, tags: [...part.tags] },
      index,
      ...(part.resolution ? { resolution: part.resolution } : {}),
      title: part.title,
      synopsis: part.gloss,
      role: part.role,
      frontMatter: part.role === 'front-matter',
      tags: ordinaryTags(part.tags, labels),
      label: labelOfTags(part.tags, labels),
      priority: priorityOfTags(part.tags),
      // D-STA-2: an unwritten part is always idea; D-STA-1: a written part with no status is Unsorted.
      status: part.resolution === 'missing' ? (part.path ? 'Missing file' : 'Missing part') : part.resolution === 'ambiguous' ? 'Ambiguous link' : written ? read.status : 'idea',
      written,
      words: written ? read.words : 0,
      titleClash: clashes.get(index) ?? null,
      flags: read?.flags ?? [],
      ...(read && part.path ? { outline: { ...(declaresSectionPage(read.content) ? { sectionPage: true as const } : {}), path: part.path, title: partTitle(read.content, part.path).title, heading: partTitle(read.content, part.path).mode, headings: outlineHeadings(read.content) } } : {}),
    }
  })
  const frontMatterFiles = frontFiles.map((part) => ({ path: part.path as string, title: part.title, words: facts.get(part.path as string)?.words ?? 0 }))

  const name = dir === '' ? posix.basename(ws.root) : posix.basename(dir)
  const indexTitle = indexNoteTitle(indexSource, name)
  // One walk of the Folio's own folders, shared by the evidence, the binder and the map (spec folio-workspace § 5).
  const walked = await filesBeneath(ws, dir)
  if (essential) return {
    dir, name, title: indexTitle || name, stateKey: roomStateKey(ws, dir), indexBasis: indexSource,
    parts, leftOut, frontMatterFiles, binder: { research: [], notes: [], ideas: [] }, enrichment: 'pending',
    labels, duplicateLabels: duplicates, meta: roomMeta(parts),
    startAPlan: parts.length === 0 && !declaresRunningOrder(indexSource ?? ''),
    newCardFolio: { notInOutline: plan.unlisted.map(part => ({ title: part.title, path: part.path })), indexNote: plan.indexNoteAbsent ? null : { path: plan.indexPath, title: indexTitle || null } },
  }
  const evidence = await readEvidence(ws, dir, parts.map(part => ({ title: part.title, path: part.key.path, content: part.key.path ? facts.get(part.key.path)?.content : undefined })), walked)
  const binder = await folioBinder(ws, dir, walked)
  const bin = readFolioBin(ws, dir)
  binder.bin = bin.items
  if (bin.unreadable) binder.binUnreadable = true
  binder.research.push(...[...new Map(Object.values(evidence.parts).flatMap(part => part.rows.filter(row => row.kind === 'zotero').map(row => [row.target, { path: row.target, name: row.sourceTitle ?? row.citationLabel ?? row.title, kind: 'zotero' as const }] as const))).values()])
  binder.notes.push(...evidence.orphans.map(orphan => ({ path: evidence.path, name: `Evidence and notes for a part not in the outline · ${orphan.title}`, section: orphan.title, kind: 'file' as const })))
  return {
    dir,
    name,
    title: indexTitle || name,
    stateKey: roomStateKey(ws, dir),
    indexBasis: indexSource,
    parts,
    leftOut,
    frontMatterFiles,
    binder,
    evidence,
    map: await readMap(ws, dir, parts, [...new Set([...walked, ...evidence.candidates.map(candidate => candidate.path)])]),
    labels,
    duplicateLabels: duplicates,
    meta: roomMeta(parts),
    startAPlan: parts.length === 0 && !declaresRunningOrder(indexSource ?? ''),
    newCardFolio: {
      notInOutline: plan.unlisted.map((part) => ({ title: part.title, path: part.path })),
      indexNote: plan.indexNoteAbsent ? null : { path: plan.indexPath, title: indexTitle || null },
    },
  }
}

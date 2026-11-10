/**
 * Compare two Folio versions, or a version with the working draft (ADR-0052 § Agent verbs `compare-folio-versions`; Folio
 * versions ticket 08). One function the Versions tab, the command line and the agent's verb all call, so the three cannot disagree.
 *
 * WHAT IT SAYS. For the Index Note, every part, every file not in the outline and every inserted file: unchanged, changed (with
 * the words added and removed), only on one side, or moved (the same text in a different place in the running order). A part
 * that moved and also changed is `changed` and carries both places. A file is the same file on both sides when the file's own
 * history is the same (a per-file version's path), not when its label was spelt the same on the day, so a renamed part is still
 * one line. Inserted files are compared by the per-file version each side used, so a changed table says `v1 → v2`.
 *
 * "WORKING" IS THE TEXT ON DISK. The working side is gathered as a save would gather it (folio-version-members.ts) and read from
 * disk; a version's side is read through the shared reader (folio-version-reader.ts) by per-file version id, so a file that has
 * since changed, moved or been deleted still reads as it was saved. Two members with the same per-file version id are the same
 * bytes (a save reuses the version when the bytes are equal), so a version compared with itself, or with a later version that left
 * a part alone, reads nothing for that part.
 *
 * READS ONLY: nothing here appends a journal line, makes a folder or writes a file. Electron-free.
 */
import { createHash } from 'node:crypto'
import { diffContent, type ContentDiffHunk } from '../engine'
import type { FolioContentMember } from '../shared/folio-version-records'
import {
  COMPARE_WORKING,
  type FolioCompareEnd, type FolioCompareEntry, type FolioCompareFileSide, type FolioCompareKind, type FolioComparePart, type FolioCompareResult, type FolioCompareRow,
  type FolioCompareSegment, type FolioCompareState, type FolioCompareSummary,
} from '../shared/folio-version-compare'
import { FolioGatherRefused, gatherFolio } from './folio-version-members'
import { openVersionMembers, type OpenedVersionMembers, type VersionReaderSources } from './folio-version-reader'
import type { FileVersionFacts } from './folio-versions-tab'
import { versionParagraphs, type VersionParagraph } from '../shared/folio-version-paragraphs'

/** The seams: the shared reader's, and the bytes of a working file (null when it is not there). */
export type FolioCompareSources = VersionReaderSources & {
  readWorkingBytes: (path: string) => Promise<Buffer | null>
}

/** The comparison cannot be made, and why, in a sentence for the person. */
export class FolioCompareRefused extends Error {
  override readonly name = 'FolioCompareRefused'
  readonly code: 'not-found' | 'unreadable'
  constructor(message: string, code: 'not-found' | 'unreadable' = 'not-found') { super(message); this.code = code }
}

const MARKDOWN = /\.(md|markdown)$/i
const utf8 = (bytes: Buffer): string => bytes.toString('utf8')
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const READ_AT_ONCE = 8

async function inBatches<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let at = 0; at < items.length; at += READ_AT_ONCE) out.push(...(await Promise.all(items.slice(at, at + READ_AT_ONCE).map(run))))
  return out
}

/** One file on one side. `read` gives its bytes; `sameAs` is the per-file version it came from (a version side only). */
type SideFile = {
  kind: FolioCompareKind
  /** What the file is across versions: its history's path, else its label. */
  identity: string
  path: string
  title: string
  position?: number
  versionId?: string
  file?: FolioCompareFileSide | null
  read: () => Promise<Buffer | null>
}
type Side = { end: FolioCompareEnd; files: SideFile[] }

const titleOf = (path: string, title?: string): string => title?.trim() || path.split('/').pop()?.replace(/\.(md|markdown)$/i, '') || path

/** How many versions of the file at `path` there were up to and including the one at `ts`: `v1`, `v2`. Absent when the history does not say where a file sits. */
function ordinalsOf(facts: Map<string, FileVersionFacts>): (versionId: string) => number | undefined {
  const byPath = new Map<string, Array<{ id: string; ts: number }>>()
  for (const fact of facts.values()) {
    if (fact.path === undefined || fact.snapshotId === undefined) continue
    const list = byPath.get(fact.path) ?? []
    list.push({ id: fact.id, ts: fact.ts })
    byPath.set(fact.path, list)
  }
  for (const list of byPath.values()) list.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
  return (versionId) => {
    const path = facts.get(versionId)?.path
    const at = path === undefined ? -1 : (byPath.get(path)?.findIndex((entry) => entry.id === versionId) ?? -1)
    return at === -1 ? undefined : at + 1
  }
}

function versionSide(opened: OpenedVersionMembers): Side {
  const { version } = opened
  const ordinal = ordinalsOf(opened.facts)
  const parts = opened.members.filter((member) => member.role === 'part').sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))
  const positionOf = new Map(parts.map((member, at) => [member, at + 1]))
  // A version's own `index` pointer stands in when its members carry no Index Note line.
  const members: FolioContentMember[] = opened.members.some((member) => member.role === 'index') ? opened.members : [{ role: 'index', path: version.index.path, versionId: version.index.versionId }, ...opened.members]
  const files = members.map((member: FolioContentMember): SideFile => {
    const fact = opened.facts.get(member.versionId)
    const kind: FolioCompareKind = member.role
    const used = fact ? { name: fact.name, ts: fact.ts, ...(ordinal(member.versionId) !== undefined ? { ordinal: ordinal(member.versionId) } : {}) } : null
    return {
      kind,
      identity: kind === 'index' ? 'index' : (fact?.path ?? member.path),
      path: member.path,
      title: kind === 'index' ? 'Index Note' : titleOf(member.path, member.title),
      ...(kind === 'part' ? { position: positionOf.get(member) } : {}),
      versionId: member.versionId,
      ...(kind === 'inserted' ? { file: used } : {}),
      read: () => opened.bytesOf(member),
    }
  })
  return { end: { id: version.id, name: version.name, ts: version.ts, author: version.author.name, working: false }, files }
}

async function workingSide(sources: FolioCompareSources, dir: string): Promise<Side> {
  let gathered
  try { gathered = await gatherFolio(sources.workspace, dir) } catch (error) {
    if (error instanceof FolioGatherRefused) throw new FolioCompareRefused(error.message, 'unreadable')
    throw error
  }
  // An inserted file whose bytes on disk are those of its latest saved file version is that version, not a new "working copy".
  const facts = new Map((await sources.fileVersions()).map((fact) => [fact.id, fact]))
  const ordinal = ordinalsOf(facts)
  const latest = new Map<string, FileVersionFacts>()
  for (const fact of facts.values()) {
    if (fact.path === undefined || fact.snapshotId === undefined) continue
    const held = latest.get(fact.path)
    if (!held || fact.ts > held.ts) latest.set(fact.path, fact)
  }
  const workingCopy = async (path: string): Promise<FolioCompareFileSide> => {
    const fact = latest.get(path)
    const bytes = await sources.readWorkingBytes(path)
    if (fact?.snapshotId && bytes !== null) {
      const saved = await sources.readSnapshotBytes(fact.snapshotId).catch(() => null)
      if (saved !== null && sha256(saved) === sha256(bytes)) return { name: fact.name, ts: fact.ts, ...(ordinal(fact.id) !== undefined ? { ordinal: ordinal(fact.id) } : {}) }
    }
    return { name: null, ts: null }
  }
  const inserted = await inBatches(gathered.files.filter((file) => file.role === 'inserted'), async (file) => [file.path, await workingCopy(file.path)] as const)
  const insertedSide = new Map(inserted)
  const files = gathered.files.flatMap((file): SideFile[] => {
    if (file.role === 'linked') return []
    const kind: FolioCompareKind = file.role
    return [{
      kind,
      identity: kind === 'index' ? 'index' : file.path,
      path: file.path,
      title: kind === 'index' ? 'Index Note' : titleOf(file.path, file.title),
      ...(kind === 'part' ? { position: file.order } : {}),
      ...(kind === 'inserted' ? { file: insertedSide.get(file.path) ?? { name: null, ts: null } } : {}),
      read: () => sources.readWorkingBytes(file.path),
    }]
  })
  // The working parts' places: renumber 1..n so a gap left by an unwritten part is not a move.
  const parts = files.filter((file) => file.kind === 'part').sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  parts.forEach((part, at) => { part.position = at + 1 })
  return { end: { id: COMPARE_WORKING, name: 'Working draft', ts: null, author: null, working: true }, files }
}

async function sideOf(sources: FolioCompareSources, dir: string, id: string): Promise<Side> {
  if (id === COMPARE_WORKING) return workingSide(sources, dir)
  const opened = await openVersionMembers(sources, dir, id)
  if (!opened) throw new FolioCompareRefused(`There is no Folio version "${String(id)}" in this Folio. "folio-versions" lists the versions, or give "${COMPARE_WORKING}" for the text on disk now.`)
  return versionSide(opened)
}

// ---- Words and differences ----------------------------------------------------------------------------

const wordsIn = (text: string): number => text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length

/** Words added and removed by one hunk. */
function hunkWords(hunk: ContentDiffHunk): { added: number; removed: number } {
  if (hunk.kind === 'added') return { added: wordsIn(hunk.newText), removed: 0 }
  if (hunk.kind === 'removed') return { added: 0, removed: wordsIn(hunk.oldText) }
  let added = 0
  let removed = 0
  for (const segment of hunk.segments) {
    if (segment.kind === 'added') added += wordsIn(segment.text)
    else if (segment.kind === 'removed') removed += wordsIn(segment.text)
  }
  return { added, removed }
}

/** Words added and words removed going from `from` to `to`. */
export function countChangedWords(from: string, to: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of diffContent(from, to)) {
    const words = hunkWords(hunk)
    added += words.added
    removed += words.removed
  }
  return { added, removed }
}

// ---- Which places moved -------------------------------------------------------------------------------

/** Indexes (into `values`) that are in a longest increasing subsequence; the rest are what moved. */
function stayingPut(values: readonly number[]): Set<number> {
  const tails: number[] = []
  const previous: number[] = new Array(values.length).fill(-1)
  values.forEach((value, at) => {
    let low = 0
    let high = tails.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (values[tails[middle]] < value) low = middle + 1
      else high = middle
    }
    if (low > 0) previous[at] = tails[low - 1]
    tails[low] = at
  })
  const keep = new Set<number>()
  for (let at = tails.length ? tails[tails.length - 1] : -1; at !== -1; at = previous[at]) keep.add(at)
  return keep
}

// ---- The comparison -----------------------------------------------------------------------------------

type Pair = { from?: SideFile; to?: SideFile }

const keyOf = (kind: FolioCompareKind, identity: string): string => (kind === 'index' ? 'index' : `${kind}:${identity}`)

function pairUp(from: Side, to: Side): Map<string, Pair> {
  const pairs = new Map<string, Pair>()
  for (const file of to.files) pairs.set(keyOf(file.kind, file.identity), { to: file })
  for (const file of from.files) {
    const key = keyOf(file.kind, file.identity)
    pairs.set(key, { ...pairs.get(key), from: file })
  }
  return pairs
}

async function entryOf(key: string, pair: Pair, moved: boolean, workingEnd: 'from' | 'to' | null): Promise<FolioCompareEntry> {
  const { from, to } = pair
  const either = (to ?? from) as SideFile
  const isFile = either.kind === 'inserted'
  const text = !isFile || MARKDOWN.test(either.path)
  const base: Omit<FolioCompareEntry, 'state'> = {
    key,
    kind: either.kind,
    title: either.title,
    path: either.path,
    ...(from ? { fromPath: from.path } : {}),
    ...(to ? { toPath: to.path } : {}),
    ...(from?.position !== undefined ? { fromPosition: from.position } : {}),
    ...(to?.position !== undefined ? { toPosition: to.position } : {}),
    ...(isFile && from ? { fromFile: from.file ?? null } : {}),
    ...(isFile && to ? { toFile: to.file ?? null } : {}),
    text,
    added: 0,
    removed: 0,
  }
  if (!from) return { ...base, state: 'only-to' }
  if (!to) return { ...base, state: 'only-from' }
  const unchangedOrMoved: FolioCompareState = moved ? 'moved' : 'unchanged'
  // The same per-file version is the same bytes: nothing to read.
  if (from.versionId !== undefined && from.versionId === to.versionId) return { ...base, state: unchangedOrMoved }
  const [before, after] = await Promise.all([from.read(), to.read()])
  if (before === null || after === null) return { ...base, state: 'changed', unreadable: true }
  if (sha256(before) === sha256(after)) return { ...base, state: unchangedOrMoved }
  return { ...base, state: 'changed', ...(text ? countChangedWords(utf8(before), utf8(after)) : {}), ...(workingEnd ? { workingSha256: sha256(workingEnd === 'from' ? before : after) } : {}) }
}

/** Parts in the order the later side shows them, with a part only on the earlier side placed after the part that came before it there. */
function mergedOrder(parts: Array<{ key: string; fromPosition?: number; toPosition?: number }>): string[] {
  const out = parts.filter((part) => part.toPosition !== undefined).sort((a, b) => (a.toPosition as number) - (b.toPosition as number)).map((part) => part.key)
  const placed = new Set<string>()
  let anchor: string | null = null
  for (const part of parts.filter((candidate) => candidate.fromPosition !== undefined).sort((a, b) => (a.fromPosition as number) - (b.fromPosition as number))) {
    if (part.toPosition !== undefined) { anchor = part.key; continue }
    let place = anchor === null ? 0 : out.indexOf(anchor) + 1
    while (place < out.length && placed.has(out[place])) place += 1
    out.splice(place, 0, part.key)
    placed.add(part.key)
  }
  return out
}

function summarise(entries: readonly FolioCompareEntry[]): FolioCompareSummary {
  const summary: FolioCompareSummary = { unchanged: 0, changed: 0, onlyFrom: 0, onlyTo: 0, moved: 0 }
  for (const entry of entries) {
    if (entry.state === 'unchanged') summary.unchanged += 1
    else if (entry.state === 'changed') summary.changed += 1
    else if (entry.state === 'only-from') summary.onlyFrom += 1
    else if (entry.state === 'only-to') summary.onlyTo += 1
    else summary.moved += 1
  }
  return summary
}

/**
 * Compare version `fromId` with version `toId` of the Folio at `dir` (either may be `working`, the text on disk now). Throws
 * `FolioCompareRefused` when a version is not one of this Folio's (an id from another Folio is never answered) or the working
 * Folio cannot be read as a save would read it.
 */
export async function compareFolioVersions(sources: FolioCompareSources, dir: string, fromId: string, toId: string): Promise<FolioCompareResult> {
  if (typeof fromId !== 'string' || typeof toId !== 'string' || fromId === '' || toId === '') throw new FolioCompareRefused('Name the two versions to compare by their ids ("folio-versions" lists them), or "working" for the text on disk now.')
  const [from, to] = [await sideOf(sources, dir, fromId), await sideOf(sources, dir, toId)]
  const pairs = pairUp(from, to)

  // A part that sits in both running orders but not in the longest stretch that kept its relative order has moved.
  const partKeys = [...pairs].filter(([, pair]) => pair.from?.kind === 'part' && pair.to?.kind === 'part').sort((a, b) => (a[1].from?.position as number) - (b[1].from?.position as number))
  const staying = stayingPut(partKeys.map(([, pair]) => pair.to?.position as number))
  const moved = new Set(partKeys.filter((_, at) => !staying.has(at)).map(([key]) => key))

  const entries = new Map<string, FolioCompareEntry>()
  const keys = [...pairs.keys()]
  const made = await inBatches(keys, async (key) => entryOf(key, pairs.get(key) as Pair, moved.has(key), from.end.working ? 'from' : to.end.working ? 'to' : null))
  made.forEach((entry) => entries.set(entry.key, entry))
  const all = [...entries.values()]

  const parts = all.filter((entry) => entry.kind === 'part')
  const order = mergedOrder(parts)
  const byPath = (a: FolioCompareEntry, b: FolioCompareEntry): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const indexEntry = entries.get('index')
  if (!indexEntry) throw new FolioCompareRefused('This Folio has no Index Note to compare.', 'unreadable')
  return {
    dir,
    from: from.end,
    to: to.end,
    same: from.end.id === to.end.id,
    index: indexEntry,
    parts: order.map((key) => entries.get(key) as FolioCompareEntry),
    unlisted: all.filter((entry) => entry.kind === 'unlisted').sort(byPath),
    inserted: all.filter((entry) => entry.kind === 'inserted').sort(byPath),
    summary: summarise(all),
  }
}

// ---- One line opened ----------------------------------------------------------------------------------

const trimmed = (text: string): string => text.replace(/\r?\n$/, '')

/** The first and last paragraph numbers whose text lies in lines `startLine` to `startLine + lines - 1` (1-based) of `text`; undefined when none does. */
function paragraphsTouching(text: string, starts: readonly number[], paragraphs: readonly VersionParagraph[], startLine: number, lines: number): [number, number] | undefined {
  if (lines <= 0 || paragraphs.length === 0) return undefined
  const a = starts[startLine - 1] ?? text.length
  const b = starts[startLine - 1 + lines] ?? text.length
  const hits = paragraphs.filter((paragraph) => paragraph.from < b && paragraph.to > a)
  return hits.length > 0 ? [hits[0]!.n, hits[hits.length - 1]!.n] : undefined
}
const lineStarts = (text: string): number[] => { const out = [0]; for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') out.push(i + 1); return out }

/** The row for one hunk: both sides' text with the changed words marked, and the paragraphs of each side it touches. */
type SideText = { text: string; starts: number[]; paragraphs: VersionParagraph[] }
const sideText = (text: string): SideText => ({ text, starts: lineStarts(text), paragraphs: versionParagraphs(text) })

function rowOf(hunk: ContentDiffHunk, ends: { from: SideText; to: SideText }): FolioCompareRow {
  const segments: FolioCompareSegment[] = hunk.segments.map((segment) => ({ kind: segment.kind, text: segment.text }))
  const { added, removed } = hunkWords(hunk)
  const from = segments.filter((segment) => segment.kind !== 'added').map((segment) => ({ ...segment, text: trimmed(segment.text) }))
  const to = segments.filter((segment) => segment.kind !== 'removed').map((segment) => ({ ...segment, text: trimmed(segment.text) }))
  const fromParagraphs = paragraphsTouching(ends.from.text, ends.from.starts, ends.from.paragraphs, hunk.oldStart, hunk.oldLines)
  const toParagraphs = paragraphsTouching(ends.to.text, ends.to.starts, ends.to.paragraphs, hunk.newStart, hunk.newLines)
  return { kind: 'changed', from, to, added, removed, ...(fromParagraphs ? { fromParagraphs } : {}), ...(toParagraphs ? { toParagraphs } : {}) }
}

/** Two texts as rows: stretches of unchanged paragraphs folded to a count, and each changed stretch with both sides. */
export function compareRows(from: string, to: string): FolioCompareRow[] {
  const lines = from.split('\n')
  const ends = { from: sideText(from), to: sideText(to) }
  const rows: FolioCompareRow[] = []
  let at = 1
  const skip = (until: number): void => {
    const paragraphs = lines.slice(at - 1, Math.max(at - 1, until - 1)).filter((line) => line.trim() !== '').length
    if (paragraphs > 0) rows.push({ kind: 'same', paragraphs })
  }
  for (const hunk of diffContent(from, to)) {
    skip(hunk.oldStart)
    rows.push(rowOf(hunk, ends))
    at = Math.max(at, hunk.oldStart + hunk.oldLines)
  }
  skip(lines.length + 1)
  return rows
}

/**
 * One line of a comparison opened: the two texts of a part (or a file not in the outline, or the Index Note) side by side. Null
 * when the line is not in this pair, is not text, or its text cannot be read. The line is found by its key among the two sides'
 * own files; nothing from the caller is joined to a path.
 */
export async function compareFolioPart(sources: FolioCompareSources, dir: string, fromId: string, toId: string, key: string): Promise<FolioComparePart | null> {
  if (typeof key !== 'string') return null
  const [from, to] = [await sideOf(sources, dir, fromId), await sideOf(sources, dir, toId)]
  const pair = pairUp(from, to).get(key)
  const either = pair?.to ?? pair?.from
  if (!pair || !either || (either.kind === 'inserted' && !MARKDOWN.test(either.path))) return null
  const [before, after] = await Promise.all([pair.from ? pair.from.read() : Promise.resolve(Buffer.alloc(0)), pair.to ? pair.to.read() : Promise.resolve(Buffer.alloc(0))])
  if (before === null || after === null) return null
  const rows = compareRows(utf8(before), utf8(after))
  const added = rows.reduce((sum, row) => sum + (row.kind === 'changed' ? row.added : 0), 0)
  const removed = rows.reduce((sum, row) => sum + (row.kind === 'changed' ? row.removed : 0), 0)
  return { key, title: either.title, rows, added, removed }
}

// ---- One part, for the take ---------------------------------------------------------------------------

/** What a take of one part needs: the working file as it is now and the saved text of the version's side of the same line. */
export type TakePair = {
  /** The line's title and the working part's path (the file the text would go to). */
  title: string
  path: string
  version: { id: string; name: string }
  workingBytes: Buffer
  versionBytes: Buffer
}

/** Why a take pair could not be made: the line is not a part both sides have, or one side cannot be read. */
export type TakePairRefused = 'not-a-take' | 'unreadable'

/**
 * The two sides of one PART line when exactly one end of the comparison is the working draft: the working file's bytes now and the
 * version's saved bytes. Reads only. The line is found by its key among the two sides' own files; nothing from the caller is joined
 * to a path. Throws `FolioCompareRefused` for a version that is not this Folio's.
 */
export async function readTakePair(sources: FolioCompareSources, dir: string, fromId: string, toId: string, key: string): Promise<TakePair | TakePairRefused> {
  if (typeof key !== 'string' || (fromId === COMPARE_WORKING) === (toId === COMPARE_WORKING)) return 'not-a-take'
  const [from, to] = [await sideOf(sources, dir, fromId), await sideOf(sources, dir, toId)]
  const pair = pairUp(from, to).get(key)
  const working = from.end.working ? pair?.from : pair?.to
  const saved = from.end.working ? pair?.to : pair?.from
  const versionEnd = from.end.working ? to.end : from.end
  if (!pair || !working || !saved || working.kind !== 'part' || saved.kind !== 'part') return 'not-a-take'
  const [workingBytes, versionBytes] = await Promise.all([working.read(), saved.read()])
  if (workingBytes === null || versionBytes === null) return 'unreadable'
  return { title: working.title, path: working.path, version: { id: versionEnd.id, name: versionEnd.name }, workingBytes, versionBytes }
}

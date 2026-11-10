import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { assertCollectionWritable } from './collection-write-gate'
import { createHash } from 'node:crypto'
import { ChangedSinceRead, Workspace } from './workspace'
import { createIndexNote, localCalendarDate } from './collection'
import { documentTitle, parseFrontmatter } from './frontmatter'
import { removeFrontmatterKeys, setFrontmatterKeys } from './capabilities'

export const DIARY_FOLDER_SETTING = 'diary.folder'
export const COUNTED_VALUE = 'counted'
export const RECORDED_START = '<!-- writeflex:recorded:start -->'
export const RECORDED_END = '<!-- writeflex:recorded:end -->'
const RECORDED_META = '<!-- writeflex:recorded:meta '

export type CountedCollection = { root: string; dir: string; name: string; pieces: number }
export type DiarySessionRecord = {
  id: string
  startedAt: number
  minutes: number
  netWords: number
  pieces: string[]
  edited?: boolean
}

function indexPath(ws: Workspace, dir: string): string {
  const name = dir === '' ? basename(ws.root) : basename(dir)
  return dir === '' ? `_${name}_INDEX.md` : posix.join(dir, `_${name}_INDEX.md`)
}

export async function isCountedCollection(ws: Workspace, dir: string): Promise<boolean> {
  const path = indexPath(ws, dir)
  if (!(await ws.listFiles()).some((file) => file.path === path)) return false
  const value = parseFrontmatter((await ws.readFile(path)).content)?.extra.diary
  return typeof value === 'string' && value.trim().toLowerCase() === COUNTED_VALUE
}

export async function setCollectionCounted(ws: Workspace, dir: string, counted: boolean) {
  const path = indexPath(ws, dir)
  if (!(await ws.listFiles()).some((file) => file.path === path)) {
    if (!counted) throw new Error(`Could not stop counting ${dir || basename(ws.root)} because its Index Note no longer exists.`)
    await createIndexNote(ws, dir)
  }
  const source = await ws.readFile(path)
  const content = counted
    ? setFrontmatterKeys(source.content, { diary: COUNTED_VALUE }, path)
    : removeFrontmatterKeys(source.content, ['diary'], path)
  const saved = await ws.saveFile(path, content)
  invalidateCountedCollectionCache(ws.root, dir)
  return saved
}

export async function countedCollections(ws: Workspace): Promise<CountedCollection[]> {
  const files = await ws.listFiles()
  const out: CountedCollection[] = []
  for (const file of files) {
    if (!/^_.+_INDEX\.md$/i.test(file.name)) continue
    const value = parseFrontmatter((await ws.readFile(file.path)).content)?.extra.diary
    if (typeof value !== 'string' || value.trim().toLowerCase() !== COUNTED_VALUE) continue
    const dir = file.directory
    const pieces = files.filter((candidate) => candidate.directory === dir && candidate.path !== file.path).length
    out.push({ root: ws.root, dir, name: dir === '' ? basename(ws.root) : basename(dir), pieces })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir))
}

export function collectionDirForPiece(path: string): string {
  const parent = posix.dirname(path)
  return parent === '.' ? '' : parent
}

const countedDecisionCache = new Map<string, Promise<boolean>>()

function countedCacheKey(root: string, dir: string): string {
  return `${root}\0${dir}`
}

export function invalidateCountedCollectionCache(root: string, dir?: string): void {
  if (dir !== undefined) {
    countedDecisionCache.delete(countedCacheKey(root, dir))
    return
  }
  for (const key of countedDecisionCache.keys()) if (key.startsWith(`${root}\0`)) countedDecisionCache.delete(key)
}

async function cachedIsCountedCollection(ws: Workspace, dir: string): Promise<boolean> {
  const key = countedCacheKey(ws.root, dir)
  let pending = countedDecisionCache.get(key)
  if (!pending) {
    pending = isCountedCollection(ws, dir)
    countedDecisionCache.set(key, pending)
    void pending.catch(() => { if (countedDecisionCache.get(key) === pending) countedDecisionCache.delete(key) })
  }
  return pending
}

function isInside(root: string, path: string): boolean {
  const canonical = (value: string): string => {
    let existing = resolve(value)
    const tail: string[] = []
    while (!existsSync(existing)) {
      const parent = dirname(existing)
      if (parent === existing) return resolve(value)
      tail.unshift(basename(existing))
      existing = parent
    }
    return resolve(realpathSync(existing), ...tail)
  }
  const canonicalRoot = canonical(root)
  const canonicalPath = canonical(path)
  const rel = relative(canonicalRoot, canonicalPath)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function isInsideDiaryRoot(diaryRoot: string, absolutePath: string): boolean {
  return isInside(diaryRoot, absolutePath)
}

export async function diaryCaptureRoot(ws: Workspace, path: string, designated: unknown): Promise<string | null> {
  if (typeof designated !== 'string' || designated.trim() === '') return null
  if (isInside(designated, ws.absolute(path))) return null
  return await cachedIsCountedCollection(ws, collectionDirForPiece(path)) ? designated : null
}

function timeLabel(timestamp: number): string {
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function pieceLink(title: string): string {
  return `[[${title}]]`
}

function rowChecksum(row: string): string {
  return createHash('sha256').update(row).digest('hex').slice(0, 12)
}

function rowPrefix(row: string): string {
  return row.split(' words · ')[0] + ' words · '
}

function sessionRow(record: DiarySessionRecord, titles: string[]): string {
  const sign = record.netWords >= 0 ? '+' : ''
  return `${timeLabel(record.startedAt)} · ${record.minutes} min · ${sign}${record.netWords} words · ${titles.map(pieceLink).join(', ')}`
}

type MachineMeta = { id: string; checksum: string; prefix?: string; suffixChecksum?: string }

function metaLine(meta: MachineMeta[]): string {
  return `${RECORDED_META}${JSON.stringify(meta)} -->`
}

function recordedBlock(row: string, record: DiarySessionRecord, eol: string): string {
  return [RECORDED_START, metaLine([{ id: record.id, checksum: rowChecksum(row), prefix: rowPrefix(row), suffixChecksum: rowChecksum(row.slice(rowPrefix(row).length)) }]), 'recorded', row, RECORDED_END].join(eol)
}

type ParsedMachineRow = { id: string; minutes: number; words: number }
function machineRows(content: string): ParsedMachineRow[] {
  const rows: ParsedMachineRow[] = []
  const lines = content.split(/\r?\n/)
  const start = lines.findIndex((line) => line === RECORDED_START)
  const end = lines.findIndex((line, index) => index > start && line === RECORDED_END)
  if (start < 0 || end < 0) return rows
  const rawMeta = lines.slice(start + 1, end).find((line) => line.startsWith(RECORDED_META) && line.endsWith(' -->'))
  if (!rawMeta) return rows
  let meta: MachineMeta[]
  try {
    const parsed = JSON.parse(rawMeta.slice(RECORDED_META.length, -4)) as unknown
    if (!Array.isArray(parsed)) return rows
    meta = parsed.filter((entry): entry is MachineMeta => !!entry && typeof entry.id === 'string' && typeof entry.checksum === 'string')
  } catch { return rows }
  const candidates = lines.slice(start + 1, end)
  const used = new Set<number>()
  for (const entry of meta) {
    const index = candidates.findIndex((line, candidateIndex) => !used.has(candidateIndex) && rowChecksum(line) === entry.checksum)
    if (index < 0) continue
    const match = /^(\d{2}:\d{2}) · (\d+) min · ([+-]?\d+) words · /.exec(candidates[index])
    if (!match) continue
    used.add(index)
    rows.push({ id: entry.id, minutes: Number(match[2]), words: Number(match[3]) })
  }
  return rows
}

function latestTotals(content: string): { words: number; minutes: number } {
  const latest = new Map<string, ParsedMachineRow>()
  for (const row of machineRows(content)) latest.set(row.id, row)
  let words = 0
  let minutes = 0
  for (const row of latest.values()) {
    words += row.words
    minutes += row.minutes
  }
  return { words, minutes }
}

function appendOrCheckpoint(content: string, record: DiarySessionRecord, titles: string[]): string {
  const eol = content.match(/\r\n|\n/)?.[0] ?? '\n'
  const row = sessionRow(record, titles)
  const lines = content.split(/(?<=\n)/)
  const clean = lines.map((line) => line.replace(/\r?\n$/, ''))
  const startIndex = clean.findIndex((line) => line === RECORDED_START)
  const endIndex = clean.findIndex((line, index) => index > startIndex && line === RECORDED_END)
  const metaIndex = clean.findIndex((line, index) => index > startIndex && index < endIndex && line.startsWith(RECORDED_META) && line.endsWith(' -->'))
  if (startIndex >= 0 && endIndex >= 0) {
    let meta: MachineMeta[] = []
    try {
      const parsed = metaIndex < 0 ? [] : JSON.parse(clean[metaIndex].slice(RECORDED_META.length, -4)) as unknown
      if (Array.isArray(parsed)) meta = parsed.filter((entry): entry is MachineMeta => !!entry && typeof entry.id === 'string' && typeof entry.checksum === 'string')
    } catch { /* Recover the surviving visible records below. */ }
    // Match occurrences, not just fingerprints: identical visible rows are separate sittings.
    const rowIndices = clean.flatMap((line, index) => index > startIndex && index < endIndex
      && /^\d{2}:\d{2} · \d+ min · [+-]?\d+ words · \[\[.*\]\]/.test(line) ? [index] : [])
    // No surviving rows means there is nothing to count twice, including stale metadata
    // left behind when the writer deliberately removed every row.
    if (rowIndices.length === 0) {
      if (clean.slice(startIndex + 1, endIndex).some(line => /^\d{2}:\d{2} · /.test(line))) {
        throw new Error('Cannot rebuild Diary totals: no readable recorded rows survive. Restore the recorded block before continuing.')
      }
      meta = []
    }
    const unmatched = new Set(rowIndices)
    const matched = new Map<MachineMeta, number>()
    for (const entry of meta) {
      const index = rowIndices.find(index => unmatched.has(index) && rowChecksum(clean[index]) === entry.checksum)
      if (index !== undefined) { matched.set(entry, index); unmatched.delete(index) }
    }
    // The original numeric prefix identifies a row whose link or trailing note was edited.
    // Only accept a unique pairing; uncertain identities must refuse rather than double count.
    for (const entry of meta) {
      if (matched.has(entry) || typeof entry.prefix !== 'string') continue
      const candidates = [...unmatched].filter(index => rowPrefix(clean[index]) === entry.prefix)
      const owners = meta.filter(other => !matched.has(other) && typeof other.prefix === 'string'
        && other.prefix === entry.prefix)
      if (candidates.length === 1 && owners.length === 1) {
        matched.set(entry, candidates[0]); unmatched.delete(candidates[0])
      }
    }
    const prior = [...meta].reverse().find(entry => entry.id === record.id)
    const existingIndex = prior ? matched.get(prior) ?? -1 : -1
    if (prior && existingIndex < 0) {
      throw new Error('Cannot identify this Diary checkpoint after its row was edited or deleted. Restore the recorded row before continuing this sitting.')
    }
    const recoveredCheckpoint = rowIndices.some(index => clean[index].startsWith(`${timeLabel(record.startedAt)} · `)
      && (unmatched.has(index) || [...matched].some(([entry, at]) => at === index && entry.id.startsWith('recovered-'))))
    if (!prior && recoveredCheckpoint) {
      throw new Error('Cannot identify this Diary checkpoint after its metadata was damaged. Restore the recorded metadata before continuing this sitting.')
    }
    meta = meta.filter(entry => matched.has(entry)).map(entry => ({
      id: entry.id, suffixChecksum: entry.suffixChecksum, checksum: rowChecksum(clean[matched.get(entry)!]), prefix: rowPrefix(clean[matched.get(entry)!]),
    }))
    for (const index of unmatched) {
      meta.push({ id: `recovered-${index}-${rowChecksum(clean[index])}`, checksum: rowChecksum(clean[index]), prefix: rowPrefix(clean[index]) })
    }
    if (metaIndex < 0) {
      lines.splice(startIndex + 1, 0, `${metaLine(meta)}${eol}`)
      return appendOrCheckpoint(lines.join(''), record, titles)
    }
    const preserveSuffix = existingIndex >= 0 && prior && (rowChecksum(clean[existingIndex]) !== prior.checksum
      || (prior.suffixChecksum && rowChecksum(clean[existingIndex].slice(rowPrefix(clean[existingIndex]).length)) !== prior.suffixChecksum))
    const nextRow = preserveSuffix
      ? row.split(' words · ')[0] + ' words · ' + clean[existingIndex].split(' words · ').slice(1).join(' words · ')
      : row
    const checksum = rowChecksum(nextRow)
    if (existingIndex >= 0) {
      lines[existingIndex] = `${nextRow}${lines[existingIndex].endsWith('\n') ? eol : ''}`
      const metaPosition = meta.findLastIndex(entry => entry.id === record.id)
      meta[metaPosition] = { id: record.id, checksum, prefix: rowPrefix(nextRow), suffixChecksum: preserveSuffix ? prior?.suffixChecksum : rowChecksum(nextRow.slice(rowPrefix(nextRow).length)) }
    } else {
      lines.splice(endIndex, 0, `${row}${eol}`)
      meta.push({ id: record.id, checksum, prefix: rowPrefix(nextRow), suffixChecksum: preserveSuffix ? prior?.suffixChecksum : rowChecksum(nextRow.slice(rowPrefix(nextRow).length)) })
    }
    lines[metaIndex] = `${metaLine(meta)}${lines[metaIndex].endsWith('\n') ? eol : ''}`
    return lines.join('')
  }
  const end = content.indexOf(RECORDED_END)
  if (end >= 0 || startIndex >= 0) throw new Error('The Diary recorded block is incomplete. Restore its start and end markers before recording more sessions.')
  const separator = content.length === 0 || content.endsWith(`${eol}${eol}`) ? '' : content.endsWith(eol) ? eol : `${eol}${eol}`
  return `${content}${separator}${recordedBlock(row, record, eol)}${eol}`
}

/** Atomic, non-empty Day Entry update. Only machine rows and aggregate target keys are changed. */
const diaryWriteChains = new Map<string, Promise<string>>()

export type DiaryWriteContext = { diaryWorkspace?: Workspace; sourceWorkspace?: Workspace }

async function pieceTitles(record: DiarySessionRecord, sourceWorkspace?: Workspace): Promise<string[]> {
  return Promise.all(record.pieces.map(async (path) => {
    if (!sourceWorkspace) return documentTitle('', path)
    try { return documentTitle((await sourceWorkspace.readFile(path)).content, path) } catch { return documentTitle('', path) }
  }))
}

async function writeDiarySession(diaryRoot: string, record: DiarySessionRecord, context: DiaryWriteContext): Promise<string> {
  // A diary kept inside a Collection is written only while this app holds that Collection; refused
  // like the save below would be, and reported the same way (persistDiarySession).
  assertCollectionWritable(diaryRoot)
  await mkdir(diaryRoot, { recursive: true })
  const diary = context.diaryWorkspace?.root === diaryRoot ? context.diaryWorkspace : new Workspace(diaryRoot)
  const name = `${localCalendarDate(new Date(record.startedAt))}.md`
  const date = new Date(record.startedAt)
  const day = `${date.toLocaleDateString('en-GB', { weekday: 'long' })} ${date.getDate()} ${date.toLocaleDateString('en-GB', { month: 'long' })} ${date.getFullYear()}`
  const titles = await pieceTitles(record, context.sourceWorkspace)
  for (let attempt = 0; ; attempt++) {
    const exists = existsSync(join(diaryRoot, name))
    const basis = exists ? await readFile(join(diaryRoot, name), 'utf8') : `# ${day}\n\n`
    let content = appendOrCheckpoint(basis, record, titles)
    const totals = latestTotals(content)
    content = setFrontmatterKeys(content, {
      words_written: String(totals.words),
      mins_spent: String(totals.minutes),
    }, name)
    try {
      if (exists) await diary.saveFileOverRead(name, content, basis)
      else await diary.createFile(name, content)
      break
    } catch (error) {
      // Closing a sitting may have no later checkpoint: rebuild over the latest bytes now.
      const conflict = error instanceof ChangedSinceRead
        || (!exists && error instanceof Error && error.message === `File already exists: ${name}`)
      if (attempt > 0 || !conflict) throw error
    }
  }
  return name
}

/** Serialise read-modify-write updates per Day Entry across every open Workspace window. */
export async function appendDiarySession(diaryRoot: string, record: DiarySessionRecord, context: DiaryWriteContext = {}): Promise<string | null> {
  if (!Number.isFinite(record.startedAt) || !Number.isFinite(new Date(record.startedAt).getTime())
    || !Number.isFinite(record.netWords) || !Number.isFinite(record.minutes) || record.minutes < 0) throw new Error('Invalid Diary session numbers.')
  if (record.netWords === 0 && !record.edited) return null
  const name = `${localCalendarDate(new Date(record.startedAt))}.md`
  const key = join(diaryRoot, name)
  const previous = diaryWriteChains.get(key)
  const next = (previous ? previous.catch(() => name) : Promise.resolve(name)).then(() => writeDiarySession(diaryRoot, record, context))
  diaryWriteChains.set(key, next)
  try { return await next } finally { if (diaryWriteChains.get(key) === next) diaryWriteChains.delete(key) }
}

export type GuardedDiaryWrite = { name: string | null; error?: string }

/** Guard the instrumentation write so a diary refusal can never break Workspace opening or editing. */
export async function persistDiarySession(
  diaryRoot: string,
  record: DiarySessionRecord | null,
  context: DiaryWriteContext = {},
): Promise<GuardedDiaryWrite> {
  if (!record || (record.netWords === 0 && !record.edited)) return { name: null }
  const name = `${localCalendarDate(new Date(record.startedAt))}.md`
  try {
    return { name: await appendDiarySession(diaryRoot, record, context) }
  } catch (error) {
    return { name: null, error: error instanceof Error ? error.message : `Could not update ${name}.` }
  }
}

export function countedSettingKey(root: string, dir: string): string {
  return `diary.counted:${encodeURIComponent(root)}:${encodeURIComponent(dir)}`
}

export function parseCountedSettingKey(key: string): { root: string; dir: string } | null {
  const match = /^diary\.counted:([^:]+):(.*)$/.exec(key)
  if (!match) return null
  try { return { root: decodeURIComponent(match[1]), dir: decodeURIComponent(match[2]) } } catch { return null }
}

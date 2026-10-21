import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { assertCollectionWritable } from './collection-write-gate'
import { createHash } from 'node:crypto'
import { Workspace } from './workspace'
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

function sessionRow(record: DiarySessionRecord, titles: string[]): string {
  const sign = record.netWords >= 0 ? '+' : ''
  return `${timeLabel(record.startedAt)} · ${record.minutes} min · ${sign}${record.netWords} words · ${titles.map(pieceLink).join(', ')}`
}

type MachineMeta = { id: string; checksum: string }

function metaLine(meta: MachineMeta[]): string {
  return `${RECORDED_META}${JSON.stringify(meta)} -->`
}

function recordedBlock(row: string, record: DiarySessionRecord, eol: string): string {
  return [RECORDED_START, metaLine([{ id: record.id, checksum: rowChecksum(row) }]), 'recorded', row, RECORDED_END].join(eol)
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
  if (startIndex >= 0 && endIndex >= 0 && metaIndex >= 0) {
    let meta: MachineMeta[] = []
    try {
      const parsed = JSON.parse(clean[metaIndex].slice(RECORDED_META.length, -4)) as unknown
      if (Array.isArray(parsed)) meta = parsed.filter((entry): entry is MachineMeta => !!entry && typeof entry.id === 'string' && typeof entry.checksum === 'string')
    } catch { /* malformed marker is preserved; a fresh trusted entry is appended below */ }
    const prior = [...meta].reverse().find((entry) => entry.id === record.id)
    const existingIndex = prior
      ? clean.findIndex((line, index) => index > startIndex && index < endIndex && rowChecksum(line) === prior.checksum)
      : -1
    const checksum = rowChecksum(row)
    if (existingIndex >= 0) {
      lines[existingIndex] = `${row}${lines[existingIndex].endsWith('\n') ? eol : ''}`
      const metaPosition = meta.lastIndexOf(prior!)
      meta[metaPosition] = { id: record.id, checksum }
    } else {
      lines.splice(endIndex, 0, `${row}${eol}`)
      meta.push({ id: record.id, checksum })
    }
    lines[metaIndex] = `${metaLine(meta)}${lines[metaIndex].endsWith('\n') ? eol : ''}`
    return lines.join('')
  }
  const end = content.indexOf(RECORDED_END)
  if (end >= 0) return content
  const separator = content.length === 0 || content.endsWith(`${eol}${eol}`) ? '' : content.endsWith(eol) ? eol : `${eol}${eol}`
  return `${content}${separator}${recordedBlock(row, record, eol)}${eol}`
}

/** Atomic, non-empty Day Entry update. Only machine rows and aggregate target keys are changed. */
const diaryWriteChains = new Map<string, Promise<string>>()
const pausedDayFiles = new Set<string>()
const surfacedDayFileErrors = new Set<string>()

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
  const exists = existsSync(join(diaryRoot, name))
  const date = new Date(record.startedAt)
  const day = `${date.toLocaleDateString('en-GB', { weekday: 'long' })} ${date.getDate()} ${date.toLocaleDateString('en-GB', { month: 'long' })} ${date.getFullYear()}`
  let content = exists ? await readFile(join(diaryRoot, name), 'utf8') : `# ${day}\n\n`
  content = appendOrCheckpoint(content, record, await pieceTitles(record, context.sourceWorkspace))
  const totals = latestTotals(content)
  content = setFrontmatterKeys(content, {
    words_written: String(totals.words),
    mins_spent: String(totals.minutes),
  }, name)
  if (exists) await diary.saveFileWithoutReadBack(name, content)
  else await diary.createFile(name, content)
  return name
}

/** Serialise read-modify-write updates per Day Entry across every open Workspace window. */
export async function appendDiarySession(diaryRoot: string, record: DiarySessionRecord, context: DiaryWriteContext = {}): Promise<string | null> {
  if (record.netWords <= 0) return null
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
  if (!record || record.netWords <= 0) return { name: null }
  const name = `${localCalendarDate(new Date(record.startedAt))}.md`
  const absolute = resolve(diaryRoot, name)
  if (pausedDayFiles.has(absolute)) return { name: null }
  try {
    return { name: await appendDiarySession(diaryRoot, record, context) }
  } catch (error) {
    pausedDayFiles.add(absolute)
    if (surfacedDayFileErrors.has(absolute)) return { name: null }
    surfacedDayFileErrors.add(absolute)
    return { name: null, error: error instanceof Error ? error.message : `Could not update ${name}.` }
  }
}

/** A genuine in-app edit of the refused Day Entry permits one later persistence attempt. */
export function resumeDiaryDayFile(path: string): void {
  pausedDayFiles.delete(resolve(path))
}

export function countedSettingKey(root: string, dir: string): string {
  return `diary.counted:${encodeURIComponent(root)}:${encodeURIComponent(dir)}`
}

export function parseCountedSettingKey(key: string): { root: string; dir: string } | null {
  const match = /^diary\.counted:([^:]+):(.*)$/.exec(key)
  if (!match) return null
  try { return { root: decodeURIComponent(match[1]), dir: decodeURIComponent(match[2]) } } catch { return null }
}

import { existsSync, readFileSync } from 'node:fs'
import { posix } from 'node:path'
import {
  MANIFEST_NAME,
  fallbackFolioParts,
  indexNotePath,
  manifestEntryPointsOutsideFolio,
  manifestFilePathCandidates,
  orderFor,
  readManifest,
  resolveManifestFilePath,
  type Folio,
  type FolioFile,
} from './folio'
import { collectionCandidates, buildWikilinkCandidateIndex, createCollectionStub, resolveWikilinkTargetFromIndex } from './wikilinks'
import { slugifyFileName, type Workspace } from './workspace'
import { PLAN_ROLES, parsePlanLine, serialisePlanLine, type PlanLine, type PlanLineMarker } from '../shared/plan-line'
import { jsonArrayLayout, rewriteJsonArrayByKey } from './json-array-layout'
import { parseFrontmatter } from './frontmatter'
import { preferOriginal } from '../shared/conflict-copy'
import { withPlanLock } from './plan-lock'

export type PlanPart = {
  title: string
  gloss: string | null
  role: string
  tags: string[]
  path: string | null
  line: number
  /** Set on unlisted parts so the renderer can state whether the manifest compiles them. */
  manifestBacked?: boolean
}

export type Plan = {
  dir: string
  indexPath: string
  headingLine: number
  parts: PlanPart[]
  unlisted: PlanPart[]
}

type LineRecord = { text: string; ending: string }
type ParsedEntry = { record: LineRecord; parsed: PlanLine; part: PlanPart }
type LoadedPlan = {
  plan: Plan
  source: string
  lines: LineRecord[]
  entries: ParsedEntry[]
  manifest: Folio | null
  manifestSource: string | null
  manifestExists: boolean
}

export type PlanWriteOptions = {
  beforeIndexWrite?: (path: string) => Promise<void>
  beforeManifestWrite?: (path: string) => Promise<void>
  /**
   * Called with the Plan exactly as the write read it, before anything is changed. It throws to refuse.
   * A caller that computed an index from an earlier read uses it to check that the index still names
   * what the caller meant, so a stale index can never move or adopt a different part. It cannot
   * relax any other check; it only adds one. `loaded` is the manifest of that same read.
   */
  verifyPlan?: (plan: Plan, loaded: PlanLoadedManifest) => void | Promise<void>
  /**
   * Refuse, before anything is written, a write that would change the Index Note and leave the manifest
   * as it is (no manifest, a part listed twice, or a manifest the change does not alter). The Outline's
   * running-order changes set it: there the two documents must always move together.
   */
  requireManifestWrite?: boolean
}

/** The manifest exactly as a Plan write read it, for `verifyPlan`. */
export type PlanLoadedManifest = { manifest: Folio | null; manifestExists: boolean }

export const MANIFEST_WOULD_NOT_FOLLOW = 'This change would update the Index Note but not the Folio manifest, so it was not made. Open the Plan to change this Folio’s order.'

const RUNNING_ORDER = /^##(?!#)\s+Running order(?:\s.*)?$/i
const SECTION_BOUNDARY = /^ {0,3}#{1,6}(?:\s|$)/
const KNOWN_ROLES = new Set<string>(PLAN_ROLES)

function inDir(dir: string, ...parts: string[]): string {
  const joined = parts.filter((part) => part !== '' && part !== '.').join('/')
  return dir === '' ? joined : joined === '' ? dir : posix.join(dir, joined)
}

function splitLines(source: string): LineRecord[] {
  const lines: LineRecord[] = []
  let start = 0
  while (start < source.length) {
    let end = start
    while (end < source.length && source[end] !== '\n' && source[end] !== '\r') end += 1
    if (end === source.length) {
      lines.push({ text: source.slice(start), ending: '' })
      break
    }
    const ending = source[end] === '\r' && source[end + 1] === '\n' ? '\r\n' : source[end]
    lines.push({ text: source.slice(start, end), ending })
    start = end + ending.length
  }
  return lines
}

function joinLines(lines: LineRecord[]): string {
  return lines.map((line) => `${line.text}${line.ending}`).join('')
}

function preferredEnding(lines: LineRecord[]): string {
  return lines.find((line) => line.ending)?.ending ?? '\n'
}

function insertLine(lines: LineRecord[], index: number, text: string): LineRecord {
  const ending = preferredEnding(lines)
  if (index > 0 && lines[index - 1]?.ending === '') lines[index - 1].ending = ending
  const record = { text, ending }
  lines.splice(index, 0, record)
  return record
}

function codeLines(lines: LineRecord[]): boolean[] {
  const skipped = Array.from({ length: lines.length }, () => false)
  let fence: { marker: '`' | '~'; length: number } | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index].text
    if (fence) {
      skipped[index] = true
      const closing = new RegExp(`^ {0,3}${fence.marker === '`' ? '`' : '~'}{${fence.length},}\\s*$`)
      if (closing.test(text)) fence = null
      continue
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(text)
    if (opening) {
      const run = opening[1]
      fence = { marker: run[0] as '`' | '~', length: run.length }
      skipped[index] = true
      continue
    }
    if (/^(?: {4}|\t)/.test(text)) skipped[index] = true
  }
  return skipped
}

function planHeading(lines: LineRecord[]): number {
  const skipped = codeLines(lines)
  return lines.findIndex((line, index) => !skipped[index] && RUNNING_ORDER.test(line.text))
}

/**
 * Whether an Index Note's text declares a Plan: it has the Running order heading `readPlan` finds
 * (level two, any text after "Running order", not inside code). The one rule; nothing else re-tests it.
 */
export function declaresRunningOrder(indexNoteSource: string): boolean {
  return planHeading(splitLines(indexNoteSource)) >= 0
}

function sectionEnd(lines: LineRecord[], headingLine: number, skipped = codeLines(lines)): number {
  for (let line = headingLine + 1; line < lines.length; line += 1) {
    if (!skipped[line] && SECTION_BOUNDARY.test(lines[line].text)) return line
  }
  return lines.length
}

function parseEntries(lines: LineRecord[], headingLine: number): Array<{ record: LineRecord; parsed: PlanLine; line: number }> {
  if (headingLine >= lines.length) return []
  const skipped = codeLines(lines)
  const entries: Array<{ record: LineRecord; parsed: PlanLine; line: number }> = []
  for (let line = headingLine + 1; line < sectionEnd(lines, headingLine, skipped); line += 1) {
    if (skipped[line]) continue
    const parsed = parsePlanLine(lines[line].text)
    if (parsed) entries.push({ record: lines[line], parsed, line })
  }
  return entries
}

function assertIndex(index: number, length: number, allowEnd: boolean): void {
  const upper = allowEnd ? length : length - 1
  if (!Number.isInteger(index) || index < 0 || index > upper) throw new Error('Plan part index is out of range.')
}

async function readOptional(ws: Workspace, path: string): Promise<string | null> {
  try {
    return (await ws.readFile(path)).content
  } catch {
    return null
  }
}

/**
 * The file's text at this instant, read synchronously: for a check made in the tick of a rename. Null
 * only when no file is there (ENOENT). A file that is there and cannot be read throws, which stops the
 * rename: read as absent, it would be taken for "still no manifest" and written over.
 */
function textNow(ws: Workspace, path: string): string | null {
  try {
    return readFileSync(ws.absolute(path), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`"${path.split('/').at(-1) ?? path}" could not be read, so nothing was written over it.`)
  }
}

async function manifestState(ws: Workspace, dir: string): Promise<{ manifest: Folio | null; source: string | null; exists: boolean }> {
  const path = inDir(dir, MANIFEST_NAME)
  const exists = existsSync(ws.absolute(path))
  const source = await readOptional(ws, path)
  const manifest = await readManifest(ws, dir)
  return { manifest, source, exists }
}

function candidateRoot(dir: string, manifest: Folio | null): string {
  return inDir(dir, manifest?.contentRoot ?? '')
}

async function planCandidates(ws: Workspace, dir: string, manifest: Folio | null) {
  const root = candidateRoot(dir, manifest)
  const present = new Set((await ws.listFiles()).map((file) => file.path))
  const listed = new Set(manifest?.files.flatMap((file) => {
    const resolved = resolveManifestFilePath(dir, manifest, file, present)
    return resolved ? [resolved] : []
  }) ?? [])
  return (await collectionCandidates(ws, root)).filter((candidate) => posix.dirname(candidate.path) === (root || '.') || listed.has(candidate.path))
}

/**
 * A running-order line's file. The wikilink rule decides, except that a sync conflict copy never
 * wins over its original when both carry the title (`00_intro-Studio Mac.md` beside
 * `00_intro.md`): the copy would otherwise win whenever it sorts first.
 */
function resolvePlanTitle(indexPath: string, title: string, index: ReturnType<typeof buildWikilinkCandidateIndex>): string | null {
  const resolved = resolveWikilinkTargetFromIndex(indexPath, title, index)
  return resolved.ambiguous ? preferOriginal(resolved.ambiguous) : resolved.to
}

async function parseLoaded(
  ws: Workspace,
  dir: string,
  path: string,
  source: string,
  manifest: Folio | null,
  manifestSource: string | null,
  manifestExists = manifestSource !== null,
  unlisted: PlanPart[] = [],
): Promise<LoadedPlan> {
  const lines = splitLines(source)
  const foundHeading = planHeading(lines)
  const headingLine = foundHeading < 0 ? lines.length : foundHeading
  const candidates = await planCandidates(ws, dir, manifest)
  const candidateIndex = buildWikilinkCandidateIndex(candidates)
  const entries = parseEntries(lines, headingLine).map(({ record, parsed, line }) => ({
    record,
    parsed,
    part: {
      title: parsed.title,
      gloss: parsed.gloss,
      role: parsed.role,
      tags: parsed.tags,
      path: resolvePlanTitle(path, parsed.title, candidateIndex),
      line,
    },
  }))
  return {
    plan: { dir, indexPath: path, headingLine, parts: entries.map((entry) => entry.part), unlisted },
    source,
    lines,
    entries,
    manifest,
    manifestSource,
    manifestExists,
  }
}

function insertionLine(state: LoadedPlan, at: number): number {
  if (state.entries[at]) return state.lines.indexOf(state.entries[at].record)
  if (state.entries.length) return state.lines.indexOf(state.entries.at(-1)!.record) + 1
  if (state.plan.headingLine < state.lines.length) {
    const afterHeading = state.plan.headingLine + 1
    return state.lines[afterHeading]?.text === '' ? afterHeading + 1 : afterHeading
  }
  return state.lines.length
}

function validatePlanText(lines: LineRecord[], intended: PlanLine[]): void {
  const heading = planHeading(lines)
  if (heading < 0) throw new Error('The Plan write lost its Running order heading.')
  const reparsed = parseEntries(lines, heading).map((entry) => entry.parsed)
  const semantic = (line: PlanLine) => ({ title: line.title, gloss: line.gloss, role: line.role, tags: line.tags })
  if (JSON.stringify(reparsed.map(semantic)) !== JSON.stringify(intended.map(semantic))) {
    throw new Error('The Plan write did not round-trip through the Plan-line parser.')
  }
}

function planLineValue(line: PlanLine): Pick<PlanLine, 'title' | 'gloss' | 'role' | 'tags'> {
  return { title: line.title, gloss: line.gloss, role: line.role, tags: line.tags }
}

function samePlanLines(left: PlanLine[], right: PlanLine[]): boolean {
  return JSON.stringify(left.map(planLineValue)) === JSON.stringify(right.map(planLineValue))
}

function removedPlanTitles(current: PlanLine[], intended: PlanLine[]): string[] {
  const remaining = intended.map((line) => JSON.stringify(planLineValue(line)))
  const removed: string[] = []
  for (const line of current) {
    const value = JSON.stringify(planLineValue(line))
    const index = remaining.indexOf(value)
    if (index >= 0) remaining.splice(index, 1)
    else removed.push(line.title)
  }
  return removed
}

/** Hard backstop: only removePart may make a persisted Running order smaller, and only by its target. */
export function assertPlanWritePreservesParts(current: PlanLine[], intended: PlanLine[], removedIndex?: number): void {
  if (intended.length >= current.length) return
  if (removedIndex !== undefined && removedIndex >= 0 && removedIndex < current.length) {
    const allowed = [...current]
    allowed.splice(removedIndex, 1)
    if (samePlanLines(allowed, intended)) return
  }
  const names = removedPlanTitles(current, intended)
  throw new Error(
    `Refusing to update the Index Note because the Plan write would remove parts without an explicit Plan removal: ${names.join(', ') || 'unknown parts'}.`,
  )
}

async function saveIndex(
  ws: Workspace,
  state: LoadedPlan,
  intended: PlanLine[],
  removedIndex?: number,
  beforeWrite?: () => Promise<void>,
): Promise<string> {
  renumberOrderedPlanLines(state)
  const next = joinLines(state.lines)
  validatePlanText(state.lines, intended)
  assertPlanWritePreservesParts(state.entries.map((entry) => entry.parsed), intended, removedIndex)
  const current = await readOptional(ws, state.plan.indexPath)
  if (current !== state.source) throw new Error('The Index Note changed while the Plan was being updated.')
  await beforeWrite?.()
  // The comparison above is followed by awaits (the backups, the temporary file). It is made again in the
  // tick of the rename, so an edit that lands in between stops this write instead of being overwritten.
  await ws.saveFileWithoutReadBack(state.plan.indexPath, next, {
    beforeCommit: () => {
      if (textNow(ws, state.plan.indexPath) !== state.source) throw new Error('The Index Note changed while the Plan was being updated.')
    },
  })
  return next
}

/**
 * The one place a Plan write commits its two documents: the Index Note, then the manifest.
 *
 * What is guaranteed. Every check that can refuse runs before the first byte is written (the caller's,
 * `saveIndex`'s and the manifest's preparation). The Index Note is written only if its bytes are still the
 * ones this write read; the manifest likewise. Each of those comparisons is made twice: once before the
 * temporary file is written, and again in the tick of the rename that commits the write, with nothing
 * awaited between that second comparison and the rename. If the manifest's comparison or its write then
 * fails, the Index Note is put back to the bytes this write read, provided its bytes are still exactly
 * what this write wrote (compared, again, in the tick of the rename that puts them back); the error says
 * nothing was changed. If the Index Note has other bytes by then (something else wrote it), or putting it
 * back fails, it is left alone and the error says the Index Note was updated, the manifest was not, and
 * both must be checked in the Plan. The pristine-copy backups made before the first write are kept either way.
 *
 * What is not guaranteed: the two writes are not one atomic step for another process, and a crash between
 * them leaves the Index Note ahead of the manifest (the backups hold the earliest copies).
 */
async function commitPlanDocuments(
  ws: Workspace,
  state: LoadedPlan,
  intended: PlanLine[],
  manifestWrite: PreparedManifestWrite | null,
  options: PlanWriteOptions,
  removedIndex?: number,
): Promise<void> {
  if (options.requireManifestWrite && !manifestWrite) throw new Error(MANIFEST_WOULD_NOT_FOLLOW)
  await checkpointPlanWrites(options, state, manifestWrite, true)
  const original = state.source
  const written = await saveIndex(ws, state, intended, removedIndex, () => backupPlanDocuments(ws, state))
  try {
    await writePreparedManifest(ws, manifestWrite)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    let restored = false
    try {
      if (await readOptional(ws, state.plan.indexPath) === written) {
        await ws.saveFileWithoutReadBack(state.plan.indexPath, original, {
          allowExplicitEmpty: true,
          // Still exactly what this write wrote, in the tick of the rename: a newer edit is never replaced by the old bytes.
          beforeCommit: () => {
            if (textNow(ws, state.plan.indexPath) !== written) throw new Error('The Index Note changed while it was being put back.')
          },
        })
        restored = true
      }
    } catch {
      restored = false
    }
    throw new Error(restored
      ? `The Folio manifest could not be updated, so the Index Note was put back as it was. Nothing was changed. (${reason})`
      : `The Index Note was updated but the Folio manifest could not be, and the Index Note could not be put back as it was. Check both in the Plan. (${reason})`)
  }
  state.source = written
}

function renumberOrderedPlanLines(state: LoadedPlan): void {
  const firstMarker = state.entries[0]?.parsed.marker
  const match = firstMarker?.match(/^(\d+)\.$/)
  if (!match) return
  let number = Number(match[1])
  for (const entry of parseEntries(state.lines, state.plan.headingLine)) {
    if (!/^\d+\.$/.test(entry.parsed.marker)) continue
    entry.record.text = entry.record.text.replace(/^(\s*)\d+\.(\s+\[\[)/, `$1${number}.$2`)
    number += 1
  }
}

function manifestPath(dir: string): string {
  return inDir(dir, MANIFEST_NAME)
}

function relativeManifestPath(dir: string, contentRoot: string, fullPath: string): string {
  const base = inDir(dir, contentRoot)
  const path = base === '' ? fullPath : posix.relative(base, fullPath)
  if (!path || posix.isAbsolute(path) || path === '..' || path.startsWith('../')) {
    throw new Error(`A Plan part is outside the Folio content_root: ${fullPath}`)
  }
  return path
}

function mergeFallbackOrder(fallback: string[], parts: PlanPart[]): string[] {
  const ordered = [...fallback]
  const written = parts.flatMap((part) => part.path ? [part.path] : [])
  for (let index = 0; index < written.length; index += 1) {
    const path = written[index]
    if (ordered.includes(path)) continue
    const next = written.slice(index + 1).find((candidate) => ordered.includes(candidate))
    if (next) ordered.splice(ordered.indexOf(next), 0, path)
    else {
      const previous = written.slice(0, index).reverse().find((candidate) => ordered.includes(candidate))
      if (previous) ordered.splice(ordered.indexOf(previous) + 1, 0, path)
      else ordered.push(path)
    }
  }
  return ordered
}

export type PreparedManifestWrite = { path: string; current: string | null; next: string }

/**
 * No entry of a manifest whose content_root leaves the folder resolves (folio.ts), so the Plan cannot
 * tell which entries its parts are. Every Plan write stops here, before the Index Note or the manifest
 * is touched; the writer corrects content_root first.
 */
function assertContentRootAccepted(state: LoadedPlan): void {
  if (state.manifest?.contentRootRefused) {
    throw new Error(`Cannot change this Folio’s manifest: its content_root points outside the Folio’s folder. Correct content_root in ${manifestPath(state.plan.dir)}, then try again.`)
  }
}

function assertManifestReadableForWrite(state: LoadedPlan): void {
  if (!state.manifest && state.manifestExists) {
    throw new Error(`Cannot write an unreadable Folio manifest: ${manifestPath(state.plan.dir)}`)
  }
  assertContentRootAccepted(state)
}

export function assertManifestFallbackOrder(paths: string[], dir: string): void {
  const unsafe = paths.find((path) => {
    const name = posix.basename(path)
    return name.startsWith('_') || name.toLocaleLowerCase() === 'readme.md' || name.toLocaleLowerCase() === 'index.md'
  })
  if (unsafe) {
    throw new Error(`Fallback path ${unsafe} cannot enter a Folio manifest because Folio policy excludes it in ${dir || 'the workspace root'}.`)
  }
}

function resolveExistingManifestFile(
  ws: Workspace,
  dir: string,
  manifest: Folio,
  file: FolioFile,
): string | null {
  for (const candidate of manifestFilePathCandidates(dir, manifest, file)) {
    try {
      if (existsSync(ws.absolute(candidate))) return candidate
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Refusing to update the Folio manifest because WriteFlex could not safely resolve ${file.path}: ${reason}`)
    }
  }
  return null
}

type KeptManifestEntries = {
  files: Array<Record<string, unknown>>
  /** Each kept entry's stand-in, to its position in the manifest's `files` array as authored. */
  verbatim: Map<Record<string, unknown>, number>
}

/**
 * Put back the elements of `files` the Plan cannot place: entries that point outside the Folio's folder,
 * and elements that are not entries at all (a bare string, an object with no `path`: the manifest reader
 * skips them). They are never Plan parts, so a write derived from the parts would delete them. Each is
 * kept as authored, byte for byte, and stays immediately after the entry it followed (at the start if it
 * was first); when that entry is removed by this write, after the nearest earlier entry that survives.
 */
function keepEntriesOutsideFolio(state: LoadedPlan, files: Array<Record<string, unknown>>): KeptManifestEntries {
  const verbatim = new Map<Record<string, unknown>, number>()
  if (!state.manifest || state.manifestSource === null) return { files, verbatim }
  const authored = jsonArrayLayout(state.manifestSource, 'files').entries.map((entry) => entry.value)
  const authoredPath = (value: unknown): string | null => (
    typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).path === 'string'
      ? (value as Record<string, unknown>).path as string
      : null
  )
  const manifest = state.manifest
  const outside = authored.map((value) => {
    const path = authoredPath(value)
    return path === null || manifestEntryPointsOutsideFolio(state.plan.dir, manifest, { path })
  })
  if (!outside.includes(true)) return { files, verbatim }

  // Which authored entry each written entry continues: the same first-unused-by-path pairing the
  // surgical rewrite uses. An outside entry is never paired; it has no place a written entry can name.
  const placed = new Map<number, Record<string, unknown>>()
  for (const file of files) {
    const index = authored.findIndex((value, at) => !outside[at] && !placed.has(at) && authoredPath(value) === file.path)
    if (index >= 0) placed.set(index, file)
  }
  const result = [...files]
  for (let index = 0; index < authored.length; index += 1) {
    if (!outside[index]) continue
    // A stand-in the rewrite places by position: the element's own bytes are copied, whatever it is.
    const path = authoredPath(authored[index])
    const kept: Record<string, unknown> = path === null ? {} : { path }
    let before = index - 1
    while (before >= 0 && !placed.has(before)) before -= 1
    result.splice(before >= 0 ? result.indexOf(placed.get(before)!) + 1 : 0, 0, kept)
    placed.set(index, kept)
    verbatim.set(kept, index)
  }
  return { files: result, verbatim }
}

function duplicatePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const path of paths) {
    if (seen.has(path)) duplicates.add(path)
    else seen.add(path)
  }
  return [...duplicates]
}

type DuplicatePlanPath = { path: string; titles: string[]; indexes: number[] }

function duplicatePlanPaths(parts: PlanPart[]): DuplicatePlanPath[] {
  const byPath = new Map<string, { titles: string[]; indexes: number[] }>()
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    if (!part.path) continue
    const group = byPath.get(part.path)
    if (group) {
      group.titles.push(part.title)
      group.indexes.push(index)
    } else {
      byPath.set(part.path, { titles: [part.title], indexes: [index] })
    }
  }
  return [...byPath].flatMap(([path, group]) => group.indexes.length > 1 ? [{ path, ...group }] : [])
}

function duplicatePlanMessage(groups: DuplicatePlanPath[]): string {
  const titles = [...new Set(groups.flatMap((group) => group.titles))]
  return `The Plan has duplicate titles that resolve to the same file: ${titles.join(', ')}. Rename or remove one of those Plan parts before changing it.`
}

function assertPlanPartPathIsUnambiguous(parts: PlanPart[], index: number): void {
  const groups = duplicatePlanPaths(parts).filter((group) => group.indexes.includes(index))
  if (groups.length) throw new Error(duplicatePlanMessage(groups))
}

function assertMaterialiseTitleIsUnique(parts: PlanPart[], index: number): void {
  const title = parts[index].title
  const matches = parts.filter((part) => part.title.toLocaleLowerCase() === title.toLocaleLowerCase())
  if (matches.length > 1) {
    throw new Error(`The Plan has a duplicate title: ${title}. Rename or remove one of the ${title} parts before writing it.`)
  }
}

function assertNoNewDuplicatePlanPaths(current: PlanPart[], prospective: PlanPart[]): void {
  const currentCounts = new Map(duplicatePlanPaths(current).map((group) => [group.path, group.indexes.length]))
  const added = duplicatePlanPaths(prospective).filter((group) => group.indexes.length > (currentCounts.get(group.path) ?? 1))
  if (added.length) throw new Error(duplicatePlanMessage(added))
}

/** The last lines of the prospective Plan are the adopted ones: each must resolve to the file it was written for. */
function assertAdoptedLinesResolveToChosenFiles(prospective: PlanPart[], chosen: PlanPart[], inPlanView = false): void {
  const adopted = prospective.slice(prospective.length - chosen.length)
  chosen.forEach((part, at) => {
    if (adopted[at]?.path !== part.path) {
      throw new Error(`Two files here share the title "${part.title}". ${inPlanView ? 'Rename one, then add it. Nothing was added.' : 'Rename one, or add it from the Plan.'}`)
    }
  })
}

function newManifestPath(dir: string, manifest: Folio | null, contentRoot: string, fullPath: string): string {
  const relative = relativeManifestPath(dir, contentRoot, fullPath)
  if (!manifest || !contentRoot || !manifest.files.length) return relative
  const prefix = `${contentRoot}/`
  const prefixed = manifest.files.filter((file) => file.path.startsWith(prefix)).length
  const unprefixed = manifest.files.length - prefixed
  return prefixed > unprefixed || (prefixed === unprefixed && manifest.files[0].path.startsWith(prefix))
    ? posix.join(contentRoot, relative)
    : relative
}

export function manifestSiblingEntries(source: string | null): Array<Record<string, unknown>> {
  if (source === null) return []
  const parsed = JSON.parse(source) as { files?: unknown }
  return Array.isArray(parsed.files)
    ? parsed.files.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    : []
}

/**
 * The entry a manifest gains for a file it does not list yet: the one shape, whoever adds it (a Plan
 * write here, or the Outline's Add to a Folio with no Index Note, folio-manifest-order.ts). The path follows
 * the convention the manifest's other entries use for `content_root`; an `id` only when siblings carry
 * ids; a `role` when the part's is not `section` or siblings carry roles.
 */
export function newManifestEntry(
  dir: string,
  manifest: Folio | null,
  siblings: Array<Record<string, unknown>>,
  fullPath: string,
  part: Pick<PlanPart, 'title' | 'role'> | undefined,
): Record<string, unknown> {
  const siblingsHaveIds = siblings.some((entry) => typeof entry.id === 'string')
  const siblingsHaveRoles = siblings.some((entry) => typeof entry.role === 'string')
  return {
    ...(siblingsHaveIds && part ? { id: slugifyFileName(part.title).replace(/\.md$/i, '') } : {}),
    path: newManifestPath(dir, manifest, manifest?.contentRoot ?? '', fullPath),
    ...(part && (part.role !== 'section' || siblingsHaveRoles) ? { role: part.role } : {}),
  }
}

async function assertManifestWritePreservesExistingFiles(
  ws: Workspace,
  state: LoadedPlan,
  files: Array<Record<string, unknown>>,
  allowedRemovedPath: string | null,
): Promise<void> {
  if (!state.manifest) return
  const remaining = new Map<string, number>()
  for (const file of files) {
    const path = file.path
    if (typeof path === 'string') remaining.set(path, (remaining.get(path) ?? 0) + 1)
  }
  let usedAllowedRemoval = false
  const threatened: string[] = []
  for (const file of state.manifest.files) {
    const count = remaining.get(file.path) ?? 0
    if (count > 0) {
      remaining.set(file.path, count - 1)
      continue
    }
    const existingPath = resolveExistingManifestFile(ws, state.plan.dir, state.manifest, file)
    if (!existingPath) continue
    if (!usedAllowedRemoval && allowedRemovedPath === existingPath) {
      usedAllowedRemoval = true
      continue
    }
    threatened.push(file.path)
  }
  if (threatened.length) {
    throw new Error(
      `Refusing to update the Folio manifest because the write would remove entries for files that still exist: ${threatened.join(', ')}. The report structure was left unchanged.`,
    )
  }
}

async function prepareManifestWrite(
  ws: Workspace,
  state: LoadedPlan,
  parts: PlanPart[],
  create: boolean,
  fallbackOrder: string[] = [],
  allowedRemovedPath: string | null = null,
  preserved: PlanPart[] = [],
): Promise<PreparedManifestWrite | null> {
  assertManifestReadableForWrite(state)
  assertManifestFallbackOrder(fallbackOrder, state.plan.dir)
  if (!state.manifest && !create) return null
  const contentRoot = state.manifest?.contentRoot ?? ''
  const writtenPaths = parts.flatMap((part) => part.path ? [part.path] : [])
  let orderedPaths = state.manifest
    ? writtenPaths
    : mergeFallbackOrder(fallbackOrder, parts)
  if (state.manifest && preserved.length) {
    const present = new Set((await ws.listFiles()).map((file) => file.path))
    const preservedCounts = new Map<string, number>()
    for (const part of preserved) {
      if (part.path) preservedCounts.set(part.path, (preservedCounts.get(part.path) ?? 0) + 1)
    }
    const remainingWritten = [...writtenPaths]
    orderedPaths = []
    for (const file of state.manifest.files) {
      const resolved = resolveManifestFilePath(state.plan.dir, state.manifest, file, present)
      if (!resolved) continue
      const preserveCount = preservedCounts.get(resolved) ?? 0
      if (preserveCount > 0) {
        orderedPaths.push(resolved)
        preservedCounts.set(resolved, preserveCount - 1)
      } else {
        const next = remainingWritten.shift()
        if (next) orderedPaths.push(next)
      }
    }
    orderedPaths.push(...remainingWritten)
  }
  const duplicates = duplicatePaths(orderedPaths)
  if (duplicates.length) {
    const groups = duplicatePlanPaths(parts).filter((group) => duplicates.includes(group.path))
    throw new Error(groups.length ? duplicatePlanMessage(groups) : 'The Plan has duplicate titles. Rename or remove one before changing it.')
  }
  const partByPath = new Map(parts.flatMap((part) => part.path ? [[part.path, part] as const] : []))
  const previousByPath = new Map<string, FolioFile[]>()
  if (state.manifest) {
    const present = new Set((await ws.listFiles()).map((file) => file.path))
    for (const file of state.manifest.files) {
      const resolved = resolveManifestFilePath(state.plan.dir, state.manifest, file, present)
      if (!resolved) continue
      const bucket = previousByPath.get(resolved)
      if (bucket) bucket.push(file)
      else previousByPath.set(resolved, [file])
    }
  }
  const siblings = manifestSiblingEntries(state.manifestSource)
  const partFiles = orderedPaths.map((fullPath) => {
    const previous = previousByPath.get(fullPath)?.shift()
    const part = partByPath.get(fullPath)
    if (previous) return { path: previous.path, ...(part && part.role !== 'section' ? { role: part.role } : {}) }
    return newManifestEntry(state.plan.dir, state.manifest, siblings, fullPath, part)
  })
  const path = manifestPath(state.plan.dir)
  const current = await readOptional(ws, path)
  if (current !== state.manifestSource) throw new Error('The Folio manifest changed while the Plan was being updated.')
  const { files, verbatim } = keepEntriesOutsideFolio(state, partFiles)
  await assertManifestWritePreservesExistingFiles(ws, state, files, allowedRemovedPath)
  const next = state.manifestSource === null
    ? `${JSON.stringify({ schema_version: 1, content_root: contentRoot, files }, null, 2)}\n`
    : rewriteJsonArrayByKey(state.manifestSource, 'files', 'path', files, verbatim)
  return next === current ? null : { path, current, next }
}

async function prepareManifestWriteIfUnambiguous(
  ws: Workspace,
  state: LoadedPlan,
  parts: PlanPart[],
  create: boolean,
  fallbackOrder: string[] = [],
  allowedRemovedPath: string | null = null,
  preserved: PlanPart[] = [],
): Promise<PreparedManifestWrite | null> {
  if (duplicatePlanPaths(parts).length) return null
  return prepareManifestWrite(ws, state, parts, create, fallbackOrder, allowedRemovedPath, preserved)
}

/**
 * The one manifest write: only if the manifest's bytes are still the ones the caller read, then to a
 * temporary file beside it and a rename over it (`Workspace.saveFile`), so a reader sees the old manifest
 * or the new one. The bytes are compared before the temporary file is written and once more in the tick
 * of the rename (`current` null = there must still be no manifest). The caller's `beforeCommit` runs in
 * that same tick, after the comparison, and throws to stop the rename.
 */
export async function writePreparedManifest(
  ws: Workspace,
  prepared: PreparedManifestWrite | null,
  beforeWrite?: () => Promise<void>,
  beforeCommit?: () => void,
): Promise<void> {
  if (!prepared) return
  if (await readOptional(ws, prepared.path) !== prepared.current) {
    throw new Error('The Folio manifest changed while the Plan was being updated.')
  }
  await beforeWrite?.()
  await ws.saveFileWithoutReadBack(prepared.path, prepared.next, {
    beforeCommit: () => {
      if (textNow(ws, prepared.path) !== prepared.current) throw new Error('The Folio manifest changed while the Plan was being updated.')
      beforeCommit?.()
    },
  })
}

export const PLAN_BACKUP_SUFFIX = '.writeflex-backup'

/**
 * The two pristine-copy backups a Plan write in `dir` may create: the Index Note's and the
 * manifest's. Each is written once, before the first write that touches its document, and then
 * kept as the earliest copy. A caller that must take a step back without trace (an undone
 * running-order proposal) snapshots the ones absent beforehand, so the undo removes them again.
 */
export function planBackupPaths(ws: Pick<Workspace, 'root'>, dir: string): string[] {
  return [`${indexNotePath(ws, dir)}${PLAN_BACKUP_SUFFIX}`, `${manifestPath(dir)}${PLAN_BACKUP_SUFFIX}`]
}

async function backupPlanDocuments(ws: Workspace, state: LoadedPlan): Promise<void> {
  const indexBackup = `${state.plan.indexPath}${PLAN_BACKUP_SUFFIX}`
  if (!existsSync(ws.absolute(indexBackup))) {
    await ws.saveFileWithoutReadBack(indexBackup, state.source, { allowExplicitEmpty: true })
  }
  if (state.manifestSource === null) return
  await backupManifestDocument(ws, state.plan.dir, state.manifestSource)
}

/** The manifest's pristine copy: written once, before the first write that touches the manifest, then kept. */
export async function backupManifestDocument(ws: Workspace, dir: string, source: string): Promise<void> {
  const manifestBackup = `${manifestPath(dir)}${PLAN_BACKUP_SUFFIX}`
  if (!existsSync(ws.absolute(manifestBackup))) {
    await ws.saveFileWithoutReadBack(manifestBackup, source, { allowExplicitEmpty: true })
  }
}

async function checkpointPlanWrites(
  options: PlanWriteOptions,
  state: LoadedPlan,
  manifestWrite: PreparedManifestWrite | null,
  writesIndex: boolean,
): Promise<void> {
  if (writesIndex) await options.beforeIndexWrite?.(state.plan.indexPath)
  if (manifestWrite && manifestWrite.current !== null) await options.beforeManifestWrite?.(manifestWrite.path)
}

async function loadPlan(ws: Workspace, dir: string): Promise<LoadedPlan | null> {
  const path = indexNotePath(ws, dir)
  if (!(await ws.listFiles()).some((file) => file.path === path)) return null
  const source = (await ws.readFile(path)).content
  const { manifest, source: manifestSource, exists: manifestExists } = await manifestState(ws, dir)
  const state = await parseLoaded(ws, dir, path, source, manifest, manifestSource, manifestExists)

  const present = new Set((await ws.listFiles()).map((file) => file.path))
  const candidates = await planCandidates(ws, dir, manifest)
  const manifestCandidates = manifest
    ? manifest.files.flatMap((file) => {
        const fullPath = resolveManifestFilePath(dir, manifest, file, present)
        if (!fullPath) return []
        const candidate = candidates.find((item) => item.path === fullPath)
        return candidate ? [{ authoredPath: file.path, file, fullPath, candidate }] : []
      })
    : []
  const planned = new Set<string>()
  for (const part of state.plan.parts) {
    const exact = manifestCandidates.find((item) => !planned.has(item.authoredPath) && item.fullPath === part.path)
    const byTitle = manifestCandidates.find((item) => (
      !planned.has(item.authoredPath) && item.candidate.title.toLocaleLowerCase() === part.title.toLocaleLowerCase()
    ))
    const matched = exact ?? byTitle
    if (matched) planned.add(matched.authoredPath)
  }
  const unlisted: PlanPart[] = []
  const unlistedPaths = new Set<string>()
  for (const item of manifestCandidates) {
    if (planned.has(item.authoredPath)) continue
    const content = (await ws.readFile(item.fullPath)).content
    const frontmatter = parseFrontmatter(content)
    const part: PlanPart = {
      title: item.candidate.title,
      gloss: frontmatter?.description?.trim() || frontmatter?.purpose?.trim() || null,
      role: item.file.role && KNOWN_ROLES.has(item.file.role.toLocaleLowerCase()) ? item.file.role.toLocaleLowerCase() : 'section',
      tags: frontmatter?.tags ?? [],
      path: item.fullPath,
      line: -1,
      manifestBacked: true,
    }
    try {
      serialisePlanLine(part, state.entries[0]?.parsed.marker ?? '-')
    } catch {
      continue
    }
    unlisted.push(part)
    unlistedPaths.add(item.fullPath)
    planned.add(item.authoredPath)
  }
  const plannedPaths = new Set(state.plan.parts.flatMap((part) => part.path ? [part.path] : []))
  const titleMatterPath = manifest?.titleMatter
    ? manifestFilePathCandidates(dir, manifest, { path: manifest.titleMatter }).find((candidate) => present.has(candidate)) ?? null
    : null
  for (const fullPath of await fallbackFolioParts(ws, candidateRoot(dir, manifest))) {
    if (fullPath === titleMatterPath || plannedPaths.has(fullPath) || unlistedPaths.has(fullPath)) continue
    const candidate = candidates.find((item) => item.path === fullPath)
    if (!candidate) continue
    const content = (await ws.readFile(fullPath)).content
    const frontmatter = parseFrontmatter(content)
    const frontmatterRole = typeof frontmatter?.extra.role === 'string'
      ? frontmatter.extra.role.trim().toLocaleLowerCase()
      : ''
    const part: PlanPart = {
      title: candidate.title,
      gloss: frontmatter?.description?.trim() || frontmatter?.purpose?.trim() || null,
      role: KNOWN_ROLES.has(frontmatterRole) ? frontmatterRole : 'section',
      tags: frontmatter?.tags ?? [],
      path: fullPath,
      line: -1,
      manifestBacked: false,
    }
    try {
      serialisePlanLine(part, state.entries[0]?.parsed.marker ?? '-')
    } catch {
      continue
    }
    unlisted.push(part)
    unlistedPaths.add(fullPath)
  }
  state.plan.unlisted = unlisted
  return state
}

function requirePlan(state: LoadedPlan | null): LoadedPlan {
  if (!state) throw new Error('This folder has no Index Note for its Plan.')
  return state
}

function ensureHeading(state: LoadedPlan): void {
  if (state.plan.headingLine < state.lines.length) return
  insertLine(state.lines, state.lines.length, '## Running order')
  insertLine(state.lines, state.lines.length, '')
  state.plan.headingLine = state.lines.length - 2
}

function requireWritablePlan(state: LoadedPlan | null): LoadedPlan {
  const loaded = requirePlan(state)
  assertContentRootAccepted(loaded)
  return loaded
}

async function finalPlan(ws: Workspace, dir: string): Promise<Plan> {
  return requirePlan(await loadPlan(ws, dir)).plan
}

/**
 * A Plan write whose two documents were written, and whose Plan could not be read again afterwards. It
 * is not a refusal: the change is on disk. A caller that answers "was it made?" treats this as made.
 */
export class PlanWrittenButNotReRead extends Error {
  constructor(readonly indexPath: string, readonly reason: string) {
    super(`The change was made, but the Plan could not be read again afterwards. (${reason})`)
    this.name = 'PlanWrittenButNotReRead'
  }
}

/** The Plan as it stands after `commitPlanDocuments` returned. A failure here is a failed read of a made change. */
async function planAfterCommit(ws: Workspace, state: LoadedPlan): Promise<Plan> {
  try {
    return await finalPlan(ws, state.plan.dir)
  } catch (error) {
    throw new PlanWrittenButNotReRead(state.plan.indexPath, error instanceof Error ? error.message : String(error))
  }
}

async function prospectivePlanParts(ws: Workspace, state: LoadedPlan): Promise<PlanPart[]> {
  return (await parseLoaded(
    ws,
    state.plan.dir,
    state.plan.indexPath,
    joinLines(state.lines),
    state.manifest,
    state.manifestSource,
    state.manifestExists,
    [],
  )).plan.parts
}

export async function readPlan(ws: Workspace, dir: string): Promise<Plan | null> {
  return (await loadPlan(ws, dir))?.plan ?? null
}

/** The Plan with the manifest of the same read (what `verifyPlan` is given), for a caller that must judge the two together. */
export async function readPlanWithManifest(ws: Workspace, dir: string): Promise<{ plan: Plan; loaded: PlanLoadedManifest } | null> {
  const state = await loadPlan(ws, dir)
  return state ? { plan: state.plan, loaded: { manifest: state.manifest, manifestExists: state.manifestExists } } : null
}

async function insertPartUnlocked(
  ws: Workspace,
  dir: string,
  at: number,
  part: { title: string; gloss?: string; role?: string },
  options: PlanWriteOptions = {},
): Promise<Plan> {
  const state = requireWritablePlan(await loadPlan(ws, dir))
  assertIndex(at, state.entries.length, true)
  const marker = state.entries[0]?.parsed.marker ?? '-'
  const line = serialisePlanLine(part, marker)
  const parsed = parsePlanLine(line)
  if (!parsed) throw new Error('The inserted Plan line did not round-trip through the parser.')
  ensureHeading(state)
  insertLine(state.lines, insertionLine(state, at), line)
  const intended = [...state.entries.map((entry) => entry.parsed)]
  intended.splice(at, 0, parsed)
  const parts = await prospectivePlanParts(ws, state)
  assertNoNewDuplicatePlanPaths(state.plan.parts, parts)
  const manifestWrite = await prepareManifestWriteIfUnambiguous(ws, state, parts, false, [], null, state.plan.unlisted)
  await commitPlanDocuments(ws, state, intended, manifestWrite, options)
  return planAfterCommit(ws, state)
}

async function movePartUnlocked(ws: Workspace, dir: string, from: number, to: number, options: PlanWriteOptions = {}): Promise<Plan> {
  const state = requireWritablePlan(await loadPlan(ws, dir))
  await options.verifyPlan?.(state.plan, { manifest: state.manifest, manifestExists: state.manifestExists })
  assertIndex(from, state.entries.length, false)
  assertIndex(to, state.entries.length, false)
  assertPlanPartPathIsUnambiguous(state.plan.parts, from)
  const intended = state.entries.map((entry) => entry.parsed)
  if (from !== to) {
    const [movedParsed] = intended.splice(from, 1)
    intended.splice(to, 0, movedParsed)

    const moved = state.entries[from].record
    state.lines.splice(state.lines.indexOf(moved), 1)
    const remaining = state.entries.filter((_, index) => index !== from)
    const target = remaining[to]
      ? state.lines.indexOf(remaining[to].record)
      : remaining.length ? state.lines.indexOf(remaining.at(-1)!.record) + 1 : state.plan.headingLine + 1
    state.lines.splice(target, 0, moved)
  }

  const parts = await prospectivePlanParts(ws, state)
  const manifestWrite = await prepareManifestWriteIfUnambiguous(ws, state, parts, false, [], null, state.plan.unlisted)
  await commitPlanDocuments(ws, state, intended, manifestWrite, options)
  return planAfterCommit(ws, state)
}

async function removePartUnlocked(ws: Workspace, dir: string, index: number, options: PlanWriteOptions = {}): Promise<Plan> {
  const state = requireWritablePlan(await loadPlan(ws, dir))
  await options.verifyPlan?.(state.plan, { manifest: state.manifest, manifestExists: state.manifestExists })
  assertIndex(index, state.entries.length, false)
  const removedPath = state.plan.parts[index].path
  const intended = state.entries.map((entry) => entry.parsed)
  intended.splice(index, 1)
  state.lines.splice(state.lines.indexOf(state.entries[index].record), 1)
  const parts = await prospectivePlanParts(ws, state)
  const manifestWrite = await prepareManifestWriteIfUnambiguous(ws, state, parts, false, [], removedPath, state.plan.unlisted)
  await commitPlanDocuments(ws, state, intended, manifestWrite, options, index)
  return planAfterCommit(ws, state)
}

/**
 * Set one part's role (ticket 09: the agent's `setRole` change). The line keeps its title, gloss,
 * other tags, marker and indentation; the Folio manifest's role follows through the same write path
 * as every other Plan operation.
 */
async function setPartRoleUnlocked(
  ws: Workspace,
  dir: string,
  index: number,
  role: string,
  options: PlanWriteOptions = {},
): Promise<Plan> {
  const state = requireWritablePlan(await loadPlan(ws, dir))
  assertIndex(index, state.entries.length, false)
  assertPlanPartPathIsUnambiguous(state.plan.parts, index)
  const entry = state.entries[index]
  const indent = /^\s*/.exec(entry.record.text)?.[0] ?? ''
  const line = serialisePlanLine({ title: entry.parsed.title, gloss: entry.parsed.gloss, role, tags: entry.parsed.tags }, entry.parsed.marker)
  const parsed = parsePlanLine(line)
  if (!parsed) throw new Error('The Plan line with its new role did not round-trip through the parser.')
  if (parsed.role === entry.parsed.role) return state.plan
  entry.record.text = `${indent}${line}`
  const intended = state.entries.map((item, itemIndex) => (itemIndex === index ? parsed : item.parsed))
  const parts = await prospectivePlanParts(ws, state)
  const manifestWrite = await prepareManifestWriteIfUnambiguous(ws, state, parts, false, [], null, state.plan.unlisted)
  await commitPlanDocuments(ws, state, intended, manifestWrite, options)
  return planAfterCommit(ws, state)
}

async function adoptPartUnlocked(
  ws: Workspace,
  dir: string,
  unlistedIndex: number,
  options: PlanWriteOptions = {},
): Promise<Plan> {
  const state = requireWritablePlan(await loadPlan(ws, dir))
  assertIndex(unlistedIndex, state.plan.unlisted.length, false)
  const part = state.plan.unlisted[unlistedIndex]
  const marker = state.entries[0]?.parsed.marker ?? '-'
  const line = serialisePlanLine(part, marker)
  const parsed = parsePlanLine(line)
  if (!parsed) throw new Error('The adopted Plan line did not round-trip through the parser.')
  ensureHeading(state)
  insertLine(state.lines, insertionLine(state, state.entries.length), line)
  const intended = [...state.entries.map((entry) => entry.parsed), parsed]
  const parts = await prospectivePlanParts(ws, state)
  // The line names the file by title, and another file may carry the same title: the line must resolve to the file chosen.
  assertAdoptedLinesResolveToChosenFiles(parts, [part], true)
  assertNoNewDuplicatePlanPaths(state.plan.parts, parts)
  const preserved = state.plan.unlisted.filter((_, index) => index !== unlistedIndex)
  const manifestWrite = await prepareManifestWriteIfUnambiguous(ws, state, parts, false, [], null, preserved)
  await commitPlanDocuments(ws, state, intended, manifestWrite, options)
  return planAfterCommit(ws, state)
}

/**
 * Adopt several unlisted parts at the end of the running order in one write: the same steps as
 * `adoptPart`, with the same guards, run once for all of them, and one more: each new line must resolve
 * to exactly the file chosen (a line names a file by title, and another file may carry the same title).
 * Every check that can refuse happens before the first byte is written, so a refusal adopts none. The
 * commit is `commitPlanDocuments`: Index Note, then manifest, with the Index Note put back if the manifest
 * cannot be written; see there for exactly what that does and does not guarantee. Parts land in the
 * order of `unlistedIndices`.
 */
async function adoptPartsUnlocked(
  ws: Workspace,
  dir: string,
  unlistedIndices: number[],
  options: PlanWriteOptions = {},
): Promise<Plan> {
  const state = requireWritablePlan(await loadPlan(ws, dir))
  await options.verifyPlan?.(state.plan, { manifest: state.manifest, manifestExists: state.manifestExists })
  if (unlistedIndices.length === 0) throw new Error('There is nothing to adopt.')
  if (new Set(unlistedIndices).size !== unlistedIndices.length) throw new Error('A Plan part cannot be adopted twice.')
  for (const index of unlistedIndices) assertIndex(index, state.plan.unlisted.length, false)
  const marker = state.entries[0]?.parsed.marker ?? '-'
  const adopted = unlistedIndices.map((index) => {
    const line = serialisePlanLine(state.plan.unlisted[index], marker)
    const parsed = parsePlanLine(line)
    if (!parsed) throw new Error('The adopted Plan line did not round-trip through the parser.')
    return { line, parsed }
  })
  ensureHeading(state)
  const at = insertionLine(state, state.entries.length)
  adopted.forEach((item, offset) => { insertLine(state.lines, at + offset, item.line) })
  const intended = [...state.entries.map((entry) => entry.parsed), ...adopted.map((item) => item.parsed)]
  const parts = await prospectivePlanParts(ws, state)
  assertAdoptedLinesResolveToChosenFiles(parts, unlistedIndices.map((index) => state.plan.unlisted[index]))
  assertNoNewDuplicatePlanPaths(state.plan.parts, parts)
  const chosen = new Set(unlistedIndices)
  const preserved = state.plan.unlisted.filter((_, index) => !chosen.has(index))
  const manifestWrite = await prepareManifestWriteIfUnambiguous(ws, state, parts, false, [], null, preserved)
  await commitPlanDocuments(ws, state, intended, manifestWrite, options)
  return planAfterCommit(ws, state)
}

async function materialisePartUnlocked(
  ws: Workspace,
  dir: string,
  index: number,
  options: PlanWriteOptions = {},
): Promise<{ plan: Plan; path: string }> {
  const preflight = requirePlan(await loadPlan(ws, dir))
  assertManifestReadableForWrite(preflight)
  assertIndex(index, preflight.entries.length, false)
  assertMaterialiseTitleIsUnique(preflight.plan.parts, index)
  const preflightPart = preflight.plan.parts[index]
  if (preflightPart.path) throw new Error('This Plan part is already written.')
  const preflightRoot = preflight.manifest?.contentRoot ?? ''
  const preflightName = `${String(index + 1).padStart(2, '0')}-${slugifyFileName(preflightPart.title)}`
  const preflightPath = inDir(dir, preflightRoot, preflightName)
  if ((await ws.listFiles()).some((file) => file.path === preflightPath)) throw new Error(`The Plan part path already exists: ${preflightPath}`)

  const state = requireWritablePlan(await loadPlan(ws, dir))
  assertIndex(index, state.entries.length, false)
  assertMaterialiseTitleIsUnique(state.plan.parts, index)
  const part = state.plan.parts[index]
  if (part.path) throw new Error('This Plan part is already written.')
  const contentRoot = state.manifest?.contentRoot ?? ''
  const filename = `${String(index + 1).padStart(2, '0')}-${slugifyFileName(part.title)}`
  const path = inDir(dir, contentRoot, filename)
  if (path !== preflightPath) throw new Error('The Plan changed while the part was being prepared.')
  const prospective = state.plan.parts.map((item, partIndex) => partIndex === index ? { ...item, path } : item)

  const create = () => createCollectionStub(ws, {
    dir,
    path,
    title: part.title,
    gist: part.gloss ?? '',
    role: part.role,
    titleInFrontmatter: true,
    suppressBacklink: true,
    ...(part.gloss ? { bodyLead: part.gloss } : {}),
  })
  let created
  if (state.manifest) {
    const manifestWrite = await prepareManifestWriteIfUnambiguous(ws, state, prospective, true, [], null, state.plan.unlisted)
    await checkpointPlanWrites(options, state, manifestWrite, false)
    if (manifestWrite) {
      await writePreparedManifest(ws, manifestWrite, () => backupPlanDocuments(ws, state))
    } else {
      await backupPlanDocuments(ws, state)
    }
    created = await create()
  } else {
    const fallbackOrder = await orderFor(ws, dir)
    await backupPlanDocuments(ws, state)
    created = await create()
    if (created.created) {
      const manifestWrite = await prepareManifestWriteIfUnambiguous(ws, state, prospective, true, fallbackOrder, null, state.plan.unlisted)
      await checkpointPlanWrites(options, state, manifestWrite, false)
      await writePreparedManifest(ws, manifestWrite)
    }
  }
  if (!created.created) throw new Error(`A file already resolves the Plan part: ${part.title}`)
  return { plan: await finalPlan(ws, dir), path: created.path }
}

// Every Plan write runs under the Folio's lock (plan-lock.ts): one writer at a time per Folio, whoever calls.

export function insertPart(ws: Workspace, dir: string, at: number, part: { title: string; gloss?: string; role?: string }, options: PlanWriteOptions = {}): Promise<Plan> {
  return withPlanLock(ws, dir, () => insertPartUnlocked(ws, dir, at, part, options))
}

export function movePart(ws: Workspace, dir: string, from: number, to: number, options: PlanWriteOptions = {}): Promise<Plan> {
  return withPlanLock(ws, dir, () => movePartUnlocked(ws, dir, from, to, options))
}

export function removePart(ws: Workspace, dir: string, index: number, options: PlanWriteOptions = {}): Promise<Plan> {
  return withPlanLock(ws, dir, () => removePartUnlocked(ws, dir, index, options))
}

export function setPartRole(ws: Workspace, dir: string, index: number, role: string, options: PlanWriteOptions = {}): Promise<Plan> {
  return withPlanLock(ws, dir, () => setPartRoleUnlocked(ws, dir, index, role, options))
}

export function adoptPart(ws: Workspace, dir: string, unlistedIndex: number, options: PlanWriteOptions = {}): Promise<Plan> {
  return withPlanLock(ws, dir, () => adoptPartUnlocked(ws, dir, unlistedIndex, options))
}

export function adoptParts(ws: Workspace, dir: string, unlistedIndices: number[], options: PlanWriteOptions = {}): Promise<Plan> {
  return withPlanLock(ws, dir, () => adoptPartsUnlocked(ws, dir, unlistedIndices, options))
}

export function materialisePart(ws: Workspace, dir: string, index: number, options: PlanWriteOptions = {}): Promise<{ plan: Plan; path: string }> {
  return withPlanLock(ws, dir, () => materialisePartUnlocked(ws, dir, index, options))
}

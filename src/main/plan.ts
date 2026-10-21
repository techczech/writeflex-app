import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, relative, sep } from 'node:path'
import { isListedPath } from './document-path'
import {
  MANIFEST_NAME,
  folioPartsUnderRoot,
  indexNotePath,
  manifestEntryPointsOutsideFolio,
  manifestFilePathCandidates,
  orderFor,
  parseManifest,
  readManifest,
  resolveManifestFilePath,
  titleMatterPath,
  type Folio,
  type FolioFile,
} from './folio'
import { indexNoteStarterText } from './collection'
import { indexNoteCreationRefusal, pathIsTaken } from './folio-index-note'
import { candidateTitle, collectionCandidates, buildWikilinkCandidateIndex, createCollectionStub, isPathLink, pathLinkNewFile, resolveWikilinkTargetFromIndex, type Candidate, type CandidateIndex } from './wikilinks'
import { NameTaken, slugifyFileName, type Workspace } from './workspace'
import { subFolderOf } from '../shared/folio-outline'
import { PLAN_ROLES, parsePlanLine, serialisePlanLine, type PlanLine, type PlanLineMarker } from '../shared/plan-line'
import { jsonArrayLayout, rewriteJsonArrayByKey, rewriteJsonArrayEntryProperty } from './json-array-layout'
import { parseFrontmatter } from './frontmatter'
import { isConflictCopyAmong, preferOriginal } from '../shared/conflict-copy'
import { isAgentInstructionsName } from '../shared/folio-agent-files'
import { withPlanLock } from './plan-lock'
import { fingerprintOfRead } from './guarded-document-read'
import { partTitle, type PartTitle } from '../shared/folio-part-title'
import { frontMatterPathSet } from './folio-front-matter'
import { isNotInOutlineName } from '../shared/folio-part-name'
import { planCardRefusal, STALE_PUT_BACK_MESSAGE, type PlanCardKey } from '../shared/folio-running-order'
import { factsReader } from './file-facts'
import {
  FRONT_MATTER_ROLE,
  asFrontMatterTitle,
  assertFrontMatterStaysLeading,
  frontBlockEnd,
  frontMatterLeads,
  headerSaysFrontMatter,
  headerSaysTitlePage,
  isFrontMatterRole,
  manifestEntryIsFrontMatter,
  manifestEntryOffersFrontMatter,
  moveStaysInBlock,
  partIsFrontMatter,
  TITLE_PAGE_SET_IN_MANIFEST,
  placeInOrder,
  FRONT_MATTER_STAYS_LEADING,
} from '../shared/folio-front-matter'

export type PlanPart = {
  title: string
  gloss: string | null
  role: string
  tags: string[]
  path: string | null
  line: number
  /** Set on unlisted parts so the renderer can state whether the manifest compiles them. */
  manifestBacked?: boolean
  /** Set on an unlisted part the Plan cannot write as a running-order line (its title has `#`, `|` or `]]`): shown with Open only; this is why Put back is off. */
  putBackRefusal?: string
  /** The folder an unlisted file is in, relative to the Folio's piece root; absent for a file directly in it. */
  under?: string
  /** The part file's title and heading state (shared/folio-part-title.ts), for a part that resolves to a file. */
  heading?: PartTitle & { fingerprint?: string; frontMatter?: true }
  /**
   * A title page (ADR-0046): its file's header says `role: title-matter`, or it is the manifest's `title_matter`
   * file. A front-matter title page is the export's cover.
   */
  titlePage?: true
  /**
   * The manifest's `title_matter` file (ADR-0046): front matter whatever its role says, so the role menu offers no
   * role that would take it out (`TITLE_PAGE_SET_IN_MANIFEST`).
   */
  manifestTitlePage?: true
  /**
   * Only on unlisted parts: "Add as front matter" is offered. The file is the manifest's `title_matter`, its header
   * says `role: title-matter` or `front-matter`, or its manifest entry reads as front matter or says `toc: false`.
   */
  frontMatterOffer?: true
}

export type Plan = {
  dir: string
  indexPath: string
  headingLine: number
  parts: PlanPart[]
  unlisted: PlanPart[]
  /**
   * The running order is the manifest's: the Index Note names no part yet (no Running order heading, or one with
   * no part under it), or there is no Index Note file yet (`readFolioPlan`). `parts` are the lines the first Plan
   * write puts under "## Running order", in the manifest's order; that write then makes its own change, in the same
   * write (`withManifestOrder`). Nothing is written by a read.
   */
  orderFrom?: 'manifest'
  /** Set with `orderFrom` when the Index Note file does not exist yet: the first Plan change from the page creates it, holding the order and the change, in one write (`createsIndexNote`). */
  indexNoteAbsent?: true
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
  /** The files a running-order line may resolve to on this read (`planCandidates`'s pool). */
  poolPaths: ReadonlySet<string>
  /** This read's candidates (`planCandidates`): the pool and every candidate under the piece root. */
  candidates: PlanCandidates
  /**
   * Manifest-listed files out of the running order that "Not in the outline" does not show, by the shared name
   * rule (a cover, a `_`-prefixed file: `isNotInOutlineName`). Not listed, but every manifest write keeps their
   * entries where they are, as it keeps the listed ones (review round 2).
   */
  hiddenManifestPaths?: readonly string[]
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
  /**
   * The Folio page's writes (plan-ipc.ts): a Folio with a manifest and no Index Note file is read as its first Index
   * Note would read (`readFolioPlan`: the starter text and the manifest's order), the change is checked against that
   * Plan before anything touches the disk, and the Index Note is then created holding the order and the change, in
   * the one guarded write (`commitPlanDocuments`). `beforeIndexWrite` is called while the file is still absent, so
   * the history checkpoint records "no Index Note" and its Undo removes the file again.
   */
  createsIndexNote?: boolean
}

/** The manifest exactly as a Plan write read it, for `verifyPlan`. */
export type PlanLoadedManifest = { manifest: Folio | null; manifestExists: boolean }

/** The Folio page's read of a folder whose Index Note name holds something the workspace does not list (a link, a folder, a hidden file). */
export const INDEX_NOTE_NOT_READABLE = (file: string): string => (
  `This Folio’s Index Note, ${file}, is a link or not an ordinary file, so WriteFlex cannot read or change its outline. Replace it with the file itself, then reopen the Folio.`
)
/** The Folio page's read of a folder with no Index Note and a manifest that is there but cannot be read. */
export const MANIFEST_NOT_READABLE = 'This Folio’s manifest could not be read, so its outline cannot be shown. Check the manifest file, then reopen the Folio.'

export const MANIFEST_WOULD_NOT_FOLLOW = 'This change would update the Index Note but not the Folio manifest, so it was not made. Open the Folio outline to change this Folio’s order.'

const RUNNING_ORDER = /^##(?!#)\s+Running order(?:\s.*)?$/i
const SECTION_BOUNDARY = /^ {0,3}#{1,6}(?:\s|$)/
const KNOWN_ROLES = new Set<string>(PLAN_ROLES)

/** A manifest entry's role as the Plan reads it: front matter by the shared rule, else a Plan role, else `section`. */
export function manifestEntryRole(file: Pick<FolioFile, 'role' | 'toc'>): string {
  if (manifestEntryIsFrontMatter(file)) return FRONT_MATTER_ROLE
  const role = file.role?.toLocaleLowerCase()
  return role && KNOWN_ROLES.has(role) ? role : 'section'
}

/** Which parts are front matter, in order (each part's role as the Plan reads it). */
function frontFlags(parts: ReadonlyArray<Pick<PlanPart, 'role'>>): boolean[] {
  return parts.map((part) => isFrontMatterRole(part.role))
}

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
  if (!Number.isInteger(index) || index < 0 || index > upper) throw new Error('Folio outline part index is out of range.')
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

type PlanCandidates = {
  /**
   * The files a running-order line resolves among: those directly in the piece root and those the manifest
   * lists. Discovery never widens it (ADR-0046, review P1): a file deeper down joins it only once the manifest
   * lists it, so finding unlisted files can never change which file an existing `[[Title]]` line names.
   */
  pool: Candidate[]
  /** Every candidate under the piece root, by path: what "Not in the outline" reads titles from. */
  byPath: Map<string, Candidate>
  /**
   * Every candidate in the Folio's folder, listed or not: what a `./` path line resolves among, the same files the
   * editor resolves that link among (wikilinks.ts `resolveWikilinkPath`), so page and editor name one file.
   */
  folder: Candidate[]
}

async function planCandidates(ws: Workspace, dir: string, manifest: Folio | null): Promise<PlanCandidates> {
  const root = candidateRoot(dir, manifest)
  const present = new Set((await ws.listFiles()).map((file) => file.path))
  const listed = new Set(manifest?.files.flatMap((file) => {
    const resolved = resolveManifestFilePath(dir, manifest, file, present)
    return resolved ? [resolved] : []
  }) ?? [])
  // Agent instructions are never a part, so no Plan line or manifest entry resolves to one.
  const folder = (await collectionCandidates(ws, dir)).filter((candidate) => !isAgentInstructionsName(candidate.path))
  const under = root.replace(/\/+$/, '')
  const all = under === dir ? folder : folder.filter((candidate) => under === '' || candidate.path.startsWith(`${under}/`))
  return {
    pool: all.filter((candidate) => listed.has(candidate.path) || posix.dirname(candidate.path) === (root || '.')),
    byPath: new Map(all.map((candidate) => [candidate.path, candidate])),
    folder,
  }
}

/** The key a wikilink tier files a name under (wikilinks.ts `addCandidate`). */
function linkKey(value: string): string {
  return value.replace(/\.(?:md|markdown|mdx)$/i, '').toLocaleLowerCase()
}

export const PUT_BACK_NEEDS_MANIFEST = 'This file is in a subfolder, and only a Folio manifest can name a file there. Open it, or move it into the Folio’s folder, to put it back.'
export const PUT_BACK_SHARED_TITLE = (title: string): string => (
  `Another file here also answers to “${title}”, so its running-order line would be ambiguous or would change which file an existing line names. Rename its title to put it back.`
)

/**
 * Why a file outside the line pool (in a subfolder of the piece root, not in the manifest) cannot be put back,
 * or null when it can: its new line must name it and only it, and adding it to the pool must leave every
 * existing line naming the file it names now. Only lines whose title the file answers to can change, so the
 * pool's index is rebuilt only when one does, or when its title is already taken.
 */
function nestedPutBackRefusal(state: LoadedPlan, candidate: Candidate, pool: Candidate[], index: CandidateIndex): string | null {
  if (!state.manifest) return PUT_BACK_NEEDS_MANIFEST
  const keys = new Set([candidate.title, candidate.basename, ...candidate.aliases].map(linkKey))
  const touched = state.entries.filter((entry) => keys.has(linkKey(entry.parsed.title)))
  if (!touched.length && !index.get(`title:${linkKey(candidate.title)}`)?.length) return null
  const widened = buildWikilinkCandidateIndex([...pool, candidate], state.candidates.folder)
  // Its own line names it by title, or by path when another file answers to that title (`planLinkTarget`).
  if (!planLinkTarget(state.plan.indexPath, candidate.path, candidate.title, widened)) return PUT_BACK_SHARED_TITLE(candidate.title)
  for (const entry of touched) {
    const after = resolvePlanLink(state.plan.indexPath, entry.parsed.title, widened)
    const path = after.ambiguous ? preferOriginal(after.ambiguous) : after.to
    if (path !== entry.part.path || after.ambiguous?.includes(candidate.path)) return PUT_BACK_SHARED_TITLE(candidate.title)
  }
  return null
}

/**
 * A running-order line's file. The wikilink rule decides, except that a sync conflict copy never
 * wins over its original when both carry the title (`00_intro-Studio Mac.md` beside
 * `00_intro.md`): the copy would otherwise win whenever it sorts first.
 */
function resolvePlanTitle(indexPath: string, title: string, index: ReturnType<typeof buildWikilinkCandidateIndex>): string | null {
  const resolved = resolvePlanLink(indexPath, title, index)
  return resolved.ambiguous ? preferOriginal(resolved.ambiguous) : resolved.to
}

const MARKDOWN_EXTENSION = /\.(?:md|markdown|mdx)$/i

/**
 * What a running-order line's link names: the wikilink rule (wikilinks.ts `resolveWikilinkTargetFromIndex`). A `./`
 * link names the file at that path from the Index Note's folder (`[[./contents/a]]`, `[[./a]]` for a file in the
 * folder itself), inside the Folio's folder, or nothing: never a title or alias. Every other link: title, then file
 * name, then alias. Two files share one title: the Plan writes each such line by path (`planLinkTargets`), so both go
 * in, told apart by where they are, until the owner renames one.
 */
function resolvePlanLink(indexPath: string, target: string, index: CandidateIndex): { to: string | null; ambiguous?: string[] } {
  const folder = posix.dirname(indexPath)
  return resolveWikilinkTargetFromIndex(indexPath, target, index, { within: folder === '.' ? '' : folder })
}

/**
 * The `./` path links for `path`, from the Index Note's folder `dir`, shortest first: `./contents/a`, then
 * `./contents/a.md` (for when `a.mdx` is there too, and the bare path names neither). Empty when it cannot be one.
 */
function qualifiedPlanTargets(dir: string, path: string): string[] {
  const relative = dir === '' ? path : posix.relative(dir, path)
  if (!relative || relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)) return []
  const bare = relative.replace(MARKDOWN_EXTENSION, '')
  return bare === relative ? [`./${relative}`] : [`./${bare}`, `./${relative}`]
}

/** Whether a running-order line can hold `target` as its link: it serialises, and reads back as exactly that link. */
function lineHolds(target: string): boolean {
  try {
    return parsePlanLine(serialisePlanLine({ title: target }, '-'))?.title === target
  } catch {
    return false
  }
}

/**
 * The links a new running-order line could name `path` by, best first: its title when the title names that file and
 * no other (a sync conflict copy of it aside, which never wins over its original), then its `./` path link when
 * that names it alone (`qualifiedPlanTargets`). Each only when a line can hold it (`lineHolds`): a title such as `Has # punctuation` cannot be
 * written as a link, so the path stands in. Empty when neither does. `index`: the candidates the line resolves among.
 */
function planLinkTargets(indexPath: string, path: string, title: string, index: CandidateIndex): string[] {
  const targets: string[] = []
  const byTitle = resolvePlanLink(indexPath, title, index)
  const matches = byTitle.ambiguous ?? (byTitle.to ? [byTitle.to] : [])
  const originals = matches.filter((match) => !isConflictCopyAmong(match, matches))
  if (originals.length === 1 && originals[0] === path && lineHolds(title)) targets.push(title)
  const folder = posix.dirname(indexPath)
  for (const qualified of qualifiedPlanTargets(folder === '.' ? '' : folder, path)) {
    if (qualified === title || !lineHolds(qualified)) continue
    const byPath = resolvePlanLink(indexPath, qualified, index)
    if (byPath.to === path && !byPath.ambiguous) {
      targets.push(qualified)
      break
    }
  }
  return targets
}

/** The link a new running-order line names `path` by (`planLinkTargets`'s best), or null when no line can name it alone. */
function planLinkTarget(indexPath: string, path: string, title: string, index: CandidateIndex): string | null {
  return planLinkTargets(indexPath, path, title, index)[0] ?? null
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
  /** Files outside the pool a write is putting back: its new lines may name them (and the manifest will list them). */
  adopted: readonly string[] = [],
  known?: PlanCandidates,
): Promise<LoadedPlan> {
  const lines = splitLines(source)
  const foundHeading = planHeading(lines)
  const headingLine = foundHeading < 0 ? lines.length : foundHeading
  const candidates = known ?? await planCandidates(ws, dir, manifest)
  const poolPaths = new Set(candidates.pool.map((candidate) => candidate.path))
  const extra = adopted.flatMap((path) => {
    const candidate = poolPaths.has(path) ? undefined : candidates.byPath.get(path)
    return candidate ? [candidate] : []
  })
  const candidateIndex = buildWikilinkCandidateIndex([...candidates.pool, ...extra], candidates.folder)
  const entries = parseEntries(lines, headingLine).map(({ record, parsed, line }) => ({
    record,
    parsed,
    part: {
      title: parsed.title,
      gloss: parsed.gloss,
      // `#front-matter` anywhere among the line's role tags makes the part front matter (ADR-0046): a later role
      // tag (`#front-matter #summary`) never takes it out, so the Plan, the Outline and the export read it alike.
      role: partIsFrontMatter({ lineRole: parsed.role, lineFrontMatter: parsed.frontMatter }) ? FRONT_MATTER_ROLE : parsed.role,
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
    poolPaths,
    candidates,
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
  if (heading < 0) throw new Error('The Folio outline write lost its Running order heading.')
  const reparsed = parseEntries(lines, heading).map((entry) => entry.parsed)
  const semantic = (line: PlanLine) => ({ title: line.title, gloss: line.gloss, role: line.role, tags: line.tags, frontMatter: line.frontMatter })
  if (JSON.stringify(reparsed.map(semantic)) !== JSON.stringify(intended.map(semantic))) {
    throw new Error('The Folio outline write did not round-trip through the Folio outline-line parser.')
  }
}

function planLineValue(line: PlanLine): Pick<PlanLine, 'title' | 'gloss' | 'role' | 'tags' | 'frontMatter'> {
  return { title: line.title, gloss: line.gloss, role: line.role, tags: line.tags, frontMatter: line.frontMatter }
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
    `Refusing to update the Index Note because the Folio outline write would remove parts without an explicit Folio outline removal: ${names.join(', ') || 'unknown parts'}.`,
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
  // A Folio page write on a Folio with no Index Note file (`createsIndexNote`): the file must still be absent.
  const creating = state.plan.indexNoteAbsent === true
  const onDisk = creating ? null : state.source
  const changed = creating
    ? 'Another Index Note appeared in this folder while the Folio outline was being updated, so nothing was written.'
    : 'The Index Note changed while the Folio outline was being updated.'
  if (creating ? pathIsTaken(ws, state.plan.indexPath) : await readOptional(ws, state.plan.indexPath) !== onDisk) throw new Error(changed)
  await beforeWrite?.()
  // The comparison above is followed by awaits (the backups, the temporary file). It is made again in the
  // tick of the rename, so an edit that lands in between stops this write instead of being overwritten.
  // A created Index Note is linked into place exclusively: anything that appeared at its name meanwhile stops it.
  try {
    await ws.saveFileWithoutReadBack(state.plan.indexPath, next, {
      ...(creating ? { exclusive: true } : {}),
      beforeCommit: () => {
        if (creating ? pathIsTaken(ws, state.plan.indexPath) : textNow(ws, state.plan.indexPath) !== onDisk) throw new Error(changed)
      },
    })
  } catch (error) {
    if (creating && error instanceof NameTaken) throw new Error(changed)
    throw error
  }
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
  const creating = state.plan.indexNoteAbsent === true
  // Creating the Index Note obeys the one creation rule (folio-index-note.ts), as every other creation does.
  if (creating) {
    const refusal = await indexNoteCreationRefusal(ws, state.plan.dir)
    if (refusal) throw new Error(refusal)
  }
  // Called while a created Index Note is still absent: the checkpoint records "no Index Note", so its Undo removes it.
  await checkpointPlanWrites(options, state, manifestWrite, true)
  const original = state.source
  const written = await saveIndex(ws, state, intended, removedIndex, () => backupPlanDocuments(ws, state))
  try {
    await writePreparedManifest(ws, manifestWrite)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    let restored = false
    try {
      if (creating) {
        // The Index Note this write created goes again, only while it still holds exactly what this write wrote.
        if (await readOptional(ws, state.plan.indexPath) === written) {
          ws.removeFileOverRead(state.plan.indexPath, written)
          restored = !pathIsTaken(ws, state.plan.indexPath)
        }
      } else if (await readOptional(ws, state.plan.indexPath) === written) {
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
      : `The Index Note was updated but the Folio manifest could not be, and the Index Note could not be put back as it was. Check both in the Folio outline. (${reason})`)
  }
  state.source = written
  delete state.plan.indexNoteAbsent
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
    throw new Error(`A Folio outline part is outside the Folio content_root: ${fullPath}`)
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
    return name.startsWith('_') || name.toLocaleLowerCase() === 'readme.md' || name.toLocaleLowerCase() === 'index.md' || isAgentInstructionsName(name)
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
  return `The Folio outline has duplicate titles that resolve to the same file: ${titles.join(', ')}. Rename or remove one of those Folio outline parts before changing it.`
}

function assertPlanPartPathIsUnambiguous(parts: PlanPart[], index: number): void {
  const groups = duplicatePlanPaths(parts).filter((group) => group.indexes.includes(index))
  if (groups.length) throw new Error(duplicatePlanMessage(groups))
}

function assertMaterialiseTitleIsUnique(parts: PlanPart[], index: number): void {
  const title = parts[index].title
  const matches = parts.filter((part) => part.title.toLocaleLowerCase() === title.toLocaleLowerCase())
  if (matches.length > 1) {
    throw new Error(`The Folio outline has a duplicate title: ${title}. Rename or remove one of the ${title} parts before writing it.`)
  }
}

function assertNoNewDuplicatePlanPaths(current: PlanPart[], prospective: PlanPart[]): void {
  const currentCounts = new Map(duplicatePlanPaths(current).map((group) => [group.path, group.indexes.length]))
  const added = duplicatePlanPaths(prospective).filter((group) => group.indexes.length > (currentCounts.get(group.path) ?? 1))
  if (added.length) throw new Error(duplicatePlanMessage(added))
}

/** The adopted lines of the prospective Plan, at their places (`at`): each must resolve to the file it was written for. */
function assertAdoptedLinesResolveToChosenFiles(prospective: PlanPart[], placed: ReadonlyArray<{ at: number; part: PlanPart }>, inPlanView = false): void {
  placed.forEach(({ at, part }) => {
    if (prospective[at]?.path !== part.path) {
      throw new Error(`The running-order line for “${part.title}” would not name that file, by its title or by its path. ${inPlanView ? 'Rename its title, then add it. Nothing was added.' : 'Rename its title, or add it from the Folio outline.'}`)
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
    // Front matter is written as every reader will take it: role and `toc: false` (ADR-0046).
    ...(part && isFrontMatterRole(part.role) ? { toc: false } : {}),
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
  const hidden = state.hiddenManifestPaths ?? []
  if (state.manifest && (preserved.length || hidden.length)) {
    const present = new Set((await ws.listFiles()).map((file) => file.path))
    const preservedCounts = new Map<string, number>()
    for (const path of [...preserved.flatMap((part) => part.path ? [part.path] : []), ...hidden]) {
      preservedCounts.set(path, (preservedCounts.get(path) ?? 0) + 1)
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
    throw new Error(groups.length ? duplicatePlanMessage(groups) : 'The Folio outline has duplicate titles. Rename or remove one before changing it.')
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
  if (current !== state.manifestSource) throw new Error('The Folio manifest changed while the Folio outline was being updated.')
  const { files, verbatim } = keepEntriesOutsideFolio(state, partFiles)
  await assertManifestWritePreservesExistingFiles(ws, state, files, allowedRemovedPath)
  const next = state.manifestSource === null
    ? `${JSON.stringify({ schema_version: 1, content_root: contentRoot, files }, null, 2)}\n`
    : rewriteJsonArrayByKey(state.manifestSource, 'files', 'path', files, verbatim)
  if (next === current) return null
  await assertManifestNamesIntendedFiles(ws, state.plan.dir, next, orderedPaths)
  return { path, current, next }
}

export const MANIFEST_WOULD_NAME_ANOTHER_FILE = 'The Folio manifest would name a different file from the one chosen (another file sits where its entry would point), so nothing was changed.'

/**
 * The manifest a write prepared, read back by the rule every reader applies (`resolveManifestFilePath`, as
 * `folioPieces` and the export do): its entries inside the folder must name exactly `intended`, in order. A
 * new entry's path may be read under either `content_root` convention, and a file at the other reading would
 * win (review P2: `contents/deep/two.md` read as `contents/contents/deep/two.md`). Files this write is about to
 * create count as present.
 */
async function assertManifestNamesIntendedFiles(ws: Workspace, dir: string, next: string, intended: readonly string[]): Promise<void> {
  const manifest = parseManifest(dir, next)
  if (!manifest) throw new Error(MANIFEST_WOULD_NAME_ANOTHER_FILE)
  const present = new Set([...(await ws.listFiles()).map((file) => file.path), ...intended])
  const named = manifest.files
    .filter((file) => !manifestEntryPointsOutsideFolio(dir, manifest, file))
    .map((file) => resolveManifestFilePath(dir, manifest, file, present))
  if (named.length !== intended.length || named.some((path, at) => path !== intended[at])) throw new Error(MANIFEST_WOULD_NAME_ANOTHER_FILE)
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
    throw new Error('The Folio manifest changed while the Folio outline was being updated.')
  }
  await beforeWrite?.()
  await ws.saveFileWithoutReadBack(prepared.path, prepared.next, {
    beforeCommit: () => {
      if (textNow(ws, prepared.path) !== prepared.current) throw new Error('The Folio manifest changed while the Folio outline was being updated.')
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
  // An Index Note this write creates has no earlier copy to keep.
  if (!state.plan.indexNoteAbsent && !existsSync(ws.absolute(indexBackup))) {
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

/** Why Put back (and Add) is off for a file no running-order line can name alone. */
export const UNNAMEABLE_REFUSAL = 'No running-order line can name this file: its title has a character a line cannot hold (# | or ]]) or another file here shares it, and its path cannot stand in. Rename the file to put it back.'

/**
 * An unlisted file stays listed even when no Plan line can name it; Put back is then refused, with the reason. A
 * line can name it when its title or its `./` path does so alone (`planLinkTargets`) and the line, with the file's
 * gloss, role and tags, can be written: the line Put back and Add would write (`adoptParts`). `index`: the line pool
 * with the file in it, as it is once put back.
 */
function markIfUnnameable(state: LoadedPlan, part: PlanPart, candidate: Candidate, index: CandidateIndex, marker: PlanLineMarker): void {
  const holds = planLinkTargets(state.plan.indexPath, candidate.path, candidate.title, index).some((target) => {
    try {
      serialisePlanLine({ ...part, title: target }, marker)
      return true
    } catch {
      return false
    }
  })
  if (!holds) part.putBackRefusal = UNNAMEABLE_REFUSAL
}

/**
 * What an unlisted file's own text says of it: its gloss and tags, and its role (the manifest entry's when
 * the manifest lists the file, `manifestRole`; else the file's frontmatter `role`).
 */
function unlistedFileFacts(content: string, manifestRole: string | null): Pick<PlanPart, 'gloss' | 'role' | 'tags'> {
  const frontmatter = parseFrontmatter(content)
  const frontmatterRole = typeof frontmatter?.extra.role === 'string' ? frontmatter.extra.role.trim().toLocaleLowerCase() : ''
  return {
    gloss: frontmatter?.description?.trim() || frontmatter?.purpose?.trim() || null,
    role: manifestRole ?? (KNOWN_ROLES.has(frontmatterRole) ? frontmatterRole : 'section'),
    tags: frontmatter?.tags ?? [],
  }
}

/**
 * The unlisted part a Put back writes, from the file as it is now (review round 3): the listing reads through
 * the facts cache, which an outside edit keeping size and modified time can leave stale, so the line is built
 * from a fresh read. A file whose title is no longer the one listed is refused: the row is not what was shown.
 */
async function freshUnlistedPart(ws: Workspace, part: PlanPart, frontMatter?: { manifestOffers: boolean }): Promise<PlanPart> {
  if (!part.path) return part
  const content = (await ws.readFile(part.path)).content
  if (candidateTitle(content, part.path) !== part.title) throw new Error(STALE_PUT_BACK_MESSAGE)
  const fresh = { ...part, ...unlistedFileFacts(content, part.manifestBacked ? part.role : null) }
  if (!frontMatter) return fresh
  // "Add as front matter" (ADR-0046): offered by the manifest this write read (its `title_matter`, or an entry that
  // reads as front matter), or by the file's header as it is now, not as the listing's cache last saw it.
  if (!frontMatter.manifestOffers && !headerSaysFrontMatter(headerRole(content))) throw new Error(NOT_OFFERED_AS_FRONT_MATTER)
  return { ...fresh, role: FRONT_MATTER_ROLE }
}

/** What the manifest a write read says of `path`: its first entry (if any) and whether it is the `title_matter` file. */
function manifestFactsFor(state: LoadedPlan, present: ReadonlySet<string>, path: string): { entry: FolioFile | undefined; isTitleMatter: boolean } {
  const manifest = state.manifest
  if (!manifest) return { entry: undefined, isTitleMatter: false }
  const entry = manifest.files.find((file) => resolveManifestFilePath(state.plan.dir, manifest, file, present) === path)
  return { entry, isTitleMatter: titleMatterPath(state.plan.dir, manifest, present) === path }
}

/** Whether the manifest a write read offers `path` as front matter: it is the `title_matter` file, or its entry is front matter or says `toc: false`. */
async function manifestOffersFrontMatter(ws: Workspace, state: LoadedPlan, path: string): Promise<boolean> {
  if (!state.manifest) return false
  const present = new Set((await ws.listFiles()).map((file) => file.path))
  const { entry, isTitleMatter } = manifestFactsFor(state, present, path)
  return isTitleMatter || (entry !== undefined && manifestEntryOffersFrontMatter(entry))
}

export const NOT_OFFERED_AS_FRONT_MATTER = 'That file is not a title page or front matter, so it was not added as front matter. Put it back, then change its role. Nothing was changed.'

/** The `role` a file's own frontmatter states, or undefined. */
function headerRole(content: string): unknown {
  return parseFrontmatter(content)?.extra.role
}

/**
 * The Index Note's text with the manifest's order written under "## Running order", one line per manifest entry
 * that resolves to a file a running-order line can name, in the manifest's order: `- [[Title]]` and the entry's role
 * tag (what the manifest says of a file; nothing from the file's own frontmatter is copied in). Used when the Index
 * Note names no part yet, so the Plan shows the order the Outline shows (the Outline takes these very parts:
 * folio-order-facts.ts), and so the first Plan write writes that order and its own change in one write. The heading
 * is added at the end when there is none, after a blank line.
 *
 * A file whose title another file here also answers to (two parts both headed `# Same`), or whose title a line cannot
 * hold (`# Has # punctuation`), is written by its path (`[[./contents/a]]`, `planLinkTargets`): it goes in all the same,
 * named by where it is. Only an entry that neither its title nor its path can name alone in a line is left out of the
 * order; it is listed under "Not in the outline", and the Outline, which takes these very parts, says the same.
 *
 * Unchanged (`state` returned as it is) when the Index Note already names a part, or there is no manifest or it names
 * no such file. `state.source` stays the bytes on disk, so every write still checks the Index Note against what was
 * read.
 */
async function withManifestOrder(ws: Workspace, state: LoadedPlan, candidates: PlanCandidates, present: ReadonlySet<string>): Promise<LoadedPlan> {
  const { manifest } = state
  if (state.entries.length > 0 || !manifest) return state
  const dir = state.plan.dir
  const indexPath = state.plan.indexPath
  const poolIndex = buildWikilinkCandidateIndex(candidates.pool, candidates.folder)
  // `lines`: the lines that could name the file, best first (by title, then by path); `line` is the one in use.
  type Wanted = { path: string; line: string; lines: string[] }
  let wanted: Wanted[] = []
  let entries = 0
  for (const file of manifest.files) {
    const path = resolveManifestFilePath(dir, manifest, file, present)
    const candidate = path && state.poolPaths.has(path) ? candidates.byPath.get(path) : undefined
    if (!path || !candidate || wanted.some((item) => item.path === path)) continue
    entries += 1
    const lines = planLinkTargets(indexPath, path, candidate.title, poolIndex).flatMap((target) => {
      try {
        return [serialisePlanLine({ title: target, role: manifestEntryRole(file) }, '-')]
      } catch { return [] /* a role a line cannot hold: that line is not offered */ }
    })
    // Neither its title nor its path can name it alone in a line: not in the order, "Not in the outline" on both surfaces.
    if (lines.length) wanted.push({ path, line: lines[0], lines: lines.slice(1) })
  }
  if (entries === 0) return state
  const textWith = (items: Wanted[]): string => {
    const lines = splitLines(state.source)
    let heading = planHeading(lines)
    if (heading < 0) {
      if (lines.length > 0 && lines.at(-1)!.text.trim() !== '') insertLine(lines, lines.length, '')
      insertLine(lines, lines.length, '## Running order')
      insertLine(lines, lines.length, '')
      heading = lines.length - 2
    }
    const at = lines[heading + 1]?.text === '' ? heading + 2 : heading + 1
    items.forEach((item, offset) => { insertLine(lines, at + offset, item.line) })
    return joinLines(lines)
  }
  // Each line was checked alone; read back together, every line must still name exactly its file. One that does not
  // is left out, and the rest read again, until every line does.
  for (;;) {
    const shown = await parseLoaded(ws, dir, indexPath, textWith(wanted), manifest, state.manifestSource, state.manifestExists, [], [], candidates)
    const wrong = new Set(shown.plan.parts.flatMap((part, at) => (part.path !== wanted[at]?.path ? [at] : [])))
    if (shown.plan.parts.length === wanted.length && wrong.size === 0) {
      shown.source = state.source
      shown.plan.orderFrom = 'manifest'
      return shown
    }
    if (wrong.size === 0) return state // cannot happen: the parser read a different number of lines than were written
    // A wrong line tries the file's next line (its path, after its title); one with none left is left out.
    wanted = wanted.flatMap((item, at) => (!wrong.has(at) ? [item] : item.lines.length ? [{ ...item, line: item.lines[0], lines: item.lines.slice(1) }] : []))
  }
}

/**
 * `absent`: what a folder with no Index Note file reads as. `'none'` (every caller but the Folio page): no Plan.
 * `'as-new'` (`readFolioPlan`): for a folder with a manifest, the Plan its first Index Note would give
 * (`indexNoteStarterText`), flagged `indexNoteAbsent`; never written by the read.
 */
async function loadPlan(ws: Workspace, dir: string, absent: 'none' | 'as-new' = 'none'): Promise<LoadedPlan | null> {
  const path = indexNotePath(ws, dir)
  const listing = await ws.listFiles()
  const listedIndex = listing.some((file) => file.path === path)
  if (!listedIndex && absent === 'none') return null
  // `as-new` (the Folio page): something at the Index Note's name that the workspace does not list (a link, a folder,
  // a hidden file) is never read as "no Index Note" and never as "no Folio": the read refuses, and the page says so.
  if (!listedIndex && pathIsTaken(ws, path)) throw new Error(INDEX_NOTE_NOT_READABLE(posix.basename(path)))
  const { manifest, source: manifestSource, exists: manifestExists } = await manifestState(ws, dir)
  if (!listedIndex && !manifest) {
    // A manifest file that is there but cannot be read is not "no Folio" either.
    if (manifestExists || pathIsTaken(ws, manifestPath(dir))) throw new Error(MANIFEST_NOT_READABLE)
    return null
  }
  const source = listedIndex ? (await ws.readFile(path)).content : indexNoteStarterText(ws, dir)
  const candidates = await planCandidates(ws, dir, manifest)
  const present = new Set(listing.map((file) => file.path))
  const state = await withManifestOrder(
    ws,
    await parseLoaded(ws, dir, path, source, manifest, manifestSource, manifestExists, [], [], candidates),
    candidates,
    present,
  )
  if (!listedIndex) {
    state.plan.orderFrom = 'manifest'
    state.plan.indexNoteAbsent = true
  }
  const root = candidateRoot(dir, manifest)
  const marker = state.entries[0]?.parsed.marker ?? '-'
  const underOf = (fullPath: string): { under?: string } => {
    const under = subFolderOf(root, fullPath)
    return under ? { under } : {}
  }
  // Each unlisted file's text comes from the per-file facts cache (file-facts.ts): read again only when it changed
  // since the last load (review round 2). The heading facts below reuse the text.
  const listed = new Map(listing.map((file) => [file.path, file]))
  const reader = await factsReader(ws, listing.filter((file) => root === '' || file.path.startsWith(`${root}/`)), listing)
  const contents = new Map<string, string>()
  const readOnce = async (fullPath: string): Promise<string> => {
    const file = listed.get(fullPath)
    const content = file ? (await reader.read(file)).content : (await ws.readFile(fullPath)).content
    contents.set(fullPath, content)
    return content
  }

  const manifestCandidates = manifest
    ? manifest.files.flatMap((file) => {
        const fullPath = resolveManifestFilePath(dir, manifest, file, present)
        if (!fullPath) return []
        const candidate = state.poolPaths.has(fullPath) ? candidates.byPath.get(fullPath) : undefined
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
  const hiddenManifestPaths: string[] = []
  const pool = [...candidates.byPath.values()].filter((candidate) => state.poolPaths.has(candidate.path))
  const poolIndex = buildWikilinkCandidateIndex(pool, candidates.folder)
  for (const item of manifestCandidates) {
    if (planned.has(item.authoredPath)) continue
    // The name rule the sidebar applies (shared/folio-part-name.ts): a cover or `_`-prefixed file the manifest
    // lists is not shown here either, so the Plan and the sidebar list the same files (review round 2).
    if (!isNotInOutlineName(posix.basename(item.fullPath))) {
      hiddenManifestPaths.push(item.fullPath)
      planned.add(item.authoredPath)
      continue
    }
    const manifestRole = manifestEntryRole(item.file)
    const part: PlanPart = {
      title: item.candidate.title,
      ...unlistedFileFacts(await readOnce(item.fullPath), manifestRole),
      path: item.fullPath,
      line: -1,
      manifestBacked: true,
      ...underOf(item.fullPath),
    }
    markIfUnnameable(state, part, item.candidate, poolIndex, marker)
    unlisted.push(part)
    unlistedPaths.add(item.fullPath)
    planned.add(item.authoredPath)
  }
  const plannedPaths = new Set(state.plan.parts.flatMap((part) => part.path ? [part.path] : []))
  // The manifest's title_matter file is no longer skipped: removed from the running order, it is listed (ADR-0046).
  for (const fullPath of await folioPartsUnderRoot(ws, root)) {
    if (plannedPaths.has(fullPath) || unlistedPaths.has(fullPath)) continue
    const candidate = candidates.byPath.get(fullPath)
    if (!candidate) continue
    const part: PlanPart = {
      title: candidate.title,
      ...unlistedFileFacts(await readOnce(fullPath), null),
      path: fullPath,
      line: -1,
      manifestBacked: false,
      ...underOf(fullPath),
    }
    const inPool = state.poolPaths.has(fullPath)
    markIfUnnameable(state, part, candidate, inPool ? poolIndex : buildWikilinkCandidateIndex([...pool, candidate], candidates.folder), marker)
    // A file outside the line pool is listed with Open; Put back only when its line would name it alone and
    // leave every existing line as it is (review P1).
    if (!part.putBackRefusal && !state.poolPaths.has(fullPath)) {
      const refusal = nestedPutBackRefusal(state, candidate, pool, poolIndex)
      if (refusal) part.putBackRefusal = refusal
    }
    unlisted.push(part)
    unlistedPaths.add(fullPath)
  }
  // Manifest-backed entries stay in the writer's manifest order (the first loop); only the files in neither
  // document follow, in chapter order then by path, which `folioPartsUnderRoot` already gives (shared/folio-chapter-order.ts).
  state.plan.unlisted = unlisted
  state.hiddenManifestPaths = hiddenManifestPaths
  // Front matter (a title page) has no heading by design: its facts carry no heading checks.
  await attachHeadingFacts(ws, [...state.plan.parts, ...unlisted], frontMatterPathSet(dir, manifest, present, state.plan.parts), contents)
  attachFrontMatterFacts(state, present, contents)
  return state
}

/**
 * Front matter as the Plan reads it (ADR-0046), by the one shared rule (`partIsFrontMatter`): a part is front matter
 * when its line is tagged `#front-matter`, its manifest entry's role is `front-matter` or `title-matter`, or it is the
 * manifest's `title_matter` file. Any one suffices and none vetoes another: a line tagged `#summary` whose entry says
 * front matter is front matter. The Plan shows such a part with the role `front-matter`, so the Plan, the Outline and
 * the export (folio-front-matter.ts) read one Folio the same way. A title page is a file whose header says
 * `role: title-matter`, or the manifest's `title_matter` file; an unlisted file is offered as front matter when it is
 * one of those, its header says `role: front-matter`, or its manifest entry reads as front matter or says `toc: false`
 * (`toc: false` alone only offers: the part stays where it is).
 */
function attachFrontMatterFacts(state: LoadedPlan, present: ReadonlySet<string>, contents: ReadonlyMap<string, string>): void {
  const { manifest, plan } = state
  const entryOf = new Map<string, FolioFile>()
  if (manifest) {
    for (const file of manifest.files) {
      const resolved = resolveManifestFilePath(plan.dir, manifest, file, present)
      if (resolved && !entryOf.has(resolved)) entryOf.set(resolved, file)
    }
  }
  const titleMatter = manifest ? titleMatterPath(plan.dir, manifest, present) : null
  const roleInHeader = (path: string): unknown => {
    const text = contents.get(path)
    return text === undefined ? undefined : headerRole(text)
  }
  for (const part of [...plan.parts, ...plan.unlisted]) {
    if (!part.path) continue
    if (part.path === titleMatter) part.manifestTitlePage = true
    if (part.path === titleMatter || headerSaysTitlePage(roleInHeader(part.path))) part.titlePage = true
    // The same reading makes an unlisted front-matter file go back as front matter (so a Put back keeps the block leading).
    if (!isFrontMatterRole(part.role) && partIsFrontMatter({ lineRole: part.role, entry: entryOf.get(part.path), isTitleMatter: part.path === titleMatter })) part.role = FRONT_MATTER_ROLE
  }
  for (const part of plan.unlisted) {
    if (!part.path) continue
    const entry = entryOf.get(part.path)
    if (part.titlePage || headerSaysFrontMatter(roleInHeader(part.path)) || (entry && manifestEntryOffersFrontMatter(entry))) part.frontMatterOffer = true
  }
}

/**
 * The paths of the Folio's front-matter parts (shared/folio-front-matter.ts): its running-order lines read
 * as the Plan reads them, its manifest's roles and `title_matter`. Reads the Index Note and the manifest, not
 * the parts. Lists only the Folio's folder (every manifest candidate lies inside it); the Index Note's lines
 * are resolved (a Plan's candidate load, which walks the workspace) only when its text names `#front-matter`.
 */
export async function readFolioFrontMatter(ws: Workspace, dir: string, listing?: ReadonlySet<string>): Promise<Set<string>> {
  // `listing`: the Folio folder's `listFilesIn`, when the caller already has it.
  const present = listing ?? new Set((await ws.listFilesIn(dir)).map((file) => file.path))
  const manifest = await readManifest(ws, dir)
  const path = indexNotePath(ws, dir)
  const source = present.has(path) ? (await ws.readFile(path)).content : ''
  const lines = /#front-matter\b/i.test(source)
    ? (await parseLoaded(ws, dir, path, source, manifest, null)).plan.parts
    : []
  return frontMatterPathSet(dir, manifest, present, lines)
}

/**
 * Each part that resolves to a file carries what the title rule says of it. A file that cannot be read carries
 * nothing. `known` holds texts this load already read (through the facts cache); a text read here is added to it.
 * A part in `frontMatter` gets no heading checks (shared/folio-front-matter.ts `asFrontMatterTitle`).
 */
async function attachHeadingFacts(
  ws: Workspace,
  parts: PlanPart[],
  frontMatter: ReadonlySet<string>,
  known: Map<string, string> = new Map(),
): Promise<void> {
  const byPath = new Map<string, PlanPart['heading'] | null>()
  for (const part of parts) {
    if (!part.path) continue
    if (!byPath.has(part.path)) {
      try {
        const text = known.get(part.path) ?? (await ws.readFile(part.path)).content
        known.set(part.path, text)
        const named = partTitle(text, part.path)
        // Front matter has no conflict and no heading checks.
        if (frontMatter.has(part.path)) byPath.set(part.path, { ...asFrontMatterTitle(named, part.path), frontMatter: true })
        else if (!named.mismatch) byPath.set(part.path, named)
        else {
          // A title that differs from the heading carries the version it was read from: the Plan's
          // title-conflict buttons write only over that version (main/title-conflict-fix.ts). The facts are
          // taken from a fresh read, never a cached text, so the fingerprint is of exactly the text judged.
          const read = await ws.readFile(part.path)
          const facts = partTitle(read.content, part.path)
          byPath.set(part.path, facts.mismatch ? { ...facts, fingerprint: fingerprintOfRead(read) } : facts)
        }
      } catch { byPath.set(part.path, null) }
    }
    const facts = byPath.get(part.path)
    if (facts) part.heading = facts
  }
}

function requirePlan(state: LoadedPlan | null): LoadedPlan {
  if (!state) throw new Error('This folder has no Index Note for its Folio outline.')
  return state
}

function ensureHeading(state: LoadedPlan): void {
  if (state.plan.headingLine < state.lines.length) return
  insertLine(state.lines, state.lines.length, '## Running order')
  insertLine(state.lines, state.lines.length, '')
  state.plan.headingLine = state.lines.length - 2
}

/** What a writer reads a folder with no Index Note file as (`loadPlan`'s `absent`): only the page's writes create it. */
function absentFor(options: PlanWriteOptions): 'none' | 'as-new' {
  return options.createsIndexNote ? 'as-new' : 'none'
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
    super(`The change was made, but the Folio outline could not be read again afterwards. (${reason})`)
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

async function prospectivePlanParts(ws: Workspace, state: LoadedPlan, adopted: readonly string[] = []): Promise<PlanPart[]> {
  return (await parseLoaded(
    ws,
    state.plan.dir,
    state.plan.indexPath,
    joinLines(state.lines),
    state.manifest,
    state.manifestSource,
    state.manifestExists,
    [],
    adopted,
  )).plan.parts
}

export const PUT_BACK_WOULD_RETARGET = 'Putting this back would change which file an existing running-order line names, so nothing was added.'

/**
 * Before a Put back writes anything: every existing line still names the file it named, and (once the
 * manifest write is prepared) a file outside the line pool (a subfolder file) will be listed by it, since
 * only the manifest makes its line resolve to it on the next read. `manifestWrite` undefined = not prepared yet.
 */
function assertPutBackKeepsExistingLines(state: LoadedPlan, chosen: PlanPart[], prospective: PlanPart[], manifestWrite: PreparedManifestWrite | null | undefined, adoptedAt: ReadonlySet<number>): void {
  const kept = prospective.filter((_, at) => !adoptedAt.has(at))
  if (kept.length !== state.plan.parts.length || state.plan.parts.some((part, at) => kept[at]?.path !== part.path)) throw new Error(PUT_BACK_WOULD_RETARGET)
  if (manifestWrite === undefined) return
  const outsidePool = chosen.filter((part) => part.path && !state.poolPaths.has(part.path))
  if (outsidePool.length && !manifestWrite) throw new Error(PUT_BACK_NEEDS_MANIFEST)
}

export async function readPlan(ws: Workspace, dir: string): Promise<Plan | null> {
  return (await loadPlan(ws, dir))?.plan ?? null
}

/**
 * The Folio page's read (`plan:read`): `readPlan`, and for a folder with a manifest and no Index Note file yet, the
 * Plan its first Index Note would give (the manifest's order, `indexNoteAbsent`), so a Folio never reads as having no
 * outline. Writes nothing.
 *
 * Null says, affirmatively, "no Folio here": no Index Note path and no manifest file in the folder. Only then does
 * the page offer "Start a Folio outline". Anything else at the Index Note's name that the workspace does not list (a
 * link, a folder, a hidden file), or a manifest file that cannot be read, throws a plain sentence the page shows.
 */
export async function readFolioPlan(ws: Workspace, dir: string): Promise<Plan | null> {
  return (await loadPlan(ws, dir, 'as-new'))?.plan ?? null
}

/**
 * Which of `paths` the Folio page's order would name after a manifest-only Add lists them (folio-manifest-order.ts
 * `appendManifestEntries`), for a Folio with a manifest and no Index Note: the order the page reads from that manifest
 * (`withManifestOrder`) is worked out in memory, with the files added, and a file it leaves out ("Not in the
 * outline": no line can name it) is not one an Add should take. Files that drop out together are asked again without
 * them, so one file's title clash never costs another its place. Writes nothing.
 */
export async function namedAfterManifestAdd(ws: Workspace, dir: string, paths: readonly string[]): Promise<Set<string>> {
  const indexPath = indexNotePath(ws, dir)
  const listing = await ws.listFiles()
  const present = new Set(listing.map((file) => file.path))
  const { manifest, source, exists } = await manifestState(ws, dir)
  if (!manifest || present.has(indexPath)) return new Set()
  const starter = indexNoteStarterText(ws, dir)
  let trying = [...paths]
  while (trying.length) {
    const files: FolioFile[] = [...manifest.files, ...trying.map((path) => ({ path: newManifestPath(dir, manifest, manifest.contentRoot ?? '', path) }))]
    const widened: Folio = { ...manifest, files }
    const candidates = await planCandidates(ws, dir, widened)
    const state = await withManifestOrder(ws, await parseLoaded(ws, dir, indexPath, starter, widened, source, exists, [], [], candidates), candidates, present)
    const shown = new Set(state.plan.parts.flatMap((part) => (part.path ? [part.path] : [])))
    const kept = trying.filter((path) => shown.has(path))
    if (kept.length === trying.length) return new Set(kept)
    trying = kept
  }
  return new Set()
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
  const state = requireWritablePlan(await loadPlan(ws, dir, absentFor(options)))
  assertIndex(at, state.entries.length, true)
  const marker = state.entries[0]?.parsed.marker ?? '-'
  const line = serialisePlanLine(part, marker)
  const parsed = parsePlanLine(line)
  if (!parsed) throw new Error('The inserted Folio outline line did not round-trip through the parser.')
  // Front matter stays a leading block (ADR-0046): a part asked for on the wrong side of it lands at its edge.
  at = placeInOrder(frontFlags(state.plan.parts), at, isFrontMatterRole(parsed.role))
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

/** A line that belongs to the entry above it: indented, not blank, not itself an entry, not a fence or a heading. */
function isEntryContinuation(text: string): boolean {
  return /^[ \t]+\S/.test(text) && !FENCE_OPENING.test(text) && !SECTION_BOUNDARY.test(text)
}

/** A fence opening as `codeLines` reads one: up to three spaces, then three or more backticks or tildes. */
const FENCE_OPENING = /^( {0,3})(`{3,}|~{3,})/

/**
 * Where an entry's text starts: the width of its indent, list marker and the spaces after it (one space
 * when there are more than four, as in CommonMark, where the rest begins an indented code block).
 */
function entryContentOffset(text: string): number {
  const match = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])( *)/.exec(text)
  if (!match) return 0
  const spaces = match[2].length
  return match[0].length - spaces + (spaces >= 1 && spaces <= 4 ? spaces : 1)
}

/**
 * The line after the fence that opens at `open` and belongs to the entry whose text starts at `offset`, or
 * -1 when `open` is no such fence. The fence belongs to the entry when it is indented at least to the entry's
 * text; it runs to its close (the same character, at least as long, as `codeLines` closes it) or, unclosed,
 * to `end`. A fence indented less than the entry's text is not the entry's and ends its block.
 */
function entryFenceEnd(lines: LineRecord[], open: number, end: number, offset: number): number {
  const opening = FENCE_OPENING.exec(lines[open].text)
  if (!opening || opening[1].length < offset || offset === 0) return -1
  const run = opening[2]
  const closing = new RegExp(`^ {0,3}${run[0] === '`' ? '`' : '~'}{${run.length},}\\s*$`)
  for (let line = open + 1; line < end; line += 1) {
    if (closing.test(lines[line].text)) return line + 1
  }
  return end
}

/**
 * THE line move behind every running-order reorder (`movePart`, `reorderParts`). `order[k]` is the current
 * index of the entry that goes to position k. Each entry moves as a block: its line and the indented lines
 * directly under it (a nested note such as `  - note on C`), up to the first blank, unindented or entry line.
 * A fence indented at least to the entry's text is the entry's, with every line up to its close (blank or
 * not); a fence indented less ends the block.
 * The block for position k is put where the k-th block was; every other line (blank lines, comments,
 * unindented text) keeps its place. Line endings belong to positions, not to text: line i of the result
 * ends as line i of the file did, so a list that ends the file without a final newline keeps ending it that
 * way, and the moved last entry is never joined to the next line. Applying the inverse order gives the
 * original bytes back (bar the renumbering of a numbered list, done later by `saveIndex`).
 */
function moveEntryBlocks(state: LoadedPlan, order: readonly number[]): void {
  const { lines } = state
  const count = state.entries.length
  if (count === 0 || order.length !== count) return
  const starts = state.entries.map((entry) => lines.indexOf(entry.record))
  const entryLines = new Set(starts)
  const end = sectionEnd(lines, state.plan.headingLine)
  const blocks = starts.map((start) => {
    const offset = entryContentOffset(lines[start].text)
    let stop = start + 1
    while (stop < end && !entryLines.has(stop)) {
      const fenceStop = entryFenceEnd(lines, stop, end, offset)
      if (fenceStop >= 0) { stop = fenceStop; continue }
      if (!isEntryContinuation(lines[stop].text)) break
      stop += 1
    }
    return { start, stop }
  })
  const first = blocks[0].start
  const last = blocks[count - 1].stop
  const texts: string[] = []
  let k = 0
  for (let at = first; at < last;) {
    if (k < count && at === blocks[k].start) {
      const block = blocks[order[k]]
      for (let line = block.start; line < block.stop; line += 1) texts.push(lines[line].text)
      at = blocks[k].stop
      k += 1
    } else {
      texts.push(lines[at].text)
      at += 1
    }
  }
  if (texts.length !== last - first) throw new Error('The Folio outline reorder did not keep every line.')
  lines.splice(first, last - first, ...texts.map((text, offset) => ({ text, ending: lines[first + offset].ending })))
}

async function movePartUnlocked(ws: Workspace, dir: string, from: number, to: number, options: PlanWriteOptions = {}): Promise<Plan> {
  const state = requireWritablePlan(await loadPlan(ws, dir, absentFor(options)))
  await options.verifyPlan?.(state.plan, { manifest: state.manifest, manifestExists: state.manifestExists })
  assertIndex(from, state.entries.length, false)
  assertIndex(to, state.entries.length, false)
  assertPlanPartPathIsUnambiguous(state.plan.parts, from)
  if (!moveStaysInBlock(frontFlags(state.plan.parts), from, to)) throw new Error(FRONT_MATTER_STAYS_LEADING)
  const order = state.entries.map((_, index) => index)
  if (from !== to) {
    const [moved] = order.splice(from, 1)
    order.splice(to, 0, moved)
    moveEntryBlocks(state, order)
  }
  const intended = order.map((index) => state.entries[index].parsed)

  const parts = await prospectivePlanParts(ws, state)
  const manifestWrite = await prepareManifestWriteIfUnambiguous(ws, state, parts, false, [], null, state.plan.unlisted)
  await commitPlanDocuments(ws, state, intended, manifestWrite, options)
  return planAfterCommit(ws, state)
}

/**
 * Put the whole running order in a new order in ONE write. `order[k]` is the current index of the part that
 * goes to position k (a permutation of 0..n-1). The lines move as `moveEntryBlocks` moves them; the manifest
 * follows through the same path as a single move. Only the order changes: no entry is rewritten (a numbered
 * list is renumbered 1, 2, 3, as by every Plan write), so the on-disk format is untouched.
 */
async function reorderPartsUnlocked(ws: Workspace, dir: string, order: number[], options: PlanWriteOptions = {}): Promise<Plan> {
  const state = requireWritablePlan(await loadPlan(ws, dir, absentFor(options)))
  await options.verifyPlan?.(state.plan, { manifest: state.manifest, manifestExists: state.manifestExists })
  const count = state.entries.length
  if (order.length !== count || new Set(order).size !== count || order.some((index) => !Number.isInteger(index) || index < 0 || index >= count)) {
    throw new Error('That is not a new order for this running order.')
  }
  for (let index = 0; index < count; index += 1) assertPlanPartPathIsUnambiguous(state.plan.parts, index)
  const flags = frontFlags(state.plan.parts)
  assertFrontMatterStaysLeading(flags, order.map((index) => flags[index]))
  const intended = order.map((index) => state.entries[index].parsed)
  moveEntryBlocks(state, order)

  const parts = await prospectivePlanParts(ws, state)
  const manifestWrite = await prepareManifestWriteIfUnambiguous(ws, state, parts, false, [], null, state.plan.unlisted)
  await commitPlanDocuments(ws, state, intended, manifestWrite, options)
  return planAfterCommit(ws, state)
}

async function removePartUnlocked(ws: Workspace, dir: string, index: number, options: PlanWriteOptions = {}): Promise<Plan> {
  const state = requireWritablePlan(await loadPlan(ws, dir, absentFor(options)))
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
  expected: PlanCardKey,
  options: PlanWriteOptions = {},
): Promise<Plan> {
  const state = requireWritablePlan(await loadPlan(ws, dir, absentFor(options)))
  await options.verifyPlan?.(state.plan, { manifest: state.manifest, manifestExists: state.manifestExists })
  // The card the caller saw, checked on this read under the lock: every caller names it (review round 3).
  const refusal = planCardRefusal(state.plan.parts, index, expected)
  if (refusal) throw new Error(refusal)
  assertIndex(index, state.entries.length, false)
  assertPlanPartPathIsUnambiguous(state.plan.parts, index)
  // The manifest's title_matter file is front matter whatever its role (ADR-0046); its top-level field is the owner's.
  if (state.plan.parts[index].manifestTitlePage && !isFrontMatterRole(role)) throw new Error(`${TITLE_PAGE_SET_IN_MANIFEST}, so it stays front matter. Nothing was changed.`)
  const entry = state.entries[index]
  const indent = /^\s*/.exec(entry.record.text)?.[0] ?? ''
  const line = serialisePlanLine({ title: entry.parsed.title, gloss: entry.parsed.gloss, role, tags: entry.parsed.tags }, entry.parsed.marker)
  const parsed = parsePlanLine(line)
  if (!parsed) throw new Error('The Folio outline line with its new role did not round-trip through the parser.')
  // The role the Plan shows may come from the manifest (a line with no role of its own: a front-matter entry, the title_matter file).
  // A line with `#front-matter` among other role tags reads as front matter; choosing Front matter again leaves it as written.
  const lineRole = entry.parsed.frontMatter ? FRONT_MATTER_ROLE : entry.parsed.role
  if (parsed.role === lineRole && parsed.role === state.plan.parts[index].role) return state.plan
  entry.record.text = `${indent}${line}`
  // A part crosses the front-matter boundary by its role, never by a move (ADR-0046): it goes to the block's edge,
  // the end of the front matter or the start of the contents. Its line moves with it.
  const before = frontFlags(state.plan.parts)
  const after = before.map((flag, at) => (at === index ? isFrontMatterRole(parsed.role) : flag))
  const order = state.entries.map((_, at) => at)
  if (frontMatterLeads(before) && !frontMatterLeads(after)) {
    const end = frontBlockEnd(before)
    const to = isFrontMatterRole(parsed.role) ? end : end - 1
    order.splice(index, 1)
    order.splice(to, 0, index)
    moveEntryBlocks(state, order)
  }
  const intended = order.map((at) => (at === index ? parsed : state.entries[at].parsed))
  const parts = await prospectivePlanParts(ws, state)
  const prepared = await prepareManifestWriteIfUnambiguous(ws, state, parts, false, [], null, state.plan.unlisted)
  const manifestWrite = await withManifestRole(ws, state, prepared, state.plan.parts[index].path, parsed.role)
  await commitPlanDocuments(ws, state, intended, manifestWrite, options)
  return planAfterCommit(ws, state)
}

/**
 * What makes a manifest entry read as `role`, as property edits (`role`, `toc`). Front matter (ADR-0046): the
 * entry must read as front matter (a `front-matter` or `title-matter` role is kept as it is; any other becomes
 * `front-matter`) with `toc: false`. Any other role: `set` writes it unless the entry already says it (no `role`
 * reads as `section`, except on the `title_matter` file); `align` only replaces an entry that reads as front matter.
 * A `toc: false` becomes `true` only on an entry that read as front matter.
 */
function manifestEntryEdits(entry: Record<string, unknown>, role: string, mode: 'set' | 'align', isTitleMatter = false): Array<[string, string | boolean]> {
  const edits: Array<[string, string | boolean]> = []
  const current = entry.role
  if (isFrontMatterRole(role)) {
    if (!isFrontMatterRole(current)) edits.push(['role', FRONT_MATTER_ROLE])
    if (entry.toc !== false) edits.push(['toc', false])
    return edits
  }
  // Leaving front matter: the entry must stop reading as front matter. The title_matter file with no role reads as
  // front matter, so it is given the role in words, `section` included.
  const wasFront = manifestEntryIsFrontMatter(entry, isTitleMatter)
  const roleDiffers = mode === 'set'
    ? !(current === role || (current === undefined && role === 'section' && !isTitleMatter))
    : wasFront
  if (roleDiffers) edits.push(['role', role])
  // `toc: false` is undone only where it came with front matter; on any other entry it is the owner's and is kept.
  if (wasFront && entry.toc === false) edits.push(['toc', true])
  return edits
}

/**
 * The role change in the manifest too (review P2): every entry that names the part's file is made to read as
 * `role` (`manifestEntryEdits`), its other bytes and every other entry kept as they are
 * (`rewriteJsonArrayEntryProperty`). Applied to the manifest the write already prepared, or to the manifest as
 * read when the write had nothing else to change. `align` (a Put back) changes an entry only where its front
 * matter disagrees with the part's role.
 */
async function withManifestRole(
  ws: Workspace,
  state: LoadedPlan,
  prepared: PreparedManifestWrite | null,
  partPath: string | null,
  role: string,
  mode: 'set' | 'align' = 'set',
): Promise<PreparedManifestWrite | null> {
  if (!partPath || !state.manifest || state.manifestSource === null) return prepared
  const dir = state.plan.dir
  const base = prepared?.next ?? state.manifestSource
  const manifest = parseManifest(dir, base)
  if (!manifest) return prepared
  const present = new Set((await ws.listFiles()).map((file) => file.path))
  const titleMatter = titleMatterPath(dir, manifest, present)
  let next = base
  jsonArrayLayout(base, 'files').entries.forEach((entry, at) => {
    const value = entry.value
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return
    const authored = (value as Record<string, unknown>).path
    if (typeof authored !== 'string' || resolveManifestFilePath(dir, manifest, { path: authored }, present) !== partPath) return
    for (const [key, edit] of manifestEntryEdits(value as Record<string, unknown>, role, mode, partPath === titleMatter)) {
      next = rewriteJsonArrayEntryProperty(next, 'files', at, key, edit)
    }
  })
  if (next === base) return prepared
  const before = JSON.parse(base) as { files: unknown[] }
  const after = JSON.parse(next) as { files: unknown[] }
  const unchangedButRole = (value: unknown): unknown => (typeof value === 'object' && value !== null ? { ...value as object, role: undefined, toc: undefined } : value)
  if (JSON.stringify(before.files.map(unchangedButRole)) !== JSON.stringify(after.files.map(unchangedButRole))
    || JSON.stringify({ ...before, files: null }) !== JSON.stringify({ ...after, files: null })) {
    throw new Error('The Folio manifest’s role could not be changed exactly, so nothing was changed.')
  }
  return { path: manifestPath(dir), current: prepared?.current ?? state.manifestSource, next }
}

/**
 * Put back unlisted parts in one write: `adoptPart` (one row; `asFrontMatter` for "Add as front matter") and
 * `adoptParts` (several, from the Outline's Add and the Plan's Add all). Every check that can refuse happens before
 * the first byte is written, so a refusal adopts none. Each line is built from a fresh read of its file. Each new
 * line must resolve to exactly the file chosen (a line names a file by title, and another file may carry the same
 * title), and every existing line must still name the file it named.
 *
 * Where they land (ADR-0046): a part whose role is front matter at the end of the front-matter block, the others
 * at the end of the running order, each group in the order given. A manifest entry the Folio already has is
 * aligned with the part's role (front matter: `toc: false`), its other bytes kept.
 *
 * The commit is `commitPlanDocuments`: Index Note, then manifest, with the Index Note put back if the manifest
 * cannot be written; see there for exactly what that does and does not guarantee.
 */
async function adoptUnlocked(
  ws: Workspace,
  dir: string,
  unlistedIndices: number[],
  options: PlanWriteOptions,
  single: boolean,
  asFrontMatter = false,
): Promise<Plan> {
  const state = requireWritablePlan(await loadPlan(ws, dir, absentFor(options)))
  // The caller's check that these rows are still the files the owner saw (plan-ipc.ts), under the lock, before any write.
  await options.verifyPlan?.(state.plan, { manifest: state.manifest, manifestExists: state.manifestExists })
  if (unlistedIndices.length === 0) throw new Error('There is nothing to adopt.')
  if (new Set(unlistedIndices).size !== unlistedIndices.length) throw new Error('A Folio outline part cannot be adopted twice.')
  for (const index of unlistedIndices) assertIndex(index, state.plan.unlisted.length, false)
  const refused = unlistedIndices.find((index) => state.plan.unlisted[index].putBackRefusal)
  if (refused !== undefined) throw new Error(`${state.plan.unlisted[refused].putBackRefusal} Nothing was added.`)
  const marker = state.entries[0]?.parsed.marker ?? '-'
  const chosenParts: PlanPart[] = []
  for (const index of unlistedIndices) {
    const row = state.plan.unlisted[index]
    const frontMatter = asFrontMatter ? { manifestOffers: row.path !== null && await manifestOffersFrontMatter(ws, state, row.path) } : undefined
    const fresh = await freshUnlistedPart(ws, row, frontMatter)
    // A file that reads as front matter (its manifest entry, or the title_matter file) goes back as front matter:
    // no role its own header names takes it out (ADR-0046).
    chosenParts.push(isFrontMatterRole(row.role) && !isFrontMatterRole(fresh.role) ? { ...fresh, role: FRONT_MATTER_ROLE } : fresh)
  }
  // Each new line names its file by title, or by path when another file here also answers to that title
  // (`planLinkTarget`): both files go in, told apart by where they are, until the owner renames one.
  const linkIndex = buildWikilinkCandidateIndex([
    ...state.candidates.pool,
    ...chosenParts.flatMap((part) => {
      const candidate = part.path && !state.poolPaths.has(part.path) ? state.candidates.byPath.get(part.path) : undefined
      return candidate ? [candidate] : []
    }),
  ], state.candidates.folder)
  const adopted = chosenParts.map((part) => {
    const target = part.path ? planLinkTarget(state.plan.indexPath, part.path, part.title, linkIndex) ?? part.title : part.title
    const line = serialisePlanLine({ ...part, title: target }, marker)
    const parsed = parsePlanLine(line)
    if (!parsed) throw new Error('The adopted Folio outline line did not round-trip through the parser.')
    return { part, line, parsed }
  })
  const front = adopted.filter((item) => isFrontMatterRole(item.parsed.role))
  const contents = adopted.filter((item) => !isFrontMatterRole(item.parsed.role))
  const flags = frontFlags(state.plan.parts)
  const frontAt = frontBlockEnd(flags)
  const count = state.entries.length
  ensureHeading(state)
  const frontLine = insertionLine(state, frontAt)
  front.forEach((item, offset) => { insertLine(state.lines, frontLine + offset, item.line) })
  const endLine = frontAt === count ? frontLine + front.length : insertionLine(state, count)
  contents.forEach((item, offset) => { insertLine(state.lines, endLine + offset, item.line) })
  const placed = [
    ...front.map((item, offset) => ({ at: frontAt + offset, part: item.part })),
    ...contents.map((item, offset) => ({ at: count + front.length + offset, part: item.part })),
  ]
  const intended = state.entries.map((entry) => entry.parsed)
  intended.splice(frontAt, 0, ...front.map((item) => item.parsed))
  intended.push(...contents.map((item) => item.parsed))
  const afterFlags = [...flags]
  afterFlags.splice(frontAt, 0, ...front.map(() => true))
  afterFlags.push(...contents.map(() => false))
  assertFrontMatterStaysLeading(flags, afterFlags)
  const adoptedAt = new Set(placed.map((item) => item.at))
  const parts = await prospectivePlanParts(ws, state, chosenParts.flatMap((part) => part.path ? [part.path] : []))
  assertPutBackKeepsExistingLines(state, chosenParts, parts, undefined, adoptedAt)
  assertAdoptedLinesResolveToChosenFiles(parts, placed, single)
  assertNoNewDuplicatePlanPaths(state.plan.parts, parts)
  const chosen = new Set(unlistedIndices)
  const preserved = state.plan.unlisted.filter((_, index) => !chosen.has(index))
  let manifestWrite = await prepareManifestWriteIfUnambiguous(ws, state, parts, false, [], null, preserved)
  for (const part of chosenParts) manifestWrite = await withManifestRole(ws, state, manifestWrite, part.path, part.role, 'align')
  assertPutBackKeepsExistingLines(state, chosenParts, parts, manifestWrite, adoptedAt)
  await commitPlanDocuments(ws, state, intended, manifestWrite, options)
  return planAfterCommit(ws, state)
}

/**
 * The file "Write it out" creates for the part at `index`, and its title. A title line gets a numbered file under the
 * piece root, titled as the line. A `./` path line (Sol round 4) gets exactly the file its link names, titled by its
 * file name, and only when that file, once there, is the one the line resolves to: never a numbered file the line
 * would still not name.
 */
function materialisedFile(state: LoadedPlan, dir: string, index: number): { path: string; title: string; byPath: boolean } {
  const part = state.plan.parts[index]
  if (!isPathLink(part.title)) {
    const filename = `${String(index + 1).padStart(2, '0')}-${slugifyFileName(part.title)}`
    return { path: inDir(dir, state.manifest?.contentRoot ?? '', filename), title: part.title, byPath: false }
  }
  const folder = posix.dirname(state.plan.indexPath)
  const path = pathLinkNewFile(state.plan.indexPath, part.title, folder === '.' ? '' : folder)
  const refusal = `This running-order line names a place no part can be written to: ${part.title}`
  if (!path || isAgentInstructionsName(path)) throw new Error(refusal)
  const title = posix.basename(path).replace(MARKDOWN_EXTENSION, '')
  const written: Candidate = { path, title, basename: title, aliases: [] }
  const widened = buildWikilinkCandidateIndex([], [...state.candidates.folder, written])
  if (resolvePlanLink(state.plan.indexPath, part.title, widened).to !== path) throw new Error(refusal)
  return { path, title, byPath: true }
}

/**
 * A `./` line's file is created only where its path says (Sol rounds 5 and 6). Its folder must already exist (a line
 * never makes folders), no folder on its way down from the Folio may be a link, its real folder must be inside the
 * Folio's real folder, and the file must be one the workspace listing shows, judged on the REAL spelling (on a disk
 * that ignores case `Node_Modules` is the hidden `node_modules`). Synchronous: it runs once before anything is written
 * and again immediately before the create, with nothing awaited between. A process that swaps a folder for a link in
 * the instant between that last check and the create is out of reach here; the Workspace's own boundary check at the
 * create (workspace.ts `absolute`) still keeps the file inside the Collection.
 */
function assertWritableWhereNamed(ws: Workspace, indexPath: string, path: string, line: string): void {
  const refuse = (): never => { throw new Error(`This running-order line names a place no part can be written to: ${line}`) }
  const leaves = (rel: string): boolean => rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
  const folder = posix.dirname(indexPath)
  const folio = join(ws.root, folder === '.' ? '' : folder)
  const parent = dirname(join(ws.root, path))
  const spelled = relative(folio, parent)
  if (leaves(spelled)) refuse()
  let cursor = folio
  for (const segment of spelled.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment)
    let entry
    try { entry = lstatSync(cursor) } catch { return refuse() } // the folder is not there: a line never makes one
    if (!entry.isDirectory()) refuse()
  }
  let realRoot: string, realFolio: string, realParent: string
  try {
    realRoot = realpathSync.native(ws.root)
    realFolio = realpathSync.native(folio)
    realParent = realpathSync.native(parent)
  } catch {
    return refuse()
  }
  const inRoot = relative(realRoot, realParent)
  if (leaves(relative(realFolio, realParent)) || leaves(inRoot)) refuse()
  const listed = [...inRoot.split(sep).filter(Boolean), posix.basename(path)].join('/')
  if (!isListedPath(listed, 'file')) refuse()
}

/**
 * Run the write that names a just-created part; if it fails, remove the part again, but only while it is still the
 * file this call created (same inode, and still exactly the text it submitted: never the read-back, which may already
 * hold another editor's save). Anything else there is left in place and named in the error.
 */
async function undoCreateOnFailure(ws: Workspace, created: { path: string; submitted: string }, write: () => Promise<void>): Promise<void> {
  const absolute = ws.absolute(created.path)
  const inode = lstatSync(absolute).ino
  try {
    await write()
  } catch (error) {
    let removed = false
    try {
      if (lstatSync(absolute).ino === inode) {
        ws.removeFileOverRead(created.path, created.submitted)
        removed = true
      }
    } catch {
      removed = false
    }
    if (removed) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message} The new part ${created.path} was left in place.`, { cause: error })
  }
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
  if (preflightPart.path) throw new Error('This Folio outline part is already written.')
  const { path: preflightPath } = materialisedFile(preflight, dir, index)
  if ((await ws.listFiles()).some((file) => file.path === preflightPath)) throw new Error(`The Folio outline part path already exists: ${preflightPath}`)

  const state = requireWritablePlan(await loadPlan(ws, dir))
  assertIndex(index, state.entries.length, false)
  assertMaterialiseTitleIsUnique(state.plan.parts, index)
  const part = state.plan.parts[index]
  if (part.path) throw new Error('This Folio outline part is already written.')
  const { path, title, byPath } = materialisedFile(state, dir, index)
  if (path !== preflightPath) throw new Error('The Folio outline changed while the part was being prepared.')
  if (byPath) assertWritableWhereNamed(ws, state.plan.indexPath, path, part.title)
  const prospective = state.plan.parts.map((item, partIndex) => partIndex === index ? { ...item, path } : item)

  // A `./` line's place is judged again in the create's own tick, after every await before it (Sol round 6).
  const lastCheck = byPath ? () => assertWritableWhereNamed(ws, state.plan.indexPath, path, part.title) : undefined
  const create = () => createCollectionStub(ws, {
    dir,
    path,
    title,
    // A path line names its file by where it is, so another file that shares the title takes nothing from it.
    ...(byPath ? { createAnyway: true } : {}),
    gist: part.gloss ?? '',
    role: part.role,
    titleInFrontmatter: true,
    suppressBacklink: true,
    ...(part.gloss ? { bodyLead: part.gloss } : {}),
  }, lastCheck)
  // The file first, then the manifest (Sol round 6): a refused create leaves the manifest untouched, and a manifest
  // write that fails takes back the file it was to name (`undoCreateOnFailure`).
  let created
  if (state.manifest) {
    const manifestWrite = await prepareManifestWriteIfUnambiguous(ws, state, prospective, true, [], null, state.plan.unlisted)
    await checkpointPlanWrites(options, state, manifestWrite, false)
    created = await create()
    if (created.created) {
      await undoCreateOnFailure(ws, created, async () => {
        if (manifestWrite) {
          await writePreparedManifest(ws, manifestWrite, () => backupPlanDocuments(ws, state))
        } else {
          await backupPlanDocuments(ws, state)
        }
      })
    }
  } else {
    const fallbackOrder = await orderFor(ws, dir)
    await backupPlanDocuments(ws, state)
    created = await create()
    if (created.created) {
      const made = created
      await undoCreateOnFailure(ws, made, async () => {
        const manifestWrite = await prepareManifestWriteIfUnambiguous(ws, state, prospective, true, fallbackOrder, null, state.plan.unlisted)
        await checkpointPlanWrites(options, state, manifestWrite, false)
        await writePreparedManifest(ws, manifestWrite)
      })
    }
  }
  if (!created.created) throw new Error(`A file already resolves the Folio outline part: ${part.title}`)
  return { plan: await finalPlan(ws, dir), path: created.path }
}

// Every Plan write runs under the Folio's lock (plan-lock.ts): one writer at a time per Folio, whoever calls.

export function insertPart(ws: Workspace, dir: string, at: number, part: { title: string; gloss?: string; role?: string }, options: PlanWriteOptions = {}): Promise<Plan> {
  return withPlanLock(ws, dir, () => insertPartUnlocked(ws, dir, at, part, options))
}

export function movePart(ws: Workspace, dir: string, from: number, to: number, options: PlanWriteOptions = {}): Promise<Plan> {
  return withPlanLock(ws, dir, () => movePartUnlocked(ws, dir, from, to, options))
}

export function reorderParts(ws: Workspace, dir: string, order: number[], options: PlanWriteOptions = {}): Promise<Plan> {
  return withPlanLock(ws, dir, () => reorderPartsUnlocked(ws, dir, order, options))
}

export function removePart(ws: Workspace, dir: string, index: number, options: PlanWriteOptions = {}): Promise<Plan> {
  return withPlanLock(ws, dir, () => removePartUnlocked(ws, dir, index, options))
}

/** `expected` is the card the caller saw, its whole line: refused unless the card at `index` is still that card and no other card reads the same. */
export function setPartRole(ws: Workspace, dir: string, index: number, role: string, expected: PlanCardKey, options: PlanWriteOptions = {}): Promise<Plan> {
  return withPlanLock(ws, dir, () => setPartRoleUnlocked(ws, dir, index, role, expected, options))
}

/** Put back one unlisted part. `asFrontMatter`: "Add as front matter", for a file offered as one (`frontMatterOffer`). */
export function adoptPart(ws: Workspace, dir: string, unlistedIndex: number, options: PlanWriteOptions = {}, asFrontMatter = false): Promise<Plan> {
  return withPlanLock(ws, dir, () => adoptUnlocked(ws, dir, [unlistedIndex], options, true, asFrontMatter))
}

/** Put back several unlisted parts in one write, in the order of `unlistedIndices` (front matter in its block). */
export function adoptParts(ws: Workspace, dir: string, unlistedIndices: number[], options: PlanWriteOptions = {}): Promise<Plan> {
  return withPlanLock(ws, dir, () => adoptUnlocked(ws, dir, unlistedIndices, options, false))
}

export function materialisePart(ws: Workspace, dir: string, index: number, options: PlanWriteOptions = {}): Promise<{ plan: Plan; path: string }> {
  return withPlanLock(ws, dir, () => materialisePartUnlocked(ws, dir, index, options))
}

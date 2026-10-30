import { unescapePlanLink } from '../shared/plan-line'
import { posix } from 'node:path'
import { collectionPattern, collectionStatus, localCalendarDate } from './collection'
import { parseFrontmatter } from './frontmatter'
import { isListedPath } from './document-path'
import { slugifyFileName } from './workspace'
import type { Workspace } from './workspace'
import { FACTS_READ_CONCURRENCY, factsReader, mapBounded } from './file-facts'

export type ParsedWikilink = {
  target: string
  display: string
  raw: string
  from: number
  to: number
  context: string
}

export type CollectionLink = {
  from: string
  to: string | null
  target: string
  display: string
  ambiguous?: string[]
}

export type StubInput = {
  dir: string
  title: string
  gist: string
  path?: string
  role?: string
  bodyLead?: string
  titleInFrontmatter?: boolean
  suppressBacklink?: boolean
  from?: string
  createAnyway?: boolean
  now?: Date
}

export type StubPreview = {
  path: string
  content: string
  seeded: boolean
  explanation: string
  existing: string[]
}

export type CreateStubResult =
  /** `content`: the file as read back after the create; `submitted`: the exact text this call wrote. */
  | { created: true; path: string; content: string; submitted: string; seeded: boolean }
  | { created: false; existing: string[] }

/** A piece a wikilink could mean: how it is titled, named and aliased. */
export type Candidate = { path: string; title: string; basename: string; aliases: string[] }
export type CandidateIndex = Map<string, Candidate[]>

const WIKILINK = /\[\[([^\]\n]+)\]\]/g

function proseBody(text: string): { body: string; offset: number } {
  const lineAt = (start: number): { line: string; next: number } => {
    let end = start
    while (end < text.length && text[end] !== '\r' && text[end] !== '\n') end += 1
    const endingLength = text[end] === '\r' && text[end + 1] === '\n' ? 2 : end < text.length ? 1 : 0
    return { line: text.slice(start, end), next: end + endingLength }
  }
  const bomLength = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const first = lineAt(bomLength)
  if (first.line.trim() !== '---') return { body: text, offset: 0 }

  let lineStart = first.next
  while (lineStart < text.length) {
    const current = lineAt(lineStart)
    if (current.line.trim() === '---') {
      return { body: text.slice(current.next), offset: current.next }
    }
    lineStart = current.next
  }
  return { body: text, offset: 0 }
}

function h1(text: string): string | null {
  return /^#\s+(.+?)\s*$/m.exec(proseBody(text).body)?.[1]?.trim() ?? null
}

function cleanTarget(raw: string): string {
  return raw.split('#', 1)[0].trim()
}

function withoutMarkdownExtension(value: string): string {
  return value.replace(/\.(?:md|markdown|mdx)$/i, '')
}

function addCandidate(map: CandidateIndex, tier: 'title' | 'basename' | 'alias' | 'path', key: string, candidate: Candidate): void {
  const normalised = `${tier}:${withoutMarkdownExtension(key).toLocaleLowerCase()}`
  const current = map.get(normalised)
  if (current) current.push(candidate)
  else map.set(normalised, [candidate])
}

/**
 * Build the resolution tiers once so each subsequent wikilink lookup is O(1) before tie sorting. Each piece of
 * `pathPieces` (by default `pieces`) is also filed under its workspace path (`path:`, extension dropped, lower case),
 * the key `resolveWikilinkPath` reads for a `./` path link (`[[./contents/a]]`). A Folio's running order resolves
 * titles among its line pool but paths among every file in its folder (plan.ts `planCandidates`), as the editor does.
 */
export function buildWikilinkCandidateIndex(pieces: Candidate[], pathPieces: Candidate[] = pieces): CandidateIndex {
  const index: CandidateIndex = new Map()
  for (const piece of pieces) {
    addCandidate(index, 'title', piece.title, piece)
    addCandidate(index, 'basename', piece.basename, piece)
    for (const alias of piece.aliases) addCandidate(index, 'alias', alias, piece)
  }
  for (const piece of pathPieces) addCandidate(index, 'path', piece.path, piece)
  return index
}

/** Parse prose wikilinks without treating frontmatter values as links. Offsets are document offsets. */
export function extractWikilinks(text: string): ParsedWikilink[] {
  const { body, offset: bodyOffset } = proseBody(text)
  const links: ParsedWikilink[] = []
  for (const match of body.matchAll(WIKILINK)) {
    const raw = match[1]
    const separator = raw.indexOf('|')
    const target = cleanTarget(separator < 0 ? raw : raw.slice(0, separator))
    if (!target) continue
    const display = (separator < 0 ? target : raw.slice(separator + 1).trim()) || target
    const localFrom = match.index
    const localTo = localFrom + match[0].length
    const sentenceStart = Math.max(body.lastIndexOf('.', Math.max(0, localFrom - 1)) + 1, body.lastIndexOf('\n', Math.max(0, localFrom - 1)) + 1)
    const period = body.indexOf('.', localTo)
    const newline = body.indexOf('\n', localTo)
    const ends = [period < 0 ? body.length : period + 1, newline < 0 ? body.length : newline].filter((value) => value >= localTo)
    const sentenceEnd = Math.min(...ends)
    const context = `${body.slice(sentenceStart, localFrom)}${display}${body.slice(localTo, sentenceEnd)}`.trim()
    links.push({ target, display, raw: match[0], from: bodyOffset + localFrom, to: bodyOffset + localTo, context })
  }
  return links
}

function aliasesOf(extra: Record<string, unknown>): string[] {
  const value = extra.aliases ?? extra.alias
  if (Array.isArray(value)) return value.map(String).map((alias) => alias.trim()).filter(Boolean)
  return typeof value === 'string' && value.trim() ? [value.trim()] : []
}

/** Every piece under `dir` as a wikilink candidate. Exported because the Collection bundle
 *  (main/export.ts) must resolve links by the SAME rule the editor resolves them by. */
export async function collectionCandidates(ws: Pick<Workspace, 'listFiles' | 'readFile'>, dir: string, onUnreadable?: (path: string) => void): Promise<Candidate[]> {
  return candidatesFrom(ws, await ws.listFiles(), dir, onUnreadable)
}

async function candidatesFrom(ws: Pick<Workspace, 'readFile'>, listing: Awaited<ReturnType<Workspace['listFiles']>>, dir: string, onUnreadable?: (path: string) => void): Promise<Candidate[]> {
  const files = listing.filter((file) => dir === '' || file.path.startsWith(`${dir}/`))
  // Title and aliases come from the per-file facts cache (file-facts.ts): a file is re-read and
  // re-parsed only when it changed, so resolving links after each typing pause stays cheap.
  const reader = await factsReader(ws, files, listing)
  const candidates = await mapBounded(files, FACTS_READ_CONCURRENCY, async (file) => {
    let facts
    try { facts = await reader.read(file) } catch (error) {
      if (!onUnreadable) throw error
      onUnreadable(file.path)
      return null
    }
    const { title, aliases } = facts.derive('wikilinks:candidate', (content) => ({
      title: candidateTitle(content, file.path),
      aliases: aliasesOf(parseFrontmatter(content)?.extra ?? {}),
    }))
    const basename = posix.basename(file.path).replace(/\.(?:md|markdown|mdx)$/i, '')
    return { path: file.path, title, basename, aliases: [...aliases] }
  })
  return candidates.filter((candidate): candidate is Candidate => candidate !== null)
}

/** A piece's title as a wikilink candidate carries it: frontmatter title, else first level-1 heading, else file name. */
export function candidateTitle(content: string, path: string): string {
  const basename = posix.basename(path).replace(/\.(?:md|markdown|mdx)$/i, '')
  return parseFrontmatter(content)?.title?.trim() || h1(content) || basename
}

function folderDistance(from: string, to: string): number {
  const left = posix.dirname(from) === '.' ? [] : posix.dirname(from).split('/')
  const right = posix.dirname(to) === '.' ? [] : posix.dirname(to).split('/')
  let common = 0
  while (common < left.length && common < right.length && left[common] === right[common]) common += 1
  return left.length - common + right.length - common
}

/** The one form a path link takes: its target starts with `./` and is read from the linking note's own folder. */
export function isPathLink(target: string): boolean {
  return target.trim().startsWith('./')
}

const MARKDOWN_EXTENSION = /\.(?:md|markdown|mdx)$/i

/** The workspace path a `./` path link spells, as written (extension or none), or null when it cannot name a file:
 *  it climbs, is absolute, has a backslash, ends in `/`, or, with `within`, lies outside that folder. */
function pathLinkPlace(from: string, target: string, within?: string, decode = true): string | null {
  const wanted = decode ? unescapePlanLink(target.trim()) : target.trim()
  if (!isPathLink(wanted) || wanted.includes('\\') || wanted.split('/').includes('..')) return null
  const folder = posix.dirname(from)
  const full = posix.normalize(posix.join(folder === '.' ? '' : folder, wanted))
  if (full === '.' || full === '..' || full.startsWith('../') || posix.isAbsolute(full) || full.endsWith('/') || wanted.endsWith('/')) return null
  const scoped = within !== undefined && within !== '' && within !== '.'
  if (scoped && !full.startsWith(`${within}/`)) return null
  return full
}

/**
 * The file a dead `./` path link would name once written (Sol round 4): its path from the note's folder, with the
 * extension the link gives or `.md`. Null when the link cannot name a file (`pathLinkPlace`), or names one the
 * workspace listing would never show.
 */
export function pathLinkNewFile(from: string, target: string, within?: string): string | null {
  const full = pathLinkPlace(from, target, within)
  // Only a place the workspace listing shows (the walker's own rule): a file in a hidden or tooling folder
  // (`./.bridle/x`) would be written where no link can find it (Sol round 5).
  if (full === null || posix.basename(full).startsWith('.') || !isListedPath(full, 'file')) return null
  return MARKDOWN_EXTENSION.test(full) ? full : `${full}.md`
}

/**
 * The file a `./` path link names, or null when it names none or more than one. The path is read from the linking
 * note's own folder (`./contents/a`, `./a`). Never a path that climbs (`..` anywhere), an absolute one, one with a
 * backslash, or, with `within`, one outside that folder. Only files in `index` can match: the workspace walk lists no
 * symlink and enters none (workspace.ts), so no match is a link out.
 *
 * Exact, never a silent pick (Sol round 3): a target that gives an extension matches only that extension; one that
 * gives none matches `.md`, `.markdown` or `.mdx`, and two of those both there is no match. An exact-case match wins;
 * a case-folded one counts only when it is the single candidate.
 *
 * One rule for every reader of a link: the editor and the Collection graph (`resolveWikilinkTargetFromIndex`) and the
 * Folio's running-order lines (plan.ts `resolvePlanLink`).
 */
function matchingPath(from: string, target: string, index: CandidateIndex, within?: string, decode = true): string | null {
  const full = pathLinkPlace(from, target, within, decode)
  if (full === null) return null
  const scoped = within !== undefined && within !== '' && within !== '.'
  const pool = (index.get(`path:${withoutMarkdownExtension(full).toLocaleLowerCase()}`) ?? [])
    .map((piece) => piece.path)
    .filter((path) => !scoped || path.startsWith(`${within}/`))
  const extension = MARKDOWN_EXTENSION.exec(full)?.[0]
  // With an extension the whole path is compared; without, the path less its extension.
  const stem = (path: string): string => (extension ? path : withoutMarkdownExtension(path))
  const named = extension ? pool.filter((path) => posix.extname(path).toLocaleLowerCase() === extension.toLocaleLowerCase()) : pool
  const exact = named.filter((path) => stem(path) === full)
  if (exact.length) return exact.length === 1 ? exact[0] : null
  const folded = named.filter((path) => stem(path).toLocaleLowerCase() === full.toLocaleLowerCase())
  return folded.length === 1 ? folded[0] : null
}

/** Accept old literal percent paths as well as escaped paths; two possible files require repair. */
export function resolveWikilinkPath(from: string, target: string, index: CandidateIndex, within?: string): string | null {
  const decoded = matchingPath(from, target, index, within)
  const raw = unescapePlanLink(target) === target ? decoded : matchingPath(from, target, index, within, false)
  return decoded && raw && decoded !== raw ? null : decoded ?? raw
}

/** Which piece `target` means, judged from `from` (`resolveWikilinkTargetFromIndex`): a `./` path link by its path
 *  alone, any other by title, file name, alias, each case-insensitively and without a Markdown extension; ties break
 *  on folder distance. */
export function resolveWikilinkTarget(from: string, target: string, pieces: Candidate[]): { to: string | null; ambiguous?: string[] } {
  return resolveWikilinkTargetFromIndex(from, target, buildWikilinkCandidateIndex(pieces))
}

/**
 * Which piece `target` means, judged from `from`. A target that starts with `./` is a path link
 * (`resolveWikilinkPath`): it names that file or nothing, never a title or alias. Every other target, with a `/` or
 * without, resolves as it always has: title, then file name, then alias, each case-insensitively and without a
 * Markdown extension; ties break on folder distance. `within`: the folder a path link must stay inside (a Folio's
 * folder for its running order).
 */
export function resolveWikilinkTargetFromIndex(from: string, target: string, index: CandidateIndex, scope: { within?: string } = {}): { to: string | null; ambiguous?: string[] } {
  if (isPathLink(target)) {
    const decoded = matchingPath(from, target, index, scope.within)
    const raw = unescapePlanLink(target) === target ? decoded : matchingPath(from, target, index, scope.within, false)
    if (decoded && raw && decoded !== raw) return { to: null, ambiguous: [decoded, raw] }
    return { to: decoded ?? raw }
  }
  const wanted = withoutMarkdownExtension(target).toLocaleLowerCase()
  const tiers = [index.get(`title:${wanted}`), index.get(`basename:${wanted}`), index.get(`alias:${wanted}`)]
  const matches = tiers.find((tier) => (tier?.length ?? 0) > 0) ?? []
  if (!matches.length) return { to: null }
  const ordered = [...matches].sort((a, b) => folderDistance(from, a.path) - folderDistance(from, b.path) || a.path.localeCompare(b.path))
  return { to: ordered[0].path, ...(ordered.length > 1 ? { ambiguous: ordered.map((piece) => piece.path) } : {}) }
}

/** Build the read-only link graph for a Collection, including dead links and explicit ambiguity. */
export async function collectionLinks(ws: Workspace, dir: string, override?: { from: string; content: string }): Promise<CollectionLink[]> {
  const listing = await ws.listFiles()
  const pieces = await candidatesFrom(ws, listing, dir)
  const index = buildWikilinkCandidateIndex(pieces)
  const byPath = new Map(listing.map((file) => [file.path, file]))
  const reader = await factsReader(ws, [], listing)
  const links: CollectionLink[] = []
  for (const piece of pieces) {
    const file = byPath.get(piece.path)
    const parsedLinks = override?.from === piece.path
      ? extractWikilinks(override.content)
      : file ? (await reader.read(file)).derive('wikilinks:parsed', extractWikilinks) : extractWikilinks((await ws.readFile(piece.path)).content)
    for (const parsed of parsedLinks) {
      links.push({ from: piece.path, target: parsed.target, display: parsed.display, ...resolveWikilinkTargetFromIndex(piece.path, parsed.target, index) })
    }
  }
  return links
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

function displayTitle(path: string, content: string): string {
  return parseFrontmatter(content)?.title?.trim() || h1(content) || posix.basename(path).replace(/\.(?:md|markdown|mdx)$/i, '')
}

async function freeStubPath(ws: Workspace, baseDir: string, title: string): Promise<string> {
  const files = new Set((await ws.listFiles()).map((file) => file.path))
  const filename = slugifyFileName(title)
  const extension = posix.extname(filename)
  const stem = filename.slice(0, -extension.length)
  let path = baseDir ? posix.join(baseDir, filename) : filename
  for (let suffix = 2; files.has(path); suffix += 1) path = baseDir ? posix.join(baseDir, `${stem}-${suffix}${extension}`) : `${stem}-${suffix}${extension}`
  return path
}

function seedFrontmatter(keys: string[], input: StubInput): string {
  const required = ['status', 'description', ...(input.role ? ['role'] : []), ...(input.titleInFrontmatter ? ['title'] : [])]
  const ordered = keys.filter((key) => key !== 'title')
  for (const key of required) if (!ordered.includes(key)) ordered.unshift(key)
  const lines = ordered.map((key) => {
    if (key === 'status') return 'status: idea'
    if (key === 'description') return `description: ${yamlString(input.gist)}`
    if (key === 'role' && input.role !== undefined) return `role: ${yamlString(input.role)}`
    if (key === 'title' && input.titleInFrontmatter) return `title: ${yamlString(input.title)}`
    if (key === 'date') return `date: ${localCalendarDate(input.now ?? new Date())}`
    if (key === 'tags' || key === 'related') return `${key}: []`
    return `${key}: `
  })
  return `---\n${lines.join('\n')}\n---\n\n`
}

/** Preview the exact path/content used by both dead-link materialisation and Capture. */
export async function previewCollectionStub(ws: Workspace, input: StubInput): Promise<StubPreview> {
  const title = input.title.trim()
  if (!title) throw new Error('A Stub title is required.')
  const pieces = await collectionCandidates(ws, input.dir)
  const existing = pieces.filter((piece) => piece.title.toLocaleLowerCase() === title.toLocaleLowerCase()).map((piece) => piece.path).sort()
  const ideasDir = input.dir ? posix.join(input.dir, 'ideas') : 'ideas'
  const folders = new Set(await ws.listFolders())
  const placement = folders.has(ideasDir) ? ideasDir : input.dir
  const path = input.path ?? await freeStubPath(ws, placement, title)
  const detected = await collectionStatus(ws, input.dir)
  const seeded = detected.collection || input.role !== undefined
  const backlink = input.from && !input.suppressBacklink
    ? `Backlink: [[${displayTitle(input.from, (await ws.readFile(input.from)).content)}]].`
    : ''
  const bodyLead = input.bodyLead?.trim() ?? ''
  const bodyLines = [bodyLead, backlink].filter(Boolean)
  const body = `# ${title}\n\n${bodyLines.join('\n\n')}${bodyLines.length ? '\n' : ''}`
  const content = seeded ? `${seedFrontmatter((await collectionPattern(ws, input.dir)).keys, input)}${body}` : body
  return {
    path,
    content,
    seeded,
    explanation: seeded
      ? `Will create a Stub in ${placement || 'the Collection root'} using this Collection's Frontmatter Pattern.`
      : `This is a bare folder, so WriteFlex will create plain Markdown in ${placement || 'the folder root'} without inventing frontmatter.`,
    existing,
  }
}

/** Main-owned Stub write used by both capture paths; never writes outside Workspace containment. */
export async function createCollectionStub(ws: Workspace, input: StubInput, lastCheck?: () => void): Promise<CreateStubResult> {
  const preview = await previewCollectionStub(ws, input)
  if (preview.existing.length && !input.createAnyway) return { created: false, existing: preview.existing }
  // `lastCheck` (synchronous) runs immediately before the create, with nothing awaited between: a refusal throws.
  lastCheck?.()
  const created = await ws.createFile(preview.path, preview.content)
  return { created: true, path: created.file.path, content: created.content, submitted: preview.content, seeded: preview.seeded }
}

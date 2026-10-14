import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import type {
  ArchivePassageResponse,
  ArchiveResult,
  ArchiveScope,
  ArchiveSearchRequest,
  ArchiveSearchResponse,
} from '../shared/scout'

/**
 * The main-process adapter over the `scout` CLI (WF-4B archive search).
 *
 * The seam is three calls: find the binary, search, and fetch one passage in context. Everything the
 * engine decides — parsing the query, ranking, citation text — stays in the CLI; this module only
 * spawns it with `--json` (never through a shell), parses the documented schema-1 output and maps it
 * to the shared types. Sources are only ever read, and quotes pass through as the CLI printed them.
 */

export type ScoutEnvironment = {
  /** `process.env.PATH`. A Finder-launched app has a minimal PATH, hence the ~/.cargo/bin fallback. */
  pathEnv?: string
  home?: string
  /** `WRITEFLEX_SCOUT_BIN`: when set, the ONLY candidate (tests and e2e point it at a fake or at nothing). */
  override?: string
  isExecutable?: (candidate: string) => boolean
}

export type ScoutRunOptions = { timeoutMs?: number }

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100
const MAX_QUERY_LENGTH = 1_000
const PASSAGE_ID = /^[a-z0-9_-]+:.+:\d+$/i

function defaultIsExecutable(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The `scout` binary to run: the override alone when set; else the first on PATH; else ~/.cargo/bin/scout. */
export function resolveScoutBinary(env: ScoutEnvironment = {}): string | null {
  const isExecutable = env.isExecutable ?? defaultIsExecutable
  const override = env.override?.trim()
  if (override) return isAbsolute(override) && isExecutable(override) ? override : null
  for (const dir of (env.pathEnv ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue
    const candidate = join(dir, 'scout')
    if (isExecutable(candidate)) return candidate
  }
  if (env.home) {
    const cargo = join(env.home, '.cargo', 'bin', 'scout')
    if (isExecutable(cargo)) return cargo
  }
  return null
}

/** The live process environment, resolved per call so installing scout needs no relaunch. */
export function processScoutEnvironment(): ScoutEnvironment {
  return { pathEnv: process.env.PATH, home: process.env.HOME, override: process.env.WRITEFLEX_SCOUT_BIN }
}

type RunResult = { code: number; stdout: string; stderr: string }

function run(binary: string, args: string[], options: ScoutRunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true }, (error, stdout, stderr) => {
      if (error && typeof (error as NodeJS.ErrnoException).code !== 'number') {
        const killed = (error as { killed?: boolean }).killed
        reject(new Error(killed ? 'The archive search took too long and was stopped.' : error.message))
        return
      }
      resolve({ code: error ? Number((error as NodeJS.ErrnoException).code) : 0, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

/** The CLI's own complaint (its last stderr line, minus the `scout:` prefix), or a fallback. */
function complaint(stderr: string, fallback: string): string {
  const line = stderr.split('\n').map((entry) => entry.trim()).filter((entry) => entry && !entry.startsWith('scout: note:')).at(-1)
  return line ? line.replace(/^scout:\s*/, '') : fallback
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function parseJson(stdout: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stdout)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('scout printed something other than a JSON object.')
  const record = parsed as Record<string, unknown>
  if (record.schema_version !== 1) throw new Error(`scout printed schema ${String(record.schema_version)}; WriteFlex reads schema 1.`)
  return record
}

/** One `results[]` entry → the panel's result, using the document's best (first) hit. */
function mapResult(raw: unknown): ArchiveResult | null {
  if (!raw || typeof raw !== 'object') return null
  const result = raw as Record<string, unknown>
  const hit = Array.isArray(result.hits) ? result.hits[0] as Record<string, unknown> | undefined : undefined
  const citation = result.citation as Record<string, unknown> | undefined
  const passageId = asString(hit?.passage_id)
  const quote = asString(hit?.quote)
  const markdown = asString(citation?.markdown)
  if (!hit || !passageId || quote === null || !markdown) return null
  return {
    corpus: asString(result.corpus) ?? '',
    title: asString(result.title) ?? '',
    author: asString(result.author),
    date: asString(result.date),
    dateDisplay: asString(result.date_display),
    genre: asString(result.genre),
    source: asString(result.source),
    publicUrl: asString(result.public_url),
    passageId,
    line: asNumber(hit.line, asNumber(hit.line_start, 1)),
    quote,
    link: asString(hit.link) ?? '',
    citationMarkdown: markdown,
  }
}

/** `scout search --json [--in corpus] --limit N -- <query>`, typed. */
export async function searchArchive(
  request: ArchiveSearchRequest,
  env: ScoutEnvironment = processScoutEnvironment(),
  options: ScoutRunOptions = {},
): Promise<ArchiveSearchResponse> {
  const query = typeof request?.query === 'string' ? request.query.trim() : ''
  if (!query) return { status: 'ok', query: '', corpora: [], totalDocuments: 0, totalPassages: 0, results: [] }
  if (query.length > MAX_QUERY_LENGTH) return { status: 'error', message: 'The search is too long.' }
  const scope: ArchiveScope = request.scope ?? 'all'
  if (!['all', 'writing', 'tweets', 'highlights'].includes(scope)) return { status: 'error', message: 'Unknown search scope.' }
  const limit = Math.min(Math.max(Math.trunc(request.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT)
  const binary = resolveScoutBinary(env)
  if (!binary) return { status: 'missing' }
  // `--` ends the options, so a query that starts with `-` (an exclusion) is never read as a flag.
  const args = ['search', '--json', '--limit', String(limit), ...(scope === 'all' ? [] : ['--in', scope]), '--', query]
  let outcome: RunResult
  try {
    outcome = await run(binary, args, options)
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) }
  }
  if (outcome.code === 2 || outcome.code === 3) return { status: 'unavailable', message: complaint(outcome.stderr, 'The archive index is not available.') }
  if (outcome.code !== 0 && outcome.code !== 1) return { status: 'error', message: complaint(outcome.stderr, `scout exited with code ${outcome.code}.`) }
  try {
    const parsed = parseJson(outcome.stdout)
    const results = (Array.isArray(parsed.results) ? parsed.results : []).map(mapResult).filter((entry): entry is ArchiveResult => entry !== null)
    return {
      status: 'ok',
      query: asString(parsed.query) ?? query,
      corpora: Array.isArray(parsed.corpora) ? parsed.corpora.filter((entry): entry is string => typeof entry === 'string') : [],
      totalDocuments: asNumber(parsed.total_documents, results.length),
      totalPassages: asNumber(parsed.total_passages, results.length),
      results,
    }
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}

const NOT_PROSE = /^(?:#{1,6}\s|```|~~~|---\s*$|\*\*\*\s*$|<|\||!\[)/

/** The nearest non-empty line from `start` stepping by `step`, when it is a prose line outside the
 *  frontmatter; null at a heading, fence, rule, table, HTML or image (a new unit of attention). */
function neighbourLine(lines: string[], start: number, step: 1 | -1, frontmatterEnd: number): string | null {
  for (let index = start; index >= 0 && index < lines.length; index += step) {
    const text = lines[index].trim()
    if (!text) continue
    if (index <= frontmatterEnd || NOT_PROSE.test(text)) return null
    return lines[index].replace(/\s+$/, '')
  }
  return null
}

/** The last frontmatter line's 0-based index, or -1 when the file has none. */
function frontmatterEndIndex(lines: string[]): number {
  if (lines[0]?.trim() !== '---') return -1
  for (let index = 1; index < lines.length; index += 1) if (/^(?:---|\.\.\.)\s*$/.test(lines[index])) return index
  return -1
}

/** `scout cite --json -- <passage id>`: the whole passage, plus for a writing piece the prose line
 *  before and after it, read from the source file only when the file still matches the index. */
export async function archivePassage(
  passageId: string,
  env: ScoutEnvironment = processScoutEnvironment(),
  options: ScoutRunOptions = {},
): Promise<ArchivePassageResponse> {
  if (typeof passageId !== 'string' || !PASSAGE_ID.test(passageId) || passageId.length > 4_096) return { status: 'error', message: 'Invalid passage.' }
  const binary = resolveScoutBinary(env)
  if (!binary) return { status: 'missing' }
  let outcome: RunResult
  try {
    outcome = await run(binary, ['cite', '--json', '--', passageId], options)
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) }
  }
  if (outcome.code === 1) return { status: 'unavailable', message: 'The index no longer has this passage.' }
  if (outcome.code === 2 || outcome.code === 3) return { status: 'unavailable', message: complaint(outcome.stderr, 'The archive index is not available.') }
  if (outcome.code !== 0) return { status: 'error', message: complaint(outcome.stderr, `scout exited with code ${outcome.code}.`) }
  let cite: Record<string, unknown>
  try {
    cite = parseJson(outcome.stdout)
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) }
  }
  const passage = asString(cite.quote)
  if (passage === null) return { status: 'error', message: 'scout printed no passage.' }
  const context = cite.corpus === 'writing' ? await neighbours(cite, passage) : { before: null, after: null }
  return { status: 'ok', passage, ...context }
}

async function neighbours(cite: Record<string, unknown>, passage: string): Promise<{ before: string | null; after: string | null }> {
  const none = { before: null, after: null }
  const path = asString(cite.path)
  const lineStart = asNumber(cite.line_start, 0)
  const lineEnd = asNumber(cite.line_end, lineStart)
  if (!path || !isAbsolute(path) || !/\.(?:md|markdown|mdx)$/i.test(path) || lineStart < 1 || lineEnd < lineStart) return none
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return none
  }
  const lines = text.split(/\r?\n/)
  // A stale index points at lines that moved: show no context rather than the wrong neighbours.
  const firstPassageLine = passage.split('\n')[0].trim()
  if (!lines.slice(lineStart - 1, lineEnd).join('\n').includes(firstPassageLine)) return none
  const frontmatterEnd = frontmatterEndIndex(lines)
  return {
    before: neighbourLine(lines, lineStart - 2, -1, frontmatterEnd),
    after: neighbourLine(lines, lineEnd, 1, frontmatterEnd),
  }
}

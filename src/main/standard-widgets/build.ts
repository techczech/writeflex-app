/**
 * Building a standard widget (contracts §9, C8): recipe + source → `widget.html` and its receipt
 * `widget.build.json`, beside `visualisations/<name>/widget.md`. Main process only.
 *
 * What holds:
 * - Every read is contained: the recipe, the source and the previous output are read through a no-follow walk
 *   and a checked descriptor (`readContainedFile`); a link anywhere on a path is refused, never followed. A
 *   `source.path` must stay inside the document's folder (the Folio folder: the folder that holds
 *   `visualisations/`), by the Folio containment rule (`manifestFilePathCandidates`); a `source.resource` must be
 *   a declared item of the Folio manifest whose path passes the same checks (§1).
 * - Deterministic: `widget.html` is a function of the recipe, the source records and the template; the same
 *   inputs give the same bytes. The time of the build is in the receipt only.
 * - A failed build never replaces a working page: `widget.html` is kept and the receipt says `failed` with every
 *   named error (at most 50).
 * - A hand-edited page is kept: when `widget.html` is not the page the last receipt recorded, the new page goes to
 *   `widget.rebuilt.html` and the build warns `output-hand-edited`.
 * - A source kept in sync (contracts §1, §1.1; ticket 04c) is refreshed first: its grant is looked up by the
 *   building Folio's identity and the item's id, and only an exact match reads the original (no link followed, a
 *   regular file within the size cap). Changed bytes replace the cached copy by the guarded write, only over the
 *   copy as it was read, and the item's `capture` is updated. An original that is missing or unreadable, a grant
 *   unknown on this Mac or bound elsewhere is a named warning; the build goes on with the cached copy. The outcome is
 *   in the receipt's `states`.
 * - Writes are the Workspace's guarded writes (`writeInWidgetFolder`: staged through a no-follow handle whose real
 *   location is checked, then renamed) and land only in the widget's own folder, which is checked again, without
 *   following anything, in the tick of each commit. `widget.html` is replaced only while it still holds the bytes
 *   this build read; an edit made while the build ran is kept like any hand edit.
 */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { manifestFilePathCandidates } from '../folio'
import { MANIFEST_NAME } from '../../shared/folio-constants'
import { eachInline, readDocument, type Inline } from '../../shared/markdown/model'
import { toHtml } from '../../shared/markdown/to-html'
import { readContainedFile, walkNoFollowSync, WIDGET_MAX_BYTES } from '../widget-file'
import { assertRelativeWorkspacePath, isHiddenWorkspacePath, type Workspace } from '../workspace'
import { readCsvRecords, readJsonRecords, type RecordRead, type RecordSet } from './adapters'
import { BROWSER_TEMPLATE_SHA256, browserRecords, renderBrowserPage } from './browser-template'
import { BUILD_ERROR_CAP, buildError, type BuildError } from './build-errors'
import { checkRecipe, declaredTypes, isRecipeMap, mappedFields, parseRecipeText, type RecipeMap, type WidgetIssue } from './recipe'
import { setResourceItemCaptureText } from './resources-manifest'
import { appSyncGrantStore, lookupGrant, readOrigin, type SyncGrantStore } from './sync-grants'

/** `bytes` as text that encodes back to exactly these bytes (a byte-order mark kept), or null. */
function exactUtf8(bytes: Buffer): string | null {
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { return null }
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null
}

export const WIDGET_RECIPE_NAME = 'widget.md'
export const WIDGET_OUTPUT_NAME = 'widget.html'
export const WIDGET_REBUILT_NAME = 'widget.rebuilt.html'
export const WIDGET_RECEIPT_NAME = 'widget.build.json'
export const VISUALISATIONS_DIR = 'visualisations'
/** Largest recipe read. A recipe is a few hundred bytes. */
const RECIPE_MAX_BYTES = 256 * 1024
/** Largest source read: half the frame's page limit, so the page built from it has room. */
export const SOURCE_MAX_BYTES = 8 * 1024 * 1024
/** §8.1: a frame's resource set holds at most this many ids. */
const FRAME_SET_MAX = 500

export type BuildReceipt = {
  widget_schema: unknown
  template: unknown
  template_version: unknown
  recipe_sha256: string
  inputs: Array<{ path: string; sha256: string } | { resource: string; sha256: string }>
  template_sha256: string | null
  output_sha256: string | null
  built_at: string
  result: 'built' | 'failed' | 'kept-hand-edit'
  errors: BuildError[]
  states: string[]
  resources: string[]
}

export type BuildOutcome = {
  result: 'built' | 'failed' | 'kept-hand-edit'
  /** Workspace-relative paths. */
  recipePath: string
  outputPath: string
  /** The file this build wrote its page to (`widget.html`, or `widget.rebuilt.html` beside a hand edit); null when none. */
  writtenOutput: string | null
  errors: BuildError[]
  /** The receipt as written; null when the recipe could not be read, so nothing was written. */
  receipt: BuildReceipt | null
  /** Every file this build wrote, workspace-relative. */
  written: string[]
}

export type BuildOptions = {
  now?: () => Date
  /** The sync grant store (contracts §1.1); unset: the app's (`appSyncGrantStore`). */
  grants?: SyncGrantStore | null
}

/** Where a recipe's widget folder and Folio folder are: `<folio>/visualisations/<name>/widget.md`. */
export function recipePlace(recipePath: string): { folder: string; bundle: string; name: string } | null {
  const parts = recipePath.split('/')
  if (parts.length < 3 || parts[parts.length - 1] !== WIDGET_RECIPE_NAME || parts[parts.length - 3] !== VISUALISATIONS_DIR) return null
  const name = parts[parts.length - 2]
  if (name === '' || name.startsWith('.')) return null
  return { folder: parts.slice(0, -1).join('/'), bundle: parts.slice(0, -3).join('/'), name }
}

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const inFolder = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`)
const timestamp = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z')

function decodeUtf8(bytes: Buffer): string | null {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return null }
}

const slugCache = new Map<string, string>()
/** The app's native heading id of `text` (the `slug` of to-html.ts, read through the renderer). */
export function nativeSlug(text: string): string {
  let slug = slugCache.get(text)
  if (slug === undefined) {
    slug = /<h1 id="([^"]*)"/.exec(toHtml(`# ${text}`, { stableHeadingIds: true }).html)?.[1] ?? ''
    if (slugCache.size > 2000) slugCache.clear()
    slugCache.set(text, slug)
  }
  return slug
}
/** §5: a resource id is valid when the native slug leaves it unchanged and it is at most 80 characters. */
export const isSlugId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 80 && nativeSlug(value) === value

type DeclaredItem = { id: string; path: string; raw: Record<string, unknown> }

/** The manifest's declared resource items with a valid id and a path (others declare nothing a widget may use). */
function declaredItems(manifestText: string | null): DeclaredItem[] {
  if (manifestText === null) return []
  let json: unknown
  try { json = JSON.parse(manifestText) } catch { return [] }
  const resources = isRecipeMap(json) ? (json as Record<string, unknown>).resources : undefined
  const items = typeof resources === 'object' && resources !== null ? (resources as Record<string, unknown>).items : undefined
  if (!Array.isArray(items)) return []
  return items.flatMap((item): DeclaredItem[] => {
    if (typeof item !== 'object' || item === null) return []
    const record = item as Record<string, unknown>
    return isSlugId(record.id) && typeof record.path === 'string' ? [{ id: record.id, path: record.path, raw: record }] : []
  })
}

/** §1's declaration rules for the one item a recipe names: one code, or null when it may be read. */
function declarationProblem(item: DeclaredItem): string | null {
  const inclusion = item.raw.inclusion
  if (!['in-place', 'copy', 'sync'].includes(inclusion as string)) return 'resource-declaration-invalid'
  if ('origin' in item.raw) return 'resource-declaration-invalid'
  if (inclusion === 'sync' ? !(typeof item.raw.grant === 'string' && /^g-[a-z2-7]{26}$/.test(item.raw.grant)) : 'grant' in item.raw) return 'resource-declaration-invalid'
  return null
}

type SourceRead =
  | { ok: true; text: string; bytes: Buffer; folioPath: string; input: { path: string } | { resource: string } }
  | { ok: false; errors: WidgetIssue[]; path: string }

const LEXICAL_FOLIO = { contentRoot: '', files: [] }

/** Resolve and read the recipe's source, contained in the Folio folder, nothing followed (§1, §3). */
async function readSource(realRoot: string, bundle: string, folder: string, recipe: RecipeMap, manifestText: string | null): Promise<SourceRead> {
  const source = recipe.source as RecipeMap
  let workspacePath: string
  let folioPath: string
  let input: { path: string } | { resource: string }
  let codes: { outside: string; link: string; missing: string; unreadable: string }
  if (typeof source.path === 'string') {
    const authored = source.path
    const fromBundle = posix.normalize(posix.join(folder.slice(bundle === '' ? 0 : bundle.length + 1), authored.replace(/\\/g, '/')))
    const candidates = authored === '' || /^[\\/]/.test(authored) || /^[a-zA-Z]:[\\/]/.test(authored) ? [] : manifestFilePathCandidates(bundle, LEXICAL_FOLIO, { path: fromBundle })
    codes = { outside: 'source-outside', link: 'source-unreadable', missing: 'source-missing', unreadable: 'source-unreadable' }
    if (candidates.length === 0 || isHiddenWorkspacePath(candidates[0])) return { ok: false, path: inFolder(folder, authored), errors: [{ code: 'source-outside', value: authored }] }
    workspacePath = candidates[0]
    folioPath = fromBundle
    input = { path: authored }
  } else {
    const id = source.resource as string
    const item = declaredItems(manifestText).find((candidate) => candidate.id === id)
    if (!item) return { ok: false, path: inFolder(bundle, MANIFEST_NAME), errors: [{ code: 'resource-id-unknown', value: id }] }
    const problem = declarationProblem(item)
    if (problem) return { ok: false, path: inFolder(bundle, MANIFEST_NAME), errors: [{ code: problem, value: id }] }
    const candidates = manifestFilePathCandidates(bundle, LEXICAL_FOLIO, { path: item.path })
    codes = { outside: 'resource-outside', link: 'resource-link-refused', missing: 'resource-missing', unreadable: 'resource-unreadable' }
    if (candidates.length === 0 || isHiddenWorkspacePath(candidates[0])) return { ok: false, path: inFolder(bundle, MANIFEST_NAME), errors: [{ code: 'resource-outside', value: id }] }
    workspacePath = candidates[0]
    folioPath = posix.normalize(item.path)
    input = { resource: id }
  }
  const read = await readContainedFile(realRoot, workspacePath, SOURCE_MAX_BYTES)
  if (!read.ok) {
    const code = read.reason === 'missing' ? codes.missing
      : read.reason === 'link' ? codes.link
      : read.reason === 'too-large' ? 'source-too-large'
      : codes.unreadable
    const detail = read.reason === 'link' ? 'it is reached through a link, and WriteFlex reads only real files inside the Folio'
      : read.reason === 'not-file' ? 'it is not a file'
      : read.reason === 'changed' ? 'it changed while it was being read'
      : read.reason === 'too-large' ? `larger than ${SOURCE_MAX_BYTES / 1024 / 1024} MiB` : undefined
    return { ok: false, path: workspacePath, errors: [{ code, ...(detail ? { detail } : {}) }] }
  }
  const text = decodeUtf8(read.bytes)
  if (text === null) return { ok: false, path: workspacePath, errors: [{ code: 'source-not-utf8' }] }
  return { ok: true, text, bytes: read.bytes, folioPath, input }
}

/** The adapter the recipe's source format names. */
function readRecords(recipe: RecipeMap, folioPath: string, text: string): RecordRead {
  const source = recipe.source as RecipeMap
  const mapping = isRecipeMap(recipe.mapping) ? recipe.mapping : {}
  const options = { idField: typeof mapping.id === 'string' ? mapping.id : undefined, types: declaredTypes(recipe), mapped: mappedFields(recipe) }
  if (source.format === 'csv') return readCsvRecords(folioPath, text, options)
  return readJsonRecords(folioPath, text, { pointer: (source.select as RecipeMap).pointer as string }, options)
}

/** What this version builds: the browser template from CSV or a JSON array. Other registered templates and
 *  sources belong to later slices and are named, not attempted. */
function notBuiltHere(recipe: RecipeMap): WidgetIssue[] {
  if (recipe.template !== 'browser') return [{ code: 'recipe-unknown-template', value: recipe.template, detail: 'this version of WriteFlex builds the record browser only' }]
  const format = (recipe.source as RecipeMap).format
  if (format !== 'csv' && format !== 'json') return [{ code: 'recipe-mapping-incompatible', field: 'source.format', value: format, detail: 'this version of WriteFlex builds a record browser from CSV or a JSON array' }]
  return []
}

/**
 * §8.1, for the receipt (informational; the host derives its own set): declared resources a record's Markdown
 * detail links to, plus the values of a mapped `resource` field. An undeclared `resource` value is
 * `resource-id-unknown`, naming the record.
 */
function frameResources(recipe: RecipeMap, set: RecordSet, items: DeclaredItem[]): { ids: string[]; errors: WidgetIssue[] } {
  const mapping = isRecipeMap(recipe.mapping) ? recipe.mapping : {}
  const byPath = new Map(items.map((item) => [posix.normalize(item.path), item.id]))
  const declared = new Set(items.map((item) => item.id))
  const found = new Set<string>()
  const errors: WidgetIssue[] = []
  const sourceFolder = posix.dirname(set.source.path)
  const detailField = typeof mapping.detail === 'string' ? mapping.detail : null
  const resourceField = typeof mapping.resource === 'string' ? mapping.resource : null
  set.records.forEach((record, index) => {
    const detail = detailField !== null && Object.hasOwn(record.values, detailField) ? record.values[detailField] : null
    if (detail) {
      const document = readDocument(detail)
      const visit = (inline: Inline): void => {
        if (inline.kind !== 'link') return
        const target = inline.href
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('/')) return
        let path: string
        try { path = decodeURI(target.split('#')[0]) } catch { return }
        if (path === '') return
        const resolved = posix.normalize(posix.join(sourceFolder, path))
        if (resolved === '..' || resolved.startsWith('../')) return
        const id = byPath.get(resolved)
        if (id !== undefined) found.add(id)
      }
      eachInline(document.blocks, visit)
      for (const note of document.footnotes) eachInline(note.children, visit)
    }
    const linked = resourceField !== null && Object.hasOwn(record.values, resourceField) ? record.values[resourceField] : null
    if (linked) {
      if (declared.has(linked)) found.add(linked)
      else if (errors.length < BUILD_ERROR_CAP) errors.push({ code: 'resource-id-unknown', ...('line' in record.locator && 'record' in record.locator ? { line: record.locator.line } : { pointer: (record.locator as { pointer: string }).pointer }), record: index + 1, field: resourceField, value: linked })
    }
  })
  const ids = [...found].sort()
  if (ids.length > FRAME_SET_MAX) errors.push({ code: 'recipe-invalid', field: 'mapping.resource', detail: `a widget may open at most ${FRAME_SET_MAX} resources` })
  return { ids, errors }
}

/** The previous receipt's recorded page hash, when the receipt reads; null otherwise. */
function recordedOutputHash(text: string | null): string | null {
  if (text === null) return null
  try {
    const json = JSON.parse(text) as unknown
    return isRecipeMap(json) && typeof (json as Record<string, unknown>).output_sha256 === 'string' ? (json as Record<string, string>).output_sha256 : null
  } catch { return null }
}

/** A text file's contents when it is a real file inside, null when it is not there; throws on a link. */
async function readOptional(realRoot: string, path: string, maxBytes: number): Promise<Buffer | null> {
  const read = await readContainedFile(realRoot, path, maxBytes)
  if (read.ok) return read.bytes
  if (read.reason === 'missing') return null
  throw new Error(`${path} is ${read.reason === 'link' ? 'reached through a link' : 'not a file WriteFlex can read'}`)
}

/** Thrown by `writeInWidgetFolder` when the file at the path no longer holds the bytes it was read as; nothing was written. */
export class OutputChangedSinceRead extends Error {
  constructor(readonly path: string) { super(`${path} changed while the widget was being built, so it was not replaced`) }
}

export type WidgetFolderWrite = {
  /** The bytes the file held when it was read (null: there was no file). Checked in the tick of the commit: any
   *  other content there refuses the write with `OutputChangedSinceRead`. Undefined: not checked. */
  basis?: Buffer | null
  /** Create the file, never replace one. */
  exclusive?: boolean
}

/**
 * THE write of a file in a widget folder (recipe, page, receipt). `folder` is the widget folder, whose identity was
 * taken as `folderId`. The write is the Workspace's guarded one (`documentOnly`: staged beside the file through a
 * handle that follows no link, its real location checked, then renamed or linked into the folder's real path), so a
 * folder swapped for a link at any point before the commit puts nothing outside the Workspace. In the tick of the
 * commit, the folder is walked again without following anything and must still be that real folder (and so must the
 * real folder the write commits in, so a folder swapped for a link and back is caught), the name must
 * be free or a real file, and, with `basis`, the file must still hold exactly those bytes.
 */
export async function writeInWidgetFolder(ws: Workspace, realRoot: string, folder: string, folderId: { dev: number; ino: number }, path: string, text: string, write: WidgetFolderWrite = {}): Promise<void> {
  await ws.saveFileWithoutReadBack(path, text, {
    allowExplicitEmpty: true,
    documentOnly: true,
    ...(write.exclusive ? { exclusive: true } : {}),
    beforeCommit: (commit) => {
      const now = walkNoFollowSync(realRoot, folder)
      if (now.kind !== 'directory' || now.dev !== folderId.dev || now.ino !== folderId.ino) throw new Error(`${folder} changed while the widget was being saved`)
      // The real folder the write commits in must be that folder too: one swapped for a link and back after the
      // write judged it (so it staged elsewhere) is caught here.
      let real: { dev: number; ino: number } | null = null
      try { if (commit) { const info = lstatSync(commit.folder); if (info.isDirectory()) real = { dev: info.dev, ino: info.ino } } } catch { real = null }
      if (!real || real.dev !== folderId.dev || real.ino !== folderId.ino) throw new Error(`${folder} changed while the widget was being saved`)
      const target = walkNoFollowSync(realRoot, path)
      if (target.kind !== 'file' && !(target.kind === 'missing' && target.last)) throw new Error(`${path} is not a plain file`)
      if (write.basis === undefined) return
      if (write.basis === null ? target.kind !== 'missing' : target.kind !== 'file' || !sameBytes(realRoot, path, write.basis)) throw new OutputChangedSinceRead(path)
    },
  })
}

/** Whether the real file at `path` holds exactly `bytes` (read in the caller's tick). */
function sameBytes(realRoot: string, path: string, bytes: Buffer): boolean {
  try { return readFileSync(join(realRoot, ...path.split('/'))).equals(bytes) } catch { return false }
}

/**
 * Rewrite the Folio manifest of `bundle` from `current` (the text the caller read) to `next`, only while it still
 * holds `current`: in a Folio folder by the guarded write (`writeInWidgetFolder`, the folder's identity checked in
 * the tick of the commit); the Workspace folder itself by the Workspace's compare-before-rename.
 */
export async function writeManifestOver(ws: Workspace, realRoot: string, bundle: string, current: string, next: string): Promise<void> {
  const path = inFolder(bundle, MANIFEST_NAME)
  if (next === current) return
  if (bundle === '') {
    await ws.saveFileWithoutReadBack(path, next, { documentOnly: true, beforeCommit: ws.commitOnlyOver(path, { kind: 'disk', text: current }) })
    return
  }
  const walked = walkNoFollowSync(realRoot, bundle)
  if (walked.kind !== 'directory') throw new Error(`${bundle} is not a real folder of the open Workspace`)
  await writeInWidgetFolder(ws, realRoot, bundle, { dev: walked.dev, ino: walked.ino }, path, next, { basis: Buffer.from(current, 'utf8') })
}

type SyncRefresh = { manifestText: string | null; issues: Array<{ issue: WidgetIssue; path: string }>; states: string[]; written: string[]; failed: Array<{ issue: WidgetIssue; path: string }> }

/** TEST-ONLY: run after the cached copy is read and before it is replaced (to change it in the race). */
export const syncRefreshSeams: { beforeReplace?: (path: string) => void } = {}

/**
 * The sync step of a build (see the module note): nothing for a source that is not a declared `sync` item with a
 * well-formed declaration and a contained path (the read after it names those). Never reads the original unless
 * the grant's binding matches exactly.
 */
async function refreshSyncedSource(ws: Workspace, realRoot: string, bundle: string, recipe: RecipeMap, manifestText: string | null, store: SyncGrantStore | null, now: Date): Promise<SyncRefresh> {
  const none: SyncRefresh = { manifestText, issues: [], states: [], written: [], failed: [] }
  const source = isRecipeMap(recipe.source) ? recipe.source : null
  if (!source || typeof source.resource !== 'string') return none
  const item = declaredItems(manifestText).find((candidate) => candidate.id === source.resource)
  if (!item || item.raw.inclusion !== 'sync' || declarationProblem(item) !== null) return none
  const candidates = manifestFilePathCandidates(bundle, LEXICAL_FOLIO, { path: item.path })
  if (candidates.length === 0 || isHiddenWorkspacePath(candidates[0])) return none
  const copyPath = candidates[0]
  if (bundle !== '' && walkNoFollowSync(realRoot, bundle).kind !== 'directory') return none
  const folio = bundle === '' ? realRoot : join(realRoot, ...bundle.split('/'))
  const warn = (code: string, detail?: string): SyncRefresh => ({ ...none, issues: [{ issue: { code, value: item.id, ...(detail ? { detail } : {}) }, path: copyPath }], states: [`${code}:${item.id}`] })
  const lookup = lookupGrant(store, folio, item.id, item.raw.grant)
  if (!lookup.ok) return warn(lookup.code)
  // The cached copy as it is now: the replacement commits only over these bytes (null: there is none).
  const cached = await readContainedFile(realRoot, copyPath, SOURCE_MAX_BYTES)
  if (!cached.ok && cached.reason !== 'missing') return none
  const original = await readOrigin(lookup.origin, SOURCE_MAX_BYTES)
  if (!original.ok) {
    if (original.reason === 'missing') return warn('source-original-missing', 'the last copy was used')
    const why = original.reason === 'link' ? 'it is reached through a link' : original.reason === 'not-file' ? 'it is not a plain file' : original.reason === 'too-large' ? `it is larger than ${SOURCE_MAX_BYTES / 1024 / 1024} MiB` : 'it cannot be opened'
    return warn('source-original-unreadable', `${why}; the last copy was used`)
  }
  // The copy becomes the original's bytes exactly; the text is only the writer's carrier.
  const text = exactUtf8(original.bytes)
  if (text === null) return warn('source-original-unreadable', 'it is not UTF-8 text; the last copy was used')
  if (cached.ok && cached.bytes.equals(original.bytes)) return { ...none, states: [`sync-current:${item.id}`] }
  const folder = posix.dirname(copyPath) === '.' ? '' : posix.dirname(copyPath)
  const walked = walkNoFollowSync(realRoot, folder)
  if (walked.kind !== 'directory') return none
  const written: string[] = []
  try {
    syncRefreshSeams.beforeReplace?.(copyPath)
    await writeInWidgetFolder(ws, realRoot, folder, { dev: walked.dev, ino: walked.ino }, copyPath, text, { basis: cached.ok ? cached.bytes : null })
    written.push(copyPath)
    const check = await readContainedFile(realRoot, copyPath, SOURCE_MAX_BYTES)
    if (!check.ok || !check.bytes.equals(original.bytes)) throw new Error('the copy is not byte for byte the original')
  } catch (error) {
    return { ...none, written, failed: [{ issue: { code: 'output-write-failed', detail: `the copy kept in sync was not refreshed: ${error instanceof Error ? error.message : String(error)}` }, path: copyPath }] }
  }
  let nextManifest = manifestText
  if (manifestText !== null) {
    const capture = { sha256: sha256(original.bytes), bytes: original.bytes.byteLength, media_type: typeof (item.raw.capture as Record<string, unknown> | undefined)?.media_type === 'string' ? (item.raw.capture as Record<string, string>).media_type : (/\.json$/i.test(copyPath) ? 'application/json' : 'text/csv'), captured_at: timestamp(now) }
    try {
      nextManifest = setResourceItemCaptureText(manifestText, item.id, capture)
      await writeManifestOver(ws, realRoot, bundle, manifestText, nextManifest)
      written.push(inFolder(bundle, MANIFEST_NAME))
    } catch (error) {
      return { ...none, written, failed: [{ issue: { code: 'output-write-failed', detail: `the copy kept in sync was refreshed but its record in the manifest was not: ${error instanceof Error ? error.message : String(error)}` }, path: inFolder(bundle, MANIFEST_NAME) }] }
    }
  }
  return { manifestText: nextManifest, issues: [], states: [`sync-refreshed:${item.id}`], written, failed: [] }
}

type PageProblem = { issue: WidgetIssue; path: string }
/** The page a checked recipe makes from its source text: pure, nothing read or written. */
type PageRender = { ok: true; page: string; resources: string[] } | { ok: false; problems: PageProblem[] }

function renderWidgetPage(recipe: RecipeMap, recipePath: string, outputPath: string, sourceShown: string, folioPath: string, text: string, manifestText: string | null): PageRender {
  const records = readRecords(recipe, folioPath, text)
  if (!records.ok) return { ok: false, problems: records.errors.map((issue) => ({ issue, path: sourceShown })) }
  const frame = frameResources(recipe, records.value, declaredItems(manifestText))
  if (frame.errors.length > 0) return { ok: false, problems: frame.errors.map((issue) => ({ issue, path: issue.code === 'recipe-invalid' ? recipePath : sourceShown })) }
  const mapping = recipe.mapping as RecipeMap
  const page = renderBrowserPage({
    title: typeof recipe.title === 'string' && recipe.title.trim() !== '' ? recipe.title : 'Records',
    views: recipe.views as string[],
    initialView: isRecipeMap(recipe.initial) && typeof recipe.initial.view === 'string' ? recipe.initial.view : null,
    groupLabel: typeof mapping.group === 'string' ? records.value.fields.find((field) => field.key === mapping.group)?.label ?? null : null,
    records: browserRecords(recipe, records.value),
  })
  if (Buffer.byteLength(page, 'utf8') > WIDGET_MAX_BYTES) {
    return { ok: false, problems: [{ issue: { code: 'output-write-failed', detail: `the built page would be larger than ${WIDGET_MAX_BYTES / 1024 / 1024} MiB` }, path: outputPath }] }
  }
  return { ok: true, page, resources: frame.ids }
}

export type WidgetPreview = { ok: true; html: string; title: string; errors: BuildError[] } | { ok: false; errors: BuildError[] }

/**
 * The page `recipe` would build at `recipePath` (a widget folder that may not exist yet), WITHOUT writing anything:
 * no recipe, page, receipt or folder. The source is resolved and read exactly as a build reads it (contained in the
 * Folio folder, nothing followed); `sourceText`, when given, stands in for the bytes read (an edit not yet saved),
 * so the file must still be there. The page is byte for byte the one a build with that text would write.
 */
export async function previewStandardWidget(ws: Workspace, recipePath: string, recipe: RecipeMap, sourceText?: string, supplied?: { folioPath: string }): Promise<WidgetPreview> {
  assertRelativeWorkspacePath(recipePath)
  const place = recipePlace(recipePath)
  const outputPath = place ? inFolder(place.folder, WIDGET_OUTPUT_NAME) : recipePath
  const failed = (problems: PageProblem[]): WidgetPreview => ({ ok: false, errors: problems.slice(0, BUILD_ERROR_CAP).map(({ issue, path }) => buildError(issue, path)) })
  if (!place || isHiddenWorkspacePath(recipePath)) return failed([{ issue: { code: 'output-outside', detail: `a widget recipe is ${VISUALISATIONS_DIR}/<name>/${WIDGET_RECIPE_NAME} in a document's folder` }, path: recipePath }])
  const recipeProblems = [...checkRecipe(recipe), ...notBuiltHere(recipe)]
  if (recipeProblems.length > 0) return failed(recipeProblems.map((issue) => ({ issue, path: recipePath })))
  const realRoot = await realpath(ws.root)
  let manifestText: string | null = null
  try {
    const raw = await readOptional(realRoot, inFolder(place.bundle, MANIFEST_NAME), 4 * 1024 * 1024)
    manifestText = raw === null ? null : raw.toString('utf8')
  } catch { manifestText = null }
  // A file picked outside the document's folders (ticket 04c) is not in the Folio yet: its text is supplied, read
  // in main from the picker's descriptor, and nothing is read here.
  const source: SourceRead = supplied !== undefined && sourceText !== undefined
    ? { ok: true, text: sourceText, bytes: Buffer.from(sourceText, 'utf8'), folioPath: supplied.folioPath, input: { path: supplied.folioPath } }
    : await readSource(realRoot, place.bundle, place.folder, recipe, manifestText)
  if (!source.ok) return failed(source.errors.map((issue) => ({ issue, path: source.path })))
  if (sourceText !== undefined && Buffer.byteLength(sourceText, 'utf8') > SOURCE_MAX_BYTES) {
    return failed([{ issue: { code: 'source-too-large', detail: `larger than ${SOURCE_MAX_BYTES / 1024 / 1024} MiB` }, path: inFolder(place.bundle, source.folioPath) }])
  }
  const rendered = renderWidgetPage(recipe, recipePath, outputPath, inFolder(place.bundle, source.folioPath), source.folioPath, sourceText ?? source.text, manifestText)
  if (!rendered.ok) return failed(rendered.problems)
  return { ok: true, html: rendered.page, title: typeof recipe.title === 'string' && recipe.title.trim() !== '' ? recipe.title : 'Records', errors: [] }
}

/**
 * Build the widget whose recipe is `recipePath` (workspace-relative). Never throws for a problem with the
 * widget: every problem is a named error in the outcome (and in the receipt, when the recipe could be read).
 */
export async function buildStandardWidget(ws: Workspace, recipePath: string, options: BuildOptions = {}): Promise<BuildOutcome> {
  assertRelativeWorkspacePath(recipePath)
  const place = recipePlace(recipePath)
  const outputPath = place ? inFolder(place.folder, WIDGET_OUTPUT_NAME) : recipePath
  const outcome = (result: BuildOutcome['result'], errors: BuildError[], receipt: BuildReceipt | null, written: string[], writtenOutput: string | null): BuildOutcome =>
    ({ result, recipePath, outputPath, writtenOutput, errors, receipt, written })
  if (!place || isHiddenWorkspacePath(recipePath)) {
    return outcome('failed', [buildError({ code: 'output-outside', detail: `a widget recipe is ${VISUALISATIONS_DIR}/<name>/${WIDGET_RECIPE_NAME} in a document's folder` }, recipePath)], null, [], null)
  }
  const realRoot = await realpath(ws.root)
  const folderWalk = walkNoFollowSync(realRoot, place.folder)
  const recipeRead = folderWalk.kind === 'directory' ? await readContainedFile(realRoot, recipePath, RECIPE_MAX_BYTES) : { ok: false as const, reason: folderWalk.kind === 'missing' ? 'missing' as const : 'link' as const }
  const recipeText = recipeRead.ok ? decodeUtf8(recipeRead.bytes) : null
  if (!recipeRead.ok || recipeText === null || folderWalk.kind !== 'directory') {
    const detail = !recipeRead.ok ? (recipeRead.reason === 'missing' ? 'there is no recipe file' : recipeRead.reason === 'link' ? 'it is reached through a link' : 'it cannot be read') : 'it is not UTF-8 text'
    return outcome('failed', [buildError({ code: 'recipe-unreadable', detail }, recipePath)], null, [], null)
  }
  const folderId = { dev: folderWalk.dev, ino: folderWalk.ino }
  const receiptPath = inFolder(place.folder, WIDGET_RECEIPT_NAME)
  const builtAt = timestamp((options.now ?? (() => new Date()))())
  const written: string[] = []

  let previousReceipt: string | null = null
  let currentOutput: Buffer | null = null
  try {
    const raw = await readOptional(realRoot, receiptPath, 1024 * 1024)
    previousReceipt = raw === null ? null : raw.toString('utf8')
    currentOutput = await readOptional(realRoot, outputPath, WIDGET_MAX_BYTES + 1)
  } catch (error) {
    return outcome('failed', [buildError({ code: 'output-outside', detail: error instanceof Error ? error.message : String(error) }, outputPath)], null, [], null)
  }
  const previousHash = recordedOutputHash(previousReceipt)

  const parsed = parseRecipeText(recipeText)
  const recipe = parsed.ok ? parsed.recipe : {}
  const base = {
    widget_schema: recipe.widget_schema ?? null, template: recipe.template ?? null, template_version: recipe.template_version ?? null,
    recipe_sha256: sha256(recipeRead.bytes),
  }
  let syncIssues: Array<{ issue: WidgetIssue; path: string }> = []
  let syncStates: string[] = []
  const fail = async (problems: Array<{ issue: WidgetIssue; path: string }>, inputs: BuildReceipt['inputs'] = []): Promise<BuildOutcome> => {
    const errors = [...syncIssues, ...problems].slice(0, BUILD_ERROR_CAP).map(({ issue, path }) => buildError(issue, path))
    const receipt: BuildReceipt = { ...base, inputs, template_sha256: recipe.template === 'browser' ? BROWSER_TEMPLATE_SHA256 : null, output_sha256: previousHash, built_at: builtAt, result: 'failed', errors, states: syncStates, resources: [] }
    try {
      await writeInWidgetFolder(ws, realRoot, place.folder, folderId, receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
      written.push(receiptPath)
    } catch (error) {
      errors.push(buildError({ code: 'output-write-failed', detail: error instanceof Error ? error.message : String(error) }, receiptPath))
    }
    return outcome('failed', errors, receipt, written, null)
  }

  if (!parsed.ok) return fail(parsed.errors.map((issue) => ({ issue, path: recipePath })))
  const recipeProblems = checkRecipe(recipe)
  if (recipeProblems.length > 0) return fail(recipeProblems.map((issue) => ({ issue, path: recipePath })))
  const unsupported = notBuiltHere(recipe)
  if (unsupported.length > 0) return fail(unsupported.map((issue) => ({ issue, path: recipePath })))

  let manifestText: string | null = null
  try {
    const raw = await readOptional(realRoot, inFolder(place.bundle, MANIFEST_NAME), 4 * 1024 * 1024)
    manifestText = raw === null ? null : raw.toString('utf8')
  } catch { manifestText = null }

  // A source kept in sync is refreshed from its original first; its warnings go with every outcome.
  const sync = await refreshSyncedSource(ws, realRoot, place.bundle, recipe, manifestText, options.grants === undefined ? appSyncGrantStore() : options.grants, new Date(builtAt))
  manifestText = sync.manifestText
  written.push(...sync.written)
  syncIssues = sync.issues
  syncStates = sync.states
  if (sync.failed.length > 0) return fail(sync.failed)

  const source = await readSource(realRoot, place.bundle, place.folder, recipe, manifestText)
  if (!source.ok) return fail(source.errors.map((issue) => ({ issue, path: source.path })))
  const inputs: BuildReceipt['inputs'] = ['path' in source.input ? { path: source.input.path, sha256: sha256(source.bytes) } : { resource: source.input.resource, sha256: sha256(source.bytes) }]
  const sourceShown = inFolder(place.bundle, source.folioPath)
  const rendered = renderWidgetPage(recipe, recipePath, outputPath, sourceShown, source.folioPath, source.text, manifestText)
  if (!rendered.ok) return fail(rendered.problems, inputs)
  const page = rendered.page
  const pageBytes = Buffer.from(page, 'utf8')
  const pageHash = sha256(pageBytes)
  let handEdited = currentOutput !== null && !currentOutput.equals(pageBytes) && sha256(currentOutput) !== previousHash
  let target = handEdited ? inFolder(place.folder, WIDGET_REBUILT_NAME) : outputPath
  const handEditWarning = (): BuildError => buildError({ code: 'output-hand-edited', detail: `the new build is in ${WIDGET_REBUILT_NAME}` }, outputPath)
  const errors: BuildError[] = [...syncIssues.map(({ issue, path }) => buildError(issue, path)), ...(handEdited ? [handEditWarning()] : [])]
  try {
    // An unchanged page is not rewritten: the file keeps its bytes and its time.
    if (handEdited || currentOutput === null || !currentOutput.equals(pageBytes)) {
      try {
        // widget.html is replaced only while it still holds the bytes this build read (null: still absent).
        await writeInWidgetFolder(ws, realRoot, place.folder, folderId, target, page, handEdited ? {} : { basis: currentOutput })
      } catch (error) {
        if (!(error instanceof OutputChangedSinceRead)) throw error
        // Edited while this build ran: that edit is kept, as a hand edit is, and the new page goes beside it.
        handEdited = true
        target = inFolder(place.folder, WIDGET_REBUILT_NAME)
        errors.push(handEditWarning())
        await writeInWidgetFolder(ws, realRoot, place.folder, folderId, target, page)
      }
      written.push(target)
    }
  } catch (error) {
    return fail([{ issue: { code: 'output-write-failed', detail: error instanceof Error ? error.message : String(error) }, path: target }], inputs)
  }
  const result: BuildOutcome['result'] = handEdited ? 'kept-hand-edit' : 'built'
  const receipt: BuildReceipt = { ...base, inputs, template_sha256: BROWSER_TEMPLATE_SHA256, output_sha256: pageHash, built_at: builtAt, result, errors, states: syncStates, resources: rendered.resources }
  try {
    await writeInWidgetFolder(ws, realRoot, place.folder, folderId, receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
    written.push(receiptPath)
  } catch (error) {
    errors.push(buildError({ code: 'output-write-failed', detail: error instanceof Error ? error.message : String(error) }, receiptPath))
  }
  return outcome(result, errors, receipt, written, target)
}

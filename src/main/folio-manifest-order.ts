/**
 * Changing the running order of a Folio that has a manifest and no Index Note. "Make a Folio" writes only
 * the manifest, so this is every freshly made Folio. There is one document, the manifest; these writes
 * change the order of its `files` array, append entries, or take the last entries out again. They never
 * create an Index Note.
 *
 * What holds for every write here:
 * - It is made from ONE read of the manifest (its bytes, and the manifest parsed from those bytes) and one
 *   listing of the Folio's folder. The caller holds the Folio's lock (plan-lock.ts).
 * - The Folio must be one that can be changed exactly (`assessManifestOnly`): every element of `files` is
 *   an entry with a path, each resolves to a file that is there, inside the folder, no file twice, and
 *   `content_root` stays inside the folder. Anything else is refused and nothing is written.
 * - The caller's `expected` running order must be that read's order, or the request is stale.
 * - The new text is the old text with the `files` array rewritten by `rewriteJsonArrayByKey`
 *   (json-array-layout.ts, the Plan's own manifest rewrite), every kept entry held verbatim by its
 *   position: its bytes are copied, not re-serialised. Every byte outside the array is untouched.
 * - Before it is written the new text is parsed and checked: its `files` is exactly the intended list of
 *   entries (the same objects, re-ordered, plus the new ones), every other top-level key is unchanged,
 *   and it resolves to exactly the intended running order.
 * - The write is `writePreparedManifest` (plan.ts): the bytes on disk must still be the bytes read; the
 *   `.writeflex-backup` copy is made first if absent; the new text goes to a temporary file and is
 *   renamed over the manifest. In the tick of that rename the bytes are compared once more (by
 *   `writePreparedManifest`) and the Index Note is checked to be still absent (here).
 *
 * `keepEntriesOutsideFolio` (plan.ts) has no work here: a manifest with an entry outside the folder is
 * refused before any rewrite, so no such entry can be dropped or moved.
 */

import { existsSync } from 'node:fs'
import { posix } from 'node:path'
import {
  MANIFEST_NAME,
  folioPartsUnderRoot,
  indexNotePath,
  manifestContentRootRefused,
  manifestEntryPointsOutsideFolio,
  manifestFilePathCandidates,
  parseManifest,
  resolveManifestFilePath,
  titleMatterPath,
  type Folio,
} from './folio'
import { parseFrontmatter } from './frontmatter'
import { jsonArrayLayout, rewriteJsonArrayByKey } from './json-array-layout'
import { backupManifestDocument, manifestSiblingEntries, newManifestEntry, writePreparedManifest, type PlanWriteOptions } from './plan'
import { candidateTitle } from './wikilinks'
import type { Workspace } from './workspace'
import { PLAN_ROLES } from '../shared/plan-line'
import { isAgentInstructionsName } from '../shared/folio-agent-files'
import { FRONT_MATTER_STAYS_LEADING, assertFrontMatterStaysLeading, frontBlockEnd, manifestEntryIsFrontMatter, moveStaysInBlock } from '../shared/folio-front-matter'

export type ManifestOnlyReason =
  | 'no-manifest' // no manifest, or one that is not a JSON object with a `files` array
  | 'outside-entry' // an entry points outside the Folio's folder (or content_root leaves it)
  | 'missing-file' // an entry's file is not there
  | 'listed-twice' // a file is listed twice
  | 'unreadable-entry' // an element of `files` is not an entry with a path, so a rewrite could not keep it in place
  | 'agent-instructions' // an entry names AGENTS.md, CLAUDE.md or a conflict copy of either, which is never a part

export type ManifestOnlyAssessment = { ok: true; order: string[] } | { ok: false; reason: ManifestOnlyReason }

const KNOWN_ROLES = new Set<string>(PLAN_ROLES)

const manifestPathOf = (dir: string): string => (dir === '' ? MANIFEST_NAME : `${dir}/${MANIFEST_NAME}`)

/** Whether the folder has an Index Note file at all, listed by the workspace or not. */
export function indexNoteExists(ws: Workspace, dir: string): boolean {
  return existsSync(ws.absolute(indexNotePath(ws, dir)))
}

/** The parsed elements of the manifest's `files` array, as written. Null when the text has no such array. */
function authoredEntries(source: string): unknown[] | null {
  try {
    return jsonArrayLayout(source, 'files').entries.map((entry) => entry.value)
  } catch {
    return null
  }
}

/** Pure: one read of the manifest (parsed, and its bytes) and the files present in the Folio's folder. */
export function assessManifestOnly(dir: string, manifest: Folio | null, source: string | null, present: ReadonlySet<string>): ManifestOnlyAssessment {
  if (!manifest || source === null) return { ok: false, reason: 'no-manifest' }
  const authored = authoredEntries(source)
  if (!authored) return { ok: false, reason: 'no-manifest' }
  // Every element of the array must be an entry the reader kept, in the same place: a rewrite places entries by position.
  const sameEntries = authored.length === manifest.files.length && authored.every((value, at) => (
    typeof value === 'object' && value !== null && !Array.isArray(value) && (value as Record<string, unknown>).path === manifest.files[at].path
  ))
  if (!sameEntries) return { ok: false, reason: 'unreadable-entry' }
  if (manifestContentRootRefused(dir, manifest)) return { ok: false, reason: 'outside-entry' }
  const order: string[] = []
  for (const file of manifest.files) {
    if (manifestEntryPointsOutsideFolio(dir, manifest, file)) return { ok: false, reason: 'outside-entry' }
    const path = resolveManifestFilePath(dir, manifest, file, present)
    if (!path) return { ok: false, reason: 'missing-file' }
    if (isAgentInstructionsName(path)) return { ok: false, reason: 'agent-instructions' }
    order.push(path)
  }
  if (new Set(order).size !== order.length) return { ok: false, reason: 'listed-twice' }
  return { ok: true, order }
}

export type ManifestOnlyRead = { manifest: Folio | null; source: string | null; present: Set<string>; assessment: ManifestOnlyAssessment }

/** One read: the manifest's bytes, the manifest parsed from those bytes, and the folder's listing. */
export async function readManifestOnly(ws: Workspace, dir: string): Promise<ManifestOnlyRead> {
  let source: string | null
  try {
    source = (await ws.readFile(manifestPathOf(dir))).content
  } catch {
    source = null
  }
  const manifest = source === null ? null : parseManifest(dir, source)
  const present = new Set((await ws.listFilesIn(dir)).map((file) => file.path))
  return { manifest, source, present, assessment: assessManifestOnly(dir, manifest, source, present) }
}

/**
 * The files Add accepts for a Folio with no Index Note, in file-name order: the rule the Plan applies to
 * its unlisted files (plan.ts `loadPlan`), without the Index Note. Markdown files under the folder
 * the Folio takes its pieces from (`content_root` when it has one) that are not covers, Index Notes,
 * backups or underscore-prefixed, are present in the Folio folder's listing and are not already in the running
 * order. The manifest's `title_matter` file is listed like any other (ADR-0046); subfolders are included.
 */
export async function manifestOnlyAddable(ws: Workspace, dir: string, read: ManifestOnlyRead): Promise<string[]> {
  if (!read.assessment.ok || !read.manifest) return []
  const manifest = read.manifest
  const root = manifest.contentRoot ? posix.join(dir || '.', manifest.contentRoot) : dir
  const listed = new Set(read.assessment.order)
  return (await folioPartsUnderRoot(ws, root)).filter((path) => read.present.has(path) && !listed.has(path))
}

type Desired = { keep: number } | { add: Record<string, unknown> }

/** The entry Add writes for one file: the Plan's own shape (`newManifestEntry`), from the file's title and role. */
async function entryForAddedFile(ws: Workspace, dir: string, read: ManifestOnlyRead, path: string): Promise<Record<string, unknown>> {
  const content = (await ws.readFile(path)).content
  const authoredRole = parseFrontmatter(content)?.extra.role
  const role = typeof authoredRole === 'string' && KNOWN_ROLES.has(authoredRole.trim().toLocaleLowerCase()) ? authoredRole.trim().toLocaleLowerCase() : 'section'
  return newManifestEntry(dir, read.manifest, manifestSiblingEntries(read.source), path, { title: candidateTitle(content, path), role })
}

const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

/**
 * Build the new manifest text and check it says exactly what was meant. Throws when it does not; nothing
 * has been written at that point.
 */
function rewrittenManifest(dir: string, read: ManifestOnlyRead, desired: Desired[], intendedOrder: readonly string[]): string {
  const source = read.source as string
  const authored = authoredEntries(source) as Array<Record<string, unknown>>
  const verbatim = new Map<Record<string, unknown>, number>()
  const values = desired.map((item) => {
    if ('add' in item) return item.add
    // A stand-in the rewrite places by position: the entry's own bytes are copied.
    const stand = { path: authored[item.keep].path }
    verbatim.set(stand, item.keep)
    return stand
  })
  const next = rewriteJsonArrayByKey(source, 'files', 'path', values, verbatim)

  const refusal = new Error('The Folio manifest could not be rewritten exactly, so nothing was changed. Open the Folio outline to change this Folio’s order.')
  const before = JSON.parse(source) as Record<string, unknown>
  const after = JSON.parse(next) as Record<string, unknown>
  const intendedFiles = desired.map((item) => ('add' in item ? item.add : authored[item.keep]))
  if (!sameJson(after.files, intendedFiles)) throw refusal
  if (!sameJson(Object.keys(before), Object.keys(after)) || !sameJson({ ...before, files: null }, { ...after, files: null })) throw refusal
  const again = assessManifestOnly(dir, parseManifest(dir, next), next, read.present)
  if (!again.ok || again.order.length !== intendedOrder.length || again.order.some((path, at) => path !== intendedOrder[at])) throw refusal
  return next
}

/** Write the new text over the manifest, under every condition the file's header lists. False = the text is unchanged, nothing written. */
async function commit(ws: Workspace, dir: string, read: ManifestOnlyRead, next: string, options: PlanWriteOptions): Promise<boolean> {
  const source = read.source as string
  if (next === source) return false
  const path = manifestPathOf(dir)
  if (indexNoteExists(ws, dir)) throw new Error('This Folio gained an Index Note meanwhile, so nothing was changed.')
  await options.beforeManifestWrite?.(path)
  await writePreparedManifest(
    ws,
    { path, current: source, next },
    () => backupManifestDocument(ws, dir, source),
    // In the tick of the rename, after `writePreparedManifest` has compared the manifest's bytes once more.
    () => {
      if (indexNoteExists(ws, dir)) throw new Error('This Folio gained an Index Note meanwhile, so nothing was changed.')
    },
  )
  return true
}

/** The manifest's `title_matter` file on this read, or null. */
function titleMatterOf(dir: string, read: ManifestOnlyRead): string | null {
  return read.manifest ? titleMatterPath(dir, read.manifest, read.present) : null
}

/** Which entries are front matter, in the order read (ADR-0046: `role: front-matter|title-matter`, or the `title_matter` file naming no other role). */
function frontFlagsOf(dir: string, read: ManifestOnlyRead): boolean[] {
  const manifest = read.manifest
  if (!manifest) return []
  const titleMatter = titleMatterOf(dir, read)
  return manifest.files.map((file) => manifestEntryIsFrontMatter(file, titleMatter !== null && resolveManifestFilePath(dir, manifest, file, read.present) === titleMatter))
}

/** Move the entry at `from` so that it sits at `to` once taken out. Only the order of the array's elements changes. A move never crosses the front-matter boundary. */
export async function moveManifestEntry(ws: Workspace, dir: string, read: ManifestOnlyRead & { assessment: { ok: true; order: string[] } }, from: number, to: number, options: PlanWriteOptions = {}): Promise<string[]> {
  if (!moveStaysInBlock(frontFlagsOf(dir, read), from, to)) throw new Error(FRONT_MATTER_STAYS_LEADING)
  const order = [...read.assessment.order]
  const positions = order.map((_, at) => at)
  const [moved] = positions.splice(from, 1)
  positions.splice(to, 0, moved)
  const intended = positions.map((at) => order[at])
  const next = rewrittenManifest(dir, read, positions.map((keep) => ({ keep })), intended)
  await commit(ws, dir, read, next, options)
  return intended
}

/** Put the entries in a new order (`target` is a permutation of the current order), in one write. Only the order of the array's elements changes. */
export async function reorderManifestEntries(ws: Workspace, dir: string, read: ManifestOnlyRead & { assessment: { ok: true; order: string[] } }, target: readonly string[], options: PlanWriteOptions = {}): Promise<string[]> {
  const order = read.assessment.order
  const positions = target.map((path) => order.indexOf(path))
  if (target.length !== order.length || positions.some((at) => at < 0) || new Set(positions).size !== order.length) throw new Error('That is not a new order for this running order.')
  const flags = frontFlagsOf(dir, read)
  assertFrontMatterStaysLeading(flags, positions.map((at) => flags[at]))
  const next = rewrittenManifest(dir, read, positions.map((keep) => ({ keep })), [...target])
  await commit(ws, dir, read, next, options)
  return [...target]
}

/**
 * Append one entry per file, in the order given; an entry for front matter (a file whose header says
 * `role: front-matter`) goes at the end of the front-matter block instead (ADR-0046). The caller has checked each
 * file is addable on this read.
 */
export async function appendManifestEntries(ws: Workspace, dir: string, read: ManifestOnlyRead & { assessment: { ok: true; order: string[] } }, paths: readonly string[], options: PlanWriteOptions = {}): Promise<string[]> {
  const order = read.assessment.order
  const added: Array<{ path: string; desired: Desired; front: boolean }> = []
  for (const path of paths) {
    const entry = await entryForAddedFile(ws, dir, read, path)
    added.push({ path, desired: { add: entry }, front: manifestEntryIsFrontMatter(entry, path === titleMatterOf(dir, read)) })
  }
  const flags = frontFlagsOf(dir, read)
  const at = frontBlockEnd(flags)
  const front = added.filter((item) => item.front)
  const rest = added.filter((item) => !item.front)
  const kept: Desired[] = order.map((_, keep) => ({ keep }))
  const desired = [...kept.slice(0, at), ...front.map((item) => item.desired), ...kept.slice(at), ...rest.map((item) => item.desired)]
  const intended = [...order.slice(0, at), ...front.map((item) => item.path), ...order.slice(at), ...rest.map((item) => item.path)]
  assertFrontMatterStaysLeading(flags, [...flags.slice(0, at), ...front.map(() => true), ...flags.slice(at), ...rest.map(() => false)])
  const next = rewrittenManifest(dir, read, desired, intended)
  await commit(ws, dir, read, next, options)
  return intended
}


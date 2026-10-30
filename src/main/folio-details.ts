import { isSectionExportField } from '../shared/folio-sections'
/**
 * The Folio outline's Details card (0.26 ticket 4): reading the seven fields, the one write that changes one of
 * them, and the Undo of that write. Every field the card or its pickers (ticket 5) change goes through
 * `setFolioDetail`; nothing else in the app writes these keys for the card.
 *
 * Scope: the caller names a Folio by its folder, never a file. Main derives the Index Note (folio.ts
 * `indexNotePath`, the file the Folio outline reads and writes) and refuses a Folio with none: one is never
 * created here. The folder is checked as a Workspace-relative path and put in its one spelling (folio-dir.ts) by
 * the IPC seam (folio-details-ipc.ts); the Index Note must be a document the sidebar would show.
 *
 * The write changes only the named key's line (or lines, for a list it replaces), through the strict frontmatter
 * writer every direct frontmatter write uses (capabilities.ts `setFrontmatterKeys` / `removeFrontmatterKeys`, as
 * export-toc-depth.ts and goal:set): a new key goes at the end of the block, a removed key takes only its own lines
 * (the last key out takes the block with it, so a bare file stays bare, unless the body would then be read as a
 * header: it then keeps an empty one), and an Index Note with no header gains a
 * minimal one. The body and every other key are kept byte for byte, line endings included. A value with a line
 * break or a character YAML would read differently is written as one double-quoted line (`\n` escapes), which the
 * app's frontmatter reader gives back unchanged.
 *
 * Guards, in order: the Folio's lock (plan-lock.ts, shared with every Folio outline write); the Index Note read
 * through the guarded read (no link, no hidden folder); the caller's basis (the Index Note text it last saw)
 * compared with the file, refused with nothing written when they differ; the history checkpoint
 * (`beforeIndexWrite`, as every Plan write); then the guarded document write (`documentOnly`), which compares the
 * file with the basis again in the tick of the rename (`commitOnlyOver`).
 *
 * Undo: each write keeps the Index Note's text before and after it, in memory, under a token (the last
 * DETAIL_UNDO_KEPT per Folio; a restart forgets them). An Undo names the token and puts the before text back only
 * while the file holds exactly the after text (checked before and in the tick of the rename); anything else is
 * refused as stale with nothing written. A token is used once.
 */

import { randomUUID } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { removeFrontmatterKeys, setFrontmatterKeys } from './capabilities'
import { indexNotePath } from './folio'
import { folioKey } from './folio-dir'
import { DocumentReadRefused, readDocumentGuarded } from './guarded-document-read'
import { GuardedWriteRefused, leftoverNote, type FolderIdentity } from './guarded-document-write'
import { withPlanLock } from './plan-lock'
import { readPlan, type PlanWriteOptions } from './plan'
import { parseFrontmatter } from './frontmatter'
import { frontmatterBlock } from '../shared/markdown/frontmatter'
import type { CoverDetails } from '../shared/folio-cover-details'
import { DiskChangedUnderBuffer, NotADocumentPathError, type Workspace } from './workspace'
import {
  FOLIO_DETAIL_FIELDS,
  FOLIO_DETAIL_LABEL,
  FOLIO_DETAIL_MAX_LENGTH,
  FOLIO_DETAIL_STALE_UNDO,
  folioDetailsWithFallback,
  folioDetailValueRefusal,
  isFolioDetailField,
  normaliseFolioDetailValue,
  type FolioDetailAnswer,
  type FolioDetailField,
  type FolioDetailUndoAnswer,
  type FolioDetailsRead,
  type FolioDetailsRefusal,
} from '../shared/folio-details'

/** How many Details changes per Folio keep their Undo record (older ones are dropped, oldest first). */
export const DETAIL_UNDO_KEPT = 20

type DetailRecord = { folio: string; indexPath: string; before: string; after: string }
const records = new Map<string, DetailRecord>()

const folioOf = (ws: Pick<Workspace, 'root'>, dir: string): string => {
  const key = folioKey(ws.root, dir)
  return `${key.root}\u0000${key.dir}`
}

/** Forget every Undo record (tests; a workspace closed). */
export function forgetFolioDetailUndoRecords(): void {
  records.clear()
}

const refusal = (refused: FolioDetailsRefusal['refused'], message: string, text?: string): FolioDetailsRefusal =>
  ({ ok: false, refused, message, ...(text !== undefined ? { text } : {}) })

const NO_INDEX_NOTE = refusal('no-index-note', 'This Folio has no Index Note yet, so its details cannot be kept. The first change you make to the running order writes it.')
const OUTSIDE = refusal('outside', 'That is not a Folio in this Workspace, so nothing was changed.')

/** `answer`, naming after its own words any temporary file the failed write `error` could not remove. */
const naming = (answer: FolioDetailsRefusal, error: unknown): FolioDetailsRefusal => {
  const note = leftoverNote(error)
  return note ? { ...answer, message: `${answer.message} ${note}` } : answer
}

const fold = (text: string): string => text.normalize('NFC').toLocaleLowerCase()

/**
 * The folder is the Folio itself, not a name for it: no segment of it is a symbolic link (an alias such as
 * `alias → book` would derive `alias/_alias_INDEX.md`, which is an ordinary part of `book`, and the write would
 * change that part). Differences of letter case or Unicode form alone are the same folder (folio-dir.ts), so they
 * pass. The answer is the folder's identity (real path, device, inode), pinned here and handed to the write, which
 * lands only in that folder (checked again in the tick of the rename): a link swapped in for the folder while the
 * checkpoint is awaited is refused. `missing`: there is no such folder (left to the guarded read to refuse);
 * `null`: it is not the Folio itself.
 */
function pinTheFolio(ws: Pick<Workspace, 'root'>, dir: string): FolderIdentity | 'missing' | null {
  let realRoot: string
  let real: string
  try {
    realRoot = realpathSync.native(ws.root)
    real = realpathSync.native(resolve(ws.root, dir))
  } catch {
    return 'missing'
  }
  if (dir !== '' && fold(relative(realRoot, real).split(sep).join('/')) !== fold(dir)) return null
  try {
    // lstat of the real path: a link put there since it was resolved is not a folder, and is refused.
    const stat = lstatSync(real)
    return stat.isDirectory() ? { real, dev: stat.dev, ino: stat.ino } : null
  } catch {
    return 'missing'
  }
}

type IndexRead = { path: string; text: string; folder: FolderIdentity } | FolioDetailsRefusal

/** The Folio's Index Note and its text, read through the guarded read, with the Folio folder's pinned identity;
 *  or why there is none to use. */
async function readIndexNote(ws: Workspace, dir: string): Promise<IndexRead> {
  const folder = pinTheFolio(ws, dir)
  if (folder === null) return OUTSIDE
  const path = indexNotePath(ws, dir)
  if (ws.classifyPath(path) !== 'document') return OUTSIDE
  try {
    const read = await readDocumentGuarded(ws, path)
    // Read, yet the folder could not be pinned before: it appeared meanwhile, and is not trusted for a write.
    if (folder === 'missing') return OUTSIDE
    return { path, text: read.content, folder }
  } catch (error) {
    if (error instanceof DocumentReadRefused) return error.code === 'missing' ? NO_INDEX_NOTE : OUTSIDE
    return refusal('unwritable', 'WriteFlex could not read this Folio’s Index Note, so nothing was changed.')
  }
}

/** A header value as the card shows it: a string, a list joined, or null when empty. */
function shown(value: unknown): string | null {
  if (Array.isArray(value)) {
    const joined = value.map(String).filter((item) => item.trim() !== '').join(', ')
    return joined === '' ? null : joined
  }
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

/** A header value as the pickers count it: one string, or each item of a list. */
function shownItems(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value]
  return items.flatMap((item) => (item === undefined || item === null ? [] : [String(item).trim()])).filter((item) => item !== '')
}

/** The seven fields as one file's header says them (null: absent or empty). */
export function detailsInHeader(text: string): Record<FolioDetailField, string | null> {
  const fm = parseFrontmatter(text)
  const values = {} as Record<FolioDetailField, string | null>
  for (const field of FOLIO_DETAIL_FIELDS) {
    const typed = fm ? (fm as unknown as Record<string, unknown>)[field] : undefined
    values[field] = fm ? shown(typed !== undefined ? typed : fm.extra[field]) : null
  }
  return values
}

/** What one file's header says for `field`, one entry per item of a list; empty when it says nothing. */
export function detailItemsInHeader(text: string, field: FolioDetailField): string[] {
  const fm = parseFrontmatter(text)
  if (!fm) return []
  const typed = (fm as unknown as Record<string, unknown>)[field]
  return shownItems(typed !== undefined ? typed : fm.extra[field])
}

/** The Folio's title page: the one in the running order, else one under Not in the outline; null when none. */
async function titlePagePath(ws: Workspace, dir: string): Promise<string | null> {
  try {
    const plan = await readPlan(ws, dir)
    const page = plan?.parts.find((part) => part.titlePage && part.path) ?? plan?.unlisted.find((part) => part.titlePage && part.path)
    return page?.path ?? null
  } catch {
    return null
  }
}

/** The title page's header values (null: no title page, or it could not be read). */
async function titlePageValues(ws: Workspace, page: string | null): Promise<Record<FolioDetailField, string | null> | null> {
  if (!page) return null
  try { return detailsInHeader((await readDocumentGuarded(ws, page)).content) } catch { return null }
}

/**
 * The Details as the exported cover reads them (title, standfirst, date, status, author): each field the Index Note's,
 * else the title page's, by the card's own rule (`folioDetailsWithFallback`). Null when the Folio has no readable
 * Index Note: the export then keeps what it had.
 */
export async function folioCoverDetails(ws: Workspace, dir: string): Promise<CoverDetails | null> {
  const index = await readIndexNote(ws, dir)
  if ('ok' in index) return null
  const fields = folioDetailsWithFallback(detailsInHeader(index.text), await titlePageValues(ws, await titlePagePath(ws, dir)))
  const details: CoverDetails = {}
  for (const field of ['title', 'standfirst', 'date', 'status', 'author'] as const) if (fields[field].value !== null) details[field] = fields[field].value as string
  return Object.keys(details).length > 0 ? details : null
}

/**
 * What the Details card shows for the Folio at `dir` (its one spelling): each field from the Index Note's header,
 * else from the title page's header. `text` is the Index Note as read: the basis of the next write.
 */
export async function readFolioDetails(ws: Workspace, dir: string): Promise<FolioDetailsRead> {
  const index = await readIndexNote(ws, dir)
  if ('ok' in index) return index
  const page = await titlePagePath(ws, dir)
  const fields = folioDetailsWithFallback(detailsInHeader(index.text), await titlePageValues(ws, page))
  return { ok: true, indexPath: index.path, text: index.text, titlePagePath: page, fields }
}

/**
 * `text` with frontmatter `field` set to `value`, or its line(s) removed for null. Only that key's lines change.
 * Throws (with a sentence naming `path`) when the header is in a form the strict writer cannot change safely.
 */
export function withFolioDetail(text: string, field: string, value: string | null, path = 'document'): string {
  if (value !== null) return setFrontmatterKeys(text, { [field]: value }, path)
  const removed = removeFrontmatterKeys(text, [field], path)
  const block = frontmatterBlock(text)
  if (!block || removed === text) return removed
  // The shared writer drops the body's first line break with the last key it removes (so a header it made itself
  // goes without a trace). That is the only answer of this exact form: a kept header is longer than the body.
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : ''
  const body = text.slice(block.end)
  if (removed !== `${bom}${body.replace(/^\r?\n/, '')}`) return removed
  // The header went with its last key: here the body is kept byte for byte, whatever it began with. A body that
  // would itself be read as a header (it opens on a fence and a block of keys) keeps an empty header in front of
  // it, so its lines stay writing and never become metadata.
  if (frontmatterBlock(body) === null) return `${bom}${body}`
  const nl = text.match(/\r?\n/)?.[0] ?? '\n'
  return `${bom}---${nl}---${nl}${body}`
}

export type SetFolioDetailRequest = { field: unknown; value: unknown; basis: unknown }

/**
 * Write one Details field into the Index Note of the Folio at `dir` (already in its one spelling), only over
 * `basis`, the Index Note text the caller last saw. `value` null (or empty) removes the key. Every way it does not
 * write is an answer with a plain sentence. A value the file already holds writes nothing (`changed: false`).
 */
export async function setFolioDetail(ws: Workspace, dir: string, request: SetFolioDetailRequest, options: Pick<PlanWriteOptions, 'beforeIndexWrite'> = {}): Promise<FolioDetailAnswer> {
  const { field, value, basis } = request
  if (!isFolioDetailField(field) && !isSectionExportField(field)) return refusal('invalid', 'That is not one of the Folio’s details, so nothing was changed.')
  if (value !== null && typeof value !== 'string') return refusal('invalid', `The ${(isSectionExportField(field) ? field : FOLIO_DETAIL_LABEL[field]).toLocaleLowerCase()} must be text, so nothing was changed.`)
  if (typeof value === 'string' && value.length > FOLIO_DETAIL_MAX_LENGTH) {
    return refusal('invalid', `The ${(isSectionExportField(field) ? field : FOLIO_DETAIL_LABEL[field]).toLocaleLowerCase()} is longer than ${FOLIO_DETAIL_MAX_LENGTH.toLocaleString('en-GB')} characters, so nothing was changed.`)
  }
  if (typeof basis !== 'string') return refusal('invalid', 'WriteFlex did not know which version of the Index Note it read, so nothing was changed.')
  const next = normaliseFolioDetailValue(value as string | null)
  const wrong = isSectionExportField(field) ? (next !== null && next !== 'true' && next !== 'false' ? 'Choose on or off for this export option.' : null) : folioDetailValueRefusal(field, next)
  if (wrong) return refusal('invalid', wrong)

  return withPlanLock(ws, dir, async () => {
    const index = await readIndexNote(ws, dir)
    if ('ok' in index) return index
    const { path, text, folder } = index
    const changed = (now: string | null): FolioDetailsRefusal => refusal(
      'disk-changed',
      'The Index Note changed since the Details card read it, so nothing was changed. Check the value and try again.',
      now ?? undefined,
    )
    if (text !== basis) return changed(text)
    let written: string
    try {
      written = withFolioDetail(text, field, next, path)
    } catch (error) {
      return refusal('unwritable', `${error instanceof Error ? error.message : `Could not change the header of ${path}.`} Nothing was changed.`)
    }
    if (written === text) return { ok: true, changed: false, undoToken: null, indexPath: path, text }
    await options.beforeIndexWrite?.(path)
    try {
      // The guarded document write: staged beside the file through a no-follow handle in its checked real folder,
      // renamed only while the file still holds `text` and the Folio folder is still the one pinned when it was read
      // (both compared again in the tick of the rename). Empty text is
      // allowed (an Index Note whose only line was this key) because the basis check already pins what it replaces.
      await ws.saveFileWithoutReadBack(path, written, { documentOnly: true, allowExplicitEmpty: true, inFolder: folder, beforeCommit: ws.commitOnlyOver(path, { kind: 'disk', text }) })
    } catch (error) {
      if (error instanceof DiskChangedUnderBuffer) return naming(changed(error.diskText), error)
      if (error instanceof NotADocumentPathError || error instanceof GuardedWriteRefused) return naming(OUTSIDE, error)
      return naming(refusal('unwritable', 'WriteFlex could not save the Index Note, so nothing was changed.'), error)
    }
    return { ok: true, changed: true, undoToken: remember(ws, dir, path, text, written), indexPath: path, text: written }
  })
}

function remember(ws: Workspace, dir: string, indexPath: string, before: string, after: string): string {
  const folio = folioOf(ws, dir)
  const token = randomUUID()
  records.set(token, { folio, indexPath, before, after })
  const mine = [...records.entries()].filter(([, record]) => record.folio === folio)
  for (const [old] of mine.slice(0, Math.max(0, mine.length - DETAIL_UNDO_KEPT))) records.delete(old)
  return token
}

const STALE = refusal('stale', FOLIO_DETAIL_STALE_UNDO)

/**
 * Undo the Details change `token` names, in the Folio at `dir`: the Index Note goes back to exactly what it held
 * before that change, only while it holds exactly what the change left. Otherwise refused as stale, nothing written.
 */
export async function undoFolioDetail(ws: Workspace, dir: string, token: unknown, options: Pick<PlanWriteOptions, 'beforeIndexWrite'> = {}): Promise<FolioDetailUndoAnswer> {
  const record = typeof token === 'string' ? records.get(token) : undefined
  if (!record || record.folio !== folioOf(ws, dir)) return STALE
  return withPlanLock(ws, dir, async () => {
    // The record is looked up again under the lock: an Undo of the same token that ran first has used it.
    if (records.get(token as string) !== record) return STALE
    const { indexPath, before, after } = record
    if (indexPath !== indexNotePath(ws, dir)) return STALE
    const index = await readIndexNote(ws, dir)
    if ('ok' in index) return index.refused === 'unwritable' ? index : STALE
    if (index.text !== after) return STALE
    await options.beforeIndexWrite?.(indexPath)
    try {
      await ws.saveFileWithoutReadBack(indexPath, before, { documentOnly: true, allowExplicitEmpty: true, inFolder: index.folder, beforeCommit: ws.commitOnlyOver(indexPath, { kind: 'disk', text: after }) })
    } catch (error) {
      if (error instanceof DiskChangedUnderBuffer) return naming(STALE, error)
      if (error instanceof NotADocumentPathError || error instanceof GuardedWriteRefused) return naming(OUTSIDE, error)
      return naming(refusal('unwritable', 'WriteFlex could not save the Index Note, so nothing was undone.'), error)
    }
    records.delete(token as string)
    return { ok: true, indexPath, text: before }
  })
}

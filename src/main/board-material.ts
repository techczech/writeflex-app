/**
 * What the Board's material steps write (docs/design/2026-09-27-scraps-and-sources-on-the-board,
 * frames 2 and 3). Two steps, each touching two files:
 *
 *  - **Offcut to idea:** the tracker (the Collection's Index Note) gains ONE wikilink line under
 *    `## Ideas`, with the scrap's text quoted beneath it, and the scrap leaves its scraps file.
 *  - **Add to end of piece:** the scrap's text is appended to its piece, and the scrap leaves its
 *    scraps file.
 *
 * The planners are pure (file text in, file text out); everything outside the lines they add or the
 * scrap section they remove stays byte-identical. `prepare*` reads the files and plans; `writeMaterial`
 * writes a plan. Undo lives in the desk (board-material-desk.ts), which snapshots before writing.
 */

import { isLosslessScrapId } from './scrap-listing'
import { existsSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { indexNotePath } from './folio'
import { isScrapsPath, removeScrapFromContent, scrapsPathFor } from './scraps'
import { parseFrontmatter } from './frontmatter'
import { DiskChangedUnderBuffer, SavedButNotReadBack, slugifyFileName, type Workspace } from './workspace'
import type { AppendScrapInput, PromoteOffcutInput } from '../shared/board-material'

const IDEAS_HEADING = /^##(?!#)\s+Ideas\s*#*\s*$/i
const ANY_HEADING = /^ {0,3}#{1,6}(?:\s|$)/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const MARKDOWN_EXTENSION = /\.(?:md|markdown|mdx)$/i

/** One file a step writes: its text before and after. null means the file is absent (after: deleted). */
export type MaterialWrite = { path: string; before: string | null; after: string | null }

/** The wikilink target an idea name writes, as the locked design shows it (`[[frames-and-scripts]]`). */
export function ideaTarget(name: string): string {
  const slug = slugifyFileName(name.trim()).replace(MARKDOWN_EXTENSION, '')
  return slug === 'untitled' && !/untitled/i.test(name) ? '' : slug
}

/** The tracker lines for one idea: the wikilink line, then the scrap text quoted beneath it. */
export function ideaEntryLines(target: string, text: string): string[] {
  const quote = text.replace(/\r/g, '').replace(/^\n+|\n+$/g, '').split('\n').map((line) => (line.trim() ? `  > ${line}` : '  >'))
  return [`- [[${target}]]`, ...quote]
}

function lineEnding(content: string): '\r\n' | '\n' {
  const first = content.indexOf('\n')
  return first > 0 && content[first - 1] === '\r' ? '\r\n' : '\n'
}

/** Whether the tracker already links to `target` anywhere (`[[target]]`, `[[target|…]]`, `[[target#…]]`). */
export function trackerLinksTo(content: string, target: string): boolean {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\[\\[\\s*${escaped}\\s*(?:[|#][^\\]]*)?\\]\\]`, 'i').test(content)
}

/**
 * Add one idea entry to the tracker's `## Ideas` section, after its last line, so the new idea
 * follows the ones already there. No section: one is added at the end of the file. No tracker: a
 * new one is written, headed with the Collection's name. Nothing else in the file changes.
 */
export function addIdeaToTracker(content: string | null, collectionName: string, entry: string[]): string {
  if (content === null) return [`# ${collectionName}`, '', '## Ideas', '', ...entry, ''].join('\n')
  const eol = lineEnding(content)
  const cr = eol === '\r\n' ? '\r' : ''
  const lines = content.split('\n')
  const bare = (line: string): string => (cr && line.endsWith('\r') ? line.slice(0, -1) : line)

  let heading = -1
  let end = lines.length
  let fence: string | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const text = bare(lines[index])
    const opening = FENCE.exec(text)?.[1]
    if (fence) {
      if (opening && opening[0] === fence[0] && opening.length >= fence.length && text.trim() === opening) fence = null
      continue
    }
    if (opening) {
      fence = opening
      continue
    }
    if (heading === -1) {
      if (IDEAS_HEADING.test(text)) heading = index
    } else if (ANY_HEADING.test(text)) {
      end = index
      break
    }
  }

  const withEnding = entry.map((line) => `${line}${cr}`)
  if (heading === -1) {
    const gap = content === '' || content.endsWith('\n\n') || content.endsWith('\r\n\r\n') ? '' : content.endsWith('\n') ? eol : `${eol}${eol}`
    return `${content}${gap}## Ideas${eol}${eol}${entry.join(eol)}${eol}`
  }

  let last = heading
  for (let index = end - 1; index > heading; index -= 1) {
    if (bare(lines[index]).trim() !== '') {
      last = index
      break
    }
  }
  const insert = last === heading ? [cr, ...withEnding] : withEnding
  const at = last + 1
  const next = lines[at]
  if (next !== undefined && ANY_HEADING.test(bare(next))) insert.push(cr)
  // The final line had no line ending: give the entry one so the file still ends on a full line.
  if (at === lines.length) return `${content}${eol}${insert.map((line) => line.replace(/\r$/, '')).join(eol)}${eol}`
  lines.splice(at, 0, ...insert)
  return lines.join('\n')
}

/** Append a scrap's text to the end of a piece, as its own paragraph. */
export function appendToPieceText(content: string, text: string): string {
  const eol = lineEnding(content)
  const body = text.replace(/\r/g, '').replace(/^\n+|\n+$/g, '').split('\n').join(eol)
  if (content === '') return `${body}${eol}`
  const gap = content.endsWith(`${eol}${eol}`) ? '' : content.endsWith('\n') ? eol : `${eol}${eol}`
  return `${content}${gap}${body}${eol}`
}

/** A lossless Scratchpad text item a plan copies from (spec P4 copy-for-reuse): no scraps file is
 *  written and the candidate is retained; after the receiving document lands, the copy is recorded
 *  on the item as a historical use. `markdown` is the exact payload this plan was prepared from —
 *  the captured authority execution is held to, so a payload changed since cannot be re-authorised
 *  by a later read. See recordLosslessBoardCopy. */
export type LosslessBoardTake = { id: string; markdown: string }

export type OffcutPromotionPlan = { target: string; tracker: MaterialWrite; scraps: MaterialWrite | null; lossless?: LosslessBoardTake }

/**
 * The pure promote plan: scrap + name → the tracker's new text and the scraps file's new text.
 * Refuses (throws) an empty name, a name already linked from the tracker, and a missing scrap.
 */
export function planOffcutPromotion(input: {
  trackerPath: string
  tracker: string | null
  collectionName: string
  scrapsPath: string
  scraps: string
  scrapId: string
  name: string
}): OffcutPromotionPlan {
  const target = ideaTarget(input.name)
  if (!target) throw new Error('Give the idea a name first.')
  if (input.tracker !== null && trackerLinksTo(input.tracker, target)) {
    throw new Error(`“${input.name.trim()}” is already in the tracker note. Choose another name.`)
  }
  const removed = removeScrapFromContent(input.scraps, input.scrapId)
  return {
    target,
    tracker: { path: input.trackerPath, before: input.tracker, after: addIdeaToTracker(input.tracker, input.collectionName, ideaEntryLines(target, removed.scrap.text)) },
    scraps: { path: input.scrapsPath, before: input.scraps, after: removed.next },
  }
}

export type ScrapAppendPlan = { piece: MaterialWrite; scraps: MaterialWrite | null; lossless?: LosslessBoardTake }

/** Append a lossless item's exact payload to a piece: only the blank-line separation before it and a
 *  final line ending after it are added; the payload's own bytes (line endings included) are kept. */
export function appendExactText(content: string, text: string): string {
  if (content === '') return text
  const eol = lineEnding(content)
  const gap = content.endsWith(`${eol}${eol}`) ? '' : content.endsWith('\n') ? eol : `${eol}${eol}`
  const joined = `${content}${gap}${text}`
  return joined.endsWith('\n') ? joined : `${joined}${eol}`
}

/** The lossless item a Board step may take, read through the Scratchpad store's checked authority
 *  (loaded on first use, as in scrap-listing.ts, so Board imports stay light). */
async function boardTextItem(ws: Workspace, id: string): Promise<{ markdown: string; origin: string }> {
  const { ScratchpadStore } = await import('./scratchpad-store')
  const item = await new ScratchpadStore(ws, null).boardTextItem(id)
  return { markdown: item.markdown, origin: item.origin.path }
}

/**
 * The scrap half of a Board/agent copy step for a lossless item, run AFTER the receiving document
 * is written and inside the caller's restore ownership (the Board desk, or the accepted agent
 * proposal's own exclusive write): the store records the actual copy as a historical use through
 * its checked writer and RETAINS the candidate. Undo of the step restores the receiving document
 * only; this record is never rolled back over outside metadata edits.
 */
export async function recordLosslessBoardCopy(ws: Workspace, take: LosslessBoardTake, destination: string): Promise<void> {
  const { ScratchpadStore } = await import('./scratchpad-store')
  await new ScratchpadStore(ws, null).recordBoardCopy(take.id, destination, `u_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`, take.markdown)
}

/** The pure append plan: scrap → the piece's new text (scrap at its end) and the scraps file's new text. */
export function planScrapAppend(input: { piecePath: string; piece: string; scrapsPath: string; scraps: string; scrapId: string }): ScrapAppendPlan {
  const removed = removeScrapFromContent(input.scraps, input.scrapId)
  if (!removed.scrap.text.trim()) throw new Error('That scrap is empty; there is nothing to add.')
  return {
    piece: { path: input.piecePath, before: input.piece, after: appendToPieceText(input.piece, removed.scrap.text) },
    scraps: { path: input.scrapsPath, before: input.scraps, after: removed.next },
  }
}

async function readOptional(ws: Workspace, path: string): Promise<string | null> {
  const absolute = ws.absolute(path)
  if (!existsSync(absolute)) return null
  return readFile(absolute, 'utf8')
}

function collectionName(ws: Workspace, dir: string): string {
  return dir === '' ? posix.basename(ws.root) : posix.basename(dir)
}

function isInside(dir: string, path: string): boolean {
  return dir === '' || path.startsWith(`${dir}/`)
}

/** Read the tracker and scraps file and plan the promotion; refuses before anything is written. */
export async function prepareOffcutPromotion(ws: Workspace, input: PromoteOffcutInput): Promise<OffcutPromotionPlan> {
  const dir = input.dir.replace(/^\/+|\/+$/g, '')
  if (isLosslessScrapId(input.scrapId)) {
    // A lossless text item (ticket 04): the tracker quote is its exact payload, and the copy is
    // copied (the candidate is retained) instead of a scraps file being rewritten.
    const item = await boardTextItem(ws, input.scrapId)
    if (!isInside(dir, item.origin)) throw new Error('That offcut is not in this collection.')
    const target = ideaTarget(input.name)
    if (!target) throw new Error('Give the idea a name first.')
    const clash = (await ws.listFiles()).find((file) => isInside(dir, file.path) && !isScrapsPath(file.path)
      && posix.basename(file.path).replace(MARKDOWN_EXTENSION, '').toLocaleLowerCase() === target)
    if (clash) throw new Error(`A piece named “${input.name.trim()}” already exists in this collection (${clash.path}). Choose another name.`)
    const trackerPath = indexNotePath(ws, dir)
    const tracker = await readOptional(ws, trackerPath)
    if (tracker !== null && trackerLinksTo(tracker, target)) throw new Error(`“${input.name.trim()}” is already in the tracker note. Choose another name.`)
    return {
      target,
      tracker: { path: trackerPath, before: tracker, after: addIdeaToTracker(tracker, collectionName(ws, dir), ideaEntryLines(target, item.markdown)) },
      scraps: null,
      lossless: { id: input.scrapId, markdown: item.markdown },
    }
  }
  if (!isScrapsPath(input.scrapsPath) || !isInside(dir, input.scrapsPath)) throw new Error('That offcut is not in this collection.')
  const scraps = await readOptional(ws, input.scrapsPath)
  if (scraps === null) throw new Error('That offcut is gone: its scraps file no longer exists.')
  const target = ideaTarget(input.name)
  if (target) {
    const clash = (await ws.listFiles()).find((file) => isInside(dir, file.path) && !isScrapsPath(file.path)
      && posix.basename(file.path).replace(MARKDOWN_EXTENSION, '').toLocaleLowerCase() === target)
    if (clash) throw new Error(`A piece named “${input.name.trim()}” already exists in this collection (${clash.path}). Choose another name.`)
  }
  const trackerPath = indexNotePath(ws, dir)
  return planOffcutPromotion({
    trackerPath,
    tracker: await readOptional(ws, trackerPath),
    collectionName: collectionName(ws, dir),
    scrapsPath: input.scrapsPath,
    scraps,
    scrapId: input.scrapId,
    name: input.name,
  })
}

/** Read the piece and its scraps file and plan the append; refuses before anything is written. */
export async function prepareScrapAppend(ws: Workspace, input: AppendScrapInput): Promise<ScrapAppendPlan & { pieceTitle: string }> {
  if (!MARKDOWN_EXTENSION.test(input.piece) || isScrapsPath(input.piece)) throw new Error('A scrap can only be added to a piece.')
  const piece = await readOptional(ws, input.piece)
  if (piece === null) throw new Error(`${input.piece} no longer exists.`)
  if (isLosslessScrapId(input.scrapId)) {
    // A lossless text item (ticket 04): its exact payload is appended and the candidate is
    // retained for reuse. Like a drawer scrap, it belongs to the piece it came from.
    const item = await boardTextItem(ws, input.scrapId)
    if (item.origin !== input.piece) throw new Error('That item was set aside from another piece, so it was left as it is. Insert a copy from the Scratchpad to use it here.')
    if (!item.markdown.trim()) throw new Error('That scrap is empty; there is nothing to add.')
    const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(piece.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''))?.[1]
    const pieceTitle = parseFrontmatter(piece)?.title?.trim() || heading || posix.basename(input.piece).replace(MARKDOWN_EXTENSION, '')
    return {
      piece: { path: input.piece, before: piece, after: appendExactText(piece, item.markdown) },
      scraps: null,
      lossless: { id: input.scrapId, markdown: item.markdown },
      pieceTitle,
    }
  }
  const scrapsPath = scrapsPathFor(input.piece)
  const scraps = await readOptional(ws, scrapsPath)
  if (scraps === null) throw new Error('That scrap is gone: its scraps file no longer exists.')
  const plan = planScrapAppend({ piecePath: input.piece, piece, scrapsPath, scraps, scrapId: input.scrapId })
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(piece.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''))?.[1]
  const pieceTitle = parseFrontmatter(piece)?.title?.trim() || heading || posix.basename(input.piece).replace(MARKDOWN_EXTENSION, '')
  return { ...plan, pieceTitle }
}

/** What is at `path` now: its text, or null when there is no file. */
function textNow(ws: Workspace, path: string): string | null {
  const absolute = ws.absolute(path)
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null
}

/** The file still holds what the plan read (`before`; null: no file), or the write is refused as a change
 *  since the read (ChangedSinceRead), nothing written. */
function assertAsRead(ws: Workspace, write: MaterialWrite): void {
  if (write.before === null) {
    if (existsSync(ws.absolute(write.path))) throw ws.changedSinceRead(write.path, textNow(ws, write.path))
    return
  }
  try {
    ws.commitOnlyOver(write.path, { kind: 'disk', text: write.before })()
  } catch (error) {
    if (error instanceof DiskChangedUnderBuffer) throw ws.changedSinceRead(error.path, error.diskText)
    throw error
  }
}

/**
 * Write a plan's files in order (the receiving file first, the scraps file last, so a failure part
 * way never loses the scrap). A null `after` deletes the file, as ScrapStore.remove does.
 *
 * Each file is written only over the text the plan read (`before`), never over a version it did not read
 * (R5; final review round 2, finding 1): every file is checked before the first is written, and each write
 * is checked again where it commits (an existing file in the tick of its rename or unlink, a new one by an
 * exclusive create). A file changed since the read throws ChangedSinceRead.
 */
export async function writeMaterial(ws: Workspace, writes: MaterialWrite[]): Promise<void> {
  for (const write of writes) assertAsRead(ws, write)
  for (const write of writes) {
    if (write.after === null) {
      // A turn of the Collection's write turn, as the saves below take for themselves; removed only while
      // it still holds the text the plan read (R5), compared in the tick of the unlink.
      await ws.exclusive(write.path, async () => {
        ws.assertWritable()
        if (write.before !== null) ws.removeFileOverRead(write.path, write.before)
      })
    } else if (write.before === null) {
      try {
        await ws.createFile(write.path, write.after)
      } catch (error) {
        // Created by someone else since the check: a change since the read.
        if (existsSync(ws.absolute(write.path))) throw ws.changedSinceRead(write.path, textNow(ws, write.path))
        throw error
      }
    } else {
      try {
        await ws.saveFileOverRead(write.path, write.after, write.before, { allowExplicitEmpty: true })
      } catch (error) {
        // Committed and not read back: written.
        if (!(error instanceof SavedButNotReadBack)) throw error
      }
    }
  }
}

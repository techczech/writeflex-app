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

import { existsSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { posix } from 'node:path'
import { indexNotePath } from './folio'
import { isScrapsPath, removeScrapFromContent, scrapsPathFor } from './scraps'
import { parseFrontmatter } from './frontmatter'
import { slugifyFileName, type Workspace } from './workspace'
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

export type OffcutPromotionPlan = { target: string; tracker: MaterialWrite; scraps: MaterialWrite }

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

export type ScrapAppendPlan = { piece: MaterialWrite; scraps: MaterialWrite }

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
  const scrapsPath = scrapsPathFor(input.piece)
  const scraps = await readOptional(ws, scrapsPath)
  if (scraps === null) throw new Error('That scrap is gone: its scraps file no longer exists.')
  const plan = planScrapAppend({ piecePath: input.piece, piece, scrapsPath, scraps, scrapId: input.scrapId })
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(piece.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''))?.[1]
  const pieceTitle = parseFrontmatter(piece)?.title?.trim() || heading || posix.basename(input.piece).replace(MARKDOWN_EXTENSION, '')
  return { ...plan, pieceTitle }
}

/**
 * Write a plan's files in order (the receiving file first, the scraps file last, so a failure part
 * way never loses the scrap). A null `after` deletes the file, as ScrapStore.remove does.
 */
export async function writeMaterial(ws: Workspace, writes: MaterialWrite[]): Promise<void> {
  for (const write of writes) {
    if (write.after === null) {
      if (existsSync(ws.absolute(write.path))) await unlink(ws.absolute(write.path))
    } else if (write.before === null) {
      await ws.createFile(write.path, write.after)
    } else {
      await ws.saveFileWithoutReadBack(write.path, write.after, { allowExplicitEmpty: true })
    }
  }
}

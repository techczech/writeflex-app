/**
 * Attach a source to a piece (docs/design/2026-09-27-scraps-and-sources-on-the-board, frame 4): the
 * piece's frontmatter `sources:` list gains ONE line naming a research note. Nothing else in the file
 * changes, and no file moves.
 *
 * `appendSourceLine` is the pure half (file text + entry → new text); everything outside the line it
 * adds stays byte-identical. The forms it writes into, in order of how often a writer meets them:
 *
 *  - a dashed block list: one item line after the last, in the list's own indent and dash spacing;
 *  - no `sources:` key: the key and its one item, just before the closing fence;
 *  - no frontmatter at all: a new block holding only the key and its item (the writer asked for it,
 *    so this is not the automatic insertion ADR-0008 forbids);
 *  - an inline list `[a, b]`: the item is added inside the brackets, so that one line changes;
 *  - a lone scalar: the line becomes a dashed list holding the old value, then the new item.
 *
 * Anything else (a block scalar, a nested mapping, brackets inside an inline list) is refused rather
 * than guessed at. `prepareSourceAttach` reads the piece and the Collection and plans; the Board's
 * desk (board-material-desk.ts) writes the plan under one restore point.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { collectionPieces } from './collection'
import { parseFrontmatter } from './frontmatter'
import { isResearchNotePath, listedSourceEntry, materialFactOf } from './piece-material'
import { isScrapsPath } from './scraps'
import type { MaterialWrite } from './board-material'
import type { Workspace } from './workspace'
import type { AttachSourceInput } from '../shared/board-material'
import { frontmatterBlock, FRONTMATTER_DASH_ITEM, FRONTMATTER_KEY_VALUE } from '../shared/markdown/frontmatter'

const SOURCES_KEY = 'sources'
const MARKDOWN_EXTENSION = /\.(?:md|markdown|mdx)$/i
const BOM = '﻿'
/** A list item's lead: its indent, the dash, and the space after it. */
const ITEM_LEAD = /^([ \t]*)-([ \t]*)/
/** Characters that would make a bare list item read as something other than a string. */
const YAML_SPECIAL_START = /^[-?:,[\]{}#&*!|>'"%@`]/

/** Why an attach was refused: the text is shown to the writer as it stands. */
export class SourceAttachRefusal extends Error {}

type Line = { content: string; ending: string }

function linesOf(text: string): Line[] {
  const lines: Line[] = []
  let cursor = 0
  while (cursor < text.length) {
    const newline = text.indexOf('\n', cursor)
    const end = newline === -1 ? text.length : newline
    const raw = text.slice(cursor, end)
    const cr = raw.endsWith('\r')
    lines.push({ content: cr ? raw.slice(0, -1) : raw, ending: newline === -1 ? '' : cr ? '\r\n' : '\n' })
    cursor = newline === -1 ? text.length : newline + 1
  }
  return lines
}

function joined(lines: Line[]): string {
  return lines.map((line) => line.content + line.ending).join('')
}

/** A list item as YAML reads it back as the same string: bare when that is safe, else double-quoted. */
export function yamlItem(value: string, inline = false): string {
  const unsafe = value === '' || value.trim() !== value || YAML_SPECIAL_START.test(value) || /: |\s#|[\n\r\t"]/.test(value)
    || /:$/.test(value) || /^(?:~|null|true|false|yes|no|on|off)$/i.test(value) || (inline && /[,[\]{}]/.test(value))
  return unsafe ? JSON.stringify(value) : value
}

/** The entry a piece's `sources:` list names a research note by: its path from the piece's folder. */
export function sourceEntryFor(piecePath: string, sourcePath: string): string {
  const from = posix.dirname(piecePath)
  return from === '.' ? sourcePath : posix.relative(from, sourcePath)
}

function refuse(reason: string): never {
  throw new SourceAttachRefusal(`This piece's sources: list ${reason}, so WriteFlex will not add to it. Nothing was changed.`)
}

/**
 * The piece's text with ONE `sources:` entry added (the key created when absent). Pure; every byte
 * outside the added line (or, for an inline list or a lone value, the one rewritten key line) is
 * kept exactly, line endings and BOM included. Throws SourceAttachRefusal on a form it cannot extend
 * safely, and when the list already holds exactly this entry.
 */
export function appendSourceLine(content: string, entry: string): string {
  const bom = content.startsWith(BOM) ? BOM : ''
  const block = frontmatterBlock(content)
  if (!block) {
    const first = content.indexOf('\n')
    const eol = first > 0 && content[first - 1] === '\r' ? '\r\n' : '\n'
    return `${bom}---${eol}${SOURCES_KEY}:${eol}  - ${yamlItem(entry)}${eol}---${eol}${content.slice(bom.length)}`
  }

  const head = linesOf(content.slice(bom.length, block.end))
  const rest = content.slice(block.end)
  const eol = head[0].ending || '\n'
  // head[0] is the opening fence and head.at(-1) the closing one; the body lies between them.
  const last = head.length - 1
  let keyIndex = -1
  for (let index = 1; index < last; index += 1) {
    if (FRONTMATTER_KEY_VALUE.exec(head[index].content)?.[1] === SOURCES_KEY) keyIndex = index
  }
  const finish = (lines: Line[]): string => `${bom}${joined(lines)}${rest}`

  if (keyIndex === -1) {
    head.splice(last, 0, { content: `${SOURCES_KEY}:`, ending: eol }, { content: `  - ${yamlItem(entry)}`, ending: eol })
    return finish(head)
  }

  const keyLine = head[keyIndex]
  const value = FRONTMATTER_KEY_VALUE.exec(keyLine.content)![2].trim()

  if (value === '') {
    let end = keyIndex + 1
    while (end < last && FRONTMATTER_DASH_ITEM.test(head[end].content)) end += 1
    const items = head.slice(keyIndex + 1, end)
    if (items.length === 0) {
      // An indented line under an empty key is a nested mapping or a continuation, not a list.
      if (keyIndex + 1 < last && /^[ \t]+\S/.test(head[keyIndex + 1].content)) refuse('is not a plain list')
      head.splice(keyIndex + 1, 0, { content: `  - ${yamlItem(entry)}`, ending: eol })
      return finish(head)
    }
    const written = items.map((line) => FRONTMATTER_DASH_ITEM.exec(line.content)![1].trim())
    if (written.includes(entry) || written.includes(yamlItem(entry))) refuse(`already names ${entry}`)
    const lead = ITEM_LEAD.exec(items[items.length - 1].content)!
    const prefix = `${lead[1]}-${lead[2] || ' '}`
    head.splice(end, 0, { content: `${prefix}${yamlItem(entry)}`, ending: items[items.length - 1].ending || eol })
    return finish(head)
  }

  if (value.startsWith('[')) {
    const open = keyLine.content.indexOf('[')
    const close = keyLine.content.lastIndexOf(']')
    const inner = close > open ? keyLine.content.slice(open + 1, close) : ''
    if (!value.endsWith(']') || /[[\]]/.test(inner)) refuse('is written in a form it cannot read safely')
    const items = inner.split(',').map((item) => item.trim().replace(/^(["'])(.*)\1$/, '$2'))
    if (items.includes(entry)) refuse(`already names ${entry}`)
    const before = keyLine.content.slice(0, close).replace(/[ \t]+$/, '')
    const separator = inner.trim() === '' ? '' : ', '
    head[keyIndex] = { content: `${before}${separator}${yamlItem(entry, true)}${keyLine.content.slice(close)}`, ending: keyLine.ending }
    return finish(head)
  }

  if (/^[|>&*!%@`]/.test(value)) refuse('is written in a form it cannot read safely')
  if (keyIndex + 1 < last && /^[ \t]+\S/.test(head[keyIndex + 1].content)) refuse('continues on the next line')
  if (value.replace(/^(["'])(.*)\1$/, '$2') === entry) refuse(`already names ${entry}`)
  const indent = /^[ \t]*/.exec(keyLine.content)![0]
  head.splice(keyIndex, 1,
    { content: `${indent}${SOURCES_KEY}:`, ending: keyLine.ending },
    { content: `${indent}  - ${value}`, ending: eol },
    { content: `${indent}  - ${yamlItem(entry)}`, ending: keyLine.ending || eol })
  return finish(head)
}

export type SourceAttachPlan = { piece: MaterialWrite; entry: string; pieceTitle: string; sourceTitle: string }

/** The pure attach plan. `listedAs` is the entry that already names the source, when one does. */
export function planSourceAttach(input: {
  piecePath: string
  piece: string
  sourcePath: string
  pieceTitle: string
  sourceTitle: string
  listedAs: string | null
}): SourceAttachPlan {
  if (input.listedAs !== null) {
    throw new SourceAttachRefusal(`“${input.sourceTitle}” is already in the sources of ${input.pieceTitle}. Nothing was changed.`)
  }
  const entry = sourceEntryFor(input.piecePath, input.sourcePath)
  return {
    piece: { path: input.piecePath, before: input.piece, after: appendSourceLine(input.piece, entry) },
    entry,
    pieceTitle: input.pieceTitle,
    sourceTitle: input.sourceTitle,
  }
}

function isInside(dir: string, path: string): boolean {
  return dir === '' || path.startsWith(`${dir}/`)
}

function entriesOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  return typeof value === 'string' && value.trim() ? [value.trim()] : []
}

/**
 * Read the piece and the Collection and plan the attach; refuses, before anything is written, a
 * piece or source outside the Collection, a source that is not a research note, a missing file, and
 * a source the piece's `sources:` list already names in any form.
 */
export async function prepareSourceAttach(ws: Workspace, input: AttachSourceInput): Promise<SourceAttachPlan> {
  const dir = input.dir.replace(/^\/+|\/+$/g, '')
  if (!MARKDOWN_EXTENSION.test(input.piece) || isScrapsPath(input.piece) || isResearchNotePath(input.piece, dir)) {
    throw new SourceAttachRefusal('A source can only be attached to a piece.')
  }
  if (!isInside(dir, input.piece)) throw new SourceAttachRefusal('That piece is not in this collection.')
  if (!isInside(dir, input.source) || !isResearchNotePath(input.source, dir) || !MARKDOWN_EXTENSION.test(input.source)) {
    throw new SourceAttachRefusal('Only a Markdown note in a research/ folder of this collection can be attached as a source.')
  }
  if (!existsSync(ws.absolute(input.piece))) throw new SourceAttachRefusal(`${input.piece} no longer exists.`)
  if (!existsSync(ws.absolute(input.source))) throw new SourceAttachRefusal(`${input.source} no longer exists.`)
  const piece = await readFile(ws.absolute(input.piece), 'utf8')
  const facts = (await collectionPieces(ws, dir)).map(materialFactOf)
  const title = (path: string): string => facts.find((fact) => fact.path === path)?.title ?? posix.basename(path).replace(MARKDOWN_EXTENSION, '')
  if (!facts.some((fact) => fact.path === input.piece)) throw new SourceAttachRefusal('That piece is not in this collection.')
  if (!facts.some((fact) => fact.path === input.source)) throw new SourceAttachRefusal('That source is not in this collection.')
  const entries = entriesOf(parseFrontmatter(piece)?.extra[SOURCES_KEY])
  return planSourceAttach({
    piecePath: input.piece,
    piece,
    sourcePath: input.source,
    pieceTitle: title(input.piece),
    sourceTitle: title(input.source),
    listedAs: listedSourceEntry(dir, facts, input.piece, entries, input.source),
  })
}

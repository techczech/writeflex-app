/**
 * Line-exact edits of a document's frontmatter block: set one key, find where the block's lines sit. Pure
 * text in, text out, so main (the Folio part proposals, the title-conflict fixes) and the renderer (the
 * open document's title bar, which edits the editor buffer) make the same bytes. Moved here from
 * main/folio-part-proposals.ts; `withFrontmatterKey` now keeps a CRLF line's `\r` (it dropped it before). Every other byte of the document is kept; the line ending is the file's own.
 */

import { frontmatterBlock, FRONTMATTER_FENCE, FRONTMATTER_KEY_VALUE } from './frontmatter'

export const eolOf = (source: string): string => (source.includes('\r\n') ? '\r\n' : '\n')

/** A YAML scalar the frontmatter reader gives back unchanged. */
export function yamlScalar(value: string): string {
  const plain = /^[\p{L}\p{N}][^:#"'\n]*$/u.test(value) && !/[\s]$/.test(value) && !/:\s/.test(value) && !/\s#/.test(value)
  return plain ? value : JSON.stringify(value)
}

export type FrontmatterLine = { start: number; end: number; text: string }
export type FrontmatterLayout = { bom: number; openEnd: number; closeStart: number; end: number; lines: FrontmatterLine[] }

/** Where the frontmatter block's lines sit in the original text; null when there is no block. */
export function layoutOf(source: string): FrontmatterLayout | null {
  const block = frontmatterBlock(source)
  if (!block) return null
  const bom = source.startsWith('﻿') ? 1 : 0
  const lines: FrontmatterLine[] = []
  let cursor = source.indexOf('\n', bom) + 1
  const openEnd = cursor
  for (;;) {
    const newline = source.indexOf('\n', cursor)
    const end = newline === -1 ? source.length : newline
    const text = source.slice(cursor, end).replace(/\r$/, '')
    if (FRONTMATTER_FENCE.test(text)) return { bom, openEnd, closeStart: cursor, end: block.end, lines }
    lines.push({ start: cursor, end, text })
    if (newline === -1) return null
    cursor = newline + 1
  }
}

/** The text with frontmatter `key` set to `value` (a ready-made scalar). Null when the key's current value is a list (never edited here). */
export function withFrontmatterKey(source: string, key: string, value: string): string | null {
  const eol = eolOf(source)
  const layout = layoutOf(source)
  const line = `${key}: ${value}`
  if (!layout) return `---${eol}${line}${eol}---${eol}${eol}${source}`
  const at = layout.lines.find((item) => FRONTMATTER_KEY_VALUE.exec(item.text)?.[1] === key)
  if (!at) return source.slice(0, layout.openEnd) + line + eol + source.slice(layout.openEnd)
  if ((FRONTMATTER_KEY_VALUE.exec(at.text)?.[2] ?? '').trim() === '') return null
  // The line's own `\r` (a CRLF file) stays: `at.end` is the `\n`, so the replaced range holds it.
  const cr = source[at.end - 1] === '\r' ? '\r' : ''
  return source.slice(0, at.start) + line + cr + source.slice(at.end)
}

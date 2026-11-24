import { posix } from 'node:path'
import { frontmatterBlock } from '../shared/markdown/frontmatter'

/** Where a vault file that a value reaches (by its path before the move) will be once the move is made;
 *  null when the value reaches no file. */
export type FrontMatterTarget = (oldTarget: string) => Promise<string | null>

/** The keys whose value is a file the document points at. Nothing else in front matter is read as a path. */
const PATH_KEYS = new Set(['image', 'cover', 'thumbnail', 'banner', 'file', 'path', 'src', 'attachment', 'pdf', 'audio', 'video'])
/** `key:` with its value, the key bare or quoted, at any indentation. */
const KEY_LINE = /^([ \t]*)(?:"([^"\\]*)"|'([^']*)'|([^\s"'#:?\-][^:#]*?))[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/u
/** `-` with its value, at any indentation. */
const DASH_LINE = /^([ \t]*)-(?:[ \t]+(.*)|[ \t]*)$/
/** A node property (an anchor `&a` or a tag `!t`) in front of a value. */
const PROPERTIES = /^(?:[&!][^\s]*[ \t]+)+/

const indentOf = (line: string): number => /^[ \t]*/.exec(line)![0].length

/**
 * Plan the edits to relative file paths in the front matter of a document moving from `from` to `to`.
 * Deliberately narrow (two review rounds found YAML shapes a line reader misreads): only a single-line value of a
 * path key (`image`, `cover`, `thumbnail`, `banner`, `file`, `path`, `src`, `attachment`, `pdf`, `audio`,
 * `video`), at the top level or one level into a block mapping, plain or quoted, that reaches an existing vault
 * file from the old place and whose meaning the move changes. Never a value inside a block scalar, a flow
 * collection or a multi-line value, nor one with an anchor, alias or tag. The new value is always written as a
 * double-quoted string, so YAML cannot read it as a number or a Boolean. Everything else keeps its exact bytes.
 */
export async function movedFrontMatterPaths(
  source: string,
  from: string,
  to: string,
  locate: FrontMatterTarget,
): Promise<{ content: string; references: string[]; destinations: string[] }> {
  const block = frontmatterBlock(source)
  const references: string[] = []
  const destinations = new Set<string>()
  if (!block) return { content: source, references, destinations: [] }
  // The block's lines in the original text (after the opening fence, before the closing one), with offsets.
  const lines: Array<{ at: number; text: string }> = []
  for (let cursor = source.indexOf('\n') + 1; cursor < block.end;) {
    const newline = source.indexOf('\n', cursor)
    const end = newline === -1 ? source.length : newline
    lines.push({ at: cursor, text: source.slice(cursor, end).replace(/\r$/, '') })
    if (newline === -1) break
    cursor = newline + 1
  }
  lines.pop()

  const edits: Array<{ from: number; to: number; text: string }> = []
  let blockScalarIndent: number | null = null
  let flowDepth = 0
  let openQuote: '"' | "'" | null = null
  /** The top-level key whose value is the block mapping the next lines belong to, and that mapping's indent. */
  let parent: { mapping: boolean; childIndent: number | null } | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const { at, text: line } = lines[index]!
    const indent = indentOf(line)
    if (openQuote) {
      if (closingQuoteAt(line, 0, openQuote) >= 0) openQuote = null
      continue
    }
    if (blockScalarIndent !== null) {
      if (line.trim() === '' || indent > blockScalarIndent) continue
      blockScalarIndent = null
    }
    if (flowDepth > 0) {
      flowDepth = Math.max(0, flowDepth + depthChange(line))
      continue
    }
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const keyed = KEY_LINE.exec(line)
    const dashed = keyed ? null : DASH_LINE.exec(line)
    const raw = (keyed ? keyed[5] : dashed?.[2]) ?? ''
    const value = raw.replace(PROPERTIES, '')
    const hasProperties = value !== raw
    if (keyed && indent === 0) parent = { mapping: raw.trim() === '', childIndent: null }
    else if (keyed && parent?.mapping) parent.childIndent ??= indent
    // Shapes that run past this line: whatever key they belong to, their lines are never read as keys.
    if (/^[|>][-+0-9]*(?:[ \t]+#.*)?$/.test(value.trim())) { blockScalarIndent = indent; continue }
    if (/^[[{]/.test(value)) { flowDepth = Math.max(0, depthChange(value)); continue }
    if ((value.startsWith('"') || value.startsWith("'")) && closingQuoteAt(value, 1, value[0] as '"' | "'") < 0) {
      openQuote = value[0] as '"' | "'"
      continue
    }
    if (!keyed) continue
    const key = (keyed[2] ?? keyed[3] ?? keyed[4] ?? '').trim().toLowerCase()
    const level = indent === 0 ? 0 : parent?.mapping && parent.childIndent === indent ? 1 : null
    if (level === null || !PATH_KEYS.has(key) || hasProperties || !value) continue
    if (continues(lines, index, indent)) continue // a plain value carried on to the next line
    const scalar = scalarOf(value)
    if (!scalar) continue
    const next = await rewritten(scalar.path, from, to, locate)
    if (!next) continue
    const start = line.length - value.length
    const authored = value.slice(0, scalar.length)
    edits.push({ from: at + start, to: at + start + scalar.length, text: next.text })
    references.push(`${to}: ${authored}`)
    destinations.add(next.target)
  }
  let content = source
  for (const edit of edits.reverse()) content = `${content.slice(0, edit.from)}${edit.text}${content.slice(edit.to)}`
  return { content, references, destinations: [...destinations] }
}

/** Whether the line after `index` carries on the value of the key at `indent` (a multi-line plain scalar). */
function continues(lines: ReadonlyArray<{ text: string }>, index: number, indent: number): boolean {
  for (let next = index + 1; next < lines.length; next += 1) {
    const text = lines[next]!.text
    if (text.trim() === '') continue
    return indentOf(text) > indent && !text.trimStart().startsWith('#')
  }
  return false
}

/** Where `line` closes a quoted scalar opened before `from`, or -1. */
function closingQuoteAt(line: string, from: number, quote: '"' | "'"): number {
  for (let i = from; i < line.length; i += 1) {
    if (quote === '"' && line[i] === '\\') { i += 1; continue }
    if (line[i] !== quote) continue
    if (quote === "'" && line[i + 1] === "'") { i += 1; continue }
    return i
  }
  return -1
}

/** How far a line opens (+) or closes (−) flow brackets, quoted text and comments aside. */
function depthChange(text: string): number {
  let depth = 0
  let quote = ''
  let previous = ' '
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (quote === '"' && ch === '\\') { i += 1; continue } // an escape: the next character is text
    if (quote) { if (ch === quote) quote = ''; previous = ch; continue }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '[' || ch === '{') depth += 1
    else if (ch === ']' || ch === '}') depth -= 1
    else if (ch === '#' && /[ \t]/.test(previous)) break
    previous = ch
  }
  return depth
}

/** A single-line scalar at the start of `value`: its text and its length there (a trailing comment allowed after
 *  it); null for any other form (an escape in double quotes, text after a closing quote, an indicator). */
function scalarOf(value: string): { path: string; length: number } | null {
  const rest = (after: string): boolean => after === '' || /^[ \t]+(?:#.*)?$/.test(after)
  if (value.startsWith('"')) {
    const close = closingQuoteAt(value, 1, '"')
    const path = value.slice(1, close)
    return close > 0 && !path.includes('\\') && rest(value.slice(close + 1)) ? { path, length: close + 1 } : null
  }
  if (value.startsWith("'")) {
    const close = closingQuoteAt(value, 1, "'")
    return close > 0 && rest(value.slice(close + 1)) ? { path: value.slice(1, close).replaceAll("''", "'"), length: close + 1 } : null
  }
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value)) return null
  const comment = value.search(/[ \t]+#/)
  const path = (comment < 0 ? value : value.slice(0, comment)).replace(/[ \t]+$/, '')
  return path ? { path, length: path.length } : null
}

async function rewritten(path: string, from: string, to: string, locate: FrontMatterTarget): Promise<{ text: string; target: string } | null> {
  if (!path || path.trim() !== path || path.includes('\\') || path.includes('](') || /[\u0000-\u001f\u007f]/.test(path)) return null
  if (/^(?:[/#?]|[a-zA-Z][a-zA-Z0-9+.-]*:)/.test(path)) return null
  const oldTarget = posix.normalize(posix.join(posix.dirname(from), path))
  if (oldTarget === '..' || oldTarget.startsWith('../') || oldTarget === '.') return null
  const target = await locate(oldTarget).catch(() => null)
  if (!target) return null
  if (posix.normalize(posix.join(posix.dirname(to), path)) === target) return null
  let relative = posix.relative(posix.dirname(to), target)
  if (!relative || /[\u0000-\u001f\u007f]/.test(relative)) return null
  if (path.startsWith('./') && !relative.startsWith('../')) relative = `./${relative}`
  return { text: `"${relative.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`, target }
}

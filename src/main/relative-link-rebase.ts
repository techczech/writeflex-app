/**
 * Relative links in a Markdown document, kept pointing at the same files when documents move (the own-folder step
 * of a widget insert, contracts §14 C5). Pure: no fs.
 *
 * What is rewritten: the destination of an inline link or image (`[t](x)`, `![a](x)`), of a link reference
 * definition (`[id]: x`) and the path of a widget embed line (`[Simulation: x]`), when it is relative (no scheme,
 * not `/…`, `#…` or `?…`). It is resolved from the document's old folder, carried to where that file is now
 * (`where`, for files that moved too) and written again from the document's new folder. A `#fragment` or `?query`
 * is kept. Nothing inside code (fenced, indented or inline) is touched (the app's own Markdown parser finds the
 * links); wikilinks are not handled here (rename repair does that by name). Both forms of a destination, plain
 * (`a%20b.md`) and in angle brackets (`<a b.md>`), are read the same way: backslash escapes, then the path up to
 * the first `#` or `?`, then its percent-escapes. The new destination keeps the form it had; a name that was in it
 * keeps the way it was written, and a new one has every character that would not stay part of the name (`%`, `#`,
 * `?`, and in the plain form spaces and parentheses) percent-encoded.
 */
import { posix } from 'node:path'
import { parseMarkdown } from '../shared/markdown/dialect'
import { embedLine } from '../shared/markdown/embed-line'
import { scanMarkdownCodeRanges } from './rename-repair'

export type RebaseResult = { text: string; rewritten: number }

const dirOf = (path: string): string => (posix.dirname(path) === '.' ? '' : posix.dirname(path))

/** `target` (workspace-relative) as written from `fromDir` (workspace-relative, '' the Workspace folder). */
export function relativeFrom(fromDir: string, target: string): string {
  const from = fromDir.split('/').filter(Boolean)
  const to = target.split('/').filter(Boolean)
  let shared = 0
  while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared += 1
  const out = [...Array(from.length - shared).fill('..'), ...to.slice(shared)].join('/')
  return out === '' ? '.' : out
}

const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|[/#?]|\\)/i
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/

/** A link destination as written, in its two forms: `plain` (`a%20b.md`) or `angle` (`<a b.md>`, the brackets
 *  taken off). CommonMark reads both the same way: backslash escapes first, then the address, whose `#` or `?`
 *  starts a fragment or query and whose percent-escapes stand for the characters of the file name. */
export type DestinationForm = 'plain' | 'angle'

/** `raw` with its backslash escapes read (`\(` is `(`; a backslash before anything else stays). */
export function unescapeDestination(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === '\\' && i + 1 < raw.length && ASCII_PUNCTUATION.test(raw[i + 1])) { out += raw[i + 1]; i += 1 } else out += raw[i]
  }
  return out
}

/** Where the path ends in `raw` (as written): the first `#` or `?`, escaped or not (an escaped one is still the
 *  fragment's start once the escape is read). */
function pathEnd(raw: string): number {
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === '\\' && i + 1 < raw.length && ASCII_PUNCTUATION.test(raw[i + 1])) {
      if (raw[i + 1] === '#' || raw[i + 1] === '?') return i
      i += 1
    } else if (raw[i] === '#' || raw[i] === '?') return i
  }
  return raw.length
}

/** Percent-escapes read as the characters they stand for; a `%` that starts no valid UTF-8 escape stays a `%`
 *  (as a browser reads `100%.md`). */
export function decodePercent(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try { return decodeURIComponent(run) } catch {
      // Part of the run may still be valid: read it escape by escape, keeping what does not decode.
      return run.replace(/%[0-9a-f]{2}/gi, (one) => { try { return decodeURIComponent(one) } catch { return one } })
    }
  })
}

/** One path segment (a file or folder name) written for `form`, so that every character stays part of the name:
 *  `%`, `#` and `?` always percent-encoded; spaces, brackets and parentheses too in the plain form; a backslash
 *  and control characters always. */
export function encodeSegment(name: string, form: DestinationForm): string {
  let out = ''
  for (const char of name) {
    const code = char.codePointAt(0) as number
    const always = char === '%' || char === '#' || char === '?' || char === '\\' || char === '<' || char === '>' || code < 0x20 || code === 0x7f
    const plainOnly = char === ' ' || char === '(' || char === ')'
    out += always || (form === 'plain' && plainOnly) ? encodeURIComponent(char).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`) : char
  }
  return out
}

/** The file a destination names: the path part, its escapes read (segments as written and as read), and the
 *  `#fragment` or `?query` as written. Null for an address that is not a relative path. */
export function readDestination(raw: string): { segments: Array<{ written: string; name: string }>; suffix: string } | null {
  if (raw === '' || ABSOLUTE.test(unescapeDestination(raw))) return null
  const cut = pathEnd(raw)
  const pathPart = raw.slice(0, cut)
  if (pathPart === '') return null
  return { segments: pathPart.split('/').map((written) => ({ written, name: decodePercent(unescapeDestination(written)) })), suffix: raw.slice(cut) }
}

/** The rewritten destination (as written, in the same `form`), or null when it stays as it is. Names that were
 *  already in the destination keep the way they were written; new ones are encoded for the form. */
function rebaseTarget(raw: string, fromDir: string, toDir: string, where: (path: string) => string, form: DestinationForm | 'embed'): string | null {
  let segments: Array<{ written: string; name: string }>
  let suffix: string
  if (form === 'embed') {
    // An embed line names a file path as it is: no escapes, no fragment.
    if (raw === '' || ABSOLUTE.test(raw)) return null
    segments = raw.split('/').map((name) => ({ written: name, name }))
    suffix = ''
  } else {
    const read = readDestination(raw)
    if (read === null) return null
    ;({ segments, suffix } = read)
  }
  const decoded = segments.map((segment) => segment.name).join('/')
  const trailing = decoded.endsWith('/') ? '/' : ''
  const resolved = posix.normalize(posix.join(fromDir === '' ? '.' : fromDir, decoded)).replace(/\/$/, '')
  if (resolved === '..' || resolved.startsWith('../') || resolved === '.') return null
  const now = where(resolved)
  if (fromDir === toDir && now === resolved) return null
  const relative = relativeFrom(toDir, now)
  const asWritten = new Map(segments.map((segment) => [segment.name, segment.written]))
  const written = form === 'embed' ? relative : relative.split('/').map((name) => (name === '..' || name === '.' ? name : asWritten.get(name) ?? encodeSegment(name, form))).join('/')
  return `${written}${trailing}${suffix}`
}

/**
 * `source` (the document that was at `from`, now at `to`) with its relative links carried along. `where` answers
 * where a workspace-relative file is now (itself when it did not move). For a document that did not move, give
 * the same path twice: only links to moved files change.
 */
export function rebaseRelativeLinks(source: string, from: string, to: string, where: (path: string) => string): RebaseResult {
  const fromDir = dirOf(from)
  const toDir = dirOf(to)
  const edits: Array<{ from: number; to: number; text: string }> = []
  const cursor = parseMarkdown(source).cursor()
  do {
    if (cursor.name !== 'URL') continue
    const parent = cursor.node.parent?.name
    if (parent !== 'Link' && parent !== 'Image' && parent !== 'LinkReference') continue
    const raw = source.slice(cursor.from, cursor.to)
    const angled = raw.startsWith('<') && raw.endsWith('>') && raw.length >= 2
    const inner = angled ? raw.slice(1, -1) : raw
    const next = rebaseTarget(inner, fromDir, toDir, where, angled ? 'angle' : 'plain')
    if (next !== null) edits.push({ from: cursor.from, to: cursor.to, text: angled ? `<${next}>` : next })
  } while (cursor.next())

  // Embed lines: one line each, outside code.
  const code = scanMarkdownCodeRanges(source)
  const linePattern = /[^\r\n]*(?:\r\n|\n|\r|$)/g
  for (let match = linePattern.exec(source); match && match[0] !== ''; match = linePattern.exec(source)) {
    const start = match.index
    const line = match[0].replace(/[\r\n]+$/, '')
    const embed = embedLine(line)
    if (!embed || embed.refusal) continue
    if (code.some((range) => start >= range.from && start < range.to)) continue
    const next = rebaseTarget(embed.path, fromDir, toDir, where, 'embed')
    if (next === null) continue
    const at = line.lastIndexOf(embed.path)
    edits.push({ from: start + at, to: start + at + embed.path.length, text: next })
  }

  edits.sort((a, b) => b.from - a.from)
  let text = source
  for (const edit of edits) text = `${text.slice(0, edit.from)}${edit.text}${text.slice(edit.to)}`
  return { text, rewritten: edits.length }
}

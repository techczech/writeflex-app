/**
 * Rich paste keeps its links (scout-search-panel ticket 02).
 *
 * The editor pastes `text/plain`, which loses every link target: a Highlight Scout citation copied
 * as rich text, a browser selection or a Word paragraph arrives with "archive" and "public" as dead
 * words, or with raw URLs. When the clipboard's `text/html` carries anchors, this reads it instead
 * and writes each anchor as a Markdown inline link `[words](url)`. Everything else is treated as a
 * plain paste already treats it: the words, line and paragraph breaks, no other markup.
 *
 * Pure string work (no DOM), so it runs the same in the renderer and in a unit test. It answers
 * null whenever the plain paste is already right, and the caller then pastes `text/plain` as before:
 * - the HTML has no followable anchor;
 * - `text/plain` already carries every anchor as a Markdown link (Highlight Scout's "Markdown in
 *   WriteFlex" copy puts the Markdown citation there, which is more faithful than any conversion);
 * - `text/plain` is a bare URL, which the auto-link-title paste owns.
 */
import { isBareUrl } from './auto-link-title'

/** Destinations a pasted link may keep in the writer's own document. The editor opens writeflex://
 *  and file:// links itself; export later drops them (external-links.ts). */
const PASTE_LINK_SCHEMES = new Set(['http', 'https', 'mailto', 'tel', 'writeflex', 'file', 'zotero'])
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“',
  rdquo: '”', middot: '·', bull: '•', deg: '°', pound: '£', euro: '€', times: '×', shy: '',
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body] ?? ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** The href a pasted link may keep, or null for one that stays words (javascript:, data:, relative
 *  paths and #fragments, which mean nothing once they leave the page they were copied from). */
export function pasteHref(raw: string): string | null {
  const href = decodeEntities(raw).replace(/[\u0000-\u001f\u007f]/g, '').trim()
  const scheme = SCHEME.exec(href)
  return scheme && PASTE_LINK_SCHEMES.has(scheme[1].toLowerCase()) ? href : null
}

/** A block element ends a paragraph; a line element ends a line. Anything else is inline. */
const PARAGRAPH_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'ul', 'ol', 'table', 'hr', 'figure'])
const LINE_TAGS = new Set(['div', 'li', 'tr', 'dt', 'dd', 'dl', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside', 'address', 'figcaption', 'caption'])
const CELL_TAGS = new Set(['td', 'th'])

const DROPPED_ELEMENTS = /<(script|style|head|title|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|[^<]+|</g

function attribute(attributes: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attributes)
  return match ? match[1] ?? match[2] ?? match[3] ?? '' : null
}

/** Link words as Markdown link text: brackets and backslashes escaped so the link cannot close
 *  early. */
function linkText(words: string): string {
  return words.replace(/([\\[\]])/g, '\\$1')
}

/** A destination as Markdown writes it: bare when it can be, in angle brackets when it holds a
 *  space or a parenthesis that would end it. */
function linkDestination(href: string): string {
  return /[\s()<>]/.test(href) ? `<${href.replace(/[<>]/g, (c) => encodeURIComponent(c))}>` : href
}

type Anchor = { href: string | null; words: string }

type Walk = { markdown: string; hrefs: string[]; pre: boolean }

/** Walk the fragment once: words collapse their whitespace as a browser shows them, blocks become
 *  breaks, anchors become Markdown links. */
function walk(html: string): Walk {
  let out = ''
  let pre = 0
  let anchor: Anchor | null = null
  const hrefs: string[] = []
  const emit = (text: string): void => {
    if (anchor) anchor.words += text
    else out += text
  }
  /** A `<br>` always breaks the line; a block only ends the current one, so `</li><li>` or
   *  `</p><p>` do not stack their breaks. */
  const lineBreak = (): void => {
    if (anchor) { anchor.words += ' '; return }
    out += '\n'
  }
  const blockBreak = (lines: 1 | 2): void => {
    if (anchor) { anchor.words += ' '; return }
    const trailing = /\n*$/.exec(out.replace(/ +$/, ''))?.[0].length ?? 0
    if (out.trim() === '') return
    out += '\n'.repeat(Math.max(0, lines - trailing))
  }
  const closeAnchor = (): void => {
    if (!anchor) return
    const { href, words } = anchor
    anchor = null
    const trimmed = words.replace(/\s+/g, ' ').trim()
    const lead = /^\s/.test(words) ? ' ' : ''
    const trail = /\s$/.test(words) ? ' ' : ''
    if (!trimmed) { out += lead || trail; return }
    if (href === null) { out += `${lead}${trimmed}${trail}`; return }
    hrefs.push(href)
    out += `${lead}[${linkText(trimmed)}](${linkDestination(href)})${trail}`
  }
  const source = html.replace(DROPPED_ELEMENTS, '')
  for (const match of source.matchAll(TOKEN)) {
    const token = match[0]
    const tag = match[1]?.toLowerCase()
    if (token.startsWith('<!') || token.startsWith('<?')) continue
    if (!tag) {
      if (token === '<') { emit('<'); continue }
      const text = decodeEntities(token)
      emit(pre > 0 ? text : text.replace(/[ \t\r\n\f]+/g, ' '))
      continue
    }
    const closing = token.startsWith('</')
    if (tag === 'a') {
      if (closing) closeAnchor()
      else {
        closeAnchor()
        const href = attribute(match[2] ?? '', 'href')
        anchor = { href: href === null ? null : pasteHref(href), words: '' }
      }
      continue
    }
    if (tag === 'br') { lineBreak(); continue }
    if (tag === 'pre') pre = Math.max(0, pre + (closing ? -1 : 1))
    if (PARAGRAPH_TAGS.has(tag)) { closeAnchor(); blockBreak(2); continue }
    if (LINE_TAGS.has(tag)) { closeAnchor(); blockBreak(1); continue }
    if (CELL_TAGS.has(tag) && !closing) emit(' ')
  }
  closeAnchor()
  return { markdown: out, hrefs, pre: /<pre\b/i.test(source) }
}

/** Tidy the walked text the way a plain paste reads: no spaces at line edges, at most one blank
 *  line between paragraphs, runs of spaces as one (unless the fragment has a `<pre>`), nothing before the first line or after the last. */
function tidy(text: string, keepSpacing: boolean): string {
  return text
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => (keepSpacing ? line : line.replace(/ {2,}/g, ' ')).replace(/^ +| +$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** True when `text/plain` already carries this destination as a Markdown link. */
function plainCarries(plain: string, href: string): boolean {
  return plain.includes(`](${href})`) || plain.includes(`](<${href}>)`)
}

/**
 * The Markdown to paste for a rich clipboard, or null to paste `text/plain` as before.
 */
export function richPasteMarkdown(html: string, plain: string): string | null {
  if (!html || !/<a\b/i.test(html)) return null
  if (isBareUrl(plain.trim())) return null
  const { markdown, hrefs, pre } = walk(html)
  if (!hrefs.length) return null
  if (hrefs.every((href) => plainCarries(plain, href))) return null
  const result = tidy(markdown, pre)
  return result === '' ? null : result
}

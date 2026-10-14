/**
 * What a widget's frame is and what goes into its document (interactive-widgets-in-documents,
 * ticket 02). Ported from TalkWeaver `compiler/scripts/lib/embed-frame.mjs` at 6ec8102f: the sandbox
 * token list with its guard, the frame's attributes, the lead put at the top of the page (policy,
 * referrer, base, agent), and the small start-tag scan that places it and reads the page's title.
 *
 * Pure: no DOM, no Electron. The renderer's widget-frame builds the frame from these; export
 * (ticket 06) will reuse them.
 */
import { WIDGET_AGENT_SOURCE } from './widget-agent-source'

/** The frame's sandbox. Its origin is opaque: `allow-same-origin` is never in this list, and nor is any
 *  token that would let the widget leave its frame (top navigation, pop-ups, downloads, modals). */
export const WIDGET_SANDBOX: readonly string[] = Object.freeze(['allow-scripts', 'allow-forms'])
const WIDGET_SANDBOX_VALUE = 'allow-scripts allow-forms'

/**
 * Throws unless `tokens` is exactly `allow-scripts allow-forms`. Checked where the list is defined (a
 * later edit that adds a token fails at import, in the app and in every test) and again on the
 * attribute the frame actually carries before it is given a document.
 */
export function assertWidgetSandbox(tokens: readonly string[] | string | null | undefined): void {
  const list = typeof tokens === 'string' ? tokens.trim().split(/\s+/) : Array.isArray(tokens) ? [...tokens] : []
  if (list.some((token) => token.toLowerCase() === 'allow-same-origin') || list.join(' ') !== WIDGET_SANDBOX_VALUE) {
    throw new Error('widget-frame: the widget sandbox must be exactly allow-scripts allow-forms')
  }
}
assertWidgetSandbox(WIDGET_SANDBOX)

/** Every powerful feature refused by name (they are off for an opaque-origin frame anyway). */
export const WIDGET_ALLOW = "camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'; fullscreen 'none'; payment 'none'; usb 'none'; serial 'none'; hid 'none'; bluetooth 'none'; clipboard-read 'none'; clipboard-write 'none'"

/** The attributes a widget frame carries, in the order they are set, all before it has a document. */
export function widgetFrameAttributes(): Array<[name: string, value: string]> {
  return [
    ['sandbox', WIDGET_SANDBOX.join(' ')],
    ['credentialless', ''],
    ['referrerpolicy', 'no-referrer'],
    ['allow', WIDGET_ALLOW],
  ]
}

/**
 * The policy the widget's document runs under. Network is refused: only what the page carries inline
 * and the `data:` and `blob:` URLs it builds load (`connect-src`, so fetch, XHR, WebSocket and
 * EventSource, falls back to `default-src`; `ws:`/`wss:` are not in it). No form is submitted anywhere.
 * Delivered as `<meta>`, so it binds the widget's document only.
 */
export const WIDGET_PAGE_POLICY = "default-src data: blob: 'unsafe-inline' 'unsafe-eval'; form-action 'none'"
export const WIDGET_POLICY_META = `<meta http-equiv="Content-Security-Policy" content="${WIDGET_PAGE_POLICY}">`
export const WIDGET_REFERRER_META = '<meta name="referrer" content="no-referrer">'
/** Makes `#anchor` links same-document navigations inside a srcdoc frame. */
export const WIDGET_BASE_TAG = '<base href="about:srcdoc">'

/** The lead of a widget's document, in order: policy, referrer, base (unless the page has its own), agent. */
export function widgetDocumentLead(page: { ownBase?: boolean } = {}): string {
  // The agent is written into a <script> element as it is; neither sequence may occur in it.
  if (/<\/script/i.test(WIDGET_AGENT_SOURCE) || WIDGET_AGENT_SOURCE.includes('<!--')) throw new Error('widget-frame: the agent source cannot be inlined')
  return `${WIDGET_POLICY_META}${WIDGET_REFERRER_META}${page.ownBase ? '' : WIDGET_BASE_TAG}<script>${WIDGET_AGENT_SOURCE}</script>`
}

// ── Reading a page's text the way the HTML parser will ──────────────────────────────────────────
// Two decisions depend on what the page's markup IS, not on what its text mentions: where the lead
// goes, and whether the page has a <base> of its own. Both use this small scan, which knows
// comments, the doctype, start tags with their attributes, and the elements whose content is not
// markup. It is not a parser: it answers these questions and nothing else.

const HTML_SPACE = '\t\n\f\r '
const NOT_MARKUP_INSIDE = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'template', 'svg', 'math'])

/** The index just past the comment that starts at `at` ("<!--"), as the tokenizer ends it. */
function commentEnd(text: string, at: number): number {
  const from = at + 4
  if (text.startsWith('>', from)) return from + 1
  if (text.startsWith('->', from)) return from + 2
  const terminator = /--!?>/g
  terminator.lastIndex = from
  return terminator.test(text) ? terminator.lastIndex : text.length
}

/** The index just past the bogus comment that starts at `at`: the first ">"; else the end. */
function bogusCommentEnd(text: string, at: number): number {
  const gt = text.indexOf('>', at)
  return gt < 0 ? text.length : gt + 1
}

type StartTag = { name: string; attributes: Map<string, string>; contentStart: number; contentEnd: number }

/** Visit each HTML start tag of a document's text, in order. A visitor that returns true stops the scan. */
function scanStartTags(html: string, visit: (tag: StartTag) => boolean): void {
  const text = String(html ?? '')
  const lower = text.toLowerCase()
  let i = 0
  while (i < text.length) {
    const lt = text.indexOf('<', i)
    if (lt < 0) return
    if (text.startsWith('<!--', lt)) { i = commentEnd(text, lt); continue }
    const next = text[lt + 1] ?? ''
    if (next === '!' || next === '?' || next === '/') { i = bogusCommentEnd(text, lt); continue }
    if (!/[a-zA-Z]/.test(next)) { i = lt + 1; continue }
    let j = lt + 1
    while (j < text.length && !HTML_SPACE.includes(text[j]) && text[j] !== '/' && text[j] !== '>') j += 1
    const name = lower.slice(lt + 1, j)
    const attributes = new Map<string, string>()
    for (;;) {
      while (j < text.length && (HTML_SPACE.includes(text[j]) || text[j] === '/')) j += 1
      if (j >= text.length) break
      if (text[j] === '>') { j += 1; break }
      const nameStart = j
      if (text[j] === '=') j += 1
      while (j < text.length && !HTML_SPACE.includes(text[j]) && text[j] !== '/' && text[j] !== '>' && text[j] !== '=') j += 1
      const attribute = lower.slice(nameStart, j)
      let value = ''
      while (j < text.length && HTML_SPACE.includes(text[j])) j += 1
      if (text[j] === '=') {
        j += 1
        while (j < text.length && HTML_SPACE.includes(text[j])) j += 1
        if (text[j] === '"' || text[j] === "'") {
          const close = text.indexOf(text[j], j + 1)
          value = text.slice(j + 1, close < 0 ? text.length : close)
          j = close < 0 ? text.length : close + 1
        } else {
          const valueStart = j
          while (j < text.length && !HTML_SPACE.includes(text[j]) && text[j] !== '>') j += 1
          value = text.slice(valueStart, j)
        }
      }
      if (attribute && !attributes.has(attribute)) attributes.set(attribute, value)
    }
    if (name === 'plaintext') { visit({ name, attributes, contentStart: j, contentEnd: text.length }); return }
    if (NOT_MARKUP_INSIDE.has(name)) {
      const close = lower.indexOf(`</${name}`, j)
      const contentEnd = close < 0 ? text.length : close
      if (visit({ name, attributes, contentStart: j, contentEnd })) return
      i = close < 0 ? text.length : close + 2
      continue
    }
    if (visit({ name, attributes, contentStart: -1, contentEnd: -1 })) return
    i = j
  }
}

/** Whether the page sets a base URL of its own: a real `<base>` element with an `href`. */
export function widgetHasOwnBase(html: string): boolean {
  let found = false
  scanStartTags(html, (tag) => {
    if (tag.name === 'base' && tag.attributes.has('href')) { found = true; return true }
    return false
  })
  return found
}

/**
 * Where the lead goes: directly after the doctype when the document starts with one (counting a
 * byte-order mark, white space and comments before it, as the parser does, so the page stays in
 * standards mode); otherwise the very start. Nothing the page's author wrote that can run, load or set
 * a policy comes before the lead.
 */
export function widgetLeadPosition(html: string): number {
  const text = String(html)
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  for (;;) {
    while (i < text.length && HTML_SPACE.includes(text[i])) i += 1
    if (text.startsWith('<!--', i)) { i = commentEnd(text, i); continue }
    const bogus = text.startsWith('<?', i) || (text.startsWith('<!', i) && text.slice(i + 2, i + 9).toLowerCase() !== 'doctype')
    if (!bogus) break
    i = bogusCommentEnd(text, i)
  }
  const doctype = /^<!doctype[^>]*>/i.exec(text.slice(i, i + 4096))
  return doctype ? i + doctype[0].length : 0
}

/**
 * The page's text with every `shadowrootmode` attribute made inert (`data-wf-inert-shadowrootmode`), so
 * the parser builds no declarative shadow tree: a closed one would hide a frame from the agent's sweep
 * (widget-agent-source). Plain text replacement, case-insensitive, wherever the word occurs: an attribute
 * name holds no character references, so no spelling of it escapes.
 */
export function withoutDeclarativeShadow(html: string): string {
  return String(html).replace(/shadowrootmode/gi, (match) => `data-wf-inert-${match}`)
}

/** The widget's document: the page's text with the lead in place. */
export function withWidgetLead(html: string): string {
  const text = withoutDeclarativeShadow(html)
  const at = widgetLeadPosition(text)
  return text.slice(0, at) + widgetDocumentLead({ ownBase: widgetHasOwnBase(text) }) + text.slice(at)
}

export const WIDGET_TITLE_MAX = 80

function fromCodePoint(value: number): string {
  if (!Number.isInteger(value) || value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return '�'
  return value < 0x20 || (value >= 0x7f && value <= 0x9f) ? ' ' : String.fromCodePoint(value)
}

function withoutTags(raw: string): string {
  let out = ''
  let i = 0
  for (;;) {
    const lt = raw.indexOf('<', i)
    const gt = lt < 0 ? -1 : raw.indexOf('>', lt + 1)
    if (gt < 0) return out + raw.slice(i)
    out += `${raw.slice(i, lt)} `
    i = gt + 1
  }
}

/** The page's own `<title>` as plain text (references decoded, white space collapsed, 80 characters at
 *  most); empty when it has none. Escaped again wherever it is shown. */
export function widgetPageTitle(html: string): string {
  const source = String(html ?? '')
  let raw: string | null = null
  scanStartTags(source, (tag) => {
    if (tag.name !== 'title') return false
    raw = source.slice(tag.contentStart, tag.contentEnd)
    return true
  })
  if (raw === null) return ''
  const named: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&', nbsp: ' ' }
  const text = withoutTags(raw)
    .replace(/&(?:#x([0-9a-f]{1,8})|#([0-9]{1,8})|(lt|gt|quot|apos|amp|nbsp));/gi, (_whole, hex: string, decimal: string, name: string) =>
      (hex ? fromCodePoint(Number.parseInt(hex, 16)) : decimal ? fromCodePoint(Number.parseInt(decimal, 10)) : named[name.toLowerCase()]))
    .replace(/[\s ]+/g, ' ')
    .trim()
  return Array.from(text).slice(0, WIDGET_TITLE_MAX).join('')
}

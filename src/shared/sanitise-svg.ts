/**
 * The app's ONE rule for untrusted SVG.
 *
 * It lives in `shared/` rather than in the editor because three surfaces now hold the same opinion
 * about the same bytes: the live preview draws a ```svg fence, its object editor validates one as
 * it is typed, and the copy/export emitters turn one into a picture. A second sanitiser is a second
 * opinion, and the weaker of two opinions is the one that gets exploited.
 */
import DOMPurify from 'dompurify'

export type SanitisedSvg = { svg: string } | { error: string }

const FORBIDDEN_TAGS = ['script', 'foreignObject', 'style', 'animate', 'animateMotion', 'animateTransform', 'set']
// The svg + svgFilters profiles are the attribute allow-list that KEEPS geometry/presentation
// (viewBox/width/height/fill/d). Adding ALLOWED_URI_REGEXP or FORBID_ATTR here silently stripped those
// core attributes, blanking every SVG — so URI/handler/external-ref restriction is done by the strict
// source preflight (unsafeSourceError) instead, and DOMPurify keeps FORBID_TAGS as tag-level defence.
const SVG_CONFIG = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: [...FORBIDDEN_TAGS],
}

/**
 * Whether a fenced code block is the app's SVG object type. `mermaid` and `markmap` are the other
 * two drawable fences and are deliberately NOT included: they need rendering engines that live in
 * the renderer, so outside it their source is the honest thing to show.
 */
export function isSvgFence(language: string): boolean {
  return language.trim().toLowerCase() === 'svg'
}

function xmlShapeError(source: string): string | null {
  const stack: string[] = []
  const tokens = source.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>/g) ?? []
  for (const token of tokens) {
    if (/^<!--|^<!\[CDATA\[/.test(token)) continue
    if (/^<\?|^<!/i.test(token)) return 'SVG declarations, doctypes, and entities are not allowed.'
    const close = /^<\s*\/\s*([A-Za-z_][\w:.-]*)\s*>$/.exec(token)
    if (close) {
      if (stack.pop()?.toLowerCase() !== close[1].toLowerCase()) return 'The SVG markup is not well formed.'
      continue
    }
    const open = /^<\s*([A-Za-z_][\w:.-]*)\b[\s\S]*?>$/.exec(token)
    if (!open) return 'The SVG markup is not well formed.'
    if (!/\/\s*>$/.test(token)) stack.push(open[1])
  }
  return stack.length ? 'The SVG markup is not well formed.' : null
}

function unsafeSourceError(source: string): string | null {
  const trimmed = source.trim()
  if (!/^<svg(?:\s|>)/i.test(trimmed) || !/(?:<\/svg\s*>|<svg\b[^>]*\/\s*>)$/i.test(trimmed)) {
    return 'Expected one complete SVG document with an <svg> root.'
  }
  if (/<!DOCTYPE|<!ENTITY|<\?xml/i.test(trimmed)) return 'SVG declarations, doctypes, and entities are not allowed.'
  if (/<\s*(?:[A-Za-z_][\w.-]*:)?(?:script|foreignObject)\b/i.test(trimmed)) return 'Scripts and foreignObject content are not allowed in SVG.'
  if (/<\s*(?:style|animate|animateMotion|animateTransform|set)\b/i.test(trimmed) || /\sstyle\s*=/i.test(trimmed)) return 'Embedded CSS and animated attribute mutation are not allowed in SVG.'
  if (/\s(?:[A-Za-z_][\w.-]*:)?on[a-z][\w.-]*\s*=/i.test(trimmed)) return 'SVG event-handler attributes are not allowed.'
  for (const match of trimmed.matchAll(/\s(?:xlink:)?(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (!/^#[A-Za-z_][\w:.-]*$/.test(value)) return 'SVG references must be local #fragment references; external links and image fetches are not allowed.'
  }
  for (const match of trimmed.matchAll(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi)) {
    if (!/^#[A-Za-z_][\w:.-]*$/.test(match[2])) return 'SVG CSS references must be local #fragment references.'
  }
  if (/<style\b[^>]*>[\s\S]*?@import/i.test(trimmed)) return 'External CSS imports are not allowed in SVG.'
  return null
}

function parseError(source: string): string | null {
  if (typeof DOMParser === 'undefined') return null
  const document = new DOMParser().parseFromString(source, 'image/svg+xml')
  if (document.querySelector('parsererror') || document.documentElement.localName.toLowerCase() !== 'svg') return 'The SVG markup is not well formed.'
  return null
}

/** Sanitise untrusted SVG before it reaches innerHTML. Any removal is a visible failure, never a hole. */
export function sanitiseSvg(source: string): SanitisedSvg {
  const trimmed = source.trim()
  const unsafe = unsafeSourceError(source) ?? (typeof DOMParser === 'undefined' ? xmlShapeError(trimmed) : parseError(source))
  if (unsafe) return { error: unsafe }
  // DOM-less unit env (DOMPurify factory / no DOMParser): the strict preflight above is the gate.
  if (typeof DOMPurify.sanitize !== 'function' || typeof DOMParser === 'undefined') return { svg: trimmed }
  // Sanitise the SVG as an SVG-namespaced DOM NODE, not an HTML string. Parsing the string as HTML
  // (DOMPurify's default) wrapped it in <body> — recorded as a removed element on every call — and
  // stripped SVG-only attributes (viewBox/width/height/fill/d), which blanked every valid SVG. Parsing
  // it as image/svg+xml and cleaning that node keeps the geometry and adds no wrapper.
  const svg = String(DOMPurify.sanitize(trimmed, SVG_CONFIG)).trim()
  // Fail closed if DOMPurify had to drop a real ELEMENT the preflight didn't catch (e.g. a non-SVG
  // <iframe>/<object>). The BODY/HTML/HEAD wrapper is an artifact of parsing the SVG string as HTML,
  // not a real removal. Attribute-level scrubs are the preflight's job (above), so a benign xmlns
  // normalisation never trips this — but a stripped element means the source wasn't clean SVG.
  const droppedElement = DOMPurify.removed.some((entry) => {
    const element = (entry as { element?: { nodeName?: string; localName?: string } }).element
    if (!element) return false
    const name = String(element.nodeName ?? element.localName ?? '').toUpperCase()
    return name !== 'BODY' && name !== 'HTML' && name !== 'HEAD'
  })
  if (!svg || !/^<svg[\s>]/i.test(svg) || droppedElement) return { error: 'Unsafe SVG content was removed. Edit the source before it can be previewed.' }
  // Final belt-and-braces: re-run the strict preflight + parse on DOMPurify's OUTPUT, so nothing the
  // preflight would reject can survive even if DOMPurify's profile ever let it through.
  const after = unsafeSourceError(svg) ?? parseError(svg)
  return after ? { error: after } : { svg }
}

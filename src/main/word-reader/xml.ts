/**
 * Reads XML bytes into a small element tree, refusing anything that could pull in or multiply text.
 *
 * Word never writes a document type declaration, so any `<!DOCTYPE`, `<!ENTITY` or the like is a
 * refusal before the parser sees it (the external-entity and entity-expansion routes). The parser
 * (`sax`, strict) expands only the five built-in entities and numeric references; it has no way to
 * fetch a file or a URL. Namespaces are resolved here, not by the parser: its namespace mode scans
 * every earlier attribute for each new one, which is quadratic on a hostile tag. The tree keeps element names, attributes and the text of
 * `w:t`-style leaves only, and is bounded in nodes and depth.
 */
/// <reference path="./sax.d.ts" />
import sax from 'sax'
import { WordRefusalError } from './refusal'
import type { WordReaderLimits } from './types'

export type XmlElement = {
  /** Local name without prefix. */
  name: string
  /** Namespace URI the element resolves to ('' when none). */
  uri: string
  /** Attributes by local name. Word-namespace and unprefixed attributes use the bare local name;
   *  relationship-namespace attributes (`r:id`) use `r:<local>`; any other namespace is dropped. */
  attrs: Record<string, string>
  children: XmlElement[]
  /** Text directly inside a text-bearing leaf (`t`, `delText`, `instrText`, and the like); '' elsewhere. */
  text: string
}

const TEXT_LEAVES = new Set(['t', 'delText', 'instrText', 'delInstrText'])
const DECLARATION = /<!\s*(DOCTYPE|ENTITY|ELEMENT|ATTLIST|NOTATION)/i
const REL_NAMESPACES = new Set(['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'])
const WORD_NS = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main'])
/** More attributes than any Word element carries; a tag with more is a bomb, not a document. */
const MAX_ATTRIBUTES_PER_TAG = 1024

/**
 * Refuse a tag with more attributes than any Word element carries BEFORE the parser sees it: the
 * parser builds every attribute of a tag before it reports the tag, so a count made afterwards has
 * already cost the memory. One linear pass; quotes, comments, CDATA and processing instructions are
 * skipped the way XML skips them, so none of them can hide a tag.
 */
function checkAttributeCounts(text: string): void {
  // Where each kind of markup that is not a tag ends, and how long its closing mark is.
  const skip: Array<[string, string]> = [['<!--', '-->'], ['<![CDATA[', ']]>'], ['<?', '?>']]
  let i = text.indexOf('<')
  while (i >= 0) {
    const kind = skip.find(([open]) => text.startsWith(open, i))
    let next: number
    if (kind) {
      const end = text.indexOf(kind[1], i + kind[0].length)
      // Unterminated: the parser will refuse it, and there is no further tag to count.
      if (end < 0) return
      next = end + kind[1].length
    } else {
      let quote = ''
      let equals = 0
      let j = i + 1
      for (; j < text.length; j++) {
        const c = text[j]
        if (quote) {
          if (c === quote) quote = ''
        } else if (c === '"' || c === "'") quote = c
        else if (c === '=') {
          if (++equals > MAX_ATTRIBUTES_PER_TAG) throw new WordRefusalError('zip-bomb')
        } else if (c === '>') break
      }
      next = j + 1
    }
    i = text.indexOf('<', next)
  }
}

/** Decode UTF-8 or UTF-16 (with a byte-order mark) strictly; any other bytes are refused. */
function decode(bytes: Uint8Array): string {
  try {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2))
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2))
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes).replace(/^\uFEFF/, '')
  } catch {
    throw new WordRefusalError('damaged')
  }
}

/** Namespace declarations in force: own declarations, a link to the enclosing scope, and a cache. */
type Scope = { own: Map<string, string> | null; parent: Scope | null; cache: Map<string, string | undefined> }

function lookup(scope: Scope, prefix: string): string | undefined {
  if (prefix === 'xml') return 'http://www.w3.org/XML/1998/namespace'
  const hit = scope.cache.get(prefix)
  if (hit !== undefined || scope.cache.has(prefix)) return hit
  let found: string | undefined
  for (let s: Scope | null = scope; s; s = s.parent) {
    const v = s.own?.get(prefix)
    if (v !== undefined) {
      found = v
      break
    }
  }
  scope.cache.set(prefix, found)
  return found
}

export function parseXml(bytes: Uint8Array, limits: WordReaderLimits): XmlElement {
  // XML ends lines with LF only: CRLF and a lone CR become LF before anything reads them.
  const text = decode(bytes).replace(/\r\n?/g, '\n')
  if (DECLARATION.test(text)) throw new WordRefusalError('xml-not-allowed')
  checkAttributeCounts(text)

  const parser = sax.parser(true, { xmlns: false, trim: false, normalize: false, lowercase: false, position: false })
  let root: XmlElement | null = null
  const stack: XmlElement[] = []
  const scopes: Scope[] = [{ own: null, parent: null, cache: new Map() }]
  let nodes = 0
  let failure: Error | null = null

  parser.onerror = (e: Error) => {
    failure = e
    // Stop at the first error; sax would otherwise carry on and hand back a partial tree.
    parser.error = null
  }
  parser.onopentag = (tag) => {
    if (failure) return
    if (++nodes > limits.maxXmlNodes || stack.length >= limits.maxXmlDepth) {
      failure = new WordRefusalError('zip-bomb')
      return
    }
    const names = Object.keys(tag.attributes)
    if (names.length > MAX_ATTRIBUTES_PER_TAG) {
      failure = new WordRefusalError('zip-bomb')
      return
    }
    let scope = scopes[scopes.length - 1]
    let declared: Map<string, string> | null = null
    for (const n of names) {
      if (n === 'xmlns') (declared ??= new Map()).set('', tag.attributes[n])
      else if (n.startsWith('xmlns:')) (declared ??= new Map()).set(n.slice(6), tag.attributes[n])
    }
    if (declared) scope = { own: declared, parent: scope, cache: new Map() }
    scopes.push(scope)

    const colon = tag.name.indexOf(':')
    const prefix = colon < 0 ? '' : tag.name.slice(0, colon)
    const uri = lookup(scope, prefix)
    if (uri === undefined && prefix !== '') {
      failure = new WordRefusalError('damaged')
      return
    }
    const attrs: Record<string, string> = {}
    for (const n of names) {
      if (n === 'xmlns' || n.startsWith('xmlns:')) continue
      const c = n.indexOf(':')
      if (c < 0) attrs[n] = tag.attributes[n]
      else {
        const ns = lookup(scope, n.slice(0, c))
        if (ns === undefined) {
          failure = new WordRefusalError('damaged')
          return
        }
        if (WORD_NS.has(ns)) attrs[n.slice(c + 1)] = tag.attributes[n]
        else if (REL_NAMESPACES.has(ns)) attrs[`r:${n.slice(c + 1)}`] = tag.attributes[n]
      }
    }
    const el: XmlElement = { name: colon < 0 ? tag.name : tag.name.slice(colon + 1), uri: uri ?? '', attrs, children: [], text: '' }
    const parent = stack[stack.length - 1]
    if (parent) parent.children.push(el)
    else if (!root) root = el
    stack.push(el)
  }
  parser.onclosetag = () => {
    stack.pop()
    scopes.pop()
  }
  const addText = (t: string): void => {
    const cur = stack[stack.length - 1]
    // A character reference (&#13;) can still produce a CR after the line-ending rule above; it is a line end too.
    if (cur && TEXT_LEAVES.has(cur.name)) cur.text += t.includes('\r') ? t.replace(/\r/g, '\n') : t
  }
  parser.ontext = addText
  parser.oncdata = addText

  // Feed in slices so an error or limit stops the work early instead of after the whole part.
  const SLICE = 1 << 16
  for (let i = 0; i < text.length && !failure; i += SLICE) {
    try {
      parser.write(text.slice(i, i + SLICE))
    } catch (e) {
      failure = e as Error
    }
  }
  if (!failure) {
    try {
      parser.close()
    } catch (e) {
      failure = e as Error
    }
  }
  if (failure) throw failure instanceof WordRefusalError ? failure : new WordRefusalError('damaged')
  if (!root || stack.length !== 0) throw new WordRefusalError('damaged')
  return root
}

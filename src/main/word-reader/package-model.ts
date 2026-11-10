/**
 * What the reader needs from outside `word/document.xml`: the package's content types and
 * relationships, the style names (for headings) and the list formats (for bullets against numbers).
 * Everything here is read from bytes already in memory; a relationship target is a string and is
 * never opened, fetched or followed.
 */
import { WordRefusalError } from './refusal'
import { isUnsafePartName } from './zip'
import type { XmlElement } from './xml'

export const W_NAMESPACES = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main'])
const PACKAGE_RELS_NS = new Set(['http://schemas.openxmlformats.org/package/2006/relationships'])
const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'

export const MAIN_DOCUMENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'

export const isW = (el: XmlElement, name: string): boolean => el.name === name && W_NAMESPACES.has(el.uri)
export const wChildren = (el: XmlElement, name: string): XmlElement[] => el.children.filter((c) => isW(c, name))
export const wChild = (el: XmlElement, name: string): XmlElement | undefined => el.children.find((c) => isW(c, name))
export const wVal = (el: XmlElement | undefined): string | undefined => el?.attrs.val

export type ContentTypes = { defaults: Map<string, string>; overrides: Map<string, string> }

export function readContentTypes(root: XmlElement): ContentTypes {
  if (root.name !== 'Types' || root.uri !== CONTENT_TYPES_NS) throw new WordRefusalError('not-a-word-file')
  const defaults = new Map<string, string>()
  const overrides = new Map<string, string>()
  for (const c of root.children) {
    if (c.name === 'Default' && c.attrs.Extension && c.attrs.ContentType) defaults.set(c.attrs.Extension.toLowerCase(), c.attrs.ContentType)
    else if (c.name === 'Override' && c.attrs.PartName && c.attrs.ContentType) overrides.set(c.attrs.PartName.toLowerCase(), c.attrs.ContentType)
  }
  return { defaults, overrides }
}

export function contentTypeOf(types: ContentTypes, partName: string): string | undefined {
  const override = types.overrides.get(('/' + partName).toLowerCase())
  if (override) return override
  const dot = partName.lastIndexOf('.')
  return dot >= 0 ? types.defaults.get(partName.slice(dot + 1).toLowerCase()) : undefined
}

export type Relationship = { id: string; type: string; target: string; external: boolean }

export function readRelationships(root: XmlElement): Relationship[] {
  if (root.name !== 'Relationships' || !PACKAGE_RELS_NS.has(root.uri)) throw new WordRefusalError('damaged')
  const out: Relationship[] = []
  for (const c of root.children) {
    if (c.name === 'Relationship' && c.attrs.Id && c.attrs.Type && c.attrs.Target !== undefined) {
      out.push({ id: c.attrs.Id, type: c.attrs.Type, target: c.attrs.Target, external: c.attrs.TargetMode === 'External' })
    }
  }
  return out
}

/** Resolve an internal relationship target to a part name, or refuse when it climbs out of the package. */
export function resolveTarget(baseDir: string, target: string): string {
  try {
    target = decodeURIComponent(target)
  } catch {
    throw new WordRefusalError('damaged')
  }
  const parts = target.startsWith('/') ? [] : baseDir.split('/').filter(Boolean)
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length === 0) throw new WordRefusalError('unsafe-part-name')
      parts.pop()
    } else parts.push(seg)
  }
  const name = parts.join('/')
  if (isUnsafePartName(name)) throw new WordRefusalError('unsafe-part-name')
  return name
}

export const dirOf = (partName: string): string => partName.slice(0, Math.max(0, partName.lastIndexOf('/')))
export const relsNameFor = (partName: string): string => {
  const i = partName.lastIndexOf('/')
  return `${partName.slice(0, i + 1)}_rels/${partName.slice(i + 1)}.rels`
}

/** A link target worth keeping as a Markdown link. Anything else (file:, javascript:, data:, a UNC path) is dropped to text. */
export const MAX_LINK_TARGET_CHARS = 2048

export function safeLinkTarget(target: string | undefined): string | null {
  // A target longer than any real address is not copied into the text: it would be repeated wherever it is linked.
  if (!target || target.length > MAX_LINK_TARGET_CHARS) return null
  return /^(https?:\/\/|mailto:)[^\s<>()]*$/i.test(target) ? target : null
}

export type StyleInfo = { name?: string; basedOn?: string; outline?: number }

export function readStyles(root: XmlElement | null): Map<string, StyleInfo> {
  const styles = new Map<string, StyleInfo>()
  if (!root || !isW(root, 'styles')) return styles
  for (const s of wChildren(root, 'style')) {
    const id = s.attrs.styleId
    if (!id) continue
    const pPr = wChild(s, 'pPr')
    const outline = pPr ? wVal(wChild(pPr, 'outlineLvl')) : undefined
    styles.set(id, { name: wVal(wChild(s, 'name')), basedOn: wVal(wChild(s, 'basedOn')), outline: outline !== undefined && /^\d$/.test(outline) ? Number(outline) : undefined })
  }
  return styles
}

/** Heading level 1–9 for a paragraph style, or undefined. Follows `basedOn` a bounded way. */
export function headingLevelOfStyle(styles: Map<string, StyleInfo>, styleId: string | undefined): number | undefined {
  let id = styleId
  for (let step = 0; id && step < 20; step++) {
    const info = styles.get(id)
    if (info?.outline !== undefined) return info.outline <= 8 ? info.outline + 1 : undefined
    const named = /^heading\s*([1-9])$/i.exec(info?.name ?? '') ?? (info ? null : /^heading([1-9])$/i.exec(id))
    if (named) return Number(named[1])
    id = info?.basedOn
  }
  return undefined
}

export type Numbering = { ordered(numId: string, level: number): boolean }

export function readNumbering(root: XmlElement | null): Numbering {
  const abstract = new Map<string, Map<number, string>>()
  const nums = new Map<string, string>()
  if (root && isW(root, 'numbering')) {
    for (const a of wChildren(root, 'abstractNum')) {
      const levels = new Map<number, string>()
      for (const l of wChildren(a, 'lvl')) {
        const fmt = wVal(wChild(l, 'numFmt'))
        if (fmt !== undefined && /^\d$/.test(l.attrs.ilvl ?? '')) levels.set(Number(l.attrs.ilvl), fmt)
      }
      if (a.attrs.abstractNumId) abstract.set(a.attrs.abstractNumId, levels)
    }
    for (const n of wChildren(root, 'num')) {
      const abs = wVal(wChild(n, 'abstractNumId'))
      if (n.attrs.numId && abs) nums.set(n.attrs.numId, abs)
    }
  }
  return {
    ordered(numId, level) {
      const fmt = abstract.get(nums.get(numId) ?? '')?.get(level)
      return fmt !== undefined && fmt !== 'bullet' && fmt !== 'none'
    }
  }
}

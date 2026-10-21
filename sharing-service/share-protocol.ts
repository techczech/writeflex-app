// What the app sends to publish a share, checked. Pure; no storage, no Workers runtime.
//
// A publish is two kinds of request (a very large piece publishes in parts, and nothing partial is
// ever shown to readers):
//   PUT /shares/<id>/images/<name>   one image, raw bytes. <name> is `<sha256 of the bytes>.<ext>`;
//                                    the service checks the digest, so an image is never stored
//                                    under another's name, and an unchanged image is not sent again.
//   PUT /shares/<id>/page            the text (`PublishBody` below, JSON). It names the images it
//                                    uses; all of them must have arrived, or nothing changes and
//                                    the answer lists the ones missing. Images the new text does
//                                    not name are deleted in the same step.
//
// The text arrives as HTML the app rendered with its export renderer (one part for a piece, the
// parts in running order for a Folio). It is the author's own text, signed by the owner token; the
// page that carries it forbids every script (reader-page.ts, content security policy). Every other
// field (title, chips, part titles, heading names, "Shared by") is plain text and is escaped.

export const SHARE_LIMITS = {
  /** The JSON of one publish, in bytes. */
  publishBodyBytes: 16 * 1024 * 1024,
  /** One image, in bytes. */
  imageBytes: 10 * 1024 * 1024,
  /** The images of one published copy, in bytes; and, counted apart, of the images waiting to be published. */
  shareImageBytes: 64 * 1024 * 1024,
  /** Images in one published copy; and, counted apart, images waiting to be published. */
  shareImages: 500,
  titleChars: 300,
  sharedByChars: 100,
  chips: 8,
  chipLabelChars: 40,
  chipValueChars: 200,
  folioParts: 200,
  headingsPerPart: 200,
  headingChars: 300,
} as const

export const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
}

const IMAGE_NAME = /^([0-9a-f]{64})\.(png|jpg|jpeg|gif|webp|avif|svg)$/
const HEADING_ID = /^[A-Za-z][A-Za-z0-9_:.-]{0,127}$/
const LANG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/
/** Control and invisible formatting characters that have no place in a one-line label. */
const NOT_ONE_LINE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/

/** `<sha256>.<ext>` → its digest and content type; null when the name is not an image name. */
export function parseImageName(name: string): { sha256: string; contentType: string } | null {
  const match = IMAGE_NAME.exec(name)
  return match ? { sha256: match[1], contentType: IMAGE_TYPES[match[2]] } : null
}

export interface PublishedHeading {
  id: string
  text: string
}

export interface PublishedPart {
  title: string
  /** The part's rendered HTML; absent when the part's file is missing on disk. */
  html: string | null
  headings: PublishedHeading[]
}

export interface PublishBody {
  /** The previous published revision + 1. */
  revision: number
  /** When the author saved this text (ms since 1970): the page's "Updated" date and time. */
  savedAt: number
  /** The author's time zone (IANA name) to write "Updated" in; UTC when absent. */
  timeZone: string | null
  /** The language of the text, for `<html lang>`. */
  lang: string
  sharedBy: string | null
  /**
   * Whether readers may leave notes and propose edits. Off when absent: a page takes notes only when the author asked for it.
   */
  comments: boolean
  kind: 'piece' | 'folio'
  title: string
  chips: { label: string; value: string }[]
  parts: PublishedPart[]
  /** Every image name the text uses. */
  images: string[]
}

export class ShareProtocolError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ShareProtocolError'
    this.code = code
  }
}

function fail(code: string, message: string): never {
  throw new ShareProtocolError(code, message)
}

function oneLine(value: unknown, max: number, what: string, { optional = false, allowEmpty = false } = {}): string | null {
  if (value === undefined || value === null) {
    if (optional) return null
    fail('invalid_publish', `${what} is missing.`)
  }
  if (typeof value !== 'string') fail('invalid_publish', `${what} must be text.`)
  const text = value.trim()
  if (!allowEmpty && text.length === 0) {
    if (optional) return null
    fail('invalid_publish', `${what} is empty.`)
  }
  if (text.length > max) fail('invalid_publish', `${what} is longer than ${max} characters.`)
  if (NOT_ONE_LINE.test(text)) fail('invalid_publish', `${what} must be one line of plain text.`)
  return text
}

export function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value })
    return true
  } catch {
    return false
  }
}

/** The publish body, checked. Throws ShareProtocolError with a code the app can act on. */
export function parsePublishBody(value: unknown): PublishBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_publish', 'The publish body must be a JSON object.')
  const v = value as Record<string, unknown>
  if (!Number.isSafeInteger(v.revision) || (v.revision as number) < 1) fail('invalid_publish', 'revision must be a whole number from 1.')
  if (!Number.isSafeInteger(v.savedAt) || (v.savedAt as number) <= 0) fail('invalid_publish', 'savedAt must be a time in milliseconds.')
  let timeZone: string | null = null
  if (v.timeZone !== undefined && v.timeZone !== null) {
    if (typeof v.timeZone !== 'string' || v.timeZone.length > 64 || !validTimeZone(v.timeZone)) fail('invalid_publish', 'timeZone must be a time zone name.')
    timeZone = v.timeZone
  }
  let lang = 'en'
  if (v.lang !== undefined && v.lang !== null) {
    if (typeof v.lang !== 'string' || !LANG.test(v.lang)) fail('invalid_publish', 'lang must be a language tag.')
    lang = v.lang
  }
  if (v.kind !== 'piece' && v.kind !== 'folio') fail('invalid_publish', 'kind must be "piece" or "folio".')
  const kind = v.kind
  const title = oneLine(v.title, SHARE_LIMITS.titleChars, 'title') as string
  const sharedBy = oneLine(v.sharedBy, SHARE_LIMITS.sharedByChars, 'sharedBy', { optional: true })
  if (v.comments !== undefined && v.comments !== null && typeof v.comments !== 'boolean') fail('invalid_publish', 'comments must be true or false.')
  const comments = v.comments === true

  const chipsIn = v.chips ?? []
  if (!Array.isArray(chipsIn) || chipsIn.length > SHARE_LIMITS.chips) fail('invalid_publish', `chips must be a list of at most ${SHARE_LIMITS.chips}.`)
  const chips = chipsIn.map((chip, index) => {
    if (!chip || typeof chip !== 'object') fail('invalid_publish', `chip ${index + 1} must be an object.`)
    const c = chip as Record<string, unknown>
    return {
      label: oneLine(c.label, SHARE_LIMITS.chipLabelChars, `chip ${index + 1} label`) as string,
      value: oneLine(c.value, SHARE_LIMITS.chipValueChars, `chip ${index + 1} value`) as string,
    }
  })

  const partsIn = v.parts
  if (!Array.isArray(partsIn) || partsIn.length === 0) fail('invalid_publish', 'parts must be a list with at least one part.')
  if (kind === 'piece' && partsIn.length !== 1) fail('invalid_publish', 'A piece is published as exactly one part.')
  if (partsIn.length > SHARE_LIMITS.folioParts) fail('invalid_publish', `A Folio is published with at most ${SHARE_LIMITS.folioParts} parts.`)
  const headingIds = new Set<string>()
  const parts = partsIn.map((part, index): PublishedPart => {
    const where = `part ${index + 1}`
    if (!part || typeof part !== 'object' || Array.isArray(part)) fail('invalid_publish', `${where} must be an object.`)
    const p = part as Record<string, unknown>
    const partTitle = kind === 'piece'
      ? (oneLine(p.title, SHARE_LIMITS.titleChars, `${where} title`, { optional: true }) ?? title)
      : oneLine(p.title, SHARE_LIMITS.titleChars, `${where} title`) as string
    let html: string | null
    if (p.missing === true) {
      if (kind === 'piece') fail('invalid_publish', 'A piece cannot be published without its text.')
      html = null
    } else {
      if (typeof p.html !== 'string') fail('invalid_publish', `${where} html must be text.`)
      html = p.html
    }
    const headingsIn = p.headings ?? []
    if (!Array.isArray(headingsIn) || headingsIn.length > SHARE_LIMITS.headingsPerPart) fail('invalid_publish', `${where} headings must be a list of at most ${SHARE_LIMITS.headingsPerPart}.`)
    const headings = headingsIn.map((heading, at) => {
      if (!heading || typeof heading !== 'object') fail('invalid_publish', `${where} heading ${at + 1} must be an object.`)
      const h = heading as Record<string, unknown>
      if (typeof h.id !== 'string' || !HEADING_ID.test(h.id)) fail('invalid_publish', `${where} heading ${at + 1} id is not a usable anchor.`)
      if (headingIds.has(h.id) || /^part-\d+$/.test(h.id)) fail('invalid_publish', `${where} heading ${at + 1} id is used twice.`)
      headingIds.add(h.id)
      return { id: h.id, text: oneLine(h.text, SHARE_LIMITS.headingChars, `${where} heading ${at + 1} text`) as string }
    })
    return { title: partTitle, html, headings }
  })

  const imagesIn = v.images ?? []
  if (!Array.isArray(imagesIn) || imagesIn.length > SHARE_LIMITS.shareImages) fail('invalid_publish', `images must be a list of at most ${SHARE_LIMITS.shareImages}.`)
  const images = [...new Set(imagesIn.map((name, index) => {
    if (typeof name !== 'string' || !parseImageName(name)) fail('invalid_publish', `image ${index + 1} is not an image name (<sha256>.<extension>).`)
    return name
  }))]

  return { revision: v.revision as number, savedAt: v.savedAt as number, timeZone, lang, sharedBy, comments, kind, title, chips, parts, images }
}

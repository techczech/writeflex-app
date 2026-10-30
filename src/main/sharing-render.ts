// The piece as it is published to a link (sharing ticket 03; spec section 8, "What is published").
//
// The text is the HTML export's rendering (to-html.ts, the fragment the export wraps), over the
// export's own reading of the file: frontmatter and comments hidden in the Markdown are gone before
// anything is read (withoutHiddenComments; the title too), links a reader cannot follow become their
// words (`external-only`, and any destination that is not http(s), mailto or tel), wikilinks stay their
// words, and a widget line becomes WIDGET_NOT_SHARED (its line names a local file).
// So the copy carries the piece's own words and pictures and nothing else: no file path, no
// collection name, no Agent notes and no pending changes (both live outside the file), no version
// history. The leak harness checks that on the payload (tests/main/sharing-published-leak.test.ts).
//
// Pictures. The page's content security policy loads images only from the service itself, so every
// picture is uploaded: local ones from the Workspace (the export's loader and its containment check),
// `data:` ones from their own bytes, and ones on other sites fetched from this Mac (a port:
// sharing-remote-pictures.ts, which refuses any address that points at this Mac or its network; a
// refused picture is its alt text and is counted in `refusedPictures`, so the writer is told). Each
// is named `<sha256>.<ext>` and referenced as `<imagePath><name>`. A picture that cannot be had (missing, unreadable, a type a browser cannot draw) is left as its alt text, as
// the export does. `htmlWith(available)` renders the same text with only the named pictures shown:
// the first step of a publish that has to make room (sharing-publisher.ts, the image cap).
//
// No Electron import.
import { createHash } from 'node:crypto'
import { documentTitle, parseFrontmatter } from './frontmatter'
import { isRemote, loadPictures, type LoadedPictures } from './pictures'
import { Workspace } from './workspace'
import { RemotePictureRefused, type RemotePictureFetch } from './sharing-remote-pictures'
import { htmlOutline, toHtml } from '../shared/markdown/to-html'
import { readDocument } from '../shared/markdown/model'
import { parseMarkdown, stripComments, withoutByteOrderMark } from '../shared/markdown/dialect'
import { findFlags } from '../shared/markdown/flags'
import { frontmatterBlock } from '../shared/markdown/frontmatter'
import { partTitle, withoutOwnHeading } from '../shared/folio-part-title'
import { SHARE_LIMITS } from '../../sharing-service/share-protocol.ts'

export type SharedPicture = { name: string; bytes: Uint8Array }

export type RenderedPiece = {
  title: string
  chips: { label: string; value: string }[]
  headings: { id: string; text: string }[]
  /** When the file was last saved (its modification time, ms). */
  savedAt: number
  /** Every picture the text shows, by name, each once. */
  pictures: SharedPicture[]
  /** The text with every picture it can show. */
  html: string
  /** The same text showing only the pictures named in `available`; the others are their alt text. */
  htmlWith(available: ReadonlySet<string>): string
  /** Pictures from other sites left as their alt text because their address points at this Mac or its network. */
  refusedPictures: number
}

export type { RemotePictureFetch } from './sharing-remote-pictures'

const TYPE_FOR_MIME: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg',
}
/** What a widget line publishes as (no path; neither the spec nor the locked frames draw one). */
export const WIDGET_NOT_SHARED = 'Interactive part not shared'
/** Destinations a reader can follow from the copy. */
const PUBLIC_LINK = /^(?:https?:\/\/|mailto:|tel:)/i
const CHIP_FIELDS: ReadonlyArray<[string, string]> = [['date', 'Date'], ['status', 'Status'], ['author', 'Author']]
const NOT_ONE_LINE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** `data:<mime>;base64,<bytes>` → its bytes and type, or null for anything else. */
export function decodeDataUri(uri: string): { bytes: Uint8Array; type: string } | null {
  const match = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]*)$/i.exec(uri)
  if (!match) return null
  const type = TYPE_FOR_MIME[match[1].toLowerCase()]
  if (!type) return null
  const bytes = new Uint8Array(Buffer.from(match[2], 'base64'))
  return bytes.length > 0 ? { bytes, type } : null
}

/** What a picture fetched from another site is, from its first bytes (never from what the site says). */
export function sniffPictureType(bytes: Uint8Array): string | null {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value)
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'png'
  if (starts(0xff, 0xd8, 0xff)) return 'jpg'
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'gif'
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp'
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70 && String.fromCharCode(...bytes.slice(8, 12)).startsWith('avi')) return 'avif'
  const head = Buffer.from(bytes.slice(0, 512)).toString('utf8').replace(/^﻿/, '').trimStart()
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'svg'
  return null
}

export function oneLine(value: string, max: number): string {
  return value.replace(NOT_ONE_LINE, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

export function chipsOf(source: string): { label: string; value: string }[] {
  const parsed = parseFrontmatter(source)
  if (!parsed) return []
  const chips: { label: string; value: string }[] = []
  for (const [field, label] of CHIP_FIELDS) {
    const fields = parsed as unknown as Record<string, unknown>
    const raw = field === 'status' && typeof parsed.extra.status_label === 'string' && parsed.extra.status_label.trim()
      ? parsed.extra.status_label : fields[field]
    const text = typeof raw === 'string' || typeof raw === 'number' ? String(raw)
      : Array.isArray(raw) ? raw.filter((item) => typeof item === 'string').join(', ') : ''
    const value = oneLine(text, SHARE_LIMITS.chipValueChars)
    if (value) chips.push({ label, value })
  }
  return chips
}

/**
 * The file with everything hidden in its Markdown taken out before anything is read from it: HTML
 * comments (inline and block, as the parser finds them, so code keeps its own) and `//` post-it lines.
 * The frontmatter stays (the chips and a frontmatter title come from it). The title, the body and the
 * headings are all read from this, so a hidden comment can reach no published field.
 *
 * It starts, as every emitter does (dialect.ts exportSource), by dropping a leading byte-order mark:
 * with no frontmatter to carry it off, a mark at offset 0 kept a comment there from being found
 * (review round 2, finding 1).
 */
export function withoutHiddenComments(source: string): string {
  const content = withoutByteOrderMark(source)
  const block = frontmatterBlock(content)
  const head = block ? content.slice(0, block.end) : ''
  const body = stripComments((block ? content.slice(block.end) : content).replace(/\r\n?/g, '\n'))
  // Only a tag that really closes a flag in this text stays; an orphan flag tag is cut like any comment
  // (kept, it could become a flag once an ordinary comment between it and a highlight is cut).
  const flagTags = new Set(findFlags(body).map((flag) => flag.wordsTo + 2))
  const cuts: Array<[number, number]> = []
  parseMarkdown(body).iterate({
    enter: (node) => {
      if (node.name !== 'Comment' && node.name !== 'CommentBlock') return undefined
      // A flag's tag stays: the reading model drops it and publishes the flagged words as plain text.
      // Cut here, the flagged words would be left in a bare `==` and publish as a <mark>.
      if (node.name === 'Comment' && flagTags.has(node.from)) return false
      cuts.push([node.from, node.to])
      return false
    },
  })
  let out = head
  let at = 0
  for (const [from, to] of cuts) { out += body.slice(at, from); at = to }
  return out + body.slice(at)
}

/**
 * How a Folio part is rendered (sharing ticket 09), as the export's Folio rendering does it
 * (export.ts exportBundle): every id the text carries (headings, footnotes, block ids) starts with the
 * part's own prefix, so parts on one page cannot collide and a note's block hint names its part, and
 * the part's headings sit one level under the part title the reader page prints.
 */
export type PartRendering = { idPrefix: string; headingOffset: number }

/**
 * Render the piece at `path` (relative to `root`) for publishing at `imagePath` (`/s/<id>/images/`).
 * `part`: render it as a Folio part (sharing-folio.ts). Throws when the file cannot be read.
 */
export async function renderPieceForSharing(
  root: string,
  path: string,
  imagePath: string,
  ports: { fetchRemote?: RemotePictureFetch } = {},
  part: PartRendering | null = null,
): Promise<RenderedPiece> {
  const workspace = new Workspace(root)
  const { content: raw, file } = await workspace.readFile(path)
  const content = withoutHiddenComments(raw)
  const body = withoutOwnHeading(content, path)
  const document = readDocument(body)
  const pictures: LoadedPictures = await loadPictures(workspace, document, path)

  // Every picture source → its name and bytes, or null when it cannot be published.
  const bySource = new Map<string, SharedPicture | null>()
  const shared = new Map<string, SharedPicture>()
  const keep = (bytes: Uint8Array, type: string): SharedPicture => {
    const name = `${sha256(bytes)}.${type}`
    const found = shared.get(name)
    if (found) return found
    const picture = { name, bytes }
    shared.set(name, picture)
    return picture
  }
  const sources: string[] = []
  let refusedPictures = 0
  toHtml(body, { images: { resolve: (src) => { sources.push(src); return null } }, links: 'external-only' })
  for (const src of sources) {
    if (bySource.has(src)) continue
    let picture: SharedPicture | null = null
    if (/^data:/i.test(src)) {
      const decoded = decodeDataUri(src)
      picture = decoded ? keep(decoded.bytes, decoded.type) : null
    } else if (isRemote(src)) {
      const bytes = ports.fetchRemote
        ? await ports.fetchRemote(src).catch((error: unknown) => { if (error instanceof RemotePictureRefused) refusedPictures += 1; return null })
        : null
      const type = bytes && bytes.length > 0 ? sniffPictureType(bytes) : null
      picture = bytes && type ? keep(bytes, type) : null
    } else {
      const loaded = pictures.bySource.get(src)
      // The picture's own bytes when a browser draws its type, else the rasterised PNG the copy uses.
      const decoded = loaded ? decodeDataUri(loaded.dataUri) ?? (loaded.paste ? decodeDataUri(loaded.paste) : null) : null
      picture = decoded ? keep(decoded.bytes, decoded.type) : null
    }
    bySource.set(src, picture)
  }

  const render = (available: ReadonlySet<string> | null): string => toHtml(body, {
    links: 'external-only',
    // Only a link a reader can follow keeps its destination; a link to a file or folder (relative or
    // not) and an in-page `#` link become their words, so no path reaches the copy.
    linkTarget: (href) => (PUBLIC_LINK.test(href.trim()) ? href : null),
    // A widget is a local file: its line would name the path, so it publishes as one fixed sentence.
    widgets: { withheld: WIDGET_NOT_SHARED },
    stableHeadingIds: true,
    stableBlockIds: true,
    tableRegions: true,
    ...(part ? { idPrefix: part.idPrefix, headingOffset: part.headingOffset } : {}),
    images: {
      resolve: (src) => {
        const picture = bySource.get(src)
        if (!picture || (available && !available.has(picture.name))) return null
        return `${imagePath}${picture.name}`
      },
    },
  }).html

  const headings = htmlOutline(document, part?.idPrefix ?? '')
    .filter((heading) => /^[A-Za-z][A-Za-z0-9_:.-]{0,127}$/.test(heading.anchor) && !/^part-\d+$/.test(heading.anchor))
    .slice(0, SHARE_LIMITS.headingsPerPart)
    .map((heading) => ({ id: heading.anchor, text: oneLine(heading.text, SHARE_LIMITS.headingChars) }))
    .filter((heading) => heading.text !== '')

  const title = oneLine(partTitle(content, path).title || documentTitle(content, path), SHARE_LIMITS.titleChars) || 'Untitled'
  return {
    title,
    chips: chipsOf(content).slice(0, SHARE_LIMITS.chips),
    headings: [...new Map(headings.map((heading) => [heading.id, heading])).values()],
    savedAt: Math.round(file.modifiedAt),
    pictures: [...shared.values()],
    html: render(null),
    htmlWith: (available) => render(available),
    refusedPictures,
  }
}

/**
 * Pictures for a copy and for an export — the one place a document's images become bytes.
 *
 * Copy and export used to disagree about pictures, which is exactly the drift the shared emitters
 * exist to prevent: an export read files and carried them, while a copy emitted the writer's own
 * relative `src` (which the receiving application cannot resolve) and rendered the RTF flavour's
 * images as alt text. Both now come through here, so a picture that survives an export survives a
 * paste, and neither path can reach a file the other could not.
 *
 * Reading is the ONLY thing this module does with a disk, and it does it through the same
 * containment check the `wf-asset` protocol uses: a source is resolved against the workspace root
 * first (what the editor's own asset URLs mean, and what `saveImage` writes), then against the
 * document's own folder for a path a writer typed by hand. Neither may leave the workspace.
 */
import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { resolveWorkspaceAsset } from './wf-asset'
import { eachInline, type Block, type MarkdownDocument } from '../shared/markdown/model'
import { isSvgFence, sanitiseSvg } from '../shared/sanitise-svg'
import type { DocxImage } from '../shared/markdown/to-docx'
import type { RtfPicture } from '../shared/markdown/to-rtf'

/** Only the root is used; typed loosely so a caller does not need a whole Workspace to load one. */
type PictureSource = { root: string }

/**
 * One picture, in every form an output needs. A null flavour is one that could not take it.
 *
 * `dataUri` is the picture's OWN bytes and `paste` is the form a clipboard HTML flavour may use;
 * they differ for exactly the formats a paste target cannot draw (see `HTML_PASTE_NATIVE`).
 */
export type Picture = { dataUri: string; paste: string | null; docx: DocxImage | null; rtf: RtfPicture | null }

/**
 * What a document's pictures came to. `unreadable` is the honest half of the old "were not found"
 * message: the file IS there, and its bytes could not be read or converted.
 */
export type LoadedPictures = { bySource: Map<string, Picture>; unreadable: Set<string> }

/** Word embeds these four as they are; anything else (SVG, WebP, AVIF, TIFF…) is rasterised on the
 *  way in, so the format a picture happens to be saved in is no longer what decides whether it can
 *  be exported at all. */
const DOCX_NATIVE: Record<string, DocxImage['type']> = { png: 'png', jpg: 'jpg', jpeg: 'jpg', gif: 'gif', bmp: 'bmp' }

/** RTF hosts a picture as `{\pict\pngblip …}` or `{\pict\jpegblip …}` and nothing else, so a GIF or
 *  a BMP is rasterised for the clipboard even though Word's own file format takes it. */
const RTF_NATIVE: Record<string, RtfPicture['type']> = { png: 'png', jpg: 'jpg', jpeg: 'jpg' }

/**
 * What a paste target draws when it imports the CLIPBOARD's HTML flavour. Everything else — SVG
 * above all — travels as the rasteriser's PNG instead.
 *
 * the user's usability review find on 0.9.1: an SVG pasted into Word and Teams disappeared, though the export
 * to Word was fine and the RTF flavour carried a valid `\pict`. Word, Teams and Outlook DISCARD an
 * inline `<svg>` and an `image/svg+xml` data URI when they import HTML, and HTML is the flavour
 * they negotiate for first. So a clipboard picture is judged by what the RECEIVER can draw, which
 * is a stricter question than what a browser can draw — an exported HTML FILE deliberately keeps
 * the SVG (crisp, scalable, and a browser is what opens it).
 */
const HTML_PASTE_NATIVE = new Set(['png', 'jpg', 'jpeg', 'gif'])

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff',
}

/** The widest a picture is drawn, in px: a 6.5in text column at 96 dpi. A larger picture is scaled
 *  down in proportion; a smaller one is left alone. */
export const MAX_DRAWN_WIDTH = 624

/** A vector source is rasterised at twice its nominal size and drawn at half of that, so a diagram
 *  is still crisp when Word or a reader scales the page. 72 is sharp's own base density. */
const VECTOR_DENSITY = 144
const VECTOR_SUPERSAMPLE = VECTOR_DENSITY / 72

export function extensionOf(source: string): string {
  return (source.split('?')[0].split('#')[0].split('.').pop() ?? '').toLowerCase()
}

export function isRemote(source: string): boolean {
  return /^(?:https?:|data:)/i.test(source)
}

/**
 * A raster picture's natural size, read from its own header — PNG, JPEG, GIF and BMP, which are the
 * formats Word accepts as they are. Null when the bytes are not one of those or are truncated. The
 * rasteriser answers for everything else, so this stays a header read rather than a decode.
 */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const at = (index: number): number => bytes[index] ?? -1
  // PNG: an IHDR chunk right after the 8-byte signature.
  if (bytes.byteLength > 24 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  // GIF: a 7-byte logical screen descriptor, little-endian.
  if (bytes.byteLength > 10 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  }
  // BMP: the DIB header's width/height, little-endian (height may be negative for a top-down bitmap).
  if (bytes.byteLength > 26 && at(0) === 0x42 && at(1) === 0x4d) {
    return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) }
  }
  // JPEG: walk the segments to the first frame header (SOF0…SOF15, skipping the four that are not).
  if (bytes.byteLength > 4 && at(0) === 0xff && at(1) === 0xd8) {
    let offset = 2
    while (offset + 9 < bytes.byteLength) {
      if (at(offset) !== 0xff) { offset += 1; continue }
      const marker = at(offset + 1)
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue }
      const length = view.getUint16(offset + 2)
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isFrame) return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) }
      offset += 2 + length
    }
  }
  return null
}

/** How wide to DRAW a picture: its own size, scaled down to the text column if it overflows it. */
function fit(size: { width: number; height: number }): { width: number; height: number } {
  const scale = size.width > MAX_DRAWN_WIDTH ? MAX_DRAWN_WIDTH / size.width : 1
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }
}

type Raster = { data: Uint8Array; pixels: { width: number; height: number }; drawn: { width: number; height: number } }

/**
 * Anything to PNG, through `sharp` — SVG, WebP, AVIF, TIFF and the rest. It is already a dependency
 * of the packaged app, so nothing new is installed and no release-age gate applies. A failure is
 * never thrown: the caller reports the picture as unreadable and the caption travels alone.
 */
export async function rasterise(bytes: Uint8Array, vector: boolean): Promise<Raster | null> {
  try {
    const { default: sharp } = await import('sharp')
    const { data, info } = await sharp(bytes, vector ? { density: VECTOR_DENSITY } : {})
      .png()
      .toBuffer({ resolveWithObject: true })
    const pixels = { width: info.width, height: info.height }
    const nominal = vector
      ? { width: pixels.width / VECTOR_SUPERSAMPLE, height: pixels.height / VECTOR_SUPERSAMPLE }
      : pixels
    return { data, pixels, drawn: fit(nominal) }
  } catch {
    return null
  }
}

/** Every form of one picture, or null when its bytes could be read but not understood. */
async function pictureFor(bytes: Uint8Array, extension: string, forceRaster = false): Promise<Picture | null> {
  const mime = MIME[extension] ?? 'application/octet-stream'
  const dataUri = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
  const docxType = forceRaster ? null : DOCX_NATIVE[extension] ?? null
  const rtfType = forceRaster ? null : RTF_NATIVE[extension] ?? null
  const native = docxType || rtfType ? imageSize(bytes) : null
  // One conversion at most, and only when a flavour actually needs it.
  const raster = !native || !rtfType ? await rasterise(bytes, forceRaster || extension === 'svg') : null
  if (!native && !raster) return null
  const drawn = native ? fit(native) : raster?.drawn ?? { width: 1, height: 1 }
  const rasterUri = raster ? `data:image/png;base64,${Buffer.from(raster.data).toString('base64')}` : null
  return {
    dataUri,
    // A format the paste target draws keeps its own bytes — no needless re-encode; anything else
    // is the PNG. Null only when the rasteriser had nothing to give.
    paste: !forceRaster && HTML_PASTE_NATIVE.has(extension) && native ? dataUri : rasterUri,
    // Word takes the four it hosts natively as they are — no needless re-encode — and everything
    // else as the rasteriser's PNG, drawn at the size the raster reported.
    docx: docxType && native
      ? { data: bytes, type: docxType, ...drawn }
      : raster
        ? { data: raster.data, type: 'png', ...raster.drawn }
        : null,
    rtf: rtfType && native
      ? { data: bytes, type: rtfType, pixels: native, ...drawn }
      : raster
        ? { data: raster.data, type: 'png', pixels: raster.pixels, ...raster.drawn }
        : null,
  }
}

/** Every image source in a document, in order and without repeats. */
function imageSources(document: MarkdownDocument): string[] {
  const sources: string[] = []
  const collect = (list: Block[]): void => eachInline(list, (part) => {
    if (part.kind === 'image' && part.src && !sources.includes(part.src)) sources.push(part.src)
  })
  collect(document.blocks)
  for (const note of document.footnotes) collect(note.children)
  return sources
}

/** Read the bytes a source names, or null when nothing readable sits at any of its candidate paths. */
async function readSource(root: string, source: string, from: string): Promise<Uint8Array | null> {
  const folder = posix.dirname(from) === '.' ? '' : posix.dirname(from)
  const decoded = ((): string => { try { return decodeURIComponent(source) } catch { return source } })()
  const candidates = [decoded, folder ? posix.join(folder, decoded) : null].filter((value): value is string => value !== null)
  for (const candidate of candidates) {
    const absolute = await resolveWorkspaceAsset(root, candidate)
    if (!absolute) continue
    const bytes = await readFile(absolute).catch(() => null)
    if (bytes) return bytes
  }
  return null
}

/**
 * Read every picture a document names. A source with no readable file is simply absent from the
 * map (the emitters report it as missing); a source whose file WAS read but could not be turned
 * into a picture is absent AND named in `unreadable`, so the surface can say which happened.
 */
export async function loadPictures(source: PictureSource, document: MarkdownDocument, from: string): Promise<LoadedPictures> {
  const bySource = new Map<string, Picture>()
  const unreadable = new Set<string>()
  for (const src of imageSources(document)) {
    if (isRemote(src)) continue
    const bytes = await readSource(source.root, src, from)
    if (!bytes) continue
    const picture = await pictureFor(bytes, extensionOf(src))
    if (picture) bySource.set(src, picture)
    else unreadable.add(src)
  }
  return { bySource, unreadable }
}

// ---- Drawn objects -------------------------------------------------------------------------------
// A ```svg fence is one of the app's object types, and the editor draws it. HTML can take the SVG
// itself (to-html inlines the sanitised source); RTF and Word take bytes, so the fence is rendered
// here. ```mermaid and ```markmap are deliberately NOT handled: they need rendering engines that
// live in the renderer, and a half-drawn diagram is worse than its source.

/** Every ```svg fence in a document, in order and without repeats. */
function svgFences(document: MarkdownDocument): string[] {
  const sources: string[] = []
  const walk = (list: Block[]): void => {
    for (const entry of list) {
      if (entry.kind === 'code' && isSvgFence(entry.language) && !sources.includes(entry.text)) sources.push(entry.text)
      else if (entry.kind === 'quote') walk(entry.children)
      else if (entry.kind === 'list') for (const item of entry.items) walk(item.children)
    }
  }
  walk(document.blocks)
  for (const note of document.footnotes) walk(note.children)
  return sources
}

/** Rasterised ```svg fences, keyed by their exact source text. */
export type DrawnFences = Map<string, Picture>

/**
 * Draw every ```svg fence a document holds. A fence the app's own sanitiser refuses is simply not
 * in the map, and the emitters fall back to showing its source — a removal is a visible failure,
 * never a hole.
 */
export async function loadSvgFences(document: MarkdownDocument): Promise<DrawnFences> {
  const drawn: DrawnFences = new Map()
  for (const source of svgFences(document)) {
    const safe = sanitiseSvg(source)
    if (!('svg' in safe)) continue
    const picture = await pictureFor(Buffer.from(safe.svg, 'utf8'), 'svg', true)
    if (picture) drawn.set(source, picture)
  }
  return drawn
}

/** The Word fence policy: a drawn object, or the fence's own source as code. */
export function docxSvgFences(drawn: DrawnFences): { resolve: (source: string) => DocxImage | null } {
  return { resolve: (source) => drawn.get(source)?.docx ?? null }
}

/**
 * The CLIPBOARD's HTML fence policy: the rasterised PNG as a data URI.
 *
 * The exported HTML FILE inlines the `<svg>` instead (to-html's default), and that difference is
 * deliberate — see `HTML_PASTE_NATIVE` above. Unifying the two paths silently empties every SVG
 * pasted into Word or Teams, which is precisely the defect this exists to fix.
 */
export function pastedHtmlSvgFences(drawn: DrawnFences): { resolve: (source: string) => string | null } {
  return { resolve: (source) => drawn.get(source)?.paste ?? null }
}

/** The RTF fence policy. Same rule. */
export function rtfSvgFences(drawn: DrawnFences): { resolve: (source: string) => RtfPicture | null } {
  return { resolve: (source) => drawn.get(source)?.rtf ?? null }
}

/** Merge a second document's pictures into a bundle's accumulating set (first reading wins). */
export function mergePictures(into: LoadedPictures, more: LoadedPictures): void {
  for (const [source, picture] of more.bySource) if (!into.bySource.has(source)) into.bySource.set(source, picture)
  for (const source of more.unreadable) into.unreadable.add(source)
}

/** The exported HTML FILE's picture policy: a local picture becomes its own bytes (an SVG stays an
 *  SVG — a browser opens the file and draws it crisply at any zoom); a remote one keeps its
 *  address; anything unreadable is reported and its alt text travels alone. */
export function htmlImages(pictures: LoadedPictures): { resolve: (src: string) => string | null } {
  return { resolve: (src) => (isRemote(src) ? src : pictures.bySource.get(src)?.dataUri ?? null) }
}

/** The CLIPBOARD's HTML picture policy. Same shape, ONE deliberate difference from the export's:
 *  a format the receiving application cannot draw (SVG, WebP, AVIF, TIFF, BMP) arrives as the
 *  rasterised PNG rather than as its own bytes. Do not collapse this into `htmlImages`. */
export function pastedHtmlImages(pictures: LoadedPictures): { resolve: (src: string) => string | null } {
  return { resolve: (src) => (isRemote(src) ? src : pictures.bySource.get(src)?.paste ?? null) }
}

/** The Word picture policy: bytes or nothing (Word cannot follow an address). */
export function docxImages(pictures: LoadedPictures): { resolve: (src: string) => DocxImage | null } {
  return { resolve: (src) => pictures.bySource.get(src)?.docx ?? null }
}

/** The RTF picture policy. Same rule as Word's: a clipboard picture is bytes or it is alt text. */
export function rtfImages(pictures: LoadedPictures): { resolve: (src: string) => RtfPicture | null } {
  return { resolve: (src) => pictures.bySource.get(src)?.rtf ?? null }
}

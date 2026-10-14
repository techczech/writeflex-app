import { citationChip } from './citation'

export const READING_ROOM_AREA_MIME = 'application/x-writeflex-reading-area'

/** Keep the renderer-to-main image message bounded before it is decoded or copied. */
export const MAX_READING_ROOM_AREA_BYTES = 16 * 1024 * 1024

export type ReadingRoomAreaTransfer = {
  annotationKey: string
  attachmentKey: string
  authorYear: string
  image: string
  libraryId: number
  link: string
  pageLabel: string | null
}

export type ReadingRoomAreaAnnotation = {
  image?: string | null
  key: string
  pageLabel: string | null
  type: string
}

export type ReadingRoomAreaDocument = {
  attachmentKey: string
  authorYear: string
  libraryId: number
}

const PNG_PREFIX = 'data:image/png;base64,'
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function decodedLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor(base64.length * 3 / 4) - padding
}

function decodeBase64(base64: string): Uint8Array | null {
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null
  try {
    const binary = atob(base64)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

function pngBytes(image: string, maxBytes: number): Uint8Array | null {
  if (!image.startsWith(PNG_PREFIX)) return null
  const base64 = image.slice(PNG_PREFIX.length)
  if (decodedLength(base64) > maxBytes) return null
  const bytes = decodeBase64(base64)
  if (!bytes || bytes.length > maxBytes) return null
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return null
  return bytes
}

function exactAnnotationLink(link: string, attachmentKey: string, annotationKey: string): boolean {
  const match = /^zotero:\/\/open-pdf\/(?:library|groups\/\d+)\/items\/([^?]+)\?annotation=([^&]+)$/.exec(link)
  if (!match) return false
  try {
    return decodeURIComponent(match[1]) === attachmentKey && decodeURIComponent(match[2]) === annotationKey
  } catch {
    return false
  }
}

export function parseReadingRoomAreaTransfer(
  raw: string,
  maxBytes = MAX_READING_ROOM_AREA_BYTES,
): ReadingRoomAreaTransfer | null {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < PNG_SIGNATURE.length) return null
  // Bound the attacker-controlled serialised form before JSON.parse allocates its object graph.
  if (raw.length > Math.ceil(maxBytes / 3) * 4 + 4096) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (
    !nonEmptyString(candidate.annotationKey)
    || !nonEmptyString(candidate.attachmentKey)
    || !nonEmptyString(candidate.authorYear)
    || !nonEmptyString(candidate.image)
    || !Number.isSafeInteger(candidate.libraryId)
    || (candidate.libraryId as number) <= 0
    || !nonEmptyString(candidate.link)
    || !(candidate.pageLabel === null || nonEmptyString(candidate.pageLabel))
  ) return null
  const transfer: ReadingRoomAreaTransfer = {
    annotationKey: candidate.annotationKey.trim(),
    attachmentKey: candidate.attachmentKey.trim(),
    authorYear: candidate.authorYear.trim(),
    image: candidate.image,
    libraryId: candidate.libraryId as number,
    link: candidate.link.trim(),
    pageLabel: typeof candidate.pageLabel === 'string' ? candidate.pageLabel.trim() : null,
  }
  if (!pngBytes(transfer.image, maxBytes)) return null
  if (!exactAnnotationLink(transfer.link, transfer.attachmentKey, transfer.annotationKey)) return null
  return transfer
}

export function readingRoomAreaTransferForAnnotation(
  annotation: ReadingRoomAreaAnnotation,
  document: ReadingRoomAreaDocument,
  citationBaseLink: string,
): ReadingRoomAreaTransfer | null {
  if (annotation.type !== 'image' || !nonEmptyString(annotation.image)) return null
  const transfer: ReadingRoomAreaTransfer = {
    annotationKey: annotation.key,
    attachmentKey: document.attachmentKey,
    authorYear: document.authorYear,
    image: annotation.image,
    libraryId: document.libraryId,
    link: `${citationBaseLink}?annotation=${encodeURIComponent(annotation.key)}`,
    pageLabel: annotation.pageLabel,
  }
  return parseReadingRoomAreaTransfer(JSON.stringify(transfer))
}

export function decodeReadingRoomAreaPng(image: string): Uint8Array {
  const bytes = pngBytes(image, MAX_READING_ROOM_AREA_BYTES)
  if (!bytes) throw new Error('The Area capture is not a valid PNG.')
  return bytes
}

export function areaCaptureMarkdown(path: string, transfer: ReadingRoomAreaTransfer): string {
  const source = transfer.pageLabel
    ? { authorYear: transfer.authorYear, pageLabel: `${transfer.pageLabel} · area annotation`, link: transfer.link }
    : { authorYear: `${transfer.authorYear} · area annotation`, pageLabel: null, link: transfer.link }
  return `![Captured chart or table](${path})\n\n${citationChip(source)}`
}

export type ReadingRoomAreaDropResult = 'failed' | 'inserted' | 'inserted-without-provenance' | 'stale'

export type ReadingRoomAreaDropDestination = {
  saveImage: (bytes: Uint8Array) => Promise<{ path: string }>
  isCurrent: () => boolean
  insert: (markdown: string) => boolean
  recordQuotation: (transfer: ReadingRoomAreaTransfer) => void | Promise<void>
  onStatus: (message: string) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The irreversible ordering for a drop: asset first, one editor transaction second, provenance last.
 * Quotation provenance may fail independently, but it can never describe content that was not inserted.
 */
export async function commitReadingRoomAreaDrop(
  transfer: ReadingRoomAreaTransfer,
  destination: ReadingRoomAreaDropDestination,
): Promise<ReadingRoomAreaDropResult> {
  let saved: { path: string }
  try {
    saved = await destination.saveImage(decodeReadingRoomAreaPng(transfer.image))
  } catch (error) {
    destination.onStatus(`Could not insert the Area capture: ${errorMessage(error)}`)
    return 'failed'
  }
  if (!destination.isCurrent()) {
    destination.onStatus('Area capture saved, but the destination draft changed before insertion.')
    return 'stale'
  }
  try {
    if (!destination.insert(areaCaptureMarkdown(saved.path, transfer))) {
      destination.onStatus('Could not insert the Area capture into the destination draft.')
      return 'failed'
    }
  } catch (error) {
    destination.onStatus(`Could not insert the Area capture: ${errorMessage(error)}`)
    return 'failed'
  }
  try {
    await destination.recordQuotation(transfer)
    return 'inserted'
  } catch (error) {
    destination.onStatus(`Area inserted, but its quotation record could not be saved: ${errorMessage(error)}`)
    return 'inserted-without-provenance'
  }
}

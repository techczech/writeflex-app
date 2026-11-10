import { EVIDENCE_DRAG_MIME, type EvidenceTransfer } from '../../shared/folio-evidence-transfer'
import type { ReaderEmbed, ReaderSelectionAnnotation } from '@readflex/reader-embed'
import type { ReaderDocumentMetadata, ReaderSelectionSnapshot } from '../../shared/reading-room-channel'
import { READING_ROOM_AREA_MIME, readingRoomAreaTransferForAnnotation } from './editor/reading-room-area-drop'
import { normaliseReaderText } from './editor/citation'

/** Runs synchronously beside the real reader DOM and DataTransfer. Main-owned Area preparation
 * remains in the editor's existing drop/insert path. The parent receives an attributed snapshot. */
export function readerTransferCallback(input: {
  embed: ReaderEmbed; dataTransfer: unknown; items: unknown[]; document: ReaderDocumentMetadata; citationBaseLink: string
  selection(value: ReaderSelectionSnapshot | null): void; error(message: string): void
}): void {
  const { embed, items, document, citationBaseLink } = input
  const transfer = input.dataTransfer as { setData?: (type: string, value: string) => void }
  const first = items.length ? items[0] as { id?: unknown; type?: unknown; text?: unknown; position?: unknown; pageLabel?: unknown } : null
  if (items.length === 1 && first?.type === 'image') {
    const annotation = typeof first.id === 'string' ? embed.annotationForKey(first.id) : null
    const payload = annotation ? readingRoomAreaTransferForAnnotation(annotation, document, citationBaseLink) : null
    if (!payload || typeof transfer.setData !== 'function') input.error('The Area capture could not be prepared for dragging.')
    else transfer.setData(READING_ROOM_AREA_MIME, JSON.stringify(payload))
    input.selection(null); return
  }
  const itemTarget = citationBaseLink.replace('zotero://open-pdf/', 'zotero://select/').replace(/\/items\/[^/?]+(?:\?.*)?$/, `/items/${document.itemKey}`)
  const candidate = typeof first?.id === 'string' && /^[A-Z\d]{8}$/.test(first.id) ? first.id : null
  const source: EvidenceTransfer = { kind: 'zotero', itemTarget, label: document.authorYear, pending: true,
    ...(candidate ? { annotation: { target: `${citationBaseLink}?annotation=${candidate}`, label: document.authorYear } } : {}) }
  transfer.setData?.(EVIDENCE_DRAG_MIME, JSON.stringify(source))
  let selection: ReaderSelectionAnnotation | null = null
  try { selection = embed.getSelectionAnnotation() } catch (error) { input.error(String(error)) }
  const text = typeof first?.text === 'string' ? first.text : ''
  if (!text.trim()) { input.selection(null); return }
  const matched = selection && typeof selection.text === 'string' && normaliseReaderText(selection.text) === normaliseReaderText(text) ? selection : null
  let pageIndex: number | null = null
  try {
    const parsed = JSON.parse(matched ? matched.position : JSON.stringify(first?.position ?? {}))
    if (Number.isSafeInteger(parsed.pageIndex) && parsed.pageIndex >= 0) pageIndex = parsed.pageIndex
  } catch { /* A quote without page position retains the document link. */ }
  input.selection({ annotation: matched, text, pageIndex,
    pageLabel: matched ? matched.pageLabel : typeof first?.pageLabel === 'string' ? first.pageLabel : null,
    pageLink: pageIndex === null ? citationBaseLink : `${citationBaseLink}?page=${pageIndex + 1}` })
}

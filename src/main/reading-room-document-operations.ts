import type { IpcMainInvokeEvent } from 'electron'
import type { SidecarStore, ReadingRoomDocument } from '@readflex/sidecar'
import type { ZoteroAnnotation } from '@readflex/zotero-bridge'
import type { ReadingRoomContexts } from './reading-room-context'
import { allOutboxEntries, zoteroOutboxCounts, citationSelection, annotationFromOutbox, isRecord, type createShelfLoader } from './reading-room-inputs'
import { highlightsResult, mergeWithOutbox, retireConfirmed, withKeptEdits, type HighlightsResult, type ZoteroRead } from './reading-room-highlights'
import { keptEditKeys } from './reading-room-refused'
import { pageLink, annotationLink } from './zotero-links'
import { annotationPayload, annotationPositionWithinCap, annotationTextWithinCap, citationAnnotation, findExactCitationAnnotation, isPdfCitationPosition, LOCAL_ONLY_COMPLEX_PDF_REASON, LOCAL_ONLY_NON_PDF_REASON, readerSessionOf, validBaseline, type SavedAnnotation, type DrainReport, type DrainSkipReason } from './zotero-annotation-writes'
import { queueAnnotationChange } from './zotero-outbox-edits'
import type { ReadingRoomOutboxNotice } from './reading-room'

type DocumentOperations = {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => any): void
  store: SidecarStore
  contexts: ReadingRoomContexts
  requireReaderLease(input: unknown): () => void
  currentDocument(): ReadingRoomDocument | null
  readZoteroAnnotations(library: number, attachment: string): Promise<{ annotations: ZoteroAnnotation[]; read: ZoteroRead }>
  shelf: ReturnType<typeof createShelfLoader>
  drainEverything(): Promise<DrainReport>
  drainFacts(report: DrainReport): Pick<ReadingRoomOutboxNotice, 'written' | 'refusedNow' | 'notWritten' | 'notWrittenCode'>
}
export function registerReaderDocumentOperations({ handle, store, contexts, requireReaderLease, currentDocument, readZoteroAnnotations, shelf, drainEverything, drainFacts }: DocumentOperations): void {
  /** The remembered document's annotations. Read straight from Zotero rather than from the reader, so
   *  the harvest works with no document rendered — the posture the locked mockup is built around. */
  handle('reading-room:read-highlights', async (_event, lease?: unknown): Promise<HighlightsResult> => {
    if (lease !== undefined) requireReaderLease({ lease })
    const document = currentDocument()
    if (!document) {
      return { colours: [], error: null, forReader: [], rows: [], tags: [] }
    }
    try {
      // Zotero's marks AND the ones still owed to it, as one set (ADR-0029): a highlight made in this
      // session paints immediately and stays painted across a reopen, with or without a credential.
      const { annotations, read } = await readZoteroAnnotations(document.libraryId, document.attachmentKey)
      contexts.check()
      // This document's rows only, with no window: a long log elsewhere cannot hide its edits.
      const waiting = store.outboxUnconfirmedFor(document.libraryId, document.attachmentKey)
      // What Zotero confirmed stays painted from here until an authoritative read that started after
      // the confirmation, so a confirmed highlight never vanishes on reopen (ADR-0047).
      const settled = retireConfirmed(store.outboxConfirmedUnreadFor(document.libraryId, document.attachmentKey), read)
      if (settled.retired.length > 0) store.markOutboxRead(settled.retired)
      const owed = [...settled.stillShown, ...waiting].sort((left, right) => left.id - right.id)
      const shown = mergeWithOutbox(annotations, owed)
      const result = withKeptEdits(highlightsResult(shown), keptEditKeys(owed))
      const confirmed = new Set([...annotations.map(annotation => annotation.key), ...settled.stillShown.map(entry => entry.itemKey)])
      return { ...result, rows: result.rows.map(row => ({ ...row, zoteroKey: confirmed.has(row.key) ? row.key : null })) }
    } catch (error) {
      return {
        colours: [],
        forReader: [],
        error: `The highlights for this document could not be read. ${
          error instanceof Error ? error.message : String(error)
        }`,
        rows: [],
        tags: [],
      }
    }
  })

  /**
   * The citation create path (ADR-0035). It writes only after the selected words actually arrive in
   * a draft, so copying for another destination does not create a Zotero mark.
   *
   * Exact reuse is restricted to this app's retained outbox rows: same library and attachment, same
   * page, byte-identical rect arrays. A confirmed row earns an annotation link. Every unconfirmed
   * state, including Zotero-open refusal, earns only the page link and keeps ADR-0036's result.
   */
  handle('reading-room:cite-selection', async (_event, input: unknown): Promise<{
    annotation: (SavedAnnotation & { isExternal: false }) | null
    confirmed: boolean
    link: string
    waiting: number
    rejected: number
    notWritten?: string
    notWrittenCode?: DrainSkipReason | 'document-mismatch'
  }> => {
    if (
      !isRecord(input)
      || typeof input.attachmentKey !== 'string'
      || typeof input.libraryId !== 'number'
      || typeof input.documentTitle !== 'string'
      || !input.documentTitle.trim()
    ) {
      throw new Error('Invalid citation selection.')
    }
    const document = currentDocument()
    if (
      !document
      || input.libraryId !== document.libraryId
      || input.attachmentKey !== document.attachmentKey
    ) {
      return {
        annotation: null,
        confirmed: false,
        link: '',
        ...zoteroOutboxCounts(store),
        notWrittenCode: 'document-mismatch',
      }
    }
    const selection = citationSelection(input.annotation)
    if (!selection) throw new Error('The reader selection cannot become a Zotero highlight.')

    const state = await shelf.load()
    contexts.checkIfBound()
    contexts.check()
    let pageIndex: number | null = null
    try {
      const position = JSON.parse(selection.position) as { pageIndex?: unknown }
      if (typeof position.pageIndex === 'number' && Number.isFinite(position.pageIndex)) {
        pageIndex = Math.max(1, Math.round(position.pageIndex) + 1)
      }
    } catch {
      pageIndex = null
    }
    const fallbackLink = pageLink(
      state.librarySegments,
      document.libraryId,
      document.attachmentKey,
      pageIndex,
    )
    if (!isPdfCitationPosition(selection.position)) {
      return {
        annotation: null,
        confirmed: false,
        link: fallbackLink,
        ...zoteroOutboxCounts(store),
      }
    }
    if (
      !annotationPositionWithinCap(selection.position)
      || !annotationTextWithinCap(selection.text)
    ) {
      return {
        annotation: null,
        confirmed: false,
        link: fallbackLink,
        ...zoteroOutboxCounts(store),
      }
    }
    let entries = allOutboxEntries(store)
    let exact = findExactCitationAnnotation(
      entries,
      document.libraryId,
      document.attachmentKey,
      selection.position,
    )
    let annotation = exact ? annotationFromOutbox(exact) : null
    if (!annotation) {
      annotation = citationAnnotation(selection, input.documentTitle.trim())
      store.enqueueOutbox({
        itemKey: annotation.key,
        libraryId: document.libraryId,
        operation: 'create',
        parentItemKey: document.attachmentKey,
        payload: JSON.stringify(annotationPayload(annotation, document.attachmentKey)),
      })
    }

    const report = await drainEverything()
    contexts.checkIfBound()
    entries = allOutboxEntries(store)
    exact = findExactCitationAnnotation(
      entries,
      document.libraryId,
      document.attachmentKey,
      selection.position,
    )
    const retained = exact ? annotationFromOutbox(exact) : null
    if (retained) annotation = retained

    const written = exact?.status === 'confirmed' && exact.itemKey
      ? annotationLink(state.librarySegments, document.libraryId, document.attachmentKey, exact.itemKey)
      : fallbackLink
    return {
      annotation: { ...annotation, isExternal: false },
      confirmed: exact?.status === 'confirmed',
      link: written,
      ...zoteroOutboxCounts(store),
      ...drainFacts(report),
    }
  })

  /**
   * A highlight made in the reader, on its way into Zotero through the WriteFlex plugin (ADR-0047).
   *
   * It is **queued first** and only then written: the renderer awaits this call and only then tells
   * the reader "saved", so the boundary the reader trusts is the durable local queue and never the
   * write (ADR-0014). If Zotero is not open the entry simply stays queued —
   * still painted, because ADR-0029 draws the union of Zotero and the outbox.
   */
  handle('reading-room:save-annotations', async (_event, input: unknown): Promise<{
    queued: number
    waiting: number
    rejected: number
    /** Present when Zotero would not take the write, e.g. "Zotero is not open…". */
    notWritten?: string
    /** Which refusal it was, so a surface can name the cause without reading the sentence. */
    notWrittenCode?: DrainSkipReason
    /** Facts about marks deliberately kept here, independent of the Zotero drain result. */
    keptLocal?: {
      code: 'unsupported-position'
      count: number
      created: boolean
      reason: string
    }
  }> => {
    const completeSave = requireReaderLease(input)
    const document = currentDocument()
    if (!document) throw new Error('There is no open document to attach a highlight to.')
    if (!isRecord(input) || !Array.isArray(input.annotations)) {
      throw new Error('Invalid annotation payload.')
    }
    const operation = input.operation === 'update' || input.operation === 'delete'
      ? input.operation
      : 'create'
    let queued = 0
    let keptLocalCount = 0
    let keptLocalReason: string | null = null
    // The before-state is the reader's, sent with each change: the mark as THAT reader instance showed
    // it (ADR-0047). Main keeps no copy of its own, so a list refreshed since cannot stand in for it.
    const before = Array.isArray(input.before) ? input.before : []
    // Which reader instance made the change: a create re-keyed because Zotero already held its key is
    // resolved to the new key only for that instance's later changes (ADR-0047).
    const readerSession = readerSessionOf({ readflexReaderSession: input.readerSession })
    // Each change is one sidecar transaction, and a row the drain has claimed is never folded into or
    // cancelled (see zotero-outbox-edits), so this may interleave freely with a drain in flight.
    for (const [index, raw] of input.annotations.entries()) {
      if (
        !isRecord(raw)
        || typeof raw.key !== 'string'
        || typeof raw.sortIndex !== 'string'
        || typeof raw.position !== 'string'
      ) continue
      const annotation = raw as unknown as SavedAnnotation
      const payload = annotationPayload(annotation, document.attachmentKey, undefined, {
        keepWholeComment: operation !== 'create',
      })
      // The reader's OWN key, on a create as well as an update or delete. ADR-0029 deduplicates the
      // painted union by annotation key, and a key Zotero replaces on insert is carried to every row
      // queued after it when the create is confirmed.
      const queuedChange = queueAnnotationChange(store, {
        itemKey: annotation.key,
        libraryId: document.libraryId,
        operation,
        parentItemKey: document.attachmentKey,
        payload: JSON.stringify({
          ...(operation === 'create' && annotation.type === 'image'
            ? { ...payload, readflexSourceKey: annotation.key }
            : payload),
          ...(readerSession ? { readflexReaderSession: readerSession } : {}),
        }),
      }, operation === 'create' ? null : validBaseline(before[index]))
      queued += 1
      // A fold landed in a row that is already classified; a cancel left nothing to classify.
      if (queuedChange.kind !== 'queued') continue
      const keptReason = document.kind !== 'pdf'
        ? LOCAL_ONLY_NON_PDF_REASON
        : operation !== 'delete'
            && (!annotationPositionWithinCap(annotation.position) || !isPdfCitationPosition(annotation.position))
          ? LOCAL_ONLY_COMPLEX_PDF_REASON
          : null
      if (keptReason) {
        keptLocalReason = keptReason
        store.markOutboxLocalOnly(queuedChange.entry.id, keptReason)
        keptLocalCount += 1
      }
    }
    // Now try to hand it to Zotero. A refusal is not a failure of the save.
    const report = await drainEverything()
    // The queue belongs to the admitted document; a replacement selection cannot undo its save.
    completeSave()
    return {
      queued,
      ...zoteroOutboxCounts(store),
      ...(keptLocalReason
        ? {
            keptLocal: {
              code: 'unsupported-position' as const,
              count: keptLocalCount,
              created: operation === 'create',
              reason: keptLocalReason,
            },
          }
        : {}),
      ...drainFacts(report),
    }
  })

}

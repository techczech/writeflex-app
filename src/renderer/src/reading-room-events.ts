import type { ViewStatePersistence, ReaderLiveness } from '@readflex/reader-embed'
import type { MutableRefObject } from 'react'
import type { ReadingRoomClient } from './reading-room-client'
import { createHeldMarks } from './reading-room-held-marks'
import { completeAreaCapture, leaveReadingRoomMarkMode, readingRoomTool, type ReadingRoomMarkState } from './reading-room-marks'
import type { ReadingRoomProps } from './components/ReadingRoom.types'
import type { ReadingRoomDocument } from '../../preload'

type ReaderEventsOptions = Pick<ReadingRoomProps, 'onError' | 'onReaderSelection' | 'onHostChord' | 'onWriteResult'> & {
  embed: ReadingRoomClient
  writer: ViewStatePersistence
  document: ReadingRoomDocument
  index: number
  markStateRef: MutableRefObject<ReadingRoomMarkState>
  activeIndexRef: MutableRefObject<number>
  setMarkState(state: ReadingRoomMarkState): void
  setColourPopoverOpen(open: boolean): void
  setLiveness(state: ReaderLiveness): void
}
const readingRoomError = (error: unknown): string => error instanceof Error ? error.message : String(error)
export function bindReaderEvents({ embed, writer, document, index, markStateRef, activeIndexRef, setMarkState, setColourPopoverOpen, setLiveness, onError, onReaderSelection, onHostChord, onWriteResult }: ReaderEventsOptions): ReturnType<typeof createHeldMarks> {
  // What THIS reader shows for each mark: the before-state its edits and deletions carry (ADR-0031).
  // A list refresh never changes it; only what this reader was given and what it did itself.
  const held = createHeldMarks()
  embed.on('error', message => onError(message))
  embed.on('selection', selection => {
    onReaderSelection(selection ? { ...selection, ...document,
      paint: annotation => { held.hold(annotation); void embed.upsertAnnotations([annotation]).catch(error => onError(readingRoomError(error))) },
    } : null)
  })
  embed.on('host-chord', (chord) => onHostChord(chord))
  embed.on('mark-mode-cancelled', () => {
    const next = leaveReadingRoomMarkMode(markStateRef.current)
    void embed.setTool(readingRoomTool(next)).catch(error => onError(readingRoomError(error)))
    markStateRef.current = next
    setMarkState(next)
    setColourPopoverOpen(false)
  })
  // A highlight made in the reader is queued for Zotero, and the reader is told "saved" only once
  // that queue write has returned — the embed awaits these listeners, so returning the promise IS the
  // durability contract (ADR-0014, consequence 1). Nothing waits on the network.
  //
  // The RESULT is read, not discarded (ADR-0036): it carries `notWritten` — the sentence for a person
  // when Zotero would not take the write — and throwing it away is what made a refused write silent.
  embed.on('annotation-created', (annotation) => {
    if (annotation.type === 'image') {
      const next = completeAreaCapture(markStateRef.current)
      markStateRef.current = next
      setMarkState(next)
      setColourPopoverOpen(false)
    }
    held.created(annotation)
    return window.writeflex.readingRoom
      .saveAnnotations({ lease: embed.lease.id, annotations: [annotation], operation: 'create', readerSession: held.session })
      .then((result) => { onWriteResult(result) })
      .catch((error: unknown) => { onError(readingRoomError(error)); throw error })
  })
  embed.on('annotation-updated', (annotation) =>
    window.writeflex.readingRoom
      .saveAnnotations({ lease: embed.lease.id, annotations: [annotation], before: [held.edit(annotation)], operation: 'update', readerSession: held.session })
      .then((result) => { onWriteResult(result) })
      .catch((error: unknown) => { onError(readingRoomError(error)); throw error }))
  // A deletion takes the same path as an edit: queued (or cancelling a mark Zotero never got), drawn
  // as gone, and written into Zotero when it is closed.
  embed.on('annotation-deleted', (annotation) =>
    window.writeflex.readingRoom
      .saveAnnotations({ lease: embed.lease.id, annotations: [annotation], before: [held.remove(annotation)], operation: 'delete', readerSession: held.session })
      .then((result) => { onWriteResult(result) })
      .catch((error: unknown) => { onError(readingRoomError(error)); throw error }))
  embed.beforeRelease(() => writer.flush())
  embed.on('view-state-changed', (viewState) => {
    writer.schedule(viewState)
    window.setTimeout(() => {
      if (activeIndexRef.current === index) {
        try {
          void embed.getLiveness().then(setLiveness).catch(error => onError(readingRoomError(error)))
        } catch {
          // The next settled view-state event will refresh the locator.
        }
      }
    }, 0)
    return writer.flush()
  })
  return held
}

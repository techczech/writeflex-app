import { useCallback, useEffect, useState } from 'react'
import type { ReadingRoomWriteResult, RefusedHighlight } from '../../../preload'

/**
 * "Not sent to Zotero" — the highlights the status bar's refused count is about, across every
 * document, each with its paper, its words, the stored reason and the date.
 *
 * It exists because a count nobody can inspect is an alarm, not information. It sits at the top of the
 * Highlights view, which is where the status-bar chip already leads, and it is absent when there is
 * nothing refused. Dismissing a row removes it from the count and deletes nothing: the highlight is
 * kept here and stays on the page, and the text says so.
 */

export type ReadingRoomRefusedListProps = {
  items: RefusedHighlight[]
  /** The row an action is in flight for, so its buttons cannot be pressed twice. */
  busyId: number | null
  onOpen: (item: RefusedHighlight) => void
  onRetry: (item: RefusedHighlight) => void
  onDismiss: (item: RefusedHighlight) => void
}

function refusedDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** The list itself, with no fetching, so a render test can reach it. Renders nothing when empty. */
export function ReadingRoomRefusedList({
  busyId,
  items,
  onDismiss,
  onOpen,
  onRetry,
}: ReadingRoomRefusedListProps): JSX.Element | null {
  if (items.length === 0) return null
  return (
    <section
      className="reading-room-refused"
      aria-label="Not sent to Zotero"
      // The Highlights view treats Enter and the arrows as list navigation; a button in here must get
      // its own keys. Escape is let through so it still leaves the view.
      onKeyDown={(event) => { if (event.key !== 'Escape') event.stopPropagation() }}
    >
      <div className="reading-room-shelf-bar">
        Not sent to Zotero
        <span>{items.length}</span>
      </div>
      <p className="reading-room-refused-lead">
        Zotero would not take {items.length === 1 ? 'this highlight' : 'these highlights'}.
        {' '}
        {items.length === 1 ? 'It is' : 'Each one is'} kept here in WriteFlex and stays on the page.
        Dismissing one only stops counting it; nothing is deleted.
      </p>
      <ul>
        {items.map((item) => (
          <li key={item.id} className="reading-room-refused-item" data-refused-kind={item.kind}>
            <span className="reading-room-shelf-meta">
              <span className="reading-room-shelf-who">{item.documentTitle}</span>
              <span className="reading-room-refused-date">{refusedDate(item.date)}</span>
            </span>
            {item.open ? (
              <button
                type="button"
                className="reading-room-refused-excerpt"
                title="Open this document at the highlight"
                onClick={() => onOpen(item)}
              >
                “{item.excerpt}”
              </button>
            ) : (
              <span className="reading-room-refused-excerpt">“{item.excerpt}”</span>
            )}
            <span className="reading-room-refused-reason">
              {item.kind === 'conflict' ? 'Changed in Zotero as well: ' : ''}
              {item.reason}
            </span>
            <span className="reading-room-refused-actions">
              {item.retryable && (
                <button type="button" disabled={busyId === item.id} onClick={() => onRetry(item)}>
                  Try again
                </button>
              )}
              <button
                type="button"
                disabled={busyId === item.id}
                title="Stop counting this one. The highlight is kept here; nothing is deleted."
                onClick={() => onDismiss(item)}
              >
                Dismiss, keep highlight here
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export type ReadingRoomRefusedProps = {
  /** Bumped whenever the Highlights view is raised; each bump re-reads the list. */
  focusToken: number
  /** The refused count changed, so the status bar's indicator should re-read it. */
  onOutboxChanged: () => void
  onError: (message: string) => void
  onOpen: (item: RefusedHighlight) => void
  onWriteResult: (result: ReadingRoomWriteResult) => void
}

export function ReadingRoomRefused({
  focusToken,
  onError,
  onOutboxChanged,
  onOpen,
  onWriteResult,
}: ReadingRoomRefusedProps): JSX.Element | null {
  const [items, setItems] = useState<RefusedHighlight[]>([])
  const [busyId, setBusyId] = useState<number | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    setItems(await window.writeflex.readingRoom.refusedHighlights())
  }, [])

  useEffect(() => {
    let live = true
    void window.writeflex.readingRoom
      .refusedHighlights()
      .then((next) => { if (live) setItems(next) })
      .catch((error: unknown) => {
        if (live) onError(error instanceof Error ? error.message : String(error))
      })
    return () => { live = false }
  }, [focusToken, onError])

  const act = useCallback((item: RefusedHighlight, action: () => Promise<void>): void => {
    setBusyId(item.id)
    void action()
      .then(reload)
      .catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusyId(null))
  }, [onError, reload])

  const retry = useCallback((item: RefusedHighlight): void => {
    act(item, async () => {
      onWriteResult(await window.writeflex.readingRoom.retryRefused(item.id))
    })
  }, [act, onWriteResult])

  const dismiss = useCallback((item: RefusedHighlight): void => {
    act(item, async () => {
      await window.writeflex.readingRoom.dismissRefused(item.id)
      onOutboxChanged()
    })
  }, [act, onOutboxChanged])

  return (
    <ReadingRoomRefusedList
      items={items}
      busyId={busyId}
      onOpen={onOpen}
      onRetry={retry}
      onDismiss={dismiss}
    />
  )
}

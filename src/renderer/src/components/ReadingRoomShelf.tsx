import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, CircleAlert, Clock, FileText, Globe, Link2, Search } from 'lucide-react'
import type { RecentDocumentRow, ShelfRow, ShelfSearchResult } from '../../../preload'
import { claimKeyboard } from './claim-keyboard'

export type ReadingRoomShelfProps = {
  /** Bumped whenever the Shelf is raised, so the search field takes the keyboard each time. */
  focusToken: number
  /** Esc leaves the Shelf. Absent when there is no document behind it to return to. */
  onDismiss: (() => void) | null
  onError: (message: string) => void
  onOpen: (row: ShelfRow, attachmentKey: string) => void
  /** Open one of the recently read papers. Given keys rather than a Shelf row, because that is all a
   *  recents entry stores — which is what lets it survive a reindex or a rename in Zotero. */
  onOpenRecent: (recent: RecentDocumentRow) => void
  /** Present when the Shelf is being used to PICK A REFERENCE for the draft rather than to open a
   *  document. Every row becomes choosable, including the 237 items with no readable file — citing an
   *  item you have no PDF of is the commonest citation case, not an edge case (ADR-0009). */
  onCite?: ((row: ShelfRow) => void) | null
}

/**
 * One keyboard stop: a recently read paper, an item row, or one attachment inside an expanded item
 * row. Recents come first in the list, so raising the Shelf and pressing ↓ then ↵ reopens yesterday's
 * paper **without typing anything** — which is the point of them, since the title is what the user has
 * forgotten (ReadFlex ADR-0032).
 */
type Stop =
  | { kind: 'recent'; recent: RecentDocumentRow }
  | { attachmentKey?: undefined; kind: 'item'; row: ShelfRow }
  | { attachmentKey: string; kind: 'attachment'; row: ShelfRow }

/** A stable empty list, so the stop table is not rebuilt on every keystroke. */
const NO_RECENTS: RecentDocumentRow[] = []

const EMPTY: ShelfSearchResult = {
  diagnostics: [],
  error: null,
  matched: 0,
  query: '',
  rows: [],
  total: 0,
  zoteroDataDirectory: '',
}

function kindIcon(kind: ShelfRow['kind']): JSX.Element {
  if (kind === 'pdf') return <FileText aria-hidden="true" />
  if (kind === 'snapshot') return <Globe aria-hidden="true" />
  if (kind === 'other') return <Link2 aria-hidden="true" />
  return <CircleAlert aria-hidden="true" />
}

function stopId(stop: Stop): string {
  if (stop.kind === 'recent') {
    return `shelf-recent-${stop.recent.libraryId}-${stop.recent.itemKey}-${stop.recent.attachmentKey}`
  }
  return `shelf-${stop.row.libraryId}-${stop.row.itemKey}${stop.kind === 'attachment' ? `-${stop.attachmentKey}` : ''}`
}

/** "Yesterday", "3 days ago" — when the user read it, in the terms the user would ask the question in. */
function whenRead(openedAt: string, now = Date.now()): string {
  const at = Date.parse(openedAt)
  if (Number.isNaN(at)) return ''
  const days = Math.floor((now - at) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  if (days < 14) return 'last week'
  if (days < 60) return `${Math.round(days / 7)} weeks ago`
  return `${Math.round(days / 30)} months ago`
}

export function ReadingRoomShelf({
  focusToken,
  onCite,
  onDismiss,
  onError,
  onOpen,
  onOpenRecent,
}: ReadingRoomShelfProps): JSX.Element {
  const citing = !!onCite
  const field = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const request = useRef(0)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<ShelfSearchResult | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [cursor, setCursor] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [recents, setRecents] = useState<RecentDocumentRow[]>([])

  // Recents are re-read whenever the Shelf is raised, so a paper opened this session is at the front
  // the next time the user looks. Failing to read them is not worth a message — the Shelf still works.
  useEffect(() => {
    void window.writeflex.readingRoom
      .recentDocuments()
      .then(setRecents)
      .catch(() => { /* the history is a convenience; the library search is the guarantee */ })
  }, [focusToken])

  // Raising the Shelf over a live document competes with the reader for the keyboard, so the claim
  // retries until it sticks: without it `Search the Shelf` becomes a panel you must click into.
  useEffect(() => claimKeyboard(() => field.current), [focusToken])

  // Instant search: every keystroke asks the main-process index, coalesced so a fast typist issues
  // one query per pause rather than one per character. A stale reply can never overwrite a fresh one.
  useEffect(() => {
    const token = (request.current += 1)
    const timer = window.setTimeout(() => {
      void window.writeflex.readingRoom
        .searchShelf(query)
        .then((next) => {
          if (request.current !== token) return
          setResult(next)
          setCursor(0)
          setNotice(null)
        })
        .catch((error: unknown) => {
          if (request.current !== token) return
          onError(error instanceof Error ? error.message : String(error))
        })
    }, query === '' ? 0 : 110)
    return () => window.clearTimeout(timer)
  }, [onError, query])

  const rows = result?.rows ?? EMPTY.rows
  // Recents answer "the thing I was reading yesterday", which search cannot; they belong to the
  // BROWSE state, so typing a query replaces them with matches rather than pushing them down the page.
  // Not while citing: a recents entry is a reading, and a citation needs a Shelf row.
  const shownRecents = useMemo(
    () => (!citing && !query.trim() ? recents : NO_RECENTS),
    [citing, query, recents],
  )
  const stops = useMemo<Stop[]>(() => {
    const flattened: Stop[] = []
    for (const recent of shownRecents) {
      flattened.push({ kind: 'recent', recent })
    }
    for (const row of rows) {
      flattened.push({ kind: 'item', row })
      if (!citing && row.attachments.length > 1 && expanded.has(`${row.libraryId}:${row.itemKey}`)) {
        for (const attachment of row.attachments) {
          flattened.push({ attachmentKey: attachment.key, kind: 'attachment', row })
        }
      }
    }
    return flattened
  }, [citing, expanded, rows, shownRecents])

  const activeIndex = Math.min(cursor, Math.max(0, stops.length - 1))
  const active = stops[activeIndex] ?? null

  useEffect(() => {
    if (!active) return
    listRef.current
      ?.querySelector(`#${CSS.escape(stopId(active))}`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const toggle = useCallback((row: ShelfRow): void => {
    const key = `${row.libraryId}:${row.itemKey}`
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const activate = useCallback((stop: Stop): void => {
    setNotice(null)
    if (stop.kind === 'recent') {
      onOpenRecent(stop.recent)
      return
    }
    if (onCite) {
      onCite(stop.row)
      return
    }
    if (stop.kind === 'attachment') {
      const attachment = stop.row.attachments.find((entry) => entry.key === stop.attachmentKey)
      if (!attachment) return
      if (!attachment.openable) {
        setNotice(attachment.notice)
        return
      }
      onOpen(stop.row, attachment.key)
      return
    }
    // A chaptered book carries a dozen PDFs (494 items in this library hold more than one), so a
    // multi-file row opens its choices rather than guessing which file the reader meant.
    if (stop.row.attachments.length > 1) {
      toggle(stop.row)
      return
    }
    if (!stop.row.openable || !stop.row.attachmentKey) {
      setNotice(stop.row.notice)
      return
    }
    onOpen(stop.row, stop.row.attachmentKey)
  }, [onCite, onOpen, onOpenRecent, toggle])

  const onKeyDown = useCallback((event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      if (!onDismiss) return
      event.preventDefault()
      onDismiss()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setCursor((current) => Math.max(0, Math.min(stops.length - 1, current + step)))
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setCursor(event.key === 'Home' ? 0 : Math.max(0, stops.length - 1))
      return
    }
    if (!active) return
    if (event.key === 'Enter') {
      event.preventDefault()
      activate(active)
      return
    }
    if (active.kind === 'recent') return
    if (event.key === 'ArrowRight' && active.kind === 'item' && active.row.attachments.length > 1) {
      event.preventDefault()
      if (!expanded.has(`${active.row.libraryId}:${active.row.itemKey}`)) toggle(active.row)
      return
    }
    if (event.key === 'ArrowLeft' && active.row.attachments.length > 1) {
      event.preventDefault()
      if (expanded.has(`${active.row.libraryId}:${active.row.itemKey}`)) toggle(active.row)
    }
  }, [activate, active, expanded, onDismiss, stops.length, toggle])

  const counted = result === null
    ? 'Reading your Zotero library…'
    : `${result.total.toLocaleString('en-GB')} items · sort: ${query.trim() ? 'relevance' : 'title'}`
  const shown = result === null
    ? ''
    : rows.length === result.matched
      ? `${rows.length} shown`
      : `${rows.length} of ${result.matched.toLocaleString('en-GB')}`

  return (
    <div className="reading-room-shelf" onKeyDown={onKeyDown}>
      <div className="reading-room-shelf-filters">
        <div className="reading-room-shelf-field">
          <Search aria-hidden="true" />
          <input
            ref={field}
            type="search"
            role="combobox"
            aria-expanded={stops.length > 0}
            aria-controls="reading-room-shelf-list"
            aria-activedescendant={active ? stopId(active) : undefined}
            aria-label="Search the Shelf"
            placeholder="Search your Zotero library…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <span className="reading-room-shelf-count">{counted}</span>
      </div>
      <div className="reading-room-shelf-list" ref={listRef}>
        <div className="reading-room-shelf-bar">
          {citing ? 'Insert a reference' : 'The Shelf'}
          <span>{shown}</span>
        </div>
        {result?.error && (
          <p className="reading-room-shelf-notice" role="status">
            <CircleAlert aria-hidden="true" />
            {result.error}
          </p>
        )}
        {notice && (
          <p className="reading-room-shelf-notice" role="alert">
            <CircleAlert aria-hidden="true" />
            {notice}
          </p>
        )}
        {result && !result.error && rows.length === 0 && (
          <p className="reading-room-shelf-empty">
            {query.trim()
              ? `Nothing matches “${query.trim()}”. Try an author or a shorter phrase.`
              : 'Your Zotero library holds no citeable items yet.'}
          </p>
        )}
        <div id="reading-room-shelf-list" role="listbox" aria-label="The Shelf">
          {stops.map((stop, index) => {
            const isActive = index === activeIndex
            // Two visual bands in one flat listbox, so the arrow keys run straight through from the
            // recents into the library. The band labels are decoration for the eye; every option
            // still carries its own accessible name.
            const band = shownRecents.length === 0
              ? null
              : index === 0
                ? 'Recently opened'
                : stop.kind === 'item' && stops[index - 1]?.kind === 'recent'
                  ? 'Your library'
                  : null
            const withBand = (content: JSX.Element): JSX.Element => (band
              ? (
                <div key={`band-${stopId(stop)}`} role="presentation" className="reading-room-shelf-band">
                  <p className="reading-room-shelf-section" aria-hidden="true">{band}</p>
                  {content}
                </div>
              )
              : content)
            if (stop.kind === 'recent') {
              return withBand(
                <div
                  key={stopId(stop)}
                  id={stopId(stop)}
                  role="option"
                  aria-selected={isActive}
                  data-openable
                  className={`reading-room-shelf-row recent${isActive ? ' on' : ''}`}
                  onMouseDown={(event) => { event.preventDefault(); setCursor(index) }}
                  onClick={() => activate(stop)}
                >
                  <span className="reading-room-shelf-meta">
                    <Clock aria-hidden="true" />
                    <span className="reading-room-shelf-who">{stop.recent.authorYear}</span>
                    <span className="reading-room-shelf-kind">{whenRead(stop.recent.openedAt)}</span>
                  </span>
                  <span className="reading-room-shelf-title">{stop.recent.shortTitle}</span>
                </div>,
              )
            }
            if (stop.kind === 'attachment') {
              const attachment = stop.row.attachments.find((entry) => entry.key === stop.attachmentKey)!
              return withBand(
                <div
                  key={stopId(stop)}
                  id={stopId(stop)}
                  role="option"
                  aria-selected={isActive}
                  // NOT aria-disabled: the row IS actionable — activating it explains why it cannot
                  // be read (the badge carries that in the accessible name either way), and an
                  // aria-disabled option is inert to assistive tech and to the keyboard.
                  data-openable={attachment.openable}
                  title={attachment.notice ?? undefined}
                  className={`reading-room-shelf-row attachment${isActive ? ' on' : ''}${attachment.openable ? '' : ' closed'}`}
                  onMouseDown={(event) => { event.preventDefault(); setCursor(index) }}
                  onClick={() => activate(stop)}
                >
                  <span className="reading-room-shelf-meta">
                    {kindIcon(attachment.kind)}
                    <span className="reading-room-shelf-who">{attachment.title}</span>
                    <span className="reading-room-shelf-kind">{attachment.badge}</span>
                  </span>
                </div>,
              )
            }
            const open = stop.row.attachments.length > 1
              && expanded.has(`${stop.row.libraryId}:${stop.row.itemKey}`)
            return withBand(
              <div
                key={stopId(stop)}
                id={stopId(stop)}
                role="option"
                aria-selected={isActive}
                data-openable={citing ? true : stop.row.openable}
                title={stop.row.notice ?? undefined}
                aria-expanded={stop.row.attachments.length > 1 ? open : undefined}
                className={`reading-room-shelf-row${isActive ? ' on' : ''}${citing || stop.row.openable ? '' : ' closed'}`}
                onMouseDown={(event) => { event.preventDefault(); setCursor(index) }}
                onClick={() => activate(stop)}
              >
                <span className="reading-room-shelf-meta">
                  {/* A multi-file row keeps its kind icon as well as the disclosure: the mockup
                      distinguishes PDF from HTML snapshot by icon on every row. */}
                  {stop.row.attachments.length > 1
                    && (open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />)}
                  {kindIcon(stop.row.kind)}
                  <span className="reading-room-shelf-who">{stop.row.authorYear || stop.row.citationKey}</span>
                  <span className="reading-room-shelf-kind">{stop.row.badge}</span>
                </span>
                <span className="reading-room-shelf-title">{stop.row.title}</span>
              </div>,
            )
          })}
        </div>
      </div>
    </div>
  )
}

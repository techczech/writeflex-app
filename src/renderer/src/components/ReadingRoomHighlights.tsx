import { setEvidenceDrag, useEvidenceAttachmentTarget } from '../folio-evidence-transfer'
import type { EvidenceTransfer } from '../../../shared/folio-evidence-transfer'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CircleAlert, Search, SquareDashed, Tag, Users } from 'lucide-react'
import type { HighlightRow, HighlightsResult } from '../../../preload'
import { claimKeyboard } from './claim-keyboard'

export type ReadingRoomHighlightsProps = {
  evidenceSource?: { itemTarget: string; label: string; baseLink: string }
  /** Bumped whenever the view is raised, so the filter field takes the keyboard each time. */
  focusToken: number
  /** The document whose marks these are, for the section bar. */
  authorYear: string
  /** Shown above this document's highlights: the cross-document "Not sent to Zotero" list. */
  banner?: React.ReactNode
  /** Esc leaves the harvest. Absent when there is no document behind it to return to. */
  onDismiss: (() => void) | null
  onError: (message: string) => void
  /** Go to this mark in the reader, opening the document view if it is not showing. */
  onJump: (row: HighlightRow) => void
}

const EMPTY: HighlightsResult = { colours: [], error: null, forReader: [], rows: [], tags: [] }

/** Zotero's own swatch names, so a colour reads as a word to a screen reader. */
const COLOUR_NAMES: Record<string, string> = {
  '#ffd400': 'yellow',
  '#ff6666': 'red',
  '#5fb236': 'green',
  '#2ea8e5': 'blue',
  '#a28ae5': 'purple',
  '#e56eee': 'magenta',
  '#f19837': 'orange',
  '#aaaaaa': 'grey',
}

function colourName(colour: string): string {
  return COLOUR_NAMES[colour.toLowerCase()] ?? colour
}

function toggle(set: Set<string>, value: string): Set<string> {
  const next = new Set(set)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

/** The renderer's copy of the main-process filter. Kept identical in meaning to
 *  `matchesHighlightFilter` in `src/main/reading-room-highlights.ts`, which the unit tests pin. */
function matches(
  row: HighlightRow,
  query: string,
  colours: Set<string>,
  tags: Set<string>,
): boolean {
  if (colours.size > 0 && (!row.colour || !colours.has(row.colour))) return false
  if (tags.size > 0 && !row.tags.some((tag) => tags.has(tag))) return false
  const needle = query.trim().toLocaleLowerCase('en')
  if (!needle) return true
  const haystack = [row.body, row.comment ?? '', row.tags.join(' '), row.pageLabel ?? '']
    .join(' ')
    .toLocaleLowerCase('en')
  return needle.split(/\s+/).every((token) => haystack.includes(token))
}

export function ReadingRoomHighlights({
  evidenceSource,
  authorYear,
  banner,
  focusToken,
  onDismiss,
  onError,
  onJump,
}: ReadingRoomHighlightsProps): JSX.Element {
  const evidenceTarget = useEvidenceAttachmentTarget()
  const sourceFor = (row: HighlightRow): EvidenceTransfer | null => evidenceSource ? {
    kind: 'zotero', itemTarget: evidenceSource.itemTarget, label: evidenceSource.label, pending: !row.zoteroKey,
    ...(row.zoteroKey ? { annotation: { target: `${evidenceSource.baseLink}?annotation=${row.zoteroKey}`, label: row.pageLabel ? `${evidenceSource.label}, p. ${row.pageLabel}` : evidenceSource.label } } : {}),
  } : null

  const field = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const [result, setResult] = useState<HighlightsResult | null>(null)
  const [query, setQuery] = useState('')
  const [colours, setColours] = useState<Set<string>>(() => new Set())
  const [tags, setTags] = useState<Set<string>>(() => new Set())
  const [cursor, setCursor] = useState(0)

  useEffect(() => claimKeyboard(() => field.current), [focusToken])

  useEffect(() => {
    let live = true
    void window.writeflex.readingRoom
      .readHighlights()
      .then((next) => {
        if (!live) return
        setResult(next)
        setCursor(0)
      })
      .catch((error: unknown) => {
        if (!live) return
        onError(error instanceof Error ? error.message : String(error))
      })
    return () => { live = false }
  }, [focusToken, onError])

  const all = result?.rows ?? EMPTY.rows
  const rows = useMemo(
    () => all.filter((row) => matches(row, query, colours, tags)),
    [all, colours, query, tags],
  )

  const activeIndex = Math.min(cursor, Math.max(0, rows.length - 1))
  const active = rows[activeIndex] ?? null

  useEffect(() => {
    if (!active) return
    listRef.current
      ?.querySelector(`#${CSS.escape(`highlight-${active.key}`)}`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const onKeyDown = useCallback((event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      if (!onDismiss) return
      event.preventDefault()
      onDismiss()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setCursor((current) =>
        Math.max(0, Math.min(rows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1))))
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setCursor(event.key === 'Home' ? 0 : Math.max(0, rows.length - 1))
      return
    }
    if (event.key === 'Enter' && active) {
      event.preventDefault()
      onJump(active)
    }
  }, [active, onDismiss, onJump, rows.length])

  return (
    <div className="reading-room-highlights" onKeyDown={onKeyDown}>
      <div className="reading-room-shelf-filters">
        <div className="reading-room-shelf-field">
          <Search aria-hidden="true" />
          <input
            ref={field}
            type="search"
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls="reading-room-highlights-list"
            aria-activedescendant={active ? `highlight-${active.key}` : undefined}
            aria-label="Filter highlights"
            placeholder="Filter highlights…"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setCursor(0) }}
          />
        </div>
        <div className="reading-room-highlights-facets">
          {(result?.colours ?? []).map((colour) => (
            <button
              key={colour}
              type="button"
              className={`reading-room-highlights-swatch${colours.size === 0 || colours.has(colour) ? '' : ' off'}`}
              style={{ background: colour }}
              aria-pressed={colours.has(colour)}
              aria-label={`Only ${colourName(colour)} highlights`}
              title={`Only ${colourName(colour)} highlights`}
              onClick={() => { setColours((current) => toggle(current, colour)); setCursor(0) }}
            />
          ))}
          {(result?.tags ?? []).map((tag) => (
            <button
              key={tag}
              type="button"
              className={`reading-room-highlights-tag${tags.has(tag) ? ' on' : ''}`}
              aria-pressed={tags.has(tag)}
              onClick={() => { setTags((current) => toggle(current, tag)); setCursor(0) }}
            >
              <Tag aria-hidden="true" />
              {tag}
            </button>
          ))}
          <span className="reading-room-highlights-sort">sort: page ↓</span>
        </div>
      </div>
      <div className="reading-room-shelf-list" ref={listRef}>
        {banner}
        <div className="reading-room-shelf-bar">
          {authorYear ? `Highlights — ${authorYear}` : 'Highlights'}
          <span>{result === null ? '' : String(rows.length)}</span>
        </div>
        {result?.error && (
          <p className="reading-room-shelf-notice" role="status">
            <CircleAlert aria-hidden="true" />
            {result.error}
          </p>
        )}
        {result && !result.error && all.length === 0 && (
          <p className="reading-room-shelf-empty">
            No highlights in this document yet. Marks you make in the reader appear here.
          </p>
        )}
        {result && !result.error && all.length > 0 && rows.length === 0 && (
          <p className="reading-room-shelf-empty">
            Nothing matches this filter. Clear a colour, a tag, or the text.
          </p>
        )}
        <div id="reading-room-highlights-list" role="listbox" aria-label="Highlights">
          {rows.map((row, index) => (
            <div
              key={row.key}
              id={`highlight-${row.key}`}
              draggable={Boolean(evidenceSource)}
              onDragStart={event => { const source = sourceFor(row); if (source) setEvidenceDrag(event.dataTransfer, source) }}
              role="option"
              aria-selected={index === activeIndex}
              className={`reading-room-shelf-row${index === activeIndex ? ' on' : ''}`}
              title="Go to it"
              onMouseDown={(event) => { if (!evidenceSource) event.preventDefault(); setCursor(index) }}
              onClick={() => onJump(row)}
            >
              <span className="reading-room-shelf-meta">
                <span
                  className="reading-room-highlights-dot"
                  style={row.colour ? { background: row.colour } : undefined}
                  aria-hidden="true"
                />
                <span className="reading-room-shelf-who">
                  {row.pageLabel ? `p. ${row.pageLabel}` : 'no page'}
                </span>
                {row.bodyKind === 'mark' && <SquareDashed aria-hidden="true" />}
                {row.isExternal && <Users aria-hidden="true" />}
                {row.tags.map((tag) => (
                  <span key={tag} className="reading-room-highlights-tagmini">{tag}</span>
                ))}
                {row.keptHere && (
                  <span
                    className="reading-room-highlights-kept"
                    title="You edited this highlight here. The edit is saved in WriteFlex and is not sent to Zotero."
                  >
                    kept here, not yet in Zotero
                  </span>
                )}
              </span>
              <span className={`reading-room-shelf-title${row.bodyKind === 'quote' ? ' quote' : ''}`}>
                {row.bodyKind === 'quote' ? `“${row.body}”` : row.body}
              </span>
              {evidenceTarget && evidenceSource && <button type="button" className="fr-linkbtn" onMouseDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); const source = sourceFor(row); if (source) void evidenceTarget.attach(source) }}>Attach to {evidenceTarget.part}</button>}
              {row.comment && (
                <span className="reading-room-highlights-comment">{row.comment}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

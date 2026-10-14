import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { Library, Search, X } from 'lucide-react'
import { ARCHIVE_SCOPES, type ArchivePassageResponse, type ArchiveResult, type ArchiveScope, type ArchiveSearchResponse } from '../../../shared/scout'
import { createSequencer } from '../search-hits'
import { buildPassageModel, NO_WIDENING, selectedSpans, widen, widenedQuote, type Widening } from '../archive-passage'
import { archiveLinkMarkdown, archiveQuoteBlock, citationLineOf } from '../editor/archive-insert'

/** Long enough that a fast typist spawns one scout run, not one per keystroke. */
const SEARCH_DEBOUNCE_MS = 200

const SCOPE_LABELS: Record<ArchiveScope, string> = { all: 'All', writing: 'Writing', tweets: 'Tweets', highlights: 'Highlights' }
const SOURCE_BADGE: Record<string, { label: string; className: string }> = {
  writing: { label: 'Writing', className: 'w' },
  tweets: { label: 'Tweet', className: 'tw' },
  highlights: { label: 'Highlight', className: 'hl' },
}

type ArchiveSearchDockProps = {
  /** The chord that opens and closes the dock, for its header (⌃⌘F unless reassigned). */
  shortcut: string
  /** ⏎: insert the block into the draft as one edit. Returns false when there is no draft to insert into. */
  onInsertQuote: (result: ArchiveResult, block: string) => boolean
  /** ⌘⏎: insert the link only. */
  onInsertLink: (result: ArchiveResult, link: string) => boolean
  onClose: () => void
}

/** The one-line row's text: the piece title, a tweet's own words, or "Author · Title" for a highlight. */
function rowTitle(result: ArchiveResult): string {
  if (result.corpus === 'tweets') return result.quote
  if (result.corpus === 'highlights') return [result.author, result.title].filter(Boolean).join(' · ')
  return result.title
}

/** The row's trailing column: the date for writing and tweets, the source system for a highlight. */
function rowMeta(result: ArchiveResult): string {
  if (result.corpus === 'highlights' && result.source) return result.source[0].toUpperCase() + result.source.slice(1)
  return result.date ? result.date.slice(0, 10) : ''
}

/** The citation line as the draft will render it: `*Title*` in italics, `[label](url)` as link text. */
function renderCitationLine(line: string): ReactNode[] {
  const out: ReactNode[] = []
  const pattern = /\*([^*]+)\*|\[((?:\\.|[^\]])+)\]\((?:<[^>]*>|[^)\s]*)\)/g
  let cursor = 0
  let key = 0
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    if (match.index > cursor) out.push(line.slice(cursor, match.index))
    if (match[1] !== undefined) out.push(<em key={key++}>{match[1]}</em>)
    else out.push(<span key={key++} className="archive-link">{match[2].replace(/\\(.)/g, '$1')}</span>)
    cursor = match.index + match[0].length
  }
  if (cursor < line.length) out.push(line.slice(cursor))
  return out
}

/**
 * The archive search dock (WF-4B): a 460 px dock of its own, replacing both side panes while open.
 * Top: the query, the scope chips and a one-line-per-result list for scanning. Bottom: the passage in
 * context (the hit highlighted, ⇧↑/⇧↓ taking one more sentence) and exactly the block ⏎ will insert.
 * ⏎ inserts the quote and its citation, ⌘⏎ the link only; either closes the dock (App does). Every
 * result, passage and citation comes from the scout CLI through main; nothing is searched here.
 */
export default function ArchiveSearchDock({ shortcut, onInsertQuote, onInsertLink, onClose }: ArchiveSearchDockProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<ArchiveScope>('all')
  const [response, setResponse] = useState<ArchiveSearchResponse | null>(null)
  const [pending, setPending] = useState(false)
  const [selected, setSelected] = useState(0)
  const [passage, setPassage] = useState<ArchivePassageResponse | null>(null)
  const [widening, setWidening] = useState<Widening>(NO_WIDENING)
  const [notice, setNotice] = useState<string | null>(null)
  const searchSeq = useRef(createSequencer())
  const passageSeq = useRef(createSequencer())
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  // Live, debounced, race-guarded: a slow earlier scout run can never overwrite a later one.
  useEffect(() => {
    const trimmed = query.trim()
    const seq = searchSeq.current.begin()
    setNotice(null)
    if (!trimmed) {
      setResponse(null)
      setPending(false)
      return
    }
    setPending(true)
    const handle = setTimeout(() => {
      window.writeflex.archive.search({ query: trimmed, scope })
        .then((next) => {
          if (!searchSeq.current.isCurrent(seq)) return
          setResponse(next)
          setSelected(0)
          setPending(false)
        })
        .catch((error: unknown) => {
          if (!searchSeq.current.isCurrent(seq)) return
          setResponse({ status: 'error', message: error instanceof Error ? error.message : String(error) })
          setPending(false)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [query, scope])

  const results = response?.status === 'ok' ? response.results : []
  const current: ArchiveResult | null = results[selected] ?? null

  // The selected row's whole passage (scout cite) and, for writing, its neighbouring lines.
  useEffect(() => {
    const seq = passageSeq.current.begin()
    setPassage(null)
    setWidening(NO_WIDENING)
    if (!current) return
    window.writeflex.archive.passage(current.passageId)
      .then((next) => { if (passageSeq.current.isCurrent(seq)) setPassage(next) })
      .catch(() => { if (passageSeq.current.isCurrent(seq)) setPassage({ status: 'error', message: 'The passage could not be read.' }) })
  }, [current?.passageId])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.archive-row.on')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const model = useMemo(
    () => (current && passage?.status === 'ok' ? buildPassageModel(passage, current.quote) : null),
    [current, passage],
  )
  const quote = current ? (model ? widenedQuote(model, widening) : current.quote) : ''
  const block = current ? archiveQuoteBlock(current.citationMarkdown, current.quote, quote) : ''
  const citationLine = current ? citationLineOf(current.citationMarkdown) : null

  const insertQuote = (): void => {
    if (!current) return
    if (!onInsertQuote(current, block)) setNotice('Open a draft to insert into.')
  }
  const insertLink = (): void => {
    if (!current) return
    if (!onInsertLink(current, archiveLinkMarkdown(current))) setNotice('Open a draft to insert into.')
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    const onButton = (event.target as HTMLElement).tagName === 'BUTTON'
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !event.metaKey && !event.altKey && !event.ctrlKey) {
      event.preventDefault()
      const down = event.key === 'ArrowDown'
      if (event.shiftKey) setWidening((value) => widen(model, value, down ? 'after' : 'before'))
      else if (results.length > 0) setSelected((index) => Math.min(Math.max(index + (down ? 1 : -1), 0), results.length - 1))
    } else if (event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.shiftKey && !(onButton && !event.metaKey)) {
      event.preventDefault()
      event.stopPropagation()
      if (event.metaKey) insertLink()
      else insertQuote()
    }
  }

  return (
    <aside className="chrome-pane archive-dock" aria-label="Search the archive" onKeyDown={onKeyDown}>
      <div className="archive-head">
        <Library className="icon sm" aria-hidden="true" />
        <span>Search the archive</span>
        <span className="gap" />
        {shortcut && <kbd>{shortcut}</kbd>}
        <button type="button" className="x" aria-label="Close archive search" title="Close (esc)" onClick={onClose}><X className="icon sm" /></button>
      </div>
      <label className="archive-field">
        <Search className="icon sm" aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search your writing, tweets and highlights"
          aria-label="Search the archive"
          spellCheck={false}
        />
      </label>
      <div className="archive-scope" role="group" aria-label="Corpus">
        {ARCHIVE_SCOPES.map((entry) => (
          <button key={entry} type="button" className={entry === scope ? 'on' : ''} aria-pressed={entry === scope} onClick={() => { setScope(entry); inputRef.current?.focus() }}>
            {SCOPE_LABELS[entry]}
          </button>
        ))}
        <span className="archive-order">Best matches</span>
      </div>
      <div className="archive-list" ref={listRef} role="listbox" aria-label="Results">
        <DockListBody query={query} pending={pending} response={response} selected={selected} onPick={(index) => { setSelected(index); inputRef.current?.focus() }} onDoubleClick={insertQuote} />
      </div>
      {current && (
        <div className="archive-preview">
          <div className="archive-label">Passage<span className="archive-label-hint"><kbd>⇧↑</kbd> <kbd>⇧↓</kbd> take one more sentence</span></div>
          <div className="archive-context" aria-label="Passage in context">
            {model ? <ContextUnits model={model} widening={widening} /> : passage?.status === 'ok' ? passage.passage : current.quote}
          </div>
          <div className="archive-label">Will insert</div>
          <div className="archive-will" aria-label="Will insert" data-block={block}>
            <em>{quote}</em>
            {citationLine && <div className="archive-citation">{renderCitationLine(citationLine)}</div>}
          </div>
        </div>
      )}
      {notice && <div className="archive-notice" role="status">{notice}</div>}
      <div className="archive-actions">
        <button type="button" className="archive-btn pri" disabled={!current} onClick={insertQuote}>Insert quote + citation <kbd>⏎</kbd></button>
        <button type="button" className="archive-btn" disabled={!current} onClick={insertLink}>Insert link only <kbd>⌘⏎</kbd></button>
      </div>
    </aside>
  )
}

function ContextUnits({ model, widening }: { model: NonNullable<ReturnType<typeof buildPassageModel>>; widening: Widening }): JSX.Element {
  const spans = selectedSpans(model, widening)
  return (
    <>
      {model.units.map((text, unit) => {
        const span = spans.get(unit)
        const lead = unit < model.passageUnit ? '…' : ''
        const tail = unit > model.passageUnit ? '…' : ''
        return (
          <Fragment key={unit}>
            {unit > 0 && ' '}
            <span className={unit === model.passageUnit ? 'archive-unit passage' : 'archive-unit'}>
              {lead}
              {span ? <>{text.slice(0, span.from)}<span className="pick">{text.slice(span.from, span.to)}</span>{text.slice(span.to)}</> : text}
              {tail}
            </span>
          </Fragment>
        )
      })}
    </>
  )
}

function DockListBody({ query, pending, response, selected, onPick, onDoubleClick }: {
  query: string
  pending: boolean
  response: ArchiveSearchResponse | null
  selected: number
  onPick: (index: number) => void
  onDoubleClick: () => void
}): JSX.Element {
  if (response?.status === 'missing') {
    return (
      <div className="archive-empty" role="status">
        <b>The archive search needs the scout tool, which is not installed.</b>
        <p>Archive search needs a local search engine and index that are not included in this build. They are not available on this computer.</p>
      </div>
    )
  }
  if (response?.status === 'unavailable' || response?.status === 'error') {
    return (
      <div className="archive-empty" role="status">
        <b>{response.status === 'unavailable' ? 'The archive is not ready to search.' : 'The search did not run.'}</b>
        <p>{response.message}</p>
        {response.status === 'unavailable' && <p>Build the indexes with <code>scout index build</code>, then search again.</p>}
      </div>
    )
  }
  if (!query.trim()) {
    return (
      <div className="archive-empty hint">
        <p>Words match as prefixes and all must appear: <code>paths metaphor</code>. Also <code>"exact phrase"</code>, <code>-exclude</code>, <code>a OR b</code>, <code>after:2015</code>, <code>au:lakoff</code>.</p>
      </div>
    )
  }
  if (!response || response.status !== 'ok') return <div className="archive-empty hint"><p>{pending ? 'Searching…' : ''}</p></div>
  if (response.results.length === 0) return <div className="archive-empty hint"><p>Nothing in the archive matches <b>{response.query}</b>.</p></div>
  return (
    <>
      {response.results.map((result, index) => {
        const badge = SOURCE_BADGE[result.corpus] ?? { label: result.corpus, className: 'w' }
        return (
          <div
            key={`${result.passageId}`}
            className={index === selected ? 'archive-row on' : 'archive-row'}
            role="option"
            aria-selected={index === selected}
            onMouseDown={(event) => { event.preventDefault(); onPick(index) }}
            onDoubleClick={onDoubleClick}
          >
            <span className={`archive-src ${badge.className}`}>{badge.label}</span>
            <span className="archive-title">{rowTitle(result)}</span>
            <span className="archive-meta">{rowMeta(result)}</span>
          </div>
        )
      })}
    </>
  )
}

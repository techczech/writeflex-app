import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ChevronLeft, Search } from 'lucide-react'
import type { FolderFocus, SearchMatch } from '../../../preload'
import { createSequencer, scopeLabel } from '../search-hits'
import { SearchExcerpt, SearchResultList, type SearchResults } from './SearchResultList'

/** Debounce for the live search: long enough that a fast typist fires one workspace read, not one
 *  per keystroke; short enough to feel immediate. The sequencer below still guards the race. */
const SEARCH_DEBOUNCE_MS = 160

type SearchPanelProps = {
  /** Open the hit: App opens the tab, places the caret, and selects the match (jump-to-match). */
  onOpenHit: (match: SearchMatch) => void
  /** Dismiss the panel (Esc / the ⇧⌘F toggle / the header collapse control). */
  onClose: () => void
  /** The window's focused folder (ticket 03). While set, search defaults to it and a two-way switch
   *  widens to everywhere, both counts shown; with no focus the switch is absent. */
  focus?: FolderFocus | null
}

type ScopeSide = 'folder' | 'everywhere'

/**
 * Workspace-wide search (⇧⌘F / File ▸ Search Files…, PRD S20). A RAIL SWAP: it takes the sidebar
 * column's place rather than floating as a modal, so it is NOT behind the overlay guard — Esc is
 * scoped to this panel's own onKeyDown. Live search runs debounced; each run begins a new sequence
 * (search-hits.ts) and a response is dropped unless still current, so a slow earlier search can
 * never clobber a faster later one. Results are one row per piece, ranked by the backend
 * (SearchResultList). Focus stays in the input; arrows rove the rows; Enter opens the highlighted
 * piece at its best line; a click opens directly. With a focused folder (ticket 03) the search is
 * scoped to it, and a two-way switch — "This folder/folio/collection N" / "Everywhere N" — widens it.
 */
export default function SearchPanel({ onOpenHit, onClose, focus = null }: SearchPanelProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResults | null>(null) // null = the "type a query" hint
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState(0)
  const sequencerRef = useRef(createSequencer())
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const focusPath = focus?.path ?? null
  const [side, setSide] = useState<ScopeSide>('folder')
  // A new focus (or none) starts back on the focused folder: the default is always "here".
  useEffect(() => setSide('folder'), [focusPath])

  // Keyboard-first: the panel owns the keyboard the instant it swaps in.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Live, debounced, race-guarded search. begin() on every run (empty query included) supersedes any
  // in-flight request, whose late response would otherwise repopulate a panel the user has moved on from.
  useEffect(() => {
    const trimmed = query.trim()
    const seq = sequencerRef.current.begin()
    if (!trimmed) {
      setResults(null)
      setError(null)
      setPending(false)
      return
    }
    setPending(true)
    setError(null)
    const handle = setTimeout(() => {
      const searching = focusPath
        ? window.writeflex.searchWorkspace(trimmed, { scope: { folder: focusPath, results: side } })
        : window.writeflex.searchWorkspace(trimmed)
      searching
        .then((result) => {
          if (!sequencerRef.current.isCurrent(seq)) return
          setResults({ query: trimmed, matches: result.matches, total: result.total, note: result.note, scope: result.scope })
          setPending(false)
        })
        .catch((err: unknown) => {
          if (!sequencerRef.current.isCurrent(seq)) return
          setResults({ query: trimmed, matches: [], total: 0, note: undefined })
          setError(err instanceof Error ? err.message : String(err))
          setPending(false)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [query, focusPath, side])

  const flatHits = useMemo(() => results?.matches ?? [], [results])
  const selectedHit = flatHits[selected]

  // New results re-rank the list — start the highlight at the top again.
  useEffect(() => {
    setSelected(0)
  }, [results])

  // Keep the highlighted hit scrolled into view as arrows move it past the fold.
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected, flatHits])

  const openAt = useCallback(
    (index: number) => {
      const match = flatHits[index]
      if (match) onOpenHit(match)
    },
    [flatHits, onOpenHit],
  )

  function onInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected((s) => Math.min(s + 1, Math.max(0, flatHits.length - 1)))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      openAt(selected)
    }
    // Escape bubbles to the panel root (onPanelKeyDown) so it closes from the input or a hovered row.
  }

  function onPanelKeyDown(event: ReactKeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  return (
    <div className="search-panel" onKeyDown={onPanelKeyDown} aria-label="Search workspace">
      <div className="search-head">
        <span className="search-title">Search</span>
        <span className="spacer" />
        <button className="tbtn" title="Close search (Esc)" aria-label="Close search" onClick={onClose}>
          <ChevronLeft className="icon sm" />
        </button>
      </div>

      <div className="search-line">
        <div className="search-field">
          <Search className="icon sm" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={focus && side === 'folder' ? `Search ${scopeLabel(focus.kind).toLowerCase()}…` : 'Search every file…'}
            aria-label="Search query"
            spellCheck={false}
          />
          <kbd>esc</kbd>
        </div>
        {focus && (
          <div className="search-scope" role="group" aria-label="Search scope">
            {(['folder', 'everywhere'] as const).map((option) => {
              const counts = results?.scope?.folder === focus.path ? results.scope : undefined
              const count = option === 'folder' ? counts?.inFolder : counts?.everywhere
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={side === option}
                  title={option === 'folder' ? `Search only ${focus.path}` : 'Search the whole workspace'}
                  onClick={() => setSide(option)}
                >
                  {option === 'folder' ? scopeLabel(focus.kind) : 'Everywhere'}
                  {count !== undefined && <span className="n">{count}</span>}
                </button>
              )
            })}
          </div>
        )}
        <div className="search-hint">
          Words match anywhere in a piece. Try <code>"a phrase"</code>, <code>-word</code>, <code>/regex/</code>, or <code>tag:draft</code>.
        </div>
      </div>

      <div className="search-results" ref={listRef}>
        {pending ? (
          <div className="search-empty">Searching…</div>
        ) : results === null ? (
          <div className="search-empty">
            {focus && side === 'folder'
              ? `Type a query to search ${scopeLabel(focus.kind).toLowerCase()}, ${focus.path.split('/').at(-1)}.`
              : 'Type a query to search across the whole workspace.'}
          </div>
        ) : error ? (
          <div className="search-empty">Search failed: {error}</div>
        ) : results.matches.length === 0 ? (
          <div className="search-empty">
            No matches for <span className="search-q">{results.query}</span>.
          </div>
        ) : (
          <SearchResultList
            results={results}
            selected={selected}
            onHover={setSelected}
            onOpen={onOpenHit}
            folderBase={focus && results.scope?.results === 'folder' ? focus.path : undefined}
          />
        )}
      </div>
      <SearchExcerpt hit={selectedHit} />
    </div>
  )
}

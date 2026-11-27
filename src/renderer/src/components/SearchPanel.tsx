import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { SearchField } from './SearchField'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ChevronLeft } from 'lucide-react'
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
type SearchIdentity = { query: string; folder: string | null; side: ScopeSide }
type SearchOutcome = { results: SearchResults; error?: never } | { error: string; results?: never }

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
  const [reply, setReply] = useState<{ identity: SearchIdentity; outcome: SearchOutcome } | null>(null)
  const [selected, setSelected] = useState(0)
  const sequencerRef = useRef(createSequencer())
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const focusPath = focus?.path ?? null
  const [scope, setScope] = useState<{ folder: string | null; side: ScopeSide }>({ folder: focusPath, side: 'folder' })
  // A new focus starts on its folder before any search for that focus can run.
  if (scope.folder !== focusPath) setScope({ folder: focusPath, side: 'folder' })
  const side = focusPath === null ? 'everywhere' : scope.side
  const trimmed = query.trim()
  const identity = useMemo<SearchIdentity>(() => ({ query: trimmed, folder: focusPath, side }), [trimmed, focusPath, side])
  const current = reply?.identity === identity ? reply.outcome : null
  const results = current?.results
  const pending = Boolean(trimmed && !current)
  const hitCount = results?.matches.length ?? 0
  const selectedHit = results?.matches[selected]
  // Both counts describe the same query and folder, so they can stay visible across a side switch.
  const counts = reply?.identity.query === trimmed && reply.identity.folder === focusPath && reply.outcome.results?.scope?.folder === focusPath
    ? reply.outcome.results.scope
    : undefined

  // Keyboard-first: the panel owns the keyboard the instant it swaps in.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Retire the previous request in the same commit that hides its rows, including on clear.
  useLayoutEffect(() => {
    if (!identity.query) return
    const sequencer = sequencerRef.current
    const seq = sequencer.begin()
    const accept = (outcome: SearchOutcome): void => {
      if (!sequencer.isCurrent(seq)) return
      setReply({ identity, outcome })
      setSelected(0)
    }
    const handle = setTimeout(() => {
      const searching = identity.folder
        ? window.writeflex.searchWorkspace(identity.query, { scope: { folder: identity.folder, results: identity.side } })
        : window.writeflex.searchWorkspace(identity.query)
      void searching.then(
        (result) => accept({ results: { ...result, query: identity.query } }),
        (err: unknown) => accept({ error: err instanceof Error ? err.message : String(err) }),
      )
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(handle)
      sequencer.begin()
    }
  }, [identity])

  // Keep the highlighted hit scrolled into view as arrows move it past the fold.
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected, results])

  function onInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (hitCount > 0) setSelected((s) => Math.min(s + 1, hitCount - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (hitCount > 0) setSelected((s) => Math.max(s - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (selectedHit) onOpenHit(selectedHit)
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
    <div className="search-panel" onKeyDown={onPanelKeyDown} aria-label="Search vault">
      <div className="search-head">
        <span className="search-title">Search</span>
        <span className="spacer" />
        <button className="tbtn" title="Close search (Esc)" aria-label="Close search" onClick={onClose}>
          <ChevronLeft className="icon sm" />
        </button>
      </div>

      <div className="search-line">
        <SearchField
          ref={inputRef}
          wrapClassName="search-panel-field search-field"
          value={query}
          onValueChange={setQuery}
          onKeyDown={onInputKeyDown}
          placeholder={focus && side === 'folder' ? `Search ${scopeLabel(focus.kind).toLowerCase()}…` : 'Search every file…'}
          aria-label="Search query"
          clearLabel="Clear search"
        />
        {focus && (
          <div className="search-scope" role="group" aria-label="Search scope">
            {(['folder', 'everywhere'] as const).map((option) => {
              const count = option === 'folder' ? counts?.inFolder : counts?.everywhere
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={side === option}
                  title={option === 'folder' ? `Search only ${focus.path}` : 'Search the whole vault'}
                  onClick={() => {
                    if (side !== option) setScope({ folder: focusPath, side: option })
                  }}
                >
                  {option === 'folder' ? scopeLabel(focus.kind) : 'Everywhere'}
                  {count !== undefined && <span className="n">{count}</span>}
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className="search-results" ref={listRef}>
        {pending ? (
          <div className="search-empty">Searching…</div>
        ) : current === null ? (
          <div className="search-empty">
            {focus && side === 'folder'
              ? `Type a query to search ${scopeLabel(focus.kind).toLowerCase()}, ${focus.path.split('/').at(-1)}.`
              : 'Type a query to search across the whole vault.'}
          </div>
        ) : !current.results ? (
          <div className="search-empty">Search failed: {current.error}</div>
        ) : current.results.matches.length === 0 ? (
          <div className="search-empty">
            No matches for <span className="search-q">{current.results.query}</span>.
          </div>
        ) : (
          <SearchResultList
            results={current.results}
            selected={selected}
            onHover={setSelected}
            onOpen={onOpenHit}
            folderBase={focus && current.results.scope?.results === 'folder' ? focus.path : undefined}
          />
        )}
      </div>
      {hitCount > 0 && <SearchExcerpt hit={selectedHit} />}
    </div>
  )
}

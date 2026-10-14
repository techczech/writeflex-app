import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, CornerDownLeft, Folder, GripVertical, Plus, Search, StickyNote, Trash2, X } from 'lucide-react'
import type { Scrap, SourceFile } from '../../../preload'
import { writeScrapDrag } from '../editor/scraps'
import { SourcesSection } from './SourcesSection'

/** The tile dot palette (ADR-0008). Stored as hex so the SCRAPS.md `(colour)` mark stays clean on
 *  disk; amber + accent-blue match the locked mockup's dots. */
const SCRAP_COLOURS: Array<{ value: string; label: string }> = [
  { value: '#b97d10', label: 'Amber' },
  { value: '#2e6be6', label: 'Blue' },
  { value: '#3f9142', label: 'Green' },
  { value: '#c2405a', label: 'Rose' },
]

/** Scrap items carry the FULL workspace-relative origin path internally (so `a/notes.md` and `b/notes.md`
 *  never share a group); the pane shows the basename. */
const basenameOf = (origin: string): string => origin.split('/').pop() ?? origin
const stemOf = (origin: string): string => basenameOf(origin).replace(/\.(md|markdown|mdx)$/i, '')

type ScratchpadPaneProps = {
  scraps: Scrap[]
  /** Bumped by ⇧⌘J (and the tab open) to land the keyboard in the filter input. */
  focusTick: number
  onToggleDone: (id: string) => void
  onSetColour: (id: string, colour: string | null) => void
  onRemove: (id: string) => void
  /** Insert the scrap at the editor cursor and remove it — the keyboard path for drag-into-document. */
  onInsert: (scrap: Scrap) => void
  /** The mouse path for ⌘⇧X: cut the editor's current selection into a scrap. */
  onNewScrap: () => void
  /** Sources (Task 21): reference material under research/, listed below the cuttings. */
  sources: SourceFile[]
  /** Open a Markdown source in a tab. */
  onOpenSource: (path: string) => void
  /** Reveal a non-Markdown source in the OS file manager. */
  onRevealSource: (path: string) => void
}

/**
 * The Scratchpad pane (Task 20, ADR-0008, mockup `.scrap-list`): file-native cuttings grouped by origin
 * document, each a draggable tile with done / colour / delete / insert actions. Cut with ⌘⇧X, drag a
 * tile into the document to paste-and-remove, or type a `{trigger}` to expand an expandable. Stored
 * per piece in `scraps/<origin>-SCRAPS.md`.
 */
export function ScratchpadPane({
  scraps,
  focusTick,
  onToggleDone,
  onSetColour,
  onRemove,
  onInsert,
  onNewScrap,
  sources,
  onOpenSource,
  onRevealSource,
}: ScratchpadPaneProps): JSX.Element {
  const [filter, setFilter] = useState('')
  const filterRef = useRef<HTMLInputElement | null>(null)

  // ⇧⌘J lands the keyboard in the filter (the composer-focus pattern). focusTick is 0 for a cut,
  // which opens the tab but leaves the keyboard in the editor — so guard the zero.
  useEffect(() => {
    if (focusTick === 0) return
    filterRef.current?.focus()
  }, [focusTick])

  const q = filter.trim().toLowerCase()
  const matches = useMemo(
    () => (q ? scraps.filter((s) => s.text.toLowerCase().includes(q) || s.origin.toLowerCase().includes(q)) : scraps),
    [scraps, q],
  )
  // Group by origin, preserving first-seen order so the pane reads top-to-bottom like the file tree.
  const groups = useMemo(() => {
    const order: string[] = []
    const byOrigin = new Map<string, Scrap[]>()
    for (const scrap of matches) {
      if (!byOrigin.has(scrap.origin)) {
        byOrigin.set(scrap.origin, [])
        order.push(scrap.origin)
      }
      byOrigin.get(scrap.origin)!.push(scrap)
    }
    return order.map((origin) => ({ origin, items: byOrigin.get(origin)! }))
  }, [matches])

  const example = scraps[0] ? `${stemOf(scraps[0].origin)}-SCRAPS.md` : null

  return (
    <div className="rview">
      <div className="facet-row" style={{ padding: '10px 12px 6px' }}>
        <div className="facet-search">
          <Search className="icon sm" />
          <input
            ref={filterRef}
            type="text"
            value={filter}
            placeholder="Filter scraps"
            aria-label="Filter scraps"
            title="Filter scraps"
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <button className="facet" title="New scrap from the selection (⌘⇧X)" aria-label="New scrap from the selection" onClick={onNewScrap}>
          <Plus className="icon sm" />
        </button>
      </div>

      {scraps.length === 0 ? (
        <div className="rpane-empty">
          <StickyNote className="icon" />
          <p>
            Scratchpad holds scraps in <code>scraps/</code> — select text and press <kbd>⌘⇧X</kbd> to cut one.
          </p>
        </div>
      ) : (
        <div className="scrap-list">
          {groups.length === 0 ? (
            <div className="scrap-empty-filter">No scraps match “{filter}”.</div>
          ) : (
            groups.map((group) => (
              <div key={group.origin} className="scrap-group">
                <div className="scrap-sec" title={group.origin}>From {basenameOf(group.origin)}</div>
                {group.items.map((scrap) => (
                  <ScrapTile
                    key={scrap.id}
                    scrap={scrap}
                    onToggleDone={onToggleDone}
                    onSetColour={onSetColour}
                    onRemove={onRemove}
                    onInsert={onInsert}
                  />
                ))}
              </div>
            ))
          )}
        </div>
      )}

      <div className="scrap-foot">
        <Folder className="icon sm" />
        <span>
          Stored per piece in <strong>scraps/</strong>
          {example ? ` — e.g. ${example}` : ''}
        </span>
      </div>

      <SourcesSection sources={sources} onOpen={onOpenSource} onReveal={onRevealSource} />
    </div>
  )
}

function ScrapTile({
  scrap,
  onToggleDone,
  onSetColour,
  onRemove,
  onInsert,
}: {
  scrap: Scrap
  onToggleDone: (id: string) => void
  onSetColour: (id: string, colour: string | null) => void
  onRemove: (id: string) => void
  onInsert: (scrap: Scrap) => void
}): JSX.Element {
  const [swatchesOpen, setSwatchesOpen] = useState(false)

  function onDragStart(e: React.DragEvent): void {
    writeScrapDrag(e.dataTransfer, scrap)
  }

  // Card-level accelerators so a keyboard user need not tab into the actions row for the common ones.
  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.target !== e.currentTarget) return // a focused inner button owns its own keys
    if (e.key === 'Enter') {
      e.preventDefault()
      onInsert(scrap)
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault()
      onRemove(scrap.id)
    }
  }

  return (
    <div
      className={scrap.done ? 'scrap done' : 'scrap'}
      tabIndex={0}
      draggable
      data-scrap-id={scrap.id}
      onDragStart={onDragStart}
      onKeyDown={onKeyDown}
      aria-label={`Scrap: ${scrap.text}`}
    >
      {scrap.colour && <span className="sdot" style={{ background: scrap.colour }} aria-hidden="true" />}
      <div className="stext">
        {scrap.expandTrigger !== undefined && (
          <>
            <code>{`{${scrap.expandTrigger}}`}</code>{' '}
          </>
        )}
        {scrap.text}
        {scrap.expandTrigger !== undefined && <span className="sbadge">expandable</span>}
      </div>
      <div className="smeta">
        <GripVertical className="icon sm" aria-hidden="true" />
        <span>drag into the document</span>
        <span className="scrap-actions">
          <button
            className="scrap-act"
            title="Insert into the document (⏎)"
            aria-label="Insert into the document"
            onClick={() => onInsert(scrap)}
          >
            <CornerDownLeft className="icon sm" />
          </button>
          <button
            className={scrap.done ? 'scrap-act on' : 'scrap-act'}
            title={scrap.done ? 'Mark not done' : 'Mark done'}
            aria-label={scrap.done ? 'Mark not done' : 'Mark done'}
            aria-pressed={scrap.done}
            onClick={() => onToggleDone(scrap.id)}
          >
            <Check className="icon sm" />
          </button>
          <span className="scrap-colour">
            <button
              className="scrap-act"
              title="Colour"
              aria-label="Set colour"
              aria-expanded={swatchesOpen}
              onClick={() => setSwatchesOpen((open) => !open)}
            >
              <span className="scrap-dot-btn" style={scrap.colour ? { background: scrap.colour } : undefined} />
            </button>
            {swatchesOpen && (
              <span className="scrap-swatches" role="group" aria-label="Scrap colour">
                {SCRAP_COLOURS.map((c) => (
                  <button
                    key={c.value}
                    className="scrap-swatch"
                    style={{ background: c.value }}
                    title={c.label}
                    aria-label={`Mark ${c.label}`}
                    aria-pressed={scrap.colour === c.value}
                    onClick={() => {
                      onSetColour(scrap.id, scrap.colour === c.value ? null : c.value)
                      setSwatchesOpen(false)
                    }}
                  />
                ))}
                <button
                  className="scrap-swatch clear"
                  title="Clear colour"
                  aria-label="Clear colour"
                  onClick={() => {
                    onSetColour(scrap.id, null)
                    setSwatchesOpen(false)
                  }}
                >
                  <X className="icon sm" />
                </button>
              </span>
            )}
          </span>
          <button
            className="scrap-act danger"
            title="Delete scrap (⌫)"
            aria-label="Delete scrap"
            onClick={() => onRemove(scrap.id)}
          >
            <Trash2 className="icon sm" />
          </button>
        </span>
      </div>
    </div>
  )
}

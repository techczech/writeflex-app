import type { DragEvent } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { sourceKey, type BoardSource } from './board-projection'

/** The drag payload a source carries; only a card accepts it. */
export const SOURCE_DRAG_MIME = 'application/x-writeflex-source'

export const SOURCES_EMPTY_LEAD = 'This collection has no research notes yet. Add Markdown notes to a '
export const SOURCES_EMPTY_TAIL = ' folder in it, and they appear here.'

export type SourcesRailProps = {
  sources: BoardSource[]
  collapsed: boolean
  selectedKey: string | null
  /** The source picked up with the keyboard, waiting for a card. */
  carryingPath: string | null
  onToggle: () => void
  onSelect: (source: BoardSource) => void
  onOpen: (source: BoardSource) => void
  onDragStart: (event: DragEvent, source: BoardSource) => void
  onDragEnd: () => void
}

/** Who uses a source, as the rail's second line says it: the pieces' titles, else "not used yet". */
export function sourceUseLine(source: BoardSource, firstUnused: boolean): string {
  if (source.usedBy.length > 0) return source.usedBy.map((user) => user.title).join(' · ')
  return firstUnused ? 'not used yet · drag onto a card' : 'not used yet'
}

/**
 * The Sources rail (locked design frames 1, 7 and 8): the Collection's research notes, each with the
 * pieces that use it, an unused one dashed. Drag one onto a card to attach it. With none it says where
 * notes come from; collapsed it is a 28-pixel strip that opens it again.
 */
export function SourcesRail({ sources, collapsed, selectedKey, carryingPath, onToggle, onSelect, onOpen, onDragStart, onDragEnd }: SourcesRailProps): JSX.Element {
  const label = `Sources · ${sources.length}`
  if (collapsed) {
    return (
      <aside className="bsrc-rail collapsed" aria-label="Sources">
        <button type="button" className="bsrc-strip" aria-expanded="false" aria-label={`Show sources (${sources.length})`} title="Show sources" onClick={onToggle}>
          <span className="bsrc-ico"><ChevronLeft aria-hidden="true" /></span>
          <span className="bsrc-strip-lbl">{label}</span>
        </button>
      </aside>
    )
  }
  const firstUnused = sources.findIndex((source) => source.usedBy.length === 0)
  return (
    <aside className="bsrc-rail" aria-label="Sources">
      <div className="bsrc-head">
        <span className="bsrc-lbl">{label}</span>
        <button type="button" className="bsrc-ico" aria-expanded="true" aria-label="Hide sources" title="Hide sources" onClick={onToggle}>
          <ChevronRight aria-hidden="true" />
        </button>
      </div>
      {sources.length === 0 ? (
        <div className="bsrc-empty">{SOURCES_EMPTY_LEAD}<code>research/</code>{SOURCES_EMPTY_TAIL}</div>
      ) : (
        <div className="bsrc-list" role="list">
          {sources.map((source, index) => {
            const key = sourceKey(source)
            const unused = source.usedBy.length === 0
            return (
              <article
                key={key}
                role="listitem"
                className={`bsrc${unused ? ' unused' : ''}${selectedKey === key ? ' sel' : ''}${carryingPath === source.path ? ' carrying' : ''}`}
                draggable
                tabIndex={-1}
                data-source={source.path}
                title={source.path}
                onClick={() => onSelect(source)}
                onDoubleClick={() => onOpen(source)}
                onDragStart={(event) => onDragStart(event, source)}
                onDragEnd={onDragEnd}
              >
                <div className="bsrc-title">{source.title}</div>
                <div className="bsrc-p">{sourceUseLine(source, index === firstUnused)}</div>
                <div className="kbhint"><kbd>⌥←</kbd> attach to a card · <kbd>⏎</kbd> open note</div>
              </article>
            )
          })}
          <div className="bsrc-lbl bsrc-foot">From research/ in this collection</div>
        </div>
      )}
    </aside>
  )
}

/** While a source is carried with the keyboard: what it is waiting for, and how to let it go. */
export function SourceCarryHint({ source }: { source: BoardSource }): JSX.Element {
  return (
    <div className="board-activity bsrc-carry" role="status">
      <span className="ba-tick source">+</span>
      <span className="ba-text">Attaching “{source.title}”: choose a card and press <kbd>⏎</kbd> · <kbd>Esc</kbd> cancels</span>
    </div>
  )
}

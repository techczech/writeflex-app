import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown, Folder } from 'lucide-react'
import { matchCollectionRows, type CollectionRow } from '../../../shared/shelf-collections'

/**
 * The Shelf's collection filter: a chip plus a combobox popover over Zotero's collection tree.
 * Type to filter by name or parent path (two "Methods" collections stay distinguishable), arrows and
 * Enter to choose. Escape closes only the popover, and focus leaving the picker closes it too, so a
 * later Escape reaches the Shelf.
 */
export function ReadingRoomCollectionPicker({
  counts,
  onChoose,
  rows,
  selectedId,
}: {
  counts: ReadonlyMap<string, number>
  onChoose: (id: string | null) => void
  rows: CollectionRow[]
  selectedId: string | null
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [needle, setNeedle] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const optionId = (index: number): string => `${listId}-option-${index}`
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const selected = rows.find((row) => row.id === selectedId) ?? null
  const searching = needle.trim() !== ''
  const visible = useMemo(() => matchCollectionRows(rows, needle), [rows, needle])
  const entries: (CollectionRow | null)[] = [null, ...visible]

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [active, open])

  const closeWithoutFocus = (): void => {
    setOpen(false)
    setNeedle('')
  }
  const close = (): void => {
    closeWithoutFocus()
    buttonRef.current?.focus()
  }
  const choose = (id: string | null): void => {
    onChoose(id)
    closeWithoutFocus()
  }
  const openPopover = (): void => {
    const index = selectedId ? rows.findIndex((row) => row.id === selectedId) + 1 : 0
    setActive(Math.max(index, 0))
    setOpen(true)
  }

  return (
    <div
      className="reading-room-collection-picker"
      onBlur={(event) => {
        if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) closeWithoutFocus()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          event.stopPropagation()
          close()
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={selected ? 'active' : ''}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Collection: ${selected?.name ?? 'All collections'}`}
        title={selected?.path}
        data-testid="shelf-collection-picker"
        onClick={() => (open ? close() : openPopover())}
        onKeyDown={(event) => {
          // Enter and Space press this button; the Shelf behind it must not also activate the current
          // row (which would cite or open a paper). The default action (a click) is left alone.
          if (['Enter', ' ', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) event.stopPropagation()
        }}
      >
        <Folder aria-hidden="true" />
        <span className="reading-room-collection-label">{selected?.name ?? 'All collections'}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      {open && (
        <div className="reading-room-collection-popover">
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={optionId(active)}
            aria-label="Filter collections"
            placeholder="Filter collections…"
            value={needle}
            onChange={(event) => { setNeedle(event.target.value); setActive(0) }}
            onKeyDown={(event) => {
              // The Shelf behind this popover also listens for arrows and Enter; they are the popover's here.
              if (event.key === 'ArrowDown') {
                event.preventDefault(); event.stopPropagation()
                setActive((index) => Math.min(index + 1, entries.length - 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault(); event.stopPropagation()
                setActive((index) => Math.max(index - 1, 0))
              } else if (event.key === 'Enter') {
                event.preventDefault(); event.stopPropagation()
                const entry = entries[active]
                if (entry !== undefined) choose(entry ? entry.id : null)
              } else if (event.key === 'Home' || event.key === 'End') {
                event.stopPropagation()
              }
            }}
          />
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Collections"
            className="reading-room-collection-list"
            onMouseDown={(event) => event.preventDefault()}
          >
            {entries.map((entry, index) => (
              <div
                key={entry?.id ?? 'all'}
                id={optionId(index)}
                role="option"
                aria-selected={(entry?.id ?? null) === selectedId}
                data-active={index === active}
                data-testid="shelf-collection-option"
                className="reading-room-collection-option"
                style={{ paddingLeft: 10 + (entry && !searching ? entry.depth * 14 : 0) }}
                onClick={() => choose(entry ? entry.id : null)}
                onMouseMove={() => setActive(index)}
              >
                <span className="reading-room-collection-name">{entry ? entry.name : 'All collections'}</span>
                {entry && searching && entry.parentPath
                  ? <span className="reading-room-collection-path">{entry.parentPath}</span>
                  : null}
                {entry && counts.has(entry.id)
                  ? <span className="reading-room-collection-count">{counts.get(entry.id)}</span>
                  : null}
              </div>
            ))}
            {visible.length === 0 && <p className="reading-room-collection-none">No matching collections.</p>}
          </div>
        </div>
      )}
    </div>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { ChevronLeft, ChevronRight, Minus, RotateCcw, Search, SlidersHorizontal, X } from 'lucide-react'
import { ACTION_BAR_SEPARATOR } from '../../../shared/action-bar-settings'
import { ActionBarConfigureRow } from './ActionBarConfigureRow'
import {
  addToBar,
  availableActiveIndex,
  availableRows,
  barRows,
  drawnCommandCount,
  drawnGroupCount,
  dropIndexFor,
  filterCommands,
  insertSeparator,
  moveTo,
  removeFromBar,
  type ConfigureCommand,
  type ConfigureRow,
} from './action-bar-configure'

/**
 * The configure sheet (ADR-0040, the drawing's CONFIGURE SHEET frame): everything the app can do on
 * the left, the bar's commands in order on the right, separators draggable as items so the grouping
 * stays the writer's. One surface, reached from Settings → Action bar AND from the bar's own
 * configure control — the same component either way, so the two can never diverge.
 *
 * FULLY OPERABLE FROM THE KEYBOARD. Drag is an affordance, never the only path: every edit a drag
 * can make has a key, both call the same model functions in `action-bar-configure.ts`, and the two
 * lists are single tab stops the arrows move inside (the listbox pattern), so the sheet is five tab
 * stops rather than forty.
 *
 *   Tab            search field → every command → the three middle buttons → on the bar → footer
 *   ↑ ↓            move within a list · Home / End its ends
 *   → or ↵         put the selected command (or a separator) on the bar, after the bar's active row
 *   ← ⌫ ⌦          take the bar's active row off the bar
 *   ⌃⌘↑ ⌃⌘↓        move the bar's active row up or down — the app's structure family, "move the thing"
 *   ⎋              close
 *
 * Every change is written the moment it is made — there is no Save, so there is nothing to lose by
 * closing the sheet, and the bar behind it redraws as you work. Because the list is one global
 * setting, a second window redraws with it.
 */

export type ActionBarConfigureSheetProps = {
  /** The bar's stored list: command ids and separators, in order. */
  items: readonly string[]
  /** Every command the app can run right now — the palette's own rows. */
  commands: readonly ConfigureCommand[]
  /** Persist a new list. Called on every edit; there is no Save button. */
  onChange: (items: string[]) => void
  /** Forget the stored list, so the bar returns to the drawn default. */
  onReset: () => void
  onClose: () => void
}

type ListName = 'available' | 'bar'

export function ActionBarConfigureSheet({ items, commands, onChange, onReset, onClose }: ActionBarConfigureSheetProps): JSX.Element {
  const [query, setQuery] = useState('')
  // null means "wherever the rule puts it" (`availableActiveIndex`): the row the writer's search
  // just made the top match. Typing in the search field returns to null, so a search followed by
  // Enter always adds what was searched for; the arrows then pin a row by number.
  const [availableAt, setAvailableAt] = useState<number | null>(null)
  // The bar list opens on its LAST row, so a command added without touching it lands at the end —
  // the obvious meaning of "add this to my bar" before any position has been chosen.
  const [barAt, setBarAt] = useState(Number.MAX_SAFE_INTEGER)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const [note, setNote] = useState('')

  const commandsById = useMemo(() => new Map(commands.map((command) => [command.id, command])), [commands])
  const bar = useMemo(() => barRows(items, commandsById), [items, commandsById])
  const available = useMemo(() => availableRows(filterCommands(commands, query), items, query), [commands, items, query])

  const barIndex = Math.max(0, Math.min(barAt, bar.length - 1))
  const availableIndex = availableAt === null
    ? availableActiveIndex(available)
    : Math.max(0, Math.min(availableAt, available.length - 1))

  const searchRef = useRef<HTMLInputElement | null>(null)
  const rowRefs = useRef<Record<ListName, Array<HTMLDivElement | null>>>({ available: [], bar: [] })
  const dragRef = useRef<{ list: ListName; row: ConfigureRow } | null>(null)
  // Where the drop would land. The REF is the truth and the state is only the insertion line the
  // writer sees: dragover and drop can arrive in the same task, and a state update React has not
  // yet flushed would make the drop read a stale target and do nothing.
  const dropAtRef = useRef<number | null>(null)
  const pendingFocus = useRef<{ list: ListName; at: number } | null>(null)

  useEffect(() => searchRef.current?.focus(), [])

  // Focus follows the item a keyboard edit moved, so a run of ⌃⌘↓ keeps pushing the SAME row down
  // rather than walking away from it. Runs after the list has re-rendered with its new order.
  useEffect(() => {
    const target = pendingFocus.current
    if (!target) return
    pendingFocus.current = null
    rowRefs.current[target.list][target.at]?.focus()
  })

  /** Where a new item goes: after the bar's active row, or at the end when the bar is empty. */
  const insertionPoint = useCallback(
    (): number => (bar.length === 0 ? items.length : bar[barIndex].index + 1),
    [bar, barIndex, items.length],
  )

  /** Commit a new list, then put the keyboard on the row the edit was about. */
  const commit = useCallback(
    (next: string[], focus?: (rows: ConfigureRow[]) => number): void => {
      onChange(next)
      if (!focus) return
      const rows = barRows(next, commandsById)
      const at = Math.max(0, Math.min(rows.length - 1, focus(rows)))
      setBarAt(at)
      pendingFocus.current = { list: 'bar', at }
    },
    [commandsById, onChange],
  )

  const addRow = useCallback(
    (row: ConfigureRow): void => {
      const at = insertionPoint()
      if (row.kind === 'separator') {
        const next = insertSeparator(items, at)
        if (next.length === items.length) {
          setNote('There is already a group boundary there.')
          return
        }
        setNote('Separator added.')
        commit(next, (rows) => rows.findIndex((candidate) => candidate.kind === 'separator' && candidate.index === at))
        return
      }
      setNote(row.onBar ? `${row.label} moved.` : `${row.label} added to the bar.`)
      commit(addToBar(items, row.commandId, at), (rows) =>
        rows.findIndex((candidate) => candidate.kind === 'command' && candidate.commandId === row.commandId))
    },
    [commit, insertionPoint, items],
  )

  const removeActive = useCallback((): void => {
    const row = bar[barIndex]
    if (!row) return
    const next = removeFromBar(items, row.index, commandsById)
    if (next.length === items.length) {
      setNote('The bar keeps at least one command — hide the bar instead.')
      return
    }
    setNote(row.kind === 'separator' ? 'Separator removed.' : `${row.label} taken off the bar.`)
    commit(next, () => barIndex)
  }, [bar, barIndex, commandsById, commit, items])

  /** Move the bar's active row one VISIBLE place, stepping over any stored id this build cannot draw. */
  const moveActive = useCallback(
    (delta: -1 | 1): void => {
      const row = bar[barIndex]
      const neighbour = bar[barIndex + delta]
      if (!row || !neighbour) return
      setNote(delta > 0 ? 'Moved down.' : 'Moved up.')
      commit(moveTo(items, row.index, delta > 0 ? neighbour.index + 1 : neighbour.index), () => barIndex + delta)
    },
    [bar, barIndex, commit, items],
  )

  const listKeys = useCallback(
    (list: ListName) =>
      (event: KeyboardEvent<HTMLDivElement>): void => {
        const rows = list === 'bar' ? bar : available
        const at = list === 'bar' ? barIndex : availableIndex
        // Navigation does not reorder anything, so the row to focus is already on screen: focus it
        // NOW rather than through pendingFocus, which only fires after a re-render — and pressing ↑
        // at the top of a list changes no state, so there would be no re-render to fire it.
        const move = (to: number): void => {
          event.preventDefault()
          const clamped = Math.max(0, Math.min(rows.length - 1, to))
          if (list === 'bar') setBarAt(clamped)
          else setAvailableAt(clamped)
          pendingFocus.current = null
          rowRefs.current[list][clamped]?.focus()
        }
        switch (event.key) {
          case 'ArrowDown':
            // ⌃⌘↓ is the app's "move the thing" gesture (the structure family), not navigation.
            if (list === 'bar' && event.ctrlKey && event.metaKey) {
              event.preventDefault()
              moveActive(1)
              return
            }
            move(at + 1)
            return
          case 'ArrowUp':
            if (list === 'bar' && event.ctrlKey && event.metaKey) {
              event.preventDefault()
              moveActive(-1)
              return
            }
            move(at - 1)
            return
          case 'Home':
            move(0)
            return
          case 'End':
            move(rows.length - 1)
            return
          case 'Enter':
          case 'ArrowRight':
            if (list !== 'available') return
            event.preventDefault()
            if (rows[at]) addRow(rows[at])
            return
          case 'Backspace':
          case 'Delete':
          case 'ArrowLeft':
            if (list !== 'bar') return
            event.preventDefault()
            removeActive()
            return
          default:
        }
      },
    [addRow, available, availableIndex, bar, barIndex, moveActive, removeActive],
  )

  // ---- Dragging: the drawn affordance, over exactly the same model functions --------------------

  const startDrag = (list: ListName, row: ConfigureRow) => (event: DragEvent): void => {
    dragRef.current = { list, row }
    event.dataTransfer.effectAllowed = 'move'
    // dataTransfer cannot be READ during dragover, so the payload also lives in a ref; this copy is
    // what makes the drag legible to anything outside the sheet.
    event.dataTransfer.setData('text/plain', row.kind === 'separator' ? ACTION_BAR_SEPARATOR : row.commandId)
  }

  const overBar = (event: DragEvent): void => {
    if (!dragRef.current) return
    event.preventDefault()
    const rects = rowRefs.current.bar.slice(0, bar.length).map((node) => {
      const rect = node?.getBoundingClientRect()
      return { top: rect?.top ?? 0, height: rect?.height ?? 0 }
    })
    dropAtRef.current = dropIndexFor(rects, event.clientY)
    setDropAt(dropAtRef.current)
  }

  const dropOnBar = (event: DragEvent): void => {
    const drag = dragRef.current
    const target = dropAtRef.current
    dragRef.current = null
    dropAtRef.current = null
    setDropAt(null)
    if (!drag || target === null) return
    event.preventDefault()
    // The drop target is a ROW position; the edit happens in the STORED list underneath it.
    const storedAt = target >= bar.length ? items.length : bar[target].index
    if (drag.list === 'bar') {
      const from = bar.findIndex((row) => row.index === drag.row.index)
      setNote('Moved.')
      commit(moveTo(items, drag.row.index, storedAt), () => (target > from ? target - 1 : target))
      return
    }
    if (drag.row.kind === 'separator') {
      setNote('Separator added.')
      commit(insertSeparator(items, storedAt), (rows) =>
        rows.findIndex((candidate) => candidate.kind === 'separator' && candidate.index === storedAt))
      return
    }
    const commandId = drag.row.commandId
    setNote(`${drag.row.label} added to the bar.`)
    commit(addToBar(items, commandId, storedAt), (rows) =>
      rows.findIndex((candidate) => candidate.kind === 'command' && candidate.commandId === commandId))
  }

  const dropOnAvailable = (event: DragEvent): void => {
    const drag = dragRef.current
    dragRef.current = null
    dropAtRef.current = null
    setDropAt(null)
    if (!drag || drag.list !== 'bar') return
    event.preventDefault()
    const next = removeFromBar(items, drag.row.index, commandsById)
    if (next.length === items.length) {
      setNote('The bar keeps at least one command — hide the bar instead.')
      return
    }
    onChange(next)
    setNote(drag.row.kind === 'separator' ? 'Separator removed.' : `${drag.row.label} taken off the bar.`)
  }

  const renderRow = (list: ListName, row: ConfigureRow, at: number, activeAt: number): JSX.Element => (
    <ActionBarConfigureRow
      key={`${row.key}:${at}`}
      row={row}
      active={at === activeAt}
      {...(list === 'bar' && dropAt === at ? { dropBefore: true } : {})}
      onSelect={() => (list === 'bar' ? setBarAt(at) : setAvailableAt(at))}
      onActivate={() => (list === 'bar' ? removeActive() : addRow(row))}
      onDragStart={startDrag(list, row)}
      registerRef={(node) => {
        rowRefs.current[list][at] = node
      }}
    />
  )

  return (
    <div className="overlay abcfg-overlay" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="sheet abcfg"
        role="dialog"
        aria-modal="true"
        aria-label="Action bar"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }}
      >
        <div className="abcfg-head">
          <SlidersHorizontal className="icon" aria-hidden="true" />
          <b>Action bar</b>
          <span className="sub">
            {/* Both counts describe the rows the bar DRAWS — the same rows this sheet just listed —
                not the stored ids, which can name a command this build has no feature for. */}
            {commands.length} commands available · {drawnCommandCount(bar)} on the bar · {drawnGroupCount(bar)} groups
          </span>
          <button type="button" className="abcfg-x" aria-label="Close" title="Close (⎋)" onClick={onClose}>
            <X className="icon sm" aria-hidden="true" />
          </button>
        </div>

        <div className="abcfg-cols">
          <div className="abcfg-col">
            <h6 id="abcfg-available-label">Every command</h6>
            <div className="abcfg-search">
              <Search className="icon sm" aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                placeholder="Search commands"
                aria-label="Search commands"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setAvailableAt(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    // ↓ lands on the row Enter would have added, so ↓-then-Enter and Enter alone
                    // can never mean two different things.
                    event.preventDefault()
                    setAvailableAt(availableIndex)
                    rowRefs.current.available[availableIndex]?.focus()
                  } else if (event.key === 'Enter' && available[availableIndex]) {
                    event.preventDefault()
                    addRow(available[availableIndex])
                  }
                }}
              />
            </div>
            <div
              className="abcfg-list"
              role="listbox"
              aria-labelledby="abcfg-available-label"
              onKeyDown={listKeys('available')}
              onDragOver={(event) => dragRef.current?.list === 'bar' && event.preventDefault()}
              onDrop={dropOnAvailable}
            >
              {available.map((row, at) => renderRow('available', row, at, availableIndex))}
            </div>
          </div>

          <div className="abcfg-col mid">
            <button
              type="button"
              className="abcfg-ib"
              aria-label="Put the selected command on the bar"
              title="Put the selected command on the bar (→)"
              onClick={() => available[availableIndex] && addRow(available[availableIndex])}
            >
              <ChevronRight className="icon sm" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="abcfg-ib"
              aria-label="Take the selected command off the bar"
              title="Take the selected command off the bar (←)"
              onClick={removeActive}
            >
              <ChevronLeft className="icon sm" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="abcfg-ib"
              aria-label="Add a separator"
              title="Add a separator after the bar’s selected row"
              onClick={() => addRow({ kind: 'separator', key: 'new-separator', index: -1 })}
            >
              <Minus className="icon sm" aria-hidden="true" />
            </button>
          </div>

          <div className="abcfg-col">
            <h6 id="abcfg-bar-label">On the bar — in this order</h6>
            <div
              className="abcfg-list"
              role="listbox"
              aria-labelledby="abcfg-bar-label"
              onKeyDown={listKeys('bar')}
              onDragOver={overBar}
              onDragLeave={() => {
                dropAtRef.current = null
                setDropAt(null)
              }}
              onDrop={dropOnBar}
            >
              {bar.map((row, at) => renderRow('bar', row, at, barIndex))}
              <div className={`abcfg-end${dropAt !== null && dropAt >= bar.length ? ' drop-before' : ''}`} aria-hidden="true" />
            </div>
          </div>
        </div>

        <div className="abcfg-foot">
          <span className="keyhint">
            <kbd>↑</kbd>
            <kbd>↓</kbd> move · <kbd>→</kbd> add · <kbd>←</kbd> remove · <kbd>⌃⌘↑</kbd>
            <kbd>⌃⌘↓</kbd> reorder
          </span>
          <span className="sp" />
          <span className="abcfg-note" role="status" aria-live="polite">
            {note}
          </span>
          <button type="button" className="btn" onClick={() => { onReset(); setNote('Back to the default set.') }}>
            <RotateCcw className="icon sm" aria-hidden="true" />
            Reset to the default set
          </button>
          <button type="button" className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

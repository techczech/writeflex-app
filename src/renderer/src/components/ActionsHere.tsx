import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Command, Search } from 'lucide-react'
import type { EditorState } from '@codemirror/state'
import { AGENT_ICON, AGENT_ICON_CLASS } from './agent-icon'
import {
  ACTIONS_HERE_TEXT as TEXT,
  DIAGRAM_ROWS,
  INSERT_OPENER,
  actionLayoutAt,
  allCommandsChord,
  filterActionGroups,
  insertObjectRows,
  hereCount,
  type ActionGroup,
  type ActionRow,
  type PanelView,
} from '../commands/actions-here'
import type { OverrideMap } from '../commands/chords'
import { placeLabel, type Place } from '../commands/place'
import { INSERT_GROUP } from '../commands/command-places'
import { placeFlyout, type Rect } from '../commands/flyout-position'

/**
 * Actions here (ADR-0043, ticket 03): the one ⌘K panel. It stands at the caret or at the row, lists
 * what `actionsAt` lists for the place (never a list of its own), and swaps to the object list for
 * "Insert object…". The surfaces that own a place (the editor, the Files pane, the Outline) render
 * <ActionsHere> where their old menu was and pass the one thing only they can do: run the rows that
 * act on their own state. Every other row is run by App through the command palette's dispatch.
 */
export type ActionsHereApi = {
  /** Run a command exactly as the palette runs it. False when no command has that id. */
  runCommand: (id: string) => boolean
  /** Whether `runCommand` can run this command from here (the keyboard sheet's Run action asks). */
  canRun?: (id: string) => boolean
  /** Open the command palette with this text typed in it. */
  openPalette: (query: string) => void
  overrides: OverrideMap
  /** The editor's state, which commands' `when` is asked about; null with no document. */
  editorState: () => EditorState | null
}

const NO_API: ActionsHereApi = { runCommand: () => false, openPalette: () => {}, overrides: {}, editorState: () => null }
export const ActionsHereContext = createContext<ActionsHereApi>(NO_API)
export const useActionsHere = (): ActionsHereApi => useContext(ActionsHereContext)

const PANEL_WIDTH = 340
const EDGE = 8

export type ActionsHereProps = {
  x: number
  y: number
  place: Place
  /** Open on the object list (the backtick trigger) instead of the place's rows. */
  startView?: PanelView
  /** Rows the surface runs itself. Return true when it did; the surface then also closes the panel. */
  runHere?: (id: string) => boolean
  /** Rows listed first in the Insert object list although the place does not list them. */
  insertExtras?: ActionRow[]
  /** Rows of the surface's own, drawn as a group after the place's first group (the vault sidebar's Pin / Unpin). Run through `runHere`. */
  extraRows?: ActionRow[]
  /** Escape or a click away is 'dismiss'; running a row that App runs is 'ran'. */
  onClose: (reason: 'dismiss' | 'ran') => void
}

export function ActionsHere({ x, y, place, startView = 'here', runHere, insertExtras = [], extraRows, onClose }: ActionsHereProps): JSX.Element {
  const api = useActionsHere()
  const [query, setQuery] = useState('')
  const [hi, setHi] = useState(0)
  // The lists open beside the panel, one inside the other: stack[0] is the opener row of the main panel whose list stands
  // beside it, stack[1] the opener row of that list whose list stands beside the second (Insert object → Flow diagram).
  // `the user's[n]` is the highlighted row of list n; `objQuery` the Insert object list's own filter. The Format strip's cell
  // that has the keyboard is `stripHi`.
  const [stack, setStack] = useState<ActionRow[]>(() => (startView === 'insert' ? [INSERT_OPENER] : []))
  const [his, setHis] = useState<number[]>([0, 0])
  const [objQuery, setObjQuery] = useState('')
  const [places, setPlaces] = useState<Array<{ left: number; top: number }>>([])
  const panelRefs = useRef<Array<HTMLDivElement | null>>([])
  const [stripHi, setStripHi] = useState<number | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  // Once the panel has been closed or a row has run, the focus it loses on its way out is not a click away.
  const done = useRef(false)

  const overrides = api.overrides
  const layout = useMemo(() => actionLayoutAt(place, api.editorState(), overrides), [place, api, overrides])
  const objects = useMemo(() => [...insertExtras, ...insertObjectRows(overrides)], [insertExtras, overrides])
  // The strip is drawn above the filter while nothing is typed; once something is typed its cells are rows like any other.
  const showStrip = query === '' && layout.strip.length > 0
  const groups: ActionGroup[] = useMemo(() => {
    const base = extraRows && extraRows.length > 0 ? [...layout.groups.slice(0, 1), { name: '', rows: extraRows }, ...layout.groups.slice(1)] : layout.groups
    const withStrip = query !== '' && layout.strip.length > 0 ? [...base, { name: '', rows: layout.strip }] : base
    return filterActionGroups(withStrip, query, objects)
  }, [layout, objects, query, extraRows])
  const flat = useMemo(() => groups.flatMap((group) => group.rows.filter((row) => !row.inert)), [groups])
  const panelGroups: ActionGroup[][] = stack.map((row) =>
    row.opens === 'insert' ? filterActionGroups([{ name: INSERT_GROUP, rows: objects }], objQuery)
      : row.opens === 'diagram' ? [{ name: '', rows: [...DIAGRAM_ROWS] }]
        : row.children ?? [])
  const panelFlat: ActionRow[][] = panelGroups.map((list) => list.flatMap((group) => group.rows.filter((row) => !row.inert)))
  const allIndex = flat.length
  const paletteChord = allCommandsChord(overrides)

  useLayoutEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => { setHi(0); setStripHi(null) }, [query])
  /** A new filter text: the first row is highlighted in the same render, not a render later (Return right after typing must run the first row, not the one the pointer last rested on). */
  function typeQuery(next: string): void {
    setQuery(next)
    setHi(0)
    setStripHi(null)
    setStack([])
  }
  // Opening a list moves the keyboard into it (its filter, or its first row); closing one is done by closeDeepest, which moves it back first.
  useEffect(() => { if (stack.length > 0) focusPanel(stack.length - 1) }, [stack.length, stack[stack.length - 1]?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    rootRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
    for (const box of panelRefs.current) box?.querySelector('.ak-row.sel')?.scrollIntoView?.({ block: 'nearest' })
  }, [hi, groups, his])

  // Small, at the caret or the row, and never off the window: measure it and slide it back inside.
  useLayoutEffect(() => {
    const box = rootRef.current?.getBoundingClientRect()
    if (!box) return
    const left = Math.max(EDGE, Math.min(x, window.innerWidth - PANEL_WIDTH - EDGE))
    const top = Math.max(EDGE, Math.min(y, window.innerHeight - box.height - EDGE))
    setPos((current) => current && current.left === left && current.top === top ? current : { left, top })
  }, [x, y, groups, showStrip])

  // Each list stands beside the one it hangs from, top aligned with its opener row; the window decides the side and the
  // shift, and a list prefers the side its parent list took, so the three read as one run.
  useLayoutEffect(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    const next: Array<{ left: number; top: number }> = []
    let parentEl: HTMLElement | null = rootRef.current
    let parentRect: Rect | null = parentEl ? parentEl.getBoundingClientRect() : null
    let prefer: 'right' | 'left' | undefined
    for (let at = 0; at < stack.length; at += 1) {
      const box = panelRefs.current[at]
      if (!parentEl || !parentRect || !box) break
      const dom = parentEl.getBoundingClientRect()
      const rowEl = parentEl.querySelector<HTMLElement>(`[data-action-id="${CSS.escape(stack[at]!.id)}"]`)
      const rr = (rowEl ?? parentEl).getBoundingClientRect()
      // The parent may not have moved to its measured place yet: take the row's offset inside it, not its screen position.
      const row: Rect = { left: rr.left - dom.left + parentRect.left, top: rr.top - dom.top + parentRect.top, right: rr.right - dom.left + parentRect.left, bottom: rr.bottom - dom.top + parentRect.top }
      const cr = box.getBoundingClientRect()
      const placed = placeFlyout(parentRect, row, { width: cr.width, height: cr.height }, viewport, undefined, undefined, prefer)
      next.push({ left: placed.left, top: placed.top })
      prefer = placed.side
      parentEl = box
      parentRect = { left: placed.left, top: placed.top, right: placed.left + cr.width, bottom: placed.top + cr.height }
    }
    setPlaces((current) => current.length === next.length && current.every((p, i) => p.left === next[i]!.left && p.top === next[i]!.top) ? current : next)
  }, [stack, pos, objQuery, groups, showStrip])

  /** The keyboard goes to list `at`: its filter when it has one, else the list itself. */
  function focusPanel(at: number): void {
    const box = panelRefs.current[at]
    if (box) (box.querySelector<HTMLElement>('input') ?? box).focus()
  }
  function close(reason: 'dismiss' | 'ran'): void {
    if (done.current) return
    done.current = true
    onClose(reason)
  }
  function open(row: ActionRow, at: number): void {
    // Replacing a list that has the keyboard: hand the focus to its parent first so the swap is not read as a click away.
    if (stack.length > at) { if (at === 0) inputRef.current?.focus(); else focusPanel(at - 1) }
    setStack((current) => [...current.slice(0, at), row])
    setHis((current) => current.map((value, i) => (i >= at ? 0 : value)))
    if (row.opens === 'insert') setObjQuery('')
  }
  /** Close the deepest open list; the keyboard goes back to its parent first so the focus is never lost with the list. */
  function closeDeepest(): void {
    if (stack.length >= 2) focusPanel(stack.length - 2)
    else inputRef.current?.focus()
    setStack((current) => current.slice(0, -1))
  }
  const within = (node: Node | null): boolean => !!node && node instanceof Element && !!node.closest('[data-ak-panel]')
  function run(id: string): void {
    done.current = true
    if (runHere?.(id)) return
    done.current = false
    close('ran')
    api.runCommand(id)
  }
  /** `which` picks the command of a split row: Return runs the second, ⇧Return the first. `at` is the index of the list an opener row would open. */
  function pick(row: ActionRow, which: 'first' | 'second', at: number): void {
    if (row.opens) { open(row, at); return }
    run(row.split ? row.split[which].id : row.id)
  }
  function openPalette(): void {
    close('ran')
    api.openPalette(query)
  }
  function activate(index: number, which: 'first' | 'second' = 'second'): void {
    if (index === allIndex) openPalette()
    else if (flat[index]) pick(flat[index], which, 0)
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    const count = flat.length + 1
    const cells = showStrip ? layout.strip.length : 0
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && stack.length > 0) setStack([])
    if (event.key === 'ArrowDown') {
      if (stripHi !== null) { setStripHi(null); setHi(0) } else setHi((value) => (value + 1) % count)
    } else if (event.key === 'ArrowUp') {
      // The strip sits above the first row: ↑ from it goes to its first cell, and ↑ from the cells wraps to the foot.
      if (stripHi !== null) { setStripHi(null); setHi(count - 1) } else if (hi === 0 && cells > 0) setStripHi(0)
      else setHi((value) => (value - 1 + count) % count)
    } else if (stripHi !== null && event.key === 'ArrowLeft') setStripHi((value) => Math.max(0, (value ?? 0) - 1))
    else if (stripHi !== null && event.key === 'ArrowRight') setStripHi((value) => Math.min(cells - 1, (value ?? 0) + 1))
    else if (event.key === 'Enter') {
      if (stripHi !== null && layout.strip[stripHi]) run(layout.strip[stripHi]!.id)
      else activate(hi, event.shiftKey ? 'first' : 'second')
    }
    else if (event.key === 'Escape') close('dismiss')
    else if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') close('dismiss')
    // The way in to a row that opens a list: →, again with nothing typed.
    else if (event.key === 'ArrowRight' && query === '' && flat[hi]?.opens) open(flat[hi], 0)
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  /** Keys while list `at` has the keyboard (it is always the deepest open list). */
  function onPanelKeyDown(at: number, event: React.KeyboardEvent): void {
    const opener = stack[at]
    if (!opener) return
    const rows = panelFlat[at] ?? []
    const current = his[at] ?? 0
    const input = opener.opens === 'insert' && event.target instanceof HTMLInputElement ? event.target : null
    const setCurrent = (value: number): void => setHis((list) => list.map((old, i) => (i === at ? value : old)))
    if (event.key === 'ArrowDown') { if (rows.length) setCurrent((current + 1) % rows.length) }
    else if (event.key === 'ArrowUp') { if (rows.length) setCurrent((current - 1 + rows.length) % rows.length) }
    else if (event.key === 'ArrowLeft') {
      // In a filter with text, ← walks the caret; only at the very start (or with an empty box) does it close the list.
      if (input && (input.selectionStart !== 0 || input.selectionEnd !== 0)) return
      closeDeepest()
    }
    else if (event.key === 'Backspace') { if (input && input.value !== '') return; closeDeepest() }
    else if (event.key === 'Enter') { if (rows[current]) pick(rows[current]!, 'second', at + 1) }
    else if (event.key === 'ArrowRight') {
      if (input && (input.selectionStart !== input.value.length || input.selectionEnd !== input.value.length)) return
      if (rows[current]?.opens) open(rows[current]!, at + 1)
    }
    else if (event.key === 'Escape') closeDeepest()
    else if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') close('dismiss')
    else if (event.key === 'Tab') { /* Tab stays in the menu */ }
    else if (!input && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      // Typing while a first-level list has the keyboard goes to the main filter, which closes the list (its rows change under it).
      if (at === 0) {
        const typed = event.key
        closeDeepest()
        typeQuery(query + typed)
      }
    }
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  let index = -1
  return (
    <>
    <div
      ref={rootRef}
      className="ak"
      role="dialog"
      aria-label={TEXT.title}
      data-testid="actions-here"
      data-ak-panel=""
      style={{ left: pos?.left ?? x, top: pos?.top ?? y }}
      onKeyDown={onKeyDown}
      onBlur={(event) => { if (!within(event.relatedTarget as Node | null)) close('dismiss') }}
    >
      <div className="ak-head">
        <Command className="icon sm" aria-hidden="true" />
        <span className="ak-t">{TEXT.title}</span>
        <span className="ak-place">{placeLabel(place)}</span>
      </div>
      {showStrip && (
        <div className="ak-strip-wrap">
          <div className="ak-strip-cap">{layout.stripCaption}</div>
          <div className="ak-strip" role="toolbar" aria-label={layout.stripCaption}>
            {layout.strip.map((cell, at) => (
              <button
                key={cell.id}
                type="button"
                tabIndex={-1}
                className={`ak-cell${stripHi === at ? ' sel' : ''}`}
                data-action-id={cell.id}
                aria-label={cell.label}
                title={[cell.label, ...cell.chords].join('  ')}
                onMouseMove={() => setStripHi(at)}
                onMouseDown={(event) => { event.preventDefault(); run(cell.id) }}
              >
                {cell.icon && <cell.icon className="icon sm" aria-hidden="true" data-testid="ak-row-icon" />}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="ak-filter">
        <Search className="icon sm" aria-hidden="true" />
        <input ref={inputRef} value={query} onChange={(event) => typeQuery(event.target.value)} placeholder={TEXT.filter} aria-label={TEXT.filter} aria-activedescendant={flat[hi] && stripHi === null ? `ak-row-${flat[hi]!.id}` : undefined} />
      </div>
      <div className="ak-list" role="menu" aria-label={TEXT.title}>
        {groups.length === 0 && <div className="ak-none">{TEXT.none(query)}</div>}
        {groups.map((group, groupAt) => (
          <div key={groupAt} role="group" aria-label={group.name || undefined}>
            {groupAt > 0 && <div className="ak-sep" role="separator" />}
            {group.rows.map((row) => {
              if (row.inert) {
                return (
                  <div key={row.id} className="ak-row now" aria-disabled="true" data-testid="ak-now-row">
                    {row.icon && <row.icon className="icon sm" aria-hidden="true" data-testid="ak-row-icon" />}
                    <span className="grow">{row.label}</span>
                    {row.tag && <span className="ak-tag">{row.tag}</span>}
                  </div>
                )
              }
              index += 1
              const at = index
              return (
                <div
                  key={row.id}
                  id={`ak-row-${row.id}`}
                  role="menuitem"
                  aria-haspopup={row.opens ? 'menu' : undefined}
                  aria-expanded={row.opens ? stack[0]?.id === row.id : undefined}
                  data-action-id={row.id}
                  className={`ak-row${at === hi && stripHi === null ? ' sel' : ''}${stack[0]?.id === row.id ? ' open' : ''}`}
                  onMouseMove={() => { setHi(at); setStripHi(null) }}
                  onMouseDown={(event) => { event.preventDefault(); pick(row, 'second', 0) }}
                >
                  {row.agent
                    ? <AGENT_ICON className={`icon sm ${AGENT_ICON_CLASS}`} aria-hidden="true" data-testid="ak-row-icon" />
                    : row.icon && <row.icon className="icon sm" aria-hidden="true" data-testid="ak-row-icon" />}
                  <span className="grow">{row.label}</span>
                  {row.opens
                    ? <ChevronRight className="icon sm go" aria-hidden="true" />
                    : row.split
                      ? [row.split.first, row.split.second].map((half) => half.chords[0] && (
                        <kbd
                          key={half.id}
                          className="ak-cap"
                          data-cap-id={half.id}
                          title={half.label}
                          onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); run(half.id) }}
                        >{half.chords[0]}</kbd>
                      ))
                      : row.chords.map((chord) => <kbd key={chord}>{chord}</kbd>)}
                </div>
              )
            })}
          </div>
        ))}
      </div>
      <div
        role="menuitem"
        data-action-id="all-commands"
        className={`ak-all${hi === allIndex ? ' sel' : ''}${groups.length === 0 ? ' none' : ''}`}
        onMouseMove={() => setHi(allIndex)}
        onMouseDown={(event) => { event.preventDefault(); openPalette() }}
      >
        <Command className="icon sm" aria-hidden="true" />
        <span className="grow">{TEXT.all}</span>
        {groups.length === 0 && <kbd>↵</kbd>}
        {paletteChord && <kbd>{paletteChord}</kbd>}
      </div>
    </div>
    {stack.map((opener, at) => {
      const rows = panelFlat[at] ?? []
      const current = his[at] ?? 0
      const prefix = at === 0 ? 'ak-child-' : 'ak-grand-'
      const withFilter = opener.opens === 'insert'
      const place = places[at]
      const list = (
        <>
          {withFilter && panelGroups[at]!.length === 0 && <div className="ak-none">{TEXT.none(objQuery)}</div>}
          {panelGroups[at]!.map((group, groupAt) => (
            <div key={groupAt} role="group">
              {groupAt > 0 && <div className="ak-sep" role="separator" />}
              {group.rows.map((row) => {
                if (row.inert) {
                  return (
                    <div key={row.id} className="ak-row now" aria-disabled="true" data-testid="ak-now-row">
                      {row.icon && <row.icon className="icon sm" aria-hidden="true" data-testid="ak-row-icon" />}
                      <span className="grow">{row.label}</span>
                      {row.tag && <span className="ak-tag">{row.tag}</span>}
                    </div>
                  )
                }
                const rowAt = rows.indexOf(row)
                return (
                  <div
                    key={row.id}
                    id={`${prefix}${row.id}`}
                    role="menuitem"
                    aria-haspopup={row.opens ? 'menu' : undefined}
                    aria-expanded={row.opens ? stack[at + 1]?.id === row.id : undefined}
                    data-action-id={row.id}
                    className={`ak-row${rowAt === current ? ' sel' : ''}${stack[at + 1]?.id === row.id ? ' open' : ''}`}
                    onMouseMove={() => setHis((list) => list.map((old, i) => (i === at ? rowAt : old)))}
                    onMouseDown={(event) => { event.preventDefault(); pick(row, 'second', at + 1) }}
                  >
                    {row.icon && <row.icon className="icon sm" aria-hidden="true" data-testid="ak-row-icon" />}
                    <span className="grow">{row.label}</span>
                    {row.opens
                      ? <ChevronRight className="icon sm go" aria-hidden="true" />
                      : row.chords.map((chord) => <kbd key={chord}>{chord}</kbd>)}
                  </div>
                )
              })}
            </div>
          ))}
        </>
      )
      const active = rows[current] ? `${prefix}${rows[current]!.id}` : undefined
      const labelledby = `${at === 0 ? 'ak-row-' : 'ak-child-'}${opener.id}`
      return (
        <div
          key={at}
          ref={(node) => { panelRefs.current[at] = node }}
          className={`ak ak-child${withFilter ? ' ak-insert' : ''}`}
          role={withFilter ? undefined : 'menu'}
          tabIndex={-1}
          aria-labelledby={withFilter ? undefined : labelledby}
          aria-activedescendant={withFilter ? undefined : active}
          data-ak-panel=""
          data-testid={at === 0 ? 'actions-here-child' : 'actions-here-grandchild'}
          style={{ left: place?.left ?? 0, top: place?.top ?? 0, opacity: place ? 1 : 0 }}  // measured before it shows; opacity (not visibility) so it can take the focus at once
          onKeyDown={(event) => onPanelKeyDown(at, event)}
          onBlur={(event) => { if (!within(event.relatedTarget as Node | null)) close('dismiss') }}
        >
          {withFilter && (
            <div className="ak-filter">
              <Search className="icon sm" aria-hidden="true" />
              <input
                value={objQuery}
                onChange={(event) => { setObjQuery(event.target.value); setStack((value) => value.slice(0, 1)); setHis([0, 0]) }}
                placeholder={TEXT.insertFilter}
                aria-label={TEXT.insertFilter}
                aria-activedescendant={active}
              />
            </div>
          )}
          {withFilter ? <div role="menu" aria-labelledby={labelledby}>{list}</div> : list}
        </div>
      )
    })}
    </>
  )
}

/** How many rows the panel lists at a place: the number the status-bar chip shows. */
export const panelRowCount = (place: Place, state: EditorState | null, _overrides: OverrideMap): number => hereCount(place, state)

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { FolderSearch, Heading, Headphones, History, Keyboard, LayoutGrid, PenLine, Play, Search, Share, SlidersHorizontal, Sparkles, Target, TextCursorInput, X, type LucideProps } from 'lucide-react'
import type { EditorState } from '@codemirror/state'
import type { OverrideMap } from '../commands/chords'
import { KEYBOARD_SHEET_TEXT as TEXT, keyboardSheet, splitColumns, type SheetRow, type SheetSectionId } from '../commands/keyboard-sheet'
import type { Place } from '../commands/place'
import { useActionsHere } from './ActionsHere'

const FUTURE_TITLE = { ship2: 'Ships in the next milestone', build: 'Ships later in this build' } as const

/** The rail's icons: the drawing's TASK_ICON, as lucide components. */
const SECTION_ICON: Record<SheetSectionId, ComponentType<LucideProps>> = {
  here: TextCursorInput,
  Write: PenLine,
  'Shape the document': Heading,
  'Stay focused': Target,
  Listen: Headphones,
  'Review and versions': History,
  'Find and manage files': FolderSearch,
  'Collect and plan': LayoutGrid,
  'Work with the agent': Sparkles,
  'Share and export': Share,
  'Set up WriteFlex': SlidersHorizontal,
}

export type CheatSheetProps = {
  overrides?: OverrideMap
  /** Where the writer is when the sheet opens; null (no document, no pane row) leaves the Here section out. */
  place?: Place | null
  /** The editor's state, which commands' `when` is asked about (the same one the ⌘K panel asks). */
  editorState?: EditorState | null
  /** The section the sheet opens on; Here when there is a place, else the first task. */
  startOn?: SheetSectionId
  /** The text typed in the filter when it opens (a test seam). */
  startQuery?: string
  onClose: () => void
}

function Keys({ row }: { row: SheetRow }): JSX.Element {
  if (row.chords.length === 0) return <span className="nokey">{TEXT.noKey}</span>
  if (row.then) return <>{row.chords.map((chord) => <kbd key={chord}>{chord}</kbd>)}<span className="then">then</span><kbd>{row.then}</kbd></>
  if (row.rebound) {
    return <>
      <span className="reb">{TEXT.rebound}{row.was.length > 0 && <> · {TEXT.was} {row.was.map((chord) => <kbd key={chord} className="was">{chord}</kbd>)}</>}</span>
      {row.chords.map((chord) => <kbd key={chord} className="new">{chord}</kbd>)}
    </>
  }
  return <>{row.chords.map((chord) => <kbd key={chord}>{chord}</kbd>)}</>
}

export function CheatSheet({ overrides = {}, place = null, editorState = null, startOn, startQuery = '', onClose }: CheatSheetProps): JSX.Element {
  const api = useActionsHere()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [query, setQuery] = useState(startQuery)
  const [chosen, setChosen] = useState<SheetSectionId>(startOn ?? (place ? 'here' : 'Write'))
  const [hi, setHi] = useState(-1)

  const sections = useMemo(() => keyboardSheet({ place, state: editorState, overrides, query }), [place, editorState, overrides, query])
  const section = sections.find((item) => item.id === chosen) ?? sections[0]!
  const flat = useMemo(() => section.groups.flatMap((group) => group.rows), [section])
  const canRunRow = (row: SheetRow): boolean => row.chords.length === 0 && !row.future && (api.canRun?.(row.id) ?? false)

  useLayoutEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => { setHi(-1) }, [query, chosen])
  useEffect(() => { rootRef.current?.querySelector('.ks-row.focus')?.scrollIntoView?.({ block: 'nearest' }) }, [hi, section])

  function choose(offset: number): void {
    const at = sections.findIndex((item) => item.id === section.id)
    setChosen(sections[(at + offset + sections.length) % sections.length]!.id)
  }
  function run(row: SheetRow): void { api.runCommand(row.id) }

  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'Escape') onClose()
    else if (event.key === 'ArrowDown') setHi(flat.length === 0 ? -1 : (hi + 1) % flat.length)
    else if (event.key === 'ArrowUp') setHi(flat.length === 0 ? -1 : (hi - 1 + flat.length) % flat.length)
    // Tab moves between the tasks (the rail) without leaving the filter.
    else if (event.key === 'Tab') choose(event.shiftKey ? -1 : 1)
    else if (event.key === 'Enter') { const row = flat[hi]; if (row && canRunRow(row)) run(row) }
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  const [left, right] = splitColumns(section.groups)
  let index = -1
  const column = (groups: typeof left): JSX.Element => (
    <div>
      {groups.map((group) => (
        <div className="ks-group" key={group.name} role="group" aria-label={group.name}>
          <h3>{group.name}<span>{group.count}</span></h3>
          {group.rows.map((row) => {
            index += 1
            const at = index
            const focused = at === hi
            const runnable = focused && canRunRow(row)
            return (
              <div key={row.id} role="option" aria-selected={focused} data-command-id={row.id}
                className={`ks-row${focused ? ' focus' : ''}${row.future ? ' future' : ''}`}
                title={row.future ? FUTURE_TITLE[row.future] : undefined}
                onMouseMove={() => setHi(at)}>
                <span className="grow">{row.label}</span>
                <span className="keys">
                  {runnable && <button type="button" className="btn sm run" tabIndex={-1} onMouseDown={(event) => { event.preventDefault(); run(row) }}><Play className="icon sm" aria-hidden="true" />{TEXT.run}<kbd>↵</kbd></button>}
                  <Keys row={row} />
                </span>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )

  return (
    <div ref={rootRef} className="overlay open" role="dialog" aria-modal="true" aria-label={TEXT.title} data-testid="keyboard-sheet"
      onKeyDown={onKeyDown}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="sheet cheatsheet-sheet ks">
        <div className="ks-head">
          <Keyboard className="icon" aria-hidden="true" />
          <h2>{TEXT.title}</h2>
          <div className="search-field">
            <Search className="icon sm" aria-hidden="true" />
            <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={TEXT.filter} aria-label={TEXT.filter} />
            {query !== '' && <button type="button" className="ks-clear" aria-label="Clear the filter" tabIndex={-1} onMouseDown={(event) => { event.preventDefault(); setQuery(''); inputRef.current?.focus() }}><X className="icon sm" aria-hidden="true" /></button>}
          </div>
          <span className="grow" />
          <kbd>esc</kbd>
        </div>
        <div className="ks-body">
          <nav className="ks-rail" aria-label="Sections">
            {sections.map((item, at) => {
              const Icon = SECTION_ICON[item.id]
              return (
                <div key={item.id}>
                  <button type="button" data-section={item.id} aria-current={item.id === section.id ? 'true' : undefined} tabIndex={-1}
                    className={`ks-item${item.id === section.id ? ' on' : ''}${item.count === 0 ? ' zero' : ''}`}
                    onMouseDown={(event) => { event.preventDefault(); setChosen(item.id); inputRef.current?.focus() }}>
                    <Icon className="icon sm" aria-hidden="true" /><span className="grow">{item.label}</span><span className="n">{item.count}</span>
                  </button>
                  {item.id === 'here' && at === 0 && <div className="ks-sep" />}
                </div>
              )
            })}
          </nav>
          <div className="ks-pane" role="listbox" aria-label={section.label}>
            {section.groups.length === 0 && query.trim() !== '' && <div className="ks-none">{TEXT.none(query.trim())}</div>}
            <div className="ks-cols">{column(left)}{column(right)}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

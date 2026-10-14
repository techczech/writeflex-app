import { useEffect, useMemo, useRef, useState } from 'react'
import { FileCode2, Search } from 'lucide-react'
import type { WidgetChoice, WidgetChoices } from '../../../main/widget-insert'
import { fuzzyFilter } from '../fuzzy'
import { cancelEnter, listArrived, pressEnter } from './widget-picker-enter'

/**
 * Insert widget… (interactive-widgets-in-documents, ticket 05, drawing state 13): the palette's
 * file-picking step. It lists the HTML files in the document's folder and below it (main finds them,
 * inside the workspace only), with search; Enter inserts the embed line at the caret. Esc goes back
 * to the command list. The fixed strings are the drawing's COPY.palette.
 */
export const WIDGET_PICKER_TEXT = {
  command: 'Insert widget…',
  placeholder: 'Find an HTML file in this folder…',
  section: (folder: string): string => `HTML files in ${folder}`,
  rowHint: '↵ insert',
  esc: 'esc',
  footer: '↵ inserts the widget line at the cursor · Esc goes back to commands',
  none: 'No HTML files here yet. Save a page as an HTML file in this folder.',
  noMatch: 'No HTML files match',
} as const

type Props = {
  /** The active document's workspace-relative path. */
  documentPath: string
  onChoose: (choice: WidgetChoice) => void
  /** Esc or the backdrop: back to the command list. */
  onBack: () => void
}

export function WidgetPicker({ documentPath, onChoose, onBack }: Props): JSX.Element {
  const [choices, setChoices] = useState<WidgetChoices | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  // One Enter pressed while the list is still loading; it inserts the first row when the list arrives.
  const pendingEnter = useRef(false)

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => {
    let live = true
    void window.writeflex.listWidgetChoices(documentPath).then((result) => { if (live) setChoices(result) }, () => { if (live) setChoices({ folder: '', files: [], truncated: false }) })
    return () => { live = false }
  }, [documentPath])

  const shown = useMemo(() => {
    const files = choices?.files ?? []
    const byRaw = new Map(files.map((file) => [file.rawPath, file]))
    return fuzzyFilter(query.trim(), files.map((file) => file.rawPath)).map((raw) => byRaw.get(raw)).filter((file): file is WidgetChoice => file != null)
  }, [choices, query])

  useEffect(() => { setSelected(0) }, [query, choices])
  useEffect(() => {
    if (choices === null || !pendingEnter.current) return
    const action = listArrived(pendingEnter.current, choices.files)
    pendingEnter.current = action.pending
    if (action.choose) onChoose(action.choose)
  }, [choices]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }) }, [selected, shown])

  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'Escape') { event.preventDefault(); pendingEnter.current = cancelEnter(); onBack() }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((index) => Math.min(index + 1, shown.length - 1)) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((index) => Math.max(index - 1, 0)) }
    else if (event.key === 'Enter') { event.preventDefault(); const action = pressEnter(choices !== null, shown[selected]); pendingEnter.current = action.pending; if (action.choose) onChoose(action.choose) }
  }

  return (
    <div className="overlay open" role="dialog" aria-modal="true" aria-label={WIDGET_PICKER_TEXT.command} data-testid="widget-picker" onKeyDown={onKeyDown} onMouseDown={(event) => { if (event.target === event.currentTarget) onBack() }}>
      <div className="sheet palette-sheet">
        <div className="pal-input">
          <Search className="icon" aria-hidden="true" />
          <span className="wf-pal-step">{WIDGET_PICKER_TEXT.command}</span>
          <input ref={inputRef} className="wf-pal-input" type="text" value={query} onChange={(event) => { pendingEnter.current = cancelEnter(); setQuery(event.target.value) }} placeholder={WIDGET_PICKER_TEXT.placeholder} aria-label="HTML file name" />
          <kbd>{WIDGET_PICKER_TEXT.esc}</kbd>
        </div>
        <div className="pal-list" ref={listRef}>
          {choices && shown.length === 0 && <div className="pal-empty">{choices.files.length === 0 ? WIDGET_PICKER_TEXT.none : WIDGET_PICKER_TEXT.noMatch}</div>}
          {shown.length > 0 && <div className="pal-sec">{WIDGET_PICKER_TEXT.section(choices?.folder ?? '')}</div>}
          {shown.map((file, index) => (
            <button key={file.rawPath} type="button" className="pal-row" data-testid="widget-picker-row" aria-selected={index === selected} onMouseMove={() => setSelected(index)} onClick={() => onChoose(file)}>
              <FileCode2 className="icon sm" aria-hidden="true" />
              <span className="grow"><span className="pal-name">{file.name}</span>{file.directory && <span className="pal-dir">{file.directory}</span>}</span>
              {index === selected && <kbd>{WIDGET_PICKER_TEXT.rowHint}</kbd>}
            </button>
          ))}
        </div>
        <div className="palette-footer">{WIDGET_PICKER_TEXT.footer}</div>
      </div>
    </div>
  )
}

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
import { addDays, addMonths, monthGrid, monthTitle, parseIsoDate, todayIso } from '../../../shared/calendar-grid'

/**
 * The Details card's pickers (0.26, mockup frames c1 to c3): a list for Status, Author, Audience and Language, and a
 * calendar for Date. Both open under their field, take the keyboard at once, set with Enter and close with Escape
 * (which closes the picker and nothing more). They only say what was chosen; the card writes it.
 */

export type PickerOption = {
  /** The value written; null removes the key ("No status"). */
  value: string | null
  label: string
  /** Quiet text at the right ("you · 8 files", "Unsorted on the Board"). */
  hint?: string
  /** The value the field holds now. */
  current?: boolean
  /** A coloured lane dot (Status). */
  dot?: string
}
export type PickerSection = { heading: string; options: PickerOption[] }

type ListPickerProps = {
  label: string
  sections: PickerSection[]
  /** Placeholder of the filter box; typing a name no option has offers it as a new value (when `newLabel` is given). */
  placeholder: string
  newLabel?: (typed: string) => string
  onChoose: (value: string | null) => void
  onClose: () => void
}

const STATUS_DOT: Record<string, string> = {
  idea: 'var(--s-idea, #b7791f)', 'note gathering': 'var(--s-note, #7c5cd6)', 'in progress': 'var(--s-prog, #2f6fe4)',
  editing: 'var(--s-edit, #1f8a70)', ready: 'var(--s-ready, #1f8a70)', published: 'var(--ink-3)',
}
export const statusDot = (lane: string): string => STATUS_DOT[lane.toLocaleLowerCase()] ?? 'var(--ink-4)'

type Row = { key: string; option: PickerOption; fresh?: boolean }

export function DetailListPicker({ label, sections, placeholder, newLabel, onChoose, onClose }: ListPickerProps): JSX.Element {
  const [query, setQuery] = useState('')
  // The list opens on the value the field holds now, so ↓ and ↑ step from where the writer is.
  const [active, setActive] = useState(() => Math.max(0, sections.flatMap((section) => section.options).findIndex((option) => option.current)))
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  useEffect(() => { inputRef.current?.focus() }, [])

  const typed = query.trim()
  const shown = useMemo(() => {
    const needle = typed.toLocaleLowerCase()
    return sections
      .map((section) => ({ heading: section.heading, options: section.options.filter((option) => needle === '' || option.label.toLocaleLowerCase().includes(needle)) }))
      .filter((section) => section.options.length > 0)
  }, [sections, typed])
  const rows: Row[] = useMemo(() => {
    const list: Row[] = shown.flatMap((section) => section.options.map((option) => ({ key: `${section.heading}:${option.value ?? 'none'}`, option })))
    const exact = sections.some((section) => section.options.some((option) => option.label.toLocaleLowerCase() === typed.toLocaleLowerCase()))
    if (newLabel && typed !== '' && !exact) list.push({ key: 'new', option: { value: typed, label: newLabel(typed) }, fresh: true })
    return list
  }, [newLabel, sections, shown, typed])
  const at = rows.length === 0 ? -1 : Math.min(active, rows.length - 1)
  const firstRender = useRef(true)
  useEffect(() => { if (firstRender.current) { firstRender.current = false; return } setActive(0) }, [typed])

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation()
      if (rows.length > 0) setActive((at + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation()
      if (at >= 0) onChoose(rows[at].option.value)
    }
  }

  let flat = -1
  return (
    <div className="fd-pop" role="dialog" aria-label={label} data-folio-detail-picker={label.toLocaleLowerCase()} onKeyDown={onKeyDown}>
      <input
        ref={inputRef}
        className="fd-pop-q"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={at >= 0 ? `${listId}-${at}` : undefined}
        aria-label={`${label}: filter or type a new value`}
        placeholder={placeholder}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="fd-pop-list" role="listbox" id={listId} aria-label={label}>
        {shown.map((section) => (
          <div key={section.heading} role="group" aria-label={section.heading}>
            <div className="fd-pop-h">{section.heading}</div>
            {section.options.map((option) => {
              flat += 1
              const index = flat
              return (
                <div
                  key={`${section.heading}:${option.value ?? 'none'}`}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === at}
                  className={`fd-pop-row${index === at ? ' on' : ''}`}
                  data-folio-detail-option={option.value ?? ''}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => setActive(index)}
                  onClick={() => onChoose(option.value)}
                >
                  {option.dot && <span className="fd-dot" style={{ background: option.dot }} aria-hidden="true" />}
                  <span className="fd-pop-l">{option.label}</span>
                  {option.hint && <span className="fd-pop-hint">{option.hint}</span>}
                  {option.current && <Check className="fd-icon fd-pop-check" aria-label="current" />}
                </div>
              )
            })}
          </div>
        ))}
        {rows.some((row) => row.fresh) && (() => {
          flat += 1
          const index = flat
          const row = rows[rows.length - 1]
          return (
            <div id={`${listId}-${index}`} role="option" aria-selected={index === at} className={`fd-pop-row fd-pop-new${index === at ? ' on' : ''}`} data-folio-detail-option-new="true"
              onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setActive(index)} onClick={() => onChoose(row.option.value)}>
              <span className="fd-pop-l">{row.option.label}</span>
            </div>
          )
        })()}
        {rows.length === 0 && <div className="fd-pop-empty">Nothing matches.</div>}
      </div>
      <div className="fd-pop-foot"><span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>↵</kbd> set</span>{newLabel && <span>type a new value</span>}</div>
    </div>
  )
}

type CalendarProps = { value: string | null; onChoose: (iso: string | null) => void; onClose: () => void; today?: string }

export function DetailCalendarPicker({ value, onChoose, onClose, today = todayIso() }: CalendarProps): JSX.Element {
  const start = value !== null && parseIsoDate(value) ? value : today
  const [cursor, setCursor] = useState(start)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  const weeks = useMemo(() => monthGrid(cursor), [cursor])

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.nativeEvent.isComposing) return
    const move = (next: string) => { event.preventDefault(); event.stopPropagation(); setCursor(next) }
    switch (event.key) {
      case 'Escape': event.preventDefault(); event.stopPropagation(); onClose(); return
      case 'ArrowLeft': move(addDays(cursor, -1)); return
      case 'ArrowRight': move(addDays(cursor, 1)); return
      case 'ArrowUp': move(addDays(cursor, -7)); return
      case 'ArrowDown': move(addDays(cursor, 7)); return
      case 'PageUp': move(addMonths(cursor, -1)); return
      case 'PageDown': move(addMonths(cursor, 1)); return
      case 'Enter': event.preventDefault(); event.stopPropagation(); onChoose(cursor); return
      case 'Backspace': case 'Delete': event.preventDefault(); event.stopPropagation(); onChoose(null); return
      default:
        if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 't') move(today)
    }
  }

  return (
    <div className="fd-pop fd-cal" role="dialog" aria-label="Date" data-folio-detail-picker="date" tabIndex={-1} ref={ref} onKeyDown={onKeyDown}>
      <div className="fd-cal-head">
        <b aria-live="polite">{monthTitle(cursor)}</b>
        <span className="fd-grow" />
        <button type="button" tabIndex={-1} aria-label="Previous month" onMouseDown={(e) => e.preventDefault()} onClick={() => setCursor(addMonths(cursor, -1))}><ChevronLeft className="fd-icon" /></button>
        <button type="button" tabIndex={-1} className="fd-cal-today" onMouseDown={(e) => e.preventDefault()} onClick={() => onChoose(today)}>Today</button>
        <button type="button" tabIndex={-1} aria-label="Next month" onMouseDown={(e) => e.preventDefault()} onClick={() => setCursor(addMonths(cursor, 1))}><ChevronRight className="fd-icon" /></button>
      </div>
      <div className="fd-cal-grid" role="grid" aria-label={monthTitle(cursor)}>
        {['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].map((day) => <span key={day} className="fd-cal-wd" role="columnheader">{day}</span>)}
        {weeks.flat().map((day) => (
          <button
            key={day.iso}
            type="button"
            tabIndex={-1}
            role="gridcell"
            aria-selected={day.iso === value}
            aria-current={day.iso === today ? 'date' : undefined}
            aria-label={day.iso}
            className={`fd-cal-day${day.inMonth ? '' : ' out'}${day.iso === value ? ' chosen' : ''}${day.iso === cursor ? ' cursor' : ''}${day.iso === today ? ' today' : ''}`}
            data-folio-detail-day={day.iso}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChoose(day.iso)}
          >{day.day}</button>
        ))}
      </div>
      <div className="fd-pop-foot"><span>Writes date: <code>{cursor}</code></span></div>
      <div className="fd-pop-foot"><span><kbd>←</kbd><kbd>→</kbd> day</span><span><kbd>↑</kbd><kbd>↓</kbd> week</span><span><kbd>⇞</kbd><kbd>⇟</kbd> month</span><span><kbd>T</kbd> today</span><span><kbd>↵</kbd> set</span><span><kbd>⌫</kbd> clear</span></div>
    </div>
  )
}

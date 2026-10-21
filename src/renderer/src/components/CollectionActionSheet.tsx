import { useEffect, useRef } from 'react'
import { BOARD_STATUS_ORDER } from '../../../shared/collection-status'
import { trappedFocus } from '../../../shared/folio-add-all'

export const NO_MOVE_DESTINATION = '\0'

export type CollectionSheet = 'rename' | 'status' | 'move' | 'folio' | 'tag'
const SHEET_TITLES: Record<CollectionSheet, string> = {
  rename: 'Rename collection', status: 'Set status', move: 'Move to folder', folio: 'Add to Folio', tag: 'Tag documents',
}
const SHEET_LABELS: Record<CollectionSheet, string> = {
  rename: 'Name', status: 'Status', tag: 'Tags, separated by commas', folio: 'Folio', move: 'Destination folder in this workspace',
}

type Props = {
  sheet: CollectionSheet
  value: string
  folders: readonly string[]
  folioName: string
  busy: boolean
  error: string
  onChange: (value: string) => void
  onClose: () => void
  onSubmit: () => void
  returnFocusTo?: HTMLElement | null
  fallbackFocus?: () => HTMLElement | null
}

export function CollectionActionSheet({ sheet, value, folders, folioName, busy, error, onChange, onClose, onSubmit, returnFocusTo, fallbackFocus }: Props): JSX.Element {
  const dialogRef = useRef<HTMLFormElement>(null)
  useEffect(() => {
    const previous = returnFocusTo ?? document.activeElement
    dialogRef.current?.querySelector<HTMLElement>('input, select, button')?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected && previous !== document.body) previous.focus()
      else fallbackFocus?.()?.focus()
    }
  }, [])
  const valid = sheet === 'folio' || (sheet === 'move' ? folders.includes(value) : Boolean(value.trim()))
  return <div className="cv-sheet-backdrop">
    <form ref={dialogRef} className="cv-sheet" role="dialog" aria-modal="true" aria-label={SHEET_TITLES[sheet]}
      tabIndex={-1}
      onSubmit={event => { event.preventDefault(); if (!busy && valid) onSubmit() }}
      onKeyDown={event => {
        if (dialogRef.current) collectionSheetKeyDown(event, dialogRef.current, document.activeElement, onClose, busy)
      }}>
      <h2>{SHEET_TITLES[sheet]}</h2>
      <label>{SHEET_LABELS[sheet]}
        {sheet === 'move'
          ? <select value={value} disabled={busy} onChange={event => onChange(event.target.value)}>
              <option value={NO_MOVE_DESTINATION} disabled>Choose a folder…</option>
              {folders.map(folder => <option key={folder} value={folder}>{folder || 'Workspace root'}</option>)}
            </select>
          : sheet === 'folio'
            ? <span>{folioName}</span>
            : <input value={value} disabled={busy} onChange={event => onChange(event.target.value)} list={sheet === 'status' ? 'collection-statuses' : undefined} />}
      </label>
      {sheet === 'status' && <datalist id="collection-statuses">{BOARD_STATUS_ORDER.map(status => <option key={status}>{status}</option>)}</datalist>}
      {error && <p role="alert">{error}</p>}
      <div>
        <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="primary" type="submit" disabled={busy || !valid}>{busy ? 'Working…' : 'Apply'}</button>
      </div>
    </form>
  </div>
}

/** The same trap applies to every control in the sheet, including its folder picker. */
export function collectionSheetKeyDown(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault' | 'stopPropagation'>,
  dialog: Pick<HTMLFormElement, 'querySelectorAll' | 'focus'>,
  active: Element | null,
  onClose: () => void,
  busy = false,
): void {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); return }
  if (event.key !== 'Tab') return
  const elements = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled])')]
  const next = trappedFocus(elements.length, elements.findIndex(element => element === active), event.shiftKey)
  event.preventDefault()
  if (next !== null) elements[next]?.focus()
  else dialog.focus()
}

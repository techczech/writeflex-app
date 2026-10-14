import type { DragEvent } from 'react'
import { GripVertical } from 'lucide-react'
import type { ConfigureRow } from './action-bar-configure'

/**
 * One row of either list in the configure sheet (ADR-0040).
 *
 * It is an `option` inside a listbox, not a button: the two lists are single tab stops the arrow
 * keys move inside, which is what lets the whole sheet be crossed with Tab in five stops rather than
 * forty. It is ALSO `draggable`, because the lock draws a drag sheet — drag is the affordance, the
 * keyboard is the guarantee, and both call the same model functions.
 */
export type ActionBarConfigureRowProps = {
  row: ConfigureRow
  /** The roving tab stop: the active row of a list is the only one Tab can land on. */
  active: boolean
  /** Draws the drawing's insertion rule above this row while something is dragged over the list. */
  dropBefore?: boolean
  onSelect: () => void
  onActivate: () => void
  onDragStart: (event: DragEvent) => void
  registerRef: (node: HTMLDivElement | null) => void
}

export function ActionBarConfigureRow({ row, active, dropBefore, onSelect, onActivate, onDragStart, registerRef }: ActionBarConfigureRowProps): JSX.Element {
  const separator = row.kind === 'separator'
  const label = separator ? '— separator —' : row.label
  return (
    <div
      ref={registerRef}
      role="option"
      aria-selected={active}
      aria-label={label}
      tabIndex={active ? 0 : -1}
      draggable
      data-row-kind={row.kind}
      data-command={separator ? undefined : row.commandId}
      data-drop-before={dropBefore ? 'true' : undefined}
      className={`abcfg-row${separator ? ' sep' : ''}${!separator && row.onBar ? ' picked' : ''}${dropBefore ? ' drop-before' : ''}`}
      onMouseDown={onSelect}
      onFocus={onSelect}
      onDoubleClick={onActivate}
      onDragStart={onDragStart}
    >
      <span className="grip" aria-hidden="true">
        <GripVertical className="icon sm" />
      </span>
      {!separator && <row.icon className="icon sm" aria-hidden="true" />}
      <span className="lb">{label}</span>
      {!separator && <span className="keys">{row.keys ?? '—'}</span>}
    </div>
  )
}

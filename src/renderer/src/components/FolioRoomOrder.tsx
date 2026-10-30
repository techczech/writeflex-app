import { useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { Plus, TriangleAlert } from 'lucide-react'
import type { FolioRoomModel } from '../../../shared/folio-room'
import type { PlanPartKey } from '../../../shared/folio-running-order'
import { EXPORT_ORDER_REPAIR, newCardTitle, type NewCardFolio } from '../../../shared/folio-room-order'
import { registryCommand } from '../commands/registry'
import type { ExportOrderState } from './ExportOrderNotice'

/**
 * The Folio room's order controls (ticket 11, mockup frames 1 and 3, interactions 6 and 7): the New card tile and
 * composer, the drag-to-reorder wiring shared by cards and Outline rows, and the export-order banner. They write
 * nothing themselves: each asks the room (FolioRoom.tsx), which makes one request through the app's running-order
 * hook (app/folio-running-order.ts), and main decides (main/folio-room-writes.ts).
 */

/** The first chord a registry command answers to (its default), or undefined. */
export function chordOf(id: string): string | undefined {
  try {
    const keys = registryCommand(id).keys
    return Array.isArray(keys) ? keys[0] : keys
  } catch {
    return undefined
  }
}

/** The move pair as the drawing writes it (⌥↑↓): plan.moveUp's chord and plan.moveDown's last key. The room's ⌥↑ / ⌥↓ are
 *  those two commands (ADR-0011: not reserved chords; the Folio page answers the same keys). */
export function roomMoveChord(): string | undefined {
  const up = chordOf('plan.moveUp')
  const down = chordOf('plan.moveDown')
  return up && down ? `${up}${down.slice(-1)}` : undefined
}

/**
 * New card (interaction 7): the dashed tile; clicked (or N) it becomes a title field. ↵ adds the title as an unwritten
 * part at the end of the running order; Esc puts the tile back. A title that is empty, unwritable, a part's already,
 * the Index Note's or a reserved file's name, or a file's under Not in the outline is refused here in the same words
 * main uses, and main checks again.
 */
export function NewCard({ open, parts, folio, busy, row = false, onOpen, onClose, onAdd }: {
  open: boolean
  /** The running order as the room shows it (titles are compared under the Plan's title key). */
  parts: readonly PlanPartKey[]
  /** Not in the outline and the Index Note, as the room read them. */
  folio?: NewCardFolio
  busy: boolean
  /** Drawn as an Outline row rather than a card. */
  row?: boolean
  onOpen: () => void
  onClose: () => void
  /** Ask for the card; resolves true when it was added. */
  onAdd: (title: string) => Promise<boolean>
}): JSX.Element | null {
  const [draft, setDraft] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    if (!open) { setDraft(''); setRefusal(null); return }
    // The input owns Escape, so opening must give it focus in the same commit.
    input.current?.focus()
  }, [open])

  const submit = async (): Promise<void> => {
    const checked = newCardTitle(draft, parts, folio)
    if (!checked.ok) { setRefusal(checked.message); return }
    setRefusal(null)
    if (await onAdd(checked.title)) onClose()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    // The field owns its keys: N, arrows and ↵ never reach the room or the app while it has focus.
    event.stopPropagation()
    if (event.key === 'Enter') { event.preventDefault(); if (!busy) void submit() }
    else if (event.key === 'Escape') { event.preventDefault(); onClose() }
  }

  if (row && !open) return null
  if (!open) {
    return (
      <button type="button" className="fr-card fr-newcard" data-testid="room-new-card" onClick={onOpen}>
        <Plus className="icon" aria-hidden="true" /><b>New card</b><span>Type a title to add an unwritten part to the running order</span>
      </button>
    )
  }
  return (
    <div className={row ? 'fr-olr fr-newrow' : 'fr-card fr-newcard open'} data-testid="room-new-card-composer">
      {!row && <><Plus className="icon" aria-hidden="true" /><b>New card</b></>}
      <input
        ref={input}
        type="text"
        value={draft}
        disabled={busy}
        aria-label="Title of the new part"
        placeholder="Type a title, then press ↵"
        onChange={(event) => { setDraft(event.target.value); setRefusal(null) }}
        onKeyDown={onKeyDown}
        onBlur={() => { if (draft.trim() === '' && !busy) onClose() }}
      />
      {refusal ? <span className="err" role="alert">{refusal}</span> : <span><kbd>↵</kbd> add as an unwritten part · <kbd>Esc</kbd> cancel</span>}
    </div>
  )
}

/** What a draggable part needs: the drag start, and the drop target's over / leave / drop, by running-order index. */
export type PartDrag = {
  /** The running-order index of the part being dragged, or null. */
  dragged: number | null
  /** The part the pointer is over, where the dragged part would go. */
  over: number | null
  props: (index: number) => {
    draggable: boolean
    onDragStart: (event: DragEvent<HTMLElement>) => void
    onDragEnd: () => void
    onDragOver: (event: DragEvent<HTMLElement>) => void
    onDragLeave: () => void
    onDrop: (event: DragEvent<HTMLElement>) => void
  }
}

const DRAG_TYPE = 'application/x-writeflex-room-part'

/** Drag a card or an Outline row onto another to put it in that one's place (interaction 6). Nothing is written until the drop. */
export function usePartDrag(enabled: boolean, onMove: (from: number, to: number) => void): PartDrag {
  const dragged = useRef<number | null>(null)
  const source = useRef<HTMLElement | null>(null)
  const over = useRef<HTMLElement | null>(null)
  const end = (): void => {
    source.current?.classList.remove('dragging')
    over.current?.classList.remove('drop')
    source.current = null; over.current = null; dragged.current = null
  }
  return {
    get dragged() { return dragged.current },
    get over() { return over.current ? Number(over.current.dataset.partIndex) : null },
    props: (index) => ({
      draggable: enabled,
      onDragStart: event => {
        if (!enabled) return
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData(DRAG_TYPE, String(index))
        dragged.current = index; source.current = event.currentTarget
        source.current.classList.add('dragging')
      },
      onDragEnd: end,
      onDragOver: event => {
        if (dragged.current === null || !event.dataTransfer.types.includes(DRAG_TYPE)) return
        event.preventDefault(); event.dataTransfer.dropEffect = 'move'
        if (over.current === event.currentTarget) return
        over.current?.classList.remove('drop'); over.current = event.currentTarget
        if (dragged.current !== index) over.current.classList.add('drop')
      },
      onDragLeave: () => { over.current?.classList.remove('drop'); over.current = null },
      onDrop: event => {
        if (dragged.current === null) return
        event.preventDefault()
        const from = dragged.current
        end()
        if (from !== index) onMove(from, index)
      },
    }),
  }
}

/**
 * The room's export-order banner (spec § 8 D-ORD-3 and § 12): the export sheet's out-of-step line, or the Index-only
 * line, each with Make export follow the running order (the manifest-only repair). In the room's banner style.
 */
export function RoomOrderBanner({ state }: { state: Pick<ExportOrderState, 'line' | 'said' | 'busy' | 'repair'> }): JSX.Element | null {
  const { line, said, busy, repair } = state
  if (!line && !said) return null
  return (
    <>
      {line && (
        <div className="fr-banner fr-order" role="note" data-testid="room-order-banner">
          <TriangleAlert className="icon" aria-hidden="true" />
          <span>{line.lines.map((text, index) => (index === 0 ? <b key={text}>{text}</b> : <span key={text}> · {text}</span>))}</span>
          {line.repair && <button type="button" className="fr-btn" disabled={busy} onClick={repair}>{busy ? 'Changing the export order…' : EXPORT_ORDER_REPAIR}</button>}
        </div>
      )}
      {said && <div className={`fr-banner fr-said${said.ok ? '' : ' bad'}`} role={said.ok ? 'status' : 'alert'} data-testid="room-order-said">{said.text}</div>}
    </>
  )
}

/** The actual order source, including a Folio that has not created an Index Note yet. */
export function RoomOrderSource({ indexNote }: { indexNote: { path: string } | null }) {
  return <span className="r" data-testid="room-order-source">Order of record: {indexNote ? `${indexNote.path.split('/').at(-1)} running order` : 'Folio manifest (_report-structure.json)'}</span>
}

const LEFT_OUT_REASONS = {
  'outside-folio': 'outside the Folio folder',
  'not-found': 'file not found',
  'unreadable': 'file could not be read',
  'agent-instructions': 'agent instructions',
  'room-support': 'Folio support file',
  'not-in-outline': 'not in the outline',
  'not-a-part': 'cannot be named in the running order',
}

export function RoomLeftOut({ entries }: { entries: NonNullable<FolioRoomModel['leftOut']> }) {
  if (!entries.length) return null
  return <div className="fr-edit-message" role="status" data-testid="room-left-out">
    {entries.map((entry, at) => <p key={at}>Left out: {entry.path} — {LEFT_OUT_REASONS[entry.reason]}.</p>)}
  </div>
}

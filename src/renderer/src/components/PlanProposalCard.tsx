import { useEffect, useState, type DragEvent, type KeyboardEvent } from 'react'
import { Check, GripVertical, RotateCcw, TriangleAlert, Undo2, X } from 'lucide-react'
import {
  displayRows,
  resolveProposal,
  staleMessage,
  type DisplayRow,
  type ProposalRow,
} from '../../../shared/plan-proposal'
import type { PlanCard } from '../hooks/plan-proposal-cards'

/**
 * The running-order proposal card in the Agent pane (ticket 09). Drawn to the locked design
 * docs/design/2026-08-10-agent-and-multi-part-works/2026-09-27-proposal-card-states.html, frames 2–6,
 * at the pane's 340-pixel width. Presentational: the card state and every write live in useAgent
 * and main.
 */
export type PlanProposalCardActions = {
  onLoad: (id: string) => void
  onAccept: (id: string) => void
  onEdit: (id: string) => void
  onCancelEdit: (id: string) => void
  onDiscard: (id: string) => void
  onDrop: (id: string, changeIds: string[]) => void
  onRestore: (id: string, changeIds: string[]) => void
  onDrag: (id: string, title: string, to: number) => void
  onUndo: (id: string) => void
  onProposeAgain: (id: string) => void
}

const MARK: Record<'add' | 'move' | 'out', { glyph: string; className: string; label: string }> = {
  add: { glyph: '+', className: 'mk add', label: 'added' },
  move: { glyph: '↕', className: 'mk mov', label: 'moved' },
  out: { glyph: '−', className: 'mk out', label: 'taken out of the order' },
}

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const inWords = (count: number) => NUMBER_WORDS[count] ?? String(count)
const changes = (count: number) => `${count} ${count === 1 ? 'change' : 'changes'}`
const fileName = (path: string) => path.split('/').at(-1) ?? path
const stem = (path: string) => fileName(path).replace(/\.(?:md|markdown|mdx)$/i, '')

function Mark({ mark }: { mark: ProposalRow['mark'] }): JSX.Element | null {
  if (!mark) return <span className="mk none" aria-hidden="true" />
  const spec = MARK[mark]
  return <span className={spec.className} title={spec.label} aria-label={spec.label}>{spec.glyph}</span>
}

function Words({ row }: { row: ProposalRow }): JSX.Element {
  if (row.mark === 'out') return <span className="w">file stays</span>
  if (row.materialise) return <span className="w">new file</span>
  return <span className="w">{row.words === null ? 'unwritten' : `${row.words} w`}</span>
}

/** Frame 3's sentence: what the writer's edits did. */
export function editSentence(card: PlanCard): string {
  const view = card.view
  if (!view) return ''
  const full = resolveProposal(view.basis, card.entries.map((entry) => ({ ...entry, enabled: entry.origin === 'agent' })))
  const now = resolveProposal(view.basis, card.entries)
  const moved = [...new Set(card.entries.filter((entry) => entry.origin === 'writer' && entry.enabled && entry.change.op === 'move').map((entry) => (entry.change as { title: string }).title))]
    .map((title) => {
      const before = full.rows.findIndex((row) => row.title === title)
      const after = now.rows.findIndex((row) => row.title === title)
      return `${title} ${after < before ? 'up' : after > before ? 'down' : 'back'}`
    })
  const droppedEntries = card.entries.filter((entry) => entry.origin === 'agent' && !entry.enabled)
  const droppedTitles = droppedEntries.map((entry) => ('title' in entry.change ? entry.change.title : fileName(entry.change.path)))
  const staysInFolder = droppedEntries.some((entry) => (
    (entry.change.op === 'insert' && view.basis.strays.some((stray) => stray.title === (entry.change as { title: string }).title))
    || entry.change.op === 'adopt'
  ))
  const clauses = [
    moved.length ? `moved ${moved.join(' and ')}` : '',
    droppedTitles.length ? `dropped ${droppedTitles.join(' and ')}` : '',
  ].filter(Boolean)
  if (!clauses.length) return 'Drag a row to reorder it; × drops a change and ↺ restores it.'
  const tail = staysInFolder ? `: ${droppedTitles.length === 1 ? 'it stays' : 'they stay'} in the folder, outside the order, for now` : ''
  return `You ${clauses.join(' and ')}${tail}.`
}

/** Frame 4's sentence: what Accept changed on disk. */
export function acceptedSentence(card: PlanCard): string {
  const accepted = card.accepted
  if (!accepted) return ''
  const count = accepted.parts.length
  const shows = `The Folio outline pane now shows ${inWords(count)} ${count === 1 ? 'part' : 'parts'} in your order.`
  const hadList = (card.view?.basis.parts.length ?? 0) > 0
  const index = accepted.createdIndexNote
    ? 'WriteFlex created the Index Note with the running-order list'
    : hadList ? "The Index Note's running-order list was rewritten" : 'The Index Note gained the running-order list'
  return `${shows} ${index}${accepted.manifest ? ', and _report-structure.json follows from it.' : '.'}`
}

function OrderRow({
  row,
  editing,
  index,
  card,
  actions,
}: {
  row: DisplayRow
  editing: boolean
  index: number
  card: PlanCard
  actions: PlanProposalCardActions
}): JSX.Element {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!editing || row.dropped || !event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    event.preventDefault()
    actions.onDrag(card.id, row.title, Math.max(0, index + (event.key === 'ArrowUp' ? -1 : 1)))
  }
  const draggable = editing && !row.dropped && row.mark !== 'out'
  return (
    <div
      className={row.dropped ? 'ln drop' : 'ln'}
      data-row={row.key}
      tabIndex={editing ? 0 : undefined}
      draggable={draggable}
      onDragStart={draggable ? (event: DragEvent<HTMLDivElement>) => { event.dataTransfer.setData('text/plain', row.title) } : undefined}
      onDragOver={editing ? (event: DragEvent<HTMLDivElement>) => event.preventDefault() : undefined}
      onDrop={editing ? (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault()
        const title = event.dataTransfer.getData('text/plain')
        if (title && title !== row.title) actions.onDrag(card.id, title, index)
      } : undefined}
      onKeyDown={onKeyDown}
      aria-label={editing && draggable ? `${row.title} — ⌥↑↓ moves it` : undefined}
    >
      {editing && <GripVertical className="grip" aria-hidden="true" />}
      <Mark mark={row.mark} />
      <span className="nm" title={row.title}>{row.title}</span>
      {!editing && row.roleSet && <span className="role">{row.role}</span>}
      {!editing && <Words row={row} />}
      {editing && row.changeIds.length > 0 && (
        <button type="button" className="x" title="Drop this change" aria-label={`Drop the change to ${row.title}`} onClick={() => actions.onDrop(card.id, row.changeIds)}>
          <X aria-hidden="true" />
        </button>
      )}
      {editing && row.changeIds.length === 0 && row.droppedIds.length > 0 && (
        <button type="button" className="x restore" title="Restore this change" aria-label={`Restore the change to ${row.title}`} onClick={() => actions.onRestore(card.id, row.droppedIds)}>
          <RotateCcw aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

function ProposalBody({ card, actions, dim }: { card: PlanCard; actions: PlanProposalCardActions; dim?: boolean }): JSX.Element | null {
  const view = card.view
  if (!view) return null
  const editing = card.phase === 'editing'
  const proposed = resolveProposal(view.basis, card.entries)
  const shown = editing
    ? displayRows(view.basis, card.entries)
    : { rows: proposed.rows.map((row) => ({ ...row, dropped: false, droppedIds: [] })), removed: proposed.removed.map((row) => ({ ...row, dropped: false, droppedIds: [] })) }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && (card.phase === 'pending' || card.phase === 'editing') && !card.busy) {
      event.preventDefault()
      actions.onAccept(card.id)
    }
  }
  const headCount = editing ? 'editing' : changes(proposed.count)
  return (
    <div className={dim ? 'card plan-proposal dim' : 'card plan-proposal'} onKeyDown={onKeyDown} tabIndex={-1} aria-label="Proposed running order">
      <div className="ttl">Proposed running order <span>{headCount}</span></div>
      {proposed.createsIndexNote && (
        <div className="ln first">
          <Mark mark="add" />
          <span className="nm">Create the Index Note</span>
          {!editing && <span className="w">{stem(view.basis.indexPath)}</span>}
        </div>
      )}
      {shown.rows.map((row, index) => (
        // A row's place is counted in the order Accept writes: struck-through rows take no place.
        <OrderRow key={row.key} row={row} editing={editing} index={shown.rows.slice(0, index).filter((item) => !item.dropped).length} card={card} actions={actions} />
      ))}
      {shown.removed.map((row) => <OrderRow key={row.key} row={row} editing={editing} index={proposed.rows.length} card={card} actions={actions} />)}
      {!editing && !dim && proposed.outside.length > 0 && (
        <>
          <div className="lbl">Not in the order</div>
          {proposed.outside.map((file) => (
            <div className="ln" key={file.path}>
              <span className="nm muted" title={file.path}>{stem(file.path)}</span>
              <span className="w">file stays</span>
            </div>
          ))}
        </>
      )}
      {!dim && (editing ? <div className="why">{editSentence(card)}</div> : view.summary ? <div className="why">{view.summary}</div> : null)}
      {card.message && !dim && <div className="why error" role="status">{card.message}</div>}
      {!dim && (
        <div className="btns">
          <button type="button" className="b p" disabled={card.busy || proposed.count === 0} onClick={() => actions.onAccept(card.id)} title="Use this order (⌘↵)">
            {editing ? <>Use this order · {changes(proposed.count)}</> : <>Use this order <kbd className="k">⌘↵</kbd></>}
          </button>
          {editing ? (
            <button type="button" className="b" onClick={() => actions.onCancelEdit(card.id)}>Cancel edit</button>
          ) : (
            <>
              <button type="button" className="b" disabled={card.busy} onClick={() => actions.onEdit(card.id)}>Edit first</button>
              <button type="button" className="b" disabled={card.busy} onClick={() => actions.onDiscard(card.id)}>Discard</button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function AcceptedRow({ card, actions, refused }: { card: PlanCard; actions: PlanProposalCardActions; refused: boolean }): JSX.Element {
  const count = card.accepted?.count ?? 0
  return (
    <div className="act plan-act">
      <span className="mk add" aria-hidden="true"><Check /></span>
      <span className="atext">Running order set · {changes(count)}</span>
      <button
        type="button"
        className={refused ? 'b u dim' : 'b u'}
        disabled={card.busy}
        title={refused ? 'Try Undo again once the change in the way is undone' : 'Undo (⌘⇧Z)'}
        aria-label={refused ? 'Try Undo again' : 'Undo the running order'}
        onClick={() => actions.onUndo(card.id)}
      >
        Undo{!refused && <kbd className="k">⌘⇧Z</kbd>}
      </button>
    </div>
  )
}

export function PlanProposalCard({ card, actions }: { card: PlanCard; actions: PlanProposalCardActions }): JSX.Element {
  const [requested, setRequested] = useState(false)
  useEffect(() => {
    if (card.phase !== 'loading' || requested) return
    setRequested(true)
    actions.onLoad(card.id)
  }, [actions, card.id, card.phase, requested])

  switch (card.phase) {
    case 'loading':
      return <div className="act plan-act muted"><span className="atext">Reading the proposal…</span></div>
    case 'pending':
    case 'editing':
      return <ProposalBody card={card} actions={actions} />
    case 'accepted': {
      const accepted = card.accepted
      return (
        <div className="plan-proposal-state">
          <AcceptedRow card={card} actions={actions} refused={false} />
          <div className="why">{acceptedSentence(card)}</div>
          {accepted && (
            <div className="card plan-proposal">
              <div className="ttl">Folio outline <span>{accepted.folderName}</span></div>
              {accepted.parts.map((part, index) => (
                <div className="ln" key={`${part.title}-${index}`}><span className="w">{index + 1}</span><span className="nm">{part.title}</span></div>
              ))}
              {accepted.outside.length > 0 && (
                <>
                  <div className="lbl">In the folder, not in the order</div>
                  {accepted.outside.map((file) => (
                    <div className="ln" key={file.path}><span className="nm muted" title={file.path}>{file.title === stem(file.path) ? stem(file.path) : file.title}</span></div>
                  ))}
                </>
              )}
            </div>
          )}
          {card.message && <div className="why error" role="status">{card.message}</div>}
        </div>
      )
    }
    case 'undo-refused':
      return (
        <div className="plan-proposal-state">
          <AcceptedRow card={card} actions={actions} refused />
          <div className="act warn" role="status">
            <TriangleAlert className="icon sm warn-icon" aria-hidden="true" />
            <span className="atext">{card.message}</span>
          </div>
        </div>
      )
    case 'stale':
      return (
        <div className="plan-proposal-state">
          <ProposalBody card={card} actions={actions} dim />
          <div className="act warn" role="status">
            <TriangleAlert className="icon sm warn-icon" aria-hidden="true" />
            <span className="atext">{staleMessage(card.view?.stale ?? [])}</span>
          </div>
          <div className="btns">
            <button type="button" className="b p" disabled={card.busy} onClick={() => actions.onProposeAgain(card.id)}>Propose again</button>
            <button type="button" className="b" disabled={card.busy} onClick={() => actions.onDiscard(card.id)}>Discard</button>
          </div>
        </div>
      )
    case 'undone':
      return (
        <div className="act plan-act" data-kind="undo">
          <Undo2 className="icon sm" aria-hidden="true" />
          <span className="atext">Running order put back<small>The Index Note is as it was before the order was set.</small></span>
        </div>
      )
    case 'discarded':
      return <div className="act plan-act muted"><span className="atext">Proposal discarded<small>Nothing was written.</small></span></div>
    case 'gone':
      return <div className="act plan-act muted"><span className="atext">This proposal was replaced<small>A newer proposal for this folder supersedes it.</small></span></div>
  }
}

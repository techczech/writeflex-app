import { FolioEvidenceInspector } from './FolioRoomEvidence'
import type { RoomEvidenceRow } from '../../../shared/folio-evidence'
import type { ShownFlag } from './FolioRoomFlags'
import { FLAG_LABELS } from '../editor/flag-actions'
import { useEffect, useRef, useState } from 'react'
import type { FolioRoomModel, RoomPart } from '../../../shared/folio-room'
import { PRIORITY_LABELS } from '../../../shared/folio-room'
import { BOARD_STATUS_ORDER } from '../../../shared/collection-status'
import type { LabelChange, RoomAuthoringRequest } from '../../../shared/folio-room-authoring'

export type RoomAuthor = (request: RoomAuthoringRequest) => Promise<boolean>

export function PartSynopsis({ part, disabled, author, outline = false }: { part: RoomPart; disabled: boolean; author: RoomAuthor; outline?: boolean }): JSX.Element {
  const [draft, setDraft] = useState(part.synopsis ?? '')
  useEffect(() => setDraft(part.synopsis ?? ''), [part.synopsis, part.index, part.title])
  const save = (): void => {
    if (draft.trim() !== (part.synopsis ?? '')) void author({ op: 'line', index: part.index, expected: part.card, change: { gloss: draft.trim() || null } })
  }
  const props = {
    'aria-label': `Synopsis for ${part.title}`, value: draft, disabled, placeholder: 'Add a synopsis',
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(event.target.value),
    onBlur: save,
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); event.currentTarget.blur() }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDraft(part.synopsis ?? '') }
    },
  }
  return outline ? <input className="fr-line-input" {...props} /> : <textarea className="fr-syn fr-edit" rows={3} {...props} />
}

export function PartPick({ part, field, model, disabled, author }: { part: RoomPart; field: 'label' | 'priority' | 'status'; model: FolioRoomModel; disabled: boolean; author: RoomAuthor }): JSX.Element {
  const value = field === 'label' ? part.label?.slug ?? '' : field === 'priority' ? part.priority ?? '' : part.status
  if (field === 'status' && !part.written) return <span className="fr-val">{part.resolution ? part.status : 'idea · not written yet'}</span>
  const options = field === 'label' ? model.labels.map(label => [label.slug, label.name])
    : field === 'priority' ? Object.entries(PRIORITY_LABELS)
    : [...new Set([...BOARD_STATUS_ORDER, part.status])].map(status => [status, status])
  return <select className="fr-pick fr-edit" aria-label={`${field[0].toUpperCase() + field.slice(1)} for ${part.title}`} value={value} disabled={disabled}
    onChange={(event) => {
      if (field === 'status') void author({ op: 'status', index: part.index, expected: part.card, status: event.target.value })
      else void author({ op: 'line', index: part.index, expected: part.card, change: { [field]: event.target.value || null } })
    }}>
    {field !== 'status' && <option value="">None</option>}
    {options.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
  </select>
}

export function PartMenu({ part, field, model, disabled, author }: Parameters<typeof PartPick>[0]): JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const value = field === 'label' ? part.label?.slug ?? '' : field === 'priority' ? part.priority ?? '' : part.status
  const options = field === 'label' ? [['', 'None'], ...model.labels.map(label => [label.slug, label.name])]
    : field === 'priority' ? [['', 'None'], ...Object.entries(PRIORITY_LABELS)]
    : [...new Set([...BOARD_STATUS_ORDER, part.status])].map(status => [status, status])
  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')?.focus()
    const outside = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    window.addEventListener('pointerdown', outside)
    return () => window.removeEventListener('pointerdown', outside)
  }, [open])
  const close = (): void => { setOpen(false); trigger.current?.focus() }
  const label = options.find(([key]) => key === value)?.[1] ?? value
  return <span className="fr-part-menu" ref={root} onClick={event => event.stopPropagation()} onKeyDown={event => {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); close() }
    if (event.key === 'Tab') setOpen(false)
    if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const items = [...root.current!.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
      const at = items.indexOf(document.activeElement as HTMLElement)
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
    }
  }}>
    <button type="button" ref={trigger} className="fr-meta-menu" aria-label={`${field[0].toUpperCase() + field.slice(1)} for ${part.title}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled || (field === 'status' && !part.written)} onClick={() => setOpen(value => !value)}>{value ? label : '—'}</button>
    {open && <span className="fr-meta-options" role="menu" aria-label={`${field} for ${part.title}`}>{options.map(([key, text]) => <button type="button" role="menuitemradio" aria-checked={value === key} key={key} onClick={() => {
      close()
      if (field === 'status') void author({ op: 'status', index: part.index, expected: part.card, status: key })
      else void author({ op: 'line', index: part.index, expected: part.card, change: { [field]: key || null } })
    }}>{text}</button>)}</span>}
  </span>
}

export function FolioRoomInspector({ part, model, author, busy, flags = [], onFlag, onOpenEvidence, onInsertEvidence, onEvidenceDrop, onEvidenceOver, onRemove, extras = null }: { extras?: React.ReactNode; onRemove?: (part: RoomPart) => void; onEvidenceDrop?: (event: React.DragEvent, part: RoomPart) => boolean; onEvidenceOver?: (event: React.DragEvent) => boolean; onOpenEvidence?: (path: string) => void; onInsertEvidence?: (part: RoomPart, row: RoomEvidenceRow, quote?: string) => void; flags?: ShownFlag[]; onFlag?: (flag: ShownFlag) => void; part: RoomPart | null; model: FolioRoomModel; author: RoomAuthor; busy: boolean }): JSX.Element {
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<string>('')
  const labels = async (change: LabelChange): Promise<void> => {
    if (await author({ op: 'labels', change, basis: model.indexBasis })) { setName(''); setEditing('') }
  }
  return <aside className="fr-insp" aria-label="Inspector">
    <div className="fr-ih"><span className="lbl">{part ? `Selected part · ${part.index + 1} of ${model.parts.length}` : 'Selected part'}</span></div>
    <div className="fr-iscroll">{!part ? <div className="fr-note">Select a part to see its synopsis, label, status and priority.</div> : <>
      <div className="fr-ititle">{part.title}</div>
      <div className="fr-ifile">{part.key.path ?? 'no file yet · a plan line in the Index Note'}</div>
      {part.titleClash && <div className="fr-clash" role="note">{part.titleClash}</div>}
      <div className="fr-isec"><span>Synopsis</span></div>
      <PartSynopsis key={`${part.index}:${part.title}`} part={part} disabled={busy} author={author} />
      <dl className="fr-igrid">{(['label', 'status', 'priority'] as const).map(field => <div className="fr-field-row" key={field}>
        <dt>{field[0].toUpperCase() + field.slice(1)}</dt><dd><PartPick part={part} field={field} model={model} disabled={busy} author={author} /></dd>
      </div>)}
        {part.tags.length > 0 && <><dt>Tags</dt><dd><div className="fr-tags" data-testid="inspector-tags">{part.tags.map(tag => <span key={tag} className="fr-tag">#{tag}</span>)}</div></dd></>}
        <dt>Words</dt><dd>{part.words.toLocaleString('en-GB')}</dd>
      </dl>
      {!part.written && <LocateFile part={part} model={model} disabled={busy} author={author} />}
      {!part.written && !part.key.path && part.status === 'idea' && <button type="button" className="fr-btn" disabled={busy || Boolean(part.titleClash)} onClick={() => void author({ op: 'start', index: part.index, expected: part.card })}>Start this part</button>}
      <details className="fr-label-editor"><summary>Edit labels</summary>
        {model.duplicateLabels.length > 0 && <p role="note">Two labels in the list read as the same name.</p>}
        {model.labels.length >= 8 && <p role="note">The ninth label reuses the first colour.</p>}
        {model.labels.map(label => <div className="fr-label-row" key={label.slug}><span>{label.name}</span>
          <button type="button" disabled={busy} onClick={() => { setEditing(label.slug); setName(label.name) }}>Rename</button>
          <button type="button" disabled={busy} onClick={() => void labels({ op: 'delete', slug: label.slug })}>Delete</button></div>)}
        <form onSubmit={event => { event.preventDefault(); void labels(editing ? { op: 'rename', slug: editing, name } : { op: 'add', name }) }}>
          <label>{editing ? 'Rename label' : 'New label'}<input aria-label={editing ? 'Rename label' : 'New label'} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
          <button type="submit" disabled={busy || !name.trim()}>{editing ? 'Save label' : 'Add label'}</button>
          {editing && <button type="button" onClick={() => { setEditing(''); setName('') }}>Cancel</button>}
        </form>
      </details>
      <FolioEvidenceInspector part={part} model={model} author={author} busy={busy} onOpen={onOpenEvidence} onInsert={onInsertEvidence} onEvidenceDrop={onEvidenceDrop} onEvidenceOver={onEvidenceOver} />
      <div className="fr-isec"><span>Flags ({flags.length})</span></div>
      {flags.map(flag => <button className="fr-inspector-flag" type="button" key={flag.from} onClick={() => onFlag?.(flag)}><span className="wf-flag-tag">{FLAG_LABELS[flag.kind]}</span>{flag.words}</button>)}
      {extras}
      <div className="fr-isec"><span>Running order</span></div>
      <button type="button" className="fr-btn" data-action="remove-part" disabled={busy} title="Moves its file to the Folio bin; Undo puts it back" onClick={() => onRemove ? onRemove(part) : void author({ op: 'remove', indices: [part.index], expected: model.parts.map(item => item.card) })}>Remove from Folio</button>
    </>}</div>
  </aside>
}


/** Every unwritten row may explicitly choose an unbound file instead of starting a new one. */
export function LocateFile({ part, model, disabled, author }: { part: RoomPart; model: FolioRoomModel; disabled: boolean; author: RoomAuthor }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [path, setPath] = useState('')
  const bound = new Set(model.parts.flatMap(item => item.key.path ? [item.key.path] : []))
  const candidates = model.newCardFolio.notInOutline.filter(item => item.path && !bound.has(item.path))
  return <span onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
    <button type="button" className="fr-btn" disabled={disabled} onClick={() => setOpen(value => !value)}>Link to a file…</button>
    {open && <><select aria-label={`Link to a file for ${part.title}`} value={path} disabled={disabled} onChange={event => setPath(event.target.value)}>
      <option value="">Choose chapter file…</option>
      {candidates.map(item => <option key={item.path!} value={item.path!}>{item.title} — {item.path}</option>)}
    </select><button type="button" className="fr-btn" disabled={disabled || !path} onClick={() => void author({ op: 'locate', index: part.index, expected: part.card, path }).then(ok => { if (ok) setOpen(false) })}>Link file</button></>}
  </span>
}

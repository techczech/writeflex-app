import { noEvidence } from './FolioRoomEvidence'
import { useEffect, useRef, useState } from 'react'
import type { FolioRoomModel, RoomPart } from '../../../shared/folio-room'
import { FLAG_KINDS, findFlags, type Flag, type FlagKind } from '../../../shared/markdown/flags'
import { FLAG_LABELS } from '../editor/flag-actions'
import { onEditorUpdate } from '../editor/setup'
import type { EditorHandle } from './EditorPane'
import type { RoomAuthor } from './FolioRoomInspector'

export type RoomEditorRef = { current: EditorHandle | null }
export type ShownFlag = Flag & { path: string; fingerprint: string; live?: boolean }

export function useRoomFlags(model: FolioRoomModel | null | undefined, editor?: RoomEditorRef): Map<number, ShownFlag[]> {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = onEditorUpdate(() => { clearTimeout(timer); timer = setTimeout(() => setTick(value => value + 1), 250) })
    return () => { clearTimeout(timer); off() }
  }, [])
  void tick
  return new Map((model?.parts ?? []).map(part => {
    const current = editor?.current
    const path = part.key.path
    const live = path ? current?.rawDocFor(path) ?? null : null
    return [part.index, live !== null && path ? findFlags(live).map(flag => ({ ...flag, path, fingerprint: '', live: true })) : part.flags ?? []]
  }))
}

export function FolioRoomFlags({ model, flags, filter, onFilter, onJump, onClear, busy }: {
  model: FolioRoomModel; flags: Map<number, ShownFlag[]>; filter: FlagKind | 'all'; onFilter: (filter: FlagKind | 'all') => void;
  onJump: (part: RoomPart, flag: ShownFlag) => void; onClear: (part: RoomPart, flag: ShownFlag) => void; busy: boolean;
}): JSX.Element {
  const all = [...flags.values()].flat()
  return <div className="fr-flags" data-testid="room-flags" onKeyDown={event => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.target instanceof HTMLInputElement) return
    const at = Number(event.key) - 1
    if (event.key === '0') { event.preventDefault(); onFilter('all') }
    else if (at >= 0 && at < FLAG_KINDS.length) { event.preventDefault(); onFilter(FLAG_KINDS[at]) }
  }}>
    <div className="fr-flag-filters" role="group" aria-label="Filter flags">{(['all', ...FLAG_KINDS] as const).map(kind => <button type="button" key={kind} aria-pressed={filter === kind} onClick={() => onFilter(kind)}>{kind === 'all' ? 'All' : FLAG_LABELS[kind]} ({kind === 'all' ? all.length : all.filter(flag => flag.kind === kind).length})</button>)}</div>
    {model.parts.some(part => !part.written) && <p className="fr-note">Not written yet: {model.parts.filter(part => !part.written).map(part => part.title).join(', ')}.</p>}
    {model.evidence && model.evidence.state !== 'unreadable' && <p className="fr-note">No evidence: {model.parts.filter(part => !part.frontMatter && noEvidence(model, part)).map(part => part.title).join(', ') || 'Every part has evidence'}.</p>}
    {all.length === 0 && <div className="fr-empty"><b>No flags in this Folio.</b>Select words while writing, then choose “Flag the selection…” in the command palette.</div>}
    {model.parts.map(part => {
      const shown = (flags.get(part.index) ?? []).filter(flag => filter === 'all' || flag.kind === filter)
      return shown.length === 0 ? null : <section key={part.index}><h2>{part.index + 1}. {part.title} <small>{shown.length}</small></h2>
        {shown.map(flag => <div className="fr-flag-row" key={flag.from} onKeyDown={event => {
          if (event.key === 'Backspace' && !event.metaKey && !event.ctrlKey && !busy) { event.preventDefault(); event.stopPropagation(); onClear(part, flag) }
        }}>
          <button type="button" className="fr-flag-jump" onClick={() => onJump(part, flag)}><span className="wf-flag-tag">{FLAG_LABELS[flag.kind]}</span><span>{flag.contextBefore}<mark>{flag.words}</mark>{flag.contextAfter}</span><small>Paragraph {flag.paragraph + 1}{flag.inTable ? ' · in a table: shown as text in the editor' : ''}</small></button>
          <button type="button" className="fr-btn" disabled={busy} onClick={() => onClear(part, flag)}>Clear flag</button>
        </div>)}
      </section>
    })}
  </div>
}

import { registerRoomPending, roomNotesDraft, rememberRoomNotes, forgetRoomNotes } from '../folio-room-pending'
import { useEffect, useMemo, useRef, useState } from 'react'
import { evidenceKey, evidencePartKey, repointEvidenceLine, type EvidenceOp, type RoomEvidenceRow } from '../../../shared/folio-evidence'
import type { FolioRoomModel, RoomPart } from '../../../shared/folio-room'
import { safeLabel, safeUrl } from '../editor/citation'
import type { RoomAuthor } from './FolioRoomInspector'

const relativeFile = (model: FolioRoomModel, path: string): string => model.dir ? path.slice(model.dir.length + 1) : path
export function evidenceFor(model: FolioRoomModel, part: RoomPart) { return model.evidence?.parts[evidencePartKey(part.title)] }
export const evidenceUnreadable = (model: FolioRoomModel): boolean => model.evidence?.state === 'unreadable'
/** False while the evidence file cannot be read: the room cannot say a part has none. */
export const noEvidence = (model: FolioRoomModel, part: RoomPart): boolean => !model.enrichment && !evidenceUnreadable(model) && (evidenceFor(model, part)?.rows.length ?? 0) === 0
function UnreadableEvidence({ model }: { model: FolioRoomModel }): JSX.Element {
  return <div className="fr-empty" data-testid="room-evidence-unreadable"><b>The evidence file cannot be read.</b><p>{model.evidence?.message}</p><button type="button" className="fr-btn" onClick={() => void window.writeflex.showItem(model.evidence!.path)}>Show in Finder</button></div>
}
function lineFor(model: FolioRoomModel, candidate: { path: string; title: string; kind: 'file' | 'note' }): { key: string; value: string } {
  const eol = model.evidence?.eol ?? '\n'
  if (candidate.kind === 'note') return { key: evidenceKey(candidate.title, 'note'), value: `- [[${candidate.title}]]${eol}` }
  const target = relativeFile(model, candidate.path)
  return { key: evidenceKey(target), value: `- [${safeLabel(candidate.path.split('/').at(-1)!)}](${safeUrl(target)})${eol}` }
}

function PartNotes({ part, model, author, session }: { part: RoomPart; model: FolioRoomModel; author: RoomAuthor; session: string }): JSX.Element {
  const data = evidenceFor(model, part)
  const key = model.stateKey + '\0' + part.title
  const recovered = roomNotesDraft(key)
  const [draft, setDraft] = useState(recovered?.text ?? data?.notes ?? '')
  const [error, setError] = useState(recovered?.error ?? '')
  const [both, setBoth] = useState(false)
  const latest = useRef({ draft, basis: recovered?.basis ?? data?.notesBasis ?? null, dirty: Boolean(recovered), saving: false })
  const saveRef = useRef<() => Promise<boolean>>(() => Promise.resolve(true))
  const inFlight = useRef<Promise<boolean> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const writer = useRef(author); writer.current = author
  useEffect(() => {
    const state = latest.current
    if (state.saving) return
    if (state.dirty && state.draft === data?.notes) { state.dirty = false; forgetRoomNotes(key); setError('') }
    if (!state.dirty) { state.draft = data?.notes ?? ''; state.basis = data?.notesBasis ?? null; setDraft(state.draft) }
  }, [data?.notes, data?.notesBasis, key])
  saveRef.current = () => {
    clearTimeout(timer.current)
    if (inFlight.current) return inFlight.current.then(ok => !ok ? false : latest.current.dirty ? saveRef.current() : true)
    const state = latest.current
    if (!state.dirty) return Promise.resolve(true)
    if (/^#/m.test(state.draft)) { setError('Notes cannot hold headings.'); return Promise.resolve(false) }
    const eol = model.evidence?.eol ?? '\n'
    const value = state.draft.trim() ? state.draft.replace(/\r\n|\r|\n/g, eol).replace(/(?:\r\n|\r|\n)+$/, '') + eol + eol : null
    const sent = state.draft
    state.saving = true; state.dirty = false
    const pending = writer.current({ op: 'evidence', session, stateKey: model.stateKey, ops: [{ kind: 'notes', part: part.title, expect: state.basis, value }] }).then(ok => {
      if (ok) {
        state.basis = value; setError('')
        if (state.draft === sent) forgetRoomNotes(key)
        else rememberRoomNotes(key, { text: state.draft, basis: value })
      } else {
        state.dirty = true
        const message = `Your notes for ${part.title} were not saved. They may have changed in another app.`
        setError(message); rememberRoomNotes(key, { text: state.draft, basis: state.basis, error: message })
      }
      return ok
    }).finally(() => {
      state.saving = false; inFlight.current = null
      if (state.draft !== sent) { state.dirty = true; timer.current = setTimeout(() => { void saveRef.current() }, 800) }
    })
    inFlight.current = pending
    return pending
  }
  useEffect(() => {
    const off = registerRoomPending({ path: model.evidence?.path ?? `${model.dir}/_${model.name}_EVIDENCE-AND-NOTES.md`, dirty: () => latest.current.dirty || latest.current.saving, flush: () => saveRef.current() })
    return () => { clearTimeout(timer.current); off() }
  }, [key])
  return <div className="fr-part-notes">
    <label className="fr-isec" htmlFor={`folio-notes-${part.index}`}>Notes</label>
    <textarea id={`folio-notes-${part.index}`} aria-label={`Notes for ${part.title}`} value={draft} rows={5} placeholder="Keep notes for this part, even before it has a file."
      onChange={event => { const value = event.target.value; latest.current.draft = value; latest.current.dirty = true; rememberRoomNotes(key, { text: value, basis: latest.current.basis }); setDraft(value); setError(''); clearTimeout(timer.current); timer.current = setTimeout(() => { void saveRef.current() }, 800) }} onBlur={() => { void saveRef.current() }} />
    {error && <div className="fr-note" role="alert">{error} <button type="button" className="fr-linkbtn" onClick={() => setBoth(value => !value)}>Show both</button></div>}
    {both && <div className="fr-notes-conflict"><b>Your notes</b><pre>{draft}</pre><b>Notes saved in the Folio</b><pre>{data?.notes ?? '(none)'}</pre></div>}
  </div>
}

export function FolioEvidenceInspector({ part, model, author, busy, onOpen, onInsert, onEvidenceDrop, onEvidenceOver }: { onEvidenceDrop?: (event: React.DragEvent, part: RoomPart) => boolean; onEvidenceOver?: (event: React.DragEvent) => boolean; part: RoomPart; model: FolioRoomModel; author: RoomAuthor; busy: boolean; onOpen?: (path: string) => void; onInsert?: (part: RoomPart, row: RoomEvidenceRow, quote?: string) => void }): JSX.Element {
  const data = evidenceFor(model, part)
  const session = useMemo(() => crypto.randomUUID(), [model.stateKey])
  const [adding, setAdding] = useState(false)
  const [candidate, setCandidate] = useState('')
  const [finding, setFinding] = useState<string | null>(null)
  const [replacement, setReplacement] = useState('')
  const candidates = model.evidence?.candidates ?? []
  const write = (ops: EvidenceOp[]) => author({ op: 'evidence', session, stateKey: model.stateKey, ops })
  const attach = async (): Promise<void> => {
    const found = candidates.find(value => value.path === candidate)
    if (!found) return
    if (await write([{ kind: 'item', part: part.title, ...lineFor(model, found), expect: null }])) { setAdding(false); setCandidate('') }
  }
  if (model.enrichment) return <section className="fr-evidence-box" role="status">{model.enrichment === 'pending' ? 'Loading sources…' : 'Sources could not be loaded.'}</section>
  if (evidenceUnreadable(model)) return <section className="fr-evidence-box" aria-label={`Evidence for ${part.title}`}><UnreadableEvidence model={model} /></section>
  return <section className="fr-evidence-box" aria-label={`Evidence for ${part.title}`} onDragOver={onEvidenceOver} onDrop={event => onEvidenceDrop?.(event, part)}>
    <div className="fr-isec"><span>Evidence ({data?.rows.length ?? 0})</span><button type="button" className="fr-linkbtn" disabled={busy || Boolean(part.titleClash)} onClick={() => setAdding(value => !value)}>Add evidence</button></div>
    {!data?.rows.length && <p className="fr-note">Attach a source from Research or a workspace note. You can also drop sources and highlights here.</p>}
    {adding && <form onSubmit={event => { event.preventDefault(); void attach() }} className="fr-evidence-add">
      <label>Source or note<select aria-label="Source or note" value={candidate} onChange={event => setCandidate(event.target.value)}><option value="">Choose a source or note</option>{candidates.map(value => <option key={value.path} value={value.path}>{value.kind === 'note' ? 'Note: ' : ''}{value.title} · {value.path}</option>)}</select></label>
      <button type="submit" className="fr-btn" disabled={busy || !candidate}>Attach evidence</button>
      <button type="button" className="fr-linkbtn" onClick={() => setAdding(false)}>Cancel</button>
    </form>}
    {data?.duplicate && <p className="fr-note">This part has more than one section in its evidence file. New edits go to its first section.</p>}
    {data?.rows.map(row => <article className="fr-evidence-row" key={row.key}>
      <div>{row.path ? <button type="button" className="fr-source-title" onClick={() => /\.(?:md|markdown|mdx)$/i.test(row.path!) ? onOpen?.(row.path!) : void window.writeflex.showItem(row.path!)}>{row.title}</button> : <a className="fr-source-title" href={row.target} target="_blank" rel="noreferrer">{row.title}</a>}<small>{row.origins.join(' · ')}</small>{row.state !== 'ready' && <span className="fr-evidence-state">{row.state}</span>}</div>
      {row.item && row.removable && <button type="button" className="fr-linkbtn" disabled={busy} onClick={() => void write([{ kind: 'item', part: part.title, key: row.item!.key, expect: row.item!.raw, value: null }])}>Remove evidence</button>}
      {row.kind === 'file' && row.item && row.state !== 'ready' && <div className="fr-evidence-repair">
        {row.state === 'changed since attached' && <button type="button" className="fr-linkbtn" disabled={busy} onClick={() => void write([{ kind: 'line', part: part.title, key: row.item!.key, expect: row.item!.line, value: row.item!.line }])}>Keep</button>}
        <button type="button" className="fr-linkbtn" onClick={() => { setFinding(row.key); setReplacement('') }}>Find again</button>
      </div>}
      {finding === row.key && <form onSubmit={event => {
        event.preventDefault(); const found = candidates.find(value => value.path === replacement); if (!found || !row.item) return
        void write([{ kind: 'line', part: part.title, key: row.item.key, expect: row.item.line, value: repointEvidenceLine(row.item.line, relativeFile(model, found.path)) }]).then(ok => { if (ok) setFinding(null) })
      }}><label>Replacement source<select aria-label="Replacement source" value={replacement} onChange={event => setReplacement(event.target.value)}><option value="">Choose the replacement file</option>{candidates.filter(value => value.kind === 'file').sort((a, b) => Number(b.path.split('/').at(-1) === row.path?.split('/').at(-1)) - Number(a.path.split('/').at(-1) === row.path?.split('/').at(-1))).map(value => <option key={value.path} value={value.path}>{value.path}</option>)}</select></label><button type="submit" disabled={busy || !replacement}>Use this file</button></form>}
      {row.highlights.map(highlight => <blockquote key={highlight.key}><p>{highlight.quote ?? highlight.state ?? 'Highlight unavailable'}</p>{highlight.state && <small>{highlight.state}</small>}{highlight.quote && <button type="button" className="fr-linkbtn" disabled={!part.written || row.state !== 'ready' || Boolean(highlight.state)} onClick={() => onInsert?.(part, highlight.target ? { ...row, target: highlight.target, citationLabel: highlight.citation ?? row.citationLabel } : row, highlight.quote!)}>Insert with citation</button>}</blockquote>)}
      {row.citation && <button type="button" className="fr-linkbtn" disabled={!part.written || row.state !== 'ready'} onClick={() => onInsert?.(part, row)}>Insert citation</button>}
    </article>)}
    {data?.additionalNotes.map((notes, at) => <div className="fr-note" key={at}><b>Notes in a duplicate section</b><pre>{notes}</pre></div>)}
    <PartNotes key={`${model.stateKey}:${part.title}`} part={part} model={model} author={author} session={session} />
  </section>
}

export function FolioEvidenceView({ model, author, busy, gaps, onGaps, onSelect, onEvidenceDrop, onEvidenceOver }: { onEvidenceDrop?: (event: React.DragEvent, part: RoomPart) => boolean; onEvidenceOver?: (event: React.DragEvent) => boolean; model: FolioRoomModel; author: RoomAuthor; busy: boolean; gaps: boolean; onGaps: (gaps:boolean)=>void; onSelect: (part: RoomPart) => void }): JSX.Element {
  const session = useMemo(() => crypto.randomUUID(), [model.stateKey])
  const all = [...new Map(model.parts.flatMap(part => (evidenceFor(model, part)?.rows ?? []).map(row => [row.key, row] as const))).values()]
  const parts = model.parts.filter(part => !part.frontMatter && (!gaps || noEvidence(model, part)))
  if (evidenceUnreadable(model)) return <div className="fr-evidence-view" data-testid="room-evidence"><UnreadableEvidence model={model} /></div>
  return <div className="fr-evidence-view" data-testid="room-evidence">
    <div className="fr-evidence-tools"><label><input type="checkbox" checked={gaps} onChange={event => onGaps(event.target.checked)} /> Only gaps</label><span>{model.parts.filter(part => !part.frontMatter && noEvidence(model, part)).length} parts have no evidence</span></div>
    {!all.length ? <div className="fr-empty"><b>No evidence attached yet.</b>Select a part, then use Add evidence in the inspector or drop a source onto it.</div> : <table aria-label="Evidence attached to Folio parts"><thead><tr><th>Part</th>{all.map(row => <th key={row.key}>{row.title}</th>)}</tr></thead><tbody>{parts.map(part => <tr key={part.index} onDragOver={onEvidenceOver} onDrop={event => onEvidenceDrop?.(event, part)}><th><button type="button" className="fr-linkbtn" onClick={() => onSelect(part)}>{part.title}</button></th>{all.map(reference => {
      const present = evidenceFor(model, part)?.rows.find(row => row.key === reference.key)
      return <td key={reference.key}><button type="button" aria-label={`${part.title}: ${reference.title}`} aria-pressed={Boolean(present)} disabled={busy || Boolean(part.titleClash) || Boolean(present && !present.removable)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onSelect(part) } }}
        onClick={() => {
          let op: EvidenceOp
          if (present?.item) op = { kind: 'item', part: part.title, key: present.item.key, expect: present.item.raw, value: null }
          else if (reference.item) op = { kind: 'item', part: part.title, key: reference.item.key, expect: null, value: reference.item.line }
          else if (reference.path) op = { kind: 'item', part: part.title, ...lineFor(model, { path: reference.path, title: reference.title, kind: model.dir && !reference.path.startsWith(model.dir + '/') ? 'note' : 'file' }), expect: null }
          else return
          void author({ op: 'evidence', session, stateKey: model.stateKey, ops: [op] })
        }}>{present ? `Attached${present.highlights.length ? ` · ${present.highlights.length}` : ''}` : 'Attach'}</button></td>
    })}</tr>)}</tbody></table>}
  </div>
}

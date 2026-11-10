import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Mail, Plus, RefreshCw, Trash2, Users } from 'lucide-react'
import { askConfirm } from '../confirm-bus'
import type { PeopleChange, PeopleState } from '../../../../shared/sharing-people'

/** One share's owner projection; every successful change is reread from the service. */
export function SharingPeople({ shareId, onFlash }: { shareId: string; onFlash(message: string): void }): JSX.Element {
  const [state, setState] = useState<PeopleState | null>(null)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState(''), [email, setEmail] = useState('')
  const active = useRef(false), pending = useRef(false)
  const load = useCallback(async (change?: PeopleChange) => {
    if (pending.current) return false
    pending.current = true
    setBusy(true)
    try {
      const answer = await window.writeflex.sharing.people(shareId, change)
      if (!active.current) return false
      if (!answer.ok) { setProblem(answer.problem); return false }
      setState(answer.state)
      setProblem('')
      return true
    } catch { if (active.current) setProblem('People could not be loaded. Try again.'); return false }
    finally { pending.current = false; if (active.current) setBusy(false) }
  }, [shareId])
  useEffect(() => {
    active.current = true
    void load()
    const refresh = () => { if (!document.hidden) void load() }
    window.addEventListener('focus', refresh)
    const timer = window.setInterval(refresh, 15_000)
    return () => { active.current = false; window.clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [load])
  const copy = async (id: string) => {
    try {
      const address = await window.writeflex.sharing.personAddress(shareId, id)
      if (!address) { onFlash('This personal link could not be copied. Try again.'); return }
      await navigator.clipboard.writeText(address)
      onFlash('Personal link copied.')
    } catch { onFlash('This personal link could not be copied. Try again.') }
  }
  const reissue = async (id: string, personName: string) => {
    const confirmed = await askConfirm({
      title: `Make a new link for ${personName}?`,
      detail: 'Their current link stops working.',
      recover: 'Use Copy link or Email invitation to give them the new link.',
      confirmLabel: 'New link',
    })
    if (confirmed && active.current && await load({ id, reissue: true })) onFlash('New personal link made.')
  }
  return <section className="shr-people" data-testid="sharing-people" aria-label="People">
    <header><Users className="icon" aria-hidden="true" /><h3>People</h3><span className="grow" /><span className="shr-dim">{state?.people.length || ''}</span></header>
    {problem && <p role="alert" className="shr-p">{problem} <button className="shr-btn small" disabled={busy} onClick={() => void load()}>Retry</button></p>}
    {!state && !problem && <p className="shr-p shr-dim">Loading people…</p>}
    {state && <>
      {!state.people.length && <p className="shr-p shr-dim">No personal links yet</p>}
      <div className="shr-people-rows">{state.people.map(person => <div className="shr-person" key={person.id} data-person={person.id}>
        <div className="shr-person-id"><b>{person.name}</b><span>{person.email}</span></div>
        <div className="shr-person-facts"><span title={person.openedAt ? `${new Date(person.openedAt).toLocaleString('en-GB')} · ${person.openCount} openings` : undefined}>{person.openedAt ? `Opened ${new Date(person.openedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : 'Not opened yet'}</span><span>{person.commentCount} {person.commentCount === 1 ? 'comment' : 'comments'}</span></div>
        <div className="shr-person-actions">
          <button className="shr-btn small" disabled={busy || person.status !== 'on'} onClick={() => void copy(person.id)}><Copy className="icon" aria-hidden="true" />Copy link</button>
          <button className="shr-btn small" disabled={busy || person.status !== 'on'} onClick={() => void window.writeflex.sharing.personInvitation(shareId, person.id).then(ok => { if (!ok) onFlash('The invitation draft could not be opened. Try again.') }).catch(() => onFlash('The invitation draft could not be opened. Try again.'))}><Mail className="icon" aria-hidden="true" />Email invitation</button>
          <button className="shr-sw" role="switch" aria-checked={person.status === 'on'} aria-label={`${person.name} personal link`} disabled={busy} onClick={() => void load({ id: person.id, status: person.status === 'on' ? 'off' : 'on' })}><span className="trk" aria-hidden="true" />{person.status === 'on' ? 'On' : 'Off'}</button>
          <details className="shr-person-menu"><summary aria-label={`Actions for ${person.name}`}>•••</summary><div><button className="shr-btn small" disabled={busy} onClick={() => void reissue(person.id, person.name)}><RefreshCw className="icon" aria-hidden="true" />New link</button><button className="shr-btn small" disabled={busy} onClick={() => void load({ id: person.id, remove: true })}><Trash2 className="icon" aria-hidden="true" />Remove</button><p>Comments stay in the margin.</p></div></details>
        </div>
      </div>)}</div>
      <form className="shr-add-person" onSubmit={event => { event.preventDefault(); void load({ name, email }).then(ok => { if (ok) { setName(''); setEmail('') } }) }}>
        <label>Name<span className="shr-inp"><input aria-label="Person name" placeholder="Full name" maxLength={80} required value={name} onChange={event => setName(event.target.value)} /></span></label>
        <label>Email<span className="shr-inp"><input aria-label="Person email" placeholder="name@example.com" type="email" maxLength={254} required value={email} onChange={event => setEmail(event.target.value)} /></span></label>
        <button type="submit" className="shr-btn primary" disabled={busy || state.people.length >= 100}><Plus className="icon" aria-hidden="true" />Add person</button>
      </form>
      <p className="shr-people-help">Personal links work on any device. Comments made earlier through the plain link stay separate. Anyone the person forwards their link to can comment as them.</p>
      <div className="shr-plain-choice"><div><b>Anyone with the link</b><p>{state.plainLink ? 'Anyone with the plain link can read and comment.' : 'The plain link is off. Only personal links work.'}</p></div><button role="switch" aria-checked={state.plainLink} aria-label="Anyone with the link" className="shr-sw" disabled={busy} onClick={() => void load({ plainLink: !state.plainLink })}><span className="trk" aria-hidden="true" />{state.plainLink ? 'On' : 'Off'}</button></div>
    </>}
  </section>
}

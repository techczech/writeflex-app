// The agent-skill offer (design element 19; mockup frames 1-4 and 6).
//  - AgentSkillStep: on a first use, a dialog over the start screen: the agents found, each ticked,
//    "Install skill" and "Not now", a "What this does" disclosure that names the folders, then a finished state.
//  - AgentSkillMark: later, one offer per agent found after that, in the status bar.
// The words are the owner's (shared/agent-skill/wording.ts); main does every write and keeps links and
// unmarked folders. Nothing here is a startup failure: an offer that cannot be read shows nothing.
import { useEffect, useRef, useState } from 'react'
import { Plug } from 'lucide-react'
import { skillWording, joinNames, cliWords, cliAcceptable, rowWords } from '../../../shared/agent-skill/wording'
import { AGENT_SKILL_IDENTITY } from '../../../shared/agent-skill-identity'
import type { ActionReport, AgentRow, Offer } from '../../../shared/agent-skill/types'
import { agentSkillBridge, useAgentSkillOffer } from '../lib/agentSkillOffer'

const W = skillWording(AGENT_SKILL_IDENTITY)
const OK = ['installed', 'updated', 'unchanged']

function OfferList({ offer, ticked, toggle }: { offer: Offer; ticked: Set<string>; toggle: (id: string) => void }): JSX.Element {
  return (
    <div className="cf-box keep">
      {offer.agents.map((a) => (
        <label key={a.id} className="cf-row" data-agent-offer-row={a.id}>
          <input type="checkbox" checked={ticked.has(a.id)} onChange={() => toggle(a.id)} />
          <span><b>{a.name}</b><small>{W.foundLine}</small></span>
        </label>
      ))}
      {offer.via.map((v) => (
        <div key={v.name} className="cf-row"><span><b>{v.name}</b><small>{W.viaLine(v.name, v.through).slice(v.name.length + 1)}</small></span></div>
      ))}
    </div>
  )
}

export function AgentSkillStep(): JSX.Element | null {
  const [offer, setOffer] = useAgentSkillOffer()
  const [ticked, setTicked] = useState<Set<string> | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<ActionReport | null>(null)
  const installRef = useRef<HTMLButtonElement | null>(null)
  const open = !!offer && offer.kind === 'first-run'
  useEffect(() => { if (open) installRef.current?.focus() }, [open])
  const api = agentSkillBridge()
  if (!api || !offer || offer.kind !== 'first-run') return done ? <Finished report={done} close={() => { setDone(null); setOffer(null) }} /> : null
  const on = ticked ?? new Set(offer.agents.map((a) => a.id))
  const toggle = (id: string): void => setTicked((cur) => { const n = new Set(cur ?? on); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const answer = (install: string[]): void => {
    if (busy) return
    setBusy(true)
    const all = offer.agents.map((a) => a.id)
    void api.answerOffer({ install, decline: all.filter((id) => !install.includes(id)) })
      .then((report) => { setOffer(null); if (install.length && report.rows.some((x) => OK.includes(x.result) || x.result === 'failed')) setDone(report) })
      .catch(() => setOffer(null)).finally(() => setBusy(false))
  }
  const folders = offer.agents.filter((a) => on.has(a.id) && a.folder).map((a) => ({ name: a.name, folder: `${a.folder}/${AGENT_SKILL_IDENTITY.skillName}` }))
  const disclosure = W.disclosure(folders, AGENT_SKILL_IDENTITY.cli.command, offer.via.map((v) => W.viaLine(v.name, v.through)))
  return (
    <div className="overlay confirm-overlay" data-agent-skill-step>
      <div className="sheet confirm" role="dialog" aria-modal="true" aria-labelledby="agent-skill-title"
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); answer([]) } }}>
        <div className="cf-head">
          <span className="cf-ico" aria-hidden="true"><Plug className="icon" /></span>
          <h2 id="agent-skill-title">{W.title}</h2>
        </div>
        <p className="cf-lead">{W.text}</p>
        <OfferList offer={offer} ticked={on} toggle={toggle} />
        <details data-agent-what-this-does>
          <summary>{W.whatThisDoes}</summary>
          {disclosure.map((line, i) => <p key={i} className="cf-lead">{line}</p>)}
        </details>
        <div className="cf-foot">
          <button type="button" className="btn" disabled={busy} data-agent-not-now onClick={() => answer([])}>{W.notNow}<kbd>esc</kbd></button>
          <button ref={installRef} type="button" className="btn primary" disabled={busy || on.size === 0} data-agent-install-skill onClick={() => answer([...on])}>{W.install}</button>
        </div>
      </div>
    </div>
  )
}

function Finished({ report, close }: { report: ActionReport; close: () => void }): JSX.Element {
  const ok = report.rows.filter((r) => OK.includes(r.result))
  const failed = report.rows.filter((r) => r.result === 'failed').map((r) => {
    const row = report.status.agents.find((a) => a.id === r.id)
    const words = rowWords({ ...(row ?? ({ id: r.id, name: r.name } as AgentRow)), state: 'failed', reason: r.message || row?.reason || undefined } as AgentRow)
    return { id: r.id, name: r.name, ...words }
  })
  const first = ok[0]?.name ?? 'your agent'
  const doneRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { doneRef.current?.focus() }, [])
  return (
    <div className="overlay confirm-overlay" data-agent-skill-done>
      <div className="sheet confirm" role="dialog" aria-modal="true" aria-labelledby="agent-skill-done-title">
        <div className="cf-head">
          <span className="cf-ico" aria-hidden="true"><Plug className="icon" /></span>
          <h2 id="agent-skill-done-title">{ok.length ? W.doneTitle : 'The skill was not installed'}</h2>
        </div>
        {ok.length > 0 && <p className="cf-lead">{W.doneLead}</p>}
        {ok.length > 0 && <div className="cf-box keep">{ok.map((r) => <div key={r.id} className="cf-row"><b>{r.name}</b></div>)}</div>}
        {failed.length > 0 && (
          <div className="cf-box keep" data-agent-failed>
            {failed.map((f) => <div key={f.id} className="cf-row" data-agent-failed-row={f.id}><span><b>{f.name}</b> · {f.status}<small>{f.detail}</small></span></div>)}
          </div>
        )}
        {report.cli && !cliAcceptable(report.cli) && <p className="cf-lead" data-agent-cli-blocked>{cliWords(report.cli, true)}</p>}
        {ok.length > 0 && <p className="cf-lead"><b>{W.tryHeading}</b></p>}
        {ok.length > 0 && <p className="cf-lead">“{W.tryExample(first)}”</p>}
        <div className="cf-foot"><button ref={doneRef} type="button" className="btn primary" data-agent-done onClick={close}>{W.done}</button></div>
      </div>
    </div>
  )
}

/** The later offer: a mark in the status bar, opened to a small notice. Shown once per agent. */
export function AgentSkillMark(): JSX.Element | null {
  const [offer, setOffer] = useAgentSkillOffer()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const api = agentSkillBridge()
  if (!api || !offer || offer.kind !== 'later') return null
  const names = offer.agents.map((a) => a.name)
  const ids = offer.agents.map((a) => a.id)
  const finish = (): void => { setOpen(false); setOffer(null) }
  return (
    <span className="sb-agent-skill" data-sb-resident>
      <button type="button" className="sb-agent-skill-mark" data-agent-skill-mark aria-expanded={open} title={W.laterMark(names)}
        onClick={() => { if (!open) void api.offerShown(ids); setOpen((v) => !v) }}>{W.laterMark(names)}</button>
      {open && (
        <div role="dialog" aria-label={W.laterTitle(names)} data-agent-skill-popover className="sb-agent-skill-popover">
          <b>{W.laterTitle(names)}</b>
          <p>{W.laterText(names)}</p>
          <div className="sb-agent-skill-actions">
            <button type="button" className="btn primary" disabled={busy} data-agent-install-skill onClick={() => { setBusy(true); void api.install(ids).catch(() => {}).finally(() => { setBusy(false); finish() }) }}>{W.install}</button>
            <button type="button" className="btn" disabled={busy} data-agent-not-now onClick={() => { void api.decline(ids).catch(() => {}).finally(finish) }}>{W.notNow}</button>
          </div>
          <small>Agents: {joinNames(names)}. Change this any time in Settings.</small>
        </div>
      )}
    </span>
  )
}

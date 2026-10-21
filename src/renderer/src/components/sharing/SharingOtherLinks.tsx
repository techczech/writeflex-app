// Links of another kind on the Sharing page's file or folder (ticket 09, review round 1, findings 3 and
// 4): every link that is on stays reachable, so it can always be turned off.
//
//   - On a Folio's page opened from a part: the part's own piece links (made while the file was not a
//     part). They still publish the file alone.
//   - On a piece's or a Folio's page: the links of a folder above it that is no longer a Folio. Readers
//     still see the copy published last.
//
// Drawn from the locked frames (`folio`, `shared-several`): the panel and its header, the state chip, the
// small Copy link and Turn off buttons. Added here: the panel itself, one row per link (name, state,
// buttons) and a line saying what the links publish. Main lets this page only copy, open and turn off
// these links (sharing-piece-ipc.ts `also`); renaming, turning on and making stay on their own page.
import { CircleCheck, CloudOff, Copy, FileQuestion, FileText, Layers, Minus, PowerOff, TriangleAlert } from 'lucide-react'
import { linkLabel, type OtherLinks, type ShareLinkView } from '../../../../shared/sharing-links'
import { linkState } from './sharing-page-model'

/** `limit`: readers on the link ran into a limit (ticket 07): a published link shows "Limit reached" (frame `problems`). */
export function StateChip({ link, limit = false }: { link: ShareLinkView; limit?: boolean }): JSX.Element {
  const base = linkState(link)
  const state = limit && (base.kind === 'published' || base.kind === 'nothing') ? { kind: 'limit-reached', label: 'Limit reached', tone: 'warn' } as const : base
  const Icon = state.kind === 'off' ? PowerOff : state.kind === 'not-published' ? CloudOff : state.kind === 'not-found' ? FileQuestion : state.kind === 'part-missing' || state.kind === 'limit-reached' ? TriangleAlert : state.kind === 'published' ? CircleCheck : Minus
  return <span className={`shr-chip ${state.tone}`} data-state={state.kind}><Icon className="icon" aria-hidden="true" />{state.label}</span>
}

const fileName = (path: string): string => path.split('/').at(-1) ?? path
const folderName = (path: string): string => (path === '' ? 'the Workspace' : path.split('/').at(-1) ?? path)

export function OtherLinksPanel({ group, busy, onCopy, onTurnOff }: {
  group: OtherLinks
  busy: boolean
  onCopy: (link: ShareLinkView) => void
  onTurnOff: (link: ShareLinkView) => void
}): JSX.Element {
  const piece = group.kind === 'piece'
  const title = piece ? `Links for ${fileName(group.path)} on its own` : `Links for the Folio in ${folderName(group.path)}`
  const says = piece
    ? 'These links share this file alone, not the Folio. They stay on until you turn them off.'
    : 'This folder is no longer a Folio. Readers of these links still see the copy published last until you turn them off.'
  return (
    <div className="shr-panel" data-testid="sharing-other-links" data-kind={group.kind}>
      <div className="shr-panel-h">{piece ? <FileText className="icon" aria-hidden="true" /> : <Layers className="icon" aria-hidden="true" />}<span>{title}</span></div>
      <ul className="shr-other">
        {group.links.map((link) => (
          <li key={link.shareId} data-other-share={link.shareId} className={link.on ? '' : 'off'}>
            <span className="t">{linkLabel(link)}</span>
            <StateChip link={link} />
            <button type="button" className="shr-btn small" onClick={() => onCopy(link)}><Copy className="icon" aria-hidden="true" />Copy link</button>
            {link.on && <button type="button" className="shr-btn small" disabled={busy} onClick={() => onTurnOff(link)}><PowerOff className="icon" aria-hidden="true" />Turn off</button>}
          </li>
        ))}
      </ul>
      <p className="shr-p shr-dim shr-parts-foot">{says}</p>
    </div>
  )
}

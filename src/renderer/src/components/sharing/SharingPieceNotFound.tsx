// "Piece not found" (sharing ticket 04, orchestrator ruling round 1, R-B): a row at the top of the right
// column, drawn as the other problem rows of the locked frame `problems` (the panel, its header with an
// icon and a word, one or two sentences of what happened and what readers see, then the actions).
// Used by the Sharing page and the Shares list.
//
// The link is on, but its piece is not where the share has it: deleted or moved outside WriteFlex, or its
// folder cannot be read now. Nothing is published to it and nothing has been removed. Turn off always;
// "Follow to <path>" only when main found the one place holding the same file. The window names only the
// link: main follows to the place it found itself (sharing-piece-ipc.ts `sharing:follow-to`).
import { FileQuestion, MoveRight, PowerOff } from 'lucide-react'
import { pieceNotFoundOffText, pieceNotFoundText, type ShareLinkView } from '../../../../shared/sharing-links'
import { shortTime } from './sharing-view-model'

export function PieceNotFoundPanel({ link, where, busy, onTurnOff, onFollow, offNotFound = false }: {
  link: ShareLinkView
  /** How the sentence names the piece ("this piece", "Notes/Draft.md"). */
  where: string
  busy: boolean
  onTurnOff: () => void
  onFollow: () => void
  /** Ticket 11: the page's piece is not on disk and this link is off: the row says so, with nothing to
   *  press (Turn on waits for the piece; main refuses it meanwhile). */
  offNotFound?: boolean
}): JSX.Element | null {
  if (!link.on && offNotFound) {
    return (
      <div className="shr-panel problem" data-problem="piece-not-found" data-why="gone">
        <div className="shr-panel-h"><FileQuestion className="icon" aria-hidden="true" /><span>Piece not found</span></div>
        <div className="shr-panel-b"><p className="shr-p" data-testid="sharing-not-found-text">{pieceNotFoundOffText(where)}</p></div>
      </div>
    )
  }
  if (!link.on || !link.lost) return null
  const lastCopy = link.publishedAt ? shortTime(link.publishedAt) : null
  return (
    <div className="shr-panel problem" data-problem="piece-not-found" data-why={link.lost.why}>
      <div className="shr-panel-h"><FileQuestion className="icon" aria-hidden="true" /><span>Piece not found</span></div>
      <div className="shr-panel-b">
        <p className="shr-p" data-testid="sharing-not-found-text">{pieceNotFoundText(link.lost, where, lastCopy)}</p>
        <div className="shr-row" style={{ marginTop: 10, flexWrap: 'wrap', gap: 8 }}>
          {link.lost.candidate && (
            <button type="button" className="shr-btn primary small" disabled={busy} onClick={onFollow}>
              <MoveRight className="icon" aria-hidden="true" />Follow to {link.lost.candidate}
            </button>
          )}
          <button type="button" className="shr-btn small" disabled={busy} onClick={onTurnOff}>
            <PowerOff className="icon" aria-hidden="true" />Turn off
          </button>
        </div>
      </div>
    </div>
  )
}

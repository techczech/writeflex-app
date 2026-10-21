import { useEffect, useRef, type KeyboardEvent } from 'react'
import { ArrowUpRight, FileText, SkipForward } from 'lucide-react'
import { elsewhereRows } from './status-bar-model'
import type { OtherPiece } from '../app/margin-model'

/**
 * "Waiting in N other pieces" (ticket 07, frame `elsewhere`): the popover the review line opens. One row per piece with
 * its count, who it is from and its first item's words, an Open button, and Next piece with items waiting (the chord
 * beside it). It decides nothing itself: Open and Next piece go through callbacks.
 */
export type ElsewhereControls = {
  pieces: OtherPiece[]
  /** The folder the pieces are in, for the heading. */
  folderName: string
  onOpen: (path: string, firstId: string) => void
  onNextPiece: () => void
  nextPieceChord: string
}

export function ElsewherePopover({ controls, onClose }: { controls: ElsewhereControls; onClose: () => void }): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const rows = elsewhereRows(controls.pieces)
  useEffect(() => { rootRef.current?.querySelector<HTMLButtonElement>('button')?.focus() }, [])
  useEffect(() => {
    const away = (event: MouseEvent): void => {
      const target = event.target as HTMLElement
      if (!rootRef.current?.contains(target) && !target.closest('[data-testid="status-review-elsewhere"]')) closeRef.current()
    }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [])
  useEffect(() => { if (rows.length === 0) closeRef.current() }, [rows.length])
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
    event.stopPropagation()
  }
  return (
    <div ref={rootRef} className="rbp rbp-elsewhere" role="dialog" aria-modal="false" aria-label="Waiting in other pieces" data-testid="review-elsewhere" onKeyDown={onKeyDown}>
      <div className="rnp-h">Waiting in other pieces{controls.folderName ? ` of ${controls.folderName}` : ''}</div>
      <div className="rnp-list">
        {rows.map((row) => (
          <div key={row.path} className="rel-row" data-elsewhere-piece={row.path}>
            <FileText className="icon" aria-hidden="true" />
            <div className="rel-main">
              <b title={row.path}>{row.name}</b>
              <span>{row.sources}</span>
              {row.first && <span>{row.first}</span>}
            </div>
            <span className="rel-n">{row.count}</span>
            <button type="button" className="rbp-btn" data-margin-action="open-piece" aria-label={`Open ${row.name}`} onClick={() => { onClose(); controls.onOpen(row.path, row.firstId) }}><ArrowUpRight className="icon" aria-hidden="true" />Open</button>
          </div>
        ))}
      </div>
      <button type="button" className="rel-next" data-margin-action="next-piece" onClick={() => { onClose(); controls.onNextPiece() }}>
        <SkipForward className="icon" aria-hidden="true" />
        <span>Next piece with items waiting</span>
        {controls.nextPieceChord && <kbd className="sb-review-kbd">{controls.nextPieceChord}</kbd>}
      </button>
    </div>
  )
}

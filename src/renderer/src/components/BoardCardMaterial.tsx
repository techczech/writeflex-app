import type { DragEvent } from 'react'
import type { DrawerScrap, QueryRow } from '../../../preload'
import { writeScrapDrag } from '../editor/scraps'

const plural = (count: number, one: string): string => `${count} ${count === 1 ? one : `${one}s`}`

export type BoardCardChipsProps = {
  row: Pick<QueryRow, 'title' | 'scrapCount' | 'sourceCount'>
  drawerOpen: boolean
  onToggleDrawer: () => void
}

/** The card's material chips (locked design frame 1): an amber scraps chip and a blue sources chip.
 *  A piece with neither shows nothing. Each chip opens and closes the card's drawer. */
export function BoardCardChips({ row, drawerOpen, onToggleDrawer }: BoardCardChipsProps): JSX.Element | null {
  if (row.scrapCount === 0 && row.sourceCount === 0) return null
  const chip = (kind: 'scraps' | 'sources', count: number, one: string): JSX.Element | null => count === 0 ? null : (
    <button
      type="button"
      className={`bc-chip ${kind}`}
      aria-expanded={drawerOpen}
      aria-label={`${plural(count, one)} — ${drawerOpen ? 'close' : 'open'} what ${row.title} is made of`}
      onClick={onToggleDrawer}
      onDoubleClick={(event) => event.stopPropagation()}
    >{plural(count, one)}</button>
  )
  return <>{chip('scraps', row.scrapCount, 'scrap')}{chip('sources', row.sourceCount, 'source')}</>
}

/** The card's progress chip (checkbox-lists design, frame 9): the boxes anywhere in the piece, as
 *  "n / m to do" while any is open and a green "m / m done" once all are ticked. A piece without
 *  boxes shows nothing. */
export function BoardCardTasks({ row }: { row: Partial<Pick<QueryRow, 'taskOpen' | 'taskDone'>> }): JSX.Element | null {
  const open = row.taskOpen ?? 0
  const total = open + (row.taskDone ?? 0)
  if (total === 0) return null
  return open === 0
    ? <span className="bc-chip tasks done" aria-label={`All ${total} boxes ticked`}>{total} / {total} done</span>
    : <span className="bc-chip tasks" aria-label={`${open} of ${total} boxes still to do`}>{open} / {total} to do</span>
}

/** A drawer scrap drag: the Scratchpad's own payload, and the card's stage drag never starts. */
export function startDrawerScrapDrag(event: Pick<DragEvent, 'dataTransfer' | 'stopPropagation'>, scrap: DrawerScrap): void {
  event.stopPropagation()
  writeScrapDrag(event.dataTransfer, scrap)
}

/** The card's drawer (locked design frame 1): scraps by their first words, then sources by title,
 *  each kind followed by "+ n more". Each scrap offers "Add to end of piece" (the Board covers the
 *  editor, so this is how a scrap reaches the piece from here), and still drags as from the Scratchpad. */
export function BoardCardDrawer({ row, onAppend, busy = false }: {
  row: Pick<QueryRow, 'title' | 'drawer'>
  onAppend?: (scrap: DrawerScrap) => void
  busy?: boolean
}): JSX.Element | null {
  const drawer = row.drawer
  if (!drawer) return null
  return (
    <div className="bc-drawer" role="list" aria-label={`What ${row.title} is made of`}>
      {drawer.scraps.map((scrap) => (
        <div
          key={scrap.id}
          className="bc-dr-it scrap"
          role="listitem"
          draggable
          title={scrap.text}
          data-scrap-id={scrap.id}
          onDragStart={(event) => startDrawerScrapDrag(event, scrap)}
        ><b>scrap</b><span>{scrap.firstWords}</span>{onAppend && (
          <button
            type="button"
            className="bc-dr-append"
            disabled={busy}
            aria-label={`Add “${scrap.firstWords}” to the end of ${row.title}`}
            onClick={(event) => { event.stopPropagation(); onAppend(scrap) }}
            onDoubleClick={(event) => event.stopPropagation()}
          >Add to end of piece</button>
        )}</div>
      ))}
      {drawer.moreScraps > 0 && <div className="bc-dr-more" role="listitem">+ {plural(drawer.moreScraps, 'more scrap')}</div>}
      {drawer.sources.map((source) => (
        <div key={source.path ?? source.title} className="bc-dr-it source" role="listitem" title={source.path ?? source.title}>
          <b>source</b><span>{source.title}</span>
        </div>
      ))}
      {drawer.moreSources > 0 && <div className="bc-dr-more" role="listitem">+ {plural(drawer.moreSources, 'more source')}</div>}
    </div>
  )
}

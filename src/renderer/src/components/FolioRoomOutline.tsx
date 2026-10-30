import { sectionOutlineRows, sectionKeyTarget } from '../../../shared/folio-sections'
import { useOutlinePartDrag } from './folio-outline-drag'
import { roomPartRenderKey } from '../../../shared/folio-room'
import { outlineHeadingRows, filterOutlinePart, headingRoute, type FolioHeadingTarget } from '../../../shared/folio-workspace-headings'
import { Fragment, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { noEvidence, evidenceFor, evidenceUnreadable } from './FolioRoomEvidence'
import type { ShownFlag } from './FolioRoomFlags'
import { LocateFile, PartMenu, type RoomAuthor } from './FolioRoomInspector'
import type { FolioRoomModel } from '../../../shared/folio-room'
import { Lightbulb } from 'lucide-react'
import type { KeyboardEvent, ReactNode, RefObject } from 'react'
import type { RoomPart } from '../../../preload'
import { PRIORITY_LABELS, outlineTotals, stageClass } from '../../../shared/folio-room'
import { roomMoveChord, type PartDrag } from './FolioRoomOrder'

/**
 * The Outline view of the Folio room (mockup frame 3): one row per part, in running order, with title and synopsis,
 * label, status, priority and words. Rows reorder by drag and ⌥↑↓ (ticket 11): this view only draws and hands the drag
 * to the room, which makes the one write (FolioRoom.tsx). The Sources
 * and Flags columns of the drawing join with the evidence and flag tickets, so they are not drawn yet. A part with no
 * file is drawn dashed with no word count.
 */

function Status({ part }: { part: RoomPart }): JSX.Element {
  const cls = part.resolution ? 'missing' : part.written || part.status === 'idea' ? stageClass(part.status) : 'idea'
  const text = part.status
  return <span className={`fr-stage ${cls}`}><span className="sd" />{text.toLowerCase() === 'unsorted' ? 'Unsorted' : text}</span>
}

export type FolioRoomOutlineProps = {
  /** The parts the room draws, in running order (front matter is not among them). */
  titleWidth?: number
  onTitleWidth?: (width: number | null) => void
  parts: RoomPart[]
  /** Running-order index of the shown selection. */
  shown: number | null
  listRef: RefObject<HTMLDivElement>
  onSelect: (part: RoomPart, event?: Pick<React.MouseEvent, 'shiftKey' | 'metaKey' | 'ctrlKey'>, visible?: readonly number[]) => void
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  /** Drag a row onto another to put it in that row's place. */
  drag: PartDrag
  onMove?: (from: number, to: number, sourceKey: string) => Promise<void>
  onDragActive?: (active: boolean) => void
  onDragRefuse?: (message: string) => void
  /** The New card composer row, drawn under the rows while it is open (null: the room does not write). */
  flags?: Map<number, ShownFlag[]>
  model?: FolioRoomModel
  author?: RoomAuthor
  busy?: boolean
  multi?: ReadonlySet<number>
  newCard?: ReactNode
  /** Existing editor outline, including heading navigation and guarded running-order actions, reused in the workspace. */
  headingOutline?: ReactNode
  expanded?: readonly string[]
  onExpanded?: (paths: string[]) => void
  onHeading?: (target: FolioHeadingTarget) => void
}

export function FolioRoomOutline({ titleWidth, onTitleWidth, parts, shown, listRef, onSelect, onKeyDown, drag, onMove, onDragActive, onDragRefuse, newCard = null, model, author, busy = false, multi, flags, headingOutline = null, expanded = [], onExpanded, onHeading }: FolioRoomOutlineProps): JSX.Element {
  const column = useRef<HTMLDivElement>(null)
  const resizing = useRef<{ x: number; width: number } | null>(null)
  const totals = outlineTotals(parts)
  const [filter, setFilter] = useState('')
  const filtering = filter.trim() !== ''
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<string>>(new Set())
  const collapsed = new Set(parts.filter(part => collapsedSections.has(part.outline?.path ?? '')).map(part => part.index))
  const sectionRows = sectionOutlineRows(parts, filtering ? new Set() : collapsed)
  const allSectionRows = sectionOutlineRows(parts, new Set())
  const sectionFacts = new Map(sectionRows.map(row => [row.index, row]))
  const toggleSection = (part: RoomPart, shut = !collapsed.has(part.index)): void => {
    const path = part.outline?.path
    if (!path) return
    setCollapsedSections(previous => { const next = new Set(previous); if (shut) next.add(path); else next.delete(path); return next })
    if (shut) onSelect(part)
  }
  const startDrag = useOutlinePartDrag({ listRef, allParts: (model?.parts ?? parts).map(part => ({ index: part.index, key: JSON.stringify(part.card) })), enabled: !filtering && drag.props(0).draggable, onMove: (from, to, sourceKey) => onMove?.(from, to, sourceKey), onActive: active => onDragActive?.(active), onRefuse: message => onDragRefuse?.(message) })
  const rows = parts.filter(part => sectionFacts.has(part.index)).map(part => ({ part, ...filterOutlinePart(part.title, part.outline, filter) }))
  if (filtering) {
    const parents = new Set(rows.filter(row => row.keep).map(row => sectionFacts.get(row.part.index)?.sectionIndex))
    for (const row of rows) if (parents.has(row.part.index)) row.keep = true
  }
  const toggle = (path: string): void => onExpanded?.(expanded.includes(path) ? expanded.filter(value => value !== path) : [...expanded, path])
  return (
    <div className="fr-ol" ref={column} data-testid="room-outline" style={{ '--fr-title-width': titleWidth ? `${titleWidth}px` : 'minmax(140px, 1fr)' } as React.CSSProperties}>
      <div className="fr-otools" data-testid="outline-heading-tools">
        <button type="button" className="fr-tb" onClick={() => onExpanded?.(parts.flatMap(part => part.outline && outlineHeadingRows(part.outline).length ? [part.outline.path] : []))}><ChevronDown aria-hidden="true" />Expand all</button>
        <button type="button" className="fr-tb" onClick={() => onExpanded?.([])}><ChevronRight aria-hidden="true" />Collapse all</button>
        {allSectionRows.some(row => row.sectionPage) && <button type="button" className="fr-tb" onClick={() => {
          setCollapsedSections(new Set(parts.flatMap(part => part.outline?.sectionPage ? [part.outline.path] : [])))
          const owner = allSectionRows.find(row => row.index === shown)?.sectionIndex
          const section = parts.find(part => part.index === owner)
          if (section) onSelect(section)
        }}><ChevronRight aria-hidden="true" />Collapse all sections</button>}
        {allSectionRows.some(row => row.sectionPage) && <button type="button" className="fr-tb" onClick={() => setCollapsedSections(new Set())}>Expand all sections</button>}
        <input className="fr-heading-filter" type="text" aria-label="Filter headings" placeholder="Filter headings…" value={filter} onChange={event => setFilter(event.target.value)} />
      </div>
      <div className="fr-olbar"><span className="fr-sort">Running order</span><span className="fr-olhint">{drag.props(0).draggable ? <>Drag a row or <kbd>{roomMoveChord()}</kbd> to reorder · </> : null}<kbd>↵</kbd> opens its text</span></div>

      <div className="fr-outline-columns" aria-hidden="false"><span /><span className="fr-title-column">Title
        <button type="button" className="fr-title-resize" aria-label="Resize title column" title="Drag to widen the title column; double-click to reset" onDoubleClick={() => onTitleWidth?.(null)}
          onPointerDown={event => {
            const width = event.currentTarget.parentElement!.getBoundingClientRect().width
            resizing.current = { x: event.clientX, width }
            event.currentTarget.setPointerCapture(event.pointerId)
          }} onPointerMove={event => {
            if (!resizing.current) return
            const width = Math.max(140, Math.min(1800, resizing.current.width + event.clientX - resizing.current.x))
            column.current?.style.setProperty('--fr-title-width', `${width}px`)
          }} onPointerUp={event => {
            if (!resizing.current) return
            const width = Math.max(140, Math.min(1800, resizing.current.width + event.clientX - resizing.current.x))
            resizing.current = null; onTitleWidth?.(width)
          }} onPointerCancel={() => { resizing.current = null; column.current?.style.setProperty('--fr-title-width', titleWidth ? `${titleWidth}px` : 'minmax(140px, 1fr)') }}
          onKeyDown={event => {
            if (['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) {
              event.preventDefault(); event.stopPropagation()
              onTitleWidth?.(event.key === 'Home' ? null : Math.max(140, Math.min(1800, (titleWidth ?? event.currentTarget.parentElement!.getBoundingClientRect().width) + (event.key === 'ArrowRight' ? 40 : -40))))
            }
          }} />
      </span><span>Words</span><span>Label</span><span>Status</span><span>Priority</span><span>Sources</span></div>
      <div className="fr-olrows" role="listbox" aria-label="Parts, in running order" aria-multiselectable="true" ref={listRef} onKeyDown={event => {
        if ((event.target as HTMLElement).closest('input, textarea, select, button') || event.altKey || event.metaKey || event.ctrlKey) { onKeyDown(event); return }
        const selected = parts.find(part => part.index === shown)
        if (selected?.outline?.sectionPage && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
          event.preventDefault(); event.stopPropagation(); toggleSection(selected, event.key === 'ArrowLeft'); return
        }
        if (allSectionRows.some(row => row.sectionPage) && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
          const visible = rows.filter(row => row.keep)
          const indexes = visible.map(row => row.part.index)
          const target = sectionKeyTarget(indexes, shown, event.key)
          const next = visible.find(row => row.part.index === target)
          if (next) {
            event.preventDefault(); event.stopPropagation(); onSelect(next.part, event, indexes)
            requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-part-index="${next.part.index}"]`)?.focus())
          }
          return
        }
        onKeyDown(event)
      }}>
        {rows.filter(row => row.keep).map(({ part, headings }) => {
          const section = sectionFacts.get(part.index)!
          const path = part.outline?.path
          const open = filtering ? headings.length > 0 : (path !== undefined && expanded.includes(path))
          return <Fragment key={roomPartRenderKey(part, parts)}>
          <div
            key={roomPartRenderKey(part, parts)}
            role="option"
            aria-selected={multi?.size ? multi.has(part.index) : shown === part.index}
            tabIndex={shown === part.index ? 0 : -1}
            data-part-index={part.index}
            data-part-key={JSON.stringify(part.card)}
            data-written={part.written}
            className={`fr-olr${section.sectionPage ? ' fr-section-band' : section.sectionIndex !== null ? ' fr-section-member' : ''}${part.written ? '' : ' unw'}${part.label ? ` fr-lbl-${part.label.colour}` : ''}`}
            onFocus={event => { if (event.target !== event.currentTarget && (event.target as HTMLElement).closest('input, textarea, select')) onSelect(part) }}
            onClick={event => onSelect(part, event, allSectionRows.some(row => row.sectionPage) ? rows.filter(row => row.keep).map(row => row.part.index) : undefined)}
            onPointerDown={event => startDrag(event, part.index)}
            data-outline-draggable={!filtering && drag.props(part.index).draggable}
          >
            <span className="n">{drag.props(part.index).draggable && <span className="grip" aria-hidden="true">⠿</span>}{part.index + 1}</span>
            <span className="tt"><b>{section.sectionPage && <button type="button" className="fr-heading-toggle" aria-label={`${collapsed.has(part.index) ? 'Expand' : 'Collapse'} section ${part.title}`} aria-expanded={!collapsed.has(part.index)} onKeyDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); toggleSection(part) }}>{collapsed.has(part.index) ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}</button>}{!section.sectionPage && path && outlineHeadingRows(part.outline!).length > 0 && <button type="button" className="fr-heading-toggle" aria-label={`${open ? 'Collapse' : 'Expand'} headings for ${part.title}`} aria-expanded={open} onKeyDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); toggle(path) }}>{open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}</button>}{!part.written && !part.resolution && <Lightbulb className="icon idea" aria-hidden="true" />}<span className="tx" title={part.title}>{part.title}</span>{section.sectionPage && <span className="fr-section-chip">Section page</span>}{!part.written && model && author && <LocateFile part={part} model={model} disabled={busy ?? false} author={author} />}</b>{part.synopsis && <i title={part.synopsis}>— {part.synopsis}</i>}</span>
            {section.sectionPage ? <span className="fr-section-summary">{section.parts} parts · {section.words.toLocaleString('en-GB')} words</span> : <>
            <span className="num fr-inline-words">{part.written ? `${part.words.toLocaleString('en-GB')} w` : '—'}</span>
            <span className="lb" onClick={event => event.stopPropagation()}>{author && model ? <PartMenu part={part} field="label" model={model} disabled={busy} author={author} /> : part.label ? <><em /><span>{part.label.name}</span></> : <span className="none">—</span>}</span>
            <span onClick={event => event.stopPropagation()}>{author && model ? <PartMenu part={part} field="status" model={model} disabled={busy} author={author} /> : <Status part={part} />}</span>
            <span className={`pr${part.priority ? ` ${part.priority}` : ''}`}>{author && model ? <PartMenu part={part} field="priority" model={model} disabled={busy} author={author} /> : part.priority ? PRIORITY_LABELS[part.priority] : '—'}</span>
            <span className="num">{model?.enrichment ? <small role="status">{model.enrichment === 'pending' ? 'Loading…' : 'Unavailable'}</small> : model && !evidenceUnreadable(model) ? <small className="fr-evidence-count">{evidenceFor(model, part)?.rows.length ?? 0} sources</small> : <small>Unavailable</small>}</span></>}
          </div>
          {open && headings.length > 0 && <div className="fr-heading-rows" role="group" aria-label={`Headings in ${part.title}`}>
            {headings.map(heading => <button type="button" key={heading.line} className="fr-heading-link" data-heading-line={heading.line} style={{ paddingLeft: `${52 + heading.depth * 18}px` }} onKeyDown={event => event.stopPropagation()} onClick={() => { onSelect(part); onHeading?.(headingRoute(part.outline!, heading)) }}><span className="fr-heading-level" aria-hidden="true">h{heading.level}</span>{heading.text}</button>)}
          </div>}
          </Fragment>
        })}
        {newCard}
      </div>
      <div className="fr-olt"><span /><span data-testid="outline-totals">{totals.line}</span><span /><span /><span /><span /><span className="num">{totals.words.toLocaleString('en-GB')}</span></div>
    </div>
  )
}

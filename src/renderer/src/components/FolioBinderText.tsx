import { roomPartRenderKey } from '../../../shared/folio-room'
import { BookOpen, ChevronDown, ChevronRight, Inbox, Library, Plus } from 'lucide-react'
import type { Plan } from '../../../preload'
import { unlistedRowFacts } from '../../../shared/folio-surface'
import { PartHeadingControl } from './PlanView'
import type { FolioRoomModel, RoomPart } from '../../../shared/folio-room'
import { stageClass } from '../../../shared/folio-room'

/**
 * The binder's TEXT section (ADR-0049, layout 1A): the Folio title row, the parts in running order (numbered; a planned
 * part is italic with a dashed dot) and "Not in the outline (n)", closed until opened, with Add to outline on each file.
 * The selection is the room's (the tabs and this list agree); clicking a part selects it, and a second click on the
 * selected part (or Enter) opens it in the Text tab. Drawn into the sidebar by the room (a portal), so the room's own
 * state and writes stay in one place.
 */
export function FolioBinderText({ showParts = true, model, shown, titleRow, hidden, onTitle, onPart, onOpenPart, onAdopt, onOpenFile, canAdopt, loose, onLoose, onLooseSelect, unlistedPlan = null, onHeadingMode }: {
  /** The Plan's own rows for the files not in the outline (the Folio page's eligibility, refusal and heading choice); null until read. */
  unlistedPlan?: Plan['unlisted'] | null
  onHeadingMode?: (path: string, mode: 'own' | 'none') => void
  loose: boolean
  onLoose: (open: boolean) => void
  onLooseSelect: (path: string | null) => void
  showParts?: boolean
  model: FolioRoomModel
  shown: number | null
  titleRow: boolean
  hidden: ReadonlySet<string>
  onTitle: () => void
  onPart: (part: RoomPart) => void
  onOpenPart: (part: RoomPart) => void
  onAdopt: (path: string, asFrontMatter?: boolean) => void
  onOpenFile: (path: string) => void
  canAdopt: boolean
}): JSX.Element {
  const parts = model.parts.filter((part) => !hidden.has(`${part.key.title}\u0000${part.key.path ?? ''}`))
  const unlisted = model.newCardFolio.notInOutline
  const unlistedCount = unlistedPlan?.length ?? unlisted.length
  return (
    <div className="fr-binder fr-binder-text" data-testid="binder-text">
      <div className="fr-bh"><span>Text</span><small>top level · {model.meta.parts} {model.meta.parts === 1 ? 'part' : 'parts'}</small></div>
      <button type="button" className="fr-brow fr-title-row" data-testid="binder-title-row" aria-current={titleRow ? 'true' : undefined} title="The Folio’s own details" onClick={onTitle}>
        <Library aria-hidden="true" /><span className="t">{model.title}</span>
      </button>
      {showParts && <div role="listbox" aria-label="Parts, in running order">
        {parts.map((part) => {
          const current = !titleRow && shown === part.index
          return (
            <button type="button" role="option" aria-selected={current} key={roomPartRenderKey(part, parts)} className={`fr-brow fr-part-row${current ? ' cur' : ''}`} data-binder-part={part.index}
              aria-current={current ? 'true' : undefined}
              onClick={() => (current ? onOpenPart(part) : onPart(part))} onDoubleClick={() => onOpenPart(part)}>
              <span className="n">{part.frontMatter ? '·' : part.index + 1}</span>
              <span className={`t${part.written ? '' : ' unw'}`}>{part.title}</span>
              <span className={`fr-dot ${part.written || part.status === 'idea' ? stageClass(part.status) : 'idea'}${part.written ? '' : ' dash'}`} aria-hidden="true" />
            </button>
          )
        })}
      </div>}
      {unlistedCount > 0 && (
        <div className="fr-nio" data-testid="binder-not-in-outline">
          <button type="button" className="fr-brow" aria-expanded={loose} onClick={() => onLoose(!loose)}>
            {loose ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}<Inbox aria-hidden="true" /><span className="t">Not in the outline</span><span className="c">{unlistedCount}</span>
          </button>
          {loose && unlistedPlan === null && unlisted.map((file) => (
            <div key={file.path ?? file.title} className="fr-nio-row" data-loose-path={file.path ?? undefined} onFocus={() => onLooseSelect(file.path)}>
              <button type="button" className="fr-brow" disabled={!file.path} title={file.path ?? undefined} onClick={() => file.path && onOpenFile(file.path)}><span className="t f">{file.title}</span></button>
            </div>
          ))}
          {loose && unlistedPlan !== null && unlistedPlan.map((part, index) => {
            const row = unlistedRowFacts(part)
            return (
              <div key={`${part.path ?? part.title}:${index}`} className="fr-nio-item" data-loose-path={part.path ?? undefined} onFocus={() => onLooseSelect(part.path)}>
                <div className="fr-nio-row">
                  <button type="button" className="fr-brow" disabled={!row.canOpen} title={row.path ?? undefined} onClick={() => row.path && onOpenFile(row.path)}><span className="t f">{row.title}</span></button>
                  {canAdopt && row.canAddFrontMatter && <button type="button" className="fr-bplus" data-action="add-as-front-matter" title="Put this file back as front matter: it exports before the contents page and is never listed in it" aria-label={`Add ${row.title} as front matter`} onClick={() => onAdopt(row.path as string, true)}><BookOpen aria-hidden="true" /></button>}
                  {canAdopt && row.path && <button type="button" className="fr-bplus" data-action="add-to-outline" disabled={!row.canAdd} title={row.refusal ?? 'Put this file back at the end of the running order'} aria-label={`Add ${row.title} to the outline`} onClick={() => onAdopt(row.path as string)}><Plus aria-hidden="true" /></button>}
                </div>
                {row.refusal && <p className="fr-nio-why" data-plan-putback-why="true">{row.refusal}</p>}
                {row.headingChoice && onHeadingMode && <PartHeadingControl part={part} onChoose={onHeadingMode} />}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

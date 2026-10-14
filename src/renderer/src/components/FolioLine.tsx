import { ChevronLeft, ChevronRight, ListOrdered } from 'lucide-react'
import type { FolioPlace } from '../../../shared/folio-place'

export type FolioLineProps = {
  place: FolioPlace
  onOpenPlan: () => void
  onOpenPiece: (path: string) => void
}

/** The words that stand where a position would be. */
export function folioPositionText(place: Pick<FolioPlace, 'kind' | 'position' | 'total'>): string {
  if (place.kind === 'index') return 'Index Note'
  if (place.kind === 'unlisted') return 'Not in the running order'
  return `${place.position} of ${place.total}`
}

/**
 * The line above the text of a Folio piece: the Folio's name (opens the Plan), the position, and the
 * previous and next piece. App chrome: it is mounted outside the CodeMirror document, so it is never
 * saved, exported, counted or read aloud. Each neighbour keeps its own fixed place, so an absent one
 * leaves the other where it was.
 */
export function FolioLine({ place, onOpenPlan, onOpenPiece }: FolioLineProps): JSX.Element {
  const openLabel = `Open the Plan for ${place.name}`
  const previous = place.previous ? `Previous piece: ${place.previous.title}` : null
  const next = place.next ? `Next piece: ${place.next.title}` : null
  return (
    <nav className="folio-line" aria-label="Folio" contentEditable={false}>
      <button type="button" className="fl-folio" aria-label={openLabel} title={openLabel} onClick={onOpenPlan}>
        <ListOrdered className="icon sm" /><span>{place.name}</span>
      </button>
      <span className="fl-pos">{folioPositionText(place)}</span>
      <span className="fl-grow" />
      <span className="fl-slot prev">
        {place.previous && previous && (
          <button type="button" className="fl-nav" aria-label={previous} title={previous} onClick={() => onOpenPiece(place.previous!.path)}>
            <ChevronLeft className="icon sm" /><span>{place.previous.title}</span>
          </button>
        )}
      </span>
      <span className="fl-slot next">
        {place.next && next && (
          <button type="button" className="fl-nav" aria-label={next} title={next} onClick={() => onOpenPiece(place.next!.path)}>
            <span>{place.next.title}</span><ChevronRight className="icon sm" />
          </button>
        )}
      </span>
    </nav>
  )
}

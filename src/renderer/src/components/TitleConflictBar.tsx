import { TriangleAlert, X } from 'lucide-react'
import { TITLE_FIX_LABEL, titleConflictSentence, type TitleConflict, type TitleFixDirection } from '../../../shared/title-conflict'

/**
 * The slim bar at the top of the open document when its frontmatter `title:` and its heading disagree
 * (title-conflict buttons, 2026-10-19). Its two fixes edit the editor buffer as one undoable transaction
 * (App: `fixOpenDocumentTitle`), never the disk under the buffer; ✕ hides it for this document until the
 * conflict changes. Each control has a command and a key, shown here and in the `?` sheet.
 */
export type TitleConflictBarProps = {
  conflict: TitleConflict
  onFix: (direction: TitleFixDirection) => void
  onDismiss: () => void
  /** The keys of the three commands, as displayed (empty when unassigned). */
  chords: { headingToTitle: string; titleToHeading: string; dismiss: string }
}

export function TitleConflictBar({ conflict, onFix, onDismiss, chords }: TitleConflictBarProps): JSX.Element {
  const keyOf = { 'heading-to-title': chords.headingToTitle, 'title-to-heading': chords.titleToHeading } as const
  return (
    <div className="title-conflict-bar" role="region" aria-label="Title and heading differ" data-title-conflict-bar="true">
      <TriangleAlert className="icon sm" aria-hidden="true" />
      <span className="tcb-text">{titleConflictSentence(conflict)}</span>
      <span className="tcb-actions">
        {(['heading-to-title', 'title-to-heading'] as const).map((direction) => (
          <button key={direction} type="button" className="tcb-btn" data-title-fix={direction} onClick={() => onFix(direction)}>
            {TITLE_FIX_LABEL[direction]}{keyOf[direction] && <kbd>{keyOf[direction]}</kbd>}
          </button>
        ))}
        <button type="button" className="tcb-close" aria-label="Hide for this document" title={chords.dismiss ? `Hide for this document (${chords.dismiss})` : 'Hide for this document'} data-title-fix-dismiss="true" onClick={onDismiss}>
          <X className="icon sm" aria-hidden="true" />
        </button>
      </span>
    </div>
  )
}

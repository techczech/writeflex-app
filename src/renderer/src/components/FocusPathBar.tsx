import { X } from 'lucide-react'
import { focusSegments } from '../sidebar-tree'

type FocusPathBarProps = {
  /** The Workspace root's folder name — the first segment, which clears the focus. */
  rootName: string
  /** The focused folder, workspace-relative. */
  focus: string
  /** Re-focus on an ancestor segment. */
  onFocus: (path: string) => void
  /** Return to the whole archive (the root segment and the Clear focus control). */
  onClear: () => void
}

/**
 * The path bar (ticket 03, frames A2/D4): one row under the toolbar while a folder is focused. Every
 * segment is a button — the root segment clears the focus, each ancestor re-focuses there, the last
 * marks where you are — and Clear focus sits at the right. Present only while a folder is focused.
 */
export function FocusPathBar({ rootName, focus, onFocus, onClear }: FocusPathBarProps): JSX.Element {
  const segments = focusSegments(focus)
  return (
    <nav className="pathbar" aria-label="Focused folder">
      <button type="button" className="seg" title="Clear focus — show the whole archive" onClick={onClear}>
        {rootName}
      </button>
      {segments.map((segment, index) => {
        const here = index === segments.length - 1
        return (
          <span key={segment.path} className="pathbar-step">
            <span className="sep" aria-hidden="true">›</span>
            <button
              type="button"
              className={here ? 'seg here' : 'seg'}
              aria-current={here ? 'location' : undefined}
              title={here ? `Focused on ${segment.path}` : `Focus on ${segment.path}`}
              onClick={() => { if (!here) onFocus(segment.path) }}
            >
              {segment.name}
            </button>
          </span>
        )
      })}
      <button type="button" className="out" title="Clear focus — show the whole archive" onClick={onClear}>
        <X className="icon sm" aria-hidden="true" />
        Clear focus
      </button>
    </nav>
  )
}

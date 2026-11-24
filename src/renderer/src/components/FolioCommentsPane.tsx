import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { BookMarked, X } from 'lucide-react'
import type { Change } from '../../../preload'
import type { FolioOutline } from '../../../shared/folio-outline'
import { folioComments, folioCommentsCountText } from '../app/folio-comments'
import { folioPathText } from '../vault-folios'
import './folio-comments.css'

type Props = {
  /** The Folio's folder ('' = the workspace root), or null when nothing open is in a Folio. */
  dir: string | null
  /** The Folio's own title (vault index), when known. */
  title: string | null
  /** The row the writer last jumped to: drawn as current. */
  currentId?: string | null
  onJump: (path: string, id: string) => void
  onClose: () => void
}

/**
 * The right sidebar's Comments tab: every comment and suggested edit waiting in the Folio, grouped by part in
 * running order, each one a button that opens its part at its place. It reads the change ledger and the Folio's
 * outline through the existing bridge calls, and re-reads both when the ledger changes.
 */
export function FolioCommentsPane({ dir, title, currentId = null, onJump, onClose }: Props): JSX.Element {
  const [outline, setOutline] = useState<FolioOutline | null>(null)
  const [changes, setChanges] = useState<Change[]>([])
  const [tick, setTick] = useState(0)

  // The ledger changes (a comment added, settled or carried by a rename), and so does the Folio (a part renamed or
  // moved): either way both are read again, so a row is always joined to the part as it is now.
  useEffect(() => window.writeflex.onChangesChanged(() => setTick((n) => n + 1)), [])
  useEffect(() => window.writeflex.onCollectionChanged(() => setTick((n) => n + 1)), [])
  useEffect(() => {
    if (dir === null) { setOutline(null); setChanges([]); return undefined }
    let live = true
    // Any path whose folder is the Folio's folder names the Folio (folio-place.ts `folioContaining`).
    const probe = `${dir ? `${dir}/` : ''}_report-structure.json`
    void Promise.all([
      window.writeflex.readFolioOutline(probe).catch(() => null),
      window.writeflex.listChanges().catch(() => [] as Change[]),
    ]).then(([nextOutline, nextChanges]) => {
      if (!live) return
      setOutline(nextOutline)
      setChanges(nextChanges)
    })
    return () => { live = false }
  }, [dir, tick])

  const result = useMemo(() => (outline ? folioComments(outline, changes) : null), [outline, changes])
  const heading = title ?? outline?.name ?? 'This Folio'

  const step = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const rows = [...(event.currentTarget.closest('.fc-pane')?.querySelectorAll<HTMLButtonElement>('[data-folio-comment]') ?? [])]
    const next = rows[rows.indexOf(event.currentTarget) + (event.key === 'ArrowDown' ? 1 : -1)]
    if (!next) return
    event.preventDefault()
    next.focus()
  }

  return (
    <div className="fc-pane" data-testid="folio-comments" aria-label="All comments in this Folio">
      <div className="fc-head">
        <div className="fc-head-text">
          <div className="fc-kicker">All comments in this Folio</div>
          {dir !== null && (
            <div className="fc-title"><BookMarked className="icon sm" aria-hidden="true" /><span>{heading}</span></div>
          )}
          {dir !== null && <div className="fc-path">{folioPathText(dir)}</div>}
        </div>
        <button type="button" className="fc-close" aria-label="Close the Comments tab" title="Close the Comments tab" onClick={onClose}><X className="icon sm" /></button>
      </div>
      {dir === null ? (
        <p className="fc-empty">Open a Folio, or one of its parts, to see all its comments here.</p>
      ) : !result ? (
        <p className="fc-empty">Reading the Folio…</p>
      ) : (
        <>
          <p className="fc-count" data-testid="folio-comments-count">{folioCommentsCountText(result)}</p>
          {result.groups.map((group) => (
            <section key={group.path} className="fc-group" data-folio-comment-part={group.path}>
              <h3 className="fc-part">
                <span className="fc-pos">{group.position === null ? '–' : group.position}</span>
                <span className="fc-part-title">{group.title}</span>
                <span className="fc-part-count">{group.rows.length}</span>
              </h3>
              {group.position === null && <div className="fc-not-listed">Not in the outline</div>}
              {group.rows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className={`fc-row k-${row.kind}${row.id === currentId ? ' is-current' : ''}`}
                  data-folio-comment={row.id}
                  aria-current={row.id === currentId ? 'true' : undefined}
                  title={`Open “${group.title}” at this ${row.kind === 'note' ? 'comment' : 'suggested edit'}`}
                  onKeyDown={step}
                  onClick={() => onJump(row.path, row.id)}
                >
                  <span className="fc-meta"><span className="fc-kind">{row.label}</span><span className="fc-who">{row.who}</span>{row.held && <span className="fc-held">Held</span>}</span>
                  {row.quote && <span className="fc-quote">“{row.quote}”</span>}
                  {row.text && <span className="fc-text">{row.kind === 'edit' ? `→ ${row.text}` : row.text}</span>}
                </button>
              ))}
            </section>
          ))}
        </>
      )}
    </div>
  )
}

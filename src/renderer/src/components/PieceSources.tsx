import { useCallback, useEffect, useRef, useState } from 'react'
import { sourceStatusLine, type PieceSourceListing, type SourceListEntry } from '../../../shared/piece-sources'
import { humanReadableError } from '../error-text'

/** How many listed-only entries the popover shows before "+ n more listed" (locked design frame 5). */
export const LISTED_SHOWN = 2

export type PieceSourcesListProps = {
  listing: PieceSourceListing
  /** Show every listed entry rather than the first few. */
  expanded: boolean
  /** The source being added now, if one is. */
  addingPath: string | null
  /** The words of the last add, or why it was refused. */
  notice: { text: string; refused: boolean; undo: (() => void) | null } | null
  onExpand: () => void
  onAdd: (entry: SourceListEntry) => void
  onOpen: (path: string) => void
}

/** The visible entries, and how many listed ones are folded into "+ n more listed". Cited-not-listed
 *  entries (the ones with an action) are always shown. */
export function visibleSources(entries: SourceListEntry[], expanded: boolean): { shown: SourceListEntry[]; hiddenListed: number } {
  if (expanded) return { shown: entries, hiddenListed: 0 }
  let listedSeen = 0
  const shown: SourceListEntry[] = []
  let hiddenListed = 0
  for (const entry of entries) {
    if (entry.status === 'cited') shown.push(entry)
    else if (listedSeen < LISTED_SHOWN) { listedSeen += 1; shown.push(entry) }
    else hiddenListed += 1
  }
  return { shown, hiddenListed }
}

/**
 * A piece's sources, listed and cited (locked design frame 5): its `sources:` list merged with what its
 * text cites. A source cited but not listed is dashed and carries "Add to sources". An author–year
 * citation that fits more than one research note is shown as ambiguous, never picked; when author–year
 * matching could not run, the list says so.
 */
export function PieceSourcesList({ listing, expanded, addingPath, notice, onExpand, onAdd, onOpen }: PieceSourcesListProps): JSX.Element {
  const { shown, hiddenListed } = visibleSources(listing.entries, expanded)
  return (
    <div className="psrc" role="group" aria-label={`Sources of ${listing.pieceTitle}`}>
      <div className="psrc-lbl">{`Sources of ${listing.pieceTitle} · ${listing.entries.length}`}</div>
      {listing.entries.length === 0 && <div className="psrc-empty">This piece lists no sources and cites none in its text.</div>}
      {shown.map((entry) => (
        <div key={entry.path ?? `entry:${entry.title}`} className={entry.status === 'cited' ? 'psrc-item unlisted' : 'psrc-item'}>
          {entry.path
            ? <button type="button" className="psrc-title" onClick={() => onOpen(entry.path!)}>{entry.title}</button>
            : <span className="psrc-title plain">{entry.title}</span>}
          <div className="psrc-p">
            {sourceStatusLine(entry)}
            {entry.status === 'cited' && entry.path && (
              <>
                {' · '}
                <button type="button" className="psrc-add" disabled={addingPath !== null} onClick={() => onAdd(entry)}>
                  {addingPath === entry.path ? 'Adding…' : 'Add to sources'}
                </button>
              </>
            )}
          </div>
        </div>
      ))}
      {listing.ambiguous.map((item) => (
        <div key={item.text} className="psrc-item ambiguous">
          <span className="psrc-title plain">{`${item.text} · ${item.count}×`}</span>
          <div className="psrc-p">{`ambiguous: fits ${item.candidates.map((candidate) => candidate.title).join(' or ')}; not counted`}</div>
        </div>
      ))}
      {hiddenListed > 0 && <button type="button" className="psrc-more" onClick={onExpand}>{`+ ${hiddenListed} more listed`}</button>}
      {listing.authorYearMatching.message && <div className="psrc-note">{listing.authorYearMatching.message}</div>}
      {notice && (
        <div className={notice.refused ? 'psrc-notice refused' : 'psrc-notice'} role="status">
          <span>{notice.text}</span>
          {notice.undo && <button type="button" className="psrc-add" onClick={notice.undo}>Undo</button>}
        </div>
      )}
    </div>
  )
}

/**
 * The popover over the Board or the editor: reads the listing through the preload bridge, adds a cited
 * source through the Board's attach (one undoable step), and re-reads. Esc or a click outside closes it.
 */
export function PieceSourcesPopover({ request, onClose, onOpenPiece, onChanged }: {
  request: { path: string; dir?: string }
  onClose: () => void
  onOpenPiece: (path: string) => void
  onChanged?: (paths: string[]) => void
}): JSX.Element {
  const [listing, setListing] = useState<PieceSourceListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [addingPath, setAddingPath] = useState<string | null>(null)
  const [notice, setNotice] = useState<PieceSourcesListProps['notice']>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      setListing(await window.writeflex.boardMaterial.listSources(request.path, request.dir))
      setError(null)
    } catch (caught: unknown) {
      setError(humanReadableError(caught, 'Could not list this piece’s sources.'))
    }
  }, [request.dir, request.path])
  useEffect(() => { void load() }, [load])
  useEffect(() => { rootRef.current?.focus() }, [])

  const add = useCallback(async (entry: SourceListEntry) => {
    if (!listing || !entry.path || addingPath) return
    setAddingPath(entry.path)
    try {
      const result = await window.writeflex.boardMaterial.attachSource({ dir: listing.dir, piece: listing.piece, source: entry.path })
      if (result.ok) {
        onChanged?.(result.paths)
        const stepId = result.step.id
        setNotice({
          text: `${result.step.activity}: ${entry.title}`, refused: false,
          undo: () => {
            void window.writeflex.boardMaterial.undo(stepId).then(async (undone) => {
              if (undone.ok) { onChanged?.(undone.paths); setNotice({ text: 'Undone: the file is as it was.', refused: false, undo: null }) }
              else setNotice({ text: undone.message, refused: true, undo: null })
              await load()
            }).catch((caught: unknown) => setNotice({ text: humanReadableError(caught, 'Could not undo that step.'), refused: true, undo: null }))
          },
        })
        await load()
      } else setNotice({ text: result.message, refused: true, undo: null })
    } catch (caught: unknown) {
      setNotice({ text: humanReadableError(caught, 'Could not add the source.'), refused: true, undo: null })
    } finally {
      setAddingPath(null)
    }
  }, [addingPath, listing, load, onChanged])

  return (
    <div className="psrc-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        ref={rootRef}
        className="psrc-pop"
        role="dialog"
        aria-modal="true"
        aria-label="Sources of this piece"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
        }}
      >
        {error && <div className="psrc-notice refused" role="alert">{error}</div>}
        {!error && !listing && <div className="psrc-empty">Reading sources…</div>}
        {listing && (
          <PieceSourcesList
            listing={listing} expanded={expanded} addingPath={addingPath} notice={notice}
            onExpand={() => setExpanded(true)} onAdd={(entry) => void add(entry)}
            onOpen={(path) => { onClose(); onOpenPiece(path) }}
          />
        )}
      </div>
    </div>
  )
}

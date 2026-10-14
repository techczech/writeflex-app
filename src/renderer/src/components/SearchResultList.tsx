import type { SearchMatch, SearchScopeCounts } from '../../../preload'
import { capNote, markSegments, piecesLabel } from '../search-hits'

/** Matches and the query that PRODUCED them, kept in one state slot so a hit's offsets and the
 *  echoed query text can never be paired with a different search (the M1 stale-race lesson). */
export type SearchResults = { query: string; matches: SearchMatch[]; total: number; note?: 'literal'; scope?: SearchScopeCounts }

export function pathParts(path: string): { name: string; folder: string } {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? { name: path, folder: '' } : { name: path.slice(slash + 1), folder: path.slice(0, slash) }
}

/** Text with every mark span `<mark>`ed and the rest as plain spans — escaped the normal React way,
 *  never `dangerouslySetInnerHTML`. Marks are 1-based columns into `text` (markSegments). */
function MarkedText({ text, marks }: { text: string; marks: ReadonlyArray<{ column: number; length: number }> }): JSX.Element {
  return (
    <>
      {markSegments(text, marks).map((segment, i) =>
        segment.marked ? <mark key={i}>{segment.text}</mark> : <span key={i}>{segment.text}</span>,
      )}
    </>
  )
}

/**
 * The preview under the results: the highlighted piece's name and line, then its best line in its
 * surrounding lines, with every term on the best line marked — the same marks as the row's snippet,
 * placed on the full line (`marks` index into `preview`).
 */
export function SearchExcerpt({ hit }: { hit: SearchMatch | undefined }): JSX.Element {
  return (
    <div className="search-excerpt" aria-live="polite">
      {hit ? (
        <>
          <div className="search-excerpt-from">
            <span>{pathParts(hit.path).name} · line {hit.line}</span>
            <span>↵ jump</span>
          </div>
          <div className="search-excerpt-body">
            {hit.context.before.filter((line) => line.trim()).map((line, index) => <span key={`before:${index}`}>{line} </span>)}
            <span><MarkedText text={hit.preview} marks={hit.marks} /> </span>
            {hit.context.after.filter((line) => line.trim()).map((line, index) => <span key={`after:${index}`}>{line} </span>)}
          </div>
        </>
      ) : (
        <div className="search-excerpt-from">no hit selected</div>
      )}
    </div>
  )
}

type SearchResultListProps = {
  results: SearchResults
  /** Index of the highlighted row (arrows move it; Enter opens it). */
  selected: number
  onHover: (index: number) => void
  onOpen: (match: SearchMatch) => void
  /** The focused folder, when the list shows its pieces: row folders read relative to it, as drawn
   *  in frame D4 (`parts/`, `research/`). */
  folderBase?: string
}

/**
 * The ranked result list (frame D4): one row per piece — its file name, its folder path and the
 * best matching line as a snippet with every term marked. A count line leads; when the backend's
 * cap left pieces out, a closing note says how many there are in total.
 */
export function SearchResultList({ results, selected, onHover, onOpen, folderBase }: SearchResultListProps): JSX.Element {
  const note = capNote(results.matches.length, results.total)
  return (
    <>
      <div className="search-count">
        {piecesLabel(results.total)} for <span className="search-q">{results.query}</span>
        {results.note === 'literal' && <span className="search-note">literal</span>}
      </div>
      {results.matches.map((match, index) => {
        const parts = pathParts(match.path)
        const name = parts.name
        const folder = folderBase && (parts.folder === folderBase || parts.folder.startsWith(`${folderBase}/`))
          ? parts.folder.slice(folderBase.length + 1)
          : parts.folder
        return (
          <button
            key={match.path}
            type="button"
            className="search-hit"
            aria-selected={index === selected}
            title={`${match.path} · line ${match.line}`}
            onMouseMove={() => onHover(index)}
            onClick={() => onOpen(match)}
          >
            <span className="search-hit-head">
              <span className="search-hit-name">{name}</span>
              {folder && <span className="search-hit-folder">{folder}/</span>}
            </span>
            <span className="search-hit-snippet">
              <MarkedText text={match.snippet.text} marks={match.snippet.marks} />
            </span>
          </button>
        )
      })}
      {note && <div className="search-capnote">{note}</div>}
    </>
  )
}

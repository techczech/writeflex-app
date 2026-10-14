import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Bot, Folder, Link as LinkIcon, ListPlus, PanelRightClose, PanelRightOpen } from 'lucide-react'
import type { CollectionLink, QueryRow, UnresolvedFolderPiece } from '../../../preload'
import { projectionQuerySource } from '../../../shared/query-source'
import { humanReadableError } from '../error-text'
import { boardAge, groupBoardRows } from './board-projection'

export type QueryInsertionContext = { label: string; source: string; notice?: string }

export type RailProps = {
  dir: string
  name: string
  activePath: string | null
  activeContent: string | null
  onClose: () => void
  onOpenPiece: (path: string) => void
  onQueryContext: (context: QueryInsertionContext) => void
  onInsertQuery: (context: QueryInsertionContext) => void
  insertChord: string | null
  focusRequest: number
}

type RailLink = { path: string; label: string; direction: 'outgoing' | 'backlink' }

function liveLinks(links: CollectionLink[], activePath: string | null, queryRows: QueryRow[]): RailLink[] {
  if (!activePath) return []
  const titlesByPath = new Map(queryRows.map((row) => [row.path, row.title]))
  const seen = new Set<string>()
  const rows: RailLink[] = []
  for (const link of links) {
    const candidate = link.from === activePath && link.to
      ? { path: link.to, label: link.display, direction: 'outgoing' as const }
      : link.to === activePath && link.from !== activePath
        ? { path: link.from, label: titlesByPath.get(link.from) ?? link.display, direction: 'backlink' as const }
        : null
    if (!candidate) continue
    const key = `${candidate.direction}:${candidate.path}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push(candidate)
  }
  return rows
}

/** The summonable Projection: current Collection truth over the editor, never part of its layout. */
export function Rail({ dir, name, activePath, activeContent, onClose, onOpenPiece, onQueryContext, onInsertQuery, insertChord, focusRequest }: RailProps): JSX.Element {
  const [rows, setRows] = useState<QueryRow[]>([])
  const [links, setLinks] = useState<CollectionLink[]>([])
  const [unresolvedFolders, setUnresolvedFolders] = useState<UnresolvedFolderPiece[]>([])
  const [error, setError] = useState<string | null>(null)
  const [focusedStatus, setFocusedStatus] = useState<string | null>(null)
  const groupHeadRefs = useRef<Array<HTMLDivElement | null>>([])
  const handledFocusRequest = useRef(0)

  const reloadProjection = useCallback(async () => {
    try {
      const [population, missing] = await Promise.all([
        window.writeflex.collection.query(dir, ''),
        window.writeflex.collection.unresolvedFolderPieces(dir),
      ])
      if (!population.ok) throw new Error(population.error.humanReadable)
      setRows(population.rows)
      setUnresolvedFolders(missing)
      setError(null)
    } catch (cause) {
      setError(humanReadableError(cause, 'The Rail could not read this Collection.'))
    }
  }, [dir])

  useEffect(() => {
    void reloadProjection()
    return window.writeflex.collection.onChanged(() => { void reloadProjection() })
  }, [reloadProjection])

  useEffect(() => {
    if (!activePath || activeContent === null) {
      setLinks([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void window.writeflex.collection.links(dir, activePath, activeContent).then((graph) => {
        if (!cancelled) setLinks(graph)
      }).catch((cause: unknown) => {
        if (!cancelled) setError(humanReadableError(cause, 'The Rail could not read links for this document.'))
      })
    }, 1_000)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [activeContent, activePath, dir])

  const groups = useMemo(() => groupBoardRows(rows).filter((group) => group.rows.length > 0), [rows])
  const linked = useMemo(() => liveLinks(links, activePath, rows), [activePath, links, rows])
  const dead = useMemo(() => activePath
    ? links.filter((link) => link.from === activePath && link.to === null)
    : [], [activePath, links])

  useEffect(() => {
    const index = Math.max(0, groups.findIndex((group) => group.status === focusedStatus))
    const focused = groups[index]
    if (!focused) return
    setFocusedStatus(focused.status)
    onQueryContext({ label: focused.status, source: projectionQuerySource({ dir, status: focused.status }) })
  }, [dir, groups, onQueryContext])

  const focusGroup = useCallback((index: number) => {
    const group = groups[index]
    if (!group) return
    setFocusedStatus(group.status)
    onQueryContext({ label: group.status, source: projectionQuerySource({ dir, status: group.status }) })
    groupHeadRefs.current[index]?.focus()
  }, [dir, groups, onQueryContext])

  useEffect(() => {
    if (focusRequest <= handledFocusRequest.current) return
    const index = Math.max(0, groups.findIndex((group) => group.status === focusedStatus))
    if (!groups[index]) return
    handledFocusRequest.current = focusRequest
    focusGroup(index)
  }, [focusGroup, focusedStatus, focusRequest, groups])

  return (
    <aside className="collection-rail" aria-label="Rail">
      <header className="rail-head">
        <div className="rail-title">
          <PanelRightOpen aria-hidden="true" />
          <strong>{name}</strong>
          <button type="button" className="rail-close" aria-label="Dismiss Rail" onClick={onClose}><PanelRightClose aria-hidden="true" /></button>
        </div>
        <div className="rail-projection">one query · <span className="on">rail</span> · <span>board</span> · <span>in-doc query</span></div>
      </header>
      <div className="rail-scroll">
        {error ? <div className="rail-error" role="alert"><AlertTriangle aria-hidden="true" />{error}</div> : (
          <>
            <section aria-labelledby="rail-pipeline-label">
              <h2 id="rail-pipeline-label" className="rail-section-label">Pipeline</h2>
              <div className="rail-card rail-pipeline">
                {groups.map((group, index) => {
                  const context = { label: group.status, source: projectionQuerySource({ dir, status: group.status }) }
                  return (
                    <div className={`rail-group${group.status === 'Unsorted' ? ' unsorted' : ''}`} key={group.status}>
                      <div
                        className={`rail-group-head${focusedStatus === group.status ? ' focused' : ''}`}
                        ref={(element) => { groupHeadRefs.current[index] = element }}
                        tabIndex={0}
                        aria-label={`${group.status} group`}
                        onMouseEnter={() => { setFocusedStatus(group.status); onQueryContext(context) }}
                        onFocus={() => { setFocusedStatus(group.status); onQueryContext(context) }}
                        onKeyDown={(event) => {
                          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                          event.preventDefault()
                          focusGroup(Math.max(0, Math.min(groups.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))))
                        }}
                      >
                        <span className={`rail-stage-dot ${group.badgeClass}`} />
                        <span className={`rail-stage-name ${group.badgeClass}`}>{group.status}</span>
                        <button
                          type="button"
                          className="rail-insert-query"
                          aria-label={`Insert ${group.status} as query`}
                          title="Insert as query"
                          onClick={() => onInsertQuery(context)}
                        ><ListPlus aria-hidden="true" /></button>
                        <span className="rail-group-count">{group.rows.length}</span>
                      </div>
                      {group.rows.map((row) => {
                        const age = boardAge(row)
                        return (
                          <button
                            type="button"
                            className={`rail-row${row.path === activePath ? ' current' : ''}`}
                            aria-label={`Open ${row.title}`}
                            key={row.path}
                            onClick={() => onOpenPiece(row.path)}
                          >
                            <span>{row.title}{row.agentAuthored && <Bot aria-label="Agent-authored Piece" />}{row.folderPath && <Folder aria-label="Folder Piece" />}</span>
                            <time className={age.stalled ? 'stalled' : ''}>{age.label}</time>
                          </button>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            </section>
            <section className="rail-links" aria-labelledby="rail-links-label">
              <h2 id="rail-links-label" className="rail-section-label">Links</h2>
              <div className="rail-card rail-link-list">
                {linked.length ? linked.map((link) => (
                  <button type="button" aria-label={`Open ${link.label}`} key={`${link.direction}:${link.path}`} onClick={() => onOpenPiece(link.path)}>
                    <LinkIcon aria-hidden="true" /><span>{link.label}</span><small>{link.direction}</small>
                  </button>
                )) : <p className="rail-empty">No links for this document.</p>}
              </div>
            </section>
            <section className="rail-unresolved" aria-labelledby="rail-unresolved-label">
              <h2 id="rail-unresolved-label" className="rail-section-label">Unresolved</h2>
              <div className="rail-card rail-unresolved-list">
                {unresolvedFolders.map((folder) => (
                  <div className="rail-unresolved-row" key={folder.folderPath}><AlertTriangle aria-hidden="true" /><span>{folder.title} — main document missing</span><small>folder piece</small></div>
                ))}
                {dead.map((link) => (
                  <div className="rail-unresolved-row" key={`${link.from}:${link.target}`}><LinkIcon aria-hidden="true" /><span>{link.display}</span><small>dead link</small></div>
                ))}
                {!unresolvedFolders.length && !dead.length && <p className="rail-empty">Nothing unresolved.</p>}
              </div>
            </section>
          </>
        )}
      </div>
      <footer className="rail-foot"><span><kbd>esc</kbd> dismisses</span><span>{insertChord && <kbd>{insertChord}</kbd>} insert as query</span></footer>
    </aside>
  )
}

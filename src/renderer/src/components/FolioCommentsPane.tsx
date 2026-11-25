import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { BookMarked, X } from 'lucide-react'
import { MANIFEST_NAME } from '../../../shared/folio-constants'
import type { VaultIndex } from '../../../shared/vault-index'
import { folioComments, folioCommentsCountText, type FolioComments } from '../app/folio-comments'
import { folioPathText } from '../vault-folios'
import './folio-comments.css'

type Props = {
  root: string | null
  /** An open Collection takes precedence over the editor underneath it. */
  collectionDir: string | null
  activePath: string | null
  onJump: (path: string, id: string) => void
  onClose: () => void
}

type ReadState =
  | { status: 'outside' }
  | { status: 'loading'; dir?: string }
  | { status: 'unavailable'; dir?: string }
  | { status: 'ready'; dir: string; name: string; comments: FolioComments }

/**
 * The right sidebar's Comments tab: every comment and suggested edit waiting in the Folio, grouped by part in
 * running order, each one a button that opens its part at its place. It reads the change ledger and the Folio's
 * outline through the existing bridge calls, and re-reads both when the ledger changes.
 */
export function FolioCommentsPane({ root, collectionDir, activePath, onJump, onClose }: Props): JSX.Element {
  const source = collectionDir !== null ? 'collection' : 'file'
  const path = collectionDir ?? activePath
  // Render against this request so the previous rows disappear in the navigation render itself.
  const request = useMemo(() => root !== null && path !== null && !path.includes('://')
    ? { root, source, path }
    : null, [root, source, path])
  const [read, setRead] = useState<{ request: NonNullable<typeof request>; value: ReadState } | null>(null)
  const [current, setCurrent] = useState<{ root: string; dir: string; id: string } | null>(null)
  const [titles, setTitles] = useState<{ root: string; works: VaultIndex['works'] } | null>(null)
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick(n => n + 1), [])

  useEffect(() => {
    if (root === null) return undefined
    let live = true
    let pushed = false
    const show = (index: VaultIndex | null): void => setTitles({ root, works: index?.works ?? [] })
    const off = window.writeflex.onVaultIndexChanged((index) => { pushed = true; show(index) })
    void window.writeflex.getVaultIndex().then(index => { if (live && !pushed) show(index) }).catch(() => undefined)
    return () => { live = false; off() }
  }, [root])

  useEffect(() => {
    const bridge = window.writeflex
    const offChanges = bridge.onChangesChanged(refresh)
    const offCollection = bridge.onCollectionChanged(refresh)
    const offDisk = bridge.onFileChangedOnDisk(paths => {
      if (paths.some(path => path === MANIFEST_NAME || path.endsWith(`/${MANIFEST_NAME}`))) refresh()
    })
    return () => { offChanges(); offCollection(); offDisk() }
  }, [refresh])
  useEffect(() => {
    if (!request) {
      setCurrent(null)
      return undefined
    }
    let live = true
    const bridge = window.writeflex
    void (async () => {
      let dir: string | undefined
      try {
        const verified = request.source === 'collection'
          ? (await bridge.readFolioDeclaration(request.path)).isFolio ? request.path : null
          : (await bridge.readFolioPlace(request.path))?.dir ?? null
        if (!live) return
        setCurrent(selected => selected?.root === request.root && selected.dir === verified ? selected : null)
        if (verified === null) {
          setRead({ request, value: { status: 'outside' } })
          return
        }
        dir = verified
        setRead(previous => previous?.request === request && previous.value.status === 'ready' && previous.value.dir === dir
          ? previous
          : { request, value: { status: 'loading', dir } })
        const probe = [dir, MANIFEST_NAME].filter(Boolean).join('/')
        const [outline, changes] = await Promise.all([bridge.readFolioOutline(probe), bridge.listChanges()])
        if (!live) return
        if (!outline || outline.dir !== dir) {
          setRead({ request, value: { status: 'unavailable', dir } })
          return
        }
        setRead({ request, value: { status: 'ready', dir, name: outline.name, comments: folioComments(outline, changes) } })
      } catch {
        if (live) setRead({ request, value: { status: 'unavailable', dir } })
      }
    })()
    return () => { live = false }
  }, [request, tick])

  const view: ReadState = !request ? { status: 'outside' } : read?.request === request ? read.value : { status: 'loading' }
  const dir = view.status === 'outside' ? undefined : view.dir
  const title = dir === undefined || titles?.root !== root
    ? undefined
    : titles.works.find(work => work.kind === 'folio' && work.path === dir)?.title
  const heading = title ?? (view.status === 'ready' ? view.name : 'This Folio')
  const currentId = current?.root === root && current.dir === dir ? current.id : null

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
          {dir !== undefined && (
            <div className="fc-title"><BookMarked className="icon sm" aria-hidden="true" /><span>{heading}</span></div>
          )}
          {dir !== undefined && <div className="fc-path">{folioPathText(dir)}</div>}
        </div>
        <button type="button" className="fc-close" aria-label="Close the Comments tab" title="Close the Comments tab" onClick={onClose}><X className="icon sm" /></button>
      </div>
      {view.status === 'outside' ? (
        <p className="fc-empty">Open a Folio, or one of its parts, to see all its comments here.</p>
      ) : view.status === 'loading' ? (
        <p className="fc-empty" role="status">Reading the Folio…</p>
      ) : view.status === 'unavailable' ? (
        <div className="fc-empty">
          <div role="status">Could not read this Folio’s comments.</div>
          <button type="button" className="btn" onClick={refresh}>Try again</button>
        </div>
      ) : (
        <>
          <p className="fc-count" data-testid="folio-comments-count">{folioCommentsCountText(view.comments)}</p>
          {view.comments.groups.map((group) => (
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
                  onClick={() => {
                    if (root !== null) setCurrent({ root, dir: view.dir, id: row.id })
                    onJump(row.path, row.id)
                  }}
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

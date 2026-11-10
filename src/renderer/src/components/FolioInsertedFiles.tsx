import { useEffect, useRef, useState } from 'react'
import { FileText, Globe, Image as ImageIcon, Table2 } from 'lucide-react'
import { FILE_KIND_LABEL, type FolioInsertedFile } from '../../../shared/file-versions'
import { dispatchSidebar } from '../plan/folio-sidebar'
import { useFileVersionsFocus } from '../plan/file-versions-focus'
import { FileVersionsPanel } from './FileVersionsPanel'

/**
 * "Inserted files" in the Folio's Inspector (Folio versions ticket 19, the locked mockup's scene `asset`): the tables, widget pages and images the
 * Folio's text inserts, each with how many versions hold a copy of it. Choosing one shows its versions (FileVersionsPanel). Nothing here writes.
 * A file asked for from elsewhere (the cursor panel on a table the cursor is on, a palette command) is chosen through `focusFileVersions`.
 */
const KIND_ICON = { table: Table2, image: ImageIcon, widget: Globe, file: FileText } as const
const REREAD_MS = 250

export function FolioInsertedFiles({ dir, onStatus }: { dir: string; onStatus?: (message: string) => void }): JSX.Element {
  const [files, setFiles] = useState<FolioInsertedFile[] | null>(null)
  const [unavailable, setUnavailable] = useState('')
  const [tick, setTick] = useState(0)
  const [chosen, setChosen] = useState<string | null>(null)
  const focus = useFileVersionsFocus(dir)
  const seen = useRef(0)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const soon = (): void => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; setTick((value) => value + 1) }, REREAD_MS)
    }
    const offs = [window.writeflex.onCollectionChanged(soon), window.writeflex.onFileChangedOnDisk(soon), window.writeflex.onVersionsChanged(soon)]
    return () => { for (const off of offs) off(); if (timer !== null) clearTimeout(timer) }
  }, [])
  useEffect(() => {
    let live = true
    void window.writeflex.fileVersions.inserted(dir).then((answer) => {
      if (!live) return
      if (answer.ok) { setFiles(answer.files); setUnavailable(answer.unavailable ?? '') } else { setFiles([]); setUnavailable(answer.message) }
    }, () => { if (live) { setFiles([]); setUnavailable('The inserted files could not be read.') } })
    return () => { live = false }
  }, [dir, tick])
  // Another Folio starts with no file chosen.
  useEffect(() => { setChosen(null) }, [dir])
  // A file asked for from elsewhere is chosen, once per request.
  useEffect(() => {
    if (focus === null || focus.seq === seen.current) return
    seen.current = focus.seq
    setChosen(focus.path)
    requestAnimationFrame(() => panelRef.current?.scrollIntoView?.({ block: 'nearest' }))
  }, [focus])

  const request = focus !== null && focus.path === chosen ? { action: focus.action, seq: focus.seq } : null
  return (
    <div className="fvp-section" data-testid="folio-inserted-files" data-own-keys="file-versions">
      <div className="fr-isec"><span>Inserted files{files ? ` (${files.length})` : ''}</span></div>
      {files === null && <p className="fvp-note" role="status">Reading the inserted files…</p>}
      {files !== null && files.length === 0 && <p className="fvp-note" data-testid="inserted-files-empty">{unavailable || 'This Folio’s text inserts no table, widget or image. When it does, each appears here with its versions.'}</p>}
      {files !== null && files.length > 0 && (
        <ul className="fvp-list" aria-label="Tables, widgets and images the text inserts">
          {files.map((file) => {
            const Icon = KIND_ICON[file.kind]
            return (
              <li key={file.path}>
                <button type="button" className="fvp-file" data-testid="inserted-file" data-path={file.path} aria-current={chosen === file.path ? 'true' : undefined} title={file.path} onClick={() => setChosen(file.path)}>
                  <Icon aria-hidden="true" /><span>{FILE_KIND_LABEL[file.kind]} · {file.path.split('/').pop()}</span>
                  <span className="n">{file.versions === 0 ? 'no versions' : file.versions === 1 ? '1 version' : `${file.versions} versions`}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {chosen !== null && <div ref={panelRef}><FileVersionsPanel key={chosen} path={chosen} request={request} onReveal={() => dispatchSidebar('select-title-row')} {...(onStatus ? { onStatus } : {})} /></div>}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { GitCompare, History, Save, Table2, FileText, Image as ImageIcon, Globe } from 'lucide-react'
import { changesSentence, insertedStateSentence, partSentence, usesSentence, type CursorInsertedFacts, type FolioCursorFacts } from '../../../shared/folio-version-changes'
import { versionWhen } from '../../../shared/folio-versions-view'
import { useFolioCues } from '../plan/folio-cues-store'
import { dispatchSidebar } from '../plan/folio-sidebar'
import { FILE_VERSIONS_COMMAND_EVENT, focusFileVersions, type FileVersionsCommandDetail } from '../plan/file-versions-focus'

/**
 * The panel that follows the cursor, in the existing right rail's Versions tab (ADR-0052 § Decision 1, Folio versions ticket 06):
 * what the Folio's versions say about the part the writer is in, about the table or widget the cursor's line inserts, and the
 * Folio itself. Docked panel, not a modal: it follows the cursor and takes no focus. Its buttons call the per-part and per-file
 * operations the rail already has (compare with the part's last version, save a version of the part, save a version of the
 * file); saving a version of the part or the Folio is the pane's one Save version button (batch 3: one primary action per scope). It shows nothing in a Collection with no Folio version.
 */

/** How long a burst of changes is gathered before the facts are read again. */
const REREAD_MS = 250

const KIND_LABEL: Record<CursorInsertedFacts['kind'], string> = { table: 'Table', image: 'Image', widget: 'Widget', file: 'File' }
const KIND_ICON = { table: Table2, image: ImageIcon, widget: Globe, file: FileText } as const

export type FolioVersionsCursorPanelProps = {
  /** The Folio the open file belongs to; null when it belongs to none. */
  dir: string | null
  /** The open file. */
  activePath: string | null
  /** The file the cursor's line inserts, as written in the text; null when it inserts none. */
  embed: string | null
  onCompareWithLast: (fileVersionId: string) => void
  /** Save a version of the inserted file under the name given; answers a sentence when it could not, else null. */
  onSaveFileVersion: (path: string, name: string) => Promise<string | null>
  onCompareFile: (path: string, fileVersionId: string) => void
}

export function FolioVersionsCursorPanel({ dir, activePath, embed, onCompareWithLast, onSaveFileVersion, onCompareFile }: FolioVersionsCursorPanelProps): JSX.Element | null {
  const cues = useFolioCues(dir)
  const [facts, setFacts] = useState<FolioCursorFacts | null>(null)
  const [tick, setTick] = useState(0)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  // Read again after a collection or file change, a new version, or a change of the Folio's cues, gathered into one read.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const soon = (): void => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; setTick((value) => value + 1) }, REREAD_MS)
    }
    const offs = [window.writeflex.onCollectionChanged(soon), window.writeflex.onFileChangedOnDisk(soon), window.writeflex.onVersionsChanged(soon)]
    return () => { for (const off of offs) off(); if (timer !== null) clearTimeout(timer) }
  }, [])
  const has = cues.state === 'ready'
  useEffect(() => {
    if (dir === null || !has) { setFacts(null); return }
    let live = true
    void window.writeflex.folioVersions.cursor(dir, activePath, embed).then((value) => { if (live) setFacts(value) }, () => { if (live) setFacts(null) })
    return () => { live = false }
  }, [dir, activePath, embed, tick, has, cues])

  const insertedPath = facts?.inserted?.path ?? null
  // The file-versions commands (save a version of this file, compare, restore, save as a copy): with the cursor on an inserted file they are about THAT file,
  // so this panel answers first (capture) and hands the file to the Inspector, which draws its versions and does the work (Folio versions ticket 19).
  const insertedRef = useRef<string | null>(null)
  insertedRef.current = insertedPath
  useEffect(() => {
    if (dir === null) return
    const onCommand = (event: Event): void => {
      const detail = (event as CustomEvent<FileVersionsCommandDetail>).detail
      const path = insertedRef.current
      if (detail.handled || path === null) return
      detail.handled = true
      focusFileVersions(dir, path, detail.action)
      dispatchSidebar('select-title-row')
    }
    window.addEventListener(FILE_VERSIONS_COMMAND_EVENT, onCommand, true)
    return () => window.removeEventListener(FILE_VERSIONS_COMMAND_EVENT, onCommand, true)
  }, [dir])
  useEffect(() => { setNaming(false); setName(''); setError('') }, [insertedPath])
  useEffect(() => { if (naming) nameRef.current?.focus() }, [naming])

  if (dir === null || !has || facts === null) return null
  const part = facts.part
  const file = facts.inserted
  const FileIcon = file ? KIND_ICON[file.kind] : FileText

  const saveFile = async (): Promise<void> => {
    if (!file || busy) return
    const trimmed = name.trim()
    if (trimmed === '') { setError('Name the version before saving.'); return }
    setBusy(true)
    const refused = await onSaveFileVersion(file.path, trimmed).catch((cause: unknown) => (cause instanceof Error ? cause.message : 'The version could not be saved.'))
    setBusy(false)
    if (refused) { setError(refused); return }
    setNaming(false); setName(''); setError('')
  }

  return (
    <section className="fcp" aria-label="This part's Folio versions" data-testid="folio-cursor-panel" data-active-path={activePath ?? ''} data-embed={embed ?? ''}>
      {part && (
        <>
          <h3 className="fcp-h"><FileText aria-hidden="true" />This part · {part.title}</h3>
          <div className="fcp-b" data-testid="cursor-part">
            <p data-testid="cursor-part-versions">{partSentence(part, (ts) => versionWhen(ts))}</p>
            {part.versionCount > 0 && <p className="dim" data-testid="cursor-part-changes">{changesSentence(part)}</p>}
            <div className="fcp-row">
              <button type="button" className="fcp-btn" data-testid="cursor-compare-part" aria-disabled={part.latestFileVersion === null ? true : undefined} title={part.latestFileVersion === null ? 'This part has no saved version to compare with yet.' : undefined}
                onClick={() => { if (part.latestFileVersion) onCompareWithLast(part.latestFileVersion.id) }}><GitCompare aria-hidden="true" />Compare with last version</button>
            </div>
          </div>
        </>
      )}
      {file && (
        <>
          <h3 className="fcp-h"><FileIcon aria-hidden="true" />{KIND_LABEL[file.kind]} under the cursor · {file.path.split('/').pop()}</h3>
          <div className="fcp-b" data-testid="cursor-inserted" data-state={file.state}>
            <p data-testid="cursor-inserted-state">{insertedStateSentence(file)}</p>
            {file.uses.length > 0 && <p className="dim" data-testid="cursor-inserted-uses">{usesSentence(file.uses)}</p>}
            {naming ? (
              <div className="fcp-name" data-testid="cursor-file-name">
                <input ref={nameRef} value={name} aria-label={`Name for the version of ${file.path.split('/').pop()}`} placeholder="Name this version" disabled={busy}
                  onChange={(event) => { setName(event.target.value); setError('') }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void saveFile() }
                    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setNaming(false); setName(''); setError('') }
                  }} />
                <button type="button" className="fcp-btn pri" data-testid="cursor-file-name-save" disabled={busy} onClick={() => void saveFile()}><Save aria-hidden="true" />Save</button>
              </div>
            ) : (
              <div className="fcp-row">
                <button type="button" className="fcp-btn" data-testid="cursor-save-file" onClick={() => setNaming(true)}><History aria-hidden="true" />Save version…</button>
                <button type="button" className="fcp-btn" data-testid="cursor-compare-file" aria-disabled={file.latest && file.state === 'changed' ? undefined : true}
                  title={file.latest && file.state === 'changed' ? undefined : 'Nothing to compare: the working copy is the last version, or no version used it.'}
                  onClick={() => { if (file.latest && file.state === 'changed') onCompareFile(file.path, file.latest.id) }}><GitCompare aria-hidden="true" />{file.latest ? `Compare v${file.latest.number} with working` : 'Compare with working'}</button>
                <button type="button" className="fcp-btn" data-testid="cursor-all-versions" title="Every version of this file, with the Folio versions that used it, in the Inspector" onClick={() => { focusFileVersions(dir, file.path, 'show'); dispatchSidebar('select-title-row') }}><History aria-hidden="true" />All versions…</button>
              </div>
            )}
            {error && <p className="fcp-err" role="alert">{error}</p>}
          </div>
        </>
      )}
    </section>
  )
}

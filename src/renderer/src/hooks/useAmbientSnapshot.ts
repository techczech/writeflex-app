import { useEffect, useRef, type RefObject } from 'react'
import type { AmbientSnapshot, ExplicitSessionState } from '../../../preload'
import { parseFrontmatter, parseGoal } from '../../../main/frontmatter'
import { listingTitle } from '../../../shared/markdown/listing-title'
import type { EditorHandle } from '../components/EditorPane'
import { onEditorUpdate } from '../editor/setup'
import { documentTextForPersistence } from '../editor/writer-review'

/** The hook's debounce seam; switching identity cancels the old pending selection. */
export function ambientDebouncer(send: () => void) {
  let key: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    update(nextKey: string) {
      clearTimeout(timer)
      if (key !== nextKey) { key = nextKey; send() }
      else timer = setTimeout(send, 250)
    },
    dispose() { clearTimeout(timer) },
  }
}

type Options = {
  root: string | null
  active: string | null
  loadedFile: string | null
  collection: string | undefined
  writer: 'drafting' | 'reviewing'
  view: 'clean' | 'markup' | 'raw'
  editorRef: RefObject<EditorHandle | null>
  explicitSession: ExplicitSessionState | null
  sessionWords: number
  lastWriterEditAt: RefObject<string | undefined>
  onError: (message: string) => void
}

/** The sole renderer publisher. Read the editor only when sending, using its own update bus. */
export function useAmbientSnapshot(options: Options): void {
  const latest = useRef(options)
  latest.current = options
  // The title of the last text read: a send for the same text (a mode flip, a selection) reuses it.
  const titled = useRef<{ source: string; path: string; title: string }>()
  const folio = useRef<{ key: string; value: NonNullable<AmbientSnapshot['activeFile']>['folio'] }>()
  const publisher = useRef<ReturnType<typeof ambientDebouncer>>()
  if (!publisher.current) publisher.current = ambientDebouncer(() => {
    const o = latest.current
    if (!o.root) return
    const view = o.active && o.loadedFile === o.active ? o.editorRef.current?.view() : null
    const source = view ? documentTextForPersistence(view.state) : o.active ? o.editorRef.current?.docFor(o.active) ?? '' : ''
    const range = view?.state.selection.main
    const selection = range && !range.empty ? { from: range.from, to: range.to, text: view!.state.doc.sliceString(range.from, Math.min(range.to, range.from + 2000)) + (range.to - range.from > 2000 ? ' […]' : '') } : null
    if (selection && selection.text.length > 2000) selection.text = selection.text.slice(0, 1996) + ' […]'
    const goal = parseGoal(parseFrontmatter(source))
    const running = o.explicitSession?.status === 'running'
    const key = `${o.root}\n${o.active}`
    const position = folio.current?.key === key ? folio.current.value : undefined
    if (o.active && (titled.current?.source !== source || titled.current.path !== o.active)) {
      // listingTitle is documentTitle's answer without building the whole document model (ADR-0034).
      titled.current = { source, path: o.active, title: listingTitle(source, o.active) }
    }
    const snapshot: AmbientSnapshot = {
      workspaceRoot: o.root,
      activeFile: o.active ? { path: o.active, title: titled.current!.title, collection: o.collection, ...(position ? { folio: position } : {}) } : null,
      mode: o.active ? { writer: o.writer, view: o.view } : null,
      selection,
      process: { session: running ? 'running' : 'none', wordsThisSession: running ? o.explicitSession!.netWords : o.sessionWords,
        ...(goal ? { goal: { target: goal.target, ...(goal.due ? { due: goal.due } : {}) } } : {}) },
      recency: { ...(o.lastWriterEditAt.current ? { lastWriterEditAt: o.lastWriterEditAt.current } : {}) },
    }
    void window.writeflex.setAmbient(snapshot).catch(() => o.onError('Could not update the agent’s view of your writing.'))
  })
  const key = `${options.root}\n${options.active}`
  useEffect(() => {
    publisher.current!.update(key)
  }, [key, options.loadedFile, options.collection, options.writer, options.view, options.explicitSession, options.sessionWords])
  useEffect(() => onEditorUpdate(() => publisher.current!.update(`${latest.current.root}\n${latest.current.active}`)), [])
  useEffect(() => () => publisher.current!.dispose(), [])

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      if (!options.root || !options.active) return
      // The nearest declared ancestor owns a part; never infer a Folio from its filename.
      let dir = options.active.includes('/') ? options.active.slice(0, options.active.lastIndexOf('/')) : ''
      let position: NonNullable<AmbientSnapshot['activeFile']>['folio']
      while (true) {
        const manifest = await window.writeflex.readFolio(dir)
        if (cancelled) return
        // A manifest whose content_root leaves the folder lists no parts (main resolves none of them).
        if (manifest && !manifest.contentRootRefused) {
          const join = (...parts: string[]) => parts.filter(Boolean).join('/')
          const index = manifest.files.findIndex((part) => [join(dir, manifest.contentRoot, part.path), join(dir, part.path)].includes(options.active!))
          if (index >= 0) { position = { path: dir, index: index + 1, of: manifest.files.length }; break }
        }
        if (!dir) break
        dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : ''
      }
      if (!cancelled) { folio.current = { key, value: position }; publisher.current!.update(key) }
    }
    const run = () => { void refresh().catch(() => { if (!cancelled) options.onError('Could not read Folio context for the agent.') }) }
    run()
    const unsubscribe = window.writeflex.collection.onChanged(run)
    return () => { cancelled = true; unsubscribe() }
  }, [key, options.root, options.active])
}

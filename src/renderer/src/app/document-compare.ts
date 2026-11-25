import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import type { VersionCompareEndpointId, VersionCompareResult, WriteFlexApi } from '../../../preload'
import { compareHighlightsForEditor, shouldRefreshWorkingCompare, type CompareEditorHighlights } from '../components/compare-live'

const WORKING_DEBOUNCE_MS = 700

type Document = { workspace: string; path: string }
type Endpoints = { fromId: VersionCompareEndpointId; toId: VersionCompareEndpointId }
type Selection = Document & Endpoints

type CompareView = {
  selection: Selection
  request: number
  result: VersionCompareResult | null
  loading: boolean
  error: string
}

type CompareDependencies = {
  compare: WriteFlexApi['compareVersions']
  readWorking: (path: string) => string | undefined
  delay: (run: () => void) => () => void
}

export function createDocumentCompare(deps: CompareDependencies) {
  let document: Document | null = null
  let view: CompareView | null = null
  let nextRequest = 0
  let cancelDelay: (() => void) | undefined
  const listeners = new Set<() => void>()

  function publish(next: CompareView | null): void {
    if (view === next) return
    view = next
    for (const listener of listeners) listener()
  }

  function cancelWorkingDelay(): void {
    cancelDelay?.()
    cancelDelay = undefined
  }

  function close(): void {
    cancelWorkingDelay()
    publish(null)
  }

  function observe(workspace: string | null, path: string | null): void {
    if (workspace === document?.workspace && path === document?.path) return
    document = workspace && path ? { workspace, path } : null
    close()
  }

  function prepare(selection: Selection): CompareView {
    cancelWorkingDelay()
    const pending = { selection, request: ++nextRequest, result: null, loading: true, error: '' }
    publish(pending)
    return pending
  }

  async function read(pending: CompareView): Promise<void> {
    if (view?.request !== pending.request) return
    const { path, fromId, toId } = pending.selection
    try {
      const currentContent = deps.readWorking(path)
      const result = await deps.compare({ path, fromId, toId, currentContent })
      if (view?.request === pending.request) publish({ ...pending, result, loading: false })
    } catch (error) {
      if (view?.request === pending.request) {
        publish({
          ...pending,
          loading: false,
          error: error instanceof Error ? error.message : 'Could not compare these versions.',
        })
      }
    }
  }

  function open(fromId: VersionCompareEndpointId, toId: VersionCompareEndpointId): Promise<void> | undefined {
    if (document) return read(prepare({ ...document, fromId, toId }))
  }

  function select(endpoints: Endpoints): Promise<void> | undefined {
    const selection = view?.selection
    if (!selection || (selection.fromId === endpoints.fromId && selection.toId === endpoints.toId)) return
    return read(prepare({ ...selection, ...endpoints }))
  }

  function queueWorkingRefresh(path: string): void {
    const selection = view?.selection
    if (!selection || !shouldRefreshWorkingCompare(selection, selection.path, path)) return
    // Once Working changes, the previous diff's offsets no longer address its text.
    const pending = prepare(selection)
    cancelDelay = deps.delay(() => {
      if (view?.request !== pending.request) return
      cancelDelay = undefined
      void read(pending)
    })
  }

  return {
    getSnapshot: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    observe,
    open,
    close,
    setFrom(fromId: VersionCompareEndpointId) {
      if (view) return select({ fromId, toId: view.selection.toId })
    },
    setTo(toId: VersionCompareEndpointId) {
      if (view) return select({ fromId: view.selection.fromId, toId })
    },
    swap() {
      if (view) return select({ fromId: view.selection.toId, toId: view.selection.fromId })
    },
    queueWorkingRefresh,
    refreshRenamedVersion(workspace: string | null | undefined, path: string | null, id: string) {
      const selection = view?.selection
      if (selection && selection.workspace === workspace && selection.path === path
        && (selection.fromId === id || selection.toId === id)) {
        return read(prepare(selection))
      }
    },
  }
}

export function useDocumentCompare(
  workspace: string | null,
  path: string | null,
  readWorking: CompareDependencies['readWorking'],
) {
  const [compare] = useState(() => createDocumentCompare({
    compare: (input) => window.writeflex.compareVersions(input),
    readWorking,
    delay: (run) => {
      const timer = setTimeout(run, WORKING_DEBOUNCE_MS)
      return () => clearTimeout(timer)
    },
  }))
  const snapshot = useSyncExternalStore(compare.subscribe, compare.getSnapshot)
  useLayoutEffect(() => {
    compare.observe(workspace, path)
    return () => compare.observe(null, null)
  }, [compare, workspace, path])
  // React can render the next tab before its layout effect retires the previous session.
  const compareView = snapshot?.selection.workspace === workspace && snapshot.selection.path === path ? snapshot : null
  return { compare, compareView }
}

export function documentCompareMarks(view: CompareView | null, doc: string | null): CompareEditorHighlights {
  return view?.result && view.selection.toId === 'working' && doc !== null
    ? compareHighlightsForEditor(view.result.changes, doc)
    : { marks: [] }
}

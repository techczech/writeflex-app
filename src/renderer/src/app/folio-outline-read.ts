import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MANIFEST_NAME } from '../../../shared/folio-constants'
import type { FolioOutline } from '../../../shared/folio-outline'
import { ORDER_IN_PLAN_LINE, blockCommandTarget, commandTarget, type FocusedFolioRow } from '../../../shared/folio-running-order'
import type { FolioRunningOrder, FolioSeen } from './folio-running-order'

type Scope = { root: string; folder: string; workspaceDir: string | null }
type Request = { scope: Scope; path: string }
type Answer = { request: Request; outline: FolioOutline | null; failed: boolean }

export function useFolioOutlineRead(
  root: string | null, editorPath: string | null, workspaceDir: string | null, knownFolio: boolean,
  savedTick: number, refreshTick: number,
) {
  const path = workspaceDir === null ? editorPath : workspaceDir ? `${workspaceDir}/${MANIFEST_NAME}` : MANIFEST_NAME
  // Main resolves a document's Folio from the file's parent folder. Keep a projection while
  // switching files in that folder. A different folder may resolve to a different nested Folio.
  const folder = path === null || path.includes('://') ? null : path.slice(0, Math.max(0, path.lastIndexOf('/')))
  const scope = useMemo<Scope | null>(() => root !== null && folder !== null ? { root, folder, workspaceDir } : null, [root, folder, workspaceDir])
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [retryTick, setRetryTick] = useState(0)
  const shown = answer?.request.scope === scope ? answer : null
  const shouldRead = knownFolio || workspaceDir !== null || shown !== null
  const request = useMemo<Request | null>(
    () => scope && path !== null && shouldRead ? { scope, path } : null,
    [scope, path, shouldRead, savedTick, refreshTick, retryTick],
  )
  const liveRequest = useRef<Request | null>(null)
  const latest = useRef<Answer | null>(null)
  const committedScope = useRef<Scope | null>(null)
  useLayoutEffect(() => {
    committedScope.current = scope
    return () => { committedScope.current = null }
  }, [scope])
  const isCurrent = useCallback(() => request !== null && liveRequest.current === request, [request])
  const retry = useCallback(() => {
    if (!isCurrent()) return
    // Notifications retire write authority immediately, including events in the same turn.
    liveRequest.current = null
    setRetryTick(tick => tick + 1)
  }, [isCurrent])

  useLayoutEffect(() => {
    if (request === null) return
    liveRequest.current = request
    let disposed = false
    const { scope } = request
    const settle = (outline: FolioOutline | null, failed: boolean): void => {
      if (disposed || liveRequest.current !== request) return
      const previous = latest.current?.request.scope === scope ? latest.current.outline : null
      const next = { request, outline: failed ? previous : outline, failed }
      latest.current = next
      setAnswer(next)
    }
    const offCollection = window.writeflex.onCollectionChanged(retry)
    const offDisk = window.writeflex.onFileChangedOnDisk(retry)
    void window.writeflex.readFolioOutline(request.path).then(
      outline => settle(scope.workspaceDir === null || outline?.dir === scope.workspaceDir ? outline : null, false),
      () => settle(null, true),
    )
    return () => {
      disposed = true
      if (liveRequest.current === request) liveRequest.current = null
      offCollection()
      offDisk()
    }
  }, [request, retry])

  const outline = shown?.outline ?? null
  const failed = shown?.failed ?? false
  const pending = request !== null && shown?.request !== request
  const order = useCallback((expected?: readonly string[]): FolioSeen | null => {
    if (!outline || outline.orderInPlanOnly || failed || pending || !isCurrent()) return null
    if (expected && (expected.length !== outline.pieces.length || expected.some((path, index) => path !== outline.pieces[index].path))) return null
    return {
      dir: outline.dir,
      pieces: outline.pieces,
      outlineRequest: {
        isCurrent,
        // Preparing the write may itself save a buffer and start a new read. The scope must
        // still own the Folio and main still checks the expected order at the point of writing.
        ownsScope: () => committedScope.current === scope && latest.current?.request.scope === scope
          && latest.current.outline?.dir === outline.dir && !latest.current.failed,
      },
    }
  }, [outline, failed, pending, isCurrent, scope])
  return useMemo(() => ({ scope, outline, failed, pending, retry, order, revision: request }), [scope, outline, failed, pending, retry, order, request])
}

export type FolioOutlineRead = ReturnType<typeof useFolioOutlineRead>
export type FolioOutlineCommand = 'up' | 'down' | 'add' | 'addAll'

/** Palette and menu actions use the same accepted basis as the Outline's toolbar and drag. */
export function runFolioOutlineCommand(
  command: FolioOutlineCommand, path: string | null, read: FolioOutlineRead,
  runningOrder: FolioRunningOrder, flash: (message: string) => void,
): void {
  if (!path) { flash('Open a file of a Folio first.'); return }
  const { outline } = read
  const seen = read.order()
  if (!outline || !seen) {
    if (read.failed) flash('Retry the Folio Outline before changing the running order.')
    else if (read.pending) flash('Wait for the Folio Outline to finish reading.')
    else if (outline?.orderInPlanOnly) flash(ORDER_IN_PLAN_LINE)
    else if (outline) flash('Wait for the Folio Outline to finish reading.')
    else flash('This file is not in a Folio.')
    return
  }
  const row = document.activeElement?.closest<HTMLElement>('[data-fo-path]')
  const focused: FocusedFolioRow = row?.dataset.foPath && (row.dataset.kind === 'piece' || row.dataset.kind === 'also')
    ? { path: row.dataset.foPath, kind: row.dataset.kind }
    : null
  if (command === 'addAll') {
    const files = outline.also.filter(file => file.addable === true).map(({ path, title }) => ({ path, title }))
    if (files.length === 0) { flash(`Every piece that can join ${outline.name} is already in the running order.`); return }
    void runningOrder.addPieces(seen, files)
    return
  }
  const target = command === 'add' ? commandTarget(command, focused, path, outline) : blockCommandTarget(command, focused, path, outline)
  if ('message' in target) { flash(target.message); return }
  if (command === 'add') void runningOrder.addPieces(seen, [{ path: target.path, title: target.title }])
  else void runningOrder.movePiece(seen, target.path, target.beforePath)
}

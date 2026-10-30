import { useCallback, useEffect, useRef, useState } from 'react'
import type { ScratchGroup, ScratchItem, ScratchSnapshot, ScratchSource, ScratchStatus, ScratchpadBridge } from '../../../shared/scratchpad-items'

const EMPTY: ScratchSnapshot = { items: [], groups: [], notices: [], folioDir: null }

export type ScratchpadData = {
  snapshot: ScratchSnapshot
  /** The Folio's canonical sources, for the collectable Reference/Evidence cards. Re-read with the list. */
  sources: ScratchSource[]
  reload: () => void
  collectSource: (sourceId: string) => Promise<ScratchItem | null>
  /** Why the last listing failed, said as it is; the previous list stays shown. */
  loadError: string | null
  setStatus: (ids: string[], status: ScratchStatus) => Promise<boolean>
  setGroup: (ids: string[], group: string | null) => Promise<boolean>
  createGroup: (name: string) => Promise<ScratchGroup | null>
  toggleDone: (item: ScratchItem) => Promise<boolean>
  setColour: (item: ScratchItem, colour: string | null) => Promise<boolean>
  /** Delete forever (Rejected only, confirmed in the panel first); a refusal is said and nothing is removed. */
  deleteForever: (item: ScratchItem) => Promise<boolean>
}

/**
 * The window's Scratchpad list over the preload bridge. Re-lists on the folder or document changing and
 * on every `scratchpad:changed` / `scraps:changed` push. An answer that arrives after a newer request, or
 * after the folder changed, is dropped, so a slow list never shows another folder's items.
 */
export function useScratchpadItems(bridge: ScratchpadBridge, root: string | null, activePath: string | null, onScrapsChanged: (fn: () => void) => () => void, say: (message: string) => void): ScratchpadData {
  const [snapshot, setSnapshot] = useState<ScratchSnapshot>(EMPTY)
  const [sources, setSources] = useState<ScratchSource[]>([])
  const [sourceNotices, setSourceNotices] = useState<string[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const ask = useRef(0)
  const rootRef = useRef(root)
  rootRef.current = root
  const pathRef = useRef(activePath)
  pathRef.current = activePath
  const sayRef = useRef(say)
  sayRef.current = say

  const reload = useCallback(() => {
    const asked = ++ask.current
    const folder = rootRef.current
    if (!folder) { setSnapshot(EMPTY); setSources([]); setSourceNotices([]); setLoadError(null); return }
    void bridge.list({ root: folder, activePath: pathRef.current }).then((reply) => {
      if (asked !== ask.current || rootRef.current !== folder) return
      if (reply.ok) { setSnapshot(reply.snapshot); setLoadError(null) } else setLoadError(reply.error)
    }).catch(() => { if (asked === ask.current) setLoadError('The Scratchpad could not be read.') })
    const path = pathRef.current
    if (!path) { setSources([]); setSourceNotices([]); return }
    void bridge.sources({ root: folder, activePath: path }).then((reply) => {
      if (asked !== ask.current || rootRef.current !== folder) return
      setSources(reply.ok ? reply.sources : [])
      setSourceNotices(reply.ok ? reply.notices : [reply.error])
    }).catch(() => { if (asked === ask.current) { setSources([]); setSourceNotices(['The Folio sources could not be read.']) } })
  }, [bridge])

  useEffect(() => { setSnapshot(EMPTY); setSources([]); setSourceNotices([]); reload() }, [root, reload])
  useEffect(() => { reload() }, [activePath, reload])
  useEffect(() => bridge.onChanged(reload), [bridge, reload])
  useEffect(() => onScrapsChanged(reload), [onScrapsChanged, reload])

  /** Every mutation names this window's folder; a refusal is said, and the push drives the re-list. */
  const act = useCallback(async <T,>(run: (folder: string) => Promise<({ ok: true } & T) | { ok: false; error: string }>): Promise<(({ ok: true } & T)) | null> => {
    const folder = rootRef.current
    if (!folder) return null
    const reply = await run(folder).catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : 'No answer.' }))
    if (!reply.ok) { sayRef.current(reply.error); return null }
    return reply
  }, [])

  return {
    snapshot: { ...snapshot, notices: [...snapshot.notices, ...sourceNotices] },
    sources,
    reload,
    collectSource: useCallback(async (sourceId) => {
      const folder = rootRef.current
      const path = pathRef.current
      if (!folder || !path) return null
      const reply = await bridge.collectSource({ root: folder, activePath: path, sourceId }).catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : 'No answer.' }))
      if (!reply.ok) { sayRef.current(reply.error); return null }
      return reply.item
    }, [bridge]),
    loadError,
    setStatus: useCallback(async (ids, status) => (await act((folder) => bridge.setStatus({ root: folder, ids, status }))) !== null, [act, bridge]),
    setGroup: useCallback(async (ids, group) => (await act((folder) => bridge.setGroup({ root: folder, ids, group }))) !== null, [act, bridge]),
    createGroup: useCallback(async (name) => (await act((folder) => bridge.createGroup({ root: folder, name })))?.group ?? null, [act, bridge]),
    toggleDone: useCallback(async (item) => (await act((folder) => bridge.toggleDone({ root: folder, id: item.id }))) !== null, [act, bridge]),
    setColour: useCallback(async (item, colour) => (await act((folder) => bridge.setColour({ root: folder, id: item.id, colour }))) !== null, [act, bridge]),
    deleteForever: useCallback(async (item) => {
      const version = item.version
      if (!version) { sayRef.current('Refresh the Scratchpad before deleting this item. Nothing was deleted.'); return false }
      return (await act((folder) => bridge.deleteForever({ root: folder, id: item.id, version }))) !== null
    }, [act, bridge]),
  }
}

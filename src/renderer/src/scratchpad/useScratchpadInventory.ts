import { useCallback, useEffect, useRef, useState } from 'react'
import type { ScratchItem, ScratchLiveBuffer, ScratchpadBridge } from '../../../shared/scratchpad-items'

/** Live reads ask each bound window's existing buffer owner; this hook never flushes or saves. */
export function useScratchpadInventory(bridge: ScratchpadBridge, root: string | null, path: string | null, enabled: boolean, buffer: (path: string) => { content: string; removedSpans: Array<{ from: number; to: number }> } | null, owned: (path: string) => boolean) {
  const [scope, setScope] = useState<'part' | 'folio'>('part')
  const [items, setItems] = useState<ScratchItem[]>([])
  const [notices, setNotices] = useState<string[]>([])
  const latest = useRef({ root, path, scope, buffer, owned })
  latest.current = { root, path, scope, buffer, owned }
  const request = useRef(0)
  const reload = useCallback(() => {
    const { root, path, scope } = latest.current
    const ask = ++request.current
    if (!root || !path) { setItems([]); setNotices([]); return }
    void bridge.inventory({ root, activePath: path, scope }).then(reply => {
      if (ask !== request.current || latest.current.root !== root || latest.current.path !== path || latest.current.scope !== scope) return
      if (reply.ok) { setItems(reply.items); setNotices(reply.notices) }
      else { setItems([]); setNotices([reply.error]) }
    }).catch((error: Error) => { if (ask === request.current) { setItems([]); setNotices([error.message]) } })
  }, [bridge])
  useEffect(() => bridge.onReadBuffersRequested(input => {
    const current = latest.current
    if (input.root !== current.root) { void bridge.answerBuffers({ id: input.id, root: current.root ?? '', buffers: [] }); return }
    const buffers = input.paths.flatMap((path): ScratchLiveBuffer[] => {
      const live = current.buffer(path)
      if (live !== null) return [{ path, content: live.content, removedSpans: live.removedSpans }]
      return current.owned(path) ? [{ path, content: null }] : []
    })
    void bridge.answerBuffers({ id: input.id, root: input.root, buffers })
  }), [bridge])
  useEffect(() => {
    setItems([]); setNotices([]); ++request.current
    if (!enabled) return
    reload()
    // Other bound windows may own the unsaved part. Actions always revalidate against a fresh read.
    const timer = setInterval(reload, 2000)
    const off = bridge.onChanged(reload)
    return () => { clearInterval(timer); off(); ++request.current }
  }, [root, path, scope, enabled, reload, bridge])
  return { items, notices, scope, setScope, reload }
}

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AssistantTurnActivity } from '../../../shared/assistant-turns'
import { assistantMode, latestChangedTurn, ASSISTANT_MODE_KEY, storeNotice, type AssistantMode, type AssistantTurnUndo } from '../../../shared/assistant-turns'

/** Owns the panel's turn history, selection, refusals and app-wide mode through the IPC seam. */
export function useAssistantTurns(threadId: string | undefined, onChanged: () => void) {
  const [turns, setTurns] = useState<AssistantTurnActivity[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<AssistantTurnUndo | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<AssistantMode>('work')
  const [busy, setBusy] = useState(false)
  const selection = useRef<string | null>(null)
  const generation = useRef(0)
  const changed = useRef(onChanged)
  changed.current = onChanged
  const refresh = useCallback(async () => {
    const current = generation.current
    const next = await window.writeflex.assistantTurns.list()
    if (current !== generation.current) return
    setTurns([...next.turns].reverse())
    setNotice(storeNotice(next.store))
  }, [])
  useEffect(() => {
    generation.current++
    selection.current = null
    setTurns([]); setSelected(null); setRefusal(null); setError(null); setNotice(null); setBusy(false)
    let active = true
    void refresh().catch(() => {})
    // Refresh from authoritative list: older steps' undo availability changes with every write.
    const off = window.writeflex.assistantTurns.onActivity(() => { if (active) void refresh().catch(() => {}) })
    const offSuggestions = window.writeflex.onSuggestions(() => { if (active) void refresh().catch(() => {}) })
    // Lease loss has no Bridle event. Re-read the reported store state while this panel is mounted.
    const timer = window.setInterval(() => { if (active) void refresh().catch(() => {}) }, 5000)
    return () => { active = false; generation.current++; off(); offSuggestions(); window.clearInterval(timer) }
  }, [threadId, refresh])
  useEffect(() => {
    let active = true
    void window.writeflex.getSettings().then((settings) => { if (active) setMode(assistantMode(settings[ASSISTANT_MODE_KEY])) })
    const off = window.writeflex.onSettingChanged(({ key, value }) => { if (key === ASSISTANT_MODE_KEY) setMode(assistantMode(value)) })
    return () => { active = false; off() }
  }, [])
  const chooseMode = useCallback(async (next: AssistantMode) => {
    try { await window.writeflex.setSetting(ASSISTANT_MODE_KEY, next, 'Assistant mode'); setMode(next); setError(null) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }, [])
  const select = useCallback(async (id: string) => {
    const current = generation.current
    selection.current = id
    setSelected(id); setRefusal(null)
    try {
      const turn = await window.writeflex.assistantTurns.get(id)
      if (turn && current === generation.current) setTurns((entries) => entries.map((entry) => entry.turnId === id ? turn : entry))
    } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause)) }
  }, [])
  const undo = useCallback(async (id: string, includingLater = false) => {
    const current = generation.current
    selection.current = id
    setSelected(id); setBusy(true); setRefusal(null)
    try {
      const result = await window.writeflex.assistantTurns.undo(id, includingLater)
      if (current !== generation.current) return null
      if (selection.current === id) setRefusal(result.undone ? null : result)
      await refresh().catch(() => {})
      if (result.undone || result.reason === 'partially-undone') changed.current()
      return result
    } catch (cause) {
      if (current === generation.current && selection.current === id) setRefusal({ undone: false, reason: 'error', message: cause instanceof Error ? cause.message : String(cause) })
      return null
    } finally { if (current === generation.current) setBusy(false) }
  }, [refresh])
  const undoLatest = useCallback(async () => {
    const current = generation.current
    const next = await window.writeflex.assistantTurns.list()
    if (current !== generation.current) return null
    const latest = latestChangedTurn(next.turns)
    return latest ? undo(latest.turnId) : null
  }, [undo])
  return { turns, selected, select, refusal, busy, mode, chooseMode, notice, error, undo, undoLatest }
}

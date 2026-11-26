import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Version } from '../../../preload'

export type DocumentVersionsStatus = 'idle' | 'loading' | 'ready' | 'unavailable'

type DocumentHistory = {
  status: DocumentVersionsStatus
  versions: Version[]
  attachments: Array<{ from: string; to: string }>
  attachmentUndo: { id: string; files: number } | null
  waiting: Array<{ from: string; count: number }>
}

type Subject = { root: string | null; path: string | null }
type Projection = { subject: Subject; history: DocumentHistory }
type Activation = Projection & { request: number }

const emptyHistory: DocumentHistory = {
  status: 'idle',
  versions: [],
  attachments: [],
  attachmentUndo: null,
  waiting: [],
}
const loadingHistory: DocumentHistory = { ...emptyHistory, status: 'loading' }

export function useDocumentVersions(root: string | null, path: string | null) {
  // Every committed return to a document gets a new subject, even if its root and path match.
  const subject = useMemo(() => ({ root, path }), [root, path])
  const initial = root && path ? loadingHistory : emptyHistory
  const [projection, setProjection] = useState<Projection | null>(null)
  const activation = useRef<Activation | null>(null)

  useLayoutEffect(() => {
    activation.current = { subject, history: initial, request: 0 }
    return () => { activation.current = null }
  }, [subject, initial])

  const isHistorySubjectCurrent = useCallback(() => activation.current?.subject === subject, [subject])
  const currentHistory = useCallback((): DocumentHistory | null => {
    const current = activation.current
    return current?.subject === subject && current.history.status === 'ready' ? current.history : null
  }, [subject])

  const reloadVersions = useCallback(async (): Promise<void> => {
    const current = activation.current
    if (current?.subject !== subject || !subject.root || !subject.path) return
    const documentPath = subject.path
    const request = ++current.request
    const publish = (history: DocumentHistory) => {
      if (activation.current !== current || current.request !== request) return
      current.history = history
      setProjection({ subject, history })
    }
    try {
      const [versions, attachments, attachmentUndo, waiting] = await Promise.all([
        window.writeflex.listVersions({ path: documentPath }),
        window.writeflex.historyAttachmentSuggestions(documentPath).catch(() => []),
        window.writeflex.historyAttachmentUndo(documentPath).catch(() => null),
        window.writeflex.waitingVersionHistory().catch(() => []),
      ])
      publish({ status: 'ready', versions, attachments, attachmentUndo, waiting })
    } catch {
      // Keep the whole accepted projection visible. Its controls stay guarded until a read succeeds.
      publish({ ...current.history, status: 'unavailable' })
    }
  }, [subject])

  useEffect(() => {
    if (!subject.root || !subject.path) return
    const unsubscribe = window.writeflex.onVersionsChanged(() => void reloadVersions())
    void reloadVersions()
    return unsubscribe
  }, [subject, reloadVersions])

  const history = projection?.subject === subject ? projection.history : initial
  return { history, reloadVersions, currentHistory, isHistorySubjectCurrent }
}

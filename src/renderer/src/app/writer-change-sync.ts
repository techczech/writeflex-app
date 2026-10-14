import type { Change, NewChange } from '../../../preload'
import type { WriterPendingChange } from '../editor/writer-review'

type WriterChangePort = {
  addChange: (input: NewChange) => Promise<Change>
  updateWriterChange: (id: string, input: NewChange) => Promise<Change>
}

export function writerChangeInput(path: string, change: WriterPendingChange, sessionId?: string): NewChange {
  return {
    path,
    provenance: 'writer',
    editClass: 'content',
    category: 'wording',
    summary: change.oldText && change.newText ? 'Your rewrite' : change.newText ? 'Your insertion' : 'Your deletion',
    oldText: change.oldText,
    newText: change.newText,
    anchor: change.anchor,
    isCorrection: false,
    // ADR-0025 §3: the per-document writer session this edit belongs to. Grouped as "this session" in
    // Reviewing; the diary groups document-sessions into work periods later.
    ...(sessionId ? { sessionId } : {}),
  }
}

export async function syncWriterChanges(input: {
  path: string
  pending: readonly WriterPendingChange[]
  pathMap: Map<string, string>
  sessionId?: string
} & WriterChangePort): Promise<string[]> {
  const ids: string[] = []
  for (const change of input.pending) {
    const payload = writerChangeInput(input.path, change, input.sessionId)
    const existing = input.pathMap.get(change.localId)
    if (existing) {
      const updated = await input.updateWriterChange(existing, payload)
      ids.push(updated.id)
      continue
    }
    const added = await input.addChange(payload)
    input.pathMap.set(change.localId, added.id)
    ids.push(added.id)
  }
  return ids
}

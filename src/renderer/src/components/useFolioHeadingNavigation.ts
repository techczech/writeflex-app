import { useEffect, useState } from 'react'
import { EditorView } from '@codemirror/view'
import type { RoomEditorRef } from './FolioRoomFlags'
import { resolveHeadingLine, type FolioHeadingTarget } from '../../../shared/folio-workspace-headings'

type Target = FolioHeadingTarget

/** Wait for the app's existing Text editor to load the requested part before placing the cursor. */
export function useFolioHeadingNavigation(dir: string, textLoaded: string | null, editor: RoomEditorRef | undefined, selectedPath: string | null, textShown: boolean): (target: Target) => void {
  const [pending, setPending] = useState<(Target & { dir: string }) | null>(null)
  useEffect(() => {
    if (!pending) return
    if (pending.dir !== dir || !textShown || selectedPath !== pending.path) { setPending(null); return }
    if (textLoaded !== pending.path || editor?.current?.path() !== pending.path) return
    const view = editor.current.view()
    if (!view) return
    const doc = view.state.doc
    const line = doc.line(resolveHeadingLine(doc.lines, n => doc.line(n).text, pending))
    view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) })
    view.focus()
    setPending(null)
  }, [pending, dir, textLoaded, editor, selectedPath, textShown])
  return target => setPending({ ...target, dir })
}

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { onEditorUpdate } from '../editor/setup'
import type { Text } from '@codemirror/state'
import { extractOutlineOfState, type OutlineHeading } from '../editor/outline'
import type { EditorHandle } from '../components/EditorPane'
import { documentTextForPersistence } from '../editor/writer-review'

// Coalesce the rapid doc/cursor updates typing produces into one recompute. The status bar and the
// outline pane USED to own this debounce independently, and each ran its own extractOutline (a full
// Lezer parse) every tick — one cursor move on a long document meant two whole-document parses per
// 150ms. Lifting the read here makes it ONE shared parse per tick, and none at all on a cursor-only
// move (the outline is memoised on the doc text). Interval unchanged from both former subscribers.
const DEBOUNCE_MS = 150

/**
 * Debounces snapshot reads (typing, cursor moves) but reads at once when the editor shows a different
 * file than the last read did, so a tab switch does not leave the outline waiting for the debounce.
 */
export function snapshotScheduler(readPath: () => string | null, recompute: () => void): { schedule: () => void; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastPath: string | null | undefined
  const run = (): void => {
    timer = null
    lastPath = readPath()
    recompute()
  }
  return {
    schedule: () => {
      if (timer) clearTimeout(timer)
      if (readPath() !== lastPath) { timer = null; run(); return }
      timer = setTimeout(run, DEBOUNCE_MS)
    },
    dispose: () => { if (timer) clearTimeout(timer); timer = null },
  }
}

/** A single debounced read of the live editor view, shared by the status bar and the outline pane. */
export type EditorSnapshot = {
  /** The file whose buffer this was read from, recorded when the snapshot is produced (null: none open). A snapshot trails a tab switch by the debounce, so consumers compare it with the open path. */
  path: string | null
  /** Raw live buffer text (`doc.toString()`), captured once per tick. Offset-indexed consumers use this. */
  docText: string
  /** Clean persisted text for whole-document counts/readouts. Never use this for buffer offsets. */
  countText: string
  /** The document's headings — a pure function of `docText`, memoised on it so a cursor-only move
   *  (which leaves `docText` unchanged) reuses the previous parse instead of re-running the parser. */
  outline: OutlineHeading[]
  /** The primary selection, read off the SAME view snapshot as `docText`. */
  selHead: number
  selFrom: number
  selTo: number
  selEmpty: boolean
}

/** Everything the tick reads straight off the view; `outline` is derived from `docText` separately so
 *  the parse re-runs only when the text actually changes. */
type RawSnapshot = Omit<EditorSnapshot, 'outline'>

/**
 * Subscribe ONCE to the editor-update bus and publish a debounced snapshot of the live view — the
 * document text, its heading outline, and the primary selection — for both the status bar and the
 * outline pane to derive from. This consolidates what were two independent bus subscribers, each of
 * which ran its own `extractOutline` every tick; the parse now happens once and is skipped entirely
 * when only the cursor moved (the outline is memoised on the unchanged doc text). Returns null before
 * the first read or when no view is mounted, matching the former per-component "no view" reset.
 */
export function useEditorSnapshot(
  editorRef: RefObject<EditorHandle | null>,
  activePath: string | null,
): EditorSnapshot | null {
  const [raw, setRaw] = useState<(RawSnapshot & { outline: OutlineHeading[] }) | null>(null)
  // The outline is a pure function of the document, so a tick on the same document (a caret move)
  // reuses it; a changed document reads headings off the editor's syntax tree, not a second parse.
  const outlineCache = useRef<{ doc: Text; text: string; outline: OutlineHeading[] } | null>(null)

  const recompute = useCallback(() => {
    const view = editorRef.current?.view()
    if (!view) {
      setRaw(null)
      return
    }
    const sel = view.state.selection.main
    const docText = view.state.doc.toString()
    const cached = outlineCache.current
    if (cached?.doc !== view.state.doc && cached?.text !== docText) {
      outlineCache.current = { doc: view.state.doc, text: docText, outline: extractOutlineOfState(view.state, docText) }
    }
    setRaw({
      path: editorRef.current?.path() ?? null,
      docText,
      outline: outlineCache.current!.outline,
      countText: documentTextForPersistence(view.state),
      selHead: sel.head,
      selFrom: sel.from,
      selTo: sel.to,
      selEmpty: sel.empty,
    })
  }, [editorRef])

  const scheduler = useMemo(
    () => snapshotScheduler(() => editorRef.current?.path() ?? null, recompute),
    [editorRef, recompute],
  )
  const schedule = scheduler.schedule

  // Follow the live editor: doc edits and cursor moves both re-derive the snapshot. A tab switch
  // rebuilds the editor state (firing the same bus) and also re-runs the activePath effect below.
  useEffect(() => onEditorUpdate(schedule), [schedule])
  useEffect(() => () => scheduler.dispose(), [scheduler])
  // A path change recomputes at once (no debounce) so the outline's wait for the new file's snapshot lasts a frame.
  useEffect(() => { schedule() }, [activePath, schedule])

  return raw
}

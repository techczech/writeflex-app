import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { syntaxTree } from '@codemirror/language'
import { onEditorUpdate } from '../editor/setup'
import type { EditorHandle } from '../components/EditorPane'
import { hereCount } from '../commands/actions-here'
import { placeAt, placeLabel, placeOfRow, type PaneRow, type Place } from '../commands/place'

// The caret moves many times a second while typing; the chip only needs the place it comes to rest on.
const DEBOUNCE_MS = 80
// After a jump to a part of a long file the parser has not reached, read the place once more.
const REPARSE_RETRY_MS = 350

/** The setting "Show where I am in the status bar": on unless it is stored as false. */
export const SHOW_PLACE_KEY = 'statusBar.showPlace'
export const SHOW_PLACE_LABEL = 'Show where I am in the status bar'

/** What the status-bar chip shows: the place, its label, and how many commands Actions here lists there. */
export type PlaceReading = { place: Place; label: string; count: number }

type Closest = { closest(selector: string): { classList: { contains(name: string): boolean } } | null }

/**
 * Which pane row an element with the keyboard stands for.
 *   - a row of the Files pane or a heading row of the Outline: that row;
 *   - anything inside the editor, or an Outline row that is not a heading: null (the caret decides);
 *   - anything else (the status bar, a dialog, a rename box): undefined, which changes nothing, so
 *     the chip keeps naming the last place the writer was.
 */
export function paneRowFromElement(element: Closest | null): PaneRow | null | undefined {
  if (!element) return undefined
  if (element.closest('.cm-editor')) return null
  const fileRow = element.closest('.tree [data-row]')
  if (fileRow) {
    if (fileRow.classList.contains('renaming')) return undefined
    return fileRow.classList.contains('folder') ? { kind: 'folder', focused: fileRow.classList.contains('focused') } : { kind: 'file' }
  }
  if (element.closest('.ol-item[role="treeitem"][data-kind="heading"]')) return { kind: 'outline-row' }
  if (element.closest('.ol-item[role="treeitem"]')) return null
  return undefined
}

/**
 * The Place the writer is in, for the status-bar chip: follows the caret (the editor-update bus) and
 * the keyboard's move between the editor, the Files pane and the Outline (focus). null while
 * `enabled` is false, and while no document is open and no row has the keyboard.
 */
export function usePlace(editorRef: RefObject<EditorHandle | null>, activePath: string | null, enabled: boolean): PlaceReading | null {
  const [reading, setReading] = useState<PlaceReading | null>(null)
  const rowRef = useRef<PaneRow | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const recompute = useCallback((retry = true) => {
    const view = activePath ? editorRef.current?.view() ?? null : null
    const row = rowRef.current
    if (!enabled || (!view && !row)) { setReading(null); return }
    const state = view?.state ?? null
    const place = row || !state ? placeOfRow(row!) : placeAt(state)
    const count = hereCount(place, state)
    setReading((current) => current && current.place === place && current.count === count ? current : { place, label: placeLabel(place), count })
    if (retryRef.current) clearTimeout(retryRef.current)
    if (retry && state && !row && syntaxTree(state).length < state.doc.lineAt(state.selection.main.head).to) {
      retryRef.current = setTimeout(() => recompute(false), REPARSE_RETRY_MS)
    }
  }, [activePath, editorRef, enabled])

  const schedule = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(recompute, DEBOUNCE_MS)
  }, [recompute])

  useEffect(() => onEditorUpdate(schedule), [schedule])
  useEffect(() => { schedule() }, [activePath, enabled, schedule])
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (retryRef.current) clearTimeout(retryRef.current)
  }, [])

  useEffect(() => {
    if (!enabled) return
    const read = (target: EventTarget | null): void => {
      const row = paneRowFromElement(target instanceof Element ? target : null)
      if (row === undefined) return
      rowRef.current = row
      schedule()
    }
    const onFocusIn = (event: FocusEvent): void => read(event.target)
    read(document.activeElement)
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [enabled, schedule])

  return reading
}

/**
 * Do what ⌘K does at this time, wherever the keyboard is: the key is sent to the element that has
 * it, so the editor, the Files pane and the Outline each answer as they would to the real chord.
 * With the keyboard nowhere (the page body), the editor takes it first.
 */
export function pressCommandK(focusEditor: () => void): void {
  let target = document.activeElement
  if (!target || target === document.body || !(target.closest('.cm-editor') || target.closest('.tree') || target.closest('[role="treeitem"]'))) {
    focusEditor()
    target = document.activeElement
  }
  target?.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', keyCode: 75, which: 75, metaKey: true, bubbles: true, cancelable: true } as KeyboardEventInit))
}

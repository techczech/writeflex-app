// Adapted from TalkWeaver talklist/SearchAssist.tsx. Uses the loaded view folders, never IPC.
import { commandRan } from '../commands/command-ran'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react'
import type { FileFolderCount } from '../file-prefix-assist'
import { DATE_FORMS_HELP, FILE_FIELD_PREFIXES } from '../file-query'
import { applyCompletion, completionAt, insertPrefix, type Completion, type QueryEdit } from '../file-prefix-assist'

/** L3: the available prefixes; a click types one (mousedown keeps the box focused). */
export function PrefixHints({ onPick }: { onPick: (prefix: string) => void }): JSX.Element {
  return (
    <div className="file-pfx-row" role="group" aria-label="Search prefixes">
      {FILE_FIELD_PREFIXES.map((p) => (
        <button
          key={p.prefix}
          type="button"
          className="file-pfx"
          data-prefix={p.token}
          title={p.prefix === 'da' ? DATE_FORMS_HELP : `${p.token} ${p.hint}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(p.token)}
        >
          <b>{p.token}</b> {p.hint}
        </button>
      ))}
    </div>
  )
}

/** L4: what the box offers; the first folder row says "N files", the rest the bare count. */
export function CompletionPop({ completion, active, onPick, onHover }: {
  completion: Completion
  active: number
  onPick: (index: number) => void
  onHover: (index: number) => void
}): JSX.Element {
  // Only a pointer that really moves picks a row: the list appearing under a resting pointer
  // (after a hint click) must not move the highlight away from the first offer.
  const lastPointer = useRef<string | null>(null)
  const moved = (e: React.MouseEvent): boolean => {
    const at = `${e.screenX},${e.screenY}`
    const was = lastPointer.current
    lastPointer.current = at
    return was != null && was !== at
  }
  return (
    <div className="file-cpl" role="listbox" aria-label={completion.heading}>
      <div className="file-cpl-h">{completion.heading}</div>
      {completion.items.map((item, i) => (
        <div
          key={item.key}
          role="option"
          aria-selected={i === active}
          className={`file-cpl-o${i === active ? ' is-on' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); onPick(i) }}
          onMouseMove={(e) => { if (moved(e)) onHover(i) }}
        >
          <span>{item.label}</span>
          <i>{item.kind === 'folder' ? (i === 0 ? `${item.count} ${item.count === 1 ? 'file' : 'files'}` : item.count) : item.hint}</i>
        </div>
      ))}
      <div className="file-cpl-f">↵ or Tab completes</div>
    </div>
  )
}

export interface SearchAssist {
  folders: FileFolderCount[]
  hintVisible: boolean
  completion: Completion | null
  active: number
  setActive: (index: number) => void
  pick: (index: number) => void
  pickHint: (prefix: string) => void
  /** Set the query from elsewhere (a no-results suggestion): caret at the end, box focused. */
  replaceQuery: (query: string) => void
  /** The box's own handlers. */
  onChange: (value: string, caret?: number | null) => void
  onFocus: () => void
  onBlur: () => void
  onSelect: (caret: number | null) => void
  /** Completion keys (↑ ↓ move, ↵ or Tab complete, Esc dismisses). True when it used the key. */
  onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => boolean
}

export function useSearchAssist({ query, setQuery, searchRef, folderListing }: {
  query: string
  setQuery: (value: string) => void
  searchRef: RefObject<HTMLInputElement>
  /** Changes when the vault's file list does: the folder list is re-read. */
  folderListing: FileFolderCount[]
}): SearchAssist {
  const [focused, setFocused] = useState(false)
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  // Esc hides the offer for this exact query; typing brings it back.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  const [folders, setFolders] = useState<FileFolderCount[]>([])
  const pendingCaret = useRef<number | null>(null)
  // The hint row and the list sit in the panel's flow: if they left at the mousedown that blurs
  // the box, the tree would move up under the pointer before the click landed. A blur that a
  // press causes hides them once that press's click is done.
  const pointerDown = useRef(false)
  useEffect(() => {
    const down = (): void => { pointerDown.current = true }
    const up = (): void => { pointerDown.current = false }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', up, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', up, true)
    }
  }, [])
  const focusedRef = useRef(false)

  useEffect(() => { setFolders(folderListing) }, [folderListing])

  // A completion sets the caret after React has written the new value into the box.
  useLayoutEffect(() => {
    const input = searchRef.current
    if (pendingCaret.current == null || !input) return
    const at = pendingCaret.current
    pendingCaret.current = null
    input.setSelectionRange(at, at)
  })

  const completion = useMemo(
    () => (focused && dismissedFor !== query ? completionAt(query, Math.min(caret, query.length), folders) : null),
    [focused, dismissedFor, query, caret, folders]
  )
  const completionKey = completion ? `${completion.start}:${completion.items.map((i) => i.key).join('|')}` : ''
  useEffect(() => { setActive(0) }, [completionKey])

  function commit(edit: QueryEdit): void {
    pendingCaret.current = edit.caret
    setCaret(edit.caret)
    setDismissedFor(null)
    setQuery(edit.query)
  }
  function pick(index: number): void {
    const item = completion?.items[index]
    if (completion && item) commit(applyCompletion(query, completion, item))
  }

  return {
    folders,
    hintVisible: focused && query === '',
    completion,
    active,
    setActive,
    pick,
    pickHint: (prefix) => commit(insertPrefix(query, caret, prefix)),
    replaceQuery: (next) => {
      commit({ query: next, caret: next.length })
      searchRef.current?.focus()
    },
    onChange: (value, at) => {
      setCaret(at ?? value.length)
      setDismissedFor(null)
      setQuery(value)
    },
    onFocus: () => { focusedRef.current = true; setFocused(true) },
    onBlur: () => {
      focusedRef.current = false
      const hide = (): void => { if (!focusedRef.current) setFocused(false) }
      if (!pointerDown.current) { hide(); return }
      const later = (): void => { window.removeEventListener('pointerup', later, true); window.setTimeout(hide, 0) }
      window.addEventListener('pointerup', later, true)
    },
    onSelect: (at) => { if (at != null) setCaret(at) },
    onKeyDown: (e) => {
      if (!completion || e.nativeEvent.isComposing) return false
      const n = completion.items.length
      if (e.key === 'ArrowDown') setActive((a) => (a + 1) % n)
      else if (e.key === 'ArrowUp') setActive((a) => (a - 1 + n) % n)
      else if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) pick(Math.min(active, n - 1))
      else if (e.key === 'Escape') setDismissedFor(query)
      else return false
      commandRan(e.key === 'ArrowDown' || e.key === 'ArrowUp' ? 'sheet.FileSearch.0' : 'sheet.FileSearch.1')
      e.preventDefault()
      e.stopPropagation()
      return true
    }
  }
}

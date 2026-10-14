import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { AGENT_ICON, AGENT_ICON_CLASS } from './agent-icon'

export type FileMenuItem =
  | { sep: true }
  /** `icon` fills the row's leading slot, before the label; rows without one render as before. */
  | { id: string; label: string; kbd?: string; sublabel?: string; danger?: boolean; icon?: LucideIcon }

type ActionItem = Exclude<FileMenuItem, { sep: true }>
const actions = (items: FileMenuItem[]): ActionItem[] => items.filter((it): it is ActionItem => !('sep' in it))

/** Viewport-clamped fixed positioning for the sidebar's anchored surfaces (menu / picker / popover).
 *  `window` is absent under server rendering (the render-lock tests) — clamping is browser-only. */
function clampedStyle(x: number, y: number, width: number): React.CSSProperties {
  if (typeof window === 'undefined') return { left: x, top: y }
  return {
    left: Math.min(x, window.innerWidth - width - 12),
    top: Math.min(y, window.innerHeight - 320),
  }
}

/**
 * The Quiet Menu (ADR-0017): one anchored, keyboard-first menu for a file/folder row. Focus lands on
 * the menu at open (↑↓ wrap, ↵ fires, Esc dismisses and the caller restores row focus); hover hands
 * the highlight to the mouse. Items carry their shortcut labels — advertised, not hidden.
 */
export function FileRowMenu({
  x,
  y,
  items,
  onAction,
  onClose,
}: {
  x: number
  y: number
  items: FileMenuItem[]
  onAction: (id: string) => void
  onClose: () => void
}): JSX.Element {
  const [hi, setHi] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const acts = actions(items)
  useEffect(() => {
    rootRef.current?.focus()
  }, [])
  // A long menu (the outline's has sixteen rows) must never run off the bottom of the window: measure it
  // and slide it up so every row, including the last, is on screen and clickable.
  const [lift, setLift] = useState<number | null>(null)
  useLayoutEffect(() => {
    const box = rootRef.current?.getBoundingClientRect()
    if (!box) return
    const overflow = box.bottom - (window.innerHeight - 8)
    if (overflow > 0) setLift(Math.max(8, box.top - overflow))
  }, [])

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      setHi((h) => (h + 1) % acts.length)
    } else if (e.key === 'ArrowUp') {
      setHi((h) => (h - 1 + acts.length) % acts.length)
    } else if (e.key === 'Enter') {
      onAction(acts[hi]!.id)
    } else if (e.key === 'Escape') {
      onClose()
    } else {
      return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  let actionIndex = -1
  return (
    <div
      ref={rootRef}
      className="fm-menu"
      role="menu"
      tabIndex={-1}
      style={{ ...clampedStyle(x, y, 200), ...(lift === null ? {} : { top: lift }) }}
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget as Node)) onClose()
      }}
    >
      {items.map((it, i) => {
        if ('sep' in it) return <hr key={`sep-${i}`} />
        actionIndex += 1
        const idx = actionIndex
        return (
          <div
            key={it.id}
            role="menuitem"
            className={`fm-item${it.danger ? ' danger' : ''}${idx === hi ? ' hi' : ''}`}
            onMouseEnter={() => setHi(idx)}
            onMouseDown={(e) => {
              e.preventDefault()
              onAction(it.id)
            }}
          >
            {it.icon && <it.icon className={`icon sm${it.icon === AGENT_ICON ? ` ${AGENT_ICON_CLASS}` : ''}`} aria-hidden="true" />}
            <span className="grow">{it.label}</span>
            {it.kbd && <kbd>{it.kbd}</kbd>}
          </div>
        )
      })}
    </div>
  )
}

/** The Move-to-folder picker (M): the same anchored surface listing folders + the workspace root. */
export function MoveFolderPicker({
  x,
  y,
  fileName,
  options,
  onPick,
  onClose,
}: {
  x: number
  y: number
  fileName: string
  options: Array<{ label: string; dir: string | null }>
  onPick: (dir: string | null) => void
  onClose: () => void
}): JSX.Element {
  const [hi, setHi] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'ArrowDown') setHi((h) => (h + 1) % options.length)
    else if (e.key === 'ArrowUp') setHi((h) => (h - 1 + options.length) % options.length)
    else if (e.key === 'Enter') onPick(options[hi]!.dir)
    else if (e.key === 'Escape') onClose()
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div
      ref={rootRef}
      className="fm-menu"
      role="menu"
      tabIndex={-1}
      style={clampedStyle(x, y, 200)}
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget as Node)) onClose()
      }}
      aria-label={`Move ${fileName} to folder`}
    >
      <div className="fm-item head">MOVE “{fileName}” TO</div>
      {options.map((opt, i) => (
        <div
          key={opt.dir ?? '__root__'}
          role="menuitem"
          className={`fm-item${i === hi ? ' hi' : ''}`}
          onMouseEnter={() => setHi(i)}
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(opt.dir)
          }}
        >
          <span className="grow">{opt.label}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * The Bin confirmation popover (ADR-0017): anchored to the row, defaulting focus on the destructive
 * button (↵ confirms, Esc backs out) — and always saying the recovery path out loud.
 */
export function BinPopover({
  x,
  y,
  name,
  fileCount,
  onConfirm,
  onCancel,
}: {
  x: number
  y: number
  name: string
  /** For folders: how many files ride along. Undefined for a single file. */
  fileCount?: number
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element {
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    confirmRef.current?.focus()
  }, [])

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    }
  }

  return (
    <div className="fm-pop" role="alertdialog" aria-label={`Move ${name} to the Bin?`} style={clampedStyle(x, y, 230)} onKeyDown={onKeyDown}>
      <div>
        Move <b>{name}</b>
        {fileCount !== undefined ? ` and its ${fileCount} file${fileCount === 1 ? '' : 's'}` : ''} to the Bin?
        <br />
        <span className="fm-dim">Recoverable from Finder.</span>
      </div>
      <div className="fm-btns">
        <button type="button" className="fm-btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          ref={confirmRef}
          type="button"
          className="fm-btn danger"
          onClick={onConfirm}
          onBlur={(e) => {
            const pop = (e.currentTarget as HTMLElement).closest('.fm-pop')
            if (pop && !pop.contains(e.relatedTarget as Node)) onCancel()
          }}
        >
          Move to Bin
        </button>
      </div>
    </div>
  )
}

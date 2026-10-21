import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  ArrowRightToLine, Bot, Check, CheckCheck, ChevronDown, ChevronRight, ChevronUp, Clock, Eye, Link2, ListFilter, PanelRight, PanelRightClose,
  Pencil, RotateCcw, GitCommitHorizontal, Rows3, Send, Terminal, User, Users, X, Hand,
} from 'lucide-react'
import type { CountMenuAction, CountMenuIcon, CountMenuRow } from '../app/margin-count-menu'

const ICONS: Record<CountMenuIcon, typeof Check> = {
  next: ChevronDown, previous: ChevronUp, 'next-piece': ArrowRightToLine, accept: Check, done: CheckCheck, decline: X, 'send-back': Send,
  everyone: Users, agent: Bot, readers: User, link: Link2, outside: Terminal, request: Clock, kind: ListFilter, held: Hand,
  settled: RotateCcw, mine: Pencil, quiet: Eye, margin: PanelRight, under: Rows3, hide: PanelRightClose, version: GitCommitHorizontal,
}

type ItemRow = Extract<CountMenuRow, { kind: 'item' }>

/** One panel of rows. The arrow keys, Home and End move among the enabled rows; Enter or Space picks. */
function Panel({ rows, label, onPick, onOpenSub, onLeave, className }: {
  rows: CountMenuRow[]; label: string; onPick: (action: CountMenuAction) => void; onOpenSub?: (row: ItemRow) => void; onLeave: () => void; className?: string
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const buttons = (): HTMLButtonElement[] => [...(ref.current?.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not([aria-disabled="true"])') ?? [])]
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const items = buttons()
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const go = (next: number): void => { event.preventDefault(); event.stopPropagation(); items[(next + items.length) % items.length]?.focus() }
    if (event.key === 'ArrowDown') go(at + 1)
    else if (event.key === 'ArrowUp') go(at === -1 ? items.length - 1 : at - 1)
    else if (event.key === 'Home') go(0)
    else if (event.key === 'End') go(items.length - 1)
    else if (event.key === 'ArrowRight' && at !== -1 && items[at].hasAttribute('aria-haspopup')) { event.preventDefault(); event.stopPropagation(); items[at].click() }
    else if (event.key === 'ArrowLeft' && onOpenSub === undefined) { event.preventDefault(); event.stopPropagation(); onLeave() }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onLeave() }
  }
  return (
    <div ref={ref} className={`rcm ${className ?? ''}`} role="menu" aria-label={label} onKeyDown={onKeyDown} data-testid={className === 'rcm-sub' ? 'review-count-submenu' : 'review-count-menu'}>
      {rows.map((row, index) => {
        if (row.kind === 'separator') return <div key={`s${index}`} className="rcm-sep" role="separator" />
        if (row.kind === 'heading') return <div key={`h${index}`} className="rcm-h" role="presentation">{row.label}</div>
        const Icon = row.icon ? ICONS[row.icon] : null
        const check = row.checked === true
        return (
          <button
            key={row.id}
            type="button"
            role={row.submenu ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={row.submenu ? undefined : check}
            aria-disabled={!row.enabled || undefined}
            aria-haspopup={row.submenu ? 'menu' : undefined}
            data-menu-id={row.id}
            data-checked={check || undefined}
            className={`rcm-row${row.nested ? ' nested' : ''}`}
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (!row.enabled) return
              if (row.submenu) { onOpenSub?.(row); return }
              if (row.action) onPick(row.action)
            }}
          >
            <span className="rcm-lead">{check && !row.submenu ? <Check className="icon" aria-hidden="true" /> : Icon ? <Icon className="icon" aria-hidden="true" /> : null}</span>
            <span className="rcm-label">{row.label}{row.reason && <small className="rcm-reason">{row.reason}</small>}</span>
            {row.shortcut && <kbd className="rcm-kbd">{row.shortcut}</kbd>}
            {row.count !== undefined && <span className="rcm-n">{row.count}</span>}
            {row.submenu && <ChevronRight className="icon chev" aria-hidden="true" />}
          </button>
        )
      })}
    </div>
  )
}

/**
 * The popover the count in the status bar's review line opens (frames `filter-who`, `narrow-1000`, `component-sheet`).
 * It draws the rows `countMenu()` gives; picking one runs its action and closes the menu. Escape, a click away or a pick
 * closes it and hands the focus back to the editor.
 */
export function ReviewCountMenu({ rows, onPick, onClose }: { rows: CountMenuRow[]; onPick: (action: CountMenuAction) => void; onClose: () => void }): JSX.Element {
  const [sub, setSub] = useState<ItemRow | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const first = rootRef.current?.querySelector<HTMLButtonElement>('button[role^="menuitem"]:not([aria-disabled="true"])')
    first?.focus()
    const away = (event: MouseEvent): void => { if (!rootRef.current?.contains(event.target as Node) && !(event.target as HTMLElement).closest('[data-testid="status-review-count"]')) onClose() }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [onClose])
  // The submenu's own panel takes the focus when it opens; closing it returns to its row.
  useEffect(() => {
    if (!sub) return
    rootRef.current?.querySelector<HTMLButtonElement>('.rcm-sub button[role^="menuitem"]:not([aria-disabled="true"])')?.focus()
  }, [sub])
  const closeSub = (): void => {
    const id = sub?.id
    setSub(null)
    if (id) requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>(`[data-menu-id="${id}"]`)?.focus())
  }
  const live = sub ? rows.flatMap((row) => (row.kind === 'item' && row.id === sub.id ? [row] : []))[0] ?? sub : null
  return (
    <div ref={rootRef} className="rcm-wrap" data-review-count-menu>
      <Panel rows={rows} label="Review" onPick={onPick} onOpenSub={(row) => setSub(row)} onLeave={onClose} />
      {live?.submenu && <Panel rows={live.submenu} label={live.label} className="rcm-sub" onPick={onPick} onLeave={closeSub} />}
    </div>
  )
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, FolderOpen, Library } from 'lucide-react'
import { worksText, type SwitcherList } from '../../../shared/vault-switcher'

/**
 * The vault switcher (vaults ticket 06, locked frame `locked-vault-sidebar-vault-switcher-menu`): opened
 * from the sidebar's root name or the palette's `Switch vault…`. `Vaults` (tick on this window's root,
 * work count), `Folders` (parent path), then `Open folder…` and `Make this folder a vault…` (greyed with
 * "already a vault" on a vault). `Vault settings…` waits for Vault settings (spec build-time notes).
 *
 * Keyboard: focus lands on the menu; ↑/↓ move over the items that can be chosen, ↵ chooses, Esc closes,
 * and typing selects the first item whose name starts with what was typed (then one that contains it).
 */

export type SwitcherChoice =
  | { kind: 'root'; root: string; current: boolean }
  | { kind: 'open-folder' }
  | { kind: 'make-vault' }

type Row =
  | { kind: 'head'; key: string; label: string }
  | { kind: 'sep'; key: string }
  | { kind: 'item'; key: string; label: string; small?: string; tick?: boolean; icon?: 'open' | 'make'; off?: boolean; choice: SwitcherChoice }

/** The menu's rows for a list (null while it loads: the two actions only). Pure, for the render test. */
export function switcherRows(list: SwitcherList | null, currentIsVault: boolean): Row[] {
  const rows: Row[] = []
  if (list && list.vaults.length > 0) {
    rows.push({ kind: 'head', key: 'h-vaults', label: 'Vaults' })
    for (const vault of list.vaults) {
      rows.push({ kind: 'item', key: `v:${vault.root}`, label: vault.name, small: worksText(vault.works), tick: vault.current, choice: { kind: 'root', root: vault.root, current: vault.current } })
    }
  }
  if (list && list.folders.length > 0) {
    if (rows.length > 0) rows.push({ kind: 'sep', key: 's-folders' })
    rows.push({ kind: 'head', key: 'h-folders', label: 'Folders' })
    for (const folder of list.folders) {
      rows.push({ kind: 'item', key: `f:${folder.root}`, label: folder.name, small: folder.parent, tick: folder.current, choice: { kind: 'root', root: folder.root, current: folder.current } })
    }
  }
  if (rows.length > 0) rows.push({ kind: 'sep', key: 's-actions' })
  const isVault = list ? list.currentIsVault : currentIsVault
  rows.push({ kind: 'item', key: 'open-folder', label: 'Open folder…', icon: 'open', choice: { kind: 'open-folder' } })
  rows.push({ kind: 'item', key: 'make-vault', label: 'Make this folder a vault…', icon: 'make', off: isVault, ...(isVault ? { small: 'already a vault' } : {}), choice: { kind: 'make-vault' } })
  return rows
}

const TYPEAHEAD_MS = 700

export function VaultSwitcherMenu({
  x,
  y,
  currentIsVault,
  onChoose,
  onClose,
  load = () => window.writeflex.getSwitcherList(),
  initialList = null,
}: {
  x: number
  y: number
  /** What the window knows before the list arrives (greys Make at once on a vault). */
  currentIsVault: boolean
  onChoose: (choice: SwitcherChoice) => void
  /** Esc, a click elsewhere or Tab: the caller puts the focus back on the root name. */
  onClose: () => void
  load?: () => Promise<SwitcherList>
  /** A list already in hand (the render test); the menu still reads a fresh one as it opens. */
  initialList?: SwitcherList | null
}): JSX.Element {
  const [list, setList] = useState<SwitcherList | null>(initialList)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const typed = useRef<{ text: string; at: number }>({ text: '', at: 0 })
  // Asked once per opening: the menu is short-lived and each opening reads the folders afresh.
  const loadOnce = useRef(load)
  useEffect(() => {
    let live = true
    void loadOnce.current().then((next) => { if (live) setList(next) }, () => undefined)
    return () => { live = false }
  }, [])
  useEffect(() => { rootRef.current?.focus() }, [])

  const rows = useMemo(() => switcherRows(list, currentIsVault), [list, currentIsVault])
  const choosable = rows.filter((row): row is Extract<Row, { kind: 'item' }> => row.kind === 'item' && !row.off)
  // The first highlight: the first root that is not this window's own (the likely next place), else the first item.
  const [hi, setHi] = useState<string | null>(null)
  const initial = choosable.find((row) => row.choice.kind === 'root' && !row.choice.current) ?? choosable[0]
  const hiKey = hi !== null && choosable.some((row) => row.key === hi) ? hi : initial?.key ?? null

  // A long list must not run off the bottom of the window.
  const [lift, setLift] = useState<number | null>(null)
  useLayoutEffect(() => {
    const box = rootRef.current?.getBoundingClientRect()
    if (!box) return
    const overflow = box.bottom - (window.innerHeight - 8)
    setLift(overflow > 0 ? Math.max(8, box.top - overflow) : null)
  }, [rows.length])

  function move(step: number): void {
    if (choosable.length === 0) return
    const at = choosable.findIndex((row) => row.key === hiKey)
    const next = at === -1 ? 0 : (at + step + choosable.length) % choosable.length
    setHi(choosable[next]!.key)
  }

  function typeahead(key: string): void {
    const now = Date.now()
    const text = (now - typed.current.at < TYPEAHEAD_MS ? typed.current.text : '') + key.toLowerCase()
    typed.current = { text, at: now }
    const named = choosable.filter((row) => row.choice.kind === 'root')
    const match = named.find((row) => row.label.toLowerCase().startsWith(text))
      ?? named.find((row) => row.label.toLowerCase().includes(text))
      ?? choosable.find((row) => row.label.toLowerCase().startsWith(text))
    if (match) setHi(match.key)
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'ArrowDown') move(1)
    else if (e.key === 'ArrowUp') move(-1)
    else if (e.key === 'Home') setHi(choosable[0]?.key ?? null)
    else if (e.key === 'End') setHi(choosable.at(-1)?.key ?? null)
    else if (e.key === 'Enter') {
      const row = choosable.find((candidate) => candidate.key === hiKey)
      if (row) onChoose(row.choice)
    } else if (e.key === 'Escape' || e.key === 'Tab') onClose()
    else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) typeahead(e.key)
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div
      ref={rootRef}
      className="fm-menu vsw-menu"
      role="menu"
      aria-label="Switch vault or open a folder"
      data-testid="vault-switcher"
      tabIndex={-1}
      style={{ left: typeof window === 'undefined' ? x : Math.max(8, Math.min(x, window.innerWidth - 312)), top: lift ?? y }}
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget as Node)) onClose()
      }}
    >
      {rows.map((row) => {
        if (row.kind === 'sep') return <hr key={row.key} />
        if (row.kind === 'head') return <div key={row.key} className="fm-item head" role="presentation">{row.label}</div>
        const Icon = row.icon === 'open' ? FolderOpen : row.icon === 'make' ? Library : null
        return (
          <div
            key={row.key}
            role={row.choice.kind === 'root' ? 'menuitemradio' : 'menuitem'}
            {...(row.choice.kind === 'root' ? { 'aria-checked': row.tick === true } : {})}
            aria-disabled={row.off ? true : undefined}
            data-root={row.choice.kind === 'root' ? row.choice.root : undefined}
            className={`fm-item${row.key === hiKey ? ' hi' : ''}${row.off ? ' off' : ''}`}
            onMouseEnter={() => { if (!row.off) setHi(row.key) }}
            onMouseDown={(e) => {
              e.preventDefault()
              if (!row.off) onChoose(row.choice)
            }}
          >
            {Icon
              ? <Icon className="icon sm" aria-hidden="true" />
              : <span className="tick" aria-hidden="true">{row.tick ? <Check className="icon sm" /> : null}</span>}
            <span className="grow">{row.label}</span>
            {row.small && <small>{row.small}</small>}
          </div>
        )
      })}
    </div>
  )
}

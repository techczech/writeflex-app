import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Bot, Compass, Ellipsis, GitCommitHorizontal, StickyNote, type LucideIcon } from 'lucide-react'
import { fitPaneTabs, type RightPaneTab } from '../app/pane-layout'
import { AGENT_ICON } from './agent-icon'

type TabSpec = { id: RightPaneTab; label: string; icon: LucideIcon; chord?: string; keys?: string }

/** Last in the row, and only while the person has opened it (the title-bar Guide button). */
const GUIDE_TAB: TabSpec = { id: 'guide', label: 'Guide', icon: Compass }
const BASE_TABS: readonly TabSpec[] = [
  { id: 'agent', label: 'Agent', icon: AGENT_ICON, chord: '⌘J', keys: 'Meta+J' },
  { id: 'scratchpad', label: 'Scratchpad', icon: StickyNote },
  { id: 'agent-notes', label: 'Agent notes', icon: Bot },
  { id: 'versions', label: 'Versions', icon: GitCommitHorizontal, chord: '⌘3', keys: 'Meta+3' },
]
const SPEC = new Map([GUIDE_TAB, ...BASE_TABS].map((tab) => [tab.id, tab]))

/** What the fit is computed from, all read from the real layout. */
type RowMetrics = { widths: number[]; available: number; gap: number; more: number }

const sameMetrics = (a: RowMetrics | null, b: RowMetrics): boolean =>
  !!a && a.available === b.available && a.gap === b.gap && a.more === b.more && a.widths.every((width, index) => width === b.widths[index])

/** Measuring must run before paint in the app, and not at all when the row is rendered to static markup. */
const useLayoutEffectWhenPainted = typeof window === 'undefined' ? useEffect : useLayoutEffect

type RightPaneTabsProps = {
  active: RightPaneTab
  onSelect: (tab: RightPaneTab) => void
  /** The Guide tab is open: it is last in the row. */
  guideShown?: boolean
}

/**
 * The right pane's tab row, on the locked pane-tab geometry (ADR-0026, chrome-mockup-v3): 12px icon,
 * 4px padding, and the chord hidden at rest (`.pchord`, zero width until hover) — the same tabs as
 * the left pane's row.
 *
 * Five labelled tabs are wider than the pane's default 340px, so what does not fit goes under a "…"
 * at the row's right end (ticket 07, option D): the tabs that fit stay, the active tab always stays
 * (taking the place of the last tab that fits), and the row never scrolls. `fitPaneTabs` decides;
 * this component only measures. Widths come from a hidden copy of every tab, because a tab already
 * in the menu is not in the row to measure, and resizing the pane re-fits live.
 *
 * The "…" is a button in the row: ↵ or Space opens its menu with the first hidden tab focused, ↑/↓
 * move, ↵ activates, Esc closes back to the "…". Chords and ⌃⌘Tab never pass through this row, so
 * they reach hidden tabs as they reach the rest — and the tab they activate enters the row.
 */
export function RightPaneTabs({ active, onSelect, guideShown = false }: RightPaneTabsProps): JSX.Element {
  const TABS = useMemo<readonly TabSpec[]>(() => (guideShown ? [...BASE_TABS, GUIDE_TAB] : BASE_TABS), [guideShown])
  const rowRef = useRef<HTMLDivElement | null>(null)
  const measureRef = useRef<HTMLDivElement | null>(null)
  const moreRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [metrics, setMetrics] = useState<RowMetrics | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)

  useLayoutEffectWhenPainted(() => {
    const row = rowRef.current
    const measure = measureRef.current
    if (!row || !measure) return
    const remeasure = (): void => {
      const style = getComputedStyle(row)
      const next: RowMetrics = {
        widths: [...measure.querySelectorAll<HTMLElement>('[data-measure-tab]')].map((node) => node.getBoundingClientRect().width),
        available: row.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0'),
        gap: parseFloat(style.columnGap) || 0,
        more: measure.querySelector<HTMLElement>('[data-measure-more]')?.getBoundingClientRect().width ?? 0,
      }
      setMetrics((previous) => (sameMetrics(previous, next) ? previous : next))
    }
    remeasure()
    if (typeof ResizeObserver === 'undefined') return
    // The row resizes with the pane; the hidden copy resizes when the tab font finishes loading.
    const observer = new ResizeObserver(remeasure)
    observer.observe(row)
    observer.observe(measure)
    return () => observer.disconnect()
  }, [TABS])

  const fit = useMemo(
    () =>
      metrics
        ? fitPaneTabs({ tabs: TABS.map((tab, index) => ({ id: tab.id, width: metrics.widths[index] ?? 0 })), ...metrics, active })
        : { row: TABS.map((tab) => tab.id), menu: [] },
    [metrics, active, TABS],
  )
  const hidden = fit.menu.length > 0
  const open = menuOpen && hidden

  const placeMenu = (): void => {
    const more = moreRef.current
    if (!more) return
    const rect = more.getBoundingClientRect()
    const next = { top: rect.bottom + 2, right: document.documentElement.clientWidth - rect.right }
    setAnchor((previous) => (previous && previous.top === next.top && previous.right === next.right ? previous : next))
  }

  // The "…" moves when the pane is resized or the window changes; the open menu follows it.
  useLayoutEffectWhenPainted(() => {
    if (open) placeMenu()
  }, [open, metrics, fit])

  useEffect(() => {
    if (menuOpen && !hidden) setMenuOpen(false)
  }, [menuOpen, hidden])

  useEffect(() => {
    if (!open) return
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus())
    const outside = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !moreRef.current?.contains(target)) setMenuOpen(false)
    }
    window.addEventListener('pointerdown', outside, true)
    return () => window.removeEventListener('pointerdown', outside, true)
  }, [open])

  const toggleMenu = (): void => {
    if (!menuOpen) placeMenu()
    setMenuOpen(!menuOpen)
  }

  const choose = (tab: RightPaneTab): void => {
    setMenuOpen(false)
    onSelect(tab)
    // The menu the focus was in is gone. Where opening the tab focused something of its own (the
    // composer, the scratchpad) that stays; otherwise focus lands on the tab, now in the row.
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return
      rowRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus()
    })
  }

  const onMenuKeyDown = (event: React.KeyboardEvent): void => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
    if (items.length === 0) return
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'ArrowDown') items[(at + 1) % items.length].focus()
    else if (event.key === 'ArrowUp') items[at <= 0 ? items.length - 1 : at - 1].focus()
    else if (event.key === 'Home') items[0].focus()
    else if (event.key === 'End') items[items.length - 1].focus()
    else if (event.key === 'Escape') {
      setMenuOpen(false)
      moreRef.current?.focus()
    } else return
    event.preventDefault()
    event.stopPropagation()
  }

  const tabContent = ({ label, icon: Icon, chord }: TabSpec): JSX.Element => (
    <>
      <Icon className="icon i sm" aria-hidden="true" />
      {label}
      {chord && <> <span className="pchord" aria-hidden="true">{chord}</span></>}
    </>
  )

  return (
    <>
      {/* data-fit-width: the row width the current fit was made for — what a layout test waits on. */}
      <div className="pane-tabs" role="tablist" aria-label="Right pane tabs" ref={rowRef} data-fit-width={metrics?.available}>
        {fit.row.map((id) => {
          const spec = SPEC.get(id)!
          return (
            <button
              key={id}
              type="button"
              className={active === id ? 'pane-tab on' : 'pane-tab'}
              role="tab"
              aria-selected={active === id}
              onClick={() => onSelect(id)}
              title={spec.chord ? `${spec.label} (${spec.chord})` : spec.label}
              aria-keyshortcuts={spec.keys}
            >
              {tabContent(spec)}
            </button>
          )
        })}
        {hidden && (
          <button
            type="button"
            ref={moreRef}
            className="pane-tab more"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label="More tabs"
            title="More tabs"
            onClick={toggleMenu}
          >
            <Ellipsis className="icon i sm" aria-hidden="true" />
          </button>
        )}
      </div>

      {open && anchor && (
        <div
          className="abmenu pane-tabs-menu"
          role="menu"
          aria-label="More tabs"
          ref={menuRef}
          style={{ top: anchor.top, right: anchor.right }}
          onKeyDown={onMenuKeyDown}
          onBlur={(event) => {
            const next = event.relatedTarget as Node | null
            if (next && (menuRef.current?.contains(next) || moreRef.current?.contains(next))) return
            setMenuOpen(false)
          }}
        >
          {fit.menu.map((id) => {
            const { label, icon: Icon, keys } = SPEC.get(id)!
            return (
              <button type="button" role="menuitem" key={id} data-tab={id} aria-keyshortcuts={keys} onClick={() => choose(id)}>
                <Icon className="icon sm" aria-hidden="true" />
                <span className="lb">{label}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* Natural widths at rest, off screen: what the fit measures never changes as tabs move. */}
      <div className="pane-tabs-measure" ref={measureRef} aria-hidden="true">
        {TABS.map((spec) => (
          <span className="pane-tab-measure" key={spec.id} data-measure-tab={spec.id}>
            {tabContent(spec)}
          </span>
        ))}
        <span className="pane-tab-measure" data-measure-more>
          <Ellipsis className="icon i sm" />
        </span>
      </div>
    </>
  )
}

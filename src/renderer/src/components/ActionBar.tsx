import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, Ellipsis, SlidersHorizontal } from 'lucide-react'
import type { ActionBarGroup } from './action-bar-commands'
import { planGroupOverflow } from './action-bar-overflow'

export type ActionBarProps = {
  /** The bar's groups, already resolved against the commands this window can run. */
  groups: ActionBarGroup[]
  /**
   * Open the configure sheet (Settings → Action bar). Ticket A2 owns that sheet; until it exists
   * the control is absent rather than dead — the bar never carries a button that cannot act.
   */
  onConfigure?: () => void
}

/**
 * The action bar (ADR-0040): one 30px pane-coloured row directly below the 44px ADR-0026 toolbar.
 *
 * The toolbar is untouched and the tab strip never moves — showing or hiding this row shifts only
 * the paper. Hidden, the bar is NOT RENDERED AT ALL: no lip, no hairline, no reserved height, so
 * the hidden state is pixel-identical to the app before the bar existed. The only way back in is
 * the toolbar's panel-top toggle and its command; there is deliberately no fold chevron here.
 */
/** The measuring effect must run before paint in the app, and simply not at all when a test renders
 *  the bar to static markup — where there is no layout to measure and React warns about it. */
const useLayoutEffectWhenPainted = typeof window === 'undefined' ? useEffect : useLayoutEffect

export function ActionBar({ groups, onConfigure }: ActionBarProps): JSX.Element {
  const barRef = useRef<HTMLDivElement | null>(null)
  const measureRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const overflowButtonRef = useRef<HTMLButtonElement | null>(null)
  const [visibleGroups, setVisibleGroups] = useState(groups.length)
  const [menuOpen, setMenuOpen] = useState(false)
  // A button's ▾ menu (the list button's List type choices): which one is open, and where.
  const [choices, setChoices] = useState<{ commandId: string; left: number } | null>(null)
  const choicesRef = useRef<HTMLDivElement | null>(null)
  const choicesButtonRef = useRef<HTMLButtonElement | null>(null)

  // Widths come from a hidden copy of every group, measured in the real layout: a group already
  // moved into the … menu is not on screen to measure, so measuring the live row would ratchet.
  useLayoutEffectWhenPainted(() => {
    const bar = barRef.current
    const measure = measureRef.current
    if (!bar || !measure) return
    const replan = (): void => {
      const rows = [...measure.querySelectorAll<HTMLElement>('[data-measure-group]')]
      if (rows.length === 0) return
      // Positions, not element widths: the distance from the first group's left edge to the nth
      // group's right edge already contains every gap and separator margin between them.
      const left = rows[0].getBoundingClientRect().left
      const prefixWidths = rows.map((node) => node.getBoundingClientRect().right - left)
      const lastRight = prefixWidths[prefixWidths.length - 1] + left
      const overflowRight = measure.querySelector<HTMLElement>('[data-measure-overflow]')?.getBoundingClientRect().right ?? lastRight
      const tailRight = measure.querySelector<HTMLElement>('[data-measure-tail]')?.getBoundingClientRect().right ?? overflowRight
      const style = getComputedStyle(bar)
      const available = bar.getBoundingClientRect().width - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0')
      setVisibleGroups(planGroupOverflow({
        available,
        prefixWidths,
        overflowChunk: overflowRight - lastRight,
        tailChunk: tailRight - overflowRight,
      }).visible)
    }
    replan()
    const observer = new ResizeObserver(replan)
    observer.observe(bar)
    return () => observer.disconnect()
  }, [groups])

  const shown = groups.slice(0, visibleGroups)
  const overflowed = groups.slice(visibleGroups)

  useEffect(() => {
    if (overflowed.length === 0 && menuOpen) setMenuOpen(false)
  }, [menuOpen, overflowed.length])

  useEffect(() => {
    if (!menuOpen) return
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus())
    const outside = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node) && !overflowButtonRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('pointerdown', outside, true)
    return () => window.removeEventListener('pointerdown', outside, true)
  }, [menuOpen])

  useEffect(() => {
    if (!choices) return
    requestAnimationFrame(() => choicesRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus())
    const outside = (event: PointerEvent): void => {
      if (!choicesRef.current?.contains(event.target as Node) && !choicesButtonRef.current?.contains(event.target as Node)) setChoices(null)
    }
    window.addEventListener('pointerdown', outside, true)
    return () => window.removeEventListener('pointerdown', outside, true)
  }, [choices])

  /**
   * A TOOLBAR BUTTON DOES NOT TAKE THE CARET. Preventing the default on mousedown is the
   * conventional toolbar behaviour and it is load-bearing here: without it the press moved DOM
   * focus onto the button, and the live pass of 2026-09-12 measured the consequence — press Bullet
   * list from the bar, keep typing, and the letters went nowhere at all. Click still fires; only
   * the focus move is cancelled.
   *
   * It is NOT what made a bar-inserted table cost two undos — a capturing document-level mousedown
   * listener is what commits an open object editor, and preventDefault does not stop a listener.
   * That one is fixed where it lives, in the object editor's shell.
   */
  const keepCaret = (event: { preventDefault: () => void }): void => event.preventDefault()

  const button = (item: ActionBarGroup['items'][number]): JSX.Element => (
    <Fragment key={item.commandId}>
      <button
        type="button"
        className="ab"
        data-command={item.commandId}
        disabled={item.dimmed}
        title={item.keys ? `${item.label} (${item.keys})` : item.label}
        aria-label={item.label}
        onMouseDown={keepCaret}
        onClick={item.run}
      >
        <item.icon className="icon sm" aria-hidden="true" />
      </button>
      {item.menu && (
        <button
          type="button"
          ref={choices?.commandId === item.commandId ? choicesButtonRef : undefined}
          className={`abmore${choices?.commandId === item.commandId ? ' on' : ''}`}
          data-menu-for={item.commandId}
          disabled={item.dimmed}
          aria-haspopup="menu"
          aria-expanded={choices?.commandId === item.commandId}
          title={item.menu.label}
          aria-label={item.menu.label}
          onMouseDown={keepCaret}
          onClick={(event) => {
            if (choices?.commandId === item.commandId) { setChoices(null); return }
            const bar = barRef.current?.getBoundingClientRect()
            const own = event.currentTarget.getBoundingClientRect()
            choicesButtonRef.current = event.currentTarget
            setChoices({ commandId: item.commandId, left: bar ? own.left - bar.left : 0 })
          }}
        >
          <ChevronDown className="icon xs" aria-hidden="true" />
        </button>
      )}
    </Fragment>
  )

  /** A menu row: runs its command and closes whichever menu holds it. */
  const menuRow = (item: ActionBarGroup['items'][number], close: () => void): JSX.Element => (
    <button
      type="button"
      role="menuitem"
      key={item.commandId}
      data-command={item.commandId}
      disabled={item.dimmed}
      onMouseDown={keepCaret}
      onClick={() => {
        close()
        item.run()
      }}
    >
      <item.icon className="icon sm" aria-hidden="true" />
      <span className="lb">{item.label}</span>
      {item.keys && <kbd>{item.keys}</kbd>}
    </button>
  )
  const openChoices = choices ? shown.flatMap((group) => group.items).find((item) => item.commandId === choices.commandId)?.menu : undefined

  return (
    <div className="actionbar" role="toolbar" aria-label="Action bar" ref={barRef}>
      {shown.map((group, index) => (
        <Fragment key={group.id}>
          {index > 0 && <span className="absep" aria-hidden="true" />}
          <div className="grp" data-group={group.id}>{group.items.map(button)}</div>
        </Fragment>
      ))}
      <div className="abtail">
        {overflowed.length > 0 && (
          <>
            <span className="absep" aria-hidden="true" />
            <button
              type="button"
              ref={overflowButtonRef}
              className={`ab${menuOpen ? ' on' : ''}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title="More actions"
              aria-label="More actions"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <Ellipsis className="icon sm" aria-hidden="true" />
            </button>
          </>
        )}
        {onConfigure && (
          <button type="button" className="ab" title="Configure the action bar" aria-label="Configure the action bar" onClick={onConfigure}>
            <SlidersHorizontal className="icon sm" aria-hidden="true" />
          </button>
        )}
      </div>

      {menuOpen && overflowed.length > 0 && (
        <div
          className="abmenu"
          role="menu"
          aria-label="More actions"
          ref={menuRef}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            setMenuOpen(false)
            overflowButtonRef.current?.focus()
          }}
        >
          {overflowed.map((group, index) => (
            <div className="abmenu-grp" key={group.id}>
              {index > 0 && <hr />}
              {group.items.flatMap((item) => [
                menuRow(item, () => setMenuOpen(false)),
                // A folded button's ▾ choices fold with it, listed under it.
                ...(item.menu?.items ?? []).map((choice) => menuRow(choice, () => setMenuOpen(false))),
              ])}
            </div>
          ))}
        </div>
      )}

      {choices && openChoices && (
        <div
          className="abmenu ab-choices"
          role="menu"
          aria-label={openChoices.label}
          ref={choicesRef}
          style={{ left: choices.left, right: 'auto' }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            setChoices(null)
            choicesButtonRef.current?.focus()
          }}
        >
          {openChoices.items.map((item) => menuRow(item, () => setChoices(null)))}
        </div>
      )}

      {/* Natural widths, off screen: what the planner measures never changes as groups move. */}
      <div className="ab-measure" ref={measureRef} aria-hidden="true">
        {groups.map((group, index) => (
          <Fragment key={group.id}>
            {index > 0 && <span className="absep" />}
            <span className="grp" data-measure-group={group.id}>
              {group.items.map((item) => (
                <Fragment key={item.commandId}>
                  <span className="ab">
                    <item.icon className="icon sm" />
                  </span>
                  {item.menu && (
                    <span className="abmore">
                      <ChevronDown className="icon xs" />
                    </span>
                  )}
                </Fragment>
              ))}
            </span>
          </Fragment>
        ))}
        <span className="absep" />
        <span className="ab" data-measure-overflow>
          <Ellipsis className="icon sm" />
        </span>
        <span className="abtail" data-measure-tail>
          {onConfigure && (
            <span className="ab">
              <SlidersHorizontal className="icon sm" />
            </span>
          )}
        </span>
      </div>
    </div>
  )
}

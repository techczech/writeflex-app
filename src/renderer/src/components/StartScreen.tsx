import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, Compass, FolderOpen, GripVertical, Library, PenLine, Pin, Trash2, type LucideIcon } from 'lucide-react'
import type { ExampleCollectionView, PinnedWorkspace, StartScreenModel, StartVault } from '../../../preload'
import { relativeTime } from './relative-time'
import { REMOVE_EXAMPLE_TEXT } from './RemoveExampleConfirm'

export type StartScreenProps = {
  /** Open the folder/file picker (App wires this to workspace:open-dialog + a workspace refresh). */
  onOpen: () => void
  /** Open a recent or pinned Workspace by its stored root (App wires this to workspace:open-recent + refresh). */
  onOpenRecent: (root: string) => void
  /** Open the Guide or the Example collection (App wires this to example:open + a workspace refresh). */
  onOpenExample: (target: ExampleTarget) => void
  /** Open "Remove the example?" (ticket 10). The row names no path; main holds it. */
  onRemoveExample?: () => void
  /** Render seam: the model as already loaded, so the screen can be drawn without the preload bridge. */
  initial?: StartScreenModel
}

export type ExampleTarget = 'guide' | 'collection'

/** Roving-group keys for the two marked entries. Not paths: nothing can open, pin or move them as roots. */
const GUIDE_KEY = 'writeflex:guide'
const EXAMPLE_KEY = 'writeflex:example-collection'

/** The Example collection's second line: where it is and how many lesson files it holds, both read from disk. */
export function exampleLine(example: ExampleCollectionView): string {
  return `${example.location} · ${example.lessonFiles} lesson ${example.lessonFiles === 1 ? 'file' : 'files'}`
}

/** Trailing path segment — the Workspace folder's own name, shown as the row's title. */
function folderName(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.at(-1) ?? path
}

/** Everything above the folder name — the muted second line that disambiguates same-named folders. */
function parentPath(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut > 0 ? path.slice(0, cut) : path
}

type RowMenu = { root: string; x: number; y: number }

/**
 * The pane a window shows with no Workspace open (App renders it when root === null). No v4 mockup
 * frame exists for the bare state; the two-column layout follows the locked Pinned-workspaces design
 * (docs/design/2026-10-06-pinned-workspaces): Pinned on the left in the user's order, Recent on the
 * right newest first, a pinned folder never listed twice. Rows reuse the .rec-row family and the
 * tab context-menu styling.
 *
 * Present rows are one roving-tabindex group, in the order they are drawn: vault cards (Vaults row on
 * top), then pins, then Guide and Example collection, then recents: one row is tab-reachable, arrows
 * move focus, Enter/Space opens, ⌥↑/⌥↓ reorder a pinned row, ⌘1–⌘9 open the first nine pins.
 * A missing pinned folder is a dimmed non-focusable row with Locate… and Unpin buttons.
 *
 * Vaults (locked-vault-start-screen, DTC review 2026-10-16): a pinned or recent root that is a vault is
 * listed ONLY as a card in the Vaults row, never again in Pinned or Recent. A pinned vault keeps its
 * pin but has no ⌘ number; the remaining pins number from ⌘1. No vaults, no Vaults row.
 *
 * While the Example collection is pinned (ADR-0043, mockup-onboarding-hifi-v2 states 01 and 26),
 * two marked entries, Guide and Example collection, close the Pinned column, below the person's own
 * pins and a hairline (Dominik 2026-10-19). They join the roving group but are not pins: no ⌘ number,
 * no reorder, no drag, no context menu, and the person's own pins keep ⌘1–⌘9.
 *
 * Everything listed comes from main as ONE model (`getStartScreen`), computed after the example
 * check: the entries, the pins as numbered, the recents that are not pins. This component compares
 * no paths to decide what is shown; after any change it asks for the model again.
 */
export function StartScreen({ onOpen, onOpenRecent, onOpenExample, onRemoveExample, initial }: StartScreenProps): JSX.Element {
  const [model, setModel] = useState<StartScreenModel | null>(initial ?? null)
  const [active, setActive] = useState(0)
  const [menu, setMenu] = useState<RowMenu | null>(null)
  const [dragRoot, setDragRoot] = useState<string | null>(null)
  const [overRoot, setOverRoot] = useState<string | null>(null)
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const menuRef = useRef<HTMLDivElement | null>(null)
  const alive = useRef(true)

  const reload = useCallback((): void => {
    void window.writeflex.getStartScreen().then(
      (next) => {
        if (alive.current) setModel(next)
      },
      () => {}, // keep what is shown
    )
  }, [])
  useEffect(() => {
    alive.current = true
    reload()
    // The example was removed or brought back, here or in another window: ask for the model again.
    const off = window.writeflex.onExampleChanged?.(reload)
    return () => {
      alive.current = false
      off?.()
    }
  }, [reload])

  const example = model?.example ?? null
  const pinned = model?.pinned ?? null
  const recents = model?.recents ?? null
  const vaults = useMemo(() => model?.vaults ?? [], [model])
  const ownPins = useMemo(() => pinned ?? [], [pinned])
  const recentRows = useMemo(() => recents ?? [], [recents])
  // Which rows are pins: by where main listed them, for the keyboard and the context menu.
  const pinnedRoots = useMemo(() => new Set(ownPins.map((p) => p.root)), [ownPins])
  // The roving group: every row that can take focus — marked entries, then pins, then recents.
  const sequence = useMemo(
    () => [
      ...vaults.map((v) => v.root),
      ...ownPins.filter((p) => !p.missing).map((p) => p.root),
      ...(example ? [GUIDE_KEY, EXAMPLE_KEY] : []),
      ...recentRows.map((r) => r.root),
    ],
    [vaults, example, ownPins, recentRows],
  )

  const focusRoot = useCallback(
    (root: string) => {
      setActive(Math.max(0, sequence.indexOf(root)))
      rowRefs.current.get(root)?.focus()
    },
    [sequence],
  )
  const focusIndex = useCallback(
    (index: number) => {
      const root = sequence[Math.max(0, Math.min(index, sequence.length - 1))]
      if (root !== undefined) focusRoot(root)
    },
    [sequence, focusRoot],
  )

  // Every change is made in main; the lists are then asked for again, never patched here.
  const pin = useCallback((root: string) => void window.writeflex.pinWorkspace(root).then(reload, reload), [reload])
  const unpin = useCallback((root: string) => void window.writeflex.unpinWorkspace(root).then(reload, reload), [reload])
  const locate = useCallback((root: string) => void window.writeflex.locatePinned(root).then(reload, reload), [reload])
  const move = useCallback(
    (root: string, toIndex: number) => {
      if (toIndex < 0 || toIndex >= ownPins.length) return
      void window.writeflex.movePinned(root, toIndex).then(reload, reload)
    },
    [ownPins, reload],
  )
  const shift = useCallback(
    (root: string, delta: number) => move(root, ownPins.findIndex((p) => p.root === root) + delta),
    [ownPins, move],
  )
  const openInNewWindow = useCallback((root: string) => void window.writeflex.openRecent(root, { newWindow: true }), [])

  // ⌘1–⌘9 open the first nine pinned folders (placeholder until the keymap sweep).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.shiftKey || event.altKey || event.ctrlKey || !/^[1-9]$/.test(event.key)) return
      const target = ownPins[Number(event.key) - 1]
      if (!target || target.missing) return
      event.preventDefault()
      onOpenRecent(target.root)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ownPins, onOpenRecent])

  // The context menu dismisses on Escape or a press outside it, like the tab menu.
  useEffect(() => {
    if (!menu) return
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setMenu(null)
    }
    const onOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenu(null)
    }
    window.addEventListener('keydown', onEscape, true)
    document.addEventListener('pointerdown', onOutside, true)
    return () => {
      window.removeEventListener('keydown', onEscape, true)
      document.removeEventListener('pointerdown', onOutside, true)
    }
  }, [menu])

  const onRowKeyDown = useCallback(
    (event: React.KeyboardEvent, root: string) => {
      const index = sequence.indexOf(root)
      const isPinned = pinnedRoots.has(root)
      if (event.altKey && isPinned && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault()
        shift(root, event.key === 'ArrowUp' ? -1 : 1)
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        focusIndex(index + 1)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        focusIndex(index - 1)
      } else if (event.key === 'Home') {
        event.preventDefault()
        focusIndex(0)
      } else if (event.key === 'End') {
        event.preventDefault()
        focusIndex(sequence.length - 1)
      }
      // Enter/Space fall through to native <button> activation → onClick → onOpenRecent.
    },
    [sequence, pinnedRoots, shift, focusIndex],
  )

  const setRowRef = (root: string) => (el: HTMLButtonElement | null) => {
    if (el) rowRefs.current.set(root, el)
    else rowRefs.current.delete(root)
  }

  const rowButton = (root: string, trailing: JSX.Element, leading: JSX.Element): JSX.Element => (
    <button
      ref={setRowRef(root)}
      className="rec-row"
      tabIndex={sequence.indexOf(root) === active ? 0 : -1}
      onFocus={() => setActive(Math.max(0, sequence.indexOf(root)))}
      onKeyDown={(event) => onRowKeyDown(event, root)}
      onClick={() => onOpenRecent(root)}
      title={root}
      onContextMenu={
        pinnedRoots.has(root)
          ? (event) => {
              event.preventDefault()
              setMenu({ root, x: event.clientX, y: event.clientY })
            }
          : undefined
      }
    >
      {leading}
      <span className="rec-text">
        <span className="rec-name">{folderName(root)}</span>
        <span className="rec-dir">{parentPath(root)}</span>
      </span>
      {trailing}
    </button>
  )

  /**
   * A marked entry: an accent icon in place of the red pin, no number, no grip, no menu. The Example
   * collection's row offers removal (states 26 and 28): a bin at rest, "Remove the example…" while the
   * row is hovered or holds focus, and ⌘⌫ on the row. All three open the same confirmation.
   */
  const markedRow = (key: string, target: ExampleTarget, Icon: LucideIcon, name: string, line: string, title: string, onRemove?: () => void): JSX.Element => (
    <li className={`rec-item${onRemove ? ' removable' : ''}`} data-marked={target}>
      <button
        ref={setRowRef(key)}
        className="rec-row"
        tabIndex={sequence.indexOf(key) === active ? 0 : -1}
        onFocus={() => setActive(Math.max(0, sequence.indexOf(key)))}
        onKeyDown={(event) => {
          if (onRemove && event.metaKey && (event.key === 'Backspace' || event.key === 'Delete')) {
            event.preventDefault()
            onRemove()
          } else onRowKeyDown(event, key)
        }}
        onClick={() => onOpenExample(target)}
        title={title}
      >
        <span className="rec-pin mk" aria-hidden="true">
          <Icon className="icon" />
        </span>
        <span className="rec-text">
          <span className="rec-name">{name}</span>
          <span className="rec-dir">{line}</span>
        </span>
      </button>
      {onRemove ? (
        <button type="button" className="rec-remove" data-action="remove-example" aria-label={REMOVE_EXAMPLE_TEXT.open} title={`${REMOVE_EXAMPLE_TEXT.open} (⌘⌫)`} onClick={onRemove}>
          <Trash2 className="icon sm" aria-hidden="true" />
          <span className="rec-remove-label">{REMOVE_EXAMPLE_TEXT.open}</span>
        </button>
      ) : null}
    </li>
  )

  const figure = (value: number | null, label: string): JSX.Element => (
    <span className="vault-fig">
      <b>{value === null ? '—' : value.toLocaleString('en-GB')}</b>
      <span>{label}</span>
    </span>
  )
  const vaultCard = (vault: StartVault): JSX.Element => (
    <button
      key={vault.root}
      ref={setRowRef(vault.root)}
      className="vault-card"
      data-testid="vault-card"
      tabIndex={sequence.indexOf(vault.root) === active ? 0 : -1}
      onFocus={() => setActive(Math.max(0, sequence.indexOf(vault.root)))}
      onKeyDown={(event) => onRowKeyDown(event, vault.root)}
      onClick={() => onOpenRecent(vault.root)}
      title={vault.root}
    >
      <span className="vault-card-head">
        <Library className="icon" aria-hidden="true" />
        <span className="vault-card-name">{vault.name}</span>
      </span>
      <span className="vault-card-path">{vault.location}</span>
      <span className="vault-card-figs">
        {figure(vault.works, 'works')}
        {figure(vault.inProgress, 'in progress')}
        <span className="vault-fig">
          <b>{vault.lastWorked === null ? '—' : relativeTime(vault.lastWorked)}</b>
          <span>last worked by you</span>
        </span>
      </span>
    </button>
  )

  const pinnedList = ownPins
  const menuIndex = menu ? pinnedList.findIndex((p) => p.root === menu.root) : -1
  const menuElement = menu && (
    <div
      ref={menuRef}
      className="tab-pin-menu start-menu"
      role="menu"
      aria-label="Pinned folder"
      style={{ left: menu.x, top: menu.y }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        event.preventDefault()
        const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
        const at = items.indexOf(document.activeElement as HTMLButtonElement)
        items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
      }}
      onMouseOver={(event) => (event.target as HTMLElement).closest<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()}
    >
      {(
        [
          ['Open', () => onOpenRecent(menu.root), false],
          ['Open in a new window', () => openInNewWindow(menu.root), false],
          ['Unpin', () => unpin(menu.root), false],
          ['Move up', () => shift(menu.root, -1), menuIndex <= 0],
          ['Move down', () => shift(menu.root, 1), menuIndex >= pinnedList.length - 1],
          ['Reveal in Finder', () => void window.writeflex.revealPinned(menu.root), false],
        ] as Array<[string, () => void, boolean]>
      ).map(([label, action, disabled]) => (
        <button
          key={label}
          role="menuitem"
          disabled={disabled}
          onClick={() => {
            setMenu(null)
            action()
          }}
        >
          <span>{label}</span>
        </button>
      ))}
    </div>
  )

  return (
    <div className="start">
      <div className="start-inner">
        <div className="start-brand">
          <PenLine className="start-mark" aria-hidden="true" />
          <span className="start-name">WriteFlex</span>
        </div>
        <p className="start-tag">Open a folder to start writing.</p>

        <button className="start-open" onClick={onOpen} title="Open folder (⌘O)" aria-label="Open folder">
          <FolderOpen className="icon" aria-hidden="true" />
          <span>Open folder…</span>
          <kbd>⌘O</kbd>
        </button>

        {vaults.length > 0 ? (
          <div className="start-vaults" data-testid="vaults-row">
            <div className="side-label">Vaults</div>
            <div className="vault-cards">{vaults.map(vaultCard)}</div>
          </div>
        ) : null}

        <div className={`start-cols${vaults.length > 0 ? ' after-vaults' : ''}`}>
          <div className="start-recents start-pinned" data-testid="pinned-column">
            <div className="side-label">
              <Pin className="pin-glyph" aria-hidden="true" /> Pinned
            </div>
            {pinned === null ? null : !example && ownPins.length === 0 ? (
              <p className="start-empty">Pin a folder you use often</p>
            ) : (
              <ul className="rec-list" role="list">
                {ownPins.map((item, index) => (
                  <li
                    key={item.root}
                    className={`rec-item${overRoot === item.root && dragRoot !== item.root ? ' drop-target' : ''}${dragRoot === item.root ? ' dragging' : ''}`}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData('text/plain', item.root)
                      setDragRoot(item.root)
                    }}
                    onDragOver={(event) => {
                      if (dragRoot === null) return
                      event.preventDefault()
                      setOverRoot(item.root)
                    }}
                    onDrop={(event) => {
                      event.preventDefault()
                      if (dragRoot !== null && dragRoot !== item.root) move(dragRoot, index)
                      setDragRoot(null)
                      setOverRoot(null)
                    }}
                    onDragEnd={() => {
                      setDragRoot(null)
                      setOverRoot(null)
                    }}
                  >
                    {item.missing ? (
                      <div className="rec-row missing" data-missing="true" title={item.root}>
                        <span className="rec-pin" aria-hidden="true">
                          <Pin className="icon" />
                        </span>
                        <span className="rec-text">
                          <span className="rec-name">{folderName(item.root)}</span>
                          <span className="rec-dir">
                            {parentPath(item.root)} · <span className="rec-notfound">not found</span>
                          </span>
                        </span>
                        <button className="rec-act" onClick={() => locate(item.root)}>
                          Locate…
                        </button>
                        <button className="rec-act" onClick={() => unpin(item.root)}>
                          Unpin
                        </button>
                      </div>
                    ) : (
                      rowButton(
                        item.root,
                        <>
                          {index < 9 ? <kbd className="rec-key">⌘{index + 1}</kbd> : null}
                          <GripVertical className="rec-grip" aria-hidden="true" />
                        </>,
                        <span className="rec-pin" aria-hidden="true">
                          <Pin className="icon" />
                        </span>,
                      )
                    )}
                  </li>
                ))}
                {example ? (
                  <>
                    {ownPins.length > 0 ? <li className="rec-sep" role="separator" /> : null}
                    {markedRow(GUIDE_KEY, 'guide', Compass, 'Guide', 'Opens with the Example collection', 'Guide')}
                    {markedRow(EXAMPLE_KEY, 'collection', BookOpen, 'Example collection', exampleLine(example), example.root, onRemoveExample)}
                  </>
                ) : null}
              </ul>
            )}
            {pinned !== null && example && ownPins.length === 0 ? <p className="start-empty pad">Pin a folder you use often</p> : null}
          </div>

          <div className="start-recents">
            <div className="side-label">Recent</div>
            {recents === null ? null : recentRows.length === 0 ? (
              <p className="start-empty">Nothing recent yet — the folders you open will appear here.</p>
            ) : (
              <ul className="rec-list" role="list">
                {recentRows.map((recent) => (
                  <li key={recent.root} className="rec-item">
                    {rowButton(
                      recent.root,
                      <span className="rec-date">{relativeTime(recent.openedAt)}</span>,
                      <span className="rec-pin" aria-hidden="true" />,
                    )}
                    <button
                      className="rec-pin-btn"
                      aria-label={`Pin ${folderName(recent.root)}`}
                      title="Pin this folder"
                      onClick={() => pin(recent.root)}
                    >
                      <Pin className="icon" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <p className="start-hint">
          Press <kbd>?</kbd> for keyboard shortcuts.
        </p>
      </div>
      {menuElement}
    </div>
  )
}

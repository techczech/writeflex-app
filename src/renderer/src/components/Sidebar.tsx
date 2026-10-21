import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { commandRan } from '../commands/command-ran'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  Archive,
  BookOpenText,
  BookMarked,
  Bot,
  ChevronDown,
  ChevronsUpDown,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GripVertical,
  LayoutDashboard,
  MessagesSquare,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Star,
  StickyNote,
  Link2,
  Tag,
  Trash2,
  X,
} from 'lucide-react'
import type { MarkdownFile } from '../../../preload'
import { NO_CHECKLIST_PROGRESS, type ChecklistProgressMap } from '../hooks/useChecklistProgress'
import { ChecklistProgressChip } from './ChecklistProgressChip'
import { buildTree, filterTreeByName, focusTree, isInFocus, vaultSidebarTree, workRowIcon, type TreeFile, type TreeFolder, type TreeNode } from '../sidebar-tree'
import { vaultCountText } from '../vault-sidebar'
import { useVaultSidebarPrefs } from '../hooks/useVaultSidebarPrefs'
import { VaultSwitcherMenu, type SwitcherChoice } from './VaultSwitcherMenu'
import { useVaultSidebar } from '../hooks/useVaultSidebar'
import { movePin, pinnedRows } from '../vault-pins'
import { PIN_DOCUMENT_EXTENSION, type VaultWriteResult } from '../../../shared/vault'
import type { ActionRow } from '../commands/actions-here'
import { BinPopover, MoveFolderPicker } from './file-menu'
import { ActionsHere } from './ActionsHere'
import { placeOfRow } from '../commands/place'

/** App-implemented file operations (ADR-0017). Rename/create/move return false on a REFUSAL
 *  (name collision) so the row can shake and stay in rename; everything else flashes in App. */
export type SidebarFileOps = {
  createFile: (name: string, directory: string) => Promise<boolean>
  createFolder: (path: string) => Promise<boolean>
  renameFile: (path: string, newName: string) => Promise<boolean>
  renameFolder: (path: string, newName: string) => Promise<boolean>
  moveFile: (path: string, directory: string | null) => Promise<boolean>
  /** Returns the copy's path (to land it straight in rename), or null on failure. */
  duplicateFile: (path: string) => Promise<string | null>
  trashFile: (path: string) => Promise<void>
  trashFolder: (path: string) => Promise<void>
  revealFile: (path: string) => void
  copyPath: (path: string) => void
  /** Raise the Export sheet on this row (Round B T6, ADR-0029: palette, quiet menu, cheat-sheet). */
  exportFile: (path: string) => void
}

export type SidebarProps = {
  files: MarkdownFile[]
  /** Checklist notes' "done / total" (checkbox-lists frame 8); a file absent from it has no chip. */
  checklistProgress?: ChecklistProgressMap
  /** Review items waiting per piece (path to count), shown as a count on the piece's row (0.23 ticket 04). */
  waitingCounts?: Readonly<Record<string, number>>
  /** Every workspace directory (including EMPTY ones — a just-created folder is visible, ADR-0017). */
  folders: string[]
  /** Root Collection projection summary; Folder Piece paths mark the corresponding tree folder rows. */
  pieceCount?: number
  folderPiecePaths?: Set<string>
  favourites: string[]
  activePath: string | null
  onOpen: (path: string) => void
  onToggleFavourite: (path: string) => void
  onOpenCollection: (dir: string) => void
  /** The folder whose dashboard (Collection page) is showing in the main area ('' = the whole collection),
   *  or null/undefined when none is. Its Folder dashboard button is drawn filled. */
  dashboardDir?: string | null
  /** Sharing ticket 10 (frame `shares-list`): the collection row's Shares button opens the Shares list; drawn filled while it shows. */
  onOpenSharesList?: () => void
  sharesListOn?: boolean
  root: string
  /** Retired (ticket 13): the collapse ‹ lives in the sidebar's tab row now. Kept so callers need not change. */
  onCollapse?: () => void
  onStatus: (message: string) => void
  onOpenSettings: (initialSection?: string) => void
  /** Publishes the existing roving-focus row so app-level creation commands can use the same target. */
  onFocusedRowChange: (row: SidebarFocusedRow | null) => void
  /** Footer creation uses the same app-owned target ruling as the menu shortcuts. */
  onRequestCreate: (kind: 'file' | 'folder') => void
  /** The running build's version (package.json), shown quietly in the footer so an installed
   *  build can always be identified — the status bar deliberately hides it outside development. */
  version: string | null
  focusFilterTick: number
  fileOps: SidebarFileOps
  /** App-driven creation (⌘N / ⌃⌘N): bump tick to start a ghost row of `kind` in `directory`. */
  createRequest: { tick: number; kind: 'file' | 'folder'; directory: string } | null
  /** App-owned request to focus the active/first row, or reveal one exact file/folder row. */
  focusTreeRequest?: SidebarTreeFocusRequest
  /** The window's focused folder (ticket 03): the tree shows only it and its descendants, with the
   *  folder as the top row. Null = the whole archive. */
  focusPath?: string | null
  /** Focus a folder (the row menu's Focus), or clear the focus with null (its Clear focus). */
  onFocusFolder?: (path: string | null) => void
  /** Start the report skill on this folder (ticket 10: the folder menu's Help with this report). */
  onHelpWithReport?: (path: string) => void
  /** The vault switcher under the root name (vaults ticket 06). Open state is the app's, so the palette's
   *  `Switch vault…` opens the same menu; without `onSwitcherOpenChange` the root name opens nothing. */
  switcherOpen?: boolean
  onSwitcherOpenChange?: (open: boolean) => void
  onSwitcherChoose?: (choice: SwitcherChoice) => void
}

export type SidebarFocusedRow = { key: string; kind: 'file' | 'folder' }
export type SidebarTreeFocusRequest = { tick: number; target: SidebarFocusedRow | null }
type RowRef = SidebarFocusedRow
type Renaming = { key: string; kind: 'file' | 'folder'; isNew: boolean; directory: string }
type Anchored = { key: string; kind: 'file' | 'folder'; x: number; y: number }

const NEW_KEY = '__new__'
/** A Pinned row's focus key (the tree's own row for the same folder or document keeps the plain path). */
const PIN_PREFIX = 'pin:'
/** What the rest of the app is told about the focused row: a Pinned row is its folder or document. */
const appRow = (row: RowRef | null): RowRef | null => (row && row.key.startsWith(PIN_PREFIX) ? { key: row.key.slice(PIN_PREFIX.length), kind: row.kind } : row)
const TREE_ROW_BASE_PX = 8
const TREE_DEPTH_STEP_PX = 14

/** Pressing a row-end button must not move focus to it: focus-within restyles the row (the buttons shrink to
 *  icons and move), and a button that moves between mouse-down and mouse-up loses the click. Click and the
 *  keyboard (Tab, Enter, Space) are unchanged. */
const keepFocus = (e: { preventDefault: () => void }): void => e.preventDefault()

function treeRowStyle(depth: number): CSSProperties {
  return { paddingLeft: TREE_ROW_BASE_PX + depth * TREE_DEPTH_STEP_PX }
}

function glyphFor(node: TreeFile): JSX.Element {
  if (node.isIndex) return <BookOpenText className="icon sm" />
  if (node.isScrap) return <StickyNote className="icon sm" />
  return <FileText className="icon sm" />
}

const collapseKey = (root: string): string => `writeflex:tree:${root}`

function readCollapsed(root: string): Set<string> {
  try {
    const raw = localStorage.getItem(collapseKey(root))
    const parsed = raw ? JSON.parse(raw) : null
    return Array.isArray(parsed) ? new Set(parsed.filter((p): p is string => typeof p === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

/** A pin control. Rendered as a role=button span because a .trow is itself a <button> (no nesting). */
function StarButton({ path, on, onToggle }: { path: string; on: boolean; onToggle: (path: string) => void }): JSX.Element {
  return (
    <span
      role="button"
      tabIndex={0}
      className={on ? 'fav-star on' : 'fav-star'}
      aria-pressed={on}
      aria-label={on ? 'Unpin favourite' : 'Pin favourite'}
      title={on ? 'Unpin from Favourites' : 'Pin to Favourites'}
      onClick={(e) => {
        e.stopPropagation() // don't also open the row we're pinning
        onToggle(path)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          e.stopPropagation()
          onToggle(path)
        }
      }}
    >
      <Star className="icon sm" />
    </span>
  )
}

/**
 * The Files pane's row actions, by the command id Actions here lists them under (ticket 03). The ids are
 * the ones `actionsAt` returns at the file, folder and focused-folder places; the values are what
 * `runMenuAction` has always done for them. A row of the panel with no entry here is run by App.
 */
export const ROW_ACTION_OF: Readonly<Record<string, string>> = {
  'file.open': 'open', 'file.rename': 'rename', 'file.move': 'move', 'file.duplicate': 'duplicate', 'file.pin': 'pin',
  'file.export': 'export', 'file.reveal': 'reveal', 'file.copyPath': 'copy-path', 'file.trash': 'trash',
  'folder.newFile': 'new-file', 'folder.newFolder': 'new-folder', 'folder.focus': 'focus', 'folder.clearFocus': 'clear-focus',
  'folder.helpWithReport': 'help-report', 'folder.rename': 'rename', 'folder.reveal': 'reveal', 'folder.trash': 'trash',
}

/** The registry command a row action stands for (`rename` on a file is `file.rename`, on a folder `folder.rename`). */
const rowCommandOf = (kind: 'file' | 'folder', action: string): string | null =>
  Object.entries(ROW_ACTION_OF).find(([id, own]) => own === action && id.startsWith(`${kind}.`))?.[0] ?? null
const reportRowRun = (kind: 'file' | 'folder', action: string): void => {
  const id = rowCommandOf(kind, action)
  if (id) commandRan(id)
}

/**
 * The Files sidebar per mockup v4 (ADR-0009) + the Quiet Menu file management (ADR-0017, mockup
 * `reports/design/file-management/quiet-menu-v1.html` is the spec): roving row focus, one anchored
 * context menu (⌘K / right-click), inline rename (F2) with collision shake-and-stay, dialog-free
 * ghost-row creation, M move picker + drag-and-drop, and the ⌘⌫ bin popover.
 *
 * Memoised (0.24.1, R6): App re-renders on every editor snapshot while the writer types, and the tree
 * (thousands of rows in a large vault) must not reconcile with it. App hands it stable props.
 */
export const Sidebar = memo(SidebarView)

function SidebarView({
  files,
  checklistProgress = NO_CHECKLIST_PROGRESS,
  waitingCounts,
  folders,
  pieceCount,
  folderPiecePaths = new Set(),
  favourites,
  activePath,
  onOpen,
  onToggleFavourite,
  onOpenCollection,
  dashboardDir = null,
  onOpenSharesList,
  sharesListOn = false,
  root,
  onStatus,
  onOpenSettings,
  onFocusedRowChange,
  onRequestCreate,
  version,
  focusFilterTick,
  fileOps,
  createRequest,
  focusTreeRequest = { tick: 0, target: null },
  focusPath = null,
  onFocusFolder,
  onHelpWithReport,
  switcherOpen,
  onSwitcherOpenChange,
  onSwitcherChoose,
}: SidebarProps): JSX.Element {
  const tree = useMemo(() => buildTree(files, folders), [files, folders])
  const focusedTree = useMemo(() => focusTree(tree, focusPath), [tree, focusPath])
  const favSet = useMemo(() => new Set(favourites), [favourites])
  const favFiles = useMemo(
    () => files.filter((f) => favSet.has(f.path)).sort((a, b) => a.name.localeCompare(b.name)),
    [files, favSet],
  )

  const { vault, index: vaultIndex } = useVaultSidebar(root)
  const isVault = vault !== null
  const [prefs, choosePrefs] = useVaultSidebarPrefs(root)
  // The vault switcher hangs under the root name; where it opens is read from the name when it opens.
  const rootNameRef = useRef<HTMLButtonElement | null>(null)
  const [switcherAt, setSwitcherAt] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!switcherOpen) { setSwitcherAt(null); return }
    const box = rootNameRef.current?.getBoundingClientRect()
    setSwitcherAt(box ? { x: box.left - 4, y: box.bottom + 4 } : null)
  }, [switcherOpen])
  const closeSwitcher = useCallback((refocus: boolean) => {
    onSwitcherOpenChange?.(false)
    if (refocus) requestAnimationFrame(() => rootNameRef.current?.focus())
  }, [onSwitcherOpenChange])
  const [tip, setTip] = useState<{ text: string; mono: boolean; x: number; y: number } | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [filterVisible, setFilterVisible] = useState(false)
  const [filterQuery, setFilterQuery] = useState('')
  const filterInputRef = useRef<HTMLInputElement | null>(null)
  const treeRef = useRef<HTMLDivElement | null>(null)

  // --- Quiet Menu state (ADR-0017) ---
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [menu, setMenu] = useState<Anchored | null>(null)
  const [movePick, setMovePick] = useState<Anchored | null>(null)
  const [binAsk, setBinAsk] = useState<Anchored | null>(null)
  const [renaming, setRenaming] = useState<Renaming | null>(null)
  const [shakeKey, setShakeKey] = useState<string | null>(null)
  const [dragPath, setDragPath] = useState<string | null>(null)
  const [dropDir, setDropDir] = useState<string | null>(null)
  const shakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** A pinned row being dragged and the slot (0..pins.length) its drop line shows at. */
  const [pinDrag, setPinDrag] = useState<{ path: string; over: number | null } | null>(null)

  useEffect(() => setCollapsed(readCollapsed(root)), [root])
  useEffect(() => {
    if (focusFilterTick === 0) return
    setFilterVisible(true)
  }, [focusFilterTick])
  useEffect(() => {
    if (!filterVisible) return
    requestAnimationFrame(() => filterInputRef.current?.focus())
  }, [filterVisible, focusFilterTick])

  // ⌘N / ⌃⌘N from App: start a ghost row (dialog-free creation).
  useEffect(() => {
    if (!createRequest || createRequest.tick === 0) return
    setMenu(null)
    setMovePick(null)
    setBinAsk(null)
    setCollapsed((prev) => {
      if (!createRequest.directory || !prev.has(createRequest.directory)) return prev
      const next = new Set(prev)
      next.delete(createRequest.directory) // creating INTO a collapsed folder must show the ghost
      return next
    })
    setRenaming({ key: NEW_KEY, kind: createRequest.kind, isNew: true, directory: createRequest.directory })
  }, [createRequest])

  const persistCollapsed = useCallback(
    (next: Set<string>) => {
      try {
        localStorage.setItem(collapseKey(root), JSON.stringify([...next]))
      } catch {
        // localStorage can throw (quota/private mode); collapse state is convenience only.
      }
    },
    [root],
  )
  const toggleFolder = useCallback(
    (folderPath: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev)
        if (next.has(folderPath)) next.delete(folderPath)
        else next.add(folderPath)
        persistCollapsed(next)
        return next
      })
    },
    [persistCollapsed],
  )
  const setFolderCollapsed = useCallback(
    (folderPath: string, value: boolean) => {
      setCollapsed((prev) => {
        if (prev.has(folderPath) === value) return prev
        const next = new Set(prev)
        if (value) next.add(folderPath)
        else next.delete(folderPath)
        persistCollapsed(next)
        return next
      })
    },
    [persistCollapsed],
  )

  const workspaceName = root.split('/').filter(Boolean).at(-1) ?? 'Workspace'
  const hasFilter = filterQuery.trim().length > 0
  const vaultTree = useMemo(
    () => (isVault ? vaultSidebarTree(focusedTree, { writingOnly: prefs.writingOnly, titles: prefs.titles, index: vaultIndex }) : focusedTree),
    [isVault, focusedTree, prefs, vaultIndex],
  )
  const shownTree = useMemo(() => filterTreeByName(vaultTree, filterQuery), [vaultTree, filterQuery])
  const pins = vault?.settings.pins
  const pinKinds = vault?.pinKinds
  const pinSet = useMemo(() => new Set(pins ?? []), [pins])
  const pinRows = useMemo(
    () => (pins
      ? pinnedRows({ pins, kinds: pinKinds, index: vaultIndex, folders: new Set(folders), documents: new Set(files.map((file) => file.path)), titles: prefs.titles })
      : []),
    [pins, pinKinds, vaultIndex, folders, files, prefs.titles],
  )
  /** Can this tree row be pinned? Any folder of a vault; a document only when it is a `.md` file (main's rule). */
  const pinnable = (path: string, kind: 'file' | 'folder'): boolean => isVault && path !== '' && (kind === 'folder' || PIN_DOCUMENT_EXTENSION.test(path))
  const showPinned = isVault && pinRows.length > 0 && !hasFilter
  /** Every pin operation goes through the vault store; a refusal is told in the status line. */
  const pinOp = useCallback(async (run: () => Promise<VaultWriteResult>): Promise<void> => {
    try {
      const result = await run()
      if (!result.ok) onStatus(result.message)
    } catch {
      onStatus('The pinned items could not be changed.')
    }
  }, [onStatus])
  /** Work folders in the Titles view: one row that opens, never expands. */
  const workFolderKeys = useMemo(() => {
    const out = new Set<string>()
    const walk = (nodes: TreeNode[]): void => {
      for (const n of nodes) if (n.kind === 'folder') { if (n.work) out.add(n.path); else walk(n.children) }
    }
    walk(shownTree)
    return out
  }, [shownTree])
  const filesInFocus = useMemo(() => files.filter((file) => isInFocus(file.path, focusPath)).length, [files, focusPath])
  const allFolders = useMemo(() => {
    const out: string[] = []
    const walk = (nodes: TreeNode[]): void => {
      for (const n of nodes) {
        if (n.kind === 'folder') {
          out.push(n.path)
          walk(n.children)
        }
      }
    }
    walk(tree)
    return out
  }, [tree])

  /** The visible rows in document order — the roving-focus ring for ↑/↓ (ADR-0017). */
  const visibleRows = useMemo(() => {
    const out: RowRef[] = []
    if (showPinned) for (const pin of pinRows) out.push({ key: PIN_PREFIX + pin.path, kind: pin.kind === 'document' ? 'file' : 'folder' })
    const walk = (nodes: TreeNode[]): void => {
      for (const n of nodes) {
        if (n.kind === 'folder') {
          out.push({ key: n.path, kind: 'folder' })
          const isCollapsed = hasFilter || n.path === focusPath ? false : collapsed.has(n.path)
          if (!isCollapsed) walk(n.children)
        } else {
          out.push({ key: n.path, kind: 'file' })
        }
      }
    }
    walk(shownTree)
    return out
  }, [shownTree, collapsed, hasFilter, focusPath, showPinned, pinRows])

  /** The one tab-reachable row: the focused row, else the FIRST visible row of either kind — a
   *  folder-first workspace must still let Tab enter the tree (Codex second-look finding #5). */
  const tabTargetKey = focusKey && visibleRows.some((r) => r.key === focusKey) ? focusKey : visibleRows[0]?.key ?? null
  const rowRef = useCallback((key: string): RowRef | null => visibleRows.find((r) => r.key === key) ?? null, [visibleRows])
  const nodeFor = useCallback(
    (key: string): TreeNode | null => {
      let hit: TreeNode | null = null
      const walk = (nodes: TreeNode[]): void => {
        for (const n of nodes) {
          if (n.path === key) hit = n
          if (n.kind === 'folder') walk(n.children)
        }
      }
      walk(tree)
      return hit
    },
    [tree],
  )

  useEffect(() => {
    onFocusedRowChange(appRow(focusKey ? rowRef(focusKey) : null))
  }, [focusKey, onFocusedRowChange, rowRef])
  useEffect(() => () => onFocusedRowChange(null), [onFocusedRowChange])
  const rowElement = useCallback(
    (key: string): HTMLElement | null => treeRef.current?.querySelector(`[data-row="${CSS.escape(key)}"]`) ?? null,
    [],
  )
  const focusRow = useCallback(
    (key: string | null) => {
      setFocusKey(key)
      onFocusedRowChange(appRow(key ? rowRef(key) : null))
      if (key) requestAnimationFrame(() => rowElement(key)?.focus())
    },
    [onFocusedRowChange, rowElement, rowRef],
  )

  // App navigation lands on the requested row. Exact targets clear narrowing and expand every
  // ancestor through this existing collapsed-state seam, so quick-open never maintains a second tree.
  useEffect(() => {
    if (focusTreeRequest.tick === 0) return
    const requested = focusTreeRequest.target
    if (requested) {
      setFilterQuery('')
      const slash = requested.key.lastIndexOf('/')
      let cursor = requested.kind === 'folder' ? requested.key : slash === -1 ? '' : requested.key.slice(0, slash)
      const ancestors: string[] = []
      while (cursor) {
        ancestors.push(cursor)
        cursor = cursor.includes('/') ? cursor.slice(0, cursor.lastIndexOf('/')) : ''
      }
      setCollapsed((previous) => {
        const next = new Set(previous)
        for (const path of ancestors) next.delete(path)
        persistCollapsed(next)
        return next
      })
      setFocusKey(requested.key)
      onFocusedRowChange(requested)
      requestAnimationFrame(() => requestAnimationFrame(() => rowElement(requested.key)?.focus()))
      return
    }
    const target = (focusKey && visibleRows.some((r) => r.key === focusKey) ? focusKey : null)
      ?? (activePath && visibleRows.some((r) => r.key === activePath) ? activePath : null)
      ?? visibleRows[0]?.key
      ?? null
    focusRow(target)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTreeRequest.tick])

  const shake = useCallback((key: string) => {
    setShakeKey(key)
    if (shakeTimer.current) clearTimeout(shakeTimer.current)
    shakeTimer.current = setTimeout(() => setShakeKey(null), 400)
  }, [])

  const closeAnchored = useCallback(() => {
    setMenu(null)
    setMovePick(null)
    setBinAsk(null)
  }, [])

  const openMenuFor = useCallback(
    (key: string, kind: 'file' | 'folder', at?: { x: number; y: number }) => {
      setMovePick(null)
      setBinAsk(null)
      const rect = rowElement(key)?.getBoundingClientRect()
      setMenu({ key, kind, x: at?.x ?? (rect ? rect.left + 90 : 100), y: at?.y ?? (rect ? rect.bottom + 2 : 100) })
    },
    [rowElement],
  )
  const openMovePicker = useCallback(
    (key: string) => {
      closeAnchored()
      // No destinations (root file, no folders) → say so instead of an empty, crash-prone picker
      // (Codex second-look finding #6).
      const slash = key.lastIndexOf('/')
      const currentDir = slash === -1 ? '' : key.slice(0, slash)
      const destinations = allFolders.filter((dir) => dir !== currentDir).length + (currentDir ? 1 : 0)
      if (destinations === 0) {
        onStatus('No other folder to move to — create one first (⌃⌘N).')
        return
      }
      const rect = rowElement(key)?.getBoundingClientRect()
      setMovePick({ key, kind: 'file', x: rect ? rect.left + 40 : 100, y: rect ? rect.bottom + 4 : 120 })
    },
    [closeAnchored, rowElement, allFolders, onStatus],
  )
  const openBinAsk = useCallback(
    (key: string, kind: 'file' | 'folder') => {
      closeAnchored()
      const rect = rowElement(key)?.getBoundingClientRect()
      setBinAsk({ key, kind, x: rect ? rect.left + 26 : 80, y: rect ? rect.bottom + 4 : 120 })
    },
    [closeAnchored, rowElement],
  )

  const startRename = useCallback(
    (key: string, kind: 'file' | 'folder') => {
      closeAnchored()
      const slash = key.lastIndexOf('/')
      setRenaming({ key, kind, isNew: false, directory: slash === -1 ? '' : key.slice(0, slash) })
    },
    [closeAnchored],
  )

  const commitRename = useCallback(
    async (value: string) => {
      if (!renaming) return
      const typed = value.trim()
      if (!typed) {
        setRenaming(null)
        return
      }
      const { key, kind, isNew, directory } = renaming
      let ok: boolean
      if (isNew) {
        ok = kind === 'file'
          ? await fileOps.createFile(`${typed}.md`, directory)
          : await fileOps.createFolder(directory ? `${directory}/${typed}` : typed)
      } else {
        ok = kind === 'file' ? await fileOps.renameFile(key, `${typed}.md`) : await fileOps.renameFolder(key, typed)
      }
      if (!ok) {
        shake(isNew ? NEW_KEY : key) // refusal: shake and STAY in rename (ADR-0017)
        return
      }
      setRenaming(null)
      const landed = isNew
        ? directory
          ? `${directory}/${typed}${kind === 'file' ? '.md' : ''}`
          : `${typed}${kind === 'file' ? '.md' : ''}`
        : directory
          ? `${directory}/${typed}${kind === 'file' ? '.md' : ''}`
          : `${typed}${kind === 'file' ? '.md' : ''}`
      focusRow(landed)
    },
    [renaming, fileOps, shake, focusRow],
  )
  const cancelRename = useCallback(() => {
    setRenaming(null)
    if (focusKey) focusRow(focusKey)
  }, [focusKey, focusRow])

  const runMenuAction = useCallback(
    (id: string) => {
      if (!menu) return
      const { key, kind } = menu
      setMenu(null)
      if (kind === 'file') {
        if (id === 'open') onOpen(key)
        else if (id === 'rename') startRename(key, 'file')
        else if (id === 'move') openMovePicker(key)
        else if (id === 'duplicate') void duplicateRow(key)
        else if (id === 'pin') onToggleFavourite(key)
        else if (id === 'reveal') fileOps.revealFile(key)
        else if (id === 'export') fileOps.exportFile(key)
        else if (id === 'copy-path') fileOps.copyPath(key)
        else if (id === 'trash') openBinAsk(key, 'file')
      } else {
        if (id === 'new-file') setRenaming({ key: NEW_KEY, kind: 'file', isNew: true, directory: key })
        else if (id === 'new-folder') setRenaming({ key: NEW_KEY, kind: 'folder', isNew: true, directory: key })
        else if (id === 'focus') onFocusFolder?.(key)
        else if (id === 'clear-focus') onFocusFolder?.(null)
        else if (id === 'help-report') onHelpWithReport?.(key)
        else if (id === 'rename') startRename(key, 'folder')
        else if (id === 'reveal') fileOps.revealFile(key)
        else if (id === 'trash') openBinAsk(key, 'folder')
      }
      if (id === 'new-file' || id === 'new-folder') setFolderCollapsed(key, false)
      // The row command ran (the Guide's ticks): the same report as the row keys below.
      reportRowRun(kind, id)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [menu, onOpen, startRename, openMovePicker, onToggleFavourite, fileOps, openBinAsk, setFolderCollapsed, onFocusFolder, onHelpWithReport],
  )

  /** A row of Actions here at a file or folder: what the old menu did for it. False for a row App runs. */
  const runRowCommand = useCallback((commandId: string): boolean => {
    if (commandId === 'vault.pin' || commandId === 'vault.unpin') {
      const target = menu?.key
      setMenu(null)
      if (target) void pinOp(() => (commandId === 'vault.pin' ? window.writeflex.vault.addPin(target) : window.writeflex.vault.removePin(target)))
      return true
    }
    const action = ROW_ACTION_OF[commandId]
    if (!action) return false
    runMenuAction(action)
    return true
  }, [runMenuAction, menu, pinOp])

  const duplicateRow = useCallback(
    async (key: string) => {
      const copyPath = await fileOps.duplicateFile(key)
      if (copyPath) startRename(copyPath, 'file') // land in rename so the (copy) suffix is instantly fixable
    },
    [fileOps, startRename],
  )

  const confirmBin = useCallback(async () => {
    if (!binAsk) return
    const { key, kind } = binAsk
    setBinAsk(null)
    if (kind === 'file') await fileOps.trashFile(key)
    else await fileOps.trashFolder(key)
    focusRow(visibleRows.find((r) => r.key !== key)?.key ?? null)
  }, [binAsk, fileOps, focusRow, visibleRows])

  const moveRowTo = useCallback(
    async (key: string, dir: string | null) => {
      const slash = key.lastIndexOf('/')
      const currentDir = slash === -1 ? null : key.slice(0, slash)
      if ((dir ?? null) === currentDir) {
        setMovePick(null)
        return // dropping onto its own parent is a no-op (Codex #7)
      }
      const ok = await fileOps.moveFile(key, dir)
      if (!ok) return
      setMovePick(null)
      if (dir) setFolderCollapsed(dir, false)
      const name = key.split('/').at(-1) ?? key
      focusRow(dir ? `${dir}/${name}` : name)
    },
    [fileOps, setFolderCollapsed, focusRow],
  )

  // --- keyboard (the tree container owns the ring; inputs stop propagation themselves) ---
  function onTreeKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
    if (renaming) return
    // Enter / Space on the Folder dashboard button press it; the row's Enter (expand / collapse) is not theirs.
    if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof Element && e.target.closest('.fdash')) return
    const idx = focusKey ? visibleRows.findIndex((r) => r.key === focusKey) : -1
    const current = idx >= 0 ? visibleRows[idx] : null
    if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof Element && e.target.closest('.vd-pinbtn')) return
    if (current?.key.startsWith(PIN_PREFIX)) {
      // A Pinned row: it takes the ring's arrows, Enter (opens the folder's dashboard, or the document) and the menu
      // key; the tree's own row commands act on the tree row of the same folder or document, not on this one.
      const path = current.key.slice(PIN_PREFIX.length)
      const kind = pinRows.find((row) => row.path === path)?.kind ?? 'missing'
      const missing = kind === 'missing'
      if (e.key === 'ArrowDown') focusRow(visibleRows[Math.min(idx + 1, visibleRows.length - 1)]?.key ?? null)
      else if (e.key === 'ArrowUp') focusRow(visibleRows[Math.max(idx - 1, 0)]?.key ?? null)
      else if (e.key === 'Enter' && kind === 'document') onOpen(path)
      else if (e.key === 'Enter' && kind === 'folder') onOpenCollection(path)
      else if ((e.key === 'Delete' || e.key === 'Backspace') && missing) void pinOp(() => window.writeflex.vault.removePin(path))
      else if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey) && !missing) openMenuFor(path, kind === 'document' ? 'file' : 'folder', pinRowMenuAt(current.key))
      else return
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if (e.key === 'ArrowDown') {
      focusRow(visibleRows[Math.min(idx + 1, visibleRows.length - 1)]?.key ?? null)
    } else if (e.key === 'ArrowUp') {
      focusRow(visibleRows[Math.max(idx - 1, 0)]?.key ?? null)
    } else if (e.key === 'ArrowRight' && current?.kind === 'folder') {
      if (!workFolderKeys.has(current.key)) setFolderCollapsed(current.key, false)
    } else if (e.key === 'ArrowLeft' && current) {
      if (current.kind === 'folder' && !workFolderKeys.has(current.key) && !collapsed.has(current.key)) {
        setFolderCollapsed(current.key, true)
      } else {
        const slash = current.key.lastIndexOf('/')
        if (slash !== -1) {
          const parent = current.key.slice(0, slash)
          setFolderCollapsed(parent, true)
          focusRow(parent)
        }
      }
    } else if (e.key === 'Enter' && current?.kind === 'folder' && workFolderKeys.has(current.key)) {
      onOpenCollection(current.key)
    } else if (e.key === 'Enter' && current?.kind === 'folder') {
      if (hasFilter) setFolderCollapsed(current.key, false)
      else toggleFolder(current.key)
    } else if (e.key === 'F2' && current) {
      startRename(current.key, current.kind)
      reportRowRun(current.kind, 'rename')
    } else if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey) && current) {
      openMenuFor(current.key, current.kind)
    } else if ((e.key === 'm' || e.key === 'M') && !e.metaKey && !e.ctrlKey && !e.altKey && current?.kind === 'file') {
      openMovePicker(current.key)
      reportRowRun('file', 'move')
    } else if ((e.key === 'd' || e.key === 'D') && (e.metaKey || e.ctrlKey) && !e.shiftKey && current?.kind === 'file') {
      void duplicateRow(current.key)
      reportRowRun('file', 'duplicate')
    } else if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey) && current) {
      openBinAsk(current.key, current.kind)
      reportRowRun(current.kind, 'trash')
    } else {
      return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  function onFilterKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      const target = event.key === 'ArrowDown' ? visibleRows[0] : visibleRows.at(-1)
      focusRow(target?.key ?? null)
    } else if (event.key === 'Escape' && filterQuery) {
      event.preventDefault()
      event.stopPropagation()
      setFilterQuery('')
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setFilterVisible(false)
      focusRow((focusKey && visibleRows.some((row) => row.key === focusKey) ? focusKey : visibleRows[0]?.key) ?? null)
    }
  }

  function renameRow(kind: 'file' | 'folder', depth: number, currentName: string, key: string): JSX.Element {
    const base = kind === 'file' ? currentName.replace(/\.md$/i, '') : currentName
    return (
      <div
        key={`ren:${key}`}
        data-row={key}
        className={`trow renaming${shakeKey === key ? ' shake' : ''}`}
        style={treeRowStyle(depth)}
      >
        <span className="gtr" aria-hidden="true" />
        {kind === 'file' ? <FileText className="icon sm" /> : <Folder className="icon sm" />}
        <span className="ren-wrap">
          <input
            autoFocus
            defaultValue={base}
            aria-label={kind === 'file' ? 'File name' : 'Folder name'}
            spellCheck={false}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') {
                e.preventDefault()
                void commitRename(e.currentTarget.value)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                cancelRename()
              }
            }}
            onBlur={(e) => void commitRename(e.currentTarget.value)}
          />
          {kind === 'file' && <span className="ren-ext">.md</span>}
        </span>
      </div>
    )
  }

  function fileRow(node: TreeFile, depth: number): JSX.Element {
    if (renaming && !renaming.isNew && renaming.key === node.path) return renameRow('file', depth, node.name, node.path)
    const active = node.path === activePath
    const rowTip = vaultTipFor(node)
    return (
      <button
        key={node.path}
        data-row={node.path}
        className={`trow${node.path.split('/').includes('agent-notes') ? ' agent-authored' : ''}${focusKey === node.path ? ' kfocus' : ''}${dragPath === node.path ? ' dragged' : ''}${shakeKey === node.path ? ' shake' : ''}`}
        style={treeRowStyle(depth)}
        aria-current={active ? 'true' : undefined}
        title={rowTip ? undefined : node.path}
        {...tipHandlers(rowTip)}
        tabIndex={tabTargetKey === node.path ? 0 : -1}
        draggable
        onFocus={() => {
          setFocusKey(node.path)
          onFocusedRowChange({ key: node.path, kind: 'file' })
        }}
        onClick={() => onOpen(node.path)}
        onContextMenu={(e) => {
          e.preventDefault()
          setFocusKey(node.path) // NOT focusRow — its deferred row.focus() would blur-close the menu
          onFocusedRowChange({ key: node.path, kind: 'file' })
          openMenuFor(node.path, 'file', { x: e.clientX, y: e.clientY })
        }}
        onDragStart={() => setDragPath(node.path)}
        onDragEnd={() => {
          setDragPath(null)
          setDropDir(null)
        }}
      >
        <span className="gtr" aria-hidden="true" />
        {glyphFor(node)}
        <span className="flex-name">{node.label ?? node.name}</span>
        <ChecklistProgressChip path={node.path} progress={checklistProgress} />
        {(waitingCounts?.[node.path] ?? 0) > 0 && <span className="wait-count" data-waiting-count={waitingCounts![node.path]} title={`${waitingCounts![node.path]} waiting for review`} aria-label={`${waitingCounts![node.path]} waiting for review`}><MessagesSquare className="icon" aria-hidden="true" />{waitingCounts![node.path]}</span>}
        {node.path.split('/').includes('agent-notes') && <Bot className="agent-provenance" aria-label="Agent-authored Piece" />}
        <StarButton path={node.path} on={favSet.has(node.path)} onToggle={onToggleFavourite} />
        {pinButton(node.path, node.label ?? node.name, true, 'file')}
      </button>
    )
  }

  /** The Folder dashboard button: shown on a folder row that is selected, pointed at or keyboard-focused
   *  (CSS decides which; it is display:none otherwise, so it is out of the Tab order too), and always on the
   *  collection's name row. It is the Tab stop after the focused row only. */
  function dashboardButton(name: string, dir: string, rowFocused: boolean, whole = false): JSX.Element {
    return (
      <button
        className={`fdash${dashboardDir === dir ? ' on' : ''}`}
        tabIndex={rowFocused || whole ? 0 : -1}
        title={`Open the Folder dashboard for ${name}${whole ? ' (the whole collection)' : ''}`}
        aria-label={`Folder dashboard for ${name}`}
        onMouseDown={keepFocus}
        onClick={() => onOpenCollection(dir)}
      >
        {/* The icon stands in for the words when the row is too narrow for both row-end buttons as pills (CSS). */}
        <LayoutDashboard className="icon rb-ico" aria-hidden="true" />
        <span className="rb-lbl">Folder dashboard</span>
      </button>
    )
  }

  /** The vault tooltip of a row, or null for today's native title: Titles shows the file or folder name (mono),
   *  File names shows the title when it differs from the name. */
  function vaultTipFor(node: TreeNode): { text: string; mono: boolean } | null {
    if (!isVault) return null
    if (node.label !== undefined) return { text: node.name, mono: true }
    const title = vaultIndex?.labels[node.path]
    return title !== undefined && title !== node.name ? { text: title, mono: false } : null
  }
  function tipHandlers(rowTip: { text: string; mono: boolean } | null): {
    onMouseEnter?: (e: React.MouseEvent<HTMLElement>) => void
    onMouseLeave?: () => void
    onBlur?: () => void
  } {
    if (!rowTip) return {}
    return {
      onMouseEnter: (e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        setTip({ ...rowTip, x: rect.left + 40, y: rect.bottom + 4 })
      },
      onMouseLeave: () => setTip(null),
      onBlur: () => setTip(null),
    }
  }

  /** A work folder in the Titles view: one row with the work's title, no chevron; a click opens it as today. */
  function workFolderRow(node: TreeFolder, depth: number): JSX.Element {
    if (renaming && !renaming.isNew && renaming.key === node.path) return renameRow('folder', depth, node.name, node.path)
    const rowTip = vaultTipFor(node)
    const open = (): void => onOpenCollection(node.path)
    return (
      <button
        key={node.path}
        data-row={node.path}
        data-work={node.work}
        className={`trow lv-work${focusKey === node.path ? ' kfocus' : ''}${dashboardDir === node.path ? ' dash-on' : ''}${shakeKey === node.path ? ' shake' : ''}`}
        style={treeRowStyle(depth)}
        aria-current={dashboardDir === node.path ? 'true' : undefined}
        title={rowTip ? undefined : node.name}
        {...tipHandlers(rowTip)}
        tabIndex={tabTargetKey === node.path ? 0 : -1}
        onFocus={() => {
          setFocusKey(node.path)
          onFocusedRowChange({ key: node.path, kind: 'folder' })
        }}
        onClick={open}
        onContextMenu={(e) => {
          e.preventDefault()
          setFocusKey(node.path)
          onFocusedRowChange({ key: node.path, kind: 'folder' })
          openMenuFor(node.path, 'folder', { x: e.clientX, y: e.clientY })
        }}
      >
        <span className="gtr" aria-hidden="true" />
        {workRowIcon(true, node.work) === 'folio' ? <BookMarked className="icon sm" aria-label="Folio" /> : <Folder className="icon sm" aria-label="Folder piece" />}
        <span className="flex-name">{node.label ?? node.name}</span>
        {pinButton(node.path, node.label ?? node.name, true)}
      </button>
    )
  }

  function folderRow(node: TreeFolder, depth: number): JSX.Element {
    if (renaming && !renaming.isNew && renaming.key === node.path) {
      return (
        <div className="group" key={node.path}>
          {renameRow('folder', depth, node.name, node.path)}
          <div className="children">{renderNodes(node.children, depth + 1, node.path)}</div>
        </div>
      )
    }
    const focusedRow = node.path === focusPath
    const isCollapsed = hasFilter || focusedRow ? false : collapsed.has(node.path)
    const agentFolder = node.name === 'agent-notes'
    const dashShowing = dashboardDir === node.path
    return (
      <div className="group" key={node.path}>
        <div
          data-row={node.path}
          aria-current={dashShowing ? 'true' : undefined}
          className={`trow folder${dashShowing ? ' dash-on' : ''}${focusedRow ? ' focused' : ''}${folderPiecePaths.has(node.path) ? ' folder-piece' : ''}${agentFolder ? ' agent-authored' : ''}${isCollapsed ? ' collapsed' : ''}${focusKey === node.path ? ' kfocus' : ''}${dropDir === node.path ? ' dropt' : ''}`}
          style={treeRowStyle(depth)}
          tabIndex={tabTargetKey === node.path ? 0 : -1}
          onFocus={(e) => {
            if (e.target === e.currentTarget) {
              setFocusKey(node.path)
              onFocusedRowChange({ key: node.path, kind: 'folder' })
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            setFocusKey(node.path) // NOT focusRow — its deferred row.focus() would blur-close the menu
            onFocusedRowChange({ key: node.path, kind: 'folder' })
            openMenuFor(node.path, 'folder', { x: e.clientX, y: e.clientY })
          }}
          onDragOver={(e) => {
            if (!dragPath) return
            e.preventDefault()
            if (dropDir !== node.path) setDropDir(node.path)
          }}
          onDragLeave={() => {
            if (dropDir === node.path) setDropDir(null)
          }}
          onDrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            const dragged = dragPath
            setDragPath(null)
            setDropDir(null)
            if (dragged) void moveRowTo(dragged, node.path)
          }}
        >
          <button
            className="fchev"
            tabIndex={-1}
            aria-expanded={!isCollapsed}
            aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${node.name}`}
            onClick={() => { if (!focusedRow) toggleFolder(node.path) }}
          >
            <ChevronDown className="icon sm chev" />
            {isCollapsed
              ? <Folder className="icon sm" aria-label={folderPiecePaths.has(node.path) ? 'Folder Piece' : undefined} />
              : <FolderOpen className="icon sm" aria-label={folderPiecePaths.has(node.path) ? 'Folder Piece' : undefined} />}
          </button>
          <button className="fname" tabIndex={-1} title={agentFolder ? 'Agent notes — written by the agent, not by you' : (isVault && !prefs.titles ? (vaultTipFor(node)?.text ?? node.name) : node.name)} onClick={() => onOpenCollection(node.path)}>
            {node.name}
          </button>
          {dashboardButton(node.name, node.path, focusKey === node.path)}
          {pinButton(node.path, node.name)}
          {agentFolder && <Bot className="agent-provenance" aria-label="Agent-authored folder" />}
        </div>
        {/* A collapsed folder's rows are not drawn at all (R6): the ring (visibleRows) already skips them,
            and every path that lands on a row inside one expands its ancestors first. */}
        <div className="children" hidden={isCollapsed}>
          {isCollapsed ? null : renderNodes(node.children, depth + 1, node.path)}
        </div>
      </div>
    )
  }

  /** Where a Pinned row's menu stands when opened from the keyboard (the tree's own rows are found by path instead). */
  function pinRowMenuAt(key: string): { x: number; y: number } | undefined {
    const rect = rowElement(key)?.getBoundingClientRect()
    return rect ? { x: rect.left + 90, y: rect.bottom + 2 } : undefined
  }

  /** The drop slot under the pointer: before this row's index in its upper half, after it in its lower half. */
  const pinSlotAt = (e: React.DragEvent<HTMLElement>, index: number): number => {
    const rect = e.currentTarget.getBoundingClientRect()
    return e.clientY < rect.top + rect.height / 2 ? index : index + 1
  }
  const finishPinDrag = (): void => setPinDrag(null)

  /** A pinned document's icon: the one its tree row has (index note, scraps), else the file icon. */
  function pinnedDocumentGlyph(path: string): JSX.Element {
    const node = nodeFor(path)
    return node && node.kind === 'file' ? glyphFor(node) : <FileText className="icon sm" />
  }

  /** The PINNED section: grip, pin glyph, name, count (folders) or icon and name (documents), one shared order;
   *  a missing folder or document reads `not found` with Remove. */
  function pinnedSection(): JSX.Element {
    return (
      <>
        <div className="vd-pins" role="group" aria-label="Pinned folders and documents" data-testid="vault-pins">
          <div className="side-label lv-sideLabel">Pinned</div>
          {pinRows.map((row, index) => {
            const key = PIN_PREFIX + row.path
            const dragging = pinDrag?.path === row.path
            const isDocument = row.kind === 'document'
            const rowKind: 'file' | 'folder' = isDocument ? 'file' : 'folder'
            const open = (): void => {
              if (row.kind === 'document') onOpen(row.path)
              else if (row.kind === 'folder') onOpenCollection(row.path)
            }
            return (
              <div key={row.path} className="pin-slot">
                {pinDrag?.over === index && <div className="vd-drop" data-testid="vault-pin-drop" />}
                <div
                  data-row={key}
                  data-pin={row.path}
                  data-pin-kind={row.kind}
                  className={`trow lv-pin${row.missing ? ' missing' : ''}${dragging ? ' dragging' : ''}${focusKey === key ? ' kfocus' : ''}${!isDocument && dashboardDir === row.path ? ' dash-on' : ''}`}
                  style={{ paddingLeft: 8 }}
                  aria-current={isDocument && row.path === activePath ? 'true' : undefined}
                  title={row.missing ? `${row.path} was not found` : row.tip ? undefined : row.path}
                  {...(row.missing ? {} : tipHandlers(row.tip))}
                  tabIndex={tabTargetKey === key ? 0 : -1}
                  draggable
                  aria-label={row.missing ? `${row.path}, not found` : `${row.label}${row.countText ? `, ${row.countText}` : ''}`}
                  onFocus={(e) => {
                    if (e.target !== e.currentTarget) return
                    setFocusKey(key)
                    onFocusedRowChange(row.missing ? null : { key: row.path, kind: rowKind })
                  }}
                  onClick={open}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    if (row.missing) return
                    setFocusKey(key)
                    onFocusedRowChange({ key: row.path, kind: rowKind })
                    openMenuFor(row.path, rowKind, { x: e.clientX, y: e.clientY })
                  }}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('application/x-writeflex-pin', row.path)
                    setPinDrag({ path: row.path, over: null })
                  }}
                  onDragOver={(e) => {
                    if (!pinDrag) return
                    e.preventDefault()
                    e.stopPropagation()
                    const slot = pinSlotAt(e, index)
                    if (pinDrag.over !== slot) setPinDrag({ ...pinDrag, over: slot })
                  }}
                  onDrop={(e) => {
                    if (!pinDrag) return
                    e.preventDefault()
                    e.stopPropagation()
                    const next = movePin(pins ?? [], pinDrag.path, pinSlotAt(e, index))
                    setPinDrag(null)
                    if (next) void pinOp(() => window.writeflex.vault.reorderPins(next))
                  }}
                  onDragEnd={finishPinDrag}
                >
                  <span className="grip" aria-hidden="true"><GripVertical className="icon" /></span>
                  <Pin className="icon sm pin" aria-hidden="true" />
                  {isDocument && pinnedDocumentGlyph(row.path)}
                  <span className="flex-name">{row.label}</span>
                  {row.missing ? (
                    <>
                      <span className="cnt">not found</span>
                      <button
                        type="button"
                        className="vd-pinbtn show"
                        aria-label={`Remove ${row.path} from the pinned items`}
                        onMouseDown={keepFocus}
                        onClick={(e) => { e.stopPropagation(); void pinOp(() => window.writeflex.vault.removePin(row.path)) }}
                      >
                        Remove
                      </button>
                    </>
                  ) : (
                    <>
                      {!isDocument && <span className="cnt">{row.countText}</span>}
                      {row.unpinnable && (
                        <button
                          type="button"
                          className="vd-pinbtn vd-unpin"
                          title="Unpin from the top of the sidebar"
                          aria-label={`Unpin ${row.label}`}
                          tabIndex={-1}
                          draggable={false}
                          onMouseDown={keepFocus}
                          onClick={(e) => { e.stopPropagation(); e.preventDefault(); void pinOp(() => window.writeflex.vault.removePin(row.path)) }}
                        >
                          <PinOff className="icon" aria-hidden="true" />
                          <span className="rb-lbl">Unpin</span>
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            )
          })}
          {pinDrag?.over === pinRows.length && <div className="vd-drop" data-testid="vault-pin-drop" />}
        </div>
        <div className="side-sep" style={{ margin: '6px 14px' }} />
      </>
    )
  }

  /** The Pin button at the end of a tree row (a vault's folders and `.md` documents that are not pinned yet). */
  function pinButton(path: string, name: string, asSpan = false, kind: 'file' | 'folder' = 'folder'): JSX.Element | null {
    if (!pinnable(path, kind) || pinSet.has(path)) return null
    const add = (e: React.MouseEvent): void => {
      e.stopPropagation()
      e.preventDefault()
      void pinOp(() => window.writeflex.vault.addPin(path))
    }
    const props = { className: 'vd-pinbtn', title: 'Pin to the top of the sidebar', 'aria-label': `Pin ${name} to the top of the sidebar`, tabIndex: -1, onClick: add, onMouseDown: keepFocus }
    return asSpan
      ? <span role="button" {...props}><Pin className="icon" aria-hidden="true" /><span className="rb-lbl">Pin</span></span>
      : <button type="button" {...props}><Pin className="icon" aria-hidden="true" /><span className="rb-lbl">Pin</span></button>
  }

  function renderNodes(nodes: TreeNode[], depth: number, directory: string): JSX.Element[] {
    const rendered = nodes.map((node) => (node.kind === 'folder' ? (node.work ? workFolderRow(node, depth) : folderRow(node, depth)) : fileRow(node, depth)))
    if (renaming?.isNew && renaming.directory === directory) {
      rendered.push(renameRow(renaming.kind, depth, '', NEW_KEY))
    }
    return rendered
  }

  const menuNode = menu ? nodeFor(menu.key) : null
  const moveNode = movePick ? nodeFor(movePick.key) : null
  const binNode = binAsk ? nodeFor(binAsk.key) : null
  const moveOptions = movePick
    ? [
        ...allFolders
          .filter((dir) => {
            const slash = movePick.key.lastIndexOf('/')
            const currentDir = slash === -1 ? '' : movePick.key.slice(0, slash)
            return dir !== currentDir
          })
          .map((dir) => ({ label: dir, dir: dir as string | null })),
        ...(movePick.key.includes('/') ? [{ label: 'Workspace root', dir: null }] : []),
      ]
    : []

  return (
    <>
      <div className="ws-row lv-root">
        <ChevronDown className="icon sm" aria-hidden="true" />
        {/* The root name is the vault switcher on a vault and on a plain folder alike (spec § Sidebar);
            a plain folder's dashboard is its Folder dashboard button beside it. */}
        <button
          ref={rootNameRef}
          className="wsname"
          title="Switch vault or open a folder"
          aria-haspopup="menu"
          aria-expanded={switcherOpen === true}
          onClick={() => onSwitcherOpenChange?.(!switcherOpen)}
        >
          <span>{isVault ? vault.settings.name : workspaceName}</span>
          <ChevronsUpDown className="icon sm" aria-hidden="true" />
        </button>
        {!isVault && dashboardButton(workspaceName, '', false, true)}
        {onOpenSharesList && (
          <button className={`fdash${sharesListOn ? ' on' : ''}`} title={`Shares list for ${workspaceName}`} aria-label={`Shares list for ${workspaceName}`} aria-pressed={sharesListOn} data-testid="shares-list-button" onClick={onOpenSharesList}>
            <Link2 className="icon" aria-hidden="true" />Shares
          </button>
        )}
        <span className="spacer" />
        <button className="tbtn" title="Filter files" aria-label="Filter files" onClick={() => {
          setFilterVisible(true)
        }}>
          <span className="filter-glyph" aria-hidden="true">⌕</span>
        </button>
      </div>
      {isVault && vaultIndex && (
        <div className="lv-count">
          <span>{vaultCountText(vaultIndex.works, vault.settings.statusMap)}</span>
          {/* Until the vault dashboard exists this opens today's Folder dashboard for the root. */}
          <button
            className={`fdash${dashboardDir === '' ? ' on' : ''}`}
            title="Open the dashboard"
            aria-label={`Dashboard for ${vault.settings.name}`}
            onClick={() => onOpenCollection('')}
          >
            Dashboard
          </button>
        </div>
      )}
      {isVault && (
        <div className="lv-fbar">
          <div className="l1">
            <span className={`lv-sel${prefs.writingOnly ? ' on' : ''}`}>
              <select
                aria-label="Which files the sidebar shows"
                value={prefs.writingOnly ? 'writing' : 'all'}
                onChange={(event) => choosePrefs({ writingOnly: event.target.value === 'writing' })}
              >
                <option value="writing">Writing only</option>
                <option value="all">All files</option>
              </select>
              <ChevronDown className="icon sm" aria-hidden="true" />
            </span>
            <div className="lv-seg" role="radiogroup" aria-label="Show in sidebar">
              {([['Titles', true], ['File names', false]] as const).map(([label, value]) => (
                <button
                  key={label}
                  type="button"
                  role="radio"
                  aria-checked={prefs.titles === value}
                  tabIndex={prefs.titles === value ? 0 : -1}
                  className={prefs.titles === value ? 'on' : ''}
                  onClick={() => choosePrefs({ titles: value })}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                    event.preventDefault()
                    choosePrefs({ titles: !prefs.titles })
                    const sibling = event.currentTarget.parentElement?.querySelector<HTMLElement>('button:not([aria-checked="true"])')
                    requestAnimationFrame(() => sibling?.focus())
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {prefs.writingOnly
            ? vaultIndex && (
              <div className="l2">
                <span>{vaultIndex.hidden.countText}</span>
                <button type="button" className="lv-link" onClick={() => choosePrefs({ writingOnly: false })}>Show all files</button>
              </div>
            )
            : (
              <div className="l2">
                <span>Showing everything in the folder</span>
                <button type="button" className="lv-link" onClick={() => choosePrefs({ writingOnly: true })}>Writing only</button>
              </div>
            )}
        </div>
      )}
      {!isVault && pieceCount !== undefined && (
        <div className="ws-count">
          {pieceCount} {pieceCount === 1 ? 'piece' : 'pieces'} · {folderPiecePaths.size} folder {folderPiecePaths.size === 1 ? 'piece' : 'pieces'}
        </div>
      )}
      {tip && <div className="lv-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>{tip.mono ? <code>{tip.text}</code> : tip.text}</div>}
      {switcherOpen && switcherAt && (
        <VaultSwitcherMenu
          x={switcherAt.x}
          y={switcherAt.y}
          currentIsVault={isVault}
          onClose={() => closeSwitcher(true)}
          onChoose={(choice) => {
            closeSwitcher(choice.kind === 'root' && choice.current)
            if (!(choice.kind === 'root' && choice.current)) onSwitcherChoose?.(choice)
          }}
        />
      )}

      {filterVisible && <div className="file-filter" aria-label="Filter files">
        <div className="facet-search file-filter-search">
          <Search className="icon sm" aria-hidden="true" />
          <input
            ref={filterInputRef}
            type="text"
            value={filterQuery}
            onChange={(event) => setFilterQuery(event.target.value)}
            onKeyDown={onFilterKeyDown}
            placeholder="Filter tree — ⇧⌘K finds by name"
            aria-label="Filter files by name"
            spellCheck={false}
          />
          {filterQuery && (
            <button className="filter-clear" aria-label="Clear file filter" title="Clear filter (Esc)" onClick={() => setFilterQuery('')}>
              <X className="icon sm" />
            </button>
          )}
        </div>
        <div className="file-filter-count">{visibleRows.filter((row) => row.kind === 'file').length} of {filesInFocus} · Esc clears</div>
      </div>}

      <div className="tree-region" ref={treeRef} onKeyDown={onTreeKeyDown}>
      {showPinned && <div className={`tree-pinned${isVault ? ' lv-vault' : ''}`}>{pinnedSection()}</div>}
      <div
        className={`tree${isVault ? ' lv-vault' : ''}`}
        onDragOver={(e) => {
          if (dragPath) e.preventDefault()
        }}
        onDrop={(e) => {
          // Dropping on tree background = move to workspace root (the mockup's fallback target).
          e.preventDefault()
          const dragged = dragPath
          setDragPath(null)
          setDropDir(null)
          if (dragged && dragged.includes('/')) void moveRowTo(dragged, null)
        }}
      >
        <>
            {shownTree.length > 0 || renaming?.isNew ? (
              renderNodes(shownTree, 0, '')
            ) : hasFilter || !focusPath ? (
              <div className="filter-empty">
                No names match <span>{filterQuery.trim()}</span>.
              </div>
            ) : null}

            {!hasFilter && (
              <>
                <div className="side-sep" />
                <div className="side-label">Favourites</div>
                {favFiles.map((file) => (
                  <button
                    key={`fav:${file.path}`}
                    className="trow"
                    aria-current={file.path === activePath ? 'true' : undefined}
                    title={file.path}
                    onClick={() => onOpen(file.path)}
                  >
                    <span className="gtr" aria-hidden="true" />
                    <StarButton path={file.path} on onToggle={onToggleFavourite} />
                    <span className="flex-name">{file.name}</span>
                  </button>
                ))}

                <div className="side-sep" />
                <button className="trow" title="Archive" aria-label="Archive" onClick={() => onStatus('Archive lands later in this build')}>
                  <span className="gtr" aria-hidden="true" />
                  <Archive className="icon sm" />
                  <span className="flex-name">Archive</span>
                </button>
                <button className="trow" title="Trash" aria-label="Trash" onClick={() => onStatus('Trash lands later in this build')}>
                  <span className="gtr" aria-hidden="true" />
                  <Trash2 className="icon sm" />
                  <span className="flex-name">Trash</span>
                </button>
              </>
            )}
          </>
      </div>
      </div>

      <div className="side-foot">
        <button
          className="tbtn"
          title="New file (⌘N)"
          aria-label="New file"
          onClick={() => onRequestCreate('file')}
        >
          <Plus className="icon" />
        </button>
        <button
          className="tbtn"
          title="New folder (⌃⌘N)"
          aria-label="New folder"
          onClick={() => onRequestCreate('folder')}
        >
          <FolderPlus className="icon" />
        </button>
        <button className="tbtn" title="Tags" aria-label="Tags" onClick={() => onStatus('Tags land later in this build')}>
          <Tag className="icon" />
        </button>
        <span className="gap" />
        {version && (
          <button className="side-version" type="button" title="About WriteFlex" aria-label="About WriteFlex" onClick={() => onOpenSettings('sec-about')}>
            {version}
          </button>
        )}
        <button className="tbtn" title="Settings (⌘,)" aria-label="Settings" onClick={() => onOpenSettings()}>
          <Settings className="icon" />
        </button>
      </div>

      {menu && menuNode && (
        <ActionsHere
          x={menu.x}
          y={menu.y}
          place={placeOfRow(menu.kind === 'file' ? { kind: 'file' } : { kind: 'folder', focused: menu.key === focusPath })}
          runHere={runRowCommand}
          extraRows={pinnable(menu.key, menu.kind) ? [pinSet.has(menu.key)
            ? { id: 'vault.unpin', label: 'Unpin', chords: [], keywords: 'unpin pinned remove', icon: PinOff }
            : { id: 'vault.pin', label: 'Pin to the top', chords: [], keywords: 'pin pinned top', icon: Pin }] as ActionRow[] : undefined}
          onClose={(reason) => {
            setMenu(null)
            if (reason === 'dismiss' && focusKey) focusRow(focusKey)
          }}
        />
      )}
      {movePick && moveNode && (
        <MoveFolderPicker
          x={movePick.x}
          y={movePick.y}
          fileName={moveNode.name}
          options={moveOptions}
          onPick={(dir) => void moveRowTo(movePick.key, dir)}
          onClose={() => {
            setMovePick(null)
            if (focusKey) focusRow(focusKey)
          }}
        />
      )}
      {binAsk && binNode && (
        <BinPopover
          x={binAsk.x}
          y={binAsk.y}
          name={binNode.name}
          fileCount={binNode.kind === 'folder' ? countFiles(binNode) : undefined}
          onConfirm={() => void confirmBin()}
          onCancel={() => {
            setBinAsk(null)
            if (focusKey) focusRow(focusKey)
          }}
        />
      )}
    </>
  )
}

function countFiles(folder: TreeFolder): number {
  let n = 0
  const walk = (nodes: TreeNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'file') n += 1
      else walk(node.children)
    }
  }
  walk(folder.children)
  return n
}

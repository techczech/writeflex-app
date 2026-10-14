import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { commandRan } from '../commands/command-ran'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  Archive,
  BookOpenText,
  Bot,
  ChevronDown,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Plus,
  Search,
  Settings,
  Star,
  StickyNote,
  Tag,
  Trash2,
  X,
} from 'lucide-react'
import type { MarkdownFile } from '../../../preload'
import { NO_CHECKLIST_PROGRESS, type ChecklistProgressMap } from '../hooks/useChecklistProgress'
import { ChecklistProgressChip } from './ChecklistProgressChip'
import { buildTree, filterTreeByName, focusTree, isInFocus, type TreeFile, type TreeFolder, type TreeNode } from '../sidebar-tree'
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
}

export type SidebarFocusedRow = { key: string; kind: 'file' | 'folder' }
export type SidebarTreeFocusRequest = { tick: number; target: SidebarFocusedRow | null }
type RowRef = SidebarFocusedRow
type Renaming = { key: string; kind: 'file' | 'folder'; isNew: boolean; directory: string }
type Anchored = { key: string; kind: 'file' | 'folder'; x: number; y: number }

const NEW_KEY = '__new__'
const TREE_ROW_BASE_PX = 8
const TREE_DEPTH_STEP_PX = 14

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
 */
export function Sidebar({
  files,
  checklistProgress = NO_CHECKLIST_PROGRESS,
  folders,
  pieceCount,
  folderPiecePaths = new Set(),
  favourites,
  activePath,
  onOpen,
  onToggleFavourite,
  onOpenCollection,
  dashboardDir = null,
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
}: SidebarProps): JSX.Element {
  const tree = useMemo(() => buildTree(files, folders), [files, folders])
  const focusedTree = useMemo(() => focusTree(tree, focusPath), [tree, focusPath])
  const favSet = useMemo(() => new Set(favourites), [favourites])
  const favFiles = useMemo(
    () => files.filter((f) => favSet.has(f.path)).sort((a, b) => a.name.localeCompare(b.name)),
    [files, favSet],
  )

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
  const shownTree = useMemo(() => filterTreeByName(focusedTree, filterQuery), [focusedTree, filterQuery])
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
  }, [shownTree, collapsed, hasFilter, focusPath])

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
    onFocusedRowChange(focusKey ? rowRef(focusKey) : null)
  }, [focusKey, onFocusedRowChange, rowRef])
  useEffect(() => () => onFocusedRowChange(null), [onFocusedRowChange])
  const rowElement = useCallback(
    (key: string): HTMLElement | null => treeRef.current?.querySelector(`[data-row="${CSS.escape(key)}"]`) ?? null,
    [],
  )
  const focusRow = useCallback(
    (key: string | null) => {
      setFocusKey(key)
      onFocusedRowChange(key ? rowRef(key) : null)
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
    const action = ROW_ACTION_OF[commandId]
    if (!action) return false
    runMenuAction(action)
    return true
  }, [runMenuAction])

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
    if (e.key === 'ArrowDown') {
      focusRow(visibleRows[Math.min(idx + 1, visibleRows.length - 1)]?.key ?? null)
    } else if (e.key === 'ArrowUp') {
      focusRow(visibleRows[Math.max(idx - 1, 0)]?.key ?? null)
    } else if (e.key === 'ArrowRight' && current?.kind === 'folder') {
      setFolderCollapsed(current.key, false)
    } else if (e.key === 'ArrowLeft' && current) {
      if (current.kind === 'folder' && !collapsed.has(current.key)) {
        setFolderCollapsed(current.key, true)
      } else {
        const slash = current.key.lastIndexOf('/')
        if (slash !== -1) {
          const parent = current.key.slice(0, slash)
          setFolderCollapsed(parent, true)
          focusRow(parent)
        }
      }
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
    return (
      <button
        key={node.path}
        data-row={node.path}
        className={`trow${node.path.split('/').includes('agent-notes') ? ' agent-authored' : ''}${focusKey === node.path ? ' kfocus' : ''}${dragPath === node.path ? ' dragged' : ''}${shakeKey === node.path ? ' shake' : ''}`}
        style={treeRowStyle(depth)}
        aria-current={active ? 'true' : undefined}
        title={node.path}
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
        <span className="flex-name">{node.name}</span>
        <ChecklistProgressChip path={node.path} progress={checklistProgress} />
        {node.path.split('/').includes('agent-notes') && <Bot className="agent-provenance" aria-label="Agent-authored Piece" />}
        <StarButton path={node.path} on={favSet.has(node.path)} onToggle={onToggleFavourite} />
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
        onClick={() => onOpenCollection(dir)}
      >
        Folder dashboard
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
          <button className="fname" tabIndex={-1} title={agentFolder ? 'Agent notes — written by the agent, not by you' : node.name} onClick={() => onOpenCollection(node.path)}>
            {node.name}
          </button>
          {dashboardButton(node.name, node.path, focusKey === node.path)}
          {agentFolder && <Bot className="agent-provenance" aria-label="Agent-authored folder" />}
        </div>
        <div className="children" hidden={isCollapsed}>
          {renderNodes(node.children, depth + 1, node.path)}
        </div>
      </div>
    )
  }

  function renderNodes(nodes: TreeNode[], depth: number, directory: string): JSX.Element[] {
    const rendered = nodes.map((node) => (node.kind === 'folder' ? folderRow(node, depth) : fileRow(node, depth)))
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
      <div className="ws-row">
        <ChevronDown className="icon sm" aria-hidden="true" />
        <button className="wsname" title={`Open ${workspaceName} collection`} onClick={() => onOpenCollection('')}>{workspaceName}</button>
        {dashboardButton(workspaceName, '', false, true)}
        <span className="spacer" />
        <button className="tbtn" title="Filter files" aria-label="Filter files" onClick={() => {
          setFilterVisible(true)
        }}>
          <span className="filter-glyph" aria-hidden="true">⌕</span>
        </button>
      </div>
      {pieceCount !== undefined && (
        <div className="ws-count">
          {pieceCount} {pieceCount === 1 ? 'piece' : 'pieces'} · {folderPiecePaths.size} folder {folderPiecePaths.size === 1 ? 'piece' : 'pieces'}
        </div>
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

      <div
        className="tree"
        ref={treeRef}
        onKeyDown={onTreeKeyDown}
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

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import { commandRan } from '../commands/command-ran'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bookmark, ChevronDown, Columns3, ListOrdered, MessageSquareDashed, Search, SquareCheck, SquareMinus, SquarePlus } from 'lucide-react'
import { EditorView } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'
import type { EditorHandle } from './EditorPane'
import { FileRowMenu, type FileMenuItem } from './file-menu'
import { ActionsHere } from './ActionsHere'
import type { FolioOutline, FolioPlace, OutlineScanEntry } from '../../../preload'
import { FolderPartFoot, FolioOutlinePart, folioFileKeys } from './FolioOutline'
import type { FolioRunningOrder } from '../app/folio-running-order'
import { commandTarget, type FocusedFolioRow } from '../../../shared/folio-running-order'
import { clampOffset, outlineSwitch } from '../../../shared/folio-outline'
import { extractOutline, type OutlineHeading } from '../editor/outline'
import type { EditorSnapshot } from '../hooks/useEditorSnapshot'
import { dispatchSectionsEdit, outlineSelectionField, runSectionAction, setOutlineSelection, type SectionAction } from '../editor/outline-selection'
import {
  deepestLevel,
  dropSection,
  headingIndexAt,
  hiddenBeneath,
  levelVisibility,
  sectionRoots,
  sectionWordCounts,
  shiftSections,
  wordsInSections,
} from '../editor/outline-sections'
import { eventToChord } from '../app/shortcuts'
import { splitChord } from '../commands/chords'
import { classifyOutlineKey, emptySpaceFocusTarget, extendSelection } from '../editor/outline-keys'
// The jumps scanner is a PURE module (no Electron/Node imports), so the renderer can run it against
// the LIVE editor buffer — unsaved bookmarks/comments/tasks appear in the facet list immediately,
// where the disk-backed jumps:scan channel would miss them. Folder scope (Task 10) uses the channel.
import { scanText, type JumpKind } from '../../../main/jumps'

/** What the palette asks the panel to do (the display commands live here, not in the editor). */
export type OutlineRequest = {
  tick: number
  action: 'expandAll' | 'collapseAll' | 'toggleWordCounts' | 'rowMenu' | { levels: number | null }
}

type OutlinePaneProps = {
  /** The window's editor handle — the panel resolves jump offsets off the live doc and jumps through it. */
  editorRef: RefObject<EditorHandle | null>
  /** The shared debounced editor snapshot (App's useEditorSnapshot): the doc text this pane scans for
   *  jumps, the heading outline (parsed ONCE for the whole app), and the caret for cursor-follow. */
  snapshot: EditorSnapshot | null
  /** The path currently in the editor; a change resets this pane's collapse + focus state. */
  activePath: string | null
  /** Folder scope: land the caret on a line of a (possibly other) file — opens it first if needed. */
  onJumpToFile: (file: string, line: number) => void
  /** Bumped by App each time a save completes. Folder scope is disk-backed, so it must re-scan when a
   *  save lands a new `//@`/`//`/task on disk — otherwise the view ignores the save the user just made. */
  savedTick: number
  /** Bumped by App each time the outline OPENS (⇧⌘O, menu, palette, toolbar). A fresh bump lands the
   *  keyboard on the active row so the writer can Arrow around at once — deferred here because the
   *  shared snapshot may not have populated the rows at the instant the pane un-hides. */
  focusTick: number
  /** The writer's effective chord for a command id (display glyphs), or null. The panel shows these in
   *  its menu and bar and matches the structure chords against them while it has focus. */
  shortcutFor: (commandId: string) => string | null
  /** A display command from the palette (expand/collapse all, levels, word counts). */
  request: OutlineRequest | null
  /** Where the open file sits in its Folio (null = in none): it decides whether the second part is the Folio or the Folder. */
  folioPlace: FolioPlace | null
  /** Files listed under the open file's folder (sub-folders included), for the Folder part's foot. */
  folderFileCount: number
  /** Open a file (a piece, or one of "Also in this folder"). */
  onOpenFile: (path: string) => void
  /** The Folio part's Plan and Board buttons. */
  onOpenPlan: () => void
  onOpenBoard: () => void
  onStatus: (message: string) => void
  /** The Folio part's running-order changes: moves, Add, Undo, and what they announce. */
  runningOrder: FolioRunningOrder
  /** Bumped by App after a running-order write: the Folio part reads again at once. */
  folioRefreshTick: number
}

/** The structure commands the panel answers while it has focus: the editor's own ids, so one binding. */
const CHORD_ACTIONS: ReadonlyArray<readonly [string, SectionAction]> = [
  ['heading.decrease', 'promote'],
  ['outline.raiseSubtreeLevel', 'promote'],
  ['heading.increase', 'demote'],
  ['outline.lowerSubtreeLevel', 'demote'],
  ['outline.moveBlockUp', 'moveUp'],
  ['outline.moveSubtreeUp', 'moveUp'],
  ['outline.moveBlockDown', 'moveDown'],
  ['outline.moveSubtreeDown', 'moveDown'],
]

/** The commands that act at the caret: from an outline row they are run with the caret on the row's heading. */
const CARET_COMMANDS: ReadonlySet<string> = new Set(['outline.selectCurrentSection', 'outline.newHeadingBefore', 'outline.newSubheading'])

/** Chords compare by their modifier SET: the registry writes ⇧⌥⌘ where eventToChord reads ⌥⇧⌘. */
function sameChord(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  const left = splitChord(a)
  const right = splitChord(b)
  return left.key === right.key && [...left.mods].sort().join('') === [...right.mods].sort().join('')
}

const WORD_COUNTS_KEY = 'wf:outlineWordCounts'
/** Pixels of sideways drag per heading level. */
const LEVEL_STEP_PX = 16

/** Document ⟷ second part (PRD S18). The second part is the Folder (the active file's folder + subfolders) or,
 *  when the file is in a Folio, the Folio. The writer's choice is the part, not its name, so it holds across both. */
type Scope = 'file' | 'folder'

/** A stable empty-outline reference so the `entries` memo is not invalidated while no snapshot exists. */
const EMPTY_HEADINGS: OutlineHeading[] = []

/** The three jump kinds, in the facet chip order the mockup fixes (bookmark, comment, task). */
const FACETS: ReadonlyArray<{ kind: JumpKind; label: string; Icon: typeof Bookmark }> = [
  { kind: 'bookmark', label: 'Bookmarks', Icon: Bookmark },
  { kind: 'comment', label: 'Comments', Icon: MessageSquareDashed },
  { kind: 'task', label: 'Tasks', Icon: SquareCheck },
]

/** A heading or a jump target, located to a document offset — the merged unit the outline renders. */
type Entry =
  | { type: 'heading'; from: number; level: number; text: string }
  | { type: 'jump'; from: number; kind: JumpKind; line: number; text: string; done?: boolean }

/** One row in the merged tree, carrying the structural facts the keyboard + collapse model needs. */
type Row = {
  entry: Entry
  depth: number
  parentFrom: number | null
  hasChildren: boolean
  isCollapsed: boolean
  /** False when an ancestor heading is collapsed (browse mode hides it; filter mode ignores this). */
  visible: boolean
}

/**
 * Merge headings and jumps into one ordered, structured row list. Headings nest by level (a heading's
 * parent is the nearest preceding heading of lower level) and a heading becomes a collapsible parent
 * ONLY when it has heading children — the locked mockup renders jumps as FLAT siblings, so a bookmark,
 * comment, or task never gives its surrounding heading a chevron. Each jump joins the list at its
 * surrounding heading's child level (26px nested) but inherits that heading's OWN visibility: collapsing
 * the surrounding heading does NOT hide its jumps; a jump hides only when its surrounding heading is
 * itself hidden by a collapsed ANCESTOR heading (then the whole section, subheadings included, folds
 * away). With no jumps this reproduces the Task 8 heading tree exactly.
 */
function buildRows(entries: Entry[], collapsed: Set<number>): Row[] {
  const rows: Row[] = []
  // Each open heading section carries its OWN `visible` (false when an ancestor heading is collapsed)
  // and its `collapsed` state; a jump reads the top frame to inherit its position and visibility.
  const stack: Array<{ from: number; level: number; collapsed: boolean; visible: boolean }> = []
  const indexByFrom = new Map<number, number>()
  // Only a heading child gives a heading a chevron — jumps are flat siblings, never children.
  const markHeadingParent = (parentFrom: number | null): void => {
    if (parentFrom != null) rows[indexByFrom.get(parentFrom)!].hasChildren = true
  }
  for (const entry of entries) {
    if (entry.type === 'heading') {
      while (stack.length && stack[stack.length - 1].level >= entry.level) stack.pop()
      const parent = stack.length ? stack[stack.length - 1] : null
      const parentFrom = parent ? parent.from : null
      // Hidden when an ancestor is collapsed: the parent is itself hidden, or the parent is collapsed.
      const visible = parent ? parent.visible && !parent.collapsed : true
      const isCollapsed = collapsed.has(entry.from)
      const index =
        rows.push({ entry, depth: stack.length, parentFrom, hasChildren: false, isCollapsed, visible }) - 1
      indexByFrom.set(entry.from, index)
      markHeadingParent(parentFrom)
      stack.push({ from: entry.from, level: entry.level, collapsed: isCollapsed, visible })
    } else {
      const parent = stack.length ? stack[stack.length - 1] : null
      // A flat sibling at the surrounding heading's child level: it does NOT mark that heading a parent
      // (no chevron), and it inherits the heading's OWN visibility so the heading's collapse never hides
      // it — only a collapsed ANCESTOR (which hides the surrounding heading itself) folds it away.
      rows.push({
        entry,
        depth: stack.length,
        parentFrom: parent ? parent.from : null,
        hasChildren: false,
        isCollapsed: false,
        visible: parent ? parent.visible : true,
      })
    }
  }
  return rows
}

/** One folder-scope row: a heading or a jump located to a file + 1-based line, keyed for roving focus. */
type FolderRow = {
  key: string
  file: string
  line: number
  kind: JumpKind | 'heading'
  text: string
  done?: boolean
}
/** A folder-scope file group: its label (the basename, uppercased in CSS) and its surviving rows. */
type FolderGroup = { file: string; label: string; rows: FolderRow[] }

/** The `//` marker stays visible on comment rows so the annotation's origin reads at a glance. */
function folderRowLabel(row: FolderRow): string {
  return row.kind === 'comment' ? `// ${row.text}` : row.text
}

/**
 * Turn a flat, path-ordered folder scan into file groups (the disk-backed scanner already yields files
 * in path order — the Folio ordering seam lives there, Task 24). `facet`/`needle` filter ACROSS the
 * whole scope first (a facet drops headings and the other jump kinds; the text narrows further); a
 * group with no surviving rows is dropped so its label never renders over an empty section.
 */
function groupFolderEntries(entries: OutlineScanEntry[], facet: JumpKind | null, needle: string): FolderGroup[] {
  const groups: FolderGroup[] = []
  let current: FolderGroup | null = null
  entries.forEach((entry, i) => {
    if (facet !== null && entry.kind !== facet) return
    const text = entry.text
    if (needle && !text.toLowerCase().includes(needle)) return
    if (!current || current.file !== entry.file) {
      current = { file: entry.file, label: entry.file.split('/').at(-1) ?? entry.file, rows: [] }
      groups.push(current)
    }
    current.rows.push({
      key: `${entry.file}::${entry.line}::${entry.kind}::${i}`,
      file: entry.file,
      line: entry.line,
      kind: entry.kind,
      text,
      done: entry.kind === 'task' ? entry.done : undefined,
    })
  })
  return groups
}

/** What a section drag is showing right now (nothing is edited until the pointer is released). */
type DragView = {
  from: number
  /** 'move' = vertical (drop before a row); 'level' = sideways (change the level). */
  mode: 'move' | 'level' | 'none'
  /** For 'move': the heading to land before, null = the end of the document. */
  beforeFrom: number | null
  /** For 'level': levels to add (+ demotes, − promotes). */
  delta: number
  label: string
  x: number
  y: number
}

/** Rows between a heading and the end of its section (the heading itself included). */
function sectionRowCount(headings: readonly OutlineHeading[], index: number): number {
  let end = index + 1
  while (end < headings.length && headings[end].level > headings[index].level) end += 1
  return end - index
}

function sameSet(a: ReadonlySet<number>, list: readonly number[]): boolean {
  return a.size === list.length && list.every((value) => a.has(value))
}

/**
 * The outline pane (PRD S16/S17): the open file's headings as a collapsible tree, merged with the
 * jumps scanner's bookmarks / `//` comments / tasks positioned in their heading sections. The whole
 * list is ONE tab stop (roving tabindex — the active row is `tabIndex=0`, the rest `-1`); Arrow keys
 * move between visible rows and collapse/expand; Enter/Space jumps the caret (scrollIntoView y:start)
 * and the active heading follows the cursor via a debounced selection listener.
 *
 * The facet row filters that list: one facet chip narrows to a single jump kind, the search field
 * narrows by text (both together). In filter mode the list flattens — collapse is ignored so a match
 * inside a folded section still shows — and returns to the collapsible tree when both are cleared.
 *
 * Outline package (tickets 13 and 17): the current heading follows the cursor and scrolls into view;
 * rows drag up/down to move a section and sideways to change its level; ⌘/⇧-click picks several; the
 * header bar, Levels drop-down and right-click menu run the structure commands; rows can show word counts.
 */
export function OutlinePane({ editorRef, snapshot: sharedSnapshot, activePath, onJumpToFile, savedTick, focusTick, shortcutFor, request, folioPlace, folderFileCount, onOpenFile, onOpenPlan, onOpenBoard, onStatus, runningOrder, folioRefreshTick }: OutlinePaneProps): JSX.Element {
  const [chosenPart, setScope] = useState<Scope>('file')
  // With no file open there is no folder to list: the Document part shows, whatever was chosen.
  const scope: Scope = activePath == null ? 'file' : chosenPart
  const folioPart = scope === 'folder' && folioPlace !== null
  const second = outlineSwitch(activePath != null, folioPlace)
  // The Folio part (read-only): the Folio's pieces and the folder's other files with their headings, from main.
  const [folioOutline, setFolioOutline] = useState<FolioOutline | null>(null)
  const [folioExpanded, setFolioExpanded] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const [folioChanged, setFolioChanged] = useState(0)
  const [folioFocused, setFolioFocused] = useState<FocusedFolioRow>(null)
  const [folioBusy, setFolioBusy] = useState(false)
  // Collapsed sections, keyed by heading start offset; reset when the file changes.
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set())
  // The row that holds the roving tabindex (and DOM focus during keyboard nav). Distinct from
  // `activeFrom`, which is the cursor-follow highlight. Falls back to the first shown row.
  const [focusFrom, setFocusFrom] = useState<number | null>(null)
  // Facet row state: at most one active kind (mockup behaviour), plus a free-text narrow. Shared by
  // both scopes — the facet chips and filter operate across the whole folder scope too.
  const [facet, setFacet] = useState<JumpKind | null>(null)
  const [filter, setFilter] = useState('')
  // Folder scope (disk-backed): the aggregated scan for the active file's folder, and this list's
  // own single roving tab stop (keyed by the folder row's string key, not a document offset).
  const [folderEntries, setFolderEntries] = useState<OutlineScanEntry[]>([])
  const [folderFocusKey, setFolderFocusKey] = useState<string | null>(null)
  // Extras (ticket 17): Levels limit, word counts, several-picked sections, menus, delete confirmation, drag.
  const [levelLimit, setLevelLimit] = useState<number | null>(null)
  const [showCounts, setShowCounts] = useState<boolean>(() => {
    // On by default (the approved frame 4); '0' is the writer's choice to turn them off.
    try { return localStorage.getItem(WORD_COUNTS_KEY) !== '0' } catch { return true }
  })
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set())
  const [anchorFrom, setAnchorFrom] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; from: number } | null>(null)
  const [levelsMenu, setLevelsMenu] = useState<{ x: number; y: number } | null>(null)
  const [confirm, setConfirm] = useState<{ froms: number[]; words: number } | null>(null)
  const [drag, setDrag] = useState<DragView | null>(null)

  const listRef = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef<number | null>(null)
  const suppressClick = useRef(false)
  const levelsButtonRef = useRef<HTMLButtonElement>(null)

  // Headings come straight from the SHARED snapshot (App's useEditorSnapshot parses the outline once
  // for the whole app), so this pane no longer runs its own extractOutline. A stable empty fallback
  // keeps `entries` memoised through the no-snapshot window and any render where the outline is unchanged.
  // The snapshot trails a tab switch by its debounce: until it is read from the open file's buffer it is
  // the previous file's, so it is not used at all (no headings, jumps or cursor-follow from another file).
  const snapshot = sharedSnapshot && sharedSnapshot.path === activePath ? sharedSnapshot : null
  const headings = snapshot?.outline ?? EMPTY_HEADINGS
  // A file is open but the snapshot of ITS buffer has not arrived: "waiting", which is not "no headings".
  const waiting = activePath != null && snapshot === null

  // Jumps stay this pane's own concern (PRD S16): scan the shared doc text for bookmarks / `//`
  // comments / tasks and resolve each to a start offset off the live doc. Keyed on the doc TEXT (a
  // primitive), so a cursor-only move — same text — reuses the previous scan rather than re-running it.
  const docText = snapshot?.docText
  const jumps = useMemo<Array<Extract<Entry, { type: 'jump' }>>>(() => {
    const view = editorRef.current?.view()
    if (docText == null || !view) return []
    const doc = view.state.doc
    // File scope asks scanText for jumps only (headings come from the shared outline), so the heading
    // variant of ScannedEntry never appears here — this narrows the union to the jump kinds.
    return scanText(docText)
      .filter((j): j is Extract<typeof j, { kind: JumpKind }> => j.kind !== 'heading')
      .map((j) => ({
        type: 'jump' as const,
        // A jump's identity is its line; resolve it to a start offset for ordering, keying, and jumping.
        from: doc.line(Math.min(Math.max(j.line, 1), doc.lines)).from,
        kind: j.kind,
        line: j.line,
        text: j.text,
        done: j.done,
      }))
  }, [docText, editorRef])

  // Cursor-follow: the heading whose section the caret sits in, from the shared outline + selection.
  const activeIndex = useMemo(() => (snapshot ? headingIndexAt(snapshot.outline, snapshot.selHead) : -1), [snapshot])
  const activeFrom = activeIndex >= 0 && snapshot ? snapshot.outline[activeIndex].from : null

  // A new file: forget the previous file's collapse + focus state. The shared snapshot re-derives the
  // outline itself — App's useEditorSnapshot schedules that recompute on this same activePath change.
  useEffect(() => {
    setCollapsed(new Set())
    setFocusFrom(null)
    setSelected(new Set())
    setAnchorFrom(null)
    setMenu(null)
    setLevelsMenu(null)
    setConfirm(null)
  }, [activePath])

  const entries = useMemo<Entry[]>(() => {
    const merged: Entry[] = [
      ...headings.map((h) => ({ type: 'heading' as const, from: h.from, level: h.level, text: h.text })),
      ...jumps,
    ]
    // Document order; a heading and a jump can never share an offset, but keep headings first on a tie.
    merged.sort((a, b) => a.from - b.from || (a.type === 'heading' ? -1 : 1))
    return merged
  }, [headings, jumps])

  const allRows = useMemo(() => buildRows(entries, collapsed), [entries, collapsed])

  const isFiltering = facet !== null || filter.trim() !== ''

  // Levels (frame 3): a limit hides deeper headings, never the cursor's section or its ancestors.
  const deepest = deepestLevel(headings)
  const levelShown = useMemo(() => {
    const flags = levelVisibility(headings, levelLimit, activeIndex)
    return new Map(headings.map((heading, index) => [heading.from, flags[index]] as const))
  }, [headings, levelLimit, activeIndex])

  // Browse mode: the collapsible tree (visible rows only). Filter mode: a flat list of matches across
  // the whole document (collapse ignored) — a facet restricts to its kind, the text narrows further.
  const rows = useMemo(() => {
    if (!isFiltering) {
      return allRows.filter((r) => {
        if (!r.visible) return false
        const governing = r.entry.type === 'heading' ? r.entry.from : r.parentFrom
        return governing == null || levelShown.get(governing) !== false
      })
    }
    const needle = filter.trim().toLowerCase()
    return allRows.filter((r) => {
      if (facet !== null && (r.entry.type !== 'jump' || r.entry.kind !== facet)) return false
      if (needle && !r.entry.text.toLowerCase().includes(needle)) return false
      return true
    })
  }, [allRows, isFiltering, facet, filter, levelShown])

  // "+N" on a row: how many sections beneath it are not shown (folded away or above the chosen level).
  const hiddenByFrom = useMemo(() => {
    const shownFroms = new Set(rows.filter((r) => r.entry.type === 'heading').map((r) => r.entry.from))
    const counts = hiddenBeneath(headings, headings.map((h) => shownFroms.has(h.from)))
    return new Map(headings.map((h, index) => [h.from, counts[index]] as const))
  }, [rows, headings])

  const wordCountByFrom = useMemo(() => {
    if (!showCounts || docText == null) return null
    const counts = sectionWordCounts(docText, headings)
    return new Map(headings.map((h, index) => [h.from, counts[index]] as const))
  }, [showCounts, docText, headings])

  // Exactly one shown row is tabbable. If the stored focus row is no longer shown (collapsed away, file
  // changed, or filtered out), fall back to the first row so the list always keeps precisely one stop.
  // The fallback is the current heading (the cursor's), so opening the outline lands the keyboard where the
  // writer is, not at the top of a long list.
  const effectiveFocus =
    focusFrom != null && rows.some((r) => r.entry.from === focusFrom)
      ? focusFrom
      : activeFrom != null && !isFiltering && rows.some((r) => r.entry.from === activeFrom)
        ? activeFrom
        : (rows[0]?.entry.from ?? null)

  const headingRows = useMemo(() => rows.filter((r) => r.entry.type === 'heading'), [rows])

  // ---- Follow the document (ticket 13): the current row scrolls into view; nothing else moves ----
  useEffect(() => {
    if (activeFrom == null || scope !== 'file') return
    listRef.current?.querySelector<HTMLElement>(`.ol-item[data-from="${activeFrom}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activeFrom, scope, rows])

  // ---- Several picked sections: the editor holds them (tint + chords), the panel mirrors them ----
  useEffect(() => {
    const view = editorRef.current?.view()
    const current = view?.state.field(outlineSelectionField, false)
    if (!view || current === undefined) return
    const next = [...selected].sort((a, b) => a - b)
    if (current.length === next.length && current.every((value, index) => value === next[index])) return
    view.dispatch({ effects: setOutlineSelection.of(next) })
  }, [selected, editorRef])
  // The editor is authoritative while the writer types: follow its mapped positions after each snapshot.
  useEffect(() => {
    const current = editorRef.current?.view()?.state.field(outlineSelectionField, false)
    if (current && !sameSet(selected, current)) setSelected(new Set(current))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot])

  // Re-focus a row after an action moved it (rows are keyed by offset, so a moved row remounts).
  useEffect(() => {
    if (pendingFocus.current == null) return
    const row = listRef.current?.querySelector<HTMLElement>(`.ol-item[data-from="${pendingFocus.current}"]`)
    if (!row) return
    pendingFocus.current = null
    // Only hand focus back when it was lost with the old row (it is on the list or on nothing). If the
    // writer has since opened a menu or gone to the document, leave their focus alone.
    const holder = document.activeElement
    if (holder === document.body || holder === null || listRef.current?.contains(holder)) row.focus()
  }, [rows])

  // ---- Folder scope (Task 10): the active file's folder + subfolders, grouped by file ----
  const folderSubpath = useMemo(() => {
    if (activePath == null) return null
    const slash = activePath.lastIndexOf('/')
    return slash === -1 ? '' : activePath.slice(0, slash)
  }, [activePath])

  // Pull the disk-backed folder scan whenever folder scope is shown or its anchor folder changes. It
  // aggregates SAVED files across the subtree (headings + jumps), so it re-reads on scope enter, folder
  // change, file switch, AND every save (savedTick) rather than tracking one open buffer — the channel is
  // the disk-backed path, so a just-saved bookmark must trigger a re-scan or the view ignores the save.
  useEffect(() => {
    if (scope !== 'folder' || folioPart || folderSubpath == null) {
      setFolderEntries([])
      return
    }
    let cancelled = false
    void window.writeflex
      // A workspace-ROOT file has no folder segment, so folderSubpath is '' — its "folder" is the whole
      // workspace (PRD S18). Send undefined (not '') so scanFolder does a whole-workspace scan; passing ''
      // would trip the ipc path guard, which rejects the empty string.
      .scanJumps('folder', folderSubpath || undefined)
      .then((entries) => { if (!cancelled) setFolderEntries(entries) })
      .catch(() => { if (!cancelled) setFolderEntries([]) })
    return () => { cancelled = true }
  }, [scope, folioPart, folderSubpath, activePath, savedTick])

// The Folio part asks main when it is shown, and again when the open file, a save, or the collection
  // changes. Main lists the folder and re-reads only files that changed, so this is cheap on a tab switch.
  useEffect(() => {
    if (!folioPart || activePath == null) return
    let cancelled = false
    void window.writeflex
      .readFolioOutline(activePath)
      .then((next) => { if (!cancelled) setFolioOutline((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next)) })
      .catch(() => { if (!cancelled) setFolioOutline(null) })
    return () => { cancelled = true }
  }, [folioPart, activePath, savedTick, folioChanged, folioRefreshTick])
  useEffect(() => {
    if (!folioPart) return
    const bump = (): void => setFolioChanged((n) => n + 1)
    const offCollection = window.writeflex.onCollectionChanged(bump)
    const offDisk = window.writeflex.onFileChangedOnDisk(bump)
    return () => { offCollection(); offDisk() }
  }, [folioPart])
  // A different Folio starts again from "the open piece expanded, the others collapsed".
  const folioDir = folioPlace?.dir ?? null
  useEffect(() => { setFolioExpanded(new Map()) }, [folioDir])
  const folioShown = folioOutline !== null && folioOutline.dir === folioDir ? folioOutline : null
  const setFolioOpen = useCallback((key: string, open: boolean) => {
    setFolioExpanded((current) => new Map(current).set(key, open))
  }, [])
  const makeFolio = useCallback(() => {
    void window.writeflex
      .makeFolio(folderSubpath ?? '')
      .catch((error: Error) => onStatus(error?.message ?? 'Could not make this folder a Folio.'))
  }, [folderSubpath, onStatus])

  // Running order: every path sent to main comes from the list on screen, with that list as `expected`.
  const seenFolio = useCallback((expected?: readonly string[]) => {
    if (!folioShown) return null
    const titles = new Map(folioShown.pieces.map((piece) => [piece.path, piece.title] as const))
    const order = expected ?? folioShown.pieces.map((piece) => piece.path)
    return { dir: folioShown.dir, pieces: order.map((path) => ({ path, title: titles.get(path) ?? path })) }
  }, [folioShown])
  const guardBusy = useCallback(async (run: () => Promise<unknown>): Promise<void> => {
    setFolioBusy(true)
    try { await run() } finally { setFolioBusy(false) }
  }, [])
  const onMovePiece = useCallback((path: string, beforePath: string | null, expected: string[]) => {
    const seen = seenFolio(expected)
    if (seen) void guardBusy(() => runningOrder.movePiece(seen, path, beforePath))
  }, [seenFolio, guardBusy, runningOrder])
  const onAddFiles = useCallback((files: Array<{ path: string; title: string }>) => {
    const seen = seenFolio()
    if (seen) void guardBusy(() => runningOrder.addPieces(seen, files))
  }, [seenFolio, guardBusy, runningOrder])
  const pieceMove = (direction: 'up' | 'down') => (folioShown && !folioShown.orderInPlanOnly && folioFocused?.kind === 'piece'
    ? commandTarget(direction, folioFocused, null, folioShown)
    : { message: 'Focus a piece of the running order to move it.' })
  const movePieceFromBar = (direction: 'up' | 'down'): void => {
    const target = pieceMove(direction)
    if (!('message' in target)) onMovePiece(target.path, target.beforePath, folioShown!.pieces.map((piece) => piece.path))
  }

  const folderGroups = useMemo(
    () => groupFolderEntries(folderEntries, facet, filter.trim().toLowerCase()),
    [folderEntries, facet, filter],
  )
  // The flat, path-ordered list of every shown folder row — what the roving tabindex + Arrow keys walk
  // (the `.ol-group-label`s are non-focusable separators, skipped). Exactly one row carries tabIndex=0,
  // so the whole grouped list stays ONE tab stop, like the file-scope tree.
  const folderRows = useMemo(() => folderGroups.flatMap((g) => g.rows), [folderGroups])
  const effectiveFolderFocus =
    folderFocusKey != null && folderRows.some((r) => r.key === folderFocusKey)
      ? folderFocusKey
      : (folderRows[0]?.key ?? null)

  const focusFolderRow = useCallback((key: string) => {
    setFolderFocusKey(key)
    listRef.current?.querySelector<HTMLElement>(`[data-key=${CSS.escape(key)}]`)?.focus()
  }, [])

  // A folder-scope activation delegates to App: same-file jumps land in-editor immediately, cross-file
  // jumps open the file and flush the caret once its buffer is live (App's pending-line). Keep the
  // roving tabindex on the activated row so a Tab back into the list returns here.
  const jumpFolderRow = useCallback(
    (row: FolderRow) => {
      setFolderFocusKey(row.key)
      onJumpToFile(row.file, row.line)
    },
    [onJumpToFile],
  )

  const onFolderKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (folderRows.length === 0) return
      const current = effectiveFolderFocus ?? folderRows[0].key
      const i = Math.max(0, folderRows.findIndex((r) => r.key === current))
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault()
          focusFolderRow(folderRows[Math.min(i + 1, folderRows.length - 1)].key)
          break
        case 'ArrowUp':
          event.preventDefault()
          focusFolderRow(folderRows[Math.max(i - 1, 0)].key)
          break
        case 'Home':
          event.preventDefault()
          focusFolderRow(folderRows[0].key)
          break
        case 'End':
          event.preventDefault()
          focusFolderRow(folderRows[folderRows.length - 1].key)
          break
        case 'Enter':
        case ' ':
          event.preventDefault()
          jumpFolderRow(folderRows[i])
          break
      }
    },
    [folderRows, effectiveFolderFocus, focusFolderRow, jumpFolderRow],
  )

  const selectScope = useCallback((next: Scope) => {
    setScope(next)
    setFocusFrom(null)
    setFolderFocusKey(null)
    setSelected(new Set())
  }, [])

  const jumpTo = useCallback(
    (entry: Entry, options: { keepFocus?: boolean } = {}) => {
      const view = editorRef.current?.view()
      if (!view) return
      // Keep the roving tabindex on the jumped row so a later Tab back into the list lands here. Resolve
      // a jump's target from its line (its stable identity) so a debounced-stale offset can't misfire.
      const target =
        entry.type === 'jump'
          ? view.state.doc.line(Math.min(Math.max(entry.line, 1), view.state.doc.lines)).from
          : clampOffset(entry.from, view.state.doc.length)
      setFocusFrom(entry.from)
      view.dispatch({
        selection: { anchor: target },
        effects: EditorView.scrollIntoView(target, { y: 'start', yMargin: 80 }),
      })
      // Keyboard-first: land back in the editor, ready to write at the place you jumped to. The
      // selection change fires the editor bus, so App's shared snapshot re-derives the cursor-follow
      // (accent bar) on the next debounced tick — no local recompute needed here. ↵ in the list keeps the
      // keyboard in the list instead (options.keepFocus): the writer is walking the outline.
      if (!options.keepFocus) view.focus()
    },
    [editorRef],
  )

  const toggleCollapsed = useCallback((from: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(from)) next.delete(from)
      else next.add(from)
      return next
    })
  }, [])

  // Move the roving tabindex to a row and pull DOM focus there so document.activeElement tracks it.
  const focusRow = useCallback((from: number) => {
    setFocusFrom(from)
    listRef.current?.querySelector<HTMLElement>(`[data-from="${from}"]`)?.focus()
  }, [])

  const toggleFacet = useCallback((kind: JumpKind) => {
    setFacet((prev) => (prev === kind ? null : kind))
    setFocusFrom(null)
    setFolderFocusKey(null)
  }, [])

  // ---- Display commands: header bar, Levels, menu and palette all land here ----
  const expandAll = useCallback(() => {
    if (folioPart && folioShown) setFolioExpanded(new Map(folioFileKeys(folioShown).map((key) => [key, true] as const)))
    setCollapsed(new Set()); setLevelLimit(null); commandRan('outline.expandAll')
  }, [folioPart, folioShown])
  const collapseAll = useCallback(() => {
    if (folioPart && folioShown) setFolioExpanded(new Map(folioFileKeys(folioShown).map((key) => [key, false] as const)))
    const parents = new Set<number>()
    headings.forEach((heading, index) => { if (headings[index + 1] && headings[index + 1].level > heading.level) parents.add(heading.from) })
    setCollapsed(parents)
    setLevelLimit(null)
    commandRan('outline.collapseAll')
  }, [headings, folioPart, folioShown])
  const toggleWordCounts = useCallback(() => {
    setShowCounts((on) => {
      try { localStorage.setItem(WORD_COUNTS_KEY, on ? '0' : '1') } catch { /* the choice still holds for the session */ }
      return !on
    })
  }, [])

  // ---- A row's menu (right-click, ⌘K, the menu key, the palette): positioned at the row ----
  const menuReturn = useRef<number | null>(null)
  const openRowMenu = useCallback((from: number) => {
    const el = listRef.current?.querySelector<HTMLElement>(`.ol-item[data-from="${from}"]`)
    const box = el?.getBoundingClientRect()
    menuReturn.current = from
    setMenu({ x: box ? box.left + 24 : 0, y: box ? box.bottom : 0, from })
  }, [])
  // When the menu closes, the keyboard goes back to the row it came from (unless an action moved it, which
  // the refocus-after-action step handles, or the writer has gone elsewhere).
  useEffect(() => {
    if (menu !== null || menuReturn.current === null) return
    const row = listRef.current?.querySelector<HTMLElement>(`.ol-item[data-from="${menuReturn.current}"]`)
    const holder = document.activeElement
    if (row && (holder === document.body || holder === null || listRef.current?.contains(holder))) row.focus()
    if (row || pendingFocus.current === null) menuReturn.current = null
  }, [menu])

  const handledRequest = useRef(request?.tick ?? 0)
  useEffect(() => {
    if (!request || request.tick === handledRequest.current) return
    handledRequest.current = request.tick
    const action = request.action
    if (action === 'expandAll') expandAll()
    else if (action === 'collapseAll') collapseAll()
    else if (action === 'toggleWordCounts') toggleWordCounts()
    else if (action === 'rowMenu') {
      const focused = rows.find((r) => r.entry.from === effectiveFocus && r.entry.type === 'heading')?.entry.from ?? activeFrom
      if (focused != null) openRowMenu(focused)
    }
    else { setLevelLimit(action.levels); setCollapsed(new Set()) }
  }, [request, expandAll, collapseAll, toggleWordCounts, rows, effectiveFocus, activeFrom, openRowMenu])

  // ---- Structure actions on whole sections ----
  /** Whether the snapshot's offsets still match the live document (they trail it by a debounce). */
  const offsetsAreFresh = useCallback((froms: readonly number[]): boolean => {
    const view = editorRef.current?.view()
    if (!view) return false
    const fresh = extractOutline(view.state.doc.toString())
    return froms.every((from) => fresh.some((heading) => heading.from === from))
  }, [editorRef])

  const act = useCallback((action: SectionAction, froms: readonly number[], commandId?: string) => {
    const view = editorRef.current?.view()
    if (!view || froms.length === 0 || !offsetsAreFresh(froms)) return
    const keep = selected.size > 0 && froms.every((from) => selected.has(from))
    const next = runSectionAction(view, action, froms, keep)
    if (!next) return
    if (commandId) commandRan(commandId) // the registry command this route stands for (the Guide's ticks)
    pendingFocus.current = next[0] ?? null
    if (next[0] !== undefined) setFocusFrom(next[0])
    if (keep) setSelected(new Set(next))
  }, [editorRef, offsetsAreFresh, selected])

  /** The sections a header button or key acts on: the picked ones, else the cursor's section. */
  const actionTargets = useCallback((): number[] => {
    if (selected.size > 0) return [...selected]
    // The cursor's section, read from the live document (the snapshot trails it by a debounce).
    const view = editorRef.current?.view()
    if (view) {
      const fresh = extractOutline(view.state.doc.toString())
      const index = headingIndexAt(fresh, view.state.selection.main.head)
      return index >= 0 ? [fresh[index].from] : []
    }
    return activeFrom != null ? [activeFrom] : []
  }, [selected, activeFrom, editorRef])

  const askDelete = useCallback((froms: readonly number[]) => {
    const view = editorRef.current?.view()
    if (!view || froms.length === 0 || !offsetsAreFresh(froms)) return
    const doc = view.state.doc.toString()
    setConfirm({ froms: sectionRoots(doc, froms), words: wordsInSections(doc, froms) })
  }, [editorRef, offsetsAreFresh])

  const confirmDelete = useCallback(() => {
    const view = editorRef.current?.view()
    if (view && confirm && offsetsAreFresh(confirm.froms)) runSectionAction(view, 'delete', confirm.froms, false)
    setConfirm(null)
    setSelected(new Set())
  }, [confirm, editorRef, offsetsAreFresh])

  // ---- Picking several rows ----
  const pick = useCallback((from: number, mode: 'toggle' | 'range') => {
    setFocusFrom(from)
    if (mode === 'toggle') {
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(from)) next.delete(from)
        else next.add(from)
        return next
      })
      setAnchorFrom(from)
      return
    }
    const anchor = anchorFrom ?? focusFrom ?? activeFrom ?? from
    const order = headingRows.map((r) => r.entry.from)
    const a = order.indexOf(anchor)
    const b = order.indexOf(from)
    if (a === -1 || b === -1) { setSelected(new Set([from])); setAnchorFrom(from); return }
    setSelected(new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1)))
  }, [anchorFrom, focusFrom, activeFrom, headingRows])

  // ---- Dragging a section: up/down moves it, sideways changes its level ----
  const headingsRef = useRef(headings)
  headingsRef.current = headings
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  const startDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>, sourceFrom: number) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || scope !== 'file' || isFiltering) return
    if ((event.target as Element).closest('.ol-chev-btn')) return
    const startX = event.clientX
    const startY = event.clientY
    let active = false
    let latest: DragView | null = null

    const compute = (e: PointerEvent): DragView => {
      const all = headingsRef.current
      const index = all.findIndex((heading) => heading.from === sourceFrom)
      const source = all[index]
      const count = sectionRowCount(all, index)
      const subtreeFroms = new Set(all.slice(index, index + count).map((heading) => heading.from))
      const plural = count === 1 ? '1 section moves' : `${count} sections move`
      const base = { from: sourceFrom, x: e.clientX, y: e.clientY }
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const rowEl = el?.closest<HTMLElement>('.ol-item[data-from]')
      const inList = el ? listRef.current?.contains(el) === true : false
      const shown = rowsRef.current
      const levelMode = (): DragView => {
        const deepestInside = all.slice(index, index + count).reduce((most, heading) => Math.max(most, heading.level), 1)
        const delta = Math.max(1 - source.level, Math.min(6 - deepestInside, Math.round((e.clientX - startX) / LEVEL_STEP_PX)))
        return { ...base, mode: 'level', beforeFrom: null, delta, label: delta === 0 ? 'Drag sideways to change the level' : `To Heading ${source.level + delta} · ${plural}` }
      }
      if (rowEl) {
        const from = Number(rowEl.dataset.from)
        const isOwn = subtreeFroms.has(from)
        const hoveredJump = rowEl.dataset.kind !== 'heading'
        const parent = hoveredJump ? shown.find((r) => r.entry.from === from)?.parentFrom : null
        if (isOwn || (hoveredJump && parent != null && subtreeFroms.has(parent))) return levelMode()
        const rect = rowEl.getBoundingClientRect()
        const lowerHalf = e.clientY > rect.top + rect.height / 2
        const rowIndex = shown.findIndex((r) => r.entry.from === from)
        let before: number | null
        if (!hoveredJump && !lowerHalf) before = from
        else {
          const next = shown.slice(rowIndex + 1).find((r) => r.entry.type === 'heading')
          before = next ? next.entry.from : null
        }
        const target = before == null ? null : all.find((heading) => heading.from === before)
        return { ...base, mode: 'move', beforeFrom: before, delta: 0, label: target ? `Before “${target.text}” · ${plural}` : `To the end · ${plural}` }
      }
      if (inList) return { ...base, mode: 'move', beforeFrom: null, delta: 0, label: `To the end · ${plural}` }
      return { ...base, mode: 'none', beforeFrom: null, delta: 0, label: '' }
    }

    const onMove = (e: PointerEvent): void => {
      if (!active) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 5) return
        active = true
        suppressClick.current = true
      }
      latest = compute(e)
      setDrag(latest)
    }
    const finish = (commit: boolean): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onEscape, true)
      setDrag(null)
      if (active) window.setTimeout(() => { suppressClick.current = false }, 0)
      const view = editorRef.current?.view()
      const result = latest
      if (!commit || !active || !result || !view) return
      const doc = view.state.doc.toString()
      if (!extractOutline(doc).some((heading) => heading.from === sourceFrom)) return
      if (result.mode === 'move') {
        if (result.beforeFrom !== null && !extractOutline(doc).some((heading) => heading.from === result.beforeFrom)) return
        const edit = dropSection(doc, sourceFrom, result.beforeFrom)
        if (!edit) return
        view.dispatch({
          changes: edit.changes,
          selection: EditorSelection.cursor(edit.movedFrom),
          effects: setOutlineSelection.of([]),
          scrollIntoView: true,
          userEvent: 'move.drop',
        })
        pendingFocus.current = edit.movedFrom
        setFocusFrom(edit.movedFrom)
        setSelected(new Set())
      } else if (result.mode === 'level' && result.delta !== 0) {
        const edit = shiftSections(doc, [sourceFrom], result.delta < 0 ? -1 : 1, Math.abs(result.delta))
        if (!edit) return
        dispatchSectionsEdit(view, edit, 'outline.drag-level', false)
        pendingFocus.current = edit.froms[0] ?? null
        setSelected(new Set())
      }
    }
    const onUp = (): void => finish(true)
    const onEscape = (e: globalThis.KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); finish(false) } }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onEscape, true)
  }, [editorRef, isFiltering, scope])

  // ---- Keyboard: WAI-ARIA tree model + the structure chords while the outline has focus ----
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (rows.length === 0) return
      // The row the key landed on (DOM focus is the truth; the roving tab stop only mirrors it).
      const focusedAttr = (event.target as HTMLElement).closest<HTMLElement>('[data-from]')?.dataset.from
      const current = focusedAttr !== undefined ? Number(focusedAttr) : (effectiveFocus ?? rows[0].entry.from)
      const i = Math.max(0, rows.findIndex((r) => r.entry.from === current))
      const row = rows[i]
      // The editor's structure chords act on the focused row (or the picked rows) while the panel has focus.
      const chord = eventToChord(event.nativeEvent)
      if (chord) {
        const hit = CHORD_ACTIONS.find(([id]) => sameChord(shortcutFor(id), chord))
        if (hit) {
          event.preventDefault()
          event.stopPropagation()
          const froms = selected.size > 0 ? [...selected] : row.entry.type === 'heading' ? [row.entry.from] : []
          act(hit[1], froms, hit[0])
          return
        }
      }
      const action = classifyOutlineKey(event.nativeEvent)
      if (action === null) return
      event.preventDefault()
      switch (action) {
        case 'down': focusRow(rows[Math.min(i + 1, rows.length - 1)].entry.from); break
        case 'up': focusRow(rows[Math.max(i - 1, 0)].entry.from); break
        case 'home': focusRow(rows[0].entry.from); break
        case 'end': focusRow(rows[rows.length - 1].entry.from); break
        case 'unfold':
          if (row.hasChildren && row.isCollapsed) toggleCollapsed(row.entry.from)
          else if (row.hasChildren && !row.isCollapsed && rows[i + 1]) focusRow(rows[i + 1].entry.from)
          break
        case 'fold':
          if (row.hasChildren && !row.isCollapsed) toggleCollapsed(row.entry.from)
          else if (row.parentFrom != null && rows.some((r) => r.entry.from === row.parentFrom)) focusRow(row.parentFrom)
          break
        case 'jump': jumpTo(row.entry, { keepFocus: true }); break
        case 'jumpToEditor': jumpTo(row.entry); break
        case 'escape':
          // Esc clears a several-picked selection first; with none, it returns to the editor at this heading.
          if (selected.size > 0) setSelected(new Set())
          else jumpTo(row.entry)
          break
        case 'extendUp':
        case 'extendDown': {
          const order = headingRows.map((r) => r.entry.from)
          const result = extendSelection(order, anchorFrom, row.entry.type === 'heading' ? row.entry.from : (order.filter((from) => from <= row.entry.from).at(-1) ?? order[0]), action === 'extendUp' ? -1 : 1)
          if (result) {
            setSelected(new Set(result.selected))
            setAnchorFrom(result.anchor)
            focusRow(result.focus)
          }
          break
        }
        case 'menu':
          if (row.entry.type === 'heading') openRowMenu(row.entry.from)
          break
      }
    },
    [rows, effectiveFocus, focusRow, toggleCollapsed, jumpTo, act, selected, shortcutFor, headingRows, anchorFrom, openRowMenu],
  )

  // Land the keyboard on the active row when App opens the outline (focusTick bumps). The row may not
  // be in the DOM yet — the shared snapshot populates the outline on a debounce — so this re-runs as
  // the shown rows change and focuses the moment the active (roving-tabindex) row exists, once per bump.
  const handledFocusTick = useRef(focusTick)
  useEffect(() => {
    if (focusTick === handledFocusTick.current) return
    const row = listRef.current?.querySelector<HTMLElement>('.ol-item[tabindex="0"], .fo-row[tabindex="0"]')
    if (!row) return // rows not rendered yet; a later render (the snapshot lands) re-runs this effect
    handledFocusTick.current = focusTick
    row.focus()
  }, [focusTick, rows, folderRows, scope, folioShown])

  // ---- Right-click menu (frame 4) and Levels drop-down (frame 3) ----
  // A row of Actions here at an outline row. The structure commands act on the row (or the picked rows)
  // exactly as their chords do while the panel has focus; the commands that act at the caret get the
  // caret moved to the row's heading first, and App then runs them as the palette does. The display
  // commands (expand, collapse, levels, word counts) are App's too. False means App runs it.
  const runRow = (commandId: string): boolean => {
    const target = menu
    if (!target) return false
    const froms = selected.has(target.from) ? [...selected] : [target.from]
    const structural = CHORD_ACTIONS.find(([id]) => id === commandId)
    if (structural) { setMenu(null); act(structural[1], froms, structural[0]); return true }
    if (commandId === 'outline.deleteCurrentSection') { setMenu(null); askDelete(froms); return true }
    if (CARET_COMMANDS.has(commandId)) {
      const view = editorRef.current?.view()
      if (!view || !offsetsAreFresh([target.from])) { setMenu(null); return true }
      view.dispatch({ selection: EditorSelection.cursor(target.from) })
    }
    return false
  }
  const levelItems = (): FileMenuItem[] => [
    ...Array.from({ length: Math.max(folioPart ? folioDeepest : deepest, 1) }, (_, index) => ({ id: `level${index + 1}`, label: `Level ${index + 1}`, kbd: levelLimit === index + 1 ? '✓' : undefined })),
    { id: 'levelAll', label: 'All levels', kbd: levelLimit === null ? '✓' : undefined },
  ]
  const onLevelAction = (id: string): void => {
    setLevelsMenu(null)
    setCollapsed(new Set())
    setLevelLimit(id === 'levelAll' ? null : Number(id.slice(5)))
    commandRan(id === 'levelAll' ? 'outline.showAllLevels' : `outline.showLevel${id.slice(5)}`)
  }
  const openLevelsMenu = (): void => {
    const box = levelsButtonRef.current?.getBoundingClientRect()
    setLevelsMenu(box ? { x: box.left, y: box.bottom + 4 } : { x: 0, y: 0 })
  }

  const empty = headings.length === 0 && jumps.length === 0
  const barOff = scope !== 'file' || headings.length === 0
  // Collapse all, Expand all and Levels also work on the Folio part (every piece, every piece's headings).
  const viewOff = folioPart ? folioShown === null : barOff
  const folioDeepest = folioShown
    ? [...folioShown.pieces, ...folioShown.also].reduce((most, file) => file.headings.reduce((m, heading) => Math.max(m, heading.level), most), deepest)
    : deepest
  const selectedCount = selected.size
  const chordHint = (id: string): string => { const chord = shortcutFor(id); return chord ? ` (${chord})` : '' }
  const dragSource = drag && drag.mode !== 'none' ? headings.findIndex((h) => h.from === drag.from) : -1
  const dragSubtree = new Set<number>(dragSource >= 0 ? headings.slice(dragSource, dragSource + sectionRowCount(headings, dragSource)).map((h) => h.from) : [])

  return (
    <>
      {/* Document ⟷ Folder, or Document ⟷ Folio when the open file's folder is a Folio (PRD S18). */}
      <span className="scope-seg" role="group" aria-label="Outline part">
        <button type="button" data-scope="file" aria-pressed={scope === 'file'} title="Headings of the open piece" onClick={() => selectScope('file')}>
          Document
        </button>
        <button
          type="button"
          data-scope={second.second === 'Folio' ? 'folio' : 'folder'}
          aria-pressed={scope === 'folder'}
          disabled={second.secondDisabled}
          title={second.second === 'Folio' ? 'The Folio of this folder: its pieces in running order, with their headings' : 'Every file in this folder, with its headings'}
          onClick={() => selectScope('folder')}
        >
          {second.second}
        </button>
      </span>
      {folioPart && (
        <div className="fo-actions">
          <button type="button" data-action="openPlan" title={`Open the Plan for ${folioPlace?.name ?? 'this Folio'}`} onClick={onOpenPlan}><ListOrdered className="icon sm" aria-hidden="true" />Plan</button>
          <button type="button" data-action="openBoard" title={`Open the Board for ${folioPlace?.name ?? 'this Folio'}`} onClick={onOpenBoard}><Columns3 className="icon sm" aria-hidden="true" />Board</button>
        </div>
      )}
      <div className="ol-bar" role="toolbar" aria-label="Outline actions">
        {/* A Folio the Outline cannot change shows no Move arrows: they would refuse every time. */}
        {!(folioPart && folioShown?.orderInPlanOnly) && (<>
        <button type="button" className="ol-btn" data-action="moveUp" disabled={folioPart ? folioBusy || 'message' in pieceMove('up') : barOff} title={folioPart ? 'Move piece up in the running order' : `Move up${chordHint('outline.moveBlockUp')}`} aria-label="Move up" onClick={() => (folioPart ? movePieceFromBar('up') : act('moveUp', actionTargets(), 'outline.moveBlockUp'))}><ArrowUp className="icon sm" aria-hidden="true" /></button>
        <button type="button" className="ol-btn" data-action="moveDown" disabled={folioPart ? folioBusy || 'message' in pieceMove('down') : barOff} title={folioPart ? 'Move piece down in the running order' : `Move down${chordHint('outline.moveBlockDown')}`} aria-label="Move down" onClick={() => (folioPart ? movePieceFromBar('down') : act('moveDown', actionTargets(), 'outline.moveBlockDown'))}><ArrowDown className="icon sm" aria-hidden="true" /></button>
        </>)}
        <button type="button" className="ol-btn" data-action="promote" disabled={barOff} title={`Promote${chordHint('heading.decrease')}`} aria-label="Promote" onClick={() => act('promote', actionTargets(), 'heading.decrease')}><ArrowLeft className="icon sm" aria-hidden="true" /></button>
        <button type="button" className="ol-btn" data-action="demote" disabled={barOff} title={`Demote${chordHint('heading.increase')}`} aria-label="Demote" onClick={() => act('demote', actionTargets(), 'heading.increase')}><ArrowRight className="icon sm" aria-hidden="true" /></button>
        <span className="ol-bar-sep" aria-hidden="true" />
        <button type="button" className="ol-btn" data-action="collapseAll" disabled={viewOff} title="Collapse all" aria-label="Collapse all" onClick={collapseAll}><SquareMinus className="icon sm" aria-hidden="true" /></button>
        <button type="button" className="ol-btn" data-action="expandAll" disabled={viewOff} title="Expand all" aria-label="Expand all" onClick={expandAll}><SquarePlus className="icon sm" aria-hidden="true" /></button>
        <span className="ol-bar-gap" aria-hidden="true" />
        <button ref={levelsButtonRef} type="button" className="ol-levels" disabled={viewOff} aria-haspopup="menu" aria-expanded={levelsMenu !== null} title="Show levels" aria-label="Levels" onClick={openLevelsMenu}>
          {levelLimit === null ? 'All' : `Level ${levelLimit}`}
          <ChevronDown className="icon sm" aria-hidden="true" />
        </button>
      </div>
      <div className="facet-row">
        <div className="facet-search">
          <Search className="icon sm" aria-hidden="true" />
          <input
            type="text"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value)
              setFocusFrom(null)
              setFolderFocusKey(null)
            }}
            placeholder="Filter"
            aria-label="Filter outline"
          />
        </div>
        {!folioPart && FACETS.map(({ kind, label, Icon }) => (
          <button
            key={kind}
            type="button"
            className="facet"
            data-kind={kind}
            aria-pressed={facet === kind}
            title={label}
            aria-label={label}
            onClick={() => toggleFacet(kind)}
          >
            <Icon className="icon sm" aria-hidden="true" />
          </button>
        ))}
      </div>
      {folioPart ? (
        folioShown ? (
          <FolioOutlinePart
            outline={folioShown}
            openPath={activePath}
            bufferHeadings={headings}
            bufferPath={snapshot ? snapshot.path : null}
            activeFrom={activeFrom}
            needle={filter.trim().toLowerCase()}
            levelLimit={levelLimit}
            expanded={folioExpanded}
            onToggle={setFolioOpen}
            onOpenFile={onOpenFile}
            onJumpToFile={onJumpToFile}
            onJumpOpen={(from) => jumpTo({ type: 'heading', from, level: 1, text: '' })}
            listRef={listRef}
            onMovePiece={onMovePiece}
            onAdd={onAddFiles}
            busy={folioBusy}
            justAdded={runningOrder.justAdded}
            announcement={runningOrder.announcement}
            touched={runningOrder.touched}
            onFocusedRow={setFolioFocused}
            onOpenPlan={onOpenPlan}
          />
        ) : (
          <div ref={listRef} className="ol-list" role="tree" aria-label="Folio outline" aria-busy="true" />
        )
      ) : (
      <div
        ref={listRef}
        className={`ol-list${drag && drag.mode !== 'none' ? ' dragging' : ''}`}
        role="tree"
        aria-label="Document outline"
        aria-multiselectable="true"
        aria-busy={scope === 'file' && waiting ? 'true' : undefined}
        onKeyDown={scope === 'folder' ? onFolderKeyDown : onKeyDown}
        onMouseDown={(event) => {
          // Empty space (below the last row, in the padding, between rows) gives the list the keyboard: the
          // cursor's row, else the first. DOM focus only; the editor does not move.
          if (event.target !== event.currentTarget) return
          event.preventDefault()
          if (scope === 'folder') {
            if (effectiveFolderFocus !== null) focusFolderRow(effectiveFolderFocus)
            return
          }
          const target = emptySpaceFocusTarget(rows.map((r) => r.entry.from), activeFrom)
          if (target !== null) focusRow(target)
        }}
      >
        {scope === 'folder' ? (
          folderRows.length === 0 ? (
            <p className="ol-empty">{isFiltering ? 'No matches' : 'Nothing to show in this folder'}</p>
          ) : (
            folderGroups.map((group) => (
              <Fragment key={group.file}>
                <div className="ol-group-label">{group.label}</div>
                {group.rows.map((row) => (
                  <FolderOutlineRow key={row.key} row={row} focusKey={effectiveFolderFocus} onJump={jumpFolderRow} />
                ))}
              </Fragment>
            ))
          )
        ) : rows.length === 0 ? (
          waiting ? null : <p className="ol-empty">{activePath == null ? 'No piece is open. Open one to see its outline.' : empty ? 'No headings yet' : 'No matches'}</p>
        ) : (
          rows.map((row) => {
            const from = row.entry.from
            const isHeading = row.entry.type === 'heading'
            const dragging = drag && drag.mode !== 'none'
            return (
              <OutlineRow
                key={from}
                row={row}
                flat={isFiltering}
                activeFrom={activeFrom}
                focusFrom={effectiveFocus}
                selected={isHeading && selected.has(from)}
                hidden={isHeading && !isFiltering ? (hiddenByFrom.get(from) ?? 0) : 0}
                words={isHeading ? (wordCountByFrom?.get(from) ?? null) : null}
                dropBefore={!!dragging && drag.mode === 'move' && drag.beforeFrom === from}
                dragSource={!!dragging && drag.from === from}
                dragInside={!!dragging && drag.from !== from && dragSubtree.has(from)}
                levelPreview={dragging && drag.mode === 'level' && drag.from === from ? drag.delta : 0}
                onToggle={toggleCollapsed}
                onActivate={(event) => {
                  if (suppressClick.current) return
                  if (isHeading && (event.metaKey || event.ctrlKey)) pick(from, 'toggle')
                  else if (isHeading && event.shiftKey) pick(from, 'range')
                  else {
                    if (selected.size > 0) setSelected(new Set())
                    setAnchorFrom(isHeading ? from : null)
                    jumpTo(row.entry)
                  }
                }}
                onPointerDown={isHeading ? (event) => startDrag(event, from) : undefined}
                onContextMenu={isHeading ? (event) => {
                  event.preventDefault()
                  if (!selected.has(from)) { setSelected(new Set()); setFocusFrom(from) }
                  menuReturn.current = from
                  setMenu({ x: event.clientX, y: event.clientY, from })
                } : undefined}
              />
            )
          })
        )}
        {drag && drag.mode === 'move' && drag.beforeFrom === null && <div className="ol-drop-end" aria-hidden="true" />}
      </div>
      )}
      {scope === 'folder' && !folioPart && activePath != null && (
        <FolderPartFoot
          folderName={folderSubpath ? folderSubpath.split('/').at(-1) ?? folderSubpath : null}
          fileName={(activePath.split('/').at(-1) ?? activePath).replace(/\.(?:md|markdown|mdx)$/i, '')}
          fileCount={folderFileCount}
          onMakeFolio={makeFolio}
        />
      )}
      {confirm && (
        <div className="ol-confirm" role="alertdialog" aria-label="Delete sections">
          <span>
            Delete {confirm.froms.length === 1 ? 'this section' : `${confirm.froms.length} sections`}
            {' '}and {confirm.words.toLocaleString()} {confirm.words === 1 ? 'word' : 'words'}?
          </span>
          <button type="button" className="ol-confirm-yes" autoFocus onClick={confirmDelete}>Delete</button>
          <button type="button" className="ol-confirm-no" onClick={() => setConfirm(null)}>Cancel</button>
        </div>
      )}
      {selectedCount > 0 && !confirm && (
        <div className="ol-selbar" role="toolbar" aria-label="Selected sections">
          <span className="ol-selbar-count">{selectedCount} selected</span>
          <button type="button" data-action="promote" onClick={() => act('promote', [...selected])}><kbd>{shortcutFor('heading.decrease') ?? ''}</kbd> Promote</button>
          <button type="button" data-action="demote" onClick={() => act('demote', [...selected])}><kbd>{shortcutFor('heading.increase') ?? ''}</kbd> Demote</button>
          <span className="ol-selbar-move">
            <kbd>{(shortcutFor('outline.moveBlockUp') ?? '').replace(/[↑]/, '↑↓')}</kbd> Move
            <button type="button" data-action="moveUp" aria-label="Move selected up" onClick={() => act('moveUp', [...selected])}><ArrowUp className="icon sm" aria-hidden="true" /></button>
            <button type="button" data-action="moveDown" aria-label="Move selected down" onClick={() => act('moveDown', [...selected])}><ArrowDown className="icon sm" aria-hidden="true" /></button>
          </span>
          <button type="button" data-action="delete" className="danger" onClick={() => askDelete([...selected])}><kbd>⌫</kbd> Delete</button>
        </div>
      )}
      {drag && drag.mode !== 'none' && drag.label && (
        <div className="ol-drag-label" style={{ left: drag.x + 14, top: drag.y + 14 }} aria-hidden="true">{drag.label}</div>
      )}
      {menu && <ActionsHere x={menu.x} y={menu.y} place="outline-row" runHere={runRow} onClose={() => setMenu((current) => (current === menu ? null : current))} />}
      {levelsMenu && <FileRowMenu x={levelsMenu.x} y={levelsMenu.y} items={levelItems()} onAction={onLevelAction} onClose={() => setLevelsMenu((current) => (current === levelsMenu ? null : current))} />}
    </>
  )
}

type OutlineRowProps = {
  row: Row
  /** Filter mode: render every row as a flat leaf (no chevron/collapse) — matches float free of the tree. */
  flat: boolean
  activeFrom: number | null
  /** The row that currently holds the list's single tab stop (roving tabindex). */
  focusFrom: number | null
  selected: boolean
  /** Sections beneath this one that are not shown (the "+N"). */
  hidden: number
  /** Words in the section and everything under it; null = counts are off. */
  words: number | null
  dropBefore: boolean
  dragSource: boolean
  dragInside: boolean
  /** Levels the row is being dragged sideways by (shown as its indent while dragging). */
  levelPreview: number
  onToggle: (from: number) => void
  onActivate: (event: ReactMouseEvent<HTMLDivElement>) => void
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void
  onContextMenu?: (event: ReactMouseEvent<HTMLDivElement>) => void
}

const KIND_ICON = { bookmark: Bookmark, comment: MessageSquareDashed, task: SquareCheck } as const

/**
 * One outline row — a heading or a jump — as the single focusable treeitem (WAI-ARIA tree pattern).
 * A click anywhere on the row jumps; a heading's chevron is a presentation hit target that stops
 * propagation to collapse instead. Every heading reserves the same chevron/spacer prefix, while its
 * row indent advances 8px per Markdown heading level. The advance caps at H5 so unusually deep levels
 * do not squeeze a narrow sidebar into a column of wrapped words. Jump rows lead with their kind glyph
 * (`.ol-kind`); a comment shows its `//` marker so its origin stays legible.
 */
function OutlineRow({ row, flat, activeFrom, focusFrom, selected, hidden, words, dropBefore, dragSource, dragInside, levelPreview, onToggle, onActivate, onPointerDown, onContextMenu }: OutlineRowProps): JSX.Element {
  const { entry, depth, hasChildren, isCollapsed } = row
  const nested = entry.type === 'jump' || depth >= 1
  const isCurrent = entry.from === activeFrom
  const showChevron = !flat && entry.type === 'heading' && hasChildren
  const showSpacer = !flat && entry.type === 'heading' && !hasChildren
  const label = entry.type === 'jump' && entry.kind === 'comment' ? `// ${entry.text}` : entry.text
  const KindIcon = entry.type === 'jump' ? KIND_ICON[entry.kind] : null
  const headingLevel = entry.type === 'heading' ? entry.level : null
  const previewLevel = headingLevel != null ? headingLevel + levelPreview : null
  const headingIndent = previewLevel != null && !flat
    ? 8 + Math.min(Math.max(previewLevel - 1, 0), 4) * 8
    : undefined
  return (
    <div
      className={`ol-item${nested ? ' nested' : ''}${!flat && isCollapsed ? ' collapsed' : ''}${entry.type === 'jump' && entry.done ? ' done' : ''}${selected ? ' selected' : ''}${dropBefore ? ' drop-before' : ''}${dragSource ? ' drag-source' : ''}${dragInside ? ' drag-inside' : ''}`}
      role="treeitem"
      data-from={entry.from}
      data-kind={entry.type === 'jump' ? entry.kind : 'heading'}
      data-heading-level={headingLevel ?? undefined}
      style={headingIndent == null ? undefined : { paddingLeft: headingIndent }}
      tabIndex={entry.from === focusFrom ? 0 : -1}
      aria-current={isCurrent ? 'true' : undefined}
      aria-selected={entry.type === 'heading' ? selected : undefined}
      aria-expanded={showChevron ? !isCollapsed : undefined}
      aria-level={depth + 1}
      title={label}
      onClick={onActivate}
      onPointerDown={onPointerDown}
      // A right-press must not move DOM focus to the row after the menu has taken it (the menu closes on blur).
      onMouseDown={onContextMenu ? (event) => { if (event.button === 2) event.preventDefault() } : undefined}
      onContextMenu={onContextMenu}
    >
      {entry.type === 'heading' && !flat && <span className="ol-grip" aria-hidden="true" />}
      {showChevron ? (
        <span
          className="ol-chev-btn"
          aria-hidden="true"
          onClick={(event) => {
            event.stopPropagation()
            onToggle(entry.from)
          }}
        >
          <ChevronDown className="ol-chev" aria-hidden="true" />
        </span>
      ) : showSpacer ? (
        <span className="ol-chev-spacer" aria-hidden="true" />
      ) : KindIcon ? (
        <KindIcon className="ol-kind" aria-hidden="true" />
      ) : null}
      <span className="ol-label">{label}</span>
      {hidden > 0 && <span className="ol-hidden" title={`${hidden} hidden ${hidden === 1 ? 'section' : 'sections'}`}>+{hidden}</span>}
      {words !== null && <span className="ol-count">{words.toLocaleString()}</span>}
    </div>
  )
}

type FolderOutlineRowProps = {
  row: FolderRow
  /** The folder-scope row that currently holds the list's single tab stop (roving tabindex). */
  focusKey: string | null
  onJump: (row: FolderRow) => void
}

/**
 * One folder-scope row — a heading or a jump from some file in the scope — as a flat treeitem at the
 * mockup's nested indent (26px, `.nested`). Unlike file scope there is no collapse: every entry across
 * every file is a flat sibling, so headings carry no chevron/spacer and jumps lead with their kind
 * glyph. A click (or Enter) jumps to that file+line, opening the file first when it is not the active one.
 */
function FolderOutlineRow({ row, focusKey, onJump }: FolderOutlineRowProps): JSX.Element {
  const label = folderRowLabel(row)
  const KindIcon = row.kind === 'heading' ? null : KIND_ICON[row.kind]
  return (
    <div
      className={`ol-item nested${row.done ? ' done' : ''}`}
      role="treeitem"
      data-key={row.key}
      data-kind={row.kind}
      tabIndex={row.key === focusKey ? 0 : -1}
      aria-level={1}
      title={label}
      onClick={() => onJump(row)}
    >
      {KindIcon ? <KindIcon className="ol-kind" aria-hidden="true" /> : null}
      <span className="ol-label">{label}</span>
    </div>
  )
}

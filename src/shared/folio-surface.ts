import type { FolioPlaceKind } from './folio-place'
import type { RoomView } from './folio-room'
import { ROOM_VIEWS } from './folio-room'
import { BOARD_STATUS_ORDER } from './collection-status'

/**
 * Where a Folio opens (ADR-0049, spec folio-workspace § 3 and § 4). Pure: the app asks, these answer.
 *
 * A Folio has one surface, the workspace. The Folio page, the room, the Board for a Folio and the Collection list for
 * a Folio no longer have an entry point: every route that used to open one of them opens the workspace, and a Folio
 * part opened from anywhere opens in the workspace's Text tab.
 */

/** `workspace`: the tabs and the binder. `list`: the plain Collection list, for a folder that is not a readable Folio. */
export type FolioSurface = 'workspace' | 'list'

/**
 * The surface a folder opens. `showPlan`: the folder is a Folio (manifest, Index Note with a running order, or a
 * requested outline). `roomEligible`: its manifest reads and its plan reads. A Folio that cannot be read keeps the list,
 * which names the manifest problem; it never opens the retired page.
 */
export function surfaceForFolder(facts: { showPlan: boolean; roomEligible: boolean }): FolioSurface {
  return facts.showPlan && facts.roomEligible ? 'workspace' : 'list'
}

/** The state the workspace is opened with for a part: the Text tab, the part chosen by its file, Split off. */
export type WorkspacePartPatch = { view: 'text'; selected: { title: ''; path: string }; split: false }
export type PartRoute = { dir: string; patch: WorkspacePartPatch }

/**
 * What opening `path` does, given where main says the file sits in its Folio (`readFolioPlace`). A part in the
 * running order opens the Folio's workspace on its Text tab; any other file (the Index Note, agent instructions, a file
 * not in the outline, a file outside every Folio) opens in the editor as before. Null = the editor.
 */
export function routeForOpenedFile(path: string, place: { dir: string; kind: FolioPlaceKind } | null): PartRoute | null {
  if (place === null || place.kind !== 'piece') return null
  return { dir: place.dir, patch: { view: 'text', selected: { title: '', path }, split: false } }
}

/** The command id of a tab: `folio.room.outline` … `folio.room.files`, in tab order. */
export const WORKSPACE_TAB_COMMANDS: readonly string[] = ROOM_VIEWS.map((view) => `folio.room.${view}`)

/** The tab a `folio.room.*` command id names, or null for another id. */
export function tabOfCommand(id: string): RoomView | null {
  return ROOM_VIEWS.find((view) => id === `folio.room.${view}`) ?? null
}

// ---- The sidebar column: Binder or Inspector (layout 1A) -------------------------------------

/** `mode`: what the sidebar column shows. `titleRow`: the Folio title row is the selection (the inspector shows the Folio's own details). */
export type SidebarState = { mode: 'binder' | 'inspector'; titleRow: boolean }
export const INITIAL_SIDEBAR: SidebarState = { mode: 'binder', titleRow: false }
export type SidebarAction = 'toggle-inspector' | 'close-inspector' | 'show-binder' | 'show-inspector' | 'select-title-row' | 'select-part'

/**
 * The sidebar's state after an action. ⌥⌘I is `toggle-inspector`; × is `close-inspector` and brings the binder back; the
 * switch at the top is `show-binder` / `show-inspector`. Clicking the Folio title row asks for the Folio's details, so
 * it makes the title row the subject AND shows the inspector; selecting a part changes only the subject (back to the
 * part) and never opens or closes the inspector.
 */
export function sidebarAfter(state: SidebarState, action: SidebarAction): SidebarState {
  switch (action) {
    case 'toggle-inspector': return { ...state, mode: state.mode === 'inspector' ? 'binder' : 'inspector' }
    case 'close-inspector':
    case 'show-binder': return state.mode === 'binder' ? state : { ...state, mode: 'binder' }
    case 'show-inspector': return state.mode === 'inspector' ? state : { ...state, mode: 'inspector' }
    case 'select-title-row': return state.titleRow && state.mode === 'inspector' ? state : { mode: 'inspector', titleRow: true }
    case 'select-part': return state.titleRow ? { ...state, titleRow: false } : state
  }
}

// ---- Cards: Group by status (the Board's lanes, now an option of Cards) ------------------------

/**
 * The lane order Cards uses: the Board's saved column order for this folder when there is one (statuses it does not
 * name follow in the default order), else the default Board order.
 */
export function laneOrder(saved: readonly string[]): string[] {
  if (saved.length === 0) return [...BOARD_STATUS_ORDER]
  const named = new Set(saved.map((status) => status.toLowerCase()))
  return [...saved, ...BOARD_STATUS_ORDER.filter((status) => !named.has(status.toLowerCase()))]
}

/**
 * Parts grouped into the Board's status lanes. Every status in `order` has a lane, empty or not (an empty lane is a drop
 * target: the Board drew every column), then any other status the parts carry, in the order first seen. Comparison
 * ignores case; a known lane carries the order's spelling, another the spelling the first part wrote. Parts keep their
 * running order inside a lane.
 */
export function groupByStatus<T extends { status: string }>(parts: readonly T[], order: readonly string[]): Array<{ status: string; parts: T[] }> {
  const lanes = new Map<string, { status: string; parts: T[] }>()
  for (const status of order) if (!lanes.has(status.trim().toLowerCase())) lanes.set(status.trim().toLowerCase(), { status, parts: [] })
  for (const part of parts) {
    const key = part.status.trim().toLowerCase()
    const lane = lanes.get(key) ?? { status: part.status, parts: [] }
    lane.parts.push(part)
    lanes.set(key, lane)
  }
  return [...lanes.values()]
}

/** The status one lane over from `status` (`step` 1 = right, -1 = left), or null at either end or for a status with no lane. */
export function neighbourLaneStatus(lanes: ReadonlyArray<{ status: string }>, status: string, step: 1 | -1): string | null {
  const at = lanes.findIndex((lane) => lane.status.toLowerCase() === status.trim().toLowerCase())
  return at < 0 ? null : lanes[at + step]?.status ?? null
}

/** The chords that move the selected card one lane left or right while Cards are grouped by status. */
export const LANE_MOVE_CHORDS = { left: '⌥←', right: '⌥→' } as const

// ---- Open Folio (⌘↵) and Open Folio at another part (⇧⌘↵), inside the workspace ------------------

/** The parts "Open Folio" can open: the written parts that have a file, in running order. */
export function workspaceOpenParts(parts: ReadonlyArray<{ title: string; written: boolean; key: { path: string | null } }>): Array<{ path: string; title: string }> {
  return parts.flatMap((part) => (part.written && part.key.path ? [{ path: part.key.path, title: part.title }] : []))
}

/** The chord that opens the selected part in the Text tab (⌘↵ keeps its pre-workspace meaning: open the Folio at its first part). */
export const OPEN_SELECTED_CHORD = '⇧↵'

// ---- The binder's Not in the outline: the Folio page's own eligibility and wording ------------------

/**
 * What a file under Not in the outline offers, from the Plan's own row (main decides: `putBackRefusal` is its sentence, and
 * main refuses a file it would not put back, by index, whatever the screen offers). A file with a refusal cannot be added as
 * a part or as front matter, and shows the sentence; a file with no path cannot be opened or added.
 */
export function unlistedRowFacts(part: { title: string; path: string | null; heading?: { title: string } | null; putBackRefusal?: string | null; frontMatterOffer?: unknown }): {
  title: string; path: string | null; refusal: string | null; canAdd: boolean; canAddFrontMatter: boolean; canOpen: boolean; headingChoice: boolean
} {
  const refusal = part.putBackRefusal ?? null
  const eligible = part.path !== null && refusal === null
  return {
    title: part.heading?.title ?? part.title,
    path: part.path,
    refusal,
    canAdd: eligible,
    canAddFrontMatter: eligible && Boolean(part.frontMatterOffer),
    canOpen: part.path !== null,
    headingChoice: part.path !== null && Boolean(part.heading),
  }
}

/** Creation stays unavailable until ancestry is known. The empty string is a Folio at the root. */
export function canStartFolioOutline(containingFolio: string | null | undefined, alreadyFolio: boolean): boolean {
  return containingFolio === null && !alreadyFolio
}

import type { FolioSectionExportField } from '../shared/folio-sections'
import type { MapOp } from '../shared/folio-map'
import type { MapWriteResult } from '../main/folio-map'
import type { AssistantTurnsState, AssistantTurnUndo } from '../shared/assistant-turns'
import type { TurnActivity } from '@bridle/core'
import type { MetadataValues } from '../shared/metadata-registry'
import type { AmbientSnapshot } from '../main/ambient'
import type { ModelDiscoveryReason, ModelRefreshResult, ModelsChecked } from '../shared/model-refresh'
export type { AmbientSnapshot } from '../main/ambient'
import { clipboard, contextBridge, ipcRenderer, webUtils } from 'electron'
import { createAuthTransport } from '@bridle/electron/preload'
import type { AuthTransport } from '@bridle/electron'
import { invokeTurnBackAfterNotifications, multiplexIpcChannel } from './subscriptions'
import type { ArchivePassageResponse, ArchiveSearchRequest, ArchiveSearchResponse } from '../shared/scout'
import type { PreserveResult } from '../shared/preserve-receipt'
import type { OpenLinkResult } from '../main/scout-ipc'
import type { CaptureRequest, CaptureResponse } from '../shared/research-capture'
import type { WidgetReadResult } from '../main/widget-ipc'
import type { WidgetChoices, WidgetDropResult } from '../main/widget-insert'
import type { OwnFolderFactsAnswer } from '../main/standard-widgets/own-folder'
import type { CleanUpResult, LeftoverStep } from '../main/standard-widgets/step-journal'
import type { CreateWidgetCall, CreateWidgetResult, PreviewCall, PreviewResult, UndoResult, UpdateRecipeCall, UpdateRecipeResult } from '../main/standard-widgets/operations'
import type { PickAnswer } from '../main/standard-widgets/outside-files'
import type { SourceFileListing } from '../main/standard-widgets/source-files'
import type { BuildOutcome } from '../main/standard-widgets/build'
import type { FolioPlace } from '../shared/folio-place'
import type { SaveBasis } from '../shared/save-basis'
import type { CollectionChanged } from '../shared/listing-patch'
import type { FolioAgentInstructionsAction, FolioAgentInstructionsStatus } from '../shared/folio-agent-files'
export type { FolioAgentInstructionsAction, FolioAgentInstructionsStatus } from '../shared/folio-agent-files'
export type { FolioPlace } from '../shared/folio-place'
import type { FolioOutline } from '../shared/folio-outline'
import type { RoomAuthoringRequest, RoomAuthoringResult } from '../shared/folio-room-authoring'
import type { FolioRoomModel, RoomState } from '../shared/folio-room'
import type { RoomCardResult, RoomOrderResult } from '../shared/folio-room-order'
import type { FolioDetailAnswer, FolioDetailField, FolioDetailUndoAnswer, FolioDetailValuesAnswer, FolioDetailsRead } from '../shared/folio-details'
import type { VaultIndex } from '../shared/vault-index'
import type { VaultPreview } from '../shared/vault-preview'
export type { VaultPreview } from '../shared/vault-preview'
import type { RootSwitchResult, RootSwitchTarget, SwitcherList } from '../shared/vault-switcher'
export type { RootSwitchResult, RootSwitchTarget, SwitcherList } from '../shared/vault-switcher'
export type { VaultHidden, VaultIndex, VaultWork, VaultWorkKind } from '../shared/vault-index'
import type { PlanCardKey, PlanOrderResult, PlanPartKey, RunningOrderResult } from '../shared/folio-running-order'
export type { RunningOrderResult } from '../shared/folio-running-order'
import type { ExportOrderCheck, ExportOrderExpected, ExportOrderRepairResult } from '../shared/export-order-agreement'
export type { ExportOrderAgreement, ExportOrderCheck, ExportOrderExpected, ExportOrderRepairResult } from '../shared/export-order-agreement'
export type { FolioOutline, FolioOutlineFile, FolioOutlineHeading } from '../shared/folio-outline'
export type { FolioRoomModel, RoomPart, RoomState, RoomSurface, RoomView } from '../shared/folio-room'
import { RENAME_REPAIR_ISSUE_KINDS } from '../shared/rename-repair-message'
import { e2eWriteHooksFromProcess } from '../shared/e2e-write-hooks'
import type { OutsideBulkAccept, OutsideChangeFields, OutsideSource, OutsideSummary } from '../shared/outside-source'
import type { ClosedCode } from '../shared/closed-code'
import type { BoardStatus } from '../shared/collection-status'
import type { ClipboardKind } from '../main/clipboard'
import type { ExportFormat, ExportOutcome, HtmlExportOptions } from '../main/export'
import type { TocDepthRefusal, TocDepthScope, TocDepthSource, TocDepthWriteResult } from '../main/export-toc-depth'
import type { ExplicitSessionState } from '../shared/explicit-session'
import type { AgentNote, AgentObjectNote, AgentProseNote } from '../main/agent-notes'
import type { CollectionDigest } from '../main/digest'
import type { DrawerScrap, DrawerSource, Offcut, PieceDrawer, SourceUser } from '../main/piece-material'
import type { ExportPresetSettings } from '../shared/export-presets'
import type { ShelfCollectionNode } from '../shared/shelf-collections'
import type { AttachAddressRequest, SharingDomainsResult, SharingRemovalQuestion, SharingRemoveRequest, SharingResult, SharingSetupStatus } from '../shared/sharing-setup'
import type { MakeLinkRequest, PieceSharingView, SharingLinkResult } from '../shared/sharing-links'
import type { OpenedCounts, SharesListView } from '../shared/sharing-shares-list'
import type { LimitsActionResult, NotesCounts } from '../shared/sharing-notes'
import type { PlanAcceptEdits, PlanAcceptResult, PlanProposalView, PlanUndoResult } from '../shared/plan-proposal'
import type { PieceSourceListing } from '../shared/piece-sources'
import type { ScratchPlacementReceipt, ScratchpadBridge } from '../shared/scratchpad-items'
import type { AppendScrapInput, AttachSourceInput, BoardStepResult, BoardUndoResult, PromoteOffcutInput } from '../shared/board-material'
export type { PlanAcceptEdits, PlanAcceptResult, PlanProposalView, PlanUndoResult }
export type { BoardStep, BoardStepResult, BoardUndoResult } from '../shared/board-material'
import type { VaultChangedEvent, VaultCreateInput, VaultSettings, VaultView, VaultWriteResult } from '../shared/vault'
export type { VaultChangedEvent, VaultCreateInput, VaultSettings, VaultStep, VaultView, VaultWriteRefusal, VaultWriteResult } from '../shared/vault'

export type { ClipboardKind, ExportFormat, ExportOutcome, HtmlExportOptions, ExplicitSessionState }
export type { AgentNote, AgentObjectNote, AgentProseNote, CollectionDigest }
export type { ExportPresetSettings }
export type { TocDepthRefusal, TocDepthScope, TocDepthSource, TocDepthWriteResult }
/** What the sheet is exporting: this piece, or the Collection it sits in (ADR-0029). */
export type ExportChoice =
  | { scope: 'piece'; path: string; format: ExportFormat }
  | { scope: 'collection'; dir: string; format: ExportFormat }
/** Title displayed in the Export sheet; source may be the current unsaved buffer. */
export type ExportTitleChoice =
  | { scope: 'piece'; path: string; source?: string }
  | { scope: 'collection'; dir: string; sources?: Array<{ path: string; source: string }> }
/** What a copy put on the clipboard, so the renderer can say so. */
export type ClipboardCopyResult = { kind: ClipboardKind; label: string; flavours: string[]; characters: number }
import type { Skill, SkillInput, SkillLoadError } from '@bridle/core'

export type MarkdownFile = { path: string; name: string; directory: string; modifiedAt: number; size: number }
/** A checklist note's "done / total" (Files tree and Quick Open chips). */
export type ChecklistProgress = { path: string; done: number; total: number }
export type WorkspaceState = { root: string | null; files: MarkdownFile[]; folders: string[]; assetBaseUrl: string | null }
export type FileReadResult = { file: MarkdownFile; content: string }
export type RenameRepairIssue = { kind: 'reference' | 'file' | 'reason' | 'outcome'; text: string }
export type RenameFileResult = FileReadResult & {
  repair: { writtenPaths: string[]; unrepairedReferences: string[]; issues: RenameRepairIssue[] }
}
export type FileRenamePlan = { newPath: string; repairPaths: string[] }
export type FileSaveRefusal = {
  refused: true
  path: string
  message: string
  rescueDirectory: string
  previousRescuePath: string
  rejectedRescuePath: string
}
/** An editor save refused because the disk no longer holds the version the save was based on (its
 *  SaveBasis). Nothing was written. `diskText`: what is on disk now (null: no file there). */
export type FileSaveDiskChanged = {
  refused: 'disk-changed'
  path: string
  diskText: string | null
  message: string
}
/** An exclusive create (SaveBasis `create`: a recovery copy) found the name taken. Nothing was written. */
export type FileSaveNameTaken = { refused: 'name-taken'; path: string; message: string }
/** A save main made, or found already made: `content` is the file read back, `written` the text the
 *  buffer is based on from now (what was written, or found when nothing was). They differ only when
 *  another program wrote the file between the commit and the readback: an outside change. */
export type FileSaveWritten = FileReadResult & { written: string; seq?: number }
/** The receipt of one write call main made to an open document (document-owner plan, parcel 1): the text
 *  THAT call wrote (`written`) and its place in the workspace's order of writes (`seq`). */
export type WriteReceipt = { written: string; seq: number }
export type FileSaveResult = FileSaveWritten | FileSaveRefusal | FileSaveDiskChanged | FileSaveNameTaken
export type { SaveBasis }
export type ClearDocumentResult = { file: FileReadResult & Partial<WriteReceipt>; rescueDirectory: string | null } | FileSaveDiskChanged
export type SearchMatch = {
  path: string
  line: number
  column: number
  length: number
  preview: string
  /** Every term span on the best line, 1-based columns into `preview`, so the preview marks them all. */
  marks: Array<{ column: number; length: number }>
  context: { before: string[]; after: string[] }
  /** The best line as the result row shows it: `text` (cut around the marks on a long line, `…`
   *  where cut) with every term span marked — 1-based columns into `text`. */
  snippet: { text: string; marks: Array<{ column: number; length: number }> }
}
/** A workspace search result: one match per piece, ranked and capped; `total` counts every matching
 *  piece; `note` is 'literal' when an invalid /regex/ fell back to a literal search. */
export type SearchResult = { matches: SearchMatch[]; total: number; note?: 'literal'; scope?: SearchScopeCounts }
/** Folder-scoped search (ticket 03): which side `matches` came from, and both piece counts. */
export type SearchScopeCounts = { folder: string; results: 'folder' | 'everywhere'; inFolder: number; everywhere: number }
/** The folder focused in this window; `kind` picks the Search switch label. */
export type FolderFocus = { path: string; kind: 'folio' | 'collection' | 'folder' }
export type RecentWorkspace = { root: string; openedAt: number; focus?: string }
/** One pinned Workspace root, in the user's order; `missing` when the folder is no longer on disk. */
export type PinnedWorkspace = { root: string; missing: boolean }
/** The Example collection as the start screen draws it: where it is and how many lesson files it holds. */
export type GuideContext = { shown: boolean; here: boolean; /** Not shown, and it may be brought back (removed, or never finished). */ canRestore?: boolean; /** The person removed it (state `removed`). */ removed?: boolean; /** A route in main asked this window to open its Guide tab (taken once). */ wantsTab?: boolean }
/** "Remove the example?": the folder as it is on disk (home-relative where it can be) and the files in it now. */
export type ExampleRemovalPreview = { ok: true; folder: string; files: number; /** Given back to `removeExample`. Not a path. */ token: string } | { ok: false; message: string }
/** Removing or bringing back the example: done, or one sentence saying why not. */
export type ExampleChangeResult = { ok: true; outcome: string } | { ok: false; message: string }
export type ExampleCollectionView = { root: string; location: string; lessonFiles: number }
/** The start screen's whole model, as main computed it: the marked entries or none, the person's
 *  pins in the order they are numbered, and the recents that are not pins. */
export type StartVault = { root: string; name: string; location: string; works: number | null; inProgress: number | null; lastWorked: number | null }
export type StartScreenModel = { example: ExampleCollectionView | null; pinned: PinnedWorkspace[]; recents: RecentWorkspace[]; /** Vaults (pins and recents that hold a vault file), listed only here; absent or empty: no Vaults row. */ vaults?: StartVault[] }

export type JumpKind = 'bookmark' | 'comment' | 'task'
export type JumpEntry = { kind: JumpKind; file: string; line: number; text: string; done?: boolean }
/** A folder-scope scan result: a jump OR an ATX heading (Task 10). File scope returns only jumps. */
export type OutlineScanEntry =
  | JumpEntry
  | { kind: 'heading'; file: string; line: number; text: string; level: number }

/** A file-native cutting (Task 20, ADR-0008). `origin` is the group label (the source doc's
 *  basename); `expandTrigger`, when set, is the `{trigger}` that expands the body in the editor. */
/** `source` (scraps:list): `lossless` is a floating Scratchpad item (id `p_…`, exact Markdown as `text`). */
export type Scrap = { id: string; origin: string; text: string; done: boolean; colour?: string; expandTrigger?: string; source?: 'legacy' | 'lossless'; how?: 'cut' | 'copy' }

/** A reference-material file under research/ (Task 21, PRD S30). `kind` drives the row icon and the
 *  open-vs-reveal split: md sources open in a tab, everything else reveals in the OS file manager. */
export type SourceKind = 'md' | 'pdf' | 'image' | 'other'
export type SourceFile = { name: string; path: string; kind: SourceKind; size: number }

/** A file's parsed frontmatter (Task 22, ADR-0008). Read-only: null when the file is bare (frontmatter
 *  is never auto-inserted). Core fields promote; every other key is preserved in `extra`. */
export type Frontmatter = {
  title?: string
  date?: string
  status?: string
  description?: string
  purpose?: string
  related?: string[]
  tags?: string[]
  series?: string
  seriesOrder?: number
  extra: Record<string, unknown>
}

/** A Collection (Task 23, ADR-0008): a folder's own pieces as a metadata table under an Index-Note
 *  cover. `cover` is null when the folder declares none; a `bare` row carries no frontmatter. */
export type CollectionCover = { text: string | null; source: string; path: string }
export type CollectionRow = {
  path: string
  name: string
  title: string | null
  purpose: string | null
  status: string | null
  modified: number
  words: number
  /** Read-only view snapshot derived through the shared search-index facts cache. */
  searchText?: string
  tags?: string[]
  bare: boolean
  provenance: { title: 'written' | 'derived'; purpose: 'written' | 'derived'; status: 'written' | 'derived' }
  folderPath?: string
  folderPieceMode?: 'one' | 'many'
}
export type CollectionSubfolder = {
  path: string
  name: string
  title: string | null
  status: string | null
  work: 'folio' | 'folder-piece' | 'file' | null
  pieces: number
  modified: number
}
export type Collection = { name: string; cover: CollectionCover | null; rows: CollectionRow[]; subfolders: CollectionSubfolder[] }
export type CollectionSignals = {
  frontmatterPattern: boolean
  frontmatterPieceCount: number
  indexNote: boolean
  indexSiblingLinkCount: number
  siblingWikilinks: boolean
  siblingWikilinkCount: number
}
export type CollectionStatus = { collection: boolean; signals: CollectionSignals; pieceCount: number }
export type CollectionPattern = { keys: string[]; statuses: string[] }
export type QueryFilterField = 'title' | 'date' | 'status' | 'description' | 'purpose' | 'related' | 'tags' | 'goal' | 'due' | 'project' | 'words'
export type QuerySortField = 'date' | 'title' | 'status' | 'description' | 'purpose' | 'goal' | 'due' | 'project' | 'words'
export type QuerySortDirection = 'asc' | 'desc'
export type Query = Partial<Record<QueryFilterField, string[]>> & {
  folder?: string
  sort?: { field: QuerySortField; direction: QuerySortDirection }
  limit?: number
}
export type QueryError = { line: number; message: string; humanReadable: string }
export type QueryRow = {
  path: string
  title: string
  status: string | null
  description: string | null
  date: string | null
  words: number
  goal?: number | null
  due?: string | null
  project?: string | null
  purpose?: string | null
  agentAuthored: boolean
  provenance: { title: 'written' | 'derived'; status: 'written' | 'derived'; date: 'written' | 'derived' }
  folderPath?: string
  /** Scraps whose origin is this piece, and its sources (frontmatter `sources:` + wikilinked research notes). */
  scrapCount: number
  sourceCount: number
  /** The piece's open and ticked boxes (the Board card's "n / m to do" chip); both 0 when it has none. */
  taskOpen: number
  taskDone: number
  /** The Board card's drawer listing; present only when either count is above zero. */
  drawer?: PieceDrawer
  /** A scraps file or a research note: a piece's material, never a Board card. */
  material?: 'scraps' | 'research'
  /** On a scraps file: its scraps, as the Board's Offcuts column lists them. */
  offcuts?: Offcut[]
  /** On a piece: the floating Scratchpad's items cut from it and still waiting. */
  looseOffcuts?: Offcut[]
  /** On a research note: the pieces that use it, as the Board's Sources rail names them. */
  usedBy?: SourceUser[]
}
export type { DrawerScrap, DrawerSource, Offcut, PieceDrawer, SourceUser }
export type QueryResult =
  | { ok: true; source: string; query: Query; rows: QueryRow[] }
  | { ok: false; source: string; error: QueryError }
export type CollectionQueryInvalidation = { paths: string[] }
export type CollectionLink = { from: string; to: string | null; target: string; display: string; ambiguous?: string[] }
export type UnresolvedFolderPiece = { folderPath: string; title: string }
export type CollectionTarget = { windowId: number; name: string; current: boolean }
export type CountedCollection = { root: string; dir: string; name: string; pieces: number }
export type StubInput = { dir: string; title: string; gist: string; path?: string; role?: string; bodyLead?: string; titleInFrontmatter?: boolean; suppressBacklink?: boolean; from?: string; createAnyway?: boolean; windowId?: number }
export type StubPreview = { path: string; content: string; seeded: boolean; explanation: string; existing: string[] }
export type CreateStubResult = { created: true; path: string; content: string; seeded: boolean } | { created: false; existing: string[] }

/** A Folio manifest (Task 24, ADR-0008): a folder declared to compile to one output in a fixed order.
 *  `contentRoot` is relative to the folder; each file's `path` is relative to contentRoot. */
export type FolioFile = { path: string; role?: string; render?: string; toc?: boolean }
export type Folio = { contentRoot: string; output?: string; titleMatter?: string; files: FolioFile[]; contentRootRefused?: true }
/** A listed Folio entry that an export leaves out, with its path as the manifest wrote it. */
export type FolioLeftOut = { path: string; reason: 'not-found' | 'outside-folio' | 'agent-instructions' | 'room-support' }
/** A Folio's listed entries, resolved by main: the pieces in order, and the entries left out. */
export type FolioPieces = { pieces: string[]; leftOut: FolioLeftOut[] }
/** What the part-title rule says of a part's file (shared/folio-part-title.ts). */
export type PlanPartHeading = { title: string; mode: 'own' | 'none' | 'missing'; from: 'heading' | 'frontmatter' | 'file-name'; headingText: string | null; frontmatterTitle: string | null; mismatch: boolean; fingerprint?: string; frontMatter?: true }
/** Which way a title-conflict fix goes (shared/title-conflict.ts). */
export type TitleFixDirection = 'heading-to-title' | 'title-to-heading'
/** A title-conflict fix's answer (main/title-conflict-fix.ts): what was written, each file that was not and why,
 *  and the token of its one Undo step (null: nothing written). `ok: false`: nothing was written. */
export type TitleFixAnswer =
  | { ok: true; written: string[]; skipped: Array<{ path: string; message: string }>; undo: string | null }
  | { ok: false; message: string }
export type TitleUndoAnswer = { ok: true; restored: string[]; kept: Array<{ path: string; message: string }> } | { ok: false; message: string }
export type PlanPart = { sectionPage?: true; resolution?: 'missing' | 'ambiguous'; title: string; gloss: string | null; role: string; tags: string[]; path: string | null; line: number; manifestBacked?: boolean; putBackRefusal?: string; under?: string; heading?: PlanPartHeading; titlePage?: true; manifestTitlePage?: true; frontMatterOffer?: true }
export type Plan = { sectionRoleUndoToken?: string; dir: string; indexPath: string; headingLine: number; parts: PlanPart[]; unlisted: PlanPart[]; orderFrom?: 'manifest'; indexNoteAbsent?: true }
export type PlanPartInput = { title: string; gloss?: string; role?: string }
/** An order write from the Folio room (spec D-ORD-2): `createManifest` creates the manifest on a Folio that has none. */
/** `room`: the Folio room's order write (ticket 11), through the room's pinned view, with `createManifest`, refused while two parts share a title. */
export type PlanOrderWrite = { createManifest?: boolean; room?: true }

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high'
export type TurnExecution = { turnId: string; provider: string; modelId: string; thinkingLevel: ThinkingLevel; completedAt: number }
export type ChatMessage = { role: 'user' | 'assistant' | 'tool'; content: string; createdAt: number; error?: boolean; execution?: TurnExecution }
export type ModelChoice = { provider: string; id: string; name: string }
export type Suggestion = { id: string; capabilityName: string; input: unknown; preview?: string; stagedAt: number }
export type ProseEditCategory = 'typo' | 'grammar' | 'wording' | 'structure' | 'clarity' | 'tone' | 'other'
export type ProseEditInput = { path: string; oldText: string; newText: string; category: ProseEditCategory; summary: string }
export type ProseMoveInput = { path: string; text: string; insertAfter: string; summary: string }
export type ProseInsertInput = { path: string; insertAfter: string; text: string; category: ProseEditCategory; summary: string }
// Change Ledger (ADR-0010/0011/0014). These mirror the engine Change record so the renderer has
// no dependency on main; the boundary carries plain data. `editClass` is internal, `category` is the
// writer-facing axis, and `provenance` records who made the edit.
export type Provenance = 'agent' | 'writer' | 'reviewer'
export type EditClass = 'copy' | 'content' | 'move' | 'insert' | 'housekeeping'
export type ChangeStatus = 'pending' | 'accepted' | 'rejected' | 'held'
export type EditSessionStatus = 'open' | 'reviewing' | 'saved' | 'discarded'
type LedgerChange = {
  id: string
  path: string
  ts: number
  provenance: Provenance
  editClass: EditClass | null
  category: string | null
  summary: string
  oldText: string
  newText: string
  anchor?: { from: number; to: number }
  moveFrom?: { from: number; to: number }
  moveTo?: { from: number; to: number }
  /** For `editClass: 'insert'`, the exact unique text the new content is inserted after; '' = append at end. */
  insertAfter?: string
  status: ChangeStatus
  isCorrection: boolean
  sessionId?: string
  appliedBy?: 'writer' | 'agent'
  reviewerLabel?: string
  snapshotId?: string
  versionId?: string
  author?: AuthorIdentity
  /** A new file that accepting this Change also writes (the agent's widgets.create): its workspace-relative
   *  path and full content, shown on the margin card; main writes only bytes that hash to `sha256`. */
  newFile?: { path: string; content: string; sha256: string }
  /** Set when the Change was closed without being applied (its text or file has gone, or its path is
   *  not a document): the reason to show, and when. Its status is then 'rejected'. */
  closedReason?: string
  closedAt?: number
  /** With `closedReason`: the same reason from a closed list (shared/closed-code.ts), for the dock to
   *  choose its own sentence by. Absent on a record closed before the code existed: read it with
   *  `closedCodeOf`, which answers `other` then. */
  closedCode?: ClosedCode
  /** A Change over the whole document: `oldText` is the document as it stood, `newText` what it would
   *  become. It is applied only while the document is exactly `oldText`. */
  whole?: true
  /** A Change to the frontmatter only: `oldText` is the whole frontmatter block as proposed over, `newText` the new block;
   *  placed only while the document's block is exactly `oldText`. A whole-document record that changes only the frontmatter is read so too. */
  frontmatter?: true
}
/**
 * A Change that came from outside WriteFlex through the command line (ticket 06) also carries
 * `outsideSource`, `outsideRequest` and, when refused, `outsideRefused` and `outsideIntended`. The
 * fields and the closed list of sources are defined once, in shared/outside-source.ts.
 */
export type Change = LedgerChange & OutsideChangeFields
export type { OutsideBulkAccept, OutsideChangeFields, OutsideLook, OutsideSource, OutsideSummary } from '../shared/outside-source'
export type { ClosedCode } from '../shared/closed-code'
export type EditSession = {
  id: string
  path: string
  startedTs: number
  turnId?: string
  status: EditSessionStatus
  versionId?: string
  note?: string
}
/** Any subset narrows the list; an omitted field never constrains. */
export type ChangeScope = { path?: string; provenance?: Provenance; status?: ChangeStatus }
export type AuthorIdentity = { name: string; email?: string }
export type Version = {
  id: string
  path: string
  name: string
  author: AuthorIdentity
  ts: number
  note?: string
  snapshotId?: string
  versionId?: string
}
export type VersionScope = { path?: string }
export type VersionCompareEndpointId = string | 'working'
export type VersionCompareEndpoint = { id: string; name: string; ts: number | null; author: AuthorIdentity | null; working: boolean }
export type ContentDiffSegment = { kind: 'equal' | 'added' | 'removed'; text: string }
export type AttributedChange = Change & {
  author: AuthorIdentity
  sourceVersionId: string | null
  sourceVersionName: string | null
  compareOldText: string
  compareNewText: string
  compareSegments?: ContentDiffSegment[]
  compareOldStart?: number
  compareOldLines?: number
  compareNewStart?: number
  compareNewLines?: number
  diffKind?: 'added' | 'removed' | 'changed'
}
export type VersionCompareResult = {
  path: string
  from: VersionCompareEndpoint
  to: VersionCompareEndpoint
  fromContent: string
  toContent: string
  direction: 'forward' | 'reverse' | 'same'
  versionIds: string[]
  changes: AttributedChange[]
}
export type VersionContentRequest = { id?: string; versionId?: string; snapshotId?: string; path?: string }
export type VersionContentResult = { version: Version | null; path: string | null; snapshotId: string | null; content: string | null }
/** The fields a caller supplies to add a change; main assigns id, ts, and defaults status to 'pending'. */
export type NewChange = Omit<Change, 'id' | 'ts' | 'status' | 'category'> & {
  ts?: number
  status?: ChangeStatus
  category?: string | null
}
export type ApprovalRequest = { id: string; capabilityName: string; risk: string; input: unknown; preview?: string; requestedAt: number }
export type TraceEvent = { id: string; type: string; timestamp: number; title: string; summary?: string; metadata?: Record<string, unknown> }
export type CapabilityOutcome = { text: string; isError?: boolean; details?: unknown }

export type ThreadKind = 'chat' | 'skill'
/** A thread row for the switcher/palette (0.7b B1): metadata only, transcripts stay in main. */
export type ThreadMeta = { id: string; kind: ThreadKind; skillName?: string; title: string; lastActiveAt: number }
/** A run-as-is settled (threads:run-complete push) — the M4 toast's facts. */
export type ThreadRunComplete = { threadId: string; skillName: string; reply: string | null; suggestionsStaged: number; outcome: 'completed' | 'error' }

/** Plain model projection only; catalogue pushes never hydrate conversation state. */
export type AgentModelsChanged = {
  catalogue: ModelChoice[]
  models: ModelChoice[]
  discovery: 'succeeded' | 'failed' | 'skipped'
  reason?: ModelDiscoveryReason
  at: number
  modelNotice: string | null
  /** When the model list was last checked (Bridle `lastDiscovery()`), for the "Last checked" line. */
  modelsChecked: ModelsChecked | null
}

export type AgentState = {
  available: boolean
  messages: ChatMessage[]
  suggestions: Suggestion[]
  pendingApprovals: ApprovalRequest[]
  model: { provider: string; id: string } | null
  models: ModelChoice[]
  /** The full model catalogue, configured or not — display names for a signed-out selection. */
  catalogue: ModelChoice[]
  thinking: ThinkingLevel
  /** Workspace-wide defaults copied into each new thread. */
  defaults: {
    model: { provider: string; id: string }
    thinking: ThinkingLevel
    sources: { model: 'settings' | 'codex' | 'built-in'; thinking: 'settings' | 'codex' | 'built-in' }
  }
  /** The ACTIVE thread this state belongs to; null before the thread world binds. */
  thread: { id: string; kind: ThreadKind; skillName?: string; title: string } | null
  /** Human copy when the active thread's boot failed (missing/malformed skill) — the designed
   *  notice; the thread stays selected and retryable, never a silent chat fallback. */
  threadError: string | null
  /** Quiet one-time explanation when an old thread model fell back at boot. */
  modelNotice: string | null
  /** When the model list was last checked (Bridle `lastDiscovery()`), for the "Last checked" line. */
  modelsChecked: ModelsChecked | null
  /** "Ask first" (fix 04, 2026-10-06): the chat's model is gone and its provider offers no other, so
   *  it will not start until the user picks one. `candidates` are the other providers' runnable
   *  models, OpenAI first. Null when the chat can run. */
  modelChoice: { candidates: Array<{ provider: string; id: string }> } | null
}

/** A generic setting value (Task 17). Unset keys read as null; the renderer applies defaults. */
export type SettingValue = string | number | boolean
export type SettingsRecord = Record<string, SettingValue>
/** One settings-changelog row, newest first. `old` null = the key was previously unset. */
export type SettingsChangeEntry = { key: string; label: string; old: SettingValue | null; new: SettingValue | null; at: number; reverted?: boolean }
export type ReadingRoomDocument = {
  attachmentKey: string
  authorYear: string
  itemKey: string
  kind: 'pdf' | 'snapshot'
  libraryId: number
  path: string
  shortTitle: string
}
/** One row of the global recents history (ReadFlex ADR-0032). Keys, not a path: the entry still
 *  resolves after the paper is reindexed, retitled in Zotero or moved on disk. */
export type RecentDocumentRow = {
  attachmentKey: string
  authorYear: string
  itemKey: string
  libraryId: number
  openedAt: string
  shortTitle: string
}
export type ReadingRoomState = {
  citationBaseLink: string
  document: ReadingRoomDocument | null
  readerHtml: string
  roomWidth: number
  viewState: Record<string, unknown> | null
}
export type ReadingBookmarkRow = {
  createdAt: string
  id: number
  label: string
  position: Record<string, unknown>
}
/** The Shelf's row and result shapes, mirrored from `src/main/reading-room-shelf.ts`. */
export type ShelfRowKind = 'pdf' | 'snapshot' | 'other' | 'none'
export type ShelfAttachmentRow = {
  key: string
  title: string
  kind: ShelfRowKind
  badge: string
  state: 'stored' | 'missing' | 'link' | 'linked-file' | 'unsupported'
  openable: boolean
  notice: string | null
}
export type ShelfRow = {
  libraryId: number
  itemKey: string
  authorYear: string
  title: string
  citationKey: string
  citationLink: string
  kind: ShelfRowKind
  badge: string
  openable: boolean
  attachmentKey: string | null
  notice: string | null
  attachments: ShelfAttachmentRow[]
}
export type HighlightBodyKind = 'quote' | 'note' | 'mark'
export type HighlightRow = {
  zoteroKey?: string | null
  key: string
  type: 'highlight' | 'note' | 'image' | 'ink' | 'underline' | 'text' | 'unknown'
  bodyKind: HighlightBodyKind
  body: string
  comment: string | null
  pageLabel: string | null
  colour: string | null
  tags: string[]
  position: string
  sortIndex: string
  isExternal: boolean
  /** The shown state is an edit made here that has not reached Zotero. Quiet, never a warning. */
  keptHere?: boolean
}
/** One highlight Zotero would not take, as the "Not sent to Zotero" list shows it. */
export type RefusedHighlight = {
  id: number
  kind: 'refused' | 'conflict'
  documentTitle: string
  excerpt: string
  reason: string
  /** ISO-8601. */
  date: string
  retryable: boolean
  position: string | null
  open: { libraryId: number; itemKey: string; attachmentKey: string } | null
}
export type ReaderPaintAnnotation = {
  key: string
  type: 'highlight' | 'note' | 'image' | 'ink' | 'underline' | 'text'
  text: string | null
  comment: string | null
  color: string | null
  pageLabel: string | null
  sortIndex: string
  position: string
  tags: string[]
  isExternal: boolean
}
export type HighlightsResult = {
  rows: HighlightRow[]
  forReader: ReaderPaintAnnotation[]
  colours: string[]
  tags: string[]
  error: string | null
}
/** Which refusal a drain hit, when it hit one. Mirrors the main process's `DrainSkipReason`. */
export type ReadingRoomWriteRefusal =
  | 'no-credential'
  | 'zotero-closed'
  | 'zotero-busy'
  | 'plugin-missing'
  | 'plugin-outdated'
  | 'plugin-not-paired'
export type ReadingRoomKeptLocal = {
  code: 'unsupported-position'
  count: number
  created: boolean
  reason: string
}
/**
 * What came back from an attempt to hand highlights to Zotero.
 *
 * `notWritten` is the sentence for a person — *"Zotero is not open. Your highlights are saved here and
 * are sent when Zotero is open."* — and it is the whole point of this shape: ADR-0036 records that the renderer used to
 * discard it, so a refused write was invisible. `notWrittenCode` names the cause, so a surface can say
 * *why* without reading the sentence for keywords.
 */
export type ReadingRoomWriteResult = {
  waiting: number
  rejected: number
  keptLocal?: ReadingRoomKeptLocal
  notWritten?: string
  notWrittenCode?: ReadingRoomWriteRefusal
  /** Rows this drain wrote into Zotero. */
  written?: number
  /** Rows this drain refused or found in conflict; listed with their reason. */
  refusedNow?: number
}
export type ReadingRoomOutboxCounts = Pick<
  ReadingRoomWriteResult,
  'waiting' | 'rejected'
>
export type ReadingRoomCitationResult = Omit<ReadingRoomWriteResult, 'notWrittenCode'> & {
  annotation: ReaderPaintAnnotation | null
  confirmed: boolean
  link: string
  notWrittenCode?: ReadingRoomWriteRefusal | 'document-mismatch'
}
export type { ShelfCollectionNode }
export type ShelfSearchResult = {
  query: string
  rows: ShelfRow[]
  matched: number
  total: number
  error: string | null
  diagnostics: string[]
  zoteroDataDirectory: string
}
export type SkillMeta = {
  name: string
  /** SKILL.md `title:` — the on-screen name when set (ticket 11); absent, the name is shown. */
  title?: string
  description: string
  icon: string | undefined
  tools: string[]
  input: SkillInput
  source: string
}

// Bridle auth migration (0.7a): the bespoke auth types + five invoke wrappers are
// replaced by @bridle/electron's AuthTransport on the bridle.auth:* channels —
// the renderer consumes it via useIpcAuthFlow + @bridle/react's AuthFlow.

export type MenuAction = `collection-page:${import('../shared/collection-page-commands').CollectionPageCommand}` | 'save' | 'name-version' | 'new-file' | 'new-folder' | 'capture-idea' | 'follow-wikilink' | 'materialise-stub' | 'close-tab' | 'quick-open' | 'command-palette' | 'open-files' | 'open-tabs' | 'open-board' | 'next-tab' | 'previous-tab' | 'next-folder-file' | 'previous-folder-file' | 'search' | 'archive-search' | 'toggle-outline' | 'focus-review-margin' | 'switch-margin-view' | 'toggle-margin' | 'open-versions' | 'toggle-typewriter' | 'toggle-left-pane' | 'toggle-right-pane' | 'open-dialog' | 'undo' | 'redo' | 'prose-zoom-in' | 'prose-zoom-out' | 'prose-zoom-reset' | 'column-width-in' | 'column-width-out' | 'open-scratchpad' | 'scratchpad-send-copy' | 'scratchpad-cut' | 'scratchpad-insert-copy' | 'scratchpad-compare' | 'scratchpad-search'

export type RuntimeInfo = { electron: string; chrome: string; node: string; macOS: string }

export type WriteFlexApi = {
  /** Persist an uncaught renderer failure in the main-owned bounded diagnostics log. */
  reportRendererError: (error: { message: string; stack: string; url: string }) => Promise<void>
  /** Reload this webContents after the renderer fallback has protected the window. */
  reloadRenderer: () => Promise<void>
  /** Settings: install the `writeflex` command-line shim; resolves with a readable result either way. */
  installCommandLineTool: () => Promise<{ ok: boolean; message: string }>
  /** Sharing's set-up (ticket 02). The token goes in once, on checkToken; no answer ever holds it. */
  sharing: {
    status: (options?: { askService?: boolean }) => Promise<SharingSetupStatus>
    checkToken: (token: string) => Promise<SharingResult>
    checkSavedToken: () => Promise<SharingResult>
    chooseAccount: (accountId: string) => Promise<SharingResult>
    setUp: () => Promise<SharingResult>
    /** Asked when "Remove sharing?" (or Retry) is shown: the confirmation remove must give back (single-use, this window, minutes, bound to the removal named). */
    removalConfirmation: () => Promise<SharingRemovalQuestion>
    remove: (request: SharingRemoveRequest) => Promise<SharingResult>
    openCloudflare: () => Promise<void>
    /** Ticket 05: the domains on the chosen account the token can reach, for "Use your own address". */
    domains: () => Promise<SharingDomainsResult>
    /** Attach `<name>.<domain>`; main checks both and refuses with the reason before any change. */
    attachAddress: (request: AttachAddressRequest) => Promise<SharingResult>
    /** Take your own address off the sharing service; new links use the Cloudflare address. */
    removeAddress: () => Promise<SharingResult>
    /** Ticket 03: the open piece's links (by its path in this window's Workspace). No answer holds a token. */
    piece: (path: string) => Promise<PieceSharingView>
    /** The Sharing page opened on this piece: main binds every link action of this window to it. */
    open: (path: string) => Promise<PieceSharingView>
    /** Ticket 09: a Folio's links (by its folder in this window's Workspace, '' the Workspace itself). */
    folio: (dir: string, part?: string) => Promise<PieceSharingView>
    /** The Sharing page opened on this Folio: main binds every link action of this window to it, and
     *  Turn off and Copy link to `part`'s own piece links (the part open, review round 1, finding 3). */
    openFolio: (dir: string, part?: string) => Promise<PieceSharingView>
    /** The Sharing page closed: this window can act on no link until it opens a piece again. */
    close: () => Promise<boolean>
    make: (request: MakeLinkRequest) => Promise<SharingLinkResult>
    rename: (shareId: string, name: string) => Promise<SharingLinkResult>
    setComments: (shareId: string, comments: boolean) => Promise<SharingLinkResult>
    turnOff: (shareId: string) => Promise<SharingLinkResult>
    turnOn: (shareId: string) => Promise<SharingLinkResult>
    /** Ticket 04: a link whose piece is not found follows to the place main found holding the same file. */
    followTo: (shareId: string) => Promise<SharingLinkResult>
    retry: (shareId: string) => Promise<SharingLinkResult>
    openLink: (shareId: string) => Promise<boolean>
    /** Copy link: the link's address as main decides it now (null: not a link of the open piece). Copy this, never a cached view. */
    copyAddress: (shareId: string) => Promise<string | null>
    /** Ticket 10: the Shares list of this window's Workspace. Main lists its own records and binds exactly
     *  those links to this window (in place of a piece) until the list closes or is read again. */
    openList: () => Promise<SharesListView>
    /** Ticket 10: how many times each link this window's page or list has bound was opened, from the service (null: not known). */
    opened: () => Promise<OpenedCounts>
    /** Ticket 07: notes waiting and handled for each link this window has bound, and its Limits panel. */
    notes: () => Promise<NotesCounts>
    /** Ticket 07, the Limits panel: Clear handled notes and Raise the limit for this link. */
    clearHandled: (shareId: string) => Promise<LimitsActionResult>
    raiseLimit: (shareId: string) => Promise<LimitsActionResult>
    /** A link or a publish changed (any piece): ask again. */
    onChanged: (fn: () => void) => () => void
  }
  /** Keep Mission Control/window-switcher identity in sync with the renderer's document label. */
  setWindowTitle: (title: string) => Promise<void>
  /** Static preload-time fence used only to install the renderer's forced-crash e2e hook. */
  e2eEnabled: boolean
  /** The e2e write hooks (held, failed or interleaved writes): true only when main passed the argument,
   *  which it does only in an unpackaged e2e run (shared/e2e-write-hooks.ts). */
  e2eWriteHooks: boolean
  /** Hidden-window test instrumentation; returns/reset only a call count, never query content. */
  e2eCollectionQueryCount: () => number
  resetE2eCollectionQueryCount: () => void
  /** Synchronous clipboard read for editor commands that must dispatch against their live state. */
  clipboardText: () => string
  /** Copy (Round B T5): write `markdown` to the clipboard in every flavour `kind` implies — `rich`
   *  puts RTF, HTML and plain text on it TOGETHER, which is the whole point (Word, Teams and Outlook
   *  take RTF as authoritative and reinterpret an HTML-only paste). Only the main process can write
   *  several flavours at once, so this is an invoke, not a renderer-side clipboard call. The caller
   *  supplies the scope: the selection if there is one, otherwise the whole document, and `path` —
   *  the document it came from, which is what lets its PICTURES be resolved and carried (a relative
   *  `src` means nothing to the receiving application). A copy with no path still copies, minus its
   *  pictures. Rejects with human-readable copy — nothing is written when it does. */
  copyToClipboard: (markdown: string, kind: ClipboardKind, path?: string | null) => Promise<ClipboardCopyResult>
  /** Export (Round B T6/T7, ADR-0029). Three steps, because the sheet must never ask for a path:
   *  `chooseExportTarget` opens the system save dialog (a null target means the writer cancelled —
   *  nothing is written and nothing is raised), then one of the two writers runs, then
   *  `revealExport` shows THIS window's last export in the file manager. Rejects with
   *  human-readable copy naming a way forward; `missingImages` is reported, never silent. */
  exportTitle: (input: ExportTitleChoice) => Promise<string>
  chooseExportTarget: (input: ExportChoice) => Promise<{ target: string | null; name: string }>
  /** `keepTocDepth`: the writer chose the Contents depth in the sheet; an HTML export uses exactly
   *  `html.tocDepth` (absent: Default) and main then saves it with the exported document or the Folio's
   *  Index Note (`outcome.tocDepthSave`; a refusal never fails the export). */
  exportDocument: (input: { path: string; format: ExportFormat; target: string; html?: HtmlExportOptions; keepTocDepth?: boolean }) => Promise<ExportOutcome>
  exportBundle: (input: { dir: string; format: ExportFormat; target: string; html?: HtmlExportOptions; keepTocDepth?: boolean }) => Promise<ExportOutcome>
  revealExport: () => Promise<void>
  /** Contents depth kept with the file (`toc_depth`): a document's own, or a Folio's in its Index Note.
   *  Names a SCOPE, never a file: main derives the file (a Markdown document, or the Folio's canonical
   *  Index Note). Answers null when the scope has no such file. Only an HTML export writes it. */
  readTocDepth: (scope: TocDepthScope) => Promise<TocDepthSource | null>
  /** Named export presets live in userData/settings.json; last-used choices remain workspace-scoped renderer state. */
  getExportPresetSettings: () => Promise<ExportPresetSettings>
  setExportPresetSettings: (settings: ExportPresetSettings) => Promise<ExportPresetSettings>
  openDialog: (droppedPath?: string) => Promise<WorkspaceState | null>
  metadataValues: (exclude?: string) => Promise<MetadataValues>
  setCollectionPageActive: (active: boolean, folio?: boolean, canStart?: boolean) => Promise<void>
  getWorkspace: () => Promise<WorkspaceState>
  /** Every checklist note's progress, read from main's search content cache (no file is read twice). */
  /** With `paths`, just those files' rows (a save patched them in the listing: no walk of the tree). */
  getChecklistProgress: (input?: { paths: string[] }) => Promise<ChecklistProgress[]>
  /** The vault index of this window's root (works, Writing only hidden set, Titles labels); null when the
   *  root is not a vault (no `.writeflex/vault.json`). Ticket 0.25-02. */
  getVaultIndex: () => Promise<VaultIndex | null>
  /** What the Make-this-folder-a-vault sheet shows for this window's root: found counts, per-group hide
   *  counts, support-folder file counts and the distinct raw statuses. Writes nothing anywhere. Null with no folder open. */
  previewVault: (input?: { hidden?: string[]; supportFolders?: string[] }) => Promise<VaultPreview | null>
  getRecents: () => Promise<RecentWorkspace[]>
  openRecent: (root: string, options?: { newWindow?: boolean }) => Promise<void>
  /** The vault switcher's Vaults and Folders (vaults ticket 06): pins and recents, each looked at read-only. */
  getSwitcherList: () => Promise<SwitcherList>
  /** Move to a listed root, or to what the open dialog picks: a window on it takes THIS window's place,
   *  and this window closes by its ordinary close (which writes every document). If the close is kept
   *  open, the new window goes and the result is `stayed`. */
  switchRoot: (target: RootSwitchTarget) => Promise<RootSwitchResult>
  /** Pinned roots in the user's order, each flagged `missing` when the folder is gone. */
  getPinned: () => Promise<PinnedWorkspace[]>
  /** Pin a recent root, or (no argument) this window's open Workspace. Resolves with the fresh list. */
  pinWorkspace: (root?: string) => Promise<PinnedWorkspace[]>
  unpinWorkspace: (root?: string) => Promise<PinnedWorkspace[]>
  /** Move a pinned root to `toIndex`. */
  movePinned: (root: string, toIndex: number) => Promise<PinnedWorkspace[]>
  /** Folder picker that replaces a missing pinned root, keeping its position; null when cancelled. */
  locatePinned: (root: string) => Promise<PinnedWorkspace[] | null>
  revealPinned: (root: string) => Promise<void>
  /** Everything the start screen lists, in one answer. */
  getStartScreen: () => Promise<StartScreenModel>
  /** Open the Guide or the Example collection in its own window (main holds the path). */
  openExample: (target: 'guide' | 'collection') => Promise<void>
  /** The Guide's question about this window (ADR-0043, ticket 07): is the Example collection shown on the
   *  start screen (state `written` and the folder there), and is THIS window the example's own. */
  getGuideContext: () => Promise<GuideContext>
  /** What "Remove the example?" shows: the folder as it is on disk and the files in it now. Main reads both. */
  getExampleRemovalPreview: () => Promise<ExampleRemovalPreview>
  /** Move the Example collection to the Bin. Takes the token that came with the preview this window was
   *  shown, and no path: main holds the path and the confirmation. A refusal is one sentence. */
  removeExample: (token: string) => Promise<ExampleChangeResult>
  /** Bring the Example collection back. Takes nothing. A refusal is one sentence. */
  restoreExample: () => Promise<ExampleChangeResult>
  /** The example was removed or brought back, in any window: ask for the start screen and the Guide's context again. */
  onExampleChanged: (fn: (event: { change: 'removed' | 'restored' }) => void) => () => void
  /** Main asks this window to open its Guide tab (Get started, a chapter link). */
  onGuideShow: (fn: () => void) => () => void
  /** A registry command ran, by any route (key, palette, Actions here, menu, toolbar). Main keeps the record. */
  commandRan: (id: string) => void
  /** The person finished a chapter's list: main stamps the date once. */
  guideChapterFinished: (chapter: string) => void
  /** A chapter's lesson file is the active file (the Guide opened it, or the person did): "Opened". */
  guideChapterOpened: (chapter: string) => void
  /** A topic was opened in the Guide's How it works or Features tab: it reads "Read" from now on. */
  guideTopicRead: (id: string) => void
  /** What it connects to: the one fact main reads for the Guide (Zotero's database is on this Mac). */
  getGuideConnections: () => Promise<{ zotero: boolean }>
  /** A connection row's action: main opens the fixed place the name stands for. */
  openGuideLink: (link: 'zotero-download' | 'voice-settings') => Promise<void>
  /** Open a chapter in the Example collection's window at its lesson file; from the person's own window it
   *  brings that window forward. Main holds the path and the file name; the renderer names a chapter. */
  openGuideChapter: (chapter: string) => Promise<void>
  /** Workspace search; with `scope` it is scoped to a focused folder and returns both counts. */
  searchWorkspace: (query: string, options?: { scope?: { folder: string; results: 'folder' | 'everywhere' } }) => Promise<SearchResult>
  /** The folder focused in this window (main-owned, survives relaunch), or null. */
  getFolderFocus: () => Promise<FolderFocus | null>
  /** Focus a folder (workspace-relative) or clear with null; main validates and persists. */
  setFolderFocus: (path: string | null) => Promise<FolderFocus | null>
  scanJumps: (scope: 'file' | 'folder', path?: string) => Promise<OutlineScanEntry[]>
  listFavourites: () => Promise<string[]>
  toggleFavourite: (path: string) => Promise<string[]>
  readFile: (path: string) => Promise<FileReadResult>
  /** A widget's HTML for the embed line `rawPath` in the workspace document `documentPath`, resolved and
   *  read in main (inside the workspace only); a refusal names why. Run it only through widget-frame. */
  readWidget: (documentPath: string, rawPath: string) => Promise<WidgetReadResult>
  /** The HTML files in the document's folder and below it (the Insert widget… picker); reads only. */
  listWidgetChoices: (documentPath: string) => Promise<WidgetChoices>
  /** What a file dropped on the text is: its path as the embed line would carry it, or why it is refused. Reads only. */
  resolveWidgetDrop: (documentPath: string, file: File) => Promise<WidgetDropResult>
  /** Open a widget's HTML file in the default browser (resolved in main like readWidget). */
  openWidgetFile: (documentPath: string, rawPath: string) => Promise<{ ok: boolean }>
  /** A widget block shows this embed line: main watches its file when the workspace watcher ignores it
   *  (a hidden or build folder). `unwatchWidget` when the block goes. */
  watchWidget: (documentPath: string, rawPath: string) => Promise<{ watching: boolean }>
  unwatchWidget: (documentPath: string, rawPath: string) => Promise<void>
  /** Standard widgets (ticket 04a). Create a widget from a source file and insert its line into the document, as one
   *  undoable step; a document in no Folio gets the folder the writer chose in the own-folder sheet (`placement`).
   *  Main resolves, reads and writes everything. */
  createStandardWidget: (request: CreateWidgetCall) => Promise<CreateWidgetResult>
  /** What is in a document's folder, for the own-folder sheet; `needed: false` when no sheet is shown. Reads only. */
  standardWidgetOwnFolderFacts: (request: { documentPath: string; sourceFile?: string; name: string; title?: string }) => Promise<OwnFolderFactsAnswer>
  /** Widget steps that moved documents and were stopped by a crash or a quit (their journals), for the launch notice. Reads only. */
  standardWidgetLeftoverSteps: () => Promise<LeftoverStep[]>
  /** The notice's Clean up: removes only the step's own files (each only while unchanged) and puts back the links it changed. */
  cleanUpStandardWidgetStep: (id: string) => Promise<CleanUpResult>
  /** Put away the journal of a step past its commit point (nothing on disk changes). */
  forgetStandardWidgetStep: (id: string) => Promise<void>
  /** Change the named top-level settings of a widget's recipe and rebuild it, as one undoable step. */
  updateStandardWidgetRecipe: (request: UpdateRecipeCall) => Promise<UpdateRecipeResult>
  /** Build a widget from its recipe now. */
  buildStandardWidget: (recipePath: string) => Promise<BuildOutcome>
  /** Undo a create or update step by the id it answered with. */
  undoStandardWidgetStep: (undoId: string) => Promise<UndoResult>
  /** The page a recipe draft and source (or edited source text) would build; writes nothing. */
  previewStandardWidget: (request: PreviewCall) => Promise<PreviewResult>
  /** The CSV and JSON files in the document's Folio folder (or its own folder) and below; no links, bounded. */
  listStandardWidgetSources: (documentPath: string) => Promise<SourceFileListing>
  /** Choose file… in the widget workbench: the native picker, in main. A file in the document's folders comes back
   *  by its workspace path; any other file by an opaque token (never its path) to bring in by Copy or Keep in sync. */
  pickStandardWidgetSource: (documentPath: string) => Promise<PickAnswer>
  /** widget-frame tells main whether one of the window's widgets is engaged (keys may go to it): by a press
   *  inside it, by the keyboard, or none. Main may refuse a press claim it cannot verify. */
  setWidgetKeyboardOwner: (claim: { engaged: false } | { engaged: true; how: 'press'; frame: string; sinceParentPressMs: number } | { engaged: true; how: 'keyboard'; frame: string }) => Promise<{ accepted: boolean }>
  /** Frontmatter organ (Task 22): parse a file's leading YAML frontmatter, or null when it is bare.
   *  Read-only by design — frontmatter is never auto-inserted (ADR-0008). */
  readFrontmatter: (path: string) => Promise<Frontmatter | null>
  /** Writing goal (Round A T5): the writer's own direct `goal:`/`due:` frontmatter write — the
   *  ADR-0019 capture path, never the staged agent capability. `target: null` clears both keys.
   *  Returns the rewritten file so the renderer can reconcile the open buffer, with the receipt of the goal's
   *  own write (absent when nothing needed writing). `basis`: the version the buffer was based on; over
   *  any other version on disk nothing is written and the refusal comes back as data. */
  setGoal: (path: string, target: number | null, due: string | null, basis: SaveBasis) => Promise<(FileReadResult & Partial<WriteReceipt>) | FileSaveDiskChanged>
  /** Tier 1 (ADR-0013): write the buffer to disk. Auto-save calls this continuously; it never snapshots
   *  — history is made by checkpoint() and agent turns. */
  /** The editor's save. `basis` is the version of the file the buffer was based on: main writes only if the
   *  disk holds it when the write commits (shared/save-basis.ts), and otherwise answers `disk-changed`. */
  saveFile: (path: string, content: string, basis: SaveBasis) => Promise<FileSaveResult>
  /** Deliberate emptying path for ADR-0031: main asks for confirmation before bypassing the guard.
   *  A non-empty document is rescued before the question is shown; null means the writer cancelled. */
  clearDocument: (path: string) => Promise<ClearDocumentResult | null>
  /** Tier 2 (ADR-0013): checkpoint a file's on-disk state as a returnable point (the git *commit*).
   *  `auto: true` marks an app-made close-checkpoint (gated by the "checkpoint on close" setting); a ⌘S
   *  checkpoint passes no `auto` and always fires. */
  checkpoint: (path: string, opts?: { auto?: boolean }) => Promise<void>
  /** Keep exactly `text` (a version of `path`) in History before it is replaced. The answer carries a
   *  receipt (the History entry, sha256) or says why nothing was kept: no History in this window, or the
   *  file no longer holds that text (main/preserve-version.ts). */
  preserveVersion: (path: string, text: string) => Promise<PreserveResult>
  /** User file management (ADR-0017): typed names kept faithfully; deletes are OS-Trash only. */
  createFile: (name: string, directory?: string) => Promise<FileReadResult>
  planFileRename: (path: string, newName: string, directory?: string | null) => Promise<FileRenamePlan>
  renameFile: (path: string, newPath: string) => Promise<RenameFileResult>
  moveFile: (path: string, newPath: string, collectionDir?: string) => Promise<RenameFileResult>
  duplicateFile: (path: string) => Promise<FileReadResult>
  pickImage: () => Promise<{ path: string } | null>
  saveImage: (bytes: ArrayBuffer | Uint8Array, ext: string) => Promise<{ path: string }>
  trashFile: (path: string) => Promise<{ path: string }>
  revealFile: (path: string) => Promise<void>
  createFolder: (path: string) => Promise<{ path: string }>
  renameFolder: (path: string, newName: string) => Promise<{ path: string }>
  trashFolder: (path: string) => Promise<{ path: string }>
  /** Scraps (Task 20): file-native cuttings in scraps/<origin>-SCRAPS.md. Every mutation pushes
   *  `scraps:changed` (onScrapsChanged) so the pane re-lists and the file tree refreshes. */
  listScraps: (scope?: { origin?: string }) => Promise<Scrap[]>
  addScrap: (origin: string, text: string) => Promise<Scrap>
  toggleScrapDone: (id: string) => Promise<void>
  setScrapColour: (id: string, colour: string | null) => Promise<void>
  removeScrap: (id: string) => Promise<Scrap>
  /** The floating Scratchpad (ADR-0050): exact text payloads and the legacy scraps, per calling window's folder. */
  scratchpad: ScratchpadBridge
  /** Change Ledger (Task 2, ADR-0010/0011): the review-and-learn store. Every mutation pushes
   *  `changes:changed` (onChangesChanged) so the dock re-lists over `.writeflex/changes.jsonl`. */
  listChanges: (scope?: ChangeScope) => Promise<Change[]>
  addChange: (input: NewChange) => Promise<Change>
  updateWriterChange: (id: string, input: NewChange) => Promise<Change>
  setChangeStatus: (id: string, status: ChangeStatus) => Promise<Change>
  /** A reply on a reader's note or proposed edit (0.24 ticket 08): kept as plain text on the record and sent to the link it came through. Decides nothing. */
  replyToReader: (id: string, text: string) => Promise<Change>
  classifyChange: (id: string, editClass: EditClass) => Promise<Change>
  /** Accept/Reject a change from the dock — routed through the live suggestion (disk write) when one
   *  exists, else a direct status move or stored-diff replay. `applied` is false when it could NOT resolve
   *  honestly. Accept may return the rewritten file so the renderer can reconcile a fallback apply. */
  /** `written`: the text main wrote to the change's file in this call, when it wrote one; `file` is the
   *  file read back after, which differs from `written` only when another program wrote it between. */
  resolveChange: (id: string, action: 'accept' | 'reject', options?: { sweep?: false }) => Promise<{ applied: boolean; file?: FileReadResult; written?: string; seq?: number; message?: string; closed?: true; changedOnDisk?: { path: string; diskText: string | null }; scratchPlacement?: ScratchPlacementReceipt }>
  /** How many undecided Changes from outside the ledger holds (in all, per source, per request), the
   *  limits, and what the app's last look at the command line's inbox did. */
  outsideSummary: () => Promise<OutsideSummary>
  /** Reject every undecided Change of one request, or of one source, in one step. Name exactly one. */
  rejectOutsideChanges: (which: { request: string } | { source: OutsideSource }) => Promise<{ rejected: number }>
  /** Accept every undecided Change of one source, each by the single Accept (never a reader's). `open`: the documents the window
   *  has open; their Changes come back in `open`, in order, for the window to accept through its own route. */
  acceptOutsideChanges: (which: { source: OutsideSource; open: string[] }) => Promise<OutsideBulkAccept>
  /** Save version (ADR-0014/C6): snapshot the explicit accepted/rejected state without auto-accepting
   *  undecided pending changes; pending proposals persist for a future version. */
  saveChangeVersion: (input: { path: string; changeIds: string[]; name: string; note?: string }) => Promise<{ versionId: string; snapshotId: string; record: Version; accepted: number; rejected: number; pending: number; corpusEntries: number }>
  /** Read-only suggestions for an outside move and the journal-backed attachment Undo. */
  historyAttachmentSuggestions: (path: string) => Promise<Array<{ from: string; to: string }>>
  waitingVersionHistory: () => Promise<Array<{ from: string; count: number }>>
  historyAttachmentUndo: (path: string) => Promise<{ id: string; files: number } | null>
  attachVersionHistory: (input: { from: string; to: string }) => Promise<string | null>
  undoHistoryAttachment: (id: string) => Promise<void>
  /** Version spine (ADR-0016 V1): named, authored version records over `.writeflex/versions.jsonl`. */
  listVersions: (scope?: VersionScope) => Promise<Version[]>
  /** Rename a Version by appending a newer record with the same stable id. */
  renameVersion: (id: string, name: string) => Promise<Version>
  /** Read a document exactly as it was at a named Version's file-snapshot entry. Missing snapshots return null content. */
  versionContent: (input: VersionContentRequest) => Promise<VersionContentResult | null>
  /** Compare two named versions, or a named version and Working, as content diff hunks with ledger attribution. */
  compareVersions: (input: { path: string; fromId: VersionCompareEndpointId; toId: VersionCompareEndpointId; currentContent?: string }) => Promise<VersionCompareResult>
  /** Restore a Version into the live document through main-owned writes and tier-2 checkpoints. */
  /** Restore a version as the open document. `basis`: the version of the file the buffer is based on
   *  (flushed first); main replaces only that version and otherwise answers `disk-changed`. */
  restoreVersion: (input: VersionContentRequest & { basis: SaveBasis }) => Promise<FileSaveWritten | FileSaveDiskChanged | null>
  /** Collections (Task 23): read a folder as a browsable table of its pieces under an Index-Note cover.
   *  `dir` is workspace-relative ('' = the workspace root). Read-only. */
  listCollection: (dir: string, options?: { includeSearchText?: boolean }) => Promise<Collection>
  /** The 0.6 Collection spine. All projections call this one read-only main-process engine. */
  collection: {
    beginBatch: () => Promise<void>
    endBatch: () => Promise<void>
    status: (dir: string) => Promise<CollectionStatus>
    pattern: (dir: string) => Promise<CollectionPattern>
    query: (dir: string, source: string) => Promise<QueryResult>
    unresolvedFolderPieces: (dir: string) => Promise<UnresolvedFolderPiece[]>
    /** Board move: app-owned frontmatter status write; main emits collection invalidation. */
    addTags: (dir: string, path: string, tags: string[]) => Promise<FileReadResult>
    setStatus: (dir: string, path: string, status: BoardStatus) => Promise<FileReadResult>
    /** Persist the selected folder's one-work/many-files override in its Index Note. */
    setPieceMode: (dir: string, folderPath: string, mode: 'one' | 'many') => Promise<FileReadResult>
    links: (dir: string, from?: string, content?: string) => Promise<CollectionLink[]>
    targets: () => Promise<CollectionTarget[]>
    focusPiece: (windowId: number, path: string) => Promise<void>
    previewStub: (input: StubInput) => Promise<StubPreview>
    createStub: (input: StubInput) => Promise<CreateStubResult>
    onChanged: (fn: (event: CollectionQueryInvalidation) => void) => () => void
    digest: (dir: string) => Promise<CollectionDigest>
  }
  agentNotes: {
    list: (dir?: string) => Promise<AgentNote[]>
    restage: (path: string, input: { sourceDocument: string; insertAfter?: string; anchor?: { from: number; to: number } }) => Promise<Change>
    /** Tick or untick the box on `line` (1-based, of the note FILE) of an agent note; `checked` is the
     *  state the pane showed. Writes one character into the note, never the piece. */
    toggleTask: (path: string, line: number, checked: boolean) => Promise<{ path: string; line: number; checked: boolean }>
    onChanged: (fn: () => void) => () => void
  }
  /** Create the folder's Index Note (`_<name>_INDEX.md`, only when absent — THE one sanctioned
   *  Index-Note write). Returns its path; pushes `collection:changed` so the tree refreshes. */
  createCollectionIndex: (dir: string) => Promise<string>
  /** Create a new blank piece inside the collection folder; returns its path. Pushes `collection:changed`. */
  createCollectionPiece: (dir: string) => Promise<string>
  /** Diary instrumentation (0.18): designation is global; Counted marks remain in Index Notes. */
  diary: {
    chooseFolder: () => Promise<string | null>
    countedCollections: () => Promise<CountedCollection[]>
    isCounted: (dir: string) => Promise<boolean>
    setCounted: (dir: string, counted: boolean, root?: string) => Promise<CountedCollection[]>
    prime: (path: string, words: number) => Promise<boolean>
    activity: (path: string, words: number, at?: number, beforeWords?: number) => Promise<boolean>
    getSession: () => Promise<ExplicitSessionState | null>
    getAutomaticSession: () => Promise<boolean>
    startSession: (input: { path: string; words: number; durationMinutes: number | null; targetWords: number | null; tick: boolean }) => Promise<
      { kind: 'started'; session: ExplicitSessionState } | { kind: 'diary-required' } | { kind: 'diary-root' }
    >
    endSession: () => Promise<ExplicitSessionState | null>
    dismissCompletedSession: () => Promise<null>
    adjustSessionTarget: (targetWords: number | null) => Promise<ExplicitSessionState | null>
    onSession: (fn: (session: ExplicitSessionState | null) => void) => () => void
    onSessionMessage: (fn: (message: string) => void) => () => void
    onAutomaticSession: (fn: (active: boolean) => void) => () => void
  }
  /** Folio (Task 24): read a folder's manifest (null when it is a plain Collection). */
  setAmbient: (snapshot: AmbientSnapshot) => Promise<void>
  readFolio: (dir: string) => Promise<Folio | null>
  /** The Folio's pieces as main resolves them, and the listed entries left out. Null when `dir` has no manifest. */
  readFolioPieces: (dir: string) => Promise<FolioPieces | null>
  /** Which Folio a file belongs to and where it sits in it; null when it is in none. */
  readFolioPlace: (path: string) => Promise<FolioPlace | null>
  /** The Folio folder a folder belongs to (the folder itself, an ancestor with a manifest, or null): where the Folio page opens. */
  readFolioDir: (dir: string) => Promise<string | null>
  /** The Outline's Folio part: the Folio of this file with its pieces and the folder's other files, with headings. Read-only. */
  readFolioOutline: (path: string) => Promise<FolioOutline | null>
  /** The Folio room (ADR-0048): a read-only model of the Folio at `dir`, and its UI state (last view, selected part) kept in app state, never in the Folio. */
  folioRoom: {
    map: (dir: string, request: { session: string; stateKey: string; ops?: MapOp[]; token?: string }) => Promise<MapWriteResult>
    author: (dir: string, request: RoomAuthoringRequest) => Promise<RoomAuthoringResult>
    read: (dir: string, essential?: boolean) => Promise<FolioRoomModel | null>
    getState: (dir: string) => Promise<RoomState>
    /** Lay a patch (`{ view }`, `{ selected }` or `{ surface }`) over the stored state. */
    setState: (dir: string, patch: Partial<RoomState>) => Promise<boolean>
  }
  /** The Folio outline's Details card (0.26 ticket 4). The Folio is named by its folder; main derives its Index Note. */
  folioDetails: {
    /** The seven fields as the card shows them, and the Index Note text they were read from (the next write's basis). */
    read: (dir: string) => Promise<FolioDetailsRead>
    /** Set one field (null removes its key) in the Index Note's header, only over `basis`, the Index Note text last read. */
    set: (dir: string, field: FolioDetailField | FolioSectionExportField, value: string | null, basis: string) => Promise<FolioDetailAnswer>
    /** Undo the change `token` names, only while the Index Note holds exactly what it left. */
    undo: (dir: string, token: string) => Promise<FolioDetailUndoAnswer>
    /** The Author, Audience and Language values other files in the Workspace use (read-only), with the writer's name first for Author. */
    values: () => Promise<FolioDetailValuesAnswer>
  }
  /** The Outline's running-order changes. Pieces are named by path, with the running order the caller saw
   *  (`expected`); main refuses, writing nothing, when that is no longer the running order. */
  folioRunningOrder: {
    movePiece: (dir: string, path: string, beforePath: string | null, expected: string[]) => Promise<RunningOrderResult>
    addPieces: (dir: string, paths: string[], expected: string[]) => Promise<RunningOrderResult>
    /** Undo of an Add, by the token its answer carried (`undoToken`). */
    removeAdded: (dir: string, token: string) => Promise<RunningOrderResult>
  }
  /** Tab groups (direction D): each workspace-relative path's group folder — nearest Folio, else
   *  nearest Index Note folder, else its own folder ('' = root). Read-only; nothing is stored. */
  resolveTabGroups: (paths: string[]) => Promise<Record<string, string>>
  /** Make Folio: draft + (after a native confirm) write the manifest; returns its path, or null if the
   *  writer cancels. Errors if a manifest already exists. Pushes `collection:changed`. */
  makeFolio: (dir: string) => Promise<string | null>
  onFolioFlushRequested: (fn: (input: { id: string; dir: string }) => void) => () => void
  replyFolioFlush: (id: string, saved: boolean) => Promise<void>
  createNestedFolio: (dir: string) => Promise<string>
  readFolioDeclaration: (dir: string) => Promise<import('../main/folio-declaration').FolioDeclaration>
  undoTurnBack: (dir: string) => Promise<boolean>
  turnBackIntoCollection: (dir: string) => Promise<boolean | string>
  /** A Folio's agent instructions (AGENTS.md, CLAUDE.md): their state for the Plan's and the Folder
   *  dashboard's row (null when `dir` is not a Folio), and the author's requests from it. */
  folioAgentInstructions: {
    read: (dir: string) => Promise<FolioAgentInstructionsStatus | null>
    act: (dir: string, action: FolioAgentInstructionsAction) => Promise<FolioAgentInstructionsStatus>
  }
  plan: {
    onIdentityLinked: (fn: (result: { root: string; dir: string; indexPath: string; undoToken?: string; warning?: string }) => void) => () => void
    identityCheck: (dir: string, root: string, force?: boolean) => Promise<boolean>
    open: (dir: string, root: string, force?: boolean) => Promise<{ changed: boolean; undoToken?: string; indexPath?: string; warning?: string }>
    read: (dir: string) => Promise<Plan | null>
    /** Put back one "Not in the outline" row; `expected` is that row's file and title as shown, so a list that changed meanwhile is refused.
     *  `asFrontMatter`: "Add as front matter" (ADR-0046), for a row offered as front matter (`frontMatterOffer`). */
    adoptPart: (dir: string, unlistedIndex: number, expected: PlanPartKey, asFrontMatter?: boolean) => Promise<Plan>
    /** `order.createManifest` (the Folio room's order writes): a Folio with an Index Note and no manifest gets its manifest in the same write. Absent: today's behaviour. */
    insertPart: (dir: string, at: number, part: PlanPartInput, order?: PlanOrderWrite) => Promise<Plan>
    movePart: (dir: string, from: number, to: number, order?: PlanOrderWrite) => Promise<Plan>
    removePart: (dir: string, index: number) => Promise<Plan>
    /** Change one card's role; `expected` is that card's whole line as shown (title, file, gloss, role, tags), so a running order that moved meanwhile is refused. */
    setPartRole: (dir: string, index: number, role: string, expected: PlanCardKey) => Promise<Plan>
    /** Put the whole running order in `order` (`order[k]` = index into `expected` of the part at k), in one write. Sort by chapter number and its Undo. */
    reorderParts: (dir: string, order: number[], expected: PlanPartKey[], write?: PlanOrderWrite) => Promise<RoomOrderResult>
    /** The Folio room's New card: an unwritten part `title` at the end of the running order, refused unless the running order is still `expected` and no part has the title. */
    roomNewCard: (dir: string, title: string, expected: PlanPartKey[]) => Promise<RoomCardResult>
    /** Its Undo: the card's line at `index` taken out, only while the running order is `expected` (the one New card left). */
    roomRemoveCard: (dir: string, index: number, title: string, expected: PlanPartKey[]) => Promise<PlanOrderResult>
    /** Add files at the end of the running order, in the order given, in one write (Add all from this folder). */
    addParts: (dir: string, paths: string[], expected: PlanPartKey[]) => Promise<PlanOrderResult>
    /** Undo of `addParts`: take the files (the last parts of `expected`) out again. */
    /** Undo of an Add all, by the token its answer carried (`undoToken`). */
    removeAdded: (dir: string, token: string) => Promise<PlanOrderResult>
    materialisePart: (dir: string, index: number) => Promise<{ plan: Plan; path: string }>
    /** Whether export and sharing follow the running order (the export sheet's and Share page's line). A read: writes nothing. Null: no Index Note. */
    exportOrder: (dir: string) => Promise<ExportOrderCheck | null>
    /** Make export follow the running order: the manifest alone, refused unless what the read saw (`check.expected`: the running order, whether a manifest was there) still holds. */
    alignManifest: (dir: string, expected: ExportOrderExpected) => Promise<ExportOrderRepairResult>
    /** The Plan's choice per part: no heading in the text (`heading: none`) or its own heading. */
    setHeadingMode: (dir: string, path: string, mode: 'own' | 'none') => Promise<Plan>
    /** The same choice for a part whose Folio is not known to the caller (the margin card): main finds the Folio. */
    setHeadingModeOfPart: (path: string, mode: 'own' | 'none') => Promise<Plan | null>
    /** The same, for the part open in the editor (the document owner's route): written only over `basis`, the
     *  version the buffer is based on; `written` is this call's receipt (absent: nothing written), `content`
     *  the file read back after it. Refused (the part is not the version `basis` names): nothing was written,
     *  and `diskText` is what is on disk, for the changed-on-disk notice (as setGoal). */
    setHeadingModeOfOpenPart: (path: string, mode: 'own' | 'none', basis: SaveBasis) => Promise<{ plan: Plan | null; written?: string; content?: string } | FileSaveDiskChanged>
  }
  /** Opening a Folio: stage the title proposals for the Folio holding this file, once per Folio per window. */
  checkFolioPartTitles: (path: string) => Promise<{ proposed: number } | null>
  /** The title-conflict buttons (Plan, Outline): main writes, over the version `fingerprint` names. */
  titleConflict: {
    /** One part of the Folio at `dir`. */
    fixPart: (dir: string, item: { path: string; fingerprint: string }, direction: TitleFixDirection) => Promise<TitleFixAnswer>
    /** Every part named, in one Undo step (the Plan header's "… for all N"). */
    fixFolio: (dir: string, items: Array<{ path: string; fingerprint: string }>, direction: TitleFixDirection) => Promise<TitleFixAnswer>
    /** Undo the step `token` names. */
    undo: (token: string) => Promise<TitleUndoAnswer>
  }
  /** The vault of THIS window's root (`.writeflex/vault.json`, vaults ticket 01). Main owns the file;
   *  no call names a root or a file. Pin paths are folder or `.md` document paths inside the root;
   *  every view tells each pin's kind (`pinKinds`: [path, folder | document | missing] pairs). */
  vault: {
    /** The root's vault, or null when it is not one. Writes nothing. */
    get: () => Promise<VaultView | null>
    /** Make the root a vault (one write); refuses when it already is one. Missing fields take defaults. */
    create: (input?: VaultCreateInput) => Promise<VaultWriteResult>
    /** Pin an existing folder or `.md` document inside the root, applied onto the file as it is now on disk. */
    addPin: (path: string) => Promise<VaultWriteResult>
    removePin: (path: string) => Promise<VaultWriteResult>
    /** New pin order, applied onto the file as it is now (pins added elsewhere meanwhile are kept). */
    reorderPins: (order: string[]) => Promise<VaultWriteResult>
    /** Whole save of the settings read with `baseHash`; `changed` (nothing written) when the file moved on. */
    save: (settings: VaultSettings, baseHash: string) => Promise<VaultWriteResult>
    /** Every change to this root's vault file: own writes (`outside: false`) and outside ones. */
    onChanged: (fn: (event: VaultChangedEvent) => void) => () => void
  }
  /** The Board's material steps (scraps tickets 02 and 03), each one undo group. */
  boardMaterial: {
    /** Offcut to idea: one wikilink line (and the quote) under the tracker's Ideas; the scrap leaves its file. */
    promoteOffcut: (input: PromoteOffcutInput) => Promise<BoardStepResult>
    /** A drawer scrap added to the end of its piece; the scrap leaves its file. */
    appendScrap: (input: AppendScrapInput) => Promise<BoardStepResult>
    /** A research note from the Sources rail attached to a piece: one line in its frontmatter `sources:`. */
    attachSource: (input: AttachSourceInput) => Promise<BoardStepResult>
    /** A piece's sources, listed and cited (ticket 04). `dir` is the collection when the caller knows it. */
    listSources: (path: string, dir?: string) => Promise<PieceSourceListing>
    /** Undo the latest step (its id), or refuse with what is in the way. */
    undo: (id: string) => Promise<BoardUndoResult>
  }
  /** The Agent pane's running-order proposal card (ticket 09). Accept is one undoable step. */
  planProposal: {
    view: (id: string) => Promise<PlanProposalView | null>
    accept: (id: string, edits?: PlanAcceptEdits) => Promise<PlanAcceptResult>
    discard: (id: string) => Promise<null>
    undo: (id: string) => Promise<PlanUndoResult>
  }
  /** Sources (Task 21): reference material under research/ (+ Folio `source` dirs in T24), surfaced
   *  beside Scraps. md sources open in a tab; other kinds reveal in the OS file manager via showItem. */
  listSources: () => Promise<SourceFile[]>
  /** Reveal a Workspace file in the OS file manager (boundary-validated in main). */
  showItem: (path: string) => Promise<void>
  modelPickerOpened: () => Promise<void>
  /** "Refresh models": always asks the providers; resolves with the diff and the new last-checked time. */
  refreshModels: () => Promise<ModelRefreshResult>
  onModelsChanged: (fn: (payload: AgentModelsChanged) => void) => () => void
  getAgentState: () => Promise<AgentState>
  /** Send a turn. `activeFile` (the open document, workspace-relative) rides in as ambient context so
   *  legacy callers still supply a path; ambient:set owns the model-visible writer situation.
   *  `runOnFolder` (ticket 10) is a folder skill's launch folder: with an empty text, main sends the
   *  run-as-is instruction naming that folder instead of the open document. */
  prompt: (text: string, activeFile?: string | null, activeCollectionDir?: string, runOnFolder?: string) => Promise<{ messages: ChatMessage[]; suggestions: Suggestion[] }>
  abortAgent: () => Promise<void>
  setModel: (provider: string, modelId: string) => Promise<AgentState>
  setThinking: (level: ThinkingLevel) => Promise<AgentState>
  setDefaultModel: (provider: string, modelId: string) => Promise<boolean>
  setDefaultThinking: (level: ThinkingLevel) => Promise<boolean>
  applySuggestion: (id: string) => Promise<{ outcome: CapabilityOutcome; workspace: WorkspaceState; file?: FileReadResult }>
  discardSuggestion: (id: string) => Promise<{ suggestions: Suggestion[]; settlementWarning?: string }>
  respondApproval: (id: string, approved: boolean) => Promise<void>
  assistantTurns: {
    list: () => Promise<AssistantTurnsState>
    get: (id: string) => Promise<import('../shared/assistant-turns').AssistantTurnActivity | undefined>
    undo: (id: string, includingLater?: boolean) => Promise<AssistantTurnUndo>
    onActivity: (fn: (activity: TurnActivity) => void) => () => void
  }
  restoreLastTurn: () => Promise<string[]>
  /** Settings (Task 17): the full stored record — the settings window's one-pull hydrate. */
  getSettings: () => Promise<SettingsRecord>
  /** Set a key and (unless `log: false` — live-surface tweaks like ⌘T) record it in the changelog.
   *  `value: null` UNSETS the key — back to the surface's locked default (the ⌥⌘0 reset path). */
  setSetting: (key: string, value: SettingValue | null, label: string, opts?: { log?: boolean }) => Promise<{ value: SettingValue | null; changelog: SettingsChangeEntry[] }>
  getSettingsChangelog: () => Promise<SettingsChangeEntry[]>
  /** Revert the changelog entry at `index` to its `old` value; the caller re-fires the effect. */
  revertSetting: (index: number) => Promise<{ entry: SettingsChangeEntry | null; changelog: SettingsChangeEntry[] }>
  /** A setting changed ANYWHERE in the app (this window included): settings are app-level state, so
   *  every window hears the write and re-applies it. `value` is what the store holds afterwards —
   *  null when the key was unset. First consumer: ADR-0040's globally shared action bar. */
  onSettingChanged: (fn: (change: { key: string; value: SettingValue | null }) => void) => () => void
  readingRoom: {
    /**
     * The Room's state for the draft it is beside — `draftPath` is the absolute path of the active
     * Markdown file, or null when no draft is on screen. Which paper is open is scoped per draft
     * (ReadFlex ADR-0032), so this is called again on every draft switch and not only on launch.
     */
    getState: (draftPath: string | null) => Promise<ReadingRoomState>
    /** Papers opened recently, newest first — global, persistent, and the answer to "the thing I was
     *  reading yesterday", which search cannot give because the title is what the user has forgotten. */
    recentDocuments: () => Promise<RecentDocumentRow[]>
    /** Instant search over the whole Zotero library; an empty query browses it. */
    searchShelf: (query: string, collectionId?: string | null) => Promise<ShelfSearchResult>
    /** The Zotero collection tree for the Shelf's filter; empty when the library has none. */
    shelfCollections: () => Promise<ShelfCollectionNode[]>
    /** Opens a Shelf selection through the remembered-document seam and returns the Room's state.
     *  `draftPath` travels with the open so the paper lands against the draft that asked for it. */
    openShelfItem: (input: {
      libraryId: number
      itemKey: string
      attachmentKey: string | null
      draftPath: string | null
    }) => Promise<ReadingRoomState>
    /** The remembered document's annotations, read from Zotero with no reader required. */
    readHighlights: () => Promise<HighlightsResult>
    /**
     * Create or exactly reuse the highlight for words arriving in a draft. The returned link names
     * the annotation only after Zotero has taken it; a refusal returns the honest page link.
     */
    citeSelection: (input: {
      annotation: Omit<ReaderPaintAnnotation, 'isExternal' | 'key' | 'comment' | 'tags'>
      attachmentKey: string
      documentTitle: string
      libraryId: number
    }) => Promise<ReadingRoomCitationResult>
    /** Record a draft only after its Area image-plus-source block was inserted successfully. */
    beginAreaQuotation: (input: {
      annotationKey: string
      attachmentKey: string
      libraryId: number
    }) => Promise<string>
    recordAreaQuotation: (input: {
      annotationKey: string
      attachmentKey: string
      documentTitle: string
      draftPath: string
      libraryId: number
      receipt: string
    }) => Promise<ReadingRoomWriteResult & {
      recorded: boolean
      quotationError?: string
      quotationStatus: 'pending' | 'retrying' | 'confirmed' | 'failed' | 'conflict'
    }>
    /**
     * Queue highlights, then write them into Zotero's own database (ADR-0031). Resolves once they are
     * DURABLE locally, which is before the write — so a refused write never costs the reader a mark.
     * `notWritten` carries the plain reason when Zotero would not take it ("Zotero is not open…").
     */
    saveAnnotations: (input: {
      operation: 'create' | 'update' | 'delete'
      annotations: unknown[]
      /** For an edit or deletion, each mark as THIS reader showed it before the change (aligned by
       *  index; null when the reader held nothing for it). Zotero is written only if it still holds this. */
      before?: unknown[]
      /** The reader instance making the change (32 hex characters); see ADR-0047 on re-keyed creates. */
      readerSession?: string
    }) => Promise<ReadingRoomWriteResult & { queued: number }>
    /**
     * Hand Zotero whatever is still owed to it (ADR-0036, decision 2), without making a highlight
     * first. Called when the Room opens and when a document opens, so a mark refused earlier stops
     * waiting for the next highlight to be made. A no-op when nothing is waiting.
     */
    drainOutbox: () => Promise<ReadingRoomWriteResult>
    /** Drainable and permanently rejected highlights, counted separately in main. */
    outboxCounts: () => Promise<ReadingRoomOutboxCounts>
    /** The main process sent (or tried to send) waiting highlights on its own — when Zotero, with the
     *  WriteFlex plugin, became reachable. Same shape as a write result, so it lands where every
     *  other result lands. */
    onOutboxChanged: (fn: (result: ReadingRoomWriteResult) => void) => () => void
    /** Show the WriteFlex plugin file shipped with the app in Finder. False when it is not there. */
    showZoteroPlugin: () => Promise<boolean>
    /** Every highlight Zotero would not take, across all documents: what `rejected` counts. */
    refusedHighlights: () => Promise<RefusedHighlight[]>
    /** Requeue a refused insert and try the write again. A no-op for a row that is not retryable. */
    retryRefused: (id: number) => Promise<ReadingRoomWriteResult>
    /** Stop counting a refused row. The highlight is kept here and stays drawn; nothing is deleted. */
    dismissRefused: (id: number) => Promise<ReadingRoomOutboxCounts>
    readDocument: (path: string) => Promise<Uint8Array>
    addBookmark: (input: {
      label: string
      position: Record<string, unknown>
    }) => Promise<ReadingBookmarkRow>
    listBookmarks: () => Promise<ReadingBookmarkRow[]>
    saveViewState: (input: {
      attachmentKey: string
      libraryId: number
      viewState: Record<string, unknown>
    }) => Promise<boolean>
    saveWidth: (width: number) => Promise<number>
  }
  /** The bundled sound pack (resources/sounds). The renderer cannot fetch() a file: URL off a
   *  file: page, so a sample arrives as bytes and is decoded once into a cached AudioBuffer.
   *  `null` means the file is not in the pack table or is missing — the app just stays silent. */
  sounds: {
    load: (file: string) => Promise<Uint8Array | null>
  }
  skills: {
    list: () => Promise<{ skills: SkillMeta[]; errors: SkillLoadError[] }>
    get: (name: string) => Promise<{ skill: Skill | null; errors: SkillLoadError[] }>
    proposeEdit: (name: string, request: string) => Promise<{ current: string; proposed: string }>
    applyEdit: (name: string, content: string) => Promise<{ source: string; backup: string }>
    openForEditing: (name: string) => Promise<{ root: string; source: string }>
  }
  threads: {
    list: () => Promise<{ threads: ThreadMeta[]; error: string | null; activeId: string | null }>
    /** Every mutation resolves the fresh AgentState so the panel swaps transcripts in one hop. */
    activate: (id: string) => Promise<AgentState>
    newChat: () => Promise<AgentState>
    openSkill: (skillName: string) => Promise<AgentState>
    /** Fire-and-return: completion arrives on onRunComplete (the M4 toast). */
    runSkill: (skillName: string, activeFile: string | null) => Promise<{ threadId: string }>
    /** Dispose a thread's instance (record stays as history); active close falls back to chat. */
    close: (id: string) => Promise<AgentState>
    onRunComplete: (handler: (payload: ThreadRunComplete) => void) => () => void
  }
  /** The Bridle auth transport (bridle.auth:* channels) — feed to useIpcAuthFlow. */
  auth: AuthTransport
  fetchLinkTitle: (url: string) => Promise<string | null>
  /** The archive search (WF-4B): main spawns the `scout` CLI; `missing` when it is not installed. */
  archive: {
    search: (request: ArchiveSearchRequest) => Promise<ArchiveSearchResponse>
    passage: (passageId: string) => Promise<ArchivePassageResponse>
  }
  /** "Capture to research…": main runs `scout capture` for the Piece's folder (or its Folio's) and answers with the filed path or a sentence for the writer. */
  captureResearch: (request: CaptureRequest) => Promise<CaptureResponse>
  /** Open a `writeflex://open?path=…&line=N` link clicked in a draft (same parser as browser links). */
  openWriteflexLink: (url: string) => Promise<OpenLinkResult>
  /** The app version (package.json), for the status-bar corner. Static — fetch once. */
  getAppVersion: () => Promise<string>
  /** Narrow read-only runtime details for support copy in Settings → About. */
  getRuntimeInfo: () => Promise<RuntimeInfo>
  /** E2E agent double (Task 15): registers a scripted capability turn that the window's next
   *  prompt() consumes instead of a live model call. Main registers the handler ONLY under
   *  WRITEFLEX_E2E=1, so outside the e2e harness this invoke rejects with "no handler". */
  stubAgentTurn: (steps: Array<{ cap: string; input: unknown }>, reply?: string) => Promise<void>
  /** Proceed with a close the renderer has resolved (every dirty buffer flushed, or ⌘W was pressed
   *  with no tabs open): main marks it resolved and lets the window go at once. `checkpoint` names the
   *  documents the close owes a checkpoint, the changed ones first; main makes them after the window
   *  has gone, best-effort (close-checkpoints.ts). */
  closeWindow: (options?: { checkpoint?: string[] }) => Promise<void>
  /** The app in this page has stopped and text it holds could not be written: main asks the person
   *  whether to keep the window or close it anyway (renderer unsaved-text.ts). */
  closeUnsaved: () => Promise<void>
  /** Abandon a guarded close (a save failed, so the window stays open): clears any ⌘Q quit intent in
   *  main so a later ordinary close can't inherit it and quit the whole app. */
  cancelClose: () => Promise<void>
  /** Ack a close-request the instant it arrives (before flushing) so main's dead-renderer safety-net timer
   *  is cancelled — proving the renderer is alive so a slow flush is never force-closed out from under it. */
  acknowledgeClose: () => Promise<void>
  /** A native window close (red light, Window menu, ⌘Q) was intercepted: the renderer acks, flushes its
   *  LIVE dirty set (saving is automatic, ADR-0012), then closeWindow() — or cancelClose() if a write fails. */
  onCloseRequested: (fn: () => void) => () => void
  /** Main called off the close it asked for (the vault switcher's bound ran out): the close in flight
   *  must not send closeWindow() or cancelClose() when its flush ends. Answer with acknowledgeAbandonClose(). */
  onAbandonClose: (fn: () => void) => () => void
  /** This page has dropped the abandoned close; main takes its close answers again. */
  acknowledgeAbandonClose: () => Promise<void>
  /** The page has loaded its workspace view: `root`, or null for the start screen. A window the vault
   *  switcher opened hidden is shown only once this names the root it was bound to. */
  reportRendererReady: (root: string | null) => Promise<void>
  /** A one-line status from main for the status bar ("Switching to Notes…"). */
  onStatus: (fn: (message: string) => void) => () => void
  onTrace: (fn: (e: TraceEvent) => void) => () => void
  onApproval: (fn: (req: ApprovalRequest) => void) => () => void
  onSuggestions: (fn: (s: Suggestion[]) => void) => () => void
  /** The background agent boot finished for the bound Workspace: re-pull agent state (restored
   *  transcript, models) — binding no longer waits for the agent, so this replaces "ready at bind". */
  onAgentReady: (fn: () => void) => () => void
  onMenuAction: (fn: (a: MenuAction) => void) => () => void
  /** A queued file-open focus; `line` (1-based) when a writeflex:// link named one. */
  onFocusFile: (fn: (path: string, line?: number) => void) => () => void
  /** Fires only when the Electron BrowserWindow becomes frontmost, never for iframe focus. */
  onWindowFocused: (fn: () => void) => () => void
  /** A scraps mutation landed (this window or, later, the agent): re-list the pane + refresh the tree. */
  onScrapsChanged: (fn: () => void) => () => void
  /** A Change Ledger mutation landed (writer edit, agent ingest, accept/reject): re-list the dock. */
  onChangesChanged: (fn: () => void) => () => void
  /** A Version record landed; reload the active document's spine. */
  onVersionsChanged: (fn: () => void) => () => void
  /** A Collection write landed (New piece / create Index Note): refresh the tree and the open view.
   *  The payload is `null` except after an own save in place, when it carries that file's fresh
   *  listing entry so the tree can patch it instead of re-listing (shared/listing-patch.ts). */
  onCollectionChanged: (fn: (change: CollectionChanged | null) => void) => () => void
  /** The vault index after main recomputed it on a change in this root (null if the root stopped being a vault). */
  onVaultIndexChanged: (fn: (index: VaultIndex | null) => void) => () => void
  /** A guarded Diary write refusal, already reduced to human-readable text by main. */
  onDiaryError: (fn: (message: string) => void) => () => void
  /** Genuine external filesystem changes, as Workspace-relative paths, for open-buffer reconcile. */
  onFileChangedOnDisk: (fn: (paths: string[]) => void) => () => void
}

function on<T>(channel: string) {
  return (fn: (payload: T) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: T): void => fn(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

// A close request that arrives while nothing in the page listens for it is answered here, so main does
// not wait for an acknowledgement that cannot come. That is only a page in which the app's script never
// ran (a blank shell): the app subscribes before it mounts anything and keeps that subscription when
// its editor breaks (renderer main.tsx, unsaved-text.ts), because a broken editor can leave text.
let closeRequestListeners = 0
// The first close listener in this page is the app's own, put in place before it mounts anything. Main
// is told once: from then on this page may hold text, and "still loading" no longer justifies closing
// it without an answer (window-close.ts, `appStarted`). The preload runs again for each page load.
let appStartReported = false
ipcRenderer.on('window:close-requested', () => {
  if (closeRequestListeners === 0) void ipcRenderer.invoke('window:close-unattended')
})

const subscribeMenuAction = multiplexIpcChannel<MenuAction>(ipcRenderer, 'menu:action')
const subscribeExampleChanged = multiplexIpcChannel<{ change: 'removed' | 'restored' }>(ipcRenderer, 'example:changed')
const subscribeGuideShow = multiplexIpcChannel<null>(ipcRenderer, 'guide:show')
const subscribeSettingChanged = multiplexIpcChannel<{ key: string; value: SettingValue | null }>(ipcRenderer, 'settings:changed')
const subscribeVaultChanged = multiplexIpcChannel<VaultChangedEvent>(ipcRenderer, 'vault:changed')
const subscribeCollectionQueryChanged = multiplexIpcChannel<CollectionQueryInvalidation>(ipcRenderer, 'collection:query-changed')
let collectionQueryCount = 0
const collectionQueriesInFlight = new Map<string, Promise<QueryResult>>()

function queryCollection(dir: string, source: string): Promise<QueryResult> {
  const key = JSON.stringify([dir, source])
  const existing = collectionQueriesInFlight.get(key)
  if (existing) return existing
  collectionQueryCount += 1
  const pending = ipcRenderer.invoke('collection:query', { dir, source }) as Promise<QueryResult>
  collectionQueriesInFlight.set(key, pending)
  const clear = (): void => {
    if (collectionQueriesInFlight.get(key) === pending) collectionQueriesInFlight.delete(key)
  }
  void pending.then(clear, clear)
  return pending
}

function isWorkspaceRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '' || value.startsWith('/') || value.includes('\\')) return false
  const segments = value.split('/')
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

function validateFileRenamePlan(value: unknown): FileRenamePlan {
  if (!value || typeof value !== 'object') throw new Error('Invalid file rename plan received from the main process.')
  const candidate = value as { newPath?: unknown; repairPaths?: unknown }
  if (!isWorkspaceRelativePath(candidate.newPath) || !Array.isArray(candidate.repairPaths) ||
      !candidate.repairPaths.every(isWorkspaceRelativePath)) {
    throw new Error('Invalid file rename plan received from the main process.')
  }
  return { newPath: candidate.newPath, repairPaths: [...candidate.repairPaths] }
}

function validateFileRenameResult(value: unknown): RenameFileResult {
  if (!value || typeof value !== 'object') throw new Error('Invalid file rename result received from the main process.')
  const candidate = value as { file?: unknown; content?: unknown; repair?: unknown }
  if (!candidate.file || typeof candidate.file !== 'object' || typeof candidate.content !== 'string') {
    throw new Error('Invalid file rename result received from the main process.')
  }
  const file = candidate.file as { path?: unknown; name?: unknown; directory?: unknown; modifiedAt?: unknown; size?: unknown }
  const path = typeof file.path === 'string' ? file.path : ''
  const finalSlash = path.lastIndexOf('/')
  const expectedName = finalSlash < 0 ? path : path.slice(finalSlash + 1)
  const expectedDirectory = finalSlash < 0 ? '' : path.slice(0, finalSlash)
  if (!isWorkspaceRelativePath(file.path)
      || typeof file.name !== 'string' || file.name.trim() === '' || file.name.includes('/') || file.name.includes('\\')
      || typeof file.directory !== 'string' || (file.directory !== '' && !isWorkspaceRelativePath(file.directory))
      || file.name !== expectedName || file.directory !== expectedDirectory
      || typeof file.modifiedAt !== 'number' || !Number.isFinite(file.modifiedAt)
      || typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size < 0) {
    throw new Error('Invalid file rename result received from the main process.')
  }
  if (!candidate.repair || typeof candidate.repair !== 'object') {
    throw new Error('Invalid file rename result received from the main process.')
  }
  const repair = candidate.repair as { writtenPaths?: unknown; unrepairedReferences?: unknown; issues?: unknown }
  const validIssue = (issue: unknown): issue is RenameRepairIssue => {
    if (!issue || typeof issue !== 'object') return false
    const item = issue as { kind?: unknown; text?: unknown }
    return (RENAME_REPAIR_ISSUE_KINDS as readonly unknown[]).includes(item.kind) && typeof item.text === 'string'
  }
  if (!Array.isArray(repair.writtenPaths) || !repair.writtenPaths.every(isWorkspaceRelativePath)
      || !Array.isArray(repair.unrepairedReferences)
      || !repair.unrepairedReferences.every((reference) => typeof reference === 'string')
      || !Array.isArray(repair.issues) || !repair.issues.every(validIssue)) {
    throw new Error('Invalid file rename result received from the main process.')
  }
  return {
    file: {
      path: file.path,
      name: file.name,
      directory: file.directory,
      modifiedAt: file.modifiedAt,
      size: file.size,
    },
    content: candidate.content,
    repair: {
      writtenPaths: [...repair.writtenPaths],
      unrepairedReferences: [...repair.unrepairedReferences],
      issues: repair.issues.map((issue) => ({ kind: issue.kind, text: issue.text })),
    },
  }
}

const api: WriteFlexApi = {
  reportRendererError: (error) => ipcRenderer.invoke('diagnostics:renderer-error', error),
  reloadRenderer: () => ipcRenderer.invoke('diagnostics:reload-renderer'),
  installCommandLineTool: () => ipcRenderer.invoke('cli:install'),
  sharing: {
    status: (options) => ipcRenderer.invoke('sharing:status', { askService: options?.askService === true }),
    checkToken: (token) => ipcRenderer.invoke('sharing:check-token', token),
    checkSavedToken: () => ipcRenderer.invoke('sharing:check-saved-token'),
    chooseAccount: (accountId) => ipcRenderer.invoke('sharing:choose-account', accountId),
    setUp: () => ipcRenderer.invoke('sharing:set-up'),
    removalConfirmation: () => ipcRenderer.invoke('sharing:removal-confirmation'),
    remove: (request) => ipcRenderer.invoke('sharing:remove', { confirmation: request.confirmation }),
    openCloudflare: () => ipcRenderer.invoke('sharing:open-cloudflare'),
    domains: () => ipcRenderer.invoke('sharing:domains'),
    attachAddress: (request) => ipcRenderer.invoke('sharing:attach-address', { name: request.name, domain: request.domain }),
    removeAddress: () => ipcRenderer.invoke('sharing:remove-address'),
    piece: (path) => ipcRenderer.invoke('sharing:piece', path),
    open: (path) => ipcRenderer.invoke('sharing:open', path),
    folio: (dir, part) => ipcRenderer.invoke('sharing:folio', part === undefined ? dir : { dir, part }),
    openFolio: (dir, part) => ipcRenderer.invoke('sharing:open-folio', part === undefined ? dir : { dir, part }),
    close: () => ipcRenderer.invoke('sharing:close'),
    make: (request) => ipcRenderer.invoke('sharing:make', request.folio !== undefined
      ? { folio: request.folio, name: request.name, comments: request.comments }
      : { path: request.path, name: request.name, comments: request.comments }),
    rename: (shareId, name) => ipcRenderer.invoke('sharing:rename', { shareId, name }),
    setComments: (shareId, comments) => ipcRenderer.invoke('sharing:set-comments', { shareId, comments }),
    turnOff: (shareId) => ipcRenderer.invoke('sharing:turn-off', { shareId }),
    turnOn: (shareId) => ipcRenderer.invoke('sharing:turn-on', { shareId }),
    followTo: (shareId) => ipcRenderer.invoke('sharing:follow-to', { shareId }),
    retry: (shareId) => ipcRenderer.invoke('sharing:retry', { shareId }),
    openLink: (shareId) => ipcRenderer.invoke('sharing:open-link', { shareId }),
    copyAddress: (shareId) => ipcRenderer.invoke('sharing:copy-address', { shareId }),
    openList: () => ipcRenderer.invoke('sharing:open-list'),
    opened: () => ipcRenderer.invoke('sharing:opened'),
    notes: () => ipcRenderer.invoke('sharing:notes'),
    clearHandled: (shareId) => ipcRenderer.invoke('sharing:clear-handled', { shareId }),
    raiseLimit: (shareId) => ipcRenderer.invoke('sharing:raise-limit', { shareId }),
    onChanged: (fn) => {
      const listener = (): void => fn()
      ipcRenderer.on('sharing:changed', listener)
      return () => { ipcRenderer.removeListener('sharing:changed', listener) }
    },
  },
  setWindowTitle: (title) => ipcRenderer.invoke('window:set-title', title),
  e2eEnabled: process.env.WRITEFLEX_E2E === '1',
  e2eWriteHooks: e2eWriteHooksFromProcess(process.argv, process.env),
  e2eCollectionQueryCount: () => collectionQueryCount,
  resetE2eCollectionQueryCount: () => { collectionQueryCount = 0 },
  clipboardText: () => clipboard.readText(),
  copyToClipboard: (markdown, kind, path) => ipcRenderer.invoke('clipboard:copy', { markdown, kind, path }),
  exportTitle: (input) => ipcRenderer.invoke('export:title', input),
  chooseExportTarget: (input) => ipcRenderer.invoke('export:choose', input),
  exportDocument: (input) => ipcRenderer.invoke('export:document', input),
  exportBundle: (input) => ipcRenderer.invoke('export:bundle', input),
  revealExport: () => ipcRenderer.invoke('export:reveal'),
  readTocDepth: (input) => ipcRenderer.invoke('export:toc-depth:read', input),
  getExportPresetSettings: () => ipcRenderer.invoke('export-presets:get'),
  setExportPresetSettings: (settings) => ipcRenderer.invoke('export-presets:set', settings),
  openDialog: (droppedPath) => ipcRenderer.invoke('workspace:open-dialog', droppedPath),
  metadataValues: (exclude) => ipcRenderer.invoke('metadata:values', exclude),
  setCollectionPageActive: (active, folio = false, canStart = true) => ipcRenderer.invoke('menu:collection-active', { active, folio, canStart }),
  getWorkspace: () => ipcRenderer.invoke('workspace:get'),
  getChecklistProgress: (input) => ipcRenderer.invoke('workspace:checklist-progress', input),
  getVaultIndex: () => ipcRenderer.invoke('vault:index'),
  previewVault: (input) => ipcRenderer.invoke('vault:preview', input ?? {}),
  getRecents: () => ipcRenderer.invoke('workspace:recents'),
  openRecent: (root, options) => ipcRenderer.invoke('workspace:open-recent', root, options),
  getSwitcherList: () => ipcRenderer.invoke('workspace:switcher-list'),
  switchRoot: (target) => ipcRenderer.invoke('workspace:switch', target),
  getPinned: () => ipcRenderer.invoke('workspace:pinned'),
  pinWorkspace: (root) => ipcRenderer.invoke('workspace:pin', root),
  unpinWorkspace: (root) => ipcRenderer.invoke('workspace:unpin', root),
  movePinned: (root, toIndex) => ipcRenderer.invoke('workspace:pin-move', root, toIndex),
  locatePinned: (root) => ipcRenderer.invoke('workspace:pin-locate', root),
  revealPinned: (root) => ipcRenderer.invoke('workspace:pin-reveal', root),
  getStartScreen: () => ipcRenderer.invoke('start:model'),
  openExample: (target) => ipcRenderer.invoke('example:open', target),
  getGuideContext: () => ipcRenderer.invoke('guide:context'),
  getExampleRemovalPreview: () => ipcRenderer.invoke('example:removal-preview'),
  removeExample: (token) => ipcRenderer.invoke('example:remove', token),
  restoreExample: () => ipcRenderer.invoke('example:restore'),
  onExampleChanged: subscribeExampleChanged,
  onGuideShow: (fn) => subscribeGuideShow(() => fn()),
  commandRan: (id) => { void ipcRenderer.invoke('guide:command-ran', id) },
  guideChapterFinished: (chapter) => { void ipcRenderer.invoke('guide:chapter-finished', chapter) },
  guideChapterOpened: (chapter) => { void ipcRenderer.invoke('guide:chapter-opened', chapter) },
  guideTopicRead: (id) => { void ipcRenderer.invoke('guide:topic-read', id) },
  getGuideConnections: () => ipcRenderer.invoke('guide:connections'),
  openGuideLink: (link) => ipcRenderer.invoke('guide:open-link', link),
  openGuideChapter: (chapter) => ipcRenderer.invoke('guide:open-chapter', chapter),
  searchWorkspace: (query, options) => options?.scope
    ? ipcRenderer.invoke('workspace:search', query, { scope: options.scope })
    : ipcRenderer.invoke('workspace:search', query),
  getFolderFocus: () => ipcRenderer.invoke('focus:get'),
  setFolderFocus: (path) => ipcRenderer.invoke('focus:set', path),
  scanJumps: (scope, path) => ipcRenderer.invoke('jumps:scan', { scope, path }),
  listFavourites: () => ipcRenderer.invoke('workspace:favourites:list'),
  toggleFavourite: (path) => ipcRenderer.invoke('workspace:favourites:toggle', path),
  readFile: (path) => ipcRenderer.invoke('file:read', path),
  readWidget: (documentPath, rawPath) => ipcRenderer.invoke('widget:read', { documentPath, rawPath }),
  listWidgetChoices: (documentPath) => ipcRenderer.invoke('widget:list-choices', { documentPath }),
  resolveWidgetDrop: (documentPath, file) => {
    const absolutePath = webUtils.getPathForFile(file)
    return absolutePath ? ipcRenderer.invoke('widget:resolve-drop', { documentPath, absolutePath }) : Promise.resolve({ ok: false, reason: 'missing' })
  },
  openWidgetFile: (documentPath, rawPath) => ipcRenderer.invoke('widget:open-file', { documentPath, rawPath }),
  setWidgetKeyboardOwner: (claim) => ipcRenderer.invoke('widget:keyboard-owner', claim),
  watchWidget: (documentPath, rawPath) => ipcRenderer.invoke('widget:watch', { documentPath, rawPath }),
  unwatchWidget: (documentPath, rawPath) => ipcRenderer.invoke('widget:unwatch', { documentPath, rawPath }),
  createStandardWidget: (request) => ipcRenderer.invoke('standard-widget:create', request),
  standardWidgetOwnFolderFacts: (request) => ipcRenderer.invoke('standard-widget:own-folder-facts', request),
  standardWidgetLeftoverSteps: () => ipcRenderer.invoke('standard-widget:leftover-steps'),
  cleanUpStandardWidgetStep: (id) => ipcRenderer.invoke('standard-widget:clean-up-step', { id }),
  forgetStandardWidgetStep: (id) => ipcRenderer.invoke('standard-widget:forget-step', { id }),
  updateStandardWidgetRecipe: (request) => ipcRenderer.invoke('standard-widget:update-recipe', request),
  buildStandardWidget: (recipePath) => ipcRenderer.invoke('standard-widget:build', { recipePath }),
  undoStandardWidgetStep: (undoId) => ipcRenderer.invoke('standard-widget:undo', { undoId }),
  previewStandardWidget: (request) => ipcRenderer.invoke('standard-widget:preview', request),
  listStandardWidgetSources: (documentPath) => ipcRenderer.invoke('standard-widget:list-sources', { documentPath }),
  pickStandardWidgetSource: (documentPath) => ipcRenderer.invoke('standard-widget:pick-source', { documentPath }),
  readFrontmatter: (path) => ipcRenderer.invoke('frontmatter:read', path),
  setGoal: (path, target, due, basis) => ipcRenderer.invoke('goal:set', { path, target, due, basis }),
  saveFile: (path, content, basis) => ipcRenderer.invoke('file:save', { path, content, basis }),
  clearDocument: (path) => ipcRenderer.invoke('file:clear', { path }),
  checkpoint: (path, opts) => ipcRenderer.invoke('snapshot:checkpoint', { path, ...(opts?.auto ? { auto: true } : {}) }),
  preserveVersion: (path, text) => ipcRenderer.invoke('snapshot:preserve', { path, text }),
  createFile: (name, directory) => ipcRenderer.invoke('file:create', { name, directory }),
  planFileRename: (path, newName, directory) => ipcRenderer
    .invoke('file:rename-repair-paths', { path, newName, directory })
    .then(validateFileRenamePlan),
  renameFile: (path, newPath) => ipcRenderer.invoke('file:rename', { path, newPath }).then(validateFileRenameResult),
  moveFile: (path, newPath, collectionDir) => ipcRenderer.invoke('file:move', { path, newPath, collectionDir }).then(validateFileRenameResult),
  duplicateFile: (path) => ipcRenderer.invoke('file:duplicate', { path }),
  pickImage: () => ipcRenderer.invoke('assets:pick-image'),
  saveImage: (bytes, ext) => ipcRenderer.invoke('assets:save-image', { bytes, ext }),
  trashFile: (path) => ipcRenderer.invoke('file:trash', { path }),
  revealFile: (path) => ipcRenderer.invoke('file:reveal', { path }),
  createFolder: (path) => ipcRenderer.invoke('folder:create', { path }),
  renameFolder: (path, newName) => ipcRenderer.invoke('folder:rename', { path, newName }),
  trashFolder: (path) => ipcRenderer.invoke('folder:trash', { path }),
  listScraps: (scope) => ipcRenderer.invoke('scraps:list', scope),
  addScrap: (origin, text) => ipcRenderer.invoke('scraps:add', { origin, text }),
  toggleScrapDone: (id) => ipcRenderer.invoke('scraps:toggle-done', id),
  setScrapColour: (id, colour) => ipcRenderer.invoke('scraps:set-colour', { id, colour }),
  removeScrap: (id) => ipcRenderer.invoke('scraps:remove', id),
  scratchpad: {
    sources: (input) => ipcRenderer.invoke('scratchpad:sources', input),
    collectSource: (input) => ipcRenderer.invoke('scratchpad:collect-source', input),
    prepareReference: (input) => ipcRenderer.invoke('scratchpad:prepare-reference', input),
    attachReference: (input) => ipcRenderer.invoke('scratchpad:attach-reference', input),
    undoAttach: (input) => ipcRenderer.invoke('scratchpad:undo-attach', input),
    collectAsset: (input) => ipcRenderer.invoke('scratchpad:collect-asset', input),
    inventory: (input) => ipcRenderer.invoke('scratchpad:inventory', input),
    onReadBuffersRequested: on('scratchpad:read-buffers'),
    answerBuffers: (input) => ipcRenderer.invoke('scratchpad:answer-buffers', input),
    list: (input) => ipcRenderer.invoke('scratchpad:list', input),
    sendText: (input) => ipcRenderer.invoke('scratchpad:send-text', input),
    reserveCut: (input) => ipcRenderer.invoke('scratchpad:reserve-cut', input),
    cancelCut: (input) => ipcRenderer.invoke('scratchpad:cancel-cut', input),
    confirmCut: (input) => ipcRenderer.invoke('scratchpad:confirm-cut', input),
    discardCopy: (input) => ipcRenderer.invoke('scratchpad:discard-copy', input),
    deleteForever: (input) => ipcRenderer.invoke('scratchpad:delete-forever', input),
    setStatus: (input) => ipcRenderer.invoke('scratchpad:set-status', input),
    setGroup: (input) => ipcRenderer.invoke('scratchpad:set-group', input),
    createGroup: (input) => ipcRenderer.invoke('scratchpad:create-group', input),
    toggleDone: (input) => ipcRenderer.invoke('scratchpad:toggle-done', input),
    setColour: (input) => ipcRenderer.invoke('scratchpad:set-colour', input),
    recordUse: (input) => ipcRenderer.invoke('scratchpad:record-use', input),
    dropUse: (input) => ipcRenderer.invoke('scratchpad:drop-use', input),
    releaseUses: (input) => ipcRenderer.invoke('scratchpad:release-uses', input),
    prepareInsert: (input) => ipcRenderer.invoke('scratchpad:prepare-insert', input),
    prepareWidgetPreview: (input) => ipcRenderer.invoke('scratchpad:prepare-widget-preview', input),
    externalStatus: (input) => ipcRenderer.invoke('scratchpad:external-status', input),
    externalSearch: (input) => ipcRenderer.invoke('scratchpad:external-search', input),
    externalCollect: (input) => ipcRenderer.invoke('scratchpad:external-collect', input),
    externalImport: (input) => ipcRenderer.invoke('scratchpad:external-import', input),
    onChanged: on('scratchpad:changed'),
  },
  listChanges: (scope) => ipcRenderer.invoke('changes:list', scope),
  addChange: (input) => ipcRenderer.invoke('changes:add', input),
  updateWriterChange: (id, input) => ipcRenderer.invoke('changes:update-writer', { id, input }),
  setChangeStatus: (id, status) => ipcRenderer.invoke('changes:set-status', { id, status }),
  replyToReader: (id, text) => ipcRenderer.invoke('changes:reader-reply', { id, text }),
  classifyChange: (id, editClass) => ipcRenderer.invoke('changes:classify', { id, editClass }),
  resolveChange: (id, action, options) => ipcRenderer.invoke('changes:resolve', { id, action, ...(options?.sweep === false ? { sweep: false } : {}) }),
  outsideSummary: () => ipcRenderer.invoke('changes:outside-summary'),
  rejectOutsideChanges: (which) => ipcRenderer.invoke('changes:reject-outside', which),
  acceptOutsideChanges: (which) => ipcRenderer.invoke('changes:accept-outside', which),
  saveChangeVersion: (input) => ipcRenderer.invoke('changes:save-version', input),
  historyAttachmentSuggestions: (path) => ipcRenderer.invoke('versions:attachment-suggestions', path),
  waitingVersionHistory: () => ipcRenderer.invoke('versions:waiting'),
  historyAttachmentUndo: (path) => ipcRenderer.invoke('versions:attachment-undo', path),
  attachVersionHistory: (input) => ipcRenderer.invoke('versions:attach', input),
  undoHistoryAttachment: (id) => ipcRenderer.invoke('versions:undo-attachment', id),
  listVersions: (scope) => ipcRenderer.invoke('versions:list', scope),
  renameVersion: (id, name) => ipcRenderer.invoke('versions:rename', { id, name }),
  versionContent: (input) => ipcRenderer.invoke('versions:content', input),
  compareVersions: (input) => ipcRenderer.invoke('versions:compare', input),
  restoreVersion: (input) => ipcRenderer.invoke('versions:restore', input),
  listCollection: (dir, options) => ipcRenderer.invoke('collection:list', { dir, ...options }),
  collection: {
    beginBatch: () => ipcRenderer.invoke('collection:begin-batch'),
    endBatch: () => ipcRenderer.invoke('collection:end-batch'),
    status: (dir) => ipcRenderer.invoke('collection:status', { dir }),
    pattern: (dir) => ipcRenderer.invoke('collection:pattern', { dir }),
    query: queryCollection,
    unresolvedFolderPieces: (dir) => ipcRenderer.invoke('collection:unresolved-folder-pieces', { dir }),
    addTags: (dir, path, tags) => ipcRenderer.invoke('collection:add-tags', { dir, path, tags }),
    setStatus: (dir, path, status) => ipcRenderer.invoke('collection:set-status', { dir, path, status }),
    setPieceMode: (dir, folderPath, mode) => ipcRenderer.invoke('collection:set-piece-mode', { dir, folderPath, mode }),
    links: (dir, from, content) => ipcRenderer.invoke('collection:links', { dir, from, content }),
    targets: () => ipcRenderer.invoke('collection:targets'),
    focusPiece: (windowId, path) => ipcRenderer.invoke('collection:focus-piece', { windowId, path }),
    previewStub: (input) => ipcRenderer.invoke('collection:stub-preview', input),
    createStub: (input) => ipcRenderer.invoke('collection:stub-create', input),
    onChanged: subscribeCollectionQueryChanged,
    digest: (dir) => ipcRenderer.invoke('agent:digest', { dir }),
  },
  agentNotes: {
    list: (dir = '') => ipcRenderer.invoke('agent-notes:list', { dir }),
    restage: (path, input) => ipcRenderer.invoke('agent-notes:restage', { path, ...input }),
    toggleTask: (path, line, checked) => ipcRenderer.invoke('agent-notes:toggle-task', { path, line, checked }),
    onChanged: on('agent-notes:changed'),
  },
  createCollectionIndex: (dir) => ipcRenderer.invoke('collection:create-index', { dir }),
  createCollectionPiece: (dir) => ipcRenderer.invoke('collection:new-piece', { dir }),
  diary: {
    chooseFolder: () => ipcRenderer.invoke('diary:choose-folder'),
    countedCollections: () => ipcRenderer.invoke('diary:counted-collections'),
    isCounted: (dir) => ipcRenderer.invoke('diary:is-counted', dir),
    setCounted: (dir, counted, root) => ipcRenderer.invoke('diary:set-counted', { dir, counted, ...(root ? { root } : {}) }),
    prime: (path, words) => ipcRenderer.invoke('diary:prime', { path, words }),
    activity: (path, words, at, beforeWords) => ipcRenderer.invoke('diary:activity', { path, words, ...(at === undefined ? {} : { at }), ...(beforeWords === undefined ? {} : { beforeWords }) }),
    getSession: () => ipcRenderer.invoke('diary:session:get'),
    getAutomaticSession: () => ipcRenderer.invoke('diary:automatic-session:get'),
    startSession: (input) => ipcRenderer.invoke('diary:session:start', input),
    endSession: () => ipcRenderer.invoke('diary:session:end'),
    dismissCompletedSession: () => ipcRenderer.invoke('diary:session:dismiss'),
    adjustSessionTarget: (targetWords) => ipcRenderer.invoke('diary:session:adjust-target', targetWords),
    onSession: on('diary:session'),
    onSessionMessage: on('diary:session-message'),
    onAutomaticSession: on('diary:automatic-session'),
  },
  setAmbient: (snapshot) => ipcRenderer.invoke('ambient:set', snapshot),
  readFolio: (dir) => ipcRenderer.invoke('folio:read', { dir }),
  readFolioPieces: (dir) => ipcRenderer.invoke('folio:pieces', { dir }),
  readFolioPlace: (path) => ipcRenderer.invoke('folio:place', { path }),
  readFolioDir: (dir) => ipcRenderer.invoke('folio:dir', { dir }),
  readFolioOutline: (path) => ipcRenderer.invoke('folio:outline', { path }),
  folioRoom: {
    map: (dir, request) => ipcRenderer.invoke('plan:room-map', { dir, ...request }),
    author: (dir, request) => ipcRenderer.invoke('plan:room-authoring', { dir, request }),
    read: (dir, essential) => ipcRenderer.invoke('folio-room:read', { dir, essential }),
    getState: (dir) => ipcRenderer.invoke('folio-room:get-state', { dir }),
    setState: (dir, state) => ipcRenderer.invoke('folio-room:set-state', { dir, state }),
  },
  folioDetails: {
    read: (dir) => ipcRenderer.invoke('folio:read-details', { dir }),
    set: (dir, field, value, basis) => ipcRenderer.invoke('folio:set-detail', { dir, field, value, basis }),
    undo: (dir, token) => ipcRenderer.invoke('folio:undo-detail', { dir, token }),
    values: () => ipcRenderer.invoke('folio:detail-values', {}),
  },
  folioRunningOrder: {
    movePiece: (dir, path, beforePath, expected) => ipcRenderer.invoke('folio:move-piece', { dir, path, beforePath, expected }),
    addPieces: (dir, paths, expected) => ipcRenderer.invoke('folio:add-pieces', { dir, paths, expected }),
    removeAdded: (dir, token) => ipcRenderer.invoke('folio:remove-added', { dir, token }),
  },
  resolveTabGroups: (paths) => ipcRenderer.invoke('tabs:groups', { paths }),
  makeFolio: (dir) => ipcRenderer.invoke('folio:create', { dir }),
  onFolioFlushRequested: on('folio:flush-requested'),
  replyFolioFlush: (id, saved) => ipcRenderer.invoke('folio:flush-result', { id, saved }),
  createNestedFolio: (dir) => ipcRenderer.invoke('folio:create-nested', { dir }),
  readFolioDeclaration: (dir) => ipcRenderer.invoke('folio:declaration', { dir }),
  undoTurnBack: (dir) => ipcRenderer.invoke('folio:undo-turn-back', { dir }),
  turnBackIntoCollection: (dir) => invokeTurnBackAfterNotifications(ipcRenderer, dir),
  folioAgentInstructions: {
    read: (dir) => ipcRenderer.invoke('folio:agent-instructions', { dir }),
    act: (dir, action) => ipcRenderer.invoke('folio:agent-instructions-act', { dir, action }),
  },
  plan: {
    onIdentityLinked: on('plan:identity-linked'),
    identityCheck: (dir, root, force) => ipcRenderer.invoke('plan:identity-check', { dir, root, force }),
    open: (dir, root, force) => ipcRenderer.invoke('plan:open', { dir, root, force }),
    read: (dir) => ipcRenderer.invoke('plan:read', { dir }),
    adoptPart: (dir, unlistedIndex, expected, asFrontMatter) => ipcRenderer.invoke('plan:adopt-part', { dir, unlistedIndex, expected, ...(asFrontMatter ? { asFrontMatter: true } : {}) }),
    insertPart: (dir, at, part, order) => ipcRenderer.invoke('plan:insert-part', { dir, at, part, ...(order?.createManifest !== undefined ? { createManifest: order.createManifest } : {}) }),
    movePart: (dir, from, to, order) => ipcRenderer.invoke('plan:move-part', { dir, from, to, ...(order?.createManifest !== undefined ? { createManifest: order.createManifest } : {}) }),
    removePart: (dir, index) => ipcRenderer.invoke('plan:remove-part', { dir, index }),
    setPartRole: (dir, index, role, expected) => ipcRenderer.invoke('plan:set-part-role', { dir, index, role, expected }),
    reorderParts: (dir, order, expected, write) => ipcRenderer.invoke('plan:reorder-parts', { dir, order, expected, ...(write?.createManifest !== undefined ? { createManifest: write.createManifest } : {}), ...(write?.room ? { room: true } : {}) }),
    roomNewCard: (dir, title, expected) => ipcRenderer.invoke('plan:room-new-card', { dir, title, expected }),
    roomRemoveCard: (dir, index, title, expected) => ipcRenderer.invoke('plan:room-remove-card', { dir, index, title, expected }),
    addParts: (dir, paths, expected) => ipcRenderer.invoke('plan:add-parts', { dir, paths, expected }),
    removeAdded: (dir, token) => ipcRenderer.invoke('plan:remove-added', { dir, token }),
    materialisePart: (dir, index) => ipcRenderer.invoke('plan:materialise-part', { dir, index }),
    exportOrder: (dir) => ipcRenderer.invoke('plan:export-order', { dir }),
    alignManifest: (dir, expected) => ipcRenderer.invoke('plan:align-manifest', { dir, expected }),
    setHeadingMode: (dir, path, mode) => ipcRenderer.invoke('plan:set-heading-mode', { dir, path, mode }),
    setHeadingModeOfPart: (path, mode) => ipcRenderer.invoke('plan:set-heading-mode', { path, mode, locate: true }),
    setHeadingModeOfOpenPart: (path, mode, basis) => ipcRenderer.invoke('plan:set-heading-mode', { path, mode, locate: true, basis }),
  },
  checkFolioPartTitles: (path) => ipcRenderer.invoke('folio:check-part-titles', { path }),
  titleConflict: {
    fixPart: (dir, item, direction) => ipcRenderer.invoke('title:fix-part', { dir, item, direction }),
    fixFolio: (dir, items, direction) => ipcRenderer.invoke('title:fix-folio', { dir, items, direction }),
    undo: (token) => ipcRenderer.invoke('title:undo', { token }),
  },
  vault: {
    get: () => ipcRenderer.invoke('vault:get'),
    create: (input) => ipcRenderer.invoke('vault:create', input ?? {}),
    addPin: (path) => ipcRenderer.invoke('vault:add-pin', { path }),
    removePin: (path) => ipcRenderer.invoke('vault:remove-pin', { path }),
    reorderPins: (order) => ipcRenderer.invoke('vault:reorder-pins', { order }),
    save: (settings, baseHash) => ipcRenderer.invoke('vault:save', { settings, baseHash }),
    onChanged: (fn) => subscribeVaultChanged(fn),
  },
  boardMaterial: {
    promoteOffcut: (input) => ipcRenderer.invoke('board-material:promote-offcut', input),
    appendScrap: (input) => ipcRenderer.invoke('board-material:append-scrap', input),
    attachSource: (input) => ipcRenderer.invoke('board-material:attach-source', input),
    listSources: (path, dir) => ipcRenderer.invoke('board-material:list-sources', { path, ...(dir !== undefined ? { dir } : {}) }),
    undo: (id) => ipcRenderer.invoke('board-material:undo', { id }),
  },
  planProposal: {
    view: (id) => ipcRenderer.invoke('plan-proposal:view', { id }),
    accept: (id, edits) => ipcRenderer.invoke('plan-proposal:accept', { id, ...(edits ? { edits } : {}) }),
    discard: (id) => ipcRenderer.invoke('plan-proposal:discard', { id }),
    undo: (id) => ipcRenderer.invoke('plan-proposal:undo', { id }),
  },
  listSources: () => ipcRenderer.invoke('sources:list'),
  showItem: (path) => ipcRenderer.invoke('app:show-item', path),
  modelPickerOpened: () => ipcRenderer.invoke('agent:models-picker-opened'),
  refreshModels: () => ipcRenderer.invoke('agent:models-refresh'),
  onModelsChanged: on('agent:models-changed'),
  getAgentState: () => ipcRenderer.invoke('agent:state'),
  prompt: (text, activeFile, activeCollectionDir, runOnFolder) => ipcRenderer.invoke('agent:prompt', { text, activeFile, activeCollectionDir, ...(runOnFolder === undefined ? {} : { runOnFolder }) }),
  abortAgent: () => ipcRenderer.invoke('agent:abort'),
  setModel: (provider, modelId) => ipcRenderer.invoke('agent:set-model', { provider, modelId }),
  setThinking: (level) => ipcRenderer.invoke('agent:set-thinking', level),
  setDefaultModel: (provider, modelId) => ipcRenderer.invoke('agent:set-default-model', { provider, modelId }),
  setDefaultThinking: (level) => ipcRenderer.invoke('agent:set-default-thinking', level),
  applySuggestion: (id) => ipcRenderer.invoke('suggestions:apply', id),
  discardSuggestion: (id) => ipcRenderer.invoke('suggestions:discard', id),
  respondApproval: (id, approved) => ipcRenderer.invoke('approvals:respond', { id, approved }),
  assistantTurns: {
    list: () => ipcRenderer.invoke('agent:turns:list'),
    get: (id) => ipcRenderer.invoke('agent:turns:get', id),
    undo: (id, includingLater) => ipcRenderer.invoke('agent:turns:undo', { id, includingLater }),
    onActivity: on('agent:turn-activity'),
  },
  restoreLastTurn: () => ipcRenderer.invoke('agent:restore-last-turn'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key, value, label, opts) => ipcRenderer.invoke('settings:set', { key, value, label, ...(opts?.log === false ? { log: false } : {}) }),
  getSettingsChangelog: () => ipcRenderer.invoke('settings:changelog'),
  revertSetting: (index) => ipcRenderer.invoke('settings:revert', index),
  onSettingChanged: subscribeSettingChanged,
  readingRoom: {
    getState: (draftPath) => ipcRenderer.invoke('reading-room:get-state', draftPath),
    recentDocuments: () => ipcRenderer.invoke('reading-room:recent-documents'),
    searchShelf: (query, collectionId) => ipcRenderer.invoke('reading-room:search-shelf', query, collectionId ?? null),
    shelfCollections: () => ipcRenderer.invoke('reading-room:shelf-collections'),
    openShelfItem: (input) => ipcRenderer.invoke('reading-room:open-shelf-item', input),
    readHighlights: () => ipcRenderer.invoke('reading-room:read-highlights'),
    citeSelection: (input) => ipcRenderer.invoke('reading-room:cite-selection', input),
    beginAreaQuotation: (input) => ipcRenderer.invoke('reading-room:begin-area-quotation', input),
    recordAreaQuotation: (input) => ipcRenderer.invoke('reading-room:record-area-quotation', input),
    saveAnnotations: (input) => ipcRenderer.invoke('reading-room:save-annotations', input),
    drainOutbox: () => ipcRenderer.invoke('reading-room:drain-outbox'),
    outboxCounts: () => ipcRenderer.invoke('reading-room:outbox-counts'),
    onOutboxChanged: on<ReadingRoomWriteResult>('reading-room:outbox-changed'),
    showZoteroPlugin: () => ipcRenderer.invoke('reading-room:show-zotero-plugin'),
    refusedHighlights: () => ipcRenderer.invoke('reading-room:refused-highlights'),
    retryRefused: (id) => ipcRenderer.invoke('reading-room:retry-refused', id),
    dismissRefused: (id) => ipcRenderer.invoke('reading-room:dismiss-refused', id),
    readDocument: (path) => ipcRenderer.invoke('reading-room:read-document', path),
    addBookmark: (input) => ipcRenderer.invoke('reading-room:add-bookmark', input),
    listBookmarks: () => ipcRenderer.invoke('reading-room:list-bookmarks'),
    saveViewState: (input) => ipcRenderer.invoke('reading-room:save-view-state', input),
    saveWidth: (width) => ipcRenderer.invoke('reading-room:save-width', width),
  },
  sounds: {
    load: (file) => ipcRenderer.invoke('sounds:load', file),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    get: (name) => ipcRenderer.invoke('skills:get', name),
    proposeEdit: (name, request) => ipcRenderer.invoke('skills:propose-edit', { name, request }),
    applyEdit: (name, content) => ipcRenderer.invoke('skills:apply-edit', { name, content }),
    openForEditing: (name) => ipcRenderer.invoke('skills:open-for-editing', { name }),
  },
  threads: {
    list: () => ipcRenderer.invoke('threads:list'),
    activate: (id) => ipcRenderer.invoke('threads:activate', id),
    newChat: () => ipcRenderer.invoke('threads:new-chat'),
    openSkill: (skillName) => ipcRenderer.invoke('threads:open-skill', skillName),
    runSkill: (skillName, activeFile) => ipcRenderer.invoke('threads:run-skill', { skillName, activeFile }),
    close: (id) => ipcRenderer.invoke('threads:close', id),
    onRunComplete: on('threads:run-complete'),
  },
  auth: createAuthTransport(),
  fetchLinkTitle: (url) => ipcRenderer.invoke('web:fetch-title', url),
  archive: {
    search: (request) => ipcRenderer.invoke('archive:search', request),
    passage: (passageId) => ipcRenderer.invoke('archive:passage', passageId),
  },
  captureResearch: (request) => ipcRenderer.invoke('research:capture', request),
  openWriteflexLink: (url) => ipcRenderer.invoke('links:open-writeflex', url),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  getRuntimeInfo: () => ipcRenderer.invoke('app:runtime-info'),
  stubAgentTurn: (steps, reply) => ipcRenderer.invoke('agent:stub', steps, reply),
  closeWindow: (options) => ipcRenderer.invoke('window:close', options?.checkpoint ? { checkpoint: options.checkpoint } : undefined),
  closeUnsaved: () => ipcRenderer.invoke('window:close-unsaved'),
  cancelClose: () => ipcRenderer.invoke('window:cancel-close'),
  acknowledgeClose: () => ipcRenderer.invoke('window:close-ack'),
  onAbandonClose: on<void>('window:abandon-close'),
  acknowledgeAbandonClose: () => ipcRenderer.invoke('window:abandon-close-ack'),
  reportRendererReady: (root) => ipcRenderer.invoke('renderer:ready', root),
  onStatus: on<string>('window:status'),
  onCloseRequested: (fn) => {
    closeRequestListeners += 1
    if (!appStartReported) {
      appStartReported = true
      void ipcRenderer.invoke('window:app-started').catch(() => {})
    }
    const off = on<void>('window:close-requested')(fn)
    return () => { closeRequestListeners -= 1; off() }
  },
  onTrace: on('agent:trace'),
  onAgentReady: on('agent:ready'),
  onApproval: on('agent:approval'),
  onSuggestions: on('agent:suggestions'),
  onMenuAction: subscribeMenuAction,
  onFocusFile: (fn) => {
    // The payload is the bare relative path, or { path, line } when a link named a line.
    const listener = (_e: Electron.IpcRendererEvent, payload: string | { path: string; line: number }): void =>
      typeof payload === 'string' ? fn(payload) : fn(payload.path, payload.line)
    ipcRenderer.on('workspace:focus-file', listener)
    return () => ipcRenderer.removeListener('workspace:focus-file', listener)
  },
  onWindowFocused: on<void>('window:focused'),
  onScrapsChanged: on('scraps:changed'),
  onChangesChanged: on('changes:changed'),
  onVersionsChanged: on('versions:changed'),
  onCollectionChanged: on<CollectionChanged | null>('collection:changed'),
  onVaultIndexChanged: on('vault:index-changed'),
  onDiaryError: on('diary:error'),
  onFileChangedOnDisk: on('file:changed-on-disk')
}

contextBridge.exposeInMainWorld('writeflex', api)

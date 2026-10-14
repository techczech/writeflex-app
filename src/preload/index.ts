import type { AmbientSnapshot } from '../main/ambient'
import type { ModelDiscoveryReason, ModelRefreshResult, ModelsChecked } from '../shared/model-refresh'
export type { AmbientSnapshot } from '../main/ambient'
import { clipboard, contextBridge, ipcRenderer, webUtils } from 'electron'
import { createAuthTransport } from '@bridle/electron/preload'
import type { AuthTransport } from '@bridle/electron'
import { multiplexIpcChannel } from './subscriptions'
import type { ArchivePassageResponse, ArchiveSearchRequest, ArchiveSearchResponse } from '../shared/scout'
import type { OpenLinkResult } from '../main/scout-ipc'
import type { WidgetReadResult } from '../main/widget-ipc'
import type { WidgetChoices, WidgetDropResult } from '../main/widget-insert'
import type { FolioPlace } from '../shared/folio-place'
export type { FolioPlace } from '../shared/folio-place'
import type { FolioOutline } from '../shared/folio-outline'
import type { RunningOrderResult } from '../shared/folio-running-order'
export type { RunningOrderResult } from '../shared/folio-running-order'
export type { FolioOutline, FolioOutlineFile, FolioOutlineHeading } from '../shared/folio-outline'
import { RENAME_REPAIR_ISSUE_KINDS } from '../shared/rename-repair-message'
import type { BoardStatus } from '../shared/collection-status'
import type { ClipboardKind } from '../main/clipboard'
import type { ExportFormat, ExportOutcome, HtmlExportOptions } from '../main/export'
import type { ExplicitSessionState } from '../shared/explicit-session'
import type { AgentNote, AgentObjectNote, AgentProseNote } from '../main/agent-notes'
import type { CollectionDigest } from '../main/digest'
import type { DrawerScrap, DrawerSource, Offcut, PieceDrawer, SourceUser } from '../main/piece-material'
import type { ExportPresetSettings } from '../shared/export-presets'
import type { PlanAcceptEdits, PlanAcceptResult, PlanProposalView, PlanUndoResult } from '../shared/plan-proposal'
import type { PieceSourceListing } from '../shared/piece-sources'
import type { AppendScrapInput, AttachSourceInput, BoardStepResult, BoardUndoResult, PromoteOffcutInput } from '../shared/board-material'
export type { PlanAcceptEdits, PlanAcceptResult, PlanProposalView, PlanUndoResult }
export type { BoardStep, BoardStepResult, BoardUndoResult } from '../shared/board-material'

export type { ClipboardKind, ExportFormat, ExportOutcome, HtmlExportOptions, ExplicitSessionState }
export type { AgentNote, AgentObjectNote, AgentProseNote, CollectionDigest }
export type { ExportPresetSettings }
/** What the sheet is exporting: this piece, or the Collection it sits in (ADR-0029). */
export type ExportChoice =
  | { scope: 'piece'; path: string; format: ExportFormat }
  | { scope: 'collection'; dir: string; format: ExportFormat }
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
export type FileSaveResult = FileReadResult | FileSaveRefusal
export type ClearDocumentResult = { file: FileReadResult; rescueDirectory: string | null }
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
export type StartScreenModel = { example: ExampleCollectionView | null; pinned: PinnedWorkspace[]; recents: RecentWorkspace[] }

export type JumpKind = 'bookmark' | 'comment' | 'task'
export type JumpEntry = { kind: JumpKind; file: string; line: number; text: string; done?: boolean }
/** A folder-scope scan result: a jump OR an ATX heading (Task 10). File scope returns only jumps. */
export type OutlineScanEntry =
  | JumpEntry
  | { kind: 'heading'; file: string; line: number; text: string; level: number }

/** A file-native cutting (Task 20, ADR-0008). `origin` is the group label (the source doc's
 *  basename); `expandTrigger`, when set, is the `{trigger}` that expands the body in the editor. */
export type Scrap = { id: string; origin: string; text: string; done: boolean; colour?: string; expandTrigger?: string }

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
  bare: boolean
  provenance: { title: 'written' | 'derived'; purpose: 'written' | 'derived'; status: 'written' | 'derived' }
  folderPath?: string
  folderPieceMode?: 'one' | 'many'
}
export type Collection = { name: string; cover: CollectionCover | null; rows: CollectionRow[] }
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
export type FolioLeftOut = { path: string; reason: 'not-found' | 'outside-folio' }
/** A Folio's listed entries, resolved by main: the pieces in order, and the entries left out. */
export type FolioPieces = { pieces: string[]; leftOut: FolioLeftOut[] }
export type PlanPart = { title: string; gloss: string | null; role: string; tags: string[]; path: string | null; line: number; manifestBacked?: boolean }
export type Plan = { dir: string; indexPath: string; headingLine: number; parts: PlanPart[]; unlisted: PlanPart[] }
export type PlanPartInput = { title: string; gloss?: string; role?: string }

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
export type Change = {
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
   *  path and full content, shown in the Review pane; main writes only bytes that hash to `sha256`. */
  newFile?: { path: string; content: string; sha256: string }
}
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
  | 'zotero-is-open'
  | 'schema-drift'
  | 'schema-unreadable'
  | 'library-missing'
export type ReadingRoomKeptLocal = {
  code: 'unsupported-position'
  count: number
  created: boolean
  reason: string
}
/**
 * What came back from an attempt to hand highlights to Zotero.
 *
 * `notWritten` is the sentence for a person — *"Close Zotero and this highlight will be saved to your
 * library."* — and it is the whole point of this shape: ADR-0036 records that the renderer used to
 * discard it, so a refused write was invisible. `notWrittenCode` names the cause, so a surface can say
 * *why* without reading the sentence for keywords.
 */
export type ReadingRoomWriteResult = {
  waiting: number
  rejected: number
  keptLocal?: ReadingRoomKeptLocal
  notWritten?: string
  notWrittenCode?: ReadingRoomWriteRefusal
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

export type MenuAction = 'save' | 'name-version' | 'new-file' | 'new-folder' | 'capture-idea' | 'follow-wikilink' | 'materialise-stub' | 'close-tab' | 'quick-open' | 'command-palette' | 'open-files' | 'open-tabs' | 'open-board' | 'next-tab' | 'previous-tab' | 'next-folder-file' | 'previous-folder-file' | 'search' | 'archive-search' | 'toggle-outline' | 'open-review' | 'open-versions' | 'toggle-typewriter' | 'open-dialog' | 'redo' | 'prose-zoom-in' | 'prose-zoom-out' | 'prose-zoom-reset' | 'column-width-in' | 'column-width-out'

export type RuntimeInfo = { electron: string; chrome: string; node: string; macOS: string }

export type WriteFlexApi = {
  /** Persist an uncaught renderer failure in the main-owned bounded diagnostics log. */
  reportRendererError: (error: { message: string; stack: string; url: string }) => Promise<void>
  /** Reload this webContents after the renderer fallback has protected the window. */
  reloadRenderer: () => Promise<void>
  /** Keep Mission Control/window-switcher identity in sync with the renderer's document label. */
  setWindowTitle: (title: string) => Promise<void>
  /** Static preload-time fence used only to install the renderer's forced-crash e2e hook. */
  e2eEnabled: boolean
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
  chooseExportTarget: (input: ExportChoice) => Promise<{ target: string | null; name: string }>
  exportDocument: (input: { path: string; format: ExportFormat; target: string; html?: HtmlExportOptions }) => Promise<ExportOutcome>
  exportBundle: (input: { dir: string; format: ExportFormat; target: string; html?: HtmlExportOptions }) => Promise<ExportOutcome>
  revealExport: () => Promise<void>
  /** Named export presets live in userData/settings.json; last-used choices remain workspace-scoped renderer state. */
  getExportPresetSettings: () => Promise<ExportPresetSettings>
  setExportPresetSettings: (settings: ExportPresetSettings) => Promise<ExportPresetSettings>
  openDialog: (droppedPath?: string) => Promise<WorkspaceState | null>
  getWorkspace: () => Promise<WorkspaceState>
  /** Every checklist note's progress, read from main's search content cache (no file is read twice). */
  getChecklistProgress: () => Promise<ChecklistProgress[]>
  getRecents: () => Promise<RecentWorkspace[]>
  openRecent: (root: string, options?: { newWindow?: boolean }) => Promise<void>
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
  /** widget-frame tells main whether one of the window's widgets is engaged (keys may go to it): by a press
   *  inside it, by the keyboard, or none. Main may refuse a press claim it cannot verify. */
  setWidgetKeyboardOwner: (claim: { engaged: false } | { engaged: true; how: 'press'; frame: string; sinceParentPressMs: number } | { engaged: true; how: 'keyboard'; frame: string }) => Promise<{ accepted: boolean }>
  /** Frontmatter organ (Task 22): parse a file's leading YAML frontmatter, or null when it is bare.
   *  Read-only by design — frontmatter is never auto-inserted (ADR-0008). */
  readFrontmatter: (path: string) => Promise<Frontmatter | null>
  /** Writing goal (Round A T5): the writer's own direct `goal:`/`due:` frontmatter write — the
   *  ADR-0019 capture path, never the staged agent capability. `target: null` clears both keys.
   *  Returns the rewritten file so the renderer can reconcile the open buffer. */
  setGoal: (path: string, target: number | null, due: string | null) => Promise<FileReadResult>
  /** Tier 1 (ADR-0013): write the buffer to disk. Auto-save calls this continuously; it never snapshots
   *  — history is made by checkpoint() and agent turns. */
  saveFile: (path: string, content: string) => Promise<FileSaveResult>
  /** Deliberate emptying path for ADR-0031: main asks for confirmation before bypassing the guard.
   *  A non-empty document is rescued before the question is shown; null means the writer cancelled. */
  clearDocument: (path: string) => Promise<ClearDocumentResult | null>
  /** Tier 2 (ADR-0013): checkpoint a file's on-disk state as a returnable point (the git *commit*).
   *  `auto: true` marks an app-made close-checkpoint (gated by the "checkpoint on close" setting); a ⌘S
   *  checkpoint passes no `auto` and always fires. */
  checkpoint: (path: string, opts?: { auto?: boolean }) => Promise<void>
  /** User file management (ADR-0017): typed names kept faithfully; deletes are OS-Trash only. */
  createFile: (name: string, directory?: string) => Promise<FileReadResult>
  planFileRename: (path: string, newName: string, directory?: string | null) => Promise<FileRenamePlan>
  renameFile: (path: string, newPath: string) => Promise<RenameFileResult>
  moveFile: (path: string, newPath: string) => Promise<RenameFileResult>
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
  /** Change Ledger (Task 2, ADR-0010/0011): the review-and-learn store. Every mutation pushes
   *  `changes:changed` (onChangesChanged) so the dock re-lists over `.writeflex/changes.jsonl`. */
  listChanges: (scope?: ChangeScope) => Promise<Change[]>
  addChange: (input: NewChange) => Promise<Change>
  updateWriterChange: (id: string, input: NewChange) => Promise<Change>
  setChangeStatus: (id: string, status: ChangeStatus) => Promise<Change>
  classifyChange: (id: string, editClass: EditClass) => Promise<Change>
  /** Accept/Reject a change from the dock — routed through the live suggestion (disk write) when one
   *  exists, else a direct status move or stored-diff replay. `applied` is false when it could NOT resolve
   *  honestly. Accept may return the rewritten file so the renderer can reconcile a fallback apply. */
  resolveChange: (id: string, action: 'accept' | 'reject') => Promise<{ applied: boolean; file?: FileReadResult; message?: string }>
  /** Save version (ADR-0014/C6): snapshot the explicit accepted/rejected state without auto-accepting
   *  undecided pending changes; pending proposals persist for a future version. */
  saveChangeVersion: (input: { path: string; changeIds: string[]; name: string; note?: string }) => Promise<{ versionId: string; snapshotId: string; record: Version; accepted: number; rejected: number; pending: number; corpusEntries: number }>
  /** Version spine (ADR-0016 V1): named, authored version records over `.writeflex/versions.jsonl`. */
  listVersions: (scope?: VersionScope) => Promise<Version[]>
  /** Rename a Version by appending a newer record with the same stable id. */
  renameVersion: (id: string, name: string) => Promise<Version>
  /** Read a document exactly as it was at a named Version's file-snapshot entry. Missing snapshots return null content. */
  versionContent: (input: VersionContentRequest) => Promise<VersionContentResult | null>
  /** Compare two named versions, or a named version and Working, as content diff hunks with ledger attribution. */
  compareVersions: (input: { path: string; fromId: VersionCompareEndpointId; toId: VersionCompareEndpointId; currentContent?: string }) => Promise<VersionCompareResult>
  /** Restore a Version into the live document through main-owned writes and tier-2 checkpoints. */
  restoreVersion: (input: VersionContentRequest & { currentContent?: string }) => Promise<FileReadResult | null>
  /** Collections (Task 23): read a folder as a browsable table of its pieces under an Index-Note cover.
   *  `dir` is workspace-relative ('' = the workspace root). Read-only. */
  listCollection: (dir: string) => Promise<Collection>
  /** The 0.6 Collection spine. All projections call this one read-only main-process engine. */
  collection: {
    status: (dir: string) => Promise<CollectionStatus>
    pattern: (dir: string) => Promise<CollectionPattern>
    query: (dir: string, source: string) => Promise<QueryResult>
    unresolvedFolderPieces: (dir: string) => Promise<UnresolvedFolderPiece[]>
    /** Board move: app-owned frontmatter status write; main emits collection invalidation. */
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
  /** The Outline's Folio part: the Folio of this file with its pieces and the folder's other files, with headings. Read-only. */
  readFolioOutline: (path: string) => Promise<FolioOutline | null>
  /** The Outline's running-order changes. Pieces are named by path, with the running order the caller saw
   *  (`expected`); main refuses, writing nothing, when that is no longer the running order. */
  folioRunningOrder: {
    movePiece: (dir: string, path: string, beforePath: string | null, expected: string[]) => Promise<RunningOrderResult>
    addPieces: (dir: string, paths: string[], expected: string[]) => Promise<RunningOrderResult>
    removeAdded: (dir: string, paths: string[], expected: string[]) => Promise<RunningOrderResult>
  }
  /** Tab groups (direction D): each workspace-relative path's group folder — nearest Folio, else
   *  nearest Index Note folder, else its own folder ('' = root). Read-only; nothing is stored. */
  resolveTabGroups: (paths: string[]) => Promise<Record<string, string>>
  /** Make Folio: draft + (after a native confirm) write the manifest; returns its path, or null if the
   *  writer cancels. Errors if a manifest already exists. Pushes `collection:changed`. */
  makeFolio: (dir: string) => Promise<string | null>
  plan: {
    read: (dir: string) => Promise<Plan | null>
    adoptPart: (dir: string, unlistedIndex: number) => Promise<Plan>
    insertPart: (dir: string, at: number, part: PlanPartInput) => Promise<Plan>
    movePart: (dir: string, from: number, to: number) => Promise<Plan>
    removePart: (dir: string, index: number) => Promise<Plan>
    materialisePart: (dir: string, index: number) => Promise<{ plan: Plan; path: string }>
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
    searchShelf: (query: string) => Promise<ShelfSearchResult>
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
     * `notWritten` carries the plain reason when Zotero would not take it ("Close Zotero and…").
     */
    saveAnnotations: (input: {
      operation: 'create' | 'update'
      annotations: unknown[]
    }) => Promise<ReadingRoomWriteResult & { queued: number }>
    /**
     * Hand Zotero whatever is still owed to it (ADR-0036, decision 2), without making a highlight
     * first. Called when the Room opens and when a document opens, so a mark refused earlier stops
     * waiting for the next highlight to be made. A no-op when nothing is waiting.
     */
    drainOutbox: () => Promise<ReadingRoomWriteResult>
    /** Drainable and permanently rejected highlights, counted separately in main. */
    outboxCounts: () => Promise<ReadingRoomOutboxCounts>
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
    }) => Promise<void>
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
  /** A Collection write landed (New piece / create Index Note): refresh the tree and the open view. */
  onCollectionChanged: (fn: () => void) => () => void
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
  setWindowTitle: (title) => ipcRenderer.invoke('window:set-title', title),
  e2eEnabled: process.env.WRITEFLEX_E2E === '1',
  e2eCollectionQueryCount: () => collectionQueryCount,
  resetE2eCollectionQueryCount: () => { collectionQueryCount = 0 },
  clipboardText: () => clipboard.readText(),
  copyToClipboard: (markdown, kind, path) => ipcRenderer.invoke('clipboard:copy', { markdown, kind, path }),
  chooseExportTarget: (input) => ipcRenderer.invoke('export:choose', input),
  exportDocument: (input) => ipcRenderer.invoke('export:document', input),
  exportBundle: (input) => ipcRenderer.invoke('export:bundle', input),
  revealExport: () => ipcRenderer.invoke('export:reveal'),
  getExportPresetSettings: () => ipcRenderer.invoke('export-presets:get'),
  setExportPresetSettings: (settings) => ipcRenderer.invoke('export-presets:set', settings),
  openDialog: (droppedPath) => ipcRenderer.invoke('workspace:open-dialog', droppedPath),
  getWorkspace: () => ipcRenderer.invoke('workspace:get'),
  getChecklistProgress: () => ipcRenderer.invoke('workspace:checklist-progress'),
  getRecents: () => ipcRenderer.invoke('workspace:recents'),
  openRecent: (root, options) => ipcRenderer.invoke('workspace:open-recent', root, options),
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
  readFrontmatter: (path) => ipcRenderer.invoke('frontmatter:read', path),
  setGoal: (path, target, due) => ipcRenderer.invoke('goal:set', { path, target, due }),
  saveFile: (path, content) => ipcRenderer.invoke('file:save', { path, content }),
  clearDocument: (path) => ipcRenderer.invoke('file:clear', { path }),
  checkpoint: (path, opts) => ipcRenderer.invoke('snapshot:checkpoint', { path, ...(opts?.auto ? { auto: true } : {}) }),
  createFile: (name, directory) => ipcRenderer.invoke('file:create', { name, directory }),
  planFileRename: (path, newName, directory) => ipcRenderer
    .invoke('file:rename-repair-paths', { path, newName, directory })
    .then(validateFileRenamePlan),
  renameFile: (path, newPath) => ipcRenderer.invoke('file:rename', { path, newPath }).then(validateFileRenameResult),
  moveFile: (path, newPath) => ipcRenderer.invoke('file:move', { path, newPath }).then(validateFileRenameResult),
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
  listChanges: (scope) => ipcRenderer.invoke('changes:list', scope),
  addChange: (input) => ipcRenderer.invoke('changes:add', input),
  updateWriterChange: (id, input) => ipcRenderer.invoke('changes:update-writer', { id, input }),
  setChangeStatus: (id, status) => ipcRenderer.invoke('changes:set-status', { id, status }),
  classifyChange: (id, editClass) => ipcRenderer.invoke('changes:classify', { id, editClass }),
  resolveChange: (id, action) => ipcRenderer.invoke('changes:resolve', { id, action }),
  saveChangeVersion: (input) => ipcRenderer.invoke('changes:save-version', input),
  listVersions: (scope) => ipcRenderer.invoke('versions:list', scope),
  renameVersion: (id, name) => ipcRenderer.invoke('versions:rename', { id, name }),
  versionContent: (input) => ipcRenderer.invoke('versions:content', input),
  compareVersions: (input) => ipcRenderer.invoke('versions:compare', input),
  restoreVersion: (input) => ipcRenderer.invoke('versions:restore', input),
  listCollection: (dir) => ipcRenderer.invoke('collection:list', { dir }),
  collection: {
    status: (dir) => ipcRenderer.invoke('collection:status', { dir }),
    pattern: (dir) => ipcRenderer.invoke('collection:pattern', { dir }),
    query: queryCollection,
    unresolvedFolderPieces: (dir) => ipcRenderer.invoke('collection:unresolved-folder-pieces', { dir }),
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
  readFolioOutline: (path) => ipcRenderer.invoke('folio:outline', { path }),
  folioRunningOrder: {
    movePiece: (dir, path, beforePath, expected) => ipcRenderer.invoke('folio:move-piece', { dir, path, beforePath, expected }),
    addPieces: (dir, paths, expected) => ipcRenderer.invoke('folio:add-pieces', { dir, paths, expected }),
    removeAdded: (dir, paths, expected) => ipcRenderer.invoke('folio:remove-added', { dir, paths, expected }),
  },
  resolveTabGroups: (paths) => ipcRenderer.invoke('tabs:groups', { paths }),
  makeFolio: (dir) => ipcRenderer.invoke('folio:create', { dir }),
  plan: {
    read: (dir) => ipcRenderer.invoke('plan:read', { dir }),
    adoptPart: (dir, unlistedIndex) => ipcRenderer.invoke('plan:adopt-part', { dir, unlistedIndex }),
    insertPart: (dir, at, part) => ipcRenderer.invoke('plan:insert-part', { dir, at, part }),
    movePart: (dir, from, to) => ipcRenderer.invoke('plan:move-part', { dir, from, to }),
    removePart: (dir, index) => ipcRenderer.invoke('plan:remove-part', { dir, index }),
    materialisePart: (dir, index) => ipcRenderer.invoke('plan:materialise-part', { dir, index }),
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
  restoreLastTurn: () => ipcRenderer.invoke('agent:restore-last-turn'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key, value, label, opts) => ipcRenderer.invoke('settings:set', { key, value, label, ...(opts?.log === false ? { log: false } : {}) }),
  getSettingsChangelog: () => ipcRenderer.invoke('settings:changelog'),
  revertSetting: (index) => ipcRenderer.invoke('settings:revert', index),
  onSettingChanged: subscribeSettingChanged,
  readingRoom: {
    getState: (draftPath) => ipcRenderer.invoke('reading-room:get-state', draftPath),
    recentDocuments: () => ipcRenderer.invoke('reading-room:recent-documents'),
    searchShelf: (query) => ipcRenderer.invoke('reading-room:search-shelf', query),
    openShelfItem: (input) => ipcRenderer.invoke('reading-room:open-shelf-item', input),
    readHighlights: () => ipcRenderer.invoke('reading-room:read-highlights'),
    citeSelection: (input) => ipcRenderer.invoke('reading-room:cite-selection', input),
    beginAreaQuotation: (input) => ipcRenderer.invoke('reading-room:begin-area-quotation', input),
    recordAreaQuotation: (input) => ipcRenderer.invoke('reading-room:record-area-quotation', input),
    saveAnnotations: (input) => ipcRenderer.invoke('reading-room:save-annotations', input),
    drainOutbox: () => ipcRenderer.invoke('reading-room:drain-outbox'),
    outboxCounts: () => ipcRenderer.invoke('reading-room:outbox-counts'),
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
  openWriteflexLink: (url) => ipcRenderer.invoke('links:open-writeflex', url),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  getRuntimeInfo: () => ipcRenderer.invoke('app:runtime-info'),
  stubAgentTurn: (steps, reply) => ipcRenderer.invoke('agent:stub', steps, reply),
  closeWindow: (options) => ipcRenderer.invoke('window:close', options?.checkpoint ? { checkpoint: options.checkpoint } : undefined),
  closeUnsaved: () => ipcRenderer.invoke('window:close-unsaved'),
  cancelClose: () => ipcRenderer.invoke('window:cancel-close'),
  acknowledgeClose: () => ipcRenderer.invoke('window:close-ack'),
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
  onCollectionChanged: on('collection:changed'),
  onDiaryError: on('diary:error'),
  onFileChangedOnDisk: on('file:changed-on-disk')
}

contextBridge.exposeInMainWorld('writeflex', api)

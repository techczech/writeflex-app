import { createNoticeTimer } from './notice-timer'
import { ROOM_ON_SCREEN_EVENT, roomOnScreen } from '../plan/room-on-screen'
import { flushRoomPending } from '../folio-room-pending'
import { addCollectionBatchToFolio, runCollectionBatch } from './collection-bulk'
import { setPieceStatusFlushed } from './piece-status'
import { COLLECTION_PAGE_COMMANDS, collectionPageMenuCommand, dispatchCollectionPageCommand } from '../components/collection-page-commands'
import { flushUntilClean, type CloseFlushResult } from './close-flush'
import { researchCaptureTarget } from './research-capture-target'
import { reportRendererError } from './RendererErrorBoundary'
import { closeWindowIfClean, closeWithEditor, editorIsPresent, queueCloseRetry, setEditorPresent, setSaveBasisSource, takeCloseRetry, unsaved } from './unsaved-text'
import { acceptThroughOwner as acceptRoute, replayAcceptRedo, resolveProposalThroughOwner, type AcceptAnswer, type AcceptRouteResult } from './resolution-routes'
import { createDocumentOwner, type DocumentOwner, type MainWriteOutcome, type OutsideOutcome, type Snapshot } from './document-owner'
import { documentsUnder as documentsUnderFrom, folderPrefix, renameMembers } from './documents-under'
import { useAmbientSnapshot } from '../hooks/useAmbientSnapshot'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Transaction, type StateCommand } from '@codemirror/state'
import type { Command as EditorViewCommand } from '@codemirror/view'
import { isolateHistory, redo, undo, undoDepth } from '@codemirror/commands'
import type { AgentObjectNote, AttributedChange, Change, CollectionTarget, ExplicitSessionState, FileReadResult, ProseEditInput, RenameFileResult, Scrap, SearchMatch, SettingValue, ShelfRow, SkillMeta, Suggestion, ThreadRunComplete, Version, VersionCompareEndpointId, VersionCompareResult } from '../../../preload'
import type { ClipboardKind, FileRenamePlan } from '../../../preload'
import type { ReadingRoomWriteRefusal, ReadingRoomWriteResult } from '../../../preload'
import { createOutboxSyncRunner, outboxResultAnnouncement } from '../reading-room-sync'
import { applyReadingRoomSetting } from '../reading-room-settings'
import { humanReadableError } from '../error-text'
import {
  AlignCenterVertical,
  Anchor,
  AudioLines,
  BookOpen,
  Bold,
  Bot,
  CaseLower,
  CaseSensitive,
  CaseUpper,
  Check,
  ClipboardCopy,
  ClipboardType,
  ChevronsDownUp,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUpDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Command,
  CornerUpLeft,
  CopyPlus,
  RemoveFormatting,
  Code,
  Download,
  Eraser,
  Focus,
  FileCode,
  FilePlus2,
  FoldVertical,
  FolderTree,
  Folder,
  Files as FilesIcon,
  GitCommitHorizontal,
  Heading,
  Highlighter,
  Info,
  Italic,
  Keyboard,
  LayoutPanelLeft,
  Link,
  List,
  ListFilter,
  LayoutGrid,
  ListTree,
  FileText,
  Columns2,
  ListOrdered,
  ListPlus,
  LocateFixed,
  Maximize2,
  Minimize2,
  MessageSquare,
  Minus,
  Moon,
  Pause,
  PanelRightOpen,
  PanelTop,
  Plus,
  GitMerge,
  RefreshCw,
  Quote,
  RotateCcw,
  Save,
  Scan,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquarePen,
  Star,
  StickyNote,
  Sun,
  Target,
  Timer,
  Text,
  TextCursorInput,
  TriangleAlert,
  Volume2,
  X,
  Glasses,
  Lightbulb,
  Library,
  Undo2,
  ArrowUp,
  ArrowDown,
  Pin,
  PinOff,
  type LucideIcon,
  Compass,
  AppWindow,
  FolderOpen,
  Rows3,
  Send,
  History,
  Pencil,
  BookOpenCheck,
} from 'lucide-react'
import { documentIdentityLabel, Toolbar } from '../components/Toolbar'
import { ActionBar } from '../components/ActionBar'
import { filesHeaderSummary } from '../components/files-header-summary'
import { AGENT_ICON } from '../components/agent-icon'
import { DEFAULT_ACTION_BAR_ITEMS, resolveActionBarItems, type RunnableCommand } from '../components/action-bar-commands'
import { ActionBarConfigureSheet } from '../components/ActionBarConfigureSheet'
import { configureCommands, type ConfigureCommand } from '../components/action-bar-configure'
import {
  ACTION_BAR_ITEMS_KEY,
  ACTION_BAR_ITEMS_LABEL,
  ACTION_BAR_VISIBLE_KEY,
  ACTION_BAR_VISIBLE_LABEL,
  actionBarItemsFrom,
  actionBarVisibleFrom,
  serialiseActionBarItems,
} from '../../../shared/action-bar-settings'
import { StatusBar } from '../components/StatusBar'
import type { ReviewAsk } from '../components/ReviewBulkPopovers'
import { FocusPicker } from '../components/FocusPicker'
import { applyLineOverlaySetting, DEFAULT_LINE_OVERLAY, LINE_OVERLAY_SETTINGS, RULER_OPACITY_STEP, normaliseRulerOpacity, resolveExclusive, type LineOverlayConfig, type RulerCovers, type LineFocusSize } from '../editor/line-overlay'
import { SessionStarter } from '../components/SessionStarter'
import { ReadAloudBar } from '../components/ReadAloudBar'
import { ReadingRoom, type ReaderSelection } from '../components/ReadingRoom'
import { effectiveFocusMode, FOCUS_CHIP_NAMES, normaliseFocusMode, normaliseLeadStyle, type FocusMode, type LeadStyle } from '../editor/focus-modes'
import { resolveChangeRange } from '../editor/change-marks'
import { jumpToBlock } from '../editor/live-preview'
import { noteDocumentInteraction, noteFileOpened, OUTLINE_SWITCH_IDLE, folioSidebarLayout, type OpenSource, type OutlineSwitchState } from './outline-switch'
import { askFolioPlace } from './folio-place-request'
import { useFolioRunningOrder, type FlashAction } from './folio-running-order'
import { planDirFor } from './plan-dir'
import { changedOnDiskMessage, inFolioFolder, saveQueuedBehindFolioWriteMayRun, writeFolioThroughSaveQueue } from '../../../shared/folio-write-preparation'
import { ORDER_IN_PLAN_LINE, blockCommandTarget, commandTarget, type FocusedFolioRow } from '../../../shared/folio-running-order'
import { createPlayer, normaliseReadAloudRate, type Player, type PlayerState } from '../editor/read-aloud-player'
import { normaliseReadAloudScrollMode, type ReadAloudScrollMode } from '../editor/read-aloud'
import {
  DEFAULT_READ_ALOUD_COLOUR,
  DEFAULT_READ_ALOUD_STRENGTH,
  READ_ALOUD_COLOUR_SETTING,
  READ_ALOUD_PRESETS,
  READ_ALOUD_STRENGTH_SETTING,
  applyReadAloudTokens,
  normaliseReadAloudColour,
  normaliseReadAloudStrength,
  type ReadAloudPreset,
  type ReadAloudStrength,
} from '../editor/read-aloud-colours'
import {
  FIXED_LINE_DEFAULT,
  FIXED_LINE_PRESETS,
  FIXED_LINE_PRESET_LABELS,
  FIXED_LINE_SETTING,
  normaliseFixedLine,
} from '../editor/fixed-line'
import type { PendingChange, SpeakableOptions } from '../editor/speakable'
import {
  fakeSpeechEngine,
  resolveReadAloudVoice,
  webSpeechEngine,
  type SpeechEngine,
  type SpeechVoiceInfo,
} from '../editor/speech-engine'
import {
  pauseReadAloudForDocumentChange,
  runPauseResumeReadAloud,
} from './read-aloud-controls'
import { clampVolume, normaliseTypingScheme, SoundEngine, type AmbientLoop, type TypingScheme } from './sounds'
import { documentTitle, parseFrontmatter, parseGoal } from '../../../main/frontmatter'
import { formatRenameRepairMessage } from '../../../shared/rename-repair-message'
import { isTextChange } from '../../../shared/line-endings'
import { OBJECTS_LESSON } from '../../../shared/example-files'
import { countUnits, countWords } from '../editor/word-count'
import { DocumentFind, type FindStatus } from '../components/DocumentFind'
import { TabBar } from '../components/TabBar'
import { Sidebar, type SidebarFileOps, type SidebarFocusedRow, type SidebarTreeFocusRequest } from '../components/Sidebar'
import SearchPanel from '../components/SearchPanel'
import ArchiveSearchDock from '../components/ArchiveSearchDock'
import { archiveLinkInsert, archiveQuoteInsert, insertedRange } from '../editor/archive-insert'
import type { ArchiveResult } from '../../../shared/scout'
import { RemoveExampleConfirm, REMOVE_EXAMPLE_TEXT } from '../components/RemoveExampleConfirm'
import { DiskMergeSheet } from '../components/DiskMergeSheet'
import { applyDiskMerge, beginDiskMerge, diskMergeMessage, offersMerge, type DiskMergeSession } from './disk-merge'
import type { ConflictPick } from '../../../shared/three-way-merge'
import { StartScreen } from '../components/StartScreen'
import { WorkspaceEmpty } from '../components/WorkspaceEmpty'
import { EditorPane, type EditorHandle } from '../components/EditorPane'
import { readPreferredView, type MarginControl } from '../components/ReviewMargin'
import { readTextRoom, setPreferredView, usePreferredView, useTextRoom } from './margin-view-store'
import { effectiveMarginView, marginFits } from './margin-geometry'
import { citationChip, citationForReaderText } from '../editor/citation'
import { CollectionView } from '../components/CollectionView'
import { SharingSetup } from '../components/sharing/SharingSetup'
import { SharingPage } from '../components/sharing/SharingPage'
import { SharesList } from '../components/sharing/SharesList'
import type { PieceSharingView, ShareMark } from '../../../shared/sharing-links'
import { MakeVaultSheet } from '../components/MakeVaultSheet'
import { useVaultPresence } from '../hooks/useVaultPresence'
import { useVaultSidebarPrefs } from '../hooks/useVaultSidebarPrefs'
import type { SwitcherChoice } from '../components/VaultSwitcherMenu'
import { SWITCH_CLOSE_TIMED_OUT_MESSAGE, switchStayedMessage, type CloseKept, type RootSwitchTarget } from '../../../shared/vault-switcher'
import { runAsPlanShortcut, dispatchPlanCommand, type PlanCommandName } from '../plan/plan-commands'
import { dispatchBoardCommand } from '../components/board-commands'
import { PieceSourcesPopover } from '../components/PieceSources'
import { Board } from '../components/Board'
import { Rail, type QueryInsertionContext } from '../components/Rail'
import { InsertQueryConfirm } from '../components/InsertQueryConfirm'
import { folioOpenTarget, readFolioOpenParts } from '../components/FolioOpenButton'
import { ROOM_VIEW_EVENT } from '../components/FolioRoom'
import { ROOM_VIEWS, WORKSPACE_TAB_CHORDS } from '../../../shared/folio-room'
import { folderIsFolio } from './folio-routing'
import { dispatchSidebar } from '../plan/folio-sidebar'
import { exportPlaceFor } from './export-collection-dir'
import { OutlinePane, type OutlineRequest } from '../components/OutlinePane'
import { RoomBinderSwitch } from '../components/RoomBinderPane'
import { CommandPalette, type AppCommand } from '../components/CommandPalette'
import { WidgetPicker } from '../components/WidgetPicker'
import { StandardWidgetWorkbench, type WorkbenchStep } from '../components/StandardWidgetWorkbench'
import { embedTarget, undoesWidgetCreate } from '../widgets/standard-widget-model'
import { EDIT_STANDARD_WIDGET_EVENT } from '../widgets/widget-block'
import { insertWidgetLine } from '../editor/insert-widget'
import { ActionsHereContext, type ActionsHereApi } from '../components/ActionsHere'
import { FolderPieceChooser, type FolderPieceChoice } from '../components/FolderPieceChooser'
import { AgentPanel, type AgentActionRequest, type AgentConfigurationRequest, type ComposerRequest } from '../components/AgentPanel'
import { AgentNotes } from '../components/AgentNotes'
import { SkillCompletionToast, orderSkills, skillDisplayName, type SkillToast } from '../components/AgentSkillSurfaces'
import { REPORT_SKILL, REPORT_SKILL_COMMAND, skillLaunchTarget } from '../plan/report-skill'
import { SkillsManager, SkillProvenanceBelt, activeSkillForPath } from '../components/SkillsManager'
import { SourcesSection } from '../components/SourcesSection'
import { ScratchpadHost, type ScratchpadHostApi } from '../scratchpad/ScratchpadHost'
import { isLosslessItemId as isLosslessScrapId } from '../../../shared/scratchpad-items'
import { VersionsPane } from '../components/VersionsPane'
import { summariseRun } from '../../../engine'
import { ComparePane } from '../components/ComparePane'
import { compareHighlightsForEditor, compareToColumnMode, shouldRefreshWorkingCompare } from '../components/compare-live'
import { SuggestionCallout, type CalloutViewRequest } from '../components/SuggestionCallout'
import { SettingsWindow } from '../components/SettingsWindow'
import { classifyExternalDrop, type DroppedPath } from '../external-drop'
import { CheatSheet } from '../components/CheatSheet'
import { ExportSheet, type ExportPresetOpenAction, type ExportScope, type ExportSheetOutcome } from '../components/ExportSheet'
import type { ExportFormat, FolioLeftOut, FolioPlace, HtmlExportOptions, TocDepthScope, TocDepthSource } from '../../../preload'
import type { ExportTocDepthHome } from '../components/export-sheet-options'
import { tocDepthOf } from '../../../shared/toc-depth'
import { IdeaCapture } from '../components/IdeaCapture'
import { CaptureResearchSheet } from '../components/CaptureResearchSheet'
import { IdeaMaterialise } from '../components/IdeaMaterialise'
import { useAgent } from '../hooks/useAgent'
import { useScraps } from '../hooks/useScraps'
import { useSources } from '../hooks/useSources'
import { useSettings } from '../hooks/useSettings'
import { useWorkspace } from '../hooks/useWorkspace'
import { WidgetStepLeftoverNotice } from '../components/WidgetStepLeftoverNotice'
import { useChecklistProgress } from '../hooks/useChecklistProgress'
import { useStableCallbacks } from '../hooks/useStableCallbacks'
import { useFolderFocus } from '../hooks/useFolderFocus'
import { FocusPathBar } from '../components/FocusPathBar'
import { useTabs } from '../hooks/useTabs'
import { MANIFEST_NAME } from '../../../shared/folio-constants'
import { BOARD_TAB_ID, closeTabIntent, isBoardTabId, isSurfaceTabId, isWidgetWorkbenchTabId, sameTabList, widgetWorkbenchTabId, workbenchDocumentOf } from '../hooks/tab-state'
import { createTargetDirectory, folderBrowsePath, isInFocus } from '../sidebar-tree'
import { useFavourites } from '../hooks/useFavourites'
import { useSession } from '../hooks/useSession'
import type { SessionSummary } from './session-history'
import { useEditorSnapshot } from '../hooks/useEditorSnapshot'
import { paneRowFromElement, pressCommandK, SHOW_PLACE_KEY, usePlace } from '../hooks/usePlace'
import { useOverlayGuard } from '../hooks/useOverlayGuard'
import { commandRegistry, LEDGER_EXCLUDED, registryCommand } from '../commands/registry'
import { commandRan, MENU_ACTION_COMMANDS, onCommandRan } from '../commands/command-ran'
import { placeAt, placeOfRow, type Place } from '../commands/place'
import { askComposerText, askContextAt } from '../commands/ask-context'
import { runThemeCommand } from '../commands/theme-commands'
import { runRefreshModelsCommand } from '../commands/model-refresh-command'
import { APP_DISPATCHED_EDITOR_IDS, parseOverrides, resolveChord, SHORTCUT_OVERRIDES_KEY, shortcutCaptureActive } from '../commands/chords'
import { suggestionAnchors, uniqueRange } from '../editor/suggestion-anchor'
import { flashApplied, minimisedAppliedRange } from '../editor/applied-flash'
import { closeRefusalMessage, diskNoticeRefusalMessage, keepMineWrites, mayWriteUnderDiskNotice, minimalReplace, noticeAfterRefusal, refusalMayReload, removedTabDiscardQuestion, sameDiskNotice, type ExternalDiskNotice } from '../editor/reconcile'
import { basisFromBaseline } from '../../../shared/save-basis'
import { normaliseEditorViewMode, type EditorViewMode } from '../editor/view-mode'
import type { SuggestionResolutionEffect } from '../editor/suggestion-resolution-history'
import { materialiseSeed, type WikilinkRange } from '../editor/wikilinks'
import { useReviewActions } from './review-actions'
import { keepTitleInMetadataOnlySteps, CLOSE_REFUSED_MESSAGE } from './keep-title-in-metadata'
import { buildMarginModel, isUnfiltered, makeAnchorResolver } from './margin-model'
import { myEditsSessionIds, reviewModeOf, toggleMode, trackWaitingAgain, withMode, type ReviewMode } from './margin-mode'
import { kindSegmentOf, shownIds, withKindSegment, withoutKinds, type KindSegment } from './margin-filter'
import { reviewLine, reviewLineCompact } from '../components/status-bar-model'
import { countMenu, viewCountsOf, whoChipLabel, withoutWho, type CountMenuAction } from './margin-count-menu'
import { batchProgress, bulkTargets, declineQuestion, EMPTY_BATCH, nextBatch, runTargets, sendBackScope, visibleSelection, waitingEditIds, type DeclineQuestion, type ReviewBatch, type SendBackScope } from './margin-bulk'
import { EMPTY_HEAD_FILTER, type HeadFilterState } from './margin-head-state'
import { useDismissedNotApplied, useOutsideDock } from './outside-dock'
import { useOutsideSourceBulk } from './use-outside-source-bulk'
import { reviseSuggestionWithWarning } from './revise-suggestion'
import { findLiveSuggestionForChange } from './change-suggestion-match'
import { ReviewCursor, owedReveal } from './review-cursor'
import { guideNeedsRoom, rightPaneTabsFor, usePaneLayout } from './pane-layout'
import { RightPaneTabs } from '../components/RightPaneTabs'
import { GuidePane } from '../components/GuidePane'
import { useGuideConnectionSources } from '../components/guide-connections-live'
import { GUIDE_PROGRESS_KEY, parseGuideProgress } from '../../../shared/guide-progress'
import {
  acceptWriterSessionChanges,
  revertWriterChangeToActive,
  sendOriginalToScratchpad,
  useWriterMode,
} from './writer-mode'
import {
  enterHistoricalView,
  enterSessionHistoricalView,
  restoreHistoricalView,
  returnToCurrent,
  sessionRecallKind,
  type HistoricalView,
} from './historical-view'
import { TitleConflictContext, useTitleConflictActions } from './title-conflict-actions'
import { TitleConflictBar } from '../components/TitleConflictBar'
import { titleConflict, titleConflictKey, titleHeadingInsertable, withTitleFixed, type TitleConflict, type TitleFixDirection } from '../../../shared/title-conflict'
import { backspaceChord, canonicalChord, eventToChord, formatShortcutKey, isCheatSheetShortcut, isWriterModeToggleShortcut, skillChordIntent, OPEN_CHEAT_SHEET_EVENT, type ShortcutLike } from './shortcuts'

/** Lucide glyph for each editing command id (paletteCommands carries no icon); Command is the fallback. */
const COMMAND_ICONS: Record<string, LucideIcon> = {
  'edit.bold': Bold,
  'edit.italic': Italic,
  'edit.link': Link,
  'edit.mark': Highlighter,
  'edit.toggleComment': MessageSquare,
  'edit.selectNextOccurrence': TextCursorInput,
  'edit.duplicateLine': CopyPlus,
  'block.duplicate': CopyPlus,
  'edit.inlineCode': Code,
  'edit.clearFormatting': RemoveFormatting,
  'edit.joinLines': FoldVertical,
  'heading.increase': Heading,
  'heading.decrease': Heading,
  'fold.current': ChevronsDownUp,
  'fold.all': ChevronsDownUp,
  'fold.none': ChevronsUpDown,
  'view.typewriter': AlignCenterVertical,
  'text.upperCase': CaseUpper,
  'text.lowerCase': CaseLower,
  'text.titleCase': CaseSensitive,
}

const SHORTCUTS_COMMAND = registryCommand('app.shortcuts')
const NEXT_TAB_COMMAND = registryCommand('navigation.nextTab')
const PREVIOUS_TAB_COMMAND = registryCommand('navigation.previousTab')
const NEXT_PANEL_TAB_COMMAND = registryCommand('navigation.nextPanelTab')
const PREVIOUS_PANEL_TAB_COMMAND = registryCommand('navigation.previousPanelTab')
const NEXT_FOLDER_FILE_COMMAND = registryCommand('navigation.nextFolderFile')
const PREVIOUS_FOLDER_FILE_COMMAND = registryCommand('navigation.previousFolderFile')
const FILTER_FILES_COMMAND = registryCommand('files.filter')
const HIDE_STRIKES_COMMAND = registryCommand('view.hideStrikes')
const HIDE_INSERTS_COMMAND = registryCommand('view.hideInserts')
const OPEN_TABS_COMMAND = registryCommand('view.openTabs')
const OPEN_BOARD_COMMAND = registryCommand('collection.openBoard')
const ACCEPT_SESSION_COMMAND = registryCommand('writer.acceptSession')
const EMPTY_ID_SET: ReadonlySet<string> = new Set()
const REVERT_TO_ACTIVE_COMMAND = registryCommand('change.revertToActive')
const SEND_ORIGINAL_TO_SCRATCHPAD_COMMAND = registryCommand('change.sendOriginalToScratchpad')
const ACTION_BAR_COMMAND = registryCommand('view.actionBar')
const CONFIGURE_ACTION_BAR_COMMAND = registryCommand('view.configureActionBar')
const READING_ROOM_TOGGLE_COMMAND = registryCommand('readingRoom.toggle')
const READING_ROOM_DOCUMENT_COMMAND = registryCommand('readingRoom.document')
const READING_ROOM_HIGHLIGHTS_COMMAND = registryCommand('readingRoom.highlights')
const READING_ROOM_SHELF_COMMAND = registryCommand('readingRoom.searchShelf')
const READING_ROOM_SYNC_COMMAND = registryCommand('readingRoom.syncHighlights')

const INSERT_REFERENCE_COMMAND = registryCommand('citation.insertReference')
const INSERT_WIDGET_COMMAND = registryCommand('insert.widget')
const START_SESSION_COMMAND = registryCommand('session.start')
const END_SESSION_COMMAND = registryCommand('session.end')
const ADJUST_SESSION_TARGET_COMMAND = registryCommand('session.adjustTarget')
const VIEW_MODE_COMMANDS: Record<string, EditorViewMode> = {
  'view.clean': 'clean',
  'view.markup': 'markup',
  'view.raw': 'raw',
}

/** Recently-used palette command ids are stored per workspace root so each Workspace keeps its own. */
const recentsKey = (root: string): string => `wf:cmd-recents:${root}`



/** The Editor settings ladders (Task 17). Prose-size labels apply literally (17/19/21px); the
 *  UNSET default stays the locked 18.5px (tokens.css) — the mockup's select says 19 while its page
 *  renders 18.5, so labels govern explicit choices and the locked value governs untouched (recorded
 *  deviation). Line widths step ±120px around the locked 660px measure (usability review look item). */
const PROSE_SIZES = ['17', '19', '21']
const LINE_WIDTHS = ['narrow', 'medium', 'wide']
const LINE_WIDTH_PX: Record<string, string> = { narrow: '540px', medium: '660px', wide: '780px' }
const LINE_WIDTH_LABEL: Record<string, string> = { narrow: 'Narrow', medium: 'Medium', wide: 'Wide' }
const READ_ALOUD_VOICE_SETTING = 'readAloud.voiceURI'
const READ_ALOUD_RATE_SETTING = 'readAloud.rate'
const READ_ALOUD_SCROLL_MODE_SETTING = 'readAloud.scrollMode'
function versionTimestamp(ts: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts))
}

/**
 * Shell region composition per mockup v4 (ADR-0009): .toolbar (with the document tabs in its
 * tabstrip slot), then .body holding [.sidebar, .outline, .editor-wrap (with .statusbar as its
 * last child — controller ruling: mockup-faithful placement), .agent]. Editor (Task 6), outline
 * (Tasks 8–10) and agent panel (Task 15) are live. Sidebar/outline/agent toggles follow the
 * mockup's .hidden class so the regions stay in the DOM.
 */
/**
 * Agent review surface (usability review course-correction, 2026-07-06): the default is now INLINE track-changes in
 * the prose (editor/inline-changes.ts), with margin callouts disabled by default.
 * The margin callout is GATED here rather than deleted, so it stays a one-line revert / future Settings
 * option; flip to false to bring the popup back.
 */
const INLINE_REVIEW = true
const COMPARE_LIVE_DIFF_DEBOUNCE_MS = 700
/** What the status bar says while a window close waits for its documents to be written. */
const CLOSING_STATUS = 'Saving before closing…'
const CLOSING_STATUS_AFTER_MS = 1000
const STILL_TYPING_STATUS = 'Still saving what you typed — the window stays open'
/** The documents a closing window owes a checkpoint, each once: the ones just written, then the open
 *  ones edited since their last checkpoint, then every other open document (the same set as before
 *  main made them; only the order is new). */
function closeCheckpointOrder(flushed: string[], changed: string[], open: string[]): string[] {
  const isOpen = new Set(open)
  return [...new Set([...flushed, ...changed.filter((path) => isOpen.has(path)), ...open])]
}

/**
 * The Collection a piece belongs to: the nearest ANCESTOR folder the Collection organ recognises as
 * one, else the piece's own folder. Asked by the wikilink resolver and by the Export sheet — which
 * must agree, because the sheet offers a bundle of exactly the Collection the links resolve within.
 */
async function collectionDirFor(path: string): Promise<string> {
  const start = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  const ancestors: string[] = []
  let cursor = start
  for (;;) {
    ancestors.push(cursor)
    if (cursor === '') break
    cursor = cursor.includes('/') ? cursor.slice(0, cursor.lastIndexOf('/')) : ''
  }
  for (const candidate of ancestors) {
    if ((await window.writeflex.collection.status(candidate)).collection) return candidate
  }
  return start
}

/** A Folder Piece is itself a Collection when opened, but the resident status identity names the
 * containing Collection. Find the nearest Folder Piece boundary around the document, then resume
 * the Collection walk above that boundary; the workspace name is the final fallback. */
async function statusBarCollectionDirFor(path: string, resolvedCollectionDir: string): Promise<string> {
  const start = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  let cursor = start
  let folderPieceDir: string | null = null
  while (cursor !== '') {
    const parent = cursor.includes('/') ? cursor.slice(0, cursor.lastIndexOf('/')) : ''
    const population = await window.writeflex.listCollection(parent)
    if (population.rows.some((row) => row.folderPath === cursor && row.folderPieceMode !== 'many')) {
      folderPieceDir = cursor
      break
    }
    cursor = parent
  }
  if (folderPieceDir === null) return resolvedCollectionDir

  cursor = folderPieceDir.includes('/') ? folderPieceDir.slice(0, folderPieceDir.lastIndexOf('/')) : ''
  for (;;) {
    if ((await window.writeflex.collection.status(cursor)).collection) return cursor
    if (cursor === '') return ''
    cursor = cursor.includes('/') ? cursor.slice(0, cursor.lastIndexOf('/')) : ''
  }
}

/** Commands the app chord table dispatches on a modified ⌫ (eventToChord produces no ⌫ chord). */
const BACKSPACE_APP_CHORDS = new Set(['review.declineAll'])

export default function App(): JSX.Element {
  const [readingRoomOpen, setReadingRoomOpen] = useState(false)
  const [readingRoomSide, setReadingRoomSide] = useState<'left' | 'right'>('left')
  // Each bump of this counter raises the Shelf inside the Room and lands the keyboard in its field.
  const [readingRoomShelfRequest, setReadingRoomShelfRequest] = useState(0)
  const [readingRoomHighlightsRequest, setReadingRoomHighlightsRequest] = useState(0)
  const [readingRoomCiteRequest, setReadingRoomCiteRequest] = useState(0)
  /** The last words copied or dragged out of the reader, with the page they came from. A ref, not
   *  state: a paste must read the CURRENT value inside a DOM handler without re-rendering the editor. */
  const readerSelectionRef = useRef<ReaderSelection | null>(null)
  /** Highlights a drain can still move into Zotero. */
  const [outboxWaiting, setOutboxWaiting] = useState(0)
  /** Highlights Zotero has permanently refused or left in conflict. */
  const [outboxRejected, setOutboxRejected] = useState(0)
  /**
   * Zotero's last word on a write it would not take: the sentence for a person and the cause. Null when
   * nothing is outstanding. **ADR-0036: the renderer used to discard this**, so a highlight refused
   * because Zotero was open was queued, painted and completely unannounced.
   */
  const [outboxRefusal, setOutboxRefusal] = useState<
    { reason: string; code: ReadingRoomWriteRefusal | null } | null
  >(null)
  /** The last known pending count, readable from a settled promise: "was something waiting before this
   *  attempt?" is what decides whether a drain has just become news worth telling him. */
  const outboxWaitingRef = useRef(0)
  const outboxAutomaticSyncAttemptsRef = useRef(0)
  const e2eSaveBehaviourRef = useRef<'normal' | 'slow' | 'fail' | 'hold-redo' | 'hold-move' | 'hold-accept' | 'hold-export'>('normal')
  const e2eSavesSentRef = useRef<Array<{ path: string; content: string }>>([])
  const e2eSlowSaveReleaseRef = useRef<(() => void) | null>(null)
  const [sidebarFilterFocusTick, setSidebarFilterFocusTick] = useState(0)
  const [outlineOpen, setOutlineOpen] = useState(true)
  const [agentOpen, setAgentOpen] = useState(true)
  // Change Ledger dock (Task 4, ADR-0010/0011): a right-side panel listing the active document's
  // changes over the ChangeStore. ReviewCursor owns the dock↔document current-change invariant.
  const [changesOpen, setChangesOpen] = useState(true)
  // ADR-0014 view filters: hide inline old/new spans without resolving a change or touching the ledger.
  const [hideStrikes, setHideStrikes] = useState(false)
  const [hideInserts, setHideInserts] = useState(false)
  const [changes, setChanges] = useState<Change[]>([])
  const [versions, setVersions] = useState<Version[]>([])
  const [waitingHistory, setWaitingHistory] = useState<Array<{ from: string; count: number }>>([])
  const [historyAttachments, setHistoryAttachments] = useState<Array<{ from: string; to: string }>>([])
  const [historyAttachmentUndo, setHistoryAttachmentUndo] = useState<{ path: string; id: string; files: number } | null>(null)
  const [versionCompare, setVersionCompare] = useState<VersionCompareResult | null>(null)
  const [versionCompareLoading, setVersionCompareLoading] = useState(false)
  const [versionCompareError, setVersionCompareError] = useState('')
  const [compareView, setCompareView] = useState<{ fromId: VersionCompareEndpointId; toId: VersionCompareEndpointId } | null>(null)
  const [liveCompareRefreshTick, setLiveCompareRefreshTick] = useState(0)
  const [historicalView, setHistoricalView] = useState<HistoricalView | null>(null)
  const [versionDialogError, setVersionDialogError] = useState('')
  const [versionName, setVersionName] = useState('')
  // The file `changes` were loaded for — the editor-side surfaces (inline, marks) render only when this
  // matches the buffer that actually landed (loadedFile), so a mid-switch stale list is never projected
  // onto the wrong file (readFile can beat listChanges on a tab switch).
  const [changesPath, setChangesPath] = useState<string | null>(null)
  const [reviewCursorState, setReviewCursorState] = useState({ id: null as string | null, revealId: null as string | null, revealSerial: 0 })
  const reviewCursorRef = useRef<ReviewCursor | null>(null)
  // The margin's bulk controls while one is mounted.
  const marginControlRef = useRef<MarginControl | null>(null)
  const marginCommandRef = useRef<(what: 'focus' | 'accept' | 'decline' | 'send-back') => void>(() => {})
  const runMarginCommand = useCallback((what: 'focus' | 'accept' | 'decline' | 'send-back') => marginCommandRef.current(what), [])
  // Accept all / Decline all from one outside source (use-outside-source-bulk.ts), for the palette rows below; set once the hook runs.
  const outsideSourceBulkRef = useRef<(action: 'accept' | 'decline') => void>(() => {})
  // Show or hide the review margin (⇧⌥⌘M), remembered for this window. Hidden, ⇧⌘C shows it again.
  const [marginHidden, setMarginHidden] = useState<boolean>(() => { try { return window.localStorage.getItem('writeflex-margin-hidden') === '1' } catch { return false } })
  const toggleMargin = useCallback(() => {
    setMarginHidden((hidden) => {
      try { window.localStorage.setItem('writeflex-margin-hidden', hidden ? '0' : '1') } catch { /* the choice just is not kept */ }
      return !hidden
    })
  }, [])
  const marginHiddenRef = useRef(marginHidden)
  marginHiddenRef.current = marginHidden
  // Switch Margin / Inline; with the margin hidden the first press shows it.
  const switchMarginView = useCallback(() => {
    if (marginHiddenRef.current) { toggleMargin(); return }
    marginControlRef.current?.switchView()
  }, [toggleMargin])
  if (reviewCursorRef.current === null) {
    reviewCursorRef.current = new ReviewCursor(({ id, reveal }) => {
      setReviewCursorState((current) => ({
        id,
        revealId: reveal ? id : null,
        revealSerial: reveal ? current.revealSerial + 1 : current.revealSerial,
      }))
    })
  }
  const selectedChangeId = reviewCursorState.id
  const acceptAndNextRef = useRef<(id: string) => Promise<boolean>>(async () => false)
  // Workspace search (Task 14, ⇧⌘F): CH-1 moves it into the left tabbed pane rather than a rail swap.
  // The tabbed-panes chrome (tabs, collapse, drag-resize widths) lives in its own hook; opening a tab
  // fires the app-domain side effect here (mount the panel / arm its focus behaviour).
  // The Guide (ticket 07): is the Example collection shown, and is this window its own. Asked of main (it holds
  // the fixed path); the Guide's contents follow it.
  const [guideContext, setGuideContext] = useState<{ shown: boolean; here: boolean; canRestore: boolean; removed: boolean }>({ shown: false, here: false, canRestore: false, removed: false })
  // The Guide tab is not in the right pane until the person asks for it (the title-bar Guide button, the
  // palette, Settings → Get started, a chapter link): then it is last in the row and selected. Not kept
  // across launches; it leaves the row when the example is removed or brought back (ticket 10).
  const [guideOpen, setGuideOpen] = useState(false)
  // Set up sharing (0.24 ticket 02): the set-up steps as a page over the text. Ticket 03 mounts the
  // same component on the Sharing page.
  const [sharingSetupOpen, setSharingSetupOpen] = useState(false)
  // The Sharing page of the open piece (0.24 ticket 03), and the open piece's Shared mark.
  const [sharingPageOpen, setSharingPageOpen] = useState(false)
  // The collection's Shares list (0.24 ticket 10): the Sharing page one level up.
  const [sharesListOpen, setSharesListOpen] = useState(false)
  const [shareMark, setShareMark] = useState<ShareMark | null>(null)
  const guideInRow = guideOpen
  const [exampleChanges, setExampleChanges] = useState(0)
  // Main asked this window to open its Guide tab (it is taken with the next Guide-context read).
  const [guideWanted, setGuideWanted] = useState(0)
  const openGuideTabRef = useRef<() => void>(() => {})
  const [removeExampleOpen, setRemoveExampleOpen] = useState(false)
  const {
    leftTab,
    rightTab,
    leftPaneCollapsed,
    rightPaneCollapsed,
    leftPaneWidth,
    rightPaneWidth,
    openLeftTab,
    openRightTab,
    cycleRightTab,
    toggleLeftPane,
    toggleRightPane,
    collapseLeftPane,
    collapseRightPane,
    startPaneResize,
  } = usePaneLayout({
    guideShown: guideInRow,
    onLeftTabOpened: (tab) => {
      if (tab === 'outline') setOutlineOpen(true)
    },
    onRightTabOpened: (tab) => {
      if (tab === 'agent' || tab === 'scratchpad') setAgentOpen(true)
      if (tab === 'agent-notes' || tab === 'versions') setChangesOpen(true)
    },
  })
  // The narrow-window rule (ticket 07, state 34): with the Guide open and the window too narrow to keep the
  // editor at 560px beside both panes, the Files pane closes — once per narrowing.
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = (): void => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  // Where the review cards sit (the writer's choice, Margin by default) and the room the editor leaves beside the margin: the status bar's Margin | Inline switch reads both.
  const preferredMarginView = usePreferredView()
  const marginTextRoom = useTextRoom()
  const guideCrowded = guideContext.shown && rightTab === 'guide' && !rightPaneCollapsed
    && guideNeedsRoom({ viewportWidth, leftWidth: leftPaneWidth, rightWidth: rightPaneWidth })
  useEffect(() => { if (guideCrowded) collapseLeftPane() }, [guideCrowded, collapseLeftPane])
  // Display commands for the outline panel (expand/collapse all, levels, word counts): the palette sets a
  // request, the panel (which owns the collapse state) acts on it. Opening the tab shows the result.
  const [outlineRequest, setOutlineRequest] = useState<OutlineRequest | null>(null)
  const requestOutline = useCallback((action: OutlineRequest['action']) => {
    openLeftTab('outline')
    setOutlineRequest((current) => ({ tick: (current?.tick ?? 0) + 1, action }))
  }, [openLeftTab])
  // The window's ONE workspace instance — useTabs/useFavourites take root/files as arguments so a
  // post-mount bind (start screen → Open dialog / Open Recent → refresh()) reaches every consumer.
  // A hook privately instantiating useWorkspace would only ever see the mount-time pull (fix wave 1).
  const { root, files, folders, assetBaseUrl, refresh, applyCollectionChange } = useWorkspace()
  // The page has loaded its workspace view: main shows a window the vault switcher opened hidden only
  // once this names the root it bound (vaults 06 review round 2). Again on every change of root.
  useEffect(() => {
    if (root !== undefined) void window.writeflex.reportRendererReady(root).catch(() => {})
  }, [root])
  useEffect(() => {
    let live = true
    void window.writeflex.getGuideContext().then((got) => {
      if (live && got.wantsTab === true) openGuideTabRef.current()
      const next = { shown: got.shown, here: got.here, canRestore: got.canRestore === true, removed: got.removed === true }
      if (live) setGuideContext((now) => (now.shown === next.shown && now.here === next.here && now.canRestore === next.canRestore && now.removed === next.removed ? now : next))
    }).catch(() => {})
    return () => { live = false }
  }, [root, exampleChanges, guideWanted])
  useEffect(() => window.writeflex.onGuideShow?.(() => setGuideWanted((count) => count + 1)), [])
  const checklistProgress = useChecklistProgress(files)
  // Focus a folder (ticket 03): main owns it (per-window, survives relaunch); the tree narrows and
  // search scopes to it. Tabs are untouched — the strip keeps following the open file.
  const { focus: folderFocus, setFocus: setFolderFocus } = useFolderFocus(root, folders)
  // The Board's Collection folder; declared before useTabs because the Board tab joins that folder's group.
  const [boardDir, setBoardDir] = useState('')
  // The record browser's Source and preview tab (ticket 04b): which document and widget it holds, and the last widget step to undo.
  const [workbench, setWorkbench] = useState<{ documentPath: string; recipePath: string | null; caretLine?: number | null } | null>(null)
  const [lastWidgetStep, setLastWidgetStep] = useState<WorkbenchStep | null>(null)
  const workbenchRef = useRef(workbench)
  workbenchRef.current = workbench
  const lastWidgetStepRef = useRef<WorkbenchStep | null>(null)
  lastWidgetStepRef.current = lastWidgetStep
  /** The rename path's hold and buffer follow, for a widget step that moves documents (set below, where they are made). */
  const moveHoldRef = useRef<{
    withPathsSaved: <T>(paths: readonly string[] | (() => readonly string[]), act: () => Promise<T>) => Promise<{ result: T } | null>
    afterMainMoved: (from: string, to: string) => void
  } | null>(null)
  // The "List this piece's sources" popover (scraps ticket 04): the piece, and its collection when the Board knows it.
  const [pieceSourcesRequest, setPieceSourcesRequest] = useState<{ path: string; dir?: string } | null>(null)
  const restoredIdentityRoot = useRef(root)
  restoredIdentityRoot.current = root
  const { tabs, active: activeTab, pinned: pinnedTabs, recent: recentTabs, strip: stripTabs, groups: openTabGroups, open: openTab, replaceActive: replaceActiveTab, close, activate: activateTab, cycle: cycleTab, pin: pinTab, reorderPin: reorderPinnedTab } = useTabs(root, files, boardDir, (path) => unsaved.textOf(path) !== undefined, path => {
    if (path.includes('://')) return
    const restoredRoot = root
    void window.writeflex.readFolioPlace(path).then(place => {
      if (place && restoredIdentityRoot.current === restoredRoot) void requestIdentityLinks.current(place.dir)
    }).catch(error => console.warn('Could not check the restored Folio’s chapter links.', error))
  })
  const [visibleTabStripPaths, setVisibleTabStripPaths] = useState<string[]>([])
  const [modeDrawerOpen, setModeDrawerOpen] = useState(false)
  const [distractionFree, setDistractionFree] = useState(false)
  const [dfControlsVisible, setDfControlsVisible] = useState(false)
  const [tabParents, setTabParents] = useState<Record<string, string>>({})
  const [linkTrail, setLinkTrail] = useState<string[]>([])
  const [linkTrailIndex, setLinkTrailIndex] = useState(-1)
  const tabModifiedAt = useMemo(() => Object.fromEntries(files.map((file) => [file.path, file.modifiedAt])), [files])
  const setMeasuredVisibleTabs = useCallback((paths: string[]) => {
    setVisibleTabStripPaths((current) => sameTabList(current, paths) ? current : paths)
  }, [])
  const boardActive = isBoardTabId(activeTab)
  const workbenchActive = isWidgetWorkbenchTabId(activeTab)
  // File-owned effects see null for the Board and widget-workbench sentinels, so they can never reach read/save/version IPC.
  const active = boardActive || workbenchActive ? null : activeTab
  // The Folio or Collection the open file belongs to — its tab group, the one on the strip — which
  // is what “Focus on the open file’s Collection” focuses. The Board's own Collection when it is open.
  const activeCollectionFolder = useMemo(() => {
    if (boardActive) return boardDir === '' ? null : boardDir
    if (!activeTab || activeTab.includes('://')) return null
    const own = activeTab.includes('/') ? activeTab.slice(0, activeTab.lastIndexOf('/')) : ''
    const folder = openTabGroups.find((group) => group.tabs.includes(activeTab))?.key ?? own
    return folder === '' ? null : folder
  }, [boardActive, boardDir, activeTab, openTabGroups])
  // Collection view (Task 23): a folder browsed as a table of its pieces, shown in the main area in
  // place of the editor. `collectionDir` is the open folder ('' = the workspace root), or null for the
  // editor. Opening/activating/cycling any tab exits the collection — so every doc-navigation path
  // clears it in ONE place by wrapping the useTabs actions, rather than sprinkling resets at call sites.
  const [collectionDir, setCollectionDir] = useState<string | null>(null)
  const requestIdentityLinks = useRef<(dir: string, force?: boolean) => Promise<boolean>>(async () => false)
  // A conversion Undo belongs only to the last action in its collection. Refs expire
  // synchronously when notifications arrive, before any captured key can steal a room Undo.
  const turnBackUndo = useRef<{ dir: string; root: typeof root } | null>(null)
  const [folioEditingDir, setFolioEditingDir] = useState<string | null>(null)
  const [workspaceFolioDir, setWorkspaceFolioDir] = useState<string | null>(roomOnScreen)
  const borrowedSidebar = useRef<Parameters<typeof folioSidebarLayout>[0]>(null)
  useEffect(() => {
    const onRoom = (event: Event): void => setWorkspaceFolioDir((event as CustomEvent<string | null>).detail)
    window.addEventListener(ROOM_ON_SCREEN_EVENT, onRoom)
    return () => window.removeEventListener(ROOM_ON_SCREEN_EVENT, onRoom)
  }, [])
  const sidebarFolioDir = workspaceFolioDir ?? folioEditingDir
  useEffect(() => {
    const next = folioSidebarLayout(borrowedSidebar.current, sidebarFolioDir, { tab: leftTab, collapsed: leftPaneCollapsed })
    borrowedSidebar.current = next.saved
    if (next.layout) {
      openLeftTab(next.layout.tab)
      if (next.layout.collapsed) collapseLeftPane()
    }
  }, [sidebarFolioDir, leftTab, leftPaneCollapsed, openLeftTab, collapseLeftPane])

  const [openPlanRequested, setOpenPlanRequested] = useState(false)
  // The Folio room's text pane (Text view and Split): the file it wants shown in THIS editor, while the collection overlay stays up.
  // The room puts the editor over its text box (folio-room.css); nothing here clears collectionDir.
  const [roomTextPath, setRoomTextPath] = useState<string | null>(null)
  const roomTextRef = useRef<string | null>(null)
  roomTextRef.current = roomTextPath
  const [folioPlace, setFolioPlace] = useState<FolioPlace | null>(null)
  const folioPlaceRequest = useRef(0)
  const [boardFilter, setBoardFilter] = useState('')
  // The Board shown inside a Folio's Cards tab (ADR-0049 slice 2, until the folders tree): its palette commands work while it shows.
  const [folioBoardShown, setFolioBoardShown] = useState(false)
  const boardCommandsOn = boardActive || folioBoardShown
  const [selectedFolderPiece, setSelectedFolderPiece] = useState<{ dir: string; folderPath: string; mode: 'one' | 'many' } | null>(null)
  const [folderPieceChoices, setFolderPieceChoices] = useState<FolderPieceChoice[]>([])
  const [sidebarCollectionSummary, setSidebarCollectionSummary] = useState<{ pieceCount: number; folderPiecePaths: Set<string> } | null>(null)
  const boardSeenStatusesRef = useRef(new Set<string>())
  const folderPieceContextDir = collectionDir !== null ? collectionDir : boardActive ? boardDir : null
  // Outline switching (ticket 13): opening from Files or Search arms it for that file; every other way of
  // opening disarms it. See app/outline-switch.ts.
  const outlineSwitchRef = useRef<OutlineSwitchState>(OUTLINE_SWITCH_IDLE)
  const noteOpenSource = useCallback((path: string, source: OpenSource) => { outlineSwitchRef.current = noteFileOpened(outlineSwitchRef.current, path, source) }, [])
  const open = useCallback((path: string) => { noteOpenSource(path, 'other'); setCollectionDir(null); setOpenPlanRequested(false); openTab(path) }, [openTab, noteOpenSource])
  const activate = useCallback((path: string) => { setCollectionDir(null); setOpenPlanRequested(false); setSelectedFolderPiece(null); activateTab(path) }, [activateTab])
  const cycle = useCallback((dir: 1 | -1) => { setCollectionDir(null); setOpenPlanRequested(false); setSelectedFolderPiece(null); cycleTab(dir) }, [cycleTab])
  const { favourites, toggle: toggleFavourite } = useFavourites(root)
  // The window's writing session (Task 12): +words · elapsed · wpm across every tab for the window's
  // lifetime. App owns it because it sees both a file's load baseline and its every edit.
  const session = useSession()

  // --- Editor state (Task 6) ---
  const editorRef = useRef<EditorHandle | null>(null)
  const [lastEditablePath, setLastEditablePath] = useState<string | null>(null)
  // Where the open file sits in its Folio (the line above the text, the title-bar button). Asked of
  // main when the file changes and when the Folio's files change, never per keystroke. The previous
  // answer stays on screen until the new one lands while the file is inside the same Folio's folder, so
  // moving between pieces does not blink the line; any other file clears it first. A slower earlier
  // answer is dropped.
  const folioPlacePath = active ?? (boardActive ? lastEditablePath : null)
  const refreshFolioPlace = useCallback(() => {
    const request = ++folioPlaceRequest.current
    if (!folioPlacePath || folioPlacePath.includes('://')) { setFolioPlace(null); return }
    // Keep the line while the new file is a piece of the same Folio (no blink); clear it at once when the
    // file is outside the Folio's folder, until the new answer arrives.
    setFolioPlace((current) => (current && (current.dir === '' || folioPlacePath.startsWith(`${current.dir}/`)) ? current : null))
    void askFolioPlace(
      () => window.writeflex.readFolioPlace(folioPlacePath),
      () => request === folioPlaceRequest.current,
      (next) => setFolioPlace((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next)),
    )
  }, [folioPlacePath])
  useEffect(() => { refreshFolioPlace() }, [refreshFolioPlace, root])
  useEffect(() => window.writeflex.onCollectionChanged(refreshFolioPlace), [refreshFolioPlace])
  useEffect(() => window.writeflex.onFileChangedOnDisk((paths) => {
    if (paths.some((path) => path.endsWith(MANIFEST_NAME))) refreshFolioPlace()
  }), [refreshFolioPlace])
  // Every part-opening route uses the persistent editor and the Folio contents sidebar.
  useEffect(() => {
    if (collectionDir !== null) { setFolioEditingDir(null); return }
    if (folioPlace?.kind === 'piece') {
      if (folioEditingDir !== folioPlace.dir) {
        setFolioEditingDir(folioPlace.dir)
        setOutlineRequest(current => ({ tick: (current?.tick ?? 0) + 1, action: 'showFolio' }))
      }
    }
    else setFolioEditingDir(null)
  }, [folioPlace, collectionDir, folioEditingDir])
  // Opening a Folio checks its parts' titles once (main remembers it per window): proposals wait in the Changes.
  const folioPlaceDir = folioPlace?.dir
  useEffect(() => {
    if (folioPlaceDir === undefined || !folioPlacePath) return
    void window.writeflex.checkFolioPartTitles(folioPlacePath).catch(() => undefined)
  }, [folioPlaceDir, folioPlacePath])
  const [railOpen, setRailOpen] = useState(false)
  const [railFocusRequest, setRailFocusRequest] = useState(0)
  const [queryInsertionContext, setQueryInsertionContext] = useState<QueryInsertionContext | null>(null)
  const queryInsertionContextRef = useRef<QueryInsertionContext | null>(null)
  const [queryInsertConfirm, setQueryInsertConfirm] = useState<QueryInsertionContext | null>(null)
  const collectionSurfaceMountedRef = useRef(false)
  collectionSurfaceMountedRef.current = boardActive || collectionDir !== null || railOpen
  const [documentFindOpen, setDocumentFindOpen] = useState(false)
  const [documentFindQuery, setDocumentFindQuery] = useState('')
  const [documentFindReplacement, setDocumentFindReplacement] = useState('')
  const [documentFindReplaceOpen, setDocumentFindReplaceOpen] = useState(false)
  const [documentFindStatus, setDocumentFindStatus] = useState<FindStatus>({ current: 0, total: 0 })
  const [activeCollectionDir, setActiveCollectionDir] = useState('')
  const [activeCollectionPath, setActiveCollectionPath] = useState<string | null>(null)
  const [statusBarCollectionDir, setStatusBarCollectionDir] = useState('')
  const workspaceName = root?.split('/').filter(Boolean).at(-1) ?? null
  const activeDocumentName = boardActive ? 'Board' : workbenchActive ? 'Widget workbench' : active?.split('/').at(-1) ?? null
  const activeParentDir = active?.includes('/') ? active.slice(0, active.lastIndexOf('/')) : ''
  const shownCollectionDir = boardActive ? boardDir : active ? (activeCollectionDir || activeParentDir) : collectionDir
  const shownStatusBarCollectionDir = boardActive ? boardDir : active ? statusBarCollectionDir : collectionDir
  const collectionName = shownCollectionDir?.split('/').filter(Boolean).at(-1) ?? workspaceName
  const statusBarCollectionName = shownStatusBarCollectionDir?.split('/').filter(Boolean).at(-1) ?? workspaceName
  useEffect(() => {
    const title = documentIdentityLabel(activeDocumentName, collectionName)
    document.title = title
    void window.writeflex.setWindowTitle(title)
  }, [activeDocumentName, collectionName])
  const [wikilinkRefreshTick, setWikilinkRefreshTick] = useState(0)
  const [wikilinkCompletionPieces, setWikilinkCompletionPieces] = useState<Array<{ title: string; name: string }>>([])
  const wikilinkRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // One debounced read of the live editor per update tick — doc text + a single Lezer heading parse +
  // the selection — shared by the outline pane and the status bar so a cursor move on a long document
  // triggers ONE parse, not one per consumer (fix wave 1). null before the first read / with no view.
  const snapshot = useEditorSnapshot(editorRef, active)
  useEffect(() => {
    if (!window.writeflex.e2eEnabled || !window.__writeflexE2E) return
    const api = window.__writeflexE2E
    api.setEditorSelection = (position, head) => {
      const view = editorRef.current?.view()
      if (!view) return
      const clamp = (value: number) => Math.max(0, Math.min(value, view.state.doc.length))
      view.dispatch({ selection: { anchor: clamp(position), head: clamp(head ?? position) } })
      view.focus()
    }
    api.editorDoc = () => editorRef.current?.view()?.state.doc.toString() ?? ''
    api.editorSelection = () => { const v = editorRef.current?.view(); if (!v) return null; const m = v.state.selection.main; return { from: m.from, to: m.to, domFocused: v.hasFocus } }
    api.outboxAutomaticSyncAttempts = () => outboxAutomaticSyncAttemptsRef.current
    api.resetOutboxAutomaticSyncAttempts = () => {
      outboxAutomaticSyncAttemptsRef.current = 0
    }
    api.setStatusBarEvents = (waiting, rejected) => {
      outboxWaitingRef.current = waiting
      setOutboxWaiting(waiting)
      setOutboxRejected(rejected)
    }
    // The write hooks (hold or fail a save, a rename, an accept, an export) exist only in an unpackaged e2e
    // run (shared/e2e-write-hooks.ts): a packaged build never installs them, whatever its environment.
    if (window.writeflex.e2eWriteHooks) {
      api.setSaveBehaviour = (behaviour) => { e2eSaveBehaviourRef.current = behaviour }
      api.savesSent = () => [...e2eSavesSentRef.current]
      api.releaseSlowSave = () => {
        e2eSlowSaveReleaseRef.current?.()
        e2eSlowSaveReleaseRef.current = null
        e2eSaveBehaviourRef.current = 'normal'
      }
    }
    api.collectionQueryCount = window.writeflex.e2eCollectionQueryCount
    api.focusEditor = () => { editorRef.current?.view()?.focus() }
    api.resetCollectionQueryCount = window.writeflex.resetE2eCollectionQueryCount
    return () => {
      delete api.setEditorSelection
      delete api.editorDoc
      delete api.editorSelection
      delete api.outboxAutomaticSyncAttempts
      delete api.resetOutboxAutomaticSyncAttempts
      delete api.setStatusBarEvents
      delete api.setSaveBehaviour
      delete api.savesSent
      // releaseSlowSave stays: a write held when the app is unmounted by an error must still be releasable.
      delete api.collectionQueryCount
      delete api.resetCollectionQueryCount
      delete api.focusEditor
    }
  }, [])
  // The document owner (document-owner.ts) holds every open document's saved baseline, generation, dirty
  // dot and queue, and is the only one that rebases, replaces or forgets a buffer. It is created once
  // (below, with its ports); `ownerRef` lets callbacks declared before it reach it.
  const ownerRef = useRef<DocumentOwner | null>(null)
  // The path whose buffer the editor view currently shows. Guards save() against writing the
  // PREVIOUS file's buffer to a just-activated tab whose readFile hasn't resolved yet.
  const loadedPath = useRef<string | null>(null)
  // loadedPath's reactive mirror, for consumers that must re-run when the buffer actually lands
  // (Task 16: the suggestion callout syncs anchors only against the file the view is showing).
  const [loadedFile, setLoadedFile] = useState<string | null>(null)
  // A folder-scope outline jump into a NOT-yet-loaded file (Task 10). Opening a file is async — the
  // tab activates, then readFile resolves, then switchTo swaps the buffer in — so the caret can only
  // be placed once that buffer is live. We stash {path,line} here and flush it in the activation
  // effect the instant switchTo lands (the T6 queue-until-ready pattern, at the precise ready moment).
  const pendingLine = useRef<{ path: string; line: number } | null>(null)
  // The focus-file subscription (declared above jumpToFileLine) reaches the live callback through this.
  const jumpToFileLineRef = useRef<(file: string, line: number) => void>(() => undefined)
  // A search jump into a not-yet-loaded file (Task 14): like pendingLine, but carries the match's
  // column+length so the flush places a SELECTION over the hit, not just the caret on its line.
  const pendingMatch = useRef<{ path: string; line: number; column: number; length: number } | null>(null)
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(() => new Set())
  const [saveFailures, setSaveFailures] = useState<Set<string>>(() => new Set())
  const [slowSavePaths, setSlowSavePaths] = useState<Set<string>>(() => new Set())
  const [lastSavedAt, setLastSavedAt] = useState<Map<string, number>>(() => new Map())
  const [statusDisclosureRequest, setStatusDisclosureRequest] = useState(0)
  // The same notices, readable in the turn they are raised: the save seam (writePath) asks this, not the rendered state.
  const externalDiskNoticesRef = useRef(new Map<string, ExternalDiskNotice>())
  const [externalDiskNotices, setExternalDiskNotices] = useState<Map<string, ExternalDiskNotice>>(
    () => new Map(),
  )
  // The dirty set is the owner's, exact between renders (owner.isDirty). activeRef only picks how a buffer
  // is read when saving, so a one-render lag there is harmless.
  const activeRef = useRef(active)
  activeRef.current = active
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const compareViewRef = useRef(compareView)
  compareViewRef.current = compareView
  const liveCompareRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A monotonic save signal for the outline's disk-backed folder scope: bumped whenever a save lands
  // on disk, so a just-saved bookmark/comment/task re-scans into the folder view without a scope toggle.
  const [savedTick, setSavedTick] = useState(0)
  const [skillToast, setSkillToast] = useState<SkillToast | null>(null)
  const [paletteSkills, setPaletteSkills] = useState<SkillMeta[]>([])
  const [paletteSkillErrors, setPaletteSkillErrors] = useState<Array<{ source: string; message: string }>>([])

  // App owns the palette's registry data; the palette and switcher receive the same SkillMeta
  // objects and both apply AgentSkillSurfaces.orderSkills (ADR-0027: one registry, two doors).
  useEffect(() => {
    let cancelled = false
    void window.writeflex.skills.list().then((result) => {
      if (!cancelled) {
        setPaletteSkills(result.skills)
        setPaletteSkillErrors(result.errors)
      }
    }).catch(() => {
      if (!cancelled) {
        setPaletteSkills([])
        setPaletteSkillErrors([])
      }
    })
    return () => { cancelled = true }
  }, [root])

  // Direct palette/chord runs must still report while the right pane (and therefore AgentPanel's B4
  // listener) is unmounted. With the pane open, B4 remains the single completion owner.
  useEffect(() => window.writeflex.threads.onRunComplete((payload: ThreadRunComplete) => {
    if (!rightPaneCollapsed) return
    if (payload.outcome === 'error') {
      setSkillToast({ kind: 'error', skillName: payload.skillName, details: payload.reply })
    } else if (payload.skillName === 'review') {
      setSkillToast({ kind: 'notes', skillName: payload.skillName, path: null })
    } else if (payload.suggestionsStaged > 0) {
      setSkillToast({ kind: 'staged', skillName: payload.skillName, count: payload.suggestionsStaged })
    }
  }), [rightPaneCollapsed])

  // --- Agent panel (Task 15) ---
  // Agent housekeeping (create/rename) and Undo turn move files on disk outside the save path, so
  // they refresh the tree AND bump savedTick — the outline's folder scope re-scans exactly as it
  // does after a user save (the T10 ledger note for agent tasks).
  const handleAgentWorkspaceChange = useCallback(() => {
    void refresh()
    setSavedTick((n) => n + 1)
  }, [refresh])
  // A note the agent leaves about a piece must be seen, not hunted for : the
  // completed notes.create opens the Agent notes tab; the pane re-lists on the main-side push.
  const showAgentNotesTab = useCallback(() => openRightTab('agent-notes'), [openRightTab])
  const agent = useAgent({ onWorkspaceChanged: handleAgentWorkspaceChange, onNoteCreated: showAgentNotesTab, activeFile: active, activeCollectionDir: shownCollectionDir ?? '' })
  const historicalActive = historicalView !== null
  // Read by the floating Scratchpad after its awaits: a saved version or session recall is never written to.
  const historicalActiveRef = useRef(historicalActive)
  historicalActiveRef.current = historicalActive
  const compareActive = compareView !== null
  const compareToEditable = compareView ? compareToColumnMode(compareView.toId) === 'editable-working' : false
  const insertionTarget = lastEditablePath && tabs.includes(lastEditablePath) ? lastEditablePath : null
  const railActivePath = active ?? (boardActive ? insertionTarget : null)
  const railDir = collectionDir ?? (boardActive ? boardDir : active ? activeCollectionDir : '')
  const canInsertQuery = insertionTarget !== null && (
    boardActive
    || (active === insertionTarget && loadedFile === active && !historicalActive && !compareActive && collectionDir === null)
  )
  const queryInsertionDisabledReason = collectionDir !== null
    ? 'Collection view is open.'
      : insertionTarget === null
        ? 'Open an editable document to insert this query.'
        : canInsertQuery ? null : 'Open an editable document to insert this query.'
  const restoreEditorFocus = useCallback(() => {
    window.requestAnimationFrame(() => editorRef.current?.view()?.focus())
  }, [])
  const focusRail = useCallback(() => {
    setRailOpen(true)
    setRailFocusRequest((request) => request + 1)
  }, [])
  const runRailChord = useCallback(() => {
    if (!railOpen) {
      setRailOpen(true)
      return
    }
    const railHeldFocus = document.activeElement instanceof Element
      && document.activeElement.closest('.collection-rail') !== null
    if (railHeldFocus) restoreEditorFocus()
    else setRailFocusRequest((request) => request + 1)
  }, [railOpen, restoreEditorFocus])
  const dismissRail = useCallback(() => {
    const railHeldFocus = document.activeElement instanceof Element
      && document.activeElement.closest('.collection-rail, .insert-query-confirm') !== null
    setRailOpen(false)
    queryInsertionContextRef.current = null
    setQueryInsertionContext(null)
    if (railHeldFocus) restoreEditorFocus()
  }, [restoreEditorFocus])
  const dismissQueryInsertConfirm = useCallback(() => {
    const bubbleHeldFocus = document.activeElement instanceof Element
      && document.activeElement.closest('.insert-query-confirm') !== null
    setQueryInsertConfirm(null)
    if (bubbleHeldFocus) restoreEditorFocus()
  }, [restoreEditorFocus])
  const updateQueryInsertionContext = useCallback((context: QueryInsertionContext) => {
    queryInsertionContextRef.current = context
    setQueryInsertionContext(context)
  }, [])
  const requestQueryInsertion = useCallback((context: QueryInsertionContext) => {
    updateQueryInsertionContext(context)
    setQueryInsertConfirm(context)
  }, [updateQueryInsertionContext])
  const confirmQueryInsertion = useCallback(() => {
    if (!queryInsertConfirm || !canInsertQuery || !insertionTarget) return
    editorRef.current?.insertText(`\`\`\`query\n${queryInsertConfirm.source}\n\`\`\``, { block: true })
    setQueryInsertConfirm(null)
    dismissRail()
    if (active !== insertionTarget || boardActive || collectionDir !== null) open(insertionTarget)
  }, [active, boardActive, canInsertQuery, collectionDir, dismissRail, insertionTarget, open, queryInsertConfirm])
  // --- Scratchpad (Task 20, ADR-0008) ---
  // File-native cuttings in scraps/<origin>-SCRAPS.md. A mutation refreshes the tree + bumps savedTick
  // exactly as an agent write does, so scraps/ surfaces in the sidebar the moment the first cut lands.
  const scraps = useScraps(root, handleAgentWorkspaceChange)
  // --- Sources (Task 21, PRD S30) ---
  // Reference material under research/, surfaced beside Scratchpad. Re-lists whenever the file tree is
  // re-pulled (the `files` reference changes) — an agent create or a save into research/ shows up on
  // the same beat. md sources open in a tab (useTabs.open); other kinds reveal in the OS file manager.
  const sources = useSources(root, files)
  const revealSource = useCallback((path: string) => void window.writeflex.showItem(path).catch(() => {}), [])
  const scrapsRef = useRef<Scrap[]>([])
  scrapsRef.current = scraps.scraps
  // The Scratchpad-tab request (the rail tab, Send original to Scratchpad). `focus` lands the keyboard in
  // the Agent panel's embedded scraps filter; ⇧⌘J and ⌘⇧X now go to the floating Scratchpad (ADR-0050).
  const [scratchpadRequest, setScratchpadRequest] = useState<{ tick: number; focus: boolean }>({ tick: 0, focus: false })
  // The floating Scratchpad (ADR-0050): one instance, mounted below; App only forwards keys and commands.
  const scratchpadApi = useRef<ScratchpadHostApi | null>(null)
  const [scratchpadDockSlot, setScratchpadDockSlot] = useState<HTMLElement | null>(null)
  const openScratchpadDock = useCallback(() => openRightTab('scratchpad'), [openRightTab])
  const openScratchpad = useCallback((focus: boolean) => {
    openRightTab('scratchpad')
    setScratchpadRequest((r) => ({ tick: r.tick + 1, focus }))
  }, [openRightTab])
  // A composer focus/prefill request (⌘J, the toolbar Sparkles, the palette ask-row). A tick bump —
  // not an imperative ref call — because the panel may be un-hiding in the same update, and only a
  // post-commit effect can focus an input that was display:none when the request was made.
  const [composerRequest, setComposerRequest] = useState<ComposerRequest>({ tick: 0 })
  const [agentConfigurationRequest, setAgentConfigurationRequest] = useState<AgentConfigurationRequest>({ tick: 0, focus: 'model' })
  const [agentActionRequest, setAgentActionRequest] = useState<AgentActionRequest>({ tick: 0, action: 'show-conversations' })
  const focusComposer = useCallback((text?: string) => {
    openRightTab('agent')
    setComposerRequest((r) => ({ tick: r.tick + 1, ...(text !== undefined ? { text } : {}) }))
  }, [openRightTab])
  const openAgentConfiguration = useCallback((focus: AgentConfigurationRequest['focus']) => {
    openRightTab('agent')
    setAgentConfigurationRequest((request) => ({ tick: request.tick + 1, focus }))
  }, [openRightTab])
  const requestAgentAction = useCallback((action: AgentActionRequest['action']) => {
    openRightTab('agent')
    setAgentActionRequest((request) => ({ tick: request.tick + 1, action }))
  }, [openRightTab])

  // Late-bound writer-facing report for a structured main-process refusal: flash is declared below.
  const dismissFolioNoticeRef = useRef<(() => void) | null>(null)
  const flashRef = useRef<((message: string) => void) | null>(null)
  const guardRefusalPath = useRef<string | null>(null)
  // Why the last write of each path was refused, in the words the writer was shown: a closing window
  // names every path it could not write with its own reason (a reason for one path never stands for another).
  const refusalReasons = useRef(new Map<string, string>())
  // Late-bound (declared with the notices below): main refused a write because the disk no longer holds
  // the version the buffer was based on. `answering`: the write was Keep mine to that notice.
  const diskChangedUnderBufferRef = useRef<((path: string, diskText: string | null, buffer: string, answering?: ExternalDiskNotice) => void) | null>(null)
  // Late-bound (declared with the notices below): the file read back after a write is not what was
  // written. Another program wrote it in between: an outside change, asked about like any other.
  const outsideAfterWriteRef = useRef<((path: string, diskText: string) => void) | null>(null)
  // The per-render values the owner's reports use (stable callbacks read them through this).
  const noteUserSaveRef = useRef(agent.noteUserSave)
  noteUserSaveRef.current = agent.noteUserSave
  // The document owner itself (document-owner.ts), created once. Its ports read this app's state when
  // they are called: the live editor, the notices, the unsaved registry, main's file:save.
  if (!ownerRef.current) {
    ownerRef.current = createDocumentOwner({
      buffer: (p) => {
        const editor = editorRef.current
        if (!editor) return undefined
        const live = activeRef.current === p && loadedPath.current === p
        return (live ? editor.currentDoc() : editor.docFor(p)) ?? null
      },
      notice: (p) => externalDiskNoticesRef.current.get(p),
      registry: unsaved,
      write: (p, doc, basis) => {
        // e2e only: every save the owner sends to main, in order (autosave.spec.ts reads it; review S3).
        if (window.writeflex.e2eWriteHooks) e2eSavesSentRef.current.push({ path: p, content: doc })
        return window.writeflex.saveFile(p, doc, basis)
      },
      beforeSave: window.writeflex.e2eWriteHooks
        ? async () => {
            if (e2eSaveBehaviourRef.current === 'slow') {
              await new Promise<void>((resolve) => { e2eSlowSaveReleaseRef.current = resolve })
            }
            if (e2eSaveBehaviourRef.current === 'fail') {
              e2eSaveBehaviourRef.current = 'normal'
              throw new Error('Simulated save failure')
            }
          }
        : undefined,
      setReadOnly: (paths, readOnly) => editorRef.current?.setReadOnly(paths, readOnly),
      forgetBuffer: (p) => {
        editorRef.current?.forget(p)
        if (loadedPath.current === p) loadedPath.current = null
      },
      renameBuffer: (from, to) => editorRef.current?.renamePath(from, to),
      replaceBuffer: (p, diskText, discardLocal) => editorRef.current?.setContent(p, diskText, { silent: true, ...(discardLocal ? { discardLocal: true } : {}) }),
      dirtyChanged: (paths) => setDirtyPaths(new Set(paths)),
      report: {
        slow: (p, slow) => setSlowSavePaths((current) => {
          if (current.has(p) === slow) return current
          const next = new Set(current)
          if (slow) next.add(p)
          else next.delete(p)
          return next
        }),
        refusedByNotice: (p, message) => {
          guardRefusalPath.current = p // the callers' own "could not save" lines give way to this one
          refusalReasons.current.set(p, message)
          flashRef.current?.(message)
        },
        refusedByMain: (p, message) => {
          guardRefusalPath.current = p
          refusalReasons.current.set(p, message)
          setSaveFailures((current) => (current.has(p) ? current : new Set(current).add(p)))
          flashRef.current?.(message)
        },
        diskChanged: (p, diskText, buffer, answering) => {
          guardRefusalPath.current = p
          diskChangedUnderBufferRef.current?.(p, diskText, buffer, answering)
        },
        saved: (p, changed) => {
          refusalReasons.current.delete(p)
          if (guardRefusalPath.current === p) guardRefusalPath.current = null
          setSaveFailures((current) => {
            if (!current.has(p)) return current
            const next = new Set(current)
            next.delete(p)
            return next
          })
          setLastSavedAt((current) => new Map(current).set(p, Date.now()))
          setSavedTick((n) => n + 1) // disk moved: the disk-backed folder outline re-scans
          // A user save disarms ⌘⇧Z (T16): one that put the writer's text on disk. A write that found the
          // buffer already there changed nothing an Undo turn would rewind (a flush before an accept).
          if (changed) noteUserSaveRef.current()
        },
        outsideAfterWrite: (p, diskText) => outsideAfterWriteRef.current?.(p, diskText),
        unknown: (p) => {
          refusalReasons.current.delete(p)
          if (guardRefusalPath.current === p) guardRefusalPath.current = null
          setSaveFailures((current) => (current.has(p) ? current : new Set(current).add(p)))
          flashRef.current?.(`Could not save ${p.split('/').at(-1) ?? p}.`)
        },
      },
    })
  }
  const owner = ownerRef.current
  // A path's buffer as it is now (the live editor, or the tab's cache), or null when none is held.
  const bufferNow = useCallback((path: string): string | null => {
    const editor = editorRef.current
    if (!editor) return null
    return activeRef.current === path && loadedPath.current === path ? editor.currentDoc() ?? null : editor.docFor(path) ?? null
  }, [])
  // The Scratchpad inventory's buffer: RAW editor text plus its excluded old-role spans, never the
  // persistence projection above — inventory positions must address the editor the writer sees.
  const scratchpadBufferNow = useCallback((path: string) => editorRef.current?.inventoryBufferFor(path) ?? null, [])

  const setSaveFailed = useCallback((path: string, failed: boolean) => {
    setSaveFailures((current) => {
      if (current.has(path) === failed) return current
      const next = new Set(current)
      if (failed) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])

  const setSaveSlow = useCallback((path: string, slow: boolean) => {
    setSlowSavePaths((current) => {
      if (current.has(path) === slow) return current
      const next = new Set(current)
      if (slow) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])

  // Pending state is transient. Save failures are path-owned and remain until that path saves or is
  // explicitly closed, so switching tabs cannot erase the only warning about an unsaved buffer.
  useEffect(() => {
    setSlowSavePaths(new Set())
  }, [active])

  // Tier 1 (ADR-0013): a write of one path's buffer, queued in the owner's per-path queue (Codex P1: a slow
  // earlier write can never land after a newer one). The write reads the buffer when it RUNS, so whoever
  // asks persists the latest text; it never snapshots (history is tier 2, below). The promise resolves to
  // THIS write's result: false = not written, the reason was shown, the buffer is kept.
  // The Folio folders whose running order is being written just now (one entry per write in flight).
  const folioWritesInFlight = useRef<string[]>([])
  const savePath = useCallback(
    (path: string, answered?: ExternalDiskNotice): Promise<boolean> => {
      // A save asked for while a running-order write of this file's Folio is under way runs after it, and
      // then writes only if the disk still holds what this buffer was last saved as: the buffer was read
      // before that write, so it carries the old running order (shared/folio-write-preparation.ts).
      const behindFolioWrite = folioWritesInFlight.current.some((dir) => inFolioFolder(path, dir))
      return owner.save(path, answered, behindFolioWrite
        ? () => saveQueuedBehindFolioWriteMayRun(
            owner.baselineOf(path),
            async () => (await window.writeflex.readFile(path)).content,
            isTextChange,
          )
        : undefined)
    },
    [owner],
  )

  // Tier 2 (ADR-0013): the paths edited since their last CHECKPOINT. Tracked apart from the dirty-vs-disk
  // set because auto-save clears that set while leaving work still uncheckpointed — this is what a close
  // checkpoints. A checkpoint (⌘S, or a close) flushes the buffer, then snapshots the on-disk state as a
  // returnable point (git commit). `auto` marks an app-made close-checkpoint; main gates those by the
  // "checkpoint on close" setting, while an explicit ⌘S (auto:false) always fires.
  const uncheckpointed = useRef(new Set<string>())
  const checkpointPath = useCallback(
    async (path: string, auto: boolean): Promise<void> => {
      // Flush the latest text to disk before snapshotting it. If the write FAILS, do not snapshot stale
      // on-disk content and do not clear the pending flag (Codex P2) — leave it for a later checkpoint.
      if (!(await savePath(path))) return
      await window.writeflex.checkpoint(path, { auto })
      uncheckpointed.current.delete(path)
    },
    [savePath],
  )

  // Auto-save (ADR-0012/0013, tier 1): write on a short pause after typing, and flush immediately on
  // tab-switch, window-blur, and close — so there is never an unsaved state to lose. It only writes disk;
  // history is made by tier-2 checkpoints, so continuous auto-save never touches the snapshot journal.
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingAutosave = useRef<string | null>(null)
  const flushAutosave = useCallback(() => {
    if (autosaveTimer.current) {
      clearTimeout(autosaveTimer.current)
      autosaveTimer.current = null
    }
    const path = pendingAutosave.current
    pendingAutosave.current = null
    // No automatic write under an unanswered changed-on-disk notice (savePath would refuse it, and say so
    // after every pause in typing).
    if (path && mayWriteUnderDiskNotice(externalDiskNoticesRef.current.get(path))) void savePath(path)
  }, [savePath])
  const queueAutosave = useCallback(
    (path: string) => {
      pendingAutosave.current = path
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
      autosaveTimer.current = setTimeout(flushAutosave, 700)
    },
    [flushAutosave],
  )

  const cancelAutosaveFor = useCallback((path: string) => {
    if (pendingAutosave.current !== path) return
    pendingAutosave.current = null
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
    autosaveTimer.current = null
  }, [])

  // A document under a changed-on-disk notice with nothing typed over its version: it cannot be written
  // until the writer answers. The structural routes (rename, move, duplicate) hold it unwritten and the
  // notice goes with it; no other route uses this exception (2b review P2: the dot and the registry do not
  // prove the file is what is on screen, so an export or the Board must not proceed as if it were).
  const cleanUnderNotice = useCallback(
    (p: string): boolean => externalDiskNoticesRef.current.has(p) && !owner.isDirty(p) && unsaved.textOf(p) === undefined,
    [owner],
  )
  // The documents a folder-scoped operation covers (a folder's rename or trash, a collection's export): every
  // path under the prefix the app has any record of (the owner's records, unresolved notices, registry
  // entries, tabs), never the dots or the tabs alone (2b round 3 ruling). `prefix` ends in `/`, or is ''.
  const documentsUnder = useCallback(
    (prefix: string): string[] => documentsUnderFrom(prefix, {
      owned: owner.pathsUnder(prefix),
      notices: externalDiskNoticesRef.current.keys(),
      registry: unsaved.pending(),
      tabs: tabsRef.current.filter((path) => !isSurfaceTabId(path)),
    }),
    [owner],
  )
  // The routes that need the file on disk to be what is on screen (the Board, the Plan, a folder's
  // Collection, an export) write the buffers first, through the owner (document-owner.ts, `flush`). A
  // document under an unanswered changed-on-disk notice cannot be written, so the route is refused (the
  // notice's own line says why) until the writer answers it: the file is never taken as the screen's text
  // while the two may differ (2b review P2).
  const flushPaths = useCallback(
    (paths: readonly string[]) => {
      for (const p of paths) cancelAutosaveFor(p)
      return owner.flush(paths)
    },
    [cancelAutosaveFor, owner],
  )

  useEffect(() => window.writeflex.onFolioFlushRequested(({ id, dir }) => {
    const paths = ['AGENTS.md', 'CLAUDE.md', '_report-structure.json', `_${dir.split('/').at(-1) || root?.split('/').at(-1)}_INDEX.md`].map(name => dir ? `${dir}/${name}` : name)
    void flushPaths(paths).then(result => window.writeflex.replyFolioFlush(id, result.status === 'saved'))
      .catch(() => { void window.writeflex.replyFolioFlush(id, false) })
  }), [flushPaths, root])

  const queueLiveCompareRefresh = useCallback((path: string) => {
    if (!shouldRefreshWorkingCompare(compareViewRef.current, activeRef.current, path)) return
    if (liveCompareRefreshTimer.current) clearTimeout(liveCompareRefreshTimer.current)
    liveCompareRefreshTimer.current = setTimeout(() => {
      liveCompareRefreshTimer.current = null
      setLiveCompareRefreshTick((tick) => tick + 1)
    }, COMPARE_LIVE_DIFF_DEBOUNCE_MS)
  }, [])

  useEffect(
    () => () => {
      if (liveCompareRefreshTimer.current) clearTimeout(liveCompareRefreshTimer.current)
    },
    [],
  )

  const diaryActivityTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  // The texts are held and counted once per pause: a word count is a whole-document pass, too dear
  // for every keystroke. `beforeDoc` is the text before the FIRST change of the burst, as before.
  const diaryActivityPending = useRef(new Map<string, { beforeDoc: string; doc: string }>())
  const queueDiaryActivity = useCallback((path: string, beforeDoc: string, doc: string) => {
    const prior = diaryActivityPending.current.get(path)
    diaryActivityPending.current.set(path, { beforeDoc: prior?.beforeDoc ?? beforeDoc, doc })
    const timer = diaryActivityTimers.current.get(path)
    if (timer) clearTimeout(timer)
    diaryActivityTimers.current.set(path, setTimeout(() => {
      diaryActivityTimers.current.delete(path)
      const pending = diaryActivityPending.current.get(path)
      diaryActivityPending.current.delete(path)
      if (!pending) return
      const words = countWords(pending.doc, { excludeCommentLines: true })
      const beforeWords = countWords(pending.beforeDoc, { excludeCommentLines: true })
      void window.writeflex.diary.activity(path, words, undefined, beforeWords)
        .catch((error: unknown) => flashRef.current?.(humanReadableError(error, 'Could not update the Diary.')))
    }, 500))
  }, [])
  useEffect(() => () => {
    for (const timer of diaryActivityTimers.current.values()) clearTimeout(timer)
    diaryActivityTimers.current.clear()
    diaryActivityPending.current.clear()
  }, [])

  const lastWriterEditAt = useRef<string>()
  const handleDocChanged = useCallback(
    (path: string, doc: string, beforeDoc: string) => {
      if (doc !== beforeDoc) dismissFolioNoticeRef.current?.()
      if (doc !== beforeDoc && turnBackUndo.current && (turnBackUndo.current.dir === '' || path.startsWith(`${turnBackUndo.current.dir}/`))) turnBackUndo.current = null
      lastWriterEditAt.current = new Date().toISOString()
      // The owner counts the change (its generation) and holds the latest text where a broken app cannot
      // take it; `dirty` is the dot (the text differs from the baseline). A transaction that left the text
      // to be saved as it was (the writer-review marks settling, a mode switch) is not a change of the
      // document: counted, it would make a saved buffer unsaved with nothing to write, and a main write's
      // route would then refuse to replace it (document-owner plan, parcel 2a).
      const dirty = doc === beforeDoc ? owner.isDirty(path) : owner.edited(path, doc)
      if (doc !== beforeDoc) scratchpadApi.current?.documentChanged()
      if (doc !== beforeDoc) scheduleTitleConflictReadRef.current?.()
      if (dirty) {
        // Only a genuine writer mutation feeds either session tracker. Buffer loads, reloads, agent
        // reconciles, and suggestion acceptance are deliberately silent for Diary capture.
        session.observe(path, doc)
        queueDiaryActivity(path, beforeDoc, doc)
        uncheckpointed.current.add(path) // tier 2: a ⌘S/close checkpoint will snapshot this (ADR-0013)
        queueAutosave(path) // tier 1: no manual save needed
      } else if (!owner.isSaved(path)) {
        // Back at the saved text (an undo), but changed since the last confirmed write (or a write of other
        // text is in flight): written after it, so the disk ends on this text and the owner knows it.
        queueAutosave(path)
      }
      queueLiveCompareRefresh(path)
      if (wikilinkRefreshTimer.current) clearTimeout(wikilinkRefreshTimer.current)
      wikilinkRefreshTimer.current = setTimeout(() => setWikilinkRefreshTick((tick) => tick + 1), 140)
    },
    [owner, session.observe, queueDiaryActivity, queueAutosave, queueLiveCompareRefresh],
  )
  useEffect(() => () => { if (wikilinkRefreshTimer.current) clearTimeout(wikilinkRefreshTimer.current) }, [])

  // Inline status flash (mockup's #statusFlash): a designed message in the status bar for actions
  // whose real surface arrives in a later task. Auto-clears after the mockup's 3.2s window.
  const [status, setStatus] = useState('')
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Folio notices expire independently of the running-order Undo step.
  const [statusAction, setStatusAction] = useState<FlashAction | null>(null)
  const folioNoticeVisible = useRef(false)
  const folioNoticeTimer = useRef<ReturnType<typeof createNoticeTimer> | null>(null)
  if (!folioNoticeTimer.current) folioNoticeTimer.current = createNoticeTimer(() => {
    folioNoticeVisible.current = false; setStatus(''); setStatusAction(null)
  })
  const dismissFolioNotice = useCallback(() => {
    if (!folioNoticeVisible.current) return
    folioNoticeVisible.current = false; folioNoticeTimer.current?.clear()
    setStatus(''); setStatusAction(null)
  }, [])
  dismissFolioNoticeRef.current = dismissFolioNotice
  useEffect(() => { dismissFolioNotice() }, [active, dismissFolioNotice])
  const flash = useCallback((message: string) => {
    folioNoticeVisible.current = false; folioNoticeTimer.current?.clear()
    setStatus(message)
    setStatusAction(null)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setStatus(''), 3200)
  }, [])
  const flashWithAction = useCallback((message: string, action?: FlashAction) => {
    if (!action) { flash(message); return }
    if (flashTimer.current) clearTimeout(flashTimer.current)
    setStatus(message)
    setStatusAction(action)
    folioNoticeVisible.current = action.kind === 'folio-order'
    folioNoticeTimer.current?.clear()
    if (folioNoticeVisible.current) folioNoticeTimer.current?.start()
  }, [flash])
  const sayFolioOrder = useCallback((message: string, action?: FlashAction) => {
    flashWithAction(message, action ? { ...action, kind: 'folio-order' } : undefined)
  }, [flashWithAction])
  flashRef.current = flash
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); folioNoticeTimer.current?.clear() }, [])
  useEffect(() => window.writeflex.onDiaryError((message) => flash(humanReadableError(new Error(message), 'Could not update the Diary.'))), [flash])
  // The example was removed or brought back, in this window or another (ticket 10): the Guide tab leaves
  // the row (it returns first when the example is shown again), main is asked for the context again, and a
  // removal is said once in the status bar of every window that has one (state 31).
  useEffect(() => window.writeflex.onExampleChanged(({ change }) => {
    setGuideOpen(false)
    setRemoveExampleOpen(false)
    setExampleChanges((count) => count + 1)
    if (change === 'removed') flash(REMOVE_EXAMPLE_TEXT.removedFlash)
  }), [flash])
  const restoreExample = useCallback(async (): Promise<{ ok: true } | { ok: false; message: string }> => {
    const result = await window.writeflex.restoreExample()
    return result.ok ? { ok: true } : { ok: false, message: result.message }
  }, [])
  /** The palette's and the Guide's route to restore: a refusal is one sentence in the status bar. */
  const restoreExampleOrSay = useCallback(() => {
    void restoreExample().then((result) => { if (!result.ok) flash(result.message) }, () => flash('The Example collection could not be brought back.'))
  }, [restoreExample, flash])
  // "Open the Guide" (Settings → Get started and the palette). While the example is shown it opens the
  // example's window at 00 Start here.md, as ticket 07 landed it. After removal there is no such window:
  // the Guide opens in this one, last in the tab row, with its history (state 33).
  /** The one way the Guide tab opens in this window: the right pane opens, the tab is added last and selected. */
  const openGuideTab = useCallback(() => {
    setGuideOpen(true)
    openRightTab('guide')
  }, [openRightTab])
  openGuideTabRef.current = openGuideTab
  /** The title-bar Guide button: opens the tab, or closes it when it is the tab showing. */
  const toggleGuideTab = useCallback(() => {
    if (guideOpen && rightTab === 'guide' && !rightPaneCollapsed) {
      setGuideOpen(false)
      openRightTab('agent')
    } else openGuideTab()
  }, [guideOpen, rightTab, rightPaneCollapsed, openGuideTab, openRightTab])
  const openTheGuide = useCallback(() => {
    if (guideContext.shown) {
      // Main opens the example's window at 00 Start here.md and asks that window to open its Guide tab.
      if (guideContext.here) openGuideTab()
      void window.writeflex.openExample('guide').then(refresh, () => {})
    } else openGuideTab()
  }, [guideContext.shown, guideContext.here, refresh, openGuideTab])

  /** While the example is not shown, what would open it says where it went instead. */
  const sayExampleGone = useCallback(() => flash('The Example collection is not on the start screen. Settings → Get started brings it back.'), [flash])
  useEffect(() => window.writeflex.diary.onSessionMessage(flash), [flash])
  useEffect(() => {
    const isInternalDrag = (dataTransfer: DataTransfer): boolean =>
      [...dataTransfer.types].some((type) => type.startsWith('text/writeflex-') || type === 'application/x-writeflex-scrap')
    const droppedPaths = (dataTransfer: DataTransfer): DroppedPath[] => [...dataTransfer.files].map((file) => {
      const entry = [...dataTransfer.items].find((item) => item.kind === 'file' && item.getAsFile()?.name === file.name)?.webkitGetAsEntry?.()
      return { path: (file as File & { path?: string }).path ?? file.name, kind: entry?.isDirectory ? 'directory' : 'file' }
    })
    const preventExternalFileNavigation = (event: DragEvent): void => {
      const transfer = event.dataTransfer
      if (!transfer || isInternalDrag(transfer) || transfer.files.length === 0) return
      // The editor handled it (an image, an SVG, an HTML widget file): not a request to open a workspace.
      if (event.type === 'drop' && event.defaultPrevented) return
      event.preventDefault()
      if (event.type !== 'drop') return
      const result = classifyExternalDrop(droppedPaths(transfer))
      if (!result.openable) { flash(result.reason); return }
      void window.writeflex.openDialog(result.path.path).then(() => refresh())
    }
    window.addEventListener('dragover', preventExternalFileNavigation)
    window.addEventListener('drop', preventExternalFileNavigation)
    return () => {
      window.removeEventListener('dragover', preventExternalFileNavigation)
      window.removeEventListener('drop', preventExternalFileNavigation)
    }
  }, [flash, refresh])

  // Copy (Round B T5, PRD §2). The scope law: the selection if there is one, otherwise the whole
  // document — no dialog, no second command, the selection IS the scope as everywhere else in the
  // app. The clipboard itself is written in the main process, because only it can put RTF, HTML and
  // plain text on the clipboard together, and one flavour is exactly what fails in Teams and Word.
  const copyOut = useCallback(
    async (kind: ClipboardKind) => {
      const selection = editorRef.current?.selectedText() ?? null
      const markdown = selection ?? editorRef.current?.currentDoc() ?? ''
      try {
        // The path travels with the copy so its pictures can be read and carried; without one (no
        // document open) the copy is the same copy, minus the pictures.
        const copied = await window.writeflex.copyToClipboard(markdown, kind, activeRef.current || null)
        flash(`Copied the ${selection === null ? 'document' : 'selection'} as ${copied.label}`)
      } catch (error) {
        // The main process refuses rather than emptying the clipboard, and says how to recover.
        flash(humanReadableError(error, 'Could not copy — the clipboard was left as it was.'))
      }
    },
    [flash],
  )

  const openBoard = useCallback(() => {
    void (async () => {
      // A Board status write must never race an outgoing autosave and later be overwritten by it.
      const current = activeRef.current
      if (current && (await flushPaths([current])).status !== 'saved') {
        flash('Could not save the current Piece — the Board stayed closed.')
        return
      }
      const targetDir = collectionDir ?? (boardActive ? boardDir : current ? await collectionDirFor(current) : activeCollectionDir)
      // A Folio has no Board of its own (ADR-0049): its status lanes are Cards, grouped by status, in the workspace.
      if (await folderIsFolio(targetDir, window.writeflex)) {
        await window.writeflex.folioRoom.setState(targetDir, { view: 'cards', split: false, cardsByStatus: true }).catch(() => undefined)
        if (collectionDir === targetDir) window.dispatchEvent(new CustomEvent(ROOM_VIEW_EVENT, { detail: 'status-lanes' }))
        setSelectedFolderPiece(null)
        setOpenPlanRequested(true)
        setCollectionDir(targetDir)
        return
      }
      setCollectionDir(null)
      setOpenPlanRequested(false)
      setSelectedFolderPiece(null)
      const boardWasOpen = tabsRef.current.includes(BOARD_TAB_ID)
      if (!boardWasOpen || targetDir !== boardDir) {
        boardSeenStatusesRef.current = new Set()
        setBoardDir(targetDir)
        setBoardFilter('')
      }
      openTab(BOARD_TAB_ID)
    })()
  }, [activeCollectionDir, boardActive, boardDir, collectionDir, flash, openTab, flushPaths])

  /** Open the Plan. `folioDir` is the Folio's own folder (the line and title-bar button pass it: a
   *  piece in a sub-folder can belong to a different Collection than the Folio it names). */
  const openPlanIn = useCallback((folioDir?: string) => {
    void (async () => {
      const current = activeRef.current
      if (current && (await flushPaths([current])).status !== 'saved') {
        flash('Could not save the current Piece — the Folio outline stayed closed.')
        return
      }
      // The Folio the open folder or file belongs to, by main's rule (the Outline's): a part in `contents/` opens its Folio.
      const planApi = { folioDirOf: (dir: string) => window.writeflex.readFolioDir(dir), collectionDirFor }
      const targetDir = folioDir ?? (collectionDir !== null
        ? await planDirFor({ folder: collectionDir }, planApi)
        : boardActive ? await planDirFor({ folder: boardDir }, planApi)
          : current ? await planDirFor({ file: current }, planApi)
            : await planDirFor({ folder: activeCollectionDir }, planApi))
      if (boardActive) {
        const editable = lastEditablePath && tabsRef.current.includes(lastEditablePath)
          ? lastEditablePath
          : tabsRef.current.find((path) => !isSurfaceTabId(path)) ?? null
        if (editable) activateTab(editable)
        else close(BOARD_TAB_ID)
      }
      await window.writeflex.folioRoom.setState(targetDir, { view: 'outline', split: false, ...(current ? { selected: { title: '', path: current } } : {}) }).catch(error => { console.warn('Could not remember the Folio view; opening Manage Folio anyway.', error) })
      if (collectionDir === targetDir) window.dispatchEvent(new CustomEvent(ROOM_VIEW_EVENT, { detail: 'outline' }))
      setSelectedFolderPiece(null)
      setOpenPlanRequested(true)
      setCollectionDir(targetDir)
      void requestIdentityLinks.current(targetDir)
    })()
  }, [activeCollectionDir, activateTab, boardActive, boardDir, close, collectionDir, flash, lastEditablePath, flushPaths])
  // The palette and the Board/Collection buttons call this with no argument: the folder is then found as before.
  const openPlan = useCallback(() => openPlanIn(), [openPlanIn])
  const openFolioPlan = useCallback(() => { if (folioPlace) openPlanIn(folioPlace.dir) }, [folioPlace, openPlanIn])
  // All Open Folio entry points share the explicit editor route, including the header's menu.
  const openFolioDir = collectionDir ?? folioPlace?.dir ?? null
  const openFolioAt = useCallback((path: string) => {
    if (openFolioDir === null) return
    borrowedSidebar.current ??= { tab: leftTab, collapsed: leftPaneCollapsed }
    setFolioEditingDir(openFolioDir)
    open(path)
    requestOutline('showFolio')
    void requestIdentityLinks.current(openFolioDir)
  }, [openFolioDir, open, requestOutline, leftTab, leftPaneCollapsed])
  const openFolio = useCallback(() => {
    if (openFolioDir === null) return
    void readFolioOpenParts(openFolioDir).then((parts) => {
      const target = folioOpenTarget(parts)
      if (target === null) flash('This folder is not a Folio with parts to open.')
      else openFolioAt(target)
    })
  }, [openFolioDir, openFolioAt, flash])
  // Running order from the Outline: the writes go through main by path (see main/folio-running-order.ts).
  const [folioRefreshTick, setFolioRefreshTick] = useState(0)
  // Late-bound: the reconciliation with the disk is declared below.
  const reconcileWithDiskRef = useRef<((paths: string[]) => Promise<void>) | null>(null)
  const folioRunningOrder = useFolioRunningOrder({
    say: sayFolioOrder,
    onChangeStart: dismissFolioNotice,
    // The Undo step belongs to the Folio it was made in: this workspace, and the open file's Folio folder
    // (the Outline) or the folder whose Plan is on screen (the Plan's Sort and Add all).
    root: root ?? null,
    openDir: folioPlace?.dir ?? folioEditingDir ?? null,
    planDir: collectionDir,
    // Every open buffer of the Folio (its Index Note and its pieces, active or not) is saved first, and the
    // request then takes its turn in the save queue of each of them, so no save interleaves with it. With the
    // queue held, the buffers are looked at once more in the turn main is asked; see the shared module.
    write: (dir, call) => writeFolioThroughSaveQueue(dir, {
      // Every document the app has a record of (the module keeps the Folio's folder): one with an accept in
      // flight and no tab or dot is waited for and held too (2b round 3 root rule; not tabs and dots).
      open: () => documentsUnder(''),
      // The owner's savedness, not the dot: a buffer undone to its baseline under an unanswered notice is
      // not saved, and the change is refused with the notice's sentence (2b round 3 root rule).
      isSaved: (path) => owner.isSaved(path),
      refusedUnderNotice: (path) => {
        const notice = externalDiskNoticesRef.current.get(path)
        return notice ? changedOnDiskMessage(path, notice.kind) : undefined
      },
      settled: (path) => owner.settled(path),
      save: savePath,
      exclusive: (paths, run) => {
        // From here until main has answered, a save asked for in this Folio is one queued behind this write
        // (the owner holds the files' queues).
        folioWritesInFlight.current.push(dir)
        return owner.exclusive(paths, run).finally(() => {
          const at = folioWritesInFlight.current.indexOf(dir)
          if (at >= 0) folioWritesInFlight.current.splice(at, 1)
        })
      },
      // Still inside the hold: unedited buffers take the new text, an edited one is marked changed on disk.
      afterWrite: async (paths) => { await reconcileWithDiskRef.current?.(paths.filter((path) => !path.includes('://'))) },
    }, call),
    refresh: () => setFolioRefreshTick((tick) => tick + 1),
  })
  requestIdentityLinks.current = folioRunningOrder.openIdentity
  // Title-conflict buttons (2026-10-19). The Plan's and the Outline's fixes are main's writes, with one Undo
  // step (title-conflict-actions.ts); a part open with unsaved edits is refused. The open document's bar edits
  // the buffer instead: one CodeMirror transaction, undone with ⌘Z, never a disk write under the buffer.
  const titleConflictActions = useTitleConflictActions({
    say: flashWithAction,
    unsaved: (path) => owner.isDirty(path) || unsaved.textOf(path) !== undefined,
    // The Undo step is the Folio's it was made in, offered only while that Folio is on screen (as the running order's).
    root: root ?? null,
    openDir: folioPlace?.dir ?? null,
    planDir: collectionDir,
  })
  const [openTitleConflict, setOpenTitleConflict] = useState<{ path: string; conflict: TitleConflict } | null>(null)
  // A title and no heading at the top of the body: no bar (nothing differs), but ⌃⌥⌘T inserts `# Title` at the top.
  const [openTitleInsertablePath, setOpenTitleInsertablePath] = useState<string | null>(null)
  // ✕ on the bar: hidden for this document while the conflict is the same one (`titleConflictKey`).
  const [dismissedTitleConflicts, setDismissedTitleConflicts] = useState<ReadonlyMap<string, string>>(() => new Map())
  const titleConflictTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openDocumentIsPart = folioPlace?.kind === 'piece'
  // A Folio's front matter (a title page) has no heading by design: it never shows the bar (main says which, folio-place.ts).
  const openDocumentIsFrontMatter = folioPlace?.frontMatter === true
  const readOpenTitleConflict = useCallback(() => {
    const path = activeRef.current
    const text = path ? bufferNow(path) : null
    const readable = path && text !== null && !path.includes('://') && !openDocumentIsFrontMatter
    const conflict = readable ? titleConflict(text, path, { part: openDocumentIsPart }) : null
    // A Folio part that does not open with a heading has the waiting "Add the heading" change instead (folio-part-proposals.ts):
    // inserting here as well would leave that change behind to add the heading twice.
    setOpenTitleInsertablePath(readable && !conflict && !openDocumentIsPart && titleHeadingInsertable(text, path, { part: false }) ? path : null)
    setOpenTitleConflict((current) => {
      if (!conflict || !path) return null
      return current && current.path === path && titleConflictKey(current.conflict) === titleConflictKey(conflict) ? current : { path, conflict }
    })
  }, [bufferNow, openDocumentIsPart, openDocumentIsFrontMatter])
  // Read again a moment after typing stops (never per keystroke), and whenever the open file or its Folio place changes.
  const scheduleTitleConflictRead = useCallback(() => {
    if (titleConflictTimer.current) clearTimeout(titleConflictTimer.current)
    titleConflictTimer.current = setTimeout(readOpenTitleConflict, 300)
  }, [readOpenTitleConflict])
  const scheduleTitleConflictReadRef = useRef(scheduleTitleConflictRead)
  scheduleTitleConflictReadRef.current = scheduleTitleConflictRead
  useEffect(() => { readOpenTitleConflict() }, [readOpenTitleConflict, active, loadedFile])
  useEffect(() => () => { if (titleConflictTimer.current) clearTimeout(titleConflictTimer.current) }, [])
  const shownTitleConflict = openTitleConflict && openTitleConflict.path === active && collectionDir === null && !historicalView
    && dismissedTitleConflicts.get(openTitleConflict.path) !== titleConflictKey(openTitleConflict.conflict)
    ? openTitleConflict : null
  const titleHeadingCanBeInserted = openTitleInsertablePath !== null && openTitleInsertablePath === active && collectionDir === null && !historicalView
  /** The bar's fix: the open buffer is changed in one transaction, its own ⌘Z step; autosave writes it as any edit. */
  const fixOpenDocumentTitle = useCallback((direction: TitleFixDirection) => {
    const path = activeRef.current
    const view = editorRef.current?.view()
    if (!path || !view || loadedPath.current !== path) { flash('Open the document first.'); return }
    if (view.state.readOnly) { flash('This document cannot be edited here, so its title was not changed.'); return }
    if (openDocumentIsFrontMatter) { flash('This part is front matter: its title comes from its frontmatter and it has no heading, so there is nothing to match.'); return }
    const doc = view.state.doc.toString()
    const fixed = withTitleFixed(doc, path, direction, { part: openDocumentIsPart })
    if (!fixed.ok) { flash(fixed.message); return }
    let from = 0
    while (from < doc.length && from < fixed.next.length && doc[from] === fixed.next[from]) from += 1
    let tail = 0
    while (tail < doc.length - from && tail < fixed.next.length - from && doc[doc.length - 1 - tail] === fixed.next[fixed.next.length - 1 - tail]) tail += 1
    view.dispatch({
      changes: { from, to: doc.length - tail, insert: fixed.next.slice(from, fixed.next.length - tail) },
      annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.title-conflict')],
    })
    const inserted = direction === 'title-to-heading' && titleConflict(doc, path, { part: openDocumentIsPart }) === null
    readOpenTitleConflict()
    flash(`${direction === 'heading-to-title' ? 'The title now matches the heading.' : inserted ? 'The title is now the heading at the top.' : 'The heading now matches the title.'} ${formatShortcutKey('Mod-z')} undoes it.`)
  }, [flash, openDocumentIsPart, openDocumentIsFrontMatter, readOpenTitleConflict])
  const dismissOpenTitleConflict = useCallback(() => {
    if (!openTitleConflict) return
    const { path, conflict } = openTitleConflict
    setDismissedTitleConflicts((current) => new Map(current).set(path, titleConflictKey(conflict)))
  }, [openTitleConflict])
  const runFolioCommand = useCallback(async (command: 'up' | 'down' | 'add' | 'addAll') => {
    // The row with keyboard focus, read before anything else changes focus.
    const rowEl = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>('[data-fo-path]') : null
    const focused: FocusedFolioRow = rowEl?.dataset.foPath && (rowEl.dataset.kind === 'piece' || rowEl.dataset.kind === 'also') ? { path: rowEl.dataset.foPath, kind: rowEl.dataset.kind } : null
    const path = activeRef.current
    if (!path) { flash('Open a file of a Folio first.'); return }
    const outline = await window.writeflex.readFolioOutline(path)
    if (!outline) { flash('This file is not in a Folio.'); return }
    if (outline.orderInPlanOnly) { flash(ORDER_IN_PLAN_LINE); return }
    const seen = { dir: outline.dir, pieces: outline.pieces }
    if (command === 'addAll') {
      const files = outline.also.filter((file) => file.addable === true).map((file) => ({ path: file.path, title: file.title }))
      if (files.length === 0) { flash(`Every piece that can join ${outline.name} is already in the running order.`); return }
      await folioRunningOrder.addPieces(seen, files)
      return
    }
    // A move stays on its side of the front-matter boundary (ADR-0046).
    const target = command === 'add' ? commandTarget(command, focused, path, outline) : blockCommandTarget(command, focused, path, outline)
    if ('message' in target) { flash(target.message); return }
    if (command === 'add') await folioRunningOrder.addPieces(seen, [{ path: target.path, title: target.title }])
    else await folioRunningOrder.movePiece(seen, target.path, target.beforePath)
  }, [flash, folioRunningOrder])
  // Folio Undo leaves when its step cannot be used in the Folio on screen. Scratchpad Undo owns a
  // durable item and remains available independently of the running order.
  useEffect(() => {
    if (folioRunningOrder.canUndo || titleConflictActions.canUndo || !statusAction || statusAction.kind === 'scratchpad') return
    setStatusAction(null)
    setStatus('')
  }, [folioRunningOrder.canUndo, titleConflictActions.canUndo, statusAction])
  // The Outline's Folder part names how many files it lists: those under the open file's folder (the whole collection for a root file).
  const outlineFolderFileCount = useMemo(() => {
    if (!active) return 0
    const slash = active.lastIndexOf('/')
    const dir = slash === -1 ? '' : active.slice(0, slash)
    return files.filter((file) => dir === '' || file.path.startsWith(`${dir}/`)).length
  }, [active, files])

  const clearExternalDiskNotice = useCallback((path: string) => {
    externalDiskNoticesRef.current.delete(path)
    if (guardRefusalPath.current === path) guardRefusalPath.current = null
    setExternalDiskNotices((current) => {
      if (!current.has(path)) return current
      const next = new Map(current)
      next.delete(path)
      return next
    })
  }, [])
  // The ref is what the save seam reads (writePath): it holds the notice from this turn on, before React renders it.
  const raiseExternalDiskNotice = useCallback((path: string, notice: ExternalDiskNotice) => {
    externalDiskNoticesRef.current.set(path, notice)
    setExternalDiskNotices((current) => new Map(current).set(path, notice))
  }, [])
  // The app renamed or moved a file: its notice (the same object, so a Keep mine on it stays its answer)
  // now stands for the new path, and none is left behind on the old one.
  const moveExternalDiskNotice = useCallback((from: string, to: string) => {
    const notice = externalDiskNoticesRef.current.get(from)
    if (!notice || from === to) return
    clearExternalDiskNotice(from)
    raiseExternalDiskNotice(to, notice)
  }, [clearExternalDiskNotice, raiseExternalDiskNotice])
  // A notice is dropped with its tab. A tab also closes when its file leaves the tree (useTabs prunes it on
  // a removal): once a path is neither open nor listed, its notice must not stop the saves of a file made
  // there later. (A rename's notice has moved on first; the new path is listed before its tab opens.)
  useEffect(() => {
    const listed = new Set(files.map((file) => file.path))
    for (const path of [...externalDiskNoticesRef.current.keys()]) {
      if (!tabs.includes(path) && !listed.has(path)) clearExternalDiskNotice(path)
    }
  }, [tabs, files, clearExternalDiskNotice])

  // The watcher (and a refused save over a clean buffer) asks the owner to apply what is on disk now. It
  // runs in the path's queue, after any route holding it (document-owner.ts); the owner replaces a buffer
  // only when it is saved, and says what the app should raise. `now`: from inside a hold (a Folio
  // running-order write's own reconcile), where queueing behind that hold would wait for itself.
  // What the app raises for the owner's answer to a read of the disk (the watcher's, and a file main
  // returned after writing it: reconcileAppliedFile).
  const raiseForOutside = useCallback((path: string, outcome: OutsideOutcome): void => {
    switch (outcome.kind) {
      case 'skipped': return // activation's own disk read will seed a tab not yet live
      case 'none':
        // Cloud providers may echo WriteFlex's own save long after the watcher's time window. If the
        // bytes already match the live buffer (or its saved baseline), this event is a complete no-op:
        // no editor reconcile, no state replacement, no banner, and no viewport movement.
        clearExternalDiskNotice(path)
        return
      case 'adopted':
        // The disk holds the buffer's own document in another form (or the buffer caught up with it).
        clearExternalDiskNotice(path)
        return
      case 'conflict':
        // Freeze the pending automatic write: the other version stays on disk until the writer
        // explicitly chooses Reload or Keep mine. The same version as the banner already up: that notice
        // stays (a Keep mine clicked on it stays its answer).
        cancelAutosaveFor(path)
        if (!sameDiskNotice(externalDiskNoticesRef.current.get(path), 'changed', outcome.diskText)) {
          raiseExternalDiskNotice(path, { kind: 'changed', dirty: true, diskText: outcome.diskText })
        }
        return
      case 'replaced':
        clearExternalDiskNotice(path)
        setSavedTick((tick) => tick + 1)
        queueLiveCompareRefresh(path)
        return
      case 'removed': {
        cancelAutosaveFor(path)
        // A file gone from disk is a question whether or not the buffer held unsaved text: no automatic
        // write recreates it until the writer chooses Keep mine (reconcile.ts, mayWriteUnderDiskNotice).
        const standing = externalDiskNoticesRef.current.get(path)
        if (!sameDiskNotice(standing, 'removed', null) || (outcome.dirty && !standing?.dirty)) {
          raiseExternalDiskNotice(path, { kind: 'removed', dirty: outcome.dirty, diskText: null })
        }
      }
    }
  }, [cancelAutosaveFor, clearExternalDiskNotice, queueLiveCompareRefresh, raiseExternalDiskNotice])
  // --- Record browser: Source and preview tab, edit from a made widget, undo (ticket 04b) ---------------------
  // The engine writes the widget and its embed line to disk (main, one undoable step) and announces the changed
  // files; the open buffer takes the change through the changed-on-disk path above, so no second copy is inserted.
  // The document is saved first, so the engine starts from the disk's text and a dirty buffer is never overwritten.
  const openWorkbench = useCallback((documentPath: string, recipePath: string | null, caretLine: number | null = null) => {
    void (async () => {
      // Like the Board and the Plan: what the document holds is saved before the tab takes over its place.
      if (tabsRef.current.includes(documentPath) && (await flushPaths([documentPath])).status !== 'saved') {
        flash(`Could not save ${documentPath.split('/').at(-1) ?? documentPath} — the record browser stayed closed.`)
        return
      }
      setWorkbench({ documentPath, recipePath, caretLine })
      open(widgetWorkbenchTabId(documentPath))
    })()
  }, [open, flushPaths, flash])
  const leaveWorkbench = useCallback((documentPath: string) => {
    close(widgetWorkbenchTabId(documentPath))
    setWorkbench((current) => (current?.documentPath === documentPath ? null : current))
    if (tabsRef.current.includes(documentPath)) activate(documentPath)
    else open(documentPath)
  }, [close, activate, open])
  const flushWidgetDocument = useCallback(async (path: string): Promise<{ ok: true } | { ok: false; message: string }> => {
    const name = path.split('/').at(-1) ?? path
    if (tabsRef.current.includes(path)) {
      const flushed = await flushPaths([path])
      if (flushed.status !== 'saved') return { ok: false, message: `${name} could not be saved first, so the widget was not made.` }
    }
    if (owner.isDirty(path) || externalDiskNoticesRef.current.has(path)) return { ok: false, message: `${name} has text that is not saved or a changed-on-disk notice waiting. Answer it in the document, then try again.` }
    return { ok: true }
  }, [flushPaths, owner])
  const newRecordBrowser = useCallback(() => {
    if (active && typeof root === 'string') {
      // The new widget goes in at the caret's line (the engine checks it against the text it writes over).
      const view = editorRef.current?.path() === active ? editorRef.current?.view() : null
      openWorkbench(active, null, view ? view.state.doc.lineAt(view.state.selection.main.head).number : null)
    } else flash('Open a document to put a record browser in it')
  }, [active, root, openWorkbench, flash])
  /** Edit the made widget at the caret (or the one a caption button names). */
  const editRecordBrowser = useCallback((named?: { documentPath: string; rawPath: string }) => {
    const documentPath = named?.documentPath ?? active
    if (!documentPath) { flash('Open a document with a record browser in it'); return }
    let target: ReturnType<typeof embedTarget> = null
    if (named) target = embedTarget(documentPath, `[Simulation: ${named.rawPath}]`)
    else {
      const view = editorRef.current?.view()
      if (view) target = embedTarget(documentPath, view.state.doc.lineAt(view.state.selection.main.head).text)
    }
    if (!target) { flash('Put the cursor on a record browser to edit it'); return }
    openWorkbench(documentPath, target.recipePath)
  }, [active, flash, openWorkbench])
  useEffect(() => {
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<{ documentPath?: string; rawPath?: string }>).detail
      if (detail?.documentPath && detail.rawPath) editRecordBrowser({ documentPath: detail.documentPath, rawPath: detail.rawPath })
    }
    window.addEventListener(EDIT_STANDARD_WIDGET_EVENT, listener)
    return () => window.removeEventListener(EDIT_STANDARD_WIDGET_EVENT, listener)
  }, [editRecordBrowser])
  const undoWidgetStep = useCallback(async () => {
    const step = lastWidgetStepRef.current
    if (!step) { flash('There is no widget step to undo'); return }
    let result: Awaited<ReturnType<typeof window.writeflex.undoStandardWidgetStep>>
    const moved = step.moved ?? []
    const hold = moveHoldRef.current
    if (moved.length > 0 && hold) {
      // Documents the step moved go back: held like a rename (saved first, so the undo compares the disk with what
      // the step wrote), and their buffers follow them back before the hold is let go.
      const wereOpen = moved.map((move) => move.to).filter((path) => tabsRef.current.includes(path))
      const flushed = await hold.withPathsSaved(() => [...new Set([...moved.map((move) => move.to), ...documentsUnder('')])], async () => {
        const answer = await window.writeflex.undoStandardWidgetStep(step.undoId)
        if (answer.ok) for (const back of answer.movedBack) hold.afterMainMoved(back.from, back.to)
        return answer
      })
      if (!flushed) return
      result = flushed.result
      if (result.ok && result.movedBack.length > 0) {
        await refresh()
        for (const back of result.movedBack) if (wereOpen.includes(back.from)) open(back.to)
      }
    } else {
      // What the buffer holds goes to disk first, so the undo compares the disk with what the step wrote.
      if (tabsRef.current.includes(step.documentPath)) await flushPaths([step.documentPath])
      result = await window.writeflex.undoStandardWidgetStep(step.undoId)
    }
    if (!result.ok) { flash(result.message); return }
    setLastWidgetStep(null)
    // A workbench open on the widget just taken out has nothing left to edit.
    if (step.kind === 'create' && workbenchRef.current?.recipePath === step.recipePath) {
      close(widgetWorkbenchTabId(step.documentPath))
      setWorkbench(null)
    }
    flash(step.kind === 'create' ? (moved.length > 0 ? 'Took the record browser back out and put the documents back' : 'Took the record browser back out') : 'Put the widget settings back')
  }, [flash, flushPaths, close, documentsUnder, refresh, open])
  // ⌘Z right after Create, with the keyboard in that document and its undo history where the Create left it (taken
  // as `historyDepth` when the keyboard goes back to the document), takes the widget back out
  // through the engine's undo (the insert came from disk, so it is not in the editor's own history). Every other
  // ⌘Z is the editor's. Capture phase, so the decision is made before CodeMirror's keymap sees the key.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const view = editorRef.current?.view()
      const inEditor = view !== null && view !== undefined && event.target instanceof Node && view.dom.contains(event.target)
      const editor = { inEditor, documentPath: editorRef.current?.path() ?? null, text: inEditor ? view!.state.doc.toString() : '', undoDepth: inEditor ? undoDepth(view!.state) : null }
      if (!undoesWidgetCreate(event, lastWidgetStepRef.current, editor)) return
      event.preventDefault()
      event.stopPropagation()
      void undoWidgetStep()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [undoWidgetStep])

  const reconcileExternalDiskChanges = useCallback(async (paths: string[], options: { now?: boolean } = {}): Promise<void> => {
    await Promise.all(paths.map(async (path) => {
      if (!tabsRef.current.includes(path)) return
      const outcome = await owner.applyOutside(path, async () => (await window.writeflex.readFile(path)).content, options)
      if (!tabsRef.current.includes(path)) return
      raiseForOutside(path, outcome)
    }))
  }, [owner, raiseForOutside])

  reconcileWithDiskRef.current = (paths) => reconcileExternalDiskChanges(paths, { now: true })

  // Main refused a write because the file changed after main read it (an accept's refusal): the owner reads
  // the disk and the writer is asked with the notice, whatever the watcher delivers (it holds events back
  // for a while after a write of ours). Final review round 2, finding 2.
  const askAboutRefusedWrite = useCallback(async (path: string, options: { now: boolean }): Promise<void> => {
    if (!tabsRef.current.includes(path)) return
    const outcome = await owner.refusedOnDisk(path, async () => (await window.writeflex.readFile(path)).content, options)
    if (!tabsRef.current.includes(path)) return
    raiseForOutside(path, outcome)
  }, [owner, raiseForOutside])

  // Main refused a write: the disk no longer holds the version the buffer was based on (its basis). The
  // buffer is kept and the writer is asked, as for any outside change; automatic saves stop. A buffer with
  // nothing unsaved simply takes the disk version, as the watcher would give it.
  // "Nothing unsaved" needs the baseline to be known: after a write of unknown outcome it is not (Sol M2),
  // and the buffer is replaced only by the writer's choice.
  const noteDiskChangedUnderBuffer = useCallback((path: string, diskText: string | null, buffer: string, answering?: ExternalDiskNotice) => {
    cancelAutosaveFor(path)
    const baseline = owner.baselineOf(path)
    if (refusalMayReload({ baseline, buffer, diskUnknown: unsaved.diskIsUnknown(path), answering }) && owner.unchangedSinceSave(path)) {
      void reconcileExternalDiskChanges([path])
      return
    }
    // The notice already up for exactly this disk text stays (a Keep mine clicked on it stays its answer).
    const standing = externalDiskNoticesRef.current.get(path)
    const notice = noticeAfterRefusal(standing, diskText, answering)
    if (notice !== standing) raiseExternalDiskNotice(path, notice)
    const message = diskNoticeRefusalMessage(path, notice)
    refusalReasons.current.set(path, message)
    flash(message)
  }, [owner, cancelAutosaveFor, flash, raiseExternalDiskNotice, reconcileExternalDiskChanges])
  diskChangedUnderBufferRef.current = noteDiskChangedUnderBuffer
  // A write was made and the file read back holds other text: another program wrote it between the
  // commit and the readback. The buffer stays based on what was written, and the writer is asked
  // whether or not the buffer has typing since: their text was replaced on disk without their seeing it.
  const noteOutsideAfterWrite = useCallback((path: string, diskText: string) => {
    cancelAutosaveFor(path)
    if (!sameDiskNotice(externalDiskNoticesRef.current.get(path), 'changed', diskText)) {
      raiseExternalDiskNotice(path, { kind: 'changed', dirty: true, diskText })
    }
    const name = path.split('/').at(-1) ?? path
    const message = `${name} was changed on disk by another program just after it was saved. Choose Reload or Keep mine above the text.`
    guardRefusalPath.current = path // the callers' own "could not save" lines give way to this one
    refusalReasons.current.set(path, message)
    flash(message)
  }, [cancelAutosaveFor, flash, raiseExternalDiskNotice])
  outsideAfterWriteRef.current = noteOutsideAfterWrite
  useEffect(
    () => window.writeflex.onFileChangedOnDisk((paths) => { void reconcileExternalDiskChanges(paths) }),
    [reconcileExternalDiskChanges],
  )

  const reloadExternalDiskVersion = useCallback(async () => {
    const path = activeRef.current
    if (!path) return
    cancelAutosaveFor(path)
    // The writer's choice: the owner replaces the buffer with the disk version, in the path's queue.
    const reloaded = await owner.reload(path, async () => (await window.writeflex.readFile(path)).content)
    if (reloaded.ok) {
      uncheckpointed.current.delete(path)
      clearExternalDiskNotice(path)
      setSavedTick((tick) => tick + 1)
      queueLiveCompareRefresh(path)
      flash(`Reloaded ${path} from disk`)
    } else if (reloaded.reason === 'typed') {
      // Typing after Reload was pressed is kept: nothing replaced, the notice stays up for the new text.
      flash(`${path} was not reloaded: you typed after choosing Reload. Choose Reload or Keep mine again.`)
    } else {
      raiseExternalDiskNotice(path, { kind: 'removed', dirty: owner.isDirty(path), diskText: null })
      flash(`${path} is no longer on disk`)
    }
  }, [owner, cancelAutosaveFor, clearExternalDiskNotice, flash, queueLiveCompareRefresh, raiseExternalDiskNotice])

  // "Keep mine": the writer's choice, and the one write a notice over unsaved text lets through. The
  // buffer goes to disk over the other version, as the answer to the notice that was on screen; the
  // notice goes once that write is made, and stays (with the reason in the status bar) if it is not.
  const keepExternalBuffer = useCallback(async () => {
    const path = activeRef.current
    if (!path) return
    const notice = externalDiskNoticesRef.current.get(path)
    // Keep mine is the writer's explicit choice and is carried out against the notice whatever the dirty
    // dot says now (Sol S5: an undo can clear the dot while the disk holds another version). Only a notice
    // raised over a buffer with nothing unsaved, that still has nothing unsaved, is answered by dismissing it.
    if (keepMineWrites(notice, owner.isDirty(path) || unsaved.textOf(path) !== undefined || !owner.unchangedSinceSave(path))) {
      cancelAutosaveFor(path)
      if (guardRefusalPath.current === path) guardRefusalPath.current = null
      if (!notice || !(await owner.keepMine(path, notice))) {
        if (guardRefusalPath.current !== path) flash(`Could not save ${path.split('/').at(-1) ?? path}. Your version is still only in this tab.`)
        return
      }
      if (externalDiskNoticesRef.current.get(path) !== notice) return // a later outside change: its own notice stands
    }
    clearExternalDiskNotice(path)
    flash(`Kept your version of ${path}`)
  }, [owner, cancelAutosaveFor, clearExternalDiskNotice, flash])

  // The shared overlay guard: while a sheet is up the window's own capture-phase shortcuts stand
  // down (they read isOpenRef below). Reused by Tasks 15/17 for their overlays, and by the Merge sheet.
  const overlay = useOverlayGuard()
  const { active: overlayActive, isOpenRef: overlayOpenRef, open: openOverlay, close: closeOverlay, hold: holdOverlay } = overlay

  // "Merge" (disk-merge.ts): the sheet shows both versions against the one they began from; opening and
  // cancelling it write nothing. Merging keeps exactly the disk version and the writer's (main returns a
  // History receipt for each; with no History nothing is written), writes the writer's over exactly the disk version,
  // then the merged text through the normal save.
  const [diskMerge, setDiskMerge] = useState<DiskMergeSession | null>(null)
  const [diskMergeBusy, setDiskMergeBusy] = useState(false)
  const openDiskMerge = useCallback(() => {
    const path = activeRef.current
    if (!path) return
    const view = editorRef.current?.view()
    // Pending tracked changes (Reviewing) make the editor's text differ from the text that is saved, and
    // the merge is placed into the editor's text: it waits until they are settled.
    if (view && loadedPath.current === path && view.state.doc.toString() !== bufferNow(path)) {
      flash('Settle the tracked changes in this document first, then choose Merge.')
      return
    }
    const session = beginDiskMerge({ path, notice: externalDiskNoticesRef.current.get(path), buffer: bufferNow(path), baseline: owner.baselineOf(path) })
    if (!session) { flash('There is nothing on disk to merge with.'); return }
    cancelAutosaveFor(path)
    setDiskMerge(session)
    // Through the shared overlay guard, as every sheet: it replaces any other overlay, the window's own
    // shortcuts stand down behind it, and an overlay raised over it (⌘, or the palette) dismisses it.
    openOverlay('diskMerge')
  }, [owner, bufferNow, cancelAutosaveFor, flash, openOverlay])
  const cancelDiskMerge = useCallback(() => {
    setDiskMerge(null)
    closeOverlay()
    editorRef.current?.view()?.focus() // back to the text, where the banner still asks
  }, [closeOverlay])
  const runDiskMerge = useCallback(async (session: DiskMergeSession, picks: ConflictPick[]) => {
    setDiskMergeBusy(true)
    // While it writes, the sheet is held up: no other overlay replaces it mid-write.
    holdOverlay(true)
    try {
      const outcome = await applyDiskMerge({
        notice: (p) => externalDiskNoticesRef.current.get(p),
        buffer: bufferNow,
        preserve: (p, text) => window.writeflex.preserveVersion(p, text),
        saved: (p) => ({ editor: owner.baselineOf(p), disk: owner.baselineDiskOf(p) }),
        checkpoint: (p) => window.writeflex.checkpoint(p),
        keepMine: (p, notice) => {
          cancelAutosaveFor(p)
          if (guardRefusalPath.current === p) guardRefusalPath.current = null
          return owner.keepMine(p, notice)
        },
        answered: clearExternalDiskNotice,
        placeMerged: (p, merged) => {
          const view = editorRef.current?.view()
          if (!view || activeRef.current !== p || loadedPath.current !== p || view.state.readOnly) return false
          const doc = view.state.doc.toString()
          if (doc !== bufferNow(p)) return false // tracked changes appeared meanwhile
          const change = minimalReplace(doc, merged)
          if (change) {
            view.dispatch({ changes: change, annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.merge')] })
          }
          return true
        },
        save: (p) => savePath(p),
      }, session, picks)
      if (outcome.kind === 'merged') {
        uncheckpointed.current.delete(session.path)
        queueLiveCompareRefresh(session.path)
      }
      holdOverlay(false)
      if (outcome.kind !== 'unresolved') {
        setDiskMerge(null)
        closeOverlay()
        editorRef.current?.view()?.focus()
      }
      const message = diskMergeMessage(session.path, outcome)
      if (message) flash(message)
    } finally {
      holdOverlay(false)
      setDiskMergeBusy(false)
    }
  }, [owner, bufferNow, cancelAutosaveFor, clearExternalDiskNotice, closeOverlay, flash, holdOverlay, queueLiveCompareRefresh, savePath])
  // The sheet answers one document's notice: it closes when that tab is no longer the one shown.
  // It closes too when the disk moves again under it (a newer notice): the merge it shows is out of date.
  // Another overlay raised over it (⌘, or the palette) replaced it in the shared guard: it is dismissed,
  // as Cancel would (nothing written).
  useEffect(() => {
    if (!diskMerge || diskMergeBusy) return
    if (overlayActive !== 'diskMerge') { setDiskMerge(null); return }
    if (active !== diskMerge.path) { setDiskMerge(null); closeOverlay(); return }
    if (externalDiskNotices.get(diskMerge.path) !== diskMerge.notice) {
      setDiskMerge(null)
      closeOverlay()
      flash(`${diskMerge.path.split('/').at(-1) ?? diskMerge.path} changed on disk again while you were merging, so nothing was written. Choose Merge again to see the newer version.`)
    }
  }, [active, closeOverlay, diskMerge, diskMergeBusy, externalDiskNotices, flash, overlayActive])

  // ── Change Ledger dock (Task 4) ──────────────────────────────────────────────────────────────
  // The dock lists the ACTIVE document's changes; reload when the document changes or main pushes
  // `changes:changed` (agent ingest, accept/reject). A doc switch clears the linked selection.
  const reloadChanges = useCallback(async (): Promise<Change[]> => {
    const path = active // capture: the loaded list is tagged with the file it was fetched for
    if (!path) {
      setChanges([])
      setChangesPath(null)
      return []
    }
    try {
      const list = await window.writeflex.listChanges({ path })
      if (activeRef.current !== path) return [] // a newer switch won mid-flight: drop this stale response
      setChanges(list)
      setChangesPath(path)
      return list
    } catch {
      if (activeRef.current !== path) return []
      setChanges([])
      setChangesPath(null)
      return []
    }
  }, [active])
  const reloadVersions = useCallback(async (): Promise<Version[]> => {
    const path = active
    if (!path) {
      setVersions([])
      return []
    }
    try {
      const [list, attachments, attachmentUndo, waiting] = await Promise.all([
        window.writeflex.listVersions({ path }),
        window.writeflex.historyAttachmentSuggestions(path).catch(() => []),
        window.writeflex.historyAttachmentUndo(path).catch(() => null),
        window.writeflex.waitingVersionHistory().catch(() => []),
      ])
      if (activeRef.current !== path) return []
      setVersions(list)
      setWaitingHistory(waiting)
      setHistoryAttachments(attachments)
      setHistoryAttachmentUndo(attachmentUndo ? { path, ...attachmentUndo } : null)
      return list
    } catch {
      if (activeRef.current === path) setVersions([])
      return []
    }
  }, [active])
  useEffect(() => {
    // Clear synchronously on a switch so the dock never shows the previous file's cards during the async
    // reload; reloadChanges repopulates for the new active (and drops any stale in-flight response).
    setHistoricalView(null)
    reviewCursorRef.current?.sync([], '')
    setChanges([])
    setChangesPath(null)
    setVersions([])
    setWaitingHistory([])
    setHistoryAttachments([])
    setVersionCompare(null)
    setVersionCompareError('')
    void reloadChanges()
    void reloadVersions()
  }, [reloadChanges, reloadVersions])
  useEffect(() => window.writeflex.onChangesChanged(() => void reloadChanges()), [reloadChanges])
  useEffect(() => window.writeflex.onVersionsChanged(() => void reloadVersions()), [reloadVersions])

  const restageAgentNote = useCallback(async (note: AgentObjectNote): Promise<void> => {
    const sourceDocument = activeRef.current
    const point = editorRef.current?.insertionPoint()
    if (!sourceDocument || !point) {
      flash('Open a document and place the cursor before restaging an agent object')
      return
    }
    try {
      await window.writeflex.agentNotes.restage(note.path, { sourceDocument, ...point })
      await reloadChanges()
      flash(`Restaged ${note.kind} object at the cursor`)
    } catch (error) {
      flash(humanReadableError(error, 'Could not restage this agent object'))
    }
  }, [flash, reloadChanges])

  // The Drafting/Reviewing writer-mode domain (per-file mode, debounced ledger flush, the Drafting fold)
  // lives in its own hook; `ledger: window.writeflex` is its one Bridle-facing binding.
  const {
    writerMode,
    setWriterMode,
    modeForFile,
    flushWriterChanges,
    onWriterReviewChanged,
    changeWriterMode,
    startNewSession,
    openedAtForFile,
    currentSessionIdForFile,
    cancelPendingFlush,
    flushWriterChangesNow,
    writerChangesIdle,
    clearFileWriterState,
    recordedWriterChanges,
  } = useWriterMode({
    ledger: window.writeflex,
    active,
    activeRef,
    root,
    editorRef,
    reloadChanges,
    flash,
  })

  const reviewSkillChanges = useCallback(() => {
    changeWriterMode('reviewing')
    runMarginCommand('focus')
    setSkillToast(null)
  }, [changeWriterMode, runMarginCommand])
  const dismissSkillToast = useCallback(() => setSkillToast(null), [])
  const openSkillNotes = useCallback((path: string) => {
    setSkillToast(null)
    open(path)
  }, [open])
  const exitHistoricalView = useCallback(() => {
    if (!historicalView) return
    returnToCurrent(historicalView)
    editorRef.current?.exitHistorical()
    setHistoricalView(null)
    flash('Returned to current document')
  }, [historicalView, flash])
  const viewVersion = useCallback(
    (version: Version) => {
      void (async () => {
        if (!active || loadedPath.current !== version.path) {
          flash('Open the document before viewing its history.')
          return
        }
        const result = await window.writeflex.versionContent({ id: version.id })
        if (!result || result.content === null) {
          flash(`Could not read “${version.name}” from history.`)
          return
        }
        const liveContent = editorRef.current?.currentDoc() ?? ''
        const view = enterHistoricalView({
          version,
          historicalContent: result.content,
          liveContent,
        })
        reviewCursorRef.current?.sync([], '')
        setHistoricalView(view)
        editorRef.current?.enterHistorical(version.path, view.displayContent)
        flash(`Viewing “${version.name}” read-only`)
      })()
    },
    [active, flash],
  )
  // Task 3 branches the exact live session into Reviewing and every older session into read-only recall.
  const viewSession = useCallback((session: SessionSummary): void => {
    void (async () => {
      const path = active
      if (!path || loadedPath.current !== path) {
        flash('Open the document before viewing its session history.')
        return
      }
      if (sessionRecallKind(session, currentSessionIdForFile(path)) === 'current') {
        if (historicalView) {
          editorRef.current?.exitHistorical()
          setHistoricalView(null)
        }
        changeWriterMode('reviewing')
        return
      }

      const ledgerRecords = await window.writeflex.listChanges({ path })
      if (activeRef.current !== path) return
      const records = ledgerRecords
        .filter((change) =>
          change.provenance === 'writer' &&
          change.editClass !== 'copy' &&
          change.sessionId === session.sessionId,
        )
        .map((change) => {
          const attributed = change as Change & Partial<Pick<AttributedChange, 'compareOldText' | 'compareNewText'>>
          return {
            localId: change.id,
            oldText: attributed.compareOldText ?? change.oldText,
            newText: attributed.compareNewText ?? change.newText,
            anchor: change.anchor ?? { from: -1, to: -1 },
            createdAt: change.ts,
          }
        })

      const liveContent = editorRef.current?.currentDoc() ?? ''
      let historicalContent = liveContent
      let version: Version | null = null
      if (session.versionStamp !== null) {
        const result = await window.writeflex.versionContent({
          versionId: session.versionStamp,
          snapshotId: session.versionStamp,
          path,
        })
        if (activeRef.current !== path) return
        if (!result || result.content === null) {
          flash('Could not read this session from history.')
          return
        }
        historicalContent = result.content
        version = result.version
      }

      const view = enterSessionHistoricalView({
        session,
        path,
        historicalContent,
        liveContent,
        records,
        version,
      })
      reviewCursorRef.current?.sync([], '')
      setHistoricalView(view)
      editorRef.current?.enterSessionRecall(path, view.displayContent, view.records)
      flash('Viewing a past session read-only')
    })()
  }, [active, changeWriterMode, currentSessionIdForFile, flash, historicalView])
  // Restore a version as the open document (Muse M2): like every editor write it replaces only the version
  // the buffer is based on. The buffer is flushed first through the guarded save (a standing notice or a
  // refusal stops the restore, and the writer is told why); the restore then carries that baseline as its
  // basis, and main compares it before the pre-restore checkpoint and again at the rename. Text typed
  // while the restore ran is not replaced: the restored version is then an outside change to it.
  const restoreVersionOverBuffer = useCallback(async (path: string, request: { id: string; snapshotId?: string }, name: string): Promise<boolean> => {
    cancelAutosaveFor(path)
    if (guardRefusalPath.current === path) guardRefusalPath.current = null
    // A route of the document owner (parcel 2a): the buffer is written until saved, and the restore runs
    // holding the document's queue, so no save of it interleaves. The basis is the baseline the flush
    // left, read in the turn of its last check (Sol M1, round 2); the buffer takes the restored text only
    // from the restore's own receipt, and only when nothing was typed while it ran.
    type Restored = { kind: 'failed' } | { kind: 'refused'; diskText: string | null } | { kind: 'restored'; outcome: MainWriteOutcome }
    const flushed = await owner.withFlushed([path], async (snapshots): Promise<Restored> => {
      const snapshot = snapshots.get(path)!
      const result = await window.writeflex.restoreVersion({ ...request, basis: basisFromBaseline(snapshot.baselineDisk) })
      if (!result) return { kind: 'failed' }
      if ('refused' in result) return { kind: 'refused', diskText: result.diskText }
      return { kind: 'restored', outcome: owner.replaceFromMain(path, result, { since: snapshot.gen, mode: 'replace' }) }
    })
    if (flushed.status !== 'acted') {
      const reason = guardRefusalPath.current === path ? refusalReasons.current.get(path) : undefined
      const fallback = flushed.status === 'still-unsaved'
        ? `${path.split('/').at(-1) ?? path} was still being edited while it was saved.`
        : `Could not save ${path.split('/').at(-1) ?? path} first.`
      flash(`“${name}” was not restored. ${reason ?? fallback}`)
      return false
    }
    const done = flushed.result
    if (done.kind === 'failed') {
      flash(`Could not restore “${name}”.`)
      return false
    }
    if (done.kind === 'refused') {
      const buffer = bufferNow(path)
      if (buffer !== null) noteDiskChangedUnderBuffer(path, done.diskText, buffer)
      flash(`“${name}” was not restored: ${path.split('/').at(-1) ?? path} changed on disk. Choose Reload or Keep mine above the text.`)
      return false
    }
    if (done.outcome.kind === 'moved') {
      // Typing arrived while the restore ran: kept, and asked about against the restored version.
      cancelAutosaveFor(path)
      raiseExternalDiskNotice(path, { kind: 'changed', dirty: true, diskText: done.outcome.diskText })
      return true
    }
    // The owner raised the banner for a readback that is not the receipt; otherwise the buffer is the restore.
    if (done.outcome.kind !== 'outside') clearExternalDiskNotice(path)
    return true
  }, [owner, bufferNow, cancelAutosaveFor, clearExternalDiskNotice, flash, noteDiskChangedUnderBuffer, raiseExternalDiskNotice])
  const restoreHistoricalVersion = useCallback(() => {
    void (async () => {
      if (!historicalView || historicalView.kind !== 'version') return
      if (!window.confirm(`Restore “${historicalView.version.name}” as the current document?`)) return
      const restore = restoreHistoricalView(historicalView)
      // The live buffer (kept aside while the view shows the past) is what the flush writes.
      editorRef.current?.exitHistorical()
      setHistoricalView(null)
      const restored = await restoreVersionOverBuffer(
        restore.path,
        { id: restore.versionId, ...(restore.snapshotId ? { snapshotId: restore.snapshotId } : {}) },
        historicalView.version.name,
      )
      if (!restored) return
      uncheckpointed.current.delete(restore.path)
      setSavedTick((n) => n + 1)
      agent.noteUserSave()
      await reloadChanges()
      await reloadVersions()
      flash(`Restored “${historicalView.version.name}”`)
    })()
  }, [historicalView, flash, restoreVersionOverBuffer, agent.noteUserSave, reloadChanges, reloadVersions])
  // Restore straight from a version row — the same flow as the view banner's Restore, without
  // requiring the read-only view first (walk find 2026-07-11: "no restore on old versions").
  const restoreVersionFromRow = useCallback(
    (version: Version) => {
      void (async () => {
        if (!active || loadedPath.current !== version.path) {
          flash('Open the document before restoring a version.')
          return
        }
        if (!window.confirm(`Restore “${version.name}” as the current document?`)) return
        if (historicalView) {
          editorRef.current?.exitHistorical()
          setHistoricalView(null)
        }
        const restored = await restoreVersionOverBuffer(
          version.path,
          { id: version.id, ...(version.snapshotId ? { snapshotId: version.snapshotId } : {}) },
          version.name,
        )
        if (!restored) return
        uncheckpointed.current.delete(version.path)
        setSavedTick((n) => n + 1)
        agent.noteUserSave()
        await reloadChanges()
        await reloadVersions()
        flash(`Restored “${version.name}”`)
      })()
    },
    [active, flash, historicalView, restoreVersionOverBuffer, agent.noteUserSave, reloadChanges, reloadVersions],
  )
  const compareVersionRange = useCallback(
    (fromId: VersionCompareEndpointId, toId: VersionCompareEndpointId) => {
      void (async () => {
        if (!active) return
        setVersionCompareLoading(true)
        setVersionCompareError('')
        try {
          const result = await window.writeflex.compareVersions({
            path: active,
            fromId,
            toId,
            currentContent: editorRef.current?.currentDoc(),
          })
          if (activeRef.current !== active) return
          setVersionCompare(result)
        } catch (error) {
          if (activeRef.current !== active) return
          setVersionCompare(null)
          setVersionCompareError(error instanceof Error ? error.message : 'Could not compare these versions.')
        } finally {
          if (activeRef.current === active) setVersionCompareLoading(false)
        }
      })()
    },
    [active],
  )
  useEffect(() => {
    if (!compareView) return
    compareVersionRange(compareView.fromId, compareView.toId)
  }, [compareView, compareVersionRange])
  useEffect(() => {
    if (!compareView || compareView.toId !== 'working' || liveCompareRefreshTick === 0) return
    compareVersionRange(compareView.fromId, compareView.toId)
  }, [compareView, compareVersionRange, liveCompareRefreshTick])
  useEffect(() => {
    if (!compareView || !compareToEditable || !versionCompare) {
      editorRef.current?.setCompareHighlights({ marks: [] })
      return
    }
    const doc = editorRef.current?.view()?.state.doc.toString() ?? versionCompare.toContent
    editorRef.current?.setCompareHighlights(compareHighlightsForEditor(versionCompare.changes, doc))
  }, [compareView, compareToEditable, versionCompare])
  const openCompareView = useCallback(
    (fromId: VersionCompareEndpointId, toId: VersionCompareEndpointId) => {
      if (!active) {
        flash('Open a document before comparing versions.')
        return
      }
      if (historicalView) {
        returnToCurrent(historicalView)
        editorRef.current?.exitHistorical()
        setHistoricalView(null)
      }
      setVersionCompare(null)
      setVersionCompareError('')
      setCompareView({ fromId, toId })
    },
    [active, flash, historicalView],
  )
  const closeCompareView = useCallback(() => {
    setCompareView(null)
    setVersionCompare(null)
    setVersionCompareError('')
    editorRef.current?.view()?.focus()
  }, [])
  const setCompareFrom = useCallback((fromId: VersionCompareEndpointId) => {
    setCompareView((current) => current ? { ...current, fromId } : current)
  }, [])
  const setCompareTo = useCallback((toId: VersionCompareEndpointId) => {
    setCompareView((current) => current ? { ...current, toId } : current)
  }, [])
  const swapCompareView = useCallback(() => {
    setCompareView((current) => current ? { fromId: current.toId, toId: current.fromId } : current)
  }, [])
  const getEditableCompareToScrollElement = useCallback(() => editorRef.current?.view()?.scrollDOM ?? null, [])
  useEffect(() => {
    if (!active && compareView) closeCompareView()
  }, [active, closeCompareView, compareView])
  const renameVersion = useCallback(
    (id: string, name: string) => {
      void (async () => {
        try {
          await window.writeflex.renameVersion(id, name)
          await reloadVersions()
          setVersionCompare(null)
          flash(`Renamed version “${name.trim()}”`)
        } catch (error) {
          flash(error instanceof Error ? error.message : 'Could not rename that version.')
        }
      })()
    },
    [flash, reloadVersions],
  )
  const toggleHideStrikes = useCallback(() => setHideStrikes((v) => !v), [])
  const toggleHideInserts = useCallback(() => setHideInserts((v) => !v), [])
  const selectChange = useCallback((id: string) => { reviewCursorRef.current?.select(id) }, [])
  // Ticket 09 (from 01): stepping puts DOM focus in the card, so the caret leaves the text and A / D / R act at once;
  // Esc gives the caret back. The card may not be drawn for a frame or two (a piece opening, a mode changing), so ask
  // a few times before giving up.
  const focusCardSoon = useCallback((id: string | null, tries = 4) => {
    if (id === null) return
    window.requestAnimationFrame(() => {
      if (marginControlRef.current?.focusCard(id)) return
      if (tries > 1) focusCardSoon(id, tries - 1)
    })
  }, [])
  const showChangeInText = useCallback((id: string) => {
    reviewCursorRef.current?.select(id)
    restoreEditorFocus()
  }, [restoreEditorFocus])
  const settleReviewChange = useCallback((id: string, advance: boolean) => {
    reviewCursorRef.current?.settle(id, advance)
  }, [])
  // The review actions (accept/reject/revise/inline) come from useReviewActions, bound lower down after
  // acceptSuggestion/rejectSuggestion exist — a change backed by a live suggestion routes through that
  // proven apply-and-reconcile path (which refreshes the editor buffer, flashes, arms undo), not a
  // status-only move.

  // The document end of the link: the quiet marks in the text (ticket 13) are pushed by the review margin
  // itself (components/ReviewMargin.tsx), which knows the filter, the marker numbers and the focused card.

  // Pending agent changes go to the editor's inline layer as data (where each proposal sits: the keymap,
  // live preview and the "could not be placed" flag read it). Since ticket 13 it draws no struck or inserted
  // words in the prose; an agent's proposed object is the one thing still staged over its render (ADR-0024).
  // The dock shows the ACTIVE file's changes, gated at RENDER (not an effect) on the path the list belongs
  // to — so a tab switch can't paint the previous file's cards for a frame before the reload resettles.
  // Rejected-but-unstamped changes stay in the list: the review pane folds them away with a Reopen
  // action (a mis-click must not be a one-way door). Everything that acts on the run filters to
  // pending itself, so nothing acts on a rejected record by accident.
  const dockChanges = useMemo(
    () => (changesPath === active ? changes.filter((change) => !change.snapshotId) : []),
    [changes, changesPath, active],
  )
  useEffect(() => {
    reviewCursorRef.current?.sync(dockChanges, editorRef.current?.currentDoc() ?? '')
  }, [dockChanges, loadedFile])

  // Changes from outside (command line, locked dock design 2026-10-07): the margin also lists the
  // outside changes of OTHER documents, the ledger's counts, the arrival notice and the writer's
  // dismissed "could not be applied" records. `dockChanges` stays the open document's list, so every
  // run action below (accept all, discard, by kind, the keys) acts on the open document only.
  const outsideDock = useOutsideDock(active, root, sidebarFolioDir)
  const dismissedNotApplied = useDismissedNotApplied(root)
  // A card for a document that is not open: open it, then select the change once its list has loaded.
  const changeToSelectOnLoad = useRef<string | null>(null)
  const openChangeAt = useCallback((change: Change) => {
    changeToSelectOnLoad.current = change.id
    open(change.path)
  }, [open])
  useEffect(() => {
    const id = changeToSelectOnLoad.current
    if (!id || loadedFile !== active || !dockChanges.some((change) => change.id === id)) return
    changeToSelectOnLoad.current = null
    reviewCursorRef.current?.select(id)
  }, [dockChanges, loadedFile, active])
  const rejectOutside = useCallback((which: Parameters<typeof window.writeflex.rejectOutsideChanges>[0]) => {
    void window.writeflex.rejectOutsideChanges(which).then(
      ({ rejected }) => flash(`Rejected ${rejected} change${rejected === 1 ? '' : 's'}`),
      (error) => flash(error instanceof Error ? error.message : 'Could not reject those changes.'),
    )
  }, [flash])
  // The margin's outside rows (ticket 04): waiting items in other pieces, the arrival "Show", and the next piece.
  const waitingElsewhere = useMemo(() => outsideDock.others.filter((change) => change.status === 'pending' || change.status === 'held'), [outsideDock.others])
  // The margin's filter (the head's state), owned here so the status bar's All / Comments / Edits and the head's own
  // Kind chips drive one value. It starts clean for each piece.
  const [marginFilterState, setMarginFilterState] = useState<HeadFilterState>(EMPTY_HEAD_FILTER)
  useEffect(() => { setMarginFilterState(EMPTY_HEAD_FILTER) }, [active])
  // Ticket 04: the cards picked for a bulk action (Space or ⌘-click on a card), owned here so the status bar's
  // "N selected · Accept · Decline · Clear" and ⇧⌘A / ⇧⌘⌫ act on them. A new piece starts with none.
  const [pickedCards, setPickedCards] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => { setPickedCards((current) => (current.size === 0 ? current : new Set())) }, [active])
  // The agent's items sent back with a note: their cards say Sent back until they are settled (renderer memory only).
  const [sentBackIds, setSentBackIds] = useState<ReadonlySet<string>>(() => new Set())
  // The Decline all confirmation or the Send back popover over the review line. Decline holds the ids it asked about.
  const [reviewAskState, setReviewAskState] = useState<{ kind: 'decline'; ids: string[]; question: DeclineQuestion; whole?: boolean } | { kind: 'send-back'; scope: SendBackScope } | null>(null)
  // Ticket 06 (from 14): Accepts main refused because the change could not be placed. The item still waits; its card says
  // Could not be applied, with the reason, until the writer declines it or the text changes (then Accept is offered again).
  const [refusedAccepts, setRefusedAccepts] = useState<ReadonlyMap<string, { reason: string; doc: string | null }>>(() => new Map())
  const refusedDocRef = useRef<string | null>(null)
  refusedDocRef.current = snapshot?.docText ?? null
  const noteAcceptRefused = useCallback((id: string, reason: string) => {
    setRefusedAccepts((current) => new Map(current).set(id, { reason, doc: refusedDocRef.current }))
  }, [])
  useEffect(() => {
    if (refusedAccepts.size === 0) return
    const doc = snapshot?.docText ?? null
    const waiting = new Set(dockChanges.filter((change) => change.status === 'pending' || change.status === 'held').map((change) => change.id))
    const kept = [...refusedAccepts].filter(([id, entry]) => waiting.has(id) && entry.doc === doc)
    if (kept.length !== refusedAccepts.size) setRefusedAccepts(new Map(kept))
  }, [refusedAccepts, dockChanges, snapshot?.docText])
  const refusedReasons = useMemo(() => new Map([...refusedAccepts].map(([id, entry]) => [id, entry.reason])), [refusedAccepts])
  // The edits this review pass is working through, for "M of N settled".
  const [reviewBatch, setReviewBatch] = useState<ReviewBatch>(EMPTY_BATCH)
  const marginFilter = marginFilterState.filter
  // Ticket 08: Settled today and My edits are modes held in the margin's filter state. Items reopened while Settled today
  // is on stay in it as Open cards ("waiting again"); leaving the mode or opening another piece forgets them.
  const reviewMode: ReviewMode = reviewModeOf(marginFilterState)
  const [waitingAgainState, setWaitingAgainState] = useState<{ key: string | null; seen: ReadonlySet<string>; again: ReadonlySet<string> }>(() => ({ key: null, seen: new Set(), again: new Set() }))
  const waitingAgain = reviewMode === 'settled' && waitingAgainState.key === active ? waitingAgainState.again : EMPTY_ID_SET
  // The status bar's review line is drawn from the same model the margin builds (same filter, same Yours / quiet-fix switches).
  // The four models below read the same text; they find each change's words in it once (ticket 16).
  const reviewResolver = useMemo(() => makeAnchorResolver(snapshot?.docText ?? ''), [snapshot?.docText])
  const reviewModels = useMemo(() => {
    if (active === null || collectionDir !== null) return null
    const common = { resolver: reviewResolver, changes: dockChanges, document: snapshot?.docText ?? '', view: 'margin' as const, showOwnEdits: marginFilterState.showOwnEdits, showQuietFixes: marginFilterState.showQuiet, others: waitingElsewhere, dismissedIds: dismissedNotApplied.ids }
    const shown = buildMarginModel({ ...common, selectedId: selectedChangeId, filter: marginFilter, mode: reviewMode, waitingAgain })
    return {
      shown,
      unfiltered: buildMarginModel({ ...common }),
      kinds: buildMarginModel({ ...common, filter: withoutKinds(marginFilter) }),
      // What review would show, for the counts beside Settled today, My edits and Show quiet fixes while a mode is on.
      review: reviewMode === 'review' ? shown : buildMarginModel({ ...common, showOwnEdits: false, filter: {} }),
    }
  }, [active, collectionDir, reviewResolver, dockChanges, snapshot?.docText, waitingElsewhere, dismissedNotApplied.ids, marginFilterState.showOwnEdits, marginFilterState.showQuiet, marginFilter, selectedChangeId, reviewMode, waitingAgain])
  useEffect(() => {
    if (reviewMode !== 'settled' || !reviewModels) {
      setWaitingAgainState((current) => (current.key === null && current.seen.size === 0 ? current : { key: null, seen: EMPTY_ID_SET, again: EMPTY_ID_SET }))
      return
    }
    const settledIds = [...reviewModels.review.settledToday, ...reviewModels.review.quietApplied].map((change) => change.id)
    setWaitingAgainState((current) => {
      const base = current.key === active ? current : { key: active, seen: EMPTY_ID_SET, again: EMPTY_ID_SET }
      const next = trackWaitingAgain(base, settledIds, dockChanges)
      return next.seen === base.seen && next.again === base.again && base === current ? current : { key: active, ...next }
    })
  }, [reviewMode, reviewModels, dockChanges, active])
  // A picked card that was settled or that a filter hid drops out of the pick.
  useEffect(() => {
    if (!reviewModels || pickedCards.size === 0) return
    const kept = visibleSelection(reviewModels.shown, pickedCards)
    if (kept.length !== pickedCards.size) setPickedCards(new Set(kept))
  }, [reviewModels, pickedCards])
  // A settled item is no longer Sent back.
  useEffect(() => {
    if (sentBackIds.size === 0) return
    const settled = new Set(dockChanges.filter((change) => change.status !== 'pending' && change.status !== 'held').map((change) => change.id))
    if ([...sentBackIds].some((id) => settled.has(id))) setSentBackIds(new Set([...sentBackIds].filter((id) => !settled.has(id))))
  }, [dockChanges, sentBackIds])
  const batchWaiting = useMemo(() => (reviewModels ? waitingEditIds(reviewModels.unfiltered) : []), [reviewModels])
  useEffect(() => { setReviewBatch((batch) => nextBatch(batch, active, batchWaiting)) }, [active, batchWaiting])
  const statusReview = useMemo(() => {
    if (!reviewModels) return null
    if (reviewMode === 'settled') {
      const again = reviewModels.shown.cards.length + reviewModels.shown.unplaced.length
      return reviewLine({ waiting: 0, shown: 0, filtered: false, kind: 'all', counts: { all: 0, comments: 0, edits: 0 }, position: null, newCount: 0, otherPieces: 0, mode: { kind: 'settled', settled: reviewModels.shown.settled.length + again, again } })
    }
    if (reviewMode === 'mine') {
      return reviewLine({ waiting: 0, shown: 0, filtered: false, kind: 'all', counts: { all: 0, comments: 0, edits: 0 }, position: null, newCount: 0, otherPieces: 0, mode: { kind: 'mine', recorded: reviewModels.shown.counts.shown, others: reviewModels.shown.othersWaiting } })
    }
    const pickedShown = visibleSelection(reviewModels.shown, pickedCards).length
    return reviewLine({
      picked: pickedShown,
      acceptable: pickedShown > 0 ? 0 : runTargets(reviewModels.shown, pickedCards, marginFilter, 'accept').edits,
      batch: reviewBatch.key === active ? batchProgress(reviewBatch, batchWaiting) : null,
      waiting: reviewModels.unfiltered.counts.shown,
      shown: reviewModels.shown.counts.shown,
      filtered: !isUnfiltered(marginFilter),
      kind: kindSegmentOf(marginFilter),
      counts: { all: reviewModels.kinds.counts.shown, comments: reviewModels.kinds.counts.byKind.note, edits: reviewModels.kinds.counts.byKind.edit },
      position: reviewModels.shown.position,
      newCount: outsideDock.arrived.length,
      otherPieces: reviewModels.unfiltered.otherPieces.length,
      who: whoChipLabel(marginFilter, reviewModels.unfiltered),
      notPlaced: reviewModels.unfiltered.notPlaced.length,
    })
  }, [reviewModels, marginFilter, outsideDock.arrived.length, pickedCards, reviewBatch, batchWaiting, active, reviewMode])
  // Next / previous step through what the margin shows; with a filter on, the cursor is told which ids those are.
  const shownReviewIds = useMemo(() => (reviewModels ? shownIds(reviewModels.shown, marginFilter) : null), [reviewModels, marginFilter])
  useEffect(() => { reviewCursorRef.current?.setShown(shownReviewIds) }, [shownReviewIds])
  const shownReviewIdsRef = useRef(shownReviewIds)
  shownReviewIdsRef.current = shownReviewIds
  const setReviewKind = useCallback((segment: KindSegment, toggle: boolean) => {
    setMarginFilterState((state) => ({ ...state, filter: withKindSegment(state.filter, segment, toggle) }))
  }, [])
  const waitingCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const change of [...dockChanges, ...waitingElsewhere]) {
      if (change.outsideSource && (change.status === 'pending' || change.status === 'held')) counts[change.path] = (counts[change.path] ?? 0) + 1
    }
    return counts
  }, [dockChanges, waitingElsewhere])
  const openPieceAt = useCallback((path: string, firstId: string) => {
    changeToSelectOnLoad.current = firstId
    open(path)
  }, [open])
  const nextPieceWithItems = useCallback(() => {
    const paths = [...new Set(waitingElsewhere.map((change) => change.path))].sort()
    if (paths.length === 0) { flash('Nothing is waiting in other pieces'); return }
    const path = paths.find((candidate) => active === null || candidate > active) ?? paths[0]
    const first = waitingElsewhere.find((change) => change.path === path)
    if (first) openPieceAt(path, first.id)
  }, [waitingElsewhere, active, openPieceAt, flash])
  const showArrivedInMargin = useCallback(() => {
    const first = outsideDock.arrived[0]
    outsideDock.clearArrived()
    if (!first) return
    // An arrival the filter hides would not be selectable: show everything again first.
    if (first.path === active && shownReviewIdsRef.current && !shownReviewIdsRef.current.has(first.id)) setMarginFilterState((state) => withMode({ ...state, filter: {} }, 'review'))
    if (first.path !== active) openChangeAt(first)
    else selectChange(first.id)
  }, [outsideDock, active, openChangeAt, selectChange])
  // Next / previous from the status bar and the chords: the first arrival comes first, then the shown items in order.
  const stepReview = useCallback((direction: -1 | 1) => {
    if (direction === 1 && outsideDock.arrived.length > 0) { showArrivedInMargin(); focusCardSoon(reviewCursorRef.current?.currentId ?? null); return }
    if (reviewCursorRef.current?.move(direction)) focusCardSoon(reviewCursorRef.current.currentId)
  }, [outsideDock.arrived.length, showArrivedInMargin, focusCardSoon])
  const acceptWriterSession = useCallback(async (sessionChanges?: Change[]): Promise<void> => {
    const path = active
    const pendingWriterRecords = sessionChanges ?? dockChanges
    const count = pendingWriterRecords.filter(
      (change) => change.provenance === 'writer' && change.editClass !== 'copy' && change.status === 'pending',
    ).length
    if (count === 0) {
      flash('No pending writer edits in this session')
      return
    }
    await acceptWriterSessionChanges(pendingWriterRecords, window.writeflex)
    // Fold the reveal to clean on Accept : settled everywhere, so the buffer matches
    // the emptied panel. Display-only — Reviewing already persists the clean text, so the file is unchanged.
    if (path) editorRef.current?.settleWriterChanges(path)
    await reloadChanges()
    flash(`Accepted ${count} session ${count === 1 ? 'edit' : 'edits'} — document unchanged`)
  }, [active, dockChanges, reloadChanges, flash, editorRef])
  // Ticket 08: Settled today and My edits, from the count menu, the palette and Esc. A mode asks for the margin, so a
  // hidden margin comes back with it (it draws even with nothing waiting).
  const switchReviewMode = useCallback((mode: Exclude<ReviewMode, 'review'>) => {
    setMarginFilterState((state) => toggleMode(state, mode))
    if (marginHiddenRef.current) toggleMargin()
  }, [toggleMargin])
  const leaveReviewMode = useCallback(() => {
    setMarginFilterState((state) => (reviewModeOf(state) === 'review' ? state : withMode(state, 'review')))
  }, [])
  const toggleQuietFixes = useCallback(() => {
    setMarginFilterState((state) => ({ ...state, showQuiet: !state.showQuiet }))
  }, [])
  const revertToActive = useCallback(async (change: Change): Promise<void> => {
    if (change.status !== 'accepted') {
      flash('Select an accepted change to return it to active review')
      return
    }
    await revertWriterChangeToActive(change, window.writeflex)
    await reloadChanges()
    flash('Returned change to Unreviewed edits — document unchanged')
  }, [flash, reloadChanges])
  // The original wording goes to the floating Scratchpad's lossless store as a copy from that document
  // (ADR-0050): exact bytes, never the legacy heading grammar. The store refuses what it cannot keep.
  const sendChangeOriginalToScratchpad = useCallback(async (change: Change): Promise<void> => {
    const bound = typeof root === 'string' && root !== '' ? root : null
    const lossless = {
      add: async (origin: string, text: string) => {
        if (!bound) return null
        const reply = await window.writeflex.scratchpad.sendText({ root: bound, origin, markdown: text }).catch(() => null)
        return reply?.ok ? reply.item : null
      },
    }
    const added = await sendOriginalToScratchpad(change, lossless)
    if (!added) {
      flash('Could not send the original to Scratchpad')
      return
    }
    openScratchpad(false)
    flash('Original sent to Scratchpad — document unchanged')
  }, [flash, openScratchpad, root])
  const selectedLedgerChange = useCallback(
    () => changes.find((change) => change.id === selectedChangeId) ?? null,
    [changes, selectedChangeId],
  )
  const revertSelectedToActive = useCallback(() => {
    const change = selectedLedgerChange()
    if (!change) {
      flash('Select an accepted change first')
      return
    }
    void revertToActive(change)
  }, [flash, revertToActive, selectedLedgerChange])
  const sendSelectedOriginalToScratchpad = useCallback(() => {
    const change = selectedLedgerChange()
    if (!change) {
      flash('Select a change first')
      return
    }
    void sendChangeOriginalToScratchpad(change)
  }, [flash, selectedLedgerChange, sendChangeOriginalToScratchpad])
  // Pending agent changes whose original text has DRIFTED out of the buffer (edited away, superseded)
  // cannot render inline; the review pane badges those cards so a pane-only change is never a mystery.
  const [unanchoredIds, setUnanchoredIds] = useState<string[]>([])
  const unanchoredSet = useMemo(() => new Set(unanchoredIds), [unanchoredIds])
  const pushInlineChangeProjection = useCallback(
    (list: Change[], path: string | null, suggestions: Suggestion[]) => {
      const pending = list.filter((c) => !c.snapshotId && c.provenance === 'agent' && c.status === 'pending')
      const visible = !historicalActive && path !== null && loadedPath.current === path
      const unplaced = editorRef.current?.setInlineChanges(visible ? pending : [], selectedChangeId, suggestions) ?? []
      setUnanchoredIds((prev) => (prev.length === unplaced.length && prev.every((id, i) => id === unplaced[i]) ? prev : unplaced))
    },
    [historicalActive, selectedChangeId],
  )
  useEffect(() => {
    // Render inline only when the Change list belongs to the loaded buffer (see setChangeMarks above):
    // guards both the list-beats-content and content-beats-list races on a tab switch / reopen.
    pushInlineChangeProjection(changes, changesPath, agent.suggestions)
  }, [changes, changesPath, agent.suggestions, pushInlineChangeProjection])
  // Reveal once per deliberate navigation. dockChanges is a fresh array on every ledger refresh, including
  // the idle ones while the writer types elsewhere; re-revealing then would yank the caret back to the
  // change (the 0.18.0-alpha.11 promise: background refreshes leave caret, selection and scroll alone).
  const honouredRevealSerial = useRef<number | null>(null)
  useEffect(() => {
    const change = owedReveal(reviewCursorState, honouredRevealSerial.current, dockChanges)
    if (!change) return
    honouredRevealSerial.current = reviewCursorState.revealSerial
    editorRef.current?.revealChange(change)
  }, [reviewCursorState, dockChanges])

  // A changes:resolve response can arrive after its changes/suggestions pushes. Re-list both stores
  // after reconciling the returned file, then run the SAME projection used by those pushes. If the
  // pushes arrive later, their effect also reads the live post-reconcile doc, so either order converges.
  const refreshInlineChangesAfterReconcile = useCallback(async (): Promise<void> => {
    const path = activeRef.current
    if (!path) return
    const [freshChanges, freshAgentState] = await Promise.all([
      window.writeflex.listChanges({ path }),
      window.writeflex.getAgentState(),
    ])
    if (activeRef.current !== path) return
    setChanges(freshChanges)
    setChangesPath(path)
    pushInlineChangeProjection(freshChanges, path, freshAgentState.suggestions)
  }, [pushInlineChangeProjection])

  // Undo and redo of a suggestion's resolution, each run in the document owner's queue for its path, as
  // every resolution of a change is (these, and Apply or Discard from the review pane), so that main
  // receives them in the order asked for and none interleaves with a save of the document (parcel 2a).
  const replaySuggestionResolution = useCallback(async (effect: SuggestionResolutionEffect): Promise<void> => {
    if (!effect.resolved) {
      await owner.inQueue(effect.path, () => window.writeflex.setChangeStatus(effect.id, 'pending'))
    } else if (effect.action === 'accept') {
      // Redoing an accept writes the document's file through main, in the path's queue, under a hold in
      // the unsaved registry so that a close waits for it: accept-redo.ts.
      const applied = await replayAcceptRedo({
        owner,
        bufferOf: bufferNow,
        heldText: (path) => unsaved.textOf(path),
        hold: (path) => unsaved.hold(path),
        diskChanged: (path, diskText, buffer) => {
          guardRefusalPath.current = path
          noteDiskChangedUnderBuffer(path, diskText, buffer)
        },
        changedOnDisk: askAboutRefusedWrite,
        editorPresent: editorIsPresent,
        api: window.writeflex,
        flash,
        ...(window.writeflex.e2eWriteHooks ? {
          gate: async () => {
            if (e2eSaveBehaviourRef.current !== 'hold-redo') return
            await new Promise<void>((resolve) => { e2eSlowSaveReleaseRef.current = resolve })
          },
        } : {}),
      }, effect)
      if (!applied) return
      handleAgentWorkspaceChange()
    } else {
      // A reject writes no document: main returns no receipt for a reject (agent.ts resolveChange).
      const result = await owner.inQueue(effect.path, () => window.writeflex.resolveChange(effect.id, effect.action))
      if (!result.applied) {
        flash(result.message ?? 'Could not replay that suggestion resolution.')
        return
      }
    }
    await refreshInlineChangesAfterReconcile()
  }, [owner, bufferNow, flash, handleAgentWorkspaceChange, noteDiskChangedUnderBuffer, askAboutRefusedWrite, refreshInlineChangesAfterReconcile])

  // The app version for the status-bar corner — static, fetched once from main (package.json).
  const [appVersion, setAppVersion] = useState<string | null>(null)
  useEffect(() => {
    void window.writeflex.getAppVersion().then(setAppVersion).catch(() => setAppVersion(null))
  }, [])

  // --- Collection view actions (Task 23) ---
  // A folder-name click in the sidebar opens its Collection in the main area. A New piece / Create
  // Index Note lands a file on disk; the main-process push refreshes the tree exactly as an agent
  // write does. New piece then refreshes first (so the file is in `files`) and opens it in a tab.
  const openCollection = useCallback((dir: string) => {
    void (async () => {
      const current = activeRef.current
      if (current && (await flushPaths([current])).status !== 'saved') {
        flash('Could not save the current Piece — the folder stayed closed.')
        return
      }
      if (boardActive) {
        const editable = lastEditablePath && tabsRef.current.includes(lastEditablePath)
          ? lastEditablePath
          : tabsRef.current.find((path) => !isSurfaceTabId(path)) ?? null
        if (editable) activateTab(editable)
        else close(BOARD_TAB_ID)
      }
      if (await folderIsFolio(dir, window.writeflex)) {
        const parts = await readFolioOpenParts(dir)
        const stored = await window.writeflex.folioRoom.getState(dir)
        const target = parts.find(part => part.path === stored.selected?.path)?.path ?? folioOpenTarget(parts)
        if (target) {
          borrowedSidebar.current ??= { tab: leftTab, collapsed: leftPaneCollapsed }
          setFolioEditingDir(dir)
          open(target)
          requestOutline('showFolio')
          void requestIdentityLinks.current(dir)
          return
        }
      }
      setSelectedFolderPiece(null)
      setOpenPlanRequested(false)
      setCollectionDir(dir)
      if (await folderIsFolio(dir, window.writeflex)) void requestIdentityLinks.current(dir)
    })()
  }, [flash, flushPaths, boardActive, lastEditablePath, activateTab, close, open, requestOutline, leftTab, leftPaneCollapsed])
  // The Folder dashboard command: the Files tree's keyboard-focused folder row, else the open file's folder,
  // else the whole collection (the same ruling as the New file target, minus a file row's parent).
  const openFolderDashboard = useCallback(() => {
    const row = sidebarFocusedRow.current
    openCollection(createTargetDirectory({
      focusedRow: row?.kind === 'folder' ? row : null,
      activePath: activeRef.current,
      focus: folderFocus?.path ?? null,
    }))
  }, [folderFocus, openCollection])

  // The main-side push: as handleAgentWorkspaceChange, except that an own save in place patches its one
  // listing entry instead of re-listing the folder (shared/listing-patch.ts; every other change re-lists).
  useEffect(() => window.writeflex.onCollectionChanged((change) => {
    applyCollectionChange(change)
    setSavedTick((n) => n + 1)
  }), [applyCollectionChange])
  useEffect(() => {
    if (!root) {
      setSidebarCollectionSummary(null)
      return
    }
    let cancelled = false
    const reloadSummary = (): void => {
      void window.writeflex.collection.query('', '').then((result) => {
        if (cancelled || !result.ok) return
        setSidebarCollectionSummary(filesHeaderSummary(result.rows))
      }).catch(() => { if (!cancelled) setSidebarCollectionSummary(null) })
    }
    reloadSummary()
    const dispose = window.writeflex.collection.onChanged((event) => {
      const current = activeRef.current
      if (!collectionSurfaceMountedRef.current && current && event.paths.length > 0 && event.paths.every((path) => path === current)) return
      reloadSummary()
    })
    return () => { cancelled = true; dispose() }
  }, [root])
  const newPiece = useCallback(
    async (dir: string) => {
      try {
        const path = await window.writeflex.createCollectionPiece(dir)
        await refresh() // the new file must be in `files` before open() (useTabs containment contract)
        open(path)
      } catch {
        flash('Could not create a new document.')
      }
    },
    [refresh, open, flash],
  )

  const startNestedFolio = useCallback((dir: string) => {
    void window.writeflex.readFolioDir(dir).then(parent => {
      if (parent !== null) throw new Error('This folder is already inside a Folio.')
      return window.writeflex.createNestedFolio(dir)
    }).then((child) => { void refresh(); openPlanIn(child) })
      .catch((error) => flash(humanReadableError(error, 'Could not create a new Folio.')))
  }, [refresh, openPlanIn, flash])
  const [collectionFolioParent, setCollectionFolioParent] = useState<{ dir: string; root: typeof root; folio: string | null } | null>(null)
  useEffect(() => {
    let cancelled = false
    if (collectionDir !== null) void window.writeflex.readFolioDir(collectionDir).then(folio => {
      if (!cancelled) setCollectionFolioParent({ dir: collectionDir, root, folio })
    }).catch(() => { if (!cancelled) setCollectionFolioParent(null) })
    return () => { cancelled = true }
  }, [collectionDir, root, savedTick])
  const canStartCollectionFolio = collectionDir !== null && collectionFolioParent?.dir === collectionDir && collectionFolioParent.root === root && collectionFolioParent.folio === null
  const conversionTarget = collectionDir ?? (boardActive ? boardDir : folioPlace?.dir ?? null)
  const [conversionFolio, setConversionFolio] = useState<{ dir: string; root: typeof root } | null>(null)
  useEffect(() => {
    let cancelled = false
    setConversionFolio(null)
    if (conversionTarget !== null) void window.writeflex.readFolioDeclaration(conversionTarget).then(folio => {
      if (!cancelled && (folio.isFolio || folio.repairNeeded)) setConversionFolio({ dir: conversionTarget, root })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [conversionTarget, root, savedTick])
  const canTurnBack = conversionFolio !== null && conversionFolio.dir === conversionTarget && conversionFolio.root === root
  useEffect(() => {
    void window.writeflex.setCollectionPageActive(collectionDir !== null, collectionDir !== null && canTurnBack, canStartCollectionFolio)
  }, [collectionDir, canTurnBack, canStartCollectionFolio])
  useEffect(() => () => { void window.writeflex.setCollectionPageActive(false) }, [])
  useEffect(() => {
    if (turnBackUndo.current && (turnBackUndo.current.root !== root || turnBackUndo.current.dir !== collectionDir)) turnBackUndo.current = null
  }, [root, collectionDir])
  useEffect(() => {
    const clear = () => { turnBackUndo.current = null }
    const changed = (paths: string[]) => {
      const token = turnBackUndo.current
      if (token && paths.some(path => token.dir === '' || path === token.dir || path.startsWith(`${token.dir}/`))) clear()
    }
    const offCollection = window.writeflex.onCollectionChanged(change => {
      if (change) changed([change.ownSave.path])
      else clear() // An unscoped change may include this folder.
    })
    const offDisk = window.writeflex.onFileChangedOnDisk(changed)
    return () => { offCollection(); offDisk() }
  }, [])
  const undoTurnBack = useCallback(() => {
    const token = turnBackUndo.current
    if (!token || token.root !== root || collectionDir !== token.dir) return
    void (async () => {
      if ((await flushPaths(['AGENTS.md', 'CLAUDE.md', '_report-structure.json', `_${token.dir.split('/').at(-1) || root?.split('/').at(-1)}_INDEX.md`].map(name => token.dir ? `${token.dir}/${name}` : name))).status !== 'saved') return
      if (turnBackUndo.current !== token) return
      turnBackUndo.current = null
      if (await window.writeflex.undoTurnBack(token.dir)) {
        openCollection(token.dir)
        turnBackUndo.current = null
        flash('Restored the Folio, running order and instructions exactly.')
      }
    })().catch(error => flash(humanReadableError(error, 'Could not undo Turn back.')))
  }, [turnBackUndo, root, collectionDir, flushPaths, openCollection, flash])
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.key.toLowerCase() !== 'z' || !turnBackUndo.current || turnBackUndo.current.root !== root || collectionDir !== turnBackUndo.current.dir) return
      if ((event.target as HTMLElement)?.closest('input, textarea, [contenteditable="true"], .cm-editor')) return
      event.preventDefault(); event.stopImmediatePropagation(); undoTurnBack()
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [turnBackUndo, root, collectionDir, undoTurnBack])
  const turnBackFolio = useCallback(() => {
    if (!canTurnBack || conversionTarget === null) return
    const dir = conversionTarget
    void (async () => {
      const paths = ['AGENTS.md', 'CLAUDE.md', `_${dir.split('/').at(-1) || root?.split('/').at(-1)}_INDEX.md`].map(name => dir ? `${dir}/${name}` : name)
      if ((await flushPaths(paths)).status !== 'saved') { flash('Could not save the instructions. The Folio stayed as it was.'); return }
      const turnedBack = await window.writeflex.turnBackIntoCollection(dir)
      if (turnedBack) {
        setOpenPlanRequested(false)
        openCollection(dir)
        turnBackUndo.current = { dir, root }
        flash(typeof turnedBack === 'string' ? turnedBack : 'Turned back into a collection; the running order and Folio instructions were saved. Undo restores them.')
      }
    })().catch(error => flash(humanReadableError(error, 'Could not turn this Folio back into a collection.')))
  }, [canTurnBack, conversionTarget, root, flushPaths, flash, openCollection])

  // --- Scrap actions (Task 20, ADR-0050) ---
  // ⌘⇧X and the old pane's + button both go through the floating Scratchpad's controller: the exact text
  // is saved first and the unchanged span removed only after (scratchpad-controller.ts). ⌘Z restores it.
  const handleCutToScrap = useCallback(() => { void scratchpadApi.current?.cut() }, [])
  // The native menu's Scratchpad items run the same registered commands as the palette (ticket 04).
  useEffect(() => window.writeflex.onMenuAction((action) => {
    if (action === 'open-scratchpad') scratchpadApi.current?.toggle()
    else if (action === 'scratchpad-send-copy') void scratchpadApi.current?.sendCopy()
    else if (action === 'scratchpad-cut') void scratchpadApi.current?.cut()
    else if (action === 'scratchpad-insert-copy') scratchpadApi.current?.insertSelected()
    else if (action === 'scratchpad-compare') scratchpadApi.current?.compareTicked()
    else if (action === 'scratchpad-search') scratchpadApi.current?.focusSearch()
  }), [])
  const cutSelectionToScrap = handleCutToScrap
  // A scrap dropped into the document (the editor already inserted its text): remove it from the store.
  // A floating Scratchpad item (p_…) is never removed: the editor left its text out and the Scratchpad
  // inserts a copy at the drop point, with its anchor and its links carried (scratchpad-controller.ts).
  const handleScrapDropped = useCallback((id: string) => {
    if (isLosslessScrapId(id)) { scratchpadApi.current?.insertById(id); return }
    void scraps.remove(id)
  }, [scraps.remove])
  const removeScrap = useCallback((id: string) => {
    if (isLosslessScrapId(id)) {
      const bound = typeof root === 'string' && root !== '' ? root : null
      if (!bound) return
      void window.writeflex.scratchpad.setStatus({ root: bound, ids: [id], status: 'rejected' }).then((reply) => {
        flash(reply.ok ? 'Moved to Rejected in the Scratchpad. Nothing was deleted.' : `Nothing was changed: ${reply.error}`)
      })
      return
    }
    void scraps.remove(id)
  }, [scraps.remove, root, flash])
  // The keyboard path for drag-into-document (the tile's ⏎ / Insert button): insert at the caret and
  // remove the scrap — the same net effect as a drop.
  const insertScrapAtCursor = useCallback(
    (scrap: Scrap) => {
      if (isLosslessScrapId(scrap.id)) { scratchpadApi.current?.insertById(scrap.id); return }
      const view = editorRef.current?.view()
      if (!view) {
        flash('Open a document to insert a scrap')
        return
      }
      if (view.state.readOnly) {
        flash('This is a saved version, so the scrap was not inserted. Return to the current text first.')
        return
      }
      const pos = view.state.selection.main.head
      view.dispatch({ changes: { from: pos, insert: scrap.text }, selection: { anchor: pos + scrap.text.length }, scrollIntoView: true })
      view.focus()
      void scraps.remove(scrap.id)
    },
    [scraps.remove, flash],
  )
  // The live expandable set the editor's `{trigger}`+space handler reads (off a ref, not a dep, so
  // the extension — built once per EditorState — always sees the current list).
  const getScrapExpansions = useCallback(
    () =>
      scrapsRef.current
        .filter((s) => s.expandTrigger !== undefined)
        .map((s) => ({ trigger: s.expandTrigger as string, text: s.text })),
    [],
  )

  const [treeFocusRequest, setTreeFocusRequest] = useState<SidebarTreeFocusRequest>({ tick: 0, target: null })
  const [openTabsFocusTick, setOpenTabsFocusTick] = useState(0)
  const revealFilesTab = useCallback(() => openLeftTab('files'), [openLeftTab])
  const openFilesTab = useCallback(() => {
    revealFilesTab()
    // Open commands ACTIVATE (CH-1): land the keyboard on the tree's active row, so F2/⌘K/M/⌘⌫
    // (ADR-0017) work immediately — clicking a file hands focus to the editor, ⇧⌘E hands it back.
    setTreeFocusRequest((request) => ({ tick: request.tick + 1, target: null }))
  }, [revealFilesTab])
  // ⌘2, the toolbar's Tabs button and the strip's "+N" all open the same popover (ticket 14).
  const [tabsListOpen, setTabsListOpen] = useState(false)
  const openOpenTabs = useCallback(() => {
    setTabsListOpen(true)
    setOpenTabsFocusTick((tick) => tick + 1)
  }, [])
  const closeTabsList = useCallback(() => setTabsListOpen(false), [])
  const activateFromTabsList = useCallback((path: string) => {
    activate(path)
    setTabsListOpen(false)
    requestAnimationFrame(() => editorRef.current?.view()?.focus())
  }, [activate])
  const toggleTabsList = useCallback(() => {
    setTabsListOpen((open) => {
      if (!open) setOpenTabsFocusTick((tick) => tick + 1)
      return !open
    })
  }, [])
  const openOutlineTab = useCallback(() => {
    openLeftTab('outline')
    setOutlineOpen(true)
    setOutlineFocusTick((n) => n + 1)
  }, [openLeftTab])
  const openSearchTab = useCallback(() => {
    openLeftTab('search')
    // Open commands ACTIVATE (CH-1): land the keyboard in the query field. The panel stays mounted in
    // its hidden tabpanel, so its mount-time autofocus fired long ago — focus explicitly on open.
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.search-panel .search-field input')?.focus())
  }, [openLeftTab])
  const focusSidebarFilter = useCallback(() => {
    // Reveal the Files pane WITHOUT the tree-row focus tick — otherwise its deferred rAF (Sidebar's
    // focusRow) fires after, and steals, the filter input's focus. The filter is the target here.
    revealFilesTab()
    setSidebarFilterFocusTick((tick) => tick + 1)
  }, [revealFilesTab])
  const revealTreeRow = useCallback((target: SidebarFocusedRow) => {
    revealFilesTab()
    // A reveal outside the focused folder would land on a row the narrowed tree does not hold:
    // widen to the whole archive first so "Reveal in Files" is never a dead action.
    if (folderFocus && !isInFocus(target.key, folderFocus.path)) setFolderFocus(null)
    setTreeFocusRequest((request) => ({ tick: request.tick + 1, target }))
  }, [revealFilesTab, folderFocus, setFolderFocus])
  /** Focus a folder from the palette or Quick Open, and show the narrowed tree. */
  const focusFolder = useCallback((path: string) => {
    setFolderFocus(path)
    revealFilesTab()
  }, [setFolderFocus, revealFilesTab])
  const toggleSidebar = useCallback(() => toggleLeftPane(), [toggleLeftPane])
  const toggleOutline = useCallback(() => openOutlineTab(), [openOutlineTab])

  // Typewriter mode (PRD S12): centres the cursor line as you type. The editor owns the mode (a
  // per-view CM compartment reapplied on every tab switch), so App just flips it and reports the
  // result. The status-bar tw-chip (Task 12) is now the persistent on/off readout; the flash stays
  // as a subtle one-shot confirmation of the toggle (the mockup's #statusFlash surface).
  const [typewriterOn, setTypewriterOn] = useState(false)
  // The fixed line (editor.fixedLine): one height, as a fraction of the editor, shared by read-aloud
  // and typewriter mode. Live while the margin marker is dragged; persisted when it settles.
  const [fixedLine, setFixedLine] = useState(FIXED_LINE_DEFAULT)
  // The read-aloud highlight colour and strength (Settings → Editor, palette). They are written to the
  // --ra-* tokens on the root element, per theme, so a running read-aloud changes at once.
  const readAloudColourRef = useRef<string>(DEFAULT_READ_ALOUD_COLOUR)
  const readAloudStrengthRef = useRef<ReadAloudStrength>(DEFAULT_READ_ALOUD_STRENGTH)
  const applyReadAloudColours = useCallback(() => {
    const theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
    applyReadAloudTokens(document.documentElement, readAloudColourRef.current, readAloudStrengthRef.current, theme)
  }, [])
  useEffect(() => { applyReadAloudColours() }, [applyReadAloudColours])
  const [viewMode, setViewModeState] = useState<EditorViewMode>('clean')

  // Focus modes (Round A, ADR-0028): modes are commands, not chrome — the only resident trace is
  // the status-bar Focus Chip while a mode is active. State mirrors the editor compartment; refs
  // keep applySetting/toggles stable (the applier is a stable callback, hydration order is loose).
  const [focusMode, setFocusModeState] = useState<FocusMode>('')
  const [leadStyle, setLeadStyleState] = useState<LeadStyle>('contrast')
  const focusModeRef = useRef<FocusMode>('')
  // Line focus and Ruler are overlays beside the exclusive focus mode, with their own settings.
  const [lineOverlay, setLineOverlayState] = useState<LineOverlayConfig>(DEFAULT_LINE_OVERLAY)
  const lineOverlayRef = useRef<LineOverlayConfig>(DEFAULT_LINE_OVERLAY)
  const leadStyleRef = useRef<LeadStyle>('contrast')

  // Read-aloud is an app-owned session, parallel to the declared focus mode. The player publishes
  // the one source offset that drives both wash levels; voice and default rate are ordinary
  // renderer settings, with the current rate still adjustable directly from the transport.
  const [playerState, setPlayerState] = useState<PlayerState>({
    speaking: false,
    paused: false,
    sourceOffset: null,
    word: null,
    rate: 1,
  })
  const [speechVoices, setSpeechVoices] = useState<SpeechVoiceInfo[]>([])
  const [selectedVoiceURI, setSelectedVoiceURI] = useState<string | null>(null)
  const [voiceName, setVoiceName] = useState('System voice')
  const selectedVoiceURIRef = useRef<string | null>(null)
  const speechVoicesRef = useRef<SpeechVoiceInfo[]>([])
  const resumeFromPausedPositionRef = useRef(false)
  const [readAloudPositionOutsideViewport, setReadAloudPositionOutsideViewport] = useState(false)
  const [readAloudScrollMode, setReadAloudScrollMode] = useState<ReadAloudScrollMode>('typewriter')
  const baseSpeechEngineRef = useRef<SpeechEngine | null>(null)
  const readAloudEngineRef = useRef<SpeechEngine | null>(null)
  const playerRef = useRef<Player | null>(null)
  // The invisible e2e window must never produce real audio; production always uses the platform
  // engine. The existing fake keeps the UI session live for surface assertions without sound.
  baseSpeechEngineRef.current ??= window.writeflex.e2eEnabled ? fakeSpeechEngine() : webSpeechEngine()
  readAloudEngineRef.current ??= {
    speak: (text, options, handlers) =>
      baseSpeechEngineRef.current!.speak(
        text,
        { ...options, voiceURI: selectedVoiceURIRef.current },
        handlers,
      ),
    pause: () => baseSpeechEngineRef.current!.pause(),
    resume: () => baseSpeechEngineRef.current!.resume(),
    cancel: () => baseSpeechEngineRef.current!.cancel(),
    setRate: (rate) => baseSpeechEngineRef.current!.setRate(rate),
    voices: () => baseSpeechEngineRef.current!.voices(),
  }
  playerRef.current ??= createPlayer(readAloudEngineRef.current, setPlayerState)
  const pauseReadAloudAtCaret = useCallback(() => {
    const player = playerRef.current
    if (!player || !player.state().speaking) return
    resumeFromPausedPositionRef.current = false
    pauseReadAloudForDocumentChange(player)
  }, [])
  const pauseReadAloudOnManualScroll = useCallback(() => {
    const player = playerRef.current
    if (!player) return
    const state = player.state()
    if (!state.speaking || state.paused) return
    resumeFromPausedPositionRef.current = true
    pauseReadAloudForDocumentChange(player)
  }, [])

  const refreshSpeechVoices = useCallback((): SpeechVoiceInfo[] => {
    try {
      const available = baseSpeechEngineRef.current?.voices() ?? []
      speechVoicesRef.current = available
      setSpeechVoices(available)
      if (available.length > 0) {
        const selected = resolveReadAloudVoice(available, selectedVoiceURIRef.current)
        selectedVoiceURIRef.current = selected.voiceURI
        setSelectedVoiceURI(selected.voiceURI)
        setVoiceName(selected.name)
      }
      return available
    } catch (error) {
      flash(error instanceof Error ? error.message : String(error))
      return []
    }
  }, [flash])

  // Do not leave the platform synthesiser speaking after this window is gone. The guard avoids
  // touching speechSynthesis at all for a session that never started.
  useEffect(
    () => () => {
      if (playerRef.current?.state().speaking) readAloudEngineRef.current?.cancel()
    },
    [],
  )

  // Sounds (Round A Task 4): app-level channels, both off by default, all WebAudio synthesis. The
  // engine is created LAZILY on the first enable so a silent app never touches audio hardware; the
  // prefs ref mirrors the six settings keys because applySetting delivers them one at a time.
  const soundsRef = useRef<SoundEngine | null>(null)
  const soundPrefsRef = useRef({
    typingOn: false,
    typingScheme: 'deep' as TypingScheme,
    typingVolume: 0.6,
    ambientOn: false,
    ambientLoop: 'white' as AmbientLoop,
    ambientVolume: 0.35,
  })
  const applySoundPrefs = useCallback((channel: 'typing' | 'ambient') => {
    const prefs = soundPrefsRef.current
    const wantsSound = channel === 'typing' ? prefs.typingOn : prefs.ambientOn
    if (!soundsRef.current && !wantsSound) return // never build an AudioContext for silence
    soundsRef.current ??= new SoundEngine()
    if (channel === 'typing') soundsRef.current.setTyping(prefs.typingOn, prefs.typingScheme, prefs.typingVolume)
    else soundsRef.current.setAmbient(prefs.ambientOn, prefs.ambientLoop, prefs.ambientVolume)
  }, [])

  // --- Settings (Task 17) ---
  // The effect applier: called once per persisted key on hydrate (boot-time theme/editor apply)
  // and again after every settings set/revert — so a changelog Reset genuinely re-fires the
  // setting's effect. null = the key reverted to unset; each case falls back to its default.
  // permissions.* and snapshots.* have no case here: main reads them live (policy) or on bind
  // (retention sweep, save-snapshot gate).
  const applySetting = useCallback(
    (key: string, value: SettingValue | null) => {
      switch (key) {
        case 'appearance.theme': {
          // Dark is a real theme: the tokens.css dark block re-states every token behind this
          // attribute. Light (the default face) is the attribute's absence.
          if (value === 'dark') document.documentElement.setAttribute('data-theme', 'dark')
          else document.documentElement.removeAttribute('data-theme')
          applyReadAloudColours() // each theme has its own wash values
          break
        }
        case 'editor.typewriter': {
          const on = value === true
          editorRef.current?.setTypewriter(on)
          setTypewriterOn(on)
          break
        }
        case READ_ALOUD_COLOUR_SETTING:
          readAloudColourRef.current = normaliseReadAloudColour(value)
          applyReadAloudColours()
          break
        case READ_ALOUD_STRENGTH_SETTING:
          readAloudStrengthRef.current = normaliseReadAloudStrength(value)
          applyReadAloudColours()
          break
        case FIXED_LINE_SETTING:
          setFixedLine(normaliseFixedLine(value))
          break
        case 'editor.spellcheck':
          editorRef.current?.setSpellcheck(value !== false)
          break
        case LINE_OVERLAY_SETTINGS.lineFocusOn:
        case LINE_OVERLAY_SETTINGS.lineFocusSize:
        case LINE_OVERLAY_SETTINGS.lineFocusDim:
        case LINE_OVERLAY_SETTINGS.lineFocusFollow:
        case LINE_OVERLAY_SETTINGS.rulerOn:
        case LINE_OVERLAY_SETTINGS.rulerCovers:
        case LINE_OVERLAY_SETTINGS.rulerOpacity:
        case LINE_OVERLAY_SETTINGS.rulerFollow: {
          // Hydration in any key order: a stored both-on state resolves to Line focus on.
          const applied = applyLineOverlaySetting(lineOverlayRef.current, key, value)
          if (applied) {
            const next = resolveExclusive(applied, key === LINE_OVERLAY_SETTINGS.rulerOn && value === true && !lineOverlayRef.current.lineFocus.on ? 'ruler' : 'lineFocus')
            lineOverlayRef.current = next
            setLineOverlayState(next)
          }
          break
        }
        case 'editor.focusMode': {
          // State only: the editor receives focus DECLARATIVELY (EditorPane's `focus` prop — the
          // viewMode pattern), because settings hydration can land before the pane mounts.
          const mode = normaliseFocusMode(value)
          focusModeRef.current = mode
          setFocusModeState(mode)
          break
        }
        case 'editor.leadStyle': {
          const style = normaliseLeadStyle(value)
          leadStyleRef.current = style
          setLeadStyleState(style)
          break
        }
        case READ_ALOUD_VOICE_SETTING: {
          const savedVoiceURI = typeof value === 'string' && value !== '' ? value : null
          if (speechVoicesRef.current.length === 0) {
            selectedVoiceURIRef.current = savedVoiceURI
            setSelectedVoiceURI(savedVoiceURI)
            setVoiceName('System voice')
            break
          }
          const selected = resolveReadAloudVoice(speechVoicesRef.current, savedVoiceURI)
          selectedVoiceURIRef.current = selected.voiceURI
          setSelectedVoiceURI(selected.voiceURI)
          setVoiceName(selected.name)
          break
        }
        case READ_ALOUD_RATE_SETTING:
          playerRef.current?.setRate(normaliseReadAloudRate(value))
          break
        case READ_ALOUD_SCROLL_MODE_SETTING:
          setReadAloudScrollMode(normaliseReadAloudScrollMode(value))
          break
        case 'readingRoom.side':
        case 'readingRoom.open':
          applyReadingRoomSetting(key, value, setReadingRoomSide)
          break
        case 'sounds.typing.enabled':
          soundPrefsRef.current.typingOn = value === true
          applySoundPrefs('typing')
          break
        case 'sounds.typing.scheme':
          soundPrefsRef.current.typingScheme = normaliseTypingScheme(value)
          applySoundPrefs('typing')
          break
        case 'sounds.typing.volume':
          soundPrefsRef.current.typingVolume = clampVolume(value, 0.6)
          applySoundPrefs('typing')
          break
        case 'sounds.ambient.enabled':
          soundPrefsRef.current.ambientOn = value === true
          applySoundPrefs('ambient')
          break
        case 'sounds.ambient.loop':
          soundPrefsRef.current.ambientLoop = value === 'rain' ? 'rain' : 'white'
          applySoundPrefs('ambient')
          break
        case 'sounds.ambient.volume':
          soundPrefsRef.current.ambientVolume = clampVolume(value, 0.35)
          applySoundPrefs('ambient')
          break
        case 'editor.viewMode': {
          const mode = normaliseEditorViewMode(value)
          editorRef.current?.setViewMode(mode)
          setViewModeState(mode)
          break
        }
        case 'editor.lineWidth': {
          if (value === null) document.documentElement.style.removeProperty('--prose-measure')
          else document.documentElement.style.setProperty('--prose-measure', LINE_WIDTH_PX[String(value)] ?? '660px')
          break
        }
        case 'editor.proseSize': {
          if (value === null) document.documentElement.style.removeProperty('--prose-size')
          else document.documentElement.style.setProperty('--prose-size', `${String(value)}px`)
          break
        }
        case 'agent.model': {
          // The stored raw is `${provider}::${modelId}`; the live effect is the real set-model
          // channel (which also keeps the sticky modelDefaults in step — same store, same truth).
          if (typeof value === 'string' && value.includes('::')) {
            const [provider, ...rest] = value.split('::')
            void window.writeflex
              .setDefaultModel(provider, rest.join('::'))
              .catch((error: unknown) => flash(error instanceof Error ? error.message : String(error)))
          }
          break
        }
        case 'agent.thinkingLevel': {
          if (value === 'minimal' || value === 'low' || value === 'medium' || value === 'high') {
            void window.writeflex
              .setDefaultThinking(value)
              .catch((error: unknown) => flash(error instanceof Error ? error.message : String(error)))
          }
          break
        }
      }
    },
    [flash, applySoundPrefs],
  )
  const reportSettingsError = useCallback((error: unknown) => flash(humanReadableError(error, 'Could not reset that setting.')), [flash])
  const settings = useSettings(applySetting, reportSettingsError)
  const { set: setSetting, values: settingValues } = settings
  const [explicitSession, setExplicitSession] = useState<ExplicitSessionState | null>(null)
  const [automaticDiarySession, setAutomaticDiarySession] = useState(false)
  const [sessionMenuRequest, setSessionMenuRequest] = useState(0)
  const previousExplicitSessionRef = useRef<ExplicitSessionState | null>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.all([window.writeflex.diary.getSession(), window.writeflex.diary.getAutomaticSession()]).then(([session, automatic]) => {
      if (!cancelled) { setExplicitSession(session); setAutomaticDiarySession(automatic) }
    })
    const offSession = window.writeflex.diary.onSession(setExplicitSession)
    const offAutomatic = window.writeflex.diary.onAutomaticSession(setAutomaticDiarySession)
    return () => { cancelled = true; offSession(); offAutomatic() }
  }, [])

  const sessionSoundVolume = clampVolume(settingValues['sounds.typing.volume'], 0.6)
  useEffect(() => {
    const previous = previousExplicitSessionRef.current
    if (!window.writeflex.e2eEnabled && previous?.status === 'running' && explicitSession?.status === 'completed') {
      soundsRef.current?.completeSession()
    }
    const runningTimedTick = explicitSession?.status === 'running' && explicitSession.durationMs !== null && explicitSession.tick
    if (!window.writeflex.e2eEnabled && runningTimedTick) soundsRef.current ??= new SoundEngine()
    soundsRef.current?.setSessionCues({
      running: !window.writeflex.e2eEnabled && runningTimedTick,
      timed: explicitSession?.durationMs !== null,
      tick: explicitSession?.tick === true,
      volume: sessionSoundVolume,
    })
    previousExplicitSessionRef.current = explicitSession
  }, [explicitSession, sessionSoundVolume])

  useEffect(() => {
    if (window.writeflex.e2eEnabled || explicitSession?.status !== 'running' || explicitSession.durationMs === null || !explicitSession.tick) return
    const timer = setInterval(() => soundsRef.current?.tickSession(), 1_000)
    return () => clearInterval(timer)
  }, [explicitSession?.id, explicitSession?.status, explicitSession?.durationMs, explicitSession?.tick])
  const [contextCounted, setContextCounted] = useState(false)
  useEffect(() => {
    if (folderPieceContextDir === null || !root) { setContextCounted(false); return }
    let cancelled = false
    void window.writeflex.diary.isCounted(folderPieceContextDir).then((value) => {
      if (!cancelled) setContextCounted(value)
    }).catch(() => { if (!cancelled) setContextCounted(false) })
    return () => { cancelled = true }
  }, [folderPieceContextDir, root, files])
  const toggleCountedCollection = useCallback(() => {
    if (folderPieceContextDir === null) return
    const next = !contextCounted
    void window.writeflex.diary.setCounted(folderPieceContextDir, next).then(() => {
      setContextCounted(next)
      settings.refresh()
      flash(next ? 'Collection counts toward the Diary' : 'Collection no longer counts toward the Diary')
    }).catch((error: unknown) => flash(humanReadableError(error, 'Could not change the Counted Collection mark.')))
  }, [contextCounted, flash, folderPieceContextDir, settings])
  /**
   * Show or hide the Room. Opening it also collapses the left and right panes (ADR-0036): they compete
   * with the Room for the same width, and the user opened the Room to read.
   *
   * **A default, not a lock.** Nothing here re-collapses anything, so reopening a pane afterwards — ⌘[,
   * ⌘], the chevrons, or any of the open-tab commands — works and stays, and the Room does not fight it.
   * Only a deliberate open collapses; the Room always starts closed on launch.
   */
  const setReadingRoomVisibility = useCallback((open: boolean): void => {
    if (open) {
      collapseLeftPane()
      collapseRightPane()
    }
    setReadingRoomOpen(open)
  }, [collapseLeftPane, collapseRightPane])
  /** Search the Shelf: open the Room if it is closed, then raise the Shelf inside it. */
  const searchTheShelf = useCallback((): void => {
    setReadingRoomVisibility(true)
    setReadingRoomShelfRequest((token) => token + 1)
  }, [setReadingRoomVisibility])
  const noteOutboxCounts = useCallback((counts: {
    waiting: number
    rejected: number
  }): void => {
    outboxWaitingRef.current = counts.waiting
    setOutboxWaiting(counts.waiting)
    setOutboxRejected(counts.rejected)
    // Nothing waiting means nothing was refused: the refusal must not outlive the highlight it was
    // about. This path is a plain count refresh rather than an event, so it says nothing either way.
    if (counts.waiting === 0) setOutboxRefusal(null)
  }, [])
  const refreshOutboxCounts = useCallback((): void => {
    void window.writeflex.readingRoom
      .outboxCounts()
      .then(noteOutboxCounts)
      .catch(() => { /* the count is an indicator, never a reason to interrupt writing */ })
  }, [noteOutboxCounts])
  useEffect(refreshOutboxCounts, [refreshOutboxCounts])
  /**
   * The one place a write attempt's answer lands (ADR-0036). It feeds the Room's notice and the status
   * bar's sync button from the SAME result, so the words the user reads at the moment of refusal and the
   * button the user presses about it can never disagree.
   *
   * **It speaks at both ends** (ADR-0036, second amendment). A system that speaks only on failure
   * teaches him to read silence as success — and silence is also what a broken system produces. So a
   * queue that was waiting and is now empty says so, through the app's ordinary transient flash: it
   * appears, says the thing and goes, accumulating nothing. What must never exist is a PERSISTENT
   * status surface, and a sentence that expires is not one.
   *
   * A highlight that writes straight through was never waiting, so nothing is announced for it. The
   * message answers a question the user actually had; the user had none about a mark that synced instantly.
   */
  const noteWriteResult = useCallback((result: ReadingRoomWriteResult): void => {
    const wasWaiting = outboxWaitingRef.current
    outboxWaitingRef.current = result.waiting
    setOutboxWaiting(result.waiting)
    setOutboxRejected(result.rejected)
    setOutboxRefusal(
      result.waiting > 0 && result.notWritten
        ? { code: result.notWrittenCode ?? null, reason: result.notWritten }
        : null,
    )
    if (result.keptLocal?.created) {
      flash(result.keptLocal.reason)
    }
    const announcement = outboxResultAnnouncement(wasWaiting, result)
    if (announcement) flash(announcement)
  }, [flash])
  /**
   * Hand the waiting highlights to Zotero now — the status bar's button (ADR-0036 amendment). It always
   * RE-CHECKS: the user may have opened Zotero since the label was drawn, and a control that refused on the
   * state it was rendered with would teach him not to trust it.
   */
  const outboxSync = useMemo(
    () => createOutboxSyncRunner<ReadingRoomWriteResult>({
      readCounts: () => window.writeflex.readingRoom.outboxCounts(),
      drain: () => window.writeflex.readingRoom.drainOutbox(),
      onCounts: noteOutboxCounts,
      onResult: noteWriteResult,
      onDrainError: (error: unknown) => flash(error instanceof Error ? error.message : String(error)),
      onThrottledAttempt: () => {
        outboxAutomaticSyncAttemptsRef.current += 1
      },
    }),
    [flash, noteOutboxCounts, noteWriteResult],
  )
  const syncHighlightsToZotero = useCallback((): void => {
    void outboxSync.runManual()
  }, [outboxSync])
  const syncHighlightsAutomatically = useCallback((): void => {
    void outboxSync.runAutomatic()
  }, [outboxSync])
  const syncHighlightsOnRoomLifecycle = useCallback((): void => {
    void outboxSync.runLifecycle()
  }, [outboxSync])
  useEffect(() => {
    return window.writeflex.onWindowFocused(syncHighlightsAutomatically)
  }, [syncHighlightsAutomatically])
  // The main process wrote what was waiting when Zotero quit (or was refused trying): same landing
  // place as any write result, so the count, the notice and the "synced" flash all follow.
  useEffect(() => {
    return window.writeflex.readingRoom.onOutboxChanged(noteWriteResult)
  }, [noteWriteResult])

  /** Words left the reader. The Zotero create waits until those words actually enter a draft. */
  const noteReaderSelection = useCallback((selection: ReaderSelection | null): void => {
    readerSelectionRef.current = selection
  }, [])

  const prepareReadingRoomAreaQuotation = useCallback(async (
    area: { annotationKey: string; attachmentKey: string; libraryId: number },
  ): Promise<string> => window.writeflex.readingRoom.beginAreaQuotation({
    annotationKey: area.annotationKey,
    attachmentKey: area.attachmentKey,
    libraryId: area.libraryId,
  }), [])

  const recordReadingRoomAreaQuotation = useCallback(async (
    area: { annotationKey: string; attachmentKey: string; libraryId: number },
    draftPath: string,
    receipt: string,
    draftText: string,
  ): Promise<void> => {
    const result = await window.writeflex.readingRoom.recordAreaQuotation({
      annotationKey: area.annotationKey,
      attachmentKey: area.attachmentKey,
      documentTitle: documentTitle(draftText, draftPath),
      draftPath,
      libraryId: area.libraryId,
      receipt,
    })
    noteWriteResult(result)
    if (result.quotationStatus === 'failed' || result.quotationStatus === 'conflict') {
      throw new Error(result.quotationError ?? 'The Area quotation record needs attention.')
    }
  }, [noteWriteResult])

  /**
   * Text arriving in the draft that came out of the reader becomes a quote with its reference. Matched
   * on the words themselves rather than a clipboard flavour, so it works for ⌘C→⌘V and for a drag, and
   * cannot mistake ordinary pasted prose for a citation.
   */
  const citationForPastedText = useCallback((pasted: string): {
    identity: string
    initial: string
    upgrade: Promise<string | null>
  } | null => {
    const selection = readerSelectionRef.current
    const path = activeRef.current
    if (!selection || !path) return null
    const identity = crypto.randomUUID()
    const pageCitation = citationForReaderText(pasted, selection, selection.pageLink)
    if (pageCitation === null) return null
    const initial = pageCitation
    if (!selection.annotation) {
      return { identity, initial, upgrade: Promise.resolve(null) }
    }
    const title = documentTitle(editorRef.current?.currentDoc() ?? '', path)
    const upgrade = window.writeflex.readingRoom
      .citeSelection({
        annotation: selection.annotation,
        attachmentKey: selection.attachmentKey,
        documentTitle: title,
        libraryId: selection.libraryId,
      })
      .then((result) => {
        const { notWrittenCode, ...writeResult } = result
        if (notWrittenCode === 'document-mismatch') return null
        noteWriteResult({
          ...writeResult,
          ...(notWrittenCode ? { notWrittenCode } : {}),
        })
        if (result.annotation) {
          try {
            selection.paint(result.annotation)
          } catch {
            // The draft already has its confirmed annotation link. A closed reader has nothing to paint.
          }
        }
        if (!result.confirmed) return null
        const annotationCitation = citationForReaderText(pasted, selection, result.link)
        return annotationCitation
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        flash(message)
        // The synchronous page-level citation is already in the draft.
        return null
      })
    return { identity, initial, upgrade }
  }, [flash, noteWriteResult])

  /** Insert reference…: raise the Shelf as a picker. Opens the Room because that is where the library
   *  search lives; the reference lands in the draft and the keyboard goes back to the prose. */
  const insertReference = useCallback((): void => {
    setReadingRoomVisibility(true)
    setReadingRoomCiteRequest((token) => token + 1)
  }, [setReadingRoomVisibility])
  /** A picked item becomes a chip at the caret. App owns the Markdown; the editor owns where it goes. */
  const citeShelfRow = useCallback((row: ShelfRow): void => {
    if (!row.citationLink) {
      flash('That item has no Zotero link ReadFlex can point at.')
      return
    }
    editorRef.current?.insertText(citationChip({
      authorYear: row.authorYear || row.citationKey,
      link: row.citationLink,
    }))
  }, [flash])
  /** The harvest: open the Room if it is closed, then raise the Highlights view inside it. */
  const openHighlights = useCallback((): void => {
    setReadingRoomVisibility(true)
    setReadingRoomHighlightsRequest((token) => token + 1)
  }, [setReadingRoomVisibility])
  const savedSpeechVoiceURI = typeof settingValues[READ_ALOUD_VOICE_SETTING] === 'string'
    ? settingValues[READ_ALOUD_VOICE_SETTING] as string
    : null

  // A removed system voice must not remain as a dead preference. Unset it silently so the
  // synthesiser and Settings both return to the operating system's current default.
  useEffect(() => {
    if (!savedSpeechVoiceURI || speechVoices.length === 0) return
    if (speechVoices.some((voice) => voice.uri === savedSpeechVoiceURI)) return
    const selected = resolveReadAloudVoice(speechVoices, savedSpeechVoiceURI)
    selectedVoiceURIRef.current = selected.voiceURI
    setSelectedVoiceURI(selected.voiceURI)
    setVoiceName(selected.name)
    setSetting(READ_ALOUD_VOICE_SETTING, null, 'Voice', { log: false })
  }, [savedSpeechVoiceURI, setSetting, speechVoices])

  // Assignable shortcuts (Round A T6, ADR-0028): the writer's chord overrides, parsed once from
  // their single JSON-string setting. The editor keymap and the window dispatch table below both
  // consume THIS map, so every binding surface answers to the same resolver.
  const shortcutOverrides = useMemo(() => parseOverrides(settingValues[SHORTCUT_OVERRIDES_KEY]), [settingValues])
  const guideProgress = useMemo(() => parseGuideProgress(settingValues[GUIDE_PROGRESS_KEY]), [settingValues])
  // What it connects to (ticket 08): read from this machine, only while this window has a Guide.
  const guideConnections = useGuideConnectionSources(guideContext.shown)
  // The Guide's ticks: every route that runs a registry command reports it (commands/command-ran.ts), and
  // this window forwards it to main, which keeps the one record for every window.
  useEffect(() => onCommandRan((id) => window.writeflex.commandRan(id)), [])
  useEffect(() => window.writeflex.onMenuAction((action) => {
    const id = MENU_ACTION_COMMANDS[action]
    if (id) commandRan(id)
  }), [])
  const shortcutOverridesRef = useRef(shortcutOverrides)
  shortcutOverridesRef.current = shortcutOverrides
  // The action bar (ADR-0040). Visibility is ONE GLOBAL setting, not per window: this window reads
  // the same stored boolean as every other, and a toggle anywhere arrives through the
  // settings:changed broadcast, so two windows can never disagree about whether the bar is up.
  const actionBarVisible = actionBarVisibleFrom(settingValues[ACTION_BAR_VISIBLE_KEY])
  const toggleActionBar = useCallback(() => {
    setSetting(ACTION_BAR_VISIBLE_KEY, !actionBarVisible, ACTION_BAR_VISIBLE_LABEL)
  }, [actionBarVisible, setSetting])
  const actionBarShortcut = useMemo(() => {
    const chord = resolveChord(ACTION_BAR_COMMAND.id, shortcutOverrides)
    return chord ? formatShortcutKey(chord) : null
  }, [shortcutOverrides])
  // WHAT is on the bar, and in what order, is the second half of ADR-0040 and lives beside the
  // visibility boolean in the same app-level settings file — one global list, arriving in every
  // other window through the same settings:changed broadcast. A stored list that is corrupt, empty
  // or unparseable reads as "never set" and falls back to the drawn default (actionBarItemsFrom),
  // so the bar can never be emptied by bad data.
  const actionBarItems = useMemo(
    () => actionBarItemsFrom(settingValues[ACTION_BAR_ITEMS_KEY], DEFAULT_ACTION_BAR_ITEMS),
    [settingValues],
  )
  const [configureActionBarOpen, setConfigureActionBarOpen] = useState(false)
  const setActionBarItems = useCallback(
    (items: string[]) => {
      // log:false — one drag is a dozen writes, and the changelog is a record of decisions, not of
      // keystrokes. The way back is the sheet's own "Reset to the default set", which UNSETS the key.
      setSetting(ACTION_BAR_ITEMS_KEY, serialiseActionBarItems(items), ACTION_BAR_ITEMS_LABEL, { log: false })
    },
    [setSetting],
  )
  const resetActionBarItems = useCallback(() => {
    setSetting(ACTION_BAR_ITEMS_KEY, null, ACTION_BAR_ITEMS_LABEL, { log: false })
  }, [setSetting])
  useEffect(() => {
    editorRef.current?.setCommandChords(shortcutOverrides)
  }, [shortcutOverrides])

  const toggleTypewriter = useCallback(() => {
    const on = editorRef.current?.toggleTypewriter() ?? false
    setTypewriterOn(on)
    flash(on ? 'Typewriter on' : 'Typewriter off')
    // Persist the live choice so a relaunch keeps it — but SILENTLY (log:false): the changelog
    // documents changes made in Settings; ⌘T is a live-surface tweak, not one of those.
    setSetting('editor.typewriter', on, 'Typewriter mode', { log: false })
  }, [flash, setSetting])

  // The fixed line from the palette: the three presets write the same setting as Settings → Editor.
  const chooseFixedLine = useCallback((preset: keyof typeof FIXED_LINE_PRESETS) => {
    setSetting(FIXED_LINE_SETTING, FIXED_LINE_PRESETS[preset], 'Fixed line position', { log: false })
    flash(`Fixed line: ${FIXED_LINE_PRESET_LABELS[preset].toLowerCase()}`)
  }, [flash, setSetting])
  const chooseReadAloudHighlight = useCallback((preset: ReadAloudPreset) => {
    setSetting(READ_ALOUD_COLOUR_SETTING, preset, 'Read-aloud highlight', { log: false })
    flash(`Read-aloud highlight: ${READ_ALOUD_PRESETS[preset].label.toLowerCase()}`)
  }, [flash, setSetting])
  const commitFixedLine = useCallback((fraction: number) => {
    setSetting(FIXED_LINE_SETTING, fraction, 'Fixed line position', { log: false })
  }, [setSetting])

  // Apply a focus mode exactly (the picker's semantics) and persist it silently (the ⌘T rule:
  // live-surface tweaks are not "changes made in Settings"). Both routes — picker and direct
  // commands — land here, so they stay in sync by construction.
  const chooseFocusMode = useCallback((mode: FocusMode) => {
    focusModeRef.current = mode
    setFocusModeState(mode)
    flash(mode === '' ? 'Focus off' : `Focus: ${FOCUS_CHIP_NAMES[mode]}`)
    setSetting('editor.focusMode', mode, 'Focus mode', { log: false })
  }, [flash, setSetting])

  // Direct mode commands toggle: re-invoking the active mode = Off (ADR-0028).
  const toggleFocusMode = useCallback((mode: Exclude<FocusMode, ''>) => {
    chooseFocusMode(focusModeRef.current === mode ? '' : mode)
  }, [chooseFocusMode])

  // The Anchored lead-in style. Silent here (picker = live surface); the Settings select logs.
  const chooseLeadStyle = useCallback((style: LeadStyle) => {
    leadStyleRef.current = style
    setLeadStyleState(style)
    setSetting('editor.leadStyle', style, 'Anchored lead-in style', { log: false })
  }, [setSetting])

  // Line focus and Ruler: one silent write per choice (the same rule as the focus modes).
  const chooseLineOverlay = useCallback((key: string, value: boolean | string | number, label: string) => {
    const applied = applyLineOverlaySetting(lineOverlayRef.current, key, value)
    if (applied) {
      const next = resolveExclusive(applied, key === LINE_OVERLAY_SETTINGS.rulerOn ? 'ruler' : 'lineFocus')
      lineOverlayRef.current = next
      setLineOverlayState(next)
    }
    setSetting(key, value, label, { log: false })
  }, [setSetting])
  // The two overlays are mutually exclusive: switching one on writes the other off.
  const switchOverlayOn = useCallback((which: 'lineFocus' | 'ruler') => {
    const { lineFocus, ruler } = lineOverlayRef.current
    if (which === 'lineFocus') {
      if (ruler.on) chooseLineOverlay(LINE_OVERLAY_SETTINGS.rulerOn, false, 'Ruler')
      if (!lineFocus.on) chooseLineOverlay(LINE_OVERLAY_SETTINGS.lineFocusOn, true, 'Line focus')
    } else {
      if (lineFocus.on) chooseLineOverlay(LINE_OVERLAY_SETTINGS.lineFocusOn, false, 'Line focus')
      if (!ruler.on) chooseLineOverlay(LINE_OVERLAY_SETTINGS.rulerOn, true, 'Ruler')
    }
  }, [chooseLineOverlay])
  const toggleLineFocus = useCallback(() => {
    if (lineOverlayRef.current.lineFocus.on) {
      chooseLineOverlay(LINE_OVERLAY_SETTINGS.lineFocusOn, false, 'Line focus')
      flash('Line focus off')
    } else {
      switchOverlayOn('lineFocus')
      flash('Line focus on')
    }
  }, [chooseLineOverlay, flash, switchOverlayOn])
  const toggleRuler = useCallback(() => {
    if (lineOverlayRef.current.ruler.on) {
      chooseLineOverlay(LINE_OVERLAY_SETTINGS.rulerOn, false, 'Ruler')
      flash('Ruler off')
    } else {
      switchOverlayOn('ruler')
      flash('Ruler on')
    }
  }, [chooseLineOverlay, flash, switchOverlayOn])
  // The picker's switch rows route through here too, so the picker, the palette and the chips agree.
  const chooseLineFocusSize = useCallback((size: LineFocusSize) => {
    chooseLineOverlay(LINE_OVERLAY_SETTINGS.lineFocusSize, size, 'Line focus size')
    switchOverlayOn('lineFocus')
    flash(`Line focus: ${size} ${size === 1 ? 'line' : 'lines'}`)
  }, [chooseLineOverlay, flash, switchOverlayOn])
  const chooseRulerCovers = useCallback((covers: RulerCovers) => {
    chooseLineOverlay(LINE_OVERLAY_SETTINGS.rulerCovers, covers, 'Ruler covers')
    switchOverlayOn('ruler')
    flash(`Ruler: ${covers === 'thin' ? 'thin rule' : covers === 'below' ? 'all below' : covers === '1' ? '1 line' : `${covers} lines`}`)
  }, [chooseLineOverlay, flash, switchOverlayOn])
  const nudgeRulerOpacity = useCallback((direction: 1 | -1) => {
    const opacity = normaliseRulerOpacity(lineOverlayRef.current.ruler.opacity + direction * 2 * RULER_OPACITY_STEP)
    chooseLineOverlay(LINE_OVERLAY_SETTINGS.rulerOpacity, opacity, 'Ruler opacity')
    switchOverlayOn('ruler')
    flash(`Ruler opacity: ${opacity}%`)
  }, [chooseLineOverlay, flash, switchOverlayOn])
  // By hand is only ever an explicit choice (picker pill or this command); the command toggles it for
  // both overlays and returns them to Cursor.
  const toggleOverlayFollowByHand = useCallback(() => {
    const { lineFocus, ruler } = lineOverlayRef.current
    const active = lineFocus.on ? lineFocus : ruler.on ? ruler : lineFocus
    const next = active.follow === 'by-hand' ? 'cursor' : 'by-hand'
    chooseLineOverlay(LINE_OVERLAY_SETTINGS.lineFocusFollow, next, 'Line focus follow')
    chooseLineOverlay(LINE_OVERLAY_SETTINGS.rulerFollow, next, 'Ruler follow')
    flash(next === 'by-hand' ? 'Line focus / Ruler: follow by hand' : 'Line focus / Ruler: follow cursor')
  }, [chooseLineOverlay, flash])
  // Typewriter follow is toggled the same way: the band stays on the typewriter line, the text moves through it.
  const toggleOverlayFollowTypewriter = useCallback(() => {
    const { lineFocus, ruler } = lineOverlayRef.current
    const active = lineFocus.on ? lineFocus : ruler.on ? ruler : lineFocus
    const next = active.follow === 'typewriter' ? 'cursor' : 'typewriter'
    chooseLineOverlay(LINE_OVERLAY_SETTINGS.lineFocusFollow, next, 'Line focus follow')
    chooseLineOverlay(LINE_OVERLAY_SETTINGS.rulerFollow, next, 'Ruler follow')
    flash(next === 'typewriter' ? 'Line focus / Ruler: follow typewriter' : 'Line focus / Ruler: follow cursor')
  }, [chooseLineOverlay, flash])

  // The editor's declarative focus prop (one object identity per mode/style pair).
  const focusForEditor = useMemo(
    () => ({ mode: effectiveFocusMode(focusMode, playerState.speaking), leadStyle }),
    [focusMode, leadStyle, playerState.speaking],
  )

  // Sound channel toggles (palette commands). Silent persists (the ⌘T rule: live-surface tweaks are
  // not "changes made in Settings"); setSetting re-fires applySetting, which drives the engine.
  const toggleTypingSounds = useCallback(() => {
    const on = !soundPrefsRef.current.typingOn
    flash(on ? 'Typing sounds on' : 'Typing sounds off')
    setSetting('sounds.typing.enabled', on, 'Typing sounds', { log: false })
  }, [flash, setSetting])
  const toggleAmbientSound = useCallback(() => {
    const on = !soundPrefsRef.current.ambientOn
    flash(on ? 'Ambient sound on' : 'Ambient sound off')
    setSetting('sounds.ambient.enabled', on, 'Ambient sound', { log: false })
  }, [flash, setSetting])

  // Typing sounds fire per keystroke IN THE EDITOR (capture phase, so CM's own handlers cannot eat
  // the event first); ambient pauses while WriteFlex is in the background (PRD §2 states) — which
  // also keeps multi-window sound honest: only the focused window is audible.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!soundPrefsRef.current.typingOn) return
      if (e.metaKey || e.ctrlKey || e.altKey) return // chords are commands, not writing
      if (!(e.target instanceof Element) || !e.target.closest('.cm-content')) return
      soundsRef.current?.keystroke(e.key)
    }
    const onBlur = (): void => soundsRef.current?.suspend()
    const onFocus = (): void => soundsRef.current?.resume()
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  const selectViewMode = useCallback((mode: EditorViewMode) => {
    if (distractionFree && mode !== 'clean') setDistractionFree(false)
    setSetting('editor.viewMode', mode, 'View mode', { log: false })
    flash(mode === 'clean' ? 'View: Clean' : mode === 'markup' ? 'View: Show markup' : 'View: Show raw')
  }, [distractionFree, flash, setSetting])

  const toggleDistractionFree = useCallback(() => {
    setDistractionFree((active) => {
      if (!active) selectViewMode('clean')
      setDfControlsVisible(false)
      return !active
    })
  }, [selectViewMode])

  const moveDocumentFind = useCallback((direction: 1 | -1) => {
    setDocumentFindStatus(editorRef.current?.find(documentFindQuery, direction, documentFindReplacement) ?? { current: 0, total: 0 })
  }, [documentFindQuery, documentFindReplacement])
  const updateDocumentFindQuery = useCallback((query: string) => {
    setDocumentFindQuery(query)
    setDocumentFindStatus(editorRef.current?.find(query, 0, documentFindReplacement) ?? { current: 0, total: 0 })
  }, [documentFindReplacement])
  const closeDocumentFind = useCallback(() => {
    setDocumentFindOpen(false)
    setDocumentFindReplaceOpen(false)
    editorRef.current?.clearFind()
  }, [])
  const replaceDocumentFind = useCallback((all: boolean) => {
    setDocumentFindStatus(editorRef.current?.replaceFind(documentFindQuery, documentFindReplacement, all) ?? { current: 0, total: 0 })
  }, [documentFindQuery, documentFindReplacement])

  // Prose zoom (Task 17, the locked View keys): ⌘+/⌘− step the prose size through 17/19/21,
  // ⌥⌘+/⌥⌘− step the line width, ⌥⌘0 resets both. Steps persist silently (the ⌘T rule) and flash.
  // From the untouched/reset default (locked 18.5px, which the Settings select shows as "19"), the
  // ladder treats the position as index-1 ('19'): the first ⌘+ → 21, the first ⌘− → 17 — each step
  // visibly changes the displayed size, matching the "19" the select already shows.
  const stepProseSize = useCallback(
    (direction: 1 | -1) => {
      const current = String(settingValues['editor.proseSize'] ?? '19')
      const index = PROSE_SIZES.indexOf(current)
      const next = PROSE_SIZES[Math.min(Math.max((index === -1 ? 1 : index) + direction, 0), PROSE_SIZES.length - 1)]
      setSetting('editor.proseSize', next, 'Prose size', { log: false })
      flash(`Prose size ${next}`)
    },
    [settingValues, setSetting, flash],
  )
  const stepLineWidth = useCallback(
    (direction: 1 | -1) => {
      const current = String(settingValues['editor.lineWidth'] ?? 'medium')
      const index = LINE_WIDTHS.indexOf(current)
      const next = LINE_WIDTHS[Math.min(Math.max((index === -1 ? 1 : index) + direction, 0), LINE_WIDTHS.length - 1)]
      setSetting('editor.lineWidth', next, 'Line width', { log: false })
      flash(`Line width ${LINE_WIDTH_LABEL[next]}`)
    },
    [settingValues, setSetting, flash],
  )
  const resetProseZoom = useCallback(() => {
    // Genuinely UNSET both keys (null) — reset means "back to the locked default" (18.5px / 660px),
    // consistent with the changelog's per-entry Reset, not a concrete 19/medium the ladder would
    // then treat as an explicit choice. Silent (log:false): key-driven tweaks never touch the log.
    setSetting('editor.proseSize', null, 'Prose size', { log: false })
    setSetting('editor.lineWidth', null, 'Line width', { log: false })
    flash('Prose zoom reset')
  }, [setSetting, flash])

  // --- Quick-open + command palette (Task 13) ---
  // The shared overlay guard is declared above, before the Merge sheet that also goes through it.

  const applyFolderPieceMode = useCallback((selection: FolderPieceChoice) => {
    const mode = selection.mode === 'one' ? 'many' : 'one'
    void window.writeflex.collection
      .setPieceMode(selection.dir, selection.folderPath, mode)
      .then(() => {
        setSelectedFolderPiece({ ...selection, mode })
        flash(mode === 'one' ? 'Folder now appears as one Piece' : 'Folder contents now appear as many Pieces')
      })
      .catch((error: unknown) => flash(humanReadableError(error, 'Could not change how that folder appears.')))
  }, [flash])

  const openFolderPieceChooser = useCallback(() => {
    if (folderPieceContextDir === null) return
    void Promise.all([
      window.writeflex.collection.query(folderPieceContextDir, ''),
      window.writeflex.listCollection(folderPieceContextDir),
    ]).then(([population, collection]) => {
      const choicesByFolder = new Map<string, FolderPieceChoice>()
      if (population.ok) {
        for (const row of population.rows) {
          if (row.folderPath) choicesByFolder.set(row.folderPath, { dir: folderPieceContextDir, folderPath: row.folderPath, mode: 'one' })
        }
      }
      // Direct many-mode folders disappear from the Board population, but must remain reversible.
      for (const row of collection.rows) {
        if (row.folderPath) choicesByFolder.set(row.folderPath, { dir: folderPieceContextDir, folderPath: row.folderPath, mode: row.folderPieceMode ?? 'one' })
      }
      const choices = [...choicesByFolder.values()]
      if (choices.length === 0) {
        flash('This Collection has no recognisable folders to change.')
        return
      }
      setFolderPieceChoices(choices)
      openOverlay('folderPiece')
    }).catch((error: unknown) => flash(humanReadableError(error, 'Could not list the folders in this Collection.')))
  }, [flash, folderPieceContextDir, openOverlay])

  const runFolderPieceCommand = useCallback(() => {
    if (folderPieceContextDir === null) return
    if (selectedFolderPiece?.dir === folderPieceContextDir) applyFolderPieceMode(selectedFolderPiece)
    else openFolderPieceChooser()
  }, [applyFolderPieceMode, folderPieceContextDir, openFolderPieceChooser, selectedFolderPiece])
  const [settingsInitialSection, setSettingsInitialSection] = useState<string | undefined>()
  const [settingsDiarySessionRequired, setSettingsDiarySessionRequired] = useState(false)
  const openSettings = useCallback((initialSection?: string, diarySessionRequired = false) => {
    refreshSpeechVoices()
    setSettingsInitialSection(initialSection)
    setSettingsDiarySessionRequired(diarySessionRequired)
    openOverlay('settings')
  }, [openOverlay, refreshSpeechVoices])
  const openReadAloudSettings = useCallback(() => {
    openSettings('sec-read-aloud')
  }, [openSettings])
  const openSessionStarter = useCallback(() => {
    if (!activeRef.current) {
      flash('Open a document before starting a session.')
      return
    }
    if (typeof settingValues['diary.folder'] !== 'string' || settingValues['diary.folder'] === '') {
      openSettings('sec-diary', true)
      return
    }
    openOverlay('sessionStarter')
  }, [flash, openOverlay, openSettings, settingValues])
  const [skillsManagerInitialName, setSkillsManagerInitialName] = useState<string | undefined>(undefined)
  const openSkillsManager = useCallback((skillName?: string) => {
    setSkillsManagerInitialName(skillName)
    openOverlay('skills')
  }, [openOverlay])
  const updateSkillsRegistry = useCallback((result: { skills: SkillMeta[]; errors: Array<{ source: string; message: string }> }) => {
    setPaletteSkills(result.skills)
    setPaletteSkillErrors(result.errors)
  }, [])
  // The Collection overlay (Task 23) covers the editor but leaves it MOUNTED for buffer safety — so
  // its capture-phase shortcuts and SuggestionCallout's global keydown listener must stand down while
  // it is up, exactly as behind a sheet. Fold collectionDir into the same key-ownership ref (OR'd with
  // the sheet state, so the ref returns to the right value if a sheet is opened + closed over a
  // collection). Without this, a plain Enter to activate a collection row could resolve a hidden
  // staged suggestion. A ref + effect (not a synchronous set) is enough: the collection is opened by a
  // mouse click, so no same-tick keydown needs the value before this effect runs.
  useEffect(() => {
    // The configure sheet is its own state (it can sit ABOVE the Settings window), but it is still
    // an open sheet: while it is up it owns the keyboard, exactly as every other overlay does.
    overlayOpenRef.current = overlayActive !== null || collectionDir !== null || configureActionBarOpen
  }, [overlayActive, collectionDir, configureActionBarOpen, overlayOpenRef])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (!historicalView || overlayOpenRef.current || e.key !== 'Escape') return
      e.preventDefault()
      exitHistoricalView()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [historicalView, exitHistoricalView, overlayOpenRef])

  // Esc, in the README's order: a popover or menu, the reply composer, focus inside a card, then Settled today / My edits.
  // Bubble phase, so the popovers and the composer (which take Esc themselves) and every capture-phase Esc win. The card
  // step works in every mode: the caret goes back to the text, where it was.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || overlayOpenRef.current) return
      if (window.document.querySelector('.mg-menu, .rcm, .rbp, .rbp-notplaced, .sb-review-menu-wrap [role="dialog"]')) return
      const focused = window.document.activeElement
      if (focused instanceof HTMLElement && focused.closest('.wf-margin [data-margin-card], .wf-margin [data-margin-settled-card], .wf-margin [data-margin-settled-row]')) {
        // Leave the card first: the caret goes back to the text; the next Esc leaves the mode.
        event.preventDefault()
        focused.blur()
        // The caret goes to the start of the item's words (stepping selected them), so the next Esc is not spent collapsing a selection.
        const editor = editorRef.current?.view()
        if (editor) editor.dispatch({ selection: { anchor: editor.state.selection.main.from } })
        restoreEditorFocus()
        return
      }
      if (reviewMode === 'review') return
      if (focused instanceof HTMLElement && !focused.closest('.cm-editor') && focused.closest('textarea, input, select, [contenteditable="true"]')) return
      event.preventDefault()
      leaveReviewMode()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [reviewMode, leaveReviewMode, restoreEditorFocus, overlayOpenRef])

  // The palette is a shell surface: only raise it once a Workspace is bound (root is a string).
  const openPalette = useCallback(
    (mode: 'files' | 'commands') => {
      if (typeof root === 'string') openOverlay(mode)
    },
    [root, openOverlay],
  )
  // The workspace shell container — the fallback focus target when no editor view exists yet, so a
  // palette exit never drops the keyboard onto <body> (tabIndex -1: script-focusable, not tab-reachable).
  const shellRef = useRef<HTMLDivElement | null>(null)
  // Put the keyboard back somewhere real: the live editor view when one exists, else the shell
  // container (never <body>). Shared by every surface that exits back to the document — palette
  // closes, the agent panel's idle-Esc and its close button.
  const focusEditor = useCallback(() => {
    const view = editorRef.current?.view()
    if (view) view.focus()
    else shellRef.current?.focus()
  }, [])
  // The Place chip (ADR-0043): "Show where I am in the status bar" is on unless switched off. The
  // setting hides the chip only; ⌘K itself never reads it.
  const place = usePlace(editorRef, active, settingValues[SHOW_PLACE_KEY] !== false)
  const onPlaceChip = useCallback(() => pressCommandK(focusEditor), [focusEditor])
  // EVERY palette exit routes through this focus-restoring close — Esc, backdrop, a run command, or a
  // file open. It drops the overlay AND puts the keyboard back somewhere real. Editor commands
  // additionally self-focus the view via view.focus(); that is idempotent with this, so ordering
  // runPaletteCommand as close-then-run is safe.
  // Vaults ticket 03: is this root a vault (follows `vault:changed`), and the Make-vault sheet that makes it one.
  const rootIsVault = useVaultPresence(root)
  // The vault switcher (vaults ticket 06): opened from the sidebar's root name or the palette.
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const openSwitcher = useCallback(() => {
    revealFilesTab()
    setSwitcherOpen(true)
  }, [revealFilesTab])
  // Writing only and Titles | File names, the same choices the sidebar's filter bar shows.
  const [vaultPrefs, chooseVaultPrefs] = useVaultSidebarPrefs(typeof root === 'string' ? root : '')
  // Capture to research…: the sheet files one unit through `scout capture` for the open Piece (or the Folio whose Plan is open).
  const [researchCapture, setResearchCapture] = useState<{ project: string; selection: string } | null>(null)
  const researchTarget = researchCaptureTarget({ collectionDir, boardActive, boardDir, activePiece: active ?? null })
  const researchProject = researchTarget?.project ?? null
  const openResearchCapture = useCallback(() => {
    if (researchTarget === null) return
    setResearchCapture({ project: researchTarget.project, selection: researchTarget.withSelection ? (editorRef.current?.selectedText() ?? '') : '' })
    openOverlay('researchCapture')
  }, [researchTarget?.project, researchTarget?.withSelection, openOverlay])
  const openMakeVault = useCallback(() => { if (rootIsVault === false) openOverlay('makeVault') }, [openOverlay, rootIsVault])
  const closePalette = useCallback(() => {
    closeOverlay()
    focusEditor()
  }, [closeOverlay, focusEditor])
  const openSharingSetup = useCallback(() => {
    closeOverlay()
    setSharingSetupOpen(true)
  }, [closeOverlay])
  const closeSharingSetup = useCallback(() => {
    setSharingSetupOpen(false)
    focusEditor()
  }, [focusEditor])
  const sharablePiece = active && /\.(md|markdown)$/i.test(active) ? active : null
  // Ticket 09 (frame `folio`): with a part of a Folio open (or its Index Note), Share and the Shared mark
  // are the whole Folio's; a file in no Folio, or in a Folio's folder but not in its running order, is a piece.
  const sharableFolio = sharablePiece && folioPlace && (folioPlace.kind === 'piece' || folioPlace.kind === 'index')
    && (folioPlace.dir === '' || sharablePiece.startsWith(`${folioPlace.dir}/`)) ? folioPlace : null
  const sharingFolioDir = sharableFolio?.dir ?? null
  const sharingFolioName = sharableFolio?.name ?? null
  const revealSharingPath = useCallback((path: string, kind: 'file' | 'folder') => {
    setSharingPageOpen(false)
    revealTreeRow({ key: path, kind })
  }, [revealTreeRow])
  const openSharingPlan = useCallback((dir: string) => {
    setSharingPageOpen(false)
    openPlanIn(dir)
  }, [openPlanIn])
  const openSharingPage = useCallback(() => {
    if (!sharablePiece) { flash('Open a piece to share it.'); return }
    closeOverlay()
    setSharingSetupOpen(false)
    setSharesListOpen(false)
    setSharingPageOpen(true)
  }, [sharablePiece, closeOverlay, flash])
  const closeSharingPage = useCallback(() => {
    setSharingPageOpen(false)
    focusEditor()
  }, [focusEditor])
  /** Ticket 10: the Shares list of the Workspace open in this window (the collection row's Shares, the page's switch, the palette). */
  const openSharesList = useCallback(() => {
    if (typeof root !== 'string' || root === '') { flash('Open a collection to see its links.'); return }
    closeOverlay()
    setSharingSetupOpen(false)
    setSharingPageOpen(false)
    setSharesListOpen(true)
  }, [root, closeOverlay, flash])
  const closeSharesList = useCallback(() => {
    setSharesListOpen(false)
    focusEditor()
  }, [focusEditor])
  /** From the Shares list: open the link's piece (or a part of its Folio) and its Sharing page. */
  const openSharedPiece = useCallback((path: string) => {
    setSharesListOpen(false)
    open(path)
    setSharingPageOpen(true)
  }, [open])
  // The Shared mark follows the open piece and every change to its links or their publishing.
  useEffect(() => {
    if (!sharablePiece) { setShareMark(null); setSharingPageOpen(false); return }
    let live = true
    const read = (): Promise<PieceSharingView> => (sharingFolioDir !== null ? window.writeflex.sharing.folio(sharingFolioDir) : window.writeflex.sharing.piece(sharablePiece))
    const ask = (): void => { void read().then((view) => { if (live) setShareMark(view.mark) }).catch(() => {}) }
    ask()
    const off = window.writeflex.sharing.onChanged(ask)
    return () => { live = false; off() }
  }, [sharablePiece, sharingFolioDir])
  /** Insert widget… (ticket 05): the palette's file-picking step, for the open document. */
  const insertWidget = useCallback((): void => {
    if (active && typeof root === 'string') openOverlay('widgetPicker')
    else flash('Open a document to put a widget in it')
  }, [active, root, openOverlay, flash])
  /** A picked HTML file becomes one embed line at the caret; nothing else is written. */
  const chooseWidget = useCallback((choice: { rawPath: string }): void => {
    closeOverlay()
    const view = editorRef.current?.view()
    if (view) insertWidgetLine(view, choice.rawPath)
    else focusEditor()
  }, [closeOverlay, focusEditor])
  // The keyboard sheet (ticket 04) opens on the place the writer is at and gives the keyboard back to
  // where it was. The place is read when it opens: the pane row or editor that has the keyboard, else
  // the chip's last place, else the caret; null with no document and no row (no Here section).
  const [sheetPlace, setSheetPlace] = useState<Place | null>(null)
  const sheetReturnRef = useRef<HTMLElement | null>(null)
  const openCheatSheet = useCallback(() => {
    const element = document.activeElement
    sheetReturnRef.current = element instanceof HTMLElement && element !== document.body ? element : null
    const view = active ? editorRef.current?.view() ?? null : null
    const row = paneRowFromElement(element)
    setSheetPlace(row ? placeOfRow(row) : row === null || !place ? (view ? placeAt(view.state) : null) : place.place)
    openOverlay('cheatsheet')
  }, [active, openOverlay, place])
  const closeCheatSheet = useCallback(() => {
    closeOverlay()
    const element = sheetReturnRef.current
    sheetReturnRef.current = null
    if (element?.isConnected) element.focus()
    else focusEditor()
  }, [closeOverlay, focusEditor])
  const startExplicitSession = useCallback((request: { durationMinutes: number | null; targetWords: number | null; tick: boolean }) => {
    const path = activeRef.current
    const text = snapshot?.countText ?? editorRef.current?.currentDoc() ?? ''
    if (!path) return
    void window.writeflex.diary.startSession({
      path,
      words: countUnits(text, { excludeCommentLines: true }).words,
      ...request,
    }).then((result) => {
      if (result.kind === 'diary-required') {
        openSettings('sec-diary', true)
        return
      }
      if (result.kind === 'diary-root') {
        flash('The Diary does not record itself.')
        closePalette()
        return
      }
      setExplicitSession(result.session)
      closePalette()
    }).catch((error: unknown) => flash(humanReadableError(error, 'Could not start that session.')))
  }, [closePalette, flash, openSettings, snapshot])
  const endExplicitSession = useCallback(() => {
    void window.writeflex.diary.endSession().then((session) => {
      setExplicitSession(session)
    }).catch((error: unknown) => flash(humanReadableError(error, 'Could not end that session.')))
  }, [flash])
  const dismissCompletedSession = useCallback(() => {
    void window.writeflex.diary.dismissCompletedSession().catch((error: unknown) => flash(humanReadableError(error, 'Could not dismiss that completed session.')))
  }, [flash])
  const adjustExplicitSessionTarget = useCallback((targetWords: number | null) => {
    void window.writeflex.diary.adjustSessionTarget(targetWords).then(setExplicitSession)
      .catch((error: unknown) => flash(humanReadableError(error, 'Could not adjust that session target.')))
  }, [flash])

  /** Translate the live pending-agent layer into the projection input at its rendered positions. */
  const readAloudOptions = useCallback(
    (source: string, scope: { from: number; to: number } | null = null): SpeakableOptions => {
      if (changesPath !== activeRef.current) return { announce: 'announce' }
      const pending: PendingChange[] = changes
        .filter(
          (change) =>
            change.provenance === 'agent'
            && !change.snapshotId
            && (change.status === 'pending' || change.status === 'held'),
        )
        .flatMap((change) => {
          const range = resolveChangeRange(source, change)
          if (!range) return []
          if (scope && (range.to < scope.from || range.from > scope.to)) return []
          const proposedText = change.newText === '' ? change.oldText : change.newText
          const words = proposedText.trim() === '' ? 0 : proposedText.trim().split(/\s+/).length
          const kind: PendingChange['kind'] =
            change.status === 'held'
              ? 'held'
              : change.editClass === 'insert'
                ? 'insert'
                : change.newText === ''
                  ? 'delete'
                  : 'replace'
          return [{ id: change.id, from: range.from, to: range.to, kind, words }]
        })
      return { announce: 'announce', changes: pending }
    },
    [changes, changesPath],
  )

  /**
   * Capture one immutable reading source. A selected range keeps its original absolute offsets but
   * masks everything outside it with whitespace, so the existing paragraph player stops exactly at
   * the selection without teaching the player a second coordinate system.
   */
  const currentReadAloudInput = useCallback((): {
    source: string
    fromOffset: number
    options: SpeakableOptions
  } | null => {
    const view = editorRef.current?.view()
    if (!view || !activeRef.current || loadedPath.current !== activeRef.current) {
      flash('Open a document to read aloud')
      return null
    }
    const source = view.state.doc.toString()
    const selection = view.state.selection.main
    if (selection.empty) {
      if (source.trim() === '') {
        flash('There is no prose to read aloud')
        return null
      }
      return {
        source,
        fromOffset: selection.head,
        options: readAloudOptions(source),
      }
    }
    if (source.slice(selection.from, selection.to).trim() === '') {
      flash('The selection has no prose to read aloud')
      return null
    }
    const preserveLines = (text: string): string => text.replace(/[^\n]/g, ' ')
    const selectedSource =
      preserveLines(source.slice(0, selection.from))
      + source.slice(selection.from, selection.to)
      + preserveLines(source.slice(selection.to))
    return {
      source: selectedSource,
      fromOffset: selection.from,
      options: readAloudOptions(source, { from: selection.from, to: selection.to }),
    }
  }, [flash, readAloudOptions])

  const startReadAloud = useCallback(
    () => {
      const input = currentReadAloudInput()
      if (!input) return
      const available = refreshSpeechVoices()
      try {
        resumeFromPausedPositionRef.current = false
        playerRef.current!.start(input.source, input.fromOffset, input.options)
        const currentVoice =
          available.find((voice) => voice.uri === selectedVoiceURIRef.current)?.name
          ?? voiceName
        flash(`Reading with ${currentVoice}`)
      } catch (error) {
        flash(error instanceof Error ? error.message : String(error))
      }
    },
    [currentReadAloudInput, flash, refreshSpeechVoices, voiceName],
  )

  const pauseResumeReadAloud = useCallback(() => {
    const state = playerRef.current!.state()
    const resumeFromPausedPosition = state.paused && resumeFromPausedPositionRef.current
    const result = runPauseResumeReadAloud({
      player: playerRef.current!,
      currentInput: currentReadAloudInput,
      start: startReadAloud,
      resumeFromPausedPosition,
    })
    if (result === 'paused') {
      resumeFromPausedPositionRef.current = false
      flash('Reading paused')
    } else if (result === 'resumed') {
      resumeFromPausedPositionRef.current = false
      flash(resumeFromPausedPosition ? 'Reading resumed' : 'Reading resumed from the caret')
    }
  }, [currentReadAloudInput, flash, startReadAloud])

  const stopReadAloud = useCallback(() => {
    resumeFromPausedPositionRef.current = false
    playerRef.current!.stop()
    flash('Read aloud stopped')
  }, [flash])

  const setReadAloudRate = useCallback((rate: number) => {
    const next = normaliseReadAloudRate(rate)
    // Transport changes persist as the next session's default, but only changes made inside
    // Settings belong in the Settings changelog.
    setSetting(READ_ALOUD_RATE_SETTING, next, 'Default speed', { log: false })
    flash(`Reading speed ${next.toFixed(1)}×`)
  }, [flash, setSetting])

  const nudgeReadAloudRate = useCallback((delta: 0.1 | -0.1) => {
    const current = playerRef.current!.state().rate
    setReadAloudRate(current + Math.sign(delta) * 0.1)
  }, [setReadAloudRate])

  const skipReadAloudSentence = useCallback((direction: 1 | -1) => {
    resumeFromPausedPositionRef.current = false
    playerRef.current!.skipSentence(direction)
  }, [])

  const skipReadAloudParagraph = useCallback((direction: 1 | -1) => {
    resumeFromPausedPositionRef.current = false
    playerRef.current!.skipParagraph(direction)
  }, [])

  const returnToReading = useCallback(() => {
    if (!playerRef.current?.state().paused) return
    editorRef.current?.returnToReadAloudPosition()
  }, [])

  // A read session belongs to the active buffer. Switching tabs/Board removes its wash and audio.
  useEffect(() => {
    if (playerRef.current?.state().speaking) playerRef.current.stop()
  }, [active])

  // ⇧⌘B (Open Board) is dispatched by the T6 chord table; the menu click routes here as before.
  useEffect(() => window.writeflex.onMenuAction((action) => {
    if (action === 'open-board') openBoard()
  }), [openBoard])

  const [materialiseLink, setMaterialiseLink] = useState<{ target: string; gist: string } | null>(null)
  const captureSelection = useRef<{ from: number; to: number } | null>(null)
  const restoreCaptureFocus = useCallback(() => {
    const selection = captureSelection.current
    closeOverlay()
    requestAnimationFrame(() => {
      const view = editorRef.current?.view()
      if (!view) return
      if (selection) view.dispatch({ selection: { anchor: selection.from, head: selection.to } })
      view.focus()
      captureSelection.current = null
    })
  }, [closeOverlay])
  const openCapture = useCallback(() => {
    if (!root) return
    const view = editorRef.current?.view()
    const selection = view?.state.selection.main
    captureSelection.current = selection ? { from: selection.from, to: selection.to } : null
    openOverlay('capture')
  }, [root, openOverlay])
  const activateWikilink = useCallback((link: WikilinkRange) => {
    if (link.path) {
      if (link.ambiguous?.length) flash(`Several Pieces match “${link.target}”; opening ${link.path}.`)
      if (active) {
        setTabParents((parents) => ({ ...parents, [link.path as string]: active }))
        setLinkTrail((trail) => {
          const head = linkTrailIndex >= 0 ? trail.slice(0, linkTrailIndex + 1) : [active]
          const next = head.at(-1) === active ? [...head, link.path as string] : [active, link.path as string]
          setLinkTrailIndex(next.length - 1)
          return next
        })
      }
      open(link.path)
      return
    }
    const doc = editorRef.current?.currentDoc() ?? ''
    const seed = materialiseSeed(doc, link)
    setMaterialiseLink({ target: seed.title, gist: seed.gist })
    openOverlay('materialise')
  }, [active, flash, linkTrailIndex, open, openOverlay])
  const walkLinkTrail = useCallback((direction: -1 | 1) => {
    const next = linkTrailIndex + direction
    const path = linkTrail[next]
    if (!path) return
    setLinkTrailIndex(next)
    open(path)
  }, [linkTrail, linkTrailIndex, open])
  const followWikilink = useCallback(() => {
    if (!editorRef.current?.activateWikilink()) flash('Place the cursor in a wikilink first.')
  }, [flash])
  // Ask the agent about this… (Actions here ticket 03): the quoted context goes into the composer, prefilled and
  // focused, NOT sent. The same path as the palette ask-row; nothing about the agent's verbs or permissions changes.
  const askHere = useCallback(() => {
    const state = editorRef.current?.view()?.state
    focusComposer(state ? askComposerText(askContextAt(state, placeAt(state))) : '')
  }, [focusComposer])
  const runMaterialiseCommand = useCallback(() => {
    if (overlayActive === 'materialise') {
      document.querySelector<HTMLButtonElement>('.idea-pop .idea-action')?.click()
      return
    }
    followWikilink()
  }, [overlayActive, followWikilink])
  const closeMaterialise = useCallback(() => {
    setMaterialiseLink(null)
    closePalette()
  }, [closePalette])
  const materialised = useCallback(async (path: string) => {
    setMaterialiseLink(null)
    closeOverlay()
    await refresh()
    open(path)
  }, [closeOverlay, refresh, open])
  const captured = useCallback(async (path: string, target: CollectionTarget | undefined) => {
    if (target?.current !== false) await refresh()
    else flash(`Saved ${path} in ${target.name}.`)
    // The active buffer's wikilinks were resolved before this file existed; Capture leaves the buffer
    // untouched (unlike materialise, which opens the new file), so re-resolve explicitly.
    setWikilinkRefreshTick((tick) => tick + 1)
    restoreCaptureFocus()
  }, [refresh, restoreCaptureFocus, flash])
  const openCapturedExisting = useCallback((path: string, target: CollectionTarget | undefined) => {
    closeOverlay()
    if (target?.current === false) void window.writeflex.collection.focusPiece(target.windowId, path).catch(() => flash('That Piece is no longer available.'))
    else open(path)
  }, [closeOverlay, open, flash])

  // ⇧⌘N (Capture an idea) is dispatched by the T6 chord table; the menu click routes here.
  useEffect(() => window.writeflex.onMenuAction((action) => {
    if (action === 'capture-idea') openCapture()
    else if (action === 'follow-wikilink') followWikilink()
    else if (action === 'materialise-stub') runMaterialiseCommand()
  }), [openCapture, followWikilink, runMaterialiseCommand])

  const requestNameVersion = useCallback(() => {
    if (!active) {
      flash('Open a document before saving a version.')
      return
    }
    setVersionName('')
    setVersionDialogError('')
    setChangesOpen(true)
    openRightTab('versions')
    openOverlay('version')
  }, [active, flash, openOverlay, openRightTab])

  const clearDocument = useCallback(() => {
    const path = activeRef.current
    if (!path) {
      flash('Open a document before clearing it.')
      return
    }
    cancelAutosaveFor(path)
    void (async () => {
      // A route of the document owner (parcel 2a): the typing is written first, so the clear's rescue holds
      // it, and the clear runs holding the document's queue. The buffer is emptied only from the clear's
      // own receipt, and only when nothing was typed while the confirmation was up; typing that arrived
      // then is kept and the cleared file is asked about (Reload or Keep mine).
      const flushed = await owner.withFlushed([path], async (snapshots) => {
        const snapshot = snapshots.get(path)!
        const result = await window.writeflex.clearDocument(path)
        if (!result || 'refused' in result) return { result, outcome: null }
        return { result, outcome: owner.replaceFromMain(path, result.file, { since: snapshot.gen, mode: 'replace', discardLocal: true }) }
      })
      if (flushed.status !== 'acted') {
        const reason = guardRefusalPath.current === path ? refusalReasons.current.get(path) : undefined
        flash(`Nothing was cleared. ${reason ?? `Could not save ${path.split('/').at(-1) ?? path} first.`}`)
        return
      }
      const { result, outcome } = flushed.result
      if (!result) return
      if ('refused' in result) {
        // Another version reached the disk while the confirmation was up: it is not cleared (Muse S1).
        flash(`${path.split('/').at(-1) ?? path} changed on disk while you were confirming. Nothing was cleared.`)
        void reconcileWithDiskRef.current?.([path])
        return
      }
      if (outcome?.kind === 'moved') {
        // Typed while the confirmation was up: the typing is kept, and the cleared file is asked about.
        cancelAutosaveFor(path)
        raiseExternalDiskNotice(path, { kind: 'changed', dirty: true, diskText: outcome.diskText })
        flash(`Document cleared on disk. What you typed meanwhile is kept: choose Reload or Keep mine above the text.`)
        return
      }
      clearFileWriterState(path)
      uncheckpointed.current.add(path)
      setSavedTick((tick) => tick + 1)
      queueLiveCompareRefresh(path)
      flash(
        result.rescueDirectory
          ? `Document cleared. The previous content is in ${result.rescueDirectory}.`
          : 'The document is already empty.',
      )
    })().catch((error: unknown) => {
      flash(humanReadableError(error, 'Could not clear the document. The previous content is still intact.'))
    })
  }, [owner, cancelAutosaveFor, clearFileWriterState, flash, queueLiveCompareRefresh, raiseExternalDiskNotice])

  // The palette ask-row (Task 15): close the sheet, open the agent panel and hand the typed text to
  // the composer — prefilled and focused, NOT sent; the writer finishes the thought and presses ⏎.
  // Deliberately closeOverlay, not closePalette: the keyboard's destination is the composer.
  const askAgent = useCallback(
    (text: string) => {
      closeOverlay()
      focusComposer(text)
    },
    [closeOverlay, focusComposer],
  )
  /** A folder skill starts on a folder (ticket 10): open its thread in view and fire the run there. */
  const runSkillOnFolder = useCallback((name: string, dir: string) => {
    closeOverlay()
    openRightTab('agent')
    void window.writeflex.threads.openSkill(name).then((next) => {
      agent.replaceState(next)
      agent.promptAsIsOnFolder(dir)
    }).catch((error) => {
      setSkillToast({
        kind: 'error',
        skillName: name,
        details: error instanceof Error ? error.message : String(error),
      })
    })
  }, [agent, closeOverlay, openRightTab])
  const helpWithReport = useCallback((dir: string) => runSkillOnFolder(REPORT_SKILL, dir), [runSkillOnFolder])
  const runPaletteSkill = useCallback((name: string) => {
    closePalette()
    const skill = paletteSkills.find((entry) => entry.name === name)
    const launch = skillLaunchTarget(skill, skillDisplayName(skill ?? name), { activeFile: active, focusedFolder: folderFocus?.path ?? null })
    if (launch.kind === 'refused') {
      setSkillToast({
        kind: 'error',
        skillName: name,
        details: launch.message,
      })
      flash(launch.message)
      return
    }
    if (launch.kind === 'folder') {
      runSkillOnFolder(name, launch.dir)
      return
    }
    // usability review verdict (skills-gate4-070 item 6): a run must be WATCHABLE — open the thread and
    // fire in view; no background thread whose only signal is a late toast.
    openRightTab('agent')
    void window.writeflex.threads.openSkill(name).then((next) => {
      agent.replaceState(next)
      agent.promptAsIs()
    }).catch((error) => {
      setSkillToast({
        kind: 'error',
        skillName: name,
        details: error instanceof Error ? error.message : String(error),
      })
    })
  }, [active, agent, closePalette, flash, folderFocus, openRightTab, paletteSkills, runSkillOnFolder])
  const openPaletteSkill = useCallback((name: string) => {
    // The thread, not the editor, is the destination after this overlay closes.
    closeOverlay()
    openRightTab('agent')
    void window.writeflex.threads.openSkill(name).then((next) => {
      agent.replaceState(next)
      focusComposer()
    }).catch((error) => {
      setSkillToast({
        kind: 'error',
        skillName: name,
        details: error instanceof Error ? error.message : String(error),
      })
    })
  }, [agent, closeOverlay, focusComposer, openRightTab])
  const manageSkillsFromPalette = useCallback(() => {
    openSkillsManager()
  }, [openSkillsManager])
  const closeAgentPanel = useCallback(() => {
    collapseRightPane()
    focusEditor()
  }, [collapseRightPane, focusEditor])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (overlayOpenRef.current || typeof root !== 'string') return
      const intent = skillChordIntent(event)
      if (intent) {
        const skill = orderSkills(paletteSkills)[intent.index]
        if (!skill) return
        event.preventDefault()
        if (intent.openThread) openPaletteSkill(skill.name)
        else runPaletteSkill(skill.name)
        return
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [openPaletteSkill, overlayOpenRef, paletteSkills, root, runPaletteSkill])

  // Run an editing StateCommand against the live view, then return focus to it.
  const runEditorCommand = useCallback((command: StateCommand | EditorViewCommand, id?: string) => {
    const view = editorRef.current?.view()
    if (!view) return
    command(view)
    // An explicit run (the palette, Actions here, a toolbar button) is a run even when the command had
    // nothing to change (Unfold All with nothing folded); the Guide ticks it. Only the editor keymap,
    // where a command that declines lets the key fall through, reports a run when it handled the key.
    if (id) commandRan(id)
    view.focus()
  }, [])

  // --- Workspace search tab (Task 14, CH-1) ---
  // Search now lives in the left tabbed pane. Opening it uncollapses the pane, selects Search, and the
  // SearchPanel effect focuses the query input. Repeating ⇧⌘F refocuses; it never closes the pane.
  const openSearch = useCallback(() => {
    openLeftTab('search')
  }, [openLeftTab])
  const closeSearch = useCallback(() => {
    openFilesTab()
    const view = editorRef.current?.view()
    if (view) view.focus()
    else shellRef.current?.focus()
  }, [openFilesTab])
  // The archive search dock (WF-4B, ⌃⌘F): its own 460 px dock that hides both side panes while open
  // (CSS on .archive-open, so their state survives), closing after an insert with the caret back in
  // the draft. The ref lets the window chord handler hand the dock its own keys (⏎, ⌘⏎, arrows).
  const [archiveSearchOpen, setArchiveSearchOpen] = useState(false)
  const archiveSearchOpenRef = useRef(false)
  archiveSearchOpenRef.current = archiveSearchOpen
  const closeArchiveSearch = useCallback(() => {
    setArchiveSearchOpen(false)
    requestAnimationFrame(() => {
      const view = editorRef.current?.view()
      if (view) view.focus()
      else shellRef.current?.focus()
    })
  }, [])
  const toggleArchiveSearch = useCallback(() => {
    if (archiveSearchOpenRef.current) closeArchiveSearch()
    else {
      setArchiveSearchOpen(true)
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.archive-dock .archive-field input')?.focus())
    }
  }, [closeArchiveSearch])
  const insertArchiveQuote = useCallback((result: ArchiveResult, block: string): boolean => {
    const view = editorRef.current?.view()
    if (!view || !active || active.startsWith("writeflex://")) return false
    const spec = archiveQuoteInsert(view.state, block)
    view.dispatch(spec)
    const range = insertedRange(spec)
    if (range) flashApplied(view, range.from, range.to)
    flash(`Inserted from “${result.title}” · ⌘Z undoes`)
    closeArchiveSearch()
    return true
  }, [active, closeArchiveSearch, flash])
  const insertArchiveLink = useCallback((result: ArchiveResult, link: string): boolean => {
    const view = editorRef.current?.view()
    if (!view || !active || active.startsWith("writeflex://")) return false
    view.dispatch(archiveLinkInsert(view.state, link))
    flash(`Linked “${result.title}” · ⌘Z undoes`)
    closeArchiveSearch()
    return true
  }, [active, closeArchiveSearch, flash])
  // ⇧⌘F is an OPEN + SWITCH + ACTIVATE key. It never closes on repeat.
  const toggleSearch = useCallback(() => {
    openSearch()
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.search-panel .search-field input')?.focus())
  }, [openSearch])

  // Recently-used command ids (most recent first), floated to the top of the palette on an empty
  // query. Loaded per root; a bind/rebind re-reads the new Workspace's list.
  const [recentIds, setRecentIds] = useState<string[]>([])
  // Is this window's Workspace pinned on the start screen? Drives the Pin / Unpin palette command.
  const [workspacePinned, setWorkspacePinned] = useState(false)
  useEffect(() => {
    if (typeof root !== 'string') return setWorkspacePinned(false)
    let alive = true
    void window.writeflex.getPinned().then((list) => {
      if (alive) setWorkspacePinned(list.some((p) => p.root === root))
    })
    return () => {
      alive = false
    }
  }, [root])
  const togglePinWorkspace = useCallback(() => {
    const request = workspacePinned ? window.writeflex.unpinWorkspace() : window.writeflex.pinWorkspace()
    void request.then((list) => setWorkspacePinned(typeof root === 'string' && list.some((p) => p.root === root)))
  }, [workspacePinned, root])
  useEffect(() => {
    if (typeof root !== 'string') return setRecentIds([])
    try {
      const raw = localStorage.getItem(recentsKey(root))
      setRecentIds(raw ? (JSON.parse(raw) as string[]) : [])
    } catch {
      setRecentIds([])
    }
  }, [root])
  const recordRecent = useCallback(
    (id: string) => {
      if (typeof root !== 'string') return
      // Keep the setState updater pure — compute the next list, set it, then persist as a post-set
      // side effect (rather than writing to localStorage from inside the updater).
      const next = [id, ...recentIds.filter((x) => x !== id)].slice(0, 8)
      setRecentIds(next)
      try {
        localStorage.setItem(recentsKey(root), JSON.stringify(next))
      } catch {
        /* private mode / quota — recents are a nicety, never block the command */
      }
    },
    [root, recentIds],
  )

  const browseFolderFile = useCallback(async (direction: 1 | -1) => {
    const current = activeRef.current
    if (!current) return
    const target = folderBrowsePath(files, current, direction)
    if (!target || target === current) return
    // The owner writes the buffer until it is saved, detaches it in the turn of the last check, and forgets
    // it only if nothing moved since (document-owner.ts; Muse M1, round 2): typing during the flush is
    // written first, or the browse does not happen.
    cancelAutosaveFor(current)
    const flushed = await owner.withFlushed([current], () => {
      if (!owner.forgetIfSaved(current)) return false
      clearExternalDiskNotice(current) // its tab is replaced: a notice does not outlive it
      return true
    }, { detach: true })
    if (flushed.status !== 'acted' || !flushed.result) {
      const name = current.split('/').at(-1) ?? current
      if (guardRefusalPath.current !== current) {
        flash(flushed.status === 'refused' ? `Could not save ${name} — staying on this file` : `${name} was still being edited while it was saved — staying on this file`)
      }
      return
    }
    setCollectionDir(null)
    replaceActiveTab(target)
  }, [files, flash, replaceActiveTab, owner, cancelAutosaveFor, clearExternalDiskNotice])

  // Writing goal (Round A T5, ADR-0002/0019/0028): a `goal:` in the ACTIVE document's frontmatter
  // upgrades the status-bar count cell into the Goal Gauge — one instrument, upgraded, never a
  // second chip. Derived live off the shared snapshot (hand-edited frontmatter counts too); words
  // are DOCUMENT-scoped (a goal is about the piece, not the selection). Malformed `goal:` → null →
  // the plain count, no error chrome.
  const goal = useMemo(() => {
    if (!snapshot) return null
    const parsed = parseGoal(parseFrontmatter(snapshot.countText))
    if (!parsed) return null
    return { ...parsed, words: countUnits(snapshot.countText, { excludeCommentLines: true }).words }
  }, [snapshot])

  useAmbientSnapshot({ root: root ?? null, active: boardActive || collectionDir !== null ? null : active, loadedFile, collection: activeCollectionPath === active ? activeCollectionDir : undefined,
    writer: writerMode, view: viewMode, editorRef, explicitSession, sessionWords: session.sessionWords, lastWriterEditAt, onError: flash })

  // Write the goal through the direct goal:set channel (NEVER the staged frontmatter.set agent
  // capability), then reconcile the returned file into the open buffer — the restore-version
  // pattern. A dirty buffer is flushed first so the write never races an outgoing autosave.
  const setWritingGoal = useCallback(async (target: number | null, due: string | null): Promise<void> => {
    const path = activeRef.current
    if (!path) return
    // A route of the document owner (parcel 2a): the buffer is written until saved, then the goal is
    // written holding the document's queue, based on the baseline the flush left (goal:set carries it as
    // its basis, and main writes only over that version). The buffer takes the file with the goal only
    // from the goal write's own receipt, and only when nothing was typed while main wrote it.
    const flushed = await owner.withFlushed([path], async (snapshots) => {
      const snapshot = snapshots.get(path)!
      const saved = await window.writeflex.setGoal(path, target, due, basisFromBaseline(snapshot.baselineDisk))
      if ('refused' in saved) return { saved, outcome: null }
      return { saved, outcome: owner.replaceFromMain(path, saved, { since: snapshot.gen, mode: 'replace' }) }
    })
    if (flushed.status !== 'acted') {
      throw new Error(flushed.status === 'still-unsaved'
        ? 'The document was still being edited while it was saved, so the goal was not written'
        : 'Could not save the document, so the goal was not written')
    }
    const { saved, outcome } = flushed.result
    if ('refused' in saved) {
      // Another version is on disk than the one the buffer was based on: no goal is written over it.
      const buffer = bufferNow(path)
      if (buffer !== null) noteDiskChangedUnderBuffer(path, saved.diskText, buffer)
      throw new Error('The document changed on disk, so the goal was not written. Choose Reload or Keep mine above the text')
    }
    if (outcome?.kind === 'moved') {
      // Typing arrived while main wrote the goal: it is kept (never replaced by the file), and the file
      // with the goal is asked about like any outside change; the buffer is still based on what it was.
      cancelAutosaveFor(path)
      if (!sameDiskNotice(externalDiskNoticesRef.current.get(path), 'changed', outcome.diskText)) {
        raiseExternalDiskNotice(path, { kind: 'changed', dirty: true, diskText: outcome.diskText })
      }
      return
    }
    setSavedTick((tick) => tick + 1)
    flash(target === null ? 'Writing goal cleared' : 'Writing goal set')
  }, [owner, bufferNow, flash, cancelAutosaveFor, noteDiskChangedUnderBuffer, raiseExternalDiskNotice])
  const openGoalDialog = useCallback(() => {
    if (activeRef.current) openOverlay('goal')
    else flash('Open a document to set its writing goal')
  }, [openOverlay, flash])

  // Export (Round B T6/T7, ADR-0029). The sheet is the round's one designed surface, and it is
  // raised with the facts it needs to draw itself: what the piece is called, how long it is, and
  // the Collection it sits in — because the scope rows exist ONLY inside a Collection, and a lone
  // piece must never see a choice it cannot make. Both are read BEFORE the sheet opens, so it never
  // redraws under the writer's hand.
  const [exportSubject, setExportSubject] = useState<
    { openId: number; workspaceRoot: string; path: string; title: string; words: number; collection: { dir: string; name: string; pieces: number; htmlPieces?: number; leftOut?: FolioLeftOut[] } | null; inFolio: boolean; presetAction?: ExportPresetOpenAction; tocDepthHomes: Record<ExportScope, ExportTocDepthHome | null> } | null
  >(null)
  // Each open of the sheet gets a new id, so the sheet remounts and its scope starts from this open's default.
  const exportOpenSeq = useRef(0)
  const openExportSheet = useCallback(async (from?: string, presetAction?: ExportPresetOpenAction, fromCollection?: string) => {
    // The quiet menu exports the ROW it was opened on; the palette exports the active document.
    const viewed = fromCollection === undefined ? null : await window.writeflex.listCollection(fromCollection)
    if (viewed && viewed.rows.length === 0) { flash('There are no documents in this collection to export.'); return }
    const path = viewed?.rows[0]?.path ?? viewed?.cover?.path ?? from ?? activeRef.current
    if (!path) { flash('Open a document to export it'); return }
    if (!root) { flash('Open a Workspace to export a document'); return }
    const text = path === activeRef.current
      ? editorRef.current?.currentDoc() ?? ''
      : await window.writeflex.readFile(path).then((read) => read.content).catch(() => '')
    let collection: { dir: string; name: string; pieces: number; htmlPieces?: number; leftOut?: FolioLeftOut[] } | null = null
    let inFolio = false
    try {
      const place = await exportPlaceFor(path, {
        folioDirOf: async (of) => (await window.writeflex.readFolioPlace(of))?.dir ?? null,
        hasManifest: async (of) => (await window.writeflex.readFolioPieces(of)) !== null,
        collectionDirFor,
      })
      const dir = fromCollection ?? place.dir
      // Main resolves the Folio: the pieces HTML will write, and the listed entries it will leave out.
      // A Folio writes its listed pieces in both formats; any other Collection writes its own rows.
      const folio = await window.writeflex.readFolioPieces(dir)
      if (fromCollection !== undefined || folio || (await window.writeflex.collection.status(dir)).collection) {
        const listed = await window.writeflex.listCollection(dir)
        const htmlPieces = folio ? folio.pieces.length : listed.rows.length
        if (htmlPieces || listed.rows.length || folio?.leftOut.length) {
          const sources = documentsUnder(folderPrefix(dir)).flatMap((path) => {
            const source = bufferNow(path) ?? unsaved.textOf(path)
            return source === null || source === undefined ? [] : [{ path, source }]
          })
          collection = { dir, name: await window.writeflex.exportTitle({ scope: 'collection', dir, sources }), pieces: htmlPieces, htmlPieces, ...(folio?.leftOut.length ? { leftOut: folio.leftOut } : {}) }
          inFolio = fromCollection !== undefined || place.inFolio
        }
      }
    } catch {
      collection = null // a folder that cannot be read is simply not a Collection for this sheet
    }
    // The Contents depth each scope keeps in its own file: the document's `toc_depth`, the Folio's in its
    // Index Note (none when the folder has no Index Note). An open document's own text is what it says.
    // Read only: a depth the writer chooses is saved by main when the HTML export runs.
    const readHome = (input: TocDepthScope): Promise<TocDepthSource | null> =>
      window.writeflex.readTocDepth(input).catch(() => null)
    const pieceScope: TocDepthScope = { kind: 'document', path }
    const collectionScope: TocDepthScope | null = collection ? { kind: 'folio', dir: collection.dir } : null
    const pieceSource = await readHome(pieceScope)
    const collectionSource = collectionScope ? await readHome(collectionScope) : null
    const pieceBuffer = bufferNow(path)
    if (pieceSource && pieceBuffer !== null) pieceSource.depth = tocDepthOf(pieceBuffer)
    if (collectionSource) {
      const indexBuffer = bufferNow(collectionSource.path)
      if (indexBuffer !== null) collectionSource.depth = tocDepthOf(indexBuffer)
    }
    const homeOf = (source: TocDepthSource | null, label: string): ExportTocDepthHome | null =>
      source ? { label, depth: source.depth } : null
    setExportSubject({
      openId: ++exportOpenSeq.current,
      workspaceRoot: root,
      path,
      title: await window.writeflex.exportTitle({ scope: 'piece', path, source: text }),
      words: countUnits(text, { excludeCommentLines: true }).words,
      collection,
      inFolio,
      ...(presetAction ? { presetAction } : {}),
      tocDepthHomes: {
        piece: homeOf(pieceSource, 'this document (toc_depth in its frontmatter)'),
        collection: homeOf(collectionSource, `${collection?.name ?? 'this Folio'} (toc_depth in its Index Note)`),
      },
    })
    openOverlay('export')
  }, [flash, openOverlay, root, documentsUnder, bufferNow])

  /** A piece under an unanswered changed-on-disk notice is not exported: the file may not be what is on
   *  screen (2b review P2). The sentence for the export sheet, or undefined when no notice stands. */
  const exportRefusedUnderNotice = useCallback((path: string): string | undefined => {
    const notice = externalDiskNoticesRef.current.get(path)
    if (!notice) return undefined
    const name = path.split('/').at(-1) ?? path
    return notice.kind === 'removed'
      ? `${name} is no longer readable on disk, so nothing was exported. Choose Keep mine above the text to write it again, then export.`
      : `${name} changed on disk, so nothing was exported. Choose Reload or Keep mine above the text, then export again.`
  }, [])
  /** One export attempt, end to end: flush the buffer (so the file is what is on screen), ask the
   *  system save dialog where it goes, then write it. A cancelled dialog writes nothing and says
   *  nothing; a failure comes back as the sentence the main process wrote. */
  const runExport = useCallback(
    async (choice: { scope: ExportScope; format: ExportFormat; html?: HtmlExportOptions; keepTocDepth?: true }): Promise<ExportSheetOutcome> => {
      const subject = exportSubject
      if (!subject) return { status: 'error', message: 'There is no document to export. Open a piece and try again.' }
      try {
        // The PRD's first state: an unsaved buffer is flushed FIRST, so the export reflects what the
        // writer sees rather than the last autosave.
        const flushed = await flushPaths([subject.path])
        if (flushed.status !== 'saved') {
          return { status: 'error', message: exportRefusedUnderNotice(flushed.path) ?? 'WriteFlex could not save this piece, so nothing was exported. Try again, or check the file’s permissions.' }
        }
        const bundling = choice.scope === 'collection' && subject.collection !== null
        if (bundling && subject.collection) {
          // Every piece a bundle writes is inside `dir`: a Collection's rows are, and main refuses any
          // Folio entry that is not (folio.ts). Every document under `dir` the app knows of must be saved:
          // one under an unanswered notice refuses the export with the notice's sentence, dot or none (2b
          // round 3 ruling, finding 2).
          const flushedUnder = await flushPaths(documentsUnder(folderPrefix(subject.collection.dir)))
          if (flushedUnder.status !== 'saved') {
            return { status: 'error', message: exportRefusedUnderNotice(flushedUnder.path) ?? 'WriteFlex could not save a changed piece, so nothing was exported. Check its permissions and try again.' }
          }
        }
        const request = bundling && subject.collection
          ? ({ scope: 'collection', dir: subject.collection.dir, format: choice.format } as const)
          : ({ scope: 'piece', path: subject.path, format: choice.format } as const)
        const { target } = await window.writeflex.chooseExportTarget(request)
        if (target === null) return { status: 'cancelled' }
        // e2e only: the destination sheet stays open here until `releaseSlowSave`.
        if (window.writeflex.e2eWriteHooks && e2eSaveBehaviourRef.current === 'hold-export') {
          await new Promise<void>((resolve) => { e2eSlowSaveReleaseRef.current = resolve })
        }
        // The check above was made before the destination sheet opened; a document may have changed on disk,
        // or been typed in, while it was open (2b round 3 review, finding 3). The members are asked for and
        // checked again now, and held from that check until main has read them for the export: no save, no
        // watcher reconcile and no folder route under the collection runs while main reads.
        // Invariant: an export reads only documents that were saved with no unanswered notice at the moment
        // it read them.
        const members = (): string[] => request.scope === 'collection'
          ? [...new Set([subject.path, ...documentsUnder(folderPrefix(request.dir))])]
          : [subject.path]
        for (const p of members()) cancelAutosaveFor(p)
        // A depth the writer chose in the sheet rides the request: main exports with it and then saves it
        // with the document or the Folio's Index Note (export.ts). The file it wrote is still held here, so
        // an open buffer takes it from the receipt, as goal:set's answer is taken.
        const keep = choice.keepTocDepth ? { keepTocDepth: true } : {}
        const exported = await owner.withFlushed(members, async (snapshots) => {
          const outcome = await (request.scope === 'collection'
            ? window.writeflex.exportBundle({ dir: request.dir, format: choice.format, target, ...(choice.html ? { html: choice.html } : {}), ...keep })
            : window.writeflex.exportDocument({ path: request.path, format: choice.format, target, ...(choice.html ? { html: choice.html } : {}), ...keep }))
          const saved = outcome.tocDepthSave
          if (!saved || 'refused' in saved || saved.written === undefined) return { outcome, written: null }
          const snapshot = snapshots.get(saved.file.path)
          if (snapshot?.baselineDisk === undefined) return { outcome, written: null }
          return { outcome, written: { path: saved.file.path, result: owner.replaceFromMain(saved.file.path, saved, { since: snapshot.gen, mode: 'replace' }) } }
        },
        request.scope === 'collection' ? { scope: folderPrefix(request.dir) } : {})
        if (exported.status !== 'acted') {
          return { status: 'error', message: exportRefusedUnderNotice(exported.path) ?? 'WriteFlex could not save a changed piece, so nothing was exported. Check its permissions and try again.' }
        }
        const { outcome, written } = exported.result
        if (written?.result.kind === 'moved') {
          cancelAutosaveFor(written.path)
          if (!sameDiskNotice(externalDiskNoticesRef.current.get(written.path), 'changed', written.result.diskText)) {
            raiseExternalDiskNotice(written.path, { kind: 'changed', dirty: true, diskText: written.result.diskText })
          }
        } else if (written) {
          setSavedTick((tick) => tick + 1)
        }
        const saved = outcome.tocDepthSave
        return {
          status: 'done',
          target: outcome.target,
          missingImages: outcome.missingImages,
          unreadableImages: outcome.unreadableImages,
          pieces: outcome.pieces,
          listed: outcome.listed,
          // A depth that could not be saved with the file never fails the export; the sheet says why.
          ...(saved && 'refused' in saved ? { tocDepthNote: saved.message } : {}),
        }
      } catch (error) {
        return { status: 'error', message: humanReadableError(error, 'WriteFlex could not export that. Choose somewhere else, or try again.') }
      }
    },
    [exportSubject, flushPaths, documentsUnder, exportRefusedUnderNotice, owner, cancelAutosaveFor, raiseExternalDiskNotice],
  )

  // The command list the palette (⇧⌘P) lists: the editor's paletteCommands mapped to icons + display
  // shortcuts, plus app-level actions. Typewriter routes through App's toggle (so the status chip
  // + flash update, not just the CM compartment); every other editor command runs against the view.
  const runFolioPlanCommand = useCallback((command: PlanCommandName): void => {
    if (['details', 'role', 'agents-both', 'agents-agents', 'agents-claude', 'front-matter-choose', 'not-in-outline-toggle', 'adopt', 'adopt-front-matter'].includes(command)) openLeftTab('outline')
    dispatchPlanCommand(command)
  }, [openLeftTab])

  const paletteCommandList = useMemo<AppCommand[]>(() => {
    const editorState = editorRef.current?.view()?.state
    const editorRows: AppCommand[] = commandRegistry.filter((command) => command.surfaces.includes('palette') && command.run && (!command.when || (editorState && command.when(editorState)))).map((pc) => ({
      id: pc.id,
      label: pc.label,
      group: pc.task,
      subgroup: pc.subgroup,
      keywords: pc.keywords,
      icon: COMMAND_ICONS[pc.id] ?? Command,
      keys: typeof pc.keys === 'string' ? formatShortcutKey(pc.keys) : pc.keys?.map(formatShortcutKey).join('  '),
      run: pc.id === 'view.typewriter'
        ? () => { toggleTypewriter(); commandRan(pc.id) }
        : VIEW_MODE_COMMANDS[pc.id]
          ? () => { selectViewMode(VIEW_MODE_COMMANDS[pc.id]); commandRan(pc.id) }
          : () => runEditorCommand(pc.run!, pc.id),
    }))
    const appRows: Array<Omit<AppCommand, 'group'>> = [
      { id: 'metadata.show', label: 'Show metadata', icon: Command, run: () => { editorRef.current?.setMetadataCollapsed(false) } },
      { id: 'metadata.collapse', label: 'Collapse metadata', icon: Command, run: () => editorRef.current?.setMetadataCollapsed(true) },
      { id: 'metadata.edit', label: 'Edit metadata', icon: Command, run: () => editorRef.current?.editMetadata() },
      { id: NEXT_TAB_COMMAND.id, label: NEXT_TAB_COMMAND.label, icon: ChevronRight, keys: NEXT_TAB_COMMAND.keys as string, run: () => cycle(1) },
      { id: PREVIOUS_TAB_COMMAND.id, label: PREVIOUS_TAB_COMMAND.label, icon: ChevronLeft, keys: PREVIOUS_TAB_COMMAND.keys as string, run: () => cycle(-1) },
      { id: NEXT_PANEL_TAB_COMMAND.id, label: NEXT_PANEL_TAB_COMMAND.label, icon: ChevronRight, keys: NEXT_PANEL_TAB_COMMAND.keys as string, run: () => cycleRightTab(1, rightPaneTabsFor(guideInRow)) },
      { id: PREVIOUS_PANEL_TAB_COMMAND.id, label: PREVIOUS_PANEL_TAB_COMMAND.label, icon: ChevronLeft, keys: PREVIOUS_PANEL_TAB_COMMAND.keys as string, run: () => cycleRightTab(-1, rightPaneTabsFor(guideInRow)) },
      { id: NEXT_FOLDER_FILE_COMMAND.id, label: NEXT_FOLDER_FILE_COMMAND.label, icon: ChevronRight, keys: NEXT_FOLDER_FILE_COMMAND.keys as string, run: () => void browseFolderFile(1) },
      { id: PREVIOUS_FOLDER_FILE_COMMAND.id, label: PREVIOUS_FOLDER_FILE_COMMAND.label, icon: ChevronLeft, keys: PREVIOUS_FOLDER_FILE_COMMAND.keys as string, run: () => void browseFolderFile(-1) },
      { id: 'outline.rowMenu', label: registryCommand('outline.rowMenu').label, icon: List, run: () => requestOutline('rowMenu') },
      { id: 'outline.expandAll', label: registryCommand('outline.expandAll').label, icon: List, run: () => requestOutline('expandAll') },
      { id: 'outline.collapseAll', label: registryCommand('outline.collapseAll').label, icon: List, run: () => requestOutline('collapseAll') },
      ...([1, 2, 3, 4, 5, 6] as const).map((level) => ({ id: `outline.showLevel${level}`, label: registryCommand(`outline.showLevel${level}`).label, icon: List, run: () => requestOutline({ levels: level }) })),
      { id: 'outline.showAllLevels', label: registryCommand('outline.showAllLevels').label, icon: List, run: () => requestOutline({ levels: null }) },
      { id: 'outline.toggleWordCounts', label: registryCommand('outline.toggleWordCounts').label, icon: List, run: () => requestOutline('toggleWordCounts') },
      { id: 'navigation.linkTrailBack', label: 'Back along link trail', icon: ChevronLeft, keys: '⌃⌘←', run: () => walkLinkTrail(-1) },
      { id: 'navigation.linkTrailForward', label: 'Forward along link trail', icon: ChevronRight, keys: '⌃⌘→', run: () => walkLinkTrail(1) },
      { id: 'navigation.nextBlock', label: 'Next rendered block', icon: ChevronRight, keys: '⌃⌘↓', run: () => { const view = editorRef.current?.view(); if (view) jumpToBlock(view, 1) } },
      { id: 'navigation.previousBlock', label: 'Previous rendered block', icon: ChevronLeft, keys: '⌃⌘↑', run: () => { const view = editorRef.current?.view(); if (view) jumpToBlock(view, -1) } },
      { id: HIDE_STRIKES_COMMAND.id, label: HIDE_STRIKES_COMMAND.label, icon: Highlighter, run: toggleHideStrikes },
      { id: HIDE_INSERTS_COMMAND.id, label: HIDE_INSERTS_COMMAND.label, icon: Highlighter, run: toggleHideInserts },
      { id: 'view.toggleLeftPane', label: 'Show/hide left sidebar', icon: LayoutPanelLeft, keys: '⌘[', run: toggleLeftPane },
      { id: 'view.toggleRightPane', label: 'Show/hide right pane', icon: Columns3, keys: '⌘]', run: toggleRightPane },
      { id: 'view.files', label: 'Open Files', icon: LayoutPanelLeft, keys: '⇧⌘E', run: openFilesTab },
      { id: ACTION_BAR_COMMAND.id, label: ACTION_BAR_COMMAND.label, icon: PanelTop, run: toggleActionBar },
      { id: CONFIGURE_ACTION_BAR_COMMAND.id, label: CONFIGURE_ACTION_BAR_COMMAND.label, icon: SlidersHorizontal, run: () => setConfigureActionBarOpen(true) },
      { id: 'app.quickOpen', label: 'Quick Open…', icon: Search, keys: '⇧⌘K', run: () => overlayActive === 'files' ? closePalette() : openPalette('files') },
      { id: 'app.commandPalette', label: 'Command Palette…', icon: Command, keys: '⇧⌘P', run: () => overlayActive === 'commands' ? closePalette() : openPalette('commands') },
      // ⌥⌘F now discloses Replace in Find (S5), so the Files filter keeps its discoverable path here
      // in the palette rather than a global chord (its previous ⌥⌘F was reassigned).
      { id: FILTER_FILES_COMMAND.id, label: FILTER_FILES_COMMAND.label, icon: ListFilter, run: focusSidebarFilter },
      { id: 'writer.newSession', label: registryCommand('writer.newSession').label, icon: GitCommitHorizontal, run: () => { if (active) { startNewSession(active); flash('New review session started') } } },
      { id: ACCEPT_SESSION_COMMAND.id, label: ACCEPT_SESSION_COMMAND.label, icon: Check, run: () => void acceptWriterSession() },
      { id: REVERT_TO_ACTIVE_COMMAND.id, label: REVERT_TO_ACTIVE_COMMAND.label, icon: RotateCcw, run: revertSelectedToActive },
      { id: SEND_ORIGINAL_TO_SCRATCHPAD_COMMAND.id, label: SEND_ORIGINAL_TO_SCRATCHPAD_COMMAND.label, icon: StickyNote, run: sendSelectedOriginalToScratchpad },
      { id: 'view.outline', label: 'Open Outline', icon: List, keys: '⇧⌘O', run: openOutlineTab },
      { id: OPEN_BOARD_COMMAND.id, label: OPEN_BOARD_COMMAND.label, icon: Columns3, keys: OPEN_BOARD_COMMAND.keys as string, run: openBoard },
      { id: 'collection.openDashboard', label: registryCommand('collection.openDashboard').label, icon: FolderOpen, run: openFolderDashboard },
      { id: 'vault.make', label: registryCommand('vault.make').label, icon: Library, disabled: rootIsVault !== false, disabledReason: rootIsVault ? 'This folder is already a vault' : 'Open a folder first', run: openMakeVault },
      { id: 'vault.switch', label: registryCommand('vault.switch').label, icon: ChevronsUpDown, run: openSwitcher },
      { id: 'vault.writingOnly', label: registryCommand('vault.writingOnly').label, icon: ListFilter, checked: rootIsVault === true ? vaultPrefs.writingOnly : undefined, disabled: rootIsVault !== true, disabledReason: 'This folder is not a vault', run: () => chooseVaultPrefs({ writingOnly: !vaultPrefs.writingOnly }) },
      { id: 'vault.showTitles', label: registryCommand('vault.showTitles').label, icon: Heading, checked: rootIsVault === true ? vaultPrefs.titles : undefined, disabled: rootIsVault !== true, disabledReason: 'This folder is not a vault', run: () => chooseVaultPrefs({ titles: !vaultPrefs.titles }) },
      { id: 'plan.open', label: 'Open Folio outline', icon: ListOrdered, run: openPlan },
      { id: 'folio.linkFiles', label: registryCommand('folio.linkFiles').label, icon: BookOpen, disabled: openFolioDir === null, disabledReason: 'Open a Folio first', run: () => { if (openFolioDir !== null) void requestIdentityLinks.current(openFolioDir, true) } },
      { id: 'folio.open', label: registryCommand('folio.open').label, icon: BookOpen, disabled: openFolioDir === null, disabledReason: 'Open a Folio or one of its files first', run: openFolio },
      { id: 'research.capture', label: registryCommand('research.capture').label, icon: BookOpenCheck, disabled: researchProject == null, disabledReason: 'Open a Piece or a Folio first', run: openResearchCapture },
      { id: 'folio.movePieceUp', label: registryCommand('folio.movePieceUp').label, icon: ArrowUp, disabled: !folioPlace, disabledReason: 'This file is not in a Folio', run: () => { void runFolioCommand('up') } },
      { id: 'folio.movePieceDown', label: registryCommand('folio.movePieceDown').label, icon: ArrowDown, disabled: !folioPlace, disabledReason: 'This file is not in a Folio', run: () => { void runFolioCommand('down') } },
      { id: 'folio.addToRunningOrder', label: registryCommand('folio.addToRunningOrder').label, icon: Plus, disabled: !folioPlace, disabledReason: 'This file is not in a Folio', run: () => { void runFolioCommand('add') } },
      { id: 'folio.addAllToRunningOrder', label: registryCommand('folio.addAllToRunningOrder').label, icon: ListPlus, disabled: !folioPlace, disabledReason: 'This file is not in a Folio', run: () => { void runFolioCommand('addAll') } },
      { id: 'folio.undoLastChange', label: registryCommand('folio.undoLastChange').label, icon: Undo2, disabled: !folioRunningOrder.canUndo, disabledReason: 'There is no running-order change to undo', run: () => { void folioRunningOrder.undo() } },
      { id: 'folio.previousPiece', label: 'Previous piece in Folio', icon: ChevronLeft, disabled: !folioPlace?.previous, disabledReason: 'This file has no previous piece in a Folio', run: () => { if (folioPlace?.previous) open(folioPlace.previous.path) } },
      { id: 'folio.nextPiece', label: 'Next piece in Folio', icon: ChevronRight, disabled: !folioPlace?.next, disabledReason: 'This file has no next piece in a Folio', run: () => { if (folioPlace?.next) open(folioPlace.next.path) } },
      { id: 'board.makeIdeaFromOffcut', label: 'Make idea from offcut', icon: Lightbulb, disabled: !boardCommandsOn, disabledReason: 'Open the Board and select an offcut first', run: () => dispatchBoardCommand('make-idea') },
      { id: 'board.toggleOffcuts', label: 'Show / Hide offcuts', icon: Columns3, disabled: !boardCommandsOn, disabledReason: 'Open the Board first', run: () => dispatchBoardCommand('toggle-offcuts') },
      { id: 'board.undoMaterialStep', label: 'Undo last offcut, scrap or source step', icon: Undo2, disabled: !boardCommandsOn, disabledReason: 'Open the Board first', run: () => dispatchBoardCommand('undo-step') },
      { id: 'board.moveColumnLeft', label: 'Move column left', icon: ChevronLeft, disabled: !boardCommandsOn, disabledReason: 'Open the Board first', run: () => dispatchBoardCommand('move-column-left') },
      { id: 'board.moveColumnRight', label: 'Move column right', icon: ChevronRight, disabled: !boardCommandsOn, disabledReason: 'Open the Board first', run: () => dispatchBoardCommand('move-column-right') },
      ...COLLECTION_PAGE_COMMANDS.filter(([name]) => (name !== 'bulk-folio' || (collectionDir !== null && canTurnBack)) && (name !== 'make-folio' || canStartCollectionFolio)).map(([name, label]) => ({ id: `collection.page.${name}`, label, icon: FolderOpen, disabled: collectionDir === null, disabledReason: 'Open a collection first', run: () => dispatchCollectionPageCommand(name) })),
      { id: 'collection.newDocument', label: 'New document', icon: FilePlus2, disabled: !root, disabledReason: 'Open a folder first', run: () => { void newPiece(collectionDir ?? (boardActive ? boardDir : activeCollectionDir)) } },
      { id: 'collection.startFolio', label: 'Start a Folio outline', icon: BookOpen, disabled: !canStartCollectionFolio, disabledReason: collectionDir !== null ? "Folios can't contain another Folio from here." : 'Open a collection first', run: () => { if (collectionDir !== null) startNestedFolio(collectionDir) } },
      { id: 'folio.turnBack', label: 'Turn back into a collection', icon: FolderOpen, disabled: !canTurnBack, disabledReason: 'Open a Folio first', run: turnBackFolio },
      { id: 'board.toggleSources', label: 'Show / Hide sources', icon: PanelRightOpen, disabled: !boardCommandsOn, disabledReason: 'Open the Board first', run: () => dispatchBoardCommand('toggle-sources') },
      { id: 'piece.listSources', label: 'List this piece\'s sources', icon: Link, disabled: !boardCommandsOn && !active, disabledReason: 'Open a piece or the Board first', run: () => { if (boardCommandsOn) dispatchBoardCommand('list-sources'); else if (active) setPieceSourcesRequest({ path: active }) } },
      { id: 'board.attachSource', label: 'Attach source…', icon: Link, disabled: !boardCommandsOn, disabledReason: 'Open the Board and select a source first', run: () => dispatchBoardCommand('attach-source') },
      {
        id: 'skill.run.report-structure',
        label: registryCommand(REPORT_SKILL_COMMAND).label,
        icon: AGENT_ICON,
        disabled: folderFocus === null,
        disabledReason: 'Focus a folder first',
        run: () => { if (folderFocus) helpWithReport(folderFocus.path) },
      },
      ...ROOM_VIEWS.map((view) => ({ id: `folio.room.${view}`, label: registryCommand(`folio.room.${view}`).label, icon: view === 'text' ? FileText : view === 'cards' ? LayoutGrid : ListTree, keys: WORKSPACE_TAB_CHORDS[view], disabled: collectionDir === null, disabledReason: 'Open a Folio first', run: () => window.dispatchEvent(new CustomEvent(ROOM_VIEW_EVENT, { detail: view })) })),
      { id: 'folio.room.inspector', label: registryCommand('folio.room.inspector').label, icon: ListTree, keys: '⌥⌘I', disabled: collectionDir === null, disabledReason: 'Open a Folio first', run: () => { openLeftTab('outline'); dispatchSidebar('toggle-inspector') } },
      { id: 'folio.room.split', label: 'Folio room: Text beside the cards', icon: Columns2, keys: '⌥S', disabled: collectionDir === null, disabledReason: 'Open a Folio first', run: () => window.dispatchEvent(new CustomEvent(ROOM_VIEW_EVENT, { detail: 'split' })) },
      { id: 'plan.addPart', label: 'Add a Folio outline part', icon: Plus, keys: 'N', disabled: collectionDir === null, disabledReason: 'Open a Collection first', run: () => runFolioPlanCommand('add') },
      { id: 'plan.adoptPart', label: 'Add existing part to Folio outline', icon: Plus, keys: 'A', disabled: collectionDir === null, disabledReason: 'Open a Folio outline first', run: () => runFolioPlanCommand('adopt') },
      { id: 'plan.adoptAsFrontMatter', label: 'Add existing part to Folio outline as front matter', icon: Plus, keys: 'F', disabled: collectionDir === null, disabledReason: 'Open a Folio outline first', run: () => runFolioPlanCommand('adopt-front-matter') },
      { id: 'plan.addAllFromFolder', label: registryCommand('plan.addAllFromFolder').label, icon: ListPlus, disabled: collectionDir === null, disabledReason: 'Open a Folio outline first', run: () => runFolioPlanCommand('add-all') },
      { id: 'plan.sortByChapter', label: registryCommand('plan.sortByChapter').label, icon: ListOrdered, disabled: collectionDir === null, disabledReason: 'Open a Folio outline first', run: () => runFolioPlanCommand('sort') },
      { id: 'plan.moveUp', label: 'Move Folio outline part up', icon: ChevronLeft, keys: '⌥↑', disabled: collectionDir === null, disabledReason: 'Open a Folio outline first', run: () => runFolioPlanCommand('move-up') },
      { id: 'plan.moveDown', label: 'Move Folio outline part down', icon: ChevronRight, keys: '⌥↓', disabled: collectionDir === null, disabledReason: 'Open a Folio outline first', run: () => runFolioPlanCommand('move-down') },
      { id: 'plan.materialise', label: 'Open or write Folio outline part', icon: FilePlus2, keys: '↵', disabled: collectionDir === null, disabledReason: 'Open a Folio outline first', run: () => runFolioPlanCommand('open-part') },
      { id: 'plan.removePart', label: 'Remove part from Folio outline', icon: X, keys: '⌘⌫', disabled: collectionDir === null, disabledReason: 'Open a Folio outline first', run: () => runFolioPlanCommand('remove') },
      { id: 'plan.role', label: registryCommand('plan.role').label, icon: ListOrdered, keys: 'R', disabled: collectionDir === null, disabledReason: 'Open a Folio outline first', run: () => runFolioPlanCommand('role') },
      { id: 'plan.writeAgentInstructions', label: registryCommand('plan.writeAgentInstructions').label, icon: AGENT_ICON, disabled: collectionDir === null, disabledReason: 'Open a Folio outline first', run: () => runFolioPlanCommand('agents-both') },
      { id: 'plan.writeAgentsFile', label: registryCommand('plan.writeAgentsFile').label, icon: AGENT_ICON, disabled: collectionDir === null, disabledReason: 'Open a Folio outline first', run: () => runFolioPlanCommand('agents-agents') },
      { id: 'plan.writeClaudeFile', label: registryCommand('plan.writeClaudeFile').label, icon: AGENT_ICON, disabled: collectionDir === null, disabledReason: 'Open a Folio outline first', run: () => runFolioPlanCommand('agents-claude') },
      { id: 'plan.chooseFrontMatter', label: registryCommand('plan.chooseFrontMatter').label, icon: BookOpen, disabled: collectionDir === null, disabledReason: 'Open a Folio outline first', run: () => runFolioPlanCommand('front-matter-choose') },
      { id: 'plan.toggleNotInOutline', label: registryCommand('plan.toggleNotInOutline').label, icon: ListOrdered, disabled: collectionDir === null, disabledReason: 'Open a Folio outline first', run: () => runFolioPlanCommand('not-in-outline-toggle') },
      { id: 'plan.details', label: registryCommand('plan.details').label, icon: Info, keys: 'D', disabled: collectionDir === null, disabledReason: 'Open a Folio outline first', run: () => runFolioPlanCommand('details') },
      // Title-conflict buttons: on the Plan, the selected part (or every part); elsewhere, the open document's bar.
      { id: 'title.useHeadingAsTitle', label: registryCommand('title.useHeadingAsTitle').label, icon: Heading, keys: '⌃⌥⌘H', disabled: collectionDir === null && !shownTitleConflict, disabledReason: 'The title and the heading already match', run: () => { if (collectionDir !== null) runFolioPlanCommand('title-heading-to-title'); else fixOpenDocumentTitle('heading-to-title') } },
      { id: 'title.useTitleAsHeading', label: registryCommand('title.useTitleAsHeading').label, icon: Heading, keys: '⌃⌥⌘T', disabled: collectionDir === null && !shownTitleConflict && !titleHeadingCanBeInserted, disabledReason: openDocumentIsPart ? 'The title and the heading already match, or this part does not start with a heading (the change that adds one is in the Changes)' : 'The title and the heading already match, or there is no title to add as the heading', run: () => { if (collectionDir !== null) runFolioPlanCommand('title-title-to-heading'); else fixOpenDocumentTitle('title-to-heading') } },
      { id: 'title.useHeadingsAsTitlesAll', label: registryCommand('title.useHeadingsAsTitlesAll').label, icon: Heading, keys: '⌃⌥⇧⌘H', disabled: collectionDir === null, disabledReason: 'Open a Folio outline first', run: () => runFolioPlanCommand('titles-heading-to-title') },
      { id: 'title.useTitlesAsHeadingsAll', label: registryCommand('title.useTitlesAsHeadingsAll').label, icon: Heading, keys: '⌃⌥⇧⌘T', disabled: collectionDir === null, disabledReason: 'Open a Folio outline first', run: () => runFolioPlanCommand('titles-title-to-heading') },
      { id: 'title.dismissConflictBar', label: registryCommand('title.dismissConflictBar').label, icon: X, keys: '⌃⌥⌘X', disabled: !shownTitleConflict, disabledReason: 'There is no title-differs bar on this document', run: dismissOpenTitleConflict },
      { id: 'title.undoLastChange', label: registryCommand('title.undoLastChange').label, icon: Undo2, keys: '⌃⌥⌘Z', disabled: !titleConflictActions.canUndo, disabledReason: 'There is no title change from the Folio outline or the Outline to undo (in the document, ⌘Z undoes it)', run: () => { void titleConflictActions.undo() } },
      {
        id: 'collection.toggleRail',
        label: 'Summon Rail',
        icon: PanelRightOpen,
        keys: '⌃⌘L',
        run: runRailChord,
      },
      {
        id: 'collection.focusRail',
        label: 'Focus rail',
        icon: PanelRightOpen,
        run: focusRail,
      },
      {
        id: 'collection.insertAsQuery',
        label: 'Insert as query',
        icon: ListPlus,
        keys: '⌃⌥⌘Q',
        disabled: !canInsertQuery || (!railOpen && !boardActive) || queryInsertionContext === null,
        disabledReason: !canInsertQuery
          ? queryInsertionDisabledReason ?? undefined
          : 'Choose a Rail group or Board column first.',
        run: () => {
          const context = queryInsertionContextRef.current
          if (context) requestQueryInsertion(context)
        },
      },
      {
        id: 'collection.toggleFolderPiece',
        label: selectedFolderPiece
          ? `Treat "${selectedFolderPiece.folderPath.split('/').at(-1) ?? selectedFolderPiece.folderPath}" as ${selectedFolderPiece.mode === 'one' ? 'separate pieces' : 'one piece'}`
          : 'Choose a folder to treat as one or separate pieces…',
        icon: Folder,
        disabled: folderPieceContextDir === null,
        disabledReason: 'Open a Collection or Board first',
        run: runFolderPieceCommand,
      },
      {
        id: 'collection.toggleCounted',
        label: contextCounted ? 'Stop counting toward diary' : 'Count toward diary',
        icon: BookOpen,
        disabled: folderPieceContextDir === null,
        disabledReason: 'Open a Collection or Board first',
        run: toggleCountedCollection,
      },
      {
        id: START_SESSION_COMMAND.id,
        label: START_SESSION_COMMAND.label,
        icon: Timer,
        keys: START_SESSION_COMMAND.keys as string,
        run: openSessionStarter,
      },
      ...(explicitSession?.status === 'running' ? [
        { id: END_SESSION_COMMAND.id, label: END_SESSION_COMMAND.label, icon: Square, run: endExplicitSession },
        { id: ADJUST_SESSION_TARGET_COMMAND.id, label: ADJUST_SESSION_TARGET_COMMAND.label, icon: Target, run: () => setSessionMenuRequest((request) => request + 1) },
      ] satisfies Array<Omit<AppCommand, 'group'>> : []),
      {
        id: 'tab.pin',
        label: active && pinnedTabs.includes(active) ? 'Unpin from strip' : 'Pin to strip',
        icon: Star,
        keys: '⌥⌘P',
        run: () => {
          if (active) pinTab(active, !pinnedTabs.includes(active))
        },
      },
      { id: OPEN_TABS_COMMAND.id, label: OPEN_TABS_COMMAND.label, icon: LayoutPanelLeft, keys: OPEN_TABS_COMMAND.keys as string, run: openOpenTabs },
      {
        id: 'view.focusFolder',
        label: registryCommand('view.focusFolder').label,
        icon: Folder,
        disabled: activeCollectionFolder === null,
        disabledReason: 'Open a file inside a folder first',
        run: () => { if (activeCollectionFolder !== null) focusFolder(activeCollectionFolder) },
      },
      {
        id: 'view.clearFolderFocus',
        label: registryCommand('view.clearFolderFocus').label,
        icon: X,
        disabled: folderFocus === null,
        disabledReason: 'No folder is focused',
        run: () => setFolderFocus(null),
      },
      { id: 'view.distractionFree', label: 'View: Distraction-free', icon: Maximize2, keys: '⌥⌘D', run: toggleDistractionFree },
      { id: 'statusbar.disclosure', label: 'Show status details', icon: AlignCenterVertical, keys: '⌃⌘I', run: () => setStatusDisclosureRequest((request) => request + 1) },
      {
        id: READING_ROOM_TOGGLE_COMMAND.id,
        label: readingRoomOpen ? 'Close Reading Room' : READING_ROOM_TOGGLE_COMMAND.label,
        icon: BookOpen,
        keys: READING_ROOM_TOGGLE_COMMAND.keys as string,
        run: () => setReadingRoomVisibility(!readingRoomOpen),
      },
      {
        id: READING_ROOM_DOCUMENT_COMMAND.id,
        label: READING_ROOM_DOCUMENT_COMMAND.label,
        icon: BookOpen,
        run: () => setReadingRoomVisibility(true),
      },
      { id: INSERT_WIDGET_COMMAND.id, label: INSERT_WIDGET_COMMAND.label, icon: AppWindow, keywords: INSERT_WIDGET_COMMAND.keywords, run: insertWidget },
      { id: 'widget.newRecordBrowser', label: registryCommand('widget.newRecordBrowser').label, icon: AppWindow, keywords: registryCommand('widget.newRecordBrowser').keywords, disabled: !active, disabledReason: 'Open a document first', run: newRecordBrowser },
      { id: 'widget.editRecordBrowser', label: registryCommand('widget.editRecordBrowser').label, icon: AppWindow, keywords: registryCommand('widget.editRecordBrowser').keywords, disabled: !active, disabledReason: 'Open a document first', run: () => editRecordBrowser() },
      { id: 'widget.undoStep', label: registryCommand('widget.undoStep').label, icon: Undo2, keywords: registryCommand('widget.undoStep').keywords, disabled: lastWidgetStep === null, disabledReason: 'There is no widget step to undo', run: () => { void undoWidgetStep() } },
      {
        id: INSERT_REFERENCE_COMMAND.id,
        label: INSERT_REFERENCE_COMMAND.label,
        icon: Quote,
        run: insertReference,
      },
      {
        id: READING_ROOM_SHELF_COMMAND.id,
        label: READING_ROOM_SHELF_COMMAND.label,
        icon: Search,
        keys: READING_ROOM_SHELF_COMMAND.keys as string,
        run: searchTheShelf,
      },
      {
        id: READING_ROOM_HIGHLIGHTS_COMMAND.id,
        label: READING_ROOM_HIGHLIGHTS_COMMAND.label,
        icon: Highlighter,
        keys: READING_ROOM_HIGHLIGHTS_COMMAND.keys as string,
        run: openHighlights,
      },
      {
        id: READING_ROOM_SYNC_COMMAND.id,
        label: READING_ROOM_SYNC_COMMAND.label,
        icon: RefreshCw,
        disabled: outboxWaiting === 0,
        run: syncHighlightsToZotero,
      },
      // Round A focus family (ADR-0028): "Focus and readability…" raises the transient picker; each mode is also
      // its own direct toggle so any mode can be chord-bound without the picker. All keyless.
      { id: 'focus.open', label: 'Focus and readability…', icon: Focus, run: () => openOverlay('focus') },
      { id: 'focus.fade', label: 'Fade other paragraphs', icon: Text, run: () => toggleFocusMode('fade') },
      { id: 'focus.sentence', label: 'Highlight sentence', icon: Highlighter, run: () => toggleFocusMode('sentence') },
      { id: 'focus.segment', label: 'Segment focus', icon: Scan, run: () => toggleFocusMode('segment') },
      { id: 'focus.breakup', label: 'Sentence breakup', icon: ListOrdered, run: () => toggleFocusMode('breakup') },
      { id: 'focus.anchored', label: 'Anchored reading', icon: Anchor, run: () => toggleFocusMode('anchored') },
      // Line focus and Ruler are overlays: they toggle beside the exclusive mode, never replace it, and exclude each other.
      { id: 'focus.lineFocus', label: 'Focus: Line focus', icon: Scan, run: toggleLineFocus },
      { id: 'focus.ruler', label: 'Focus: Ruler', icon: Minus, run: toggleRuler },
      { id: 'lineFocus.size1', label: 'Line focus: 1 line', icon: Scan, run: () => chooseLineFocusSize(1) },
      { id: 'lineFocus.size3', label: 'Line focus: 3 lines', icon: Scan, run: () => chooseLineFocusSize(3) },
      { id: 'lineFocus.size5', label: 'Line focus: 5 lines', icon: Scan, run: () => chooseLineFocusSize(5) },
      { id: 'ruler.covers.thin', label: 'Ruler: thin rule', icon: Minus, run: () => chooseRulerCovers('thin') },
      { id: 'ruler.covers.1', label: 'Ruler: 1 line', icon: Minus, run: () => chooseRulerCovers('1') },
      { id: 'ruler.covers.3', label: 'Ruler: 3 lines', icon: Minus, run: () => chooseRulerCovers('3') },
      { id: 'ruler.covers.5', label: 'Ruler: 5 lines', icon: Minus, run: () => chooseRulerCovers('5') },
      { id: 'ruler.covers.below', label: 'Ruler: all below', icon: Minus, run: () => chooseRulerCovers('below') },
      { id: 'ruler.opacity.lighter', label: 'Ruler opacity: lighter', icon: Minus, run: () => nudgeRulerOpacity(-1) },
      { id: 'ruler.opacity.darker', label: 'Ruler opacity: darker', icon: Minus, run: () => nudgeRulerOpacity(1) },
      { id: 'lineOverlay.followByHand', label: 'Line focus / Ruler: follow by hand', icon: Scan, run: toggleOverlayFollowByHand },
      { id: 'lineOverlay.followTypewriter', label: 'Line focus / Ruler: follow typewriter', icon: Scan, run: toggleOverlayFollowTypewriter },
      // Read-aloud defaults are registry-owned, so the same rows drive palette display, overrides,
      // the window-level editor chord table and the generated cheat sheet.
      { id: 'readAloud.start', label: 'Read aloud', icon: Volume2, run: () => startReadAloud() },
      { id: 'readAloud.pauseResume', label: 'Read aloud — start, pause, or carry on', icon: Pause, run: pauseResumeReadAloud },
      { id: 'readAloud.stop', label: 'Stop reading', icon: Square, run: stopReadAloud },
      { id: 'readAloud.faster', label: 'Read faster', icon: Plus, run: () => nudgeReadAloudRate(0.1) },
      { id: 'readAloud.slower', label: 'Read slower', icon: Minus, run: () => nudgeReadAloudRate(-0.1) },
      { id: 'readAloud.nextSentence', label: 'Next sentence', icon: ChevronRight, run: () => skipReadAloudSentence(1) },
      { id: 'readAloud.previousSentence', label: 'Previous sentence', icon: ChevronLeft, run: () => skipReadAloudSentence(-1) },
      { id: 'readAloud.nextParagraph', label: 'Next paragraph', icon: ChevronsRight, run: () => skipReadAloudParagraph(1) },
      { id: 'readAloud.previousParagraph', label: 'Previous paragraph', icon: ChevronsLeft, run: () => skipReadAloudParagraph(-1) },
      { id: 'readAloud.returnToReading', label: 'Return to the reading', icon: LocateFixed, run: returnToReading },
      { id: 'readAloud.chooseVoice', label: 'Read aloud settings…', icon: AudioLines, run: openReadAloudSettings },
      ...(Object.keys(READ_ALOUD_PRESETS) as ReadAloudPreset[]).map((preset) => ({
        id: `readAloudHighlight.${preset}`,
        label: `Read-aloud highlight: ${preset}`,
        icon: AudioLines,
        run: () => chooseReadAloudHighlight(preset),
      })),
      { id: 'fixedLine.topThird', label: 'Fixed line: top third', icon: AlignCenterVertical, run: () => chooseFixedLine('top') },
      { id: 'fixedLine.middle', label: 'Fixed line: middle', icon: AlignCenterVertical, run: () => chooseFixedLine('middle') },
      { id: 'fixedLine.lowerThird', label: 'Fixed line: lower third', icon: AlignCenterVertical, run: () => chooseFixedLine('lower') },
      // Round A sounds (Task 4): channel toggles; scheme/loop/volume live in Settings → Sounds.
      { id: 'sounds.typing', label: 'Toggle typing sounds', icon: Volume2, run: toggleTypingSounds },
      { id: 'sounds.ambient', label: 'Toggle ambient sound', icon: AudioLines, run: toggleAmbientSound },
      // Theme (2026-09-13): each writes appearance.theme through setSetting — the same path Settings uses.
      { id: 'appearance.darkTheme', label: 'Use dark theme', icon: Moon, run: () => { runThemeCommand('appearance.darkTheme', setSetting) } },
      { id: 'appearance.lightTheme', label: 'Use light theme', icon: Sun, run: () => { runThemeCommand('appearance.lightTheme', setSetting) } },
      // Round A goals (Task 5): the Goal Gauge's keyboard path — the gauge click opens the same dialog.
      { id: 'goal.set', label: 'Set writing goal…', icon: Target, run: openGoalDialog },
      // Round B copy (T5): keyless by the pre-v1 ruling, palette + cheat-sheet only. A flash names
      // both the flavour and the scope, so the writer knows what landed on the clipboard.
      { id: 'copy.rich', label: 'Copy as rich text', icon: ClipboardCopy, run: () => void copyOut('rich') },
      { id: 'copy.markdown', label: 'Copy as Markdown', icon: FileCode, run: () => void copyOut('markdown') },
      { id: 'copy.plain', label: 'Copy as plain text', icon: ClipboardType, run: () => void copyOut('plain') },
      { id: 'file.clearDocument', label: 'Clear document…', icon: Eraser, run: clearDocument },
      // Round B export (T6/T7, ADR-0029): the round's ONE designed surface. Keyless like every
      // Round A command — the pre-v1 sweep assigns chords across the app at once.
      { id: 'export.document', label: 'Export…', icon: Download, run: () => void openExportSheet() },
      { id: 'exportPresets.apply', label: 'Apply export preset', icon: Download, run: () => void openExportSheet(undefined, 'apply') },
      { id: 'exportPresets.update', label: 'Update export preset', icon: Download, run: () => void openExportSheet(undefined, 'update') },
      { id: 'exportPresets.saveAs', label: 'Save export preset as…', icon: Download, run: () => void openExportSheet(undefined, 'save-as') },
      { id: 'exportPresets.manage', label: 'Manage export presets', icon: Settings, run: () => void openExportSheet(undefined, 'manage') },
      { id: 'exportPresets.rename', label: 'Rename export preset', icon: SquarePen, run: () => void openExportSheet(undefined, 'rename') },
      { id: 'exportPresets.delete', label: 'Delete export preset', icon: X, run: () => void openExportSheet(undefined, 'delete') },
      { id: 'exportPresets.moveUp', label: 'Move export preset up', icon: ChevronLeft, run: () => void openExportSheet(undefined, 'move-up') },
      { id: 'exportPresets.moveDown', label: 'Move export preset down', icon: ChevronRight, run: () => void openExportSheet(undefined, 'move-down') },
      // Real overlay opens (Task 17): runPaletteCommand closes the palette first, then these raise
      // the settings / cheat-sheet sheet through the same overlay guard.
      { id: 'file.nameVersion', label: 'Save Version…', icon: GitCommitHorizontal, keys: '⇧⌘S', run: requestNameVersion },
      { id: 'app.settings', label: 'Open Settings…', icon: Settings, keys: '⌘,', run: () => openSettings() },
      { id: 'app.about', label: 'About WriteFlex', icon: Info, run: () => openSettings('sec-about') },
      { id: 'guide.open', label: registryCommand('guide.open').label, icon: Compass, run: openTheGuide },
      { id: 'sharing.setUp', label: registryCommand('sharing.setUp').label, icon: Link, run: openSharingSetup },
      { id: 'sharing.share', label: registryCommand('sharing.share').label, icon: Link, keys: '⌥⌘S', run: openSharingPage },
      { id: 'sharing.sharesList', label: registryCommand('sharing.sharesList').label, icon: Link, run: openSharesList },
      { id: 'example.restore', label: registryCommand('example.restore').label, icon: RotateCcw, run: restoreExampleOrSay },
      workspacePinned
        ? { id: 'workspace.unpin', label: 'Unpin this workspace', icon: PinOff, run: togglePinWorkspace }
        : { id: 'workspace.pin', label: 'Pin this workspace', icon: Pin, run: togglePinWorkspace },
      { id: SHORTCUTS_COMMAND.id, label: SHORTCUTS_COMMAND.label, icon: Keyboard, keys: (SHORTCUTS_COMMAND.keys as string[]).map(formatShortcutKey).join('  '), run: () => openCheatSheet() },
      { id: 'app.search', label: 'Search Workspace…', icon: Search, keys: '⇧⌘F', run: openSearch },
      { id: 'archive.search', label: archiveSearchOpen ? 'Close archive search' : registryCommand('archive.search').label, icon: Library, keys: '⌃⌘F', run: toggleArchiveSearch },
      { id: 'idea.capture', label: 'Capture an idea', icon: Plus, keys: '⇧⌘N', run: openCapture },
      { id: 'idea.materialise', label: 'Materialise dead wikilink', icon: Plus, keys: '⌘↵', run: runMaterialiseCommand },
      { id: 'navigation.followWikilink', label: 'Follow wikilink', icon: Link, keys: '⌥↵', run: followWikilink },
      { id: 'app.scratchpad', label: 'Open Scratchpad', icon: StickyNote, keys: '⇧⌘J', run: () => scratchpadApi.current?.toggle() },
      { id: 'scratchpad.sendCopy', label: registryCommand('scratchpad.sendCopy').label, icon: StickyNote, run: () => { void scratchpadApi.current?.sendCopy() } },
      { id: 'scratchpad.cut', label: registryCommand('scratchpad.cut').label, icon: StickyNote, run: () => { void scratchpadApi.current?.cut() } },
      { id: 'scratchpad.insertCopy', label: registryCommand('scratchpad.insertCopy').label, icon: StickyNote, run: () => scratchpadApi.current?.insertSelected() },
      { id: 'scratchpad.putBack', label: registryCommand('scratchpad.putBack').label, icon: StickyNote, run: () => scratchpadApi.current?.putBackSelected() },
      { id: 'scratchpad.compare', label: registryCommand('scratchpad.compare').label, icon: StickyNote, run: () => scratchpadApi.current?.compareTicked() },
      { id: 'scratchpad.preview', label: registryCommand('scratchpad.preview').label, icon: StickyNote, run: () => scratchpadApi.current?.previewSelected() },
      { id: 'scratchpad.reject', label: registryCommand('scratchpad.reject').label, icon: StickyNote, run: () => scratchpadApi.current?.rejectSelected() },
      { id: 'scratchpad.moveBack', label: registryCommand('scratchpad.moveBack').label, icon: StickyNote, run: () => scratchpadApi.current?.moveBackSelected() },
      { id: 'scratchpad.markDone', label: registryCommand('scratchpad.markDone').label, icon: StickyNote, run: () => scratchpadApi.current?.toggleDoneSelected() },
      { id: 'scratchpad.focusSearch', label: registryCommand('scratchpad.focusSearch').label, icon: StickyNote, run: () => scratchpadApi.current?.focusSearch() },
      { id: 'app.agent', label: 'Open Agent', icon: Sparkles, keys: '⌘J', run: () => focusComposer() },
      { id: 'agent.askHere', label: 'Ask the agent about this…', icon: Sparkles, run: askHere },
      { id: 'threads.new', label: 'Start a new conversation', icon: MessageSquare, run: () => requestAgentAction('new-conversation') },
      { id: 'threads.switcher', label: 'Show conversations', icon: MessageSquare, run: () => requestAgentAction('show-conversations') },
      { id: 'threads.closeCurrent', label: 'Close the current conversation', icon: X, run: () => requestAgentAction('close-current-conversation') },
      { id: 'agent.switchModel', label: 'Switch the model for this chat', icon: Sparkles, run: () => openAgentConfiguration('model') },
      { id: 'agent.setMode', label: 'Set assistant mode', icon: Sparkles, run: () => openAgentConfiguration('mode') },
      { id: 'agent.setThinking', label: 'Set the reasoning level for this chat', icon: AlignCenterVertical, run: () => openAgentConfiguration('thinking') },
      { id: 'agent.refreshModels', label: 'Refresh models', icon: RefreshCw, run: () => { void runRefreshModelsCommand(window.writeflex.refreshModels, flash) } },
      { id: 'agent.manageAccounts', label: 'Manage assistant accounts', icon: Settings, run: () => openSettings('sec-account') },
      { id: 'review.focusMargin', label: 'Focus the review margin', icon: Rows3, keys: '⇧⌘C', run: () => runMarginCommand('focus') },
      { id: 'review.switchMarginView', label: 'Switch Margin / Inline', icon: Rows3, keys: '⇧⌥⌘V', run: () => switchMarginView() },
      { id: 'review.toggleMargin', label: 'Show or hide the margin', icon: Rows3, keys: '⇧⌥⌘M', run: () => toggleMargin() },
      { id: 'review.acceptAll', label: 'Accept all shown, or the selected', icon: Check, keys: '⇧⌘A', run: () => runMarginCommand('accept') },
      { id: 'review.declineAll', label: 'Decline all shown, or the selected', icon: X, keys: '⇧⌘⌫', run: () => runMarginCommand('decline') },
      { id: 'review.sendBack', label: 'Send the review back to the agent', icon: Send, keys: '⇧⌘R', run: () => runMarginCommand('send-back') },
      { id: 'review.acceptAllFromSource', label: 'Accept all from one agent…', icon: Check, run: () => outsideSourceBulkRef.current('accept') },
      { id: 'review.declineAllFromSource', label: 'Decline all from one agent…', icon: X, run: () => outsideSourceBulkRef.current('decline') },
      { id: 'review.nextChange', label: 'Next change', icon: ChevronRight, run: () => { stepReview(1) } },
      { id: 'review.nextPieceWaiting', label: 'Next piece with items waiting', icon: ChevronRight, keys: '⌃⌥⌘G', run: () => nextPieceWithItems() },
      { id: 'review.previousChange', label: 'Previous change', icon: ChevronLeft, run: () => { stepReview(-1) } },
      { id: 'review.showAll', label: 'Show all in the margin', icon: Rows3, keys: '⌃⌥⌘1', run: () => setReviewKind('all', false) },
      { id: 'review.showComments', label: 'Show comments only', icon: MessageSquare, keys: '⌃⌥⌘2', run: () => setReviewKind('comments', false) },
      { id: 'review.showEdits', label: 'Show edits only', icon: SquarePen, keys: '⌃⌥⌘3', run: () => setReviewKind('edits', false) },
      // Ticket 08: the modes and the quiet-fix switch, reachable with nothing waiting (frame `none`).
      { id: 'review.settledToday', label: 'Settled today', icon: History, run: () => switchReviewMode('settled') },
      { id: 'review.myEdits', label: 'My edits', icon: Pencil, run: () => switchReviewMode('mine') },
      { id: 'review.showQuietFixes', label: marginFilterState.showQuiet ? 'Hide quiet fixes' : 'Show quiet fixes', icon: Highlighter, run: toggleQuietFixes },
      { id: 'review.acceptAndNext', label: 'Accept and next', icon: Check, run: () => { const id = reviewCursorRef.current?.currentId; if (id) void acceptAndNextRef.current(id) } },
      { id: 'app.versions', label: 'Open Versions', icon: GitCommitHorizontal, keys: '⌘3', run: () => openRightTab('versions') },
    ]
    // T6 honesty rule: a row whose chord the writer overrode shows the EFFECTIVE chord (or none),
    // never the retired default — the palette and the Keycap Ledger must agree.
    // An app row reports its own run through the one notifier; an editor row reports from
    // runEditorCommand, which knows whether the command took effect.
    const reporting = appRows.map((row): Omit<AppCommand, 'group'> => ({ ...row, run: () => { row.run(); commandRan(row.id) } }))
    return [...editorRows, ...reporting].map((row): AppCommand => {
      const registered = registryCommand(row.id)
      const keywords = registered.keywords
      const override = shortcutOverrides[row.id]
      const presented = { ...row, group: registered.task, subgroup: registered.subgroup, ...(keywords ? { keywords } : {}), ...(registered.hint ? { hint: registered.hint } : {}), ...(registered.leadsFor ? { leadsFor: registered.leadsFor } : {}) }
      if (override === undefined) return presented
      return { ...presented, keys: override === '' ? undefined : override }
    })
  }, [
    shownTitleConflict,
    titleHeadingCanBeInserted,
    openDocumentIsPart,
    fixOpenDocumentTitle,
    dismissOpenTitleConflict,
    titleConflictActions,
    workspacePinned,
    togglePinWorkspace,
    shortcutOverrides,
    archiveSearchOpen,
    toggleArchiveSearch,
    readingRoomOpen,
    setReadingRoomVisibility,
    searchTheShelf,
    insertReference,
    citeShelfRow,
    noteReaderSelection,
    citationForPastedText,
    openHighlights,
    outboxWaiting,
    syncHighlightsToZotero,
    toggleTypewriter,
    chooseFixedLine,
    chooseReadAloudHighlight,
    toggleFocusMode,
    toggleLineFocus,
    toggleRuler,
    chooseLineFocusSize,
    chooseRulerCovers,
    nudgeRulerOpacity,
    toggleOverlayFollowByHand,
    toggleOverlayFollowTypewriter,
    startReadAloud,
    pauseResumeReadAloud,
    stopReadAloud,
    nudgeReadAloudRate,
    skipReadAloudSentence,
    skipReadAloudParagraph,
    returnToReading,
    openReadAloudSettings,
    toggleTypingSounds,
    toggleAmbientSound,
    setSetting,
    openGoalDialog,
    copyOut,
    clearDocument,
    cycle,
    walkLinkTrail,
    requestOutline,
    cycleRightTab,
    guideInRow,
    openTheGuide,
    openSharingSetup,
    openSharingPage,
    openSharesList,
    restoreExampleOrSay,
    browseFolderFile,
    toggleHideStrikes,
    toggleHideInserts,
    runEditorCommand,
    openFilesTab,
    toggleLeftPane,
    toggleRightPane,
    toggleActionBar,
    focusSidebarFilter,
    openOpenTabs,
    openOutlineTab,
    openBoard,
    openFolderDashboard,
    newPiece,
    boardDir,
    activeCollectionDir,
    startNestedFolio,
    canTurnBack,
    canStartCollectionFolio,
    turnBackFolio,
    openPlan,
    openFolio,
    openFolioDir,
    folioPlace,
    runFolioCommand,
    runFolioPlanCommand,
    folioRunningOrder,
    open,
    helpWithReport,
    collectionDir,
    railOpen,
    focusRail,
    runRailChord,
    canInsertQuery,
    queryInsertionDisabledReason,
    boardActive,
    queryInsertionContext,
    requestQueryInsertion,
    selectedFolderPiece,
    folderPieceContextDir,
    runFolderPieceCommand,
    rootIsVault,
    openMakeVault,
    openSwitcher,
    vaultPrefs,
    chooseVaultPrefs,
    contextCounted,
    toggleCountedCollection,
    openSessionStarter,
    explicitSession,
    endExplicitSession,
    active,
    acceptWriterSession,
    switchReviewMode,
    toggleQuietFixes,
    marginFilterState.showQuiet,
    revertSelectedToActive,
    sendSelectedOriginalToScratchpad,
    toggleFavourite,
    pinTab,
    pinnedTabs,
    activeCollectionFolder,
    focusFolder,
    folderFocus,
    setFolderFocus,
    openOverlay,
    openCheatSheet,
    openPalette,
    closePalette,
    openSettings,
    openSearch,
    openCapture,
    runMaterialiseCommand,
    followWikilink,
    selectViewMode,
    toggleDistractionFree,
    openScratchpad,
    focusComposer,
    askHere,
    requestAgentAction,
    openAgentConfiguration,
    openRightTab,
    requestNameVersion,
    snapshot,
    overlayActive,
  ])

  // The bar's buttons come from the SAME rows the palette lists and the chord table dispatches, so
  // a button, its tooltip chord and ⇧⌘P can never disagree about what a command does. An entry the
  // app has no runnable command for is dropped rather than drawn dead (action-bar-commands.ts).
  const actionBarGroups = useMemo(() => {
    const runnable = new Map<string, RunnableCommand>(
      paletteCommandList.map((row) => [row.id, { label: row.label, keys: row.keys, icon: row.icon, disabled: row.disabled, run: row.run }]),
    )
    return resolveActionBarItems(actionBarItems, runnable, { reviewing: writerMode === 'reviewing' })
  }, [actionBarItems, paletteCommandList, writerMode])
  // The configure sheet's left list IS the palette's list — "every command the app can do" has one
  // meaning in this app, and it is the one ⇧⌘P already shows. It goes through `configureCommands`,
  // which resolves each icon the way the BAR resolves it, so a row in the sheet and the button it
  // configures cannot wear different glyphs.
  const actionBarConfigureCommands = useMemo<ConfigureCommand[]>(
    () => configureCommands(paletteCommandList),
    [paletteCommandList],
  )

  const runPaletteCommand = useCallback(
    (command: AppCommand) => {
      recordRecent(command.id)
      // Close through the focus-restoring path so app-level commands (Toggle Outline, Pin Favourite,
      // a flash row) leave the keyboard on the editor; editor commands re-focus the view themselves.
      closePalette()
      command.run()
    },
    [recordRecent, closePalette],
  )
  useEffect(() => window.writeflex.onMenuAction(action => { const command = collectionPageMenuCommand(action); if (collectionDir !== null && command) dispatchCollectionPageCommand(command) }), [collectionDir])
  const collectionChordsRef = useRef(new Set<string>())
  // Actions here (⌘K, ticket 03) runs a row through the palette's own dispatch: the AppCommand the palette
  // lists, run by runPaletteCommand. A command the list has not caught up with (its `when` changed since the
  // list was built) is run from the registry the way the list would have run it.
  const [paletteSeed, setPaletteSeed] = useState('')
  // The palette reads the seed once, as it opens; clearing it as soon as it is open means a later ⇧⌘P starts empty.
  useEffect(() => { if (overlayActive === 'commands' && paletteSeed !== '') setPaletteSeed('') }, [overlayActive, paletteSeed])
  const actionsHereApi = useMemo<ActionsHereApi>(() => ({
    canRun: (id) => {
      const row = paletteCommandList.find((item) => item.id === id)
      if (row) return !row.disabled
      const registered = commandRegistry.find((command) => command.id === id)
      return Boolean(registered?.run && registered.surfaces.includes('palette'))
    },
    runCommand: (id) => {
      const row = paletteCommandList.find((item) => item.id === id)
      if (row) {
        if (row.disabled) flash(row.disabledReason ?? 'That is not available right now')
        else runPaletteCommand(row)
        return true
      }
      const registered = commandRegistry.find((command) => command.id === id)
      if (!registered?.run || !registered.surfaces.includes('palette')) return false
      runPaletteCommand({ id, label: registered.label, group: registered.task, icon: Command, run: () => runEditorCommand(registered.run!, id) })
      return true
    },
    openPalette: (query) => { setPaletteSeed(query); openPalette('commands') },
    overrides: shortcutOverrides,
    editorState: () => editorRef.current?.view()?.state ?? null,
  }), [paletteCommandList, runPaletteCommand, runEditorCommand, flash, openPalette, shortcutOverrides])
  const openFromPalette = useCallback(
    (path: string) => {
      closePalette()
      open(path)
    },
    [closePalette, open],
  )
  // Reveal in Files: the Agent notes pane's "Reveal in sidebar" and the tab menu's "Reveal in Files".
  const revealFileInFiles = useCallback((path: string) => revealTreeRow({ key: path, kind: 'file' }), [revealTreeRow])
  const revealFileFromPalette = useCallback((path: string) => {
    closePalette()
    revealTreeRow({ key: path, kind: 'file' })
  }, [closePalette, revealTreeRow])
  const revealFolderFromPalette = useCallback((path: string) => {
    closePalette()
    revealTreeRow({ key: path, kind: 'folder' })
  }, [closePalette, revealTreeRow])
  const focusFolderFromPalette = useCallback((path: string) => {
    closePalette()
    focusFolder(path)
  }, [closePalette, focusFolder])

  // --- Assignable shortcuts, app surface (Round A T6, ADR-0028) ---------------------------------
  // ONE capture-phase dispatch table for app-surface chords, derived from the SAME rows the palette
  // runs — chord and palette can never disagree about what a command does. Editor-surface commands
  // (registry `run`s) are deliberately absent: the resolver-built CM keymap owns them, so a chord
  // fires exactly once. The literal per-key listeners this table replaces are gone with it.
  const appChordIndexRef = useRef<Map<string, () => void>>(new Map())
  // ⌫ chords the app table dispatches (eventToChord leaves ⌫ to the places that own it): ⇧⌘⌫ Decline all (ticket 04).
  const backspaceChordIndexRef = useRef<Map<string, () => void>>(new Map())
  useEffect(() => {
    const index = new Map<string, () => void>()
    const backspace = new Map<string, () => void>()
    const collectionChords = new Set<string>()
    for (const row of paletteCommandList) {
      if (LEDGER_EXCLUDED.has(row.id)) continue
      if (row.disabled) continue
      const registryEntry = commandRegistry.find((command) => command.id === row.id)
      if (registryEntry?.run && !APP_DISPATCHED_EDITOR_IDS.has(row.id)) continue // editor keymap owns it
      const chord = resolveChord(row.id, shortcutOverrides)
      if (!chord) continue
      // Chord-specific behaviour where the key historically did more than the palette row:
      // ⇧⌘F also lands the keyboard in the search field (the toggleSearch contract).
      index.set(canonicalChord(chord), row.id === 'app.search' ? toggleSearch : row.run)
      if (row.id.startsWith('collection.page.') || row.id.startsWith('folio.room.') || row.id.startsWith('plan.') || row.id.startsWith('title.') || row.id === 'collection.openBoard' || ['collection.newDocument', 'collection.startFolio', 'folio.turnBack'].includes(row.id)) collectionChords.add(canonicalChord(chord))
      if (BACKSPACE_APP_CHORDS.has(row.id)) backspace.set(canonicalChord(chord), row.run)
    }
    collectionChordsRef.current = collectionChords
    appChordIndexRef.current = index
    backspaceChordIndexRef.current = backspace
  }, [paletteCommandList, shortcutOverrides, toggleSearch])
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (shortcutCaptureActive.current) return
      const backspace = backspaceChord(e)
      const chord = eventToChord(e) ?? (backspace && backspaceChordIndexRef.current.has(backspace) ? backspace : null)
      if (!chord) return
      const disclosureChord = resolveChord('statusbar.disclosure', shortcutOverrides)
      const paneChord = ['view.toggleLeftPane', 'view.toggleRightPane'].some(id => chord === resolveChord(id, shortcutOverrides))
      const paletteChord = chord === resolveChord('app.quickOpen', shortcutOverrides) || chord === resolveChord('app.commandPalette', shortcutOverrides)
      // The room's text pane is the app's editor on screen: its own keys (⌘S and the rest) work while focus is in it.
      if (overlayOpenRef.current && !paletteChord && !(paneChord && overlayActive === null && !configureActionBarOpen && !document.querySelector('.cv-sheet')) && !(roomTextRef.current !== null && overlayActive === null && (e.target as Element | null)?.closest?.('.cm-editor')) && !(overlayActive === 'statusDisclosure' && chord === disclosureChord) && !(collectionDir !== null && overlayActive === null && !document.querySelector('.cv-sheet') && collectionChordsRef.current.has(chord))) return
      // The archive dock owns its keys (⏎, ⌘⏎, ⇧↑/⇧↓ …) while focus is in it: only its own toggle and
      // the palettes still reach the app chord table, so ⌘⏎ inserts a link rather than materialising.
      if (archiveSearchOpenRef.current && (e.target as Element | null)?.closest?.('.archive-dock')
        && !paneChord && !paletteChord && chord !== resolveChord('archive.search', shortcutOverrides)) return
      const run = chord === backspace ? backspaceChordIndexRef.current.get(chord) : appChordIndexRef.current.get(chord)
      if (!run) return
      // The room's Text and Split panes are the editor: its line-move keys must reach CodeMirror,
      // rather than being prevented here and then refused as running-order moves by the room.
      if (roomTextRef.current !== null && (e.target as Element | null)?.closest?.('.cm-editor')
        && ['plan.moveUp', 'plan.moveDown'].some(id => chord === resolveChord(id, shortcutOverrides))) return
      if (chord === resolveChord('plan.removePart', shortcutOverrides) && (e.target as Element | null)?.closest?.('input, textarea, select, [contenteditable="true"], .cm-editor')) return
      e.preventDefault()
      // Pane chords belong to the shell, before editor or room event containment.
      if (paneChord) e.stopImmediatePropagation()
      runAsPlanShortcut(run)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [overlayActive, overlayOpenRef, shortcutOverrides, collectionDir, configureActionBarOpen])

  // The Reading Room's vendored reader owns the keyboard once a document has focus, so its seam
  // forwards the modified chords it does not want (ReadFlex ADR-0028). They run through the SAME
  // app chord table as a window keydown above — one command path, so the Room can never disagree
  // with the palette about what ⌃⌘S does.
  const runReaderChord = useCallback((chord: ShortcutLike): void => {
    if (overlayOpenRef.current) return // an open sheet owns the keyboard (useOverlayGuard)
    const resolved = eventToChord(chord)
    if (!resolved) return
    appChordIndexRef.current.get(resolved)?.()
  }, [overlayOpenRef])

  // Tab activation loads the file into the editor. switchTo prefers the per-path cached buffer
  // (EditorPane's EditorState map — unsaved edits, cursor, undo history) over the disk content,
  // which only seeds FRESH buffers; the disk read still always refreshes the dirty baseline.
  useEffect(() => {
    if (!active) {
      loadedPath.current = null
      setLoadedFile(null)
      return
    }
    let cancelled = false // a fast tab switch must not let the older read land after the newer one
    void window.writeflex
      .readFile(active)
      .then(({ content }) => {
        if (cancelled) return
        setLastEditablePath(active)
        loadedPath.current = active
        setLoadedFile(active)
        const mode = modeForFile(active, content)
        setWriterMode(mode)
        // switchTo may restore a CACHED buffer, ignoring the fresh disk read. The owner reconciles it with
        // this read as the watcher would (reconcile.ts): byte for byte, never "clean" while a write of
        // unknown outcome stands (Sol M2, M3), and replaced only when it is saved (document-owner.ts).
        const action = owner.activated(active, content, () => {
          editorRef.current?.switchTo(active, content, mode)
          return editorRef.current?.currentDoc() ?? content
        })
        if (action === 'conflict') {
          // A cached buffer with unsaved text, and the disk moved under it while the tab was away: the
          // buffer is still based on the old version (main compares against it), and the writer is asked.
          cancelAutosaveFor(active)
          if (!sameDiskNotice(externalDiskNoticesRef.current.get(active), 'changed', content)) {
            raiseExternalDiskNotice(active, { kind: 'changed', dirty: true, diskText: content })
          }
        }
        // First sight of this file this session fixes its word baseline (a re-activation is a no-op
        // in useSession, since the count is unchanged) — the +words tally measures from here on.
        session.observe(active, editorRef.current?.currentDoc() ?? content)
        void window.writeflex.diary.prime(active, countWords(editorRef.current?.currentDoc() ?? content, { excludeCommentLines: true }))
        // The buffer for `active` is now live: flush a folder-scope outline jump queued for this file.
        if (pendingLine.current?.path === active) {
          editorRef.current?.goToLine(pendingLine.current.line)
          pendingLine.current = null
        }
        // …and flush a queued search jump the same way, selecting the match (Task 14).
        if (pendingMatch.current?.path === active) {
          const m = pendingMatch.current
          editorRef.current?.goToMatch(m.line, m.column, m.length)
          pendingMatch.current = null
        }
      })
      .catch(() => {
        if (cancelled) return
        // The file cannot be read (removed on disk), and the tab holds text of its own: the tab's cached
        // buffer, or the text the registry keeps. It is shown without a disk read, under the removed
        // notice (Sol S1, round 2): the tab must not name this file while the editor shows another.
        const held = editorRef.current?.docFor(active) ?? unsaved.textOf(active) ?? null
        if (held === null) {
          flash(`Could not read ${active}`)
          return
        }
        loadedPath.current = active
        setLoadedFile(active)
        const mode = modeForFile(active, held)
        setWriterMode(mode)
        editorRef.current?.switchTo(active, held, mode)
        const buffer = editorRef.current?.currentDoc() ?? held
        const dirty = owner.activatedRemoved(active, buffer)
        cancelAutosaveFor(active)
        if (!sameDiskNotice(externalDiskNoticesRef.current.get(active), 'removed', null)) {
          raiseExternalDiskNotice(active, { kind: 'removed', dirty, diskText: null })
        }
      })
    return () => {
      cancelled = true
      // A cross-file jump queues pendingLine and opens the target; the flush above clears it once that
      // buffer is live. But if the user switches AWAY before this file's readFile resolves, the flush
      // never runs — so drop the queued line here IF it still targets THIS (now-departing) file. A newer
      // jump (rapid double cross-file click) has already repointed pendingLine at its own target, so the
      // path check leaves that one intact; only the abandoned queue-until-ready is cleared, which would
      // otherwise yank the caret on a LATER unrelated activation of this same file.
      if (pendingLine.current?.path === active) pendingLine.current = null
      if (pendingMatch.current?.path === active) pendingMatch.current = null
    }
  }, [active, flash, owner, session.observe, modeForFile, cancelAutosaveFor, raiseExternalDiskNotice])

  useEffect(() => {
    const dismiss = (event: KeyboardEvent): void => {
      if (!railOpen || queryInsertConfirm || overlayOpenRef.current || event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      const railHeldFocus = document.activeElement instanceof Element
        && document.activeElement.closest('.collection-rail') !== null
      if (railHeldFocus) {
        restoreEditorFocus()
        return
      }
      dismissRail()
    }
    window.addEventListener('keydown', dismiss, true)
    return () => window.removeEventListener('keydown', dismiss, true)
  }, [dismissRail, overlayOpenRef, queryInsertConfirm, railOpen, restoreEditorFocus])

  // Resolve the active buffer's wikilinks from its current text. Population queries are deliberately
  // separate: ordinary typing updates links but never rescans the Collection.
  useEffect(() => {
    if (!active || loadedFile !== active) {
      editorRef.current?.setWikilinks([])
      setWikilinkCompletionPieces([])
      return
    }
    let cancelled = false
    const resolve = async (): Promise<void> => {
      const dir = await collectionDirFor(active)
      const statusDir = await statusBarCollectionDirFor(active, dir)
      const content = editorRef.current?.currentDoc() ?? ''
      const links = await window.writeflex.collection.links(dir, active, content)
      if (cancelled || activeRef.current !== active) return
      setActiveCollectionPath(active)
      setActiveCollectionDir(dir)
      setStatusBarCollectionDir(statusDir)
      editorRef.current?.setWikilinks(links.filter((link) => link.from === active).map(({ target, display, to, ambiguous }) => ({ target, display, to, ambiguous })))
    }
    void resolve().catch(() => {
      if (!cancelled) {
        setActiveCollectionPath(active)
        setActiveCollectionDir(active.includes('/') ? active.slice(0, active.lastIndexOf('/')) : '')
        setStatusBarCollectionDir('')
        editorRef.current?.setWikilinks([])
        setWikilinkCompletionPieces([])
      }
    })
    return () => { cancelled = true }
  }, [active, loadedFile, wikilinkRefreshTick])

  useEffect(() => {
    if (!active || loadedFile !== active) {
      setWikilinkCompletionPieces([])
      return
    }
    let cancelled = false
    const reloadPopulation = async (): Promise<void> => {
      const dir = await collectionDirFor(active)
      const query = await window.writeflex.collection.query(dir, '')
      if (!cancelled && query.ok) setWikilinkCompletionPieces(query.rows.map((piece) => ({ title: piece.title, name: piece.path.split('/').at(-1) ?? piece.path })))
    }
    void reloadPopulation().catch(() => { if (!cancelled) setWikilinkCompletionPieces([]) })
    const dispose = window.writeflex.collection.onChanged((event) => {
      if (!collectionSurfaceMountedRef.current && event.paths.length > 0 && event.paths.every((path) => path === active)) return
      // A file can leave between the query's listing and its read (a part moved into the Folio bin): that re-read
      // fails, the last list stays, and the next change notice reads again. Uncaught, it took the window down.
      void reloadPopulation().catch(() => undefined)
    })
    return () => { cancelled = true; dispose() }
  }, [active, loadedFile])

  // ⌘S = an explicit tier-2 CHECKPOINT (ADR-0013), the git *commit* of the model: flush the buffer, then
  // snapshot it as a returnable point. Saving itself is automatic, so this is the deliberate "mark this
  // point" gesture — labelled Checkpoint in the File menu and cheat-sheet.
  const save = useCallback(async () => {
    if (active && loadedPath.current === active) await checkpointPath(active, false)
  }, [active, checkpointPath])

  // Flush any pending auto-save when the writer switches tabs (the buffer just left is written before it
  // stops being active — savePath then reads it from EditorPane's cache) or blurs the window.
  useEffect(() => {
    flushAutosave()
  }, [active, flushAutosave])
  useEffect(() => {
    const onBlur = (): void => flushAutosave()
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [flushAutosave])

  // ⌘S is natively owned by the File menu (menu.ts registers CmdOrCtrl+S → 'save'), so like ⌘W it
  // arrives as a menu action (T3 precedent). EditorPane additionally binds Mod-s in the CM keymap
  // for events that reach the renderer directly (synthetic input, non-menu platforms).
  useEffect(
    () =>
      window.writeflex.onMenuAction((action) => {
        if (action === 'save') void save()
      }),
    [save],
  )

  // Data-safety (ADR-0012): a native window close — red light, Window menu, ⌘Q — never prompts and
  // never discards. Saving is automatic, so on close we simply flush every dirty buffer (background tabs
  // via docFor, inside savePath) and go. The ONLY thing that abandons the close is a failed write —
  // then the window stays open with its edits intact rather than losing them. Main intercepts the close
  // and asks HERE, where the live dirty set is read from the owner at the instant of the close.
  // The close's flush: cancel the debounced auto-save and write every dirty buffer now. Returns the paths
  // it wrote and how many writes failed. Removing the Example collection (ticket 10) closes the example's
  // windows by this same route before its folder is moved, so this is also what reaches the Bin.
  // A write reads its buffer when it starts, so typing during a slow write leaves the document unsaved
  // after a write that succeeded: the flush repeats until nothing is unsaved (close-flush.ts). What is
  // unsaved is read from the registry (every entry, and every path with a write in flight), never from
  // the dirty dots. With the editor gone (unmounted by an error) this app can write nothing and the
  // flush stops; the close is then finished by unsaved-text.ts.
  const flushEveryDirtyBuffer = useCallback((failedPaths?: string[]): Promise<CloseFlushResult> => {
    // Cancel any pending auto-save timer; every unsaved buffer is being written now.
    if (autosaveTimer.current) {
      clearTimeout(autosaveTimer.current)
      autosaveTimer.current = null
    }
    pendingAutosave.current = null
    // A document under a hold (a suggestion redo's calls to main are in flight) is written after them.
    return flushUntilClean({
      unsaved: () => (editorIsPresent() ? unsaved.pending() : []),
      save: async (path) => {
        await owner.settled(path)
        const saved = await savePath(path)
        if (!saved) failedPaths?.push(path)
        return saved
      },
    })
  }, [savePath, owner])

  // One close at a time. Main already ignores a close request while one is in flight; this is the
  // renderer's own guard for the same rule, so a repeat can never start a second flush.
  const closeInFlight = useRef(false)
  // A close request that arrived while a called-off close was still flushing.
  // Why the last close was kept open, for the vault switcher's line when its close is refused (ticket 06).
  const closeKept = useRef<CloseKept | null>(null)
  // The close handler below, for the one other place this app asks for its window to close (⌘W with
  // no tab open) when that finds something unsaved.
  const closeRequestRef = useRef<(() => void) | null>(null)
  // While this app is mounted it answers a close itself; the page's standing answer (unsaved-text.ts)
  // steps aside. Unmounted by an error, that answer takes over with the text it kept.
  useEffect(() => {
    setEditorPresent(true)
    return () => setEditorPresent(false)
  }, [])
  // The page's writes after an error (unsaved-text.ts) carry the baseline each buffer was based on. The
  // source reads this app's baseline store, which outlives the app when an error unmounts it.
  useEffect(() => {
    setSaveBasisSource((path) => basisFromBaseline(owner.baselineDiskOf(path)))
  }, [owner])
  useEffect(
    () => {
      const onCloseRequested = async (): Promise<void> => {
        // Ack immediately — before the (possibly slow) flush — so main knows the renderer is alive. A
        // blank/crashed renderer never reaches this line.
        void window.writeflex.acknowledgeClose()
        // A request while a close runs: main sends one only after it called the running close off
        // (window:abandon-close), so it is run once the called-off flush has ended.
        // Queued under the current close generation: a later call-off drops it (round 3, S1).
        if (closeInFlight.current) { queueCloseRetry(); return }
        closeInFlight.current = true
        void takeCloseRetry() // a request queued for an earlier close is not this one's
        closeKept.current = null
        let abandoned = false
        // A close that is still going after a second says so in the status bar, until it ends.
        const sayClosing = setTimeout(() => {
          if (flashTimer.current) clearTimeout(flashTimer.current)
          flashTimer.current = null
          dismissFolioNoticeRef.current?.()
          setStatus(CLOSING_STATUS)
        }, CLOSING_STATUS_AFTER_MS)
        try {
          // The documents edited since their last checkpoint, read before the flush: first in main's queue.
          const changed = [...uncheckpointed.current]
          // The paths this close could not write, each with the reason its write gave (refusalReasons).
          const failedPaths: string[] = []
          // The documents this close detached when it sent window:close, attached again if main calls
          // the close off after that (round 3, S2).
          let detached: string[] = []
          // Flush every unsaved buffer (tier 1), then the gate: the window goes only if the registry
          // holds nothing and no write is in flight at the moment of sending (unsaved-text.ts). The
          // close's checkpoints (ADR-0013 tier 2, gated in main by the "checkpoint on close" setting)
          // are made by main AFTER the window has gone: the window no longer waits one call per tab.
          // Every open document is named, even when unchanged: main uses the same event to create
          // ADR-0031's one Initial version, and content addressing keeps an unchanged checkpoint cheap.
          const { outcome, failed } = await closeWithEditor({
            // Every buffer, then the writer-review records still waiting for their debounce (vaults 06
            // review round 2): the window must not go before the ledger has them.
            flush: async () => {
              const flushed = await flushEveryDirtyBuffer(failedPaths)
              const room = await flushRoomPending()
              failedPaths.push(...room.failed)
              const combined = { flushed: [...new Set([...flushed.flushed, ...room.flushed])], failed: flushed.failed + room.failed.length, clean: flushed.clean && room.failed.length === 0 }
              // A record the ledger refused does not keep the window open; it is logged (round 3, S3).
              const { failed: unrecorded } = await flushWriterChangesNow()
              if (unrecorded.length > 0) void reportRendererError(new Error(`Close: writer-review records could not be written for ${unrecorded.join(', ')}`))
              return combined
            },
            checkpoint: (flushed) => closeCheckpointOrder(flushed, changed, tabsRef.current.filter((path) => !isSurfaceTabId(path))),
            // The window is going: every open document is detached in the turn the close is sent, so no
            // keystroke lands in a buffer after the gate found everything saved.
            closing: () => {
              detached = tabsRef.current.filter((path) => !isSurfaceTabId(path))
              owner.detach(detached)
            },
            // Main dropped the window:close (called off before it took it): the window stays, editable,
            // and still owes the checkpoints this close would have made.
            reopen: () => {
              owner.attach(detached)
              for (const path of changed) uncheckpointed.current.add(path)
            },
          })
          // Unmounted by an error while the flush ran: the page's own close has taken over.
          if (outcome === 'handed-over') return
          // Main called this close off while it ran (the vault switcher's bound): nothing to send.
          if (outcome === 'abandoned') { abandoned = true; return }
          if (outcome === 'save-failed') {
            // One line naming every path refused, with its own reason; a reason recorded for another path
            // (guardRefusalPath) never stands in for these.
            const refused = failedPaths.map((path) => ({ path, reason: refusalReasons.current.get(path) }))
            closeKept.current = { kind: 'refused', failed: refused }
            flash(refused.length > 0 ? closeRefusalMessage(refused) : `Could not save ${failed} document${failed > 1 ? 's' : ''} — the window stays open`)
            void window.writeflex.cancelClose()
            return
          }
          // Typing that outran every pass of the flush keeps the window open and says so.
          if (outcome === 'still-unsaved') {
            closeKept.current = { kind: 'still-typing' }
            flash(STILL_TYPING_STATUS)
            void window.writeflex.cancelClose()
            return
          }
          uncheckpointed.current.clear()
        } finally {
          clearTimeout(sayClosing)
          setStatus((current) => (current === CLOSING_STATUS ? '' : current))
          closeInFlight.current = false
          // A request queued while this close ran, still wanted only if no call-off came after it.
          if (takeCloseRetry() && abandoned) void onCloseRequested()
        }
      }
      closeRequestRef.current = () => { void onCloseRequested() }
      const off = window.writeflex.onCloseRequested(() => { void onCloseRequested() })
      return () => { closeRequestRef.current = null; off() }
    },
    [flushEveryDirtyBuffer, flushWriterChangesNow, flash, owner],
  )

  // A status line main sends this window (an open that found the folder's window still being switched to).
  useEffect(() => window.writeflex.onStatus((message) => flash(message)), [flash])

  // The vault switcher's choice (vaults ticket 06; review 2026-10-16): main opens the chosen root in a
  // new window at this window's place and closes this one by its ordinary close, which writes every
  // document as any close does (the close handler above). This page does nothing first. When it is
  // still here afterwards, the switch did not happen: another window shows the root (focused), the
  // folder is busy, the dialog was cancelled, or the close was kept open (a write failed).
  const switchToRoot = useCallback(async (target: RootSwitchTarget): Promise<void> => {
    try {
      const result = await window.writeflex.switchRoot(target)
      if (result.status === 'focused') flash(`${result.root.split('/').at(-1) ?? result.root} is open in another window`)
      else if (result.status === 'stayed') flash(result.reason === 'close-timed-out' ? SWITCH_CLOSE_TIMED_OUT_MESSAGE : switchStayedMessage(closeKept.current))
      else if (result.status === 'switching') flash('Already switching folders')
    } catch (error) {
      flash(humanReadableError(error, 'WriteFlex could not open that folder.'))
    }
  }, [flash])
  const chooseFromSwitcher = useCallback((choice: SwitcherChoice) => {
    if (choice.kind === 'root') void switchToRoot({ root: choice.root })
    else if (choice.kind === 'open-folder') void switchToRoot({ dialog: true })
    else openMakeVault()
  }, [switchToRoot, openMakeVault])

  // A file-open boot (or opening a file into this window) arrives as a workspace:focus-file push;
  // main queues it and flushes on the first workspace:get pull (T2 seam, ipc.ts). This subscription
  // registers in the same synchronous effects pass that SENDS that pull (useWorkspace's mount
  // effect), so the push can never arrive before we listen; useTabs.open itself queues a path that
  // arrives ahead of tab hydration.
  // A writeflex://open?…&line=N link (an archive citation) carries its line: land the caret there
  // through the outline jump's queue-until-loaded path. jumpToFileLine is declared further down, so
  // the subscription reads it off a ref rather than re-ordering this load-bearing registration.
  useEffect(() => window.writeflex.onFocusFile((path, line) => {
    if (line !== undefined) jumpToFileLineRef.current(path, line)
    else open(path)
  }), [open])

  // The View menu's Toggle Outline item routes here on click.
  useEffect(
    () =>
      window.writeflex.onMenuAction((action) => {
        if (action === 'toggle-left-pane') toggleLeftPane()
        else if (action === 'toggle-right-pane') toggleRightPane()
        else if (action === 'open-files') openFilesTab()
        else if (action === 'toggle-outline') toggleOutline()
        else if (action === 'focus-review-margin') runMarginCommand('focus')
        else if (action === 'switch-margin-view') switchMarginView()
        else if (action === 'toggle-margin') toggleMargin()
        else if (action === 'open-versions') openRightTab('versions')
      }),
    [toggleLeftPane, toggleRightPane, openFilesTab, toggleOutline, openRightTab, runMarginCommand, switchMarginView, toggleMargin],
  )

  // The View menu's Toggle Typewriter item (⌘T, registerAccelerator:false) routes here on click.
  useEffect(
    () =>
      window.writeflex.onMenuAction((action) => {
        if (action === 'toggle-typewriter') toggleTypewriter()
      }),
    [toggleTypewriter],
  )

  // ⇧⌘E / ⇧⌘O (Open Files / Open Outline) are dispatched by the T6 chord table. They remain
  // OPEN + SWITCH + ACTIVATE commands: repeat presses never close; only ⌘[ collapses the left pane.

  // The menu's Outline item routes through the same open-and-focus path. menu.ts registers it with
  // registerAccelerator:false, so Electron shows the shortcut without claiming the keydown.
  /*
  // ⇧⌘O toggles the outline. menu.ts registers View ▸ Toggle Outline with registerAccelerator:false —
  // Electron shows the shortcut for discoverability but does NOT bind it, so the RENDERER owns the
  // ⇧⌘O keydown (the Quick Open / Search pattern). Capture phase so it wins before the editor's own
  // keymap consumes the key; the shift guard keeps plain ⌘O (File ▸ Open) untouched.
  */

  // Opening the outline (via ⇧⌘O, the menu, the palette, or the toolbar button — all funnel through
  // outlineOpen) lands the keyboard on its active row so the writer can Arrow around immediately;
  // closing hands focus back to the editor (the panel-close focus-restore pattern). Fires ONLY on the
  // open/close transition — the ref skips the boot render (the outline is open by default), so this
  // never steals focus on an unrelated re-render.
  const [outlineFocusTick, setOutlineFocusTick] = useState(0)
  const outlineFocusPrimed = useRef(false)
  useEffect(() => {
    if (!outlineFocusPrimed.current) {
      outlineFocusPrimed.current = true
      return
    }
    // Opening asks the pane to land the keyboard on its active row — deferred to the pane because the
    // shared outline snapshot may not have populated the rows yet (it recomputes on a debounce), so
    // the pane focuses once the row actually exists. Closing hands focus straight back to the editor.
    if (outlineOpen) setOutlineFocusTick((n) => n + 1)
    else editorRef.current?.view()?.focus()
  }, [outlineOpen])

  // The first click or keystroke in the document after a file was opened from Files/Search moves the sidebar
  // to Outline, once per opened file (ticket 13). Never moves focus: the writer is typing in the document.
  const leftTabRef = useRef(leftTab)
  leftTabRef.current = leftTab
  useEffect(() => {
    function onInteract(event: Event): void {
      const target = event.target
      if (!(target instanceof Element) || !target.closest('.cm-editor')) return
      // A press on a widget block (engaging it) or a key while it is engaged is not the writer working in the text: it leaves the sidebar and the arm alone.
      if (target.closest('.wf-widget-block')) return
      if (event.type === 'keydown' && ['Shift', 'Meta', 'Control', 'Alt', 'CapsLock', 'Fn'].includes((event as KeyboardEvent).key)) return
      const result = noteDocumentInteraction(outlineSwitchRef.current, activeRef.current, leftTabRef.current)
      outlineSwitchRef.current = result.state
      if (result.switchToOutline) openLeftTab('outline')
    }
    window.addEventListener('pointerdown', onInteract, true)
    window.addEventListener('keydown', onInteract, true)
    return () => {
      window.removeEventListener('pointerdown', onInteract, true)
      window.removeEventListener('keydown', onInteract, true)
    }
  }, [openLeftTab])

  // ⌘2 (Open tabs) is dispatched by the T6 chord table; it opens the Open section and its filter.

  // Link-trail back/forward and rendered-block navigation are registry commands now (ticket 16), rows
  // in the palette list below and dispatched by the chord table; no raw ⌥⌘-arrow listener remains.

  // ⌘J (Open Agent) is dispatched by the T6 chord table. It focuses the agent composer — never a
  // blind toggle (Task 15 design ruling): hidden → open + focus; visible → focus (re-entry).
  // Visibility toggling belongs to the toolbar Sparkles button and the panel's own close control.

  // ⇧⌘J (Open Scratchpad, lands in its filter) and ⇧⌘C (Open Review / Change Ledger dock) are
  // dispatched by the T6 chord table; the toolbar Changes button remains the mouse path.

  // Compare is a main-pane mode entered from the version spine or ⌥⌘C. While comparing, Esc returns to
  // the editor and ⌥⌘S swaps From/To — keyboard parity for the top compare bar.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (overlayOpenRef.current) return
      if (compareActive && e.key === 'Escape') {
        e.preventDefault()
        closeCompareView()
        return
      }
      if (!(e.metaKey || e.ctrlKey) || !e.altKey || e.shiftKey) return
      if (compareActive && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        swapCompareView()
        return
      }
      // ⌥⌘S outside Compare: the Sharing page of the open piece, and back to the text (ticket 03).
      if (!compareActive && e.code === 'KeyS') {
        e.preventDefault()
        if (sharingPageOpen) closeSharingPage()
        else if (sharesListOpen) closeSharesList()
        else openSharingPage()
        return
      }
      if (!compareActive && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault()
        if (versions.length === 0) {
          flash('Name a version before comparing.')
          return
        }
        openCompareView(versions.length >= 2 ? versions[1].id : versions[0].id, versions.length >= 2 ? versions[0].id : 'working')
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [closeCompareView, compareActive, flash, openCompareView, overlayOpenRef, swapCompareView, versions, sharingPageOpen, openSharingPage, closeSharingPage, sharesListOpen, closeSharesList])

  // ⌘3 (Open Versions — never closes on repeat; only ⌘] collapses the right pane) and ⌥⌘[/⌥⌘]
  // (browse the active file's folder — a replacement gesture, the tab strip never grows) are
  // dispatched by the T6 chord table.

  // ⌘⇧Z is context-sensitive by design (ADR-0009 cheat-sheet: Undo agent turn): with focus inside
  // the agent panel it undoes the agent's last turn; anywhere else the keystroke falls through to
  // CM6's own historyKeymap (editor redo). menu.ts registers Edit ▸ Redo with
  // registerAccelerator:false so the native item never swallows the key before this handler.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (overlayOpenRef.current) return // an open sheet owns the keyboard (useOverlayGuard)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
        if (!document.querySelector('.agent')?.contains(document.activeElement)) return
        e.preventDefault()
        agent.undoTurn()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [agent.undoTurn, overlayOpenRef])

  // ⌘Z in a plain text field: Edit ▸ Undo no longer owns the key natively (menu.ts), so the field's own text undo
  // is run here. The editor (CodeMirror's historyKeymap) and the Details card (which undoes by token and has
  // already handled the key) are left alone.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z') return
      const target = e.target
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return
      if (target.closest('.cm-editor')) return
      e.preventDefault()
      document.execCommand('undo')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // The Edit-menu Redo item routes here on click (its ⇧⌘Z key is renderer-owned above): agent-panel
  // focus undoes the turn, otherwise it redoes in the live editor view.
  useEffect(
    () =>
      window.writeflex.onMenuAction((action) => {
        // Edit ▸ Undo is not a native role (menu.ts): the Details card undoes by its own token and handles its own
        // click; anywhere else the click is the browser's own text undo, as the role was.
        if (action === 'undo') {
          if (turnBackUndo.current && turnBackUndo.current.root === root && collectionDir === turnBackUndo.current.dir && !document.activeElement?.closest('input, textarea, [contenteditable="true"], .cm-editor')) { undoTurnBack(); return }
          if (document.activeElement?.closest('[data-folio-details]')) return
          if (document.activeElement?.closest('.cm-editor')) runEditorCommand(undo)
          else document.execCommand('undo')
          return
        }
        if (action !== 'redo') return
        if (document.querySelector('.agent')?.contains(document.activeElement)) agent.undoTurn()
        else runEditorCommand(redo)
      }),
    [agent.undoTurn, runEditorCommand, turnBackUndo, root, collectionDir, undoTurnBack],
  )

  // ⌘T (Toggle Typewriter) is dispatched by the T6 chord table — menu.ts keeps the item at
  // registerAccelerator:false (discoverable, not natively bound), so the renderer stays the owner.

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (overlayOpenRef.current) return
      // e.code, not e.key: Option remaps the produced character on macOS (⌥R → '®'), so `e.key === 'r'`
      // never matched and ⌥⌘R did nothing — the same rule the ⌥⌘D / prose-zoom handlers already follow.
      if ((e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey && e.code === 'KeyR') {
        e.preventDefault()
        if (distractionFree) {
          setDistractionFree(false)
          setModeDrawerOpen(true)
        } else setModeDrawerOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [distractionFree, overlayOpenRef])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (overlayOpenRef.current) return
      if (isWriterModeToggleShortcut(e)) {
        e.preventDefault()
        if (distractionFree) setDfControlsVisible(true)
        changeWriterMode(writerMode === 'reviewing' ? 'drafting' : 'reviewing')
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [changeWriterMode, distractionFree, writerMode, overlayOpenRef])

  // ⌥⌘D (Distraction-free) is dispatched by the T6 chord table; Esc leaving the mode stays here.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (overlayOpenRef.current) return
      if (distractionFree && e.key === 'Escape' && !documentFindOpen && !modeDrawerOpen) {
        e.preventDefault()
        setDistractionFree(false)
        setDfControlsVisible(false)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [distractionFree, documentFindOpen, modeDrawerOpen, overlayOpenRef])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      const commandModifierOnly = e.metaKey !== e.ctrlKey
      if (!commandModifierOnly) return
      const inFilesPane = e.target instanceof Element && e.target.closest('.sidebar') !== null
      // Collection pages deliberately guard the editor beneath them. Their own Find stays available.
      if (collectionDir !== null && overlayActive === null && !document.querySelector('.cv-sheet') && !e.shiftKey && !e.altKey && e.code === 'KeyF') { e.preventDefault(); e.stopImmediatePropagation(); dispatchCollectionPageCommand('search'); return }
      if (overlayOpenRef.current) return
      if (inFilesPane && !e.shiftKey && !e.altKey && e.code === 'KeyF') return
      if (!e.shiftKey && !e.altKey && e.code === 'KeyF') {
        e.preventDefault(); setDocumentFindOpen(true); return
      }
      if (!e.shiftKey && e.altKey && e.code === 'KeyF') {
        e.preventDefault(); setDocumentFindOpen(true); setDocumentFindReplaceOpen((open) => !open); return
      }
      if (!e.altKey && e.code === 'KeyG') {
        if (!documentFindOpen) return
        e.preventDefault(); moveDocumentFind(e.shiftKey ? -1 : 1); return
      }
      if (documentFindOpen && e.key === 'Escape') { e.preventDefault(); closeDocumentFind() }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [closeDocumentFind, documentFindOpen, moveDocumentFind, overlayOpenRef, collectionDir, overlayActive])

  // ⌘, toggles the Settings sheet (Task 17, mockup keyboard map). Deliberately NOT behind the
  // overlay guard: like ⌘P/⇧⌘P it is an overlay-raising key, so pressing it replaces whatever
  // sheet is up (the mockup's closeOverlays-then-open) or dismisses its own.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (shortcutCaptureActive.current) return // the Keycap Ledger's popover is recording a chord
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key !== ',') return
      if (typeof root !== 'string') return // the settings sheet is a workspace-shell surface
      e.preventDefault()
      overlayActive === 'settings' ? closePalette() : openSettings()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [root, overlayActive, openSettings, closePalette])

  // `?` opens the keyboard cheat-sheet — when NOT typing (mockup rule): a focused input, select,
  // textarea or the CM contenteditable keeps the literal `?` keystroke. Pressing it on the open
  // sheet dismisses it (Esc also closes, in the sheet's own handler).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (shortcutCaptureActive.current) return // the Keycap Ledger's popover is recording a chord
      if (e.metaKey || e.ctrlKey || e.altKey || e.key !== '?') return
      const el = document.activeElement as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return
      if (typeof root !== 'string') return
      e.preventDefault()
      overlayActive === 'cheatsheet' ? closeCheatSheet() : openCheatSheet()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [root, overlayActive, openCheatSheet, closeCheatSheet])

  // ⌘? is the typing-safe path from every surface. Ordinary inputs bubble here; CodeMirror and
  // object-editor shells dispatch the request event from inside their own contained key handling.
  useEffect(() => {
    const toggleCheatSheet = (): void => {
      if (typeof root !== 'string') return
      overlayActive === 'cheatsheet' ? closeCheatSheet() : openCheatSheet()
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (shortcutCaptureActive.current) return // the Keycap Ledger's popover is recording a chord
      if (e.defaultPrevented || !isCheatSheetShortcut(e)) return
      e.preventDefault()
      toggleCheatSheet()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener(OPEN_CHEAT_SHEET_EVENT, toggleCheatSheet)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener(OPEN_CHEAT_SHEET_EVENT, toggleCheatSheet)
    }
  }, [root, overlayActive, openCheatSheet, closeCheatSheet])

  // The locked View + Navigation keys the native zoom roles used to shadow (menu.ts now stands
  // aside): ⌘1 focus editor, ⌘+/⌘− prose size, ⌥⌘+/⌥⌘− line width, ⌥⌘0 reset.
  // e.code (not e.key) for the ⌥ variants — Option remaps the produced character on macOS
  // (⌥0 → 'º'), while the physical Digit0/Equal/Minus codes stay stable.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (overlayOpenRef.current) return // an open sheet owns the keyboard (useOverlayGuard)
      if (!(e.metaKey || e.ctrlKey) || (e.metaKey && e.ctrlKey)) return
      if (e.code === 'Digit0' && e.altKey && !e.shiftKey) {
        e.preventDefault()
        resetProseZoom()
      } else if (e.code === 'Digit1' && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        focusEditor()
      } else if (e.code === 'Equal') {
        e.preventDefault() // plain ⌘= and shifted ⌘+ both step up (the zoomIn convention)
        e.altKey ? stepLineWidth(1) : stepProseSize(1)
      } else if (e.code === 'Minus') {
        e.preventDefault()
        e.altKey ? stepLineWidth(-1) : stepProseSize(-1)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [toggleSidebar, focusEditor, stepProseSize, stepLineWidth, resetProseZoom, overlayOpenRef])

  // The View menu's prose-size / column-width items route their CLICK here (their keys are
  // renderer-owned above; the menu items are registerAccelerator:false — discoverable, not
  // natively bound). They land on the SAME handlers the keys use, so mouse and keyboard agree.
  useEffect(
    () =>
      window.writeflex.onMenuAction((action) => {
        if (action === 'prose-zoom-in') stepProseSize(1)
        else if (action === 'prose-zoom-out') stepProseSize(-1)
        else if (action === 'prose-zoom-reset') resetProseZoom()
        else if (action === 'column-width-in') stepLineWidth(1)
        else if (action === 'column-width-out') stepLineWidth(-1)
      }),
    [stepProseSize, stepLineWidth, resetProseZoom],
  )

  // Closing a tab leaves the workspace window open, including when this was its last document.
  // The editor drops the closed file's cached buffer state and its dirty bookkeeping with it.
  const closeTab = useCallback(
    async (path: string) => {
      if (isBoardTabId(path)) {
        boardSeenStatusesRef.current.clear()
        close(path)
        return
      }
      if (isWidgetWorkbenchTabId(path)) {
        close(path)
        setWorkbench((current) => (current && widgetWorkbenchTabId(current.documentPath) === path ? null : current))
        return
      }
      // Saving is automatic (ADR-0012): closing a document never prompts and never discards. Flush any
      // pending write first (savePath reads a background tab from EditorPane's cache); only a FAILED write
      // keeps the tab open, so the edits stay recoverable rather than lost. Read the SYNCHRONOUS dirty ref
      // (not the render-stale `dirtyPaths` state): a type-then-immediately-close-last-tab must not slip
      // past the flush before React commits, since the last-tab close force-closes the window (Codex P1).
      // The document owner writes the buffer until it is saved (typing during that save or the checkpoint
      // is written too, Sol M4), detaches it in the turn of the last check, and forgets it only if nothing
      // moved since (document-owner.ts). Always send the existing close-checkpoint event. Main gates the
      // tier-2 checkpoint by Settings and uses the same event for ADR-0031's one automatic Initial version.
      // A checkpoint that fails (a removed file: ENOENT) is a refusal, never a throw (Sol r3 S1).
      const fileName = path.split('/').at(-1) ?? path
      if (guardRefusalPath.current === path) guardRefusalPath.current = null
      // The app's own traces of the tab, once the owner has forgotten its buffer.
      const closeForgotten = (): void => {
        uncheckpointed.current.delete(path)
        if (loadedPath.current === null || loadedPath.current === path) setLoadedFile((current) => (current === path ? null : current))
        clearFileWriterState(path)
        clearExternalDiskNotice(path) // a notice must not outlive its tab and stop the saves of a later one
        refusalReasons.current.delete(path)
        setSaveFailed(path, false)
        setSaveSlow(path, false)
        close(path)
      }
      cancelAutosaveFor(path)
      const flushed = await owner.withFlushed([path], () => {
        if (!owner.forgetIfSaved(path)) return false
        closeForgotten()
        return true
      }, { detach: true, afterSave: (p) => window.writeflex.checkpoint(p, { auto: true }) })
      if (flushed.status === 'refused') {
        // A file removed on disk (Muse S1, round 2; Sol r3 S1, also when the tab is clean and its checkpoint
        // failed): the save is refused until the writer chooses Keep mine, which writes the file again.
        // Closing the tab is the other answer: the text in it is discarded, and only when the writer
        // confirms that, here, in so many words.
        if (externalDiskNoticesRef.current.get(path)?.kind === 'removed' && window.confirm(removedTabDiscardQuestion(fileName))) {
          owner.discardConfirmed(path)
          closeForgotten()
          flash(`Closed ${fileName}; the text that was only in the tab was discarded`)
          return
        }
        if (guardRefusalPath.current !== path) flash(`Could not save ${fileName} — the tab stays open`)
        return
      }
      if (flushed.status === 'still-unsaved' || !flushed.result) {
        flash(`${fileName} was still being edited while it was saved — the tab stays open`)
      }
    },
    [close, owner, cancelAutosaveFor, setSaveFailed, setSaveSlow, flash, clearFileWriterState, clearExternalDiskNotice],
  )

  // The room's text pane asks for a part's file: open it as any open does (a tab, the editor's own buffer, saves and conflict handling),
  // but stay in the room. Reading and showing the file writes nothing to the Folio.
  useEffect(() => {
    if (roomTextPath === null || collectionDir === null) return
    noteOpenSource(roomTextPath, 'other')
    openTab(roomTextPath)
  }, [roomTextPath, collectionDir, openTab, noteOpenSource])

  // ⌘W is natively owned by the File menu (menu.ts registers CmdOrCtrl+W → 'close-tab', unlike the
  // registerAccelerator:false items), so it arrives as a menu action rather than a keydown.
  useEffect(
    () =>
      window.writeflex.onMenuAction((action) => {
        if (action !== 'close-tab') return
        const intent = closeTabIntent({ tabs, active: activeTab, pinned: pinnedTabs, recent: recentTabs })
        if (intent.kind === 'tab') void closeTab(intent.path)
        // No tab is open: the window closes. Through the same gate as every close; if something is
        // still unsaved or being written, the close handler's flush runs first.
        // Writer-review records still waiting: the close handler drains them first.
        else if (!writerChangesIdle() || !closeWindowIfClean()) closeRequestRef.current?.()
      }),
    [activeTab, tabs, pinnedTabs, recentTabs, closeTab, writerChangesIdle],
  )

  // ---- Sidebar file management (ADR-0017, the Quiet Menu) ---------------------------------------
  // ⌘N / ⌃⌘N open the Files pane and plant a ghost row (dialog-free creation) in the active file's
  // folder. The sidebar publishes its existing roving-focus row; no second selection model is added.
  const [createRequest, setCreateRequest] = useState<{ tick: number; kind: 'file' | 'folder'; directory: string } | null>(null)
  const sidebarFocusedRow = useRef<SidebarFocusedRow | null>(null)
  const noteSidebarFocusedRow = useCallback((row: SidebarFocusedRow | null) => {
    sidebarFocusedRow.current = row
  }, [])
  const requestCreate = useCallback(
    (kind: 'file' | 'folder') => {
      openFilesTab()
      // One ruling for the target folder (sidebar-tree.ts): the focused row, else the open file's
      // folder, else the root — and never outside a focused folder.
      const directory = createTargetDirectory({
        focusedRow: sidebarFocusedRow.current,
        activePath: activeRef.current,
        focus: folderFocus?.path ?? null,
      })
      setCreateRequest((prev) => ({ tick: (prev?.tick ?? 0) + 1, kind, directory }))
    },
    [openFilesTab, folderFocus],
  )
  useEffect(
    () =>
      window.writeflex.onMenuAction((action) => {
        if (action === 'new-file') { if (collectionDir !== null) void newPiece(collectionDir); else requestCreate('file') }
        else if (action === 'new-folder') requestCreate('folder')
      }),
    [requestCreate, collectionDir, newPiece],
  )

  /** True when the IPC error is a name-collision REFUSAL (rename/create must shake-and-stay). */
  const isCollision = (error: unknown): boolean => error instanceof Error && error.message.includes('already exists')
  /** Drop every renderer trace of a path so a late auto-save can never resurrect it (the write path
   *  reads the buffer at run time; after forget() there is no buffer, so the save is a no-op). */
  const forgetAppTraces = useCallback((path: string) => {
    uncheckpointed.current.delete(path)
    clearExternalDiskNotice(path) // a notice leaves with its path (a rename has moved it on first)
    refusalReasons.current.delete(path)
    if (loadedPath.current === path) loadedPath.current = null
  }, [clearExternalDiskNotice])
  // Review S8: a tab pruned because its file left the tree (a trash, a removal by another program, the old
  // name of a rename) takes the document's state in the owner with it, once nothing in it is unsaved. A tab
  // holding unsaved text is not pruned (useTabs keeps it) and keeps its state.
  const tabsBeforeRef = useRef<string[]>([])
  useEffect(() => {
    const before = tabsBeforeRef.current
    tabsBeforeRef.current = tabs
    const stillOpen = new Set(tabs)
    const listed = new Set(files.map((file) => file.path))
    for (const path of before) {
      if (stillOpen.has(path) || listed.has(path) || isSurfaceTabId(path)) continue
      if (owner.generationsOf(path) === undefined && owner.baselineOf(path) === undefined) continue
      if (!owner.isSaved(path)) continue
      owner.drop(path)
      forgetAppTraces(path)
    }
  }, [tabs, files, owner, forgetAppTraces])
  // e2e only: rename, move and duplicate wait here for `releaseSlowSave` before main is asked, while the
  // owner holds the paths' queues (file-management.spec.ts).
  const e2eHoldMove = useCallback(async (): Promise<void> => {
    if (!window.writeflex.e2eWriteHooks || e2eSaveBehaviourRef.current !== 'hold-move') return
    await new Promise<void>((resolve) => { e2eSlowSaveReleaseRef.current = resolve })
  }, [])
  /**
   * Rename, move, duplicate and a folder's rename run in the document owner (document-owner-plan.md, parcel
   * 2b). Every path is written until saved, then `act` asks main to move or copy the file while the owner
   * holds the paths' queues: no save of the old path (an autosave armed before the move) runs between the
   * flush and main's move, so none recreates the file there (Muse r3 S3; TalkWeaver's 2026-07-05 incident
   * class). Null when the flush failed (flashed): the caller does nothing, the file is untouched (Codex
   * second-look finding #1, 2026-07-11). A throw from `act` (a name collision) comes back as a throw.
   */
  const withPathsSaved = useCallback(
    async <T,>(
      paths: readonly string[] | (() => readonly string[]),
      act: (snapshots: Map<string, Snapshot>) => Promise<T>,
      scope?: string,
    ): Promise<{ result: T } | null> => {
      for (const p of typeof paths === 'function' ? paths() : paths) cancelAutosaveFor(p)
      // A document under a changed-on-disk notice with nothing typed over its version is held, not
      // written (it cannot be until the writer answers): the rename moves the notice with it (spec: the
      // notice follows the rename). One with typing over its version refuses the route, as any save does.
      // The owner asks this of each path at its final check, and waits for whatever the path's queue holds
      // (a Keep mine in flight) before the hold, held or written (2b review P1).
      const flushed = await owner.withFlushed(paths, act, { holdOnly: cleanUnderNotice, ...(scope !== undefined ? { scope } : {}) })
      if (flushed.status === 'acted') return { result: flushed.result }
      const name = flushed.path.split('/').at(-1) ?? flushed.path
      if (guardRefusalPath.current !== flushed.path) {
        flash(flushed.status === 'still-unsaved' ? `${name} was still being edited while it was saved — nothing was moved` : `Could not save ${name} — nothing was moved`)
      }
      return null
    },
    [owner, cancelAutosaveFor, cleanUnderNotice, flash],
  )
  /**
   * A single file's rename or move, with main's link repair (2b round 3 review, finding 1). Its members are
   * the file, every document the repair may rewrite (main's plan) and every document the app has a record of
   * (`renameMembers`), held from the owner's final check until main has renamed the file AND repaired the
   * links: an accept in flight on a linking document finishes before main reads it for the repair, and no
   * operation on a held document starts until the repair returns. Inside the hold the plan is asked for
   * again; a document it names that is not held (it gained a link meanwhile) sends the whole route round
   * again, bounded, so main's own plan never names a document the hold does not cover.
   * Invariant: a link-repair write never lands on text older than an accept the owner had queued for that
   * document.
   */
  const withRenameScopeSaved = useCallback(
    async <T,>(path: string, plan: () => Promise<FileRenamePlan>, act: (planned: FileRenamePlan) => Promise<T>): Promise<{ result: T } | null> => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const planned = await plan()
        const flushed = await withPathsSaved(
          () => renameMembers([path], planned.repairPaths, documentsUnder('')),
          async (snapshots): Promise<{ stale: true } | { stale: false; value: T }> => {
            const again = await plan()
            if (again.repairPaths.some((p) => !snapshots.has(p))) return { stale: true }
            return { stale: false, value: await act(again) }
          },
        )
        if (!flushed) return null
        if (!flushed.result.stale) return { result: flushed.result.value }
      }
      flash('The links to this file kept changing while it was renamed — nothing was moved. Try again.')
      return null
    },
    [withPathsSaved, documentsUnder, flash],
  )
  /** Inside `withPathsSaved`'s action, once main moved `from` to `to`: the notice moves on, and the owner
   *  takes the buffer to `to` in this turn (document-owner.ts, `moved`): saved there when nothing changed
   *  it since the flush; changed meanwhile (by generation, Sol r3 M2), it stays unsaved there and is
   *  written by the next autosave (based on the version it was saved as). */
  const afterMainMoved = useCallback((from: string, to: string) => {
    moveExternalDiskNotice(from, to)
    const uncheckpointedBefore = uncheckpointed.current.has(from)
    const kept = owner.moved(from, to)
    forgetAppTraces(from)
    if (kept === 'carried') {
      uncheckpointed.current.add(to)
      queueAutosave(to)
    } else if (kept === 'renamed' && uncheckpointedBefore) {
      uncheckpointed.current.add(to) // saved, not yet checkpointed: the next ⌘S/close checkpoints it there
    }
  }, [owner, forgetAppTraces, moveExternalDiskNotice, queueAutosave])
  moveHoldRef.current = { withPathsSaved: (paths, act) => withPathsSaved(paths, () => act()), afterMainMoved }

  const sidebarFileOps: SidebarFileOps = useMemo(
    () => ({
      createFile: async (name, directory) => {
        try {
          const created = await window.writeflex.createFile(name, directory || undefined)
          await refresh()
          open(created.file.path)
          flash(`Created ${created.file.name}`)
          return true
        } catch (error) {
          if (isCollision(error)) return false
          flash(humanReadableError(error, 'Could not create the file.'))
          return true
        }
      },
      createFolder: async (path) => {
        try {
          await window.writeflex.createFolder(path)
          await refresh()
          flash(`Created folder ${path.split('/').at(-1) ?? path}`)
          return true
        } catch (error) {
          if (isCollision(error)) return false
          flash(humanReadableError(error, 'Could not create the folder.'))
          return true
        }
      },
      renameFile: async (path, newName) => {
        // The existing name confirmed: nothing to do (2b round 2, finding 1). The owner's `moved` is a no-op
        // for a destination that is its source too, for a name main normalises back to it.
        if (newName === path.split('/').at(-1)) return true
        const wasOpen = tabs.includes(path)
        try {
          const flushed = await withRenameScopeSaved(path, () => window.writeflex.planFileRename(path, newName), async (plan) => {
            if (plan.newPath === path) return null
            await e2eHoldMove()
            const renamed = await window.writeflex.renameFile(path, plan.newPath)
            afterMainMoved(path, renamed.file.path)
            return renamed
          })
          if (!flushed) return true // flashed; close the rename input, file untouched
          const moved = flushed.result
          if (moved === null) return true // the planned destination is the source: nothing moved
          await refresh()
          if (wasOpen) open(moved.file.path)
          flash(formatRenameRepairMessage(`Renamed to ${moved.file.name}`, moved.repair))
          return true
        } catch (error) {
          if (isCollision(error)) return false
          flash(humanReadableError(error, 'Could not rename the file.'))
          return true
        }
      },
      renameFolder: async (path, newName) => {
        // The existing name confirmed: nothing to do (2b round 2, finding 1).
        if (newName === path.split('/').at(-1)) return true
        // The folder's documents are every path under it the app knows of, asked for again at the owner's
        // final check, and the owner locks the folder's scope in that turn: no operation on a path under it
        // (an accept of a document not open, a save) starts until main has renamed the folder, and one in
        // flight is waited for first. A document opened under the folder meanwhile joins the hold: the
        // action moves every document it then holds, so none is left under the old name (2b round 3 ruling).
        const prefix = `${path}/`
        try {
          const flushed = await withPathsSaved(() => documentsUnder(prefix), async (snapshots) => {
            await e2eHoldMove()
            const renamed = await window.writeflex.renameFolder(path, newName)
            const moved = [...snapshots.keys()]
            // Of the documents moved, the ones open in a tab are opened again under the new name.
            const wereOpen = moved.filter((t) => tabsRef.current.includes(t))
            for (const t of moved) afterMainMoved(t, `${renamed.path}${t.slice(path.length)}`)
            return { renamed, moved: wereOpen }
          }, prefix)
          if (!flushed) return true
          const { renamed, moved: openUnder } = flushed.result
          const wasActive = active && active.startsWith(`${path}/`) ? active : null
          await refresh()
          for (const t of openUnder) open(`${renamed.path}${t.slice(path.length)}`)
          if (wasActive) open(`${renamed.path}${wasActive.slice(path.length)}`)
          flash(`Renamed folder to ${renamed.path.split('/').at(-1) ?? renamed.path}`)
          return true
        } catch (error) {
          if (isCollision(error)) return false
          flash(humanReadableError(error, 'Could not rename the folder.'))
          return true
        }
      },
      moveFile: async (path, directory) => {
        const wasOpen = tabs.includes(path)
        try {
          const name = path.split('/').at(-1) ?? path
          const flushed = await withRenameScopeSaved(path, () => window.writeflex.planFileRename(path, name, directory), async (plan) => {
            await e2eHoldMove()
            const movedTo = await window.writeflex.moveFile(path, plan.newPath)
            afterMainMoved(path, movedTo.file.path)
            return movedTo
          })
          if (!flushed) return false
          const moved = flushed.result
          await refresh()
          if (wasOpen) open(moved.file.path)
          flash(formatRenameRepairMessage(`Moved to ${directory ?? 'workspace root'}`, moved.repair))
          return true
        } catch (error) {
          flash(humanReadableError(error, 'Could not move the file.'))
          return false
        }
      },
      duplicateFile: async (path) => {
        try {
          // The copy is the saved text: the buffer is written first, and main copies the file while the
          // owner holds its queue, so a save of typing that arrives meanwhile lands after the copy, in the
          // original only.
          const flushed = await withPathsSaved([path], async () => {
            await e2eHoldMove()
            return window.writeflex.duplicateFile(path)
          })
          if (!flushed) return null
          const copy = flushed.result
          await refresh()
          flash(`Duplicated as ${copy.file.name}`)
          return copy.file.path
        } catch (error) {
          flash(humanReadableError(error, 'Could not duplicate the file.'))
          return null
        }
      },
      // Trash order (Codex second-look finding #2): flush THEN forget THEN trash. Flushing first means
      // the binned file carries the newest keystrokes (nice for recovery) and a failed trash loses
      // nothing — the buffer is re-readable from the intact disk file. forget-before-trash still kills
      // the debounced auto-save, so the file can't be resurrected the instant after it's binned.
      trashFile: async (path) => {
        // The owner writes the buffer until it is saved and detaches it in the turn of the last check: the
        // editor takes no typing while main moves the file (Sol r3 M3). The buffer is forgotten once the
        // file is in the Bin, if nothing moved; a trash that fails makes it editable again, unchanged.
        cancelAutosaveFor(path)
        const name = path.split('/').at(-1) ?? path
        const outcome = await owner.withFlushed([path], async (): Promise<{ trashed: true } | { trashed: false; error: unknown }> => {
          try {
            await window.writeflex.trashFile(path)
          } catch (error) {
            return { trashed: false, error }
          }
          if (owner.forgetIfSaved(path)) forgetAppTraces(path)
          return { trashed: true }
        }, { detach: true })
        if (outcome.status !== 'acted') {
          if (guardRefusalPath.current !== outcome.path) {
            flash(outcome.status === 'still-unsaved' ? `${name} was still being edited while it was saved — nothing was moved` : `Could not save ${name} — nothing was moved`)
          }
          return
        }
        await refresh() // tab reconcile prunes the stale tab; a refused trash re-lists the file
        if (outcome.result.trashed) flash(`Moved ${name} to the Bin — recoverable from Finder`)
        else flash(humanReadableError(outcome.result.error, 'Could not move the file to the Bin.'))
      },
      trashFolder: async (path) => {
        // As trashFile, for every document under the folder the app knows of: written, detached while main
        // moves the folder, forgotten once it is in the Bin; editable again, unchanged, when the trash fails.
        // The members are asked for again at the owner's final check, the folder's scope is locked in that
        // turn (no operation under it starts until main returns), and a document opened under the folder
        // while main trashes it joins the hold, detached: its newest text is written before the hold or
        // none is typed during it (2b round 3 ruling).
        const prefix = `${path}/`
        const under = (): string[] => documentsUnder(prefix)
        for (const t of under()) cancelAutosaveFor(t)
        const outcome = await owner.withFlushed(under, async (snapshots): Promise<{ trashed: true } | { trashed: false; error: unknown }> => {
          try {
            await window.writeflex.trashFolder(path)
          } catch (error) {
            return { trashed: false, error }
          }
          for (const t of snapshots.keys()) if (owner.forgetIfSaved(t)) forgetAppTraces(t)
          return { trashed: true }
        }, { detach: true, scope: prefix })
        if (outcome.status !== 'acted') {
          const name = outcome.path.split('/').at(-1) ?? outcome.path
          if (guardRefusalPath.current !== outcome.path) {
            flash(outcome.status === 'still-unsaved' ? `${name} was still being edited while it was saved — nothing was moved` : `Could not save ${name} — nothing was moved`)
          }
          return
        }
        await refresh()
        if (outcome.result.trashed) flash(`Moved folder ${path.split('/').at(-1) ?? path} to the Bin — recoverable from Finder`)
        else flash(humanReadableError(outcome.result.error, 'Could not move the folder to the Bin.'))
      },
      revealFile: (path) => void window.writeflex.revealFile(path),
      exportFile: (path) => void openExportSheet(path),
      copyPath: (path) => {
        void navigator.clipboard.writeText(root ? `${root}/${path}` : path)
        flash('Path copied')
      },
    }),
    [tabs, active, root, refresh, open, flash, owner, cancelAutosaveFor, forgetAppTraces, withPathsSaved, withRenameScopeSaved, afterMainMoved, e2eHoldMove, openExportSheet, documentsUnder],
  )
  // The memoised Files tree (R6) gets every callback under a fixed identity, so typing (an editor
  // snapshot, a session tick) does not re-render it; each still calls App's current closure.
  const stableSidebarFileOps = useStableCallbacks(sidebarFileOps)
  const sidebarHandlers = useStableCallbacks({
    onOpen: (path: string) => { open(path); noteOpenSource(path, 'files') },
    onToggleFavourite: toggleFavourite,
    onOpenCollection: openCollection,
    onOpenSharesList: () => (sharesListOpen ? closeSharesList() : openSharesList()),
    onCollapse: toggleLeftPane,
    onStatus: flash,
    onOpenSettings: (initialSection?: string) => openSettings(initialSection),
    onFocusedRowChange: noteSidebarFocusedRow,
    onRequestCreate: requestCreate,
    onFocusFolder: setFolderFocus,
    onHelpWithReport: helpWithReport,
    onSwitcherOpenChange: setSwitcherOpen,
    onSwitcherChoose: chooseFromSwitcher,
  })

  // Tab cycling: the macOS-standard ⇧⌘] / ⇧⌘[ chords are dispatched by the T6 chord table; the
  // Ctrl-Tab / Ctrl-Shift-Tab alternate stays here (a structural key, not an assignable chord).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (overlayOpenRef.current) return // an open sheet owns the keyboard (useOverlayGuard)
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        cycle(e.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [cycle, overlayOpenRef])

  useEffect(
    () =>
      window.writeflex.onMenuAction((action) => {
        if (action === 'open-tabs') openOpenTabs()
        else if (action === 'next-tab') cycle(1)
        else if (action === 'previous-tab') cycle(-1)
        else if (action === 'next-folder-file') void browseFolderFile(1)
        else if (action === 'previous-folder-file') void browseFolderFile(-1)
      }),
    [browseFolderFile, cycle, openOpenTabs],
  )

  // ⌥⌘P (Pin to strip / Unpin from strip, ADR-0026) is dispatched by the T6 chord table; Option-click and the
  // context menu share the durable state; pins cap at four and carry no close control.

  // The File-menu Quick Open… and Command Palette… items route to the same registry-backed overlay
  // actions as their assignable chords; this covers a mouse click of either menu item.
  useEffect(
    () =>
      window.writeflex.onMenuAction((action) => {
        if (action === 'quick-open') openPalette('files')
        else if (action === 'command-palette') openPalette('commands')
      }),
    [openPalette],
  )

  // A folder-scope outline jump (Task 10): land the caret on `line` of `file`. If that file is already
  // the loaded active buffer, jump in-editor now; otherwise queue the line and open the file — the
  // activation effect flushes the queued line once switchTo makes the buffer live (cross-file jump).
  const jumpToFileLine = useCallback(
    (file: string, line: number) => {
      if (active === file && loadedPath.current === file) {
        editorRef.current?.goToLine(line)
      } else {
        pendingLine.current = { path: file, line }
        open(file)
      }
    },
    [active, open],
  )
  jumpToFileLineRef.current = jumpToFileLine

  // Land a search hit: open its tab, place the caret, and SELECT the match. Same-file hits select now;
  // a cross-file hit queues {path,…offsets} and opens the file — the activation effect flushes it once
  // switchTo makes the buffer live (the pendingLine pattern, extended with the match offsets).
  const jumpToMatch = useCallback(
    (match: SearchMatch) => {
      if (active === match.path && loadedPath.current === match.path) {
        editorRef.current?.goToMatch(match.line, match.column, match.length)
      } else {
        pendingMatch.current = { path: match.path, line: match.line, column: match.column, length: match.length }
        open(match.path)
      }
    },
    [active, open],
  )

  // --- Margin suggestion callouts (Task 16) ---
  // The panel's `view` link: open the staged file and, once its buffer is live, centre the
  // suggestion's anchored sentence (SuggestionCallout consumes the request against loadedFile).
  const [viewRequest, setViewRequest] = useState<CalloutViewRequest | null>(null)
  const viewSuggestion = useCallback(
    (path: string, suggestionId?: string) => {
      open(path)
      if (suggestionId) setViewRequest((r) => ({ id: suggestionId, path, tick: (r?.tick ?? 0) + 1 }))
    },
    [open],
  )

  /**
   * Reconcile one file the apply pipeline just rewrote on disk with whatever buffer state this
   * window holds for it: a clean buffer takes the disk version outright; a dirty buffer over changed
   * disk gets the changed-on-disk banner, like any other outside change (Reload or Keep mine), and keeps
   * its saved baseline, so no save of the buffer replaces the agent's version until the writer chooses
   * Keep mine against it. Other files' unsaved buffers are never touched.
   */
  const reconcileAppliedFile = useCallback(
    async (file: FileReadResult, options: { now?: boolean } = {}): Promise<void> => {
      // The owner's read of the disk, with the file main returned as what is there (document-owner.ts,
      // applyOutside): queued behind any route holding the path, or `now` from inside one.
      const path = file.file.path
      raiseForOutside(path, await owner.applyOutside(path, async () => file.content, options))
    },
    [owner, raiseForOutside],
  )

  // The Board's status move: the shared flushed route (D-STA-1), never the IPC on its own.
  const setBoardPieceStatus = useCallback(
    async (dir: string, path: string, status: string): Promise<void> => {
      await setPieceStatusFlushed(owner, window.writeflex.collection.setStatus, dir, path, status)
    },
    [owner],
  )

  /** The Board for a Folio, drawn inside its workspace's Cards tab: the same Board, its offcuts, Sources rail and Undo included. */
  const renderFolioBoard = (folio: { dir: string; name: string; onLeave: () => void; onOutline: () => void }): JSX.Element => (
    <Board
      label="Sources and offcuts"
      dir={folio.dir}
      name={folio.name}
      filter=""
      onOpenPiece={open}
      onNewPiece={newPiece}
      onStatus={flash}
      onListSources={(path, sourceDir) => setPieceSourcesRequest({ path, dir: sourceDir })}
      setPieceStatus={setBoardPieceStatus}
      seenStatuses={boardSeenStatusesRef.current}
      onFolderPieceSelected={setSelectedFolderPiece}
      onQueryContext={updateQueryInsertionContext}
      onInsertQuery={requestQueryInsertion}
      onOpenPlan={folio.onOutline}
      onOpenCollection={folio.onLeave}
    />
  )

  // Accepting a change in an open document is a route of the document owner (resolution-routes.ts).
  const acceptThroughOwner = useCallback(
    <A extends AcceptAnswer,>(path: string, id: string, resolve: () => Promise<A>): Promise<AcceptRouteResult<A>> => {
      cancelAutosaveFor(path)
      // e2e only: `hold-accept` holds main's apply inside the owner's route until `releaseSlowSave`.
      const resolveMaybeHeld = window.writeflex.e2eWriteHooks
        ? async (): Promise<A> => {
            if (e2eSaveBehaviourRef.current === 'hold-accept') {
              await new Promise<void>((release) => { e2eSlowSaveReleaseRef.current = release })
            }
            return resolve()
          }
        : resolve
      return acceptRoute({
        owner,
        bufferOf: bufferNow,
        recordInEditor: (p, changeId, resolvedContent, scratchPlacement) => editorRef.current?.recordSuggestionResolution(p, changeId, 'accept', resolvedContent, scratchPlacement) === true,
        // Typing that arrived while main applied the change is kept; main's version is asked about.
        askAbout: (p, diskText) => {
          cancelAutosaveFor(p)
          if (!sameDiskNotice(externalDiskNoticesRef.current.get(p), 'changed', diskText)) {
            raiseExternalDiskNotice(p, { kind: 'changed', dirty: true, diskText })
          }
        },
        refusalReason: (p) => (guardRefusalPath.current === p ? refusalReasons.current.get(p) : undefined),
        changedOnDisk: askAboutRefusedWrite,
      }, path, id, resolveMaybeHeld)
    },
    [owner, bufferNow, cancelAutosaveFor, raiseExternalDiskNotice, askAboutRefusedWrite],
  )
  // A reject runs in the document's queue too, so that main receives it in order with the other resolutions.
  const inDocumentQueue = useCallback(<T,>(path: string, run: () => Promise<T>): Promise<T> => owner.inQueue(path, run), [owner])
  // A proposal resolved from the Agent notes pane takes the same routes (parcel 2b, residual c of 2a).
  const resolveAgentProposal = useCallback(
    (change: Change, action: 'accept' | 'reject') => resolveProposalThroughOwner({
      accept: acceptThroughOwner,
      inQueue: inDocumentQueue,
      resolveChange: (id, act) => window.writeflex.resolveChange(id, act),
    }, change, action),
    [acceptThroughOwner, inDocumentQueue],
  )
  // Accept all / Decline all from one outside source, across the collection. A document this window holds is
  // accepted through the single click's own route (acceptThroughOwner); main accepts the rest the same way.
  const outsideSourceBulk = useOutsideSourceBulk({
    rows: outsideDock.sources,
    isOpen: (path) => bufferNow(path) !== null || owner.baselineDiskOf(path) !== undefined,
    acceptInWindow: async (path, id) => {
      const accepted = await acceptThroughOwner(path, id, () => window.writeflex.resolveChange(id, 'accept', { sweep: false }))
      return accepted.status === 'acted' ? { applied: accepted.result.applied, message: accepted.result.message } : { applied: false, message: accepted.message }
    },
    afterRun: async () => {
      handleAgentWorkspaceChange()
      await refreshInlineChangesAfterReconcile()
    },
    restoreFocus: restoreEditorFocus,
    flash,
  })
  outsideSourceBulkRef.current = (action) => {
    // The source of the item in hand when it came from outside; otherwise the source with the most waiting.
    const current = dockChanges.find((change) => change.id === reviewCursorRef.current?.currentId)?.outsideSource
    setReviewAskState(null)
    outsideSourceBulk.open(action, current && current !== 'reader' ? current : undefined)
  }

  // Accept ⏎: apply through the real pipeline (suggestions:apply — snapshot, execute, audit), then
  // refresh the workspace exactly as any agent write does and reconcile the rewritten file. The
  // status copy promises ⌘⇧Z only when the apply truthfully armed Undo turn (agent-chat.ts).
  const acceptSuggestion = useCallback(
    async (suggestion: Suggestion, change?: Change): Promise<boolean> => {
      try {
        const resolvedChange = change ?? changes.find((candidate) => findLiveSuggestionForChange([candidate], [suggestion], candidate.id))
        if (!resolvedChange) return false
        // Capture WHERE the edit will land before applying: the staged anchor's start is where the
        // replacement text begins once oldText→newText lands (everything before it is untouched), so
        // the applied range is recoverable even though reconcileAppliedFile rebuilds the buffer below.
        const view = editorRef.current?.view()
        const proseInput =
          suggestion.capabilityName === 'prose.edit' ? (suggestion.input as ProseEditInput) : null
        const anchorFrom =
          view && proseInput ? suggestionAnchors(view.state).find((a) => a.id === suggestion.id)?.from : undefined

        // The buffer takes what main wrote (`written`), not the file read back after: a readback that
        // differs is another program's version, asked about by the banner (Muse M2, round 2).
        const accepted = await acceptThroughOwner(resolvedChange.path, resolvedChange.id, () => window.writeflex.resolveChange(resolvedChange.id, 'accept'))
        if (accepted.status !== 'acted') {
          flash(accepted.message)
          return false
        }
        const { result, recorded } = accepted
        handleAgentWorkspaceChange()
        if (!result.applied) {
          flash(result.message ?? 'Could not apply that suggestion.')
          return false
        }
        if (recorded) await refreshInlineChangesAfterReconcile()
        else await reloadChanges()
        // Jump the writer's eye to the applied text and flash it — only when its file is the live
        // buffer (reconcile just refreshed it, so the replacement is really there to land on).
        if (view && proseInput && loadedPath.current === proseInput.path) {
          const len = proseInput.newText.length
          let range: { from: number; to: number } | null = null
          if (anchorFrom != null && view.state.sliceDoc(anchorFrom, anchorFrom + len) === proseInput.newText)
            range = { from: anchorFrom, to: anchorFrom + len }
          else {
            // Anchor unknown or shifted (a dirty buffer before it): fall back to a unique match of the
            // new text; if it isn't unique, skip the jump rather than land on a guess.
            const unique = uniqueRange(view.state.doc.toString(), proseInput.newText)
            if (unique) range = unique
          }
          if (range) {
            const flashed = minimisedAppliedRange(proseInput.oldText, proseInput.newText, range.from)
            flashApplied(view, flashed.from, flashed.to)
          }
        }
        const armed = agent.noteSuggestionApplied()
        flash(result.message ?? (armed ? 'Edit applied — undo the turn with ⌘⇧Z' : 'Edit applied'))
        return true
      } catch (error) {
        flash(error instanceof Error ? error.message : String(error))
        return false
      }
    },
    [changes, handleAgentWorkspaceChange, acceptThroughOwner, refreshInlineChangesAfterReconcile, reloadChanges, agent.noteSuggestionApplied, flash],
  )

  // Reject ⌫: discard from the staged store — the disk is never touched; the suggestions push clears the
  // callout and demotes the panel row to Reviewed. Main's refusal (the change was already applied) is shown.
  const rejectSuggestion = useCallback(
    async (suggestion: Suggestion, change?: Change): Promise<boolean> => {
      try {
        const resolvedChange = change ?? changes.find((candidate) => findLiveSuggestionForChange([candidate], [suggestion], candidate.id))
        if (!resolvedChange) { flash(CLOSE_REFUSED_MESSAGE); return false }
        const result = await inDocumentQueue(resolvedChange.path, () => window.writeflex.resolveChange(resolvedChange.id, 'reject'))
        if (!result.applied) { flash(result.message ?? CLOSE_REFUSED_MESSAGE); return false }
        const recorded = editorRef.current?.recordSuggestionResolution(resolvedChange.path, resolvedChange.id, 'reject') === true
        if (recorded) await refreshInlineChangesAfterReconcile()
        else await reloadChanges()
        flash(result.message ?? 'Suggestion discarded')
        return true
      } catch (error) {
        flash(error instanceof Error ? error.message : String(error))
        return false
      }
    },
    [changes, inDocumentQueue, refreshInlineChangesAfterReconcile, reloadChanges, flash],
  )

  // Revise R → ⏎: the note supersedes the staged edit — discard it, then send the note back
  // through the real prompt channel (Ship 1 contract copy); the agent stages a fresh suggestion.
  const reviseSuggestion = useCallback(
    async (suggestion: Suggestion, note: string) => {
      if (agent.running) {
        flash('The agent is still working — send the note when the turn finishes')
        return
      }
      await reviseSuggestionWithWarning({
        suggestionId: suggestion.id,
        note,
        discard: window.writeflex.discardSuggestion,
        prompt: agent.prompt,
        flash,
      })
    },
    [agent.running, agent.prompt, flash],
  )

  // ── Change action handlers (dock + inline track-changes) ─────────────────────────────────────
  // A change backed by a LIVE staged suggestion resolves through the SAME acceptSuggestion/rejectSuggestion
  // path the margin callout used — so the editor buffer is reconciled to the applied text, the change
  // flashes, and Undo is armed (the coherence the status-only main path lacked). Only a change with no
  // unambiguous live suggestion (reopened workspace / apply failure / duplicated move source text) falls
  // back to the exact main-process resolver.
  // The review-action domain (accept/reject/hold, batch + multi-select, discard/send-back/revise) lives
  // in its own hook. `ledger: window.writeflex` is the one Bridle-facing binding — when the change ledger
  // moves upstream, this line is where the app re-points.
  const {
    acceptChange,
    acceptAndNext,
    rejectChange,
    holdChange,
    acceptAllPending,
    acceptInsertions,
    acceptDeletions,
    acceptMany,
    rejectMany,
    discardRun,
    sendRunBack,
    reviseChange,
    reopenChange,
    onInlineAction,
  } = useReviewActions({
    ledger: window.writeflex,
    changes,
    dockChanges,
    suggestions: agent.suggestions,
    editorRef,
    recordedWriterChanges,
    acceptSuggestion,
    rejectSuggestion,
    savePath,
    reloadChanges,
    refreshInlineChangesAfterReconcile,
    flash,
    handleAgentWorkspaceChange,
    reconcileAppliedFile,
    acceptThroughOwner,
    inDocumentQueue,
    focusComposer,
    setChangesOpen,
    selectChange,
    settleChange: settleReviewChange,
    onAcceptRefused: noteAcceptRefused,
  })
  // Margin card ▸ More ▸ "No heading in the text": the proposal is declined first, then the part's heading choice is
  // written by the same guarded path the Plan uses. A failed decline writes nothing; a refused write (the file
  // changed) reopens the proposal and says why (keep-title-in-metadata.ts).
  // The part is the open document, so the write is a route of the document owner (save fix, parcel 2a, as the
  // goal): the buffer is written until saved, the heading choice is written holding the document's queue and
  // only over the version the buffer is based on, and the buffer takes main's text only from the receipt.
  const writeHeadingNoneThroughOwner = useCallback(async (path: string): Promise<void> => {
    const flushed = await owner.withFlushed([path], async (snapshots) => {
      const snapshot = snapshots.get(path)!
      // Not open in this window: nothing to hold, and main writes only over the part it reads (R5).
      if (snapshot.text === null || snapshot.baselineDisk === undefined) {
        await window.writeflex.plan.setHeadingModeOfPart(path, 'none')
        return { outcome: null }
      }
      const answer = await window.writeflex.plan.setHeadingModeOfOpenPart(path, 'none', basisFromBaseline(snapshot.baselineDisk))
      if ('refused' in answer) return { outcome: null, refused: answer }
      if (answer.written === undefined) return { outcome: null }
      return { outcome: owner.replaceFromMain(path, { written: answer.written, content: answer.content }, { since: snapshot.gen, mode: 'replace' }) }
    })
    if (flushed.status !== 'acted') {
      throw new Error(flushed.status === 'still-unsaved'
        ? 'The document was still being edited while it was saved, so its heading choice was not written'
        : 'Could not save the document, so its heading choice was not written')
    }
    const { outcome } = flushed.result
    const refused = 'refused' in flushed.result ? flushed.result.refused : undefined
    if (refused) {
      // Another version is on disk than the one the buffer was based on: nothing is written over it, and the
      // file's changed-on-disk notice is raised (as the goal route); the caller reopens the proposal.
      const buffer = bufferNow(path)
      if (buffer !== null) noteDiskChangedUnderBuffer(path, refused.diskText, buffer)
      throw new Error('The document changed on disk, so its heading choice was not written. Choose Reload or Keep mine above the text')
    }
    if (outcome?.kind === 'moved') {
      // Typing arrived while main wrote: it is kept, and the file with the choice is asked about like any outside change.
      cancelAutosaveFor(path)
      if (!sameDiskNotice(externalDiskNoticesRef.current.get(path), 'changed', outcome.diskText)) {
        raiseExternalDiskNotice(path, { kind: 'changed', dirty: true, diskText: outcome.diskText })
      }
    }
  }, [owner, bufferNow, cancelAutosaveFor, noteDiskChangedUnderBuffer, raiseExternalDiskNotice])
  const keepTitleInMetadataOnly = useCallback(async (change: Change): Promise<void> => {
    await keepTitleInMetadataOnlySteps(change, {
      decline: rejectChange,
      writeHeadingNone: writeHeadingNoneThroughOwner,
      reopen: reopenChange,
      refusal: (error) => humanReadableError(error, 'Could not change that part’s heading choice, so the proposal is back.'),
    })
  }, [rejectChange, reopenChange, writeHeadingNoneThroughOwner])
  // Accept and next from a card: the card goes, so focus follows the review to the next one (or the text when none is left).
  const acceptAndNextFocused = useCallback(async (id: string): Promise<boolean> => {
    const fromMargin = window.document.activeElement instanceof HTMLElement && window.document.activeElement.closest('.wf-margin') !== null
    const done = await acceptAndNext(id)
    if (fromMargin) {
      const next = reviewCursorRef.current?.currentId ?? null
      if (next !== null && next !== id) focusCardSoon(next)
      else restoreEditorFocus()
    }
    return done
  }, [acceptAndNext, focusCardSoon, restoreEditorFocus])
  acceptAndNextRef.current = acceptAndNextFocused
  // The count menu (ADR-0046): rows from the margin model, read when it opens; the actions are today's.
  const reviewCountMenu = useCallback(() => {
    if (!reviewModels) return []
    return countMenu({
      model: reviewModels.shown,
      state: marginFilterState,
      preferredView: readPreferredView(),
      textRoom: readTextRoom(),
      marginHidden,
      picked: pickedCards,
      viewCounts: viewCountsOf(reviewModels.review),
      chords: {
        next: formatShortcutKey(resolveChord('review.nextChange', shortcutOverrides) ?? ''),
        previous: formatShortcutKey(resolveChord('review.previousChange', shortcutOverrides) ?? ''),
        nextPiece: formatShortcutKey(resolveChord('review.nextPieceWaiting', shortcutOverrides) ?? ''),
        acceptAll: formatShortcutKey(resolveChord('review.acceptAll', shortcutOverrides) ?? ''),
        declineAll: formatShortcutKey(resolveChord('review.declineAll', shortcutOverrides) ?? ''),
        sendBack: formatShortcutKey(resolveChord('review.sendBack', shortcutOverrides) ?? ''),
        switchView: formatShortcutKey(resolveChord('review.switchMarginView', shortcutOverrides) ?? ''),
        toggleMargin: formatShortcutKey(resolveChord('review.toggleMargin', shortcutOverrides) ?? ''),
        saveVersion: formatShortcutKey(resolveChord('file.nameVersion', shortcutOverrides) ?? ''),
      },
      outsideSources: outsideDock.sources,
    })
  }, [reviewModels, marginFilterState, marginHidden, shortcutOverrides, pickedCards, outsideDock.sources])
  // Ticket 04: the bulk actions, over the same model the review line and the count menu are drawn from, so a label and the
  // action under it agree and nothing a filter hides is touched. They need no margin on screen. Every write goes through
  // the review actions (acceptMany / rejectMany, one change at a time in document order), exactly as before.
  const bulkRef = useRef({ reviewModels, pickedCards, marginFilter, reviewMode })
  bulkRef.current = { reviewModels, pickedCards, marginFilter, reviewMode }
  const bulkAccept = useCallback((kind?: 'edit' | 'note') => {
    const { reviewModels: models, pickedCards: picked, marginFilter: filter, reviewMode: mode } = bulkRef.current
    if (!models) { acceptAllPending(); return }
    // My edits (ticket 08): Accept all is the Accept session, exactly as before (status only, no text touched).
    if (mode === 'mine' && picked.size === 0 && kind !== 'note') { void acceptWriterSession(); return }
    const targets = kind ? bulkTargets(models.shown, picked, filter, kind) : runTargets(models.shown, picked, filter, 'accept')
    if (targets.ids.length === 0) { flash(kind === 'note' ? 'No comments to mark done' : 'No edits to accept'); return }
    void acceptMany(targets.ids)
    setPickedCards(new Set())
  }, [acceptAllPending, acceptMany, flash, acceptWriterSession])
  const askDecline = useCallback(() => {
    const { reviewModels: models, pickedCards: picked, marginFilter: filter } = bulkRef.current
    if (!models) {
      // No piece's margin (a collection page): the whole pending run, as before, but it still asks.
      const pending = dockChanges.filter((change) => change.status === 'pending')
      if (pending.length === 0) { flash('No pending changes to decline'); return }
      const model = buildMarginModel({ changes: dockChanges, document: '', view: 'margin' })
      const ids = pending.map((change) => change.id)
      setReviewAskState({ kind: 'decline', ids, question: declineQuestion(model, ids), whole: true })
      return
    }
    const targets = runTargets(models.shown, picked, filter, 'decline')
    if (targets.declinable.length === 0) { flash('No edits to decline'); return }
    setReviewAskState({ kind: 'decline', ids: targets.declinable, question: declineQuestion(models.shown, targets.declinable) })
  }, [dockChanges, flash])
  const openSendBack = useCallback((open = true) => {
    const models = bulkRef.current.reviewModels
    if (!open) { setReviewAskState(null); return }
    setReviewAskState({ kind: 'send-back', scope: models ? sendBackScope(models.shown) : sendBackScope(buildMarginModel({ changes: dockChanges, document: '', view: 'margin' })) })
  }, [dockChanges])
  const reviewAsk = useMemo<ReviewAsk | null>(() => {
    const ask = reviewAskState
    if (!ask) return null
    const cancel = (): void => { setReviewAskState(null); restoreEditorFocus() }
    if (ask.kind === 'decline') {
      return {
        kind: 'decline', question: ask.question, onCancel: cancel,
        onConfirm: () => {
          setReviewAskState(null)
          if (ask.whole) discardRun()
          else {
            // Only what still waits: one settled while the question was open is left alone.
            const waiting = new Set(dockChanges.filter((change) => change.status === 'pending' || change.status === 'held').map((change) => change.id))
            const ids = ask.ids.filter((id) => waiting.has(id))
            if (ids.length > 0) void rejectMany(ids)
          }
          setPickedCards(new Set())
          restoreEditorFocus()
        },
      }
    }
    return {
      kind: 'send-back', scope: ask.scope, onCancel: cancel,
      onSend: (note: string) => {
        setReviewAskState(null)
        // Today's meaning: one note to the agent composer. The agent's items stay, marked Sent back.
        sendRunBack(note)
        if (ask.scope.ids.length > 0) setSentBackIds((current) => new Set([...current, ...ask.scope.ids]))
      },
    }
  }, [reviewAskState, dockChanges, discardRun, rejectMany, sendRunBack, restoreEditorFocus])
  const runCountMenuAction = useCallback((action: CountMenuAction) => {
    switch (action.type) {
      case 'step': stepReview(action.direction); break
      case 'next-piece': nextPieceWithItems(); break
      case 'accept': bulkAccept(action.kind); break
      case 'decline': marginCommandRef.current('decline'); break
      case 'send-back': marginCommandRef.current('send-back'); break
      case 'state':
        setMarginFilterState(action.state)
        if (reviewModeOf(action.state) !== 'review' && marginHiddenRef.current) toggleMargin()
        break
      case 'view': {
        const margin = marginControlRef.current
        if (margin) margin.setView(action.view)
        else {
          setPreferredView(action.view)
          toggleMargin()
        }
        break
      }
      case 'toggle-margin': toggleMargin(); break
      case 'save-version': requestNameVersion(); break
      case 'outside-source': setReviewAskState(null); outsideSourceBulk.open(action.action, action.source); break
    }
  }, [stepReview, nextPieceWithItems, bulkAccept, toggleMargin, requestNameVersion, outsideSourceBulk])
  // The one handler for the run-level review keys. The margin acts on its selection, else on what its filter shows; with no margin mounted
  // (no document open, a collection page) the keys fall back to the whole pending run.
  marginCommandRef.current = (what): void => {
    const margin = marginControlRef.current
    if (what === 'focus') {
      if (margin) { margin.focusFirst(); return }
      if (marginHiddenRef.current) { toggleMargin(); requestAnimationFrame(() => requestAnimationFrame(() => marginControlRef.current?.focusFirst())); return }
      flash('Open a document to review its changes.')
      return
    }
    if (what === 'send-back') { openSendBack(); return }
    if (what === 'accept') bulkAccept(); else askDecline()
  }
  const saveRunVersion = useCallback((name: string) => {
    void (async () => {
      const trimmed = name.trim()
      if (!active) {
        flash('Open a document before saving a version.')
        return
      }
      if (!trimmed) {
        setVersionDialogError('Name the version before saving.')
        return
      }
      cancelPendingFlush() // save-version flushes explicitly; a racing debounced flush must not double-record
      await flushWriterChanges(active)
      // Written until the owner counts it saved (parcel 2a pulls this one route forward from 2b): the
      // applied file is reconciled below by the owner's rule, which replaces only a saved buffer.
      if ((await owner.withFlushed([active], () => undefined)).status !== 'acted') {
        flash('Could not save the latest text, so no version snapshot was made.')
        return
      }
      const latest = await window.writeflex.listChanges({ path: active })
      setChanges(latest)
      setChangesPath(active)
      const result = await window.writeflex.saveChangeVersion({
        path: active,
        name: trimmed,
        changeIds: latest
          .filter((change) => !change.snapshotId && change.status !== 'rejected')
          .map((change) => change.id),
      })
      editorRef.current?.settleWriterChanges(active)
      clearFileWriterState(active)
      // Saving a version APPLIES still-pending accepted edits on disk (main-side), so the open buffer
      // is now stale — reconcile it with the applied file or the editor keeps showing pre-apply text.
      try {
        await reconcileAppliedFile(await window.writeflex.readFile(active))
      } catch {
        /* the file just saved; a read failure here only delays the refresh to the next reload */
      }
      await reloadChanges()
      await reloadVersions()
      closePalette()
      setChangesOpen(true)
      flash(`Version “${result.record.name}” saved — ${result.accepted} kept, ${result.pending} pending`)
    })()
  }, [active, owner, cancelPendingFlush, flushWriterChanges, clearFileWriterState, reconcileAppliedFile, reloadChanges, reloadVersions, closePalette, flash])
  useEffect(
    () =>
      window.writeflex.onMenuAction((action) => {
        if (action === 'name-version') requestNameVersion()
      }),
    [requestNameVersion],
  )
  // ⇧⌘S (Save Version…) is dispatched by the T6 chord table; the menu item stays the mouse path.
  // Revise hands off to the agent: open the composer for a fresh instruction on this change.

  // ⇧⌘F (Search Workspace, the toggleSearch contract — keyboard lands in the query field) is
  // dispatched by the T6 chord table; menu.ts keeps Search Files… at registerAccelerator:false.

  // The File-menu Search Files… item routes here when clicked (the shortcut itself is renderer-owned above).
  useEffect(
    () =>
      window.writeflex.onMenuAction((action) => {
        if (action === 'search') toggleSearch()
        else if (action === 'archive-search' && !archiveSearchOpenRef.current) toggleArchiveSearch()
      }),
    [toggleSearch, toggleArchiveSearch],
  )

  // The + button / ⌘N create-file flow belongs to a later task; the affordance renders now so the
  // tab strip matches the locked design, and gets wired when file creation lands.
  const handleNewTab = useCallback(() => requestCreate('file'), [requestCreate])

  // Opening a Workspace from the start screen. Both channels bind the Workspace in main; the renderer
  // then re-pulls workspace:get so a bind into this (start-screen) window swaps it to the full shell.
  // (Opening while a Workspace is already open binds a new window in main and leaves this one as-is.)
  const openDialog = useCallback(async () => {
    await window.writeflex.openDialog()
    await refresh()
  }, [refresh])
  const openRecent = useCallback(
    async (recentRoot: string) => {
      await window.writeflex.openRecent(recentRoot)
      await refresh()
    },
    [refresh],
  )
  // The start screen's Guide and Example collection entries: main holds the path and binds it.
  const openExample = useCallback(
    async (target: 'guide' | 'collection') => {
      await window.writeflex.openExample(target)
      await refresh()
    },
    [refresh],
  )

  // ⌘O is a native File-menu accelerator; menu.ts routes it to the focused renderer as a menu action
  // (T3 precedent) rather than driving the dialog from main, so the window that binds also refreshes.
  useEffect(
    () =>
      window.writeflex.onMenuAction((action) => {
        if (action === 'open-dialog') void openDialog()
      }),
    [openDialog],
  )

  // The first workspace:get is still in flight (root === undefined): paint a neutral frame — the
  // traffic-light drag region + brand over an empty body — rather than the start screen. Resolution
  // is fast, so a workspace-bound boot swaps straight to the shell without flashing the empty state.
  if (root === undefined) {
    return (
      <div className="app-shell">
        <div className="toolbar">
          <div className="traffic-spacer" aria-hidden="true" />
        </div>
        <div className="body" />
      </div>
    )
  }

  // With no Workspace bound, the window shows the designed start screen in place of the shell body
  // (ADR-0009 designed-empty-state). The toolbar stays as the traffic-light drag region + brand.
  if (root === null) {
    return (
      <div className="app-shell">
        <div className="toolbar">
          <div className="traffic-spacer" aria-hidden="true" />
        </div>
        <div className="body">
          <StartScreen onOpen={() => void openDialog()} onOpenRecent={(r) => void openRecent(r)} onOpenExample={(target) => void openExample(target)} onRemoveExample={() => setRemoveExampleOpen(true)} />
        </div>
        {removeExampleOpen && <RemoveExampleConfirm onClose={() => setRemoveExampleOpen(false)} />}
      </div>
    )
  }

  const renderDocumentOutline = (workspaceDir?: string): JSX.Element => (
    <aside className="outline" aria-label="Outline">
      <OutlinePane
        workspaceDir={workspaceDir}
        editorRef={editorRef}
        snapshot={snapshot}
        // The buffer the editor really shows: after a failed read `active` is the target but the old buffer stays on screen.
        activePath={loadedFile ?? active}
        onJumpToFile={(file, line, isPart) => {
          if (workspaceDir !== undefined && isPart === true) {
            window.dispatchEvent(new CustomEvent(ROOM_VIEW_EVENT, { detail: { path: file } }))
            if (active === file && loadedPath.current === file) editorRef.current?.goToLine(line)
            else { pendingLine.current = { path: file, line }; openTab(file) }
          } else jumpToFileLine(file, line)
        }}
        savedTick={savedTick}
        focusTick={outlineFocusTick}
        shortcutFor={(commandId) => resolveChord(commandId, shortcutOverrides)}
        request={outlineRequest}
        folioPlace={active !== null ? folioPlace : null}
        folderFileCount={outlineFolderFileCount}
        onOpenFile={(file, isPart) => { if (workspaceDir !== undefined && isPart === true) window.dispatchEvent(new CustomEvent(ROOM_VIEW_EVENT, { detail: { path: file } })); else open(file) }}
        onOpenPlan={workspaceDir !== undefined ? () => openPlanIn(workspaceDir) : openFolioPlan}
        onStatus={flash}
        runningOrder={folioRunningOrder}
        folioRefreshTick={folioRefreshTick}
      />
    </aside>
  )

  const activeExternalDiskNotice = active ? externalDiskNotices.get(active) : undefined
  const externalDiskNoticePaths = new Set(externalDiskNotices.keys())

  // The open-tabs list (ticket 14): the sidebar's Tabs content, as a popover under the toolbar's Tabs button.
  const tabsPopover = tabsListOpen ? (
        <TabBar
          orientation="sidebar"
          tabs={tabs}
          active={activeTab}
          pinned={pinnedTabs}
          recent={recentTabs}
          visibleInStrip={visibleTabStripPaths}
          groups={openTabGroups}
          rootName={workspaceName}
          parentByPath={tabParents}
          onTrailBack={() => walkLinkTrail(-1)}
          onTrailForward={() => walkLinkTrail(1)}
          canTrailBack={linkTrailIndex > 0}
          canTrailForward={linkTrailIndex >= 0 && linkTrailIndex < linkTrail.length - 1}
          modifiedAt={tabModifiedAt}
          boardName={collectionName}
          dirtyPaths={dirtyPaths}
          diskNoticePaths={externalDiskNoticePaths}
          onActivate={activateFromTabsList}
          onClose={closeTab}
          onNew={handleNewTab}
          onPin={pinTab}
          onReveal={revealFileInFiles}
          onReorderPin={reorderPinnedTab}
          focusTick={openTabsFocusTick}
        />
  ) : null

  return (
    <ActionsHereContext.Provider value={actionsHereApi}>
    <TitleConflictContext.Provider value={titleConflictActions}>
    <div className={`app-shell window${distractionFree ? ' df' : ''}`} ref={shellRef} tabIndex={-1}>
      <Toolbar
        sidebarOpen={!leftPaneCollapsed}
        sidebarShortcut={formatShortcutKey(resolveChord('view.toggleLeftPane', shortcutOverrides) ?? '')}
        panelsShortcut={formatShortcutKey(resolveChord('view.toggleRightPane', shortcutOverrides) ?? '')}
        onToggleSidebar={toggleSidebar}
        panelsOpen={!rightPaneCollapsed}
        onTogglePanels={toggleRightPane}
        writerMode={writerMode}
        viewMode={viewMode}
        modeDrawerOpen={modeDrawerOpen}
        onModeDrawerOpenChange={setModeDrawerOpen}
        onSelectWriterMode={changeWriterMode}
        onSelectViewMode={selectViewMode}
        onOpenPalette={() => openPalette('commands')}
        folioName={folioPlace?.name ?? null}
        onOpenFolioPlan={openFolioPlan}
        onToggleGuide={toggleGuideTab}
        guideOpen={guideOpen && rightTab === 'guide' && !rightPaneCollapsed}
        actionBarVisible={actionBarVisible}
        onToggleActionBar={toggleActionBar}
        actionBarShortcut={actionBarShortcut}
        readingRoomOpen={readingRoomOpen}
        readingRoomShortcut={formatShortcutKey(resolveChord(READING_ROOM_TOGGLE_COMMAND.id, shortcutOverrides) ?? '')}
        onToggleReadingRoom={() => setReadingRoomVisibility(!readingRoomOpen)}
        boardFilter={boardActive ? { value: boardFilter, onChange: setBoardFilter } : undefined}
        onToggleTabsList={toggleTabsList}
        tabsListOpen={tabsListOpen}
        tabsShortcut={formatShortcutKey(resolveChord(OPEN_TABS_COMMAND.id, shortcutOverrides) ?? '')}
        tabsPopover={tabsPopover}
        onCloseTabsList={closeTabsList}
        shareMark={shareMark}
        shareOpen={sharingPageOpen}
        onOpenSharing={() => (sharingPageOpen ? closeSharingPage() : openSharingPage())}
      >
        <TabBar
          orientation="horizontal"
          tabs={stripTabs}
          active={activeTab}
          pinned={pinnedTabs}
          recent={recentTabs}
          boardName={collectionName}
          dirtyPaths={dirtyPaths}
          diskNoticePaths={externalDiskNoticePaths}
          onActivate={activate}
          onClose={closeTab}
          onNew={handleNewTab}
          onPin={pinTab}
          onReveal={revealFileInFiles}
          onReorderPin={reorderPinnedTab}
          onOpenTabs={openOpenTabs}
          onStripVisibleChange={setMeasuredVisibleTabs}
        />
      </Toolbar>
      {folderFocus && !distractionFree && (
        <FocusPathBar
          rootName={workspaceName ?? 'Workspace'}
          focus={folderFocus.path}
          onFocus={setFolderFocus}
          onClear={() => setFolderFocus(null)}
        />
      )}
      <div className={`body tabbed-shell${leftPaneCollapsed ? ' left-collapsed' : ''}${rightPaneCollapsed ? ' right-collapsed' : ''}${archiveSearchOpen ? ' archive-open' : ''}`}>
        {!leftPaneCollapsed && (
          <aside className={`chrome-pane left-pane${distractionFree ? ' df-pane' : ''}`} aria-label="Left pane" style={distractionFree ? undefined : { width: leftPaneWidth }}>
            {distractionFree && <div className="df-ph">{leftTab === 'files' ? <FolderTree className="icon sm" /> : leftTab === 'outline' ? <List className="icon sm" /> : <Search className="icon sm" />}<span>{`${leftTab[0].toUpperCase()}${leftTab.slice(1)}`}</span><span className="gap" /><button type="button" className="x" aria-label="Close panel" title={`Close panel (${formatShortcutKey(resolveChord('view.toggleLeftPane', shortcutOverrides) ?? '')})`} onClick={toggleLeftPane}><X className="icon sm" /></button></div>}
            {!distractionFree && <div className="pane-tabs" role="tablist" aria-label="Sidebar sections">
              <button type="button" className={leftTab === 'files' ? 'pane-tab on' : 'pane-tab'} role="tab" aria-selected={leftTab === 'files'} onClick={openFilesTab} title="Files (⇧⌘E)" aria-keyshortcuts="Shift+Meta+E">
                <FolderTree className="icon i sm" aria-hidden="true" />
                Files <span className="pchord" aria-hidden="true">⇧⌘E</span>
              </button>
              <button type="button" className={leftTab === 'outline' ? 'pane-tab on' : 'pane-tab'} role="tab" aria-selected={leftTab === 'outline'} onClick={openOutlineTab} title="Outline (⇧⌘O)" aria-keyshortcuts="Shift+Meta+O">
                <List className="icon i sm" aria-hidden="true" />
                Outline <span className="pchord" aria-hidden="true">⇧⌘O</span>
              </button>
              <button type="button" className={leftTab === 'search' ? 'pane-tab on' : 'pane-tab'} role="tab" aria-selected={leftTab === 'search'} onClick={openSearchTab} title="Search (⇧⌘F)" aria-keyshortcuts="Shift+Meta+F">
                <Search className="icon i sm" aria-hidden="true" />
                Search <span className="pchord" aria-hidden="true">⇧⌘F</span>
              </button>
              <button type="button" className="sidebar-fold" onClick={toggleLeftPane} title={`Collapse sidebar (${formatShortcutKey(resolveChord('view.toggleLeftPane', shortcutOverrides) ?? '')})`} aria-label="Collapse sidebar">
                <ChevronLeft className="icon sm" aria-hidden="true" />
              </button>
            </div>}
            <div className="pane-body">
              <div className={leftTab === 'files' ? 'pane-view active' : 'pane-view hidden'} role="tabpanel" aria-label="Files">
                {/* The .sidebar wrapper is load-bearing: .pane-view>.sidebar sizes it for the tabbed
                    chrome, and the file-tree e2e surface addresses rows as .sidebar .trow. CH-1
                    dropped it by accident, silently orphaning both. */}
                <nav className="sidebar" aria-label="Files" onKeyDown={(event) => {
                  if (event.code !== 'KeyF' || event.metaKey === event.ctrlKey || event.shiftKey || event.altKey) return
                  event.preventDefault()
                  event.stopPropagation()
                  focusSidebarFilter()
                }}>
                  <Sidebar
                    files={files}
                    checklistProgress={checklistProgress}
                    waitingCounts={waitingCounts}
                    folders={folders}
                    pieceCount={sidebarCollectionSummary?.pieceCount}
                    folderPiecePaths={sidebarCollectionSummary?.folderPiecePaths}
                    favourites={favourites}
                    activePath={active}
                    onOpen={sidebarHandlers.onOpen}
                    onToggleFavourite={sidebarHandlers.onToggleFavourite}
                    onOpenCollection={sidebarHandlers.onOpenCollection}
                    dashboardDir={collectionDir}
                    onOpenSharesList={sidebarHandlers.onOpenSharesList}
                    sharesListOn={sharesListOpen}
                    root={root}
                    onCollapse={sidebarHandlers.onCollapse}
                    onStatus={sidebarHandlers.onStatus}
                    onOpenSettings={sidebarHandlers.onOpenSettings}
                    onFocusedRowChange={sidebarHandlers.onFocusedRowChange}
                    onRequestCreate={sidebarHandlers.onRequestCreate}
                    version={appVersion}
                    focusFilterTick={sidebarFilterFocusTick}
                    fileOps={stableSidebarFileOps}
                    createRequest={createRequest}
                    focusTreeRequest={treeFocusRequest}
                    focusPath={folderFocus?.path ?? null}
                    onFocusFolder={sidebarHandlers.onFocusFolder}
                    onHelpWithReport={sidebarHandlers.onHelpWithReport}
                    switcherOpen={switcherOpen}
                    onSwitcherOpenChange={sidebarHandlers.onSwitcherOpenChange}
                    onSwitcherChoose={sidebarHandlers.onSwitcherChoose}
                  />
                </nav>
              </div>
              <div className={leftTab === 'outline' ? 'pane-view active' : 'pane-view hidden'} role="tabpanel" aria-label="Outline">
                <RoomBinderSwitch onOpenFile={open} write={folioRunningOrder.write} contents={renderDocumentOutline(workspaceFolioDir ?? undefined)}>
                {renderDocumentOutline()}
                </RoomBinderSwitch>
              </div>
              <div className={leftTab === 'search' ? 'pane-view active' : 'pane-view hidden'} role="tabpanel" aria-label="Search workspace">
                <SearchPanel onOpenHit={(match) => { jumpToMatch(match); noteOpenSource(match.path, 'search') }} onClose={closeSearch} focus={folderFocus} />
              </div>
            </div>
          </aside>
        )}
        {!leftPaneCollapsed && (
          <div className="pane-resize" onPointerDown={startPaneResize('left')} role="separator" aria-orientation="vertical" aria-label="Resize left pane" />
        )}
        <div className={`reading-room-editor-group side-${readingRoomSide}`}>
        {readingRoomOpen && (
          <ReadingRoom
            side={readingRoomSide}
            draftPath={active}
            citeRequest={readingRoomCiteRequest}
            onReaderSelection={noteReaderSelection}
            onOutboxChanged={refreshOutboxCounts}
            onSyncHighlights={syncHighlightsToZotero}
            onSyncHighlightsAutomatically={syncHighlightsOnRoomLifecycle}
            onWriteResult={noteWriteResult}
            outboxRefusal={outboxRefusal?.reason ?? null}
            outboxRefusalCode={outboxRefusal?.code ?? null}
            outboxWaiting={outboxWaiting}
            onCite={citeShelfRow}
            highlightsRequest={readingRoomHighlightsRequest}
            shelfRequest={readingRoomShelfRequest}
            shelfShortcut={formatShortcutKey(resolveChord(READING_ROOM_SHELF_COMMAND.id, shortcutOverrides) ?? '')}
            onClose={() => setReadingRoomVisibility(false)}
            onError={flash}
            onHostChord={runReaderChord}
          />
        )}
        <main className="editor-wrap" onPointerMove={(event) => { if (distractionFree) setDfControlsVisible(!documentFindOpen && event.clientY - event.currentTarget.getBoundingClientRect().top < 64) }}>
          {collectionDir !== null && (
            // A folder browsed as its Collection (Task 23): an opaque overlay OVER the still-mounted
            // editor. Opening a piece clears collectionDir (via the wrapped open/activate) → overlay gone,
            // the editor's buffers untouched underneath.
            <div className="cv-overlay">
              <CollectionView
                key={`${root}:${collectionDir}`}
                dir={collectionDir}
                canAddToFolio={canTurnBack}
                onShowRoomText={setRoomTextPath}
                roomTextLoaded={loadedFile}
                roomEditor={editorRef}
                onRunCommand={id => { if (id === 'export.document') void openExportSheet(undefined, undefined, collectionDir); else actionsHereApi.runCommand(id) }}
                onRename={async name => {
                  if (!collectionDir) throw new Error('Rename the workspace folder in Finder.')
                  if (name === collectionDir.split('/').at(-1)) return
                  const prefix = `${collectionDir}/`
                  const openBefore = tabsRef.current.filter(path => path.startsWith(prefix))
                  const activeBefore = activeRef.current
                  const moved = await withPathsSaved(() => documentsUnder(prefix), async snapshots => {
                    const renamed = await window.writeflex.renameFolder(collectionDir, name)
                    for (const path of snapshots.keys()) afterMainMoved(path, `${renamed.path}${path.slice(collectionDir.length)}`)
                    return renamed.path
                  }, prefix)
                  if (!moved) throw new Error('Could not save the documents. The collection was not renamed.')
                  await refresh()
                  for (const path of openBefore) openTab(`${moved.result}${path.slice(collectionDir.length)}`)
                  if (activeBefore) activateTab(activeBefore.startsWith(prefix) ? `${moved.result}${activeBefore.slice(collectionDir.length)}` : activeBefore)
                  openCollection(moved.result)
                }}
                onBulkAction={async (action, paths, value) => {
                  if (action === 'move') {
                    const current = await window.writeflex.listCollection(collectionDir)
                    if (current.rows.some(row => row.folderPath && paths.includes(row.path))) {
                      throw new Error('Move folder pieces from Files so all their documents move together.')
                    }
                  }
                  if (action === 'folio') {
                    const target = await window.writeflex.readFolioPieces(collectionDir)
                    if (!target) throw new Error('Add documents from the Folio’s own collection folder.')
                    const current = await window.writeflex.listCollection(collectionDir)
                    return addCollectionBatchToFolio(folioRunningOrder, collectionDir, target.pieces, paths, current.rows)
                  }
                  await window.writeflex.collection.beginBatch()
                  const openBefore = new Set(tabsRef.current)
                  const activeBefore = activeRef.current
                  const movedTabs = new Map<string, string>()
                  try {
                    const result = await runCollectionBatch(paths, async path => {
                      if (action === 'move') {
                        const name = path.split('/').at(-1)!
                        // An empty picker value names the workspace root, which rename planning calls null.
                        const result = await withRenameScopeSaved(path, () => window.writeflex.planFileRename(path, name, value || null), async planned => {
                          const moved = await window.writeflex.moveFile(path, planned.newPath, collectionDir)
                          if (moved.file.path !== path) afterMainMoved(path, moved.file.path)
                          return moved
                        })
                        if (!result) throw new Error('Could not save this document. Try again.')
                        if (openBefore.has(path)) movedTabs.set(path, result.result.file.path)
                      } else if (action === 'status') {
                        await setPieceStatusFlushed(owner, window.writeflex.collection.setStatus, collectionDir, path, value)
                      } else {
                        const result = await owner.withFlushed([path], async snapshots => {
                          const snapshot = snapshots.get(path)!
                          const saved = await window.writeflex.collection.addTags(collectionDir, path, value.split(',').map(tag => tag.trim()).filter(Boolean))
                          owner.replaceFromMain(path, saved, { since: snapshot.gen, mode: 'replace' })
                        })
                        if (result.status !== 'acted') throw new Error('Could not save this document. Try again.')
                      }
                    })
                    flash(result.message)
                    return result
                  } finally {
                    await window.writeflex.collection.endBatch()
                    if (action === 'move') {
                      await refresh()
                      for (const path of movedTabs.values()) openTab(path)
                      if (activeBefore) activateTab(movedTabs.get(activeBefore) ?? activeBefore)
                    }
                  }
                }}
                onOpenPiece={open}
                onNewPiece={newPiece}
                onStatus={flash}
                onOpenBoard={openBoard}
                onOpenFolder={openCollection}
                onReturnToFolio={openPlanIn}
                onStartFolio={startNestedFolio}
                onFolderPieceSelected={setSelectedFolderPiece}
                shortcutOverrides={shortcutOverrides}
                openPlanRequested={openPlanRequested}
                onHelpWithReport={helpWithReport}
                onMakeVault={openMakeVault}
                rootIsVault={rootIsVault !== false}
                runningOrder={folioRunningOrder}
                onOpenFolio={openFolioAt}
                renderBoard={renderFolioBoard}
                onBoardShown={setFolioBoardShown}
              />
            </div>
          )}
          {distractionFree && dfControlsVisible && <><button type="button" className="df-exit" onClick={toggleDistractionFree} title="Leave distraction-free (⌥⌘D or Esc)"><Minimize2 className="icon sm" />Esc</button><div className="moderail" role="group" aria-label="Writing mode"><span className="rl">Mode</span><div className="rseg" role="group" aria-label="Writing mode"><button type="button" aria-pressed={writerMode === 'drafting'} title="Drafting (⌥⌘M)" onClick={() => changeWriterMode('drafting')}><SquarePen className="icon sm" />Drafting</button><button type="button" aria-pressed={writerMode === 'reviewing'} title="Reviewing (⌥⌘M)" onClick={() => changeWriterMode('reviewing')}><Glasses className="icon sm" />Reviewing</button></div><span className="rk">⌥⌘M</span></div></>}
          {/* The formatting toolbar sits inside the document pane (ticket 15): above the text, below the tab
              strip, with the read-aloud and review bars stacking under it. The sidebar therefore starts
              directly under the tab strip. Hidden costs ZERO pixels: when the bar is off it is not in the
              tree at all — no lip, no hairline, no reserved height. There is one document pane, so one bar. */}
          {actionBarVisible && <ActionBar groups={actionBarGroups} onConfigure={() => setConfigureActionBarOpen(true)} />}
          {documentFindOpen && <DocumentFind query={documentFindQuery} replacement={documentFindReplacement} replaceOpen={documentFindReplaceOpen} status={documentFindStatus} onQuery={updateDocumentFindQuery} onReplacement={setDocumentFindReplacement} onToggleReplace={() => setDocumentFindReplaceOpen((open) => !open)} onMove={moveDocumentFind} onReplace={replaceDocumentFind} onClose={closeDocumentFind} />}
          {/* The editor stack stays MOUNTED whenever a collection is shown — its per-tab buffer cache
              (the live CM view + unsaved background-tab edits) is the only home for that text, so a swap
              would destroy it. CollectionView is an opaque OVERLAY (below), never a replacement. */}
          {/* Only when nothing is on screen: no open tabs AND not browsing a collection. The empty state
              is z-12 and the collection overlay z-9, so without the collectionDir guard the start screen
              sits on top of a browsed collection and swallows its clicks (browse-with-no-file-open). */}
          {tabs.length === 0 && collectionDir === null && (
            <div className="workspace-empty">
              <WorkspaceEmpty files={files} onNewFile={handleNewTab} onSearchFiles={openSearchTab} onOpenFile={open} />
            </div>
          )}
          {/* A widget step that moved documents, left unfinished by a crash or a quit: named, never acted on by itself. */}
          <WidgetStepLeftoverNotice root={root} onStatus={flash} onChanged={() => { void refresh() }} />
          {historicalView && (
            <div className="historical-banner" role="status">
              <span>
                {historicalView.kind === 'session'
                  ? `Viewing a past session · ${versionTimestamp(historicalView.session.startedAt)} · read-only`
                  : `Viewing “${historicalView.version.name}” · ${historicalView.version.author.name} · ${versionTimestamp(historicalView.version.ts)} · read-only`}
              </span>
              <button className="cbtn" type="button" onClick={exitHistoricalView}>
                <CornerUpLeft className="icon" aria-hidden="true" />
                Return to current
              </button>
              {historicalView.kind === 'version' && (
                <button className="cbtn primary" type="button" onClick={restoreHistoricalVersion}>
                  <RotateCcw className="icon" aria-hidden="true" />
                  Restore this version
                </button>
              )}
            </div>
          )}
          {activeExternalDiskNotice && !historicalView && (
            <div className={`external-change-banner${activeExternalDiskNotice.kind === 'removed' ? ' removed' : ''}`} role="status" aria-live="polite">
              <TriangleAlert className="icon" aria-hidden="true" />
              <span className="external-change-copy">
                <strong>{activeExternalDiskNotice.kind === 'removed' ? 'Removed on disk' : activeExternalDiskNotice.again ? 'Changed on disk again' : 'Changed on disk'}</strong>
                <span>
                  {activeExternalDiskNotice.kind === 'removed'
                    ? 'This tab is still safe in WriteFlex.'
                    : 'Your unsaved writing is untouched.'}
                </span>
              </span>
              <span className="external-change-actions">
                <button className="cbtn" type="button" onClick={() => void reloadExternalDiskVersion()}>
                  <RefreshCw className="icon sm" aria-hidden="true" />
                  Reload
                </button>
                {offersMerge(activeExternalDiskNotice) && (
                  <button className="cbtn" type="button" onClick={openDiskMerge}>
                    <GitMerge className="icon sm" aria-hidden="true" />
                    Merge
                  </button>
                )}
                <button className="cbtn primary" type="button" onClick={() => void keepExternalBuffer()}>
                  {activeExternalDiskNotice.dirty || activeExternalDiskNotice.kind === 'removed' ? 'Keep mine' : 'Keep open'}
                </button>
              </span>
            </div>
          )}
          {/* The mode/format tools float absolutely over the editor top-right; they would overlap — and
              intercept clicks on — the historical banner (read-only, can't apply anyway) OR the
              external-change banner (whose Reload / Keep mine must be clickable), so hide them while
              either is up. */}
          {shownTitleConflict && !activeExternalDiskNotice && (
            <TitleConflictBar
              conflict={shownTitleConflict.conflict}
              onFix={fixOpenDocumentTitle}
              onDismiss={dismissOpenTitleConflict}
              chords={{
                headingToTitle: resolveChord('title.useHeadingAsTitle', shortcutOverrides) ?? '',
                titleToHeading: resolveChord('title.useTitleAsHeading', shortcutOverrides) ?? '',
                dismiss: resolveChord('title.dismissConflictBar', shortcutOverrides) ?? '',
              }}
            />
          )}
          <SkillProvenanceBelt skill={activeSkillForPath(paletteSkills, root, active)} />
          <ReadAloudBar
            state={playerState}
            voiceName={voiceName}
            onPauseResume={pauseResumeReadAloud}
            onStop={stopReadAloud}
            onSkipSentence={skipReadAloudSentence}
            onSkipParagraph={skipReadAloudParagraph}
            onOpenReadAloudSettings={openReadAloudSettings}
            onSetRate={setReadAloudRate}
            readingPositionOutsideViewport={readAloudPositionOutsideViewport}
            onReturnToReading={returnToReading}
          />
          <EditorPane
            citationForText={citationForPastedText}
            onInsertReference={insertReference}
            onInsertWidget={insertWidget}
            ref={editorRef}
            hasDocument={active !== null}
            folioPlace={active !== null && collectionDir === null && !distractionFree ? folioPlace : null}
            onOpenFolioPlan={openFolioPlan}
            onOpenFolioPiece={open}
            hideStrikes={hideStrikes}
            hideInserts={hideInserts}
            writerMode={writerMode}
            viewMode={viewMode}
            focus={focusForEditor}
            lineOverlay={lineOverlay}
            readAloudPosition={playerState.speaking ? playerState.sourceOffset : null}
            readAloudWord={playerState.speaking ? playerState.word : null}
            fixedLine={fixedLine}
            typewriterOn={typewriterOn}
            onFixedLineChange={setFixedLine}
            onFixedLineCommit={commitFixedLine}
            readAloudScrollMode={readAloudScrollMode}
            workspaceRoot={root}
            assetBaseUrl={assetBaseUrl}
            onDocChanged={handleDocChanged}
            onDocumentTransaction={pauseReadAloudAtCaret}
            onDocumentPointerDown={pauseReadAloudAtCaret}
            onManualReadAloudScroll={pauseReadAloudOnManualScroll}
            onReadAloudPositionVisibilityChange={(visible) => setReadAloudPositionOutsideViewport(!visible)}
            onSuggestionResolutionReplay={replaySuggestionResolution}
            onWriterReviewChanged={onWriterReviewChanged}
            onSave={() => void save()}
            onCutToScrap={handleCutToScrap}
            onScratchpadAnchors={(before, after) => scratchpadApi.current?.syncAnchors(before, after)}
            onScrapDropped={handleScrapDropped}
            getScrapExpansions={getScrapExpansions}
            onChangeMarkClick={selectChange}
            onInlineAction={onInlineAction}
            onInlineSelect={selectChange}
            margin={active !== null && collectionDir === null && !distractionFree && !historicalActive && !marginHidden ? {
              changes: dockChanges,
              bulk: { accept: bulkAccept, decline: askDecline, sendBack: openSendBack, sendBackOpen: reviewAskState?.kind === 'send-back', reopenChange },
              picked: pickedCards,
              onPicked: setPickedCards,
              sentBackIds,
              refusedAccepts: refusedReasons,
              waitingAgain,
              controlRef: marginControlRef,
              chords: {
                acceptAll: formatShortcutKey(resolveChord('review.acceptAll', shortcutOverrides) ?? ''),
                declineAll: formatShortcutKey(resolveChord('review.declineAll', shortcutOverrides) ?? ''),
                sendBack: formatShortcutKey(resolveChord('review.sendBack', shortcutOverrides) ?? ''),
              },
              selectedId: selectedChangeId,
              actions: { acceptChange, acceptAndNext: acceptAndNextFocused, rejectChange, holdChange, reviseChange },
              context: {
                sendOriginalToScratchpad: sendChangeOriginalToScratchpad, showInText: showChangeInText, keepTitleInMetadataOnly,
                // A reader's closed edit (0.24 ticket 07): copy their wording as text; Dismiss takes the card away.
                copyText: (text: string) => { void navigator.clipboard?.writeText(text) },
                dismiss: (id: string) => dismissedNotApplied.dismiss([id]),
                // A reader's card (0.24 ticket 08): the reply is kept on the note and sent back through its link by main.
                sendReaderReply: (id: string, text: string) => window.writeflex.replyToReader(id, text),
              },
              onSelect: selectChange,
              onMove: (direction) => { reviewCursorRef.current?.move(direction) },
              documentKey: active,
              others: waitingElsewhere,
              dismissedIds: dismissedNotApplied.ids,
              unanchoredIds: unanchoredSet,
              onAcceptSession: () => void acceptWriterSession(),
              headFilter: marginFilterState,
              onHeadFilter: setMarginFilterState,
              outside: {
                summary: outsideDock.summary,
                arrived: outsideDock.arrived,
                onSourceBulk: (action, source) => { setReviewAskState(null); outsideSourceBulk.open(action, source) },
              },
            } : null}
            onWikilinkActivate={activateWikilink}
            wikilinkPieces={wikilinkCompletionPieces}
            compareToActive={compareToEditable}
            overlayOpenRef={overlayOpenRef}
            onStatus={flash}
            onReadingRoomAreaPrepared={prepareReadingRoomAreaQuotation}
            onReadingRoomAreaInserted={recordReadingRoomAreaQuotation}
          />
          {overlayActive === 'materialise' && materialiseLink && active && (
            <IdeaMaterialise
              dir={activeCollectionDir}
              from={active}
              target={materialiseLink.target}
              gist={materialiseLink.gist}
              onCreated={(path) => void materialised(path)}
              onClose={closeMaterialise}
              onError={flash}
            />
          )}
          {/* Margin suggestion callouts (Task 16) — GATED behind INLINE_REVIEW (usability review): inline
              track-changes is the default review surface now; the popup stays available for a one-line
              revert. Portalled into CM's scroll surface so the card scrolls with the prose. */}
          {!INLINE_REVIEW && (
            <SuggestionCallout
              editorRef={editorRef}
              suggestions={agent.suggestions}
              loadedFile={loadedFile}
              overlayOpenRef={overlayOpenRef}
              onAccept={(s) => void acceptSuggestion(s)}
              onReject={(s) => void rejectSuggestion(s)}
              onRevise={(s, note) => void reviseSuggestion(s, note)}
              viewRequest={viewRequest}
            />
          )}
          <StatusBar
            outboxWaiting={outboxWaiting}
            outboxRejected={outboxRejected}
            outboxNeedsZoteroOpen={outboxRefusal?.code === 'zotero-closed'}
            onSyncHighlights={syncHighlightsToZotero}
            onOpenRejectedHighlights={openHighlights}
            snapshot={snapshot}
            workspaceRoot={root}
            saveState={active
              ? saveFailures.has(active)
                ? { kind: 'failed', path: active }
                : slowSavePaths.has(active)
                  ? { kind: 'pending', path: active }
                  : null
              : null}
            lastSavedAt={active ? lastSavedAt.get(active) ?? null : null}
            typewriterOn={typewriterOn}
            onToggleTypewriter={toggleTypewriter}
            focus={focusMode === '' ? null : { mode: focusMode, leadStyle }}
            lineOverlay={lineOverlay}
            onOpenFocusPicker={() => openOverlay('focus')}
            readAloud={playerState.speaking ? { state: playerState, voiceName } : null}
            goal={goal}
            onOpenGoal={openGoalDialog}
            explicitSession={explicitSession}
            automaticSession={automaticDiarySession}
            onEndExplicitSession={endExplicitSession}
            onDismissCompletedSession={dismissCompletedSession}
            onAdjustExplicitTarget={adjustExplicitSessionTarget}
            sessionMenuRequest={sessionMenuRequest}
            writerMode={writerMode}
            session={session}
            status={status}
            statusAction={statusAction}
            onStatusHover={hovered => { if (hovered) folioNoticeTimer.current?.pause(); else folioNoticeTimer.current?.resume() }}
            collectionName={statusBarCollectionName}
            onMessageAgent={() => focusComposer()}
            disclosureOpenRequest={statusDisclosureRequest}
            activePopover={overlayActive === 'statusDisclosure' || overlayActive === 'statusEvents' ? overlayActive : null}
            onOpenPopover={openOverlay}
            onClosePopover={closeOverlay}
            onRestoreEditorFocus={restoreEditorFocus}
            development={process.env.NODE_ENV === 'development'}
            version={appVersion}
            place={place}
            onPlaceChip={onPlaceChip}
            review={statusReview}
            reviewMenu={reviewCountMenu}
            onReviewMenuPick={runCountMenuAction}
            onReviewClearWho={() => setMarginFilterState((state) => withoutWho(state))}
            onReviewKind={(segment) => setReviewKind(segment, true)}
            onReviewStep={stepReview}
            onReviewNew={showArrivedInMargin}
            reviewElsewhere={reviewModels ? {
              pieces: reviewModels.unfiltered.otherPieces,
              folderName: workspaceName ?? '',
              onOpen: openPieceAt,
              onNextPiece: nextPieceWithItems,
              nextPieceChord: formatShortcutKey(resolveChord('review.nextPieceWaiting', shortcutOverrides) ?? ''),
            } : null}
            reviewCompact={reviewLineCompact(viewportWidth)}
            reviewView={{
              view: marginHidden ? null : effectiveMarginView(preferredMarginView, marginTextRoom),
              narrow: !marginFits(marginTextRoom),
              chord: formatShortcutKey(resolveChord('review.switchMarginView', shortcutOverrides) ?? ''),
            }}
            onReviewView={(view) => runCountMenuAction({ type: 'view', view })}
            onReviewAcceptAll={() => bulkAccept()}
            onReviewPicked={(what) => { if (what === 'accept') bulkAccept(); else if (what === 'decline') askDecline(); else setPickedCards(new Set()) }}
            reviewAcceptKey={formatShortcutKey(resolveChord('review.acceptAll', shortcutOverrides) ?? '')}
            reviewAsk={outsideSourceBulk.ask ?? reviewAsk}
            onReviewModeBack={leaveReviewMode}
            onReviewModeAcceptAll={() => void acceptWriterSession()}
            reviewNotPlaced={reviewModels ? {
              entries: reviewModels.unfiltered.notPlaced,
              onTryAgain: (id) => { void reopenChange(id) },
              onCopy: (text) => { void navigator.clipboard?.writeText(text) },
              onDismiss: dismissedNotApplied.dismiss,
            } : null}
            reviewKeys={selectedChangeId !== null && !reviewLineCompact(viewportWidth) ? { previous: formatShortcutKey(resolveChord('review.previousChange', shortcutOverrides) ?? ''), next: formatShortcutKey(resolveChord('review.nextChange', shortcutOverrides) ?? '') } : null}
          />
          {pieceSourcesRequest && (
            <PieceSourcesPopover
              request={pieceSourcesRequest}
              onClose={() => setPieceSourcesRequest(null)}
              onOpenPiece={open}
            />
          )}
          {skillToast && (
            <SkillCompletionToast
              toast={skillToast}
              skills={paletteSkills}
              onDismiss={dismissSkillToast}
              onReview={reviewSkillChanges}
              onOpenNotes={openSkillNotes}
            />
          )}
          {workbench && tabs.includes(widgetWorkbenchTabId(workbench.documentPath)) && (
            <div className="swb-page-overlay" hidden={!workbenchActive || workbenchDocumentOf(activeTab ?? '') !== workbench.documentPath} data-testid="widget-workbench-page">
              <StandardWidgetWorkbench
                key={`${workbench.documentPath}|${workbench.recipePath ?? ''}`}
                documentPath={workbench.documentPath}
                recipePath={workbench.recipePath}
                caretLine={workbench.caretLine ?? null}
                flushDocument={() => flushWidgetDocument(workbench.documentPath)}
                onStep={setLastWidgetStep}
                runCreate={async (paths, call) => {
                  const hold = moveHoldRef.current
                  if (!hold) return call()
                  // Held like a rename: the documents that may move (and every open one, whose links may be carried
                  // along) are saved first, and their buffers follow the moves before the hold is let go.
                  const wereOpen = paths.filter((path) => tabsRef.current.includes(path))
                  const flushed = await hold.withPathsSaved(() => [...new Set([...paths, ...documentsUnder('')])], async () => {
                    const result = await call()
                    if (result.ok) for (const move of result.moved) hold.afterMainMoved(move.from, move.to)
                    return result
                  })
                  if (!flushed) return null
                  if (flushed.result.ok && flushed.result.moved.length > 0) {
                    await refresh()
                    for (const move of flushed.result.moved) if (wereOpen.includes(move.from) && move.from !== workbench.documentPath) open(move.to)
                  }
                  return flushed.result
                }}
                onCreated={(step) => {
                  setLastWidgetStep(step)
                  if (step.documentPath !== workbench.documentPath) {
                    // The document moved into its own folder: the tab opened for it under its old name goes, and the
                    // document opens where it is now.
                    close(widgetWorkbenchTabId(workbench.documentPath))
                    setWorkbench(null)
                    open(step.documentPath)
                  } else leaveWorkbench(step.documentPath)
                  // The keyboard goes back to the document, where ⌘Z takes the widget back out while the editor's own
                  // history is where it is now: closed here (no later typing joins an earlier edit), its depth kept.
                  window.setTimeout(() => {
                    if (editorRef.current?.path() !== step.documentPath) return
                    const view = editorRef.current?.view()
                    if (!view) return
                    view.dispatch({ annotations: isolateHistory.of('full') })
                    const historyDepth = undoDepth(view.state)
                    setLastWidgetStep((current) => (current?.undoId === step.undoId ? { ...current, historyDepth } : current))
                    view.focus()
                  }, 0)
                  flash('Record browser added. ⌘Z takes it back out.')
                }}
                onBack={() => leaveWorkbench(workbench.documentPath)}
                onStatus={flash}
                onUndo={() => { void undoWidgetStep() }}
                canUndo={lastWidgetStep !== null}
              />
            </div>
          )}
          {boardActive && (
            <div className="board-page-overlay">
              <Board
                dir={boardDir}
                name={collectionName ?? 'Collection'}
                filter={boardFilter}
                onOpenPiece={open}
                onNewPiece={newPiece}
                onStatus={flash}
                onListSources={(path, dir) => setPieceSourcesRequest({ path, dir })}
                setPieceStatus={setBoardPieceStatus}
                seenStatuses={boardSeenStatusesRef.current}
                onFolderPieceSelected={setSelectedFolderPiece}
                onQueryContext={updateQueryInsertionContext}
                onInsertQuery={requestQueryInsertion}
                onOpenPlan={openPlan}
                onOpenCollection={() => openCollection(boardDir)}
              />
            </div>
          )}
          {sharingPageOpen && sharablePiece && (
            <SharingPage
              // One page per Workspace and piece: a change of piece mounts a fresh page, so nothing
              // still on its way for the old piece can be drawn under the new one's heading.
              // A Folio's page is also the open part's (its own piece links, review round 1, finding 3).
              key={`${typeof root === 'string' ? root : ''}\u0000${sharingFolioDir !== null ? `folio:${sharingFolioDir}\u0000` : ''}${sharablePiece}`}
              piecePath={sharablePiece}
              folio={sharingFolioDir !== null ? { dir: sharingFolioDir, name: sharingFolioName ?? '' } : null}
              onShowInFiles={revealSharingPath}
              onOpenPlan={openSharingPlan}
              pieceName={(sharablePiece.split('/').at(-1) ?? sharablePiece).replace(/\.(md|markdown)$/i, '')}
              collectionName={collectionName ?? null}
              onBack={closeSharingPage}
              onFlash={flash}
              onOpenSettings={() => { setSharingPageOpen(false); openSettings('sec-sharing') }}
              onOpenSharesList={openSharesList}
            />
          )}
          {sharesListOpen && typeof root === 'string' && root !== '' && (
            <SharesList
              // One list per Workspace: another Workspace mounts a fresh list (and main binds its links).
              key={root}
              collectionName={workspaceName ?? collectionName ?? 'Collection'}
              onPiecePage={sharablePiece ? () => { setSharesListOpen(false); setSharingPageOpen(true) } : undefined}
              onOpenPiece={openSharedPiece}
              onBack={closeSharesList}
              onFlash={flash}
              onOpenSettings={() => { setSharesListOpen(false); openSettings('sec-sharing') }}
              onSetUp={() => { setSharesListOpen(false); openSharingSetup() }}
            />
          )}
          {sharingSetupOpen && (
            <SharingSetup
              pieceName={active ? (active.split('/').at(-1) ?? active).replace(/\.(md|markdown)$/i, '') : null}
              onBack={closeSharingSetup}
              onFlash={flash}
              onOpenSettings={() => { setSharingSetupOpen(false); openSettings('sec-sharing') }}
            />
          )}
          {railOpen && (
            <Rail
              dir={railDir}
              name={collectionName ?? workspaceName ?? 'Workspace'}
              activePath={railActivePath}
              activeContent={railActivePath ? editorRef.current?.currentDoc() ?? snapshot?.docText ?? null : null}
              onClose={dismissRail}
              onOpenPiece={open}
              onQueryContext={updateQueryInsertionContext}
              onInsertQuery={requestQueryInsertion}
              insertChord={resolveChord('collection.insertAsQuery', shortcutOverrides)}
              focusRequest={railFocusRequest}
            />
          )}
          {queryInsertConfirm && (
            <InsertQueryConfirm
              label={queryInsertConfirm.label}
              source={queryInsertConfirm.source}
              disabledReason={queryInsertionDisabledReason}
              notice={queryInsertConfirm.notice}
              onConfirm={confirmQueryInsertion}
              onClose={dismissQueryInsertConfirm}
            />
          )}
          {compareView && (
            <ComparePane
              versions={versions}
              result={versionCompare}
              loading={versionCompareLoading}
              error={versionCompareError}
              fromId={compareView.fromId}
              toId={compareView.toId}
              onFromChange={setCompareFrom}
              onToChange={setCompareTo}
              onSwap={swapCompareView}
              onBack={closeCompareView}
              getEditableToScrollElement={getEditableCompareToScrollElement}
            />
          )}
        </main>
        </div>
        {!rightPaneCollapsed && (
          <div className="pane-resize" onPointerDown={startPaneResize('right')} role="separator" aria-orientation="vertical" aria-label="Resize right pane" />
        )}
        {!rightPaneCollapsed && (
          <aside className={`chrome-pane right-pane${distractionFree ? ' df-pane' : ''}`} aria-label="Right pane" style={distractionFree ? undefined : { width: rightPaneWidth }}>
            {distractionFree && <div className="df-ph">{rightTab === 'agent' ? <Sparkles className="icon sm" /> : rightTab === 'scratchpad' ? <StickyNote className="icon sm" /> : rightTab === 'agent-notes' ? <Bot className="icon sm" /> : <GitCommitHorizontal className="icon sm" />}<span>{rightTab === 'agent-notes' ? 'Agent notes' : rightTab === 'versions' ? 'Versions' : `${rightTab[0].toUpperCase()}${rightTab.slice(1)}`}</span><span className="gap" /><button type="button" className="x" aria-label="Close panel" title={`Close panel (${formatShortcutKey(resolveChord('view.toggleRightPane', shortcutOverrides) ?? '')})`} onClick={toggleRightPane}><X className="icon sm" /></button></div>}
            {!distractionFree && (
              <RightPaneTabs
                active={rightTab}
                guideShown={guideInRow}
                onSelect={(tab) => (tab === 'agent' ? focusComposer() : tab === 'scratchpad' ? openScratchpad(true) : openRightTab(tab))}
              />
            )}
            <div className="pane-body">
              {guideInRow && (
                <div className={rightTab === 'guide' ? 'pane-view active' : 'pane-view hidden'} role="tabpanel" aria-label="Guide">
                  <GuidePane
                    progress={guideProgress}
                    context={guideContext}
                    overrides={shortcutOverrides}
                    activeFileName={active ? active.split('/').at(-1) ?? null : null}
                    onOpenFolder={() => void openDialog()}
                    onNewFile={() => requestCreate('file')}
                    onOpenExample={() => (guideContext.shown ? void window.writeflex.openExample('collection') : sayExampleGone())}
                    onOpenChapter={(task) => (guideContext.shown ? void window.writeflex.openGuideChapter(task) : sayExampleGone())}
                    onRemoveExample={() => setRemoveExampleOpen(true)}
                    onRestoreExample={restoreExampleOrSay}
                    onChapterFinished={(task) => window.writeflex.guideChapterFinished(task)}
                    onChapterOpened={(task) => window.writeflex.guideChapterOpened(task)}
                    onTopicRead={(id) => window.writeflex.guideTopicRead(id)}
                    onTry={(target) => {
                      if (target.kind !== 'command' && !guideContext.shown) sayExampleGone()
                      else if (target.kind === 'example') void window.writeflex.openExample('collection')
                      else if (target.kind === 'chapter') void window.writeflex.openGuideChapter(target.chapter)
                      else if (target.kind === 'objects') void window.writeflex.openGuideChapter(OBJECTS_LESSON)
                      else actionsHereApi.runCommand(target.id)
                    }}
                    connections={guideConnections}
                    onConnectionAction={(action) => {
                      if (action === 'sign-in') actionsHereApi.runCommand('app.settings')
                      else void window.writeflex.openGuideLink(action === 'get-zotero' ? 'zotero-download' : 'voice-settings')
                    }}
                  />
                </div>
              )}
              <div className={rightTab === 'agent' ? 'pane-view active' : 'pane-view hidden'} role="tabpanel" aria-label="Agent">
                <aside className="agent" aria-label="Agent">
                  <AgentPanel
                    agent={agent}
                    onClose={closeAgentPanel}
                    focusRequest={composerRequest}
                    configurationRequest={agentConfigurationRequest}
                    actionRequest={agentActionRequest}
                    onViewSuggestion={viewSuggestion}
                    onExit={focusEditor}
                    activeFile={active}
                    activeCollectionDir={shownCollectionDir}
                    onOpenDigestPiece={open}
                    onManageSkills={openSkillsManager}
                    onRunFolderSkill={runPaletteSkill}
                    onOpenAccountSettings={() => openSettings('sec-account')}
                    onShowSkillToast={setSkillToast}
                    onOpenReviewing={reviewSkillChanges}
                    onOpenNotes={openSkillNotes}
                    embedded
                    scratchpad={{
                      items: scraps.scraps,
                      request: scratchpadRequest,
                      onToggleDone: scraps.toggleDone,
                      onSetColour: scraps.setColour,
                      onRemove: removeScrap,
                      onInsert: insertScrapAtCursor,
                      onNewScrap: cutSelectionToScrap,
                      sources,
                      onOpenSource: open,
                      onRevealSource: revealSource,
                    }}
                  />
                </aside>
              </div>
              <div className={rightTab === 'scratchpad' ? 'pane-view active' : 'pane-view hidden'} role="tabpanel" aria-label="Scratchpad">
                <div className="sp-rail">
                  <div className="sp-rail-slot" ref={setScratchpadDockSlot} />
                  <SourcesSection sources={sources} onOpen={open} onReveal={revealSource} />
                </div>
              </div>
              <div className={rightTab === 'agent-notes' ? 'pane-view active' : 'pane-view hidden'} role="tabpanel" aria-label="Agent notes">
                <AgentNotes dir={shownCollectionDir ?? ''} activePath={active} workspaceOpen={typeof root === 'string' && root !== ''} resolveProposal={resolveAgentProposal} onRestage={restageAgentNote} onOpenFile={open} onReveal={revealFileInFiles} />
              </div>
              <div className={rightTab === 'versions' ? 'pane-view active' : 'pane-view hidden'} role="tabpanel" aria-label="Versions">
                <div className="change-dock embedded versions-only" aria-label="Versions">
                  <div className="rlist cardlist">
                    <VersionsPane
                      activePath={active}
                      versions={versions}
                      waitingHistory={waitingHistory}
                      attachments={historyAttachments}
                      attachmentUndo={historyAttachmentUndo?.path === active ? historyAttachmentUndo : null}
                      onAttachHistory={(input) => { void (async () => {
                        try {
                          await window.writeflex.attachVersionHistory(input)
                          await reloadVersions()
                        } catch (error) { flash(error instanceof Error ? error.message : 'Could not reattach history.') }
                      })() }}
                      onUndoAttachment={() => { void (async () => {
                        if (!historyAttachmentUndo) return
                        try {
                          await window.writeflex.undoHistoryAttachment(historyAttachmentUndo.id)
                          await reloadVersions()
                        } catch (error) { flash(error instanceof Error ? error.message : 'Could not undo history attachment.') }
                      })() }}
                      allChanges={changesPath === active ? changes : []}
                      pendingCount={summariseRun(dockChanges).total}
                      historicalVersionId={historicalView?.kind === 'version' ? historicalView.version.id : null}
                      onViewSession={viewSession}
                      onViewVersion={viewVersion}
                      onRestoreVersion={restoreVersionFromRow}
                      onOpenCompare={openCompareView}
                      onRenameVersion={renameVersion}
                      onReturnToCurrent={exitHistoricalView}
                      onSaveVersion={requestNameVersion}
                    />
                    <div className="comments-lane" aria-hidden="true" />
                  </div>
                </div>
              </div>
            </div>
          </aside>
        )}
        {archiveSearchOpen && (
          <ArchiveSearchDock
            shortcut={formatShortcutKey(resolveChord('archive.search', shortcutOverrides) ?? '')}
            onInsertQuote={insertArchiveQuote}
            onInsertLink={insertArchiveLink}
            onClose={closeArchiveSearch}
          />
        )}
      </div>
      {(overlayActive === 'files' || overlayActive === 'commands') && (
        <CommandPalette
          mode={overlayActive}
          initialQuery={overlayActive === 'commands' ? paletteSeed : ''}
          files={files}
          checklistProgress={checklistProgress}
          folders={folders}
          commands={paletteCommandList}
          skills={paletteSkills}
          activeFile={active}
          recentIds={recentIds}
          onRun={runPaletteCommand}
          onOpenFile={openFromPalette}
          onRevealFile={revealFileFromPalette}
          onRevealFolder={revealFolderFromPalette}
          onFocusFolder={focusFolderFromPalette}
          onAskAgent={askAgent}
          onRunSkill={runPaletteSkill}
          onOpenSkill={openPaletteSkill}
          onManageSkills={manageSkillsFromPalette}
          onClose={closePalette}
        />
      )}
      {overlayActive === 'widgetPicker' && active && (
        <WidgetPicker
          documentPath={active}
          onChoose={chooseWidget}
          onBack={() => { closeOverlay(); openPalette('commands') }}
        />
      )}
      {overlayActive === 'makeVault' && typeof root === 'string' && (
        <MakeVaultSheet
          rootPath={root}
          onClose={closePalette}
          onMade={(name) => { closePalette(); flash(`${name} is now a vault`) }}
        />
      )}
      {overlayActive === 'researchCapture' && researchCapture && (
        <CaptureResearchSheet
          project={researchCapture.project}
          selection={researchCapture.selection}
          onClose={() => { closeOverlay(); requestAnimationFrame(() => editorRef.current?.view()?.focus()) }}
          onFiled={(file) => {
            closeOverlay()
            flashWithAction(`Captured to ${file}`, { label: 'Reveal', run: () => { void window.writeflex.revealFile(file).catch((error: unknown) => flash(humanReadableError(error, 'Could not reveal the file.'))) } })
          }}
        />
      )}
      {overlayActive === 'folderPiece' && (
        <FolderPieceChooser
          choices={folderPieceChoices}
          onChoose={(choice) => {
            closePalette()
            applyFolderPieceMode(choice)
          }}
          onClose={closePalette}
        />
      )}
      {overlayActive === 'skills' && (
        <SkillsManager
          skills={paletteSkills}
          errors={paletteSkillErrors}
          initialName={skillsManagerInitialName}
          onRegistryChanged={updateSkillsRegistry}
          onClose={closePalette}
        />
      )}
      {/* Settings (Task 17): ⌘, / the sidebar gear / the palette row. closePalette is the shared
          focus-restoring overlay exit — the keyboard lands back on the editor. */}
      {overlayActive === 'settings' && (
        <SettingsWindow
          values={settings.values}
          changelog={settings.changelog}
          voices={speechVoices}
          selectedVoiceURI={selectedVoiceURI}
          initialSection={settingsInitialSection}
          diarySessionRequired={settingsDiarySessionRequired}
          onSet={settings.set}
          onRevert={settings.revert}
          onRefresh={settings.refresh}
          typewriterOn={typewriterOn}
          workspaceName={root.split('/').at(-1) ?? root}
          workspaceRoot={typeof root === 'string' && root !== '' ? root : null}
          onFlash={flash}
          onClose={closePalette}
          onConfigureActionBar={() => setConfigureActionBarOpen(true)}
          getStarted={{ removed: guideContext.removed, canRestore: guideContext.canRestore }}
          onRestoreExample={restoreExample}
          onOpenGuide={() => { closePalette(); openTheGuide() }}
          onOpenSharingSetup={openSharingSetup}
        />
      )}
      {removeExampleOpen && <RemoveExampleConfirm onClose={() => setRemoveExampleOpen(false)} />}
      {diskMerge && overlayActive === 'diskMerge' && (
        <DiskMergeSheet
          key={`${diskMerge.path}:${diskMerge.mine.length}`}
          fileName={diskMerge.path.split('/').at(-1) ?? diskMerge.path}
          merge={diskMerge.merge}
          busy={diskMergeBusy}
          onMerge={(picks) => void runDiskMerge(diskMerge, picks)}
          onCancel={cancelDiskMerge}
        />
      )}
      {/* The configure sheet (ADR-0040 A2). It is rendered AFTER the Settings window because it can
          be opened from inside it — Settings → Action bar — and must sit above it; it is equally
          reachable from the bar's own control and from the palette, and it is the same surface in
          all three cases. Its own state, not overlayActive, for exactly that stacking reason. */}
      {configureActionBarOpen && (
        <ActionBarConfigureSheet
          items={actionBarItems}
          commands={actionBarConfigureCommands}
          onChange={setActionBarItems}
          onReset={resetActionBarItems}
          onClose={() => setConfigureActionBarOpen(false)}
        />
      )}
      {/* The `?` keyboard cheat-sheet (Task 17); T6 threads the overrides so rows show EFFECTIVE chords. */}
      {overlayActive === 'cheatsheet' && <CheatSheet overrides={shortcutOverrides} place={sheetPlace} editorState={editorRef.current?.view()?.state ?? null} onClose={closeCheatSheet} />}
      {overlayActive === 'focus' && (
        <FocusPicker
          mode={focusMode}
          leadStyle={leadStyle}
          lineOverlay={lineOverlay}
          onToggleLineFocus={toggleLineFocus}
          onToggleRuler={toggleRuler}
          onOverlayChange={chooseLineOverlay}
          onSelect={(mode) => {
            chooseFocusMode(mode)
            closePalette()
          }}
          onSelectStyle={(style) => {
            // The mockup's grammar: touching a style means Anchored — apply both, keep the picker up.
            chooseLeadStyle(style)
            if (focusModeRef.current !== 'anchored') chooseFocusMode('anchored')
          }}
          onClose={closePalette}
        />
      )}
      {overlayActive === 'sessionStarter' && (
        <SessionStarter
          tick={settingValues['diary.tick'] !== false}
          onTickChange={(tick) => setSetting('diary.tick', tick, 'Tick')}
          onStart={startExplicitSession}
          onCancel={closePalette}
        />
      )}
      {overlayActive === 'export' && exportSubject && (
        <ExportSheet
          key={exportSubject.openId}
          workspaceRoot={exportSubject.workspaceRoot}
          title={exportSubject.title}
          words={exportSubject.words}
          collection={exportSubject.collection}
          inFolio={exportSubject.inFolio}
          onExport={runExport}
          initialPresetAction={exportSubject.presetAction}
          tocDepthHomes={exportSubject.tocDepthHomes}
          onReveal={() => void window.writeflex.revealExport().catch((error: unknown) => flash(humanReadableError(error, 'Could not show the file.')))}
          onClose={closePalette}
        />
      )}
      {overlayActive === 'goal' && active && (
        <GoalDialog
          target={goal?.target ?? null}
          due={goal?.due ?? null}
          onSave={setWritingGoal}
          onDismissedError={flash}
          onClose={closePalette}
        />
      )}
      {overlayActive === 'capture' && (
        <IdeaCapture
          dir={activeCollectionDir}
          {...(active ? { from: active } : {})}
          onCreated={(path, target) => void captured(path, target)}
          onOpenExisting={openCapturedExisting}
          onClose={restoreCaptureFocus}
          onError={flash}
        />
      )}
      {overlayActive === 'version' && (
        <div className="version-modal-backdrop" role="presentation" onMouseDown={closePalette}>
          <form
            className="version-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="version-modal-title"
            onMouseDown={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault()
              saveRunVersion(versionName)
            }}
          >
            <div className="vm-head">
              <GitCommitHorizontal className="icon" aria-hidden="true" />
              <h2 id="version-modal-title">Save version</h2>
            </div>
            <label>
              <span>Version name</span>
              <input
                autoFocus
                value={versionName}
                onChange={(e) => {
                  setVersionName(e.target.value)
                  if (versionDialogError) setVersionDialogError('')
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    closePalette()
                  }
                }}
                placeholder="Second draft"
              />
            </label>
            {versionDialogError && <p className="vm-error">{versionDialogError}</p>}
            <div className="vm-actions">
              <button className="btn ghost" type="button" onClick={closePalette}>Cancel</button>
              <button className="btn primary" type="submit">
                <Save className="icon" aria-hidden="true" />
                Save version
              </button>
            </div>
          </form>
        </div>
      )}
      <ScratchpadHost
        api={scratchpadApi}
        buffer={scratchpadBufferNow}
        owned={(path) => !owner.isSaved(path) && owner.generationsOf(path) !== undefined}
        navigate={open}
        root={typeof root === 'string' && root !== '' ? root : null}
        activePath={active}
        assetBaseUrl={assetBaseUrl}
        view={() => editorRef.current?.view() ?? null}
        editorPath={() => loadedPath.current ?? active}
        editable={() => !historicalActiveRef.current}
        suspended={workbenchActive}
        liveKey={historicalActive}
        say={(message, action) => flashWithAction(message, action ? { ...action, kind: 'scratchpad' } : undefined)}
        dockSlot={scratchpadDockSlot}
        dockVisible={rightTab === 'scratchpad' && !rightPaneCollapsed}
        railOpen={!rightPaneCollapsed && !distractionFree}
        openDock={openScratchpadDock}
        externalSources={{ talkweaver: settingValues['scratchpad.talkweaver'] === true, slidewell: settingValues['scratchpad.slidewell'] === true }}
        onOpenSettings={() => openSettings('sec-scratchpad')}
      />
    </div>
    </TitleConflictContext.Provider>
    </ActionsHereContext.Provider>
  )
}

/**
 * The Set-writing-goal dialog (Round A T5, ADR-0019): the writer states an intent — a word target
 * and an optional due date — and the goal:set capture path writes `goal:`/`due:` into the active
 * document's frontmatter. Hand-editing the keys stays equally valid (the file is the truth); this
 * dialog is the paved road. Built on the Save-version modal pattern; Clear removes both keys.
 */
function GoalDialog({
  target,
  due,
  onSave,
  onDismissedError,
  onClose,
}: {
  target: number | null
  due: string | null
  onSave: (target: number | null, due: string | null) => Promise<void>
  onDismissedError: (message: string) => void
  onClose: () => void
}): JSX.Element {
  const [targetText, setTargetText] = useState(target === null ? '' : String(target))
  const [dueText, setDueText] = useState(due ?? '')
  // usability review fail (2026-07-24): the submit button used to be `disabled` until the target parsed, and
  // `.btn` had no disabled styling — so on a piece with no goal the dialog opened empty and Set goal
  // was a dead control that looked live. A dialog must ANSWER every click: the button stays live and
  // says what is wrong. Typing clears the complaint.
  const [problem, setProblem] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const trimmedTarget = targetText.trim()
  const parsedTarget = /^\d+$/.test(trimmedTarget) && Number(trimmedTarget) > 0 ? Number(trimmedTarget) : null
  const trimmedDue = dueText.trim()
  const dueOk = trimmedDue === '' || /^\d{4}-\d{2}-\d{2}$/.test(trimmedDue)
  const close = (): void => {
    setProblem(null)
    onClose()
  }
  const save = async (nextTarget: number | null, nextDue: string | null): Promise<void> => {
    if (pendingRef.current) return
    pendingRef.current = true
    setProblem(null)
    setPending(true)
    try {
      await onSave(nextTarget, nextDue)
      if (mounted.current) close()
    } catch (error: unknown) {
      const message = humanReadableError(error, 'Could not update the writing goal.')
      if (mounted.current) setProblem(message)
      else onDismissedError(message)
    } finally {
      pendingRef.current = false
      if (mounted.current) setPending(false)
    }
  }
  const submit = async (): Promise<void> => {
    setProblem(null)
    if (parsedTarget === null) {
      setProblem(
        trimmedTarget === ''
          ? 'Enter a word target — a whole number above zero.'
          : `“${trimmedTarget}” isn’t a word target. Use a whole number above zero, like 5000.`,
      )
      return
    }
    if (!dueOk) {
      setProblem('Use a due date like 2026-08-15, or leave it empty.')
      return
    }
    await save(parsedTarget, trimmedDue === '' ? null : trimmedDue)
  }
  return (
    <div className="version-modal-backdrop" role="presentation" onMouseDown={close}>
      <form
        className="version-modal goal-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="goal-modal-title"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            close()
          }
        }}
      >
        <div className="vm-head">
          <Target className="icon" aria-hidden="true" />
          <h2 id="goal-modal-title">Set writing goal</h2>
        </div>
        <div className="goal-fields">
          <label>
            <span>Word target</span>
            <input
              autoFocus
              inputMode="numeric"
              value={targetText}
              onChange={(e) => {
                setTargetText(e.target.value)
                setProblem(null)
              }}
              placeholder="e.g. 5000"
              aria-label="Word target"
            />
          </label>
          <label>
            <span>Due date (optional)</span>
            <input
              type="date"
              value={dueText}
              onChange={(e) => {
                setDueText(e.target.value)
                setProblem(null)
              }}
              aria-label="Due date"
            />
          </label>
        </div>
        {problem !== null && (
          <p className="goal-problem" role="alert">
            {problem}
          </p>
        )}
        <p className="goal-note">Saved as goal: and due: in the document&rsquo;s frontmatter — the file is the truth.</p>
        <div className="vm-actions goal-actions">
          {target !== null && (
            <button className="btn ghost" type="button" disabled={pending} onClick={() => void save(null, null)}>
              Clear goal
            </button>
          )}
          <span className="grow" aria-hidden="true" />
          <button className="btn ghost" type="button" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" type="submit" disabled={pending}>
            <Target className="icon" aria-hidden="true" />
            Set goal
          </button>
        </div>
      </form>
    </div>
  )
}

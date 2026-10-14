import { AmbientState, type AmbientSnapshot } from './ambient'
import { app, clipboard, dialog, ipcMain, shell } from 'electron'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { existsSync, statSync, watch } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { BridleAuth, createModelService, scriptedSessionFactory, sweepSnapshots, type BridleModelService } from '@bridle/core'
import { registerWriteFlexAuth } from './auth'
import { fetchLinkTitle } from './fetch-title'
import { allStates, stateForSender, setQuitting, trackPendingDisposal, type WindowState } from './state'
import { assertRelativeWorkspacePath, EmptyWriteRefusal, sanitiseFileName, Workspace } from './workspace'
import { toggleAgentNoteTask } from './tasks'
import { parseFrontmatter } from './frontmatter'
import { collectionPattern, collectionStatus, listCollection, createIndexNote, createPiece, unresolvedFolderPieces, setCollectionPieceMode, setCollectionPieceStatus } from './collection'
import { countedCollections, countedSettingKey, diaryCaptureRoot, DIARY_FOLDER_SETTING, invalidateCountedCollectionCache, isCountedCollection, isInsideDiaryRoot, parseCountedSettingKey, persistDiarySession, resumeDiaryDayFile, setCollectionCounted } from './diary'
import { DiaryCaptureTracker, DIARY_IDLE_MS } from './diary-capture'
import { ExplicitSessionRecorder, shouldIdleCloseExplicitSession, type ExplicitSessionOptions } from './explicit-session'
import { endRunningExplicitSessions } from './explicit-session-guard'
import type { ExplicitSessionEndReason, ExplicitSessionState } from '../shared/explicit-session'
import { normaliseCollectionStatus } from '../shared/collection-status'
import { OBJECTS_LESSON } from '../shared/example-files'
import { collectionQueryInvalidation, evaluateCollectionQuery } from './query-engine'
import { collectionLinks, createCollectionStub, previewCollectionStub, type StubInput } from './wikilinks'
import { validateCollectionStubIpcInput } from './collection-stub-ipc'
import { folioPlace, invalidateFolioPlaces } from './folio-place'
import { invalidateFolioOrderFacts } from './folio-order-cache'
import { folioOutline, invalidateFolioOutlineFile, invalidateFolioOutlines } from './folio-outline'
import { resolveTabGroups, tabGroupPaths } from './tab-groups'
import { applyFolderFocus, describeFolderFocus, isFocusableFolder, restoreFolderFocus } from './folder-focus'
import { folioConfirmSummaryFromDraft } from '../shared/folio-confirm-summary'
import { MANIFEST_NAME, assertManifestAbsent, draftManifest, folioPieces, orderEntriesByFolio, readManifest } from './folio'
import { registerPlanIpcHandlers } from './plan-ipc'
import { registerScoutIpcHandlers } from './scout-ipc'
import { registerPlanProposalIpcHandlers } from './plan-proposal-ipc'
import { registerBoardMaterialIpcHandlers } from './board-material-ipc'
import { registerWidgetIpcHandlers } from './widget-ipc'
import { registerWidgetInsertHandlers } from './widget-insert'
import { createWidgetWatches } from './widget-watch'
import { registerWidgetOpenHandler } from './widget-open'
import { readPieceSources } from './piece-sources'
import { BoardMaterialDesk } from './board-material-desk'
import { applyRenameRepair, failedRenameRepairResult, planRenameRepair, type RenameRepairResult } from './rename-repair'
import { ScrapStore } from './scraps'
import { ChangeStore, isChangeJournalPath } from './changes'
import type { ChangeScope, ChangeStatus, EditClass, NewChange } from './changes'
import { humanAuthorForWorkspace, VersionStore } from './versions'
import type { AuthorIdentity, VersionScope } from './versions'
import { scanFolder, scanText } from './jumps'
import {
  attachTurnExecutions,
  buildE2EScriptedTurn,
  isRunAsIsInstruction,
  registryModels,
  runAsIsInstruction,
  WorkspaceAgent,
  type ScriptedStep,
  type ScriptedTurn,
  type ThinkingLevel,
} from './agent'
import { CollectionDigestRevisions } from './digest'
import { capabilityEnabled, removeFrontmatterKeys, setFrontmatterKeys } from './capabilities'
import { GuideProgressStore } from './guide-progress-store'
import { GUIDE_LINKS, isGuideLink } from './guide-connections'
import { TASK_GROUPS, type TaskGroup } from '../renderer/src/commands/command-task-groups'
import { resolveModelDefaults, type ResolvedModelDefaults, type SettingsStore, type SettingValue } from './settings'
import { readVersionContent, restoreVersionContent, type VersionContentRequest } from './version-content'
import { compareVersionRange, type VersionCompareRequest } from './version-compare'
import { saveInitialVersionOnClose, saveNamedVersion } from './save-version'
import { RendererErrorLog, type RendererErrorInput } from './renderer-errors'
import { recordMainProcessDiagnostic } from './shutdown'
import { parseCloseCheckpointPaths, startCloseCheckpoints } from './close-checkpoints'
import { createWorkspaceWatcher } from './workspace-watcher'
import { normaliseRoot } from './root-resolution'
import { classifyOpenPath } from './writeflex-url'
import {
  parseSkillApplyEditInput,
  parseSkillOpenForEditingInput,
  parseSkillProposeEditInput,
  type SkillsRegistry,
} from './skills'
import { ThreadIndex, ThreadManager } from './threads'
import { readSoundFile, soundPackDir } from './sound-pack'
import { clipboardPayload, CLIPBOARD_KIND_LABELS } from './clipboard'
import { modelRegistryDiagnostic } from './model-diagnostics'
import { summariseModelRefresh, type ModelRefreshResult } from '../shared/model-refresh'
import {
  exportBundle,
  exportDocument,
  exportFolderToRemember,
  exportSaveDialogOptions,
  isExportFormat,
  LAST_EXPORT_FOLDER_KEY,
  suggestedName,
  type ExportFormat,
} from './export'
import { exportBundleRequest, exportDocumentRequest } from './export-ipc'
import { startScreenModel, type StartScreenModel } from './start-screen-model'
import type { ExampleRemovalPreview, ExampleRemoveResult, ExampleRestoreResult } from './example-removal'

type SharedDeps = {
  skills: SkillsRegistry
  threadIndex: ThreadIndex
  authFilePath: string
  modelService: BridleModelService
  modelServiceReady: Promise<void>
  auth: BridleAuth
  resolvedDefaults: () => ResolvedModelDefaults
}
let shared: SharedDeps | null = null
function sharedDeps(): SharedDeps {
  if (!shared) throw new Error('IPC has not been registered yet.')
  return shared
}

/** The e2e scripted queue for one thread, created on first touch (stub or boot, whichever first). */
function queueForThread(queues: Map<string, ScriptedTurn[]>, threadId: string): ScriptedTurn[] {
  let queue = queues.get(threadId)
  if (!queue) {
    queue = []
    queues.set(threadId, queue)
  }
  return queue
}

export type OpenPathRouter = {
  openFolder: (state: WindowState, root: string) => Promise<void> // binds or delegates (Task 9 swaps impl)
  openFile: (state: WindowState, filePath: string, line?: number) => Promise<void>
  recents: () => Array<{ root: string; openedAt: number }>
  openRecent: (state: WindowState, root: string, options?: { newWindow?: boolean }) => Promise<void>
  /** Rebuild the app menu after the pinned list changes (File > Open Recent). */
  refreshMenu?: () => void
  /** Roots bound in any open window — admitted for pinning alongside recents. */
  openWorkspaceRoots?: () => string[]
  /** The start screen's two marked entries (ADR-0043). The renderer names a target, never a path. */
  example?: {
    /** The start screen's whole model, computed after the example check has resolved. */
    startScreen: () => Promise<StartScreenModel>
    open: (state: WindowState, target: 'guide' | 'collection') => Promise<void>
    /** Is the example shown, and is this window its own (the Guide's two questions). */
    /** `canRestore`: the example is not shown and may be brought back (it was removed, or never finished). */
    context: (state: WindowState) => Promise<{ shown: boolean; here: boolean; canRestore: boolean; removed: boolean; wantsTab: boolean }>
    /** Ticket 10. The path is the fixed one, held in main; nothing path-like is an argument. `sender` is
     *  main's own number for the asking window. `remove` takes the token its `removalPreview` returned
     *  to that same window (`example-removal.ts`, rule H) and nothing else from the renderer. */
    removalPreview: (sender: number) => Promise<ExampleRemovalPreview>
    remove: (token: unknown, sender: number) => Promise<ExampleRemoveResult>
    restore: () => Promise<ExampleRestoreResult>
    /** Open a chapter's lesson file in the example's window (a chapter name from the ten, validated here). */
    openChapter: (state: WindowState, chapter: TaskGroup | typeof OBJECTS_LESSON) => Promise<void>
  }
}

/** Send to a window's renderer only if the window still exists (windows can close mid-flow). */
function sendSafe(state: WindowState, channel: string, payload: unknown): void {
  // The two pushes that tell the app a collection or a file changed also drop the Folio-place answers.
  if (state.workspace && (channel === 'collection:changed' || channel === 'file:changed-on-disk')) {
    invalidateFolioPlaces(state.workspace.root)
    invalidateFolioOrderFacts(state.workspace.root)
    // Heading entries are checked by size, times and inode; only a named changed file is dropped outright.
    if (channel === 'file:changed-on-disk' && Array.isArray(payload)) {
      for (const changed of payload) if (typeof changed === 'string') invalidateFolioOutlineFile(state.workspace.root, changed)
    }
  }
  if (!state.window.isDestroyed()) state.window.webContents.send(channel, payload)
}

/** The existing Collection change push is the shared invalidation mechanism for all three Query
 * projections. Keep the legacy null event for the current Collection view and add path-addressed
 * Query invalidation for W1c–W1e consumers. */
let collectionRevision = 0
const collectionDigestRevisions = new CollectionDigestRevisions()

function collectionDigestRevision(root: string, dir: string): number {
  return collectionDigestRevisions.get(root, dir)
}

function bumpCollectionDigestRevisions(root: string, paths: string[]): void {
  collectionDigestRevisions.bump(root, paths)
}

function notifyCollectionChanged(state: WindowState, paths: string[] = []): void {
  if (state.workspace) {
    invalidateCountedCollectionCache(state.workspace.root)
    bumpCollectionDigestRevisions(state.workspace.root, paths)
    // Renamed, trashed, restored or created paths: their heading entries go (the stamp covers the rest).
    for (const changed of paths) invalidateFolioOutlineFile(state.workspace.root, changed)
  }
  collectionRevision += 1
  sendSafe(state, 'collection:changed', null)
  sendSafe(state, 'collection:query-changed', collectionQueryInvalidation(paths))
}

function configureWorkspaceWatcher(state: WindowState, enabled: boolean): void {
  state.workspaceWatcher?.dispose()
  state.workspaceWatcher = null
  if (!enabled || !state.workspace || state.window.isDestroyed()) return
  try {
    state.workspaceWatcher = createWorkspaceWatcher(state.workspace, (paths) => {
      // An external edit (another agent in the same folder) must invalidate the Query projections
      // — Board and query objects — as well as the Collection view, then raise the disk-notice banner.
      // The search content cache drops the same paths so the next query re-reads them.
      state.workspace?.searchIndex.invalidate(paths)
      notifyCollectionChanged(state, paths)
      sendSafe(state, 'file:changed-on-disk', paths)
    })
  } catch (error) {
    recordMainProcessDiagnostic('workspace.watcher.failed', {
      windowId: state.window.webContents.id,
      root: state.workspace.root,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

function syncWorkspaceWatcherSetting(settings: SettingsStore): void {
  const enabled = settings.get('workspace.watchExternalChanges') !== false
  for (const state of allStates()) configureWorkspaceWatcher(state, enabled)
}

/** Native confirm for user-invoked Make Folio, showing the drafted manifest before it is written.
 *  Native sheets aren't drivable by Playwright, so under the e2e flag it auto-confirms (env
 *  WRITEFLEX_E2E_FOLIO='cancel' declines) — the same e2e-fence pattern the agent:stub seam uses. */
async function confirmMakeFolio(state: WindowState, dir: string, draft: string): Promise<boolean> {
  if (process.env.WRITEFLEX_E2E === '1') return process.env.WRITEFLEX_E2E_FOLIO !== 'cancel'
  const { response } = await dialog.showMessageBox(state.window, {
    type: 'question',
    message: `Make ${dir || 'this folder'} a Folio?`,
    detail: folioConfirmSummaryFromDraft(draft),
    buttons: ['Create Folio', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })
  return response === 0
}

/**
 * Deliver a queued file-focus to a window at most once. Freshly-created windows can't receive the
 * push until their renderer has mounted and registered `onFocusFile`; those windows carry the
 * pending path and it is flushed when the renderer first pulls `workspace:get`. Already-mounted
 * windows (existing / start-screen reuse) are flushed immediately by the WindowManager. Clearing the
 * field on send makes both paths idempotent.
 */
export function flushPendingFocus(state: WindowState): void {
  if (!state.pendingFocusFile) return
  const relPath = state.pendingFocusFile
  const line = state.pendingFocusLine
  state.pendingFocusFile = null
  state.pendingFocusLine = null
  // A bare path keeps the original payload; a line rides with it only when a link named one.
  sendSafe(state, 'workspace:focus-file', line === null ? relPath : { path: relPath, line })
}

/** Registers every IPC handler and returns cleanup hooks the WindowManager calls on window close. */
export function registerIpc(
  router: OpenPathRouter,
  settings: SettingsStore,
  skills: SkillsRegistry,
  hooks?: { appVersionLabel?: string; onSettingChanged?: (key: string) => void; soundPackDir?: string; guide?: GuideProgressStore; /** The Guide's Zotero row: is Zotero's database on this Mac (index.ts supplies the probe). */ zoteroFound?: () => boolean },
): { evictWindow: (webContentsId: number) => void; dispose: () => void } {
  // bindWorkspace is a separate export the WindowManager calls; these app-wide services reach it
  // through the module seam rather than a widened signature (registerIpc always runs first at boot).
  const authFilePath = resolve(join(app.getPath('userData'), 'auth.json'))
  const rendererErrors = new RendererErrorLog(join(app.getPath('userData'), 'renderer-errors.log'), () => app.getVersion())
  const auth = BridleAuth.file(authFilePath)
  const modelService = createModelService({ auth, appDataDir: app.getPath('userData') })
  let discoveryNotice: string | null = null
  const projectModels = () => {
    const { all, available } = registryModels(modelService)
    return {
      catalogue: all,
      models: process.env.WRITEFLEX_E2E === '1' && process.env.WRITEFLEX_E2E_AVAILABLE_MODELS === '1' ? all : available,
    }
  }
  const unsubscribeModels = modelService.onChange((_models, outcome) => {
    discoveryNotice = outcome.discovery === 'failed'
      ? `Model refresh failed: ${outcome.reason ?? 'provider-error'}.`
      : null
    const payload = {
      ...projectModels(), discovery: outcome.discovery, at: outcome.at,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      modelsChecked: modelService.lastDiscovery(),
    }
    for (const state of allStates()) {
      sendSafe(state, 'agent:models-changed', {
        ...payload, modelNotice: discoveryNotice ?? state.threads?.activeModelNotice() ?? null,
      })
    }
  })
  const modelServiceReady = modelService.refresh().then(() => undefined)
  // Coalesce repeated mouse/keyboard opens while discovery is still in flight.
  let pickerRefresh: Promise<void> | null = null
  ipcMain.handle('agent:models-picker-opened', async (event) => {
    stateForSender(event.sender.id) // only a registered WriteFlex window may trigger discovery
    await modelServiceReady
    if (pickerRefresh) return pickerRefresh
    // Bridle owns the hourly freshness rule; a failed or empty discovery is never fresh, so it retries.
    pickerRefresh = modelService.refreshModels().then(() => undefined).finally(() => { pickerRefresh = null })
    return pickerRefresh
  })
  // "Refresh models" (palette, picker, Settings): a forced refresh that reports the diff. Bridle bounds
  // it (joins a forced check in flight; reuses a successful one for ~10 s), so a renderer cannot
  // turn repeated invokes into a provider-request burst.
  ipcMain.handle('agent:models-refresh', async (event): Promise<ModelRefreshResult> => {
    stateForSender(event.sender.id) // only a registered WriteFlex window may force discovery
    await modelServiceReady
    return summariseModelRefresh(await modelService.refreshModels({ force: true }))
  })
  const resolvedDefaults = () => resolveModelDefaults(settings.modelDefaults())
  shared = {
    skills,
    threadIndex: new ThreadIndex(join(app.getPath('userData'), 'threads', 'index.json')),
    authFilePath,
    modelService,
    modelServiceReady,
    auth,
    resolvedDefaults,
  }
  // Bridle auth migration (0.7a, D1): ONE app-wide broker on the framework's
  // bridle.auth:* channels. Auth state is global — interactive login events
  // broadcast to every window, so a Settings window in window B stays truthful
  // about a sign-in started in window A. Storage stays userData/auth.json so the
  // shared agent-side BridleAuth observes the same credential changes.
  const authRegistration = registerWriteFlexAuth(ipcMain, auth, {
    openExternal: (url) => void shell.openExternal(url),
    emit: (event) => { for (const state of allStates()) sendSafe(state, 'bridle.auth:event', event) }
  })
  const requireWorkspace = (state: WindowState) => {
    if (!state.workspace) throw new Error('No Workspace is open in this window.')
    return state.workspace
  }
  const diaryContext = (state: WindowState, diaryRoot: string) => {
    const diaryWorkspace = allStates().find((candidate) => candidate.workspace?.root === diaryRoot)?.workspace ?? undefined
    return {
      ...(state.workspace ? { sourceWorkspace: state.workspace } : {}),
      ...(diaryWorkspace ? { diaryWorkspace } : {}),
    }
  }
  const persistDiaryRecord = async (state: WindowState, record: ReturnType<DiaryCaptureTracker['close']>) => {
    if (!record || !state.diaryRoot) return
    const result = await persistDiarySession(state.diaryRoot, record, diaryContext(state, state.diaryRoot))
    if (result.error) sendSafe(state, 'diary:error', result.error)
  }
  const publishExplicitSession = (state: WindowState, session: ExplicitSessionState | null) => {
    sendSafe(state, 'diary:session', session)
  }
  const publishSessionMessage = (state: WindowState, message: string) => {
    sendSafe(state, 'diary:session-message', message)
  }
  const publishAutomaticSession = (state: WindowState, active: boolean) => {
    sendSafe(state, 'diary:automatic-session', active)
  }
  const closeDiaryCapture = async (state: WindowState) => {
    if (state.diaryIdleTimer) clearTimeout(state.diaryIdleTimer)
    state.diaryIdleTimer = null
    const record = state.diaryCapture?.close() ?? null
    await persistDiaryRecord(state, record)
    publishAutomaticSession(state, false)
  }
  const closeExplicitSession = async (state: WindowState, reason: ExplicitSessionEndReason, announce = true) => {
    if (state.diaryIdleTimer) clearTimeout(state.diaryIdleTimer)
    state.diaryIdleTimer = null
    if (state.explicitDurationTimer) clearTimeout(state.explicitDurationTimer)
    state.explicitDurationTimer = null
    if (state.explicitCompletionTimer) clearTimeout(state.explicitCompletionTimer)
    state.explicitCompletionTimer = null
    const closed = state.explicitSession?.close(reason) ?? null
    if (!closed) return null
    await persistDiaryRecord(state, closed.record)
    publishExplicitSession(state, closed.session)
    if (reason === 'duration') {
      state.explicitCompletionTimer = setTimeout(() => {
        state.explicitCompletionTimer = null
        state.explicitSession = null
        publishExplicitSession(state, null)
      }, 10_000)
    }
    if (announce && reason === 'manual') publishSessionMessage(state, closed.record ? 'Session ended' : 'Session ended — nothing recorded (no edits).')
    if (announce && reason === 'duration' && !closed.record) publishSessionMessage(state, 'Session ended — nothing recorded (no edits).')
    state.diaryRoot = null
    return closed.session
  }
  const armDiaryIdleClose = (state: WindowState) => {
    if (state.diaryIdleTimer) clearTimeout(state.diaryIdleTimer)
    if (state.explicitSession?.state()?.durationMs !== null && state.explicitSession?.active) {
      state.diaryIdleTimer = null
      return
    }
    const e2eDelay = process.env.WRITEFLEX_E2E === '1' ? Number(process.env.WRITEFLEX_E2E_DIARY_IDLE_MS) : NaN
    const delay = Number.isFinite(e2eDelay) && e2eDelay >= 0 ? e2eDelay : DIARY_IDLE_MS
    state.diaryIdleTimer = setTimeout(() => {
      state.diaryIdleTimer = null
      if (state.explicitSession?.active) void closeExplicitSession(state, 'idle')
      else {
        void persistDiaryRecord(state, state.diaryCapture?.close() ?? null)
        publishAutomaticSession(state, false)
      }
    }, delay)
  }
  let countedListCache: { key: string; value: Promise<Awaited<ReturnType<typeof countedCollections>>[]> } | null = null
  const knownCountedCollections = async () => {
    const roots = new Set([
      ...settings.recents().map((recent) => recent.root),
      ...allStates().flatMap((state) => state.workspace ? [state.workspace.root] : []),
    ])
    const orderedRoots = [...roots].sort()
    const key = `${collectionRevision}:${orderedRoots.join('\0')}`
    if (countedListCache?.key === key) return (await countedListCache.value).flat().sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root) || a.dir.localeCompare(b.dir))
    const lists = Promise.all(orderedRoots.map(async (root) => {
      try { return statSync(root).isDirectory() ? await countedCollections(new Workspace(root)) : [] } catch { return [] }
    }))
    countedListCache = { key, value: lists }
    return (await lists).flat().sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root) || a.dir.localeCompare(b.dir))
  }
  // The agent boots in the BACKGROUND after a Workspace binds (the editor is usable immediately);
  // agent-needing calls await the in-flight creation rather than failing during the boot window.
  const requireAgent = async (state: WindowState) => {
    if (state.agent) return state.agent
    if (state.agentReady) return state.agentReady
    throw new Error('No agent for this window (open a Workspace first).')
  }
  const requireScraps = (state: WindowState) => {
    if (!state.scraps) throw new Error('No Scraps store for this window (open a Workspace first).')
    return state.scraps
  }
  const requireChanges = (state: WindowState) => {
    if (!state.changes) throw new Error('No Change Ledger for this window (open a Workspace first).')
    return state.changes
  }
  const requireVersions = (state: WindowState) => {
    if (!state.versions) throw new Error('No Version journal for this window (open a Workspace first).')
    return state.versions
  }
  const workspaceState = async (state: WindowState) =>
    state.workspace
      ? { root: state.workspace.root, files: await state.workspace.listFiles(), folders: await state.workspace.listFolders(), assetBaseUrl: `wf-asset://${state.assetToken}` }
      : { root: null, files: [], folders: [], assetBaseUrl: null }
  const agentState = async (state: WindowState) => {
    // `catalogue` is the shared full registry (for naming a signed-out selection, M7); `models`
    // stays credential-filtered (the select's options). Present in both branches — Settings can
    // open before the agent boots and must still name the stored model. `thread` names the ACTIVE
    // thread (0.7b B1) so the panel can wear its skill (banner, composer copy — B4).
    const record = state.threads?.activeRecord() ?? null
    const thread = record
      ? { id: record.id, kind: record.kind, ...(record.skillName ? { skillName: record.skillName } : {}), title: record.title }
      : null
    // The active thread's boot failure, as human copy (ThreadSkillGoneError etc) — the renderer's
    // designed notice for a thread that could not start (never a silent chat fallback).
    const threadError = state.threads?.activeBootError() ?? null
    const defaults = resolvedDefaults()
    if (!state.agent) {
      // A thread that CANNOT boot (missing/malformed skill), or that waits for a model choice ("ask
      // first"), still shows its history: the persisted session file is read directly, so the notice
      // arrives with the transcript, not an empty pane.
      const messages = thread && state.threads ? await state.threads.activeIdleTranscript() : []
      await modelServiceReady
      // "Ask first": the chat names the model it wanted and offers the other providers' models.
      const choice = state.threads?.activeModelChoice() ?? null
      return {
        available: false, messages, suggestions: [], pendingApprovals: [], model: choice ? record?.model ?? null : null, ...projectModels(),
        thinking: record?.thinkingLevel ?? 'medium', defaults, thread, threadError,
        modelNotice: discoveryNotice ?? state.threads?.activeModelNotice() ?? null, modelsChecked: modelService.lastDiscovery(),
        modelChoice: choice ? { candidates: choice.candidates } : null,
      }
    }
    const { catalogue, models } = projectModels()
    return {
      available: true,
      messages: attachTurnExecutions(state.agent.messages(), state.threads?.activeTurnRecords() ?? []),
      suggestions: await state.agent.suggestions(),
      pendingApprovals: state.agent.pendingApprovals(),
      model: process.env.WRITEFLEX_E2E === '1' && process.env.WRITEFLEX_E2E_AVAILABLE_MODELS === '1'
        ? record?.model ?? null // the scripted provider cannot adopt real registry models
        : state.agent.currentModel() ?? record?.model ?? null,
      models,
      catalogue,
      thinking: state.agent.thinkingLevel(),
      defaults,
      thread,
      threadError,
      modelNotice: discoveryNotice ?? state.threads?.activeModelNotice() ?? null,
      modelsChecked: modelService.lastDiscovery(),
      modelChoice: null,
    }
  }

  ipcMain.handle('diagnostics:renderer-error', (_event, input: RendererErrorInput) => rendererErrors.capture(input))
  ipcMain.handle('diagnostics:reload-renderer', (event) => { event.sender.reload() })

  ipcMain.handle('workspace:open-dialog', async (event, droppedPath?: string) => {
    const state = stateForSender(event.sender.id)
    if (typeof droppedPath === 'string' && droppedPath.length > 0) {
      const kind = classifyOpenPath(droppedPath)
      if (kind === 'folder') await router.openFolder(state, droppedPath)
      else if (kind === 'file') await router.openFile(state, droppedPath)
      return workspaceState(state)
    }
    const result = await dialog.showOpenDialog(state.window, {
      title: 'Open Folder or Markdown File',
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdx'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const picked = result.filePaths[0]
    if (statSync(picked).isDirectory()) await router.openFolder(state, picked)
    else await router.openFile(state, picked)
    return workspaceState(state)
  })
  ipcMain.handle('assets:pick-image', async (event) => {
    const state = stateForSender(event.sender.id)
    const result = await dialog.showOpenDialog(state.window, {
      title: 'Insert Image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'avif'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const source = result.filePaths[0]!
    return requireWorkspace(state).saveNamedImage(await readFile(source), source.split('/').at(-1) ?? `image${extname(source)}`)
  })
  ipcMain.handle('assets:save-image', async (event, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('Invalid image payload.')
    const candidate = input as { bytes?: unknown; ext?: unknown }
    if (typeof candidate.ext !== 'string') throw new Error('Invalid image extension.')
    if (!(candidate.bytes instanceof Uint8Array) && !(candidate.bytes instanceof ArrayBuffer)) {
      throw new Error('Invalid image bytes.')
    }
    const bytes = candidate.bytes instanceof Uint8Array ? candidate.bytes : new Uint8Array(candidate.bytes)
    if (candidate.ext.toLowerCase() === 'png') {
      const signature = [137, 80, 78, 71, 13, 10, 26, 10]
      if (bytes.length > 16 * 1024 * 1024) throw new Error('The PNG is larger than 16 MiB.')
      if (!signature.every((byte, index) => bytes[index] === byte)) throw new Error('The PNG signature is invalid.')
    }
    return requireWorkspace(stateForSender(event.sender.id)).saveImage(bytes, candidate.ext)
  })
  ipcMain.handle('workspace:get', async (event) => {
    const state = stateForSender(event.sender.id)
    const view = await workspaceState(state)
    // A fresh window's renderer is now mounted and listening; hand it any queued file-open focus.
    flushPendingFocus(state)
    return view
  })
  ipcMain.handle('workspace:recents', () => router.recents())
  ipcMain.handle('workspace:open-recent', async (event, root: string, options?: { newWindow?: boolean }) => {
    await router.openRecent(stateForSender(event.sender.id), root, { newWindow: options?.newWindow === true })
  })

  // ---- Guide and Example collection (start screen marked entries, ADR-0043) ---------------------
  // The start screen asks ONE question and gets its whole model: the marked entries or none, the
  // person's pins as numbered, the recents that are not pins. It compares no paths of its own.
  ipcMain.handle('start:model', async (): Promise<StartScreenModel> =>
    router.example ? router.example.startScreen() : startScreenModel(settings, undefined))
  // ---- The Guide (ticket 07) -------------------------------------------------------------------
  // Progress is one settings key kept by GuideProgressStore; every window's events reach it here, and
  // each change goes out to every window through the ordinary settings:changed push.
  const guide = hooks?.guide ?? new GuideProgressStore(settings)
  guide.onChange = (key) => broadcastSettingChange(key)
  ipcMain.handle('guide:command-ran', (_event, id: unknown) => { guide.commandRan(id) })
  ipcMain.handle('guide:chapter-finished', (_event, chapter: unknown) => { guide.chapterFinished(chapter) })
  ipcMain.handle('guide:chapter-opened', (_event, chapter: unknown) => { guide.chapterOpened(chapter) })
  ipcMain.handle('guide:topic-read', (_event, id: unknown) => { guide.topicRead(id) })
  // What it connects to: Zotero is read here; the account and the voices are read in the renderer. Read-only.
  ipcMain.handle('guide:connections', () => ({ zotero: hooks?.zoteroFound?.() ?? false }))
  ipcMain.handle('guide:open-link', (_event, link: unknown) => {
    if (!isGuideLink(link)) throw new Error('Not a Guide link.')
    if (process.env.WRITEFLEX_E2E !== '1') void shell.openExternal(GUIDE_LINKS[link])
  })
  ipcMain.handle('guide:context', async (event) =>
    router.example ? router.example.context(stateForSender(event.sender.id)) : { shown: false, here: false, canRestore: false, removed: false, wantsTab: false })
  // ---- Removing the example and bringing it back (ticket 10) ------------------------------------
  // The folder is the fixed one; main resolves and checks it. One handler reads one argument:
  // `example:remove` takes the token main itself gave this window with the preview (rule H), and
  // main refuses unless it is that token, from that window, recent, and the folder is as it was shown.
  // Every window is told when the answer to "is the example shown" has changed, so each start
  // screen, Guide tab and Settings page asks again.
  const NO_EXAMPLE = { ok: false as const, message: 'The Example collection is not on this Mac.' }
  const broadcastExampleChange = (change: 'removed' | 'restored'): void => {
    for (const state of allStates()) sendSafe(state, 'example:changed', { change })
  }
  ipcMain.handle('example:removal-preview', async (event): Promise<ExampleRemovalPreview> =>
    router.example ? router.example.removalPreview(event.sender.id) : NO_EXAMPLE)
  ipcMain.handle('example:remove', async (event, token: unknown): Promise<ExampleRemoveResult> => {
    if (!router.example) return NO_EXAMPLE
    const result = await router.example.remove(token, event.sender.id)
    if (result.ok) broadcastExampleChange('removed')
    return result
  })
  ipcMain.handle('example:restore', async (): Promise<ExampleRestoreResult> => {
    if (!router.example) return NO_EXAMPLE
    const result = await router.example.restore()
    if (result.ok) broadcastExampleChange('restored')
    return result
  })
  ipcMain.handle('guide:open-chapter', async (event, chapter: unknown) => {
    if (!router.example) throw new Error('The Example collection is not on this Mac.')
    if (chapter === OBJECTS_LESSON) return void (await router.example.openChapter(stateForSender(event.sender.id), OBJECTS_LESSON)) // a lesson, not a chapter: no progress is kept
    if (typeof chapter !== 'string' || !(TASK_GROUPS as readonly string[]).includes(chapter)) throw new Error('Not a chapter.')
    guide.chapterOpened(chapter)
    await router.example.openChapter(stateForSender(event.sender.id), chapter as TaskGroup)
  })
  ipcMain.handle('example:open', async (event, target: unknown) => {
    if (!router.example) throw new Error('The Example collection is not on this Mac.')
    await router.example.open(stateForSender(event.sender.id), target === 'guide' ? 'guide' : 'collection')
  })

  // ---- Pinned workspaces (start screen left column) --------------------------------------------
  // The renderer names roots only from lists main already gave it, and main re-checks: a root may be
  // pinned only if it is a persisted recent, an already-open Workspace, or this window's own root;
  // every other pinned operation accepts only a root that is currently pinned.
  const pinnedView = (): Array<{ root: string; missing: boolean }> =>
    settings.pinned().map((root) => {
      let missing = true
      try { missing = !statSync(root).isDirectory() } catch { /* absent */ }
      return { root, missing }
    })
  const pinnedRoot = (root: unknown): string => {
    if (typeof root !== 'string' || !settings.isPinned(root)) throw new Error('That folder is not pinned.')
    return root
  }
  ipcMain.handle('workspace:pinned', () => pinnedView())
  ipcMain.handle('workspace:pin', (event, root?: string) => {
    const own = stateForSender(event.sender.id).workspace?.root
    const target = typeof root === 'string' && root !== '' ? root : own
    if (!target) throw new Error('There is no Workspace to pin.')
    const wanted = normaliseRoot(target)
    const stored = settings.recents().find((r) => normaliseRoot(r.root) === wanted)?.root
      ?? (own && normaliseRoot(own) === wanted ? own : undefined)
      ?? router.openWorkspaceRoots?.().find((r) => normaliseRoot(r) === wanted)
    if (!stored) throw new Error('Only a recent or open Workspace can be pinned.')
    settings.pin(stored)
    router.refreshMenu?.()
    return pinnedView()
  })
  ipcMain.handle('workspace:unpin', (event, root?: string) => {
    const target = typeof root === 'string' && root !== '' ? root : stateForSender(event.sender.id).workspace?.root
    settings.unpin(pinnedRoot(target))
    router.refreshMenu?.()
    return pinnedView()
  })
  ipcMain.handle('workspace:pin-move', (_event, root: string, toIndex: number) => {
    if (typeof toIndex !== 'number' || !Number.isFinite(toIndex)) throw new Error('Invalid position.')
    settings.movePinned(pinnedRoot(root), Math.trunc(toIndex))
    router.refreshMenu?.()
    return pinnedView()
  })
  ipcMain.handle('workspace:pin-locate', async (event, root: string) => {
    const old = pinnedRoot(root)
    const state = stateForSender(event.sender.id)
    const result = await dialog.showOpenDialog(state.window, {
      title: 'Locate Folder',
      defaultPath: dirname(old),
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    settings.locatePinned(old, normaliseRoot(result.filePaths[0]))
    router.refreshMenu?.()
    return pinnedView()
  })
  ipcMain.handle('workspace:pin-reveal', (_event, root: string) => {
    shell.showItemInFolder(pinnedRoot(root))
  })
  ipcMain.handle('workspace:checklist-progress', async (event) => {
    const workspace = stateForSender(event.sender.id).workspace
    return workspace ? workspace.checklistProgress() : []
  })
  ipcMain.handle('workspace:search', async (event, query: string, input?: { scope?: unknown }) => {
    const workspace = requireWorkspace(stateForSender(event.sender.id))
    const scope = input?.scope as { folder?: unknown; results?: unknown } | undefined
    if (!scope || typeof scope.folder !== 'string' || scope.folder === '') return workspace.search(query)
    return workspace.search(query, {
      scope: { folder: scope.folder, results: scope.results === 'everywhere' ? 'everywhere' : 'folder' },
    })
  })

  // ---- Folder focus (ticket 03) ------------------------------------------------------------
  // A view state owned by main: the live value on the window's state, persisted on the root's
  // recents entry so it survives a relaunch. A focused folder that has gone reads as no focus and is
  // cleared silently — on relaunch (bindWorkspace) and on any later read.
  ipcMain.handle('focus:get', async (event) => {
    const state = stateForSender(event.sender.id)
    const workspace = requireWorkspace(state)
    if (state.folderFocus !== null && !isFocusableFolder(workspace, state.folderFocus)) {
      state.folderFocus = null
      settings.setFolderFocus(workspace.root, null)
    }
    return describeFolderFocus(workspace, state.folderFocus)
  })
  ipcMain.handle('focus:set', async (event, path: unknown) => {
    const state = stateForSender(event.sender.id)
    const workspace = requireWorkspace(state)
    state.folderFocus = applyFolderFocus(settings, workspace, path)
    return describeFolderFocus(workspace, state.folderFocus)
  })

  // Favourites live in the app-level SettingsStore keyed by workspace root (Task 4), not in the
  // Workspace folder — pins are a per-user convenience, never workspace content the agent can touch.
  ipcMain.handle('workspace:favourites:list', (event) =>
    settings.favourites(requireWorkspace(stateForSender(event.sender.id)).root))
  ipcMain.handle('workspace:favourites:toggle', (event, path: string) => {
    const workspace = requireWorkspace(stateForSender(event.sender.id))
    assertRelativeWorkspacePath(path) // validate the renderer-supplied path at the boundary before it is persisted
    return settings.toggleFavourite(workspace.root, path)
  })

  // ---- Settings (Task 17) ----------------------------------------------------------------------
  // The generic values + changelog live in the app-level SettingsStore (userData/settings.json).
  // These channels did NOT exist before this task (the T12 plan error of record): the renderer's
  // settings window is their first and only consumer. Values are validated primitives at the
  // boundary; effects re-fire renderer-side (theme, editor) or read live main-side (permissions,
  // snapshots), so set/revert here never special-case a key.
  const isSettingValue = (v: unknown): v is SettingValue =>
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
  // A setting is APP-level state, so a change made in one window is true in all of them (the auth
  // broadcast precedent above). ADR-0040's action bar is the first setting whose surface is live in
  // every window at once: without this push, window B would keep painting the bar window A hid
  // until it was reopened. The payload is the stored value AFTER the write — never the request.
  const broadcastSettingChange = (key: string): void => {
    for (const state of allStates()) sendSafe(state, 'settings:changed', { key, value: settings.get(key) })
  }
  ipcMain.handle('settings:get', (_event, key?: string) =>
    typeof key === 'string' ? settings.get(key) : settings.values())
  ipcMain.handle('settings:set', (_event, input: { key: string; value: SettingValue | null; label: string; log?: boolean }) => {
    // `value: null` is the legitimate UNSET payload (⌥⌘0 reset → back to the locked default).
    if (typeof input?.key !== 'string' || typeof input?.label !== 'string' || !(input.value === null || isSettingValue(input.value))) {
      throw new Error('Invalid settings:set payload.')
    }
    settings.set(input.key, input.value, input.label, { log: input.log !== false })
    if (input.key === 'workspace.watchExternalChanges') syncWorkspaceWatcherSetting(settings)
    hooks?.onSettingChanged?.(input.key)
    broadcastSettingChange(input.key)
    return { value: settings.get(input.key), changelog: settings.changelog() }
  })
  ipcMain.handle('settings:changelog', () => settings.changelog())
  ipcMain.handle('settings:revert', async (_event, index: number) => {
    const candidate = typeof index === 'number' ? settings.revertCandidate(index) : null
    const counted = candidate ? parseCountedSettingKey(candidate.key) : null
    if (counted) {
      if (!existsSync(counted.root) || !statSync(counted.root).isDirectory()) {
        throw new Error(`Could not reset ${candidate?.label ?? 'that Counted Collection'} because the Workspace no longer exists: ${counted.root}`)
      }
      const openState = allStates().find((candidate) => candidate.workspace?.root === counted.root)
      const target = openState?.workspace ?? new Workspace(counted.root)
      const saved = await setCollectionCounted(target, counted.dir, candidate?.old === true)
      if (openState) notifyCollectionChanged(openState, [saved.file.path])
      else {
        invalidateCountedCollectionCache(counted.root)
        bumpCollectionDigestRevisions(counted.root, [saved.file.path])
        collectionRevision += 1
      }
    }
    const entry = candidate ? settings.revert(index) : null
    if (entry?.key === 'workspace.watchExternalChanges') syncWorkspaceWatcherSetting(settings)
    if (entry) hooks?.onSettingChanged?.(entry.key)
    if (entry) broadcastSettingChange(entry.key)
    return { entry, changelog: settings.changelog() }
  })
  // Named export presets are structured app settings, deliberately outside both the generic
  // primitive setting values and every Workspace folder.
  ipcMain.handle('export-presets:get', () => settings.exportPresetSettings())
  ipcMain.handle('export-presets:set', (_event, input: unknown) =>
    settings.setExportPresetSettings(input as Parameters<SettingsStore['setExportPresetSettings']>[0]))
  // ---- Diary (0.18 Parcel 4) -----------------------------------------------------------------
  ipcMain.handle('diary:choose-folder', async (event) => {
    const state = stateForSender(event.sender.id)
    const scripted = process.env.WRITEFLEX_E2E === '1' ? process.env.WRITEFLEX_E2E_DIARY_FOLDER : undefined
    if (scripted) return statSync(scripted).isDirectory() ? scripted : null
    const result = await dialog.showOpenDialog(state.window, { title: 'Choose Diary Folder', properties: ['openDirectory', 'createDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
  ipcMain.handle('diary:counted-collections', () => knownCountedCollections())
  ipcMain.handle('diary:is-counted', (event, dir: string) => isCountedCollection(requireWorkspace(stateForSender(event.sender.id)), collectionDir({ dir })))
  ipcMain.handle('diary:set-counted', async (event, input: { root?: string; dir?: string; counted?: boolean }) => {
    if (typeof input?.counted !== 'boolean') throw new Error('Invalid Counted Collection request.')
    const state = stateForSender(event.sender.id)
    const current = requireWorkspace(state)
    const requestedRoot = typeof input.root === 'string' ? normaliseRoot(input.root) : current.root
    const allowedRoots = new Set([...settings.recents().map((recent) => recent.root), ...allStates().flatMap((candidate) => candidate.workspace ? [candidate.workspace.root] : [])])
    if (!allowedRoots.has(requestedRoot) || !existsSync(requestedRoot) || !statSync(requestedRoot).isDirectory()) {
      throw new Error('A Counted Collection can only be changed inside an open or recent Workspace.')
    }
    const workspace = requestedRoot === current.root ? current : new Workspace(requestedRoot)
    const dir = collectionDir(input)
    const old = await isCountedCollection(workspace, dir)
    if (old === input.counted) return knownCountedCollections()
    const saved = await setCollectionCounted(workspace, dir, input.counted)
    collectionRevision += 1
    settings.set(countedSettingKey(workspace.root, dir), input.counted, `Counted Collection: ${dir ? basename(dir) : basename(workspace.root)}`)
    const openState = allStates().find((candidate) => candidate.workspace?.root === workspace.root)
    if (openState) notifyCollectionChanged(openState, [saved.file.path])
    return knownCountedCollections()
  })
  ipcMain.handle('diary:session:get', (event) => stateForSender(event.sender.id).explicitSession?.state() ?? null)
  ipcMain.handle('diary:automatic-session:get', (event) => stateForSender(event.sender.id).diaryCapture?.current() != null)
  ipcMain.handle('diary:session:start', async (event, input: {
    path?: string
    words?: number
    durationMinutes?: number | null
    targetWords?: number | null
    tick?: boolean
  }) => {
    if (typeof input?.path !== 'string' || !Number.isFinite(input.words) || typeof input.tick !== 'boolean') {
      throw new Error('Invalid explicit session request.')
    }
    assertRelativeWorkspacePath(input.path)
    const durationMinutes = input.durationMinutes === null ? null : Number(input.durationMinutes)
    const targetWords = input.targetWords === null ? null : Number(input.targetWords)
    if ((durationMinutes !== null && (!Number.isInteger(durationMinutes) || durationMinutes <= 0 || durationMinutes > 999))
      || (targetWords !== null && (!Number.isInteger(targetWords) || targetWords <= 0 || targetWords > 10_000_000))) {
      throw new Error('Invalid explicit session duration or words target.')
    }
    const state = stateForSender(event.sender.id)
    const workspace = requireWorkspace(state)
    const designated = settings.get(DIARY_FOLDER_SETTING)
    if (typeof designated !== 'string' || designated.trim() === '') return { kind: 'diary-required' as const }
    if (isInsideDiaryRoot(designated, workspace.absolute(input.path))) return { kind: 'diary-root' as const }
    await endRunningExplicitSessions(
      allStates(),
      state,
      async (owner) => { await closeExplicitSession(owner, 'manual', false) },
      publishSessionMessage,
    )
    if (state.explicitCompletionTimer) clearTimeout(state.explicitCompletionTimer)
    state.explicitCompletionTimer = null
    await closeDiaryCapture(state)
    state.diaryCapture?.reset()
    state.diaryRoot = designated
    state.explicitSession = new ExplicitSessionRecorder()
    const options: ExplicitSessionOptions = { durationMinutes, targetWords, tick: input.tick }
    const session = state.explicitSession.start(input.path, Math.trunc(input.words as number), options)
    publishExplicitSession(state, session)
    armDiaryIdleClose(state)
    if (session.durationMs !== null) {
      const e2eMinuteMs = process.env.WRITEFLEX_E2E === '1' ? Number(process.env.WRITEFLEX_E2E_SESSION_MINUTE_MS) : NaN
      const delay = Number.isFinite(e2eMinuteMs) && e2eMinuteMs > 0
        ? durationMinutes! * e2eMinuteMs
        : session.durationMs
      state.explicitDurationTimer = setTimeout(() => {
        state.explicitDurationTimer = null
        void closeExplicitSession(state, 'duration')
      }, delay)
    }
    return { kind: 'started' as const, session }
  })
  ipcMain.handle('diary:session:end', async (event) => closeExplicitSession(stateForSender(event.sender.id), 'manual'))
  ipcMain.handle('diary:session:dismiss', (event) => {
    const state = stateForSender(event.sender.id)
    if (state.explicitSession?.state()?.status !== 'completed') return null
    if (state.explicitCompletionTimer) clearTimeout(state.explicitCompletionTimer)
    state.explicitCompletionTimer = null
    state.explicitSession = null
    publishExplicitSession(state, null)
    return null
  })
  ipcMain.handle('diary:session:adjust-target', (event, target: unknown) => {
    if (!(target === null || (typeof target === 'number' && Number.isInteger(target) && target > 0 && target <= 10_000_000))) {
      throw new Error('Invalid explicit session words target.')
    }
    const state = stateForSender(event.sender.id)
    const session = state.explicitSession?.adjustTarget(target) ?? null
    publishExplicitSession(state, session)
    return session
  })
  ipcMain.handle('diary:prime', async (event, input: { path?: string; words?: number }) => {
    if (typeof input?.path !== 'string' || !Number.isFinite(input.words)) return false
    assertRelativeWorkspacePath(input.path)
    const state = stateForSender(event.sender.id)
    if (state.explicitSession?.active) return true
    const diaryRoot = settings.get(DIARY_FOLDER_SETTING)
    const workspace = requireWorkspace(state)
    const target = await diaryCaptureRoot(workspace, input.path, diaryRoot)
    if (!target) {
      await closeDiaryCapture(state)
      state.diaryCapture?.reset()
      state.diaryRoot = null
      return false
    }
    state.diaryRoot = target
    state.diaryCapture ??= new DiaryCaptureTracker()
    state.diaryCapture.prime(input.path, Math.trunc(input.words as number))
    return true
  })
  ipcMain.handle('diary:activity', async (event, input: { path?: string; words?: number; at?: number; beforeWords?: number }) => {
    if (typeof input?.path !== 'string' || !Number.isFinite(input.words)) return false
    assertRelativeWorkspacePath(input.path)
    const state = stateForSender(event.sender.id)
    const workspace = requireWorkspace(state)
    const diaryRoot = settings.get(DIARY_FOLDER_SETTING)
    if (typeof diaryRoot === 'string' && isInsideDiaryRoot(diaryRoot, workspace.absolute(input.path))) return false
    resumeDiaryDayFile(workspace.absolute(input.path))
    const now = Date.now()
    let at = now
    if (process.env.WRITEFLEX_E2E === '1' && input.at !== undefined) {
      if (!Number.isFinite(input.at) || Math.abs((input.at as number) - now) > 24 * 60 * 60_000) throw new Error('Diary activity time is outside the allowed test window.')
      at = input.at as number
    }
    const beforeWords = Number.isFinite(input.beforeWords) ? Math.trunc(input.beforeWords as number) : Math.trunc(input.words as number)
    const explicit = state.explicitSession
    if (explicit?.active) {
      const session = explicit.state()!
      if (shouldIdleCloseExplicitSession(session, at)) {
        await closeExplicitSession(state, 'idle')
      } else {
        const updated = explicit.observe(input.path, Math.trunc(input.words as number), at, beforeWords)
        for (const record of explicit.takePersistenceRecords()) await persistDiaryRecord(state, record)
        publishExplicitSession(state, updated)
        if (updated.durationMs === null) armDiaryIdleClose(state)
        return true
      }
    }
    const target = await diaryCaptureRoot(workspace, input.path, diaryRoot)
    if (!target) {
      await closeDiaryCapture(state)
      state.diaryCapture?.reset()
      state.diaryRoot = null
      return false
    }
    state.diaryRoot = target
    state.diaryCapture ??= new DiaryCaptureTracker()
    const capture = state.diaryCapture.observe(input.path, Math.trunc(input.words as number), at, beforeWords)
    if (capture.kind === 'checkpoint') await persistDiaryRecord(state, capture.record)
    else if (capture.kind === 'split') {
      await persistDiaryRecord(state, capture.closed)
      await persistDiaryRecord(state, capture.started)
    }
    publishAutomaticSession(state, true)
    armDiaryIdleClose(state)
    return true
  })
  ipcMain.handle('skills:list', () => skills.list())
  ipcMain.handle('skills:get', (_event, name: string) => skills.get(name))

  // Sounds: the renderer cannot fetch() a file: URL off a file: page, so the bundled pack arrives as
  // bytes and is decoded once into cached AudioBuffers. `name` is checked against the shared pack
  // table before anything touches disk — this is not a general file read.
  const soundsDir = hooks?.soundPackDir ?? soundPackDir({
    packaged: app.isPackaged, resourcesPath: process.resourcesPath, entryDir: dirname(fileURLToPath(import.meta.url)),
  })
  ipcMain.handle('sounds:load', (_event, name: unknown) => readSoundFile(soundsDir, name))

  // ---- Copy (Round B T5) -----------------------------------------------------------------------
  // The clipboard is written HERE, not in the renderer, because only the main process can put
  // several flavours on it at once — and one flavour is exactly what fails: Word, Teams and Outlook
  // treat RTF as authoritative and reinterpret an HTML-only paste. The renderer decides the SCOPE
  // (the selection if there is one, otherwise the whole document) and hands over the Markdown; the
  // emitters decide what may leave (never frontmatter, never comments, never a wikilink).
  ipcMain.handle('clipboard:copy', async (event, input: { markdown?: unknown; kind?: unknown; path?: unknown }) => {
    // The document the copy came FROM is what makes its pictures resolvable — a relative `src` means
    // nothing to the application receiving the paste. Reading still goes through the workspace
    // containment check, so a copy can no more read outside the workspace than an export can.
    const workspace = stateForSender(event.sender.id).workspace ?? null
    const path = typeof input?.path === 'string' && input.path !== '' ? input.path : null
    const { kind, payload } = await clipboardPayload(
      input?.markdown,
      input?.kind,
      workspace && path ? { workspace, path } : null,
    )
    clipboard.write(payload)
    return { kind, label: CLIPBOARD_KIND_LABELS[kind], flavours: Object.keys(payload).sort(), characters: payload.text.length }
  })

  // ---- Export (Round B T6/T7, ADR-0029) --------------------------------------------------------
  // The Export sheet asks the two questions it is allowed to ask (what, and in which format) and
  // then hands over to the system save dialog: the sheet never asks the writer to type a path.
  // Cancelling there writes nothing and raises nothing. The file itself is written here, in main,
  // because only main may reach a folder outside the Workspace — which is the point of an export.
  const lastExport = new Map<number, string>()
  const exportFormat = (value: unknown): ExportFormat => {
    if (!isExportFormat(value)) throw new Error(`“${String(value)}” is not an export format. Choose HTML or Word.`)
    return value
  }
  ipcMain.handle('export:choose', async (event, input: { scope?: unknown; path?: unknown; dir?: unknown; format?: unknown }) => {
    const state = stateForSender(event.sender.id)
    const workspace = requireWorkspace(state)
    const format = exportFormat(input?.format)
    const name = input?.scope === 'collection'
      ? await suggestedName(workspace, { scope: 'collection', dir: String(input?.dir ?? ''), format })
      : await suggestedName(workspace, { scope: 'piece', path: String(input?.path ?? ''), format })
    // A native save sheet is not drivable by Playwright, so under the e2e flag the destination comes
    // from the environment — the same fence Make Folio uses. Unset means the writer cancelled.
    if (process.env.WRITEFLEX_E2E === '1') {
      const scripted = process.env.WRITEFLEX_E2E_EXPORT
      return { target: !scripted || scripted === 'cancel' ? null : scripted, name }
    }
    // The sheet opens in the last export folder. The folder only — the name always comes from the piece's own title, so a
    // remembered name would offer to overwrite a different piece's export.
    const result = await dialog.showSaveDialog(state.window, exportSaveDialogOptions({
      name,
      format,
      remembered: settings.get(LAST_EXPORT_FOLDER_KEY),
      documents: app.getPath('documents'),
    }))
    const target = result.canceled || !result.filePath ? null : result.filePath
    const folder = exportFolderToRemember(target)
    // Live-surface state, not a change the writer made in Settings — so no changelog entry.
    if (folder) settings.set(LAST_EXPORT_FOLDER_KEY, folder, 'Last export folder', { log: false })
    return { target, name }
  })
  ipcMain.handle('export:document', async (event, input: unknown) => {
    const workspace = requireWorkspace(stateForSender(event.sender.id))
    const outcome = await exportDocument(workspace, exportDocumentRequest(input))
    lastExport.set(event.sender.id, outcome.target)
    return outcome
  })
  ipcMain.handle('export:bundle', async (event, input: unknown) => {
    const workspace = requireWorkspace(stateForSender(event.sender.id))
    const outcome = await exportBundle(workspace, exportBundleRequest(input))
    lastExport.set(event.sender.id, outcome.target)
    return outcome
  })
  // "Show in Finder" reveals THIS window's last export. The renderer never names the path: an
  // arbitrary absolute path from a renderer is exactly what app:show-item refuses to reveal.
  ipcMain.handle('export:reveal', (event) => {
    const target = lastExport.get(event.sender.id)
    if (!target) throw new Error('There is nothing to show yet — export a file first.')
    shell.showItemInFolder(target)
  })

  // ---- Threads (0.7b B1, ADR-0027) -------------------------------------------------------------
  // The switcher/palette rows drive these; every mutation resolves with the fresh agent state so
  // the renderer can swap its transcript without a second round-trip. Errors carry human copy
  // (ThreadSkillGoneError, "needs an open document") — surfaces render `message` directly.
  const requireThreads = (state: WindowState) => {
    if (!state.threads) throw new Error('No Workspace is open in this window.')
    return state.threads
  }
  ipcMain.handle('skills:propose-edit', async (event, rawInput: unknown) => {
    const input = parseSkillProposeEditInput(rawInput)
    const state = stateForSender(event.sender.id)
    return requireThreads(state).proposeSkillEdit(input.name, input.request)
  })
  ipcMain.handle('skills:apply-edit', (_event, rawInput: unknown) => {
    const input = parseSkillApplyEditInput(rawInput)
    return skills.applyEdit(input.name, input.content)
  })
  ipcMain.handle('skills:open-for-editing', async (event, rawInput: unknown) => {
    const input = parseSkillOpenForEditingInput(rawInput)
    const state = stateForSender(event.sender.id)
    const target = await skills.resolveOpenForEditing(input.name)
    await router.openFile(state, target.source)
    return target
  })
  ipcMain.handle('threads:list', async (event) => {
    const state = stateForSender(event.sender.id)
    const threads = requireThreads(state)
    return { ...(await threads.list()), activeId: threads.activeThreadId() }
  })
  ipcMain.handle('threads:activate', async (event, id: string) => {
    const state = stateForSender(event.sender.id)
    await requireThreads(state).activate(id)
    return agentState(state)
  })
  ipcMain.handle('threads:new-chat', async (event) => {
    const state = stateForSender(event.sender.id)
    await requireThreads(state).newChat()
    return agentState(state)
  })
  ipcMain.handle('threads:open-skill', async (event, skillName: string) => {
    const state = stateForSender(event.sender.id)
    await requireThreads(state).openSkillThread(skillName)
    return agentState(state)
  })
  ipcMain.handle('threads:run-skill', async (event, input: { skillName: string; activeFile: string | null }) => {
    const state = stateForSender(event.sender.id)
    return requireThreads(state).runSkillAsIs(input.skillName, input.activeFile)
  })
  ipcMain.handle('threads:close', async (event, id: string) => {
    const state = stateForSender(event.sender.id)
    await requireThreads(state).close(id)
    // The closed thread's pending approvals died with its agent; drop their owner entries.
    for (const [requestId, threadId] of state.approvalOwners) {
      if (threadId === id) state.approvalOwners.delete(requestId)
    }
    return agentState(state)
  })
  // ---- end Threads ------------------------------------------------------------------------------

  // Jumps scanner (Task 9): bookmarks / `//` comments / tasks across the Workspace. File scope reads
  // one saved file; folder scope aggregates a subtree. The renderer scans the LIVE (possibly dirty)
  // buffer itself for file scope, so this channel is the disk-backed path used by folder scope (Task
  // 10). Any renderer-supplied path is workspace-relative and boundary-validated before it reaches the
  // filesystem — the same guard favourites use.
  ipcMain.handle('jumps:scan', async (event, input: { scope: 'file' | 'folder'; path?: string }) => {
    const workspace = requireWorkspace(stateForSender(event.sender.id))
    if (input.scope === 'file') {
      if (!input.path) return []
      assertRelativeWorkspacePath(input.path)
      const { content } = await workspace.readFile(input.path)
      return scanText(content).map((entry) => ({ ...entry, file: input.path! }))
    }
    // A workspace-ROOT file yields an empty subpath: treat '' as "no subpath" (a whole-workspace scan,
    // the specified root-file behaviour) rather than validating it — assertRelativeWorkspacePath rejects
    // the empty string, so this hardens the guard on the main side too (defensive both ends, Task 10 fix).
    const subpath = input.path === undefined || input.path === '' ? undefined : input.path
    if (subpath !== undefined) assertRelativeWorkspacePath(subpath)
    // Folder scope lists each file's ATX headings alongside its jumps (Task 10), so the outline pane
    // can render a heading-and-jump outline per file. File scope above omits headings — the renderer
    // parses the live buffer's headings itself, keeping unsaved structure visible.
    const entries = await scanFolder(workspace, { headings: true, ...(subpath !== undefined ? { subpath } : {}) })
    // Task 24: when the scoped folder is a Folio, its file-groups follow the manifest's compile order.
    return subpath !== undefined ? orderEntriesByFolio(workspace, subpath, entries) : entries
  })

  // ---- Scraps (Task 20, ADR-0008) --------------------------------------------------------------
  // File-native cuttings: one `## <id> <flags>` section per scrap in scraps/<origin>-SCRAPS.md. All
  // writes go through the app-owned ScrapStore (audit/undo/refresh stay possible), and every mutation
  // pushes `scraps:changed` so the pane re-lists and the file tree refreshes (scraps/ appears on the
  // first cut). The renderer supplies `origin` from the active file's workspace-relative path; the
  // store reduces it to a basename stem, so no path escapes the Workspace.
  ipcMain.handle('scraps:list', async (event, scope?: { origin?: string }) =>
    requireScraps(stateForSender(event.sender.id)).list(scope))
  ipcMain.handle('scraps:add', async (event, input: { origin: string; text: string }) => {
    const state = stateForSender(event.sender.id)
    const scrap = await requireScraps(state).add(input.origin, input.text)
    sendSafe(state, 'scraps:changed', null)
    return scrap
  })
  ipcMain.handle('scraps:toggle-done', async (event, id: string) => {
    const state = stateForSender(event.sender.id)
    await requireScraps(state).toggleDone(id)
    sendSafe(state, 'scraps:changed', null)
  })
  ipcMain.handle('scraps:set-colour', async (event, input: { id: string; colour: string | null }) => {
    const state = stateForSender(event.sender.id)
    await requireScraps(state).setColour(input.id, input.colour)
    sendSafe(state, 'scraps:changed', null)
  })
  ipcMain.handle('scraps:remove', async (event, id: string) => {
    const state = stateForSender(event.sender.id)
    const removed = await requireScraps(state).remove(id)
    sendSafe(state, 'scraps:changed', null)
    return removed
  })

  // ---- Change Ledger (Task 2, ADR-0010/0011) ---------------------------------------------------
  // The review-and-learn spine: agent suggestions, the writer's own edits, and reviewer changes, all
  // journaled to `.writeflex/changes.jsonl` via the app-owned ChangeStore (through the Workspace guard,
  // like ScrapStore — the renderer never touches the fs). Every mutation pushes `changes:changed` so
  // the dock re-lists. `add` is here for the writer-edit capture (Task 6); agent ingest (Task 3) writes
  // through the same store in-process, so it also lands as a pending Change the dock can review.
  ipcMain.handle('changes:list', async (event, scope?: ChangeScope) =>
    requireChanges(stateForSender(event.sender.id)).list(scope))
  ipcMain.handle('changes:add', async (event, input: NewChange) => {
    const state = stateForSender(event.sender.id)
    const workspace = requireWorkspace(state)
    const change = await requireChanges(state).add({
      ...input,
      ...(input.provenance === 'writer' && input.author === undefined
        ? { author: await humanAuthorForWorkspace(workspace.root) }
        : {}),
    })
    sendSafe(state, 'changes:changed', null)
    return change
  })
  ipcMain.handle('changes:update-writer', async (event, input: { id: string; input: NewChange }) => {
    const state = stateForSender(event.sender.id)
    const change = await requireChanges(state).updateWriterChange(input.id, input.input)
    sendSafe(state, 'changes:changed', null)
    return change
  })
  ipcMain.handle('changes:set-status', async (event, input: { id: string; status: ChangeStatus }) => {
    const state = stateForSender(event.sender.id)
    const change = await requireChanges(state).setStatus(input.id, input.status)
    if (input.status === 'accepted' || input.status === 'rejected') {
      state.threads?.clearRestagedOrigin(input.id)
      state.agent?.clearRestagedOrigin(input.id)
    }
    sendSafe(state, 'changes:changed', null)
    return change
  })
  ipcMain.handle('changes:classify', async (event, input: { id: string; editClass: EditClass }) => {
    const state = stateForSender(event.sender.id)
    const change = await requireChanges(state).setEditClass(input.id, input.editClass)
    sendSafe(state, 'changes:changed', null)
    return change
  })
  // Accept/Reject from the docked Changes surface (Task 4): the agent routes it through the live staged
  // suggestion when there is one (same disk-writing pipeline as the callout), else resolves from the ledger.
  ipcMain.handle('changes:resolve', async (event, input: { id: string; action: 'accept' | 'reject' }) => {
    const state = stateForSender(event.sender.id)
    const result = await (await requireAgent(state)).resolveChange(input.id, input.action)
    if (!result.applied || input.action !== 'accept') return result
    const change = await requireChanges(state).get(input.id)
    if (!change) return result
    try {
      const file = await requireWorkspace(state).readFile(change.path)
      notifyCollectionChanged(state, [change.path])
      return { ...result, file }
    } catch {
      return result
    }
  })
  ipcMain.handle('changes:save-version', async (event, input: { path: string; changeIds: string[]; name: string; note?: string }) => {
    const state = stateForSender(event.sender.id)
    const workspace = requireWorkspace(state)
    assertRelativeWorkspacePath(input.path)
    const path = input.path
    const result = await saveNamedVersion({
      path,
      name: input.name,
      changeIds: input.changeIds,
      changes: requireChanges(state),
      versions: requireVersions(state),
      agent: await requireAgent(state),
      author: await humanAuthorForWorkspace(workspace.root),
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    })
    sendSafe(state, 'changes:changed', null)
    sendSafe(state, 'versions:changed', null)
    return result
  })
  ipcMain.handle('versions:list', async (event, scope?: VersionScope) =>
    requireVersions(stateForSender(event.sender.id)).list(scope))
  ipcMain.handle('versions:rename', async (event, input: { id: string; name: string }) => {
    const state = stateForSender(event.sender.id)
    const workspace = requireWorkspace(state)
    const version = await requireVersions(state).rename(input.id, input.name, {
      author: await humanAuthorForWorkspace(workspace.root),
    })
    sendSafe(state, 'versions:changed', null)
    return version
  })
  ipcMain.handle('versions:content', async (event, input: VersionContentRequest) => {
    const state = stateForSender(event.sender.id)
    return readVersionContent(requireVersions(state), await requireAgent(state), input)
  })
  ipcMain.handle('versions:compare', async (event, input: VersionCompareRequest) => {
    const state = stateForSender(event.sender.id)
    const workspace = requireWorkspace(state)
    assertRelativeWorkspacePath(input.path)
    return compareVersionRange(
      requireVersions(state),
      requireChanges(state),
      await requireAgent(state),
      workspace,
      input,
      await humanAuthorForWorkspace(workspace.root),
    )
  })
  ipcMain.handle('versions:restore', async (event, input: VersionContentRequest & { currentContent?: string }) => {
    const state = stateForSender(event.sender.id)
    const agent = await requireAgent(state)
    const restored = await restoreVersionContent(requireVersions(state), agent, requireWorkspace(state), input)
    if (restored?.file.path) notifyCollectionChanged(state, [restored.file.path])
    return restored
  })

  // ---- Sources (Task 21, PRD S30) --------------------------------------------------------------
  // Reference material under research/ (recursively), surfaced beside Scraps. Unlike files.list this
  // includes PDFs/images, so it reads the dir directly under the Workspace guard (listSources). md
  // sources open in a tab (renderer); every other kind reveals in the OS file manager via
  // app:show-item. Folio-manifest `source` dirs join the list in Task 24 (Workspace.SOURCE_DIRS seam).
  ipcMain.handle('sources:list', async (event) =>
    requireWorkspace(stateForSender(event.sender.id)).listSources())
  // Reveal a Workspace file in the OS file manager (salvaged v3 channel, re-added in Task 21).
  // Relative paths stay behind Workspace.absolute; B5's one absolute-path case is admitted only
  // when SkillsRegistry confirms the exact path is a load error currently visible in the manager.
  ipcMain.handle('app:show-item', async (event, path: string) => {
    const absolute = isAbsolute(path)
      ? await skills.resolveRevealErrorSource(path)
      : requireWorkspace(stateForSender(event.sender.id)).absolute(path)
    shell.showItemInFolder(absolute)
  })

  ipcMain.handle('file:read', async (event, path: string) =>
    requireWorkspace(stateForSender(event.sender.id)).readFile(path))

  // ---- Collections (Task 23, ADR-0008) ---------------------------------------------------------
  // A folder is a Collection: its pieces as a sortable metadata table under an Index-Note cover. `dir`
  // is a workspace-relative directory ('' = the workspace root); a non-empty dir is boundary-validated
  // (the empty root subpath is allowed, mirroring jumps:scan's whole-workspace case). create-index and
  // new-piece are the ONLY write channels here — both user-initiated — and each pushes a tree refresh
  // (collection:changed) so the new file surfaces in the sidebar the moment it lands.
  const collectionDir = (input: { dir?: string } | undefined): string => {
    const dir = input?.dir ?? ''
    if (dir !== '') assertRelativeWorkspacePath(dir)
    return dir
  }
  ipcMain.handle('collection:list', async (event, input: { dir?: string }) =>
    listCollection(requireWorkspace(stateForSender(event.sender.id)), collectionDir(input)))
  ipcMain.handle('collection:status', async (event, input: { dir?: string }) =>
    collectionStatus(requireWorkspace(stateForSender(event.sender.id)), collectionDir(input)))
  ipcMain.handle('collection:pattern', async (event, input: { dir?: string }) =>
    collectionPattern(requireWorkspace(stateForSender(event.sender.id)), collectionDir(input)))
  ipcMain.handle('collection:query', async (event, input: { dir?: string; source?: string }) => {
    if (typeof input?.source !== 'string') throw new Error('Invalid collection:query source.')
    return evaluateCollectionQuery(requireWorkspace(stateForSender(event.sender.id)), collectionDir(input), input.source)
  })
  ipcMain.handle('collection:unresolved-folder-pieces', async (event, input: { dir?: string }) =>
    unresolvedFolderPieces(requireWorkspace(stateForSender(event.sender.id)), collectionDir(input)))
  ipcMain.handle('collection:set-status', async (event, input: { dir?: string; path?: string; status?: string }) => {
    if (typeof input?.path !== 'string') throw new Error('Invalid Collection Piece path.')
    assertRelativeWorkspacePath(input.path)
    const state = stateForSender(event.sender.id)
    const workspace = requireWorkspace(state)
    const dir = collectionDir(input)
    const status = normaliseCollectionStatus(input.status)
    const saved = await setCollectionPieceStatus(workspace, dir, input.path, status)
    notifyCollectionChanged(state, [saved.file.path])
    return saved
  })
  ipcMain.handle('collection:set-piece-mode', async (event, input: { dir?: string; folderPath?: string; mode?: string }) => {
    if (typeof input?.folderPath !== 'string') throw new Error('Invalid Folder Piece path.')
    assertRelativeWorkspacePath(input.folderPath)
    if (input.mode !== 'one' && input.mode !== 'many') throw new Error('Invalid Folder Piece mode.')
    const state = stateForSender(event.sender.id)
    const saved = await setCollectionPieceMode(requireWorkspace(state), collectionDir(input), input.folderPath, input.mode)
    notifyCollectionChanged(state, [saved.file.path])
    return saved
  })
  ipcMain.handle('collection:links', async (event, input: { dir?: string; from?: string; content?: string }) => {
    if ((input.from === undefined) !== (input.content === undefined)) throw new Error('Collection link override needs both from and content.')
    if (input.from !== undefined) assertRelativeWorkspacePath(input.from)
    return collectionLinks(
      requireWorkspace(stateForSender(event.sender.id)),
      collectionDir(input),
      input.from === undefined ? undefined : { from: input.from, content: input.content as string },
    )
  })
  ipcMain.handle('collection:targets', (event) => allStates().flatMap((candidate) => candidate.workspace
    ? [{ windowId: candidate.window.webContents.id, name: candidate.workspace.root.split('/').at(-1) ?? candidate.workspace.root, current: candidate.window.webContents.id === event.sender.id }]
    : []))
  ipcMain.handle('collection:focus-piece', async (_event, input: { windowId?: number; path?: string }) => {
    if (typeof input?.windowId !== 'number' || typeof input?.path !== 'string') throw new Error('Invalid Collection Piece focus request.')
    assertRelativeWorkspacePath(input.path)
    const target = allStates().find((candidate) => candidate.window.webContents.id === input.windowId)
    if (!target?.workspace || !(await target.workspace.listFiles()).some((file) => file.path === input.path)) throw new Error('The selected Piece is no longer available.')
    target.pendingFocusFile = input.path
    target.pendingFocusLine = null
    flushPendingFocus(target)
    target.window.focus()
  })
  const stubTarget = (event: Electron.IpcMainInvokeEvent, input: StubInput & { windowId?: number }): { state: WindowState; stub: StubInput } => {
    validateCollectionStubIpcInput(input)
    const state = input.windowId === undefined
      ? stateForSender(event.sender.id)
      : allStates().find((candidate) => candidate.window.webContents.id === input.windowId)
    if (!state?.workspace) throw new Error('The selected Collection window is no longer open.')
    const dir = collectionDir({ dir: input.dir })
    if (input.from) assertRelativeWorkspacePath(input.from)
    if (input.path) assertRelativeWorkspacePath(input.path)
    return {
      state,
      stub: {
        dir,
        title: input.title,
        gist: input.gist,
        ...(input.path ? { path: input.path } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.bodyLead !== undefined ? { bodyLead: input.bodyLead } : {}),
        ...(input.titleInFrontmatter !== undefined ? { titleInFrontmatter: input.titleInFrontmatter } : {}),
        ...(input.suppressBacklink !== undefined ? { suppressBacklink: input.suppressBacklink } : {}),
        ...(input.from ? { from: input.from } : {}),
        ...(input.createAnyway ? { createAnyway: true } : {}),
      },
    }
  }
  ipcMain.handle('collection:stub-preview', async (event, input: StubInput & { windowId?: number }) => {
    const { state, stub } = stubTarget(event, input)
    return previewCollectionStub(requireWorkspace(state), stub)
  })
  ipcMain.handle('collection:stub-create', async (event, input: StubInput & { windowId?: number }) => {
    const { state, stub } = stubTarget(event, input)
    const result = await createCollectionStub(requireWorkspace(state), stub)
    if (result.created) {
      notifyCollectionChanged(state, [result.path])
      if (state.agentReady) await (await requireAgent(state)).checkpointFile(result.path)
    }
    return result
  })
  ipcMain.handle('collection:create-index', async (event, input: { dir?: string }) => {
    const state = stateForSender(event.sender.id)
    const path = await createIndexNote(requireWorkspace(state), collectionDir(input))
    notifyCollectionChanged(state, [path]) // the new Index Note appears in the tree and projections refresh
    return path
  })
  ipcMain.handle('collection:new-piece', async (event, input: { dir?: string }) => {
    const state = stateForSender(event.sender.id)
    const path = await createPiece(requireWorkspace(state), collectionDir(input))
    notifyCollectionChanged(state, [path]) // the new piece appears in the tree and projections refresh
    return path
  })

  // ---- Folio (Task 24, ADR-0008) ---------------------------------------------------------------
  // A Folio is a folder declared to compile to one output via a `_report-structure.json` manifest.
  // folio:read parses it (null when the folder is a plain Collection). folio:create is the USER's
  // "Make Folio" — it drafts a manifest from the folder's numbered parts and, after a native confirm
  // showing that draft, writes it (only when absent). The AGENT's equivalent is folio.create_manifest,
  // staged/allowed through the capability pipeline; this direct path is the writer's own act.
  ipcMain.handle('folio:read', async (event, input: { dir?: string }) =>
    readManifest(requireWorkspace(stateForSender(event.sender.id)), collectionDir(input)))
  // The same manifest, resolved: the pieces an export will write, in order, and the listed entries it
  // will leave out (file not found, or outside the Folio's folder). Null for a folder with no manifest.
  ipcMain.handle('folio:pieces', async (event, input: { dir?: string }) =>
    folioPieces(requireWorkspace(stateForSender(event.sender.id)), collectionDir(input)))
  // Which Folio a file belongs to and where it sits in it (line above the text, title-bar button).
  ipcMain.handle('folio:place', async (event, input: { path?: unknown }) =>
    typeof input?.path === 'string' ? folioPlace(requireWorkspace(stateForSender(event.sender.id)), input.path) : null)
  // The Outline's Folio part: the same Folio, with each piece and the folder's other files and their headings.
  ipcMain.handle('folio:outline', async (event, input: { path?: unknown }) =>
    typeof input?.path === 'string' ? folioOutline(requireWorkspace(stateForSender(event.sender.id)), input.path) : null)
  ipcMain.handle('folio:create', async (event, input: { dir?: string }): Promise<string | null> => {
    const state = stateForSender(event.sender.id)
    const ws = requireWorkspace(state)
    const dir = collectionDir(input)
    await assertManifestAbsent(ws, dir)
    const draft = await draftManifest(ws, dir)
    const confirmed = await confirmMakeFolio(state, dir, draft)
    if (!confirmed) return null
    // Re-check after the (blocking) confirm: the writer may have sat on the dialog while the agent
    // declared the same folder a Folio. Never clobber a manifest that appeared in the meantime.
    await assertManifestAbsent(ws, dir)
    const saved = await ws.saveFile(dir ? `${dir}/${MANIFEST_NAME}` : MANIFEST_NAME, draft)
    notifyCollectionChanged(state, [saved.file.path]) // the Folio badge + ordering pick it up
    return saved.file.path
  })

  // ---- Tab groups (direction D) ------------------------------------------------------------
  // Read-only: which group (nearest Folio → nearest Index Note folder → own folder) each open tab
  // belongs to. The renderer derives the strip from it; nothing is stored for tabs.
  ipcMain.handle('tabs:groups', async (event, input: { paths?: unknown }) =>
    resolveTabGroups(requireWorkspace(stateForSender(event.sender.id)), tabGroupPaths(input)))

  // ---- Archive search (WF-4B) ------------------------------------------------------------
  // The scout CLI adapter and the in-draft writeflex:// link opener; see scout-ipc.ts.
  registerScoutIpcHandlers(ipcMain, {
    stateForSender,
    openFile: (state, filePath, line) => router.openFile(state, filePath, line),
  })

  // ---- Plan -------------------------------------------------------------------------------
  // Plan handlers live behind a narrow executable seam so their write ordering, validation,
  // checkpoint and invalidation behaviour can be exercised without booting all Electron IPC.
  registerPlanIpcHandlers(ipcMain, {
    stateForSender,
    requireWorkspace,
    checkpointFile: async (state, path) => {
      if (!state.agentReady) return
      await (await requireAgent(state)).checkpointFile(path)
    },
    notifyCollectionChanged,
    notifyChangedOnDisk: (state, paths) => sendSafe(state, 'file:changed-on-disk', paths),
  })

  // Widgets (interactive-widgets-in-documents, ticket 02): the HTML of an embed line's file, resolved
  // inside this window's workspace and read here; the renderer runs it in a sealed frame.
  const widgetWatches = createWidgetWatches({
    watchFolder: (folder, listener) => watch(folder, { recursive: false, encoding: 'utf8' }, (_event, name) => { if (name) listener(String(name)) }),
    notify: (windowId, paths) => {
      const state = allStates().find((candidate) => !candidate.window.isDestroyed() && candidate.window.webContents.id === windowId)
      if (state) sendSafe(state, 'file:changed-on-disk', paths)
    },
  })
  registerWidgetIpcHandlers(ipcMain, {
    workspaceRootFor: (event) => requireWorkspace(stateForSender(event.sender.id)).root,
    watches: widgetWatches,
  })
  registerWidgetInsertHandlers(ipcMain, { workspaceRootFor: (event) => requireWorkspace(stateForSender(event.sender.id)).root })
  registerWidgetOpenHandler(ipcMain, {
    workspaceRootFor: (event) => requireWorkspace(stateForSender(event.sender.id)).root,
    // Hidden e2e must not bring a browser to the foreground (same rule as windows.ts).
    openExternal: (url) => { if (process.env.WRITEFLEX_E2E !== '1') void shell.openExternal(url) },
  })

  // Running-order proposals (ticket 09): the Agent pane's proposal card.
  registerPlanProposalIpcHandlers(ipcMain, {
    stateForSender,
    requireAgent,
    notifyCollectionChanged,
    notifyChangedOnDisk: (state, paths) => sendSafe(state, 'file:changed-on-disk', paths),
  })

  // The Board's material steps (scraps tickets 02 and 03): offcut to idea, drawer scrap to the end of
  // its piece, a source attached to a piece, and their undo. One desk per agent instance: its restore points live in that agent's
  // snapshot journal, beside the agent's own, so one ⌘⇧Z restores both files the step wrote.
  const boardDesks = new WeakMap<object, BoardMaterialDesk>()
  registerBoardMaterialIpcHandlers(ipcMain, {
    stateForSender,
    deskFor: async (state) => {
      const agent = await requireAgent(state)
      let desk = boardDesks.get(agent)
      if (!desk) {
        desk = new BoardMaterialDesk(requireWorkspace(state), agent.hostSnapshots(), requireScraps(state))
        boardDesks.set(agent, desk)
      }
      return desk
    },
    listSources: (state, input) => readPieceSources(requireWorkspace(state), input),
    publish: (state, paths) => {
      notifyCollectionChanged(state, paths)
      sendSafe(state, 'file:changed-on-disk', paths)
      sendSafe(state, 'scraps:changed', null)
    },
  })

  // ---- Frontmatter organ (Task 22, ADR-0008) ---------------------------------------------------
  // READ-ONLY: parse a Workspace file's leading YAML frontmatter into a typed shape (null when the
  // file is bare — frontmatter is never auto-inserted). The renderer-supplied path is boundary +
  // symlink validated by Workspace.readFile before any disk access. There is deliberately no write
  // channel here — agent-staged normalisation arrives in T24 through the suggestion pipeline.
  ipcMain.handle('frontmatter:read', async (event, path: string) => {
    const { content } = await requireWorkspace(stateForSender(event.sender.id)).readFile(path)
    return parseFrontmatter(content)
  })
  // Writing goals (Round A T5, ADR-0002/0019/0028): a DIRECT frontmatter write — the writer's own
  // act through the "Set writing goal…" command, deliberately NOT the staged `frontmatter.set`
  // agent capability (no agent, no review queue; the ADR-0019 pattern: the writer states an intent,
  // a capture path writes the fields). `target: null` clears both keys; the body bytes never change.
  ipcMain.handle('goal:set', async (event, input: { path?: string; target?: number | null; due?: string | null }) => {
    if (typeof input?.path !== 'string') throw new Error('Invalid document path.')
    assertRelativeWorkspacePath(input.path)
    const target = input.target ?? null
    const due = input.due ?? null
    if (target !== null && (!Number.isSafeInteger(target) || target <= 0)) {
      throw new Error('A writing goal must be a positive whole number of words.')
    }
    if (due !== null && !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
      throw new Error('A due date must be an ISO date (YYYY-MM-DD).')
    }
    const state = stateForSender(event.sender.id)
    const workspace = requireWorkspace(state)
    const { content } = await workspace.readFile(input.path)
    const next = target === null
      ? removeFrontmatterKeys(content, ['goal', 'due'], input.path)
      : removeFrontmatterKeys(
          setFrontmatterKeys(content, { goal: String(target), ...(due ? { due } : {}) }, input.path),
          due ? [] : ['due'],
          input.path,
        )
    if (next === content) return workspace.readFile(input.path) // no-op: clearing an absent goal
    const saved = await workspace.saveFile(input.path, next)
    notifyCollectionChanged(state, [saved.file.path])
    return saved
  })
  ipcMain.handle('file:save', async (event, input: { path: string; content: string }) => {
    // Tier 1 (ADR-0013): auto-save writes to disk only — it never snapshots. History (tier 2) is made
    // by explicit checkpoints via snapshot:checkpoint below, and by agent turns.
    const state = stateForSender(event.sender.id)
    // The Change journal is ChangeStore's alone: a proposal's record (the new file it shows) is not editable here.
    if (isChangeJournalPath(input.path)) throw new Error('The change journal cannot be saved from the editor.')
    try {
      // The editor's text is LF; saveEditorText writes nothing for an unchanged document and restores
      // the file's own line endings and BOM for an edited one (bug 01).
      const saved = await requireWorkspace(state).saveEditorText(input.path, input.content)
      notifyCollectionChanged(state, [saved.file.path])
      return saved
    } catch (error) {
      if (!(error instanceof EmptyWriteRefusal)) throw error
      return {
        refused: true as const,
        path: error.path,
        message: error.message,
        rescueDirectory: error.rescueDirectory,
        previousRescuePath: error.previousRescuePath,
        rejectedRescuePath: error.rejectedRescuePath,
      }
    }
  })
  // Deliberate emptying is a distinct, confirmation-gated main-process operation. It first takes the
  // guarded path so both sides are rescued, then offers the one explicit override ADR-0031 requires.
  // A retry through ordinary file:save can never turn into an implicit success.
  ipcMain.handle('file:clear', async (event, input: { path: string }) => {
    if (typeof input?.path !== 'string') throw new Error('Invalid document path.')
    assertRelativeWorkspacePath(input.path)
    const state = stateForSender(event.sender.id)
    const workspace = requireWorkspace(state)
    let refusal: EmptyWriteRefusal
    try {
      const alreadyEmpty = await workspace.saveFile(input.path, '')
      notifyCollectionChanged(state, [alreadyEmpty.file.path])
      return { file: alreadyEmpty, rescueDirectory: null }
    } catch (error) {
      if (!(error instanceof EmptyWriteRefusal)) throw error
      refusal = error
    }
    const response = process.env.WRITEFLEX_E2E === '1'
      ? (process.env.WRITEFLEX_E2E_CLEAR_DOCUMENT === 'confirm' ? 1 : 0)
      : (await dialog.showMessageBox(state.window, {
          type: 'warning',
          message: `Clear ${input.path}?`,
          detail:
            `This removes all text from the document. The previous content is still intact, and rescue ` +
            `copies are in ${refusal.rescueDirectory}. Clear the document only if you meant to remove everything.`,
          buttons: ['Keep previous content', 'Clear document'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })).response
    if (response !== 1) return null
    const cleared = await workspace.saveFile(input.path, '', { allowExplicitEmpty: true })
    notifyCollectionChanged(state, [cleared.file.path])
    return { file: cleared, rescueDirectory: refusal.rescueDirectory }
  })
  // Tier-2 checkpoint (ADR-0013): snapshot a file's current on-disk state as a returnable point. `auto`
  // marks a checkpoint the app made on the writer's behalf (on close): those are suppressed when the
  // "checkpoint on close" setting is off ('manual'). An explicit ⌘S checkpoint (auto:false) always fires.
  // Auto-save has already put the latest text on disk, so this snapshots exactly what the writer sees.
  // One document's checkpoint, for the IPC call below (⌘S, closing a tab) and for a closing window's
  // run (close-checkpoints.ts), which resolves the agent and the author once for all of its documents.
  const checkpointDocument = async (state: WindowState, agent: Awaited<ReturnType<typeof requireAgent>>, path: string, auto: boolean, author?: AuthorIdentity): Promise<void> => {
    // A spec makes every checkpoint slow to show that a closing window does not wait for them.
    const e2eDelay = process.env.WRITEFLEX_E2E === '1' ? Number(process.env.WRITEFLEX_E2E_CHECKPOINT_DELAY_MS ?? 0) : 0
    if (e2eDelay > 0) await new Promise((resolve) => setTimeout(resolve, e2eDelay))
    if (!(auto && settings.get('snapshots.frequency') === 'manual')) {
      await agent.checkpointFile(path)
    }
    // The same close event creates ADR-0031's one foundation version. This is independent of the
    // close-checkpoint preference: that setting suppresses tier 2, not the one automatic tier-3 floor.
    if (auto) {
      const workspace = requireWorkspace(state)
      const initial = await saveInitialVersionOnClose({
        path,
        workspace,
        agent,
        versions: requireVersions(state),
        author: author ?? await humanAuthorForWorkspace(workspace.root),
      })
      if (initial) sendSafe(state, 'versions:changed', null)
    }
  }
  ipcMain.handle('snapshot:checkpoint', async (event, input: { path: string; auto?: boolean }) => {
    // Checkpoints are a data-safety tier: if the agent is still booting, WAIT for it rather than
    // silently dropping the snapshot; only a window with no Workspace at all skips (agentReady null).
    const state = stateForSender(event.sender.id)
    if (!state.agentReady) return
    const startedAt = Date.now()
    try {
      await checkpointDocument(state, await requireAgent(state), input.path, input.auto === true)
    } finally {
      void recordMainProcessDiagnostic('snapshot.checkpoint.settled', { auto: input.auto === true, elapsedMs: Date.now() - startedAt })
    }
  })
  // ---- User file management (ADR-0017, the Quiet Menu) ------------------------------------------
  // Sidebar-driven operations keep the TYPED name (sanitiseFileName strips only path separators) —
  // a person gets exactly what they typed or a refusal, never a silent slug transformation. Deletes
  // are shell.trashItem ONLY (recoverable from Finder); hard delete does not exist in this app.
  ipcMain.handle('file:create', async (event, input: { name: string; directory?: string }) => {
    const state = stateForSender(event.sender.id)
    const name = sanitiseFileName(input.name)
    const path = input.directory ? `${input.directory}/${name}` : name
    const created = await requireWorkspace(state).createFile(path, '')
    notifyCollectionChanged(state, [created.file.path])
    // Step two of the Guide's first steps: a file of the person's own (never one made in the example).
    if (!(await router.example?.context(state))?.here) guide.stepDone('file', basename(created.file.path))
    return created
  })

  const plannedRename = async (workspace: Workspace, path: string, newPath: string) => {
    const targetPath = workspace.relative(workspace.renameTarget(path, newPath))
    return planRenameRepair(workspace, path, targetPath)
  }
  const renameWithRepair = async (state: WindowState, path: string, newPath: string) => {
    const workspace = requireWorkspace(state)
    const plan = await plannedRename(workspace, path, newPath)
    const renamed = await workspace.renameFile(path, newPath)
    let repair: RenameRepairResult
    try {
      const checkpoint = async (repairPath: string) => {
        if (!state.agentReady) return
        await (await requireAgent(state)).checkpointFile(repairPath)
      }
      repair = await applyRenameRepair(plan, workspace, {
        beforeMarkdownWrite: checkpoint,
        beforeManifestWrite: checkpoint,
      })
    } catch (error) {
      repair = await failedRenameRepairResult(plan, workspace, error)
    }
    notifyCollectionChanged(state, [path, renamed.file.path, ...repair.writtenPaths])
    if (repair.writtenPaths.length) sendSafe(state, 'file:changed-on-disk', repair.writtenPaths)
    return { ...renamed, repair }
  }

  ipcMain.handle('file:rename-repair-paths', async (
    event,
    input: { path: string; newName: string; directory?: string | null },
  ) => {
    const workspace = requireWorkspace(stateForSender(event.sender.id))
    const name = sanitiseFileName(input.newName)
    const requestedPath = input.directory === null ? `./${name}` : input.directory ? `${input.directory}/${name}` : name
    const newPath = workspace.relative(workspace.renameTarget(input.path, requestedPath))
    const plan = await planRenameRepair(workspace, input.path, newPath)
    return { newPath, repairPaths: plan.writes.map((write) => write.path) }
  })
  ipcMain.handle('file:rename', async (event, input: { path: string; newPath: string }) => {
    const state = stateForSender(event.sender.id)
    return renameWithRepair(state, input.path, input.newPath)
  })
  ipcMain.handle('file:move', async (event, input: { path: string; newPath: string }) => {
    const state = stateForSender(event.sender.id)
    const workspaceRelativePath = input.newPath.includes('/') ? input.newPath : `./${input.newPath}`
    return renameWithRepair(state, input.path, workspaceRelativePath)
  })
  ipcMain.handle('file:duplicate', async (event, input: { path: string }) => {
    const state = stateForSender(event.sender.id)
    const duplicated = await requireWorkspace(state).duplicateFile(input.path)
    notifyCollectionChanged(state, [duplicated.file.path])
    return duplicated
  })
  ipcMain.handle('file:trash', async (event, input: { path: string }) => {
    const state = stateForSender(event.sender.id)
    const workspace = requireWorkspace(state)
    workspace.recordOwnWrite(input.path) // dedupe: our own trash write must not echo back through the watcher
    await shell.trashItem(workspace.absolute(input.path)) // containment + symlink guard inside absolute()
    notifyCollectionChanged(state, [input.path])
    return { path: input.path }
  })
  ipcMain.handle('file:reveal', async (event, input: { path: string }) => {
    const workspace = requireWorkspace(stateForSender(event.sender.id))
    shell.showItemInFolder(workspace.absolute(input.path))
  })
  ipcMain.handle('folder:create', async (event, input: { path: string }) => {
    const state = stateForSender(event.sender.id)
    const created = await requireWorkspace(state).createFolder(input.path)
    notifyCollectionChanged(state, [created.path])
    return created
  })
  ipcMain.handle('folder:rename', async (event, input: { path: string; newName: string }) => {
    const state = stateForSender(event.sender.id)
    const renamed = await requireWorkspace(state).renameFolder(input.path, input.newName)
    notifyCollectionChanged(state, [input.path, renamed.path])
    return renamed
  })
  ipcMain.handle('folder:trash', async (event, input: { path: string }) => {
    const state = stateForSender(event.sender.id)
    const workspace = requireWorkspace(state)
    workspace.recordOwnWrite(input.path) // dedupe: our own trash write must not echo back through the watcher
    await shell.trashItem(workspace.absolute(input.path))
    notifyCollectionChanged(state, [input.path])
    return { path: input.path }
  })

  // ---- E2E agent double (Task 15) --------------------------------------------------------------
  // Live model turns need usability review (a signed-in provider), so under the e2e flag a spec REGISTERS a
  // scripted capability sequence here; the window's NEXT agent:prompt consumes it (one-shot).
  // The per-window queue is bound to Bridle's F8 scripted provider when the Workspace opens. A stub
  // validates and appends exactly one turn for the next prompt; no host-side executor bypass remains.
  const e2eScripts = new Map<number, { steps: ScriptedStep[]; reply?: string }>()
  if (process.env.WRITEFLEX_E2E === '1') {
    ipcMain.handle('agent:stub', (event, steps: unknown, reply?: unknown) => {
      const state = stateForSender(event.sender.id)
      if (!state.e2eScriptQueues || !state.threads) throw new Error('The e2e scripted queue is unavailable until a Workspace is bound.')
      if (reply !== undefined && typeof reply !== 'string') throw new Error('Invalid e2e TurnScript: the final reply must be text.')
      buildE2EScriptedTurn(steps, reply) // validate NOW; queueing is deferred
      // LATE BINDING: the script joins the queue of whichever thread the next agent:prompt runs on
      // (a chord-fired run activates a NEW thread after the stub registered — push-at-stub-time
      // would strand the script on the old thread). Re-stubbing replaces the pending script.
      e2eScripts.set(event.sender.id, { steps: steps as ScriptedStep[], ...(reply === undefined ? {} : { reply }) })
    })
  }
  // ---- end E2E agent double --------------------------------------------------------------------

  ipcMain.handle('agent:state', async (event) => agentState(stateForSender(event.sender.id)))
  ipcMain.handle('agent:digest', async (event, input: { dir?: string }) =>
    (await requireAgent(stateForSender(event.sender.id))).collectionDigest(collectionDir(input)))
  ipcMain.handle('agent-notes:list', async (event, input?: { dir?: string }) =>
    (await requireAgent(stateForSender(event.sender.id))).agentNotes(collectionDir(input)))
  // The Agent notes pane's tick (checkbox-lists ticket 04): one character, written into the NOTE's
  // file only (toggleAgentNoteTask refuses anything that is not an agent note). `checked` is the state
  // the pane showed, so a stale pane never flips a box the other way. The pushes are the ones every
  // disk write outside the editor makes: the pane re-lists, an open tab of the note reconciles.
  ipcMain.handle('agent-notes:toggle-task', async (event, input: { path?: string; line?: number; checked?: boolean }) => {
    if (typeof input?.path !== 'string' || !Number.isInteger(input?.line) || typeof input?.checked !== 'boolean') {
      throw new Error('Agent note path, line and the box state are required.')
    }
    assertRelativeWorkspacePath(input.path)
    const state = stateForSender(event.sender.id)
    const toggled = await toggleAgentNoteTask(requireWorkspace(state), input.path, input.line as number, input.checked)
    const path = toggled.saved.file.path
    notifyCollectionChanged(state, [path])
    sendSafe(state, 'file:changed-on-disk', [path])
    sendSafe(state, 'agent-notes:changed', null)
    return { path, line: toggled.line, checked: toggled.checked }
  })
  ipcMain.handle('agent-notes:restage', async (event, input: { path?: string; sourceDocument?: string; insertAfter?: string; anchor?: { from: number; to: number } }) => {
    if (typeof input?.path !== 'string' || typeof input?.sourceDocument !== 'string') throw new Error('Agent note and source document paths are required.')
    assertRelativeWorkspacePath(input.path)
    assertRelativeWorkspacePath(input.sourceDocument)
    if (input.insertAfter !== undefined && typeof input.insertAfter !== 'string') throw new Error('Invalid Agent note insertion anchor.')
    if (input.anchor !== undefined && (!Number.isInteger(input.anchor.from) || !Number.isInteger(input.anchor.to) || input.anchor.from !== input.anchor.to || input.anchor.from < 0)) {
      throw new Error('Invalid Agent note cursor position.')
    }
    return (await requireAgent(stateForSender(event.sender.id))).restageAgentNote(input.path, {
      sourceDocument: input.sourceDocument,
      ...(input.insertAfter !== undefined ? { insertAfter: input.insertAfter } : {}),
      ...(input.anchor ? { anchor: input.anchor } : {}),
    })
  })
  ipcMain.handle('ambient:set', (event, snapshot: AmbientSnapshot) => {
    const state = stateForSender(event.sender.id)
    state.ambient?.set(snapshot)
  })

  ipcMain.handle('agent:prompt', async (event, input: { text: string; activeFile?: string | null; activeCollectionDir?: string; runOnFolder?: string }) => {
    const state = stateForSender(event.sender.id)
    const agent = await requireAgent(state)
    // "Ask first": refuse before any side effect (thread naming, digest priming)...
    state.threads?.assertMaySend(agent, state.threads.activeThreadId())
    // An empty text is the run-as-is turn: substitute the canonical instruction (the model must
    // ACT, not ask) — mapSessionMessages strips it, so the thread still reads as nothing said.
    // A folder skill's launch names its folder (ticket 10), validated as a workspace-relative path.
    if (input.text === '') {
      const folder = input.runOnFolder === undefined ? undefined : collectionDir({ dir: input.runOnFolder })
      input = { ...input, text: runAsIsInstruction(folder) }
    }
    // The first thing the writer says names the active thread in Recent (B1); failure is cosmetic.
    void state.threads?.noteUserText(isRunAsIsInstruction(input.text) ? '' : input.text).catch(() => {})
    const scripted = e2eScripts.get(event.sender.id) // only ever populated under the e2e fence above
    const activeCollectionDir = collectionDir({ dir: input.activeCollectionDir })
    await agent.primeCollectionDigest(activeCollectionDir).catch(() => {})
    // ...and again at the sink, after the async preparation above, through the one send gate.
    const send = () => {
      if (!scripted) return agent.prompt(input.text, input.activeFile, activeCollectionDir)
      e2eScripts.delete(event.sender.id)
      // Late binding (see agent:stub): the pending script joins THIS prompt's thread queue now.
      const activeId = state.threads?.activeThreadId()
      if (state.e2eScriptQueues && activeId) queueForThread(state.e2eScriptQueues, activeId).push(buildE2EScriptedTurn(scripted.steps, scripted.reply))
      return agent.runScriptedTurn(input.text, scripted.steps, input.activeFile, activeCollectionDir)
    }
    return state.threads ? state.threads.sendGuarded(agent, state.threads.activeThreadId(), send) : send()
  })
  ipcMain.handle('agent:abort', async (event) => (await requireAgent(stateForSender(event.sender.id))).abort())
  ipcMain.handle('agent:set-model', async (event, input: { provider: string; modelId: string }) => {
    const state = stateForSender(event.sender.id)
    if (!state.threads) throw new Error('No active thread.')
    if (state.threads.activeModelChoice()) {
      // "Ask first": the user's pick for a waiting chat is persisted, then the chat starts on it.
      await state.threads.chooseModel(input.provider, input.modelId)
      await requireAgent(state)
      return agentState(state)
    }
    const agent = await requireAgent(state)
    const catalogue = agent.modelCatalogue()
    const models = process.env.WRITEFLEX_E2E === '1' && process.env.WRITEFLEX_E2E_AVAILABLE_MODELS === '1'
      ? catalogue
      : agent.availableModels()
    void recordMainProcessDiagnostic('agent.models.assembled', {
      trigger: 'model-switch-attempt',
      requestedProvider: input.provider,
      requestedModelId: input.modelId,
      ...modelRegistryDiagnostic(authFilePath, catalogue, models),
    })
    try {
      await state.threads.setModel(input.provider, input.modelId)
      const next = await agentState(state)
      if (next.model?.provider !== input.provider || next.model.id !== input.modelId) {
        const actual = next.model ? `${next.model.provider}/${next.model.id}` : 'no model'
        throw new Error(`The model switch was ignored: ${actual} remains in force.`)
      }
      return next
    } catch (error) {
      const inForce = agent.currentModel() ?? state.threads.activeRecord()?.model ?? null
      void recordMainProcessDiagnostic('agent.model-switch.failed', {
        provider: input.provider,
        modelId: input.modelId,
        inForceProvider: inForce?.provider ?? null,
        inForceModelId: inForce?.id ?? null,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  })
  ipcMain.handle('agent:set-thinking', async (event, level: ThinkingLevel) => {
    const state = stateForSender(event.sender.id)
    if (!state.threads) throw new Error('No active thread.')
    await state.threads.setThinking(level)
    return agentState(state)
  })
  ipcMain.handle('agent:set-default-model', async (event, input: { provider: string; modelId: string }) => {
    await modelServiceReady
    const state = stateForSender(event.sender.id)
    const catalogue = registryModels(modelService).all
    const known = catalogue.some((model) => model.provider === input?.provider && model.id === input?.modelId)
    if (!known) throw new Error(`Unknown model: ${input?.provider}/${input?.modelId}`)
    settings.setModelDefaults({ provider: input.provider, modelId: input.modelId })
    return true
  })
  ipcMain.handle('agent:set-default-thinking', (_event, level: ThinkingLevel) => {
    if (!(['minimal', 'low', 'medium', 'high'] as const).includes(level)) throw new Error(`Unknown reasoning level: ${String(level)}`)
    settings.setModelDefaults({ thinkingLevel: level })
    return true
  })
  ipcMain.handle('agent:restore-last-turn', async (event) => {
    const state = stateForSender(event.sender.id)
    const paths = await (await requireAgent(state)).restoreLastTurn()
    notifyCollectionChanged(state, paths)
    return paths
  })

  ipcMain.handle('suggestions:apply', async (event, id: string) => {
    const state = stateForSender(event.sender.id)
    const agent = await requireAgent(state)
    const outcome = await agent.applySuggestion(id)
    const details = outcome.details as { file?: { file: { path: string } } } | undefined
    const file = details?.file ? await requireWorkspace(state).readFile(details.file.file.path) : undefined
    if (file?.file.path) notifyCollectionChanged(state, [file.file.path])
    return { outcome: { text: outcome.text, isError: outcome.isError }, workspace: await workspaceState(state), file }
  })
  ipcMain.handle('suggestions:discard', async (event, id: string) => (await requireAgent(stateForSender(event.sender.id))).discardSuggestion(id))
  ipcMain.handle('approvals:respond', async (event, input: { id: string; approved: boolean }) => {
    const state = stateForSender(event.sender.id)
    // Route to the OWNING thread's agent: an approval raised by a background run must be answered
    // where it is pending — resolving through the active agent would leave the owner hanging.
    const ownerThreadId = state.approvalOwners.get(input.id)
    state.approvalOwners.delete(input.id)
    const owner = ownerThreadId ? state.threads?.agentFor(ownerThreadId) : null
    ;(owner ?? await requireAgent(state)).resolveApproval(input.id, input.approved)
  })

  // auth:* handlers replaced by @bridle/electron's registerAuthIpc (bridle.auth:* channels) above.

  ipcMain.handle('web:fetch-title', (_event, url: string) => fetchLinkTitle(url))

  // Renderer-initiated proceed: the last tab closed, or a guarded close resolved (every dirty buffer
  // flushed). Mark it resolved so the 'close' guard passes it straight through. Saving is automatic
  // (ADR-0012), so there is no native confirm sheet on tab- or window-close any more.
  // The renderer received a close-request and is alive (it acks before its flush): cancel the dead-renderer
  // safety-net timer so a slow flush is never force-closed. From here the renderer owns the close, ending
  // it with window:close (proceed) or window:cancel-close (a failed save, kept open).
  // The app's script has started in this page (the preload saw its first close listener). From here
  // the page may hold text, so a close it does not acknowledge is never forced as "still loading".
  // Main frame only, as every channel here (ipc-main-frame-only.ts).
  ipcMain.handle('window:app-started', (event) => {
    stateForSender(event.sender.id).closing?.appStarted()
  })
  ipcMain.handle('window:close-ack', (event) => {
    stateForSender(event.sender.id).closing?.acked()
  })
  // The close request reached a page in which no script of the app has run (the preload saw no
  // listener at all: a blank shell). There was never an editor in it, so no text; the window goes at
  // once. A page whose app ran and then broke keeps a listener of its own (renderer unsaved-text.ts).
  ipcMain.handle('window:close-unattended', (event) => {
    stateForSender(event.sender.id).closing?.unattended()
  })
  // The app in the page has stopped and it holds text it could not write: the person is asked, and the
  // window closes only if they say so. A page can cause the question, never the close.
  ipcMain.handle('window:close-unsaved', (event) => {
    stateForSender(event.sender.id).closing?.unsaved()
  })
  // The renderer has written every dirty buffer (or asked to close with nothing open): the window
  // goes NOW. The checkpoints the close owes — the documents the renderer names, changed ones first —
  // run here in main afterwards, best-effort and bounded (close-checkpoints.ts), instead of holding
  // the window open one IPC call per tab. They are tracked so will-quit's cleanup bound covers them.
  ipcMain.handle('window:close', (event, input: unknown) => {
    const state = stateForSender(event.sender.id)
    const paths = parseCloseCheckpointPaths(input, (path) => { assertRelativeWorkspacePath(path); return true })
    if (paths.length > 0 && state.agentReady && state.workspace && !state.closeWork) {
      const root = state.workspace.root
      state.closeWork = startCloseCheckpoints(paths, {
        prepare: async () => {
          const [agent, author] = await Promise.all([requireAgent(state), humanAuthorForWorkspace(root)])
          return (path) => checkpointDocument(state, agent, path, true, author)
        },
        record: (name, details) => { void recordMainProcessDiagnostic(name, details) },
        now: () => Date.now(),
      })
      trackPendingDisposal(state.closeWork.done)
    }
    if (state.closing) state.closing.proceed()
    else {
      state.forceClose = true
      state.window.close()
    }
  })
  // The renderer abandoned a guarded close (a save failed, so the window stays open). Clear any ⌘Q
  // intent so a later ordinary close can't inherit it and quit the whole app (Codex review P2).
  ipcMain.handle('window:cancel-close', (event) => {
    setQuitting(false)
    const state = stateForSender(event.sender.id)
    state.closing?.cancelled()
    state.onCloseCancelled?.()
  })
  ipcMain.handle('window:set-title', (event, title: string) => {
    if (typeof title !== 'string' || title.length === 0 || title.length > 300 || /[\r\n]/.test(title)) {
      throw new Error('Invalid window title.')
    }
    const state = stateForSender(event.sender.id)
    if (!state.window.isDestroyed()) state.window.setTitle(title)
  })
  // The app version (package.json), shown in the status bar. Static, so the renderer fetches it once.
  ipcMain.handle('app:version', () => hooks?.appVersionLabel ?? app.getVersion())
  ipcMain.handle('app:runtime-info', () => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    macOS: process.getSystemVersion(),
  }))

  // Auth is now one app-wide broker (no per-window map to evict); only the e2e
  // script map is window-keyed. WindowManager calls this on close.
  return {
    evictWindow: (webContentsId: number) => { e2eScripts.delete(webContentsId); widgetWatches.disposeWindow(webContentsId) },
    dispose: () => {
      unsubscribeModels()
      authRegistration.dispose()
      ipcMain.removeHandler('agent:models-picker-opened')
      ipcMain.removeHandler('agent:models-refresh')
    },
  }
}

/**
 * Bind a workspace to a window: create Workspace + WorkspaceAgent, wire push channels. Used by the
 * WindowManager. Takes the SettingsStore whole (Task 17) — model defaults, the live Agent
 * Permissions filter, and snapshot retention all read from it at (or after) this moment.
 */
export async function bindWorkspace(state: WindowState, root: string, settings: SettingsStore): Promise<void> {
  const previousWorkspace = state.workspace
  state.workspaceWatcher?.dispose()
  state.workspaceWatcher = null
  if (state.threads) {
    const windowId = state.window.webContents.id
    const startedAt = Date.now()
    recordMainProcessDiagnostic('workspace.rebind-dispose.started', { windowId, root })
    await state.threads.disposeAll()
    recordMainProcessDiagnostic('workspace.rebind-dispose.settled', { windowId, root, elapsedMs: Date.now() - startedAt })
  }
  state.threads = null
  state.agent = null
  state.agentReady = null
  state.approvalOwners.clear() // owners of the old manager's approvals died with its agents
  state.bindGeneration += 1
  const generation = state.bindGeneration
  if (state.diaryIdleTimer) clearTimeout(state.diaryIdleTimer)
  state.diaryIdleTimer = null
  if (state.explicitDurationTimer) clearTimeout(state.explicitDurationTimer)
  state.explicitDurationTimer = null
  if (state.explicitCompletionTimer) clearTimeout(state.explicitCompletionTimer)
  state.explicitCompletionTimer = null
  const diaryRecord = state.explicitSession?.active
    ? state.explicitSession.close('manual')?.record ?? null
    : state.diaryCapture?.close() ?? null
  if (diaryRecord && state.diaryRoot) {
    const diaryWorkspace = allStates().find((candidate) => candidate.workspace?.root === state.diaryRoot)?.workspace ?? undefined
    const result = await persistDiarySession(state.diaryRoot, diaryRecord, {
      ...(previousWorkspace ? { sourceWorkspace: previousWorkspace } : {}),
      ...(diaryWorkspace ? { diaryWorkspace } : {}),
    })
    if (result.error) sendSafe(state, 'diary:error', result.error)
  }
  state.diaryCapture?.reset()
  state.explicitSession = null
  sendSafe(state, 'diary:session', null)
  state.diaryRoot = null
  // Opening or re-opening a workspace starts from fresh Folio-place answers, for the root left and the root opened.
  if (previousWorkspace) invalidateFolioPlaces(previousWorkspace.root)
  if (previousWorkspace) invalidateFolioOrderFacts(previousWorkspace.root)
  if (previousWorkspace) invalidateFolioOutlines(previousWorkspace.root)
  invalidateFolioPlaces(root)
  invalidateFolioOrderFacts(root)
  invalidateFolioOutlines(root)
  state.workspace = new Workspace(root)
  const workspace = state.workspace
  // A rebind starts from the NEW root's recorded focus (or none); a folder gone since is dropped.
  state.folderFocus = restoreFolderFocus(settings, workspace)
  configureWorkspaceWatcher(state, settings.get('workspace.watchExternalChanges') !== false)
  // The Scraps store shares the Workspace guard; scraps/ is created on the first cut (ADR-0008).
  state.scraps = new ScrapStore(state.workspace)
  const scraps = state.scraps
  // The Change Ledger store shares the same guard; .writeflex/changes.jsonl on the first captured change.
  state.changes = new ChangeStore(state.workspace)
  const changes = state.changes
  state.versions = new VersionStore(state.workspace)

  // E2E ONLY — Bridle ADR-0009 upstream parcel: runtime-fed scriptedSessionFactory queue. Bridle's
  // routeFor captures this ARRAY by reference and indexes it lazily, so agent:stub can push a validated
  // TurnScript after handle creation. This host proving ground is intended to fold upstream as an
  // explicit queue option; production windows never receive a factory or retain this parcel.
  const scriptedQueues: WindowState['e2eScriptQueues'] = process.env.WRITEFLEX_E2E === '1' ? new Map() : null
  state.e2eScriptQueues = scriptedQueues

  // Threads (0.7b B1): the window's agent world is a ThreadManager — one skill-bound (or chat)
  // Bridle instance per thread, each on its own appDataDir so Pi resumes per-thread transcripts.
  // `state.agent`/`state.agentReady` stay the ACTIVE thread's views, so every agent:* handler above
  // keeps working untouched. The manager boots the restored thread in the BACKGROUND: binding
  // returns as soon as the stores exist, agent-needing IPC awaits `agentReady`, and `agent:ready`
  // re-hydrates the panel when a boot (or a thread switch) lands. A rebind or window close bumps
  // the generation, and a stale manager's events are ignored on arrival.
  const deps = sharedDeps()
  const ambient = new AmbientState(workspace.root)
  state.ambient = ambient
  const manager: ThreadManager = new ThreadManager({
    ambient,
    userDataDir: app.getPath('userData'),
    workspaceRoot: root,
    index: deps.threadIndex,
    skills: deps.skills,
    defaults: () => {
      const defaults = deps.resolvedDefaults()
      return { provider: defaults.model.provider, modelId: defaults.model.id, thinkingLevel: defaults.thinking }
    },
    // Preferences resolve after the startup discovery, never against the pre-discovery bundled list.
    modelsReady: () => deps.modelServiceReady,
    // Bridle's list decides which models a chat may start on; unlisted ones fall back (fix 04).
    listedModels: () => {
      const { all, available } = registryModels(deps.modelService)
      const ref = (model: { provider: string; id: string }) => ({ provider: model.provider, id: model.id })
      return { listed: all.map(ref), available: available.map(ref) }
    },
    ...(process.env.WRITEFLEX_E2E === '1' && process.env.WRITEFLEX_E2E_AVAILABLE_MODELS === '1'
      ? { isModelAvailable: (provider: string, modelId: string) => registryModels(deps.modelService).all.some((model) => model.provider === provider && model.id === modelId) }
      : {}),
    applyModel: process.env.WRITEFLEX_E2E === '1' && process.env.WRITEFLEX_E2E_AVAILABLE_MODELS === '1'
      ? async () => {
          const reason = process.env.WRITEFLEX_E2E_FAIL_MODEL_SWITCH
          if (reason) throw new Error(reason)
        }
      : undefined,
    currentModelAfterApply: process.env.WRITEFLEX_E2E === '1' && process.env.WRITEFLEX_E2E_AVAILABLE_MODELS === '1'
      ? (_agent, provider, modelId) => ({ provider, id: modelId })
      : undefined,
    createAgent: async ({ threadId, appDataDir, defaults, composition }): Promise<WorkspaceAgent> => {
      // Background threads keep RUNNING but must not narrate over the active thread's panel: traces
      // and suggestion pushes forward only while their thread is active (a switch re-hydrates from
      // the instance, so nothing is lost); approvals ALWAYS forward — a background run waiting on
      // one must never hang silently (review finding B1 P1).
      const isActiveThread = () => state.threads?.activeThreadId() === threadId
      // Snapshot retention (Task 17): sweep aged-out journal entries + orphaned objects BEFORE an
      // agent opens the store. Unset = the default 90 days; only an explicit 'forever' skips. The
      // sweep runs before every thread boot — it is idempotent and the store is workspace-scoped —
      // and a failed sweep must never block the boot.
      const retention = settings.get('snapshots.retention')
      if (retention !== 'forever') {
        await sweepSnapshots(join(root, '.bridle'), retention === '30' ? 30 : 90).catch(() => {})
      }
      let checkpointCreated: (path: string) => Promise<void>
      await deps.modelServiceReady
      const created = await WorkspaceAgent.create({
        workspace,
        appDataDir,
        // Per-thread data dirs would each grow their own auth.json; pin the ONE app-wide broker file.
        auth: deps.auth,
        modelService: deps.modelService,
        defaults,
        // Live read on every policy decision, so an Agent Permissions toggle bites mid-session too.
        isCapabilityEnabled: (name) => capabilityEnabled(name, (key) => settings.get(key)),
        // The agent's scrap capabilities (Task 24) share the window's ONE ScrapStore, so agent + user
        // writes serialise through the same mutex; a scrap add pushes scraps:changed so the pane re-lists.
        services: {
          scraps,
          onScrapsChanged: () => sendSafe(state, 'scraps:changed', null),
          checkpointFile: (path) => checkpointCreated(path),
          notifyFilesChangedOnDisk: (paths) => {
            notifyCollectionChanged(state, paths)
            sendSafe(state, 'file:changed-on-disk', paths)
          },
        },
        // The window's ONE ChangeStore: staged prose edits ingest as pending agent Changes, accept/reject
        // moves their status, and each push re-lists the dock (Task 3, ADR-0011).
        changes,
        onChangesChanged: () => sendSafe(state, 'changes:changed', null),
        onAgentNotesChanged: (path) => {
          sendSafe(state, 'agent-notes:changed', null)
          notifyCollectionChanged(state, [path])
        },
        getCollectionRevision: (dir) => collectionDigestRevision(root, dir),
        onTurnComplete: (paths, activeCollectionDir) => notifyCollectionChanged(state, [...paths, activeCollectionDir]),
        onTurnRecorded: async (execution): Promise<void> => manager.recordTurn(threadId, execution),
        onTrace: (e) => { if (isActiveThread()) sendSafe(state, 'agent:trace', e) },
        onApprovalRequest: (req) => {
          // Record ownership BEFORE the push: approvals always forward (a background run waiting on
          // one must never hang silently), and the response routes back to the owning thread.
          state.approvalOwners.set(req.id, threadId)
          sendSafe(state, 'agent:approval', req)
        },
        onSuggestionsChanged: (s) => { if (isActiveThread()) sendSafe(state, 'agent:suggestions', s) },
        // One scripted factory + queue per THREAD: each factory owns one Cache-Law session, so a
        // shared factory across differently-composed threads would (rightly) trip the Law.
        ...(scriptedQueues ? { sessionFactory: scriptedSessionFactory(queueForThread(scriptedQueues, threadId)) } : {}),
        ...(composition ? { composition } : {}),
      })
      checkpointCreated = (path) => created.checkpointFile(path)
      const catalogue = created.modelCatalogue()
      const models = process.env.WRITEFLEX_E2E === '1' && process.env.WRITEFLEX_E2E_AVAILABLE_MODELS === '1'
        ? catalogue
        : created.availableModels()
      void recordMainProcessDiagnostic('agent.models.assembled', {
        trigger: 'agent-boot',
        threadId,
        ...modelRegistryDiagnostic(deps.authFilePath, catalogue, models),
      })
      return created
    },
    onActiveChanged: (agent, ready) => {
      if (state.bindGeneration !== generation) return // a newer bind (or close) superseded this manager
      state.agent = agent
      state.agentReady = ready
      // The rejection is consumed by whichever requireAgent awaits it; this guard only prevents an
      // unhandled-rejection crash when nothing ever asks for the agent (e.g. a failed skill boot).
      ready?.catch(() => {})
      if (agent) sendSafe(state, 'agent:ready', null)
    },
    onRunComplete: (payload) => sendSafe(state, 'threads:run-complete', payload),
    // A failed active boot is still a state change: the renderer re-pulls and finds threadError.
    onBootFailed: () => sendSafe(state, 'agent:ready', null),
    trackDisposal: trackPendingDisposal,
  })
  state.threads = manager
  // agentReady must exist SYNCHRONOUSLY from bind (requireAgent's contract since 0.2): seed it with
  // the first activation's boot; onActiveChanged repoints it as threads switch.
  const firstReady = manager.bind().then(() => {
    const ready = manager.activeReady()
    // "Ask first": the first chat waits for a model choice; say so instead of "no agent".
    if (!ready && manager.activeModelChoice()) throw new Error(manager.activeModelNotice() ?? 'Choose a model to continue.')
    if (!ready) throw new Error('No agent for this window (open a Workspace first).')
    return ready
  })
  firstReady.catch((error: unknown) => {
    recordMainProcessDiagnostic('threads.bind.failed', { root, message: error instanceof Error ? error.message : String(error) })
  })
  if (state.bindGeneration === generation) state.agentReady = firstReady
  if (!state.window.isDestroyed()) state.window.setTitle(`${root.split('/').at(-1)} — WriteFlex`)
}

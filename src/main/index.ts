import { HISTORY_APPROVAL_BASENAME } from '../backup-helper/history-approvals'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, powerMonitor, protocol, shell } from 'electron'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, readFileSync, realpathSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createOutsideChangeFollower } from './sharing-outside-changes'
import { applyFollowSignal, takeAtStart, watchFollowSignals } from './sharing-follow-signals'
import type { GitSyncLifecycle } from './git-sync-app'
import { onDocumentsChanged, onDocumentsChangedOutside, onSharingIdentityChanged, onDocumentsMoved, onDocumentsTrashed, onWindowWorkspaceBound, onWorkspaceOpened, reconcileSyncedCollectionsAfterWake, registerIpc } from './ipc'
import { installUpdateNotices } from './update-notices'
import { SettingsStore } from './settings'
import { WindowManager } from './windows'
import { THEME_SETTING } from '../shared/appearance'
import { windowBackgrounds } from './window-appearance'
import { buildAppMenu, noteFocusedWindow, noteSettingsMenuFocus, updateCollectionMenu } from './menu'
import { agentDisposalsPending, allStates, isQuitting, onQuitCancelled, setQuitting, stateForSender, waitForAgentDisposals, type WindowState } from './state'
import { duringRestartHold, restartHeld } from './restart-holds'
import { UPDATE_TEST_BUILD, updateTestHeld } from './update-test-build'
import { startUpdateTestControl } from './update-test-control'
import { restartBlockers } from '../shared/update-install'
import { createBackupRestartActivity, type BackupRestartActivity } from './backup-restart-activity'
import { createRestartClose } from './restart-windows'
import { closeSettingsForRestart } from './settings-restart'
import { openMain } from './window-presentation'
import { CUSTOM_PAGES, MENU_COMMAND_CHANNEL, OPEN_SETTINGS_CHANNEL, SETTINGS_PAGE_COMMANDS, installSettingsHost, openSharedSettings, type SettingsApp } from './settings-host'
import { schema as settingsSchema } from '../shared/settings-schema'
import { AuthKeySlots } from './key-slots'
import { registerAssetProtocol } from './wf-asset'
import { configureMainProcessDiagnostics, recordMainProcessDiagnostic, waitForCleanupWithTimeout } from './shutdown'
import { classifyOpenPath, parseWriteflexUrl } from './writeflex-url'
import { SkillsRegistry } from './skills'
import { registerReadingRoom, zoteroDatabasePath } from './reading-room'
import { probeZotero } from './guide-connections'
import { resolveAppVariant } from './app-variant'
import { GuideProgressStore } from './guide-progress-store'
import { ExampleCollection, resolveExampleDocumentsDir } from './example-collection'
import { ExampleRemoval, resolveExampleTrash } from './example-removal'
import { moveIntoHarnessBin } from './example-trash-harness'
import { registerCliInstallIpc } from './cli/install-ipc'
import { createBackupHelperService } from './backup-helper/service'
import { registerBackupEnrolmentIpc, registerBackupHelperIpc, registerBackupReceiptIpc } from './backup-helper/ipc'
import { createActiveBackupServices } from './backup-helper/active-services'
import { createBackupEnrolment } from './backup-helper/enrolment'
import { BACKUP_HELPER_ENTRY, standaloneHelperPath } from '../shared/backup-helper-entry'
import { BACKUP_GITHUB_CONFIG } from './backup-github-config'
import { createGitHubAuthStore, githubSecretsFiles } from './backup-helper/github-auth-store'
import { createGitHubAuth } from './backup-helper/github-auth'
import { registerGitHubIpc } from './backup-helper/github-ipc'
import { BACKUP_GITHUB_CHANNELS } from '../shared/backup-github'
import { createHelperSupervisor } from './backup-helper/supervisor'
import { BACKUP_ENROLMENT_CHANNELS } from '../shared/backup-enrolment'
import { createBackupReceiptService } from './backup-helper/receipt-service'
import { setSaveReceiptPort } from './backup-helper/save-port'
import { setNonAtomicWritePolicy } from './save-receipt-gate'
import { readProcessStartTime } from './local-process'
import { bundleIdentifierFor } from './cli/shim'
import { agentIdsArg, confirmedAgentAction, type ConfirmDialog, agentSkillStateStore, createWriteFlexAgentSkills, decideOnboarding, type AgentSkillHostParams } from './agent-skill-host'
import { exitPackagedSmoke, packagedSmokeIpcProbe, packagedSmokeReceipt, packagedSmokeRequested } from './packaged-smoke'
import { applyMainFrameOnly } from './ipc-main-frame-only'
import { trustedRenderer } from './renderer-boundary'
import { registerWidgetProtocol } from './widget-protocol'
import { removeOpenedWidgetCopiesSync } from './widget-open'
import { applyWidgetNetworkSwitches } from './widget-network'
import { openSecretsStore } from './secrets-store-electron'
import { openSharingSetup, registerSharingIpc } from './sharing-ipc'
import { SHARING_SERVICE_DIST_DIR } from './sharing-service-bundle'
import { createSharingPublisher } from './sharing-publisher'
import { readerLinksChanged, rememberReaderClaims, setReaderNotesSource } from './sharing-reader-notes-run'
import { READER_CLOSED_KEPT, readerNoteRecords } from './sharing-reader-notes'
import { createServiceClient } from './sharing-client'
import { renderPieceForSharing } from './sharing-render'
import { renderFolioLink } from './sharing-folio'
import { lookupHost, pinnedGet, safeRemotePictureFetch } from './sharing-remote-pictures'
import { registerSharingPieceIpc } from './sharing-piece-ipc'

declare const __WF_UPDATE_TEST__: boolean | undefined

// Before any module registers an IPC listener: only a window's top frame is ever answered, so a frame
// inside it (a widget, ticket 02) can reach no handler even if a later change gave subframes IPC.
applyMainFrameOnly(ipcMain, { trusted: trustedRenderer, log: (line) => { console.warn(line); void recordMainProcessDiagnostic('ipc.refused', { line }) } })
// Before `ready`: no DNS prefetch and no hyperlink auditing in any renderer (widget-network.ts).
applyWidgetNetworkSwitches(app.commandLine)

// This must remain before the single-instance lock and every userData read: Electron scopes the lock
// and all early stores to this path, so moving it later would bind a beta run to production state.
const appVariant = resolveAppVariant(readRunningAppMetadata())
app.setPath('userData', join(app.getPath('appData'), appVariant.userDataDirectoryName))
const packagedSmoke = packagedSmokeRequested(process.env)
// Startup ordering check: bootstrap.ts must finish loading this file before Electron emits 'ready'.
if (app.isPackaged && packagedSmoke && app.isReady()) {
  writeSync(2, 'WRITEFLEX_ORDERING_VIOLATION: app was already ready when index.js started\n')
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'wf-reader', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'wf-widget', privileges: { standard: true, secure: true } },
  { scheme: 'wf-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])
// Smoke mode must not re-register the protocol handler with the system.
// The update-test flavour never claims the writeflex: scheme (it would take it from the installed WriteFlex).
if (!(app.isPackaged && packagedSmoke) && !UPDATE_TEST_BUILD) void app.setAsDefaultProtocolClient('writeflex')

// Playwright already supplies a private Chromium user-data directory. Electron does not derive
// app.getPath('userData') from that switch, so bind the main-process stores to the same directory
// before the single-instance lock, Settings, threads, auth, or Bridle caches are opened.
if (process.env.WRITEFLEX_E2E === '1') {
  const userDataArg = process.argv.find((arg) => arg.startsWith('--user-data-dir='))
  const userDataDir = process.env.WRITEFLEX_E2E_USER_DATA?.trim()
    || app.commandLine.getSwitchValue('user-data-dir').trim()
    || userDataArg?.slice('--user-data-dir='.length).trim()
  if (userDataDir) app.setPath('userData', resolve(userDataDir))
  // Sharing's secrets go through safeStorage, which on macOS asks the login Keychain: an unpackaged
  // Electron reaching it raises a Keychain prompt on whoever's screen this is. A harness run uses
  // Chromium's mock keychain instead (never in a packaged build).
  app.commandLine.appendSwitch('use-mock-keychain')
}

// The running main-process entry script (argv[1] under `electron <entry> …`). It is the app itself,
// never a document — excluding it from launch paths keeps a bare launch (no folder/file arg) on the
// start screen instead of resolving the app's own repo as a Workspace via the .git walk-up.
const ENTRY_FILE = fileURLToPath(import.meta.url)
// bootstrap.js is the package entry and sits beside index.js; it is the app's own script too.
const BOOTSTRAP_FILE = join(dirname(ENTRY_FILE), 'bootstrap.js')

/** Every page the Settings window may be opened at: the schema's sections and WriteFlex's custom pages. */
const SETTINGS_SECTIONS: ReadonlySet<string> = new Set([...settingsSchema.sections.map((section) => section.id), ...CUSTOM_PAGES])

// One instance owns the Snapshot Store per Workspace; a second launch hands its paths to the first.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let manager: WindowManager | null = null
  let settings: SettingsStore | null = null
  let closeSettings = async (): Promise<void> => {}
  let readingRoom: { close(): void } | null = null
  // Git sync's checks start once IPC is registered; quit stops them and makes the one bounded send attempt.
  let gitSync: GitSyncLifecycle | null = null
  let ipcDisposal: Promise<void> | undefined
  // macOS delivers open-file before `ready`; buffer those paths until the manager exists.
  const bufferedFiles: string[] = []
  // macOS can likewise deliver a custom-scheme URL before `ready`; keep the same cold-start shape.
  const bufferedUrls: string[] = []

  app.on('open-file', (event, filePath) => {
    event.preventDefault()
    if (manager) void routePath(manager, focusedState(), filePath)
    else bufferedFiles.push(filePath)
  })

  app.on('open-url', (event, url) => {
    event.preventDefault()
    if (manager && settings) void handleWriteflexUrl(manager, settings, url)
    else bufferedUrls.push(url)
  })

  app.on('second-instance', (_event, argv) => {
    if (!manager || !settings) return
    const urls = writeflexUrlsFromArgv(argv)
    const paths = pathsFromArgv(argv)
    if (paths.length === 0 && urls.length === 0) { focusAnyWindow(); return }
    for (const url of urls) void handleWriteflexUrl(manager, settings, url)
    for (const candidate of paths) void routePath(manager, focusedState(), candidate)
  })

  app.whenReady().then(async () => {
    configureMainProcessDiagnostics(join(app.getPath('userData'), 'main-process.log'))
    recordMainProcessDiagnostic('app.ready')
    await registerAssetProtocol()
    registerWidgetProtocol(protocol, ipcMain)
    ipcMain.on('clipboard:read-text', event => {
      event.returnValue = trustedRenderer(event, 'editor') ? clipboard.readText() : ''
    })
    readingRoom = await registerReadingRoom(undefined, {
      // The plugin watcher sent (or tried to send) what was waiting: every window's indicator updates.
      onOutboxChanged: (notice) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send('reading-room:outbox-changed', notice)
        }
      },
    })
    // The Example collection (ADR-0043) lives at one fixed path under the Documents directory,
    // which comes from this one function. A run with the e2e flag never sees the real one: it gets
    // WRITEFLEX_E2E_DOCUMENTS (unpackaged only) or nothing at all.
    let example: ExampleCollection | null = null
    // The built-in agent skill (agent-skill-host.ts; contract: design element 19). Decided before the settings file is
    // made: a person who had one has used WriteFlex and gets the one later offer in the status bar, a new person the
    // dialog over the start screen. Then the copies the person installed are refreshed if the version changed. Never
    // awaited by the window and never a startup failure.
    const agentSkills = ((): ReturnType<typeof createWriteFlexAgentSkills> => {
      const dev = join(dirname(ENTRY_FILE), '..', '..', 'agent-skill-dist', 'writeflex')
      const params: AgentSkillHostParams = {
        userDataDir: app.getPath('userData'), version: app.getVersion(), bundleId: bundleIdentifierFor(readRunningAppMetadata()),
        skillDir: app.isPackaged ? join(process.resourcesPath, 'agent-skill', 'writeflex') : existsSync(dev) ? dev : null,
      }
      return createWriteFlexAgentSkills(params)
    })()
    try {
      decideOnboarding(agentSkillStateStore(app.getPath('userData')), existsSync(join(app.getPath('userData'), 'settings.json')))
      void agentSkills.refresh().catch(() => {})
    } catch (error) { console.warn('[agent-skill] launch check skipped', error) }
    ipcMain.handle('agent-skill:status', () => agentSkills.status())
    // A test run is never offered the skill for the agents on the machine it happens to run on.
    ipcMain.handle('agent-skill:offer', () => (process.env.WRITEFLEX_E2E === '1' ? { kind: 'none', agents: [], via: [] } : agentSkills.offer()))
    ipcMain.handle('agent-skill:install', (_event, ids: unknown) => agentSkills.install(agentIdsArg(ids)))
    ipcMain.handle('agent-skill:decline', (_event, ids: unknown) => agentSkills.decline(agentIdsArg(ids)))
    ipcMain.handle('agent-skill:answer-offer', (_event, answer: unknown) => {
      const a = (answer && typeof answer === 'object' ? answer : {}) as { install?: unknown; decline?: unknown }
      return agentSkills.answerOffer(agentIdsArg(a.install), agentIdsArg(a.decline))
    })
    ipcMain.handle('agent-skill:offer-shown', (_event, ids: unknown) => agentSkills.offerShown(agentIdsArg(ids)))
    // Remove and Replace are confirmed here, in a native dialog (confirmedAgentAction): Settings is in-page, so main cannot tell it from the editor by sender.
    const unchanged = async () => ({ ok: true, action: 'remove' as const, rows: [], written: [], cli: null, status: await agentSkills.status() })
    const confirmDialog: ConfirmDialog = (options) => { const win = BrowserWindow.getFocusedWindow(); return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options) }
    ipcMain.handle('agent-skill:remove', (_event, ids: unknown) => confirmedAgentAction('remove', ids, { dialog: confirmDialog, run: (id) => agentSkills.remove([id]), unchanged }))
    ipcMain.handle('agent-skill:replace', (_event, ids: unknown) => confirmedAgentAction('replace', ids, { dialog: confirmDialog, run: (id) => agentSkills.install([id], { replace: true }), unchanged }))
    const hadUpdateConfiguration = existsSync(join(app.getPath('userData'), 'settings.json'))
    const readySettings = new SettingsStore(join(app.getPath('userData'), 'settings.json'), {
      shownExampleRoot: () => example?.shownRoot() ?? null,
    })
    // Shared settings (0.27): preferences move to userData/settings-v2.json before anything reads one.
    // settings.json stays the app's state file (recents, pins, favourites …) and the old version's file.
    const sharedSettings = await openSharedSettings(readySettings, (line) => { void recordMainProcessDiagnostic('settings', { line }) })
    let settingsApp: SettingsApp | null = null
    let settingsContext: { sender: number; root: string | null } | null = null
    let retireSettingsContext = (): void => {}
    const settingsContents = () => settingsApp?.settingsWebContents() ?? null
    const settingsRoot = (): string | null => {
      if (!settingsContext) return null
      try {
        const current = stateForSender(settingsContext.sender)
        return !current.window.isDestroyed() && current.workspace?.root === settingsContext.root ? settingsContext.root : null
      } catch { return null }
    }
    onWindowWorkspaceBound((sender) => { if (settingsContext?.sender === sender) { retireSettingsContext(); settingsContext = null } })
    const exampleDocumentsDir = (): string | null => resolveExampleDocumentsDir({
      isPackaged: app.isPackaged,
      env: process.env,
      systemDocuments: () => app.getPath('documents'),
    })
    const exampleBundledDir = app.isPackaged
      ? join(process.resourcesPath, 'example-collection')
      : join(dirname(ENTRY_FILE), '..', '..', 'resources', 'example-collection')
    example = new ExampleCollection({
      documentsDir: exampleDocumentsDir,
      bundledDir: exampleBundledDir,
      store: readySettings,
      log: (event, details) => { void recordMainProcessDiagnostic(event, details) },
    })
    const exampleCollection = example
    // Not awaited: a slow or refused Documents folder must not hold the first window back. The
    // start screen asks for the entries and receives them once this has settled; it never throws.
    void exampleCollection.ensure()
    const skills = new SkillsRegistry({
      appDataDir: app.getPath('userData'),
      // Unpackaged, resolve from the BUILT ENTRY (out/main/index.js → ../../resources/skills):
      // app.getAppPath() is the entry dir when Electron is launched on out/main directly (the e2e
      // path), which broke the Gate: the popover showed "Could not seed bundled skills: ENOENT".
      bundledSkillsDir: app.isPackaged
        ? join(process.resourcesPath, 'skills')
        : join(dirname(ENTRY_FILE), '..', '..', 'resources', 'skills'),
    })
    await skills.init()
    settings = readySettings
    const guide = new GuideProgressStore(readySettings)
    manager = new WindowManager(readySettings, exampleCollection, guide)
    // Removing the example (ticket 10): the one destructive call is the system's move to the Bin,
    // on the fixed path. A run with the e2e flag never reaches the real Bin (`resolveExampleTrash`).
    const exampleWindows = manager
    manager.exampleRemoval = new ExampleRemoval({
      documentsDir: exampleDocumentsDir,
      bundledDir: exampleBundledDir,
      store: readySettings,
      trash: resolveExampleTrash({
        isPackaged: app.isPackaged,
        env: process.env,
        systemTrash: (path) => shell.trashItem(path),
        harnessTrash: moveIntoHarnessBin,
      }),
      closeWindows: (root) => exampleWindows.closeExampleWindows(root),
      ownLocksReleased: (root) => exampleWindows.exampleLocksReleased(root),
      log: (event, details) => { void recordMainProcessDiagnostic(event, details) },
    })
    // T6: a shortcut reassignment must relabel the native menu's displayed accelerators live —
    // the closure reads manager.refreshMenu lazily, since it is assigned just below.
    registerCliInstallIpc(ipcMain, bundleIdentifierFor(readRunningAppMetadata()))
    // Sharing (0.24 ticket 02): the set-up steps and Settings › Sharing. The token and this Mac's key
    // live in the secrets store (Keychain); settings.json keeps only the non-secret record.
    const sharingSecrets = openSecretsStore(app.getPath('userData'), app.isPackaged && process.env.WRITEFLEX_E2E === '1')
    const sharingSetup = openSharingSetup({
      secrets: sharingSecrets,
      record: { read: () => readySettings.sharingRecord(), write: (record) => readySettings.setSharingRecord(record) },
      distDir: app.isPackaged
        ? join(process.resourcesPath, SHARING_SERVICE_DIST_DIR)
        : join(dirname(ENTRY_FILE), '..', '..', SHARING_SERVICE_DIST_DIR),
      packaged: app.isPackaged,
      env: process.env,
    })
    const isAppWindow = (senderId: number): boolean => { if (settingsContents()?.id === senderId) return true; try { stateForSender(senderId); return true } catch { return false } }
    registerSharingIpc(ipcMain, sharingSetup, {
      openExternal: (url) => { if (process.env.WRITEFLEX_E2E !== '1') void shell.openExternal(url) },
      // Only a renderer WriteFlex registered as one of its windows (state.ts) is answered.
      isAppWindow,
      changed: () => {
        for (const state of allStates()) if (!state.window.isDestroyed()) state.window.webContents.send('sharing:changed')
      },
    })
    // Sharing a piece (0.24 ticket 03): the publisher, subscribed at the common post-save point.
    const sharingE2e = !app.isPackaged && process.env.WRITEFLEX_E2E === '1'
    const sharingPublisher = createSharingPublisher({
      workspaceRoots: { read: () => readySettings.sharingWorkspaceRoots(), write: (roots) => readySettings.setSharingWorkspaceRoots(roots) },
      openRoots: () => allStates().flatMap((state) => state.workspace ? [state.workspace.root] : []),
      records: { read: () => readySettings.sharingLinks(), write: (links) => readySettings.setSharingLinks(links) },
      secrets: sharingSecrets,
      access: () => sharingSetup.serviceAccess(),
      client: createServiceClient({ fetch: (input, init) => fetch(input, init) }),
      // No picture is fetched from another site in a test run.
      render: (root, path, imagePath) => renderPieceForSharing(root, path, imagePath, sharingE2e ? {} : { fetchRemote: safeRemotePictureFetch({ resolveHost: lookupHost, get: pinnedGet }) }),
      // A Folio link (ticket 09): each part through the same rendering and the same picture guard.
      renderFolio: (root, dir, imagePath, kept) => renderFolioLink(root, dir, imagePath, kept, sharingE2e ? {} : { fetchRemote: safeRemotePictureFetch({ resolveHost: lookupHost, get: pinnedGet }) }),
      changed: () => {
        for (const state of allStates()) if (!state.window.isDestroyed()) state.window.webContents.send('sharing:changed')
        readerLinksChanged()
      },
      exists: (root, path) => existsSync(resolve(root, path)),
    })
    // Ticket 04: the share follows a rename or move (the app's own, a request's, the agent's), ends with
    // the Trash; both told before the save signal.
    onDocumentsMoved((root, from, to) => { sharingPublisher.moved(root, from, to) })
    onDocumentsTrashed((root, paths) => { void sharingPublisher.trashed(root, paths) })
    // Ticket 04 (ruling R-A, R-B): a shared piece renamed, moved or gone outside WriteFlex (the workspace
    // watcher). It follows only the same file; gone or unreadable, it is "not found", never removed.
    const outsideChanges = createOutsideChangeFollower({
      followed: () => sharingPublisher.followed(),
      moved: (root, from, to) => sharingPublisher.moved(root, from, to),
      notFound: (root, path, why) => sharingPublisher.notFound(root, path, why),
      found: (root, path, id) => sharingPublisher.found(root, path, id),
      offer: (root, path, to) => sharingPublisher.offer(root, path, to),
      saved: (root, paths) => sharingPublisher.saved(root, paths),
    })
    onDocumentsChangedOutside((root, paths) => { void outsideChanges.changed(root, paths) })
    onSharingIdentityChanged((root) => sharingPublisher.invalidateSharingIdentity(root))
    onDocumentsChanged((root, paths) => sharingPublisher.saved(root, paths))
    // Ticket 04 (R-D): a Collection opened again: its shares are looked at (changed, gone, moved while closed).
    onWorkspaceOpened((root) => { void sharingPublisher.reconcile(root) })
    // Ticket 04: a move or Trash the command line made with the Collection closed here, left as a signal
    // (sharing-follow-signals.ts S3). A signal removed unapplied is reported by why and generation only.
    const followSignals = watchFollowSignals(app.getPath('userData'), (signal) => applyFollowSignal(sharingPublisher, signal), {
      report: (entry) => { void recordMainProcessDiagnostic('sharing.follow-signal-removed', entry) },
    })
    // Ticket 04: owed removals finish, saves queued before a quit or while offline go out once, and every
    // share is looked at (R-D); then a signal still held is removed (S4). The network tried again whenever the Mac wakes.
    void takeAtStart(followSignals, () => sharingPublisher.resume())
    powerMonitor.on('resume', () => { void followSignals.take().finally(() => sharingPublisher.reconnected()) })
    // Synced Collections (OneDrive): what sync delivered while the Mac slept is reconciled (sync-replica-session.ts).
    powerMonitor.on('resume', () => { reconcileSyncedCollectionsAfterWake() })
    // Readers' notes into the margin (0.24 ticket 07): the links and their owner tokens stay in main.
    const notesClient = createServiceClient({ fetch: (input, init) => fetch(input, init) })
    setReaderNotesSource({
      refresh: (root) => sharingPublisher.refresh(root),
      claimAccept: (base, id, owner, key, claim) => notesClient.claimNote(base, id, owner, key, claim),
      releaseAccept: (base, id, owner, key, claim, force, at) => notesClient.releaseClaim(base, id, owner, key, claim, force, at),
      links: (root) => sharingPublisher.noteSources(root),
      replyVisibility: (root, shareId) => sharingPublisher.shownNotes(root, shareId),
      shareIds: () => sharingPublisher.noteShareIds(),
      fetchNotes: async (base, shareId, owner) => {
        const answer = await notesClient.noteState(base, shareId, owner)
        if (answer.kind === 'ok' && rememberReaderClaims(shareId, answer.body.notes)) {
          for (const state of allStates()) if (!state.window.isDestroyed()) state.window.webContents.send('changes:changed', null)
        }
        return answer
      },
      markCollected: (base, shareId, owner, keys) => notesClient.collected(base, shareId, owner, keys),
      // Ticket 08: outcomes and replies back to the link each note came through (sharing-reader-replies.ts).
      sendOutcomes: (base, shareId, owner, items) => notesClient.outcomes(base, shareId, owner, items),
    })
    registerSharingPieceIpc(ipcMain, sharingPublisher, {
      isAppWindow,
      rootFor: (senderId) => { try { return stateForSender(senderId).workspace?.root ?? null } catch { return null } },
      openExternal: (url) => { if (process.env.WRITEFLEX_E2E !== '1') void shell.openExternal(url) },
      // Ticket 07: the readers' records in the sending window's own review list (counts, Clear handled notes).
      readerNotes: async (senderId) => {
        let changes: Awaited<ReturnType<NonNullable<ReturnType<typeof stateForSender>['changes']>['list']>> | null = null
        try { changes = (await stateForSender(senderId).changes?.list()) ?? null } catch { changes = null }
        return changes ? readerNoteRecords(changes) : null
      },
      // Review round 1 of ticket 11, F1: notes Clear handled notes took off the service, marked in that window's review list.
      readerNotesGone: async (senderId, shareId, keys) => stateForSender(senderId).changes?.markReaderNotesGone(shareId, keys, Date.now(), READER_CLOSED_KEPT),
    })
    const protectedWriters = new Set<number>()
    // What each window holds that a restart would cost (ADR-0054): text whose last save failed, and a document that
    // changed on disk with the person's choice not made yet. Only the renderer knows these; it reports two flags.
    const windowHolds = new Map<number, { unsaved: boolean; diskChoice: boolean }>()
    const anyWindowHolds = (key: 'unsaved' | 'diskChoice'): boolean => [...windowHolds.values()].some(h => h[key])
    // The backup helper's own cycles (scheduled ones too), read from the helper; set once its supervisor exists
    // below. Before that no helper process exists, so none can be cycling.
    let backupActivity: BackupRestartActivity | null = null
    // The restart's last step stops the helper (as a quit does): set with the supervisor, with how to start it again.
    let backupForRestart: { stop(): Promise<boolean>; resume(): void } | null = null
    // The app's side of the commit (restart-windows.ts): close every window, wait for their work, stop the helper
    // last, but only while the attempt is live; on call-off abandon what can be recalled and recover (idempotent).
    const restartClose = createRestartClose({
      closeEach: () => [...(manager?.closeAllForRestart() ?? []), ...closeSettingsForRestart(settingsApp?.settingsWindow() ?? null)],
      finishWork: () => waitForCleanupWithTimeout(waitForAgentDisposals(), 10_000, () => {
        recordMainProcessDiagnostic('update.restart.cleanup-timeout', { timeoutMs: 10_000 })
      }).then(() => {}),
      backup: () => backupForRestart,
      windowCount: () => BrowserWindow.getAllWindows().length,
      openWindow: () => { manager?.createWindow() },
      quitting: () => isQuitting(),
      log: (message) => console.log(`[updates] ${message}`),
    })
    onQuitCancelled(() => restartClose.quitCancelled())
    const updateNotices = installUpdateNotices({
      editorWindows: () => [...allStates().map(state => state.window), ...(settingsApp?.settingsWindow() ? [settingsApp.settingsWindow()!] : [])],
      isProtectedNow: () => protectedWriters.size > 0,
      // Read at the moment of asking: before the hand-over to Squirrel.Mac and in the same turn as the native quit.
      restartBlockers: () => {
        const backupHold = backupActivity?.hold() ?? 'none'
        return restartBlockers({
          focus: protectedWriters.size > 0,
          unsaved: anyWindowHolds('unsaved'),
          diskChoice: anyWindowHolds('diskChoice'),
          agent: restartHeld('agent'),
          // updateTestHeld: the update-test flavour's test hold (always false in a production build).
          exporting: restartHeld('exporting') || updateTestHeld(),
          sharing: sharingPublisher.inFlight(),
          // A Sync now (held while it runs), or a cycle the helper reports; not readable: held all the same.
          backup: restartHeld('backup') || backupHold === 'cycling',
          backupUnknown: backupHold === 'unknown',
          finishing: agentDisposalsPending(),
        })
      },
      refreshRestartBlockers: (maxAgeMs) => backupActivity?.refresh(maxAgeMs) ?? Promise.resolve(),
      // The restart's commit (ADR-0054): every window closes through its own close route (each writes its documents;
      // a failed write keeps it open and ends the restart), the closed windows' work is written, and the backup
      // helper stops last, as on a quit, so no new scheduled cycle begins before the install.
      closeWindowsForRestart: (restart) => (manager ? restartClose.close(restart) : Promise.resolve(false)),
      openWindows: () => BrowserWindow.getAllWindows().length,
      // Called when the attempt ends and again once what could not be called off has settled: backup resumed (after
      // a stop under way), and a window if none is left.
      restartAbandoned: () => restartClose.recover(),
      readConfig: () => ({
        updateNotices: readySettings.updateNotices(),
        updatesCheckForNewVersions: readySettings.get('updates.checkForNewVersions'),
        updatesAlphaVersions: readySettings.get('updates.alphaVersions'),
        hadConfiguration: hadUpdateConfiguration,
      }),
      writeConfig: patch => {
        if (patch.updateNotices) readySettings.setUpdateNotices(patch.updateNotices)
      },
      e2e: (!app.isPackaged || UPDATE_TEST_BUILD) && process.env.WRITEFLEX_E2E === '1',
    })
    const updates = updateNotices.checker
    ipcMain.handle('updates:protected', (event, active: unknown) => {
      if (!allStates().some(state => state.window.webContents.id === event.sender.id)) return
      if (active === true) protectedWriters.add(event.sender.id)
      else protectedWriters.delete(event.sender.id)
      updates.busyChanged()
    })
    // Two booleans, nothing else: a window can only say whether it holds unsaved text or an open disk choice.
    ipcMain.handle('updates:holds', (event, holds: unknown) => {
      if (!allStates().some(state => state.window.webContents.id === event.sender.id)) return
      const h = (typeof holds === 'object' && holds !== null ? holds : {}) as Record<string, unknown>
      const next = { unsaved: h.unsaved === true, diskChoice: h.diskChoice === true }
      if (next.unsaved || next.diskChoice) windowHolds.set(event.sender.id, next)
      else windowHolds.delete(event.sender.id)
      updateNotices.blockersChanged()
    })
    app.on('web-contents-created', (_event, contents) => {
      const clear = () => {
        if (protectedWriters.delete(contents.id)) updates.busyChanged()
        if (windowHolds.delete(contents.id)) updateNotices.blockersChanged()
      }
      contents.once('destroyed', clear)
      contents.on('render-process-gone', clear)
      contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) clear() })
    })
    const stopUpdateSettings = readySettings.onChange(key => { if (key === 'updates.checkForNewVersions' || key === 'updates.alphaVersions') updates.settingChanged() })
    app.once('will-quit', () => { updates.stop(); stopUpdateSettings() })

    const ipc = registerIpc(manager.router(), readySettings, skills, {
      appVersionLabel: `${app.getVersion()}${appVariant.versionLabelSuffix}`,
      guide,
      zoteroFound: () => probeZotero({ databasePath: zoteroDatabasePath, exists: existsSync }),
      isSettingsSender: (event) => Boolean(settingsApp?.isSettingsSender(event)),
      settingsWebContents: () => settingsApp?.settingsWebContents() ?? null,
      onAuthChanged: () => settingsApp?.slotsChanged(),
    })
    app.once('will-quit', () => { ipcDisposal = ipc.dispose() })
    gitSync = ipc.gitSync
    gitSync.start()
    sharedSettings.onPreferencesChanged((keys) => { for (const key of keys) readySettings.notifySharedChange(key); ipc.preferencesChanged(keys) })
    const windowManager = manager
    // The main window a menu command goes to: the focused one, else the last one focused, else a new one.
    let lastMainWindow: BrowserWindow | null = null
    const isMainWindow = (window: BrowserWindow | null): window is BrowserWindow =>
      Boolean(window && !window.isDestroyed() && allStates().some((state) => state.window === window))
    app.on('browser-window-focus', (_event, window) => { if (isMainWindow(window)) lastMainWindow = window })
    const mainWindow = (): BrowserWindow => {
      const focused = BrowserWindow.getFocusedWindow()
      if (isMainWindow(focused)) return focused
      if (isMainWindow(lastMainWindow)) return lastMainWindow
      return allStates().find((state) => !state.window.isDestroyed())?.window ?? windowManager.createWindow().window
    }
    settingsApp = installSettingsHost({
      shared: sharedSettings,
      slots: new AuthKeySlots(ipc.auth, () => settingsApp?.slotsChanged()),
      mainWindow,
      log: (line) => { void recordMainProcessDiagnostic('settings', { line }) },
    })
    // Keep the native frame's pre-paint colour in sync through resizes, reloads and OS changes.
    const refreshWindowBackgrounds = (): void => {
      const { editor, settings } = windowBackgrounds(readySettings.get(THEME_SETTING))
      for (const { window } of allStates()) {
        if (!window.isDestroyed()) window.setBackgroundColor(editor)
      }
      settingsApp?.settingsWindow()?.setBackgroundColor(settings)
    }
    nativeTheme.on('updated', refreshWindowBackgrounds)
    const stopAppearance = readySettings.onChange(key => {
      if (key === THEME_SETTING) refreshWindowBackgrounds()
    })
    app.once('will-quit', () => {
      nativeTheme.removeListener('updated', refreshWindowBackgrounds)
      stopAppearance()
    })
    manager.openSettings = (section) => {
      const source = allStates().find(state => state.window === BrowserWindow.getFocusedWindow())
        ?? allStates().find(state => state.window === lastMainWindow) ?? allStates()[0]
      retireSettingsContext()
      settingsContext = source ? { sender: source.window.webContents.id, root: source.workspace?.root ?? null } : null
      settingsApp?.openSettings(section)
      settingsApp?.settingsWebContents()?.send('wf-settings-window:context-changed')
    }
    closeSettings = () => settingsApp?.dispose() ?? Promise.resolve()
    // A main window asks for Settings (⌘, in the renderer, the palette, Read aloud settings…, a sign-in
    // button): the Settings window opens at the section named, when it is one of its pages.
    ipcMain.handle(OPEN_SETTINGS_CHANNEL, (event, section: unknown) => {
      if (event.senderFrame !== event.sender.mainFrame) throw new Error('Open Settings from the app window.')
      const source = stateForSender(event.sender.id)
      retireSettingsContext()
      settingsContext = { sender: event.sender.id, root: source.workspace?.root ?? null }
      settingsApp?.openSettings(typeof section === 'string' && SETTINGS_SECTIONS.has(section) ? section : undefined)
      settingsApp?.settingsWebContents()?.send('wf-settings-window:context-changed')
    })
    // The Settings window's Get started and Action bar rows run these app commands in the main window.
    ipcMain.handle('wf-settings-window:run-command', (event, id: unknown) => {
      if (!settingsApp?.isSettingsSender(event)) throw new Error('Only the Settings window may ask for this.')
      if (typeof id !== 'string' || !SETTINGS_PAGE_COMMANDS.has(id)) throw new Error('Unknown command.')
      const window = mainWindow()
      openMain(window)
      window.webContents.send(MENU_COMMAND_CHANNEL, id)
    })
    // Copies of widget files opened in the browser live only as long as the app (widget-open.ts).
    app.once('will-quit', removeOpenedWidgetCopiesSync)
    // Automatic backup (backup-helper/enrolment.ts): off unless this Mac's user turned it on for a folder in
    // Settings › Backup. Both the control lane (status, Sync now) and the editor receipts are built from one
    // trial configuration for the registered folders (active-services.ts) and rebuilt when that changes; with
    // none registered they answer `disabled`, no socket is opened, no helper runs and every save is as before.
    // A window's folder is main's own state. A window's receipt owner is retired when its page is replaced,
    // its renderer dies, it closes or a Collection is bound to it, so a later call from it gets a new owner.
    const windowRoot = (senderId: number): string | null => { if (settingsContents()?.id === senderId) return settingsRoot(); try { return stateForSender(senderId).workspace?.root ?? null } catch { return null } }
    const backupServices = createActiveBackupServices({
      make: (trial) => ({
        helper: createBackupHelperService({ trial, windowRoot }),
        receipts: createBackupReceiptService({ trial, receiptsDir: join(app.getPath('userData'), 'backup-receipts'), windowRoot, startTime: readProcessStartTime }),
      }),
      onChanged: () => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(BACKUP_ENROLMENT_CHANNELS.changed) },
    })
    const backupHelper = backupServices.helper
    // A Sync now holds an update's restart until its cycle answers (ADR-0054).
    registerBackupHelperIpc(ipcMain, { ...backupHelper, syncNow: (senderId) => duringRestartHold('backup', () => backupHelper.syncNow(senderId)) })
    const backupReceipts = backupServices.receipts
    // The installed helper is a plain process with the backup program embedded in its executable.
    const backupHelperLaunch = app.isPackaged
      ? { command: standaloneHelperPath(process.resourcesPath) }
      : { command: process.execPath, entry: join(app.getAppPath(), BACKUP_HELPER_ENTRY) }
    const githubBindings = new Map<number, number>()
    const trustedGitHubBinding = (senderId: number): string | null => {
      try {
        if (settingsContents()?.id === senderId) return `${senderId}:${githubBindings.get(senderId) ?? 0}:${settingsRoot() ?? ''}`
        const state = stateForSender(senderId), contents = state.window.webContents
        const expected = process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../renderer/index.html')).toString()
        if (state.window.isDestroyed() || contents.isDestroyed() || contents.getURL() !== expected) return null
        return `${senderId}:${githubBindings.get(senderId) ?? 0}:${windowRoot(senderId) ?? ''}`
      } catch { return null }
    }
    const githubStore = createGitHubAuthStore(app.getPath('userData'), openSecretsStore(app.getPath('userData'), packagedSmokeRequested(process.env), githubSecretsFiles()), BACKUP_GITHUB_CONFIG?.clientId ?? null)
    let backupEnrolment: ReturnType<typeof createBackupEnrolment>
    let lastAuthGeneration = ''
    let githubStarted = false
    const githubAuth = createGitHubAuth({
      config: BACKUP_GITHUB_CONFIG, store: githubStore, binding: trustedGitHubBinding, root: windowRoot,
      supervisor: () => githubSupervisor,
      holdBackups: () => backupServices.holdCopyGuard(),
      open: url => shell.openExternal(url), copy: () => {},
      changed: () => {
        settingsContents()?.send(BACKUP_GITHUB_CHANNELS.changed)
        for (const state of allStates()) if (!state.window.isDestroyed()) state.window.webContents.send(BACKUP_GITHUB_CHANNELS.changed)
        const gate = githubStore.gate.state(), generation = gate ? `${gate.epoch}:${gate.generation}:${gate.phase}` : 'unknown'
        if (generation !== lastAuthGeneration) {
          lastAuthGeneration = generation
          if (githubStarted && backupEnrolment) void backupEnrolment.startup().catch(() => recordMainProcessDiagnostic('backup-github-reconfigure', { message: 'Backup remains held after account state changed' }))
        }
      },
    })
    const githubSupervisor = createHelperSupervisor({ ...backupHelperLaunch, historyApprovalFile: join(realpathSync(app.getPath('userData')), 'backup-helper', HISTORY_APPROVAL_BASENAME), credentials: args => githubAuth.credentials(args), exposure: githubAuth.exposure })
    // An update's restart reads the helper's own cycles (ADR-0054): any helper of this app that runs, or may start
    // again on its own, is asked; its answer counts for 15 s; an answer it cannot give holds the restart.
    backupActivity = createBackupRestartActivity({
      helperMayRun: () => githubSupervisor.ownedChildren().some((child) => child.status === 'live') || (githubSupervisor.state().state !== 'stopped' && githubSupervisor.state().state !== 'failed'),
      read: () => backupHelper.activity?.() ?? Promise.resolve('unknown' as const),
      now: () => Date.now(),
    })
    backupForRestart = {
      // Stopped means the helper exited; an overdue stop ('stop-overdue') may still capture, so the restart is called
      // off. Its process handle is let go a moment after the exit: wait (up to 2 s) until no child of ours is live.
      stop: async () => {
        if ((await githubSupervisor.stop()).state !== 'stopped') return false
        const live = (): boolean => githubSupervisor.ownedChildren().some((child) => child.status === 'live')
        for (let i = 0; i < 40 && live(); i++) await new Promise((done) => setTimeout(done, 50))
        return !live()
      },
      // Fenced against a quit: never started once quitting, and a start already under way when the quit came is stopped.
      resume: () => {
        if (isQuitting()) return
        void backupEnrolment.startup()
          .then(() => {
            if (!isQuitting()) return
            void githubSupervisor.stop().catch(() => {})
            restartClose.backupStoppedForQuit()
          })
          .catch(() => recordMainProcessDiagnostic('backup-restart-resume', { message: 'Backup could not start again after an update restart was called off' }))
      },
    }
    registerGitHubIpc(ipcMain, githubAuth, event => {
      try { return Boolean(settingsApp?.isSettingsSender(event as Electron.IpcMainInvokeEvent)) || (trustedGitHubBinding(event.sender.id) !== null && stateForSender(event.sender.id).window.webContents === event.sender) } catch { return false }
    })
    const retireGitHubSender = (id: number) => { githubBindings.set(id, (githubBindings.get(id) ?? 0) + 1); githubAuth.retireSender(id) }
    backupEnrolment = createBackupEnrolment({
      dir: join(app.getPath('userData'), 'backup-helper'),
      windowRoot,
      helperEntry: () => backupHelperLaunch.entry ?? backupHelperLaunch.command,
      supervisor: githubSupervisor,
      githubBinding: vault => githubAuth.githubBinding(vault),
      githubUncertainty: () => githubStore.blocked() || githubStore.gate.debts().length > 0 || githubSupervisor.ownedChildren().length > 0,
      services: backupServices,
      shortRuntimeBase: join(tmpdir(), `writeflex-backup-${process.getuid?.() ?? 0}`),
    })
    retireSettingsContext = () => {
      const id = settingsContents()?.id
      if (id !== undefined) { backupEnrolment.retireSender(id); retireGitHubSender(id) }
    }
    ipcMain.handle('wf-settings-window:menu-focus', (event, plain: unknown) => {
      if (!settingsApp?.isSettingsSender(event)) throw new Error('Only Settings may publish its focus.')
      const window = BrowserWindow.fromWebContents(event.sender)
      if (window) noteSettingsMenuFocus(window, plain === true ? 'plain-text-field' : 'other')
    })
    ipcMain.handle('wf-settings-window:context', (event) => {
      if (!settingsApp?.isSettingsSender(event)) throw new Error('Only Settings may read its context.')
      return { root: settingsRoot() }
    })
    registerBackupEnrolmentIpc(ipcMain, backupEnrolment)
    app.once('will-quit', () => { githubAuth.quit(); backupEnrolment.quit(); void backupServices.dispose() })
    void githubAuth.startup().then(() => { githubStarted = true; return backupEnrolment.startup() }).catch((error: unknown) => recordMainProcessDiagnostic('backup-enrolment-startup', { message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) }))
    registerBackupReceiptIpc(ipcMain, backupReceipts)
    setSaveReceiptPort(backupReceipts)
    setNonAtomicWritePolicy((root) => backupReceipts.nonAtomicPolicy(root))
    // A window's backup preview (enrolment.ts) is void on the same events: it was bound to that page and folder binding.
    app.on('web-contents-created', (_event, contents) => {
      contents.on('did-navigate', () => { backupReceipts.retireSender(contents.id); backupEnrolment.retireSender(contents.id); retireGitHubSender(contents.id) })
      contents.on('render-process-gone', () => { backupReceipts.retireSender(contents.id); backupEnrolment.retireSender(contents.id); retireGitHubSender(contents.id) })
    })
    onWindowWorkspaceBound((webContentsId) => { backupReceipts.retireSender(webContentsId); backupEnrolment.retireSender(webContentsId); retireGitHubSender(webContentsId) })
    manager.onWindowClosed = (webContentsId) => { ipc.evictWindow(webContentsId); backupHelper.disposeWindow(webContentsId); backupReceipts.retireSender(webContentsId); backupEnrolment.retireSender(webContentsId); retireGitHubSender(webContentsId) }
    // The menu lists pins and recents. Whether the example's entry for its fixed path is hidden
    // there follows one asynchronous look at that path; the menu is rebuilt if the answer changed.
    const buildMenu = (): void => {
      const next = buildAppMenu(manager!, readySettings)
      if (Menu.getApplicationMenu() !== next) Menu.setApplicationMenu(next)
    }
    manager.refreshMenu = () => {
      buildMenu()
      const before = exampleCollection.shownRoot()
      void exampleCollection.current().then((now) => { if (now !== before) buildMenu() })
    }
    manager.refreshMenu()
    app.on('browser-window-focus', (_event, window) => { noteFocusedWindow(window); updateCollectionMenu() })
    app.on('browser-window-blur', updateCollectionMenu)
    app.on('browser-window-created', (_event, window) => {
      window.once('closed', updateCollectionMenu)
      window.on('enter-full-screen', updateCollectionMenu)
      window.on('leave-full-screen', updateCollectionMenu)
    })

    const launchPaths = pathsFromArgv(process.argv)
    const envFolder = process.env.WRITEFLEX_OPEN_FOLDER?.trim()
    if (envFolder) launchPaths.unshift(resolve(envFolder))
    launchPaths.push(...bufferedFiles)
    bufferedFiles.length = 0
    const launchUrls = bufferedUrls.splice(0)

    for (const candidate of launchPaths) await routePath(manager, null, candidate)
    for (const url of launchUrls) await handleWriteflexUrl(manager, readySettings, url)
    if (BrowserWindow.getAllWindows().length === 0) {
      const initialState = manager.createWindow() // start screen
      if (packagedSmoke) {
        initialState.window.webContents.once('did-finish-load', () => {
          void initialState.window.webContents.executeJavaScript(packagedSmokeIpcProbe, true)
            .then((ipcVersion: unknown) => {
              if (ipcVersion !== app.getVersion()) {
                throw new Error(`IPC version mismatch: expected ${app.getVersion()}, received ${String(ipcVersion)}.`)
              }
              console.log(packagedSmokeReceipt({
                ipcVersion,
                userData: app.getPath('userData'),
                version: app.getVersion(),
                visible: initialState.window.isVisible(),
              }))
              exitPackagedSmoke((code) => app.exit(code), 0)
            })
            .catch((error: unknown) => {
              console.error(`WRITEFLEX_SMOKE_ERROR=${error instanceof Error ? error.message : String(error)}`)
              exitPackagedSmoke((code) => app.exit(code), 1)
            })
        })
      }
    }

    if (typeof __WF_UPDATE_TEST__ === 'boolean' && __WF_UPDATE_TEST__) startUpdateTestControl()
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) manager!.createWindow() })
  })

  // ⌘Q sets the intent BEFORE windows get their 'close' events; the dirty-close guard may pause a
  // window for its Save-All sheet (cancelling the quit) — this lets the quit resume once the last
  // window has actually gone. The guard resets the intent if the writer cancels a close.
  app.on('before-quit', () => {
    setQuitting(true)
    recordMainProcessDiagnostic('app.before-quit', { windows: BrowserWindow.getAllWindows().length })
  })
  app.on('window-all-closed', () => {
    recordMainProcessDiagnostic('app.window-all-closed', { quitting: isQuitting() })
    if (isQuitting() || process.platform !== 'darwin') app.quit()
  })
  app.on('quit', () => {
    readingRoom?.close()
    readingRoom = null
  })
  let agentShutdownFlushed = false
  app.on('will-quit', (event) => {
    recordMainProcessDiagnostic('app.will-quit', { reentry: agentShutdownFlushed })
    if (agentShutdownFlushed) return
    event.preventDefault()
    const startedAt = Date.now()
    const agentCleanup = waitForCleanupWithTimeout(waitForAgentDisposals(), 1500, () => {
      recordMainProcessDiagnostic('app.will-quit.cleanup-timeout', { timeoutMs: 1500 })
      console.warn('[WriteFlex] Agent cleanup exceeded 1500 ms; continuing quit. See main-process.log.')
    })
    void Promise.all([agentCleanup, gitSync?.stop()]).then(async ([outcome]) => {
      // Await this final line: the serialised logger first persists any queued timeout warning, then this
      // settlement, before the second app.quit() ends the process.
      await recordMainProcessDiagnostic('app.will-quit.cleanup-settled', { outcome, elapsedMs: Date.now() - startedAt })
      // Every window has closed and its writes have settled (or timed out): remove each Collection's
      // reply key, so the command line on this computer writes directly. A key left by a quit that
      // outran this is ignored, because its presence record names this process, which will be gone.
      await waitForCleanupWithTimeout(manager?.openCollections.closeAll() ?? Promise.resolve(), 1000, () => {
        recordMainProcessDiagnostic('app.will-quit.close-collections-timeout', { timeoutMs: 1000 })
      })
      await ipcDisposal
      try { await closeSettings() }
      catch { await recordMainProcessDiagnostic('settings.close.failed', { message: 'Settings flush failed during quit' }) }
      finally {
        agentShutdownFlushed = true
        // The packaged smoke runs with piped stdio; Electron can retain the process after app.exit even
        // though its window and cleanup work have finished. End only this fenced process after the same
        // awaited cleanup and durable diagnostic that a normal quit uses.
        app.quit()
      }
    })
  })
}

function readRunningAppMetadata(): unknown {
  try {
    return JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/** Route one path: directories open as a Workspace, files promote their resolved root. */
async function routePath(manager: WindowManager, from: WindowState | null, candidate: string, line?: number): Promise<void> {
  try {
    const kind = classifyOpenPath(candidate)
    if (kind === 'folder') await manager.openFolder(from, candidate)
    else if (kind === 'file') await manager.openFile(from, candidate, line)
  } catch {
    // A path that vanished between resolution and open is not worth surfacing.
  }
}

/** Parse and validate an external browser link before handing its path to the one open funnel. */
async function handleWriteflexUrl(manager: WindowManager, settings: SettingsStore, rawUrl: string): Promise<void> {
  if (settings.get('integration.browserLinks') === false) {
    await recordMainProcessDiagnostic('app.open-url.ignored', { reason: 'Disabled in Settings.' })
    return
  }
  const parsed = parseWriteflexUrl(rawUrl)
  if ('error' in parsed) {
    await recordMainProcessDiagnostic('app.open-url.refused', { reason: parsed.error })
    return
  }
  const kind = classifyOpenPath(parsed.path)
  if (!kind) {
    await recordMainProcessDiagnostic('app.open-url.refused', { reason: 'Path is not an existing file or folder.' })
    return
  }
  await recordMainProcessDiagnostic('app.open-url.accepted', { kind })
  await routePath(manager, focusedState(), parsed.path, parsed.line)
}

/** Existing, resolvable, non-cwd paths from a process argv (skips flags and the app-entry cwd token). */
function pathsFromArgv(argv: string[]): string[] {
  const out: string[] = []
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue
    if (/^writeflex:/i.test(arg)) continue
    const candidate = resolve(arg)
    if (candidate === ENTRY_FILE || candidate === BOOTSTRAP_FILE) continue // the app's own entry script, not a document to open
    if (candidate === process.cwd()) continue
    if (!existsSync(candidate)) continue
    out.push(candidate)
  }
  return out
}

function writeflexUrlsFromArgv(argv: string[]): string[] {
  return argv.slice(1).filter((arg) => /^writeflex:/i.test(arg))
}

function focusedState(): WindowState | null {
  const window = BrowserWindow.getFocusedWindow()
  if (!window) return null
  return allStates().find((state) => state.window === window) ?? null
}

function focusAnyWindow(): void {
  if (process.env.WRITEFLEX_E2E === '1') return
  const [window] = BrowserWindow.getAllWindows()
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.focus()
}

// Memory-only diagnostics for bounded native delivery probes; no IPC or private document data.
export { readerDeliveryReceipts } from './reading-room-resources'
export { readerPolicyReceipts } from './reading-room-policy'

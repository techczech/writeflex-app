import { app, BrowserWindow, ipcMain, Menu, powerMonitor, protocol, shell } from 'electron'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { createOutsideChangeFollower } from './sharing-outside-changes'
import { applyFollowSignal, takeAtStart, watchFollowSignals } from './sharing-follow-signals'
import { onDocumentsChanged, onDocumentsChangedOutside, onDocumentsMoved, onDocumentsTrashed, onWorkspaceOpened, registerIpc } from './ipc'
import { SettingsStore } from './settings'
import { WindowManager } from './windows'
import { buildAppMenu, updateCollectionMenu } from './menu'
import { allStates, isQuitting, setQuitting, stateForSender, waitForAgentDisposals, type WindowState } from './state'
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
import { bundleIdentifierFor } from './cli/shim'
import { exitPackagedSmoke, packagedSmokeIpcProbe, packagedSmokeReceipt, packagedSmokeRequested } from './packaged-smoke'
import { applyMainFrameOnly } from './ipc-main-frame-only'
import { removeOpenedWidgetCopiesSync } from './widget-open'
import { applyWidgetNetworkSwitches } from './widget-network'
import { openSecretsStore } from './secrets-store-electron'
import { openSharingSetup, registerSharingIpc } from './sharing-ipc'
import { SHARING_SERVICE_DIST_DIR } from './sharing-service-bundle'
import { createSharingPublisher } from './sharing-publisher'
import { readerLinksChanged, setReaderNotesSource } from './sharing-reader-notes-run'
import { READER_CLOSED_KEPT, readerNoteRecords } from './sharing-reader-notes'
import { createServiceClient } from './sharing-client'
import { renderPieceForSharing } from './sharing-render'
import { renderFolioLink } from './sharing-folio'
import { lookupHost, pinnedGet, safeRemotePictureFetch } from './sharing-remote-pictures'
import { registerSharingPieceIpc } from './sharing-piece-ipc'

// Before any module registers an IPC listener: only a window's top frame is ever answered, so a frame
// inside it (a widget, ticket 02) can reach no handler even if a later change gave subframes IPC.
applyMainFrameOnly(ipcMain, { log: (line) => { console.warn(line); void recordMainProcessDiagnostic('ipc.refused', { line }) } })
// Before `ready`: no DNS prefetch and no hyperlink auditing in any renderer (widget-network.ts).
applyWidgetNetworkSwitches(app.commandLine)

// This must remain before the single-instance lock and every userData read: Electron scopes the lock
// and all early stores to this path, so moving it later would bind a beta run to production state.
const appVariant = resolveAppVariant(readRunningAppMetadata())
app.setPath('userData', join(app.getPath('appData'), appVariant.userDataDirectoryName))
const packagedSmoke = packagedSmokeRequested(process.env)

protocol.registerSchemesAsPrivileged([
  { scheme: 'wf-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])
void app.setAsDefaultProtocolClient('writeflex')

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
  if (!app.isPackaged) app.commandLine.appendSwitch('use-mock-keychain')
}

// The running main-process entry script (argv[1] under `electron <entry> …`). It is the app itself,
// never a document — excluding it from launch paths keeps a bare launch (no folder/file arg) on the
// start screen instead of resolving the app's own repo as a Workspace via the .git walk-up.
const ENTRY_FILE = fileURLToPath(import.meta.url)

// One instance owns the Snapshot Store per Workspace; a second launch hands its paths to the first.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let manager: WindowManager | null = null
  let settings: SettingsStore | null = null
  let readingRoom: { close(): void } | null = null
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
    readingRoom = await registerReadingRoom()
    // The Example collection (ADR-0043) lives at one fixed path under the Documents directory,
    // which comes from this one function. A run with the e2e flag never sees the real one: it gets
    // WRITEFLEX_E2E_DOCUMENTS (unpackaged only) or nothing at all.
    let example: ExampleCollection | null = null
    const readySettings = new SettingsStore(join(app.getPath('userData'), 'settings.json'), {
      shownExampleRoot: () => example?.shownRoot() ?? null,
    })
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
    // No timer runs while the machine sleeps, so on waking every owner-lock heartbeat is as old as the
    // sleep was long. Rewrite them at once rather than up to a heartbeat interval later.
    powerMonitor.on('resume', () => { void manager?.ownership.refreshNow() })
    // T6: a shortcut reassignment must relabel the native menu's displayed accelerators live —
    // the closure reads manager.refreshMenu lazily, since it is assigned just below.
    registerCliInstallIpc(ipcMain, bundleIdentifierFor(readRunningAppMetadata()))
    // Sharing (0.24 ticket 02): the set-up steps and Settings › Sharing. The token and this Mac's key
    // live in the secrets store (Keychain); settings.json keeps only the non-secret record.
    const sharingSecrets = openSecretsStore(app.getPath('userData'))
    const sharingSetup = openSharingSetup({
      secrets: sharingSecrets,
      record: { read: () => readySettings.sharingRecord(), write: (record) => readySettings.setSharingRecord(record) },
      distDir: app.isPackaged
        ? join(process.resourcesPath, SHARING_SERVICE_DIST_DIR)
        : join(dirname(ENTRY_FILE), '..', '..', SHARING_SERVICE_DIST_DIR),
      packaged: app.isPackaged,
      env: process.env,
    })
    const isAppWindow = (senderId: number): boolean => { try { stateForSender(senderId); return true } catch { return false } }
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
    // Readers' notes into the margin (0.24 ticket 07): the links and their owner tokens stay in main.
    const notesClient = createServiceClient({ fetch: (input, init) => fetch(input, init) })
    setReaderNotesSource({
      links: (root) => sharingPublisher.noteSources(root),
      shareIds: () => sharingPublisher.noteShareIds(),
      fetchNotes: (base, shareId, owner) => notesClient.notes(base, shareId, owner),
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
    const ipc = registerIpc(manager.router(), readySettings, skills, {
      appVersionLabel: `${app.getVersion()}${appVariant.versionLabelSuffix}`,
      guide,
      zoteroFound: () => probeZotero({ databasePath: zoteroDatabasePath, exists: existsSync }),
      onSettingChanged: (key) => {
        if (key === 'shortcuts.overrides') manager?.refreshMenu?.()
      },
    })
    app.once('will-quit', ipc.dispose)
    // Copies of widget files opened in the browser live only as long as the app (widget-open.ts).
    app.once('will-quit', removeOpenedWidgetCopiesSync)
    manager.onWindowClosed = ipc.evictWindow
    // The menu lists pins and recents. Whether the example's entry for its fixed path is hidden
    // there follows one asynchronous look at that path; the menu is rebuilt if the answer changed.
    const buildMenu = (): void => Menu.setApplicationMenu(buildAppMenu(manager!, readySettings))
    manager.refreshMenu = () => {
      buildMenu()
      const before = exampleCollection.shownRoot()
      void exampleCollection.current().then((now) => { if (now !== before) buildMenu() })
    }
    manager.refreshMenu()
    app.on('browser-window-focus', updateCollectionMenu)
    app.on('browser-window-blur', updateCollectionMenu)

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

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) manager!.createWindow() })
  })

  // ⌘Q sets the intent BEFORE windows get their 'close' events; the dirty-close guard may pause a
  // window for its Save-All sheet (cancelling the quit) — this lets the quit resume once the last
  // window has actually gone. The guard resets the intent if the writer cancels a close.
  app.on('before-quit', () => {
    setQuitting(true)
    recordMainProcessDiagnostic('app.before-quit', { windows: BrowserWindow.getAllWindows().length })
  })
  app.on('window-all-closed', () => { if (isQuitting() || process.platform !== 'darwin') app.quit() })
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
    void waitForCleanupWithTimeout(waitForAgentDisposals(), 1500, () => {
      recordMainProcessDiagnostic('app.will-quit.cleanup-timeout', { timeoutMs: 1500 })
      console.warn('[WriteFlex] Agent cleanup exceeded 1500 ms; continuing quit. See main-process.log.')
    }).then(async (outcome) => {
      // Await this final line: the serialised logger first persists any queued timeout warning, then this
      // settlement, before the second app.quit() ends the process.
      await recordMainProcessDiagnostic('app.will-quit.cleanup-settled', { outcome, elapsedMs: Date.now() - startedAt })
      // Every window has closed and its writes have settled (or timed out): give each Collection up,
      // so the command line can write directly. A lock left by a quit that outran this is recovered
      // by the next owner, because this process will be gone.
      await waitForCleanupWithTimeout(manager?.ownership.releaseAll() ?? Promise.resolve(), 1000, () => {
        recordMainProcessDiagnostic('app.will-quit.owner-lock-timeout', { timeoutMs: 1000 })
      })
      agentShutdownFlushed = true
      // The packaged smoke runs with piped stdio; Electron can retain the process after app.exit even
      // though its window and cleanup work have finished. End only this fenced process after the same
      // awaited cleanup and durable diagnostic that a normal quit uses.
      app.quit()
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
    if (candidate === ENTRY_FILE) continue // the app's own entry script, not a document to open
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
  const [window] = BrowserWindow.getAllWindows()
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.focus()
}

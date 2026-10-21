import { app, BrowserWindow, dialog, shell, type Rectangle } from 'electron'
import { join, dirname, relative, basename, sep } from 'node:path'
import { hostname } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerWindow, allStates, setQuitting, waitForAgentDisposals, type WindowState } from './state'
import { waitForRequestDisposals } from './request-inbox-watch'
import { bindWorkspace, flushPendingFocus, type OpenPathRouter } from './ipc'
import { normaliseRoot, resolveWorkspaceRoot, WorkspaceRootError } from './root-resolution'
import { createCloseController, shouldGuardClose, type CloseStallKind } from './window-close'
import type { SettingsStore } from './settings'
import { forwardBrowserWindowFocus } from './window-focus'
import { decideFrameNavigation, decideNavigation, navigationRefusalReason, type NavigationInitiator } from './navigation'
import { recordMainProcessDiagnostic } from './shutdown'
import { applyWidgetNetworkPolicy } from './widget-network'
import { attachKeyboardGate, isQuitKey } from './widget-keyboard'
import { isMarkdownPath } from './writeflex-url'
import type { ExampleCollection } from './example-collection'
import { EXAMPLE_OBJECTS_FILE, OBJECTS_LESSON } from '../shared/example-files'
import { e2eWriteHooksArguments } from '../shared/e2e-write-hooks'
import { EXAMPLE_CLOSE_MS, type ExampleRemoval, type ExampleRemovalPreview, type ExampleRemoveResult, type ExampleRestoreResult, type ExampleWindowsClosed } from './example-removal'
import { startScreenModel } from './start-screen-model'
import { GuideProgressStore } from './guide-progress-store'
import { lessonFileFor } from '../renderer/src/commands/guide-chapters'
import type { TaskGroup } from '../renderer/src/commands/command-task-groups'
import { REPLY_KEY_FOLDER } from './reply-key'
import { busyNotice, claimWithRetry, CollectionOwnership, lostNotice, unavailableNotice, type OwnershipChange } from './collection-ownership'
import type { OwnerLockBusyError } from './owner-lock'
import { createWindowSwitch, routeToExistingWindow, whenRendererReady, type CloseAttempt, type WindowSwitch, type WindowSwitchOutcome } from './window-switch'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Where a window is on screen, for the window that replaces it (the vault switcher, window-switch.ts). */
export type WindowPlacement = { bounds: Rectangle; fullScreen: boolean; maximized: boolean }

/** What the person is asked when a close has stalled (window-close.ts): the renderer is alive and has
 *  not said that every document is written, so the window is not closed without their say. */
const STALLED_CLOSE_COPY: Record<CloseStallKind, { message: string; detail: string; keep?: string }> = {
  'could-not-save': {
    message: 'WriteFlex could not save your text',
    detail: 'This window stopped working and some of what you typed could not be written to disk. If you close now, that typing is lost.',
    keep: 'Keep the window open',
  },
  'no-answer': {
    message: 'WriteFlex has not answered yet',
    detail: 'It is busy and has not saved your open documents. If you close now, the last few seconds of typing can be lost.',
  },
  'still-saving': {
    message: 'WriteFlex is still saving',
    detail: 'Your open documents have not finished saving. If you close now, the last few seconds of typing can be lost.',
  },
}

/**
 * Window-per-Workspace manager (ADR-0007). One BrowserWindow shows exactly one Workspace root; the
 * Snapshot Store is single-writer (Bridle ADR-0008), so a root already open focuses its window rather
 * than opening a second one on the same root.
 */
export class WindowManager {
  /** Set by index.ts after registerIpc so window-close evicts per-window IPC state (the broker map). */
  onWindowClosed?: (webContentsId: number) => void
  /** Set by index.ts to rebuild the app menu when recents change (Open Recent submenu). */
  refreshMenu?: () => void
  /** Set by index.ts: removing the Example collection and bringing it back (ticket 10). Its
   *  `closeWindows` port is `closeExampleWindows` below. */
  exampleRemoval?: Pick<ExampleRemoval, 'preview' | 'remove' | 'restore' | 'canRestore' | 'wasRemoved'>
  /** The example's window as it was found just before a removal, while its folder was still there to name it. */
  #exampleWindowBeforeRemoval: WindowState | undefined

  /** The Collection each window's owner lock was taken for, by webContents id. */
  readonly #ownedRoots = new Map<number, string>()
  /** The release of a closed window's owner lock still under way, by the root it was taken for. */
  readonly #releasing = new Map<string, Promise<void>>()

  constructor(
    private readonly settings: SettingsStore,
    /** The Example collection (ADR-0043): the one root that opens without being a Recent or a pin. */
    private readonly example?: Pick<ExampleCollection, 'current' | 'isRoot' | 'startFile' | 'view'> & Partial<Pick<ExampleCollection, 'shownRoot'>>,
    /** The Guide's progress (ticket 07): the first steps are recorded where the person does them. */
    readonly guide: GuideProgressStore = new GuideProgressStore(settings),
    /** One owner per Collection across processes (`.writeflex/owner.lock`); index.ts releases all on quit. */
    readonly ownership = new CollectionOwnership({ diagnostic: recordMainProcessDiagnostic, keyFolder: join(app.getPath('userData'), REPLY_KEY_FOLDER) }),
  ) {
    // The ownership module itself stops writes to a Collection whose lock this app does not hold;
    // this window manager only tells the user.
    ownership.watch((root, change) => this.#ownershipChanged(root, change))
  }

  /** Tell the user their saves to `root` are paused, in the message-box style of the busy-folder notice. */
  #ownershipChanged(root: string, change: OwnershipChange): void {
    void recordMainProcessDiagnostic(`owner-lock.writes-${change === 'regained' ? 'resumed' : 'paused'}`, { root, ...(change === 'regained' ? {} : { why: change }) })
    // A hidden e2e window must never raise a native dialog nobody can see.
    if (change === 'regained' || process.env.WRITEFLEX_E2E === '1') return
    const window = this.windowForRoot(root)?.window
    if (!window || window.isDestroyed()) return
    void dialog.showMessageBox(window, { type: 'warning', ...(change === 'lost' ? lostNotice(root) : unavailableNotice(root)), buttons: ['OK'], defaultId: 0 })
  }

  /** `placement`: the window is created hidden at that place, and whoever asked shows it (window-switch.ts). */
  createWindow(placement?: WindowPlacement): WindowState {
    // A test run must never take over the screen (AGENTS.md): under the e2e harness the window is
    // created hidden and nothing ever shows it — Playwright's firstWindow() attaches to a hidden
    // BrowserWindow perfectly well, and Electron's focus() is a no-op on an invisible window.
    //
    // backgroundThrottling:false is not optional here. A hidden or occluded window has its timers
    // and rAF throttled, which would make a spec flaky or — the worse outcome — falsely GREEN
    // against a runtime that is barely running. It is set only on this path, so a normal launch
    // keeps exactly the visible behaviour and timing it had.
    const e2e = process.env.WRITEFLEX_E2E === '1'
    const window = new BrowserWindow({
      ...(e2e || placement ? { show: false } : {}),
      width: 1440, height: 900, minWidth: 960, minHeight: 640,
      ...(placement ? placement.bounds : {}),
      // The pre-paint frame colour follows the persisted theme (Task 17) so a dark-mode relaunch
      // never flashes a light window while the renderer boots.
      title: 'WriteFlex', backgroundColor: this.settings.get('appearance.theme') === 'dark' ? '#1a1a1e' : '#f6f5f1',
      // Chrome 0.6 shelf (ADR-0026): x:16 follows the 12px padding + 4px inset; y:16 centres
      // the native 12px traffic lights in the 44px toolbar.
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 16 },
      webPreferences: {
        preload: join(__dirname, '../preload/index.mjs'),
        nodeIntegration: false, contextIsolation: true, sandbox: false,
        // The e2e write hooks (holds, failed saves) reach the renderer only in an unpackaged e2e run.
        additionalArguments: e2eWriteHooksArguments(process.env, app.isPackaged),
        ...(e2e ? { backgroundThrottling: false } : {})
      }
    })
    const state = registerWindow(window)
    const webContentsId = window.webContents.id
    forwardBrowserWindowFocus(window)
    const shellURL = process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
    let initialLoadFinished = false
    let lastEscapeRecovery = 0
    // Hidden e2e drives the real navigation decision but must not bring an external browser to the
    // foreground. Production keeps the same shell.openExternal path for both direct and new-window links.
    const openExternal = (url: string): void => {
      if (process.env.WRITEFLEX_E2E !== '1') void shell.openExternal(url)
    }
    const refuseNavigation = (event: Electron.Event, targetURL: string, eventName: string): void => {
      event.preventDefault()
      void recordMainProcessDiagnostic(eventName, { url: targetURL, reason: navigationRefusalReason(targetURL) })
    }
    // Which frame started a navigation (interactive-widgets-in-documents, ticket 02). A frame whose
    // properties can no longer be read counts as opaque: the refusing side.
    const initiatorOf = (frame: Electron.WebFrameMain | null | undefined): NavigationInitiator => {
      if (!frame) return 'none'
      try {
        const top = window.webContents.mainFrame
        if (frame === top || (frame.processId === top.processId && frame.routingId === top.routingId)) return 'top'
        return frame.origin === 'null' ? 'opaque' : 'other'
      } catch {
        return 'opaque'
      }
    }
    const frameIsOpaque = (frame: Electron.WebFrameMain | null | undefined): boolean => {
      if (!frame) return false
      try { return frame.origin === 'null' } catch { return true }
    }
    const parentIsOpaque = (frame: Electron.WebFrameMain | null | undefined): boolean => {
      try {
        const parent = frame?.parent
        if (!parent) return false
        const top = window.webContents.mainFrame
        if (parent === top || (parent.processId === top.processId && parent.routingId === top.routingId)) return false
        return parent.origin === 'null'
      } catch {
        return true
      }
    }
    const handleNavigation = (event: Electron.Event<{ initiator?: Electron.WebFrameMain | null }>, targetURL: string): void => {
      // The top window is moved by itself or by the app, never by a frame inside it (a widget).
      const initiator = initiatorOf(event.initiator)
      if (decideFrameNavigation({ isMainFrame: true, isSameDocument: false, initiator, frameOpaque: false, url: targetURL }) === 'refuse') {
        event.preventDefault()
        void recordMainProcessDiagnostic('window.navigation.refused', { url: targetURL, reason: `Started by a frame inside the window (${initiator}).` })
        return
      }
      const decision = decideNavigation(shellURL, targetURL)
      if (decision === 'allow') return
      if (decision === 'external') {
        event.preventDefault()
        openExternal(targetURL)
        void recordMainProcessDiagnostic('window.navigation.external', { url: targetURL })
        return
      }
      refuseNavigation(event, targetURL, 'window.navigation.refused')
    }
    // Widgets (ticket 02): no keystroke reaches a widget the writer has not engaged (widget-keyboard.ts).
    attachKeyboardGate(window.webContents, shellURL, (count) => { void recordMainProcessDiagnostic('widget.keys.dropped', { count }) }, {
      // A held key never reaches the menu (preventDefault skips menu shortcuts, and a key sent again is
      // not a keystroke the menu hears), so ⌘Q pressed while a widget's frame had the focus did nothing.
      // Main quits on that one key itself. The widget takes no part: it never sees the key, and only a
      // real keystroke comes through before-input-event.
      onHeld: (input) => { if (input.type === 'keyDown' && input.meta) void recordMainProcessDiagnostic('widget.keys.held', { meta: true }) },
      actsOn: (input) => (isQuitKey(input, process.platform) ? () => app.quit() : null),
    })
    // Widgets (ticket 02): no WebRTC over UDP, and no permission for a frame that is not the app's own.
    applyWidgetNetworkPolicy(window.webContents, shellURL, (permission, url) => {
      void recordMainProcessDiagnostic('frame.permission.refused', { permission, url: url.slice(0, 200) })
    })
    window.webContents.on('will-navigate', handleNavigation)
    window.webContents.on('will-redirect', handleNavigation)
    // Frames inside the window: a widget's frame goes nowhere that would reach the network.
    window.webContents.on('will-frame-navigate', (event) => {
      if (event.isMainFrame) return // will-navigate above
      const decision = decideFrameNavigation({
        isMainFrame: false,
        isSameDocument: event.isSameDocument,
        initiator: initiatorOf(event.initiator),
        frameOpaque: frameIsOpaque(event.frame),
        parentOpaque: parentIsOpaque(event.frame),
        url: event.url,
      })
      if (decision === 'continue') return
      event.preventDefault()
      void recordMainProcessDiagnostic('frame.navigation.refused', { url: event.url.slice(0, 200) })
    })
    window.webContents.setWindowOpenHandler(({ url }) => {
      const decision = decideNavigation(shellURL, url)
      if (decision === 'external') {
        openExternal(url)
        void recordMainProcessDiagnostic('window.navigation.external', { url, source: 'window.open' })
      } else if (decision === 'refuse') {
        void recordMainProcessDiagnostic('window.open.refused', { url, reason: navigationRefusalReason(url) })
      }
      return { action: 'deny' }
    })
    const recoverEscapedNavigation = (targetURL: string): void => {
      if (!initialLoadFinished || decideNavigation(shellURL, targetURL) === 'allow') return
      void recordMainProcessDiagnostic('window.navigation.escaped', { url: targetURL })
      const now = Date.now()
      if (now - lastEscapeRecovery < 4000 || window.isDestroyed()) return
      lastEscapeRecovery = now
      void window.loadURL(shellURL)
    }
    window.webContents.on('did-finish-load', () => { initialLoadFinished = true })
    window.webContents.on('did-navigate', (_event, url) => recoverEscapedNavigation(url))
    // The top frame only: a frame inside the window moving to its own `#anchor` (a widget's link, a
    // Reading Room page) is not the shell escaping, and reloading the shell for it would throw the
    // writer's window away.
    window.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) recoverEscapedNavigation(url) })

    // Data-safety guard (ADR-0007 window-per-workspace): a native close — red light, Window menu, ⌘Q —
    // must not discard unsaved edits the way it did before this landed (the T11 Gate-5 gap). Hold the
    // close and hand it to the renderer, which holds the LIVE dirty set (no cached count a fast
    // type-then-⌘Q could outrun): it prompts if needed, saves, and re-requests the close via
    // window:close (which sets forceClose so this guard passes it straight through next time).
    const closing = createCloseController({
      shouldGuard: () => shouldGuardClose(state),
      // No renderer left to ask: nothing in it to save.
      rendererGone: () => window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isCrashed(),
      // Heeded by the controller only until the app has started in the page (window:app-started).
      rendererLoading: () => !initialLoadFinished || window.webContents.isLoadingMainFrame(),
      requestRenderer: () => window.webContents.send('window:close-requested'),
      closeNow: () => {
        state.forceClose = true
        if (!window.isDestroyed()) window.close()
      },
      ask: async (kind, signal) => {
        // A harness run shows no dialog (nobody could answer it): the answer is the spec's to script.
        if (e2e) return process.env.WRITEFLEX_E2E_STALLED_CLOSE === 'close' ? 'close' : 'wait'
        const { response } = await dialog.showMessageBox(window, {
          type: 'warning', message: STALLED_CLOSE_COPY[kind].message, detail: STALLED_CLOSE_COPY[kind].detail,
          buttons: [STALLED_CLOSE_COPY[kind].keep ?? 'Keep waiting', 'Close anyway'], defaultId: 0, cancelId: 0, noLink: true, signal,
        })
        return response === 1 ? 'close' : 'wait'
      },
      // As for a close the renderer cancels: a ⌘Q it came from is over too.
      kept: () => { setQuitting(false); state.onCloseCancelled?.() },
      record: (name, details) => { void recordMainProcessDiagnostic(name, { windowId: webContentsId, ...details }) },
      now: () => Date.now(),
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    })
    state.closing = closing
    window.on('close', (event) => {
      if (closing.onNativeClose() === 'hold') event.preventDefault()
    })
    // A renderer that dies during a close has no text left to write: the window goes at once.
    window.webContents.on('render-process-gone', () => closing.rendererGone())
    // A new document in the top frame (a reload) during a close throws the renderer's close away with
    // the page. The close is over, and so is any ⌘Q it came from (as for a close the renderer cancels).
    // On commit, not on start: a navigation that is refused replaces nothing. The same event tells the
    // controller that the app has not started in the new page.
    window.webContents.on('did-navigate', () => {
      if (!closing.reset()) return
      setQuitting(false)
      state.onCloseCancelled?.()
    })

    window.on('closed', () => {
      this.onWindowClosed?.(webContentsId)
      const root = this.#ownedRoots.get(webContentsId)
      if (!root) return
      this.#ownedRoots.delete(webContentsId)
      // state.ts's own 'closed' handler (registered first) has started this window's agent and diary
      // flushes; the Collection stays ours until they settle, so no other owner writes under them.
      // The same for a command-line request the app was carrying out when the window closed.
      // Kept until it settles, so the example's removal can wait for it (`exampleLocksReleased`).
      const releasing = Promise.all([waitForAgentDisposals(), waitForRequestDisposals()]).then(() => this.ownership.release(root))
      const after = Promise.all([this.#releasing.get(root), releasing]).then(() => undefined, () => undefined)
      this.#releasing.set(root, after)
      void after.then(() => { if (this.#releasing.get(root) === after) this.#releasing.delete(root) })
    })
    if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
    else void window.loadFile(join(__dirname, '../renderer/index.html'))
    return state
  }

  windowForRoot(root: string): WindowState | undefined {
    const canonical = normaliseRoot(root)
    return allStates().find((state) => state.workspace?.root === canonical)
  }

  /**
   * Open (or focus) a window on `root`. If a window already shows this root, focus it — never two
   * windows on one root. Otherwise reuse `from` if it has no Workspace yet (the start screen), else
   * open a new window. Always records the recent.
   *
   * A new binding first takes the Collection's owner lock, waiting for a short-lived owner (the
   * command line mid-write). Resolves null when another owner still has it and the user, told so,
   * chose not to try again. A Collection whose lock cannot be taken at all (collection-ownership.ts,
   * `unlockable`) still opens, read-only: its write gate is closed before it is bound, and the user
   * is told once the window shows it.
   */
  async openFolder(from: WindowState | null, root: string, options: { placement?: WindowPlacement } = {}): Promise<WindowState | null> {
    // Canonicalise BEFORE dedup and binding: dialogs return realpaths while argv/env use resolve(),
    // and APFS is case-insensitive — string comparison on mixed forms would let two windows bind one
    // physical root and corrupt the single-writer Snapshot Store (Bridle ADR-0008). Everything
    // downstream (Workspace, recents, window title) stores the canonical form.
    const canonicalRoot = normaliseRoot(root)
    const existing = this.windowForRoot(canonicalRoot)
    if (existing) {
      // A hidden window a switch has opened is not this open's to show (round 2): the switch's own
      // window is brought forward and says the switch is under way.
      if (this.#switchingInto(existing, canonicalRoot)) return null
      this.#recordRecent(canonicalRoot)
      this.#recordGuideStep(canonicalRoot)
      if (!existing.window.isDestroyed()) existing.window.focus()
      return existing
    }
    if (!(await claimWithRetry(this.ownership, canonicalRoot, (busy) => this.#askRetry(busy)))) return null
    // The wait can outlast the caller's picture of the world: this root may have opened meanwhile
    // (its window shares the claim just taken), and `from` may have closed or been bound.
    const opened = this.windowForRoot(canonicalRoot)
    if (opened) {
      void this.ownership.release(canonicalRoot)
      if (this.#switchingInto(opened, canonicalRoot)) return null
      this.#recordRecent(canonicalRoot)
      if (!opened.window.isDestroyed()) opened.window.focus()
      return opened
    }
    let target: WindowState | null = null
    let created = false
    try {
      if (from && !from.workspace && !from.window.isDestroyed()) target = from
      else {
        target = this.createWindow(options.placement)
        created = true
      }
      this.#ownedRoots.set(target.window.webContents.id, canonicalRoot)
      await bindWorkspace(target, canonicalRoot, this.settings, (root) => this.ownership.owns(root))
      // Opened without its lock: nothing is saved until a later beat takes it. Say so now that a window shows it.
      if (this.ownership.unavailable(canonicalRoot)) this.#ownershipChanged(canonicalRoot, 'unavailable')
      this.#recordRecent(canonicalRoot)
      this.#recordGuideStep(canonicalRoot)
    } catch (error) {
      // A start-screen window this open reused that the bind got far enough to bind (round 3, T1): it
      // stays bound, so the folder stays claimed (its heartbeat and write gate with it) until the window
      // closes, whose 'closed' handler releases it. Undoing a part-made bind in place is not attempted.
      // The window is returned and says what failed.
      if (target && !created && !target.window.isDestroyed() && target.workspace?.root === canonicalRoot) {
        const message = error instanceof Error ? error.message : String(error)
        void recordMainProcessDiagnostic('workspace.open.failed-after-bind', { root: canonicalRoot, message })
        target.window.webContents.send('window:status', `${basename(canonicalRoot)} is open, but part of opening it failed: ${message}`)
        return target
      }
      // Not bound, so not ours to hold — unless the window closed mid-bind and released it already.
      if (!target || this.#ownedRoots.delete(target.window.webContents.id)) await this.ownership.release(canonicalRoot)
      // A window this open made goes with it (round 2): nobody else is responsible for it. Its
      // 'closed' handlers dispose whatever the bind had made. A start-screen window it reused stays.
      if (created && target && !target.window.isDestroyed()) target.window.destroy()
      throw error
    }
    return target
  }

  /** The switches in flight: which hidden windows they have opened, and for which window. A test
   *  replaces this to stand for a switch under way. */
  switchReservations(): Pick<WindowSwitch<WindowState>, 'isPending' | 'sourceOf'> {
    return this.#windowSwitch
  }

  /** `existing` is a hidden window a switch has opened (round 2): bring the switch's own window
   *  forward with "Switching to <name>…", and report true so the open stops there. */
  #switchingInto(existing: WindowState, root: string): boolean {
    const route = routeToExistingWindow(existing, this.switchReservations())
    if (route.kind === 'focus') return false
    const source = route.source
    void recordMainProcessDiagnostic('workspace.open.switching', { root })
    if (source && !source.window.isDestroyed()) {
      source.window.focus()
      source.window.webContents.send('window:status', `Switching to ${basename(root)}…`)
    }
    return true
  }

  /**
   * Switch `state` to `root` (vaults ticket 06, the vault switcher; review 2026-10-16): the window is
   * REPLACED, never rebound. `root` opens by `openFolder` in a new window created hidden at this
   * window's place; this window then closes by the ordinary close route (`#closeByNormalRoute`: its
   * renderer writes every document and drains its ledger, main makes the close checkpoints, disposes its
   * services and releases its lock); once it has closed the new window is shown. The new window must
   * first have loaded its root (`renderer:ready`). A close kept open, or one still undecided after the
   * switch's bound (then called off), closes the hidden window again and leaves this one as it was. The
   * order, its refusals and the per-window and per-root reservations are window-switch.ts's.
   */
  switchWindow(state: WindowState, root: string, focusFile: string | null = null): Promise<WindowSwitchOutcome<WindowState>> {
    return this.#windowSwitch.switchWindow(state, root, focusFile).then((outcome) => {
      void recordMainProcessDiagnostic('workspace.switch', {
        windowId: state.window.isDestroyed() ? null : state.window.webContents.id,
        status: outcome.status,
        ...(outcome.status === 'switched' || outcome.status === 'focused' ? { root: outcome.root } : {}),
      })
      return outcome
    })
  }

  readonly #windowSwitch = createWindowSwitch<WindowState, WindowPlacement>({
    rootOf: (state) => state.workspace?.root ?? null,
    canonical: (candidate) => normaliseRoot(candidate),
    ownerWindow: (candidate, except) => {
      const shown = this.windowForRoot(candidate)
      return shown && shown !== except ? shown : undefined
    },
    focus: (shown) => { if (!shown.window.isDestroyed()) shown.window.focus() },
    placement: (state) => {
      const { window } = state
      const fullScreen = window.isFullScreen()
      return { bounds: fullScreen || window.isMaximized() ? window.getNormalBounds() : window.getBounds(), fullScreen, maximized: window.isMaximized() }
    },
    openHidden: async (candidate, placement, focusFile) => {
      const before = new Set(allStates())
      const opened = await this.openFolder(null, candidate, { placement })
      if (!opened) return { kind: 'busy' }
      if (before.has(opened)) return { kind: 'existing', window: opened }
      // A fresh window carries the file until its renderer pulls workspace:get (as openFile does).
      if (focusFile) {
        opened.pendingFocusFile = focusFile
        opened.pendingFocusLine = null
      }
      return { kind: 'opened', window: opened }
    },
    whenReady: (state) => this.#whenRendererReady(state),
    requestClose: (state) => this.#closeAttempt(state),
    isGone: (state) => state.window.isDestroyed(),
    show: (state, placement) => {
      const { window } = state
      // A test run never shows a window (AGENTS.md): the e2e window stays hidden, as every e2e window does.
      if (window.isDestroyed() || process.env.WRITEFLEX_E2E === '1') return
      if (placement.maximized) window.maximize()
      window.show()
      if (placement.fullScreen) window.setFullScreen(true)
      window.focus()
    },
    discard: async (state) => {
      // A window nobody has seen or typed in: the ordinary close, then destroy if that did not finish
      // (its 'closed' handler releases the lock either way).
      try {
        await this.#closeByNormalRoute(state)
      } finally {
        if (!state.window.isDestroyed()) state.window.destroy()
      }
    },
  })

  /** The new window's page has loaded the root it was bound to (`renderer:ready`), or cannot. */
  #whenRendererReady(state: WindowState): Promise<boolean> {
    const { window } = state
    if (window.isDestroyed()) return Promise.resolve(false)
    const contents = window.webContents
    return whenRendererReady({
      isReady: () => !window.isDestroyed() && state.workspace !== null && state.rendererRoot === state.workspace.root,
      onReport: (listener) => {
        state.onRendererReady = listener
        return () => { if (state.onRendererReady === listener) state.onRendererReady = null }
      },
      onFailure: (listener) => {
        const failedLoad = (_event: unknown, _code: number, _description: string, _url: string, isMainFrame: boolean): void => {
          if (isMainFrame) listener()
        }
        const gone = (): void => listener()
        contents.on('did-fail-load', failedLoad)
        contents.on('render-process-gone', gone)
        window.once('closed', gone)
        return () => {
          if (contents.isDestroyed()) return
          contents.removeListener('did-fail-load', failedLoad)
          contents.removeListener('render-process-gone', gone)
          if (!window.isDestroyed()) window.removeListener('closed', gone)
        }
      },
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    })
  }

  /**
   * One window closed as the red light closes it, with no time limit of its own: `closed` settles
   * true once it has closed, false once its close was kept open (a write failed, the person kept it, or
   * a reload replaced the page). `abandon` calls the close off (the switch's bound, window-switch.ts):
   * main drops any late answer to it and the page is told to drop it too, so the window stays; false
   * when the window is already closing past recall.
   */
  #closeAttempt(state: WindowState): CloseAttempt {
    const { window } = state
    if (window.isDestroyed()) return { closed: Promise.resolve(true), abandon: () => false }
    let finish: (closed: boolean) => void = () => {}
    const closed = new Promise<boolean>((resolve) => {
      let finished = false
      finish = (outcome: boolean): void => {
        if (finished) return
        finished = true
        if (state.onCloseCancelled === refused) state.onCloseCancelled = null
        if (!window.isDestroyed()) window.removeListener('closed', gone)
        resolve(outcome)
      }
      const gone = (): void => finish(true)
      const refused = (): void => finish(false)
      window.once('closed', gone)
      state.onCloseCancelled = refused
      try {
        window.close()
      } catch {
        // No close started: the window is as it was (or already gone).
        finish(window.isDestroyed())
      }
    })
    return {
      closed,
      abandon: () => {
        // Past recall: the renderer's "every document written" has been taken and the window is going.
        if (window.isDestroyed() || state.forceClose) return false
        state.closing?.abandon()
        if (!window.webContents.isDestroyed()) window.webContents.send('window:abandon-close')
        finish(false)
        return true
      },
    }
  }

  /** Whether `root` may be named by a renderer as a root to open: a persisted recent or pin, or the
   *  shown Example collection at its fixed path (see `openRecent` in `router()`). */
  async isKnownRoot(root: string): Promise<boolean> {
    const wanted = normaliseRoot(root)
    return this.settings.recents().some((r) => normaliseRoot(r.root) === wanted)
      || this.settings.pinned().some((r) => normaliseRoot(r) === wanted)
      || ((await this.example?.current()) !== null && this.example?.isRoot(root) === true)
  }

  /** Tell the user another program has the folder, in the dialog style openFile uses; true = try again. */
  async #askRetry(busy: OwnerLockBusyError): Promise<boolean> {
    void recordMainProcessDiagnostic('owner-lock.busy', {
      root: busy.root, waitedMs: busy.waitedMs,
      owner: busy.owner ? { pid: busy.owner.pid, kind: busy.owner.kind, host: busy.owner.host } : null,
    })
    // A hidden e2e window must never block on a native dialog nobody can see.
    if (process.env.WRITEFLEX_E2E === '1') return false
    const { response } = await dialog.showMessageBox({
      type: 'info', ...busyNotice(busy, hostname()), buttons: ['Try Again', 'Cancel'], defaultId: 0, cancelId: 1,
    })
    return response === 0
  }

  /**
   * Open a single file by promoting its resolved Workspace root and focusing the file in that
   * window. Opening a file NEVER opens a bare buffer (ADR-0007). A file with no resolvable root
   * (directly in the home folder) shows a dialog and opens no window.
   */
  async openFile(from: WindowState | null, filePath: string, line?: number): Promise<WindowState | null> {
    // Canonicalise before the marker walk-up: a symlinked path segment would otherwise yield a
    // symlink-form root that dedups differently from the same folder opened via dialog, and
    // relative(root, filePath) must be computed on one consistent form.
    const canonicalPath = normaliseRoot(filePath)
    if (!isMarkdownPath(canonicalPath)) {
      await dialog.showMessageBox({ type: 'info', message: 'Cannot open file', detail: 'WriteFlex opens Markdown files and folders.' })
      return null
    }
    let root: string
    try {
      root = resolveWorkspaceRoot(canonicalPath)
    } catch (error) {
      if (error instanceof WorkspaceRootError) {
        await dialog.showMessageBox({ type: 'info', message: 'Cannot open file', detail: error.message })
        return null
      }
      throw error
    }
    // Whether the target window is already mounted decides how the focus push is delivered.
    const alreadyMounted = this.windowForRoot(root) !== undefined || (from !== null && !from.workspace)
    const state = await this.openFolder(from, root)
    if (!state) return null
    state.pendingFocusFile = relative(root, canonicalPath)
    state.pendingFocusLine = line ?? null
    if (alreadyMounted) flushPendingFocus(state)
    // Fresh windows carry pendingFocusFile until their renderer pulls workspace:get (see ipc.ts).
    return state
  }

  /**
   * Open the Example collection as its own window, focusing that window if it is already open. A
   * window with a Workspace of the person's own is never replaced; a start-screen window becomes
   * the example, as it does for any other row. A window newly bound to the example opens at
   * `00 Start here.md` (journey J1, step 2); an already-open one is left where the person had it.
   * The root is never supplied by the renderer: it is the fixed example path, checked now, or nothing.
   */
  async openExampleCollection(from: WindowState | null): Promise<WindowState | null> {
    const state = await this.#openExample(from, { atStartFile: 'when-new' })
    return state
  }

  /**
   * Open the Guide (the start screen's Guide entry, Settings, the palette). The Guide tab opens in the
   * right pane of the window it lands in (last in the row), so this opens the Example
   * collection's window at `00 Start here.md`, where the first steps and the chapters are.
   */
  async openGuide(from: WindowState | null): Promise<WindowState | null> {
    return this.#openExample(from, { atStartFile: 'always' })
  }

  /**
   * Open a chapter's lesson file in the Example collection's window (ticket 07). From the example's own
   * window it opens the file there; from the person's own window `openFolder` finds the example's window
   * already open (and focuses it) or opens it as a window of its own, so the lesson is never opened in the
   * person's window. The file name is computed here from the chapter; nothing path-like comes from the renderer.
   */
  async openChapter(from: WindowState | null, chapter: TaskGroup | typeof OBJECTS_LESSON): Promise<WindowState | null> {
    const root = (await this.example?.current()) ?? null
    if (root === null) throw new Error('The Example collection is not on this Mac.')
    const alreadyMounted = this.windowForRoot(root) !== undefined
    const state = await this.openFolder(from?.workspace ? from : null, root)
    // Null: another program holds the folder and the person chose not to wait (openFolder said so).
    if (!state) return null
    state.pendingFocusFile = chapter === OBJECTS_LESSON ? EXAMPLE_OBJECTS_FILE : lessonFileFor(chapter)
    state.pendingFocusLine = null
    if (alreadyMounted) flushPendingFocus(state)
    this.#wantGuideTab(state)
    if (!state.window.isDestroyed()) state.window.focus()
    return state
  }

  /**
   * Remove the Example collection (ticket 10): the example's windows close by the normal route, then
   * the folder goes to the Bin and, only then, the record becomes `removed` (`example-removal.ts`,
   * rules E and I). Takes only the confirmation's token from the renderer (rule H), with main's own
   * number for the window that sent it: the path is the fixed one.
   */
  async removeExample(token: unknown, sender: number): Promise<ExampleRemoveResult> {
    if (!this.exampleRemoval) return { ok: false, message: 'The Example collection is not on this Mac.' }
    const root = (await this.example?.current()) ?? null
    this.#exampleWindowBeforeRemoval = root === null ? undefined : this.windowForRoot(root)
    try {
      const result = await this.exampleRemoval.remove(token, sender)
      await this.example?.current() // the marked entries follow the record and the disk
      this.refreshMenu?.()
      return result
    } finally {
      this.#exampleWindowBeforeRemoval = undefined
    }
  }

  /** Bring the Example collection back (ticket 10). Opens no window. */
  async restoreExample(): Promise<ExampleRestoreResult> {
    if (!this.exampleRemoval) return { ok: false, message: 'The Example collection is not on this Mac.' }
    const result = await this.exampleRemoval.restore()
    await this.example?.current()
    this.refreshMenu?.()
    return result
  }

  /**
   * The removal's window port (`example-removal.ts`, rule I): before the folder is moved, close every
   * window whose folder is the example, or a folder inside it, by the normal close route: the close
   * guard hands the close to the renderer, which writes every unsaved buffer and closes, or keeps the
   * window open when a write fails (`window:cancel-close`). `closed` only when every such window has
   * closed within `EXAMPLE_CLOSE_MS`; a refusal or no close in time is `open`, and the windows that
   * did close stay closed. If no window is left, a start screen takes the place of the last one so the
   * person is not left without one.
   */
  async closeExampleWindows(root: string): Promise<ExampleWindowsClosed> {
    const canonical = normaliseRoot(root)
    const showing = new Set<WindowState>(allStates().filter((state) => {
      const open = state.workspace?.root
      return open !== undefined && !state.window.isDestroyed() && (open === canonical || open.startsWith(canonical + sep))
    }))
    const found = this.#exampleWindowBeforeRemoval
    if (found && !found.window.isDestroyed()) showing.add(found)
    if (showing.size === 0) return 'closed'
    const closed = await Promise.all([...showing].map((state) => this.#closeByNormalRoute(state)))
    if (!allStates().some((state) => !state.window.isDestroyed())) this.createWindow()
    return closed.every((done) => done) ? 'closed' : 'open'
  }

  /**
   * The removal's lock port (`example-removal.ts`, rule J): resolves once every release of a closed
   * window's owner lock for the example, or a folder inside it, has finished. Called after
   * `closeExampleWindows` answered `closed`, so each of those windows has already started its release.
   */
  async exampleLocksReleased(root: string): Promise<void> {
    const canonical = normaliseRoot(root)
    const pending = [...this.#releasing.entries()].filter(([held]) => held === canonical || held.startsWith(canonical + sep)).map(([, done]) => done)
    await Promise.all(pending)
  }

  /** One window closed as the red light closes it. True once it has closed; false on a refusal or no close in time. */
  #closeByNormalRoute(state: WindowState): Promise<boolean> {
    const { window } = state
    if (window.isDestroyed()) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      let finished = false
      const finish = (closed: boolean): void => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        if (state.onCloseCancelled === refused) state.onCloseCancelled = null
        if (!window.isDestroyed()) window.removeListener('closed', gone)
        resolve(closed)
      }
      const gone = (): void => finish(true)
      const refused = (): void => finish(false)
      const timer = setTimeout(() => finish(window.isDestroyed()), EXAMPLE_CLOSE_MS)
      window.once('closed', gone)
      state.onCloseCancelled = refused
      try {
        window.close()
      } catch {
        finish(window.isDestroyed())
      }
    })
  }

  /** The Guide tab is not in the right pane until asked for: this asks the window's renderer to open it (pulled once with the Guide context, or pushed if it is already running). */
  #wantGuideTab(state: WindowState): void {
    state.guideTabWanted = true
    if (!state.window.isDestroyed()) state.window.webContents.send('guide:show', null)
  }

  async #openExample(from: WindowState | null, options: { atStartFile: 'when-new' | 'always' }): Promise<WindowState | null> {
    const root = (await this.example?.current()) ?? null
    if (root === null) throw new Error('The Example collection is not on this Mac.')
    const alreadyOpen = this.windowForRoot(root) !== undefined
    const alreadyMounted = alreadyOpen || (from !== null && !from.workspace)
    const state = await this.openFolder(from, root)
    // Null: another program holds the folder and the person chose not to wait (openFolder said so).
    if (!state) return null
    const startFile = alreadyOpen && options.atStartFile === 'when-new' ? null : (await this.example?.startFile()) ?? null
    if (options.atStartFile === 'always') this.#wantGuideTab(state)
    if (startFile !== null) {
      state.pendingFocusFile = startFile
      state.pendingFocusLine = null
      if (alreadyMounted) flushPendingFocus(state)
    }
    return state
  }

  /** OpenPathRouter adapter passed into registerIpc so renderer-initiated opens route through here. */
  router(): OpenPathRouter {
    return {
      openFolder: async (state, root) => { await this.openFolder(state, root) },
      openFile: async (state, filePath, line) => { await this.openFile(state, filePath, line) },
      recents: () => this.settings.recents(),
      // Unlike openFolder/openFile (both reached via a native consent gate — the open dialog, argv, or
      // a Finder file-open), open-recent takes a bare renderer-supplied root and establishes it as the
      // workspace. Require it to be a persisted recent so a compromised renderer can't designate an
      // arbitrary folder as the root and gain guarded read/write within it.
      openRecent: async (state, root, options) => {
        // The Example collection is neither a Recent nor a pin (ADR-0043), so it is admitted by
        // its own rule: the fixed example path while it is shown, and no other path.
        // Asked with the path AS REQUESTED: a symlink or another spelling that merely leads to
        // the example is not the fixed path. (Recents and pins compare canonical forms.)
        const known = await this.isKnownRoot(root)
        if (!known) throw new Error('Refusing to open a folder that is not in Recents or Pinned.')
        await this.openFolder(options?.newWindow ? null : state, root)
      },
      example: {
        startScreen: () => startScreenModel(this.settings, this.example),
        open: async (state, target) => {
          if (target === 'guide') await this.openGuide(state)
          else await this.openExampleCollection(state)
        },
        context: async (state) => {
          const root = (await this.example?.current()) ?? null
          return { shown: root !== null, here: root !== null && this.windowForRoot(root) === state, canRestore: root === null && this.exampleRemoval?.canRestore() === true, removed: this.exampleRemoval?.wasRemoved() === true, wantsTab: ((): boolean => { const w = state.guideTabWanted; state.guideTabWanted = false; return w })() }
        },
        removalPreview: async (sender): Promise<ExampleRemovalPreview> =>
          this.exampleRemoval ? this.exampleRemoval.preview(sender) : { ok: false, message: 'The Example collection is not on this Mac.' },
        remove: (token, sender) => this.removeExample(token, sender),
        restore: () => this.restoreExample(),
        openChapter: async (state, chapter) => { await this.openChapter(state, chapter) },
      },
      refreshMenu: () => this.refreshMenu?.(),
      switchWindow: (state, root, focusFile) => this.switchWindow(state, root, focusFile),
      isKnownRoot: (root) => this.isKnownRoot(root),
      openWorkspaceRoots: () => allStates().flatMap((candidate) => (candidate.workspace ? [candidate.workspace.root] : []))
    }
  }

  /** The first step "Open a folder" is a folder of the person's own; "Open the Example collection" is the example. */
  #recordGuideStep(root: string): void {
    const shown = this.example?.shownRoot?.() ?? null
    if (shown !== null && normaliseRoot(shown) === root) this.guide.stepDone('example')
    else this.guide.stepDone('folder', basename(root))
  }

  #recordRecent(root: string): void {
    this.settings.touchRecent(root)
    this.refreshMenu?.()
  }
}

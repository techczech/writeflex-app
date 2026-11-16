// Updates (ADR-0054, porting TalkWeaver ADR-0044): the daily check of writeflex.app/updates.json (release and alpha
// channels, src/shared/update-checker.ts), the one click that updates in place (update-installer.ts), and the
// `updates:*` IPC. WriteFlex ports: persistence, the busy gate (distraction-free writing), the restart blockers,
// bundled notes.
import { updateTestOptions } from './update-notices-test-options'
import { UPDATE_TEST_CACHE_DIR_NAME } from './update-test-build'
import { app, ipcMain, net, session, shell, type BrowserWindow } from 'electron'
import { request as httpRequest } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { downloadLinkFor, isSiteLink, parseVersion, parseWhatsNew, type CopySource, type WhatsNewItem, type FeedAnswer } from '@app-patterns/updates'
import { createElectronFeedFetcher } from '@app-patterns/updates/electron'
import { UPDATE_IDENTITY, UPDATE_INSTALL_IDENTITY, FEED_URL, FEED_REQUEST, STORE_LINK, notesLinkFor } from '../shared/update-identity.ts'
import { RELEASE_ASSET_PREFIX, isOfferSeen, newerOffer, updateFileFor } from '../shared/update-channels.ts'
import { createChannelChecker, readChannelState, type ChannelChecker, type ChannelUpdateState, type CheckerSnapshot, type UpdateSnapshot } from '../shared/update-checker.ts'
import type { InPlaceRefusal, RestartBlocker } from '../shared/update-install.ts'
import { createUpdateInstaller } from './update-installer.ts'
import type { RestartClose } from './update-engine.ts'

export interface UpdateNoticesPorts {
  /** Every window that may show a notice: the editor windows, never a presenting window. */
  editorWindows(): BrowserWindow[]
  /** Distraction-free writing is active in an editor window: no request, no mark, no update starts. */
  isProtectedNow(): boolean
  /** Everything a restart now would cost the person (update-install.ts restartBlockers), read at the moment of asking. */
  restartBlockers(): RestartBlocker[]
  /** Refreshes what restartBlockers reads asynchronously (the backup helper's activity); at most one read at a time. */
  refreshRestartBlockers?(maxAgeMs?: number): Promise<void>
  /** The restart's commit (ADR-0054): every window closed through its own close route, their work waited for. */
  closeWindowsForRestart(restart: RestartClose): Promise<boolean>
  /** How many windows are open now (the native install is called only at zero). */
  openWindows(): number
  /** The restart's commit began and the restart will not happen: start the backup helper again, give a window.
   *  Idempotent: called when the attempt ends and again once the close work that could not be called off settled. */
  restartAbandoned?(): void
  /** Persistence keys: `updateNotices` (state), `updatesCheckForNewVersions` and `updatesAlphaVersions` (the settings
   *  `updates.checkForNewVersions` and `updates.alphaVersions`, per Mac). */
  readConfig(): { updateNotices?: unknown; updatesCheckForNewVersions?: unknown; updatesAlphaVersions?: unknown; hadConfiguration?: boolean }
  writeConfig(patch: { updateNotices: ChannelUpdateState }): void
  /** A test run (WRITEFLEX_E2E) logs the link instead of opening it. */
  e2e: boolean
}

const fetchReleaseFeed = createElectronFeedFetcher(UPDATE_IDENTITY, { net, session })
export function fetchFeedOverNet(url: string = FEED_URL): Promise<FeedAnswer> {
  return url === FEED_URL ? fetchReleaseFeed() : fetchStandIn(url)
}

/** Test only (see updateTestOptions): the stand-in on this computer's loopback address, without changing the production session. Same limits, same answer shape. */
function fetchStandIn(url: string): Promise<FeedAnswer> {
  return new Promise((resolve) => {
    let finished = false
    let request: ReturnType<typeof httpRequest> | null = null
    const done = (answer: FeedAnswer): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (!answer.ok) { try { request?.destroy() } catch { /* already over */ } }
      resolve(answer)
    }
    const timer = setTimeout(() => done({ ok: false, reason: 'unreachable' }), FEED_REQUEST.timeoutMs)
    try {
      request = httpRequest(url, { method: FEED_REQUEST.method, headers: FEED_REQUEST.headers }, (response) => {
        // The same cap on every answer, a non-200 one too: the body is counted, never kept.
        const ok = response.statusCode === 200
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > FEED_REQUEST.maxBytes) { done({ ok: false, reason: 'too-large' }); return }
          if (ok) chunks.push(chunk)
        })
        response.on('end', () => done(ok ? { ok: true, text: Buffer.concat(chunks).toString('utf8') } : { ok: false, reason: 'unreadable' }))
        response.on('error', () => done({ ok: false, reason: 'unreachable' }))
      })
      request.on('error', () => done({ ok: false, reason: 'unreachable' }))
      request.end()
    } catch { done({ ok: false, reason: 'unreachable' }) }
  })
}

const notesDir = (): string => (app.isPackaged ? join(process.resourcesPath, 'whats-new') : join(process.cwd(), 'resources', 'whats-new'))

/** The notes shipped for a version, or null. The version is checked first, so no path can be built from it. */
function readNotes(version: string): WhatsNewItem[] | null {
  if (!parseVersion(version)) return null
  try { return parseWhatsNew(readFileSync(join(notesDir(), `${version}.md`), 'utf8')) } catch { return null }
}

/** Where this copy came from. Any packaged copy outside a Store checks and may update itself, an alpha too: alphas are
 *  public (ADR-0044 §2), so an alpha reads "downloaded from writeflex.app", not the shared "preview built for testing". */
function copySourceOf(packaged: boolean, store: boolean): CopySource {
  if (store) return 'store'
  return packaged ? 'website' : 'development'
}

export interface UpdateNotices {
  checker: ChannelChecker
  /** Tell the windows again: a restart blocker appeared or went (a Restart button's reason). */
  blockersChanged(): void
}

export function installUpdateNotices(ports: UpdateNoticesPorts): UpdateNotices {
  const running = app.getVersion()
  const store = process.mas === true || (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore === true
  const test = updateTestOptions(app.isPackaged, process.env)
  const source = test.source ?? copySourceOf(app.isPackaged, store)
  // A stand-in feed (hidden e2e runs only) names its update files on the same loopback address.
  const assetPrefix = test.feedUrl ? new URL('/releases/download/', test.feedUrl).href : RELEASE_ASSET_PREFIX
  const readState = (): ChannelUpdateState => readChannelState(ports.readConfig().updateNotices, FEED_URL, assetPrefix)
  const alphaOn = (): boolean => ports.readConfig().updatesAlphaVersions === true
  const blockersNow = (): RestartBlocker[] => ports.restartBlockers()

  let checker: ChannelChecker | null = null
  const refusals = new Map<string, InPlaceRefusal | null>()
  const installer = createUpdateInstaller({
    identity: { appName: UPDATE_INSTALL_IDENTITY.appName, userAgent: UPDATE_INSTALL_IDENTITY.userAgent },
    // A hidden e2e run downloads and checks, then logs instead of installing (its Squirrel.Mac is a stand-in). The
    // packaged update-test flavour installs for real (the proof on this Mac), with its own cache folder.
    install: test.feedUrl === null || test.packagedProof,
    cacheDirName: test.packagedProof ? UPDATE_TEST_CACHE_DIR_NAME : UPDATE_INSTALL_IDENTITY.cacheDirName,
    ...(test.feedUrl && !test.packagedProof ? { cacheBase: join(app.getPath('userData'), 'updater-cache') } : {}),
    configDir: join(app.getPath('userData'), 'updater'),
    filterLocalAddresses: test.feedUrl === null,
    source,
    isProtected: ports.isProtectedNow,
    blockers: blockersNow,
    ...(ports.refreshRestartBlockers ? { refreshBlockers: () => ports.refreshRestartBlockers!() } : {}),
    closeWindows: ports.closeWindowsForRestart,
    openWindows: ports.openWindows,
    ...(ports.restartAbandoned ? { commitAbandoned: ports.restartAbandoned } : {}),
    changed: () => { try { checker?.tell() } catch { /* starting */ } },
    log: (message) => console.log(`[updates] ${message}`),
  })

  /** The check's snapshot with the click's state, the file for this computer and whether it can be used here. */
  const withInstall = (s: CheckerSnapshot): UpdateSnapshot => {
    const offer = newerOffer(s.state.channels, s.alpha, running)
    const file = updateFileFor(offer, process.platform, process.arch)
    const key = `${offer?.version ?? ''} ${file?.url ?? ''} ${file?.bundleId ?? ''}`
    if (!refusals.has(key)) refusals.set(key, installer.refusal(file, s.source))
    const install = installer.state()
    // While working on an update the mark stays (unless distraction-free writing is on), whatever the offer says.
    const working = install.phase !== 'idle'
    return { ...s, install, file, refusal: refusals.get(key) ?? null, blockers: working ? blockersNow() : [] }
  }
  const tellWindows = (channel: string, snapshot: UpdateSnapshot): void => {
    for (const win of ports.editorWindows()) {
      try { if (!win.isDestroyed()) win.webContents.send(channel, snapshot) } catch { /* closing */ }
    }
  }
  let lastOffer: string | null = null
  const theChecker = createChannelChecker({
    identity: UPDATE_IDENTITY,
    arch: process.arch,
    running,
    platform: process.platform,
    source,
    assetPrefix,
    // The update-test flavour never contacts writeflex.app: the stand-in, or no answer.
    fetchFeed: () => test.packagedProof
      ? (test.feedUrl ? fetchStandIn(test.feedUrl) : Promise.resolve({ ok: false, reason: 'unreachable' } as FeedAnswer))
      : fetchFeedOverNet(test.feedUrl ?? FEED_REQUEST.url),
    readState,
    writeState: (state) => ports.writeConfig({ updateNotices: state }),
    enabled: () => ports.readConfig().updatesCheckForNewVersions !== false,
    alpha: alphaOn,
    isBusy: ports.isProtectedNow,
    hasNotes: (version) => readNotes(version) !== null,
    hadConfiguration: () => ports.readConfig().hadConfiguration === true,
    now: () => Date.now(),
    changed: (snapshot) => {
      const offer = newerOffer(snapshot.state.channels, snapshot.alpha, running)?.version ?? null
      if (offer !== lastOffer) { lastOffer = offer; installer.reset() }
      tellWindows('updates:changed', withInstall(snapshot))
    },
    answered: (snapshot) => tellWindows('updates:answered', withInstall(snapshot)),
  })
  checker = theChecker
  const snap = (): UpdateSnapshot => withInstall(theChecker.snapshot())

  /** Hand a link to the browser: only one that passes the site rule (or the Store constant). */
  const open = async (link: string, allowed: (l: string) => boolean): Promise<boolean> => {
    if (!allowed(link)) return false
    try {
      if (ports.e2e) console.log('[update-notices] external (E2E):', link)
      else await shell.openExternal(link)
      return true
    } catch { return false }
  }
  /** The offer for the setting now, or the release (what Download and What's new link to). */
  const linkEntry = () => {
    const s = theChecker.snapshot()
    return newerOffer(s.state.channels, s.alpha, running) ?? s.state.channels?.release
  }

  ipcMain.handle('updates:get', (): UpdateSnapshot => snap())
  ipcMain.handle('updates:check', async (): Promise<UpdateSnapshot> => withInstall(await theChecker.checkNow()))
  ipcMain.handle('updates:skip', (_e, version: unknown): UpdateSnapshot => withInstall(typeof version === 'string' && parseVersion(version) ? theChecker.skip(version) : theChecker.snapshot()))
  ipcMain.handle('updates:stop-skipping', (): UpdateSnapshot => withInstall(theChecker.stopSkipping()))
  ipcMain.handle('updates:not-now', (): UpdateSnapshot => withInstall(theChecker.notNow()))
  // Update, Cancel and Restart take no address and no path from the renderer. Update acts on the newer offer the last
  // validated feed gave for this computer (ADR-0044 §3), and only when it is the version the person saw: the renderer
  // names that version (checked as a version, never used to build anything); when the offer has changed since, nothing
  // starts and the windows are told again, so they show the offer as it is now.
  ipcMain.handle('updates:update', (_e, expected: unknown): UpdateSnapshot => {
    const s = theChecker.snapshot()
    const offer = newerOffer(s.state.channels, s.alpha, running)
    if (!isOfferSeen(expected, offer)) {
      console.log('[updates] Update refused: the version offered is not the one shown; the windows are told again')
      theChecker.tell()
      return snap()
    }
    const file = updateFileFor(offer, process.platform, process.arch)
    if (!offer || !file || s.busy || installer.refusal(file, s.source) !== null) return snap()
    void installer.start(offer, file)
    return snap()
  })
  ipcMain.handle('updates:cancel', (): UpdateSnapshot => { installer.cancel(); return snap() })
  // Restart reads the blockers afresh: what can only be read asynchronously (the backup helper's activity) first.
  ipcMain.handle('updates:restart', async (): Promise<UpdateSnapshot> => {
    try { await ports.refreshRestartBlockers?.() } catch { /* the blockers then say "unknown", which holds */ }
    installer.restart()
    return snap()
  })
  // Download takes no address: the link is the one the last validated feed gave for this computer.
  ipcMain.handle('updates:download', (): Promise<boolean> => {
    const latest = linkEntry()
    return latest ? open(downloadLinkFor(latest, process.platform, FEED_URL), (l) => isSiteLink(l, FEED_URL)) : Promise.resolve(false)
  })
  ipcMain.handle('updates:open-notes', (_e, version: unknown): Promise<boolean> => {
    if (typeof version !== 'string' || !parseVersion(version)) return Promise.resolve(false)
    const link = notesLinkFor(linkEntry(), version)
    return link ? open(link, (l) => isSiteLink(l, FEED_URL)) : Promise.resolve(false)
  })
  ipcMain.handle('updates:open-store', (): Promise<boolean> => open(STORE_LINK, (l) => l === STORE_LINK))
  ipcMain.handle('updates:whats-new', () => {
    const items = readNotes(running)
    const from = theChecker.snapshot().state.whatsNew?.from ?? null
    return items ? { version: running, from, items } : null
  })
  ipcMain.handle('updates:dismiss-whats-new', (): UpdateSnapshot => withInstall(theChecker.dismissWhatsNew()))

  theChecker.start()
  // While a download waits for a restart, the windows hear when a reason to wait appears or goes (an export
  // finishing, a turn ending): the Restart button and its reason follow without a click.
  let lastBlockers = ''
  const blockersChanged = (): void => {
    if (installer.state().phase !== 'waiting') { lastBlockers = ''; return }
    const now = blockersNow().join(' ')
    if (now === lastBlockers) return
    lastBlockers = now
    theChecker.tell()
  }
  // The backup helper's activity is kept fresh while waiting (read at most every 10 s), so the reason follows a cycle too.
  const watch = setInterval(() => {
    blockersChanged()
    if (installer.state().phase === 'waiting') void ports.refreshRestartBlockers?.(10_000).then(blockersChanged, () => {})
  }, 2000)
  watch.unref?.()
  app.once('will-quit', () => clearInterval(watch))
  return { checker: theChecker, blockersChanged }
}

import { updateTestOptions } from './update-notices-test-options'
// WriteFlex ports for the shared checker: persistence, IPC and bundled notes.
import { app, ipcMain, net, session, shell, type BrowserWindow } from 'electron'
import { request as httpRequest } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { downloadLinkFor, isSiteLink, parseVersion, copySource, parseWhatsNew, readUpdateState, createUpdateChecker, type UpdateState, type WhatsNewItem, type FeedAnswer, type UpdateChecker, type UpdateSnapshot } from '@app-patterns/updates'
import { createElectronFeedFetcher } from '@app-patterns/updates/electron'
import { UPDATE_IDENTITY, FEED_URL, FEED_REQUEST, STORE_LINK, notesLinkFor } from '../shared/update-identity.ts'

export interface UpdateNoticesPorts {
  /** Every window that may show a notice: the editor windows, never a presenting window. */
  editorWindows(): BrowserWindow[]
  /** Distraction-free writing is active in an editor window. */
  isProtectedNow(): boolean
  /** Persistence keys: `updateNotices` (state) and `updatesCheckForNewVersions` (the setting). */
  readConfig(): { updateNotices?: unknown; updatesCheckForNewVersions?: unknown; hadConfiguration?: boolean }
  writeConfig(patch: { updateNotices: UpdateState }): void
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


export function installUpdateNotices(ports: UpdateNoticesPorts): UpdateChecker {
  const running = app.getVersion()
  const store = process.mas === true || (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore === true
  const test = updateTestOptions(app.isPackaged, process.env)
  const tellWindows = (channel: string, snapshot: UpdateSnapshot): void => {
    for (const win of ports.editorWindows()) {
      try { if (!win.isDestroyed()) win.webContents.send(channel, snapshot) } catch { /* closing */ }
    }
  }
  const checker = createUpdateChecker({
    identity: UPDATE_IDENTITY,
    arch: process.arch,
    running,
    platform: process.platform,
    source: test.source ?? copySource({ packaged: app.isPackaged, store, running }),
    fetchFeed: () => fetchFeedOverNet(test.feedUrl ?? FEED_REQUEST.url),
    readState: () => readUpdateState(ports.readConfig().updateNotices, FEED_URL),
    writeState: (state) => ports.writeConfig({ updateNotices: state }),
    enabled: () => ports.readConfig().updatesCheckForNewVersions !== false,
    isBusy: ports.isProtectedNow,
    hasNotes: (version) => readNotes(version) !== null,
    hadConfiguration: () => ports.readConfig().hadConfiguration === true,
    now: () => Date.now(),
    changed: (snapshot) => tellWindows('updates:changed', snapshot),
    answered: (snapshot) => tellWindows('updates:answered', snapshot),
  })

  /** Hand a link to the browser: only one that passes the site rule (or the Store constant). */
  const open = async (link: string, allowed: (l: string) => boolean): Promise<boolean> => {
    if (!allowed(link)) return false
    try {
      if (ports.e2e) console.log('[update-notices] external (E2E):', link)
      else await shell.openExternal(link)
      return true
    } catch { return false }
  }

  ipcMain.handle('updates:get', (): UpdateSnapshot => checker.snapshot())
  ipcMain.handle('updates:check', (): Promise<UpdateSnapshot> => checker.checkNow())
  ipcMain.handle('updates:skip', (_e, version: unknown): UpdateSnapshot => (typeof version === 'string' && parseVersion(version) ? checker.skip(version) : checker.snapshot()))
  ipcMain.handle('updates:stop-skipping', (): UpdateSnapshot => checker.stopSkipping())
  ipcMain.handle('updates:not-now', (): UpdateSnapshot => checker.notNow())
  // Download takes no address: the link is the one the last validated feed gave for this computer.
  ipcMain.handle('updates:download', (): Promise<boolean> => {
    const latest = checker.snapshot().state.latest
    return latest ? open(downloadLinkFor(latest, process.platform, FEED_URL), (l) => isSiteLink(l, FEED_URL)) : Promise.resolve(false)
  })
  ipcMain.handle('updates:open-notes', (_e, version: unknown): Promise<boolean> => {
    if (typeof version !== 'string' || !parseVersion(version)) return Promise.resolve(false)
    const link = notesLinkFor(checker.snapshot().state.latest, version)
    return link ? open(link, (l) => isSiteLink(l, FEED_URL)) : Promise.resolve(false)
  })
  ipcMain.handle('updates:open-store', (): Promise<boolean> => open(STORE_LINK, (l) => l === STORE_LINK))
  ipcMain.handle('updates:whats-new', () => {
    const items = readNotes(running)
    const from = checker.snapshot().state.whatsNew?.from ?? null
    return items ? { version: running, from, items } : null
  })
  ipcMain.handle('updates:dismiss-whats-new', (): UpdateSnapshot => checker.dismissWhatsNew())

  checker.start()
  return checker
}

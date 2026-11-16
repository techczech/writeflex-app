// The daily check with channels (ADR-0054, porting TalkWeaver ADR-0044): WriteFlex's port of @app-patterns/updates'
// createUpdateChecker (0.4.1): the same timing, busy gate, Not now, Skip this version and What's new, with the feed read
// by update-channels.ts (release and alpha) instead of the release-only validator. Pure: the network, the clock, the
// timers and the stored state are handed in; unit-tested in tests/main/update-channels.test.ts.
import {
  BUSY_RETRY_MS, CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, compareVersions, noteLaunch, readUpdateState, whatsNewMark,
  type CheckOutcome, type CopySource, type FeedAnswer, type UpdateIdentity, type UpdateState, type WhatsNewMark,
} from '@app-patterns/updates'
import { RELEASE_ASSET_PREFIX, newerOffer, parseChannelFeed, validateChannelEntry, validateChannelFeedObject, type ChannelEntry, type ChannelFeed, type UpdateFile } from './update-channels.ts'
import type { InPlaceRefusal, InstallPhase, RestartBlocker } from './update-install.ts'

/** What is stored (settings.json `updateNotices`): the shared state, with the channels the last good check read. */
export interface ChannelUpdateState extends Omit<UpdateState, 'latest'> {
  /** The offer for the setting at the time of the last check (what older copies read back). */
  latest?: ChannelEntry
  channels?: ChannelFeed
}

export interface ChannelCheckerDeps {
  identity: UpdateIdentity
  running: string
  platform: string
  arch?: string
  source: CopySource
  /** Where update files may live (the public repository's releases; a loopback stand-in in tests). */
  assetPrefix?: string
  fetchFeed(): Promise<FeedAnswer>
  readState(): ChannelUpdateState
  writeState(state: ChannelUpdateState): void
  /** `updates.checkForNewVersions` (default on). */
  enabled(): boolean
  /** `updates.alphaVersions` (default off). */
  alpha(): boolean
  /** Distraction-free writing is on in a window. */
  isBusy(): boolean
  hasNotes(version: string): boolean
  hadConfiguration(): boolean
  now(): number
  changed(snapshot: CheckerSnapshot): void
  answered?(snapshot: CheckerSnapshot): void
  schedule?: typeof setTimeout
  cancel?: typeof clearTimeout
}

export interface CheckerSnapshot {
  identity: UpdateIdentity
  running: string
  platform: string
  arch?: string
  source: CopySource
  enabled: boolean
  alpha: boolean
  checking: boolean
  /** The stored state with `latest` set to the offer for the current setting (what the wording functions read). */
  state: ChannelUpdateState
  /** The version the status-bar mark offers, or null (null while busy, skipped, snoozed or checking off). */
  mark: ChannelEntry | null
  whatsNew: WhatsNewMark | null
  busy: boolean
  waiting: boolean
}

/** What the windows are told: the check's snapshot and the click's state (src/main/update-notices.ts). */
export interface UpdateSnapshot extends CheckerSnapshot {
  /** The click's state (idle, downloading, waiting, restarting, failed, reopen). */
  install: InstallPhase
  /** The file that would update this computer to the offered version, if the feed names one. */
  file: UpdateFile | null
  /** Why this copy cannot update itself to the offered version, or null when it can. */
  refusal: InPlaceRefusal | null
  /** What holds a restart back right now (only while working on an update). */
  blockers: RestartBlocker[]
}

/** Reads the stored state tolerantly: the shared fields as the shared reader reads them, the channels validated again. */
export function readChannelState(raw: unknown, feedUrl: string, assetPrefix: string = RELEASE_ASSET_PREFIX): ChannelUpdateState {
  const { latest: _dropped, ...shared } = readUpdateState(raw, feedUrl)
  const state: ChannelUpdateState = { ...shared }
  const r = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const channels = r.channels as { release?: unknown } | undefined
  if (channels && typeof channels === 'object') {
    const feed = validateChannelFeedObject({ schema: 1, latest: channels.release, channels }, feedUrl, assetPrefix)
    if (feed) state.channels = feed
  }
  // The stored offer, validated again as a release or an alpha entry.
  const latest = validateChannelEntry(r.latest, 'release', feedUrl, assetPrefix) ?? validateChannelEntry(r.latest, 'alpha', feedUrl, assetPrefix)
  if (latest) state.latest = latest
  return state
}

const mayCheckFrom = (source: CopySource): boolean => source === 'website' || source === 'preview'

export function createChannelChecker(deps: ChannelCheckerDeps) {
  const schedule = deps.schedule ?? setTimeout
  const cancel = deps.cancel ?? clearTimeout
  const mayCheck = mayCheckFrom(deps.source)
  const assetPrefix = deps.assetPrefix ?? RELEASE_ASSET_PREFIX
  let timer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<CheckerSnapshot> | null = null
  let stopped = false
  let waiting = false
  let lastBusy = false

  /** The offer for the setting now, newer than the running version or not (the wording reads `latest`). */
  function viewState(state: ChannelUpdateState, alpha: boolean): ChannelUpdateState {
    if (!state.channels) return { ...state, latest: undefined }
    const newer = newerOffer(state.channels, alpha, deps.running)
    return { ...state, latest: newer ?? state.channels.release }
  }

  function snapshot(): CheckerSnapshot {
    const stored = deps.readState()
    const enabled = deps.enabled()
    const alpha = deps.alpha()
    const now = deps.now()
    const busy = deps.isBusy()
    const state = viewState(stored, alpha)
    const offer = newerOffer(stored.channels, alpha, deps.running)
    let mark: ChannelEntry | null = null
    if (!busy && mayCheck && enabled && offer && stored.skippedVersion !== offer.version && !(stored.snoozedUntil !== undefined && now < stored.snoozedUntil)) mark = offer
    const whatsNew = whatsNewMark(stored as UpdateState, deps.running)
    return {
      identity: deps.identity, running: deps.running, platform: deps.platform, arch: deps.arch, source: deps.source,
      enabled, alpha, checking: running !== null, state, mark,
      whatsNew: whatsNew && deps.hasNotes(whatsNew.version) ? whatsNew : null,
      busy, waiting,
    }
  }
  const tell = (): CheckerSnapshot => {
    const s = snapshot()
    try { deps.changed(s) } catch { /* a closing window */ }
    return s
  }
  const patch = (next: Partial<ChannelUpdateState>): void => deps.writeState({ ...deps.readState(), ...next })

  function run(): Promise<CheckerSnapshot> {
    if (!mayCheck) return Promise.resolve(snapshot())
    if (running) return running
    let complete!: (s: CheckerSnapshot) => void
    const pending = new Promise<CheckerSnapshot>((resolve) => { complete = resolve })
    running = pending
    void (async () => {
      tell()
      if (deps.isBusy()) {
        waiting = true
        running = null
        arm(BUSY_RETRY_MS)
        complete(tell())
        return
      }
      let outcome: Partial<ChannelUpdateState>
      try {
        const answer = await deps.fetchFeed()
        if (!answer.ok) outcome = { lastResult: answer.reason === 'unreachable' ? 'unreachable' : 'unreadable' }
        else {
          const parsed = parseChannelFeed(answer.text, deps.identity.feedUrl, assetPrefix)
          if (!parsed.ok) outcome = { lastResult: 'unreadable' }
          else {
            const offer = newerOffer(parsed.feed, deps.alpha(), deps.running)
            outcome = {
              lastCheckAt: deps.now(),
              channels: parsed.feed,
              latest: offer ?? parsed.feed.release,
              snoozedUntil: undefined,
              lastResult: (offer ? 'newer' : 'current') as CheckOutcome,
            }
          }
        }
      } catch {
        outcome = { lastResult: 'unreachable' }
      }
      try { patch(outcome) } catch { /* not stored: the next check tries again */ }
      running = null
      complete(tell())
    })()
    return pending
  }

  function arm(ms: number): void {
    if (timer !== null) cancel(timer)
    timer = stopped ? null : schedule(() => { timer = null; void tick() }, Math.max(1000, ms))
  }

  async function tick(): Promise<void> {
    if (stopped) return
    if (waiting) {
      if (deps.isBusy()) { arm(BUSY_RETRY_MS); return }
      waiting = false
      const done = await run()
      try { deps.answered?.(done) } catch { /* a closing window */ }
      arm(CHECK_INTERVAL_MS)
      return
    }
    if (!deps.enabled()) { arm(CHECK_INTERVAL_MS); return }
    if (deps.isBusy()) { arm(BUSY_RETRY_MS); return }
    const last = deps.readState().lastCheckAt
    const sinceLast = last === undefined ? Infinity : deps.now() - last
    if (sinceLast < CHECK_INTERVAL_MS && sinceLast >= 0) { arm(CHECK_INTERVAL_MS - sinceLast); return }
    await run()
    arm(CHECK_INTERVAL_MS)
  }

  return {
    snapshot,
    /** At launch: record the version run (and start What's new), then wait for the first check. */
    start(): CheckerSnapshot {
      try {
        const state = deps.readState()
        const next = noteLaunch(state as UpdateState, deps.running, deps.now(), deps.hadConfiguration()) as ChannelUpdateState
        if (next !== (state as unknown)) deps.writeState(next)
      } catch { /* What's new is a courtesy */ }
      if (mayCheck) arm(FIRST_CHECK_DELAY_MS)
      return tell()
    },
    stop(): void {
      stopped = true
      if (timer !== null) cancel(timer)
      timer = null
    },
    /** Check for Updates…: always checks (a copy that may check), whatever the setting says. */
    checkNow(): Promise<CheckerSnapshot> {
      if (!mayCheck) return Promise.resolve(snapshot())
      if (deps.isBusy() && !running) {
        waiting = true
        arm(BUSY_RETRY_MS)
        return Promise.resolve(tell())
      }
      return run()
    },
    busyChanged(): void {
      const now = deps.isBusy()
      if (now !== lastBusy) { lastBusy = now; tell() }
      if (!now && waiting && !stopped) {
        if (timer !== null) cancel(timer)
        timer = null
        void tick()
      }
    },
    /** A setting changed: switching checking on checks soon if one is due; the alpha switch re-reads the last answer at once. */
    settingChanged(): CheckerSnapshot {
      if (mayCheck && deps.enabled()) arm(FIRST_CHECK_DELAY_MS)
      return tell()
    },
    skip(version: string): CheckerSnapshot { patch({ skippedVersion: version }); return tell() },
    stopSkipping(): CheckerSnapshot { patch({ skippedVersion: undefined }); return tell() },
    notNow(): CheckerSnapshot { patch({ snoozedUntil: deps.now() + CHECK_INTERVAL_MS }); return tell() },
    dismissWhatsNew(): CheckerSnapshot {
      const state = deps.readState()
      if (state.whatsNew) patch({ whatsNew: { ...state.whatsNew, dismissed: true } })
      return tell()
    },
    /** Tell the windows again (the install state changed). */
    tell,
  }
}
export type ChannelChecker = ReturnType<typeof createChannelChecker>

/** Is this offer newer than the running version (for a wording function that has only the two). */
export const isNewerVersion = (offer: { version: string } | null | undefined, running: string): boolean =>
  !!offer && compareVersions(offer.version, running) > 0

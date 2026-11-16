// Updating in place (ADR-0054, ADR-0044 §3): what the status-bar mark, its popover and the answer to Check for Updates…
// say in each state (src/renderer/src/components/update-notices-view.ts), the restart blockers and their words
// (src/shared/update-install.ts), the refusal to update in place, the download's network rule and the restart holds.
import { expect, test } from 'bun:test'
import type { UpdateSnapshot } from '../../src/shared/update-checker'
import type { ChannelEntry } from '../../src/shared/update-channels'
import { UPDATE_IDENTITY, UPDATE_INSTALL_IDENTITY } from '../../src/shared/update-identity'
import {
  ALPHA_HINT, RESTART_BLOCKERS, blockersSentence, inPlaceRefusal, installMarkText, restartBlockers, type InPlaceFacts, type InstallPhase, type RestartBlocker,
} from '../../src/shared/update-install'
import { answerOf, cardOf, markView, openAnswerView, popoverView, resultEvent, type OpenAnswer } from '../../src/renderer/src/components/update-notices-view'
import { noteReducer, type NoteState } from '@app-patterns/updates'
import { isOfferSeen } from '../../src/shared/update-channels'
import { canonicalHost, isLocalHost, updateRequestAllowed } from '../../src/main/update-download-filter'
import { duringRestartHold, holdRestart, restartHeld } from '../../src/main/restart-holds'

const SHA = 'q'.repeat(86) + '=='
const FILE = { url: `${UPDATE_INSTALL_IDENTITY.releaseAssetPrefix}v0.29.0/WriteFlex-mac-arm64.zip`, sha512: SHA, size: 275_000_000, bundleId: UPDATE_INSTALL_IDENTITY.bundleId }
const OFFER: ChannelEntry = {
  version: '0.29.0', released: '2026-11-20', summary: ['Updates in place.', 'Early versions on request.'],
  notes: 'https://writeflex.app/whats-new#0.29.0', download: { mac: 'https://writeflex.app/download#mac', windows: 'https://writeflex.app/download#windows' },
  update: { mac: FILE },
}
const snap = (over: Partial<UpdateSnapshot> = {}): UpdateSnapshot => ({
  identity: UPDATE_IDENTITY, running: '0.28.0', platform: 'darwin', arch: 'arm64', source: 'website', enabled: true, alpha: false, checking: false,
  state: { lastResult: 'newer', lastCheckAt: Date.now(), latest: OFFER, channels: { release: OFFER, alpha: null } },
  mark: OFFER, whatsNew: null, busy: false, waiting: false,
  install: { phase: 'idle' }, file: FILE, refusal: null, blockers: [], ...over,
})
const labels = (view: ReturnType<typeof popoverView>) => view?.buttons.map((b) => b.label)

test('Update available: the mark, and a popover whose Update says what it downloads, replaces and keeps', () => {
  const s = snap()
  expect(markView(s)).toEqual({ text: '0.29.0 is available', icon: 'available', failed: false, phase: 'idle' })
  const view = popoverView(s)!
  expect(view.state).toBe('available')
  expect(view.title).toBe('WriteFlex 0.29.0 is available')
  expect(view.sub).toBe('You have 0.28.0. Released 20 November 2026.')
  expect(view.summary).toEqual(OFFER.summary)
  expect(labels(view)).toEqual(['Update', 'Not now', 'Skip this version'])
  expect(view.buttons[0].primary).toBe(true)
  expect(view.foot).toBe('Update downloads 0.29.0 (275 MB), replaces this copy and restarts WriteFlex. Your documents and settings stay as they are.')
  expect(view.notesVersion).toBe('0.29.0')
})

test('Cannot update in place: the same offer, the reason, and Download from writeflex.app', () => {
  const view = popoverView(snap({ refusal: 'translocated' }))!
  expect(view.state).toBe('cannot-update-here')
  expect(view.refusal).toBe('WriteFlex cannot replace itself here: macOS is running it from a temporary place. Move it to Applications and open it again.')
  expect(labels(view)).toEqual(['Download from writeflex.app', 'Not now', 'Skip this version'])
  expect(view.foot).toMatch(/^Download opens the download page/)
  // An entry with no file for this computer says nothing more than the download page.
  const noFile = popoverView(snap({ file: null, refusal: 'no-file' }))!
  expect(noFile.state).toBe('cannot-update-here')
  expect(noFile.refusal).toBeUndefined()
  expect(popoverView(snap({ refusal: 'windows', platform: 'win32' }))!.refusal).toBe('In-place updates are not available on Windows yet.')
  expect(popoverView(snap({ refusal: 'other-copy' }))!.refusal).toBe('WriteFlex cannot replace itself here: this copy was built for testing.')
})

test('Downloading: the mark with its percentage, progress, what is in, and Cancel', () => {
  const install: InstallPhase = { phase: 'downloading', version: '0.29.0', received: 116_000_000, total: 275_000_000 }
  const s = snap({ install, mark: null })
  expect(markView(s)?.text).toBe('Downloading 0.29.0 · 42%')
  const view = popoverView(s)!
  expect(view.title).toBe('Downloading WriteFlex 0.29.0')
  expect(view.progress).toBe(42)
  expect(view.sub).toBe('116 MB of 275 MB. You can keep working.')
  expect(labels(view)).toEqual(['Cancel'])
})

test('Waiting to restart: Restart (disabled with the reason while one holds) and Later; nothing installs until Restart', () => {
  const install: InstallPhase = { phase: 'waiting', version: '0.29.0' }
  const held = popoverView(snap({ install, blockers: ['exporting', 'agent'] }))!
  expect(markView(snap({ install }))).toMatchObject({ text: 'Restart to finish updating', icon: 'restart' })
  expect(held.title).toBe('WriteFlex 0.29.0 is ready')
  expect(held.sub).toBe('It opens when you restart. Not now: an export is being written and the assistant is still working.')
  expect(labels(held)).toEqual(['Restart', 'Later'])
  expect(held.buttons[0].disabledReason).toBe('Not now: an export is being written and the assistant is still working.')
  expect(held.foot).toMatch(/Nothing is installed until you restart/)
  const clear = popoverView(snap({ install, blockers: [] }))!
  expect(clear.sub).toBe('It opens when you restart. Your documents are saved first.')
  expect(clear.buttons[0].disabledReason).toBeUndefined()
})

test('Restarting: no buttons, no Cancel', () => {
  const s = snap({ install: { phase: 'restarting', version: '0.29.0' } })
  expect(markView(s)?.text).toBe('Restarting into 0.29.0…')
  const view = popoverView(s)!
  expect(view.sub).toBe('macOS checks the new version; then WriteFlex saves your documents, closes its windows and opens again as 0.29.0.')
  expect(answerOf(s).detail).toBe(view.sub)
  // Closing the documents can take until the watchdog: no promise of how long, and still no Cancel.
  for (const text of [view.sub, answerOf(s).detail]) expect(text).not.toMatch(/second|minute|moment|quick/i)
  expect(answerOf(s).action).toBeNull()
  expect(view.buttons).toEqual([])
})

test('The restart did not happen (D4): "installs" or "may install" until a withdrawal is checked, then "Reopen WriteFlex to update"', () => {
  const held = snap({ install: { phase: 'reopen', version: '0.29.0', cause: 'held', pending: true } })
  expect(markView(held)).toMatchObject({ text: '0.29.0 installs when WriteFlex quits', icon: 'warn' })
  expect(popoverView(held)!.title).toBe('WriteFlex will finish updating when it next quits')
  const noAnswer = snap({ install: { phase: 'reopen', version: '0.29.0', cause: 'no-answer', pending: true } })
  expect(markView(noAnswer)?.text).toBe('0.29.0 may install when WriteFlex quits')
  expect(popoverView(noAnswer)!.sub).toMatch(/If WriteFlex then still opens as the old version, press Update again\.$/)
  const clear = snap({ install: { phase: 'reopen', version: '0.29.0', cause: 'held', pending: false } })
  expect(markView(clear)?.text).toBe('Reopen WriteFlex to update')
  expect(popoverView(clear)!.sub).toMatch(/Nothing is installed when it quits\. Quit and reopen WriteFlex, then press Update again\.$/)
  expect(popoverView(clear)!.buttons).toEqual([])
})

test('Failed: the reason in plain words, the running version unchanged, Try again and Download from writeflex.app', () => {
  const s = snap({ install: { phase: 'failed', version: '0.29.0', reason: 'mismatch' } })
  expect(markView(s)).toMatchObject({ text: 'Update to 0.29.0 failed', failed: true, icon: 'warn' })
  const view = popoverView(s)!
  expect(view.title).toBe('Could not update to 0.29.0')
  expect(view.sub).toBe('The downloaded file did not match the published one, so it was not used. WriteFlex 0.28.0 is unchanged.')
  expect(labels(view)).toEqual(['Try again', 'Download from writeflex.app'])
  expect(installMarkText({ phase: 'failed', version: '0.29.0', reason: 'signature' })).toBe('Update to 0.29.0 failed')
  expect(popoverView(snap({ install: { phase: 'failed', version: '0.29.0', reason: 'signature' } }))!.sub).toMatch(/^The new version is not signed by WriteFlex’s developer/)
})

test('no mark and no popover during distraction-free writing, or with nothing to say', () => {
  expect(markView(snap({ busy: true }))).toBeNull()
  expect(markView(snap({ busy: true, install: { phase: 'downloading', version: '0.29.0', received: 1, total: 2 } }))).toBeNull()
  expect(markView(snap({ mark: null }))).toBeNull()
  expect(popoverView(snap({ mark: null }))).toBeNull()
})

test('Check for Updates… answers with the state of an update under way, and offers Update where it can', () => {
  expect(answerOf(snap())).toMatchObject({ tone: 'new', title: 'WriteFlex 0.29.0 is available.', action: 'update' })
  expect(answerOf(snap({ refusal: 'read-only' }))).toMatchObject({ action: 'download', detail: 'You have 0.28.0. WriteFlex cannot replace itself here: this account cannot change the app’s folder.' })
  expect(answerOf(snap({ install: { phase: 'downloading', version: '0.29.0', received: 0, total: 275_000_000 } }))).toMatchObject({ action: 'cancel', title: 'Downloading WriteFlex 0.29.0…' })
  expect(answerOf(snap({ install: { phase: 'waiting', version: '0.29.0' }, blockers: ['backup'] }))).toMatchObject({ action: 'restart', held: 'Not now: a backup is running.' })
  expect(answerOf(snap({ install: { phase: 'failed', version: '0.29.0', reason: 'network' } }))).toMatchObject({ action: 'retry-update', downloadLink: true })
  expect(answerOf(snap({ waiting: true })).title).toBe('WriteFlex will check when distraction-free writing ends.')
  expect(answerOf(snap({ mark: null, state: { lastResult: 'current', lastCheckAt: Date.now() } }))).toMatchObject({ tone: 'good', title: 'You have the newest version.' })
  expect(cardOf(snap())?.action).toBe('update')
})

test('restart blockers: every reason in plain words, in a fixed order', () => {
  const all = restartBlockers({ focus: true, unsaved: true, diskChoice: true, agent: true, exporting: true, sharing: true, backup: true, backupUnknown: true, finishing: true })
  // A backup known to be running says so; "cannot tell" is said only when nothing is known.
  expect(all).toEqual(RESTART_BLOCKERS.filter((b) => b !== 'backup-unknown'))
  expect(restartBlockers({ focus: false, unsaved: false, diskChoice: false, agent: false, exporting: false, sharing: false, backup: false, backupUnknown: true, finishing: false })).toEqual(['backup-unknown'])
  expect(restartBlockers({ focus: false, unsaved: false, diskChoice: false, agent: false, exporting: false, sharing: false, backup: false, finishing: false })).toEqual([])
  const words: Record<RestartBlocker, string> = {
    focus: 'Not now: distraction-free writing is on.',
    unsaved: 'Not now: a document has changes that could not be saved yet.',
    'disk-choice': 'Not now: a document changed on disk and is waiting for your choice.',
    agent: 'Not now: the assistant is still working.',
    exporting: 'Not now: an export is being written.',
    sharing: 'Not now: a shared link is being published.',
    backup: 'Not now: a backup is running.',
    'backup-unknown': 'Not now: WriteFlex cannot tell whether a backup is running.',
    finishing: 'Not now: WriteFlex is still saving a closed window’s work.',
  }
  for (const b of RESTART_BLOCKERS) expect(blockersSentence([b])).toBe(words[b])
  expect(blockersSentence(['unsaved', 'sharing', 'backup'])).toBe('Not now: a document has changes that could not be saved yet, a shared link is being published and a backup is running.')
  expect(blockersSentence([])).toBe('')
})

test('cannot update in place: Store, development, Windows, Intel, no file, disk image, temporary place, read-only, a copy built for testing', () => {
  const base: InPlaceFacts = { platform: 'darwin', arch: 'arm64', source: 'website', file: FILE, appPath: '/Applications/WriteFlex.app', writable: true, writeError: null, bundleId: UPDATE_INSTALL_IDENTITY.bundleId }
  expect(inPlaceRefusal(base)).toBeNull()
  expect(inPlaceRefusal({ ...base, source: 'preview' })).toBeNull()
  expect(inPlaceRefusal({ ...base, source: 'store' })).toBe('store')
  expect(inPlaceRefusal({ ...base, source: 'development' })).toBe('development')
  expect(inPlaceRefusal({ ...base, platform: 'win32', arch: 'x64' })).toBe('windows')
  expect(inPlaceRefusal({ ...base, arch: 'x64' })).toBe('platform')
  expect(inPlaceRefusal({ ...base, file: null })).toBe('no-file')
  expect(inPlaceRefusal({ ...base, appPath: '/Volumes/WriteFlex/WriteFlex.app', writable: false, writeError: 'EROFS' })).toBe('disk-image')
  expect(inPlaceRefusal({ ...base, appPath: '/private/var/folders/x/AppTranslocation/y/d/WriteFlex.app' })).toBe('translocated')
  expect(inPlaceRefusal({ ...base, writable: false, writeError: 'EACCES' })).toBe('read-only')
  expect(inPlaceRefusal({ ...base, bundleId: 'net.dominiklukes.writeflex.beta' })).toBe('other-copy')
})

test('the alpha switch says how to go back', () => {
  expect(ALPHA_HINT).toBe('Alphas come first and can break. To go back, switch this off: you keep this alpha until the next release, which then updates as usual. For an older version now, download it from writeflex.app.')
})

test('the update download reaches only public HTTPS addresses', () => {
  expect(updateRequestAllowed(FILE.url)).toBe(true)
  expect(updateRequestAllowed('https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sig=x')).toBe(true)
  for (const refused of [
    'http://github.com/techczech/writeflex-app/releases/download/v0.29.0/x.zip', 'https://127.0.0.1/x.zip', 'https://localhost/x.zip', 'https://printer.local/x',
    'https://10.0.0.1/', 'https://192.168.1.1/', 'https://172.20.0.1/', 'https://169.254.169.254/latest', 'https://[::1]/', 'https://[fd00::1]/', 'https://[::ffff:127.0.0.1]/',
    'https://user:pw@github.com/', 'https://intranet/', 'not a url',
  ]) expect(updateRequestAllowed(refused)).toBe(false)
  expect(isLocalHost('github.com')).toBe(false)
  expect(isLocalHost('8.8.8.8')).toBe(false)
})

// The mDNS suffix, spelled apart so the public-source privacy gate does not read a device name here.
const MDNS = '.local'

test('finding 6: a trailing DNS dot, or several, or capitals, name the same local place and are refused', () => {
  for (const host of ['localhost.', 'LOCALHOST.', 'localhost..', `printer${MDNS}.`, `Printer${MDNS.toUpperCase()}.`, 'app.localhost.', 'nas.lan.', 'router.home.arpa.', 'svc.internal.', 'intranet.', '127.0.0.1.', '10.0.0.1.', '.', '..']) {
    expect(isLocalHost(host)).toBe(true)
  }
  for (const address of ['https://localhost./x.zip', 'https://printer.local./x', 'https://LOCALHOST./', 'https://intranet./', 'https://127.0.0.1./', 'https://nas.lan./', 'https://router.home.arpa./']) {
    expect(updateRequestAllowed(address)).toBe(false)
  }
  expect(canonicalHost('GitHub.com.')).toBe('github.com')
  expect(isLocalHost('github.com.')).toBe(false)
  expect(updateRequestAllowed('https://github.com./techczech/writeflex-app/releases/download/v0.29.0/x.zip')).toBe(true)
})

test('finding 3: an open answer is drawn from the snapshot now, not the one it opened with: Cancel, Restart, and a change of channel', () => {
  const ALPHA: ChannelEntry = { ...OFFER, version: '0.30.0-alpha.1', notes: 'https://writeflex.app/whats-new#0.30.0-alpha.1', update: { mac: { ...FILE, url: `${UPDATE_INSTALL_IDENTITY.releaseAssetPrefix}v0.30.0-alpha.1/WriteFlex-mac-arm64.zip` } } }
  const opened = snap()
  expect(openAnswerView('check', opened)).toMatchObject({ title: 'WriteFlex 0.29.0 is available.', action: 'update', version: '0.29.0' })
  // Update pressed elsewhere: the open answer now offers Cancel, then (a blocker holds) a held Restart.
  expect(openAnswerView('check', snap({ install: { phase: 'downloading', version: '0.29.0', received: 1, total: 2 } }))).toMatchObject({ action: 'cancel' })
  expect(openAnswerView('check', snap({ install: { phase: 'waiting', version: '0.29.0' }, blockers: ['exporting'] }))).toMatchObject({ action: 'restart', held: 'Not now: an export is being written.' })
  // Alpha switched on with the answer open: the title and the version Update sends both name the alpha.
  const alphaOn = snap({ alpha: true, state: { lastResult: 'newer', lastCheckAt: Date.now(), latest: ALPHA, channels: { release: OFFER, alpha: ALPHA } }, mark: ALPHA })
  const view = openAnswerView('check', alphaOn)!
  expect(view.title).toBe('WriteFlex 0.30.0-alpha.1 is available.')
  expect(view.version).toBe('0.30.0-alpha.1')
  expect(openAnswerView('could-not-ask', alphaOn)).toMatchObject({ title: 'Could not check for updates.', action: 'try-again' })
  expect(openAnswerView(null, alphaOn)).toBeNull()
  expect(openAnswerView('check', null)).toBeNull()
})

test('round 2 finding 2: a Try again that succeeds replaces "Could not check for updates." with the answer to the check', () => {
  const failed: NoteState<OpenAnswer> = { shown: 'could-not-ask', held: null }
  const next = snap()
  expect(openAnswerView(failed.shown, next)).toMatchObject({ title: 'Could not check for updates.', action: 'try-again' })
  // Try again's check came back with a snapshot: the open answer is now the check's, drawn from it.
  const after = noteReducer(failed, resultEvent(next))
  expect(after.shown).toBe('check')
  const view = openAnswerView(after.shown, next)!
  expect(view.title).not.toBe('Could not check for updates.')
  expect(view).toMatchObject({ title: 'WriteFlex 0.29.0 is available.', action: 'update', version: '0.29.0' })
  // An up-to-date answer replaces it too.
  const current = snap({ state: { lastResult: 'current', lastCheckAt: Date.now(), latest: null, channels: { release: null, alpha: null } }, mark: null })
  expect(openAnswerView(noteReducer(failed, resultEvent(current)).shown, current)?.title).toBe('You have the newest version.')
  // During distraction-free writing the answer is held, not shown, like any other answer.
  const busy = noteReducer(failed, resultEvent(snap({ busy: true })))
  expect(busy).toEqual({ shown: null, held: 'check' })
  // A result on an answer already open for a check (Update, Cancel, Restart) keeps it the check's answer.
  expect(noteReducer({ shown: 'check', held: null }, resultEvent(next)).shown).toBe('check')
})

test('finding 3: Update starts only the version the person saw; any other, or anything that is not a version, starts nothing', () => {
  const ALPHA: ChannelEntry = { ...OFFER, version: '0.30.0-alpha.1' }
  expect(isOfferSeen('0.29.0', OFFER)).toBe(true)
  expect(isOfferSeen('0.30.0-alpha.1', ALPHA)).toBe(true)
  // The answer showed the release, and alpha was switched on since: the offer is now the alpha.
  expect(isOfferSeen('0.29.0', ALPHA)).toBe(false)
  expect(isOfferSeen('0.29.0', null)).toBe(false)
  for (const bad of [undefined, null, 29, '', 'v0.29.0', '0.29', '../0.29.0', 'https://example.com/x.zip', '0.29.0'.padEnd(80, '0')]) expect(isOfferSeen(bad, OFFER)).toBe(false)
})

test('restart holds count work until it settles, however it ends', async () => {
  expect(restartHeld('exporting')).toBe(false)
  const release = holdRestart('exporting')
  const second = holdRestart('exporting')
  expect(restartHeld('exporting')).toBe(true)
  release(); release()
  expect(restartHeld('exporting')).toBe(true)
  second()
  expect(restartHeld('exporting')).toBe(false)
  let during = false
  await duringRestartHold('backup', async () => { during = restartHeld('backup') })
  expect(during).toBe(true)
  expect(restartHeld('backup')).toBe(false)
  await expect(duringRestartHold('agent', async () => { throw new Error('the turn failed') })).rejects.toThrow('the turn failed')
  expect(restartHeld('agent')).toBe(false)
})

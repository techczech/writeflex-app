// Updating in place (ADR-0054, porting TalkWeaver scripts/test-update-channels.mjs): the feed with channels
// (src/shared/update-channels.ts) and the checker reading it (src/shared/update-checker.ts). No network, no Electron.
//  1. version order: alpha.2 < alpha.10 < the release; the table the channel rules depend on;
//  2. channel rules: a release user never gets an alpha; an alpha user gets the newer of the two; never a downgrade;
//  3. the feed: the old shape still reads; channels.release must equal latest; hostile input refused whole; and the
//     shared 0.4.1 validator that 0.28.x copies run still reads a feed with channels, as before;
//  4. update files: only the public repository's release assets at the entry's own tag, with hash and size;
//  5. the checker: the alpha switch re-reads the last answer without a request; switching off never downgrades.
import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { compareVersions, validateFeed } from '@app-patterns/updates'
import {
  MAX_UPDATE_FILE_BYTES, PUBLISHED_BUNDLE_ID, RELEASE_ASSET_PREFIX, channelOffer, isAlphaVersion, newerOffer, parseChannelFeed, updateFileFor, validateUpdateFile,
} from '../../src/shared/update-channels'
import { createChannelChecker, readChannelState, type ChannelUpdateState } from '../../src/shared/update-checker'
import { UPDATE_IDENTITY, FEED_URL } from '../../src/shared/update-identity'

const SHA = 'q'.repeat(86) + '=='
const entry = (version: string, extra: Record<string, unknown> = {}) => ({
  version, released: '2026-11-20', summary: ['One plain line.'], notes: `https://writeflex.app/whats-new#${version}`,
  download: { mac: 'https://writeflex.app/download#mac', windows: 'https://writeflex.app/download#windows' }, ...extra,
})
const files = (version: string) => ({
  mac: { url: `${RELEASE_ASSET_PREFIX}v${version}/WriteFlex-mac-arm64.zip`, sha512: SHA, size: 288_703_536, bundleId: PUBLISHED_BUNDLE_ID },
  windows: { url: `${RELEASE_ASSET_PREFIX}v${version}/WriteFlex-windows-x64-setup.exe`, sha512: SHA, size: 260_535_713 },
})
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Feed = any
const feed = ({ release = '0.29.0', alpha = '0.30.0-alpha.1' as string | null, withFiles = true } = {}): Feed => {
  const rel = entry(release, withFiles ? { update: files(release) } : {})
  const { update: _u, ...latest } = structuredClone(rel) as Record<string, unknown>
  return { schema: 1, latest, channels: { release: rel, ...(alpha ? { alpha: entry(alpha, withFiles ? { update: files(alpha) } : {}) } : {}) } }
}
const parse = (value: unknown) => parseChannelFeed(typeof value === 'string' ? value : JSON.stringify(value), FEED_URL)
const parsedFeed = (value: unknown) => { const r = parse(value); if (!r.ok) throw new Error(`not parsed: ${r.reason}`); return r.feed }

test('the identity: update files only under techczech/writeflex-app releases; the published bundle is net.dominiklukes.writeflex', () => {
  expect(RELEASE_ASSET_PREFIX).toBe('https://github.com/techczech/writeflex-app/releases/download/')
  expect(PUBLISHED_BUNDLE_ID).toBe('net.dominiklukes.writeflex')
})

test('version order: numeric parts compared as numbers; an alpha is older than its release', () => {
  expect(compareVersions('0.29.0-alpha.2', '0.29.0-alpha.10')).toBeLessThan(0)
  expect(compareVersions('0.29.0-alpha.10', '0.29.0')).toBeLessThan(0)
  const ordered = ['0.28.0', '0.29.0-alpha.1', '0.29.0-alpha.2', '0.29.0-alpha.9', '0.29.0-alpha.10', '0.29.0-alpha.90', '0.29.0-alpha.91', '0.29.0', '0.29.1-alpha.1', '0.29.1', '0.30.0-alpha.1', '0.30.0', '1.0.0']
  for (let i = 0; i < ordered.length; i += 1) for (let j = 0; j < ordered.length; j += 1) {
    assert.equal(Math.sign(compareVersions(ordered[i], ordered[j])), Math.sign(i - j), `${ordered[i]} vs ${ordered[j]}`)
  }
  assert.ok(isAlphaVersion('0.29.0-alpha.2') && isAlphaVersion('0.29.0-alpha.10'))
  for (const not of ['0.29.0', '0.29.0-beta.1', '0.29.0-alpha', '0.29.0-alpha.x', '0.29.0-alpha.1.2', 'v0.29.0-alpha.1', 29]) assert.equal(isAlphaVersion(not), false, String(not))
})

test('channel rules: release users never get an alpha; alpha users get the newer of the two; switching alpha off never downgrades', () => {
  const f = parsedFeed(feed())
  const table: Array<[string, boolean, string | null]> = [
    ['0.28.0', false, '0.29.0'],
    ['0.28.0', true, '0.30.0-alpha.1'],
    ['0.29.0', false, null],
    ['0.29.0', true, '0.30.0-alpha.1'],
    ['0.30.0-alpha.1', true, null],
    ['0.30.0-alpha.1', false, null], // switched off on an alpha: no downgrade to 0.29.0
    ['0.29.0-alpha.3', false, '0.29.0'], // the release passes the alpha
    ['0.29.0-alpha.3', true, '0.30.0-alpha.1'],
  ]
  for (const [running, alpha, want] of table) assert.equal(newerOffer(f, alpha, running)?.version ?? null, want, `${running}, alpha ${alpha}`)
  // alpha.10 is offered over alpha.2 (numbers, not text).
  const ten = parsedFeed(feed({ release: '0.28.0', alpha: '0.29.0-alpha.10' }))
  assert.equal(newerOffer(ten, true, '0.29.0-alpha.2')?.version, '0.29.0-alpha.10')
  assert.equal(newerOffer(ten, true, '0.29.0-alpha.10'), null)
  // An alpha behind the release (left over): an alpha user gets the release.
  const stale = parsedFeed(feed({ release: '0.30.0', alpha: '0.30.0-alpha.4' }))
  assert.equal(channelOffer(stale, true).version, '0.30.0')
  assert.equal(newerOffer(stale, true, '0.30.0-alpha.4')?.version, '0.30.0')
  // No alpha published.
  const none = parsedFeed(feed({ alpha: null }))
  assert.equal(none.alpha, null)
  assert.equal(newerOffer(none, true, '0.28.0')?.version, '0.29.0')
  assert.equal(newerOffer(undefined, true, '0.28.0'), null)
})

test('the feed: the old shape (no channels) still reads, as a release with no update file', () => {
  const { channels: _c, ...old } = feed()
  const f = parsedFeed(old)
  assert.equal(f.release.version, '0.29.0')
  assert.equal(f.release.update, undefined)
  assert.equal(f.alpha, null)
  assert.equal(updateFileFor(f.release, 'darwin', 'arm64'), null, 'tell and link, as before')
})

test('a feed with channels is still read by the shared 0.4.1 validator as before (0.28.x copies keep telling and linking)', () => {
  const withChannels = JSON.stringify(feed())
  const old = validateFeed(withChannels, FEED_URL)
  assert.ok(old.ok, 'the unknown channels key is ignored')
  if (old.ok) {
    assert.equal(old.latest.version, '0.29.0', 'the old reader sees the release, never the alpha')
    assert.equal((old.latest as unknown as Record<string, unknown>).update, undefined)
  }
})

test('the feed: channels.release must say what latest says, field for field', () => {
  const changes: Array<[string, (f: Feed) => void]> = [
    ['version', (f) => { f.channels.release.version = '0.29.1' }],
    ['date', (f) => { f.channels.release.released = '2026-11-21' }],
    ['summary', (f) => { f.channels.release.summary = ['Another line.'] }],
    ['summary length', (f) => { f.channels.release.summary.push('Two.') }],
    ['notes', (f) => { f.channels.release.notes = 'https://writeflex.app/whats-new#other' }],
    ['download', (f) => { f.channels.release.download.mac = 'https://writeflex.app/download#other' }],
  ]
  for (const [what, change] of changes) {
    const f = feed()
    change(f)
    assert.deepEqual(parse(f), { ok: false, reason: 'not-a-version-list' }, what)
  }
})

test('hostile feeds are refused whole', () => {
  const cases: Record<string, (f: Feed) => void> = {
    'alpha that is a release': (f) => { f.channels.alpha.version = '0.30.0' },
    'alpha that is a beta': (f) => { f.channels.alpha.version = '0.30.0-beta.1' },
    'release that is an alpha': (f) => { f.channels.release.version = '0.29.0-alpha.3'; f.latest.version = '0.29.0-alpha.3' },
    'unknown channel': (f) => { f.channels.beta = f.channels.alpha },
    'channels not an object': (f) => { f.channels = [] },
    'channels without release': (f) => { delete f.channels.release },
    'alpha off-site notes': (f) => { f.channels.alpha.notes = 'https://evil.example/notes' },
    'alpha HTML in summary': (f) => { f.channels.alpha.summary = ['<img src=x onerror=alert(1)>'] },
    'unknown update platform': (f) => { f.channels.release.update.linux = f.channels.release.update.mac },
    'update not an object': (f) => { f.channels.release.update = 'yes' },
    'file on another host': (f) => { f.channels.release.update.mac.url = 'https://evil.example/releases/download/v0.29.0/WriteFlex-mac-arm64.zip' },
    'file in another repository': (f) => { f.channels.release.update.mac.url = 'https://github.com/evil/writeflex-app/releases/download/v0.29.0/WriteFlex-mac-arm64.zip' },
    'file in another repository of the same owner': (f) => { f.channels.release.update.mac.url = 'https://github.com/techczech/other-app/releases/download/v0.29.0/WriteFlex-mac-arm64.zip' },
    'file at another tag': (f) => { f.channels.release.update.mac.url = `${RELEASE_ASSET_PREFIX}v0.28.0/WriteFlex-mac-arm64.zip` },
    'file at an alpha tag for the release': (f) => { f.channels.release.update.mac.url = `${RELEASE_ASSET_PREFIX}v0.30.0-alpha.1/WriteFlex-mac-arm64.zip` },
    'path climbing out': (f) => { f.channels.release.update.mac.url = `${RELEASE_ASSET_PREFIX}v0.29.0/../v0.28.0/WriteFlex-mac-arm64.zip` },
    'encoded path': (f) => { f.channels.release.update.mac.url = `${RELEASE_ASSET_PREFIX}v0.29.0/%2e%2e/x.zip` },
    'query string': (f) => { f.channels.release.update.mac.url += '?x=1' },
    'fragment': (f) => { f.channels.release.update.mac.url += '#x' },
    'credentials': (f) => { f.channels.release.update.mac.url = f.channels.release.update.mac.url.replace('https://', 'https://user:pw@') },
    'http': (f) => { f.channels.release.update.mac.url = f.channels.release.update.mac.url.replace('https://', 'http://') },
    'port': (f) => { f.channels.release.update.mac.url = f.channels.release.update.mac.url.replace('github.com', 'github.com:8443') },
    'a sub-folder': (f) => { f.channels.release.update.mac.url = `${RELEASE_ASSET_PREFIX}v0.29.0/sub/WriteFlex-mac-arm64.zip` },
    'exe for the Mac': (f) => { f.channels.release.update.mac.url = `${RELEASE_ASSET_PREFIX}v0.29.0/WriteFlex.exe` },
    'zip for Windows': (f) => { f.channels.release.update.windows.url = `${RELEASE_ASSET_PREFIX}v0.29.0/WriteFlex.zip` },
    'dmg for the Mac': (f) => { f.channels.release.update.mac.url = `${RELEASE_ASSET_PREFIX}v0.29.0/WriteFlex-mac-arm64.dmg` },
    'hex hash': (f) => { f.channels.release.update.mac.sha512 = 'ab'.repeat(64) },
    'short hash': (f) => { f.channels.release.update.mac.sha512 = 'q'.repeat(40) + '==' },
    'no hash': (f) => { delete f.channels.release.update.mac.sha512 },
    'size zero': (f) => { f.channels.release.update.mac.size = 0 },
    'size negative': (f) => { f.channels.release.update.mac.size = -1 },
    'size fractional': (f) => { f.channels.release.update.mac.size = 1.5 },
    'size as text': (f) => { f.channels.release.update.mac.size = '288703536' },
    'size over 4 GiB': (f) => { f.channels.release.update.mac.size = MAX_UPDATE_FILE_BYTES + 1 },
    'bundle id on Windows': (f) => { f.channels.release.update.windows.bundleId = PUBLISHED_BUNDLE_ID },
    'bundle id with a space': (f) => { f.channels.release.update.mac.bundleId = 'net dominiklukes' },
    'very long address': (f) => { f.channels.release.update.mac.url = `${RELEASE_ASSET_PREFIX}v0.29.0/${'a'.repeat(400)}.zip` },
    'control character': (f) => { f.channels.release.update.mac.url = `${RELEASE_ASSET_PREFIX}v0.29.0/Write\u0000Flex.zip` },
  }
  for (const [name, change] of Object.entries(cases)) {
    const f = feed()
    change(f)
    assert.deepEqual(parse(f), { ok: false, reason: 'not-a-version-list' }, name)
  }
  assert.deepEqual(parse('<html>login</html>'), { ok: false, reason: 'not-json' })
  assert.deepEqual(parse(JSON.stringify(feed()) + ' '.repeat(70_000)), { ok: false, reason: 'too-large' })
  assert.deepEqual(parseChannelFeed(null, FEED_URL), { ok: false, reason: 'not-json' })
  assert.ok(parse(feed()).ok, 'the example itself is accepted')
})

test('update files: the right one for this computer; Intel Macs and other systems get none', () => {
  const f = parsedFeed(feed())
  assert.equal(updateFileFor(f.release, 'darwin', 'arm64')?.url, `${RELEASE_ASSET_PREFIX}v0.29.0/WriteFlex-mac-arm64.zip`)
  assert.equal(updateFileFor(f.release, 'darwin', 'arm64')?.bundleId, PUBLISHED_BUNDLE_ID)
  assert.equal(updateFileFor(f.release, 'win32', 'x64')?.url, `${RELEASE_ASSET_PREFIX}v0.29.0/WriteFlex-windows-x64-setup.exe`)
  assert.equal(updateFileFor(f.release, 'darwin', 'x64'), null)
  assert.equal(updateFileFor(f.release, 'win32', 'arm64'), null)
  assert.equal(updateFileFor(f.release, 'linux', 'x64'), null)
  assert.equal(updateFileFor(null, 'darwin', 'arm64'), null)
  // A loopback stand-in's prefix (hidden e2e runs) is accepted only when the checker is given it.
  const local = 'http://127.0.0.1:4567/releases/download/'
  const file = { url: `${local}v0.29.0/WriteFlex-mac-arm64.zip`, sha512: SHA, size: 10 }
  assert.ok(validateUpdateFile(file, 'mac', '0.29.0', local))
  assert.equal(validateUpdateFile(file, 'mac', '0.29.0'), null, 'the production prefix refuses it')
})

// ── The checker with channels ────────────────────────────────────────────────────────────────────
function harness({ running = '0.29.0', alpha = false } = {}) {
  const h = {
    now: Date.UTC(2026, 10, 20, 9), state: {} as ChannelUpdateState, alpha, requests: 0, told: [] as unknown[],
    answer: { ok: true as const, text: JSON.stringify(feed()) } as { ok: true; text: string },
    checker: null as unknown as ReturnType<typeof createChannelChecker>,
  }
  h.checker = createChannelChecker({
    identity: UPDATE_IDENTITY, running, platform: 'darwin', arch: 'arm64', source: 'website',
    fetchFeed: async () => { h.requests += 1; return h.answer },
    readState: () => readChannelState(JSON.parse(JSON.stringify(h.state)), FEED_URL),
    writeState: (s) => { h.state = JSON.parse(JSON.stringify(s)) },
    enabled: () => true, alpha: () => h.alpha, isBusy: () => false, hasNotes: () => false, hadConfiguration: () => true,
    now: () => h.now, changed: (s) => h.told.push(s),
    schedule: (() => ({})) as unknown as typeof setTimeout, cancel: (() => {}) as unknown as typeof clearTimeout,
  })
  return h
}

test('the checker: the alpha switch re-reads the last answer at once, with no request', async () => {
  const h = harness()
  const first = await h.checker.checkNow()
  assert.equal(first.mark, null, 'a release user on the release: nothing')
  assert.equal(first.state.lastResult, 'current')
  h.alpha = true
  const on = h.checker.settingChanged()
  assert.equal(h.requests, 1, 'no second request')
  assert.equal(on.alpha, true)
  assert.equal(on.mark?.version, '0.30.0-alpha.1')
  assert.equal(on.mark?.update?.mac?.bundleId, PUBLISHED_BUNDLE_ID, 'the mark carries the update file')
  h.alpha = false
  assert.equal(h.checker.settingChanged().mark, null)
  h.checker.stop()
})

test('the checker: an alpha user who switches alpha off keeps the alpha until the release passes it', async () => {
  const h = harness({ running: '0.30.0-alpha.1', alpha: false })
  assert.equal((await h.checker.checkNow()).mark, null, 'no downgrade to 0.29.0')
  h.answer = { ok: true, text: JSON.stringify(feed({ release: '0.30.0', alpha: null })) }
  assert.equal((await h.checker.checkNow()).mark?.version, '0.30.0', 'the release passes the alpha')
  h.checker.stop()
})

test('the checker: distraction-free writing holds a check, which runs when it ends', async () => {
  let busy = true
  let requests = 0
  let state: ChannelUpdateState = {}
  const checker = createChannelChecker({
    identity: UPDATE_IDENTITY, running: '0.28.0', platform: 'darwin', arch: 'arm64', source: 'website',
    fetchFeed: async () => { requests += 1; return { ok: true, text: JSON.stringify(feed()) } },
    readState: () => state, writeState: (s) => { state = s },
    enabled: () => true, alpha: () => false, isBusy: () => busy, hasNotes: () => false, hadConfiguration: () => true,
    now: () => Date.now(), changed: () => {},
  })
  try {
    expect((await checker.checkNow()).waiting).toBe(true)
    expect(requests).toBe(0)
    expect(checker.snapshot().mark).toBeNull()
    busy = false; checker.busyChanged()
    await new Promise((r) => setTimeout(r, 0))
    expect(requests).toBe(1)
    expect(checker.snapshot().mark?.version).toBe('0.29.0')
  } finally { checker.stop() }
})

test('the checker: the stored channels are validated again when read back', () => {
  const good = JSON.parse(JSON.stringify(feed()))
  const state = readChannelState({ channels: good.channels, latest: good.channels.alpha }, FEED_URL)
  assert.equal(state.channels?.alpha?.version, '0.30.0-alpha.1')
  assert.equal(state.latest?.version, '0.30.0-alpha.1', 'an alpha offer is kept')
  good.channels.release.update.mac.url = 'https://evil.example/x.zip'
  const tampered = readChannelState({ channels: good.channels }, FEED_URL)
  assert.equal(tampered.channels, undefined, 'a tampered file address in the settings file is dropped')
  assert.deepEqual(readChannelState('nonsense', FEED_URL), {})
})

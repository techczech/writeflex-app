import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:net'
import { createBunSqliteDriver } from '@readflex/sqlite-driver/bun'

void mock.module('@readflex/sqlite-driver/node', () => ({ createNodeSqliteDriver: createBunSqliteDriver }))

const { Workspace } = await import('../../src/main/workspace')
const { ScrapStore } = await import('../../src/main/scraps')
const { ScratchpadStore } = await import('../../src/main/scratchpad-store')
const { SettingsStore } = await import('../../src/main/settings')
const { TalkweaverAdapter, parseTalkweaverProviderId, talkweaverRelPath } = await import('../../src/main/scratchpad-talkweaver')
const { SlideWellAdapter, encodePictureRequest, decodePictureResponse } = await import('../../src/main/scratchpad-slidewell')
const { ScratchpadExternalSources, checkExternalAsset } = await import('../../src/main/scratchpad-external')
const { prepareBoundInsert, executeBoundInsert } = await import('../../src/main/scratchpad-agent-insert')
const { registerScratchpadIpc } = await import('../../src/main/scratchpad-ipc')
const { SCRATCHPAD_TALKWEAVER_KEY, SCRATCHPAD_SLIDEWELL_KEY, SCRATCHPAD_TALKWEAVER_VAULTS_KEY, chosenTalkweaverVaultsValue } = await import('../../src/shared/scratchpad-source-settings')

// Ticket 05 optional source connections. Every fixture is synthetic: a fake home with a
// TalkWeaver config + two vaults and a SlideWell catalogue + socket, built per test and
// removed after it. No real user home, config, vault, database or socket is ever touched.

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64')
const pngVariant = (tag: string): Buffer => Buffer.concat([PNG, Buffer.from(`variant-${tag}`)])
const SVG_OK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40"><rect width="80" height="40" fill="#80ac91"/></svg>'
const WIDGET_OK = '<!doctype html><html><head><title>Loop explorer</title></head><body><button id="b">Step</button><script>document.getElementById("b").onclick=()=>{}</script></body></html>'
const WIDGET_NET = '<!doctype html><html><head><title>Remote explorer</title><script src="https://cdn.example.org/charts.js"></script></head><body>x</body></html>'
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

let base: string
let home: string
let root: string
let ws: InstanceType<typeof Workspace>
let store: InstanceType<typeof ScratchpadStore>
let settingsValues: Map<string, string | number | boolean>
let service: InstanceType<typeof ScratchpadExternalSources>
let discoverCalls = 0
let locateCalls = 0
let socketServer: Server | null = null

class CountingTalkweaver extends TalkweaverAdapter {
  override async discover() { discoverCalls += 1; return super.discover() }
}
class CountingSlideWell extends SlideWellAdapter {
  override async locate() { locateCalls += 1; return super.locate() }
}

const settings = { get: (key: string) => settingsValues.get(key) ?? null }
const setSetting = (key: string, value: string | boolean): void => {
  settingsValues.set(key, value)
  service.noteSettingsChanged(key)
}

async function makeVault(id: string, name: string, pic: Buffer): Promise<string> {
  const vaultRoot = join(base, `vault-${id}`)
  await mkdir(join(vaultRoot, '_assets'), { recursive: true })
  await mkdir(join(vaultRoot, '.talkweaver'), { recursive: true })
  await mkdir(join(vaultRoot, 'ai-for-research/assets'), { recursive: true })
  await writeFile(join(vaultRoot, '.talkweaver/vault.json'), JSON.stringify({ schema: 1, id, name }))
  await writeFile(join(vaultRoot, '_assets/img-ab12cd3.png'), pic)
  await writeFile(join(vaultRoot, '_assets/img-ab12cd3.yml'), 'id: img-ab12cd3\nalt: "Loop diagram"\ncaption: "Research loop chart"\nsource: ""\ntags: [loop, chart]\n')
  await writeFile(join(vaultRoot, 'ai-for-research/assets/research-loop.svg'), SVG_OK)
  await writeFile(join(vaultRoot, 'ai-for-research/assets/loop-explorer.html'), WIDGET_OK)
  await writeFile(join(vaultRoot, 'ai-for-research/assets/remote-explorer.html'), WIDGET_NET)
  return vaultRoot
}

async function makeHome(): Promise<void> {
  home = join(base, 'home')
  const twDir = join(home, 'Library/Application Support/TalkWeaver')
  await mkdir(twDir, { recursive: true })
  const vaultA = await makeVault('vault-a', 'dominiks-presentations-library', pngVariant('a'))
  const vaultB = await makeVault('vault-b', 'workshop-slides-2026', pngVariant('b'))
  await writeFile(join(twDir, 'config.json'), JSON.stringify({
    vaults: [
      { id: 'vault-a', root: vaultA, open: true, order: 0 },
      { id: 'vault-b', root: vaultB, open: true, order: 1 },
    ],
    vaultRoot: vaultA, vaultRootMirrored: vaultA,
  }))
}

function makeService(seams?: { afterDiscovery?: () => void }): void {
  service = new ScratchpadExternalSources({
    settings,
    talkweaver: new CountingTalkweaver({ home }),
    slidewell: new CountingSlideWell({ home, driver: () => createBunSqliteDriver() }),
    home,
    ...(seams ? { seams } : {}),
  })
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'wf-scratch-ext-')))
  root = join(base, 'workspace')
  await mkdir(join(root, 'part'), { recursive: true })
  await writeFile(join(root, 'part/doc.md'), '# Doc\n\nAlpha paragraph.\n\nOmega paragraph.\n')
  await writeFile(join(root, 'other.md'), '# Other\n\nElsewhere.\n')
  ws = new Workspace(root)
  store = new ScratchpadStore(ws, new ScrapStore(ws))
  settingsValues = new Map()
  discoverCalls = 0
  locateCalls = 0
  await makeHome()
  makeService()
})
afterEach(async () => {
  socketServer?.close()
  socketServer = null
  await rm(base, { recursive: true, force: true })
})

const enableTalkweaver = (vaults: string[] = ['vault-a', 'vault-b']): void => {
  setSetting(SCRATCHPAD_TALKWEAVER_VAULTS_KEY, chosenTalkweaverVaultsValue(vaults))
  setSetting(SCRATCHPAD_TALKWEAVER_KEY, true)
}
const vaultPic = (vault: string): string => join(base, `vault-${vault}`, '_assets/img-ab12cd3.png')

test('both switches default off: status answers off and search refuses with zero discovery calls', async () => {
  expect(await service.status('talkweaver')).toEqual({ source: 'talkweaver', state: 'off' })
  expect(await service.status('slidewell')).toEqual({ source: 'slidewell', state: 'off' })
  await expect(service.search('talkweaver', { query: 'loop' })).rejects.toThrow(/off in Settings/)
  await expect(service.search('slidewell', { query: 'loop' })).rejects.toThrow(/off in Settings/)
  expect(discoverCalls).toBe(0)
  expect(locateCalls).toBe(0)
})

test('switches persist through the settings writer and read back off by default', async () => {
  const file = join(base, 'settings.json')
  const first = new SettingsStore(file)
  expect(first.get(SCRATCHPAD_TALKWEAVER_KEY)).toBeNull()
  expect(first.get(SCRATCHPAD_SLIDEWELL_KEY)).toBeNull()
  first.set(SCRATCHPAD_TALKWEAVER_KEY, true, 'Browse TalkWeaver vaults')
  first.set(SCRATCHPAD_TALKWEAVER_VAULTS_KEY, chosenTalkweaverVaultsValue(['vault-a']), 'TalkWeaver vaults to browse')
  const again = new SettingsStore(file)
  expect(again.get(SCRATCHPAD_TALKWEAVER_KEY)).toBe(true)
  expect(again.get(SCRATCHPAD_SLIDEWELL_KEY)).toBeNull()
  expect(again.get(SCRATCHPAD_TALKWEAVER_VAULTS_KEY)).toBe('["vault-a"]')
})

test('enabled TalkWeaver: status names chosen vaults; search finds pool, SVG and widgets with opaque handles', async () => {
  enableTalkweaver()
  const status = await service.status('talkweaver')
  expect(status.state).toBe('connected')
  expect(status.vaults?.map((v) => v.name)).toEqual(['dominiks-presentations-library', 'workshop-slides-2026'])
  expect(status.chosenVaults).toEqual(['vault-a', 'vault-b'])

  const found = await service.search('talkweaver', { query: 'loop' })
  const titles = found.results.map((r) => r.title)
  // The same picture id in both vaults is two distinct results with distinct handles.
  const pool = found.results.filter((r) => r.title === 'Research loop chart')
  expect(pool.length).toBe(2)
  expect(new Set(pool.map((r) => r.handle)).size).toBe(2)
  expect(pool.map((r) => r.provenance).sort()).toEqual(['TalkWeaver · dominiks-presentations-library', 'TalkWeaver · workshop-slides-2026'])
  expect(titles).toContain('research loop')
  for (const result of found.results) {
    expect(result.handle).toMatch(/^x_[0-9a-f]{24}$/)
    expect(JSON.stringify(result)).not.toContain(base)
    expect(JSON.stringify(result)).not.toContain('_assets/')
  }
  const explorers = await service.search('talkweaver', { query: 'explorer', vault: 'vault-a' })
  const remote = explorers.results.find((r) => r.title === 'remote explorer')
  expect(remote?.kind).toBe('widget')
  expect(remote?.incompatible).toContain('Needs checking')
  const widget = explorers.results.find((r) => r.title === 'loop explorer')
  expect(widget?.incompatible).toBeUndefined()
})

test('no chosen vault is its own honest state, and a missing TalkWeaver keeps an unavailable tab state', async () => {
  enableTalkweaver([])
  const status = await service.status('talkweaver')
  expect(status.state).toBe('connected')
  expect(status.chosenVaults).toEqual([])
  const found = await service.search('talkweaver', { query: '' })
  expect(found.results).toEqual([])
  expect(found.note).toBe('No vault is selected. Choose vaults in Settings.')

  const emptyHome = join(base, 'empty-home')
  await mkdir(emptyHome, { recursive: true })
  service = new ScratchpadExternalSources({
    settings, home: emptyHome,
    talkweaver: new TalkweaverAdapter({ home: emptyHome }),
    slidewell: new SlideWellAdapter({ home: emptyHome, driver: () => createBunSqliteDriver() }),
  })
  const missing = await service.status('talkweaver')
  expect(missing.state).toBe('unavailable')
  expect(missing.reason).toContain('not found')
})

test('collect keeps pointer + preview only; forged and stale handles refuse; source untouched', async () => {
  enableTalkweaver()
  const before = await readFile(vaultPic('vault-a'))
  const found = await service.search('talkweaver', { query: 'research loop chart', vault: 'vault-a' })
  const handle = found.results[0].handle
  await expect(service.collect(store, { handle: 'x_forged000000000000000000', activePath: 'part/doc.md' })).rejects.toThrow(/no longer current/)
  await expect(service.collect(store, { handle: '../../etc/passwd', activePath: 'part/doc.md' })).rejects.toThrow(/no longer current/)

  const item = await service.collect(store, { handle, activePath: 'part/doc.md' })
  expect(item.external?.providerId).toBe('vault:vault-a:_assets/img-ab12cd3.png')
  expect(item.external?.sha256).toBe(sha(before))
  expect(item.markdown).toContain('Nothing was copied yet')
  expect(existsSync(join(root, 'part/assets'))).toBe(false)
  expect(await readFile(vaultPic('vault-a'))).toEqual(before)

  // The same shown version collected twice is the one candidate.
  const again = await service.search('talkweaver', { query: 'research loop chart', vault: 'vault-a' })
  const second = await service.collect(store, { handle: again.results[0].handle, activePath: 'part/doc.md' })
  expect(second.id).toBe(item.id)
})

test('disabling during a search kills it, and handles issued before a disable are dead', async () => {
  enableTalkweaver()
  const found = await service.search('talkweaver', { query: 'loop', vault: 'vault-a' })
  const handle = found.results[0].handle
  setSetting(SCRATCHPAD_TALKWEAVER_KEY, false)
  await expect(service.collect(store, { handle, activePath: 'part/doc.md' })).rejects.toThrow(/no longer current/)

  setSetting(SCRATCHPAD_TALKWEAVER_KEY, true)
  makeService({ afterDiscovery: () => { settingsValues.set(SCRATCHPAD_TALKWEAVER_KEY, false); service.noteSettingsChanged(SCRATCHPAD_TALKWEAVER_KEY) } })
  await expect(service.search('talkweaver', { query: 'loop' })).rejects.toThrow(/turned off while/)
})

test('provider identities reject traversal and cross-vault forgery shapes', () => {
  expect(talkweaverRelPath('../outside.png')).toBeNull()
  expect(talkweaverRelPath('_assets/../../outside.png')).toBeNull()
  expect(talkweaverRelPath('/abs/_assets/img-ab12cd3.png')).toBeNull()
  expect(talkweaverRelPath('talk/assets/../../secret.png')).toBeNull()
  expect(parseTalkweaverProviderId('vault:vault-a:../secret.png')).toBeNull()
  expect(parseTalkweaverProviderId('vault:../x:_assets/img-ab12cd3.png')).toBeNull()
  expect(parseTalkweaverProviderId('vault:legacy:0123456789abcdef:_assets/img-ab12cd3.png')).toEqual({ vaultId: 'legacy:0123456789abcdef', relPath: '_assets/img-ab12cd3.png' })
})

test('direct import copies only the selected checked bytes, never overwrites, and reuses its local copy', async () => {
  enableTalkweaver()
  const found = await service.search('talkweaver', { query: 'research loop chart', vault: 'vault-a' })
  const item = await service.collect(store, { handle: found.results[0].handle, activePath: 'part/doc.md' })
  // A stranger's file already at the planned name is never overwritten.
  await mkdir(join(root, 'part/assets'), { recursive: true })
  await writeFile(join(root, 'part/assets/img-ab12cd3.png'), 'not ours')
  const done = await service.importForInsert(ws, store, item, 'part/doc.md')
  expect(done.copied).toBe(true)
  expect(done.markdown).toBe('![Research loop chart](assets/img-ab12cd3-2.png)')
  expect(await readFile(join(root, 'part/assets/img-ab12cd3.png'), 'utf8')).toBe('not ours')
  expect(await readFile(join(root, 'part/assets/img-ab12cd3-2.png'))).toEqual(pngVariant('a'))
  // Source bytes untouched.
  expect(await readFile(vaultPic('vault-a'))).toEqual(pngVariant('a'))

  const listed = await store.get(item.id)
  expect(listed.external?.importedPath).toBe('part/assets/img-ab12cd3-2.png')
  expect(listed.external?.provenance).toBe('TalkWeaver · dominiks-presentations-library')
  // A second insert elsewhere reuses the local copy (relative link rebased), copying nothing,
  // and keeps working after the source is switched off — no remote-required surprise.
  setSetting(SCRATCHPAD_TALKWEAVER_KEY, false)
  const reuse = await service.importForInsert(ws, store, listed, 'other.md')
  expect(reuse.copied).toBe(false)
  expect(reuse.markdown).toBe('![Research loop chart](part/assets/img-ab12cd3-2.png)')
  expect((await readdir(join(root, 'part/assets'))).sort()).toEqual(['img-ab12cd3-2.png', 'img-ab12cd3.png'])
})

test('a source changed while waiting refuses collect and import; a symlinked source is never adopted', async () => {
  enableTalkweaver()
  const found = await service.search('talkweaver', { query: 'research loop chart', vault: 'vault-a' })
  const item = await service.collect(store, { handle: found.results[0].handle, activePath: 'part/doc.md' })
  await writeFile(vaultPic('vault-a'), pngVariant('changed'))
  await expect(service.importForInsert(ws, store, item, 'part/doc.md')).rejects.toThrow(/changed in its source/)
  expect(existsSync(join(root, 'part/assets'))).toBe(false)

  const found2 = await service.search('talkweaver', { query: 'research loop chart', vault: 'vault-a' })
  await writeFile(vaultPic('vault-a'), pngVariant('changed-again'))
  await expect(service.collect(store, { handle: found2.results[0].handle, activePath: 'part/doc.md' })).rejects.toThrow(/changed in its source/)

  const outside = join(base, 'outside.png')
  await writeFile(outside, pngVariant('outside'))
  await unlink(vaultPic('vault-a'))
  await symlink(outside, vaultPic('vault-a'))
  const found3 = await service.search('talkweaver', { query: 'research loop chart', vault: 'vault-a' })
  expect(found3.results.filter((r) => r.title === 'Research loop chart')).toEqual([])
  await expect(service.importForInsert(ws, store, item, 'part/doc.md')).rejects.toThrow()
  expect(existsSync(join(root, 'part/assets'))).toBe(false)
})

test('an incompatible widget collects as a pointer but can neither run nor insert', async () => {
  enableTalkweaver()
  const found = await service.search('talkweaver', { query: 'remote explorer', vault: 'vault-a' })
  const item = await service.collect(store, { handle: found.results[0].handle, activePath: 'part/doc.md' })
  expect(item.external?.incompatible).toContain('Needs checking')
  const listed = await store.get(item.id)
  expect(listed.problem).toContain('Needs checking')
  await expect(service.prepareWidget(ws, listed)).rejects.toThrow(/Needs checking/)
  await expect(service.importForInsert(ws, store, listed, 'part/doc.md')).rejects.toThrow(/Needs checking/)
  // A compatible widget runs from its checked source bytes and imports through the widget writer.
  const ok = await service.search('talkweaver', { query: 'loop explorer', vault: 'vault-a' })
  const widgetItem = await service.collect(store, { handle: ok.results[0].handle, activePath: 'part/doc.md' })
  const prepared = await service.prepareWidget(ws, await store.get(widgetItem.id))
  expect(prepared.html).toBe(WIDGET_OK)
  const done = await service.importForInsert(ws, store, await store.get(widgetItem.id), 'part/doc.md')
  expect(done.markdown).toBe('[Simulation: assets/loop-explorer.html]')
  expect(await readFile(join(root, 'part/assets/loop-explorer.html'), 'utf8')).toBe(WIDGET_OK)
})

test('asset checks: bad picture bytes and unkeepable types are named incompatible, never silently passed', () => {
  expect(checkExternalAsset('x.png', Buffer.from('not a picture')).ok).toBe(false)
  const heic = checkExternalAsset('x.heic', pngVariant('h'))
  expect(heic.ok).toBe(false)
  if (!heic.ok) expect(heic.incompatible).toContain('cannot keep a .heic picture')
  expect(checkExternalAsset('x.svg', Buffer.from('<svg><script>alert(1)</script></svg>')).ok).toBe(false)
  expect(checkExternalAsset('x.svg', Buffer.from(SVG_OK)).ok).toBe(true)
})

// ── SlideWell: a synthetic catalogue (well.db + triage.db) and a fake picture socket ──────

const WELL_ID = 'abc1234'
const WELL_EMPTIED_ID = 'def5678'
const WELL_MISSING_ID = 'aaa9999'
const TRIAGE_HASH = 'f00df00df00d'
const TRIAGE_BIN_HASH = 'beefbeefbeef'
let wellRoot: string
let shotsDir: string

async function makeSlideWell(): Promise<void> {
  const swDir = join(home, 'Library/Application Support/SlideWell')
  wellRoot = join(home, 'SlideWell/well')
  shotsDir = join(base, 'screenshots')
  await mkdir(swDir, { recursive: true })
  await mkdir(join(wellRoot, 'images'), { recursive: true })
  await mkdir(shotsDir, { recursive: true })
  await writeFile(join(swDir, 'config.json'), JSON.stringify({}))
  await writeFile(join(wellRoot, 'images/rising-chart.png'), pngVariant('well'))
  await writeFile(join(wellRoot, 'images/emptied-chart.png'), pngVariant('emptied'))
  await writeFile(join(shotsDir, 'screen-one.png'), pngVariant('shot'))
  await writeFile(join(shotsDir, 'screen-bin.png'), pngVariant('bin'))
  const driver = createBunSqliteDriver()
  const well = driver.open(join(wellRoot, 'well.db'))
  well.run("CREATE VIRTUAL TABLE well_fts USING fts5(id UNINDEXED, slug, ext UNINDEXED, rel_path, root UNINDEXED, source, tags, notes, ocr_text, added_at UNINDEXED)")
  well.run("CREATE TABLE well_sources (well_id TEXT, source_hash TEXT)")
  well.run('INSERT INTO well_fts (id, slug, ext, rel_path, root, source, tags, notes, ocr_text, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    WELL_ID, 'rising-chart', 'png', 'images/rising-chart.png', 'well', 'screenshot', 'chart rising', '', 'a rising line chart', '2026-10-01')
  well.run('INSERT INTO well_fts (id, slug, ext, rel_path, root, source, tags, notes, ocr_text, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    WELL_EMPTIED_ID, 'emptied-chart', 'png', 'images/emptied-chart.png', 'well', 'screenshot', 'chart', '', 'an emptied chart', '2026-10-02')
  well.run('INSERT INTO well_fts (id, slug, ext, rel_path, root, source, tags, notes, ocr_text, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    WELL_MISSING_ID, 'missing-chart', 'png', 'images/gone-chart.png', 'well', 'screenshot', 'chart', '', 'a missing chart', '2026-10-03')
  well.run('INSERT INTO well_sources (well_id, source_hash) VALUES (?, ?)', WELL_EMPTIED_ID, 'emptiedhash12')
  well.run('INSERT INTO well_sources (well_id, source_hash) VALUES (?, ?)', WELL_ID, TRIAGE_HASH)
  well.close()
  const triage = driver.open(join(wellRoot, 'triage.db'))
  triage.run("CREATE VIRTUAL TABLE triage_fts USING fts5(hash UNINDEXED, rel_path, filename, ext UNINDEXED, ocr_text, source UNINDEXED, taken_at UNINDEXED, app, window_title, mtime UNINDEXED, kind UNINDEXED, offline UNINDEXED)")
  triage.run('CREATE TABLE triage_decisions (hash TEXT, state TEXT, decided_at TEXT, well_id TEXT)')
  triage.run('INSERT INTO triage_fts (hash, rel_path, filename, ext, ocr_text, source, taken_at, app, window_title, mtime, kind, offline) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    TRIAGE_HASH, 'screen-one.png', 'screen-one.png', 'png', 'chart words on screen', shotsDir, '2026-10-05', 'Preview', 'Chart window', '0', 'image', '0')
  triage.run('INSERT INTO triage_fts (hash, rel_path, filename, ext, ocr_text, source, taken_at, app, window_title, mtime, kind, offline) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    TRIAGE_BIN_HASH, 'screen-bin.png', 'screen-bin.png', 'png', 'chart in the bin', shotsDir, '2026-08-01', 'Preview', 'Bin chart', '0', 'image', '0')
  triage.run('INSERT INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, ?, ?, ?)', TRIAGE_HASH, 'selected', '2026-10-05', WELL_ID)
  triage.run('INSERT INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, ?, ?, ?)', TRIAGE_BIN_HASH, 'excluded', '2026-08-02', null)
  triage.run('INSERT INTO triage_decisions (hash, state, decided_at, well_id) VALUES (?, ?, ?, ?)', 'emptiedhash12', 'emptied', '2026-10-04', WELL_EMPTIED_ID)
  triage.close()
}

test('SlideWell catalogue word search excludes emptied, binned and missing files; duplicates across stores are one result', async () => {
  await makeSlideWell()
  setSetting(SCRATCHPAD_SLIDEWELL_KEY, true)
  const status = await service.status('slidewell')
  // The catalogue is readable while the semantic service is stopped — two distinct facts.
  expect(status).toMatchObject({ state: 'connected', catalogue: true, semantic: false })

  const found = await service.search('slidewell', { query: 'chart' })
  const titles = found.results.map((r) => r.title)
  expect(titles).toContain('Chart window')
  expect(titles.filter((t) => t === 'Chart window').length).toBe(1) // well + triage aliases deduped
  expect(titles.join(' ')).not.toContain('emptied')
  expect(titles.join(' ')).not.toContain('Bin chart')
  expect(titles.join(' ')).not.toContain('missing')

  const item = await service.collect(store, { handle: found.results[0].handle, activePath: 'part/doc.md' })
  expect(item.external?.providerId).toBe(`well:${WELL_ID}`)
  const done = await service.importForInsert(ws, store, await store.get(item.id), 'part/doc.md')
  expect(done.markdown).toContain('assets/rising-chart.png')
  expect(await readFile(join(root, 'part/assets/rising-chart.png'))).toEqual(pngVariant('well'))
  // The catalogue databases were only read.
  const driver = createBunSqliteDriver()
  const check = driver.open(join(wellRoot, 'well.db'), { readonly: true })
  expect((check.all('SELECT id FROM well_fts') as unknown[]).length).toBe(3)
  check.close()
})

test('SlideWell semantic search needs the running service and maps its ranked ids through the catalogue', async () => {
  await makeSlideWell()
  setSetting(SCRATCHPAD_SLIDEWELL_KEY, true)
  await expect(service.search('slidewell', { query: 'a chart that goes up', mode: 'meaning' })).rejects.toThrow(/not running/)

  // The service's answers arrive through the adapter's ask seam (the same seam TalkWeaver's
  // provider tests use); the catalogue mapping, dedup and exclusions are the real adapter's.
  service = new ScratchpadExternalSources({
    settings, home,
    talkweaver: new CountingTalkweaver({ home }),
    slidewell: new CountingSlideWell({
      home,
      driver: () => createBunSqliteDriver(),
      askPictures: async (_socket, text) => {
        expect(text).toBe('a chart that goes up over time')
        return { ok: true, hits: [{ id: `well:${WELL_ID}`, score: 0.82 }, { id: 'slide:old#3', score: 0.5 }, { id: `well:${WELL_EMPTIED_ID}`, score: 0.4 }] }
      },
    }),
  })
  const found = await service.search('slidewell', { query: 'a chart that goes up over time', mode: 'meaning' })
  expect(found.results.length).toBe(1) // old slides are not imported; emptied items stay hidden
  expect(found.results[0].score).toBeCloseTo(0.82)
  expect(found.results[0].provenance).toBe('SlideWell · match 0.82')
  expect(found.results[0].title).toBe('Chart window')

  // The v1 framing is bounded and strict, as TalkWeaver's reference client defines it.
  expect(encodePictureRequest('', 10)).toBeNull()
  expect(encodePictureRequest('x'.repeat(5000), 10)).toBeNull()
  expect(decodePictureResponse('not json')).toEqual({ ok: false, reason: 'bad-response' })
  expect(decodePictureResponse(JSON.stringify({ v: 2, ok: true, hits: [] }))).toEqual({ ok: false, reason: 'bad-response' })
})

test('the picture-query client speaks one bounded line each way over a user-owned socket', async () => {
  const { askPictureQuery, socketIsOurs } = await import('../../src/main/scratchpad-slidewell')
  const socketPath = join(process.env.TMPDIR ?? '/tmp', `wfq-${Math.random().toString(36).slice(2, 8)}.sock`)
  socketServer = createServer((sock) => {
    let seen = ''
    sock.on('data', (chunk) => {
      seen += chunk.toString('utf8')
      if (!seen.includes('\n')) return
      const request = JSON.parse(seen.trim()) as { v: number; op: string; text: string; limit: number }
      expect(request).toEqual({ v: 1, op: 'picture-query', text: 'a rising chart', limit: 60 })
      sock.end(JSON.stringify({ v: 1, ok: true, hits: [{ id: 'well:abc1234', score: 0.5 }] }) + '\n')
    })
  })
  const listening = await new Promise<'ok' | NodeJS.ErrnoException>((resolve) => {
    socketServer!.once('error', (error: NodeJS.ErrnoException) => resolve(error))
    socketServer!.listen(socketPath, () => resolve('ok'))
  })
  if (listening !== 'ok') {
    // The Contributor sandbox refuses unix-socket listen (EPERM); the parent host runs this
    // same test unsandboxed. Everything above the socket is still asserted there.
    expect(listening.code).toBe('EPERM')
    socketServer = null
    return
  }
  expect(socketIsOurs(socketPath)).toBe(true)
  expect(await askPictureQuery(socketPath, 'a rising chart')).toEqual({ ok: true, hits: [{ id: 'well:abc1234', score: 0.5 }] })
  socketServer.close()
  socketServer = null
  await unlink(socketPath).catch(() => {})
  expect(await askPictureQuery(socketPath, 'a rising chart')).toEqual({ ok: false, reason: 'not-running' })
})

test('SlideWell missing entirely is unavailable; word search never touches the socket', async () => {
  setSetting(SCRATCHPAD_SLIDEWELL_KEY, true)
  const status = await service.status('slidewell')
  expect(status).toMatchObject({ state: 'unavailable', catalogue: false, semantic: false })
  await expect(service.search('slidewell', { query: 'chart' })).rejects.toThrow(/not found/)
})

test('agent proposal staging copies nothing; Accept alone imports the bound shown version', async () => {
  enableTalkweaver()
  const found = await service.search('talkweaver', { query: 'research loop chart', vault: 'vault-b' })
  const item = await service.collect(store, { handle: found.results[0].handle, activePath: 'part/doc.md' })
  const bound = await prepareBoundInsert(ws, store, 'scratchpad.insert', { id: item.id, path: 'part/doc.md', insertAfter: 'Alpha paragraph.' }, service)
  expect(bound.externalImport?.path).toBe('part/assets/img-ab12cd3.png')
  expect(bound.markdown).toBe('![Research loop chart](assets/img-ab12cd3.png)')
  // Staging wrote nothing: no asset, no document change.
  expect(existsSync(join(root, 'part/assets'))).toBe(false)
  expect(await readFile(join(root, 'part/doc.md'), 'utf8')).toBe('# Doc\n\nAlpha paragraph.\n\nOmega paragraph.\n')

  const done = await executeBoundInsert(ws, store, bound, null, service)
  expect(done.text).toContain('part/assets/img-ab12cd3.png')
  expect(await readFile(join(root, 'part/assets/img-ab12cd3.png'))).toEqual(pngVariant('b'))
  expect(await readFile(join(root, 'part/doc.md'), 'utf8')).toContain('![Research loop chart](assets/img-ab12cd3.png)')
  const listed = await store.get(item.id)
  expect(listed.external?.importedPath).toBe('part/assets/img-ab12cd3.png')
  expect(listed.uses.some((use) => use.mode === 'copy' && use.path === 'part/doc.md')).toBe(true)
  // Cross-vault proof: vault B's bytes, not vault A's same-named picture.
  expect(sha(await readFile(join(root, 'part/assets/img-ab12cd3.png')))).toBe(sha(pngVariant('b')))
})

test('a source changed after staging refuses at Accept with no copy and no document write', async () => {
  enableTalkweaver()
  const found = await service.search('talkweaver', { query: 'research loop chart', vault: 'vault-b' })
  const item = await service.collect(store, { handle: found.results[0].handle, activePath: 'part/doc.md' })
  const bound = await prepareBoundInsert(ws, store, 'scratchpad.insert', { id: item.id, path: 'part/doc.md', insertAfter: 'Alpha paragraph.' }, service)
  await writeFile(vaultPic('vault-b'), pngVariant('moved'))
  await expect(executeBoundInsert(ws, store, bound, null, service)).rejects.toThrow(/changed/)
  expect(existsSync(join(root, 'part/assets'))).toBe(false)
  expect(await readFile(join(root, 'part/doc.md'), 'utf8')).toBe('# Doc\n\nAlpha paragraph.\n\nOmega paragraph.\n')

  // Turning the connection off after staging likewise refuses at Accept.
  await writeFile(vaultPic('vault-b'), pngVariant('b'))
  const bound2 = await prepareBoundInsert(ws, store, 'scratchpad.insert', { id: item.id, path: 'part/doc.md', insertAfter: 'Alpha paragraph.' }, service)
  setSetting(SCRATCHPAD_TALKWEAVER_KEY, false)
  await expect(executeBoundInsert(ws, store, bound2, null, service)).rejects.toThrow(/turned off|off in Settings/)
  expect(existsSync(join(root, 'part/assets'))).toBe(false)
})

test('the IPC boundary refuses a disabled source even when called directly', async () => {
  type Handler = (event: { sender: { id: number } }, input: unknown) => Promise<any>
  const handlers = new Map<string, Handler>()
  registerScratchpadIpc({ handle: (channel, handler) => { handlers.set(channel, handler as Handler) } }, {
    stateForSender: () => ({ workspace: ws, scratchpad: store }),
    announce: () => {},
    external: service,
  })
  const call = (channel: string, input: unknown): Promise<any> => handlers.get(channel)!({ sender: { id: 1 } }, input)
  const status = await call('scratchpad:external-status', { root, source: 'talkweaver' })
  expect(status).toEqual({ ok: true, status: { source: 'talkweaver', state: 'off' } })
  const searched = await call('scratchpad:external-search', { root, source: 'talkweaver', query: 'loop' })
  expect(searched.ok).toBe(false)
  expect(searched.error).toContain('off in Settings')
  const collected = await call('scratchpad:external-collect', { root, handle: 'x_forged', activePath: 'part/doc.md' })
  expect(collected.ok).toBe(false)
  expect(discoverCalls).toBe(0)
})


test('an explicit vault filter cannot browse a configured vault omitted from Settings selection', async () => {
  enableTalkweaver(['vault-a'])
  const result = await service.search('talkweaver', { query: '', vault: 'vault-b' })
  expect(result.results).toHaveLength(0)
})

test('a collected pointer loses remote import authority when its vault is deselected', async () => {
  enableTalkweaver(['vault-a'])
  const result = await service.search('talkweaver', { query: 'chart', vault: 'vault-a' })
  const item = await service.collect(store, { handle: result.results[0]!.handle, activePath: 'part/doc.md' })
  setSetting(SCRATCHPAD_TALKWEAVER_VAULTS_KEY, chosenTalkweaverVaultsValue(['vault-b']))
  await expect(service.importForInsert(ws, store, item, 'part/doc.md')).rejects.toThrow(/vault.*selected|selected.*vault/i)
  expect(existsSync(join(root, 'part/assets'))).toBe(false)
})


test('failed document rollback keeps the imported asset and provenance for the surviving inserted link', async () => {
  enableTalkweaver(['vault-a'])
  const result = await service.search('talkweaver', { query: 'chart', vault: 'vault-a' })
  const item = await service.collect(store, { handle: result.results[0]!.handle, activePath: 'part/doc.md' })
  const bound = await prepareBoundInsert(ws, store, 'scratchpad.insert', { id: item.id, path: 'part/doc.md', insertAfter: 'Alpha paragraph.' }, service)
  store.recordAgentUse = async () => {
    const current = await readFile(join(root, 'part/doc.md'), 'utf8')
    await writeFile(join(root, 'part/doc.md'), current + '\nNew authored text.\n')
    throw new Error('synthetic metadata failure after another writer edited')
  }
  await expect(executeBoundInsert(ws, store, bound, null, service)).rejects.toThrow(/left as it is/)
  const current = await readFile(join(root, 'part/doc.md'), 'utf8')
  expect(current).toContain(bound.markdown)
  expect(current).toContain('New authored text.')
  expect(await readFile(join(root, bound.externalImport!.path))).toEqual(pngVariant('a'))
  expect((await store.get(item.id)).external?.importedPath).toBe(bound.externalImport!.path)
})

test('import cleanup preserves a same-byte replacement because the original creation identity no longer owns the name', async () => {
  enableTalkweaver(['vault-a'])
  const result = await service.search('talkweaver', { query: 'chart', vault: 'vault-a' })
  const item = await service.collect(store, { handle: result.results[0]!.handle, activePath: 'part/doc.md' })
  const imported = await service.importForInsert(ws, store, item, 'part/doc.md')
  const path = imported.createdPath!
  await rename(join(root, path), join(root, path + '.original'))
  await writeFile(join(root, path), pngVariant('a'))
  expect(imported.created).not.toBeNull()
  expect(await service.removeCreatedImport(ws, item.external!, imported.created!)).toBe(false)
  expect(await readFile(join(root, path))).toEqual(pngVariant('a'))
})


test('turning SlideWell off while its lazy driver loads prevents subsequent discovery', async () => {
  setSetting(SCRATCHPAD_SLIDEWELL_KEY, true)
  let release!: (driver: ReturnType<typeof createBunSqliteDriver>) => void
  const pending = new Promise<ReturnType<typeof createBunSqliteDriver>>((resolve) => { release = resolve })
  let calls = 0
  const original = SlideWellAdapter.prototype.locate
  SlideWellAdapter.prototype.locate = async function () { calls += 1; return original.call(this) }
  try {
    service = new ScratchpadExternalSources({ settings, home, sqliteDriver: () => pending })
    const search = service.search('slidewell', { query: 'chart' })
    setSetting(SCRATCHPAD_SLIDEWELL_KEY, false)
    release(createBunSqliteDriver())
    await expect(search).rejects.toThrow(/turned off/)
    expect(calls).toBe(0)
  } finally { SlideWellAdapter.prototype.locate = original }
})

test('a large connected picture previews as a bounded thumbnail, collects pointer-only and inserts the exact original', async () => {
  // The proven repro shape: incompressible 512×512 noise PNG, well over the small-preview cap.
  const { default: sharp } = await import('sharp')
  const pixels = Buffer.alloc(512 * 512 * 3)
  let state = 0x5ac12
  for (let i = 0; i < pixels.length; i++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; pixels[i] = state >>> 24 }
  const large = await sharp(pixels, { raw: { width: 512, height: 512, channels: 3 } }).png().toBuffer()
  expect(large.length).toBeGreaterThan(192 * 1024)
  await writeFile(vaultPic('vault-a'), large)

  enableTalkweaver()
  const found = await service.search('talkweaver', { query: 'research loop chart', vault: 'vault-a' })
  const result = found.results[0]
  expect(result.previewDataUri).toStartWith('data:image/webp;base64,')
  const thumbBytes = Buffer.from(result.previewDataUri!.slice(result.previewDataUri!.indexOf(',') + 1), 'base64')
  expect(thumbBytes.length).toBeLessThanOrEqual(192 * 1024)
  const thumbMeta = await sharp(thumbBytes).metadata()
  expect(Math.max(thumbMeta.width ?? 0, thumbMeta.height ?? 0)).toBeLessThanOrEqual(480)

  // The off guard still kills the issued handle before anything is collected.
  setSetting(SCRATCHPAD_TALKWEAVER_KEY, false)
  await expect(service.collect(store, { handle: result.handle, activePath: 'part/doc.md' })).rejects.toThrow(/no longer current/)
  setSetting(SCRATCHPAD_TALKWEAVER_KEY, true)
  const again = await service.search('talkweaver', { query: 'research loop chart', vault: 'vault-a' })

  // Collect stores the pointer, the ORIGINAL digest and the bounded thumbnail — no asset copy.
  const item = await service.collect(store, { handle: again.results[0].handle, activePath: 'part/doc.md' })
  expect(item.external?.sha256).toBe(sha(large))
  expect(item.external?.bytes).toBe(large.length)
  expect(item.external?.previewDataUri).toBe(again.results[0].previewDataUri)
  expect(existsSync(join(root, 'part/assets'))).toBe(false)
  expect(await readFile(vaultPic('vault-a'))).toEqual(large)

  // Insertion copies the exact original bytes, never the thumbnail; the source is untouched.
  const done = await service.importForInsert(ws, store, item, 'part/doc.md')
  expect(done.copied).toBe(true)
  expect(done.markdown).toBe('![Research loop chart](assets/img-ab12cd3.png)')
  expect(await readFile(join(root, 'part/assets/img-ab12cd3.png'))).toEqual(large)
  expect(await readFile(vaultPic('vault-a'))).toEqual(large)
})

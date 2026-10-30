import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { buildVerbTable } from '../../src/main/verbs'
import { READ_OPERATIONS } from '../../src/main/cli/read-operations'
import { readScratchInventory } from '../../src/main/scratchpad-inventory'
import { ScratchpadStore } from '../../src/main/scratchpad-store'
import { waitingLossless } from '../../src/main/scrap-listing'
import { pauseCollectionWrites, resumeCollectionWrites } from '../../src/main/collection-write-gate'
let root: string
let store: ScratchpadStore
beforeEach(async () => {
  root = await mkdtemp(join(import.meta.dir, '.scratchpad-assets-'))
  await mkdir(join(root, 'source/assets'), { recursive: true })
  await mkdir(join(root, 'target/deep'), { recursive: true })
  await writeFile(join(root, 'source/part.md'), '# Source')
  await writeFile(join(root, 'target/deep/draft.md'), '# Target')
  await writeFile(join(root, 'source/assets/loop.png'), 'image bytes')
  await writeFile(join(root, 'source/assets/demo.html'), '<!doctype html><title>Demo</title><button>Go</button>')
  store = new ScratchpadStore(new Workspace(root), null)
})
afterEach(async () => { resumeCollectionWrites(root); await rm(root, { recursive: true, force: true }) })

test('typed pictures retain bytes, source base and recoverable metadata, never enter text-only adapters', async () => {
  const markdown = '![Loop](assets/loop.png)'
  const item = await store.addAsset({ origin: 'source/part.md', kind: 'pic', markdown, heading: 'Source section', capturedSpan: { from: 10, to: 10 + markdown.length, line: 3 } })
  expect((await store.get(item.id)).kind).toBe('pic')
  expect((await store.get(item.id)).origin).toMatchObject({ heading: 'Source section', capturedSpan: { from: 10, to: 10 + markdown.length, line: 3 } })
  await store.toggleDone(item.id)
  await store.setColour(item.id, '#2e6be6')
  const group = await store.createGroup('Local visuals')
  await store.setGroup([item.id], group.id)
  expect(await store.get(item.id)).toMatchObject({ kind: 'pic', done: true, colour: '#2e6be6', group: group.id, markdown })
  expect((await store.get(item.id)).markdown).toBe(markdown)
  expect(waitingLossless([item])).toEqual([])
  await expect(store.reserveCut(item.id, 'holder')).rejects.toThrow()
  await expect(store.confirmCut(item.id)).rejects.toThrow()
  const prepared = await store.prepareInsert(item.id, 'target/deep/draft.md')
  expect(prepared).toMatchObject({ ok: true, markdown: '![Loop](../../source/assets/loop.png)' })
  await store.setStatus([item.id], 'rejected')
  expect(await readFile(join(root, 'source/assets/loop.png'), 'utf8')).toBe('image bytes')
  expect(await store.prepareInsert(item.id, 'source/part.md')).toMatchObject({ ok: false })
  await store.setStatus([item.id], 'active')
  expect(await store.prepareInsert(item.id, 'source/part.md')).toMatchObject({ ok: true, markdown })
})
test('table and SVG keep complete typed payloads; mismatched or multi-object collection refuses', async () => {
  for (const [kind, markdown] of [['table', '| A | B |\r\n|---|---|\r\n| 1 | 2 |'], ['svg', '```svg\n<svg xmlns="http://www.w3.org/2000/svg"/>\n```']] as const) {
    const item = await store.addAsset({ origin: 'source/part.md', kind, markdown })
    expect((await store.get(item.id)).markdown).toBe(markdown)
    expect((await store.get(item.id)).kind).toBe(kind)
  }
  await expect(store.addAsset({ origin: 'source/part.md', kind: 'svg', markdown: 'arbitrary text' })).rejects.toThrow()
})
test('missing, remote and incompatible assets refuse before insertion and leave destination untouched', async () => {
  const item = await store.addAsset({ origin: 'source/part.md', kind: 'widget', markdown: '[Simulation: assets/demo.html]' })
  expect(await store.prepareInsert(item.id, 'target/deep/draft.md')).toMatchObject({ ok: true, markdown: '[Simulation: ../../source/assets/demo.html]' })
  await writeFile(join(root, 'source/assets/demo.html'), '<title>Bad</title><script>fetch("remote")</script>')
  expect(await store.prepareInsert(item.id, 'target/deep/draft.md')).toMatchObject({ ok: false })
  await rm(join(root, 'source/assets/demo.html'))
  expect(await store.prepareInsert(item.id, 'source/part.md')).toMatchObject({ ok: false })
  await expect(store.addAsset({ origin: 'source/part.md', kind: 'pic', markdown: '![web](https://example.com/a.png)' })).rejects.toThrow()
  expect(await readFile(join(root, 'target/deep/draft.md'), 'utf8')).toBe('# Target')
})
test('widget preview returns exactly the checked bytes of the store-current payload', async () => {
  const item = await store.addAsset({ origin: 'source/part.md', kind: 'widget', markdown: '[Simulation: assets/demo.html]' })
  const first = await store.prepareWidgetPreview(item.id)
  expect(first).toMatchObject({ ok: true, markdown: '[Simulation: assets/demo.html]', title: 'Demo' })
  if (!first.ok) throw new Error(first.error)
  expect(first.html).toBe(await readFile(join(root, 'source/assets/demo.html'), 'utf8'))
  // Bytes changed after preparation are not retro-fitted into the prepared page, and a fresh
  // preparation checks (and returns) the new bytes — never a prior check over later bytes.
  const changed = '<!doctype html><title>Changed</title><p>New page</p>'
  await writeFile(join(root, 'source/assets/demo.html'), changed)
  expect(first.html).not.toBe(changed)
  const second = await store.prepareWidgetPreview(item.id)
  expect(second).toMatchObject({ ok: true, html: changed, title: 'Changed' })
  await writeFile(join(root, 'source/assets/demo.html'), '<title>Bad</title><script>fetch("remote")</script>')
  expect(await store.prepareWidgetPreview(item.id)).toMatchObject({ ok: false })
  const table = await store.addAsset({ origin: 'source/part.md', kind: 'table', markdown: '| A |\n|---|\n| 1 |' })
  expect(await store.prepareWidgetPreview(table.id)).toMatchObject({ ok: false })
})
test('typed collection respects collection write gate', async () => {
  pauseCollectionWrites(root)
  await expect(store.addAsset({ origin: 'source/part.md', kind: 'pic', markdown: '![Loop](assets/loop.png)' })).rejects.toThrow()
})

test('Folio inventory asks live owners for each resolved part; unsaved content wins over disk', async () => {
  await writeFile(join(root, '_report-structure.json'), JSON.stringify({ files: ['source/part.md', 'target/deep/draft.md'] }))
  const reads: string[][] = []
  const inventory = await readScratchInventory(new Workspace(root), { activePath: 'source/part.md', scope: 'folio' }, async (_root, paths) => {
    reads.push([...paths])
    return [{ path: 'source/part.md', content: '![Unsaved](assets/loop.png)' }, { path: 'target/deep/draft.md', content: '| New |\n|---|\n| live |' }]
  })
  expect(reads[0]).toContain('source/part.md')
  expect(reads[0]).toContain('target/deep/draft.md')
  expect(inventory.items.map(item => item.origin.path).sort()).toEqual(['source/part.md', 'target/deep/draft.md'])
  expect(inventory.items.every(item => item.document!.basis === 'live')).toBe(true)
  const changed = await readScratchInventory(new Workspace(root), { activePath: 'source/part.md', scope: 'part' }, async () => [{ path: 'source/part.md', content: '' }])
  expect(changed.items).toEqual([])
})
test('conflicting live owners refuse disk fallback and explicitly disk-only reads say disk', async () => {
  await writeFile(join(root, 'source/part.md'), '![Disk](assets/loop.png)')
  const disk = await readScratchInventory(new Workspace(root), { activePath: 'source/part.md', scope: 'part' }, null)
  expect(disk.items[0].document!.basis).toBe('disk')
  const conflict = await readScratchInventory(new Workspace(root), { activePath: 'source/part.md', scope: 'part' }, async () => [{ path: 'source/part.md', content: '' }, { path: 'source/part.md', content: '![Other](assets/loop.png)' }])
  expect(conflict.items).toEqual([])
  expect(conflict.notices.join()).toContain('more than one')
})

test('typed headless read exposes exact candidate payloads and labels disk inventory honestly', async () => {
  const markdown = '| A | B |\n|---|---|\n| 1 | 2 |'
  await writeFile(join(root, 'source/part.md'), markdown)
  const item = await store.addAsset({ origin: 'source/part.md', kind: 'table', markdown })
  const result = await READ_OPERATIONS.find(operation => operation.name === 'scratchpad')!.run({ workspace: new Workspace(root), output: 'json', cwd: root, stdin: async () => '', openUrl: async () => {} }, { path: 'source/part.md' })
  expect(result.data).toMatchObject({ items: [{ id: item.id, kind: 'table', markdown }], inventory: { items: [{ kind: 'table', markdown, document: { basis: 'disk' } }] } })
})

test('agent read verbs expose typed metadata and exact content without a parallel writer', async () => {
  const markdown = '| A | B |\n|---|---|\n| 1 | 2 |'
  await writeFile(join(root, 'source/part.md'), markdown)
  const item = await store.addAsset({ origin: 'source/part.md', kind: 'table', markdown })
  const verbs = buildVerbTable(new Workspace(root))
  const get = verbs.find(verb => verb.id === 'scratchpad.get')!
  expect(get.posture).toBe('direct')
  expect(get.risk).toBe('read')
  const result = await get.run({} as never, { id: item.id })
  expect(result.details).toMatchObject({ item: { kind: 'table', markdown } })
  const listed = await verbs.find(verb => verb.id === 'scratchpad.list')!.run({} as never, {})
  expect(listed.details).toMatchObject({ items: [{ kind: 'table', id: item.id }] })
  expect(JSON.stringify(listed.details)).not.toContain('markdown')
  const inventory = await verbs.find(verb => verb.id === 'scratchpad.inventory')!.run({} as never, { path: 'source/part.md', scope: 'part' })
  expect(inventory.details).toMatchObject({ items: [{ kind: 'table', document: { basis: 'disk' } }] })
})

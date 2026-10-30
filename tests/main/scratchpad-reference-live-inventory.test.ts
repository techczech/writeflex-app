import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Workspace } from '../../src/main/workspace'
import { ScratchpadStore } from '../../src/main/scratchpad-store'
import { configureScratchLiveReader, readScratchInventory } from '../../src/main/scratchpad-inventory'
import { collectCanonicalSource, readCanonicalSources } from '../../src/main/scratchpad-references'
import { assetStillCurrent, documentAssets, documentAssetsProjected } from '../../src/shared/scratchpad-inventory'
import { validateScratchAsset } from '../../src/main/scratchpad-assets'
import { pangramFolio } from '../fixtures/folio-room/folio-room-fixtures'

let fixture: string | null = null
afterEach(async () => {
  configureScratchLiveReader(null)
  if (fixture) await rm(fixture, { recursive: true, force: true })
  fixture = null
})

test('unsaved live citations can be collected without saving the part first', async () => {
  fixture = await mkdtemp(join(tmpdir(), 'wf-live-ref-'))
  await pangramFolio(fixture)
  const path = 'pangram/contents/02-report.md'
  const disk = await readFile(join(fixture, path), 'utf8')
  const target = 'zotero://select/library/items/NEW12345'
  const raw = `${disk}\n\n[⟨New 2026⟩](${target})\n`
  configureScratchLiveReader(async (_root, paths) => paths.includes(path) ? [{ path, content: raw, removedSpans: [] }] : [])
  const ws = new Workspace(fixture)
  const store = new ScratchpadStore(ws, null)
  const inventory = await readScratchInventory(ws, { activePath: path, scope: 'part' })
  const cited = inventory.items.find(item => item.ref?.target === target)!
  expect(cited).toBeDefined()
  expect(cited.document?.basis).toBe('live')
  const sources = await readCanonicalSources(ws, store, path)
  const source = sources.sources.find(source => source.ref.target === target)
  expect(source).toBeDefined()
  const item = await collectCanonicalSource(ws, store, { activePath: path, sourceId: source!.sourceId })
  expect(item.ref?.target).toBe(target)
  expect(await readFile(join(fixture, path), 'utf8')).toBe(disk)
})

test('inventory counts explicit citation chips inside Markdown tables', () => {
  const target = 'zotero://select/library/items/ABCD1234'
  const chip = `[⟨Source 2026⟩](${target})`
  const markdown = `| Evidence |\n| --- |\n| ${chip} |\n`
  const inventory = documentAssets('report.md', markdown, 'live')
  expect(inventory.filter(item => item.kind === 'table')).toHaveLength(1)
  const references = inventory.filter(item => item.kind === 'ref')
  expect(references).toHaveLength(1)
  expect(references[0].cited?.count).toBe(1)
  const position = references[0].cited!.positions[0]
  expect(markdown.slice(position.from, position.to)).toBe(chip)
})

test('Reviewing excluded spans keep unsaved citations out of canonical sources; kept ones collect', async () => {
  fixture = await mkdtemp(join(tmpdir(), 'wf-live-ref-reviewing-'))
  await pangramFolio(fixture)
  const path = 'pangram/contents/02-report.md'
  const disk = await readFile(join(fixture, path), 'utf8')
  const kept = 'zotero://select/library/items/KEPT1234'
  const gone = 'zotero://select/library/items/GONE1234'
  const goneChip = `[⟨Gone 2026⟩](${gone})`
  const prefix = `${disk}\n\n[⟨Kept 2026⟩](${kept})\n\n`
  const raw = `${prefix}${goneChip}\n`
  configureScratchLiveReader(async (_root, paths) => paths.includes(path)
    ? [{ path, content: raw, removedSpans: [{ from: prefix.length, to: prefix.length + goneChip.length }] }] : [])
  const ws = new Workspace(fixture)
  const store = new ScratchpadStore(ws, null)
  const sources = await readCanonicalSources(ws, store, path)
  expect(sources.sources.find(source => source.ref.target === kept)).toBeDefined()
  expect(sources.sources.find(source => source.ref.target === gone)).toBeUndefined()
  // The inventory projection agrees: raw positions, the excluded chip absent.
  const inventory = await readScratchInventory(ws, { activePath: path, scope: 'part' })
  expect(inventory.items.find(item => item.ref?.target === kept)).toBeDefined()
  expect(inventory.items.find(item => item.ref?.target === gone)).toBeUndefined()
  expect(await readFile(join(fixture, path), 'utf8')).toBe(disk)
})

test('identical cached owners agree; conflicting and unavailable owners fail closed without stale disk', async () => {
  fixture = await mkdtemp(join(tmpdir(), 'wf-live-ref-owners-'))
  await pangramFolio(fixture)
  const path = 'pangram/contents/02-report.md'
  const stale = 'zotero://select/library/items/STALE123'
  const disk = `${await readFile(join(fixture, path), 'utf8')}\n\n[⟨Stale 2025⟩](${stale})\n`
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(fixture, path), disk)
  const live = 'zotero://select/library/items/LIVE1234'
  const raw = `${disk}\n[⟨Live 2026⟩](${live})\n`
  const ws = new Workspace(fixture)
  const store = new ScratchpadStore(ws, null)
  // Two windows holding the same cached unsaved buffer are one owner, not a conflict.
  configureScratchLiveReader(async (_root, paths) => paths.includes(path)
    ? [{ path, content: raw, removedSpans: [] }, { path, content: raw, removedSpans: [] }] : [])
  let sources = await readCanonicalSources(ws, store, path)
  expect(sources.sources.find(source => source.ref.target === live)).toBeDefined()
  expect(sources.sources.find(source => source.ref.target === stale)).toBeDefined()
  // Conflicting windows: neither the live-only nor the disk-only citation is offered.
  configureScratchLiveReader(async (_root, paths) => paths.includes(path)
    ? [{ path, content: raw, removedSpans: [] }, { path, content: `${raw}changed\n`, removedSpans: [] }] : [])
  sources = await readCanonicalSources(ws, store, path)
  expect(sources.sources.find(source => source.ref.target === live)).toBeUndefined()
  expect(sources.sources.find(source => source.ref.target === stale)).toBeUndefined()
  expect(sources.notices.some(notice => notice.includes('Disk was not substituted'))).toBe(true)
  // Unavailable owner: stale disk is not substituted either.
  configureScratchLiveReader(async (_root, paths) => paths.includes(path) ? [{ path, content: null }] : [])
  sources = await readCanonicalSources(ws, store, path)
  expect(sources.sources.find(source => source.ref.target === stale)).toBeUndefined()
  expect(sources.notices.some(notice => notice.includes('Disk was not substituted'))).toBe(true)
  expect(await readFile(join(fixture, path), 'utf8')).toBe(disk)
})

test('table citations: repeats count, code does not, validation keeps the table whole, Reviewing maps raw ranges', async () => {
  const target = 'zotero://select/library/items/ABCD1234'
  const chip = `[⟨Source 2026⟩](${target})`
  const codeChip = '`[⟨Coded 2026⟩](zotero://select/library/items/CODE1234)`'
  const table = `| Evidence | Note |\n| --- | --- |\n| ${chip} | ${codeChip} |\n| again ${chip} | x |`
  const markdown = `${table}\n\nProse cites ${chip} too.\n`
  const inventory = documentAssets('report.md', markdown, 'live')
  const tables = inventory.filter(item => item.kind === 'table')
  expect(tables).toHaveLength(1)
  // The table candidate capture stays byte-exact and complete.
  expect(tables[0].markdown).toBe(table)
  expect(markdown.slice(tables[0].document!.from, tables[0].document!.to)).toBe(table)
  const references = inventory.filter(item => item.kind === 'ref')
  expect(references).toHaveLength(1)
  expect(references[0].cited?.count).toBe(3)
  for (const position of references[0].cited!.positions) expect(markdown.slice(position.from, position.to)).toBe(chip)
  expect(inventory.some(item => item.ref?.target.includes('CODE1234'))).toBe(false)
  // One-complete-object validation accepts the table despite its secondary reference entries.
  await validateScratchAsset('/unused-root', 'report.md', 'table', tables[0].markdown)
  // Show-in-document revalidation still holds for both the table and the cited reference.
  expect(assetStillCurrent(tables[0], markdown)).toBe(true)
  expect(assetStillCurrent(references[0], markdown)).toBe(true)
  // Under Reviewing, an excluded prose citation before the table shifts nothing: reported
  // positions are the exact raw ranges of the remaining chips.
  const excluded = `Old ${chip} text.\n\n`
  const raw = `${excluded}${markdown}`
  const projected = documentAssetsProjected('report.md', raw, 'live', [{ from: 0, to: excluded.length }])
  const projectedRefs = projected.filter(item => item.kind === 'ref')
  expect(projectedRefs).toHaveLength(1)
  expect(projectedRefs[0].cited?.count).toBe(3)
  for (const position of projectedRefs[0].cited!.positions) expect(raw.slice(position.from, position.to)).toBe(chip)
  const projectedTable = projected.find(item => item.kind === 'table')!
  expect(raw.slice(projectedTable.document!.from, projectedTable.document!.to)).toBe(table)
  expect(assetStillCurrent(projectedRefs[0], { raw, removedSpans: [{ from: 0, to: excluded.length }] })).toBe(true)
})

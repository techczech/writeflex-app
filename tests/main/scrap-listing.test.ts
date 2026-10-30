import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { ScrapStore } from '../../src/main/scraps'
import { configureScratchpadHolders, scratchpadHolder } from '../../src/main/scratchpad-holders'
import { ScratchpadStore } from '../../src/main/scratchpad-store'
import { listScrapsWithScratchpad } from '../../src/main/scrap-listing'
import { evaluateCollectionQuery } from '../../src/main/query-engine'
import { prepareOffcutPromotion, prepareScrapAppend, recordLosslessBoardCopy, writeMaterial } from '../../src/main/board-material'
import { boardOffcuts } from '../../src/renderer/src/components/board-projection'

// R6 (independent review round 1): a cut now lands in the floating Scratchpad's lossless store, so the
// readers that grew up on SCRAPS.md files read it through one adapter. Legacy files stay byte-identical
// and lossless payloads are never written back in the heading grammar. Since ticket 04 the Board takes
// a lossless text item as a retained copy (spec P4): the copy is recorded, the candidate stays. Real temp folders.

let root: string
let ws: Workspace
let scraps: ScrapStore
let store: ScratchpadStore
const LEGACY = '## s_a {sig}\nKind regards,\nDominik\n'
const RICH = '## Kept heading\n\n```md\n## s_fake\n```\n\n- one\n'

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-scrap-listing-'))
  ws = new Workspace(root)
  scraps = new ScrapStore(ws)
  store = new ScratchpadStore(ws, scraps)
  await mkdir(join(root, 'scraps'), { recursive: true })
  await writeFile(join(root, 'essay.md'), '---\nstatus: draft\n---\n# Essay\n\nBody.\n', 'utf8')
  await writeFile(join(root, 'other.md'), '---\nstatus: draft\n---\n# Other\n', 'utf8')
  await writeFile(join(root, 'scraps', 'essay-SCRAPS.md'), LEGACY, 'utf8')
})
afterEach(async () => { configureScratchpadHolders(() => []); await rm(root, { recursive: true, force: true }) })

const cut = async (origin: string, markdown: string): Promise<string> => {
  const item = await store.addText({ origin, markdown, how: 'copy', by: 'writer' })
  await store.confirmCut(item.id)
  return item.id
}

describe('one listing for the old readers', () => {
  test('legacy scraps then waiting lossless items; exact Markdown; rejected and put-back items left out', async () => {
    const waiting = await cut('essay.md', RICH)
    const rejected = await cut('essay.md', 'Rejected.')
    await store.setStatus([rejected], 'rejected')
    const placed = await cut('essay.md', 'Put back.')
    configureScratchpadHolders(() => [7])
    await store.recordUse(placed, { useId: 'u_back0001', path: 'essay.md', mode: 'put-back', holder: scratchpadHolder(7) })
    const listing = await listScrapsWithScratchpad(ws, scraps)
    expect(listing.map((s) => [s.source, s.id.startsWith('p_') ? 'p_' : s.id, s.text, s.expandTrigger ?? null])).toEqual([
      ['legacy', 's_a', 'Kind regards,\nDominik', 'sig'],
      ['lossless', 'p_', RICH, null],
    ])
    expect(listing[1]).toMatchObject({ id: waiting, origin: 'essay.md', how: 'cut', done: false })
    expect(await readFile(join(root, 'scraps', 'essay-SCRAPS.md'), 'utf8')).toBe(LEGACY)
  })

  test('an origin filter applies to both kinds', async () => {
    await cut('other.md', 'From the other one.')
    expect((await listScrapsWithScratchpad(ws, scraps, { origin: 'other.md' })).map((s) => s.text)).toEqual(['From the other one.'])
    expect((await listScrapsWithScratchpad(ws, scraps, { origin: 'essay.md' })).map((s) => s.source)).toEqual(['legacy'])
  })
})

describe('the Board', () => {
  test('a new cut counts for its piece, sits in its drawer, and is listed in the Offcuts column after the scraps files', async () => {
    const id = await cut('essay.md', RICH)
    const result = await evaluateCollectionQuery(ws, '', '')
    if (!result.ok) throw new Error(result.error)
    const essay = result.rows.find((row) => row.path === 'essay.md')!
    expect(essay.scrapCount).toBe(2)
    expect(essay.drawer?.scraps.map((s) => s.id)).toEqual(['s_a', id])
    expect(boardOffcuts(result.rows).map((o) => [o.source ?? 'legacy', o.id === id ? 'new' : o.id, o.origin, o.text])).toEqual([
      ['legacy', 's_a', 'essay.md', 'Kind regards,\nDominik'],
      ['lossless', 'new', 'essay.md', RICH],
    ])
  })

  test('ticket 04 (P4 copy): a lossless offcut promotes with its exact payload quoted; recording the copy RETAINS the candidate in every listing', async () => {
    const id = await cut('essay.md', RICH)
    const plan = await prepareOffcutPromotion(ws, { dir: '', scrapsPath: '', scrapId: id, name: 'An idea' })
    expect(plan.scraps).toBeNull()
    expect(plan.lossless).toEqual({ id, markdown: RICH })
    expect(plan.tracker.after).toContain('## Kept heading')
    await writeMaterial(ws, [plan.tracker])
    await recordLosslessBoardCopy(ws, plan.lossless!, plan.tracker.path)
    // Copy-for-reuse: exact payload, id, group/status/provenance retained; only a historical use added.
    const kept = await store.get(id)
    expect(kept).toMatchObject({ markdown: RICH, status: 'active', group: null })
    expect(kept.uses).toContainEqual(expect.objectContaining({ path: plan.tracker.path, mode: 'copy', historical: true }))
    expect((await listScrapsWithScratchpad(ws, scraps)).some((s) => s.id === id)).toBe(true)
    const record = JSON.parse(await readFile(join(root, '.writeflex', `scratchpad-item-${id}.json`), 'utf8')) as { consumed?: unknown; uses: Array<{ path: string; mode: string; historical?: boolean }> }
    expect(record.consumed).toBeUndefined()
    expect(record.uses).toContainEqual(expect.objectContaining({ path: plan.tracker.path, mode: 'copy', historical: true }))
    expect(await readFile(join(root, '.writeflex', `scratchpad-item-${id}.md`), 'utf8')).toBe(RICH)
    expect(await readFile(join(root, 'scraps', 'essay-SCRAPS.md'), 'utf8')).toBe(LEGACY)
  })

  test('ticket 04: appending a lossless drawer item keeps its exact bytes; another piece refuses and nothing is written', async () => {
    const exact = 'First line.\r\n\r\n## s_fake inside\r\n- keep\r\n'
    const id = await cut('essay.md', exact)
    await expect(prepareScrapAppend(ws, { piece: 'other.md', scrapId: id })).rejects.toThrow('another piece')
    expect(await readFile(join(root, 'other.md'), 'utf8')).toBe('---\nstatus: draft\n---\n# Other\n')
    const plan = await prepareScrapAppend(ws, { piece: 'essay.md', scrapId: id })
    expect(plan.piece.after).toBe(`---\nstatus: draft\n---\n# Essay\n\nBody.\n\n${exact}`)
    await writeMaterial(ws, [plan.piece])
    await recordLosslessBoardCopy(ws, plan.lossless!, 'essay.md')
    expect((await listScrapsWithScratchpad(ws, scraps)).some((s) => s.id === id)).toBe(true)
    expect((await store.get(id)).markdown).toBe(exact)
  })
})

test('old-run put-backs return to every shared listing and Board projection', async () => {
  const id = await cut('essay.md', 'Old placement.')
  await store.recordUse(id, { useId: 'u_oldrun01', path: 'essay.md', mode: 'put-back', holder: 'previous-run:1' })
  expect((await listScrapsWithScratchpad(ws, scraps)).some((s) => s.id === id)).toBe(true)
  const result = await evaluateCollectionQuery(ws, '', '')
  if (!result.ok) throw new Error(result.error)
  expect(boardOffcuts(result.rows).some((s) => s.id === id)).toBe(true)
})


test('main-derived same-run live holders stay placed in shared readers; dead holders return everywhere', async () => {
  let senders = [11]
  configureScratchpadHolders((askedRoot) => askedRoot === root ? senders : [])
  const id = await cut('essay.md', 'Live placement.')
  await store.recordUse(id, { useId: 'u_liverun1', path: 'essay.md', mode: 'put-back', holder: scratchpadHolder(11) })
  expect((await listScrapsWithScratchpad(ws, scraps)).some((s) => s.id === id)).toBe(false)
  expect((await store.get(id)).uses[0].unverified).toBeUndefined()
  let result = await evaluateCollectionQuery(ws, '', '')
  if (!result.ok) throw new Error(result.error)
  expect(boardOffcuts(result.rows).some((s) => s.id === id)).toBe(false)
  senders = []
  expect((await listScrapsWithScratchpad(ws, scraps)).some((s) => s.id === id)).toBe(true)
  expect((await new ScratchpadStore(new Workspace(root), null).get(id)).uses[0].unverified).toBe(true)
  result = await evaluateCollectionQuery(ws, '', '')
  if (!result.ok) throw new Error(result.error)
  expect(boardOffcuts(result.rows).some((s) => s.id === id)).toBe(true)
})

test('withdrawn copies are absent from compatibility readers and Board counts', async () => {
  const item = await store.addText({ origin: 'essay.md', markdown: RICH, how: 'copy', by: 'writer' })
  await store.discardCopy(item.id)
  expect((await listScrapsWithScratchpad(ws, scraps)).map((s) => s.id)).toEqual(['s_a'])
  const result = await evaluateCollectionQuery(ws, '', '')
  if (!result.ok) throw new Error(result.error)
  expect(result.rows.find((r) => r.path === 'essay.md')!.scrapCount).toBe(1)
  expect(boardOffcuts(result.rows).some((s) => s.id === item.id)).toBe(false)
})

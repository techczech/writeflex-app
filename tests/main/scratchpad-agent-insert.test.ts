import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedSessionFactory } from '@bridle/core'
import { WorkspaceAgent, type ScriptedStep } from '../../src/main/agent'
import { ChangeStore } from '../../src/main/changes'
import { Workspace } from '../../src/main/workspace'
import { ScratchpadStore } from '../../src/main/scratchpad-store'
import { ScrapStore } from '../../src/main/scraps'
import { configureScratchLiveReader } from '../../src/main/scratchpad-inventory'
import { configureScratchpadHolders, scratchpadHolder } from '../../src/main/scratchpad-holders'
import { collectCanonicalSource, readCanonicalSources } from '../../src/main/scratchpad-references'
import { prepareBoundInsert, executeBoundInsert } from '../../src/main/scratchpad-agent-insert'
import { evidencePath } from '../../src/main/folio-evidence'
import { pangramFolio } from '../fixtures/folio-room/folio-room-fixtures'
import { isPlaced } from '../../src/shared/scratchpad-items'
import { WRITEFLEX_AGENT_AUTHOR } from '../../src/main/versions'

// Ticket 04 agent insertion parity: scratchpad.insert / scratchpad.put_back and the reference acts
// are bound proposals. The Change shows the exact prepared bytes; Accept revalidates the frozen
// bound (candidate, canonical source, widget page, destination, live owner) and writes only those
// bytes, once. All fixtures synthetic.

const DOC = '# Doc\n\nAlpha paragraph.\n\nOmega paragraph.\n'
const FRAGMENT = 'A kept fragment with **bold** words.\n\nSecond kept line.'

let root: string
let appData: string
let ws: Workspace
let store: ScratchpadStore
let scraps: ScrapStore
let agent: WorkspaceAgent | null = null

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'wf-scratch-agent-')))
  appData = await mkdtemp(join(tmpdir(), 'wf-scratch-agent-data-'))
  ws = new Workspace(root)
  scraps = new ScrapStore(ws)
  store = new ScratchpadStore(ws, scraps)
  await writeFile(join(root, 'doc.md'), DOC)
})
afterEach(async () => {
  await agent?.dispose()
  agent = null
  configureScratchLiveReader(null)
  configureScratchpadHolders(() => [])
  await rm(root, { recursive: true, force: true })
  await rm(appData, { recursive: true, force: true })
})

const docText = (): Promise<string> => readFile(join(root, 'doc.md'), 'utf8')
const payloadPath = (id: string): string => join(root, `.writeflex/scratchpad-item-${id}.md`)

async function waitForChanges(changes: ChangeStore, count: number) {
  for (let i = 0; i < 100; i += 1) {
    const all = await changes.list()
    if (all.length === count) return all
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return changes.list()
}

/** One scripted turn proposing `cap` once; returns the staged Change (or null when none staged). */
async function propose(cap: string, input: Record<string, unknown>, services: Record<string, unknown> = {}) {
  const changes = new ChangeStore(ws)
  agent = await WorkspaceAgent.create({
    mode: 'work', workspace: ws, appDataDir: appData, changes,
    services: { scraps, ...services },
    onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory([{
      prompt: 'Do it',
      rounds: [
        { kind: 'tool-calls' as const, calls: [{ name: 'tools.enable', arguments: { names: [cap] } }] },
        { kind: 'tool-calls' as const, calls: [{ name: cap, arguments: input }] },
        { kind: 'message' as const, text: 'Proposed.' },
      ],
    }]),
  })
  await agent.runScriptedTurn('Do it', [{ cap, input } as ScriptedStep])
  const staged = await waitForChanges(changes, 1).catch(() => changes.list())
  return { changes, change: (await changes.list())[0] ?? staged[0] ?? null, agent }
}

test('insert: nothing is written before Accept, the Change shows the exact payload, Accept inserts exactly it and retains the candidate', async () => {
  const item = await store.addText({ origin: 'doc.md', markdown: FRAGMENT, how: 'copy', by: 'writer' })
  const { change, agent: live } = await propose('scratchpad.insert', { id: item.id, path: 'doc.md', insertAfter: 'Alpha paragraph.' })
  expect(change).not.toBeNull()
  expect(await docText()).toBe(DOC) // proposing wrote nothing
  expect(change!.newText).toBe(FRAGMENT) // shown text is the exact prepared payload
  expect(change!.editClass).toBe('insert')

  const result = await live.resolveChange(change!.id, 'accept')
  expect(result.applied).toBe(true)
  const after = await docText()
  expect(after).toContain(`Alpha paragraph.\n\n${FRAGMENT}\n\nOmega paragraph.`)
  expect(after.split(FRAGMENT)).toHaveLength(2) // exactly once

  const kept = await store.get(item.id)
  expect(kept.markdown).toBe(FRAGMENT) // candidate retained, byte for byte
  expect(kept.status).toBe('active')
  expect(kept.uses).toHaveLength(1)
  expect(kept.uses[0]).toMatchObject({ path: 'doc.md', mode: 'copy', historical: true })
  expect(isPlaced(kept)).toBe(false) // a copy never holds a place
})

test('insert: a candidate changed while the proposal waits refuses at Accept and writes nothing', async () => {
  const item = await store.addText({ origin: 'doc.md', markdown: FRAGMENT, how: 'copy', by: 'writer' })
  const { change, agent: live } = await propose('scratchpad.insert', { id: item.id, path: 'doc.md', insertAfter: 'Alpha paragraph.' })
  expect(change).not.toBeNull()
  await writeFile(payloadPath(item.id), 'Swapped words the writer never reviewed.')

  const result = await live.resolveChange(change!.id, 'accept')
  expect(result.applied).toBe(false)
  expect(result.message).toContain('changed since this proposal was made')
  expect(await docText()).toBe(DOC)
})

test('insert: a destination changed while the proposal waits refuses at Accept', async () => {
  const item = await store.addText({ origin: 'doc.md', markdown: FRAGMENT, how: 'copy', by: 'writer' })
  const { change, agent: live } = await propose('scratchpad.insert', { id: item.id, path: 'doc.md', insertAfter: 'Alpha paragraph.' })
  expect(change).not.toBeNull()
  await writeFile(join(root, 'doc.md'), `${DOC}\nAn outside sentence.\n`)

  const result = await live.resolveChange(change!.id, 'accept')
  expect(result.applied).toBe(false)
  expect(await docText()).toBe(`${DOC}\nAn outside sentence.\n`) // the outside edit stands, untouched
})

test('insert: a whole table is shown and inserted whole; one changed cell refuses', async () => {
  const TABLE = '| Name | Count |\n| --- | --- |\n| Alpha | 1 |\n| Beta | 2 |'
  const item = await store.addAsset({ origin: 'doc.md', kind: 'table', markdown: TABLE })
  const bound = await prepareBoundInsert(ws, store, 'scratchpad.insert', { id: item.id, path: 'doc.md', insertAfter: 'Alpha paragraph.' })
  expect(bound.markdown).toBe(TABLE) // the WHOLE table, not a title or first row
  const done = await executeBoundInsert(ws, store, bound, null)
  expect(done.text).toContain('Inserted a copy')
  expect(await docText()).toContain(TABLE)

  const item2 = await store.addAsset({ origin: 'doc.md', kind: 'table', markdown: TABLE })
  const bound2 = await prepareBoundInsert(ws, store, 'scratchpad.insert', { id: item2.id, path: 'doc.md', insertAfter: 'Omega paragraph.' })
  await writeFile(payloadPath(item2.id), TABLE.replace('| Beta | 2 |', '| Beta | 99 |'))
  await expect(executeBoundInsert(ws, store, bound2, null)).rejects.toThrow('changed since this proposal was made')
})

test('insert: a compatible widget lands as its embed line; a widget page changed since staging refuses', async () => {
  await mkdir(join(root, 'assets'), { recursive: true })
  const PAGE = '<!doctype html><html><head><title>Demo</title></head><body><p>1</p></body></html>'
  await writeFile(join(root, 'assets/demo.html'), PAGE)
  const item = await store.addAsset({ origin: 'doc.md', kind: 'widget', markdown: '[Simulation: assets/demo.html]' })
  const bound = await prepareBoundInsert(ws, store, 'scratchpad.insert', { id: item.id, path: 'doc.md', insertAfter: 'Alpha paragraph.' })
  expect(bound.widgetSha256).toBeDefined()
  await writeFile(join(root, 'assets/demo.html'), PAGE.replace('<p>1</p>', '<p>2</p>'))
  await expect(executeBoundInsert(ws, store, bound, null)).rejects.toThrow('widget changed')
  expect(await docText()).toBe(DOC)

  const bound2 = await prepareBoundInsert(ws, store, 'scratchpad.insert', { id: item.id, path: 'doc.md', insertAfter: 'Alpha paragraph.' })
  await executeBoundInsert(ws, store, bound2, null)
  expect(await docText()).toContain('[Simulation: assets/demo.html]')
})

test('put_back: a copy cannot be put back (nothing stages), and a cutting with no live editor refuses at Accept', async () => {
  const copy = await store.addText({ origin: 'doc.md', markdown: FRAGMENT, how: 'copy', by: 'writer' })
  const refused = await propose('scratchpad.put_back', { id: copy.id, path: 'doc.md', insertAfter: 'Alpha paragraph.' })
  expect(refused.change).toBeNull()
  agent?.dispose(); agent = null

  const cut = await store.addText({ origin: 'doc.md', markdown: 'Cut words.', how: 'copy', by: 'writer' })
  await store.reserveCut(cut.id, 'holder-a')
  await store.confirmCut(cut.id, 'holder-a')
  expect((await store.get(cut.id)).how).toBe('cut')
  const { change, agent: live } = await propose('scratchpad.put_back', { id: cut.id, path: 'doc.md', insertAfter: 'Alpha paragraph.' })
  expect(change).not.toBeNull()
  const result = await live.resolveChange(change!.id, 'accept')
  expect(result.applied).toBe(false)
  expect(result.message).toContain('Open doc.md in WriteFlex')
  expect(await docText()).toBe(DOC)
  expect(isPlaced(await store.get(cut.id))).toBe(false)
})

test('put_back: Accept writes the words and returns an exact placement receipt; no placed use exists until the editor anchor records it', async () => {
  const cut = await store.addText({ origin: 'doc.md', markdown: 'Cut words restored.', how: 'copy', by: 'writer' })
  await store.reserveCut(cut.id, 'holder-a')
  await store.confirmCut(cut.id, 'holder-a')
  // The destination is open, its buffer exactly the saved text, in window sender 7.
  configureScratchLiveReader(async (_root, paths) => paths.map((path) => ({ path, content: DOC })))
  configureScratchpadHolders(() => [7])
  const { change, agent: live } = await propose('scratchpad.put_back', { id: cut.id, path: 'doc.md', insertAfter: 'Alpha paragraph.' }, { scratchpadHolder: () => scratchpadHolder(7) })
  expect(change).not.toBeNull()
  const result = await live.resolveChange(change!.id, 'accept')
  expect(result.applied).toBe(true)
  expect(await docText()).toContain('Alpha paragraph.\n\nCut words restored.\n\nOmega paragraph.')
  // R1: a live window existing is NOT a placement. Main recorded nothing; it returned a typed
  // receipt whose offsets name exactly the fragment in the written text. (The CodeMirror anchor
  // itself is proven in scratchpad-editor.test.ts and the hidden e2e; this test proves main's
  // half of the handshake and the store seam the anchor-sync drives.)
  expect((await store.get(cut.id)).uses).toHaveLength(0)
  expect(isPlaced(await store.get(cut.id))).toBe(false)
  const receipt = result.scratchPlacement
  expect(receipt).toBeDefined()
  expect(receipt).toMatchObject({ itemId: cut.id, path: 'doc.md', markdown: 'Cut words restored.' })
  expect((await docText()).slice(receipt!.from, receipt!.to)).toBe('Cut words restored.')
  // The accepting editor's anchor-sync records the use through this same store seam (the bridge
  // stamps the holder from the sender window, never from renderer input): placed at last.
  await store.recordUse(cut.id, { useId: receipt!.useId, path: 'doc.md', mode: 'put-back', holder: scratchpadHolder(7) })
  const placed = await store.get(cut.id)
  expect(placed.uses).toHaveLength(1)
  expect(placed.uses[0]).toMatchObject({ mode: 'put-back', path: 'doc.md', holder: scratchpadHolder(7) })
  expect(isPlaced(placed)).toBe(true)
  // Undo in the editor drops the anchor, whose sync drops this use: the candidate returns.
  await store.dropUse(cut.id, receipt!.useId, scratchpadHolder(7))
  expect((await store.get(cut.id)).uses.filter((use) => use.mode === 'put-back' && !use.unverified)).toHaveLength(0)
  expect(isPlaced(await store.get(cut.id))).toBe(false)
  // Redo re-adds the anchor; its sync records the same use again.
  await store.recordUse(cut.id, { useId: receipt!.useId, path: 'doc.md', mode: 'put-back', holder: scratchpadHolder(7) })
  expect(isPlaced(await store.get(cut.id))).toBe(true)
  // The editor session gone: the claim can no longer be confirmed (existing liveness rules).
  configureScratchpadHolders(() => [])
  expect(isPlaced(await store.get(cut.id))).toBe(false)
})

test('a Scratchpad Change that outlived its session refuses instead of replaying from the ledger', async () => {
  const item = await store.addText({ origin: 'doc.md', markdown: FRAGMENT, how: 'copy', by: 'writer' })
  const { changes, change, agent: live } = await propose('scratchpad.insert', { id: item.id, path: 'doc.md', insertAfter: 'Alpha paragraph.' })
  expect(change).not.toBeNull()
  // A second record with the same marker but no live proposal and no frozen proof in this session.
  const orphaned = await changes.addScratchpadProposal({
    path: 'doc.md', provenance: 'agent', editClass: 'insert', category: 'other',
    summary: 'Insert “kept” from the Scratchpad', oldText: '', newText: FRAGMENT, insertAfter: 'Alpha paragraph.',
    isCorrection: false, author: WRITEFLEX_AGENT_AUTHOR,
  }, 'scratchpad.insert')
  const result = await live.resolveChange(orphaned.id, 'accept')
  expect(result.applied).toBe(false)
  expect(result.message).toContain('no longer live in this session')
  expect(await docText()).toBe(DOC)
})

test('cite and insert_quote are bound to the canonical record as staged; a source changed since refuses', async () => {
  await pangramFolio(root)
  const QUOTE = 'A quoted sentence from the note.'
  await writeFile(join(root, 'pangram/research/lea-street-1998.md'), `---\nauthor: Lea and Street\nyear: 1998\n---\n\n# Academic literacies\n\n${QUOTE} More.\n`)
  const SUMMARY = 'pangram/contents/01-summary.md'
  const summaryBefore = await readFile(join(root, SUMMARY), 'utf8')
  const EVIDENCE = ['WriteFlex keeps the evidence and notes for each part of this Folio here. Each ## heading names one part.', '', '## [[Summary]]', '', '### Evidence', '- [lea-street-1998.md](research/lea-street-1998.md)', `  - “${QUOTE}”`, ''].join('\n')
  await writeFile(join(root, evidencePath({ root, folioDir: 'pangram' })), EVIDENCE)
  const { sources } = await readCanonicalSources(ws, store, SUMMARY)
  const ev = sources.find((s) => s.kind === 'evidence' && s.ref.quote === QUOTE)!
  const collected = await collectCanonicalSource(ws, store, { activePath: SUMMARY, sourceId: ev.sourceId })
  const anchored = `${summaryBefore}\nAnchor sentence for a citation.\n`
  await writeFile(join(root, SUMMARY), anchored)

  const bound = await prepareBoundInsert(ws, store, 'scratchpad.insert_quote', { id: collected.id, path: SUMMARY, insertAfter: '' })
  expect(bound.markdown).toContain(QUOTE)
  expect(bound.markdown).toContain('Lea and Street 1998')
  // The canonical source's citation changes after staging (its year): the reviewed quote must not land.
  await writeFile(join(root, 'pangram/research/lea-street-1998.md'), `---\nauthor: Lea and Street\nyear: 1999\n---\n\n# Academic literacies\n\n${QUOTE} More.\n`)
  await expect(executeBoundInsert(ws, store, bound, null)).rejects.toThrow('source changed since this proposal was made')
  expect(await readFile(join(root, SUMMARY), 'utf8')).toBe(anchored)

  // Staged afresh against the record as it stands, what the writer now sees lands exactly.
  const bound2 = await prepareBoundInsert(ws, store, 'scratchpad.insert_quote', { id: collected.id, path: SUMMARY, insertAfter: '' })
  expect(bound2.markdown).toContain('Lea and Street 1999')
  await executeBoundInsert(ws, store, bound2, null)
  const after = await readFile(join(root, SUMMARY), 'utf8')
  expect(after).toContain(QUOTE)
  expect(after).toContain('Lea and Street 1999')
})

test('insert: a required use record that fails after the document landed rolls back only that receiving write', async () => {
  const item = await store.addText({ origin: 'doc.md', markdown: FRAGMENT, how: 'copy', by: 'writer' })
  const bound = await prepareBoundInsert(ws, store, 'scratchpad.insert', { id: item.id, path: 'doc.md', insertAfter: 'Alpha paragraph.' })
  const original = store.recordAgentUse.bind(store)
  store.recordAgentUse = async () => { throw new Error('record refused for this test') }
  try {
    await expect(executeBoundInsert(ws, store, bound, null)).rejects.toThrow('record refused for this test')
  } finally { store.recordAgentUse = original }
  expect(await docText()).toBe(DOC) // the receiving write was put back; nothing else changed
  expect((await store.get(item.id)).uses).toHaveLength(0)
})

test('insert: relative links are rebased for another folder through the checked preparation', async () => {
  await mkdir(join(root, 'sub'), { recursive: true })
  await writeFile(join(root, 'sub/other.md'), 'Other doc.\n')
  const item = await store.addText({ origin: 'doc.md', markdown: 'See [the other](sub/other.md) for details.', how: 'copy', by: 'writer' })
  await writeFile(join(root, 'sub/dest.md'), 'Dest.\n')
  const bound = await prepareBoundInsert(ws, store, 'scratchpad.insert', { id: item.id, path: 'sub/dest.md', insertAfter: 'Dest.' })
  expect(bound.markdown).toBe('See [the other](other.md) for details.')
  await executeBoundInsert(ws, store, bound, null)
  expect(await readFile(join(root, 'sub/dest.md'), 'utf8')).toContain('[the other](other.md)')
})

// Parent independent source-byte authority probe, through real staged/accepted WorkspaceAgent.
test('a picture rewritten after the Change was reviewed is refused without a document write', async () => {
  await mkdir(join(root, 'assets'), { recursive: true })
  const image = join(root, 'assets', 'diagram.png')
  await writeFile(image, 'original image bytes')
  const item = await store.addAsset({ origin: 'doc.md', kind: 'pic', markdown: '![Diagram](assets/diagram.png)' })
  const { change, agent: live } = await propose('scratchpad.insert', { id: item.id, path: 'doc.md', insertAfter: 'Alpha paragraph.' })
  expect(change).not.toBeNull()
  await writeFile(image, 'outside replacement image bytes')
  const result = await live.resolveChange(change!.id, 'accept')
  expect(result.applied).toBe(false)
  expect(await docText()).toBe(DOC)
  expect(await readFile(image, 'utf8')).toBe('outside replacement image bytes')
  expect((await store.get(item.id)).uses).toHaveLength(0)
})

test('a local picture embedded in a rich fragment is bound to its reviewed bytes too', async () => {
  await mkdir(join(root, 'assets'), { recursive: true })
  const image = join(root, 'assets', 'chart.svg')
  await writeFile(image, '<svg>reviewed</svg>')
  const item = await store.addText({ origin: 'doc.md', markdown: 'Before the chart.\n\n![Chart](assets/chart.svg)\n\nAfter the chart.', how: 'copy', by: 'writer' })
  const bound = await prepareBoundInsert(ws, store, 'scratchpad.insert', { id: item.id, path: 'doc.md', insertAfter: 'Alpha paragraph.' })
  expect(bound.resources.map((proof) => proof.path)).toEqual(['assets/chart.svg'])
  await writeFile(image, '<svg>replaced outside</svg>')
  await expect(executeBoundInsert(ws, store, bound, null)).rejects.toThrow('changed since this proposal was made')
  expect(await docText()).toBe(DOC)
  expect(await readFile(image, 'utf8')).toBe('<svg>replaced outside</svg>')
  // Staged afresh against the bytes as they stand, the same fragment lands.
  const bound2 = await prepareBoundInsert(ws, store, 'scratchpad.insert', { id: item.id, path: 'doc.md', insertAfter: 'Alpha paragraph.' })
  await executeBoundInsert(ws, store, bound2, null)
  expect(await docText()).toContain('![Chart](assets/chart.svg)')
})

test('a picture swapped for a link, or removed, after review is refused without a document write', async () => {
  await mkdir(join(root, 'assets'), { recursive: true })
  const image = join(root, 'assets', 'diagram.png')
  const outside = join(root, 'assets', 'other.png')
  await writeFile(image, 'reviewed bytes')
  await writeFile(outside, 'reviewed bytes')
  const item = await store.addAsset({ origin: 'doc.md', kind: 'pic', markdown: '![Diagram](assets/diagram.png)' })
  const bound = await prepareBoundInsert(ws, store, 'scratchpad.insert', { id: item.id, path: 'doc.md', insertAfter: 'Alpha paragraph.' })
  // Same bytes behind a symlink: byte equality through a link is not the checked source.
  await unlink(image)
  await symlink(outside, image)
  await expect(executeBoundInsert(ws, store, bound, null)).rejects.toThrow('changed since this proposal was made')
  expect(await docText()).toBe(DOC)
  // And gone entirely.
  await unlink(image)
  await writeFile(image, 'reviewed bytes')
  const bound2 = await prepareBoundInsert(ws, store, 'scratchpad.insert', { id: item.id, path: 'doc.md', insertAfter: 'Alpha paragraph.' })
  await unlink(image)
  await expect(executeBoundInsert(ws, store, bound2, null)).rejects.toThrow('missing or outside this workspace')
  expect(await docText()).toBe(DOC)
  expect((await store.get(item.id)).uses).toHaveLength(0)
})

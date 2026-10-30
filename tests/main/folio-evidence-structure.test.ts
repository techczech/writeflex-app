import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Workspace } from '../../src/main/workspace'
import { FolioWorkspace } from '../../src/main/folio-workspace'
import { mixedFolio } from '../fixtures/folio-room/folio-room-fixtures'
import { writeEvidence, undoEvidence, evidencePath, countAttachedEvidence, readEvidence } from '../../src/main/folio-evidence'
import { readPlanForAgent } from '../../src/main/plan-agent-reads'
import { folioRoomContext } from '../../src/main/folio-room-context'
import { applyEvidenceOps, EVIDENCE_OPEN_FENCE, evidenceKey, parseEvidence, leavesFenceOpen } from '../../src/shared/folio-evidence'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'wf-evidence-structure-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const meeting = evidenceKey('notes/meeting.md')
const item = '- [meeting.md](notes/meeting.md)\n  ```\n  code line\n'

// S2-1 (r2 review): the Intro item owns an indented fence opener whose closer sits after Method's heading. The file is
// fence-closed (Method is inside the fence); removing or replacing the item would flip every later fence.
const flipping = '## [[Intro]]\n\n### Evidence\n' + item + '## [[Method]]\n\n### Notes\nMethod notes.\n```\n\n## [[Costs]]\n\n### Notes\nCosts notes.\n'

test('removing or replacing an item whose span holds a fence opener closed after a later heading is refused byte-identically', async () => {
  await mixedFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), 'mixed')
  await writeFile(join(root, evidencePath(ws)), flipping)
  expect(leavesFenceOpen(flipping)).toBe(false)
  expect(parseEvidence(flipping).sections.map(section => section.title)).toEqual(['Intro', 'Costs'])
  for (const value of [null, '- [meeting.md](notes/meeting.md)\n']) {
    const answer = await writeEvidence(ws, [{ kind: 'item', part: 'Intro', key: meeting, expect: item, value }], { session: 'flip' })
    expect(answer.ok).toBe(false)
    expect(answer.message).toBe('Changing “meeting.md” in “Intro” would change how the rest of the evidence file reads, so nothing was changed. Check the code blocks in the file and try again.')
    expect(answer.token).toBeNull()
    expect(await readFile(join(root, evidencePath(ws)), 'utf8')).toBe(flipping)
  }
  // The file is still writable afterwards: a later part's notes go to that part.
  const costs = await writeEvidence(ws, [{ kind: 'notes', part: 'Costs', expect: 'Costs notes.\n', value: 'New costs.\n' }], { session: 'flip' })
  expect(costs.ok).toBe(true)
  expect(parseEvidence(await readFile(join(root, evidencePath(ws)), 'utf8')).sections.map(section => [section.title, section.notes?.raw ?? null])).toEqual([['Intro', null], ['Costs', 'New costs.\n']])
})

test('a removal that keeps fences closed but changes which sections parse is refused', () => {
  // A four-backtick opener in the item; after removal its column-0 closer opens, and a later three-backtick block's
  // four-backtick closer closes it, hiding Method while the file stays fence-closed.
  const owned = '- [meeting.md](notes/meeting.md)\n  ````\n  code\n'
  const source = '## [[Intro]]\n\n### Evidence\n' + owned + '````\n\n## [[Method]]\n\n### Notes\nMethod notes.\n\n```\nx\n````\n\n## [[Costs]]\n\n### Notes\nCosts notes.\n'
  expect(parseEvidence(source).sections.map(section => section.title)).toEqual(['Intro', 'Method', 'Costs'])
  expect(() => applyEvidenceOps(source, [{ kind: 'item', part: 'Intro', key: meeting, expect: owned, value: null }]))
    .toThrow('Changing “meeting.md” in “Intro” would change how the rest of the evidence file reads, so nothing was changed. Check the code blocks in the file and try again.')
})

test('a batch is refused whole when a later op would flip a fence: the earlier ordinary op is not applied', () => {
  const ordinary = '- [other.md](notes/other.md)\n'
  const source = flipping.replace('## [[Costs]]\n\n', '## [[Costs]]\n\n### Evidence\n' + ordinary + '\n')
  expect(() => applyEvidenceOps(source, [
    { kind: 'item', part: 'Costs', key: evidenceKey('notes/other.md'), expect: ordinary, value: null },
    { kind: 'item', part: 'Intro', key: meeting, expect: item, value: null },
  ])).toThrow('would change how the rest of the evidence file reads')
})

test('appending a new section and emptying an existing one are still allowed', () => {
  const lone = '- [meeting.md](notes/meeting.md)\n'
  const source = 'Lead\n\n## [[Intro]]\n\n### Evidence\n' + lone
  const added = applyEvidenceOps(source, [{ kind: 'notes', part: 'Method', expect: null, value: 'New.\n' }])
  expect(parseEvidence(added.source).sections.map(section => section.title)).toEqual(['Intro', 'Method'])
  const emptied = applyEvidenceOps(source, [{ kind: 'item', part: 'Intro', key: meeting, expect: lone, value: null }])
  expect(parseEvidence(emptied.source).sections).toEqual([])
})

test('Undo of an ordinary removal restores the item; with a fence left open since, Undo refuses whole and can run later', async () => {
  await mixedFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), 'mixed')
  const lone = '- [meeting.md](notes/meeting.md)\n  - “Notes.”\n'
  const before = 'Lead\n\n## [[Intro]]\n\n### Evidence\n- [other.md](notes/other.md)\n' + lone + '\n## [[Method]]\n\n### Notes\nMethod notes.\n'
  await writeFile(join(root, evidencePath(ws)), before)
  const removed = await writeEvidence(ws, [{ kind: 'item', part: 'Intro', key: meeting, expect: lone, value: null }], { session: 'undo' })
  expect(removed.ok).toBe(true)
  const after = await readFile(join(root, evidencePath(ws)), 'utf8')
  expect(after).not.toContain('meeting.md')

  // Another app leaves a fence open in Method's notes: Undo refuses, nothing is written, the token survives.
  const broken = after + '```\nunclosed\n'
  await writeFile(join(root, evidencePath(ws)), broken)
  const refused = await undoEvidence(ws, removed.token!, { session: 'undo' })
  expect(refused).toMatchObject({ ok: false, message: EVIDENCE_OPEN_FENCE })
  expect(await readFile(join(root, evidencePath(ws)), 'utf8')).toBe(broken)

  await writeFile(join(root, evidencePath(ws)), after)
  const undone = await undoEvidence(ws, removed.token!, { session: 'undo' })
  expect(undone).toMatchObject({ ok: true, message: 'Undone. Other evidence and notes were kept.' })
  const restored = parseEvidence(await readFile(join(root, evidencePath(ws)), 'utf8'))
  expect(restored.sections.map(section => [section.title, section.items.map(found => found.raw)])).toEqual([['Intro', ['- [other.md](notes/other.md)\n', lone]], ['Method', []]])
})

// St2-1 (r2 review): the per-turn summary counts the evidence file's rows and reads no source.
const spied = (real: Workspace) => {
  const touched: Array<[string, string]> = []
  let listed = 0
  const ws = new Proxy(real, { get(target, name) {
    if (name === 'readFile' || name === 'absolute') return (path: string, ...rest: unknown[]) => { touched.push([name, path]); return (target as any)[name](path, ...rest) }
    if (name === 'listFiles') return (...rest: unknown[]) => { listed++; return (target as any).listFiles(...rest) }
    const value = (target as any)[name]
    return typeof value === 'function' ? value.bind(target) : value
  } }) as Workspace
  return { ws, touched, listed: () => listed }
}
const evidenceText = '## [[Intro]]\n\n### Evidence\n- [meeting.md](notes/meeting.md) <!--wf:sha1-16=0123456789abcdef-->\n  - “A quotation to check.”\n- [other.md](notes/other.md)\n\n## [[Intro]]\n\n### Evidence\n- [meeting.md](notes/meeting.md)\n\n## [[Method]]\n\n### Evidence\n- [other.md](notes/other.md)\n'

test('with only file links attached, the evidence count reads the evidence file alone: no scan, no source read', async () => {
  await mixedFolio(root)
  await writeFile(join(root, 'mixed/_mixed_EVIDENCE-AND-NOTES.md'), evidenceText)
  const { ws, touched, listed } = spied(new Workspace(root))
  const count = await countAttachedEvidence(ws, 'mixed', ['Intro', 'Method', 'Costs'])
  expect(count).toEqual({ state: 'ready', counts: Object.assign(Object.create(null), { intro: 2, method: 1, costs: 0 }) })
  expect(touched).toEqual([['readFile', 'mixed/_mixed_EVIDENCE-AND-NOTES.md']])
  expect(listed()).toBe(0)
  await rm(join(root, 'mixed/_mixed_EVIDENCE-AND-NOTES.md'))
  expect((await countAttachedEvidence(ws, 'mixed', ['Intro'])).state).toBe('missing')
})

test('the per-turn summary counts attached evidence from the evidence file and never stats or reads a source', async () => {
  const built = await mixedFolio(root)
  await writeFile(join(root, 'mixed/notes/other.md'), '# Other\n\nWords.\n')
  await writeFile(join(root, 'mixed/intro.md'), '---\nsources: [Meeting]\n---\n\n# Intro\n\nSee [[Meeting]] and [Gone](missing.md).\n')
  await writeFile(join(root, 'mixed/_mixed_EVIDENCE-AND-NOTES.md'), evidenceText)
  const { ws, touched } = spied(new Workspace(root))
  const read = await readPlanForAgent(ws, built.dir, { summary: true })
  expect(read.parts.map(part => [part.title, part.evidenceCount])).toEqual([['Title page', 0], ['Intro', 2], ['Method', 1], ['Results', 0], ['Costs', 0]])
  // Source stats, fingerprints and quotation checks all resolve the source through absolute(); none happens.
  const sourceTouches = () => touched.filter(([name, path]) => name === 'absolute' && (path.includes('/notes/') || path.endsWith('missing.md')))
  expect(sourceTouches()).toEqual([])
  const context = await folioRoomContext(ws, built.dir, null)
  expect(context?.content).toContain('"title":"Intro"')
  expect(context?.content).toContain('"evidence":2,"flags":0')
  expect(context?.content).not.toContain('A quotation to check.')
  expect(sourceTouches()).toEqual([])
  // plan.read keeps the full merged count (attached, listed and cited) and does check the sources.
  expect((await readPlanForAgent(ws, built.dir)).parts.find(part => part.title === 'Intro')?.evidenceCount).toBe(3)
  expect(sourceTouches().length).toBeGreaterThan(0)
})

// S3-2 (r3 review): one source attached under two link spellings is one source in the summary, as in the room.
test('the summary counts a source attached as [[Meeting]] and as a file link once, matching the room', async () => {
  await mixedFolio(root)
  await writeFile(join(root, 'mixed/notes/other.md'), '# Other\n\nWords.\n')
  await writeFile(join(root, 'mixed/_mixed_EVIDENCE-AND-NOTES.md'), '## [[Intro]]\n\n### Evidence\n- [[Meeting]]\n- [meeting.md](notes/meeting.md)\n- [other.md](notes/other.md)\n')
  const ws = new Workspace(root)
  const count = await countAttachedEvidence(ws, 'mixed', ['Intro'])
  expect(count.counts.intro).toBe(2)
  const room = await readEvidence(ws, 'mixed')
  expect(room.parts.intro.rows.filter(row => row.origins.includes('attached here')).length).toBe(2)
})

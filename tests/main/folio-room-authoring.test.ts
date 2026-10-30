import { pinnedIndex } from '../helpers/folio-file-identity'
import { readLabelVocabulary } from '../../src/shared/folio-room'
import { spliceLabelVocabulary } from '../../src/shared/folio-labels'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { editPlanLine } from '../../src/shared/plan-line-edit'
import { parsePlanLine } from '../../src/shared/plan-line'
import { Workspace } from '../../src/main/workspace'
import { FolioWorkspace } from '../../src/main/folio-workspace'
import { readFolioPlan, setPartLine, setFolioLabels, removePlanParts } from '../../src/main/plan'
import { readFolioRoom } from '../../src/main/folio-room'
import { readPlanForAgent } from '../../src/main/plan-agent-reads'
import { folioRoomContext } from '../../src/main/folio-room-context'
import { prepareProposal, proposalBasis } from '../../src/main/plan-proposal'
import { writeRoomAuthoring } from '../../src/main/folio-room-authoring'
import { setCollectionPieceStatus } from '../../src/main/collection'
import { symlink, mkdir } from 'node:fs/promises'
import { mixedFolio, formsFolio, pangramFolio, manifestOnlyFolio, clashFolio } from '../fixtures/folio-room/folio-room-fixtures'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'wf-room-authoring-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

test('synopsis splice preserves aliases, indentation, marker, separator and unrelated tags', () => {
  const raw = '  7. [[Intro|Alias]] - Old words  #vignette #keep #priority-low  '
  expect(editPlanLine(raw, { gloss: 'New words' }, [])).toBe(raw.replace('Old words', 'New words'))
  expect(editPlanLine(raw, { gloss: null }, [])).toBe('  7. [[Intro|Alias]]  #vignette #keep #priority-low  ')
})
test('priority changes collapse recognised priorities and keep ordinary tags and listed labels', () => {
  const raw = '1. [[Intro]] — Synopsis #label-frame #priority-low #keep #priority-high #priority-later'
  const next = editPlanLine(raw, { priority: 'medium' }, ['frame'])
  expect(parsePlanLine(next)).toMatchObject({ gloss: 'Synopsis', tags: ['label-frame', 'keep', 'priority-later', 'priority-medium'] })
  expect(editPlanLine(raw, { label: null }, ['frame'])).toContain('#priority-low #keep #priority-high #priority-later')
})
test('synopsis refuses line breaks and trailing tags; no-op is byte identical', () => {
  const raw = '* [[Part|shown]] — Old #keep'
  expect(() => editPlanLine(raw, { gloss: 'a\nb' }, [])).toThrow()
  expect(() => editPlanLine(raw, { gloss: 'a #tag' }, [])).toThrow('A synopsis cannot end with a #tag.')
  expect(editPlanLine(raw, {}, [])).toBe(raw)
  expect(editPlanLine('- [[Part]] #keep', { gloss: 'New' }, [])).toBe('- [[Part]] — New #keep')
})
test('line writer preserves the surrounding Index Note bytes and refuses a stale card', async () => {
  const built = await formsFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), built.dir)
  const before = (await ws.readFile((await readFolioPlan(ws, built.dir))!.indexPath)).content
  const plan = (await readFolioPlan(ws, built.dir))!
  const part = plan.parts[0]
  const next = await setPartLine(ws, built.dir, 0, { gloss: 'Changed synopsis' }, part)
  const written = (await ws.readFile(plan.indexPath)).content
  expect(written.startsWith('\ufeff')).toBe(before.startsWith('\ufeff'))
  expect(written.split('\r\n').length).toBe(before.split('\r\n').length)
  expect(next.parts[0].gloss).toBe('Changed synopsis')
  const stable = written
  await expect(setPartLine(ws, built.dir, 0, { priority: 'high' }, part)).rejects.toThrow()
  expect((await ws.readFile(plan.indexPath)).content).toBe(stable)
})
test('line writer never changes the manifest and refuses a concurrent disk edit', async () => {
  const built = await pangramFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), built.dir)
  const plan = (await readFolioPlan(ws, built.dir))!
  const manifest = join(root, built.dir, '_report-structure.json')
  const before = await readFile(manifest, 'utf8')
  await setPartLine(ws, built.dir, 1, { priority: 'low' }, plan.parts[1])
  expect(await readFile(manifest, 'utf8')).toBe(before)
  const fresh = (await readFolioPlan(ws, built.dir))!
  const external = (await ws.readFile(plan.indexPath)).content + '\nOutside edit\n'
  await expect(setPartLine(ws, built.dir, 1, { gloss: 'Refuse' }, fresh.parts[1], {
    beforeIndexWrite: async () => { await writeFile(join(root, plan.indexPath), external) },
  })).rejects.toThrow()
  expect((await ws.readFile(plan.indexPath)).content).toBe(external)
})

test('label rename rewrites only listed tags and preserves an unlisted label tag', async () => {
  const built = await mixedFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), built.dir)
  const plan = (await readFolioPlan(ws, built.dir))!
  const before = (await ws.readFile(plan.indexPath)).content
  const next = await setFolioLabels(ws, built.dir, { op: 'rename', slug: 'frame', name: 'Framing' }, before)
  const text = (await ws.readFile(plan.indexPath)).content
  expect(text).toContain('#label-framing')
  expect(text).not.toContain('#label-frame ')
  expect(text).toContain('#label-unlisted')
  expect(next.parts[1].tags).toContain('label-framing')
  await expect(setFolioLabels(ws, built.dir, { op: 'add', name: 'Unlisted' }, text)).rejects.toThrow('ordinary tag')
  expect((await ws.readFile(plan.indexPath)).content).toBe(text)
})
test('bulk removal changes only selected lines and manifest entries; part files stay', async () => {
  const built = await pangramFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), built.dir)
  const plan = (await readFolioPlan(ws, built.dir))!
  const sources = await Promise.all(built.writtenPaths.map(async path => [path, (await ws.readFile(path)).content] as const))
  const next = await removePlanParts(ws, built.dir, [0, 1], plan.parts)
  expect(next.parts).toHaveLength(0)
  expect(next.unlisted.map(part => part.path)).toEqual(expect.arrayContaining(built.writtenPaths))
  const manifest = JSON.parse((await ws.readFile(built.dir + '/_report-structure.json')).content)
  expect(manifest.files).toHaveLength(0)
  for (const [path, content] of sources) expect((await ws.readFile(path)).content).toBe(content)
})

test('bulk Undo restores exact bytes and refuses to replace a later outside edit', async () => {
  const built = await pangramFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), built.dir)
  const plan = (await readFolioPlan(ws, built.dir))!
  const before = (await ws.readFile(plan.indexPath)).content
  const manifestBefore = (await ws.readFile(built.dir + '/_report-structure.json')).content
  const answer = await writeRoomAuthoring(ws, { op: 'remove', indices: [1], expected: plan.parts })
  expect(answer.ok).toBe(true)
  if (!answer.ok || !answer.token) throw new Error('Expected Undo token')
  expect(await writeRoomAuthoring(ws, { op: 'undo', token: answer.token })).toMatchObject({ ok: true })
  expect((await ws.readFile(plan.indexPath)).content).toBe(before)
  expect((await ws.readFile(built.dir + '/_report-structure.json')).content).toBe(manifestBefore)
  const edited = await writeRoomAuthoring(ws, { op: 'line', index: 0, expected: plan.parts[0], change: { priority: 'high' } })
  if (!edited.ok || !edited.token) throw new Error('Expected Undo token')
  const external = (await ws.readFile(plan.indexPath)).content + '\nAnother author.\n'
  await writeFile(join(root, plan.indexPath), external)
  expect(await writeRoomAuthoring(ws, { op: 'undo', token: edited.token })).toMatchObject({ ok: false })
  expect((await ws.readFile(plan.indexPath)).content).toBe(external)
})
test('Start gives idea status, rejects a stale card, and cleans its new file after manifest failure', async () => {
  const built = await mixedFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), built.dir)
  const plan = (await readFolioPlan(ws, built.dir))!
  const at = plan.parts.findIndex(part => part.path === null)
  const stale = { ...plan.parts[at], tags: ['outside'] }
  expect(await writeRoomAuthoring(ws, { op: 'start', index: at, expected: stale })).toMatchObject({ ok: false })
  const before = (await ws.listFiles()).map(file => file.path)
  const failing = new Proxy(ws, { get(target, key) {
    if (key === 'saveFileWithoutReadBack') return async (path: string, ...args: any[]) => {
      if (path.endsWith('/_report-structure.json')) throw new Error('Synthetic write failure')
      return (target.saveFileWithoutReadBack as any)(path, ...args)
    }
    return Reflect.get(target, key)
  } })
  const failed = await writeRoomAuthoring(failing, { op: 'start', index: at, expected: plan.parts[at] })
  expect(failed).toMatchObject({ ok: false })
  expect((await ws.listFiles()).map(file => file.path)).toEqual(before)
  const made = await writeRoomAuthoring(ws, { op: 'start', index: at, expected: plan.parts[at] })
  expect(made.ok).toBe(true)
  if (!made.ok || !made.path) throw new Error('No started file')
  expect((await ws.readFile(made.path)).content).toContain('status: idea')
})
test('status uses the Board serialiser and the Folio pin refuses an escaping file', async () => {
  const built = await mixedFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), built.dir)
  const plan = (await readFolioPlan(ws, built.dir))!
  const at = plan.parts.findIndex(part => part.path !== null)
  const part = plan.parts[at]
  const saved = await writeRoomAuthoring(ws, { op: 'status', index: at, expected: part, status: 'editing' })
  expect(saved.ok).toBe(true)
  const after = (await ws.readFile(part.path!)).content
  await setCollectionPieceStatus(ws, built.dir, part.path!, 'editing')
  expect((await ws.readFile(part.path!)).content).toBe(after)
  await mkdir(join(root, 'outside'))
  await writeFile(join(root, 'outside', 'part.md'), '# Outside\n')
  await symlink(join(root, 'outside'), join(root, built.dir, 'escape'))
  await expect(setCollectionPieceStatus(ws, built.dir, built.dir + '/escape/part.md', 'editing')).rejects.toThrow()
  expect(await readFile(join(root, 'outside', 'part.md'), 'utf8')).toBe('# Outside\n')
})

test('Undo never treats an external manifest edit during a line write as its own', async () => {
  const built = await pangramFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), built.dir)
  const plan = (await readFolioPlan(ws, built.dir))!
  const path = built.dir + '/_report-structure.json'
  const before = (await ws.readFile(path)).content
  const external = before.replace('"schema_version": 1', '"owner_added": "keep", "schema_version": 1')
  const answer = await writeRoomAuthoring(ws, { op: 'line', index: 0, expected: plan.parts[0], change: { priority: 'high' } }, {
    beforeIndexWrite: async () => { await writeFile(join(root, path), external) },
  })
  expect(answer.ok).toBe(true)
  if (!answer.ok || !answer.token) throw new Error('No Undo token')
  await writeRoomAuthoring(ws, { op: 'undo', token: answer.token })
  expect((await ws.readFile(path)).content).toBe(external)
})
test('manifest-only bulk removal keeps the Index Note absent, including through Undo', async () => {
  const built = await manifestOnlyFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), built.dir)
  const plan = (await readFolioPlan(ws, built.dir))!
  const before = (await ws.readFile(built.dir + '/_report-structure.json')).content
  const answer = await writeRoomAuthoring(ws, { op: 'remove', indices: [0], expected: plan.parts })
  expect(answer.ok).toBe(true)
  expect(await Bun.file(join(root, plan.indexPath)).exists()).toBe(false)
  if (!answer.ok || !answer.token) throw new Error('No Undo token')
  expect(await writeRoomAuthoring(ws, { op: 'undo', token: answer.token })).toMatchObject({ ok: true })
  expect((await ws.readFile(built.dir + '/_report-structure.json')).content).toBe(before)
  expect(await Bun.file(join(root, plan.indexPath)).exists()).toBe(false)
})
test('a title clash blocks bulk removal without changing either outline or documents', async () => {
  const built = await clashFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), built.dir)
  const plan = (await readFolioPlan(ws, built.dir))!
  const before = (await ws.readFile(plan.indexPath)).content
  expect(await writeRoomAuthoring(ws, { op: 'remove', indices: [0], expected: plan.parts })).toMatchObject({ ok: false })
  expect((await ws.readFile(plan.indexPath)).content).toBe(before)
})
test('label editing preserves unrelated nested YAML and a block list with its comments', async () => {
  const built = await mixedFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), built.dir)
  const plan = (await readFolioPlan(ws, built.dir))!
  const before = (await ws.readFile(plan.indexPath)).content.replace('  - Frame', '  - Frame # owner comment').replace('labels:', 'nested:\n  owner: keep\nlabels:')
  await writeFile(join(root, plan.indexPath), before)
  await setFolioLabels(ws, built.dir, { op: 'add', name: 'New' }, before)
  const after = (await ws.readFile(plan.indexPath)).content
  expect(after).toContain('nested:\n  owner: keep\nlabels:\n  - Frame # owner comment\n  - Findings\n  - "New"')
  expect(after.split('## Running order')[1]).toBe(pinnedIndex(before.split('## Running order')[1], {"Title page":"./title-page.md|Title page","Intro":"./intro.md|Intro","Method":"./method.md|Method","Costs":"./costs.md|Costs"}))
})

test('closed-part flag clear keeps words and refuses a stale scan without a checkpoint', async () => {
  const built = await pangramFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), built.dir)
  const path = built.writtenPaths[0]
  const original = (await ws.readFile(path)).content
  await writeFile(join(root, path), original + '\nA ==claim==<!--flag:check-fact--> here.\n')
  const room = (await readFolioRoom(ws, built.dir))!
  const part = room.parts.find(part => part.key.path === path)!
  const flag = part.flags[0]
  await writeFile(join(root, path), original + '\nAn outside change.\nA ==claim==<!--flag:check-fact--> here.\n')
  let checkpoints = 0
  expect(await writeRoomAuthoring(ws, { op: 'clearFlag', index: part.index, expected: part.card, from: flag.from, fingerprint: flag.fingerprint }, { beforeIndexWrite: async () => { checkpoints += 1 } })).toMatchObject({ ok: false })
  expect(checkpoints).toBe(0)
  const fresh = (await readFolioRoom(ws, built.dir))!.parts.find(part => part.key.path === path)!
  const changed = fresh.flags[0]
  expect(await writeRoomAuthoring(ws, { op: 'clearFlag', index: fresh.index, expected: fresh.card, from: changed.from, fingerprint: changed.fingerprint })).toMatchObject({ ok: true })
  expect((await ws.readFile(path)).content).toContain('A claim here.')
  expect((await ws.readFile(path)).content).toContain('An outside change.')
})
test('agent/CLI read fields agree with the room and the per-turn context is a compact summary without notes, quotations or AGENTS.md text', async () => {
  const built = await mixedFolio(root)
  const ws = new Workspace(root)
  await writeFile(join(root, built.dir, 'AGENTS.md'), 'Use the author’s terminology.\n')
  await writeFile(join(root, built.dir, '_mixed_EVIDENCE-AND-NOTES.md'), '## [[Intro]]\n\n### Evidence\n- [meeting.md](notes/meeting.md)\n  - “Private quotation words.”\n\n### Notes\nPrivate notes text.\n')
  const room = (await readFolioRoom(ws, built.dir))!
  const read = await readPlanForAgent(ws, built.dir)
  expect(read.parts.map(part => [part.synopsis, part.label, part.priority, part.status, part.openFlags])).toEqual(room.parts.map(part => [part.synopsis, part.label, part.priority, part.status, part.flags.map(({ path, fingerprint, ...flag }) => flag)]))
  expect(read.parts.map(part=>part.evidenceCount)).toEqual(room.parts.map(part=>room.evidence?.parts[part.title.toLowerCase()]?.rows.length??0))
  const context = await folioRoomContext(ws, built.dir, null)
  expect(context?.content).toContain(`author instructions at ${built.dir}/AGENTS.md`)
  expect(context?.content).not.toContain('Use the author’s terminology.')
  expect(context?.content).not.toContain('Private notes text.')
  expect(context?.content).not.toContain('Private quotation words.')
  expect(context?.content).toContain('The Index Note running order is the order of record.')
  expect(context?.content).toContain('"title":"Mixed"')
  expect(context?.content).toContain('{"title":"Intro","status":"in progress","priority":"high","label":"Frame","words":')
  expect(context?.content).toContain('"evidence":1,"flags":0')
  expect(context?.transcript).toBe('hidden')
  await rm(join(root, built.dir, 'AGENTS.md'))
  expect((await folioRoomContext(ws, built.dir, null))?.content).toContain(`No Folio-specific instructions file was found at ${built.dir}/AGENTS.md.`)
})

test('inline label conversion preserves comments and blank lines that document the next field', () => {
  const source = '---\nlabels: [One, Two]\n\n# This documents the next field\nforeign:\n  key: keep\n---\nBody\n'
  const next = spliceLabelVocabulary(source, ['One', 'Two', 'Three'], { op: 'add', name: 'Three' })
  expect(next).toContain('  - "Three"\n\n# This documents the next field\nforeign:\n  key: keep')
})

test('the real label writer preserves inline quoted names with commas and escaped characters', async () => {
  const built = await mixedFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), built.dir)
  const plan = (await readFolioPlan(ws, built.dir))!
  const before = (await ws.readFile(plan.indexPath)).content.replace('labels:\n  - Frame\n  - Findings', 'labels: ["Theory, method", Results]')
  await writeFile(join(root, plan.indexPath), before)
  const answer = await writeRoomAuthoring(ws, { op: 'labels', basis: before, change: { op: 'add', name: 'Discussion' } })
  expect(answer.ok).toBe(true)
  const room = (await readFolioRoom(ws, built.dir))!
  expect(room.labels.map(label => label.name)).toEqual(['Theory, method', 'Results', 'Discussion'])
})


test('plain apostrophes and quote characters survive both vocabulary reads and the real label writer', async () => {
  const built = await mixedFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), built.dir)
  const plan = (await readFolioPlan(ws, built.dir))!
  const before = (await ws.readFile(plan.indexPath)).content.replace('labels:\n  - Frame\n  - Findings', `labels: [Writer's voice, A "quoted" name, Results]`)
  expect(readLabelVocabulary(before).labels.map(label => label.name)).toEqual(["Writer's voice", 'A "quoted" name', 'Results'])
  await writeFile(join(root, plan.indexPath), before)
  expect((await writeRoomAuthoring(ws, { op: 'labels', basis: before, change: { op: 'add', name: 'Discussion' } })).ok).toBe(true)
  expect((await readFolioRoom(ws, built.dir))!.labels.map(label => label.name)).toEqual(["Writer's voice", 'A "quoted" name', 'Results', 'Discussion'])
})

for (const value of ["[Theory: method, Results]", "['Theory' junk 'method', Results]", '[One,, Results]', '[!custom Theory, Results]', '[*alias, Results]', '[&anchor Theory, Results]']) {
  test(`unsupported inline labels refuse a real write and retain exact source: ${value}`, async () => {
    const built = await mixedFolio(root)
    const ws = new FolioWorkspace(new Workspace(root), built.dir)
    const plan = (await readFolioPlan(ws, built.dir))!
    const before = (await ws.readFile(plan.indexPath)).content.replace('labels:\n  - Frame\n  - Findings', `labels: ${value}`)
    await writeFile(join(root, plan.indexPath), before)
    const answer = await writeRoomAuthoring(ws, { op: 'labels', basis: before, change: { op: 'add', name: 'Discussion' } })
    expect(answer.ok).toBe(false)
    expect((await ws.readFile(plan.indexPath)).content).toBe(before)
  })
}


test('plain quotes do not hide a trailing YAML comment during an actual label edit', async () => {
  const built = await mixedFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), built.dir)
  const plan = (await readFolioPlan(ws, built.dir))!
  const before = (await ws.readFile(plan.indexPath)).content.replace('labels:\n  - Frame\n  - Findings', 'labels: [A "quote, Results] # retain')
  expect(readLabelVocabulary(before).labels.map(label => label.name)).toEqual(['A "quote', 'Results'])
  await writeFile(join(root, plan.indexPath), before)
  expect((await writeRoomAuthoring(ws, { op: 'labels', basis: before, change: { op: 'add', name: 'Discussion' } })).ok).toBe(true)
  expect((await ws.readFile(plan.indexPath)).content).toContain('labels: # retain')
  expect((await readFolioRoom(ws, built.dir))!.labels.map(label => label.name)).toEqual(['A "quote', 'Results', 'Discussion'])
})

test('a hash in a plain scalar starts a comment and cannot be hidden by an embedded quote', async () => {
  const built = await mixedFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), built.dir)
  const plan = (await readFolioPlan(ws, built.dir))!
  const before = (await ws.readFile(plan.indexPath)).content.replace('labels:\n  - Frame\n  - Findings', 'labels: [A "quoted # name", Results]')
  await writeFile(join(root, plan.indexPath), before)
  expect((await writeRoomAuthoring(ws, { op: 'labels', basis: before, change: { op: 'add', name: 'Discussion' } })).ok).toBe(false)
  expect((await ws.readFile(plan.indexPath)).content).toBe(before)
})

test('a manifest with no Index Note yet: plan.read and proposals read as before ticket 29 (no parts, files as strays)', async () => {
  const built = await manifestOnlyFolio(root)
  const ws = new Workspace(root)
  const read = await readPlanForAgent(ws, built.dir)
  expect({ hasIndexNote: read.hasIndexNote, indexPath: read.indexPath, parts: read.parts }).toEqual({ hasIndexNote: false, indexPath: null, parts: [] })
  expect(read.strays.map(stray => stray.path)).toEqual(built.writtenPaths)
  const basis = await proposalBasis(ws, built.dir)
  expect(basis.parts).toEqual([])
  const prepared = await prepareProposal(ws, { dir: built.dir, changes: [{ op: 'adopt', path: built.writtenPaths[1] }] })
  expect(prepared.proposed.rows.map(row => row.path)).toEqual([built.writtenPaths[1]])
  expect(prepared.ops.map(op => op.op)).toContain('createIndexNote')
})

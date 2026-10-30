import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MANIFEST_NAME } from '../../src/main/folio'
import { Workspace } from '../../src/main/workspace'
import { FolioWorkspace } from '../../src/main/folio-workspace'
import { mixedFolio, clashFolio, indexOnlyFolio } from '../fixtures/folio-room/folio-room-fixtures'
import { writeEvidence, undoEvidence, evidencePath, readEvidence, attachEvidence } from '../../src/main/folio-evidence'
import { applyEvidenceOps, EVIDENCE_OPEN_FENCE, evidenceKey, parseEvidence } from '../../src/shared/folio-evidence'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'wf-evidence-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const attach = { kind: 'item' as const, part: 'Results', key: evidenceKey('notes/meeting.md'), expect: null, value: '- [meeting.md](notes/meeting.md)\n' }

test('first attach exclusively creates support file, never an Index or manifest, and Undo restores exactly that or refuses', async () => {
  await mixedFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), 'mixed')
  const manifest = await readFile(join(root, 'mixed', MANIFEST_NAME), 'utf8').catch(() => null)
  let checkpoints = 0
  const answer = await writeEvidence(ws, [attach], { session: 'first', beforeWrite: async () => { checkpoints++ } })
  expect(answer.ok).toBe(true)
  const text = await readFile(join(root, evidencePath(ws)), 'utf8')
  expect(text).toContain('<!--wf:sha1-16=')
  // S7-1 (r7): text added since at the end of the appended section (a blank line, then a section of its own) would be
  // carried along by the restore. Refused byte-identically, token kept.
  const file = join(root, evidencePath(ws))
  for (const added of ['\n## [[Another]]\nKeep outside work.\n', 'Hand prose for Results.\n']) {
    await writeFile(file, text + added)
    expect(await undoEvidence(ws, answer.token!, { session: 'first' })).toMatchObject({ ok: false, message: 'The evidence or notes changed elsewhere. Your edit was not applied.' })
    expect(await readFile(file, 'utf8')).toBe(text + added)
  }
  // A section added after it, the section itself untouched: the Undo takes back exactly the lead and the section.
  await writeFile(file, text + '## [[Another]]\nKeep outside work.\n')
  expect((await undoEvidence(ws, answer.token!, { session: 'first' })).message).toBe('Undone. Other evidence and notes were kept.')
  expect(await readFile(file, 'utf8')).toBe('## [[Another]]\nKeep outside work.\n')
  expect(await readFile(join(root, 'mixed', MANIFEST_NAME), 'utf8').catch(() => null)).toBe(manifest)
  expect(checkpoints).toBe(1)
})

test('a checkpoint race rebases disjoint ops and reports a same-notes conflict with both versions', async () => {
  await mixedFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), 'mixed')
  const before = 'Lead\n\n## [[Results]]\n\n### Notes\nOld.\n'
  await writeFile(join(root, evidencePath(ws)), before)
  const answer = await writeEvidence(ws, [attach, { kind: 'notes', part: 'Results', expect: 'Old.\n', value: 'Mine.\n' }], {
    session: 'race', beforeWrite: async () => { await writeFile(join(root, evidencePath(ws)), before.replace('Old.', 'External.')) },
  })
  expect(answer.ok).toBe(true)
  expect(answer.conflicts).toEqual([{ part: 'Results', ours: 'Mine.\n', theirs: 'External.\n' }])
  const text = await readFile(join(root, evidencePath(ws)), 'utf8')
  expect(text).toContain('External.')
  expect(text).toContain('[meeting.md]')
  expect(text).not.toContain('Mine.')
})

test('a same-subtree external highlight prevents detach and the writer refuses headings or title clashes', async () => {
  await mixedFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), 'mixed')
  const answer = await writeEvidence(ws, [attach], { session: 'attach' })
  expect(answer.ok).toBe(true)
  const before = await readFile(join(root, evidencePath(ws)), 'utf8')
  const item = parseEvidence(before).sections[0].items[0]
  await writeFile(join(root, evidencePath(ws)), before + '  - “Added elsewhere.”\n')
  const detach = await writeEvidence(ws, [{ kind: 'item', part: 'Results', key: item.key, expect: item.raw, value: null }], { session: 'detach' })
  expect(detach.ok).toBe(false)
  expect((await writeEvidence(ws, [{ kind: 'notes', part: 'Results', expect: null, value: '# Heading\n' }], { session: 'notes' })).ok).toBe(false)
  await clashFolio(root)
  const clash = new FolioWorkspace(new Workspace(root), 'clash')
  expect((await writeEvidence(clash, [{ ...attach, part: 'Results' }], { session: 'clash' })).ok).toBe(false)
})


test('merged sources deduplicate by resolved path and duplicate notes remain separately editable', async () => {
  await mixedFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), 'mixed')
  await writeFile(join(root, 'mixed/intro.md'), '---\nsources: [Meeting]\n---\n\n# Intro\n\nSee [[Meeting]].\n')
  await writeFile(join(root, evidencePath(ws)), '## [[Intro]]\n\n### Evidence\n- [meeting.md](notes/meeting.md)\n\n### Notes\nFirst notes.\n\n## [[Intro]]\n\n### Notes\nSecond notes.\n\n## [[Removed part]]\n\n### Notes\nKeep orphan notes.\n')
  const read = await readEvidence(ws, 'mixed')
  expect(read.parts.intro.rows).toHaveLength(1)
  expect(read.parts.intro.rows[0].origins).toEqual(['attached here', 'listed in the part’s sources', 'cited in the text'])
  expect(read.parts.intro.notes).toBe('First notes.')
  expect(read.parts.intro.additionalNotes).toEqual(['Second notes.'])
  expect(read.orphans).toEqual([{ title: 'Removed part', notes: 'Keep orphan notes.' }])
})


test('all highlights from duplicate evidence sections are checked against the source', async () => {
  await mixedFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), 'mixed')
  await writeFile(join(root, evidencePath(ws)), '## [[Intro]]\n### Evidence\n- [meeting.md](notes/meeting.md)\n\n## [[Intro]]\n### Evidence\n- [meeting.md](notes/meeting.md)\n  - “A quote no longer present.”\n')
  const rows = (await readEvidence(ws, 'mixed')).parts.intro.rows
  expect(rows).toHaveLength(1)
  expect(rows[0].highlights[0].state).toBe('not in the file any more')
})

test('a missing target cited only in text is missing, rather than ready', async () => {
  await mixedFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), 'mixed')
  await writeFile(join(root, 'mixed/intro.md'), '# Intro\n\n[Gone](missing.md)\n')
  const row = (await readEvidence(ws, 'mixed')).parts.intro.rows[0]
  expect(row.origins).toEqual(['cited in the text'])
  expect(row.state).toBe('missing')
})

// S-B1 (r1 review): a write never lands in another part's section and never guesses past an unclosed code fence.
const fenced = 'Lead\n\n## [[Intro]]\n\n### Notes\nIntro notes I wrote.\n```\nunclosed code\n\n## [[Method]]\n\n### Notes\nMethod notes I wrote.\n'
test('notes that would leave a code fence open are refused and the file stays byte-identical', async () => {
  await mixedFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), 'mixed')
  const before = 'Lead\n\n## [[Intro]]\n\n### Notes\nIntro notes.\n\n## [[Method]]\n\n### Notes\nMethod notes.\n'
  await writeFile(join(root, evidencePath(ws)), before)
  for (const value of ['Intro notes.\n```python\nprint(1)\n\n', 'Intro notes.\n~~~\nopen\n\n']) {
    const answer = await writeEvidence(ws, [{ kind: 'notes', part: 'Intro', expect: 'Intro notes.\n\n', value }], { session: 'fence' })
    expect(answer.ok).toBe(false)
    expect(answer.message).toContain('never close it')
    expect(await readFile(join(root, evidencePath(ws)), 'utf8')).toBe(before)
  }
  expect((await writeEvidence(ws, [{ kind: 'notes', part: 'Intro', expect: 'Intro notes.\n\n', value: '## [[Method]]\n\n' }], { session: 'fence' })).ok).toBe(false)
  // A closed fence is ordinary notes, and the next part's notes still go to that part.
  expect((await writeEvidence(ws, [{ kind: 'notes', part: 'Intro', expect: 'Intro notes.\n\n', value: '```python\nprint(1)\n```\n\n' }], { session: 'fence' })).ok).toBe(true)
  expect((await writeEvidence(ws, [{ kind: 'notes', part: 'Method', expect: 'Method notes.\n', value: 'Method again.\n' }], { session: 'fence' })).ok).toBe(true)
  const sections = parseEvidence(await readFile(join(root, evidencePath(ws)), 'utf8')).sections
  expect(sections.map(section => [section.title, section.notes?.raw])).toEqual([['Intro', '```python\nprint(1)\n```\n\n'], ['Method', 'Method again.\n']])
})

test('the reviewer probe: a file left with an open fence by another app refuses notes, item and attach writes byte-identically', async () => {
  await mixedFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), 'mixed')
  await writeFile(join(root, evidencePath(ws)), fenced)
  const notes = await writeEvidence(ws, [{ kind: 'notes', part: 'Method', expect: null, value: 'Overwrite.\n\n' }], { session: 'probe' })
  expect(notes).toMatchObject({ ok: false, message: EVIDENCE_OPEN_FENCE })
  const item = await writeEvidence(ws, [{ ...attach, part: 'Method' }], { session: 'probe' })
  expect(item).toMatchObject({ ok: false, message: EVIDENCE_OPEN_FENCE })
  const attached = await attachEvidence(ws, 'Method', { kind: 'file', path: 'mixed/notes/meeting.md' }, { session: 'probe' })
  expect(attached).toMatchObject({ ok: false, message: EVIDENCE_OPEN_FENCE })
  expect(await readFile(join(root, evidencePath(ws)), 'utf8')).toBe(fenced)
})

test('the writer refuses a section it appended but cannot find by title, rather than writing into the last one', () => {
  expect(() => applyEvidenceOps(fenced, [{ kind: 'notes', part: 'Method', expect: null, value: 'Overwrite.\n\n' }])).toThrow(EVIDENCE_OPEN_FENCE)
  expect(applyEvidenceOps('Lead\n\n## [[Intro]]\n\n### Notes\nKeep.\n', [{ kind: 'notes', part: 'Method', expect: null, value: 'New.\n' }]).source)
    .toBe('Lead\n\n## [[Intro]]\n\n### Notes\nKeep.\n\n## [[Method]]\n\n### Notes\nNew.\n')
  // No fence open, but a title whose heading could not parse back: refused, so the last section (Intro) never takes the
  // write. (Only an open fence hides a heading, and that is refused first; the find-by-title check is the second line.)
  for (const op of [{ kind: 'notes' as const, part: 'Odd ] title', expect: null, value: 'New.\n' }, { ...attach, part: 'Odd ] title' }])
    expect(() => applyEvidenceOps('Lead\n\n## [[Intro]]\n\n### Notes\nKeep.\n', [op])).toThrow('That part title cannot be used for evidence.')
})

test('notes sent without a trailing line break still leave the next part its own section', async () => {
  await mixedFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), 'mixed')
  await writeFile(join(root, evidencePath(ws)), 'Lead\n\n## [[Intro]]\n\n### Notes\nOld.\n\n## [[Method]]\n\n### Evidence\n- [meeting.md](notes/meeting.md)\n\n## [[Costs]]\n\n### Notes\nCosts.\n')
  expect((await writeEvidence(ws, [{ kind: 'notes', part: 'Intro', expect: 'Old.\n\n', value: 'no newline' }], { session: 'eol' })).ok).toBe(true)
  expect((await writeEvidence(ws, [{ kind: 'notes', part: 'Method', expect: null, value: 'also none' }], { session: 'eol' })).ok).toBe(true)
  const sections = parseEvidence(await readFile(join(root, evidencePath(ws)), 'utf8')).sections
  expect(sections.map(section => [section.title, section.notes?.raw ?? null, section.items.length])).toEqual([['Intro', 'no newline\n\n', 0], ['Method', 'also none\n\n', 1], ['Costs', 'Costs.\n', 0]])
})

// Undo restores everything its save changed or nothing: one change made elsewhere since refuses the whole Undo.
test('an evidence Undo with one of its changes made elsewhere since refuses whole and writes nothing', async () => {
  await mixedFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), 'mixed')
  await writeFile(join(root, evidencePath(ws)), 'Lead\n\n## [[Results]]\n\n### Notes\nOld.\n')
  const answer = await writeEvidence(ws, [attach, { kind: 'notes', part: 'Results', expect: 'Old.\n', value: 'Mine.\n' }], { session: 'partial' })
  expect(answer.ok).toBe(true)
  const text = await readFile(join(root, evidencePath(ws)), 'utf8')
  const changed = text.replace('Mine.', 'Changed elsewhere.')
  await writeFile(join(root, evidencePath(ws)), changed)
  const undone = await undoEvidence(ws, answer.token!, { session: 'partial' })
  expect(undone).toMatchObject({ ok: false, token: null, message: 'The evidence or notes changed elsewhere. Your edit was not applied.' })
  expect(await readFile(join(root, evidencePath(ws)), 'utf8')).toBe(changed)
  // The token is kept: with the other change put back, the Undo runs whole.
  await writeFile(join(root, evidencePath(ws)), text)
  expect((await undoEvidence(ws, answer.token!, { session: 'partial' })).message).toBe('Undone. Other evidence and notes were kept.')
  expect(await readFile(join(root, evidencePath(ws)), 'utf8')).toBe('Lead\n\n## [[Results]]\n\n### Notes\nOld.\n')
})

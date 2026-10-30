/**
 * Command line and skill, ticket 06. Seam: the inbox validator, `proposeOutsideChange`
 * (request -> the Change it would be, or the reason it cannot be one). It writes nothing.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { declaredSource, MAX_NEW_TEXT_BYTES, MAX_TARGET_BYTES, MAX_WHOLE_DOCUMENT_BYTES, OUTSIDE_AUTHORS } from '../../src/main/cli/review-format'
import { CommandLineWorkspace } from '../../src/main/cli/guarded-workspace'
import { intendedForRecord, proposeOutsideChange, unplaceableIn, type OutsideProposal } from '../../src/main/outside-change'
import { YORK, writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'

let fx: WriteFixture
let ws: CommandLineWorkspace
beforeEach(async () => {
  fx = await writeFixture()
  ws = new CommandLineWorkspace(fx.root)
})
afterEach(async () => { await fx.dispose() })

const reason = (proposal: OutsideProposal): string => (proposal.ok ? '' : proposal.reason)
const propose = (operation: string, args: Record<string, unknown>): Promise<OutsideProposal> => proposeOutsideChange(ws, operation, args)

test('a replacement whose target occurs once is one content Change over exactly that text, and nothing is written', async () => {
  const before = await fx.snapshot({ journal: true })
  const proposal = await propose('replace', { path: 'talks/york.md', target: 'Intro about assessment.', with: 'A sharper opening.', note: '  Tighten\nthe intro  ' })
  expect(proposal).toEqual({ ok: true, path: 'talks/york.md', changes: [{
    path: 'talks/york.md', editClass: 'content', category: 'other', summary: 'Tighten the intro',
    oldText: 'Intro about assessment.', newText: 'A sharper opening.', anchor: { from: YORK.indexOf('Intro'), to: YORK.indexOf('Intro') + 'Intro about assessment.'.length },
  }] })
  expect(await fx.snapshot({ journal: true })).toEqual(before)
})

test('an empty target, a target found nowhere, and a target found twice are each refused with the reason', async () => {
  await fx.write('twice.md', 'same words\n\nsame words\n')
  expect(reason(await propose('replace', { path: 'talks/york.md', target: '', with: 'x' }))).toContain('is empty')
  expect(reason(await propose('replace', { path: 'talks/york.md', with: 'x' }))).toContain('is missing')
  expect(reason(await propose('replace', { path: 'talks/york.md', target: 'not in the file', with: 'x' }))).toContain('was not found')
  expect(reason(await propose('replace', { path: 'twice.md', target: 'same words', with: 'x' }))).toContain('more than once')
  expect(reason(await propose('replace', { path: 'talks/york.md', target: 'York', with: 'York' }))).toContain('nothing to change')
  // A target is text, never a pattern: a regular expression that would match is not found.
  expect(reason(await propose('replace', { path: 'talks/york.md', target: 'Intro .* assessment\\.', with: 'x' }))).toContain('was not found')
})

test('a path under a dot-folder, in the app\'s stores, outside the Collection, through a link, missing or not Markdown is refused', async () => {
  await fx.write('.hidden/a.md', 'secret\n')
  await symlink(join(fx.root, '.writeflex'), join(fx.root, 'stores'))
  await mkdir(join(fx.root, 'folder.md'))
  await writeFile(join(fx.root, 'plain.txt'), 'text\n')
  const refused = async (path: unknown): Promise<string> => reason(await propose('replace', { path, target: 'secret', with: 'x' }))
  expect(await refused('.hidden/a.md')).toContain('dot-folder')
  expect(await refused('.writeflex/changes.jsonl')).toContain('dot-folder')
  expect(await refused('.bridle/journal.jsonl')).toContain('dot-folder')
  expect(await refused('stores/changes.jsonl')).toContain('dot-folder')
  expect(await refused('../elsewhere.md')).toContain('outside the Collection')
  expect(await refused(join(fx.root, 'talks/york.md'))).toContain('not a path inside the Collection')
  expect(await refused('talks/gone.md')).toContain('does not exist')
  expect(await refused('folder.md')).toContain('is a folder')
  expect(await refused('plain.txt')).toContain('not a Markdown document')
  expect(await refused('')).toContain('is missing')
  expect(await refused(7)).toContain('is missing')
  expect(await refused('a\0b.md')).toContain('not a usable path')
})

test('an oversized field is refused, and a refused request\'s text is kept cut to a length', async () => {
  const big = 'x'.repeat(MAX_NEW_TEXT_BYTES + 1)
  const refused = await propose('replace', { path: 'talks/york.md', target: 'Intro about assessment.', with: big })
  expect(reason(refused)).toContain(`the limit is ${MAX_NEW_TEXT_BYTES}`)
  expect(reason(await propose('replace', { path: 'talks/york.md', target: 'y'.repeat(MAX_TARGET_BYTES + 1), with: '' }))).toContain(`the limit is ${MAX_TARGET_BYTES}`)
  expect(reason(await propose('insert', { path: 'talks/york.md', text: big }))).toContain('the limit is')
  expect(reason(await propose('replace', { path: 'talks/york.md', target: 4, with: 'x' }))).toContain('must be text')
  if (refused.ok) throw new Error('expected a refusal')
  const kept = intendedForRecord(refused.intended)
  expect(kept).toEqual({ oldText: 'Intro about assessment.', newText: 'x'.repeat(2000), cut: true })
})

test('an insert is carried as its anchor text, and a move\'s positions are found from text at the time of asking', async () => {
  await fx.write('m.md', 'One.\n\nTwo.\n\nThree.\n')
  expect(await propose('insert', { path: 'm.md', text: 'New.', after: 'Two.' })).toMatchObject({ ok: true, changes: [{ editClass: 'insert', oldText: '', newText: 'New.', insertAfter: 'Two.' }] })
  expect(await propose('insert', { path: 'm.md', text: 'Last.' })).toMatchObject({ ok: true, changes: [{ editClass: 'insert', insertAfter: '' }] })
  expect(reason(await propose('insert', { path: 'm.md', text: 'New.', after: 'Four.' }))).toContain('not found')
  expect(reason(await propose('insert', { path: 'm.md', text: '' }))).toContain('is empty')
  const move = await propose('move-text', { path: 'm.md', text: 'One.', after: 'Three.', moveFrom: { from: 0, to: 99 } })
  expect(move).toMatchObject({ ok: true, changes: [{ editClass: 'move', oldText: 'One.', newText: 'One.', moveFrom: { from: 0, to: 4 }, moveTo: { from: 18, to: 18 }, outsideMoveAfter: 'Three.' }] })
  // The same request against a document that has changed gets the positions of the document as it is now.
  await fx.write('m.md', 'Zero.\n\nOne.\n\nTwo.\n\nThree.\n')
  expect(await propose('move-text', { path: 'm.md', text: 'One.', after: 'Three.' })).toMatchObject({ ok: true, changes: [{ moveFrom: { from: 7, to: 11 }, moveTo: { from: 25, to: 25 } }] })
  expect(reason(await propose('move-text', { path: 'm.md', text: 'One.', after: 'One.' }))).toContain('overlap')
  expect(reason(await propose('move-text', { path: 'm.md', text: 'One.' }))).toContain('is missing')
})

test('frontmatter, status, a tick, an object and a source are each one Change the accept path can replay', async () => {
  // A change to the metadata only is the WHOLE old frontmatter block and the whole new one, marked
  // `frontmatter`: never the writing below (placed only while the block is exactly as proposed).
  const set = await propose('set-frontmatter', { path: 'talks/york.md', key: 'audience', value: 'teachers' })
  const block = YORK.slice(0, YORK.indexOf('---\n', 4) + 4)
  expect(set).toEqual({ ok: true, path: 'talks/york.md', changes: [{
    path: 'talks/york.md', editClass: 'content', category: 'other', summary: 'Set audience in the frontmatter of talks/york.md',
    oldText: block, newText: block.replace('status: draft\n', 'status: draft\naudience: teachers\n'), anchor: { from: 0, to: block.length }, frontmatter: true,
  }] })
  expect(reason(await propose('set-frontmatter', { path: 'talks/york.md', key: 'bad key: x', value: 'v' }))).toContain('plain name')
  expect(reason(await propose('set-frontmatter', { path: 'talks/york.md', key: 'k', value: 'a\nb: c' }))).toContain('one line')

  const status = await propose('set-status', { path: 'talks/york.md', status: 'editing' })
  expect(status).toMatchObject({ ok: true, changes: [{ oldText: block, newText: block.replace('status: draft\n', 'status: editing\n'), frontmatter: true }] })
  if (status.ok) expect(status.changes[0]).not.toHaveProperty('whole')
  expect(reason(await propose('set-status', { path: 'talks/york.md', status: 'draft' }))).toContain('already has the status')
  expect(reason(await propose('set-status', { path: 'talks/york.md', status: 'a\nb' }))).toContain('Invalid Collection status')

  await fx.write('tasks.md', '# Tasks\n\n- [ ] first\n- [x] second\n- [ ] same\n- [ ] same\n')
  expect(await propose('tick', { path: 'tasks.md', line: 3 })).toMatchObject({ ok: true, changes: [{ oldText: '- [ ] first', newText: '- [x] first', summary: 'Tick “first”' }] })
  expect(await propose('tick', { path: 'tasks.md', line: 4, untick: true })).toMatchObject({ ok: true, changes: [{ oldText: '- [x] second', newText: '- [ ] second' }] })
  expect(reason(await propose('tick', { path: 'tasks.md', line: 4 }))).toContain('already ticked')
  expect(reason(await propose('tick', { path: 'tasks.md', line: 5 }))).toContain('reads the same as another line')
  expect(reason(await propose('tick', { path: 'tasks.md', line: 1 }))).toContain('no checkbox')
  expect(reason(await propose('tick', { path: 'tasks.md', line: '3' }))).toContain('whole number')

  expect(await propose('insert-object', { path: 'talks/york.md', kind: 'table', content: '| A | B |\n| --- | --- |\n| 1 | 2 |', after: 'Intro about assessment.' })).toMatchObject({ ok: true, changes: [{ editClass: 'insert', insertAfter: 'Intro about assessment.' }] })
  expect(reason(await propose('insert-object', { path: 'talks/york.md', kind: 'script', content: 'x' }))).toContain('must be one of')

  await fx.write('talks/research/assessment.md', '# Assessment notes\n\nA finding.\n')
  const attached = await propose('attach-source', { path: 'talks/york.md', 'source-path': 'talks/research/assessment.md', collection: 'talks' })
  expect(reason(attached)).toBe('')
  if (attached.ok) expect(attached.changes[0]).toMatchObject({ editClass: 'content', frontmatter: true })
  if (attached.ok) expect(attached.changes[0].oldText).not.toContain('Intro about assessment.')
  expect(reason(await propose('attach-source', { path: 'talks/york.md', 'source-path': '.writeflex/versions.jsonl' }))).toContain('dot-folder')
  expect(reason(await propose('attach-source', { path: 'talks/york.md', 'source-path': 'notes.md' }))).toContain('research/')
})

test('a change to the whole document is refused for an empty or oversized document, and an unknown operation is never a Change', async () => {
  await fx.write('empty.md', '')
  await fx.write('big.md', `---\ntitle: Big\n---\n${'x'.repeat(MAX_WHOLE_DOCUMENT_BYTES)}\n`)
  expect(reason(await propose('set-frontmatter', { path: 'empty.md', key: 'k', value: 'v' }))).toContain('is empty')
  expect(reason(await propose('set-frontmatter', { path: 'big.md', key: 'k', value: 'v' }))).toContain('too large')
  expect(reason(await propose('normalise-frontmatter', { path: 'notes.md' }))).toContain('no frontmatter block')
  for (const operation of ['move', 'trash', 'export', 'accept', '__proto__', 'constructor']) {
    expect(reason(await propose(operation, { path: 'talks/york.md' })), operation).toContain('not one shown for review')
  }
})

test('the declared source is one of a closed list; a claim to be the writer or the in-app agent is the generic outside agent', () => {
  expect(declaredSource('claude-code')).toBe('claude-code')
  expect(declaredSource('codex')).toBe('codex')
  // 0.24 ticket 07: only the app's own collector gives the reader source; a request can never claim it.
  for (const claim of [undefined, null, '', 'reader', 'Reader', 'writer', 'agent', 'reviewer', 'WriteFlex Agent', 'Claude Code', 'CODEX', ' codex', { name: 'codex' }, ['codex'], 1, '__proto__', 'toString']) {
    expect(declaredSource(claim)).toBe('outside-agent')
  }
  expect(OUTSIDE_AUTHORS).toEqual({ 'claude-code': { name: 'Claude Code' }, codex: { name: 'Codex' }, 'outside-agent': { name: 'Outside agent' }, reader: { name: 'Reader' } })
})

test('whether an undecided Change can still be placed is asked of the text as it now stands', () => {
  const base = { id: 'c_1', ts: 1, provenance: 'agent', category: 'other', summary: '', status: 'pending', isCorrection: false, path: 'a.md' } as const
  const replace = { ...base, editClass: 'content', oldText: 'old words', newText: 'new words' } as const
  expect(unplaceableIn(replace, 'some old words here')).toBeNull()
  expect(unplaceableIn(replace, 'some new words here')).toEqual({ reason: expect.stringContaining('no longer in a.md'), code: 'target-gone' })
  expect(unplaceableIn(replace, 'old words and old words')).toEqual({ reason: expect.stringContaining('more than once'), code: 'target-repeated' })
  const insert = { ...base, editClass: 'insert', oldText: '', newText: 'New.', insertAfter: 'Anchor.' } as const
  expect(unplaceableIn(insert, 'Anchor.\n')).toBeNull()
  expect(unplaceableIn(insert, 'Gone.\n')).toEqual({ reason: expect.stringContaining('not found'), code: 'target-gone' })
  const move = { ...base, editClass: 'move', oldText: 'One.', newText: 'One.', moveFrom: { from: 0, to: 4 }, moveTo: { from: 10, to: 10 }, outsideSource: 'codex', outsideMoveAfter: 'Two.' } as const
  expect(unplaceableIn(move, 'Zero.\n\nOne.\n\nTwo.\n')).toBeNull()
  expect(unplaceableIn(move, 'One.\n\nThree.\n')).toEqual({ reason: expect.stringContaining('not found'), code: 'target-gone' })
})

test('the closed list of sources exists once: the main process, the labels and the bridge\'s Change type all come from shared/outside-source.ts', async () => {
  const shared = await import('../../src/shared/outside-source')
  const main = await import('../../src/main/cli/review-format')
  expect(main.OUTSIDE_SOURCES).toBe(shared.OUTSIDE_SOURCES)
  expect(Object.keys(shared.OUTSIDE_SOURCE_LABELS).sort()).toEqual([...shared.OUTSIDE_SOURCES].sort())
  expect(Object.fromEntries(Object.entries(main.OUTSIDE_AUTHORS).map(([source, author]) => [source, author.name]))).toEqual(shared.OUTSIDE_SOURCE_LABELS)
  for (const source of shared.OUTSIDE_SOURCES) expect(declaredSource(source) === source || source === 'outside-agent' || source === 'reader').toBe(true)
  // Compile-time: the bridge's type IS the shared one (this assignment fails typecheck if either side gains or loses a source).
  type Bridge = NonNullable<import('../../src/preload').Change['outsideSource']>
  const same: [Bridge] extends [import('../../src/shared/outside-source').OutsideSource] ? ([import('../../src/shared/outside-source').OutsideSource] extends [Bridge] ? true : never) : never = true
  expect(same).toBe(true)
  // And neither the bridge nor the main process spells the list out again.
  const { readFile } = await import('node:fs/promises')
  for (const file of ['src/preload/index.ts', 'src/main/cli/review-format.ts', 'src/main/outside-change-fields.ts']) {
    expect(await readFile(new URL(`../../${file}`, import.meta.url), 'utf8'), file).not.toMatch(/'claude-code'\s*[|,]\s*'codex'/)
  }
})

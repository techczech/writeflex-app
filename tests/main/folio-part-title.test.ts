import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChangeStore } from '../../src/main/changes'
import { listCollection, collectionPieces } from '../../src/main/collection'
import { exportBundle } from '../../src/main/export'
import { folioOutline } from '../../src/main/folio-outline'
import { invalidateFolioPlaces } from '../../src/main/folio-place'
import { PartChangedError, partTitleFix, proposePartTitles, replacementFor, setPartHeadingMode } from '../../src/main/folio-part-proposals'
import { readPlan } from '../../src/main/plan'
import { Workspace } from '../../src/main/workspace'
import { shownHeadings } from '../../src/shared/folio-outline'
import { firstHeadingIsPartTitle, partChildHeadings, partTitle, titleFromFileName, withoutOwnHeading } from '../../src/shared/folio-part-title'

// Ticket 0.23-09: a Folio part's title is its `#` heading, shown once everywhere.

test('the part title: heading, frontmatter, file name, and heading: none, as a table', () => {
  const cases: Array<[string, string, string, string, string, boolean]> = [
    // [name, source, expected title, mode, from, mismatch]
    ['heading only', '# Executive summary\n\nText.\n', 'Executive summary', 'own', 'heading', false],
    ['heading and equal title', '---\ntitle: Executive summary\n---\n\n# Executive summary\n', 'Executive summary', 'own', 'heading', false],
    ['heading wins over a different title', '---\ntitle: Summary\n---\n\n# Executive summary\n', 'Executive summary', 'own', 'heading', true],
    ['title only, no heading', '---\ntitle: Dataset\n---\n\nRows.\n', 'Dataset', 'missing', 'frontmatter', false],
    ['neither: from the file name', 'Just text.\n', 'What would it cost', 'missing', 'file-name', false],
    ['heading: none uses the title', '---\ntitle: Interview data\nheading: none\n---\n\n### Q1\n', 'Interview data', 'none', 'frontmatter', false],
    ['heading: none, no title: file name', '---\nheading: none\n---\n\n### Q1\n', 'What would it cost', 'none', 'file-name', false],
    ['heading: none even with a # heading in the text', '---\nheading: none\ntitle: Data\n---\n# Odd\n', 'Data', 'none', 'frontmatter', false],
    ['only an h3', '### Row one\n\nx\n', 'What would it cost', 'missing', 'file-name', false],
    ['an h2 first is not the title', '## Part\n\n# Later\n', 'What would it cost', 'missing', 'file-name', false],
    ['a # inside a code fence is not a heading', '```\n# not a heading\n```\n', 'What would it cost', 'missing', 'file-name', false],
    ['a # comment in the frontmatter is not a heading', '---\n# a yaml comment\ntitle: T\n---\n\nBody\n', 'T', 'missing', 'frontmatter', false],
    ['markup in the heading is not in the title', '# The **big** [[Idea|idea]]\n', 'The big idea', 'own', 'heading', false],
  ]
  for (const [name, source, title, mode, from, mismatch] of cases) {
    const result = partTitle(source, 'p/03-what-would-it-cost.md')
    expect([name, result.title, result.mode, result.from, result.mismatch]).toEqual([name, title, mode, from, mismatch])
  }
})

test('firstHeadingIsPartTitle answers whether the first heading is the part’s own title, by the part-title rule', () => {
  const cases: Array<[string, string, boolean]> = [
    ['a # first heading', '# Anything\n', true],
    ['a # first heading under a different title', '---\ntitle: Other\n---\n\n# Anything\n', true],
    ['a lower first heading that says the title, letter case aside', '---\ntitle: Kapitola 4\n---\n\n## KAPITOLA 4\n', true],
    ['a lower first heading that says the file-name title', '### What would it cost\n', true],
    ['a lower first heading that is a subsection', '---\ntitle: Cost\n---\n\n## Items\n', false],
    ['heading: none', '---\nheading: none\n---\n\n# Odd\n', false],
    ['no heading', 'Just words.\n', false],
    ['an accent is not letter case', '---\ntitle: Kapitola\n---\n\n## Kapitolá\n', false],
  ]
  for (const [name, source, expected] of cases) {
    expect([name, firstHeadingIsPartTitle(source, 'p/03-what-would-it-cost.md')]).toEqual([name, expected])
    expect([name, firstHeadingIsPartTitle(source, 'p/03-what-would-it-cost.md')]).toEqual([name, partTitle(source, 'p/03-what-would-it-cost.md').mode === 'own'])
  }
})

test('child headings: a leading heading that repeats the title is dropped whatever its letter case, as the export drops it', () => {
  const headings = [{ level: 1, text: 'T' }, { level: 2, text: 't' }, { level: 2, text: 'B' }]
  expect(partChildHeadings(headings, 'own', 'T').map((h) => h.text)).toEqual(['B'])
  expect(withoutOwnHeading('# T\n\n## t\n\n## B\n', 'p.md')).toBe('## B\n')
})

test('child headings: a `heading: none` part lists every heading, even one that says its title', () => {
  const headings = [{ level: 2, text: 'Cost' }, { level: 2, text: 'Items' }]
  expect(partChildHeadings(headings, 'none', 'Cost').map((h) => h.text)).toEqual(['Cost', 'Items'])
  // Mode missing lists them too: a heading saying the title sits below opening text (top-of-body rule, 2026-10-21).
  expect(partChildHeadings(headings, 'missing', 'Cost').map((h) => h.text)).toEqual(['Cost', 'Items'])
})

test('file-name titles drop the extension and order numbers, turn separators into spaces and use sentence case', () => {
  expect(titleFromFileName('p/03-what-would-it-cost.md')).toBe('What would it cost')
  expect(titleFromFileName('Executive_Summary.md')).toBe('Executive summary')
  expect(titleFromFileName('p/10_AI-notes.md')).toBe('AI notes')
  expect(titleFromFileName('p/2024.md')).toBe('2024')
  expect(titleFromFileName('p/01.intro.markdown')).toBe('Intro')
})

test('child headings: a part with its own heading drops it, a part without lists them all', () => {
  const headings = [{ level: 1, text: 'A' }, { level: 2, text: 'B' }]
  expect(partChildHeadings(headings, 'own').map((h) => h.text)).toEqual(['B'])
  expect(partChildHeadings(headings, 'none').map((h) => h.text)).toEqual(['A', 'B'])
  const threes = [{ level: 3, text: 'x' }, { level: 3, text: 'y' }]
  expect(shownHeadings(threes, 'none').length).toBe(2)
  expect(shownHeadings(threes).length).toBe(2) // no level-1 first: nothing dropped even for `own`
})

test('the export body leaves out the part heading the section already prints', () => {
  expect(withoutOwnHeading('---\ntitle: A\n---\n\n# A\n\nBody\n', 'p/a.md')).toBe('---\ntitle: A\n---\n\nBody\n')
  expect(withoutOwnHeading('# A\nBody\n', 'p/a.md')).toBe('Body\n')
  expect(withoutOwnHeading('## A\n\nBody\n', 'p/other.md')).toBe('## A\n\nBody\n')
  expect(withoutOwnHeading('## A\n\nBody\n', 'p/a.md')).toBe('Body\n') // ## A is this part's (file-name) title
  expect(withoutOwnHeading('---\nheading: none\n---\n# A\n', 'p/a.md')).toBe('---\nheading: none\n---\n# A\n')
})

/** What Accept does with a ledger record: the one unique oldText becomes newText. */
function accept(source: string, change: { oldText: string; newText: string }): string {
  if (change.oldText === '') return change.newText
  expect(source.indexOf(change.oldText)).toBe(source.lastIndexOf(change.oldText))
  return source.replace(change.oldText, () => change.newText)
}

test('proposals: a missing heading is added from the title or the file name, and title is set to match', () => {
  const path = 'p/03-what-would-it-cost.md'
  const cases: Array<[string, string, string]> = [
    ['bare file', 'Some text.\n', '---\ntitle: What would it cost\n---\n\n# What would it cost\n\nSome text.\n'],
    ['frontmatter without title', '---\nstatus: draft\n---\n\nSome text.\n', '---\ntitle: What would it cost\nstatus: draft\n---\n\n# What would it cost\n\nSome text.\n'],
    ['frontmatter with title', '---\ntitle: Cost\n---\n\nSome text.\n', '---\ntitle: Cost\n---\n\n# Cost\n\nSome text.\n'],
    ['no blank line after the frontmatter', '---\ntitle: Cost\n---\nSome text.\n', '---\ntitle: Cost\n---\n\n# Cost\n\nSome text.\n'],
    ['only lower headings', '### Row\n\nx\n', '---\ntitle: What would it cost\n---\n\n# What would it cost\n\n### Row\n\nx\n'],
    ['a title needing quotes', '---\ntitle: "Cost: a study"\n---\n\nx\n', '---\ntitle: "Cost: a study"\n---\n\n# Cost: a study\n\nx\n'],
    ['CRLF kept', '---\r\ntitle: Cost\r\n---\r\n\r\nx\r\n', '---\r\ntitle: Cost\r\n---\r\n\r\n# Cost\r\n\r\nx\r\n'],
  ]
  for (const [name, source, expected] of cases) {
    const fix = partTitleFix(source, path)
    const replacement = replacementFor(source, fix!.next)
    expect([name, fix!.next]).toEqual([name, expected])
    expect([name, accept(source, replacement!)]).toEqual([name, expected]) // the stated range alone reproduces it
    expect(replacement!.oldText.length).toBeLessThanOrEqual(source.length)
  }
})

test('proposals: a differing title is no longer proposed (the title-conflict buttons fix it); nothing else is either', () => {
  const path = 'p/a.md'
  const source = '---\ntitle: Summary\nstatus: draft\n---\n\n# Executive summary\n\nBody.\n'
  expect(partTitle(source, path).mismatch).toBe(true)
  expect(partTitleFix(source, path)).toBeNull()
  const next = '---\ntitle: Executive summary\nstatus: draft\n---\n\n# Executive summary\n\nBody.\n'
  expect(replacementFor(source, next)).toEqual({ oldText: 'title: Summary', newText: 'title: Executive summary', anchor: { from: 4, to: 18 } })
  expect(partTitleFix('# Alone\n', path)).toBeNull() // no title to differ from: bare files stay bare
  expect(partTitleFix('---\ntitle: Same\n---\n# Same\n', path)).toBeNull()
  expect(partTitleFix('---\nheading: none\n---\n### a\n', path)).toBeNull()
  expect(partTitleFix('---\nheading: none\ntitle: Different\n---\n# Other\n', path)).toBeNull()
})

let root: string
let ws: Workspace
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-part-title-'))
  ws = new Workspace(root)
  invalidateFolioPlaces(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const write = async (rel: string, content: string): Promise<void> => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}
const read = (rel: string): Promise<string> => readFile(join(root, rel), 'utf8')
const manifest = (files: string[]): string => JSON.stringify({ schema_version: 1, content_root: '', files: files.map((path) => ({ path })) })

async function report(): Promise<void> {
  await write('report/_report-structure.json', manifest(['01-intro.md', '02-data.md', '03-what-would-it-cost.md', '04-summary.md']))
  await write('report/01-intro.md', '# Executive summary\n\n## Why\n\n### Detail\n')
  await write('report/02-data.md', '---\ntitle: Survey data\nheading: none\n---\n\n### Q1\n\n### Q2\n')
  await write('report/03-what-would-it-cost.md', 'Costs.\n\n## Items\n')
  await write('report/04-summary.md', '---\ntitle: Short\n---\n\n# Summary\n\nEnd.\n')
}

test('the proposal builder stages pending changes only, once, never touches heading: none, and Accept applies them', async () => {
  await report()
  const before = { data: await read('report/02-data.md'), intro: await read('report/01-intro.md') }
  const changes = new ChangeStore(ws)
  expect(await proposePartTitles(ws, changes, 'report')).toEqual({ proposed: 1, flagged: 1, withdrawn: 0 })
  // Nothing was written to any part.
  expect(await read('report/02-data.md')).toBe(before.data)
  expect(await read('report/01-intro.md')).toBe(before.intro)
  expect(await read('report/03-what-would-it-cost.md')).toBe('Costs.\n\n## Items\n')
  const pending = await changes.list({ status: 'pending' })
  expect(pending.map((c) => [c.path, c.provenance, c.summary])).toEqual([
    ['report/03-what-would-it-cost.md', 'agent', 'Add the heading “What would it cost” and a matching title'],
  ])
  // Opening again (or adding a part) does not repeat it, even after it was rejected.
  await changes.setStatus(pending[0].id, 'rejected')
  expect(await proposePartTitles(ws, changes, 'report')).toEqual({ proposed: 0, flagged: 1, withdrawn: 0 })
  expect((await changes.list()).length).toBe(1)
  // Accept: the stated range is replaced; the rest of the file is as it was.
  const cost = pending[0]
  expect(await read('report/03-what-would-it-cost.md')).not.toContain('# What would it cost')
  expect(accept(await read(cost.path), cost)).toBe('---\ntitle: What would it cost\n---\n\n# What would it cost\n\nCosts.\n\n## Items\n')
})

test('the Folio outline\'s choice writes and removes heading: none, touching nothing else', async () => {
  await report()
  expect(await setPartHeadingMode(ws, 'report/03-what-would-it-cost.md', 'none')).toEqual(['report/03-what-would-it-cost.md'])
  expect(await read('report/03-what-would-it-cost.md')).toBe('---\nheading: none\n---\n\nCosts.\n\n## Items\n')
  // heading: none makes the part leave the proposals alone.
  expect(await proposePartTitles(ws, new ChangeStore(ws), 'report')).toEqual({ proposed: 0, flagged: 0, withdrawn: 0 }) // a differing title is not proposed
  expect(await setPartHeadingMode(ws, 'report/03-what-would-it-cost.md', 'none')).toEqual([]) // already so
  expect(await setPartHeadingMode(ws, 'report/03-what-would-it-cost.md', 'own')).toEqual(['report/03-what-would-it-cost.md'])
  expect(await read('report/03-what-would-it-cost.md')).toBe('Costs.\n\n## Items\n')
  await setPartHeadingMode(ws, 'report/02-data.md', 'own')
  expect(await read('report/02-data.md')).toBe('---\ntitle: Survey data\n---\n\n### Q1\n\n### Q2\n')
})

test('the Folio outline\'s choice refuses, writing nothing, when the part is saved between its read and its write', async () => {
  await report()
  const path = 'report/03-what-would-it-cost.md'
  // An editor autosave lands after the heading choice read the part and before it writes.
  const saved = 'Costs, edited in the editor.\n\n## Items\n'
  const attempt = setPartHeadingMode(ws, path, 'none', async () => { await write(path, saved) })
  await expect(attempt).rejects.toBeInstanceOf(PartChangedError)
  await expect(setPartHeadingMode(ws, path, 'none', async () => { await write(path, saved + 'more\n') })).rejects.toThrow('changed while its heading choice was being saved, so nothing was written')
  expect(await read(path)).toBe(saved + 'more\n')
})

test('the Outline names each part once: its # heading is the title, and the children start at the next level', async () => {
  await report()
  const outline = await folioOutline(ws, 'report/01-intro.md')
  const parts = outline!.pieces
  expect(parts.map((p) => [p.title, p.heading, p.titleMismatch ?? false])).toEqual([
    ['Executive summary', 'own', false],
    ['Survey data', 'none', false],
    ['What would it cost', 'missing', false],
    ['Summary', 'own', true],
  ])
  const children = (p: (typeof parts)[number]) => shownHeadings(p.headings, p.heading).map((h) => h.text)
  expect(children(parts[0])).toEqual(['Why', 'Detail'])
  expect(children(parts[1])).toEqual(['Q1', 'Q2']) // nest directly under the part
  expect(children(parts[2])).toEqual(['Items'])
})

test('the Board card, the Folio outline and the export contents use the title once', async () => {
  await report()
  const rows = (await listCollection(ws, 'report')).rows
  expect(rows.map((r) => r.title).sort()).toEqual(['Executive summary', 'Summary', 'Survey data', 'What would it cost'])
  expect((await collectionPieces(ws, 'report')).map((p) => p.metadata.title).sort()).toEqual(['Executive summary', 'Summary', 'Survey data', 'What would it cost'])
  // A file outside any Folio keeps the ordinary title (first heading of any level, else the file name).
  await write('loose/x.md', '### Only three\n')
  expect((await listCollection(ws, 'loose')).rows[0].title).toBe('Only three')

  await write('report/_report_INDEX.md', '# Report\n\n## Running order\n\n- [[Executive summary]]\n- [[Short]]\n')
  const plan = await readPlan(ws, 'report')
  expect(plan!.parts.map((p) => [p.title, p.heading?.mode, p.heading?.mismatch])).toEqual([['Executive summary', 'own', false], ['Short', 'own', true]])
  expect(plan!.unlisted.map((p) => [p.heading?.title, p.heading?.mode]).sort()).toEqual([['Survey data', 'none'], ['What would it cost', 'missing']])

  const out = join(root, 'out.html')
  await exportBundle(ws, { dir: 'report', format: 'html', target: out })
  const html = await readFile(out, 'utf8')
  const count = (needle: string): number => html.split(needle).length - 1
  // Contents link and section heading each print "Executive summary" once; the body's own # is gone.
  expect(count('>Executive summary<')).toBe(2)
  expect(html).toContain('Survey data')
  // The editor still suggests the file-derived title; export requires a declared title instead.
  expect(html).toContain('Untitled document')
  expect(html).not.toContain('What would it cost')
})

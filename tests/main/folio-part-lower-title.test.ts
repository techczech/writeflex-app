// Folio parts, 2026-10-18 (the writer's recorded answer, option C): a first heading that is the part's title,
// at any level, is the title. WriteFlex proposes nothing about it: never a lift of its levels, never removing
// a repeated title, never a second `# Title`. An old WriteFlex "Add the heading" for that title is closed.
// Seams: the rule (`partTitle`, `partTitleFix`, `headingPlainText`, `withoutOwnHeading`) and the proposal
// builder through the Workspace agent's real Accept.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceAgent } from '../../src/main/agent'
import { ChangeStore, closedCodeOf, closedReasonOf, type NewChange } from '../../src/main/changes'
import { WRITEFLEX_AGENT_AUTHOR, WRITEFLEX_SELF_AUTHOR } from '../../src/main/versions'
import { invalidateFolioPlaces } from '../../src/main/folio-place'
import { partTitleFix, proposePartTitles, replacementFor } from '../../src/main/folio-part-proposals'
import { Workspace } from '../../src/main/workspace'
import { headingPlainText, partTitle, withoutOwnHeading } from '../../src/shared/folio-part-title'

const BOM = '﻿'
const K4 = 'Kapitola 4. Idealizované kognitivní modely'
const FM_K4 = `---\ntitle: "${K4}"\n---\n\n`
const CASE = 'Případová studie 1. Anger/Hněv'
const FM_CASE = `---\ntitle: "${CASE}"\n---\n\n`
const K1 = 'Kapitola 1. Význam kategorizace'
const FM_K1 = `---\ntitle: "${K1}"\n---\n\n`

/** What the ledger's Accept does with a record: the one unique oldText becomes newText. */
function accept(source: string, change: { oldText: string; newText: string }): string {
  expect(source.indexOf(change.oldText)).toBe(source.lastIndexOf(change.oldText))
  return source.replace(change.oldText, () => change.newText)
}

test('a first heading that is the title, at any level, is the title, and nothing is proposed about it', () => {
  const path = 'kniha/04-kapitola.md'
  const cases: Array<[string, string, string]> = [
    // [name, source, the title it is named by]
    ['## title with ### and #### sections', `${FM_K4}## ${K4}\n\nText.\n\n### Oddíl\n\n#### Pododdíl\n`, K4],
    ['### title', '---\ntitle: Berlin a Kay\n---\n\n### Berlin a Kay\n\n#### Barvy\n\n##### Odstíny\n', 'Berlin a Kay'],
    ['# title then ## title (the title twice)', `${FM_K1}# ${K1}\n\n## ${K1}\n\nText.\n\n### Oddíl\n`, K1],
    ['# title then # title', `${FM_K4}# ${K4}\n\n# ${K4}\n\n## Oddíl\n`, K4],
    ['# title then ### title, CRLF', '# T\r\n### T\r\nx\r\n#### A\r\n', 'T'],
    ['a footnote reference in the ## title', `${FM_CASE}## ${CASE}[^1]\n\nText.[^2]\n\n### Oddíl\n\n[^1]: Poznámka.\n`, CASE],
    ['inline HTML and a comment in the title', `${FM_CASE}## Případová studie 1. <span lang="en">Anger</span>/Hněv<!-- pozn. -->\n`, CASE],
    ['a [text]{.mark} span and a {#id .class} block in the title', `${FM_CASE}## Případová studie 1. [Anger]{.mark}/Hněv {#anger .chapter}\n`, CASE],
    ['markup in the title', '---\ntitle: The big idea\n---\n\n## The **big** idea\n', 'The big idea'],
    ['a later ## that would have blocked a lift', '---\ntitle: T\n---\n\n## T\n\n### A\n\n## B\n', 'T'],
    ['## in a fence is not a heading', `${FM_K4}## ${K4}\n\n\`\`\`\n## not a heading\n\`\`\`\n\n### Oddíl\n`, K4],
    ['headings indented up to three spaces', '---\ntitle: T\n---\n\n  ## T\n\n   ### A\n\n    ### code\n', 'T'],
    ['CRLF', `---\r\ntitle: "${K4}"\r\n---\r\n\r\n## ${K4}\r\n\r\n### Oddíl\r\n`, K4],
    ['BOM', `${BOM}${FM_K4}## ${K4}\n\n### Oddíl\n`, K4],
    ['no frontmatter: the file-name title counts', '## Kapitola\n\n### Oddíl\n', 'Kapitola'],
    ['already #', `${FM_K4}# ${K4}\n\n## Oddíl\n`, K4],
  ]
  for (const [name, source, title] of cases) {
    expect([name, partTitle(source, path)]).toMatchObject([name, { mode: 'own', title: expect.any(String), mismatch: false }])
    expect([name, headingPlainText(partTitle(source, path).title)]).toEqual([name, title])
    expect([name, partTitleFix(source, path)]).toEqual([name, null])
  }
})

test('a heading after a fence is not at the top of the body, so it is not the title (top-of-body rule, 2026-10-21)', () => {
  for (const source of ['---\ntitle: T\n---\n\n~~~\n## Other\n~~~\n\n## T\n', '---\ntitle: T\n---\n\n````\n```\n## Other\n````\n\n## T\n']) {
    expect([source, partTitle(source, 'kniha/04-kapitola.md')]).toMatchObject([source, { mode: 'missing', title: 'T', mismatch: false }])
  }
})

test('the proposals that remain: a first heading that is not the title gets the add; a differing frontmatter title gets none (the title-conflict buttons fix it)', () => {
  const add = '---\ntitle: Cost\n---\n\n## Items\n'
  const fix = partTitleFix(add, 'p.md')!
  expect([fix.next, fix.summary]).toEqual(['---\ntitle: Cost\n---\n\n# Cost\n\n## Items\n', 'Add the heading “Cost”'])
  expect(accept(add, replacementFor(add, fix.next)!)).toBe(fix.next)
  expect(partTitleFix(fix.next, 'p.md')).toBeNull()
  // An accent is a different word: not the title, so the add stands.
  expect(partTitleFix('---\ntitle: Kapitola\n---\n\n## Kapitolá\n', 'k.md')!.summary).toBe('Add the heading “Kapitola”')
  // Letter case aside it is the title, and the mismatch rule compares the same way (title-conflict buttons, 2026-10-19).
  const lower = '---\ntitle: kapitola 4\n---\n\n## KAPITOLA 4\n\n### Oddíl\n'
  expect(partTitle(lower, 'k.md')).toMatchObject({ mode: 'own', title: 'KAPITOLA 4', mismatch: false })
  expect(partTitleFix(lower, 'k.md')).toBeNull()
  // A title that really differs from the part's own heading: flagged, never proposed.
  expect(partTitle('---\ntitle: Other\n---\n\n# KAPITOLA 4\n', 'k.md')).toMatchObject({ mode: 'own', mismatch: true })
  expect(partTitleFix('---\ntitle: Other\n---\n\n# KAPITOLA 4\n', 'k.md')).toBeNull()
  expect(partTitleFix('## kapitola\n', 'kniha/04-Kapitola.md')).toBeNull()
  expect(partTitleFix('---\ntitle: T\nheading: none\n---\n\n## Other\n', 'p.md')).toBeNull()
})

test('the plain text of a heading drops the markers that print no words of the title', () => {
  expect(headingPlainText(`${CASE}[^1]`)).toBe(CASE)
  expect(headingPlainText('Anger[^note-a]/Hněv[^2] ##')).toBe('Anger/Hněv')
  expect(headingPlainText('<em>Anger</em><br/>Hněv<!-- x -->')).toBe('Anger Hněv')
  expect(headingPlainText('Anger<br>Hněv')).toBe('Anger Hněv')
  expect(headingPlainText('Anger<BR />Hněv')).toBe('Anger Hněv')
  expect(headingPlainText('[Anger]{.mark} a [[Hněv]] {#id .class}')).toBe('Anger a Hněv')
  expect(headingPlainText('A [link](https://example.org) {lang=cs}')).toBe('A link')
  // An attribute block is a Pandoc header attribute only at the end of the line: mid-text braces stay.
  expect(headingPlainText('Equations {x=1} and more')).toBe('Equations {x=1} and more')
  expect(headingPlainText('Equations {.a} here')).toBe('Equations {.a} here')
  // Plain braces and brackets that are not markers stay.
  expect(headingPlainText('Sets {a, b} and [x]')).toBe('Sets {a, b} and [x]')
})

test('the plain text of a hostile heading is bounded: 100k braces return at once', () => {
  for (const hostile of ['{'.repeat(100_000), '[x]{'.repeat(25_000), '{#'.repeat(50_000) + 'x', '<a'.repeat(50_000), '<!--'.repeat(25_000)]) {
    const started = performance.now()
    headingPlainText(hostile)
    expect(performance.now() - started).toBeLessThan(50)
  }
  // The frontmatter side goes through the same bound.
  const started = performance.now()
  partTitle(`---\ntitle: "${'{'.repeat(100_000)}"\n---\n\n## ${'{'.repeat(100_000)}\n`, 'p.md')
  expect(performance.now() - started).toBeLessThan(500)
})

test('a heading line with a long run of spaces is read at once (200k spaces)', () => {
  const started = performance.now()
  const named = partTitle(`# a${' '.repeat(200_000)}b\n`, 'p.md')
  expect(performance.now() - started).toBeLessThan(100)
  expect(named.title).toBe('a b')
  const trailing = performance.now()
  expect(partTitle(`# a${' '.repeat(200_000)}\n`, 'p.md').title).toBe('a')
  expect(performance.now() - trailing).toBeLessThan(100)
})

test('the plain text of other hostile markers is bounded too: no pattern retries from every start', () => {
  const hostiles = ['['.repeat(100_000), '[^'.repeat(50_000), '[['.repeat(50_000), '[a]('.repeat(25_000), `a${' '.repeat(100_000)}b`, `a${' \t'.repeat(50_000)}#x`, `a${' '.repeat(100_000)}{x`, '[^x'.repeat(30_000)]
  for (const hostile of hostiles) {
    const started = performance.now()
    headingPlainText(hostile)
    expect(performance.now() - started).toBeLessThan(50)
  }
})

test('the title is read whole: a long heading is never cut, and titles that differ late do not compare equal', () => {
  const long = `${'a'.repeat(499)}😀 and the rest`
  expect(partTitle(`# ${long}\n`, 'p.md').title).toBe(long)
  expect(headingPlainText(`${'b'.repeat(600)} [^1]`)).toBe('b'.repeat(600))
  const head = 'c'.repeat(500)
  const differs = `---\ntitle: "${head}x"\n---\n\n`
  expect(partTitle(`${differs}# ${head}y\n`, 'p.md')).toMatchObject({ mode: 'own', mismatch: true })
  // A lower-level heading that differs only after character 500 is not the title.
  expect(partTitle(`${differs}## ${head}y\n`, 'p.md')).toMatchObject({ mode: 'missing', title: `${head}x` })
})

test('the mismatch rule reads the frontmatter title as it reads the heading: markers on both sides compare alike', () => {
  for (const [title, heading] of [['Title[^1]', '# Title[^1]'], ['Title[^1]', '# Title'], ['Title', '## Title[^1]'], ['Title {#t}', '# Title'], ['<em>Title</em>', '# Title']]) {
    const source = `---\ntitle: "${title.replace(/"/g, '\\"')}"\n---\n\n${heading}\n`
    expect([title, heading, partTitle(source, 'p.md')]).toMatchObject([title, heading, { mode: 'own', mismatch: false }])
    expect([title, heading, partTitleFix(source, 'p.md')]).toEqual([title, heading, null])
  }
  // A real difference is a mismatch; no change is filed for it (the title-conflict buttons fix it).
  expect(partTitle('---\ntitle: "Title[^1]"\n---\n\n# Other[^1]\n', 'p.md')).toMatchObject({ mode: 'own', mismatch: true })
  expect(partTitleFix('---\ntitle: "Title[^1]"\n---\n\n# Other[^1]\n', 'p.md')).toBeNull()
})

test('the export leaves the title heading out of the body whatever its level, and both copies of a title written twice', () => {
  expect(withoutOwnHeading(`${FM_K4}## ${K4}\n\n### Oddíl\n`, 'kniha/04.md')).toBe(`${FM_K4}### Oddíl\n`)
  expect(withoutOwnHeading(`${FM_CASE}## ${CASE}[^1]\n\nText.\n`, 'kniha/c.md')).toBe(`${FM_CASE}Text.\n`)
  expect(withoutOwnHeading('## Kapitola\n\nx\n', 'kniha/kapitola.md')).toBe('x\n')
  expect(withoutOwnHeading('## Kapitola\n\nx\n', 'kniha/jiny.md')).toBe('## Kapitola\n\nx\n') // not the title
  expect(withoutOwnHeading('# T\n\n## T\n\n### A\n', 'p.md')).toBe('### A\n')
  expect(withoutOwnHeading('# T\n\n## Other\n', 'p.md')).toBe('## Other\n')
  expect(withoutOwnHeading('# T\n\n# T\n\n## A\n', 'p.md')).toBe('## A\n')
  // The title twice at the same lower level loses both too; a different second heading stays.
  expect(withoutOwnHeading('## T\n\n## T\n\n### A\n', 'kniha/t.md')).toBe('### A\n')
  expect(withoutOwnHeading(`${FM_CASE}## ${CASE}[^1]\n\n## ${CASE}\n\nText.\n`, 'kniha/c.md')).toBe(`${FM_CASE}Text.\n`)
  expect(withoutOwnHeading('## T\n\n## Other\n', 'kniha/t.md')).toBe('## Other\n')
  expect(withoutOwnHeading('### T\n\n## T\n', 'kniha/t.md')).toBe('## T\n') // a shallower second heading is not the repeat
})

let root: string
let appData: string
let ws: Workspace
let changes: ChangeStore
let agent: WorkspaceAgent | undefined
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-part-lower-'))
  appData = await mkdtemp(join(tmpdir(), 'wf-part-lower-data-'))
  ws = new Workspace(root)
  changes = new ChangeStore(ws)
  invalidateFolioPlaces(root)
  agent = await WorkspaceAgent.create({ workspace: ws, appDataDir: appData, changes, onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {} })
})
afterEach(async () => {
  agent?.dispose()
  for (const dir of [root, appData]) await rm(dir, { recursive: true, force: true })
})
const write = async (rel: string, content: string): Promise<void> => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}
const bytes = (rel: string): Promise<Buffer> => readFile(join(root, rel))
const manifest = (files: string[]): string => JSON.stringify({ schema_version: 1, content_root: '', files: files.map((path) => ({ path })) })

/** The Lakoff shapes, as the corpus has them. */
const LAKOFF: Record<string, string> = {
  '04-kapitola.md': `${FM_K4}## ${K4}\n\nText.\n\n### Oddíl\n\n#### Pododdíl\n`,
  '05-berlin.md': `${BOM}---\r\ntitle: Berlin a Kay\r\n---\r\n\r\n### Berlin a Kay\r\n\r\n#### Barvy\r\n`,
  '01-kapitola.md': `${FM_K1}# ${K1}\n\n## ${K1}\n\nText.\n\n### Oddíl\n`,
  '07-pripad.md': `${FM_CASE}## ${CASE}[^1]\n\nText.\n\n### Oddíl\n\n[^1]: Poznámka.\n`,
}

test('opening a Folio of the Lakoff shapes files nothing for them and writes nothing; a part without its title still gets the add', async () => {
  const files = Object.keys(LAKOFF)
  for (const file of files) await write(`kniha/${file}`, LAKOFF[file])
  await write('kniha/06-other.md', '---\ntitle: Cost\n---\n\n## Items\n')
  await write('kniha/_report-structure.json', manifest([...files, '06-other.md']))

  expect(await proposePartTitles(ws, changes, 'kniha')).toEqual({ proposed: 1, flagged: 1, withdrawn: 0 })
  for (const file of files) expect((await bytes(`kniha/${file}`)).equals(Buffer.from(LAKOFF[file], 'utf8'))).toBe(true)
  expect((await changes.list()).map((c) => [c.path, c.summary])).toEqual([['kniha/06-other.md', 'Add the heading “Cost”']])
  expect(await proposePartTitles(ws, changes, 'kniha')).toEqual({ proposed: 0, flagged: 1, withdrawn: 0 })
  expect((await changes.list()).length).toBe(1)
})

const STALE_K4 = (over: Partial<NewChange> = {}): NewChange => ({
  // What the old rule filed for a `## K4` part: `# K4` added above `## K4`.
  path: 'kniha/04.md', provenance: 'agent', editClass: 'housekeeping', category: 'structure', summary: `Add the heading “${K4}”`,
  oldText: `## ${K4}`, newText: `# ${K4}\n\n## ${K4}`, anchor: { from: FM_K4.length, to: FM_K4.length + `## ${K4}`.length }, isCorrection: false,
  author: WRITEFLEX_SELF_AUTHOR, ...over,
})

test('an undecided old add of the part\'s own title is closed as superseded, saying the part has that heading; nothing else is', async () => {
  const before = `${FM_K4}## ${K4}\n\n### Oddíl\n`
  await write('kniha/_report-structure.json', manifest(['04.md', '05.md']))
  await write('kniha/04.md', before)
  await write('kniha/05.md', '---\ntitle: Cost\n---\n\n## Items\n')
  const stale = await changes.add(STALE_K4())
  const staleHeld = await changes.add(STALE_K4({ summary: `Add the heading “${K4.toUpperCase()}” and a matching title`, newText: `# ${K4}\n\n## ${K4} ` }))
  await changes.setStatus(staleHeld.id, 'held')
  const rejected = await changes.add(STALE_K4({ newText: `# ${K4}\n\n## ${K4}  ` }))
  await changes.setStatus(rejected.id, 'rejected')
  const otherTitle = await changes.add(STALE_K4({ summary: 'Add the heading “Jiný”', newText: `# Jiný\n\n## ${K4}` }))
  const agentAuthored = await changes.add(STALE_K4({ author: WRITEFLEX_AGENT_AUTHOR, newText: `# ${K4}\n\n## ${K4}\n` }))
  const otherPart = await changes.add(STALE_K4({ path: 'kniha/05.md', summary: 'Add the heading “Cost”', oldText: '## Items', newText: '# Cost\n\n## Items', anchor: { from: 20, to: 28 } }))

  expect(await proposePartTitles(ws, changes, 'kniha')).toEqual({ proposed: 0, flagged: 1, withdrawn: 2 })
  const byId = new Map((await changes.list()).map((c) => [c.id, c]))
  for (const id of [stale.id, staleHeld.id]) {
    const closed = byId.get(id)!
    expect([closed.status, closedCodeOf(closed)]).toEqual(['rejected', 'superseded'])
    expect(closedReasonOf(closed)).toBe(`Closed by WriteFlex: this part already has the heading “${K4}”, so adding it would write the title twice.`)
  }
  expect(closedReasonOf(byId.get(rejected.id)!)).toBeNull() // the writer's own decision stands
  expect(byId.get(otherTitle.id)!.status).toBe('pending')
  expect(byId.get(agentAuthored.id)!.status).toBe('pending') // not WriteFlex's own: never closed by it
  expect(byId.get(otherPart.id)!.status).toBe('pending')
  expect((await changes.list()).length).toBe(6) // nothing new filed
  // Opening again closes and files nothing more; the closed one cannot be accepted, and the part is untouched.
  expect(await proposePartTitles(ws, changes, 'kniha')).toEqual({ proposed: 0, flagged: 1, withdrawn: 0 })
  expect(await agent!.resolveChange(stale.id, 'accept')).toMatchObject({ applied: false, closed: true })
  expect((await bytes('kniha/04.md')).toString('utf8')).toBe(before)
})

test('an old add of a title whose heading carries a footnote reference is closed too', async () => {
  const before = `${FM_CASE}## ${CASE}[^1]\n\nText.\n\n[^1]: Poznámka.\n`
  await write('kniha/_report-structure.json', manifest(['c.md']))
  await write('kniha/c.md', before)
  const stale = await changes.add(STALE_K4({ path: 'kniha/c.md', summary: `Add the heading “${CASE}”`, oldText: `## ${CASE}[^1]`, newText: `# ${CASE}\n\n## ${CASE}[^1]`, anchor: { from: FM_CASE.length, to: FM_CASE.length + `## ${CASE}[^1]`.length } }))
  expect(await proposePartTitles(ws, changes, 'kniha')).toEqual({ proposed: 0, flagged: 0, withdrawn: 1 })
  expect(closedCodeOf((await changes.get(stale.id))!)).toBe('superseded')
  expect(await agent!.resolveChange(stale.id, 'accept')).toMatchObject({ applied: false, closed: true })
  expect((await bytes('kniha/c.md')).toString('utf8')).toBe(before)
})

test('the closing takes the write turn: an Accept of the old add and the open never interleave', async () => {
  const before = `${FM_K4}## ${K4}\n\n### Oddíl\n`
  await write('kniha/_report-structure.json', manifest(['04.md']))
  await write('kniha/04.md', before)
  const stale = await changes.add(STALE_K4())
  // Hold the Collection's write turn; both the Accept and the open queue behind it.
  let release!: () => void
  const held = ws.exclusiveAll(() => new Promise<void>((resolve) => { release = resolve }))
  const accepting = agent!.resolveChange(stale.id, 'accept')
  const proposing = proposePartTitles(ws, changes, 'kniha')
  for (let i = 0; i < 200 && ws.writersWaiting < 2; i += 1) await new Promise((r) => setTimeout(r, 5))
  expect(ws.writersWaiting).toBe(2)
  expect((await changes.list()).length).toBe(1) // the open has closed and filed nothing while the turn is held
  release()
  await held
  const [accepted, result] = await Promise.all([accepting, proposing])
  const after = (await changes.get(stale.id))!
  // Either order, the old add never writes (fix round 2, 2026-10-21): Accept checks it is still what the rule
  // proposes now, and this part already has its title as a heading. Whichever went first closed it as superseded.
  expect([accepted.applied, after.status === 'accepted', closedCodeOf(after)]).toEqual([false, false, 'superseded'])
  expect(result).toMatchObject({ proposed: 0, flagged: 0 })
  expect([0, 1]).toContain(result.withdrawn)
  expect((await bytes('kniha/04.md')).toString('utf8')).toBe(before)
  expect(await changes.list({ status: 'pending' })).toEqual([])
})

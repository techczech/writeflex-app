import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { collectionLinks, createCollectionStub, previewCollectionStub } from '../../src/main/wikilinks'
import { Workspace } from '../../src/main/workspace'
import { materialiseSeed, wikilinkRanges } from '../../src/renderer/src/editor/wikilinks'
import { detectWikilinkPickerTarget, wikilinkCompletionEdit, wikilinkPickerMatches } from '../../src/renderer/src/editor/wikilink-autocomplete'

// The logic of tests/e2e/wikilinks-capture.spec.ts without Electron. The Stubs are written by the real
// main-process function onto a real temporary folder and read back as bytes. What stays in the e2e: the
// tab strip, the link's live/dead look, the dead-link popup, the Capture sheet and the restored selection.
const piece = (title: string, body = ''): string => `---\ntitle: ${title}\nstatus: editing\ndescription: ${title} gist\ndate: 2026-07-14\ntags: [test]\n---\n\n# ${title}\n\n${body}\n`

let root: string
let ws: Workspace
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-wikilinks-capture-'))
  ws = new Workspace(root)
})
afterEach(() => rm(root, { recursive: true, force: true }))
const put = async (files: Record<string, string>): Promise<void> => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content, 'utf8')
  }
}
const linksFrom = async (from: string) => (await collectionLinks(ws, '')).filter((link) => link.from === from)

describe('links resolve and refresh', () => {
  test('a live link resolves to its Piece by title, with or without a markdown extension', async () => {
    await put({
      'source.md': piece('Source', 'Existing: [[Target Piece]] and [[target-file.md]]. New: [[NewIdea]].'),
      'target.md': piece('Target Piece'),
      'target-file.md': piece('Different title'),
    })
    expect((await linksFrom('source.md')).map(({ target, to }) => [target, to])).toEqual([
      ['Target Piece', 'target.md'],
      ['target-file.md', 'target-file.md'],
      ['NewIdea', null], // dead until written
    ])
  })

  test('creating the dead link\'s Stub (⌘↵ on its popup) writes newidea.md and the link then resolves live', async () => {
    const source = 'Existing: [[Target Piece]]. New: [[NewIdea]].'
    await put({ 'source.md': piece('Source', source), 'target.md': piece('Target Piece') })
    const [, dead] = wikilinkRanges(source, [{ target: 'Target Piece', display: 'Target Piece', to: 'target.md' }, { target: 'NewIdea', display: 'NewIdea', to: null }])
    const seed = materialiseSeed(source, dead)
    const created = await createCollectionStub(ws, { dir: '', title: seed.title, gist: seed.gist, from: 'source.md' })
    expect(created).toMatchObject({ created: true, path: 'newidea.md' })
    expect(existsSync(join(root, 'newidea.md'))).toBe(true)
    expect((await linksFrom('source.md')).find((link) => link.target === 'NewIdea')?.to).toBe('newidea.md')
  })
})

describe('the [[ picker', () => {
  const pieces = [{ title: 'Target Piece', name: 'target.md' }, { title: 'Zebra Notes', name: 'zebra.md' }, { title: 'Source', name: 'source.md' }]

  test('opens on [[ listing the Pieces, narrows on "Tar", and Tab or Enter write [[Target Piece]]', () => {
    expect(detectWikilinkPickerTarget('Link: [[', 8)).toEqual({ from: 8, query: '' })
    expect(wikilinkPickerMatches(pieces, '').map((match) => match.label)).toEqual(expect.arrayContaining(['Target Piece', 'Zebra Notes']))
    const narrowed = wikilinkPickerMatches(pieces, 'Tar')
    expect(narrowed.map((match) => match.label)).toEqual(['Target Piece'])
    // Accepting writes the label and closes the link, from an open "[[Tar" at the end of the line.
    const doc = 'Link: [[Tar'
    const edit = wikilinkCompletionEdit(doc, 8, doc.length, narrowed[0].label)
    expect(doc.slice(0, edit.from) + edit.insert + doc.slice(edit.to)).toBe('Link: [[Target Piece]]')
  })
})

describe('Stubs on disk', () => {
  test('a dead Idea Link in a collection with an ideas folder is seeded there, titled by its heading, with a backlink', async () => {
    const source = 'A useful thought about [[The gestalt and the frame.md]].'
    await put({ 'source.md': piece('Source', source), 'second.md': piece('Second'), 'ideas/.keep': '' })
    const [link] = wikilinkRanges(source, [])
    const seed = materialiseSeed(source, link)
    expect(seed).toEqual({ title: 'The gestalt and the frame', gist: 'A useful thought about The gestalt and the frame.' })
    const preview = await previewCollectionStub(ws, { dir: '', title: seed.title, gist: seed.gist, from: 'source.md' })
    expect(preview.path).toBe('ideas/the-gestalt-and-the-frame.md') // what the pane shows before it writes

    const created = await createCollectionStub(ws, { dir: '', title: seed.title, gist: seed.gist, from: 'source.md' })
    expect(created.created && created.path).toBe('ideas/the-gestalt-and-the-frame.md')
    const stub = await readFile(join(root, 'ideas/the-gestalt-and-the-frame.md'), 'utf8')
    expect(stub).toContain('status: idea')
    expect(stub).toContain('description: "A useful thought about The gestalt and the frame."')
    expect(stub).not.toMatch(/^title:/m) // ADR-0034: the title is derived from the heading
    expect(stub).toContain('# The gestalt and the frame')
    expect(stub).toMatch(/^date:/m)
    expect(stub).toMatch(/^tags:/m)
    expect(stub).toContain('Backlink: [[Source]].')
    expect((await linksFrom('source.md'))[0].to).toBe('ideas/the-gestalt-and-the-frame.md')
  })

  test('Capture writes a Stub whose description keeps the gist\'s line break, in the root when there is no ideas folder', async () => {
    await put({
      'source.md': piece('The Distant Mirrors', 'The sentence where the idea struck. See [[The unwritten and the unwriteable rules]].'),
      'second.md': piece('Second'),
    })
    const title = 'The unwritten and the unwriteable rules'
    const gist = 'strike to rule;\nhigh and low context cultures'
    const created = await createCollectionStub(ws, { dir: '', title, gist })
    expect(created.created && created.path).toBe('the-unwritten-and-the-unwriteable-rules.md')
    const stub = await readFile(join(root, 'the-unwritten-and-the-unwriteable-rules.md'), 'utf8')
    expect(stub).toContain('status: idea')
    expect(stub).toContain('description: "strike to rule;\\nhigh and low context cultures"')
    expect((await linksFrom('source.md'))[0].to).toBe('the-unwritten-and-the-unwriteable-rules.md') // the captured link goes live
  })

  test('a title that already exists is reported with the existing Piece and nothing is written, unless creating anyway', async () => {
    await put({
      'source.md': piece('Source'),
      'existing.md': '---\ntitle: Same idea\nstatus: idea\ndescription: existing\n---\n\n# Same idea\n',
    })
    const preview = await previewCollectionStub(ws, { dir: '', title: 'Same idea', gist: 'A separate angle' })
    expect(preview.existing).toEqual(['existing.md']) // "already exists": Open it instead / keep this as a separate idea
    expect(await createCollectionStub(ws, { dir: '', title: 'Same idea', gist: 'A separate angle' })).toEqual({ created: false, existing: ['existing.md'] })
    expect(existsSync(join(root, 'same-idea.md'))).toBe(false)

    const anyway = await createCollectionStub(ws, { dir: '', title: 'Same idea', gist: 'A separate angle', createAnyway: true })
    expect(anyway.created && anyway.path).toBe('same-idea.md')
  })

  test('a bare folder degrades to plain Markdown with no frontmatter', async () => {
    const source = '# Source\n\nA bare [[Plain idea]] link.\n'
    await put({ 'source.md': source })
    const [link] = wikilinkRanges(source, [])
    const seed = materialiseSeed(source, link)
    const preview = await previewCollectionStub(ws, { dir: '', title: seed.title, gist: seed.gist, from: 'source.md' })
    expect(preview.explanation).toContain('plain Markdown')
    const created = await createCollectionStub(ws, { dir: '', title: seed.title, gist: seed.gist, from: 'source.md' })
    expect(created.created && created.path).toBe('plain-idea.md')
    const stub = await readFile(join(root, 'plain-idea.md'), 'utf8')
    expect(stub.startsWith('---')).toBe(false)
    expect(stub).toContain('# Plain idea')
  })
})

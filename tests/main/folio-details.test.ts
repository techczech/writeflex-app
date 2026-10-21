import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { documentSaveSeams } from '../../src/main/guarded-document-write'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { detailsInHeader, forgetFolioDetailUndoRecords, readFolioDetails, setFolioDetail, undoFolioDetail, withFolioDetail } from '../../src/main/folio-details'
import { registerFolioDetailsIpc } from '../../src/main/folio-details-ipc'
import { workspaceDetailValues } from '../../src/main/folio-detail-values'
import { parseFrontmatter } from '../../src/main/frontmatter'
import { FOLIO_DETAIL_STALE_UNDO, folioDetailValueRefusal, normaliseFolioDetailValue, statusPickerLanes, type FolioDetailAnswer, type FolioDetailUndoAnswer, type FolioDetailsRead } from '../../src/shared/folio-details'

// The Folio outline's Details card (0.26 ticket 4): one main-side write for the seven fields, into the Folio's
// Index Note header, only over the text the card read; and its Undo by token.

let root: string
let ws: Workspace
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-folio-details-'))
  ws = new Workspace(root)
  forgetFolioDetailUndoRecords()
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const put = async (rel: string, content: string): Promise<void> => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content)
}
const disk = (rel: string): Promise<string> => readFile(join(root, rel), 'utf8')

const INDEX = 'book/_book_INDEX.md'
const INDEX_TEXT = '---\ntitle: "Book: a test"\n# kept comment\nstatus: draft\ntags: [a, b]\n---\n\n# Book\n\n## Running order\n\n- [[One]]\n'

test('adding, replacing and removing a key changes only that key’s line', () => {
  const added = withFolioDetail(INDEX_TEXT, 'standfirst', 'A short line.')
  expect(added).toBe(INDEX_TEXT.replace('tags: [a, b]\n', 'tags: [a, b]\nstandfirst: A short line.\n'))
  const replaced = withFolioDetail(added, 'status', 'ready')
  expect(replaced).toBe(added.replace('status: draft\n', 'status: ready\n'))
  expect(withFolioDetail(replaced, 'standfirst', null)).toBe(INDEX_TEXT.replace('status: draft\n', 'status: ready\n'))
  // Removing a key that is not there changes nothing.
  expect(withFolioDetail(INDEX_TEXT, 'language', null)).toBe(INDEX_TEXT)
})

test('a CRLF Index Note keeps its line endings and every other byte', () => {
  const crlf = INDEX_TEXT.replace(/\n/g, '\r\n')
  const added = withFolioDetail(crlf, 'standfirst', 'Under the title.')
  expect(added).toBe(crlf.replace('tags: [a, b]\r\n', 'tags: [a, b]\r\nstandfirst: Under the title.\r\n'))
  expect(withFolioDetail(added, 'standfirst', null)).toBe(crlf)
  expect(withFolioDetail(crlf, 'title', 'New')).toBe(crlf.replace('title: "Book: a test"\r\n', 'title: New\r\n'))
})

test('an Index Note with no header gains a minimal one; when its only key goes the body is kept byte for byte', () => {
  const bare = '# Book\n\n## Running order\n\n- [[One]]\n'
  const added = withFolioDetail(bare, 'standfirst', 'One line.')
  expect(added).toBe(`---\nstandfirst: One line.\n---\n\n${bare}`)
  // The body is kept byte for byte: the blank line the header brought stays, as it is the body's own first line.
  expect(withFolioDetail(added, 'standfirst', null)).toBe(`\n${bare}`)
  const spaced = '---\ntitle: Old\n---\n\nBody\n'
  expect(withFolioDetail(spaced, 'title', null)).toBe('\nBody\n')
  expect(withFolioDetail('\uFEFF---\ntitle: Old\n---\nBody\n', 'title', null)).toBe('\uFEFFBody\n')
})

test('values with colons, quotes, hashes, line breaks and YAML words round-trip through the app’s reader on one line', () => {
  const values = [
    'Pangram evaluation: proposal and proof of concept',
    'She said "no" and it\'s fine',
    'Two lines\nof standfirst',
    'A # not a comment',
    '- leading dash',
    'yes',
    '[not a list]',
    '2026-10-14',
    'Ünïcödé — dash',
  ]
  for (const value of values) {
    const text = withFolioDetail(INDEX_TEXT, 'standfirst', value)
    const block = text.slice(0, text.indexOf('\n---\n') + 5)
    // Still one line per key: the header has exactly one more line than before.
    expect(block.split('\n').length).toBe(INDEX_TEXT.slice(0, INDEX_TEXT.indexOf('\n---\n') + 5).split('\n').length + 1)
    expect(parseFrontmatter(text)?.extra.standfirst).toBe(value)
    expect(detailsInHeader(text).standfirst).toBe(value)
    expect(text.endsWith('\n# Book\n\n## Running order\n\n- [[One]]\n')).toBe(true)
  }
})

test('a value is cleaned before it is written: line breaks of any kind, control characters, ends; empty is a removal', () => {
  expect(normaliseFolioDetailValue('  a\r\nb\u2028c\u0007  ')).toBe('a\nb\nc')
  expect(normaliseFolioDetailValue('   ')).toBeNull()
  expect(normaliseFolioDetailValue(null)).toBeNull()
})

test('a write lands over the version read, returns the new text and a token, and Undo restores exactly', async () => {
  await put(INDEX, INDEX_TEXT)
  const checkpoints: string[] = []
  const answer = await setFolioDetail(ws, 'book', { field: 'standfirst', value: 'One or two sentences: for the cover.', basis: INDEX_TEXT }, { beforeIndexWrite: async (path) => { checkpoints.push(path); expect(await disk(path)).toBe(INDEX_TEXT) } }) as Extract<FolioDetailAnswer, { ok: true }>
  expect(answer.ok).toBe(true)
  expect(answer.changed).toBe(true)
  expect(answer.indexPath).toBe(INDEX)
  expect(checkpoints).toEqual([INDEX])
  const after = await disk(INDEX)
  expect(after).toBe(answer.text)
  expect(after).toBe(INDEX_TEXT.replace('tags: [a, b]\n', 'tags: [a, b]\nstandfirst: "One or two sentences: for the cover."\n'))
  const undone = await undoFolioDetail(ws, 'book', answer.undoToken)
  expect(undone).toEqual({ ok: true, indexPath: INDEX, text: INDEX_TEXT })
  expect(await disk(INDEX)).toBe(INDEX_TEXT)
  // A token is used once.
  expect(await undoFolioDetail(ws, 'book', answer.undoToken)).toMatchObject({ ok: false, refused: 'stale', message: FOLIO_DETAIL_STALE_UNDO })
})

test('a value the file already holds writes nothing and gives no token', async () => {
  await put(INDEX, INDEX_TEXT)
  const checkpoints: string[] = []
  const answer = await setFolioDetail(ws, 'book', { field: 'status', value: 'draft', basis: INDEX_TEXT }, { beforeIndexWrite: async (path) => { checkpoints.push(path) } })
  expect(answer).toEqual({ ok: true, changed: false, undoToken: null, indexPath: INDEX, text: INDEX_TEXT })
  expect(checkpoints).toEqual([])
})

test('a basis that is not the file on disk is refused, and nothing is written', async () => {
  await put(INDEX, INDEX_TEXT)
  const seen = INDEX_TEXT.replace('draft', 'idea')
  const answer = await setFolioDetail(ws, 'book', { field: 'standfirst', value: 'x', basis: seen })
  expect(answer).toMatchObject({ ok: false, refused: 'disk-changed', text: INDEX_TEXT })
  expect(await disk(INDEX)).toBe(INDEX_TEXT)
  // No basis at all is refused too.
  expect(await setFolioDetail(ws, 'book', { field: 'standfirst', value: 'x', basis: undefined })).toMatchObject({ ok: false, refused: 'invalid' })
  expect(await disk(INDEX)).toBe(INDEX_TEXT)
})

test('a change on disk between the checkpoint and the rename is refused in the rename tick', async () => {
  await put(INDEX, INDEX_TEXT)
  const outside = `${INDEX_TEXT}Outside line.\n`
  const answer = await setFolioDetail(ws, 'book', { field: 'standfirst', value: 'x', basis: INDEX_TEXT }, { beforeIndexWrite: async () => { await writeFile(join(root, INDEX), outside) } })
  expect(answer).toMatchObject({ ok: false, refused: 'disk-changed' })
  expect(await disk(INDEX)).toBe(outside)
})

test('Undo after an outside edit is refused, and the outside edit stays', async () => {
  await put(INDEX, INDEX_TEXT)
  const answer = await setFolioDetail(ws, 'book', { field: 'title', value: 'Another title', basis: INDEX_TEXT }) as Extract<FolioDetailAnswer, { ok: true }>
  const edited = `${answer.text}Typed in the editor.\n`
  await writeFile(join(root, INDEX), edited)
  expect(await undoFolioDetail(ws, 'book', answer.undoToken)).toMatchObject({ ok: false, refused: 'stale' })
  expect(await disk(INDEX)).toBe(edited)
  // An unknown token, and another Folio's token, are refused the same way.
  expect(await undoFolioDetail(ws, 'book', 'not-a-token')).toMatchObject({ ok: false, refused: 'stale' })
  await put('other/_other_INDEX.md', '# Other\n')
  expect(await undoFolioDetail(ws, 'other', answer.undoToken)).toMatchObject({ ok: false, refused: 'stale' })
  expect(await disk('other/_other_INDEX.md')).toBe('# Other\n')
})

test('two changes undo one at a time, newest first', async () => {
  await put(INDEX, INDEX_TEXT)
  const first = await setFolioDetail(ws, 'book', { field: 'title', value: 'First', basis: INDEX_TEXT }) as Extract<FolioDetailAnswer, { ok: true }>
  const second = await setFolioDetail(ws, 'book', { field: 'standfirst', value: 'Second', basis: first.text }) as Extract<FolioDetailAnswer, { ok: true }>
  // The older change cannot be undone first: the file does not hold what it left.
  expect(await undoFolioDetail(ws, 'book', first.undoToken)).toMatchObject({ ok: false, refused: 'stale' })
  expect(await undoFolioDetail(ws, 'book', second.undoToken)).toMatchObject({ ok: true, text: first.text })
  expect(await undoFolioDetail(ws, 'book', first.undoToken)).toMatchObject({ ok: true, text: INDEX_TEXT })
  expect(await disk(INDEX)).toBe(INDEX_TEXT)
})

test('a Folio with no Index Note is refused and none is created; a hidden folder is not a Folio', async () => {
  await put('loose/a.md', '# A\n')
  expect(await setFolioDetail(ws, 'loose', { field: 'standfirst', value: 'x', basis: '' })).toMatchObject({ ok: false, refused: 'no-index-note' })
  expect(existsSync(join(root, 'loose/_loose_INDEX.md'))).toBe(false)
  expect(await readFolioDetails(ws, 'loose')).toMatchObject({ ok: false, refused: 'no-index-note' })
  await put('.writeflex/_.writeflex_INDEX.md', '# Hidden\n')
  expect(await setFolioDetail(ws, '.writeflex', { field: 'standfirst', value: 'x', basis: '# Hidden\n' })).toMatchObject({ ok: false, refused: 'outside' })
  expect(await disk('.writeflex/_.writeflex_INDEX.md')).toBe('# Hidden\n')
})

test('a field that is not one of the seven, or a value that is not text, is refused', async () => {
  await put(INDEX, INDEX_TEXT)
  expect(await setFolioDetail(ws, 'book', { field: 'tags', value: 'x', basis: INDEX_TEXT })).toMatchObject({ ok: false, refused: 'invalid' })
  expect(await setFolioDetail(ws, 'book', { field: 'title', value: 3, basis: INDEX_TEXT })).toMatchObject({ ok: false, refused: 'invalid' })
  expect(await setFolioDetail(ws, 'book', { field: 'title', value: 'x'.repeat(5000), basis: INDEX_TEXT })).toMatchObject({ ok: false, refused: 'invalid' })
  expect(await disk(INDEX)).toBe(INDEX_TEXT)
})

test('a header the strict writer cannot change safely is refused with nothing written', async () => {
  const odd = '---\ntitle: x\nstandfirst: |\n  block text\n---\n# Book\n'
  await put(INDEX, odd)
  expect(await setFolioDetail(ws, 'book', { field: 'standfirst', value: 'y', basis: odd })).toMatchObject({ ok: false, refused: 'unwritable' })
  expect(await disk(INDEX)).toBe(odd)
})

test('the card shows the Index Note’s values, and the title page’s where the Index Note says nothing', async () => {
  await put(INDEX, '---\ntitle: The Book\nstatus: draft-for-review\n---\n\n# Book\n\n## Running order\n\n- [[Title page]] #front-matter\n- [[One]]\n')
  await put('book/00-title.md', '---\ntitle: Title page\nrole: title-matter\nauthor: Dominik Lukeš\ndate: 2026-10-14\naudience: [Committee, Readers]\nstatus: ignored\n---\nByline.\n')
  await put('book/one.md', '# One\n')
  const read = await readFolioDetails(ws, 'book') as Extract<FolioDetailsRead, { ok: true }>
  expect(read.ok).toBe(true)
  expect(read.titlePagePath).toBe('book/00-title.md')
  expect(read.fields.title).toEqual({ value: 'The Book', from: 'index' })
  expect(read.fields.status).toEqual({ value: 'draft-for-review', from: 'index' })
  expect(read.fields.author).toEqual({ value: 'Dominik Lukeš', from: 'title-page' })
  expect(read.fields.date).toEqual({ value: '2026-10-14', from: 'title-page' })
  expect(read.fields.audience).toEqual({ value: 'Committee, Readers', from: 'title-page' })
  expect(read.fields.standfirst).toEqual({ value: null, from: null })
  expect(read.text).toBe(await disk(INDEX))
})

// ---- The IPC seam ----------------------------------------------------------------------------------------------

function harness() {
  const handlers = new Map<string, (event: { sender: { id: number } }, input: unknown) => unknown>()
  const checkpoints: string[] = []
  const collection: string[][] = []
  const onDisk: string[][] = []
  registerFolioDetailsIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    stateForSender: () => ({}),
    requireWorkspace: () => ws,
    checkpointFile: async (_state, path) => { checkpoints.push(path) },
    notifyCollectionChanged: (_state, paths) => collection.push(paths),
    notifyChangedOnDisk: (_state, paths) => onDisk.push(paths),
  })
  const invoke = async <T,>(channel: string, input: unknown): Promise<T> => handlers.get(channel)!({ sender: { id: 1 } }, input) as Promise<T>
  return { handlers, checkpoints, collection, onDisk, invoke }
}

test('the IPC seam registers four channels and tells the collection and open buffers after a write and an Undo', async () => {
  await put(INDEX, INDEX_TEXT)
  const api = harness()
  expect([...api.handlers.keys()]).toEqual(['folio:read-details', 'folio:detail-values', 'folio:set-detail', 'folio:undo-detail'])
  const read = await api.invoke<Extract<FolioDetailsRead, { ok: true }>>('folio:read-details', { dir: 'book' })
  const set = await api.invoke<Extract<FolioDetailAnswer, { ok: true }>>('folio:set-detail', { dir: 'book', field: 'standfirst', value: 'Typed.', basis: read.text })
  expect(set.ok).toBe(true)
  expect(api.checkpoints).toEqual([INDEX])
  expect(api.collection).toEqual([[INDEX]])
  expect(api.onDisk).toEqual([[INDEX]])
  const undone = await api.invoke<FolioDetailUndoAnswer>('folio:undo-detail', { dir: 'book', token: set.undoToken })
  expect(undone.ok).toBe(true)
  expect(api.onDisk).toEqual([[INDEX], [INDEX]])
  expect(await disk(INDEX)).toBe(INDEX_TEXT)
  // A refusal tells nobody.
  await api.invoke('folio:set-detail', { dir: 'book', field: 'standfirst', value: 'x', basis: 'stale' })
  expect(api.onDisk).toHaveLength(2)
})

test('the renderer cannot name a file: a path in the request is ignored, and a folder outside the Workspace is refused', async () => {
  await put(INDEX, INDEX_TEXT)
  await put('notes/target.md', '---\ntitle: Target\n---\nBody.\n')
  const api = harness()
  const set = await api.invoke<FolioDetailAnswer>('folio:set-detail', { dir: 'book', path: 'notes/target.md', indexPath: 'notes/target.md', field: 'standfirst', value: 'x', basis: INDEX_TEXT })
  expect(set).toMatchObject({ ok: true, indexPath: INDEX })
  expect(await disk('notes/target.md')).toBe('---\ntitle: Target\n---\nBody.\n')
  for (const dir of ['../outside', '/etc', 'book\\..\\..', 'book/../../x', 42, undefined]) {
    expect(await api.invoke<FolioDetailAnswer>('folio:set-detail', { dir, field: 'standfirst', value: 'x', basis: '' })).toMatchObject({ ok: false, refused: 'outside' })
    expect(await api.invoke<FolioDetailsRead>('folio:read-details', { dir })).toMatchObject({ ok: false })
  }
  // A folder that names a file is not a Folio.
  expect(await api.invoke<FolioDetailAnswer>('folio:set-detail', { dir: 'notes/target.md', field: 'standfirst', value: 'x', basis: '' })).toMatchObject({ ok: false })
  expect(await disk('notes/target.md')).toBe('---\ntitle: Target\n---\nBody.\n')
})

// ---- Pickers (0.26 ticket 5) -------------------------------------------------------------------------------------

test('a date is a real calendar date, a status is a lane the Board can read, a name is one line', async () => {
  await put(INDEX, INDEX_TEXT)
  expect(folioDetailValueRefusal('date', '2026-10-14')).toBeNull()
  expect(folioDetailValueRefusal('date', '14 Oct 2026')).not.toBeNull()
  expect(folioDetailValueRefusal('date', '2026-02-30')).not.toBeNull()
  expect(folioDetailValueRefusal('status', 'draft-for-review')).toBeNull()
  expect(folioDetailValueRefusal('status', '"quoted')).not.toBeNull()
  expect(folioDetailValueRefusal('status', 'a: b')).not.toBeNull()
  expect(folioDetailValueRefusal('author', 'Two\nlines')).not.toBeNull()
  expect(folioDetailValueRefusal('language', 'x'.repeat(201))).not.toBeNull()
  expect(folioDetailValueRefusal('standfirst', 'Two\nlines')).toBeNull()
  expect(folioDetailValueRefusal('date', null)).toBeNull()
  // Through the one write: refused with nothing written.
  expect(await setFolioDetail(ws, 'book', { field: 'date', value: 'last Tuesday', basis: INDEX_TEXT })).toMatchObject({ ok: false, refused: 'invalid' })
  expect(await setFolioDetail(ws, 'book', { field: 'status', value: 'a: b', basis: INDEX_TEXT })).toMatchObject({ ok: false, refused: 'invalid' })
  expect(await disk(INDEX)).toBe(INDEX_TEXT)
  const written = await setFolioDetail(ws, 'book', { field: 'date', value: '2026-10-14', basis: INDEX_TEXT }) as Extract<FolioDetailAnswer, { ok: true }>
  expect(written.text).toBe(INDEX_TEXT.replace('tags: [a, b]\n', 'tags: [a, b]\ndate: 2026-10-14\n'))
  expect(detailsInHeader(written.text).date).toBe('2026-10-14')
})

test('every picked field is written as one line and undone exactly, and "No status" takes the key out', async () => {
  await put(INDEX, INDEX_TEXT)
  const status = await setFolioDetail(ws, 'book', { field: 'status', value: 'ready', basis: INDEX_TEXT }) as Extract<FolioDetailAnswer, { ok: true }>
  expect(status.text).toBe(INDEX_TEXT.replace('status: draft\n', 'status: ready\n'))
  const author = await setFolioDetail(ws, 'book', { field: 'author', value: 'Dominik Lukeš', basis: status.text }) as Extract<FolioDetailAnswer, { ok: true }>
  const language = await setFolioDetail(ws, 'book', { field: 'language', value: 'cs', basis: author.text }) as Extract<FolioDetailAnswer, { ok: true }>
  const none = await setFolioDetail(ws, 'book', { field: 'status', value: null, basis: language.text }) as Extract<FolioDetailAnswer, { ok: true }>
  expect(detailsInHeader(none.text)).toMatchObject({ status: null, author: 'Dominik Lukeš', language: 'cs' })
  expect(none.text).not.toContain('status:')
  expect(await undoFolioDetail(ws, 'book', none.undoToken)).toMatchObject({ ok: true, text: language.text })
  expect(await undoFolioDetail(ws, 'book', language.undoToken)).toMatchObject({ ok: true, text: author.text })
})

test('the Status picker lists the Board lanes, then this Folio’s own lane when it is none of them', () => {
  expect(statusPickerLanes(null)).toEqual({ board: ['idea', 'note gathering', 'in progress', 'editing', 'ready', 'published'], own: null })
  expect(statusPickerLanes('Ready').own).toBeNull()
  expect(statusPickerLanes('draft-for-review').own).toBe('draft-for-review')
})

test('the pickers offer the values other files use, most used first, you first for Author, one count per file', async () => {
  await put('a.md', '---\nauthor: Dominik Lukes\naudience: [Committee, Readers]\nlanguage: en\n---\nA\n')
  await put('b.md', '---\nauthor: Dominik Lukes\naudience: Committee\nlanguage: cs\n---\nB\n')
  await put('c/c.md', '---\nauthor: Dominik Lukeš\nlanguage: en\n---\nC\n')
  await put('d.md', '---\nauthor: [Dominik Lukes, Dominik Lukes]\n---\nD\n')
  await put('e.md', 'No header.\n')
  const values = await workspaceDetailValues(ws, 'Dominik Lukeš')
  expect(values.you).toBe('Dominik Lukeš')
  expect(values.author).toEqual([{ value: 'Dominik Lukeš', count: 1 }, { value: 'Dominik Lukes', count: 3 }])
  expect(values.audience).toEqual([{ value: 'Committee', count: 2 }, { value: 'Readers', count: 1 }])
  expect(values.language).toEqual([{ value: 'en', count: 2 }, { value: 'cs', count: 1 }])
  // You are offered first even when no file names you yet, and no one is offered when there is no name.
  expect((await workspaceDetailValues(ws, 'Someone New')).author[0]).toEqual({ value: 'Someone New', count: 0 })
  expect((await workspaceDetailValues(ws, null)).author[0]).toEqual({ value: 'Dominik Lukes', count: 3 })
})

test('the values channel is read-only: it writes nothing and names no folder', async () => {
  await put(INDEX, INDEX_TEXT)
  const api = harness()
  expect([...api.handlers.keys()]).toContain('folio:detail-values')
  const answer = await api.invoke<{ ok: boolean; author: Array<{ value: string }> }>('folio:detail-values', { dir: '../outside' })
  expect(answer.ok).toBe(true)
  expect(await disk(INDEX)).toBe(INDEX_TEXT)
  expect(api.onDisk).toEqual([])
})

// ---- Review fixes (Sol round 1) -----------------------------------------------------------------------------------

test('a folder that is a symbolic link to a Folio is not the Folio: nothing is read or written through it', async () => {
  await put(INDEX, INDEX_TEXT)
  // `alias/_alias_INDEX.md` is, in the real folder, an ordinary part named like an Index Note would be.
  const part = '---\ntitle: A part\n---\nPart text.\n'
  await put('book/_alias_INDEX.md', part)
  await symlink(join(root, 'book'), join(root, 'alias'))
  expect(await setFolioDetail(ws, 'alias', { field: 'standfirst', value: 'x', basis: part })).toMatchObject({ ok: false, refused: 'outside' })
  expect(await readFolioDetails(ws, 'alias')).toMatchObject({ ok: false, refused: 'outside' })
  expect(await disk('book/_alias_INDEX.md')).toBe(part)
  // The real folder, and its letter-case spelling on a volume that ignores case, still work.
  expect(await readFolioDetails(ws, 'book')).toMatchObject({ ok: true })
})

// ---- Review fixes (Sol round 2) -----------------------------------------------------------------------------------

/** Puts a link to `other` where the Folio folder `book` stood (the real folder kept aside as `book-real`). */
const swapBookForLinkToOther = async (): Promise<void> => {
  await rename(join(root, 'book'), join(root, 'book-real'))
  await symlink(join(root, 'other'), join(root, 'book'))
}

test('the Folio folder swapped for a link while the checkpoint is awaited: refused, the other folder untouched', async () => {
  await put(INDEX, INDEX_TEXT)
  // The other folder holds a file of the same name and the same text, so the basis check alone would pass.
  await put('other/_book_INDEX.md', INDEX_TEXT)
  const answer = await setFolioDetail(ws, 'book', { field: 'title', value: 'Hijacked', basis: INDEX_TEXT }, { beforeIndexWrite: swapBookForLinkToOther })
  expect(answer).toMatchObject({ ok: false, refused: 'outside' })
  expect(await disk('other/_book_INDEX.md')).toBe(INDEX_TEXT)
  expect(await disk('book-real/_book_INDEX.md')).toBe(INDEX_TEXT)
})

test('the Folio folder replaced by another folder of the same name inside the write: refused in the rename tick', async () => {
  await put(INDEX, INDEX_TEXT)
  // After the write judged the folder, `book` is moved aside and a new folder takes its name, holding a file of the
  // same name and text: the real path is spelled the same, only the folder's identity tells them apart.
  documentSaveSeams.betweenCheckAndWrite = async () => {
    await rename(join(root, 'book'), join(root, 'book-real'))
    await put(INDEX, INDEX_TEXT)
  }
  try {
    const answer = await setFolioDetail(ws, 'book', { field: 'title', value: 'Hijacked', basis: INDEX_TEXT })
    expect(answer).toMatchObject({ ok: false, refused: 'outside' })
  } finally {
    delete documentSaveSeams.betweenCheckAndWrite
  }
  expect(await disk(INDEX)).toBe(INDEX_TEXT)
  expect(await disk('book-real/_book_INDEX.md')).toBe(INDEX_TEXT)
  expect((await readdir(join(root, 'book'))).filter((name) => name.endsWith('.tmp'))).toEqual([])
})

test('an Undo whose Folio folder is swapped for a link while the checkpoint is awaited is refused', async () => {
  await put(INDEX, INDEX_TEXT)
  const answer = await setFolioDetail(ws, 'book', { field: 'title', value: 'New', basis: INDEX_TEXT }) as Extract<FolioDetailAnswer, { ok: true }>
  await put('other/_book_INDEX.md', answer.text)
  expect(await undoFolioDetail(ws, 'book', answer.undoToken, { beforeIndexWrite: swapBookForLinkToOther })).toMatchObject({ ok: false, refused: 'outside' })
  expect(await disk('other/_book_INDEX.md')).toBe(answer.text)
})

test('removing the last key keeps a body that itself begins with a header fence from being read as the header', () => {
  // Sol round 2, finding 3: this exact case lost the body's first line break and then read `foo: bar` as metadata.
  const text = '---\ntitle: Old\n---\n\n---\nfoo: bar\n---\nBody\n'
  const removed = withFolioDetail(text, 'title', null)
  expect(removed).toBe('\n---\nfoo: bar\n---\nBody\n')
  expect(parseFrontmatter(removed)).toBeNull()
  // A body that starts right at a fence keeps an empty header in front of it; the body's lines are not metadata.
  const tight = '---\ntitle: Old\n---\n---\nfoo: bar\n---\nBody\n'
  const kept = withFolioDetail(tight, 'title', null)
  expect(kept).toBe('---\n---\n---\nfoo: bar\n---\nBody\n')
  expect(parseFrontmatter(kept)?.extra.foo).toBeUndefined()
  expect(withFolioDetail(tight.replace(/\n/g, '\r\n'), 'title', null)).toBe('---\r\n---\r\n---\r\nfoo: bar\r\n---\r\nBody\r\n')
})

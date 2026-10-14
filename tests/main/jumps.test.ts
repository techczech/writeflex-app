import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace, type FileReadResult, type MarkdownFile } from '../../src/main/workspace'
import { scanText, scanFolder } from '../../src/main/jumps'

// Task 9: the jumps scanner organ. `scanText` is pure; the exact rules (from the brief) are:
//   bookmark = /^\s*\/\/@\s*(.+)$/            text = capture
//   comment  = a `//` line that is NOT a bookmark   text = line minus the `//` prefix, trimmed, ≤120
//   task     = /^\s*[-*] \[( |x)\] (.+)$/     done = capture is 'x'
// Fenced code blocks (``` or ~~~) are skipped — a `//` line inside a fence is real code (the T7
// semantics contract, shared with word-count's fence scanner).

test('scanText: bookmark line captures its text, not double-counted as a comment', () => {
  const entries = scanText('//@ the clockwork universe\n')
  expect(entries).toEqual([{ kind: 'bookmark', line: 1, text: 'the clockwork universe' }])
})

test('scanText: a plain // line is a comment with the prefix stripped and trimmed', () => {
  const entries = scanText('//   check the shoggoth attribution  \n')
  expect(entries).toEqual([{ kind: 'comment', line: 1, text: 'check the shoggoth attribution' }])
})

test('scanText: an indented // line is still a comment', () => {
  expect(scanText('   // note here\n')).toEqual([{ kind: 'comment', line: 1, text: 'note here' }])
})

test('scanText: comment text is capped at 120 characters', () => {
  const long = 'x'.repeat(200)
  const [entry] = scanText(`// ${long}\n`)
  expect(entry.kind).toBe('comment')
  expect(entry.text).toHaveLength(120)
})

test('scanText: tasks capture their text and done state', () => {
  const entries = scanText('- [ ] add the copilot example\n* [x] find the page numbers\n')
  expect(entries).toEqual([
    { kind: 'task', line: 1, text: 'add the copilot example', done: false },
    { kind: 'task', line: 2, text: 'find the page numbers', done: true },
  ])
})

test('scanText: line numbers are 1-based and track position across a mixed document', () => {
  const doc = '# Heading\n\n//@ marker\nprose line\n// note\n\n- [ ] todo\n'
  expect(scanText(doc)).toEqual([
    { kind: 'bookmark', line: 3, text: 'marker' },
    { kind: 'comment', line: 5, text: 'note' },
    { kind: 'task', line: 7, text: 'todo', done: false },
  ])
})

test('scanText: fenced code blocks are immune — // and //@ inside a fence are code, not annotations', () => {
  const doc = '// real comment\n```js\n//@ not a bookmark\n// not a comment\n- [ ] not a task\n```\n// after fence\n'
  expect(scanText(doc)).toEqual([
    { kind: 'comment', line: 1, text: 'real comment' },
    { kind: 'comment', line: 7, text: 'after fence' },
  ])
})

test('scanText: ~~~ fences are honoured too', () => {
  const doc = '~~~\n// inside tilde fence\n~~~\n//@ outside\n'
  expect(scanText(doc)).toEqual([{ kind: 'bookmark', line: 4, text: 'outside' }])
})

test('scanText: fence marker info strings do not leak as annotations', () => {
  expect(scanText('```//@ looks-like-a-bookmark\ncode\n```\n')).toEqual([])
})

// ---- heading rule (Task 10: folder scope) ----
// scanText gains an OPT-IN heading rule so folder scope can list each file's ATX headings alongside
// its jumps. The rule is `/^(#{1,6})\s+(.+)$/` — level = the hash count, text = the remainder, trimmed.
// Opt-in so file scope (which derives headings from the Lezer parser, not this scanner) is unaffected.

test('scanText: headings are NOT emitted unless asked for — file scope stays jump-only', () => {
  expect(scanText('# Title\n')).toEqual([])
})

test('scanText: with headings, an ATX line yields a heading whose level is its hash count', () => {
  expect(scanText('## The engine and the mirror\n', { headings: true })).toEqual([
    { kind: 'heading', line: 1, text: 'The engine and the mirror', level: 2 },
  ])
})

test('scanText: heading levels run 1..6 and the text is trimmed', () => {
  expect(scanText('# One\n######   Six  \n', { headings: true })).toEqual([
    { kind: 'heading', line: 1, text: 'One', level: 1 },
    { kind: 'heading', line: 2, text: 'Six', level: 6 },
  ])
})

test('scanText: a hash without a following space is not a heading', () => {
  expect(scanText('#nospace\n', { headings: true })).toEqual([])
})

test('scanText: seven or more hashes is not a heading', () => {
  expect(scanText('####### too deep\n', { headings: true })).toEqual([])
})

test('scanText: headings inside a fence are code, never headings', () => {
  const doc = '# real\n```\n# fenced\n```\n# also real\n'
  expect(scanText(doc, { headings: true })).toEqual([
    { kind: 'heading', line: 1, text: 'real', level: 1 },
    { kind: 'heading', line: 5, text: 'also real', level: 1 },
  ])
})

test('scanText: headings and jumps interleave in line order under the headings option', () => {
  const doc = '# Alpha\n//@ marker\n## Beta\n- [ ] todo\n'
  expect(scanText(doc, { headings: true })).toEqual([
    { kind: 'heading', line: 1, text: 'Alpha', level: 1 },
    { kind: 'bookmark', line: 2, text: 'marker' },
    { kind: 'heading', line: 3, text: 'Beta', level: 2 },
    { kind: 'task', line: 4, text: 'todo', done: false },
  ])
})

// ---- scanFolder ----
let root: string
let ws: Workspace
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-jumps-'))
  ws = new Workspace(root)
  await writeFile(join(root, 'alpha.md'), '//@ alpha bookmark\n// alpha note\n')
  await mkdir(join(root, 'notes'))
  await writeFile(join(root, 'notes', 'beta.md'), '- [x] beta done\n')
  await writeFile(join(root, 'notes', 'gamma.md'), '// gamma note\n')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test('scanFolder: aggregates every markdown file, tagging each entry with its path in path order', async () => {
  const entries = await scanFolder(ws)
  expect(entries).toEqual([
    { kind: 'bookmark', file: 'alpha.md', line: 1, text: 'alpha bookmark' },
    { kind: 'comment', file: 'alpha.md', line: 2, text: 'alpha note' },
    { kind: 'task', file: 'notes/beta.md', line: 1, text: 'beta done', done: true },
    { kind: 'comment', file: 'notes/gamma.md', line: 1, text: 'gamma note' },
  ])
})

test('scanFolder: the headings option tags heading entries with their file, in path order', async () => {
  await writeFile(join(root, 'alpha.md'), '# Alpha\n//@ mark\n')
  const entries = await scanFolder(ws, { headings: true })
  expect(entries[0]).toEqual({ kind: 'heading', file: 'alpha.md', line: 1, text: 'Alpha', level: 1 })
  expect(entries[1]).toEqual({ kind: 'bookmark', file: 'alpha.md', line: 2, text: 'mark' })
})

test('scanFolder: a subpath restricts the scan to files under that folder', async () => {
  const entries = await scanFolder(ws, { subpath: 'notes' })
  expect(entries.map((e) => e.file)).toEqual(['notes/beta.md', 'notes/gamma.md'])
})


test('scanFolder: an unreadable file is skipped and the rest still scan in path order', async () => {
  // A file can vanish or turn unreadable between the listing and the read (deleted, permission-denied,
  // symlink-guard rejection). One rejecting read must not abort the whole scan. Stub the Workspace so
  // exactly one file's readFile throws; the other two must still come back, in path order.
  const mkFile = (path: string): MarkdownFile => ({ path, name: path, directory: '', modifiedAt: 0, size: 0 })
  const stub = {
    listFiles: async () => [mkFile('a.md'), mkFile('b.md'), mkFile('c.md')],
    readFile: async (path: string): Promise<FileReadResult> => {
      if (path === 'b.md') throw new Error('EACCES: permission denied')
      return { file: mkFile(path), content: `//@ ${path} mark\n` }
    },
  } as unknown as Workspace

  const entries = await scanFolder(stub)
  expect(entries).toEqual([
    { kind: 'bookmark', file: 'a.md', line: 1, text: 'a.md mark' },
    { kind: 'bookmark', file: 'c.md', line: 1, text: 'c.md mark' },
  ])
})

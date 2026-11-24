import { expect, test } from 'bun:test'

// Through the real file:move and folder:rename handlers. Only single-line values of path keys (image, cover,
// thumbnail, banner, file, path, src, attachment, pdf, audio, video), top level or one level into a mapping, follow
// the move, written as double-quoted strings; every other byte of the front matter stays as it was.

const MOVED = [
  '---',
  'title: Draft',
  'image: ../../img/cover.png',
  'Cover: "../../img/cover one.png"   # comment',
  "thumbnail: './thumb.png'",
  "'banner': 'it''s.png'",
  'hero:',
  '  src: ../../img/cover.png',
  '  deeper:',
  '    src: ../../img/cover.png',
  'gallery:',
  '  - ../../img/cover.png',
  'poster: ../../img/cover.png',
  'missing: ../../img/none.png',
  'file: ../../../outside.png',
  'path: ../../img',
  'video: https://example.org/cover.png',
  'audio: /img/cover.png',
  'tags: [a, b]',
  '---',
  'Body ![Cover](../../img/cover.png)',
  '',
].join('\n')

const MOVED_AFTER = MOVED
  .replace('image: ../../img/cover.png', 'image: "../img/cover.png"')
  .replace('Cover: "../../img/cover one.png"   # comment', 'Cover: "../img/cover one.png"   # comment')
  .replace("thumbnail: './thumb.png'", 'thumbnail: "../papers/chapters/thumb.png"')
  .replace("'banner': 'it''s.png'", `'banner': "../papers/chapters/it's.png"`)
  .replace('  src: ../../img/cover.png\n  deeper:', '  src: "../img/cover.png"\n  deeper:')
  .replace('Body ![Cover](../../img/cover.png)', 'Body ![Cover](../img/cover.png)')

// Sol's review reproductions (rounds 1 and 2): labels sharing a file's name, block scalars (one with an anchor),
// a multi-line plain value, a flow map whose quoted text holds an escaped quote and a bracket, a list under a
// quoted key, a flow list and a multi-line flow map. None of it may change.
const UNTOUCHED = [
  '---',
  'title: Draft',
  'status: in progress',
  "'tags':",
  '  - cover.png',
  'description: &description |',
  '  image: cover.png',
  '  - keep',
  'single: |-',
  '  cover.png',
  'image: cover.png',
  '  carried on',
  'captionPath: cover.png',
  '  carried on',
  'hero: {alt: "a \\" ] b",',
  '  src: cover.png}',
  'gallery: [cover.png]',
  'banner: {',
  '  src: cover.png',
  '}',
  'cover: &c cover.png',
  'thumbnail: *c',
  '---',
  'Body',
  '',
].join('\n')

const probe = `const MOVED = ${JSON.stringify(MOVED)}\nconst UNTOUCHED = ${JSON.stringify(UNTOUCHED)}\n` + String.raw`
  import { mock } from 'bun:test'
  import { electronMainStandIn } from './tests/helpers/electron-main-stand-in.ts'
  import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'

  const root = await mkdtemp(join(tmpdir(), 'writeflex-front-matter-move-'))
  const handlers = new Map()
  void mock.module('electron', () => ({
    ...electronMainStandIn,
    app: { getPath: () => root, getVersion: () => '0.0.0-test', isPackaged: false },
    clipboard: { write: () => {} },
    dialog: {},
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) },
    shell: { openExternal: async () => {}, showItemInFolder: () => {}, trashItem: async () => {} },
  }))
  const [{ registerIpc }, { registerWindow }, { Workspace }] = await Promise.all([
    import('./src/main/ipc.ts'), import('./src/main/state.ts'), import('./src/main/workspace.ts'),
  ])
  const state = registerWindow({ webContents: { id: 17, send: () => {} }, on: () => {}, isDestroyed: () => false })
  state.workspace = new Workspace(root)
  state.agentReady = Promise.resolve({ checkpointFile: async () => {} })
  registerIpc(
    { openFolder: async () => {}, openFile: async () => {}, recents: () => [], openRecent: async () => {} },
    { modelDefaults: () => ({}), recents: () => [] },
    {},
  )
  const event = { sender: { id: 17 } }
  try {
    for (const dir of ['papers/chapters', 'papers/img', 'img', 'archive', 'old']) await mkdir(join(root, dir), { recursive: true })
    for (const file of ['img/cover.png', 'img/cover one.png', 'papers/chapters/thumb.png', "papers/chapters/it's.png", 'papers/img/inside.png']) {
      await writeFile(join(root, file), 'file')
    }
    await writeFile(join(root, 'papers/chapters/draft.md'), MOVED)
    await handlers.get('file:move')(event, { path: 'papers/chapters/draft.md', newPath: 'archive/draft.md' })
    const file = await readFile(join(root, 'archive/draft.md'), 'utf8')

    const crlf = '---\r\ntitle: Kept\r\nimage: ../../img/none.png\r\ncover:   "../../../outside.png"  \r\n---\r\nBody\r\n'
    await writeFile(join(root, 'papers/chapters/kept.md'), crlf)
    await handlers.get('file:move')(event, { path: 'papers/chapters/kept.md', newPath: 'archive/kept.md' })
    const kept = await readFile(join(root, 'archive/kept.md'), 'utf8')

    await writeFile(join(root, 'papers/chapters/folder.md'), '---\nimage: ../../papers/img/inside.png\ncover: ../../img/cover.png\n---\nBody\n')
    await handlers.get('folder:rename')(event, { path: 'papers', newName: 'renamed' })
    const folder = await readFile(join(root, 'renamed/chapters/folder.md'), 'utf8')

    for (const name of ['Draft', 'in progress', 'cover.png', 'keep', '0x10', 'false']) await writeFile(join(root, 'old', name), 'file')
    await writeFile(join(root, 'old/review.md'), UNTOUCHED)
    await handlers.get('file:move')(event, { path: 'old/review.md', newPath: 'archive/review.md' })
    const review = await readFile(join(root, 'archive/review.md'), 'utf8')

    await writeFile(join(root, 'old/type.md'), '---\ncover: ../old/0x10\nimage: ../old/false\n---\nBody\n')
    await handlers.get('folder:rename')(event, { path: 'old', newName: 'parts' })
    const typed = await readFile(join(root, 'parts/type.md'), 'utf8')
    console.log(JSON.stringify({ file, kept, crlf, folder, review, typed }))
  } finally { await rm(root, { recursive: true, force: true }) }
`

async function probeResult() {
  const child = Bun.spawn([process.execPath, '-e', probe], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code) throw new Error(err)
  return JSON.parse(out.trim().split('\n').at(-1)!)
}
let pending: ReturnType<typeof probeResult> | undefined
const run = () => pending ??= probeResult()

test('real file:move rewrites single-line path-key values, top level and one level in, as double-quoted strings', async () => {
  const { file } = await run()
  expect(file).toBe(MOVED_AFTER)
})

test('real file:move leaves a front matter that reaches no vault file byte-for-byte (CRLF)', async () => {
  const { kept, crlf } = await run()
  expect(kept).toBe(crlf)
})

test('real folder:rename rewrites front matter paths into the renamed folder only', async () => {
  const { folder } = await run()
  expect(folder).toBe('---\nimage: "../img/inside.png"\ncover: ../../img/cover.png\n---\nBody\n')
})

test('real file:move leaves labels, block scalars, multi-line values, flow collections, lists and anchors alone (PR 285 review)', async () => {
  const { review } = await run()
  expect(review).toBe(UNTOUCHED)
})

test('real folder:rename writes a path that YAML would read as a number or a Boolean as a string (PR 285 review)', async () => {
  const { typed } = await run()
  expect(typed).toBe('---\ncover: "0x10"\nimage: "false"\n---\nBody\n')
})

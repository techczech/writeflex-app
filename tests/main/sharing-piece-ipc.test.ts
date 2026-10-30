import { cleanUpScratch } from '../helpers/scratch-dirs'
// The Sharing page's IPC (src/main/sharing-piece-ipc.ts; sharing ticket 03): every channel answers only
// WriteFlex's windows; a window names pieces by their path in its own Workspace and acts only on links
// of pieces there; Open in browser opens only a link this Mac made. No answer holds a token.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerSharingPieceIpc, piecePath, SHARING_PIECE_CHANNELS } from '../../src/main/sharing-piece-ipc.ts'
import { buildShipped, removeShipped } from '../helpers/sharing-world.ts'
import { publishWorld } from '../helpers/sharing-publish-world.ts'

beforeAll(buildShipped)
afterAll(removeShipped)

test('piece paths: relative Markdown inside the Workspace only', () => {
  expect(piecePath('notes/a.md')).toBe('notes/a.md')
  expect(piecePath('../outside.md')).toBeNull()
  expect(piecePath('notes/../../outside.md')).toBeNull()
  expect(piecePath('/tmp/example-author/a.md')).toBeNull()
  expect(piecePath('notes/a.txt')).toBeNull()
  expect(piecePath(42)).toBeNull()
})

test('windows: only WriteFlex windows, only their own Workspace, only links this Mac made', async () => {
  const w = await publishWorld({ files: { 'a.md': '# A\n\nText.\n' } })
  const handlers = new Map<string, (event: { sender: { id: number } }, input?: unknown) => unknown>()
  const opened: string[] = []
  registerSharingPieceIpc({ handle: (channel, listener) => { handlers.set(channel, listener) } }, w.publisher, {
    isAppWindow: (id) => id === 1 || id === 2,
    rootFor: (id) => (id === 1 ? w.root : id === 2 ? '/somewhere/else' : null),
    openExternal: (url) => { opened.push(url) },
  })
  expect([...handlers.keys()]).toEqual([...SHARING_PIECE_CHANNELS])
  const call = (channel: string, sender: number, input?: unknown) => handlers.get(channel)!({ sender: { id: sender } }, input) as Promise<any>
  for (const channel of SHARING_PIECE_CHANNELS) expect(() => call(channel, 3, {})).toThrow('Not a WriteFlex window.')

  expect((await call('sharing:open', 1, 'a.md')).links).toHaveLength(0)
  const made = await call('sharing:make', 1, { path: 'a.md', name: 'Marta', comments: true })
  expect(made.ok).toBe(true)
  const shareId = made.shareId as string
  expect((await call('sharing:piece', 1, 'a.md')).links).toHaveLength(1)
  // Window 2 has another Workspace: it sees nothing and can do nothing to the link.
  expect((await call('sharing:piece', 2, 'a.md')).links).toHaveLength(0)
  await call('sharing:open', 2, 'a.md')
  expect((await call('sharing:turn-off', 2, { shareId })).ok).toBe(false)
  expect(await call('sharing:open-link', 2, { shareId })).toBe(false)
  expect(w.publisher.view(w.root, 'a.md').links[0].on).toBe(true)
  // A path outside the Workspace is no piece.
  expect((await call('sharing:make', 1, { path: '../b.md', name: null, comments: true })).ok).toBe(false)

  expect(await call('sharing:open-link', 1, { shareId })).toBe(true)
  expect(opened).toEqual([`https://writeflex-sharing.example.workers.dev/s/${shareId}`])
  const owner = JSON.parse(w.secrets.store.read('sharing-links')!).tokens[shareId] as string
  expect(JSON.stringify(await call('sharing:piece', 1, 'a.md'))).not.toContain(owner)
  expect((await call('sharing:turn-off', 1, { shareId })).ok).toBe(true)
})

test('every action is bound to the piece the window has open; support and hidden files are no piece', async () => {
  const w = await publishWorld({
    files: {
      'public.md': '# Public\n\nText.\n',
      'private.md': '# Private\n\nPRIVATE_PIECE_CANARY\n',
      '.writeflex/private.md': '# Hidden\n\nHIDDEN_CANARY\n',
      'notes/agent-notes/review.md': '# Note\n\nAGENT_NOTE_CANARY\n',
    },
  })
  const handlers = new Map<string, (event: { sender: { id: number } }, input?: unknown) => unknown>()
  let rootOfOne: string | null = w.root
  registerSharingPieceIpc({ handle: (channel, listener) => { handlers.set(channel, listener) } }, w.publisher, {
    isAppWindow: (id) => id === 1,
    rootFor: () => rootOfOne,
    openExternal: () => {},
  })
  const call = (channel: string, input?: unknown) => handlers.get(channel)!({ sender: { id: 1 } }, input) as Promise<any>
  // Another piece of the same Workspace has a link (made on its own Sharing page).
  const other = await w.publisher.make(w.root, 'private.md', { name: null, comments: true })
  const otherId = other.ok ? other.shareId! : ''
  const publishedBefore = w.publishes().length

  // Nothing is open yet: no link can be made or touched.
  expect((await call('sharing:make', { path: 'public.md', name: null, comments: true })).ok).toBe(false)
  expect((await call('sharing:turn-off', { shareId: otherId })).ok).toBe(false)

  // The page opens public.md: a request naming private.md is refused, as is any action on its link.
  expect((await call('sharing:open', 'public.md')).links).toHaveLength(0)
  expect((await call('sharing:make', { path: 'private.md', name: null, comments: true })).ok).toBe(false)
  for (const channel of ['sharing:turn-off', 'sharing:turn-on', 'sharing:retry', 'sharing:set-comments', 'sharing:rename']) {
    expect([channel, (await call(channel, { shareId: otherId, name: 'X', comments: false })).ok]).toEqual([channel, false])
  }
  expect(await call('sharing:open-link', { shareId: otherId })).toBe(false)
  expect(w.publisher.view(w.root, 'private.md').links[0]).toMatchObject({ on: true, name: null, comments: true })
  expect(w.publishes().length).toBe(publishedBefore)

  const mine = await call('sharing:make', { path: 'public.md', name: 'Mine', comments: true })
  expect(mine.ok).toBe(true)
  expect((await call('sharing:rename', { shareId: mine.shareId, name: 'Renamed' })).ok).toBe(true)

  // Hidden and support files are no piece: open answers nothing and clears what was open.
  for (const path of ['.writeflex/private.md', '.WriteFlex/private.md', 'notes/agent-notes/review.md']) {
    expect((await call('sharing:piece', path)).links).toEqual([])
    expect((await call('sharing:open', path)).ready).toBe(false)
    expect((await call('sharing:make', { path, name: null, comments: true })).ok).toBe(false)
    expect((await call('sharing:rename', { shareId: mine.shareId, name: 'Nope' })).ok).toBe(false)
  }
  expect(w.publishes().every((entry) => !JSON.stringify(entry.body).includes('HIDDEN_CANARY') && !JSON.stringify(entry.body).includes('AGENT_NOTE_CANARY'))).toBe(true)

  // Closed, or the window now has another Workspace: nothing can be done to the link.
  await call('sharing:open', 'public.md')
  expect((await call('sharing:rename', { shareId: mine.shareId, name: 'Again' })).ok).toBe(true)
  await call('sharing:close')
  expect((await call('sharing:turn-off', { shareId: mine.shareId })).ok).toBe(false)
  await call('sharing:open', 'public.md')
  rootOfOne = '/somewhere/else'
  expect((await call('sharing:turn-off', { shareId: mine.shareId })).ok).toBe(false)
  rootOfOne = w.root
  expect((await call('sharing:turn-off', { shareId: mine.shareId })).ok).toBe(false)
  expect(w.publisher.view(w.root, 'public.md').links[0]).toMatchObject({ on: true, name: 'Again' })
})

test('a Folio (ticket 09): only a Folio in the window\'s Workspace; a Folio page acts only on the Folio\'s links, a piece page only on the piece\'s', async () => {
  const w = await publishWorld({
    files: {
      'F/_report-structure.json': JSON.stringify({ files: [{ path: 'a.md' }, { path: 'b.md' }] }),
      'F/a.md': '# A\n\nText.\n',
      'F/b.md': '# B\n\nMore.\n',
      'Plain/c.md': '# C\n\nNot in a Folio.\n',
      '.hidden/_report-structure.json': JSON.stringify({ files: [{ path: 'x.md' }] }),
      '.hidden/x.md': '# X\n\nHIDDEN_CANARY\n',
    },
  })
  const handlers = new Map<string, (event: { sender: { id: number } }, input?: unknown) => unknown>()
  registerSharingPieceIpc({ handle: (channel, listener) => { handlers.set(channel, listener) } }, w.publisher, {
    isAppWindow: (id) => id === 1 || id === 2,
    rootFor: (id) => (id === 1 ? w.root : '/somewhere/else'),
    openExternal: () => {},
  })
  const call = (channel: string, sender: number, input?: unknown) => handlers.get(channel)!({ sender: { id: sender } }, input) as Promise<any>

  // Not Folios: a plain folder, a dot-folder, a path out of the Workspace, another window's Workspace.
  for (const dir of ['Plain', '.hidden', '../F', '/F']) {
    expect((await call('sharing:open-folio', 1, dir)).ready).toBe(false)
    expect((await call('sharing:make', 1, { folio: dir, name: null, comments: true })).ok).toBe(false)
  }
  expect((await call('sharing:open-folio', 2, 'F')).ready).toBe(false)

  // The Folio page: Make names the Folio; a request naming a piece instead is refused.
  expect((await call('sharing:open-folio', 1, 'F/')).ready).toBe(true)
  expect((await call('sharing:make', 1, { path: 'F/a.md', name: null, comments: true })).ok).toBe(false)
  const folio = await call('sharing:make', 1, { folio: 'F', name: 'Reading pack', comments: true })
  expect(folio.ok).toBe(true)
  expect(folio.view.folio.parts.map((part: { title: string }) => part.title)).toEqual(['A', 'B'])
  expect((await call('sharing:folio', 1, 'F')).links).toHaveLength(1)
  expect((await call('sharing:piece', 1, 'F/a.md')).links).toHaveLength(0)
  expect(await call('sharing:copy-address', 1, { shareId: folio.shareId })).toMatch(/^https:\/\//)

  // A piece page on a part: it cannot touch the Folio's link, and the Folio page cannot touch the piece's.
  await call('sharing:open', 1, 'F/a.md')
  expect((await call('sharing:turn-off', 1, { shareId: folio.shareId })).ok).toBe(false)
  const piece = await call('sharing:make', 1, { path: 'F/a.md', name: null, comments: true })
  expect(piece.ok).toBe(true)
  await call('sharing:open-folio', 1, 'F')
  expect((await call('sharing:turn-off', 1, { shareId: piece.shareId })).ok).toBe(false)
  expect((await call('sharing:turn-off', 1, { shareId: folio.shareId })).ok).toBe(true)
  expect(w.publishes().every((entry) => !JSON.stringify(entry.body).includes('HIDDEN_CANARY'))).toBe(true)
})

/** The IPC over a publish world, for one window (id 1) in the world's Workspace. */
function windowOn(w: Awaited<ReturnType<typeof publishWorld>>) {
  const handlers = new Map<string, (event: { sender: { id: number } }, input?: unknown) => unknown>()
  registerSharingPieceIpc({ handle: (channel, listener) => { handlers.set(channel, listener) } }, w.publisher, {
    isAppWindow: (id) => id === 1,
    rootFor: () => w.root,
    openExternal: () => {},
  })
  return (channel: string, input?: unknown) => handlers.get(channel)!({ sender: { id: 1 } }, input) as Promise<any>
}
const onNow = (w: Awaited<ReturnType<typeof publishWorld>>, shareId: string): boolean => w.publisher.records().find((record) => record.shareId === shareId)!.on

// Review round 1, finding 3: a file's own piece links stay reachable once the file is a part of a Folio.
test('a part\'s own piece links: the Folio page opened from that part lists them and can copy and turn them off, nothing else', async () => {
  const w = await publishWorld({
    files: {
      'F/_report-structure.json': JSON.stringify({ files: [{ path: 'a.md' }] }),
      'F/a.md': '# A\n\nText.\n',
      'F/b.md': '# B\n\nMore.\n',
      'Plain/c.md': '# C\n\nElsewhere.\n',
    },
  })
  const call = windowOn(w)
  // b.md is not in the running order yet: a piece. It gets two links; c.md, outside the Folio, one.
  await call('sharing:open', 'F/b.md')
  const first = await call('sharing:make', { path: 'F/b.md', name: 'Marta', comments: true })
  const second = await call('sharing:make', { path: 'F/b.md', name: 'Seminar', comments: true })
  await call('sharing:open', 'Plain/c.md')
  const outside = await call('sharing:make', { path: 'Plain/c.md', name: null, comments: true })
  expect([first.ok, second.ok, outside.ok]).toEqual([true, true, true])
  await w.publisher.idle()
  // b.md joins the running order: Share on it is now the Folio's page.
  writeFileSync(join(w.root, 'F/_report-structure.json'), JSON.stringify({ files: [{ path: 'a.md' }, { path: 'b.md' }] }))

  // Opened without the part: the piece links are not the page's.
  await call('sharing:open-folio', 'F')
  expect((await call('sharing:turn-off', { shareId: first.shareId })).ok).toBe(false)
  expect(onNow(w, first.shareId)).toBe(true)

  // Opened from b.md: listed, and Copy link, Open and Turn off reach them.
  const view = await call('sharing:open-folio', { dir: 'F', part: 'F/b.md' })
  expect(view.otherLinks).toEqual([{ kind: 'piece', path: 'F/b.md', links: expect.any(Array) }])
  expect(view.otherLinks[0].links.map((link: { name: string }) => link.name)).toEqual(['Marta', 'Seminar'])
  expect((await call('sharing:folio', { dir: 'F', part: 'F/b.md' })).otherLinks[0].links).toHaveLength(2)
  expect(await call('sharing:copy-address', { shareId: first.shareId })).toMatch(/^https:\/\/.*\/s\//)
  // Only Turn off, Copy link and Open: renaming, comments, republishing and turning on stay on the piece's own page.
  expect((await call('sharing:rename', { shareId: first.shareId, name: 'Other' })).ok).toBe(false)
  expect((await call('sharing:set-comments', { shareId: first.shareId, comments: false })).ok).toBe(false)
  expect((await call('sharing:retry', { shareId: first.shareId })).ok).toBe(false)
  const off = await call('sharing:turn-off', { shareId: first.shareId })
  expect(off.ok).toBe(true)
  expect(onNow(w, first.shareId)).toBe(false)
  expect((await w.readerPage(first.shareId)).status).toBe(404)
  expect((await call('sharing:turn-on', { shareId: first.shareId })).ok).toBe(false)
  // The link of a file outside the Folio's folder is never the page's, even named as the part.
  await call('sharing:open-folio', { dir: 'F', part: 'Plain/c.md' })
  expect((await call('sharing:folio', { dir: 'F', part: 'Plain/c.md' })).otherLinks).toBeUndefined()
  expect((await call('sharing:turn-off', { shareId: outside.shareId })).ok).toBe(false)
  expect(onNow(w, outside.shareId)).toBe(true)
  // The Folio's own link is still made on this page as before.
  await call('sharing:open-folio', { dir: 'F', part: 'F/b.md' })
  expect((await call('sharing:make', { folio: 'F', name: null, comments: true })).ok).toBe(true)
  expect((await call('sharing:turn-off', { shareId: second.shareId })).ok).toBe(true)
})

// Review round 1, finding 4: revocation never depends on the source still being valid.
test('a folder that is no longer a Folio: its links can still be opened, copied and turned off, on its page and on a piece\'s page below it; never made or republished', async () => {
  const w = await publishWorld({
    files: {
      'F/_report-structure.json': JSON.stringify({ files: [{ path: 'a.md' }] }),
      'F/a.md': '# A\n\nText.\n',
      'Plain/c.md': '# C\n\nNot in a Folio.\n',
    },
  })
  const call = windowOn(w)
  await call('sharing:open-folio', 'F')
  const one = await call('sharing:make', { folio: 'F', name: 'One', comments: true })
  const two = await call('sharing:make', { folio: 'F', name: 'Two', comments: true })
  expect([one.ok, two.ok]).toEqual([true, true])
  await w.publisher.idle()
  expect((await w.readerPage(one.shareId)).status).toBe(200)

  // The manifest goes: F is no longer a Folio (no Index Note declares a running order).
  rmSync(join(w.root, 'F/_report-structure.json'))
  const page = await call('sharing:open-folio', 'F')
  expect(page.sourceGone).toBe(true)
  expect(page.links.map((link: { name: string }) => link.name)).toEqual(['One', 'Two'])
  expect(await call('sharing:copy-address', { shareId: one.shareId })).toMatch(/^https:\/\//)
  // No new link and no republish of a folder that is no longer a Folio.
  expect((await call('sharing:make', { folio: 'F', name: null, comments: true })).ok).toBe(false)
  expect((await call('sharing:retry', { shareId: one.shareId })).ok).toBe(false)
  expect((await call('sharing:rename', { shareId: one.shareId, name: 'X' })).ok).toBe(false)
  expect((await call('sharing:turn-off', { shareId: one.shareId })).ok).toBe(true)
  expect(onNow(w, one.shareId)).toBe(false)
  expect((await w.readerPage(one.shareId)).status).toBe(404)
  expect((await call('sharing:turn-on', { shareId: one.shareId })).ok).toBe(false)

  // The page the app opens for a file in that folder now is a piece's: it lists the former Folio's links.
  const piece = await call('sharing:open', 'F/a.md')
  expect(piece.otherLinks).toEqual([{ kind: 'folio', path: 'F', links: expect.any(Array) }])
  expect(piece.otherLinks[0].links.map((link: { name: string; on: boolean }) => [link.name, link.on])).toEqual([['One', false], ['Two', true]])
  expect((await call('sharing:turn-off', { shareId: two.shareId })).ok).toBe(true)
  expect((await w.readerPage(two.shareId)).status).toBe(404)
  // A piece elsewhere sees none of them; a folder with no links and no Folio is still nothing.
  expect((await call('sharing:open', 'Plain/c.md')).otherLinks).toBeUndefined()
  expect((await call('sharing:open-folio', 'Plain')).ready).toBe(false)
  // While F is a Folio again, a piece page below it lists nothing of it (its own page does).
  writeFileSync(join(w.root, 'F/_report-structure.json'), JSON.stringify({ files: [{ path: 'a.md' }] }))
  expect((await call('sharing:open', 'F/a.md')).otherLinks).toBeUndefined()
  expect((await call('sharing:open-folio', 'F')).sourceGone).toBeUndefined()

  // Review round 2: a folder no longer a Folio above a Folio that owns every file below it. Every file
  // opens that Folio's page, so the page lists the former Folio's links (and never the page's own).
  const nested = await publishWorld({
    files: {
      'F/_report-structure.json': JSON.stringify({ files: [{ path: 'G/x.md' }] }),
      'F/G/_report-structure.json': JSON.stringify({ files: [{ path: 'x.md' }] }),
      'F/G/x.md': '# X\n\nText.\n',
    },
  })
  const inNested = windowOn(nested)
  await inNested('sharing:open-folio', 'F')
  const outer = await inNested('sharing:make', { folio: 'F', name: 'Outer', comments: true })
  expect(outer.ok).toBe(true)
  await nested.publisher.idle()
  // While F is a Folio, G's page lists nothing of it.
  expect((await inNested('sharing:open-folio', { dir: 'F/G', part: 'F/G/x.md' })).otherLinks).toBeUndefined()
  rmSync(join(nested.root, 'F/_report-structure.json'))
  const inner = await inNested('sharing:open-folio', { dir: 'F/G', part: 'F/G/x.md' })
  expect(inner.sourceGone).toBeUndefined()
  expect(inner.otherLinks).toEqual([{ kind: 'folio', path: 'F', links: expect.any(Array) }])
  expect(inner.otherLinks[0].links.map((link: { name: string }) => link.name)).toEqual(['Outer'])
  expect(await inNested('sharing:copy-address', { shareId: outer.shareId })).toMatch(/^https:\/\//)
  expect((await inNested('sharing:rename', { shareId: outer.shareId, name: 'X' })).ok).toBe(false)
  expect((await inNested('sharing:retry', { shareId: outer.shareId })).ok).toBe(false)
  expect((await inNested('sharing:turn-off', { shareId: outer.shareId })).ok).toBe(true)
  expect((await nested.readerPage(outer.shareId)).status).toBe(404)
  expect((await inNested('sharing:turn-on', { shareId: outer.shareId })).ok).toBe(false)

  // The same at the Workspace root: a manifest-only root Folio, a sub-Folio owning every file.
  const atRoot = await publishWorld({
    files: {
      '_report-structure.json': JSON.stringify({ files: [{ path: 'G/x.md' }] }),
      'G/_report-structure.json': JSON.stringify({ files: [{ path: 'x.md' }] }),
      'G/x.md': '# X\n\nText.\n',
    },
  })
  const inRoot = windowOn(atRoot)
  await inRoot('sharing:open-folio', '')
  const whole = await inRoot('sharing:make', { folio: '', name: 'Whole', comments: true })
  expect(whole.ok).toBe(true)
  await atRoot.publisher.idle()
  rmSync(join(atRoot.root, '_report-structure.json'))
  // The root's own page is manage only and does not list its own links a second time.
  const rootPage = await inRoot('sharing:open-folio', '')
  expect(rootPage.sourceGone).toBe(true)
  expect(rootPage.otherLinks).toBeUndefined()
  const sub = await inRoot('sharing:open-folio', { dir: 'G', part: 'G/x.md' })
  expect(sub.otherLinks).toEqual([{ kind: 'folio', path: '', links: expect.any(Array) }])
  expect((await inRoot('sharing:turn-off', { shareId: whole.shareId })).ok).toBe(true)
  expect((await atRoot.readerPage(whole.shareId)).status).toBe(404)
})

test('a piece whose file is no longer a writer\'s piece (its folder now a link to a dot-folder): its links can still be turned off, never republished', async () => {
  const w = await publishWorld({ files: { 'notes/x.md': '# X\n\nText.\n', '.kept/x.md': '# X\n\nHidden.\n' } })
  const call = windowOn(w)
  await call('sharing:open', 'notes/x.md')
  const link = await call('sharing:make', { path: 'notes/x.md', name: null, comments: true })
  expect(link.ok).toBe(true)
  await w.publisher.idle()
  rmSync(join(w.root, 'notes'), { recursive: true })
  symlinkSync('.kept', join(w.root, 'notes'))
  const page = await call('sharing:open', 'notes/x.md')
  expect(page.sourceGone).toBe(true)
  expect(page.links).toHaveLength(1)
  expect((await call('sharing:make', { path: 'notes/x.md', name: null, comments: true })).ok).toBe(false)
  expect((await call('sharing:retry', { shareId: link.shareId })).ok).toBe(false)
  expect((await call('sharing:turn-off', { shareId: link.shareId })).ok).toBe(true)
  expect((await w.readerPage(link.shareId)).status).toBe(404)
})

// The shared tracker is cached across files; register this file's cleanup explicitly.
afterAll(cleanUpScratch)

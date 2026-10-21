// Ticket 11, Sol review round 3 (P1): the source rule at the publisher's common boundary
// (src/main/sharing-source-eligibility.ts; sharing-publisher.ts publishNow; sharing-folio.ts per part).
// A shared piece whose file is replaced by a link (symlink) to a hidden or support file inside the
// Collection is never published: not by Create link from a page opened before the replacement, not by a
// save, not by a queued publish resumed after a restart; a Folio part replaced the same way is refused.
// The link needs attention (problem `unreadable`, "WriteFlex could not read the piece to publish it.")
// and the copy readers have stays. Against the real sharing service in memory behind the stand-in
// Cloudflare (tests/helpers/sharing-publish-world.ts). No network.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerSharingPieceIpc } from '../../src/main/sharing-piece-ipc.ts'
import { isEligibleFolioMetadata } from '../../src/main/sharing-source-eligibility.ts'
import { folioRunningOrder, isFolio, partKeysFor, renderFolioForSharing } from '../../src/main/sharing-folio.ts'
import { SHARE_UNREADABLE } from '../../src/shared/sharing-links.ts'
import { buildShipped, removeShipped } from '../helpers/sharing-world.ts'
import { publishWorld } from '../helpers/sharing-publish-world.ts'
import type { SharingPublisherPorts } from '../../src/main/sharing-publisher.ts'

beforeAll(buildShipped)
afterAll(removeShipped)

const HIDDEN_TEXT = 'ROUND3_PRIVATE_SUPPORT_TEXT'
const FOLIO = JSON.stringify({ files: [{ path: 'a.md' }, { path: 'b.md' }] })
// Round 4 (P1-2): a private manifest whose file names must never reach a reader page.
const PRIVATE_NAME = 'zqxprivatename'
const PRIVATE_MANIFEST = JSON.stringify({ files: [{ path: 'a.md' }, { path: `${PRIVATE_NAME}.md` }] })
const FILES = {
  'Reading list.md': '# Reading list\n\nA reading list is a promise.\n',
  'Marking.md': '# Marking\n\nMarking as you read.\n',
  'F/_report-structure.json': FOLIO,
  'F/a.md': '# A\n\nPart one words.\n',
  'F/b.md': '# B\n\nPart two words.\n',
  '.bridle/private.md': `# Private\n\n${HIDDEN_TEXT} in bridle.\n`,
  'agent-notes/private.md': `# Notes\n\n${HIDDEN_TEXT} in agent notes.\n`,
  '.bridle/private.json': PRIVATE_MANIFEST,
  'agent-notes/private.json': PRIVATE_MANIFEST,
  'G/_report-structure.json': JSON.stringify({ files: [{ path: 'one.md' }] }),
  'G/one.md': '# One\n\nG part words.\n',
  '.bridle/G/_report-structure.json': PRIVATE_MANIFEST,
  '.bridle/G/a.md': '# A\n\nLinked part words.\n',
  'P/_P_INDEX.md': '# P\n\n## Running order\n\n- One\n',
  'P/one.md': '# One\n\nP part words.\n',
  '.bridle/plan.md': '# Plan\n\n## Running order\n\n- One\n',
}

async function eligibilityWorld(renderFolio?: SharingPublisherPorts['renderFolio']) {
  // A long pause before trying again, so a publish waiting on the service runs only when the test says.
  const w = await publishWorld({ files: FILES, ports: { retryMs: [600_000] }, ...(renderFolio ? { renderFolio } : {}) })
  const handlers = new Map<string, (event: { sender: { id: number } }, input?: unknown) => unknown>()
  registerSharingPieceIpc({ handle: (channel, listener) => { handlers.set(channel, listener) } }, w.publisher, {
    isAppWindow: (id) => id === 1,
    rootFor: (id) => (id === 1 ? w.root : null),
    openExternal: () => {},
  })
  const call = (channel: string, input?: unknown) => handlers.get(channel)!({ sender: { id: 1 } }, input) as Promise<any>
  /** The file at `path` replaced by a link (symlink) to `target`, a file elsewhere in the Collection. */
  const replaceWithLink = (path: string, target: string): void => {
    rmSync(join(w.root, path))
    symlinkSync(join(w.root, target), join(w.root, path))
  }
  const noHiddenText = (): void => {
    expect(w.fake.wire('service')).not.toContain(HIDDEN_TEXT)
    expect(w.fake.wire()).not.toContain(HIDDEN_TEXT)
    // The private manifest's file names, in any letter case (a missing part's title is sentence-cased).
    expect(w.fake.wire('service').toLowerCase()).not.toContain(PRIVATE_NAME)
    expect(w.fake.wire().toLowerCase()).not.toContain(PRIVATE_NAME)
  }
  const recordOf = (shareId: string) => w.publisher.records().find((record) => record.shareId === shareId)!
  return { ...w, call, replaceWithLink, noHiddenText, recordOf }
}

/** The state an ineligible source ends in: on, not ended or lost, needs attention as a piece that cannot be read. */
function needsAttention(record: { on: boolean; ended: unknown; lost: unknown; problem: { kind: string; reason: string } | null }): void {
  expect(record.on).toBe(true)
  expect(record.ended).toBeNull()
  expect(record.lost).toBeNull()
  expect(record.problem).toMatchObject({ kind: 'unreadable', reason: SHARE_UNREADABLE })
}

test('round 3 P1 (a): page opened while the piece was there, then the file replaced by a link to .bridle/private.md: Create link publishes nothing', async () => {
  const w = await eligibilityWorld()
  expect((await w.call('sharing:open', 'Reading list.md')).ready).toBe(true)
  w.replaceWithLink('Reading list.md', '.bridle/private.md')
  const made = await w.call('sharing:make', { path: 'Reading list.md', name: 'Marta' })
  await w.publisher.idle()
  expect(JSON.stringify(made)).not.toContain(HIDDEN_TEXT)
  expect(w.publishes()).toEqual([])
  w.noHiddenText()
  // The link is made (the IPC's own check looks only at a page opened while the file was missing); the publisher refuses the source.
  expect(made.ok).toBe(true)
  needsAttention(w.recordOf(made.shareId))
  expect(w.publisher.view(w.root, 'Reading list.md').mark).toEqual({ kind: 'not-published' })
  expect((await w.readerPage(made.shareId)).text).not.toContain(HIDDEN_TEXT)
})

test('round 3 P1 (b): a piece on a link, its file replaced by a link to agent-notes/private.md: a save publishes nothing; the last copy stays', async () => {
  const w = await eligibilityWorld()
  const made = await w.publisher.make(w.root, 'Marking.md', { name: null, comments: true })
  expect(made.ok).toBe(true)
  const shareId = made.shareId!
  expect(w.publishes()).toHaveLength(1)
  w.replaceWithLink('Marking.md', 'agent-notes/private.md')
  w.publisher.saved(w.root, ['Marking.md'])
  await w.publisher.idle()
  expect(w.publishes()).toHaveLength(1)
  w.noHiddenText()
  needsAttention(w.recordOf(shareId))
  // R-B: nothing removed: readers still see the copy published before.
  const page = await w.readerPage(shareId)
  expect(page.status).toBe(200)
  expect(page.text).toContain('Marking as you read.')
  // Retry goes through the same guard.
  await w.publisher.retry(shareId)
  await w.publisher.idle()
  expect(w.publishes()).toHaveLength(1)
  w.noHiddenText()
})

test('round 3 P1 (b): a save queued while offline, the file then replaced by a link to agent-notes/private.md, resumed after a restart: nothing published', async () => {
  const w = await eligibilityWorld()
  const made = await w.publisher.make(w.root, 'Marking.md', { name: null, comments: true })
  const shareId = made.shareId!
  w.net.offline = true
  w.write('Marking.md', '# Marking\n\nA later save.\n')
  w.publisher.saved(w.root, ['Marking.md'])
  await w.publisher.idle()
  expect(w.recordOf(shareId).queuedAt).not.toBeNull()
  expect(w.recordOf(shareId).problem?.kind).toBe('offline')
  w.replaceWithLink('Marking.md', 'agent-notes/private.md')
  w.net.offline = false
  // WriteFlex starts again; the network is back: the queued publish is tried at once.
  const { publisher } = w.restart()
  publisher.reconnected()
  await publisher.idle()
  expect(w.publishes()).toHaveLength(1)
  w.noHiddenText()
  needsAttention(publisher.records().find((record) => record.shareId === shareId)!)
  expect((await w.readerPage(shareId)).text).toContain('Marking as you read.')
})

test('round 3 P1 (c): a Folio part replaced by a link to .bridle/private.md after the running order was read: that part refused, nothing hidden published', async () => {
  let swap: (() => void) | null = null
  const w = await eligibilityWorld(async (root, dir, imagePath, kept) => {
    // The production port (renderFolioLink), with the part replaced between reading the running order and reading the parts.
    const entries = await folioRunningOrder(root, dir)
    if (!entries) return null
    swap?.()
    const keys = partKeysFor(entries, kept)
    return { folio: await renderFolioForSharing(root, dir, imagePath, entries, keys), keys }
  })
  swap = () => { w.replaceWithLink('F/b.md', '.bridle/private.md'); swap = null }
  const made = await w.publisher.make(w.root, 'F', { name: null, comments: true }, 'folio')
  expect(made.ok).toBe(true)
  await w.publisher.idle()
  w.noHiddenText()
  const published = w.publishes()
  expect(published).toHaveLength(1)
  expect(published[0].body.parts.map((part) => [part.title, part.missing === true])).toEqual([['A', false], ['B', true]])
  expect(published[0].body.parts[0].html).toContain('Part one words.')
  // A save after the replacement: the running order already leaves the part out; still nothing hidden.
  w.publisher.saved(w.root, ['F/b.md'])
  await w.publisher.idle()
  w.noHiddenText()
})

test('round 3 P1 (d): an ordinary piece and an ordinary Folio still publish', async () => {
  const w = await eligibilityWorld()
  const piece = await w.publisher.make(w.root, 'Reading list.md', { name: null, comments: true })
  const folio = await w.publisher.make(w.root, 'F', { name: null, comments: true }, 'folio')
  expect(piece.ok && folio.ok).toBe(true)
  await w.publisher.idle()
  expect(w.recordOf(piece.shareId!).problem).toBeNull()
  expect(w.recordOf(folio.shareId!).problem).toBeNull()
  expect((await w.readerPage(piece.shareId!)).text).toContain('A reading list is a promise.')
  const folioPage = (await w.readerPage(folio.shareId!)).text
  expect(folioPage).toContain('Part one words.')
  expect(folioPage).toContain('Part two words.')
  // A missing part stays a valid placeholder.
  rmSync(join(w.root, 'F/b.md'))
  w.publisher.saved(w.root, ['F/b.md'])
  await w.publisher.idle()
  expect(w.recordOf(folio.shareId!).problem).toBeNull()
  expect(w.publishes().at(-1)!.body.parts.map((part) => part.missing === true)).toEqual([false, true])
  w.noHiddenText()
})

// Sol review round 4 (P1-2): a Folio's manifest, and the Index Note that makes a folder a Folio, keep the
// source rule before sharing reads them (sharing-source-eligibility.ts isEligibleFolioMetadata).
async function round4Folio(dir: string) {
  const w = await eligibilityWorld()
  const made = await w.publisher.make(w.root, dir, { name: null, comments: true }, 'folio')
  expect(made.ok).toBe(true)
  await w.publisher.idle()
  expect(w.publishes()).toHaveLength(1)
  expect(w.recordOf(made.shareId!).problem).toBeNull()
  return { w, shareId: made.shareId! }
}

for (const target of ['.bridle/private.json', 'agent-notes/private.json']) {
  test(`round 4 P1-2: a Folio's manifest replaced by a link to ${target}: Retry and a save publish nothing of it; "could not read"; the last copy stays`, async () => {
    const { w, shareId } = await round4Folio('F')
    w.replaceWithLink('F/_report-structure.json', target)
    await w.publisher.retry(shareId)
    await w.publisher.idle()
    expect(w.publishes()).toHaveLength(1)
    needsAttention(w.recordOf(shareId))
    w.noHiddenText()
    w.publisher.saved(w.root, ['F/_report-structure.json'])
    await w.publisher.idle()
    expect(w.publishes()).toHaveLength(1)
    w.noHiddenText()
    const page = await w.readerPage(shareId)
    expect(page.status).toBe(200)
    expect(page.text).toContain('Part two words.')
    expect(page.text.toLowerCase()).not.toContain(PRIVATE_NAME)
    // Not read for the Sharing page either: the folder is no Folio for sharing.
    expect(await isFolio(w.root, 'F')).toBe(false)
  })
}

test('round 4 P1-2: a Folio folder replaced by a link into .bridle/: its manifest there is never read; "could not read"', async () => {
  const { w, shareId } = await round4Folio('G')
  rmSync(join(w.root, 'G'), { recursive: true })
  symlinkSync(join(w.root, '.bridle/G'), join(w.root, 'G'))
  await w.publisher.retry(shareId)
  await w.publisher.idle()
  expect(w.publishes()).toHaveLength(1)
  needsAttention(w.recordOf(shareId))
  w.noHiddenText()
  expect(w.fake.wire()).not.toContain('Linked part words.')
  expect((await w.readerPage(shareId)).text).toContain('G part words.')
  expect(await isFolio(w.root, 'G')).toBe(false)
})

test('round 4 P1-2: the Index Note that makes a folder a Folio replaced by a link to .bridle/: not read; "could not read"', async () => {
  const { w, shareId } = await round4Folio('P')
  w.replaceWithLink('P/_P_INDEX.md', '.bridle/plan.md')
  await w.publisher.retry(shareId)
  await w.publisher.idle()
  expect(w.publishes()).toHaveLength(1)
  needsAttention(w.recordOf(shareId))
  expect(await isFolio(w.root, 'P')).toBe(false)
})

test('round 4 P1-2: an ordinary Folio, its manifest a link to a file in a writer\'s folder, still publishes', async () => {
  const { w, shareId } = await round4Folio('F')
  mkdirSync(join(w.root, 'Plans'))
  writeFileSync(join(w.root, 'Plans/F.json'), JSON.stringify({ files: [{ path: 'b.md' }, { path: 'a.md' }] }))
  w.replaceWithLink('F/_report-structure.json', 'Plans/F.json')
  expect(await isFolio(w.root, 'F')).toBe(true)
  await w.publisher.retry(shareId)
  await w.publisher.idle()
  expect(w.recordOf(shareId).problem).toBeNull()
  expect(w.publishes().at(-1)!.body.parts.map((part) => part.title)).toEqual(['B', 'A'])
  w.noHiddenText()
})

test('round 4 P1-2: isEligibleFolioMetadata: no .md needed; refused as typed or as linked into a dot-folder or agent-notes', async () => {
  const w = await eligibilityWorld()
  expect(isEligibleFolioMetadata(w.root, 'F/_report-structure.json')).toBe(true)
  expect(isEligibleFolioMetadata(w.root, 'P/_P_INDEX.md')).toBe(true)
  for (const bad of ['.bridle/private.json', 'agent-notes/private.json', '../x.json', '/abs.json', 'F/./_report-structure.json', 'F/none.json', 'F']) {
    expect(isEligibleFolioMetadata(w.root, bad)).toBe(false)
  }
  w.replaceWithLink('F/_report-structure.json', '.bridle/private.json')
  expect(isEligibleFolioMetadata(w.root, 'F/_report-structure.json')).toBe(false)
  w.replaceWithLink('G/_report-structure.json', 'agent-notes/private.json')
  expect(isEligibleFolioMetadata(w.root, 'G/_report-structure.json')).toBe(false)
  rmSync(join(w.root, 'G'), { recursive: true })
  symlinkSync(join(w.root, '.bridle/G'), join(w.root, 'G'))
  expect(isEligibleFolioMetadata(w.root, 'G/_report-structure.json')).toBe(false)
})

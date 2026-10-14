import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceAgent } from '../../src/main/agent'
import { CollectionDigestCache, CollectionDigestRevisions, collectionDirsForPaths, computeCollectionDigest, digestDisplayGist, digestReadPaths, formatDigestContext, type CollectionDigest } from '../../src/main/digest'
import { Workspace } from '../../src/main/workspace'

let root: string
let ws: Workspace

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-digest-'))
  ws = new Workspace(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true })
  await writeFile(join(root, path), content, 'utf8')
}

test('computes statuses, gists, word counts, Folder Pieces, link degrees, and agent provenance from one Collection population', async () => {
  await write('essays/alpha.md', '---\nstatus: drafting\ndescription: a frame is not a proof\n---\n\n# Alpha\n\nSee [[Beta]].\n')
  await write('essays/beta.md', '---\nstatus: editing\n---\n\n# Beta\n\nThe lecture that would not die. See [[Alpha]].\n')
  await write('essays/report/README.md', '---\nstatus: stalled\n---\n\n# Report\n\nOne folder-shaped work. See [[Alpha]].\n')
  await write('essays/report/parts/hidden.md', '# Hidden internal\n')
  await write('essays/agent-notes/discarded.md', '# Words per week\n\nRecorded agent object.\n')

  let harnessCalls = 0
  const originalPrompt = WorkspaceAgent.prototype.prompt
  WorkspaceAgent.prototype.prompt = async function forbiddenHarnessCall() {
    harnessCalls += 1
    throw new Error('Digest must not call the agent harness.')
  }
  try {
    const digest = await computeCollectionDigest(ws, 'essays')
    expect(harnessCalls).toBe(0)
    expect(digest.summary).toEqual({ pieces: 4, statuses: { drafting: 1, editing: 1, stalled: 1 } })
    expect(digest.pieces.map((piece) => piece.path)).toEqual([
      'essays/agent-notes/discarded.md',
      'essays/alpha.md',
      'essays/beta.md',
      'essays/report/README.md',
    ])
    expect(digest.pieces.find((piece) => piece.path.endsWith('alpha.md'))).toMatchObject({
      gist: 'a frame is not a proof', words: 4, links: { inbound: 2, outbound: 1, degree: 3 }, agentAuthored: false,
    })
    expect(digest.pieces.find((piece) => piece.path.endsWith('beta.md'))).toMatchObject({
      gist: 'The lecture that would not die. See [[Alpha]].', links: { inbound: 1, outbound: 1, degree: 2 },
    })
    expect(digest.pieces.find((piece) => piece.folderPath === 'essays/report')).toMatchObject({ title: 'Report' })
    expect(digest.pieces.some((piece) => piece.path.endsWith('hidden.md'))).toBe(false)
    expect(digest.pieces.find((piece) => piece.agentAuthored)).toMatchObject({ status: null })
  } finally {
    WorkspaceAgent.prototype.prompt = originalPrompt
  }
})

test('bounds the model context and states how many Pieces were truncated', async () => {
  for (let index = 0; index < 180; index += 1) {
    await write(`large/piece-${String(index).padStart(3, '0')}.md`, `# Piece ${index}\n\n${'long gist '.repeat(20)}\n`)
  }
  const context = formatDigestContext(await computeCollectionDigest(ws, 'large'), 8_000)
  expect(context.length).toBeLessThanOrEqual(8_000)
  expect(context).toMatch(/\d+ more Pieces? omitted to keep the Digest bounded\./)
})

test('splits the context budget so large Piece and read sections both survive with omission counts', () => {
  const pieces = Array.from({ length: 5_000 }, (_, index) => ({
    path: `piece-${index}.md`, title: `Piece ${index}`, status: 'drafting',
    gist: `See [[Piece ${index + 1}|the next Piece]] in this synthetic fixture.`, words: 70,
    links: { inbound: 1, outbound: 3, degree: 4 }, agentAuthored: false,
  }))
  const digest: CollectionDigest = {
    collection: 'large', summary: { pieces: pieces.length, statuses: { drafting: pieces.length } }, pieces,
    readThisTurn: Array.from({ length: 500 }, (_, index) => `reads/read-${index}.md`),
  }

  const context = formatDigestContext(digest, 8_000)
  expect(context.length).toBeLessThanOrEqual(8_000)
  expect(context).toContain('PIECES')
  expect(context).toContain('READ LAST TURN (full file reads by tools)')
  expect(context).toMatch(/… and \d+ more Pieces/)
  expect(context).toMatch(/… and \d+ more reads/)
  expect(context).toContain('the next Piece')
  expect(context).not.toContain('[[Piece')
})

test('small Digests omit zero-count markers and restore the honest empty-read row', () => {
  const digest: CollectionDigest = {
    collection: 'small',
    summary: { pieces: 1, statuses: { drafting: 1 } },
    pieces: [{
      path: 'small/one.md', title: 'One', status: 'drafting', gist: 'A small Piece.', words: 3,
      links: { inbound: 0, outbound: 0, degree: 0 }, agentAuthored: false,
    }],
    readThisTurn: [],
  }

  const context = formatDigestContext(digest)

  expect(context).toContain('READ LAST TURN (full file reads by tools)\n- none')
  expect(context).not.toContain('and 0 more')
  expect(context).not.toContain('omitted')
})

test('Digest display gists show wikilink titles without source brackets', () => {
  expect(digestDisplayGist('See [[Alpha]] and [[Beta|the second Piece]].')).toBe('See Alpha and the second Piece.')
})

test('Digest cache reuses one root-and-directory build until the invalidation revision changes', async () => {
  let builds = 0
  const fixture: CollectionDigest = { collection: 'essays', summary: { pieces: 0, statuses: {} }, pieces: [], readThisTurn: [] }
  const cache = new CollectionDigestCache(async () => { builds += 1; return fixture })

  await cache.get(ws, 'essays', 7, ['first.md'])
  const warm = await cache.get(ws, 'essays', 7, ['second.md'])
  await cache.get(ws, 'essays', 8, [])

  expect(builds).toBe(2)
  expect(warm.readThisTurn).toEqual(['second.md'])
})

test('a primed Digest survives a revision bump until the turn takes it', async () => {
  let builds = 0
  const cache = new CollectionDigestCache(async (_workspace, dir) => ({
    collection: `${dir}-${++builds}`, summary: { pieces: 0, statuses: {} }, pieces: [], readThisTurn: [],
  }))

  const revision = 7
  await cache.prime(ws, 'essays', revision)
  await cache.get(ws, 'essays', revision + 1)

  expect(cache.takePrimed(ws, 'essays', ['previous.md'])).toMatchObject({
    collection: 'essays-1', readThisTurn: ['previous.md'],
  })
  expect(builds).toBe(2)
})

test('Digest cache retains at most four recent entries without evicting a primed turn', async () => {
  const cache = new CollectionDigestCache(async (_workspace, dir) => ({
    collection: dir, summary: { pieces: 0, statuses: {} }, pieces: [], readThisTurn: [],
  }))

  await cache.prime(ws, 'pinned', 1)
  for (const dir of ['two', 'three', 'four', 'five', 'six']) await cache.get(ws, dir, 1)

  expect(cache.takePrimed(ws, 'pinned')).toMatchObject({ collection: 'pinned' })
  expect(cache.take(ws, 'two', 1)).toBeNull()
  expect(cache.take(ws, 'six', 1)).toMatchObject({ collection: 'six' })
})

test('a fresh prime remains takeable after seven unconsumed primes cross five Collections', async () => {
  const cache = new CollectionDigestCache(async (_workspace, dir) => ({
    collection: dir, summary: { pieces: 0, statuses: {} }, pieces: [], readThisTurn: [],
  }))

  for (const dir of ['one', 'two', 'three', 'four', 'five', 'one', 'fresh']) await cache.prime(ws, dir, 1)

  expect(cache.takePrimed(ws, 'fresh')).toMatchObject({ collection: 'fresh' })
})

test('real touched paths invalidate their root, Collection, and nested Collection scopes', () => {
  expect(collectionDirsForPaths(['Notes/n2.md'])).toEqual(['', 'Notes', 'Notes/n2.md'])
  expect(collectionDirsForPaths(['Essays/sub/n2.md'])).toEqual(['', 'Essays', 'Essays/sub', 'Essays/sub/n2.md'])
})

test('settings:revert index path bumps its Collection revision', () => {
  const revisions = new CollectionDigestRevisions()

  revisions.bump(root, ['Essays/_Essays_INDEX.md'])

  expect(revisions.get(root, '')).toBe(1)
  expect(revisions.get(root, 'Essays')).toBe(1)
  expect(revisions.get(root, 'Notes')).toBe(0)
})

test('derives read-this-turn paths only from successful harness tool reads inside the Workspace', () => {
  expect(digestReadPaths(root, [
    join(root, 'essays/alpha.md'),
    join(root, 'essays/alpha.md'),
    join(root, 'essays/report/README.md'),
    '/tmp/outside.md',
  ])).toEqual(['essays/alpha.md', 'essays/report/README.md'])
})

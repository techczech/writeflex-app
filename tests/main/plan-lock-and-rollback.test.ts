/**
 * Two guarantees every Plan write has, whoever calls it:
 * A. one writer at a time per Folio (plan-lock.ts);
 * B. the Index Note and the manifest are not left disagreeing by a manifest write that fails
 *    (`commitPlanDocuments` in plan.ts).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { folioPieces, MANIFEST_NAME } from '../../src/main/folio'
import { moveFolioPiece } from '../../src/main/folio-running-order'
import { adoptParts, movePart, readPlan, removePart } from '../../src/main/plan'
import { planLockBusy, withPlanLock } from '../../src/main/plan-lock'
import { Workspace } from '../../src/main/workspace'

let root: string
let ws: Workspace
const DIR = 'guide'
const INDEX = `${DIR}/_guide_INDEX.md`
const MANIFEST = `${DIR}/${MANIFEST_NAME}`
const piece = (name: string) => `${DIR}/${name}.md`
const ABCD = ['a', 'b', 'c', 'd'].map(piece)
const read = (path: string) => readFile(join(root, path), 'utf8')
const bytesNow = async () => [await read(MANIFEST), await read(INDEX)]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'writeflex-plan-lock-'))
  ws = new Workspace(root)
  await mkdir(join(root, DIR), { recursive: true })
  for (const [name, text] of Object.entries({ 'a.md': '# Alpha\n', 'b.md': '# Beta\n', 'c.md': '# Gamma\n', 'd.md': '# Delta\n', 'glossary.md': '# Glossary\n' })) {
    await writeFile(join(root, DIR, name), text)
  }
  await writeFile(join(root, MANIFEST), '{\n  "schema_version": 1,\n  "content_root": "",\n  "files": [\n    { "path": "a.md" },\n    { "path": "b.md" },\n    { "path": "c.md" },\n    { "path": "d.md" }\n  ]\n}\n')
  await writeFile(join(root, INDEX), '# Guide\n\n## Running order\n\n- [[Alpha]]\n- [[Beta]]\n- [[Gamma]]\n- [[Delta]]\n')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const documentsAgree = async (): Promise<string[]> => {
  const manifest = (await folioPieces(ws, DIR))!.pieces
  expect((await readPlan(ws, DIR))!.parts.map((part) => part.path)).toEqual(manifest)
  return manifest
}

/** Record every document write, slowed so that two unserialised writers would overlap. */
function recordWrites(): { log: string[]; restore: () => void } {
  const original = ws.saveFileWithoutReadBack.bind(ws)
  const log: string[] = []
  ws.saveFileWithoutReadBack = (async (path: string, content: string, options?: Parameters<typeof original>[2]) => {
    if (path === INDEX || path === MANIFEST) {
      log.push(path === INDEX ? 'index' : 'manifest')
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
    return original(path, content, options)
  }) as typeof ws.saveFileWithoutReadBack
  return { log, restore: () => { ws.saveFileWithoutReadBack = original } }
}

test('A: two Plan writes started together on one Folio run one after the other, and the documents agree after both', async () => {
  const { log, restore } = recordWrites()
  // Each is computed against the Folio as it stands when its turn comes: first a goes last, then the new first (b) goes last.
  const [first, second] = await Promise.all([movePart(ws, DIR, 0, 3), movePart(ws, DIR, 0, 3)])
  restore()
  expect(first.parts.map((part) => part.path)).toEqual(['b', 'c', 'd', 'a'].map(piece))
  expect(second.parts.map((part) => part.path)).toEqual(['c', 'd', 'a', 'b'].map(piece))
  expect(log).toEqual(['index', 'manifest', 'index', 'manifest'])
  expect(await documentsAgree()).toEqual(['c', 'd', 'a', 'b'].map(piece))
  expect(planLockBusy(ws, DIR)).toBe(false)
})

test('A: different Plan writes (move, adopt, remove) and the Outline route share the one lock', async () => {
  const { log, restore } = recordWrites()
  const results = await Promise.allSettled([
    movePart(ws, DIR, 0, 3),
    adoptParts(ws, DIR, [0]),
    moveFolioPiece(ws, DIR, { path: piece('c'), beforePath: null, expected: ABCD }),
    removePart(ws, DIR, 0),
  ])
  restore()
  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'])
  // The Outline request saw a running order that was no longer the one it named: refused, not interleaved.
  expect(results[2].status === 'fulfilled' && results[2].value.result).toMatchObject({ ok: false, stale: true })
  expect(log).toEqual(['index', 'manifest', 'index', 'manifest', 'index', 'manifest'])
  expect(await documentsAgree()).toEqual([piece('c'), piece('d'), piece('a'), piece('glossary')])
})

test('A: a write that throws releases the lock for the next one', async () => {
  await expect(movePart(ws, DIR, 0, 3, { verifyPlan: () => { throw new Error('refused by the caller') } })).rejects.toThrow('refused by the caller')
  expect(planLockBusy(ws, DIR)).toBe(false)
  await expect(withPlanLock(ws, DIR, async () => { throw new Error('boom') })).rejects.toThrow('boom')
  const moved = await movePart(ws, DIR, 0, 3)
  expect(moved.parts.map((part) => part.path)).toEqual(['b', 'c', 'd', 'a'].map(piece))
})

test('A: the lock is held across awaits, is re-entrant along one call chain, and is per Folio', async () => {
  const order: string[] = []
  const slow = withPlanLock(ws, DIR, async () => {
    order.push('first in')
    await new Promise((resolve) => setTimeout(resolve, 30))
    // A Plan write made by the holder runs straight through instead of waiting for the holder.
    await movePart(ws, DIR, 0, 3)
    order.push('first out')
  })
  const waiting = withPlanLock(ws, DIR, async () => { order.push('second') })
  const elsewhere = withPlanLock(ws, 'another-folio', async () => { order.push('other folio') })
  await Promise.all([slow, waiting, elsewhere])
  expect(order).toEqual(['first in', 'other folio', 'first out', 'second'])
})

/** Make the manifest write fail, optionally doing something first (what a racing writer would). */
function failManifestWrite(before?: () => Promise<void>): () => void {
  const original = ws.saveFileWithoutReadBack.bind(ws)
  ws.saveFileWithoutReadBack = (async (path: string, content: string, options?: Parameters<typeof original>[2]) => {
    if (path === MANIFEST) {
      await before?.()
      throw new Error(`EACCES: permission denied, open '${join(root, MANIFEST)}'`)
    }
    return original(path, content, options)
  }) as typeof ws.saveFileWithoutReadBack
  return () => { ws.saveFileWithoutReadBack = original }
}

test('B: when the manifest write fails after the Index Note was written, the Index Note gets its bytes back and the error says so', async () => {
  const bytes = await bytesNow()
  let indexWhenManifestFailed = ''
  const restore = failManifestWrite(async () => { indexWhenManifestFailed = await read(INDEX) })
  await expect(movePart(ws, DIR, 0, 3)).rejects.toThrow('the Index Note was put back as it was. Nothing was changed.')
  // The Index Note really had been written before the manifest failed.
  expect(indexWhenManifestFailed).toContain('- [[Beta]]\n- [[Gamma]]\n- [[Delta]]\n- [[Alpha]]')
  expect(await bytesNow()).toEqual(bytes)
  await expect(adoptParts(ws, DIR, [0])).rejects.toThrow('Nothing was changed.')
  await expect(removePart(ws, DIR, 1)).rejects.toThrow('Nothing was changed.')
  expect(await bytesNow()).toEqual(bytes)
  restore()
  expect(await documentsAgree()).toEqual(ABCD)
  // The pristine-copy backups made before the first write are still there.
  expect(await read(`${INDEX}.writeflex-backup`)).toBe(bytes[1])
  expect(await read(`${MANIFEST}.writeflex-backup`)).toBe(bytes[0])
})

test('B: when the Index Note was changed by something else meanwhile, it is left alone and the error says to check both', async () => {
  const manifest = await read(MANIFEST)
  const theirs = '# Guide\n\nSomeone else wrote this.\n\n## Running order\n\n- [[Delta]]\n'
  const restore = failManifestWrite(async () => { await writeFile(join(root, INDEX), theirs) })
  await expect(movePart(ws, DIR, 0, 3)).rejects.toThrow('Check both in the Plan.')
  restore()
  expect(await read(INDEX)).toBe(theirs)
  expect(await read(MANIFEST)).toBe(manifest)
})

test('B: through the Outline route the failure is a refusal with no absolute path, and both documents are as they were', async () => {
  const bytes = await bytesNow()
  const restore = failManifestWrite()
  const { result, plan } = await moveFolioPiece(ws, DIR, { path: piece('a'), beforePath: null, expected: ABCD })
  restore()
  expect(result).toMatchObject({ ok: false, stale: false })
  if (!result.ok) {
    expect(result.message).toContain('Nothing was changed.')
    expect(result.message).not.toContain(root)
    expect(result.message).not.toMatch(/\/(private|var|tmp|Users)\//)
  }
  expect(plan).toBeNull()
  expect(await bytesNow()).toEqual(bytes)
})

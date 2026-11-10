/**
 * Make Folio's write after the confirmation (Sol round 2, S1): a manifest that appears between the writer's answer
 * and the write is never replaced, whether it is there when the write turn starts or arrives after the check.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace, atomicWriteSeams } from '../../src/main/workspace'
import { createFolioManifest } from '../../src/main/folio-manifest-create'
import { MANIFEST_NAME } from '../../src/main/folio'

let root: string
const theirs = `${JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'theirs.md', role: 'section' }] }, null, 2)}\n`
const ours = `${JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'a.md', role: 'section' }] }, null, 2)}\n`
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-folio-create-'))
  await mkdir(join(root, 'book'))
  await writeFile(join(root, 'book/a.md'), '# A\n')
})
afterEach(async () => {
  delete atomicWriteSeams.afterStage
  await rm(root, { recursive: true, force: true })
})

test('with no manifest, the manifest is created', async () => {
  const saved = await createFolioManifest(new Workspace(root), 'book', ours)
  expect(saved.file.path).toBe(`book/${MANIFEST_NAME}`)
  expect(await readFile(join(root, 'book', MANIFEST_NAME), 'utf8')).toBe(ours)
})

test('a manifest installed after the confirmation and before the write turn is kept, and Make Folio refuses', async () => {
  const ws = new Workspace(root)
  // The writer confirmed; an agent wrote a manifest while the renderer flush was awaited.
  await writeFile(join(root, 'book', MANIFEST_NAME), theirs)
  await expect(createFolioManifest(ws, 'book', ours)).rejects.toThrow('A Folio manifest already exists in book.')
  expect(await readFile(join(root, 'book', MANIFEST_NAME), 'utf8')).toBe(theirs)
})

test('a manifest another program writes after the in-turn check, while the new one is staged, is not replaced', async () => {
  const ws = new Workspace(root)
  atomicWriteSeams.afterStage = async (absolute) => {
    if (absolute.endsWith(MANIFEST_NAME)) await writeFile(absolute, theirs)
  }
  await expect(createFolioManifest(ws, 'book', ours)).rejects.toThrow('appeared in book while Make Folio was waiting. Nothing was replaced.')
  expect(await readFile(join(root, 'book', MANIFEST_NAME), 'utf8')).toBe(theirs)
})

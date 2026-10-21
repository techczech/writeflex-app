import { afterEach, beforeEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RenameRepairPlan } from '../../src/main/rename-repair'
import { applyPlannedRenameRepair } from '../../src/main/rename-repair-apply'
import { Workspace } from '../../src/main/workspace'

// R7: Rename Repair's rollback puts a reference file back only while it still holds what the repair wrote,
// compared in the tick of the put-back's rename. A change landing after the rollback's own check (the
// await between it and the write) is left as it is, never overwritten with the pre-repair text.

let root: string
let ws: Workspace

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-rename-repair-rollback-'))
  ws = new Workspace(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const read = (path: string) => readFile(join(root, path), 'utf8')

function plan(): RenameRepairPlan {
  return {
    fromPath: 'old.md',
    toPath: 'new.md',
    writes: [
      { kind: 'markdown', path: 'a-ref.md', content: 'See [[new]].\n' },
      { kind: 'markdown', path: 'b-ref.md', content: 'See [[new]].\n' },
    ],
    manifestChanges: [],
    unrepairedReferences: [],
    bystanderReferences: [],
    plannedReferences: ['a-ref.md: [[old]]', 'b-ref.md: [[old]]'],
    preservedReferences: [],
    plannedOutcomes: [],
    verification: {
      workspacePaths: ['a-ref.md', 'b-ref.md', 'new.md'],
      markdown: [{ path: 'a-ref.md', content: 'See [[old]].\n' }, { path: 'b-ref.md', content: 'See [[old]].\n' }],
      manifests: [],
      renamedContent: 'Body.\n',
    },
  }
}

test('a reference file changed after the rollback checked it is left as it is and named', async () => {
  await writeFile(join(root, 'new.md'), 'Body.\n')
  await writeFile(join(root, 'a-ref.md'), 'See [[old]].\n')
  await writeFile(join(root, 'b-ref.md'), 'See [[old]].\n')
  const outside = 'See [[new]].\nA paragraph another program wrote during the rollback.\n'
  const saveFile = ws.saveFile.bind(ws)
  let putBack = false
  ws.saveFile = async (path, content, options) => {
    if (path === 'b-ref.md' && content.includes('[[new]]')) throw new Error('injected repair write failure')
    // The rollback's put-back of a-ref.md: another program writes it while the put-back is staged.
    if (path === 'a-ref.md' && content.includes('[[old]]')) { putBack = true; writeFileSync(join(root, 'a-ref.md'), outside) }
    return saveFile(path, content, options)
  }
  const failure = await applyPlannedRenameRepair(plan(), ws).then(() => null, (error: unknown) => error as Error)
  expect(putBack).toBe(true)
  expect(failure?.message).toContain('a-ref.md: the file changed after Rename Repair wrote it')
  expect(await read('a-ref.md')).toBe(outside)
  expect(await read('b-ref.md')).toBe('See [[old]].\n')
})

test('a reference file nobody changed is put back', async () => {
  await writeFile(join(root, 'new.md'), 'Body.\n')
  await writeFile(join(root, 'a-ref.md'), 'See [[old]].\n')
  await writeFile(join(root, 'b-ref.md'), 'See [[old]].\n')
  const saveFile = ws.saveFile.bind(ws)
  ws.saveFile = async (path, content, options) => {
    if (path === 'b-ref.md' && content.includes('[[new]]')) throw new Error('injected repair write failure')
    return saveFile(path, content, options)
  }
  const failure = await applyPlannedRenameRepair(plan(), ws).then(() => null, (error: unknown) => error as Error)
  expect(failure?.message).toContain('No partial repair was left behind.')
  expect(await read('a-ref.md')).toBe('See [[old]].\n')
})

/**
 * The rename doors (src/main/rename-doors.ts) against a real vault on disk, next to the agent's rename verb: both
 * doors repair, checkpoint, warn and report alike. The IPC channels reaching the module are checked once, in
 * rename-doors-ipc.test.ts.
 */
import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityContext } from '@bridle/core'
import { buildWriteFlexManifest } from '../../src/main/capabilities'
import { moveFile, previewRename, renameFile, RenameBatch, type MoveDestination } from '../../src/main/rename-doors'
import { Workspace } from '../../src/main/workspace'
import { formatRenameRepairMessage } from '../../src/shared/rename-repair-message'
import { renameDoorWorld, type RenameDoorWorld } from '../helpers/rename-door-world'

/** As the file:move handler reads the picker's path: slash-free names the workspace root. */
const destinationOf = (newPath: string): MoveDestination =>
  newPath.includes('/') ? { to: 'folder', path: newPath } : { to: 'root', name: newPath }

/** The sidebar's rename: the dialog's preview, then the rename to the path it named. */
async function sidebarRename(world: RenameDoorWorld, path: string, newName: string, directory?: string | null) {
  const plan = await previewRename(world.workspace, { path, newName, directory })
  return { plan, renamed: await renameFile(world.deps, path, plan.newPath) }
}

/** The sidebar's move: the picker's preview, then the move to the path it named. */
async function sidebarMove(world: RenameDoorWorld, path: string, newName: string, directory: string | null) {
  const plan = await previewRename(world.workspace, { path, newName, directory })
  return { plan, moved: await moveFile(world.deps, path, destinationOf(plan.newPath)) }
}

/** A checkpoint that fails, noting where the document was at that moment. */
function failingCheckpoint(world: RenameDoorWorld, oldPath: string, newPath: string) {
  const states: Array<{ oldExists: boolean; newExists: boolean }> = []
  world.failCheckpointWith(async () => {
    states.push({ oldExists: await world.exists(oldPath), newExists: await world.exists(newPath) })
    throw new Error('injected repair checkpoint failure')
  })
  return states
}

async function agentRenameCheckpointFailure() {
  const root = await mkdtemp(join(tmpdir(), 'writeflex-agent-rename-door-'))
  try {
    const workspace = new Workspace(root)
    await workspace.saveFile('old.md', 'Body.\n')
    await workspace.saveFile('ref.md', 'See [[old]].\n')
    const checkpointStates: Array<{ oldExists: boolean; newExists: boolean }> = []
    const rename = buildWriteFlexManifest(workspace, undefined, {
      checkpointFile: async () => {
        checkpointStates.push({
          oldExists: await Bun.file(join(root, 'old.md')).exists(),
          newExists: await Bun.file(join(root, 'new.md')).exists(),
        })
        throw new Error('injected repair checkpoint failure')
      },
    }).capabilities.find((capability) => capability.name === 'housekeeping.rename_file')!
    const input = { path: 'old.md', newPath: 'new.md' }
    const resolvedTouchedPaths = Object.freeze(await rename.touchedPaths!(input))
    const context: CapabilityContext = {
      trigger: { id: 't', source: 'user', trust: 'interactive' },
      sessionId: 's', attemptId: 'attempt', idempotencyKey: 'attempt', audit: () => {}, resolvedTouchedPaths,
    }
    const result = await rename.execute(input, context)
    return {
      isError: result.isError,
      warning: (result.details as { repair?: { unrepairedReferences?: string[] } } | undefined)?.repair?.unrepairedReferences ?? [],
      issues: (result.details as { repair?: { issues?: Array<{ kind: string; text: string }> } } | undefined)?.repair?.issues ?? [],
      checkpointState: checkpointStates.at(-1),
      oldExists: await Bun.file(join(root, 'old.md')).exists(),
      newExists: await Bun.file(join(root, 'new.md')).exists(),
      ref: (await workspace.readFile('ref.md')).content,
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function agentScopedPlanProbe(kind: 'orphan' | 'unaffected') {
  const root = await mkdtemp(join(tmpdir(), 'writeflex-agent-scoped-plan-'))
  try {
    const workspace = new Workspace(root)
    await mkdir(join(root, 'report', 'contents', 'parts'), { recursive: true })
    await writeFile(join(root, 'report', 'contents', 'parts', 'guide.md'), 'Report part.\n')
    await writeFile(join(root, 'report', '_report_INDEX.md'), '# Report\n\n## Running order\n\n- [[Guide]]\n')
    await writeFile(join(root, 'report', '_report-structure.json'), JSON.stringify({ schema_version: 1, content_root: 'contents/parts', files: [] }, null, 2) + '\n')
    const input = kind === 'orphan'
      ? { path: 'report/contents/parts/guide.md', newPath: 'report/contents/parts/opening.md' }
      : { path: 'elsewhere/old.md', newPath: './guide.md' }
    if (kind === 'orphan') await writeFile(join(root, 'guide.md'), '# Guide\n')
    else {
      await mkdir(join(root, 'elsewhere'), { recursive: true })
      await writeFile(join(root, 'elsewhere', 'old.md'), '# Guide\n')
    }
    const rename = buildWriteFlexManifest(workspace).capabilities
      .find((capability) => capability.name === 'housekeeping.rename_file')!
    const resolvedTouchedPaths = Object.freeze(await rename.touchedPaths!(input))
    const context: CapabilityContext = {
      trigger: { id: 't', source: 'user', trust: 'interactive' },
      sessionId: 's', attemptId: 'attempt', idempotencyKey: 'attempt', audit: () => {}, resolvedTouchedPaths,
    }
    const result = await rename.execute(input, context)
    return {
      isError: result.isError,
      text: result.text,
      repair: (result.details as { repair?: { writtenPaths: string[]; unrepairedReferences: string[]; issues: Array<{ kind: string; text: string }> } } | undefined)?.repair,
      oldExists: await Bun.file(join(root, input.path)).exists(),
      newExists: await Bun.file(join(root, input.newPath)).exists(),
      index: await Bun.file(join(root, 'report', '_report_INDEX.md')).text(),
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function agentRenameWriteFailure(rollbackAlsoFails: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'writeflex-agent-rename-write-door-'))
  try {
    class RepairFailureWorkspace extends Workspace {
      override async saveFile(path: string, content: string, options?: { allowExplicitEmpty?: boolean }) {
        if (rollbackAlsoFails) {
          if (path === 'b-ref.md' && content.includes('[[new]]')) {
            await super.saveFile('a-ref.md', 'See [[new]].\nA concurrent paragraph survives.\n')
            throw new Error('injected repair write failure')
          }
        } else if (path === 'ref.md' && content.includes('[[new]]')) {
          throw new Error('injected repair write failure')
        }
        return super.saveFile(path, content, options)
      }
    }
    const workspace = new RepairFailureWorkspace(root)
    await workspace.saveFile('old.md', 'Body.\n')
    const referencePaths = rollbackAlsoFails ? ['a-ref.md', 'b-ref.md'] : ['ref.md']
    for (const path of referencePaths) await workspace.saveFile(path, 'See [[old]].\n')
    const changedOnDisk: string[][] = []
    const rename = buildWriteFlexManifest(workspace, undefined, {
      notifyFilesChangedOnDisk: (paths) => { changedOnDisk.push(paths) },
    }).capabilities.find((capability) => capability.name === 'housekeeping.rename_file')!
    const input = { path: 'old.md', newPath: 'new.md' }
    const resolvedTouchedPaths = Object.freeze(await rename.touchedPaths!(input))
    const context: CapabilityContext = {
      trigger: { id: 't', source: 'user', trust: 'interactive' },
      sessionId: 's', attemptId: 'attempt', idempotencyKey: 'attempt', audit: () => {}, resolvedTouchedPaths,
    }
    const result = await rename.execute(input, context)
    return {
      isError: result.isError,
      text: result.text,
      repair: (result.details as { repair: {
        writtenPaths: string[]
        unrepairedReferences: string[]
        issues: Array<{ kind: string; text: string }>
      } }).repair,
      changedOnDisk,
      references: await Promise.all(referencePaths.map(async (path) => (await workspace.readFile(path)).content)),
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function agentPlanNoticeProbe(kind: 'preserved' | 'available') {
  const root = await mkdtemp(join(tmpdir(), 'writeflex-agent-plan-notice-'))
  try {
    const workspace = new Workspace(root)
    const input = kind === 'preserved'
      ? { path: 'report/part.md', newPath: 'archive/part.md' }
      : { path: 'adoption-loose.md', newPath: 'adoption-report/adopted.md' }
    if (kind === 'preserved') {
      await mkdir(join(root, 'report'), { recursive: true })
      await writeFile(join(root, 'report', 'part.md'), 'Body.\n')
      await writeFile(join(root, 'report', '_report_INDEX.md'), '# Report\n\n## Running order\n\n- [[part]]\n')
      await writeFile(join(root, 'report', '_report-structure.json'), JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'part.md' }] }, null, 2) + '\n')
    } else {
      await mkdir(join(root, 'adoption-report'), { recursive: true })
      await writeFile(join(root, 'adoption-loose.md'), 'Body.\n')
      await writeFile(join(root, 'adoption-report', '_adoption-report_INDEX.md'), '## Running order\n\n- [[adopted]]\n')
      await writeFile(join(root, 'adoption-report', '_report-structure.json'), JSON.stringify({ schema_version: 1, content_root: '', files: [] }, null, 2) + '\n')
    }
    const rename = buildWriteFlexManifest(workspace).capabilities
      .find((capability) => capability.name === 'housekeeping.rename_file')!
    const resolvedTouchedPaths = Object.freeze(await rename.touchedPaths!(input))
    const context: CapabilityContext = {
      trigger: { id: 't', source: 'user', trust: 'interactive' },
      sessionId: 's', attemptId: 'attempt', idempotencyKey: 'attempt', audit: () => {}, resolvedTouchedPaths,
    }
    const result = await rename.execute(input, context)
    return {
      text: result.text,
      repair: (result.details as { repair: {
        writtenPaths: string[]
        unrepairedReferences: string[]
        issues: Array<{ kind: string; text: string }>
      } }).repair,
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function agentMixedManifestFailure() {
  const root = await mkdtemp(join(tmpdir(), 'writeflex-agent-mixed-repair-door-'))
  try {
    let indexRepairApplied = false
    class MixedRepairFailureWorkspace extends Workspace {
      override async saveFile(path: string, content: string, options?: { allowExplicitEmpty?: boolean }) {
        if (path === 'report/_report_INDEX.md' && content.includes('See also [[moved]]')) {
          indexRepairApplied = true
        }
        if (path === 'report/_report-structure.json' && !content.includes('old.md')) {
          throw new Error('injected manifest write failure')
        }
        if (path === 'report/_report_INDEX.md' && indexRepairApplied && content.includes('See also [[old]]')) {
          throw new Error('injected index ROLLBACK failure')
        }
        return super.saveFile(path, content, options)
      }
    }
    const workspace = new MixedRepairFailureWorkspace(root)
    await mkdir(join(root, 'report'), { recursive: true })
    await writeFile(join(root, 'report', 'old.md'), 'Body.\n')
    await writeFile(join(root, 'report', '_report_INDEX.md'), '## Running order\n\n- [[old]]\n\nSee also [[old]] in prose.\n')
    await writeFile(join(root, 'report', '_report-structure.json'), JSON.stringify({
      schema_version: 1,
      content_root: '',
      files: [{ path: 'old.md' }],
    }, null, 2) + '\n')
    const rename = buildWriteFlexManifest(workspace).capabilities
      .find((capability) => capability.name === 'housekeeping.rename_file')!
    const input = { path: 'report/old.md', newPath: 'outside/moved.md' }
    const resolvedTouchedPaths = Object.freeze(await rename.touchedPaths!(input))
    const context: CapabilityContext = {
      trigger: { id: 't', source: 'user', trust: 'interactive' },
      sessionId: 's', attemptId: 'attempt', idempotencyKey: 'attempt', audit: () => {}, resolvedTouchedPaths,
    }
    const result = await rename.execute(input, context)
    return {
      text: result.text,
      repair: (result.details as { repair: {
        writtenPaths: string[]
        unrepairedReferences: string[]
        issues: Array<{ kind: string; text: string }>
      } }).repair,
      index: (await workspace.readFile('report/_report_INDEX.md')).content,
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** A completed repair's receipt for each file it wrote (shared/repair-receipt.ts): sha256 of before and after. */
const receiptsFor = (...paths: string[]) => paths.map((path) => ({ path, before: expect.stringMatching(/^[0-9a-f]{64}$/), written: expect.stringMatching(/^[0-9a-f]{64}$/) }))

test('the rename door checkpoints and notifies every repaired path, and the document is followed in one turn', async () => {
  const world = await renameDoorWorld()
  await world.write('old.md', 'Body.\n')
  await world.write('ref.md', 'See [[old]].\n')
  const { plan, renamed } = await sidebarRename(world, 'old.md', '2026/08/10.md')
  expect({
    plan, path: renamed.file.path, checkpoints: world.checkpoints, changedOnDisk: world.changedOnDisk,
    repair: renamed.repair, ref: await world.read('ref.md'),
  }).toEqual({
    plan: { newPath: '2026-08-10.md', repairPaths: ['ref.md'] },
    path: '2026-08-10.md',
    checkpoints: ['ref.md'],
    changedOnDisk: [['ref.md']],
    repair: { writtenPaths: ['ref.md'], unrepairedReferences: [], issues: [], receipts: receiptsFor('ref.md') },
    ref: 'See [[2026-08-10]].\n',
  })
  expect(world.follows).toEqual([
    ['ledger', 'old.md', '2026-08-10.md'], ['scratchpad', 'old.md', '2026-08-10.md'], ['sharing', 'old.md', '2026-08-10.md'],
  ])
  expect(world.forgotten).toEqual(['old.md'])
  expect(world.collectionChanged).toEqual([['old.md', '2026-08-10.md', 'ref.md']])
})

test('the sidebar rename door proceeds and names wikilink and manifest bystanders without rewriting them', async () => {
  const world = await renameDoorWorld()
  await world.write('bystander-link/elsewhere/target.md', 'Stable target.\n')
  await world.write('bystander-link/report/old.md', 'Moving target.\n')
  await world.write('bystander-link/report/ref.md', 'A [[old]] and a [[target]].\n')
  const link = (await sidebarRename(world, 'bystander-link/report/old.md', 'target.md', 'bystander-link/report')).renamed
  expect({ path: link.file.path, repair: link.repair, ref: await world.read('bystander-link/report/ref.md') }).toMatchObject({
    path: 'bystander-link/report/target.md',
    repair: { unrepairedReferences: [expect.stringContaining('bystander-link/report/ref.md: [[target]] changed meaning')] },
    ref: 'A [[target]] and a [[target]].\n',
  })

  await world.write('bystander-manifest/x.md', 'Stable part.\n')
  await world.write('bystander-manifest/contents/old.md', 'Moving part.\n')
  await world.write('bystander-manifest/_report-structure.json', JSON.stringify({
    schema_version: 1,
    content_root: 'contents',
    files: [{ path: 'x.md', title: 'The stable part' }, { path: 'old.md', title: 'The moving part' }],
  }, null, 2) + '\n')
  const manifest = (await sidebarRename(world, 'bystander-manifest/contents/old.md', 'x.md', 'bystander-manifest/contents')).renamed
  expect(manifest.file.path).toBe('bystander-manifest/contents/x.md')
  expect(manifest.repair.unrepairedReferences).toEqual(expect.arrayContaining([expect.stringContaining('The stable part (x.md) changed meaning')]))
  expect(JSON.parse(await world.read('bystander-manifest/_report-structure.json')).files[0]).toEqual({ path: 'x.md', title: 'The stable part' })
})

async function scopedFolio(world: RenameDoorWorld, base: string) {
  await world.write(`${base}/report/contents/parts/guide.md`, 'Report part.\n')
  await world.write(`${base}/report/_report_INDEX.md`, '# Report\n\n## Running order\n\n- [[Guide]]\n')
  await world.write(`${base}/report/_report-structure.json`, JSON.stringify({ schema_version: 1, content_root: 'contents/parts', files: [] }, null, 2) + '\n')
}

test('both rename doors repair an Index Note through the scoped Folio outline resolver', async () => {
  const world = await renameDoorWorld()
  await scopedFolio(world, 'scoped-orphan')
  await world.write('scoped-orphan/guide.md', '# Guide\n')
  const [agentDoor, { renamed }] = await Promise.all([
    agentScopedPlanProbe('orphan'),
    sidebarRename(world, 'scoped-orphan/report/contents/parts/guide.md', 'opening.md', 'scoped-orphan/report/contents/parts'),
  ])
  expect(agentDoor).toMatchObject({
    isError: undefined, oldExists: false, newExists: true,
    index: '# Report\n\n## Running order\n\n- [[opening]]\n',
    repair: { writtenPaths: ['report/_report_INDEX.md'], unrepairedReferences: [], issues: [] },
  })
  expect({ path: renamed.file.path, index: await world.read('scoped-orphan/report/_report_INDEX.md'), repair: renamed.repair }).toEqual({
    path: 'scoped-orphan/report/contents/parts/opening.md',
    index: '# Report\n\n## Running order\n\n- [[opening]]\n',
    repair: { writtenPaths: ['scoped-orphan/report/_report_INDEX.md'], unrepairedReferences: [], issues: [], receipts: receiptsFor('scoped-orphan/report/_report_INDEX.md') },
  })
})

test('both rename doors allow an unrelated rename that leaves the scoped Folio outline unchanged', async () => {
  const world = await renameDoorWorld()
  await scopedFolio(world, 'scoped-unaffected')
  await world.write('scoped-unaffected/elsewhere/old.md', '# Guide\n')
  const [agentDoor, { renamed }] = await Promise.all([
    agentScopedPlanProbe('unaffected'),
    sidebarRename(world, 'scoped-unaffected/elsewhere/old.md', 'guide.md', 'scoped-unaffected'),
  ])
  expect(agentDoor).toMatchObject({
    isError: undefined, oldExists: false, newExists: true,
    index: '# Report\n\n## Running order\n\n- [[Guide]]\n',
    repair: { writtenPaths: [], unrepairedReferences: [], issues: [] },
  })
  expect(agentDoor.text).not.toContain('The rename was not made')
  expect({ path: renamed.file.path, index: await world.read('scoped-unaffected/report/_report_INDEX.md'), repair: renamed.repair }).toEqual({
    path: 'scoped-unaffected/guide.md',
    index: '# Report\n\n## Running order\n\n- [[Guide]]\n',
    repair: { writtenPaths: [], unrepairedReferences: [], issues: [], receipts: [] },
  })
})

test('both rename doors checkpoint after the rename and keep checkpoint failure as a warning', async () => {
  const world = await renameDoorWorld()
  await world.write('broken-old.md', 'Body.\n')
  await world.write('broken-ref.md', 'See [[broken-old]].\n')
  const states = failingCheckpoint(world, 'broken-old.md', 'broken-new.md')
  const [agentDoor, { renamed }] = await Promise.all([
    agentRenameCheckpointFailure(),
    sidebarRename(world, 'broken-old.md', 'broken-new.md'),
  ])
  expect(agentDoor).toMatchObject({
    isError: undefined, checkpointState: { oldExists: false, newExists: true }, oldExists: false, newExists: true, ref: 'See [[old]].\n',
  })
  expect(agentDoor.warning).toEqual(['ref.md: [[old]]'])
  expect(agentDoor.issues).toEqual([
    { kind: 'reference', text: 'ref.md: [[old]]' },
    { kind: 'file', text: 'ref.md' },
    { kind: 'reason', text: expect.stringContaining('injected repair checkpoint failure') },
  ])
  expect({
    path: renamed.file.path, warning: renamed.repair.unrepairedReferences, issues: renamed.repair.issues,
    checkpointState: states.at(-1), targetExists: await world.read('broken-new.md'), ref: await world.read('broken-ref.md'),
  }).toEqual({
    path: 'broken-new.md',
    warning: ['broken-ref.md: [[broken-old]]'],
    issues: [
      { kind: 'reference', text: 'broken-ref.md: [[broken-old]]' },
      { kind: 'file', text: 'broken-ref.md' },
      { kind: 'reason', text: expect.stringContaining('injected repair checkpoint failure') },
    ],
    checkpointState: { oldExists: false, newExists: true },
    targetExists: 'Body.\n',
    ref: 'See [[broken-old]].\n',
  })
})

test('both rename doors deliver the failed references and repair-write reason', async () => {
  const world = await renameDoorWorld()
  await world.write('write-old.md', 'Body.\n')
  await world.write('write-ref.md', 'See [[write-old]].\n')
  world.beforeSave(async (path, content) => {
    if (path === 'write-ref.md' && content.includes('[[write-new]]')) throw new Error('injected repair write failure')
  })
  const [agentDoor, { renamed }] = await Promise.all([
    agentRenameWriteFailure(false),
    sidebarRename(world, 'write-old.md', 'write-new.md'),
  ])
  expect(agentDoor.text).toBe(formatRenameRepairMessage('Renamed to new.md', agentDoor.repair))
  for (const repair of [agentDoor.repair, renamed.repair]) {
    expect(repair).toMatchObject({
      writtenPaths: [],
      unrepairedReferences: [expect.stringContaining('ref.md: [[')],
      issues: [
        { kind: 'reference', text: expect.stringContaining('ref.md: [[') },
        { kind: 'file', text: expect.stringContaining('ref.md') },
        { kind: 'reason', text: expect.stringContaining('injected repair write failure') },
      ],
    })
  }
  expect(agentDoor.text).toContain('injected repair write failure')
  expect(agentDoor.text).not.toContain('part-way through an abandoned change')
  expect(agentDoor.references).toEqual(['See [[old]].\n'])
  expect(await world.read('write-ref.md')).toBe('See [[write-old]].\n')
})

test('a written file keeps its genuinely unrepaired running-order reference on both doors', async () => {
  const agentDoor = await agentMixedManifestFailure()
  expect(agentDoor.index).toBe('## Running order\n\n- [[old]]\n\nSee also [[moved]] in prose.\n')
  expect(agentDoor.repair.writtenPaths).toEqual(['report/_report_INDEX.md'])
  expect(agentDoor.repair.unrepairedReferences).not.toContain(
    'report/_report_INDEX.md: [[old]] was left unchanged because the renamed file left this report.',
  )
  expect(agentDoor.repair.unrepairedReferences).not.toContain('report/_report_INDEX.md: [[old]]')
  expect(agentDoor.text).toContain('report/_report_INDEX.md: [[old]] was left unchanged because the renamed file left this report.')
  expect(agentDoor.text).not.toContain('could not repair 2 references')
})

async function reportWithPart(world: RenameDoorWorld) {
  await mkdir(join(world.root, 'archive'), { recursive: true })
  await world.write('report/part.md', 'Body.\n')
  await world.write('report/_report_INDEX.md', '# Report\n\n## Running order\n\n- [[part]]\n')
  await world.write('report/_report-structure.json', JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'part.md' }] }, null, 2) + '\n')
}

test('both rename doors report a preserved plan line identically without failure wording', async () => {
  const world = await renameDoorWorld()
  await reportWithPart(world)
  const [agentDoor, { moved }] = await Promise.all([
    agentPlanNoticeProbe('preserved'),
    sidebarMove(world, 'report/part.md', 'part.md', 'archive'),
  ])
  expect(agentDoor.repair).toEqual(moved.repair)
  const agentMessage = formatRenameRepairMessage('', agentDoor.repair)
  expect(agentMessage).toBe(formatRenameRepairMessage('', moved.repair))
  expect(agentMessage).toContain(
    'Preserved plan line: report/_report_INDEX.md: [[part]] was left unchanged because the renamed file left this report.',
  )
  expect(agentMessage).not.toContain('could not repair')
  expect(agentMessage).not.toContain('Warning')
})

test('both rename doors report adoption as the same available action without writing', async () => {
  const world = await renameDoorWorld()
  await world.write('adoption-loose.md', 'Body.\n')
  await world.write('adoption-report/_adoption-report_INDEX.md', '## Running order\n\n- [[adopted]]\n')
  await world.write('adoption-report/_report-structure.json', JSON.stringify({ schema_version: 1, content_root: '', files: [] }, null, 2) + '\n')
  const [agentDoor, { moved }] = await Promise.all([
    agentPlanNoticeProbe('available'),
    sidebarMove(world, 'adoption-loose.md', 'adopted.md', 'adoption-report'),
  ])
  expect(agentDoor.repair).toEqual(moved.repair)
  expect(agentDoor.repair.writtenPaths).toEqual([])
  expect(moved.repair.writtenPaths).toEqual([])
  const agentMessage = formatRenameRepairMessage('', agentDoor.repair)
  expect(agentMessage).toBe(formatRenameRepairMessage('', moved.repair))
  expect(agentMessage).toContain(
    'Available action: adoption-report/adopted.md now matches planned part [[adopted]] in adoption-report/_adoption-report_INDEX.md; you can adopt it when you want to.',
  )
  expect(agentMessage).not.toContain('Completed repair')
  expect(await world.read('adoption-report/_adoption-report_INDEX.md')).toBe('## Running order\n\n- [[adopted]]\n')
})

test('both rename doors preserve and report content written after repair apply began', async () => {
  const world = await renameDoorWorld()
  await world.write('rollback-old.md', 'Body.\n')
  await world.write('a-ref.md', 'See [[rollback-old]].\n')
  await world.write('b-ref.md', 'See [[rollback-old]].\n')
  world.beforeSave(async (path, content, save) => {
    if (path === 'b-ref.md' && content.includes('[[rollback-new]]')) {
      await save('a-ref.md', 'See [[rollback-new]].\nA concurrent paragraph survives.\n')
      throw new Error('injected repair write failure')
    }
  })
  const [agentDoor, { renamed }] = await Promise.all([
    agentRenameWriteFailure(true),
    sidebarRename(world, 'rollback-old.md', 'rollback-new.md'),
  ])
  for (const [repair, oldName] of [[agentDoor.repair, 'old'], [renamed.repair, 'rollback-old']] as const) {
    expect(repair.writtenPaths).toEqual(['a-ref.md'])
    expect(repair.unrepairedReferences).toEqual([`b-ref.md: [[${oldName}]]`])
    expect(repair.issues).toEqual([
      { kind: 'reference', text: `b-ref.md: [[${oldName}]]` },
      { kind: 'file', text: 'b-ref.md' },
      { kind: 'reason', text: expect.stringContaining('Rollback also failed for a-ref.md') },
    ])
  }
  expect(agentDoor.text).toContain('The repair to a-ref.md was applied and could not be undone')
  expect(agentDoor.changedOnDisk).toEqual([['a-ref.md']])
  expect(agentDoor.references).toEqual(['See [[new]].\nA concurrent paragraph survives.\n', 'See [[old]].\n'])
  expect(world.changedOnDisk).toEqual([['a-ref.md']])
  expect(await world.read('a-ref.md')).toBe('See [[rollback-new]].\nA concurrent paragraph survives.\n')
  expect(await world.read('b-ref.md')).toBe('See [[rollback-old]].\n')
})

test('the move door repairs the report and notifies every rewritten path', async () => {
  const world = await renameDoorWorld()
  await reportWithPart(world)
  const { plan, moved } = await sidebarMove(world, 'report/part.md', 'part.md', 'archive')
  expect({
    plan, path: moved.file.path, checkpoints: world.checkpoints, changedOnDisk: world.changedOnDisk, repair: moved.repair,
    manifest: JSON.parse(await world.read('report/_report-structure.json')), index: await world.read('report/_report_INDEX.md'),
  }).toEqual({
    plan: { newPath: 'archive/part.md', repairPaths: ['report/_report-structure.json'] },
    path: 'archive/part.md',
    checkpoints: ['report/_report-structure.json'],
    changedOnDisk: [['report/_report-structure.json']],
    repair: {
      writtenPaths: ['report/_report-structure.json'],
      unrepairedReferences: [],
      issues: [
        { kind: 'preserved', text: 'report/_report_INDEX.md: [[part]] was left unchanged because the renamed file left this report.' },
        { kind: 'outcome', text: 'report/_report-structure.json: part.md was removed because archive/part.md left the report folder.' },
      ],
      receipts: receiptsFor('report/_report-structure.json'),
    },
    manifest: { schema_version: 1, content_root: '', files: [] },
    index: '# Report\n\n## Running order\n\n- [[part]]\n',
  })
})

test('the move door moves a nested file to the workspace root and repairs its references', async () => {
  const world = await renameDoorWorld()
  await world.write('root-source/root-part.md', 'Root-bound body.\n')
  await world.write('root-source/_report_INDEX.md', '## Running order\n\n- [[root-part]]\n')
  await world.write('root-source/_report-structure.json', JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'root-part.md' }] }, null, 2) + '\n')
  const { plan, moved } = await sidebarMove(world, 'root-source/root-part.md', 'root-part.md', null)
  expect({
    plan, path: moved.file.path, repair: moved.repair,
    oldExists: await world.exists('root-source/root-part.md'), rootContent: await world.read('root-part.md'),
    manifest: JSON.parse(await world.read('root-source/_report-structure.json')), index: await world.read('root-source/_report_INDEX.md'),
  }).toEqual({
    plan: { newPath: 'root-part.md', repairPaths: ['root-source/_report-structure.json'] },
    path: 'root-part.md',
    repair: {
      writtenPaths: ['root-source/_report-structure.json'],
      unrepairedReferences: [],
      issues: [{ kind: 'outcome', text: 'root-source/_report-structure.json: root-part.md was removed because root-part.md left the report folder.' }],
      receipts: receiptsFor('root-source/_report-structure.json'),
    },
    oldExists: false,
    rootContent: 'Root-bound body.\n',
    manifest: { schema_version: 1, content_root: '', files: [] },
    index: '## Running order\n\n- [[root-part]]\n',
  })
})

test('the rename and move doors keep traversal-like typed names inside the chosen folder', async () => {
  const world = await renameDoorWorld()
  await world.write('rename-traversal.md', 'Rename traversal.\n')
  await mkdir(join(world.root, 'safe-dir'), { recursive: true })
  await world.write('move-traversal.md', 'Move traversal.\n')
  const renamed = await sidebarRename(world, 'rename-traversal.md', '../x.md')
  const moved = await sidebarMove(world, 'move-traversal.md', '../x.md', 'safe-dir')
  expect({
    renamePlan: renamed.plan, renamePath: renamed.renamed.file.path, renameContent: await world.read('..-x.md'),
    movePlan: moved.plan, movePath: moved.moved.file.path, moveContent: await world.read('safe-dir/..-x.md'),
  }).toEqual({
    renamePlan: { newPath: '..-x.md', repairPaths: [] },
    renamePath: '..-x.md',
    renameContent: 'Rename traversal.\n',
    movePlan: { newPath: 'safe-dir/..-x.md', repairPaths: [] },
    movePath: 'safe-dir/..-x.md',
    moveContent: 'Move traversal.\n',
  })
})

test('the move door reports a completed move with a repair warning', async () => {
  const world = await renameDoorWorld()
  await mkdir(join(world.root, 'archive'), { recursive: true })
  await world.write('report/move-broken.md', 'Body.\n')
  await world.write('report/_report-structure.json', JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'move-broken.md' }] }, null, 2) + '\n')
  await world.write('move-broken-ref.md', 'See [[move-broken]].\n')
  failingCheckpoint(world, 'report/move-broken.md', 'archive/move-broken.md')
  const { moved } = await sidebarMove(world, 'report/move-broken.md', 'move-broken.md', 'archive')
  expect({
    path: moved.file.path, warning: moved.repair.unrepairedReferences, issues: moved.repair.issues,
    targetExists: await world.read('archive/move-broken.md'), ref: await world.read('move-broken-ref.md'),
  }).toEqual({
    path: 'archive/move-broken.md',
    warning: ['report/_report-structure.json: move-broken.md was removed because archive/move-broken.md left the report folder.'],
    issues: [
      { kind: 'reference', text: 'report/_report-structure.json: move-broken.md was removed because archive/move-broken.md left the report folder.' },
      { kind: 'file', text: 'report/_report-structure.json' },
      { kind: 'reason', text: expect.stringContaining('injected repair checkpoint failure') },
    ],
    targetExists: 'Body.\n',
    ref: 'See [[move-broken]].\n',
  })
})

/** One Collection multi-select move: each document moved in the same batch, as collection:begin-batch starts. */
const batchMove = (world: RenameDoorWorld, batch: RenameBatch, path: string, to: string) =>
  moveFile(world.deps, path, destinationOf(to), { dir: '', batch })

test('in a batch, a document written at a path an earlier move left keeps the links that name it', async () => {
  const world = await renameDoorWorld()
  await mkdir(join(world.root, 'dest'), { recursive: true })
  await world.write('a.md', '# Old A\n')
  await world.write('source/b.md', '# Draft without a link\n')
  const batch = new RenameBatch()
  await batchMove(world, batch, 'a.md', 'dest/a.md')
  // A new a.md at the root, linked from b before b moves in the same batch.
  await world.write('a.md', '# New\n')
  await world.write('source/b.md', '[New A](../a.md#new)\n')
  const moved = await batchMove(world, batch, 'source/b.md', 'dest/b.md')
  expect(await world.read('dest/b.md')).toBe('[New A](../a.md#new)\n')
  expect(moved.repair.unrepairedReferences).toEqual([])
})

test('in a batch, a link written in another case reaches the moved document where the volume ignores case', async () => {
  const world = await renameDoorWorld()
  await mkdir(join(world.root, 'dest'), { recursive: true })
  await world.write('source/a.md', '[B](B.md#top)\n')
  await world.write('source/b.md', '# Top\n')
  const ignoresCase = await world.exists('source/B.md')
  const batch = new RenameBatch()
  await batchMove(world, batch, 'source/a.md', 'dest/a.md')
  const moved = await batchMove(world, batch, 'source/b.md', 'dest/b.md')
  // On a case-sensitive volume the link named no file from the start, and keeps its bytes.
  expect(await world.read('dest/a.md')).toBe(ignoresCase ? '[B](b.md#top)\n' : '[B](B.md#top)\n')
  expect(moved.repair.unrepairedReferences).toEqual([])

  // The other order: b already moved, so a's link in another case is found where b went.
  const second = await renameDoorWorld()
  await mkdir(join(second.root, 'dest'), { recursive: true })
  await second.write('source/a.md', '[B](B.md#top)\n')
  await second.write('source/b.md', '# Top\n')
  const other = new RenameBatch()
  await batchMove(second, other, 'source/b.md', 'dest/b.md')
  await batchMove(second, other, 'source/a.md', 'dest/a.md')
  expect(await second.read('dest/a.md')).toBe(ignoresCase ? '[B](b.md#top)\n' : '[B](B.md#top)\n')
})

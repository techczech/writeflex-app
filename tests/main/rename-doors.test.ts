import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityContext } from '@bridle/core'
import { buildWriteFlexManifest } from '../../src/main/capabilities'
import { Workspace } from '../../src/main/workspace'
import { formatRenameRepairMessage } from '../../src/shared/rename-repair-message'

const ipcProbe = String.raw`
  import { mock } from 'bun:test'
  import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'

  const root = await mkdtemp(join(tmpdir(), 'writeflex-rename-door-'))
  const handlers = new Map()
  const sent = []
  const checkpoints = []
  const checkpointStates = []
  let failCheckpoint = false
  let saveFailure = 'none'
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: (channel) => handlers.delete(channel),
  }
  void mock.module('electron', () => ({
    app: { getPath: () => root, getVersion: () => '0.0.0-test', isPackaged: false },
    clipboard: { write: () => {} },
    dialog: {},
    ipcMain,
    shell: { openExternal: async () => {}, showItemInFolder: () => {}, trashItem: async () => {} },
  }))
  const [{ registerIpc }, { registerWindow }, { Workspace }] = await Promise.all([
    import('./src/main/ipc.ts'), import('./src/main/state.ts'), import('./src/main/workspace.ts'),
  ])
  const state = registerWindow({
    webContents: { id: 17, send: (channel, payload) => sent.push([channel, payload]) },
    on: () => {}, isDestroyed: () => false,
  })
  state.workspace = new Workspace(root)
  const realSaveFile = state.workspace.saveFile.bind(state.workspace)
  state.workspace.saveFile = async (path, content, options) => {
    if (saveFailure === 'write' && path === 'write-ref.md' && content.includes('[[write-new]]')) {
      throw new Error('injected repair write failure')
    }
    if (saveFailure === 'rollback') {
      if (path === 'b-ref.md' && content.includes('[[rollback-new]]')) {
        await realSaveFile('a-ref.md', 'See [[rollback-new]].\nA concurrent paragraph survives.\n')
        throw new Error('injected repair write failure')
      }
    }
    return realSaveFile(path, content, options)
  }
  state.agentReady = Promise.resolve({
    checkpointFile: async (path) => {
      checkpoints.push(path)
      if (failCheckpoint) checkpointStates.push({
        oldExists: await Bun.file(join(root, 'broken-old.md')).exists(),
        newExists: await Bun.file(join(root, 'broken-new.md')).exists(),
      })
      if (failCheckpoint) throw new Error('injected repair checkpoint failure')
    },
  })
  registerIpc(
    { openFolder: async () => {}, openFile: async () => {}, recents: () => [], openRecent: async () => {} },
    { modelDefaults: () => ({}), recents: () => [] },
    {},
  )
  const rename = handlers.get('file:rename')
  const move = handlers.get('file:move')
  const planRename = handlers.get('file:rename-repair-paths')
  await writeFile(join(root, 'old.md'), 'Body.\n')
  await writeFile(join(root, 'ref.md'), 'See [[old]].\n')
  const firstPlan = await planRename(
    { sender: { id: 17 } },
    { path: 'old.md', newName: '2026/08/10.md' },
  )
  const first = await rename({ sender: { id: 17 } }, { path: 'old.md', newPath: firstPlan.newPath })
  const firstResult = {
    plan: firstPlan,
    path: first.file.path,
    checkpoints: [...checkpoints],
    changedOnDisk: sent.filter(([channel]) => channel === 'file:changed-on-disk').map(([, payload]) => payload),
    repair: first.repair,
    ref: await readFile(join(root, 'ref.md'), 'utf8'),
  }

  await writeFile(join(root, 'rename-traversal.md'), 'Rename traversal.\n')
  const traversalRenamePlan = await planRename(
    { sender: { id: 17 } },
    { path: 'rename-traversal.md', newName: '../x.md' },
  )
  const traversalRename = await rename(
    { sender: { id: 17 } },
    { path: 'rename-traversal.md', newPath: traversalRenamePlan.newPath },
  )
  await mkdir(join(root, 'safe-dir'), { recursive: true })
  await writeFile(join(root, 'move-traversal.md'), 'Move traversal.\n')
  const traversalMovePlan = await planRename(
    { sender: { id: 17 } },
    { path: 'move-traversal.md', newName: '../x.md', directory: 'safe-dir' },
  )
  const traversalMove = await move(
    { sender: { id: 17 } },
    { path: 'move-traversal.md', newPath: traversalMovePlan.newPath },
  )
  const traversalResult = {
    renamePlan: traversalRenamePlan,
    renamePath: traversalRename.file.path,
    renameContent: await readFile(join(root, '..-x.md'), 'utf8'),
    movePlan: traversalMovePlan,
    movePath: traversalMove.file.path,
    moveContent: await readFile(join(root, 'safe-dir', '..-x.md'), 'utf8'),
  }

  checkpoints.length = 0
  sent.length = 0
  failCheckpoint = true
  await writeFile(join(root, 'broken-old.md'), 'Body.\n')
  await writeFile(join(root, 'broken-ref.md'), 'See [[broken-old]].\n')
  const secondPlan = await planRename(
    { sender: { id: 17 } },
    { path: 'broken-old.md', newName: 'broken-new.md' },
  )
  const second = await rename({ sender: { id: 17 } }, { path: 'broken-old.md', newPath: secondPlan.newPath })
  const failureResult = {
    path: second.file.path,
    warning: second.repair.unrepairedReferences,
    issues: second.repair.issues,
    checkpointState: checkpointStates.at(-1),
    targetExists: await readFile(join(root, 'broken-new.md'), 'utf8'),
    ref: await readFile(join(root, 'broken-ref.md'), 'utf8'),
  }

  failCheckpoint = false
  saveFailure = 'write'
  await writeFile(join(root, 'write-old.md'), 'Body.\n')
  await writeFile(join(root, 'write-ref.md'), 'See [[write-old]].\n')
  const writeFailurePlan = await planRename(
    { sender: { id: 17 } },
    { path: 'write-old.md', newName: 'write-new.md' },
  )
  const writeFailure = await rename(
    { sender: { id: 17 } },
    { path: 'write-old.md', newPath: writeFailurePlan.newPath },
  )
  const writeFailureResult = {
    path: writeFailure.file.path,
    repair: writeFailure.repair,
    ref: await readFile(join(root, 'write-ref.md'), 'utf8'),
  }

  sent.length = 0
  saveFailure = 'rollback'
  await writeFile(join(root, 'rollback-old.md'), 'Body.\n')
  await writeFile(join(root, 'a-ref.md'), 'See [[rollback-old]].\n')
  await writeFile(join(root, 'b-ref.md'), 'See [[rollback-old]].\n')
  const rollbackFailurePlan = await planRename(
    { sender: { id: 17 } },
    { path: 'rollback-old.md', newName: 'rollback-new.md' },
  )
  const rollbackFailure = await rename(
    { sender: { id: 17 } },
    { path: 'rollback-old.md', newPath: rollbackFailurePlan.newPath },
  )
  const rollbackFailureResult = {
    path: rollbackFailure.file.path,
    repair: rollbackFailure.repair,
    changedOnDisk: sent.filter(([channel]) => channel === 'file:changed-on-disk').map(([, payload]) => payload),
    firstRef: await readFile(join(root, 'a-ref.md'), 'utf8'),
    secondRef: await readFile(join(root, 'b-ref.md'), 'utf8'),
  }

  checkpoints.length = 0
  sent.length = 0
  saveFailure = 'none'
  failCheckpoint = false
  await mkdir(join(root, 'report'), { recursive: true })
  await mkdir(join(root, 'archive'), { recursive: true })
  await writeFile(join(root, 'report', 'part.md'), 'Body.\n')
  await writeFile(join(root, 'report', '_report_INDEX.md'), '# Report\n\n## Running order\n\n- [[part]]\n')
  await writeFile(join(root, 'report', '_report-structure.json'), JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'part.md' }] }, null, 2) + '\n')
  const movePlan = await planRename(
    { sender: { id: 17 } },
    { path: 'report/part.md', newName: 'part.md', directory: 'archive' },
  )
  const moved = await move({ sender: { id: 17 } }, { path: 'report/part.md', newPath: movePlan.newPath })
  const moveResult = {
    plan: movePlan,
    path: moved.file.path,
    checkpoints: [...checkpoints],
    changedOnDisk: sent.filter(([channel]) => channel === 'file:changed-on-disk').map(([, payload]) => payload),
    repair: moved.repair ?? null,
    manifest: JSON.parse(await readFile(join(root, 'report', '_report-structure.json'), 'utf8')),
    index: await readFile(join(root, 'report', '_report_INDEX.md'), 'utf8'),
  }

  await mkdir(join(root, 'adoption-report'), { recursive: true })
  await writeFile(join(root, 'adoption-loose.md'), 'Body.\n')
  await writeFile(join(root, 'adoption-report', '_adoption-report_INDEX.md'), '## Running order\n\n- [[adopted]]\n')
  await writeFile(join(root, 'adoption-report', '_report-structure.json'), JSON.stringify({ schema_version: 1, content_root: '', files: [] }, null, 2) + '\n')
  const adoptionPlan = await planRename(
    { sender: { id: 17 } },
    { path: 'adoption-loose.md', newName: 'adopted.md', directory: 'adoption-report' },
  )
  const adopted = await move(
    { sender: { id: 17 } },
    { path: 'adoption-loose.md', newPath: adoptionPlan.newPath },
  )
  const adoptionResult = {
    path: adopted.file.path,
    repair: adopted.repair,
    index: await readFile(join(root, 'adoption-report', '_adoption-report_INDEX.md'), 'utf8'),
  }

  await mkdir(join(root, 'root-source'), { recursive: true })
  await writeFile(join(root, 'root-source', 'root-part.md'), 'Root-bound body.\n')
  await writeFile(join(root, 'root-source', '_report_INDEX.md'), '## Running order\n\n- [[root-part]]\n')
  await writeFile(join(root, 'root-source', '_report-structure.json'), JSON.stringify({
    schema_version: 1,
    content_root: '',
    files: [{ path: 'root-part.md' }],
  }, null, 2) + '\n')
  const rootMovePlan = await planRename(
    { sender: { id: 17 } },
    { path: 'root-source/root-part.md', newName: 'root-part.md', directory: null },
  )
  const rootMoved = await move(
    { sender: { id: 17 } },
    { path: 'root-source/root-part.md', newPath: rootMovePlan.newPath },
  )
  const rootMoveResult = {
    plan: rootMovePlan,
    path: rootMoved.file.path,
    repair: rootMoved.repair,
    oldExists: await Bun.file(join(root, 'root-source', 'root-part.md')).exists(),
    rootContent: await Bun.file(join(root, 'root-part.md')).exists()
      ? await readFile(join(root, 'root-part.md'), 'utf8')
      : null,
    manifest: JSON.parse(await readFile(join(root, 'root-source', '_report-structure.json'), 'utf8')),
    index: await readFile(join(root, 'root-source', '_report_INDEX.md'), 'utf8'),
  }

  checkpoints.length = 0
  sent.length = 0
  failCheckpoint = true
  await writeFile(join(root, 'report', 'move-broken.md'), 'Body.\n')
  await writeFile(join(root, 'report', '_report-structure.json'), JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'move-broken.md' }] }, null, 2) + '\n')
  await writeFile(join(root, 'move-broken-ref.md'), 'See [[move-broken]].\n')
  const moveFailurePlan = await planRename(
    { sender: { id: 17 } },
    { path: 'report/move-broken.md', newName: 'move-broken.md', directory: 'archive' },
  )
  const movedWithWarning = await move(
    { sender: { id: 17 } },
    { path: 'report/move-broken.md', newPath: moveFailurePlan.newPath },
  )
  const moveFailureResult = {
    path: movedWithWarning.file.path,
    warning: movedWithWarning.repair?.unrepairedReferences ?? [],
    issues: movedWithWarning.repair?.issues ?? [],
    targetExists: await readFile(join(root, 'archive', 'move-broken.md'), 'utf8'),
    ref: await readFile(join(root, 'move-broken-ref.md'), 'utf8'),
  }

  failCheckpoint = false
  await mkdir(join(root, 'bystander-link', 'elsewhere'), { recursive: true })
  await mkdir(join(root, 'bystander-link', 'report'), { recursive: true })
  await writeFile(join(root, 'bystander-link', 'elsewhere', 'target.md'), 'Stable target.\n')
  await writeFile(join(root, 'bystander-link', 'report', 'old.md'), 'Moving target.\n')
  await writeFile(join(root, 'bystander-link', 'report', 'ref.md'), 'A [[old]] and a [[target]].\n')
  const bystanderLinkPlan = await planRename(
    { sender: { id: 17 } },
    { path: 'bystander-link/report/old.md', newName: 'target.md', directory: 'bystander-link/report' },
  )
  const bystanderLink = await rename(
    { sender: { id: 17 } },
    { path: 'bystander-link/report/old.md', newPath: bystanderLinkPlan.newPath },
  )
  const bystanderLinkResult = {
    path: bystanderLink.file.path,
    repair: bystanderLink.repair,
    ref: await readFile(join(root, 'bystander-link', 'report', 'ref.md'), 'utf8'),
  }

  await mkdir(join(root, 'bystander-manifest', 'contents'), { recursive: true })
  await writeFile(join(root, 'bystander-manifest', 'x.md'), 'Stable part.\n')
  await writeFile(join(root, 'bystander-manifest', 'contents', 'old.md'), 'Moving part.\n')
  const bystanderManifestBefore = JSON.stringify({
    schema_version: 1,
    content_root: 'contents',
    files: [
      { path: 'x.md', title: 'The stable part' },
      { path: 'old.md', title: 'The moving part' },
    ],
  }, null, 2) + '\n'
  await writeFile(join(root, 'bystander-manifest', '_report-structure.json'), bystanderManifestBefore)
  const bystanderManifestPlan = await planRename(
    { sender: { id: 17 } },
    { path: 'bystander-manifest/contents/old.md', newName: 'x.md', directory: 'bystander-manifest/contents' },
  )
  const bystanderManifest = await rename(
    { sender: { id: 17 } },
    { path: 'bystander-manifest/contents/old.md', newPath: bystanderManifestPlan.newPath },
  )
  const bystanderManifestResult = {
    path: bystanderManifest.file.path,
    repair: bystanderManifest.repair,
    manifest: await readFile(join(root, 'bystander-manifest', '_report-structure.json'), 'utf8'),
  }

  await mkdir(join(root, 'scoped-orphan', 'report', 'contents', 'parts'), { recursive: true })
  await writeFile(join(root, 'scoped-orphan', 'guide.md'), '# Guide\n')
  await writeFile(join(root, 'scoped-orphan', 'report', 'contents', 'parts', 'guide.md'), 'Report part.\n')
  await writeFile(join(root, 'scoped-orphan', 'report', '_report_INDEX.md'), '# Report\n\n## Running order\n\n- [[Guide]]\n')
  await writeFile(join(root, 'scoped-orphan', 'report', '_report-structure.json'), JSON.stringify({ schema_version: 1, content_root: 'contents/parts', files: [] }, null, 2) + '\n')
  const scopedOrphanPlan = await planRename(
    { sender: { id: 17 } },
    { path: 'scoped-orphan/report/contents/parts/guide.md', newName: 'opening.md', directory: 'scoped-orphan/report/contents/parts' },
  )
  const scopedOrphan = await rename(
    { sender: { id: 17 } },
    { path: 'scoped-orphan/report/contents/parts/guide.md', newPath: scopedOrphanPlan.newPath },
  )
  const scopedOrphanResult = {
    path: scopedOrphan.file.path,
    repair: scopedOrphan.repair,
    index: await readFile(join(root, 'scoped-orphan', 'report', '_report_INDEX.md'), 'utf8'),
  }

  await mkdir(join(root, 'scoped-unaffected', 'report', 'contents', 'parts'), { recursive: true })
  await mkdir(join(root, 'scoped-unaffected', 'elsewhere'), { recursive: true })
  await writeFile(join(root, 'scoped-unaffected', 'report', 'contents', 'parts', 'guide.md'), 'Report part.\n')
  await writeFile(join(root, 'scoped-unaffected', 'report', '_report_INDEX.md'), '# Report\n\n## Running order\n\n- [[Guide]]\n')
  await writeFile(join(root, 'scoped-unaffected', 'report', '_report-structure.json'), JSON.stringify({ schema_version: 1, content_root: 'contents/parts', files: [] }, null, 2) + '\n')
  await writeFile(join(root, 'scoped-unaffected', 'elsewhere', 'old.md'), '# Guide\n')
  const scopedUnaffectedPlan = await planRename(
    { sender: { id: 17 } },
    { path: 'scoped-unaffected/elsewhere/old.md', newName: 'guide.md', directory: 'scoped-unaffected' },
  )
  const scopedUnaffected = await rename(
    { sender: { id: 17 } },
    { path: 'scoped-unaffected/elsewhere/old.md', newPath: scopedUnaffectedPlan.newPath },
  )
  const scopedUnaffectedResult = {
    path: scopedUnaffected.file.path,
    repair: scopedUnaffected.repair,
    index: await readFile(join(root, 'scoped-unaffected', 'report', '_report_INDEX.md'), 'utf8'),
  }
  await rm(root, { recursive: true, force: true })
  console.log(JSON.stringify({
    firstResult, traversalResult, failureResult, writeFailureResult, rollbackFailureResult,
    moveResult, adoptionResult, rootMoveResult, moveFailureResult, bystanderLinkResult, bystanderManifestResult,
    scopedOrphanResult, scopedUnaffectedResult,
  }))
`

async function realIpcRenameDoor() {
  const child = Bun.spawn([process.execPath, '-e', ipcProbe], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdout: 'pipe', stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`The real rename IPC probe failed: ${stderr}`)
  return JSON.parse(stdout)
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

test('the real file:rename handler checkpoints and notifies every repaired path', async () => {
  const { firstResult } = await realIpcRenameDoor()
  expect(firstResult).toEqual({
    plan: { newPath: '2026-08-10.md', repairPaths: ['ref.md'] },
    path: '2026-08-10.md',
    checkpoints: ['ref.md'],
    changedOnDisk: [['ref.md']],
    repair: { writtenPaths: ['ref.md'], unrepairedReferences: [], issues: [] },
    ref: 'See [[2026-08-10]].\n',
  })
})

test('the real file:rename handler reports a completed rename with a repair warning', async () => {
  const { failureResult } = await realIpcRenameDoor()
  expect(failureResult).toEqual({
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

test('the sidebar rename door proceeds and names wikilink and manifest bystanders without rewriting them', async () => {
  const { bystanderLinkResult, bystanderManifestResult } = await realIpcRenameDoor()

  expect(bystanderLinkResult).toMatchObject({
    path: 'bystander-link/report/target.md',
    repair: {
      unrepairedReferences: [
        expect.stringContaining('bystander-link/report/ref.md: [[target]] changed meaning'),
      ],
    },
    ref: 'A [[target]] and a [[target]].\n',
  })
  expect(bystanderManifestResult).toMatchObject({
    path: 'bystander-manifest/contents/x.md',
    repair: {
      unrepairedReferences: expect.arrayContaining([
        expect.stringContaining('The stable part (x.md) changed meaning'),
      ]),
    },
  })
  expect(JSON.parse(bystanderManifestResult.manifest).files[0]).toEqual({
    path: 'x.md',
    title: 'The stable part',
  })
})

test('both rename doors repair an Index Note through the scoped Folio outline resolver', async () => {
  const [agentDoor, { scopedOrphanResult: sidebarDoor }] = await Promise.all([
    agentScopedPlanProbe('orphan'),
    realIpcRenameDoor(),
  ])

  expect(agentDoor).toMatchObject({
    isError: undefined,
    oldExists: false,
    newExists: true,
    index: '# Report\n\n## Running order\n\n- [[opening]]\n',
    repair: {
      writtenPaths: ['report/_report_INDEX.md'],
      unrepairedReferences: [],
      issues: [],
    },
  })
  expect(sidebarDoor).toEqual({
    path: 'scoped-orphan/report/contents/parts/opening.md',
    index: '# Report\n\n## Running order\n\n- [[opening]]\n',
    repair: {
      writtenPaths: ['scoped-orphan/report/_report_INDEX.md'],
      unrepairedReferences: [],
      issues: [],
    },
  })
})

test('both rename doors allow an unrelated rename that leaves the scoped Folio outline unchanged', async () => {
  const [agentDoor, { scopedUnaffectedResult: sidebarDoor }] = await Promise.all([
    agentScopedPlanProbe('unaffected'),
    realIpcRenameDoor(),
  ])

  expect(agentDoor).toMatchObject({
    isError: undefined,
    oldExists: false,
    newExists: true,
    index: '# Report\n\n## Running order\n\n- [[Guide]]\n',
    repair: { writtenPaths: [], unrepairedReferences: [], issues: [] },
  })
  expect(agentDoor.text).not.toContain('The rename was not made')
  expect(sidebarDoor).toEqual({
    path: 'scoped-unaffected/guide.md',
    index: '# Report\n\n## Running order\n\n- [[Guide]]\n',
    repair: { writtenPaths: [], unrepairedReferences: [], issues: [] },
  })
})

test('both rename doors checkpoint after the rename and keep checkpoint failure as a warning', async () => {
  const [agentDoor, { failureResult: ipcDoor }] = await Promise.all([
    agentRenameCheckpointFailure(),
    realIpcRenameDoor(),
  ])

  expect(agentDoor).toMatchObject({
    isError: undefined,
    checkpointState: { oldExists: false, newExists: true },
    oldExists: false,
    newExists: true,
    ref: 'See [[old]].\n',
  })
  expect(agentDoor.warning).toEqual(['ref.md: [[old]]'])
  expect(agentDoor.issues).toEqual([
    { kind: 'reference', text: 'ref.md: [[old]]' },
    { kind: 'file', text: 'ref.md' },
    { kind: 'reason', text: expect.stringContaining('injected repair checkpoint failure') },
  ])
  expect(ipcDoor).toMatchObject({
    path: 'broken-new.md',
    checkpointState: { oldExists: false, newExists: true },
    targetExists: 'Body.\n',
    ref: 'See [[broken-old]].\n',
  })
  expect(ipcDoor.warning).toEqual(['broken-ref.md: [[broken-old]]'])
  expect(ipcDoor.issues).toEqual([
    { kind: 'reference', text: 'broken-ref.md: [[broken-old]]' },
    { kind: 'file', text: 'broken-ref.md' },
    { kind: 'reason', text: expect.stringContaining('injected repair checkpoint failure') },
  ])
})

test('both rename doors deliver the failed references and repair-write reason', async () => {
  const [agentDoor, { writeFailureResult: ipcDoor }] = await Promise.all([
    agentRenameWriteFailure(false),
    realIpcRenameDoor(),
  ])

  expect(agentDoor.text).toBe(formatRenameRepairMessage('Renamed to new.md', agentDoor.repair))
  for (const repair of [agentDoor.repair, ipcDoor.repair]) {
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
  expect(ipcDoor.ref).toBe('See [[write-old]].\n')
})

test('a written file keeps its genuinely unrepaired running-order reference on both doors', async () => {
  const agentDoor = await agentMixedManifestFailure()

  expect(agentDoor.index).toBe('## Running order\n\n- [[old]]\n\nSee also [[moved]] in prose.\n')
  expect(agentDoor.repair.writtenPaths).toEqual(['report/_report_INDEX.md'])
  expect(agentDoor.repair.unrepairedReferences).not.toContain(
    'report/_report_INDEX.md: [[old]] was left unchanged because the renamed file left this report.',
  )
  expect(agentDoor.repair.unrepairedReferences).not.toContain('report/_report_INDEX.md: [[old]]')
  expect(agentDoor.text).toContain(
    'report/_report_INDEX.md: [[old]] was left unchanged because the renamed file left this report.',
  )
  expect(agentDoor.text).not.toContain('could not repair 2 references')

})

test('both rename doors report a preserved plan line identically without failure wording', async () => {
  const [agentDoor, { moveResult: sidebarDoor }] = await Promise.all([
    agentPlanNoticeProbe('preserved'),
    realIpcRenameDoor(),
  ])

  expect(agentDoor.repair).toEqual(sidebarDoor.repair)
  const agentMessage = formatRenameRepairMessage('', agentDoor.repair)
  const sidebarMessage = formatRenameRepairMessage('', sidebarDoor.repair)
  expect(agentMessage).toBe(sidebarMessage)
  expect(agentMessage).toContain(
    'Preserved plan line: report/_report_INDEX.md: [[part]] was left unchanged because the renamed file left this report.',
  )
  expect(agentMessage).not.toContain('could not repair')
  expect(agentMessage).not.toContain('Warning')
})

test('both rename doors report adoption as the same available action without writing', async () => {
  const [agentDoor, { adoptionResult: sidebarDoor }] = await Promise.all([
    agentPlanNoticeProbe('available'),
    realIpcRenameDoor(),
  ])

  expect(agentDoor.repair).toEqual(sidebarDoor.repair)
  expect(agentDoor.repair.writtenPaths).toEqual([])
  expect(sidebarDoor.repair.writtenPaths).toEqual([])
  const agentMessage = formatRenameRepairMessage('', agentDoor.repair)
  const sidebarMessage = formatRenameRepairMessage('', sidebarDoor.repair)
  expect(agentMessage).toBe(sidebarMessage)
  expect(agentMessage).toContain(
    'Available action: adoption-report/adopted.md now matches planned part [[adopted]] in adoption-report/_adoption-report_INDEX.md; you can adopt it when you want to.',
  )
  expect(agentMessage).not.toContain('Completed repair')
})

test('both rename doors preserve and report content written after repair apply began', async () => {
  const [agentDoor, { rollbackFailureResult: ipcDoor }] = await Promise.all([
    agentRenameWriteFailure(true),
    realIpcRenameDoor(),
  ])

  for (const [repair, oldName] of [[agentDoor.repair, 'old'], [ipcDoor.repair, 'rollback-old']] as const) {
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
  expect(ipcDoor.changedOnDisk).toEqual([['a-ref.md']])
  expect(ipcDoor.firstRef).toBe('See [[rollback-new]].\nA concurrent paragraph survives.\n')
  expect(ipcDoor.secondRef).toBe('See [[rollback-old]].\n')
})

test('the real file:move handler repairs the report and notifies every rewritten path', async () => {
  const { moveResult } = await realIpcRenameDoor()
  expect(moveResult).toEqual({
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
    },
    manifest: { schema_version: 1, content_root: '', files: [] },
    index: '# Report\n\n## Running order\n\n- [[part]]\n',
  })
})

test('the real file:move handler moves a nested file to the workspace root and repairs its references', async () => {
  const { rootMoveResult } = await realIpcRenameDoor()
  expect(rootMoveResult).toEqual({
    plan: { newPath: 'root-part.md', repairPaths: ['root-source/_report-structure.json'] },
    path: 'root-part.md',
    repair: {
      writtenPaths: ['root-source/_report-structure.json'],
      unrepairedReferences: [],
      issues: [
        {
          kind: 'outcome',
          text: 'root-source/_report-structure.json: root-part.md was removed because root-part.md left the report folder.',
        },
      ],
    },
    oldExists: false,
    rootContent: 'Root-bound body.\n',
    manifest: { schema_version: 1, content_root: '', files: [] },
    index: '## Running order\n\n- [[root-part]]\n',
  })
})

test('the real rename and move handlers keep traversal-like typed names inside the chosen folder', async () => {
  const { traversalResult } = await realIpcRenameDoor()
  expect(traversalResult).toEqual({
    renamePlan: { newPath: '..-x.md', repairPaths: [] },
    renamePath: '..-x.md',
    renameContent: 'Rename traversal.\n',
    movePlan: { newPath: 'safe-dir/..-x.md', repairPaths: [] },
    movePath: 'safe-dir/..-x.md',
    moveContent: 'Move traversal.\n',
  })
})

test('the real file:move handler reports a completed move with a repair warning', async () => {
  const { moveFailureResult } = await realIpcRenameDoor()
  expect(moveFailureResult).toEqual({
    path: 'archive/move-broken.md',
    warning: [
      'report/_report-structure.json: move-broken.md was removed because archive/move-broken.md left the report folder.',
    ],
    issues: [
      { kind: 'reference', text: 'report/_report-structure.json: move-broken.md was removed because archive/move-broken.md left the report folder.' },
      { kind: 'file', text: 'report/_report-structure.json' },
      { kind: 'reason', text: expect.stringContaining('injected repair checkpoint failure') },
    ],
    targetExists: 'Body.\n',
    ref: 'See [[move-broken]].\n',
  })
})

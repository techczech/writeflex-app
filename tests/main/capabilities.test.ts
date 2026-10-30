import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBridle, createManifest, scriptedSessionFactory, type Capability, type AgentTrigger, type CapabilityContext } from '@bridle/core'
import { Workspace } from '../../src/main/workspace'
import { ScrapStore } from '../../src/main/scraps'
import { buildWriteFlexManifest, capabilityEnabled, mergeFrontmatterKeys, resolveProseInsert, resolveProseMove, setFrontmatterKeys, writeflexApprovalPolicy, type ProseEditInput, type ProseInsertInput, type ProseMoveInput } from '../../src/main/capabilities'

let root: string
let ws: Workspace
const ctx: CapabilityContext = {
  trigger: { id: 't', source: 'user', trust: 'interactive' },
  sessionId: 's', attemptId: 'attempt', idempotencyKey: 'attempt', audit: () => {}
}
function cap(name: string): Capability {
  const found = buildWriteFlexManifest(ws).capabilities.find((c) => c.name === name)
  if (!found) throw new Error(`missing capability ${name}`)
  return found
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-cap-'))
  ws = new Workspace(root)
  await writeFile(join(root, 'draft.md'), '# Draft\n\nThe very quick fox.\n')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

test('manifest passes bridle validation and scopes to the workspace root', () => {
  const manifest = createManifest(buildWriteFlexManifest(ws))
  expect(manifest.workspaceRoot).toBe(root)
  expect(manifest.capabilities.map((c) => c.name).sort()).toEqual([
    'files.list', 'files.read', 'folio.create_manifest', 'folio.turn_back', 'frontmatter.normalise', 'frontmatter.set', 'history.follow', 'history.undo_follow',
    'housekeeping.create_file', 'housekeeping.rename_file', 'notes.create', 'objects.insert', 'plan.compare_parts', 'plan.propose', 'plan.read',
    'prose.edit', 'prose.insert', 'prose.move', 'research.capture', 'scratchpad.attach_evidence', 'scratchpad.cite', 'scratchpad.collect', 'scratchpad.delete', 'scratchpad.external_collect', 'scratchpad.external_search', 'scratchpad.get', 'scratchpad.group', 'scratchpad.insert', 'scratchpad.insert_quote', 'scratchpad.inventory', 'scratchpad.link', 'scratchpad.list', 'scratchpad.put_back', 'scratchpad.reject', 'scratchpad.restore', 'scratchpad.send_text', 'scratchpad.sources', 'sources.attach', 'sources.list', 'tasks.list', 'tasks.toggle', 'widgets.create', 'widgets.insert', 'widgets.list', 'widgets.remove'
  ])
})

test('files.read does not declare touched paths because Bridle snapshots every declared path', () => {
  const read = cap('files.read')
  expect(read.touchedPaths).toBeUndefined()
})

test('scrap capabilities appear only when a ScrapStore service is provided', () => {
  const names = buildWriteFlexManifest(ws, undefined, { scraps: new ScrapStore(ws) }).capabilities.map((c) => c.name)
  expect(names).toContain('scraps.add')
  expect(names).toContain('scraps.list')
  // Without a service they are absent — a unit/e2e-double manifest never offers them.
  expect(buildWriteFlexManifest(ws).capabilities.map((c) => c.name)).not.toContain('scraps.add')
})

test('policy: prose stages even for interactive; housekeeping allows; reads allow; background stages writes', async () => {
  const policy = writeflexApprovalPolicy()
  const interactive: AgentTrigger = { id: 'u', source: 'user', trust: 'interactive' }
  const background: AgentTrigger = { id: 'b', source: 'schedule', trust: 'background' }
  expect(await policy({ capability: { name: 'prose.edit', risk: 'write' }, input: {}, trigger: interactive })).toBe('stage')
  expect(await policy({ capability: { name: 'housekeeping.create_file', risk: 'write' }, input: {}, trigger: interactive })).toBe('allow')
  expect(await policy({ capability: { name: 'files.read', risk: 'read' }, input: {}, trigger: background })).toBe('allow')
  expect(await policy({ capability: { name: 'housekeeping.create_file', risk: 'write' }, input: {}, trigger: background })).toBe('stage')
  // frontmatter.normalise stages even for an interactive trigger — it rewrites files, one per Suggestion.
  expect(await policy({ capability: { name: 'frontmatter.normalise', risk: 'write' }, input: {}, trigger: interactive })).toBe('stage')
  expect(await policy({ capability: { name: 'objects.insert', risk: 'write' }, input: {}, trigger: interactive })).toBe('stage')
  // folio.create_manifest is housekeeping — allowed immediately for an interactive trigger.
  expect(await policy({ capability: { name: 'folio.create_manifest', risk: 'write' }, input: {}, trigger: interactive })).toBe('allow')
})

test('policy: malformed staged prose carries the structural validation reason in its denial', async () => {
  await ws.saveFile('draft.md', '# Draft\n\nRepeat me.\n\nAnchor.\n\nRepeat me.\n')
  const policy = writeflexApprovalPolicy(undefined, ws)
  const trigger: AgentTrigger = { id: 'u', source: 'user', trust: 'interactive' }
  const malformed = [
    ['prose.edit', { path: 'draft.md', oldText: 'Repeat me.', newText: 'Once.', category: 'wording', summary: 'Deduplicate' }, 'oldText is not unique'],
    ['prose.move', { path: 'draft.md', text: 'Repeat me.', insertAfter: 'Anchor.', summary: 'Move duplicate text' }, 'text is not unique'],
    ['prose.insert', { path: 'draft.md', text: 'New.', insertAfter: 'Missing.', category: 'other', summary: 'Insert' }, 'insertAfter was not found'],
    ['objects.insert', { path: 'draft.md', kind: 'mermaid', content: 'diagram LR\n  A --> B' }, 'supported diagram type'],
    ['frontmatter.normalise', { path: 'draft.md' }, 'has no existing frontmatter block'],
    ['frontmatter.set', { path: 'draft.md', set: {} }, 'set must name at least one'],
  ] as const
  for (const [name, input, reason] of malformed) {
    const decision = await policy({ capability: { name, risk: 'write' }, input, trigger })
    expect(decision).toEqual({
      decision: 'deny',
      reason: {
        code: 'writeflex-stage-validation',
        message: expect.stringContaining(reason),
      },
    })
  }
  expect(await policy({
    capability: { name: 'prose.move', risk: 'write' },
    input: { path: 'draft.md', text: 'Anchor.', insertAfter: '# Draft', summary: 'Valid move' },
    trigger,
  })).toBe('stage')
})

test('policy: unsafe existing frontmatter is a reason-bearing denial before a proposal can exist', async () => {
  const original = '---\nstatus: idea\n\n  continued after a blank\n---\n\n# Draft\n'
  await ws.saveFile('unsafe.md', original)
  const policy = writeflexApprovalPolicy(undefined, ws)
  const decision = await policy({
    capability: { name: 'frontmatter.set', risk: 'write' },
    input: { path: 'unsafe.md', set: { status: 'ready' } },
    trigger: { id: 'u', source: 'user', trust: 'interactive' },
  })

  expect(decision).toEqual({
    decision: 'deny',
    reason: {
      code: 'writeflex-stage-validation',
      message: expect.stringMatching(/unsafe\.md.*continued after a blank/),
    },
  })
  expect((await ws.readFile('unsafe.md')).content).toBe(original)
})

// ---- Task 17: Agent Permissions — a settings-backed filter, deny-by-default honoured ----------

test('permissions: a switched-off capability is excluded from the manifest at bind', () => {
  const enabled = (name: string): boolean => name !== 'housekeeping.create_file'
  const names = buildWriteFlexManifest(ws, enabled).capabilities.map((c) => c.name).sort()
  expect(names).toEqual([
    'files.list', 'files.read', 'folio.create_manifest', 'folio.turn_back', 'frontmatter.normalise', 'frontmatter.set', 'history.follow', 'history.undo_follow', 'housekeeping.rename_file', 'notes.create', 'objects.insert', 'plan.compare_parts', 'plan.propose', 'plan.read', 'prose.edit', 'prose.insert', 'prose.move', 'research.capture', 'scratchpad.attach_evidence', 'scratchpad.cite', 'scratchpad.collect', 'scratchpad.delete', 'scratchpad.external_collect', 'scratchpad.external_search', 'scratchpad.get', 'scratchpad.group', 'scratchpad.insert', 'scratchpad.insert_quote', 'scratchpad.inventory', 'scratchpad.link', 'scratchpad.list', 'scratchpad.put_back', 'scratchpad.reject', 'scratchpad.restore', 'scratchpad.send_text', 'scratchpad.sources', 'sources.attach', 'sources.list', 'tasks.list', 'tasks.toggle', 'widgets.create', 'widgets.insert', 'widgets.list', 'widgets.remove'
  ])
})

test('permissions: the policy denies a switched-off capability even for an interactive trigger', async () => {
  const policy = writeflexApprovalPolicy((name) => name !== 'housekeeping.create_file')
  const interactive: AgentTrigger = { id: 'u', source: 'user', trust: 'interactive' }
  expect(await policy({ capability: { name: 'housekeeping.create_file', risk: 'write' }, input: {}, trigger: interactive })).toBe('deny')
  expect(await policy({ capability: { name: 'housekeeping.rename_file', risk: 'write' }, input: {}, trigger: interactive })).toBe('allow')
})

test('capabilityEnabled: reads the settings key live; only an explicit false disables; unmapped names stay on', () => {
  const values: Record<string, unknown> = { 'permissions.createFiles': false }
  const get = (key: string): unknown => values[key] ?? null
  expect(capabilityEnabled('housekeeping.create_file', get)).toBe(false)
  expect(capabilityEnabled('housekeeping.rename_file', get)).toBe(true) // unset → default on
  expect(capabilityEnabled('files.read', get)).toBe(true)
  values['permissions.readWorkspace'] = false
  expect(capabilityEnabled('files.read', get)).toBe(false)
  expect(capabilityEnabled('files.list', get)).toBe(false) // one switch covers both read lanes
  expect(capabilityEnabled('plan.read', get)).toBe(false) // …and the report-plan reads
  expect(capabilityEnabled('plan.compare_parts', get)).toBe(false)
  expect(capabilityEnabled('sources.list', get)).toBe(false) // …and a piece's sources
  expect(capabilityEnabled('some.future_capability', get)).toBe(true)
})

test('prose.edit applies a unique exact replacement and reports its category', async () => {
  const input: ProseEditInput = { path: 'draft.md', oldText: 'The very quick fox.', newText: 'The quick fox.', category: 'wording', summary: 'Drop filler word' }
  const result = await cap('prose.edit').execute(input, ctx)
  expect(result.isError).toBeUndefined()
  expect((await ws.readFile('draft.md')).content).toContain('The quick fox.')
  const missing = await cap('prose.edit').execute({ ...input, oldText: 'nope' }, ctx)
  expect(missing.isError).toBe(true)
})

test('prose.edit category schema includes the other fallback', () => {
  const schema = cap('prose.edit').parameters as { properties: { category: { anyOf: Array<{ const: string }>; description: string } } }
  expect(schema.properties.category.anyOf.map((entry) => entry.const)).toEqual([
    'typo', 'grammar', 'wording', 'structure', 'clarity', 'tone', 'other'
  ])
  expect(schema.properties.category.description).toBe('Writer-facing edit category assigned by the agent; use `other` only when none of the specific categories fit.')
})

test('prose.edit rejects non-unique oldText', async () => {
  await ws.saveFile('draft.md', 'same\nsame\n')
  const result = await cap('prose.edit').execute(
    { path: 'draft.md', oldText: 'same', newText: 'x', category: 'wording', summary: 's' }, ctx)
  expect(result.isError).toBe(true)
  expect(result.text).toMatch(/unique/i)
})

test('housekeeping.create_file refuses overwrite; rename moves; touchedPaths declared', async () => {
  const create = cap('housekeeping.create_file')
  expect(create.touchedPaths!({ path: 'new.md', content: '' })).toEqual([join(root, 'new.md')])
  const ok = await create.execute({ path: 'new.md', content: '# New\n' }, ctx)
  expect(ok.isError).toBeUndefined()
  const dup = await create.execute({ path: 'new.md', content: 'x' }, ctx)
  expect(dup.isError).toBe(true)
  const rename = cap('housekeeping.rename_file')
  const renameInput = { path: 'new.md', newPath: 'newer.md' }
  const resolvedTouchedPaths = Object.freeze(await rename.touchedPaths!(renameInput))
  const renamed = await rename.execute(renameInput, { ...ctx, resolvedTouchedPaths })
  expect(renamed.isError).toBeUndefined()
  expect((await ws.listFiles()).map((f) => f.path)).toContain('newer.md')
})

test('rename touchedPaths matches the real destination for bare names in subfolders', async () => {
  await ws.createFile('notes/draft.md', '# D\n')
  const rename = cap('housekeeping.rename_file')
  const touched = await rename.touchedPaths!({ path: 'notes/draft.md', newPath: 'final.md' })
  expect(touched).toEqual([join(root, 'notes/draft.md'), join(root, 'notes/final.md')])
  const result = await rename.execute(
    { path: 'notes/draft.md', newPath: 'final.md' },
    { ...ctx, resolvedTouchedPaths: Object.freeze(touched) },
  )
  expect(result.isError).toBeUndefined()
  expect((await ws.listFiles()).map((f) => f.path)).toContain('notes/final.md')
})

test('housekeeping.rename_file declares exactly the structural and repair paths it applies', async () => {
  await ws.saveFile('old.md', 'Body.\n')
  await ws.saveFile('first-ref.md', 'See [[old]].\n')
  await ws.saveFile('second-ref.md', 'Again [[old]].\n')
  const rename = cap('housekeeping.rename_file')
  const input = { path: 'old.md', newPath: 'new.md' }
  const declared = await rename.touchedPaths!(input)

  const result = await rename.execute(input, {
    ...ctx,
    resolvedTouchedPaths: Object.freeze(declared),
  })
  expect(result.isError).toBeUndefined()
  const details = result.details as { repair: { writtenPaths: string[] } }
  const applied = [join(root, 'old.md'), join(root, 'new.md'), ...details.repair.writtenPaths.map((path) => join(root, path))]

  expect(new Set(declared)).toEqual(new Set(applied))
})

test('the agent rename door refuses both wikilink and manifest bystanders before writing anything', async () => {
  await mkdir(join(root, 'elsewhere'), { recursive: true })
  await mkdir(join(root, 'report'), { recursive: true })
  await ws.saveFile('elsewhere/target.md', 'Stable target.\n')
  await ws.saveFile('report/old.md', 'Moving target.\n')
  await ws.saveFile('report/ref.md', 'A [[old]] and a [[target]].\n')
  const wikilinkRename = cap('housekeeping.rename_file')
  const wikilinkInput = { path: 'report/old.md', newPath: 'report/target.md' }
  const wikilinkTouched = Object.freeze(await wikilinkRename.touchedPaths!(wikilinkInput))

  const wikilinkResult = await wikilinkRename.execute(wikilinkInput, { ...ctx, resolvedTouchedPaths: wikilinkTouched })

  expect(wikilinkResult).toMatchObject({
    isError: true,
    text: expect.stringContaining('report/ref.md: [[target]]'),
  })
  expect(await Bun.file(join(root, 'report/old.md')).exists()).toBe(true)
  expect(await Bun.file(join(root, 'report/target.md')).exists()).toBe(false)
  expect((await ws.readFile('report/ref.md')).content).toBe('A [[old]] and a [[target]].\n')

  await mkdir(join(root, 'manifest-report', 'contents'), { recursive: true })
  await ws.saveFile('manifest-report/x.md', 'Stable part.\n')
  await ws.saveFile('manifest-report/contents/old.md', 'Moving part.\n')
  const manifestBefore = `${JSON.stringify({
    schema_version: 1,
    content_root: 'contents',
    files: [
      { path: 'x.md', title: 'The stable part' },
      { path: 'old.md', title: 'The moving part' },
    ],
  }, null, 2)}\n`
  await ws.saveFile('manifest-report/_report-structure.json', manifestBefore)
  const manifestRename = cap('housekeeping.rename_file')
  const manifestInput = { path: 'manifest-report/contents/old.md', newPath: 'manifest-report/contents/x.md' }
  const manifestTouched = Object.freeze(await manifestRename.touchedPaths!(manifestInput))

  const manifestResult = await manifestRename.execute(manifestInput, { ...ctx, resolvedTouchedPaths: manifestTouched })

  expect(manifestResult).toMatchObject({
    isError: true,
    text: expect.stringContaining('The stable part (x.md)'),
  })
  expect(await Bun.file(join(root, 'manifest-report/contents/old.md')).exists()).toBe(true)
  expect(await Bun.file(join(root, 'manifest-report/contents/x.md')).exists()).toBe(false)
  expect((await ws.readFile('manifest-report/_report-structure.json')).content).toBe(manifestBefore)
})

test('housekeeping.rename_file rejects an applied path outside the declared set', async () => {
  const probe = String.raw`
    import { mock } from 'bun:test'
    import { mkdtemp, rm, writeFile } from 'node:fs/promises'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'

    const actualRenameRepair = await import('./src/main/rename-repair.ts')
    mock.module('./src/main/rename-repair.ts', () => ({
      ...actualRenameRepair,
      planRenameRepair: async (_workspace, fromPath, toPath) => ({
        fromPath, toPath, writes: [], manifestChanges: [], unrepairedReferences: [], bystanderReferences: [], plannedReferences: [],
        verification: { markdown: [], manifests: [], renamedContent: 'Body.\\n' },
      }),
      applyRenameRepair: async () => ({ writtenPaths: ['undeclared.md'], unrepairedReferences: [], issues: [] }),
      failedRenameRepairResult: async (_plan, _workspace, error) => ({
        writtenPaths: [],
        unrepairedReferences: [],
        issues: [{ kind: 'reason', text: error instanceof Error ? error.message : String(error) }],
      }),
      formatRenameRepairMessage: (success) => success,
    }))
    const [{ buildWriteFlexManifest }, { Workspace }] = await Promise.all([
      import('./src/main/capabilities.ts'), import('./src/main/workspace.ts'),
    ])
    const root = await mkdtemp(join(tmpdir(), 'writeflex-rename-superset-'))
    try {
    await writeFile(join(root, 'old.md'), 'Body.\\n')
    const workspace = new Workspace(root)
    const rename = buildWriteFlexManifest(workspace).capabilities.find((capability) => capability.name === 'housekeeping.rename_file')
    const input = { path: 'old.md', newPath: 'new.md' }
    const resolvedTouchedPaths = Object.freeze(await rename.touchedPaths(input))
    const result = await rename.execute(input, {
      trigger: { id: 't', source: 'user', trust: 'interactive' },
      sessionId: 's', attemptId: 'attempt', idempotencyKey: 'attempt', audit: () => {}, resolvedTouchedPaths,
    })
    console.log(JSON.stringify(result))
    } finally { await rm(root, { recursive: true, force: true }) }
  `
  const child = Bun.spawn([process.execPath, '-e', probe], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdout: 'pipe', stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  expect(exitCode).toBe(0)
  expect(stderr).toBe('')
  expect(JSON.parse(stdout)).toMatchObject({
    isError: true,
    text: expect.stringMatching(/falls outside .*undeclared\.md/),
  })
})

test('housekeeping.rename_file resolves structural paths for a missing source and fails cleanly at execute time', async () => {
  const rename = cap('housekeeping.rename_file')
  const input = { path: 'old.md', newPath: 'new.md' }
  const resolvedTouchedPaths = Object.freeze(await rename.touchedPaths!(input))

  expect(resolvedTouchedPaths).toEqual([join(root, 'old.md'), join(root, 'new.md')])

  const result = await rename.execute(input, { ...ctx, resolvedTouchedPaths })

  expect(result).toEqual({ isError: true, text: 'File not found: old.md' })
  expect(await Bun.file(join(root, 'new.md')).exists()).toBe(false)
})

test('housekeeping.rename_file touchedPaths is total for boundary errors and readable unlisted sources', async () => {
  await writeFile(join(root, 'notes.txt'), 'Readable non-Markdown source.\n')
  await mkdir(join(root, '.drafts'), { recursive: true })
  await writeFile(join(root, '.drafts/note.md'), 'Readable hidden Markdown source.\n')
  const rename = cap('housekeeping.rename_file')
  const fixtures = [
    { input: { path: '', newPath: 'new.md' }, declared: [], source: '""' },
    { input: { path: '../escape.md', newPath: 'new.md' }, declared: [], source: '../escape.md' },
    { input: { path: 'old.md', newPath: '../escape.md' }, declared: [join(root, 'old.md')], source: 'old.md' },
    { input: { path: 'notes.txt', newPath: 'new.md' }, declared: [join(root, 'notes.txt'), join(root, 'new.md')], source: 'notes.txt' },
    { input: { path: '.drafts/note.md', newPath: 'new.md' }, declared: [join(root, '.drafts/note.md'), join(root, '.drafts/new.md')], source: '.drafts/note.md' },
  ]

  for (const fixture of fixtures) {
    const resolvedTouchedPaths = Object.freeze(await rename.touchedPaths!(fixture.input))
    expect(resolvedTouchedPaths).toEqual(fixture.declared)

    const result = await rename.execute(fixture.input, { ...ctx, resolvedTouchedPaths })
    expect(result.isError).toBe(true)
    expect(result.text).toContain(fixture.source)
  }
})

test('housekeeping.rename_file settles stale without writing when a newly appeared file grows the repair set', async () => {
  await ws.saveFile('old.md', 'Body.\n')
  await ws.saveFile('first-ref.md', 'See [[old]].\n')
  const input = { path: 'old.md', newPath: 'new.md' }
  const bridle = await createBridle({
    manifest: buildWriteFlexManifest(ws),
    appDataDir: join(root, '.agent-data'),
    approvalPolicy: ({ capability }) => capability.risk === 'read' ? 'allow' : 'stage',
    recording: 'off',
    session: scriptedSessionFactory([{
      prompt: 'Rename the report part',
      rounds: [
        { kind: 'tool-calls', calls: [{ name: 'tools.enable', arguments: { names: ['housekeeping.rename_file'] } }] },
        { kind: 'tool-calls', calls: [{ name: 'housekeeping.rename_file', arguments: input }] },
        { kind: 'message', text: 'Rename staged.' },
      ],
    }]),
  })
  await bridle.prompt('Rename the report part', {
    trigger: { id: 'background', source: 'schedule', trust: 'background' },
  })
  const proposal = (await bridle.proposals.list({ capability: 'housekeeping.rename_file' }))[0]!
  await ws.saveFile('appeared-ref.md', 'A newly appeared [[old]] reference.\n')

  const settled = await bridle.proposals.adopt(proposal.id)
  const resolvedAfterGrowth = await buildWriteFlexManifest(ws).capabilities
    .find((capability) => capability.name === 'housekeeping.rename_file')!
    .touchedPaths!(input)

  expect(settled).toMatchObject({ status: 'stale', settlementReason: 'unpreviewed-touched-path' })
  expect(resolvedAfterGrowth).toContain(join(root, 'appeared-ref.md'))
  expect(await Bun.file(join(root, 'old.md')).exists()).toBe(true)
  expect(await Bun.file(join(root, 'new.md')).exists()).toBe(false)
  expect((await ws.readFile('first-ref.md')).content).toBe('See [[old]].\n')
  expect((await ws.readFile('appeared-ref.md')).content).toBe('A newly appeared [[old]] reference.\n')
  await bridle.dispose()
})

test('housekeeping.rename_file checkpoints and notifies every repaired path through the real capability', async () => {
  await ws.saveFile('old.md', 'Body.\n')
  await ws.saveFile('ref.md', 'See [[old]].\n')
  const checkpoints: string[] = []
  const changedOnDisk: string[][] = []
  const rename = buildWriteFlexManifest(ws, undefined, {
    checkpointFile: async (path) => { checkpoints.push(path) },
    notifyFilesChangedOnDisk: (paths) => { changedOnDisk.push(paths) },
  }).capabilities.find((capability) => capability.name === 'housekeeping.rename_file')!

  const input = { path: 'old.md', newPath: 'new.md' }
  const resolvedTouchedPaths = Object.freeze(await rename.touchedPaths!(input))
  const result = await rename.execute(input, { ...ctx, resolvedTouchedPaths })

  expect(result.isError).toBeUndefined()
  expect(checkpoints).toEqual(['ref.md'])
  expect(changedOnDisk).toEqual([['ref.md']])
  expect(result.details).toMatchObject({
    file: { file: { path: 'new.md' } },
    repair: { writtenPaths: ['ref.md'], unrepairedReferences: [] },
  })
})

test('housekeeping.rename_file keeps a completed rename successful when repair checkpointing fails', async () => {
  await ws.saveFile('old.md', 'Body.\n')
  await ws.saveFile('ref.md', 'See [[old]] and again [[old]] and once more [[old]].\n')
  const checkpointStates: Array<{ oldExists: boolean; newExists: boolean }> = []
  const rename = buildWriteFlexManifest(ws, undefined, {
    checkpointFile: async () => {
      checkpointStates.push({
        oldExists: await Bun.file(join(root, 'old.md')).exists(),
        newExists: await Bun.file(join(root, 'new.md')).exists(),
      })
      throw new Error('injected agent repair checkpoint failure')
    },
  }).capabilities.find((capability) => capability.name === 'housekeeping.rename_file')!

  const input = { path: 'old.md', newPath: 'new.md' }
  const resolvedTouchedPaths = Object.freeze(await rename.touchedPaths!(input))
  const result = await rename.execute(input, { ...ctx, resolvedTouchedPaths })

  const repair = (result.details as { repair: { unrepairedReferences: string[]; issues: Array<{ kind: string; text: string }> } }).repair
  expect(repair.unrepairedReferences).toEqual([
    'ref.md: [[old]]',
    'ref.md: [[old]]',
    'ref.md: [[old]]',
  ])
  expect(repair.issues).toEqual([
    { kind: 'reference', text: 'ref.md: [[old]]' },
    { kind: 'reference', text: 'ref.md: [[old]]' },
    { kind: 'reference', text: 'ref.md: [[old]]' },
    { kind: 'file', text: 'ref.md' },
    { kind: 'reason', text: expect.stringContaining('injected agent repair checkpoint failure') },
  ])
  expect(result.text).toContain('could not repair 3 references: ref.md: [[old]] (×3)')
  expect(result.text.match(/ref\.md: \[\[old\]\]/g)).toHaveLength(1)
  expect(result.text).toContain('Repair details: ref.md;')
  expect(result).toMatchObject({
    text: expect.stringContaining('injected agent repair checkpoint failure'),
    details: {
      file: { file: { path: 'new.md' } },
      repair: {
        writtenPaths: [],
      },
    },
  })
  expect(result.isError).toBeUndefined()
  expect(checkpointStates).toEqual([{ oldExists: false, newExists: true }])
  expect((await ws.readFile('ref.md')).content).toBe('See [[old]] and again [[old]] and once more [[old]].\n')
  expect(await Bun.file(join(root, 'old.md')).exists()).toBe(false)
  expect((await ws.readFile('new.md')).content).toBe('Body.\n')
})

test('housekeeping.rename_file keeps a completed rename successful when a repair write fails', async () => {
  await ws.saveFile('old.md', 'Body.\n')
  await ws.saveFile('ref.md', 'See [[old]] and [[old|the written part]].\n')
  class RepairWriteFailureWorkspace extends Workspace {
    override async saveFile(path: string, content: string) {
      if (path === 'ref.md') throw new Error('injected agent repair write failure')
      return super.saveFile(path, content)
    }
  }
  ws = new RepairWriteFailureWorkspace(root)
  const rename = cap('housekeeping.rename_file')
  const input = { path: 'old.md', newPath: 'new.md' }
  const resolvedTouchedPaths = Object.freeze(await rename.touchedPaths!(input))

  const result = await rename.execute(input, { ...ctx, resolvedTouchedPaths })

  expect(result.isError).toBeUndefined()
  expect(result.text).toContain('injected agent repair write failure')
  expect(result.details).toMatchObject({
    file: { file: { path: 'new.md' } },
    repair: {
      writtenPaths: [],
      unrepairedReferences: [
        'ref.md: [[old]]',
        'ref.md: [[old|the written part]]',
      ],
      issues: [
        { kind: 'reference', text: 'ref.md: [[old]]' },
        { kind: 'reference', text: 'ref.md: [[old|the written part]]' },
        { kind: 'file', text: 'ref.md' },
        { kind: 'reason', text: expect.stringContaining('injected agent repair write failure') },
      ],
    },
  })
  expect(result.text).toContain('could not repair 2 references')
  expect(await Bun.file(join(root, 'old.md')).exists()).toBe(false)
  expect((await ws.readFile('new.md')).content).toBe('Body.\n')
  expect((await ws.readFile('ref.md')).content).toBe('See [[old]] and [[old|the written part]].\n')
})

test('housekeeping.rename_file reports a successful manifest removal as an outcome, not a repair failure', async () => {
  await mkdir(join(root, 'report'), { recursive: true })
  await writeFile(join(root, 'report', 'old.md'), 'Body.\n')
  await writeFile(join(root, 'report', '_report-structure.json'), JSON.stringify({
    schema_version: 1,
    content_root: '',
    files: [{ path: 'old.md' }],
  }, null, 2) + '\n')
  const rename = cap('housekeeping.rename_file')
  const input = { path: 'report/old.md', newPath: 'outside/new.md' }
  const resolvedTouchedPaths = Object.freeze(await rename.touchedPaths!(input))

  const result = await rename.execute(input, { ...ctx, resolvedTouchedPaths })

  expect(result.text).toContain('Completed repair action: report/_report-structure.json: old.md was removed because outside/new.md left the report folder.')
  expect(result.text).not.toContain('could not repair')
  expect((result.details as { repair: { unrepairedReferences: string[] } }).repair.unrepairedReferences).toEqual([])
})

test('prose.edit rejects empty oldText with a clear message', async () => {
  const result = await cap('prose.edit').execute(
    { path: 'draft.md', oldText: '', newText: 'x', category: 'wording', summary: 's' }, ctx)
  expect(result.isError).toBe(true)
  expect(result.text).toMatch(/empty/i)
})

test('prose.move schema uses a single insertAfter destination anchor', () => {
  const schema = cap('prose.move').parameters as { required: string[]; properties: Record<string, unknown> }
  expect(schema.required).toContain('insertAfter')
  expect(Object.keys(schema.properties)).toEqual(['path', 'text', 'insertAfter', 'summary'])
})

test('resolveProseMove returns pre-apply source and zero-width destination coordinates', () => {
  const beforeAnchor = '# Draft\n\nFirst paragraph.\n\nSecond paragraph to move.\n\nThird paragraph stays.\n'
  const beforeText = 'Second paragraph to move.'
  const beforeInsertAfter = 'Third paragraph stays.'
  const beforeDestination = beforeAnchor.indexOf(beforeInsertAfter) + beforeInsertAfter.length
  const beforeResolved = resolveProseMove(beforeAnchor, {
    path: 'draft.md',
    text: beforeText,
    insertAfter: beforeInsertAfter,
    summary: 'Move the second paragraph after the third.',
  })
  expect(beforeResolved.moveFrom).toEqual({ from: beforeAnchor.indexOf(beforeText), to: beforeAnchor.indexOf(beforeText) + beforeText.length })
  expect(beforeResolved.moveTo).toEqual({ from: beforeDestination, to: beforeDestination })

  const afterAnchor = '# Draft\n\nFirst paragraph.\n\nSecond paragraph stays.\n\nThird paragraph to move.\n'
  const afterText = 'Third paragraph to move.'
  const afterInsertAfter = 'First paragraph.'
  const afterDestination = afterAnchor.indexOf(afterInsertAfter) + afterInsertAfter.length
  const afterResolved = resolveProseMove(afterAnchor, {
    path: 'draft.md',
    text: afterText,
    insertAfter: afterInsertAfter,
    summary: 'Move the third paragraph after the first.',
  })
  expect(afterResolved.moveFrom).toEqual({ from: afterAnchor.indexOf(afterText), to: afterAnchor.indexOf(afterText) + afterText.length })
  expect(afterResolved.moveTo).toEqual({ from: afterDestination, to: afterDestination })
})

test('resolveProseInsert appends at end for an empty anchor and after a unique anchor otherwise', () => {
  // Empty anchor fills an empty document (the write-into-a-blank-file path prose.edit cannot express).
  expect(resolveProseInsert('', { path: 'draft.md', insertAfter: '', text: '# The Walk\n\nJonas left.', category: 'wording', summary: 'fill' }).nextContent)
    .toBe('# The Walk\n\nJonas left.')
  // Empty anchor appends after existing content with clean paragraph spacing.
  expect(resolveProseInsert('# Draft\n\nOne.\n', { path: 'draft.md', insertAfter: '', text: 'Two.', category: 'wording', summary: 'append' }).nextContent)
    .toBe('# Draft\n\nOne.\n\nTwo.')
  // A unique anchor places the new text right after it.
  expect(resolveProseInsert('# Draft\n\nOne.\n\nThree.\n', { path: 'draft.md', insertAfter: 'One.', text: 'Two.', category: 'wording', summary: 'middle' }).nextContent)
    .toBe('# Draft\n\nOne.\n\nTwo.\n\nThree.\n')
  // A frontmatter document has no legal insertion position before metadata: the empty-anchor lane
  // lands immediately after the closing fence, before the existing body.
  expect(resolveProseInsert('---\ntitle: Draft\n---\n\nBody.\n', { path: 'draft.md', insertAfter: '', text: 'Opening.', category: 'wording', summary: 'opening' }).nextContent)
    .toBe('---\ntitle: Draft\n---\n\nOpening.\n\nBody.\n')
})

test('resolveProseInsert throws for a missing or ambiguous anchor rather than staging a ghost', () => {
  expect(() => resolveProseInsert('# Draft\n\nOne.\n', { path: 'draft.md', insertAfter: 'Nowhere.', text: 'X', category: 'other', summary: 's' })).toThrow(/not found/)
  expect(() => resolveProseInsert('Dup.\n\nDup.\n', { path: 'draft.md', insertAfter: 'Dup.', text: 'X', category: 'other', summary: 's' })).toThrow(/not unique/)
})

test('prose.insert fills an empty file and appends to an existing one through the capability', async () => {
  await ws.saveFile('blank.md', '')
  const fill: ProseInsertInput = { path: 'blank.md', insertAfter: '', text: '# The Run\n\nMara ran.', category: 'wording', summary: 'Write the run story.' }
  const filled = await cap('prose.insert').execute(fill, ctx)
  expect(filled.isError).toBeUndefined()
  expect((await ws.readFile('blank.md')).content).toBe('# The Run\n\nMara ran.')

  const append: ProseInsertInput = { path: 'blank.md', insertAfter: '', text: 'She stopped on the bridge.', category: 'wording', summary: 'Add a closing line.' }
  await cap('prose.insert').execute(append, ctx)
  expect((await ws.readFile('blank.md')).content).toBe('# The Run\n\nMara ran.\n\nShe stopped on the bridge.')
})

test('prose.insert rejects an empty text and a missing anchor without changing the file', async () => {
  await ws.saveFile('draft.md', '# Draft\n\nOne.\n')
  const emptyText = await cap('prose.insert').execute({ path: 'draft.md', insertAfter: '', text: '', category: 'other', summary: 's' }, ctx)
  expect(emptyText.isError).toBe(true)
  const badAnchor = await cap('prose.insert').execute({ path: 'draft.md', insertAfter: 'Nowhere.', text: 'X', category: 'other', summary: 's' }, ctx)
  expect(badAnchor.isError).toBe(true)
  expect((await ws.readFile('draft.md')).content).toBe('# Draft\n\nOne.\n')
})

test('objects.insert validates during preview so invalid markup is rejected before staging', async () => {
  const capability = cap('objects.insert')
  expect(capability.description).toContain('prefer objects.insert over prose.insert')
  expect(capability.description).toContain('flowchart LR\\n  A --> B')
  expect(capability.description).toContain('SVG')
  expect(() => capability.preview!({ path: 'draft.md', kind: 'mermaid', content: 'diagram LR\n  A --> B' }))
    .toThrow(/supported diagram type/i)
  expect(capability.touchedPaths!({ path: 'draft.md', kind: 'mermaid', content: 'diagram LR\n  A --> B' }))
    .toEqual([join(root, 'draft.md')])
  expect(await capability.preview!({ path: 'draft.md', kind: 'markmap', content: '- Root\n  - Child' }))
    .toContain('```markmap')
  expect(await capability.preview!({ path: 'draft.md', kind: 'svg', content: '<svg><rect/></svg>' }))
    .toContain('```svg')
})

test('objects.insert applies a validated SVG through the same staged object path', async () => {
  const result = await cap('objects.insert').execute({
    path: 'draft.md', kind: 'svg', content: '<svg viewBox="0 0 1 1"><rect/></svg>', insertAfter: 'The very quick fox.', summary: 'Add illustration.',
  }, ctx)
  expect(result.isError).toBeUndefined()
  expect((await ws.readFile('draft.md')).content).toContain('```svg\n<svg viewBox="0 0 1 1"><rect/></svg>\n```')
})

test('objects.insert applies a validated fenced block with blank-line separation', async () => {
  const result = await cap('objects.insert').execute({
    path: 'draft.md', kind: 'mermaid', content: 'flowchart LR\n  A --> B', insertAfter: 'The very quick fox.', summary: 'Add flow.',
  }, ctx)
  expect(result.isError).toBeUndefined()
  expect((await ws.readFile('draft.md')).content).toBe('# Draft\n\nThe very quick fox.\n\n```mermaid\nflowchart LR\n  A --> B\n```')
})

// Agent self-correction is the HARNESS's built-in suggestions.retract now (appended by createBridle,
// tested in Bridle core); the app manifest no longer declares a retract of its own. The one app-side
// guarantee worth locking: the policy lets a risk-read capability (which retract is) run immediately.
test('policy: read-risk capabilities (e.g. the built-in suggestions.retract) run immediately', async () => {
  const policy = writeflexApprovalPolicy()
  const interactive: AgentTrigger = { id: 'u', source: 'user', trust: 'interactive' }
  expect(await policy({ capability: { name: 'suggestions.retract', risk: 'read' }, input: {}, trigger: interactive })).toBe('allow')
})

test('prose.move relocates a unique exact block after a unique anchor with clean paragraph spacing', async () => {
  await ws.saveFile('draft.md', '# Draft\n\nFirst paragraph.\n\nSecond paragraph to move.\n\nThird paragraph stays.\n')
  const input: ProseMoveInput = {
    path: 'draft.md',
    text: 'Second paragraph to move.',
    insertAfter: 'Third paragraph stays.',
    summary: 'Move the second paragraph after the third.',
  }
  const result = await cap('prose.move').execute(input, ctx)
  expect(result.isError).toBeUndefined()
  expect((await ws.readFile('draft.md')).content).toBe('# Draft\n\nFirst paragraph.\n\nThird paragraph stays.\n\nSecond paragraph to move.\n')
})

test('prose.move rejects non-unique text or destination anchors without changing the file', async () => {
  const original = '# Draft\n\nRepeat me.\n\nAnchor.\n\nRepeat me.\n'
  await ws.saveFile('draft.md', original)
  const duplicateText = await cap('prose.move').execute(
    { path: 'draft.md', text: 'Repeat me.', insertAfter: 'Anchor.', summary: 'Move duplicate text' },
    ctx,
  )
  expect(duplicateText.isError).toBe(true)
  expect(duplicateText.text).toMatch(/text is not unique/i)
  expect((await ws.readFile('draft.md')).content).toBe(original)

  await ws.saveFile('draft.md', '# Draft\n\nMove me.\n\nAnchor.\n\nAnchor.\n')
  const duplicateAnchor = await cap('prose.move').execute(
    { path: 'draft.md', text: 'Move me.', insertAfter: 'Anchor.', summary: 'Move after duplicate anchor' },
    ctx,
  )
  expect(duplicateAnchor.isError).toBe(true)
  expect(duplicateAnchor.text).toMatch(/insertAfter is not unique/i)
  expect((await ws.readFile('draft.md')).content).toBe('# Draft\n\nMove me.\n\nAnchor.\n\nAnchor.\n')
})

// ---- Task 24: Folio + frontmatter + scrap capabilities ----------------------------------------

test('folio.create_manifest drafts a manifest when absent, then refuses to clobber one that exists', async () => {
  await ws.createFile('report/01-overview.md', '# Overview\n')
  await ws.createFile('report/02-findings.md', '# Findings\n')
  await ws.createFile('report/contents/01-intro.md', '# Intro\n')
  await ws.createFile('report/contents/02-method.md', '# Method\n')
  const create = cap('folio.create_manifest')
  // The manifest and the Folio's agent instructions (ticket 0.23-08): the turn's restore point covers the instructions and their ownership record.
  expect(await create.touchedPaths!({ dir: 'report' })).toEqual(['_report-structure.json', 'AGENTS.md', 'CLAUDE.md', '.folio-instructions.json', '.folio-backup.json', '.folio-turn-back.json', '_report_INDEX.md'].map((name) => join(root, 'report', name)))
  const preview = await create.preview!({ dir: 'report' })
  expect(preview).toContain('Create a Folio manifest in report')
  expect(preview).toContain('"content_root": ""')
  expect(preview).toContain('"path": "01-overview.md"')
  expect(preview).toContain('"path": "02-findings.md"')
  expect(preview).not.toContain('"path": "01-intro.md"')
  const first = await create.execute({ dir: 'report' }, ctx)
  expect(first.isError).toBeUndefined()
  const written = JSON.parse((await ws.readFile('report/_report-structure.json')).content)
  expect(written.content_root).toBe('')
  expect(written.files.map((f: { path: string }) => f.path)).toEqual(['01-overview.md', '02-findings.md'])
  expect(first.text).toContain('Wrote the Folio\'s agent instructions: report/AGENTS.md, report/CLAUDE.md.')
  expect((await ws.readFile('report/CLAUDE.md')).content).toBe('@AGENTS.md\n')
  expect((await ws.readFile('report/AGENTS.md')).content).toContain('<!-- BEGIN WriteFlex Folio instructions (')
  // Only-when-absent: a second call must refuse rather than overwrite the writer's manifest.
  const second = await create.execute({ dir: 'report' }, ctx)
  expect(second.isError).toBe(true)
  expect(second.text).toMatch(/already exists/i)
})

test('folio.create_manifest returns a capability failure when no Markdown parts can seed it', async () => {
  const result = await cap('folio.create_manifest').execute({ dir: 'empty' }, ctx)

  expect(result.isError).toBe(true)
  expect(result.text).toContain('no Markdown files')
})

test('frontmatter.normalise canonicalises existing metadata without adding keys', async () => {
  await ws.saveFile('piece.md', '---\ntitle: "Old: title"\ntags:\n  - one\n  - two\n---\n\n# Body\n\nUntouched prose.\n')
  const result = await cap('frontmatter.normalise').execute({ path: 'piece.md' }, ctx)
  expect(result.isError).toBeUndefined()
  const content = (await ws.readFile('piece.md')).content
  expect(content).toContain('title: "Old: title"')
  expect(content).toContain('tags: [one, two]')
  expect(content).toContain('# Body\n\nUntouched prose.\n') // body bytes preserved
  expect(content.endsWith('Untouched prose.\n')).toBe(true)
})

test('frontmatter.normalise preserves scalar representations it does not edit', async () => {
  const original = '---\ndraft: true\npublished: false\nreviewed: null\nempty: ~\ntags:\n  - one\n  - two\n---\n\n# Body\n'
  await ws.saveFile('typed.md', original)
  const result = await cap('frontmatter.normalise').execute({ path: 'typed.md' }, ctx)
  expect(result.isError).toBeUndefined()
  expect((await ws.readFile('typed.md')).content).toBe(
    '---\ndraft: true\npublished: false\nreviewed: null\nempty: ~\ntags: [one, two]\n---\n\n# Body\n',
  )
})

test('frontmatter.normalise refuses a bare file and directs metadata additions to frontmatter.set', async () => {
  await ws.saveFile('bare.md', '# Just a heading\n\nProse.\n')
  const result = await cap('frontmatter.normalise').execute({ path: 'bare.md' }, ctx)
  expect(result.isError).toBe(true)
  expect(result.text).toContain('frontmatter.set')
  expect((await ws.readFile('bare.md')).content).toBe('# Just a heading\n\nProse.\n')
})

test('frontmatter.set creates canonical metadata on a bare file and serialises arrays safely', async () => {
  await ws.saveFile('bare.md', '# Just a heading\n\nProse.\n')
  const result = await cap('frontmatter.set').execute({
    path: 'bare.md',
    set: { title: 'A: careful title', tags: ['writing', 'research, methods'], draft: 'true' },
    summary: 'Add document metadata',
  }, ctx)
  expect(result.isError).toBeUndefined()
  expect((await ws.readFile('bare.md')).content).toBe(
    '---\ntitle: "A: careful title"\ntags:\n  - writing\n  - "research, methods"\ndraft: "true"\n---\n\n# Just a heading\n\nProse.\n',
  )
})

test('frontmatter.set keeps a thematic-break pull quote outside the new metadata block', async () => {
  const original = '---\nA pull quote opening the piece.\n---\n\n# The actual heading\n\nProse.\n'
  await ws.saveFile('pull-quote.md', original)
  const result = await cap('frontmatter.set').execute({
    path: 'pull-quote.md', set: { status: 'editing' }, summary: 'Set status',
  }, ctx)
  expect(result.isError).toBeUndefined()
  expect((await ws.readFile('pull-quote.md')).content).toBe(`---\nstatus: editing\n---\n\n${original}`)
})

test('setFrontmatterKeys treats a dated epigraph fence pair as prose when the apparent key is not targeted', () => {
  const original = '---\n2026-08-02 : a diary epigraph\nA second prose line.\n---\n\n# The actual heading\n'
  expect(setFrontmatterKeys(original, { goal: '500' }, 'epigraph.md')).toBe(
    `---\ngoal: 500\n---\n\n${original}`,
  )
})

test('setFrontmatterKeys refuses an unquoted target collision inside a prose-classified leading fence pair', () => {
  const original = '---\ngoal : 500\nA second prose line.\n---\n\n# The actual heading\n'
  expect(() => setFrontmatterKeys(original, { goal: '900' }, 'unquoted-collision.md'))
    .toThrow(/unquoted-collision\.md.*line 2 reads .*goal : 500/)
})

for (const [quoteName, keyLine] of [['double-quoted', '"goal" : 500'], ['single-quoted', "'goal' : 500"]]) {
  test(`setFrontmatterKeys treats ${quoteName} malformed-block keys like unquoted keys only when targeted`, () => {
    const original = `---\n${keyLine}\nA second prose line.\n---\n\n# The actual heading\n`
    expect(() => setFrontmatterKeys(original, { goal: '900' }, `${quoteName}-collision.md`))
      .toThrow(new RegExp(`${quoteName}-collision\\.md.*line 2 reads`))
    expect(setFrontmatterKeys(original, { status: 'idea' }, `${quoteName}-epigraph.md`)).toBe(
      `---\nstatus: idea\n---\n\n${original}`,
    )
  })
}

test('setFrontmatterKeys preserves CRLF and untouched lines byte-for-byte', () => {
  const original = '---\r\ntags:\r\n- alpha\r\n- beta\r\npurpose: Keep  two spaces\r\n---\r\n\r\n# Piece\r\n'
  expect(setFrontmatterKeys(original, { status: 'editing' }, 'piece.md')).toBe(
    '---\r\ntags:\r\n- alpha\r\n- beta\r\npurpose: Keep  two spaces\r\nstatus: editing\r\n---\r\n\r\n# Piece\r\n',
  )
})

test('frontmatter.set refuses an unsafe requested key and leaves the file untouched', async () => {
  const original = '---\ntags: |\n  alpha\n  beta\nstatus: idea\n---\n\n# Piece\n'
  await ws.saveFile('unsafe.md', original)
  const result = await cap('frontmatter.set').execute({
    path: 'unsafe.md', set: { tags: ['safe'] }, summary: 'Change tags',
  }, ctx)
  expect(result.isError).toBe(true)
  expect(result.text).toContain('unsafe.md')
  expect(result.text).toContain('tags')
  expect((await ws.readFile('unsafe.md')).content).toBe(original)
})

test('setFrontmatterKeys refuses a nested block-list map and preserves every byte', () => {
  const original = '---\nauthors:\n  - name: Ada\n    role: editor\nstatus: idea\n---\n\n# Piece\n'
  expect(() => setFrontmatterKeys(original, { authors: ['Z'] }, 'authors.md'))
    .toThrow(/authors\.md.*cannot safely rewrite this block: line 3 reads .*name: Ada/)
  expect(original).toBe('---\nauthors:\n  - name: Ada\n    role: editor\nstatus: idea\n---\n\n# Piece\n')
})

test('setFrontmatterKeys refuses a wrapped plain scalar and preserves every byte', () => {
  const original = '---\nstatus: idea and\n  more words\npurpose: essay\n---\n\n# Piece\n'
  expect(() => setFrontmatterKeys(original, { status: 'ready' }, 'wrapped.md'))
    .toThrow(/wrapped\.md.*cannot safely rewrite this block: line 3 reads .*more words/)
  expect(original).toBe('---\nstatus: idea and\n  more words\npurpose: essay\n---\n\n# Piece\n')
})

test('setFrontmatterKeys refuses a multiline double-quoted scalar and preserves every byte', () => {
  const original = '---\ndescription: "Opening words\nstatus: embedded text\nclosing words"\npurpose: essay\n---\n\n# Piece\n'
  expect(() => setFrontmatterKeys(original, { status: 'ready' }, 'quoted.md')).toThrow(/quoted\.md.*description/)
  expect(original).toBe('---\ndescription: "Opening words\nstatus: embedded text\nclosing words"\npurpose: essay\n---\n\n# Piece\n')
})

test('setFrontmatterKeys refuses a multiline single-quoted scalar and preserves every byte', () => {
  const original = "---\ndescription: 'Opening words\nstatus: embedded text\nclosing words'\npurpose: essay\n---\n\n# Piece\n"
  expect(() => setFrontmatterKeys(original, { status: 'ready' }, 'single-quoted.md')).toThrow(/single-quoted\.md.*description/)
  expect(original).toBe("---\ndescription: 'Opening words\nstatus: embedded text\nclosing words'\npurpose: essay\n---\n\n# Piece\n")
})

test('setFrontmatterKeys chooses appended-key EOL from frontmatter rather than the body', () => {
  const original = '---\nstatus: idea\n---\n\nBody with CRLF below.\r\nSecond body line.\r\n'
  expect(setFrontmatterKeys(original, { purpose: 'essay' }, 'mixed-eol.md')).toBe(
    '---\nstatus: idea\npurpose: essay\n---\n\nBody with CRLF below.\r\nSecond body line.\r\n',
  )
})

test('mergeFrontmatterKeys preserves body bytes exactly, updates existing keys, appends new ones', () => {
  const withFm = '---\ntitle: A\nkeep: yes\n---\n\nBody **exact**.\n'
  const merged = mergeFrontmatterKeys(withFm, { title: 'B', status: 'draft' })
  expect(merged).toBe('---\ntitle: B\nkeep: yes\nstatus: draft\n---\n\nBody **exact**.\n')
  // A bare file gains a block; the body follows a blank line, byte-identical.
  expect(mergeFrontmatterKeys('# H\n', { title: 'T' })).toBe('---\ntitle: T\n---\n\n# H\n')
  // An empty set is a no-op.
  expect(mergeFrontmatterKeys(withFm, {})).toBe(withFm)
})

test('mergeFrontmatterKeys refuses an unmodelled nested map instead of appending beside it', () => {
  const nested = '---\nauthors:\n  name: Ada\ntitle: Paper\n---\n\nBody.\n'
  expect(() => mergeFrontmatterKeys(nested, { name: 'Grace' }))
    .toThrow(/cannot safely rewrite this block: line 3 reads .*name: Ada/)
  expect(nested).toBe('---\nauthors:\n  name: Ada\ntitle: Paper\n---\n\nBody.\n')
})

test('scraps.add files a cutting through the shared store and notifies; scraps.list reads it back', async () => {
  const store = new ScrapStore(ws)
  let notified = 0
  const manifest = buildWriteFlexManifest(ws, undefined, { scraps: store, onScrapsChanged: () => { notified += 1 } })
  const capOf = (name: string): Capability => manifest.capabilities.find((c) => c.name === name)!
  const add = capOf('scraps.add')
  expect(add.touchedPaths!({ origin: 'draft.md', text: 't' })).toEqual([join(root, 'scraps/draft-SCRAPS.md')])
  const result = await add.execute({ origin: 'draft.md', text: 'a kept sentence' }, ctx)
  expect(result.isError).toBeUndefined()
  expect(notified).toBe(1) // the pane is told to re-list
  const listed = await capOf('scraps.list').execute({ origin: 'draft.md' }, ctx)
  expect(listed.text).toContain('a kept sentence')
  // The same store the renderer would use sees it too (one instance, one mutex).
  expect((await store.list()).map((s) => s.text)).toContain('a kept sentence')
})


test('history attachment tools always ask interactively and are denied in the background', async () => {
  const policy = writeflexApprovalPolicy()
  for (const name of ['history.follow', 'history.undo_follow']) {
    for (const trust of ['interactive', 'trusted_app', 'background'] as const) {
      expect(await policy({ capability: { name, risk: 'write' }, input: {}, trigger: { id: 'history', source: 'user', trust } })).toBe(trust === 'background' ? 'deny' : 'ask')
    }
  }
})

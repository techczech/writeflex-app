/**
 * Command line and skill, ticket 01 (third round): the path rule is enforced where a capability
 * reads and writes, not by predicting its targets. Seams: the document-only Workspace view, the
 * manifest built over it, and the agent's adoption doors (`applySuggestion`, `resolveChange`).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedSessionFactory, type CapabilityContext } from '@bridle/core'
import { WorkspaceAgent, type ScriptedStep } from '../../src/main/agent'
import { buildWriteFlexManifest } from '../../src/main/capabilities'
import { ChangeStore, closedReasonOf } from '../../src/main/changes'
import { documentOnlyView } from '../../src/main/document-only-workspace'
import { ScrapStore } from '../../src/main/scraps'
import { NotADocumentPathError, Workspace } from '../../src/main/workspace'

const DIR = 'schemas'
const TRACKER = 'schemas/_schemas_INDEX.md'
const PIECE = 'schemas/how-humans-hallucinate.md'
const SCRAPS = 'schemas/scraps/how-humans-hallucinate-SCRAPS.md'
const HALL = 's_mtb9yb2s0xq8'
const trackerText = '# schemas\n\n## Ideas\n\n- [[frames-and-scripts]]\n'
const pieceText = '---\nstatus: editing\n---\n# How humans hallucinate\n\nWe fill gaps.\n'
const scrapsText = `## ${HALL}\nHall's high and low context cultures.\n\n## s_mtb9yb3a1abc\nFamilies share more context.\n`
const SECRET = 'SECRET-LEDGER-TEXT'

let root: string
let appData: string
let ws: Workspace
let changes: ChangeStore
let agent: WorkspaceAgent | undefined

const ctx: CapabilityContext = {
  trigger: { id: 't', source: 'user', trust: 'interactive' },
  sessionId: 's', attemptId: 'attempt', idempotencyKey: 'attempt', audit: () => {},
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-doc-only-'))
  appData = await mkdtemp(join(tmpdir(), 'wf-doc-only-data-'))
  ws = new Workspace(root)
  changes = new ChangeStore(ws)
  agent = undefined
  await mkdir(join(root, 'schemas/scraps'), { recursive: true })
  await mkdir(join(root, '.writeflex'), { recursive: true })
  await mkdir(join(root, '.private'), { recursive: true })
  await writeFile(join(root, TRACKER), trackerText)
  await writeFile(join(root, PIECE), pieceText)
  await writeFile(join(root, SCRAPS), scrapsText)
  await writeFile(join(root, 'a.md'), '# A\n\nThe draft is too wordy.\n')
  await writeFile(join(root, '.writeflex', 'secret.md'), `---\ntitle: ${SECRET}\n---\n\n- [ ] ${SECRET}\n\nThe draft is too wordy.\n`)
  await symlink(join(root, '.writeflex'), join(root, 'alias'))
})
afterEach(async () => {
  await agent?.dispose()
  await rm(root, { recursive: true, force: true })
  await rm(appData, { recursive: true, force: true })
})

async function boot(steps?: ScriptedStep[]): Promise<WorkspaceAgent> {
  agent = await WorkspaceAgent.create({
    workspace: ws, appDataDir: appData, services: { scraps: new ScrapStore(ws) },
    changes, onChangesChanged: () => {},
    onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    ...(steps
      ? { sessionFactory: scriptedSessionFactory([{ prompt: 'go', rounds: [
          { kind: 'tool-calls', calls: steps.map((step) => ({ name: step.cap, arguments: step.input as Record<string, unknown> })) },
          { kind: 'message', text: 'done' },
        ] }]) }
      : {}),
  })
  return agent
}

/** Every entry under the Collection with each file's text, leaving out the two stores a turn itself
 *  appends to (Bridle's journal and the review ledger). */
async function collection(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const entry of (await readdir(root, { recursive: true, withFileTypes: true }))) {
    const path = join(entry.parentPath, entry.name).slice(root.length + 1)
    if (path === '.bridle' || path.startsWith('.bridle/') || path === '.writeflex/changes.jsonl') continue
    out[path] = entry.isFile() ? await readFile(join(root, path), 'utf8') : `<${entry.isSymbolicLink() ? 'link' : 'folder'}>`
  }
  return out
}

async function settle(live: WorkspaceAgent): Promise<void> {
  // Staging files its Changes just after the turn returns; give it the same grace the other suites do.
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
  await live.suggestions()
}

const HIDDEN_CALLS: ScriptedStep[] = [
  // None of these is named by the agent's early check: no `path`, or the hidden path is in another field.
  { cap: 'housekeeping.rename_file', input: { path: 'a.md', newPath: '.writeflex/a.md' } },
  { cap: 'housekeeping.rename_file', input: { path: 'a.md', newPath: 'alias/a.md' } },
  { cap: 'folio.create_manifest', input: { dir: '.writeflex' } },
  { cap: 'folio.create_manifest', input: { dir: 'alias' } },
  { cap: 'housekeeping.create_file', input: { path: '.writeflex/planted.md', content: '# Planted\n' } },
  { cap: 'housekeeping.create_file', input: { path: 'alias/planted.md', content: '# Planted\n' } },
  { cap: 'housekeeping.create_file', input: { path: '.newhidden/planted.md', content: '# Planted\n' } },
  { cap: 'scraps.promote', input: { dir: '.writeflex', origin: '.writeflex/secret.md', id: HALL, name: 'Idea' } },
  { cap: 'sources.attach', input: { dir: '', piece: '.writeflex/secret.md', source: 'research/x.md' } },
  { cap: 'tasks.toggle', input: { path: '.writeflex/secret.md', line: 5 } },
  { cap: 'frontmatter.set', input: { path: '.writeflex/secret.md', set: { status: 'done' } } },
  { cap: 'frontmatter.normalise', input: { path: 'alias/secret.md' } },
  { cap: 'prose.edit', input: { path: '.writeflex/secret.md', oldText: 'The draft is too wordy.', newText: 'Planted.', category: 'wording', summary: 's' } },
  { cap: 'prose.insert', input: { path: 'alias/secret.md', insertAfter: 'The draft is too wordy.', text: 'Planted.', category: 'wording', summary: 's' } },
  { cap: 'objects.insert', input: { path: '.writeflex/secret.md', kind: 'mermaid', content: 'graph TD\nA-->B', insertAfter: 'The draft is too wordy.', summary: 's' } },
]

test('no capability, run directly over the document-only Workspace, writes to a hidden path', async () => {
  const view = documentOnlyView(ws)
  const capabilities = buildWriteFlexManifest(view.workspace, undefined, { scraps: new ScrapStore(ws) }).capabilities
  const before = await collection()

  for (const call of HIDDEN_CALLS) {
    const capability = capabilities.find((candidate) => candidate.name === call.cap)!
    expect(capability).toBeDefined()
    let outcome: { isError?: boolean } | undefined
    try { outcome = await capability.execute(call.input as never, ctx) as { isError?: boolean } } catch { outcome = { isError: true } }
    expect({ cap: call.cap, refused: outcome?.isError === true }).toEqual({ cap: call.cap, refused: true })
  }

  expect(await collection()).toEqual(before)
  expect(view.refusals.length).toBeGreaterThan(0)
})

test('a turn that calls capabilities with hidden paths writes nothing, stages nothing acceptable and records none of the file\'s text', async () => {
  const live = await boot(HIDDEN_CALLS)
  const before = await collection()

  await live.runScriptedTurn('go', HIDDEN_CALLS)
  await settle(live)
  // Whatever did get staged (with or without a Change record) is refused when accepted.
  for (const suggestion of await live.suggestions()) {
    expect((await live.applySuggestion(suggestion.id)).isError).toBe(true)
  }
  for (const change of await changes.list()) {
    expect((await live.resolveChange(change.id, 'accept')).applied).toBe(false)
  }

  expect(await collection()).toEqual(before)
  expect(await changes.list({ status: 'accepted' })).toEqual([])
  const ledger = existsSync(join(root, '.writeflex', 'changes.jsonl')) ? await readFile(join(root, '.writeflex', 'changes.jsonl'), 'utf8') : ''
  expect(ledger).not.toContain(SECRET)
})

test('an adoption whose second write turns out to be hidden is refused, rewound and closed', async () => {
  const promote: ScriptedStep = { cap: 'scraps.promote', input: { dir: DIR, origin: PIECE, id: HALL, name: 'High and low context' } }
  const live = await boot([promote])
  await live.runScriptedTurn('go', [promote])
  await settle(live)
  const [change] = await changes.list()
  expect(change).toMatchObject({ path: TRACKER, status: 'pending' })
  expect(await live.suggestions()).toHaveLength(1)
  // Between the gate and the second write the Collection changes: once the tracker has been written,
  // the scraps folder is a link into a hidden folder. Everything judged beforehand was a document.
  await writeFile(join(root, '.private', 'how-humans-hallucinate-SCRAPS.md'), `${scrapsText}\nprivate tail\n`)
  const save = ws.saveFile.bind(ws)
  let swapped = false
  ws.saveFile = async (path, content, options) => {
    const saved = await save(path, content, options)
    if (path === TRACKER && !swapped) {
      swapped = true
      await rename(join(root, 'schemas/scraps'), join(root, 'schemas/scraps-was'))
      await symlink(join(root, '.private'), join(root, 'schemas/scraps'))
    }
    return saved
  }

  const result = await live.resolveChange(change.id, 'accept')

  expect(swapped).toBe(true)
  expect(result.applied).toBe(false)
  expect(result.closed).toBe(true)
  expect(result.message).toMatch(/scraps\/how-humans-hallucinate-SCRAPS\.md is in a folder WriteFlex keeps for itself.*Nothing was changed/)
  // No partial adoption: the tracker is back as it was, and the file behind the link was never written.
  expect(await readFile(join(root, TRACKER), 'utf8')).toBe(trackerText)
  expect(await readFile(join(root, '.private', 'how-humans-hallucinate-SCRAPS.md'), 'utf8')).toBe(`${scrapsText}\nprivate tail\n`)
  expect(await readFile(join(root, 'schemas/scraps-was/how-humans-hallucinate-SCRAPS.md'), 'utf8')).toBe(scrapsText)
  const closed = (await changes.get(change.id))!
  expect(closed.status).toBe('rejected')
  expect(closedReasonOf(closed)).toMatch(/keeps for itself/)
  expect(await live.suggestions()).toEqual([])
})

test('ordinary adoption still works over the document-only Workspace', async () => {
  const promote: ScriptedStep = { cap: 'scraps.promote', input: { dir: DIR, origin: PIECE, id: HALL, name: 'High and low context' } }
  const edit: ScriptedStep = { cap: 'prose.edit', input: { path: 'a.md', oldText: 'The draft is too wordy.', newText: 'Concise.', category: 'wording', summary: 's' } }
  const live = await boot([promote, edit])
  await live.runScriptedTurn('go', [promote, edit])
  await settle(live)

  for (const change of await changes.list()) expect(await live.resolveChange(change.id, 'accept')).toMatchObject({ applied: true })

  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('# A\n\nConcise.\n')
  expect(await readFile(join(root, TRACKER), 'utf8')).toContain('[[high-and-low-context]]')
  expect(await readFile(join(root, SCRAPS), 'utf8')).not.toContain(HALL)
})

test('the view shares the one Workspace, guards resolve and read, and refuses a member it does not name', async () => {
  const view = documentOnlyView(ws)

  expect(view.workspace).toBeInstanceOf(Workspace)
  await view.workspace.saveFile('a.md', '# A\n')
  expect(ws.wasRecentlyWrittenByApp('a.md')).toBe(true) // the real Workspace's own-write record
  expect(() => view.workspace.absolute('.writeflex')).toThrow(NotADocumentPathError)
  expect(() => view.workspace.absolute('alias/secret.md')).toThrow(NotADocumentPathError)
  await expect(view.workspace.readFile('.writeflex/secret.md')).rejects.toBeInstanceOf(NotADocumentPathError)
  await expect(view.workspace.createFile('.newhidden/x.md', 'x')).rejects.toBeInstanceOf(NotADocumentPathError)
  expect(existsSync(join(root, '.newhidden'))).toBe(false)
  await expect(view.workspace.renameFile('a.md', '.writeflex/a.md')).rejects.toBeInstanceOf(NotADocumentPathError)
  await expect(view.workspace.createFolder('.cache/x')).rejects.toBeInstanceOf(NotADocumentPathError)
  // A method added to Workspace later is unreachable until it is classed in the view.
  ;(Workspace.prototype as unknown as Record<string, unknown>).futureWriter = () => 'wrote'
  try {
    expect(() => (view.workspace as unknown as { futureWriter: () => string }).futureWriter).toThrow(/not available to agent capabilities/)
  } finally {
    delete (Workspace.prototype as unknown as Record<string, unknown>).futureWriter
  }
  // The empty-write rescue, the Workspace's own write under .writeflex, still works through the view.
  await writeFile(join(root, 'full.md'), 'text\n')
  await expect(view.workspace.saveFile('full.md', '')).rejects.toThrow()
  expect((await readdir(join(root, '.writeflex', 'rescue'))).length).toBe(2)
  expect(await readFile(join(root, 'full.md'), 'utf8')).toBe('text\n')
})

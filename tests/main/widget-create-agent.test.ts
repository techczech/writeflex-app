import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedSessionFactory } from '@bridle/core'
import { WorkspaceAgent, type ScriptedStep } from '../../src/main/agent'
import { capabilityEnabled } from '../../src/main/capabilities'
import { ChangeStore, changeJournalPath, newFilePartOf } from '../../src/main/changes'
import { widgetFileSha256 } from '../../src/main/widget-create'
import { isHiddenWorkspacePath, SavedButNotReadBack, Workspace } from '../../src/main/workspace'
import { writeflexApprovalPolicy } from '../../src/main/capabilities'
import { parseFrontmatter } from '../../src/main/frontmatter'
import type { Capability } from '@bridle/core'
import { buildWriteFlexManifest } from '../../src/main/capabilities'

// Interactive widgets, ticket 07, the whole route through the real agent: the proposal the writer reviews carries
// the new file (path, full content, hash); accepting writes exactly that or nothing.

const DOC = 'Intro.\n\nMore.\n'
const PAGE = '<!doctype html><html><head><title>Pace</title></head><body><b id="o">0</b><script>document.getElementById("o").textContent="1"</script></body></html>'
const INPUT = { path: 'essays/doc.md', fileName: 'Pace.html', html: PAGE, title: 'Pace' }
const FILE = 'essays/assets/pace.html'

let root: string
let appData: string
let ws: Workspace
let agent: WorkspaceAgent | null = null
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'wf-widget-agent-')))
  appData = await mkdtemp(join(tmpdir(), 'wf-widget-agent-data-'))
  ws = new Workspace(root)
  await mkdir(join(root, 'essays'), { recursive: true })
  await writeFile(join(root, 'essays/doc.md'), DOC)
})
afterEach(async () => {
  agent?.dispose()
  agent = null
  await rm(root, { recursive: true, force: true })
  await rm(appData, { recursive: true, force: true })
})

const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false)
const nothingWritten = async (): Promise<void> => {
  expect(await exists(join(root, 'essays/assets'))).toBe(false)
  expect(await readFile(join(root, 'essays/doc.md'), 'utf8')).toBe(DOC)
}

async function waitForChanges(changes: ChangeStore, count: number): Promise<Awaited<ReturnType<ChangeStore['list']>>> {
  for (let i = 0; i < 100; i += 1) {
    const all = await changes.list()
    if (all.length === count) return all
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return changes.list()
}

/** Scripted turns in which the agent calls widgets.create once each; returns the store and the staged Changes in order. */
async function proposeMany(inputs: Record<string, unknown>[], options: { isCapabilityEnabled?: (name: string) => boolean; workspace?: Workspace; changes?: ChangeStore } = {}) {
  const workspace = options.workspace ?? ws
  const changes = options.changes ?? new ChangeStore(workspace)
  const turns = inputs.map((input, index) => ({ prompt: `Add widget ${index + 1}`, step: { cap: 'widgets.create', input } as ScriptedStep }))
  agent = await WorkspaceAgent.create({
    workspace, appDataDir: appData, changes, ...(options.isCapabilityEnabled ? { isCapabilityEnabled: options.isCapabilityEnabled } : {}),
    onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory(turns.map(({ prompt, step }) => ({
      prompt,
      rounds: [
        { kind: 'tool-calls' as const, calls: [{ name: step.cap, arguments: step.input as Record<string, unknown> }] },
        { kind: 'message' as const, text: 'Proposed.' },
      ],
    }))),
  })
  for (const [index, { prompt, step }] of turns.entries()) {
    await agent.runScriptedTurn(prompt, [step])
    await waitForChanges(changes, index + 1)
  }
  return { changes, staged: await changes.list(), agent }
}

async function propose(input: Record<string, unknown> = INPUT, isCapabilityEnabled?: (name: string) => boolean, workspace?: Workspace) {
  const { changes, staged, agent: live } = await proposeMany([input], { isCapabilityEnabled, workspace })
  return { changes, change: staged[0], agent: live }
}

test('the proposal the writer reviews carries the new file, and accepting writes those exact bytes', async () => {
  const { changes, change, agent: live } = await propose()
  expect((await live.suggestions()).map((s) => s.capabilityName)).toEqual(['widgets.create'])
  await nothingWritten() // proposing wrote nothing

  // What the Review pane is given: the document edit, plus the file's path, full content and hash.
  expect(change).toMatchObject({ path: 'essays/doc.md', provenance: 'agent', status: 'pending', oldText: DOC, newText: `${DOC}\n[Simulation: assets/pace.html]\n` })
  expect(change.summary).toContain(FILE)
  const shown = newFilePartOf(change)
  expect(shown).toEqual({ path: FILE, content: PAGE, sha256: widgetFileSha256(PAGE) })

  const result = await live.resolveChange(change.id, 'accept')
  expect(result.applied, result.message).toBe(true)
  const written = await readFile(join(root, FILE))
  expect(written.equals(Buffer.from(shown!.content, 'utf8'))).toBe(true) // byte-identical to what was shown
  expect(await readFile(join(root, 'essays/doc.md'), 'utf8')).toBe(`${DOC}\n[Simulation: assets/pace.html]\n`)
  expect((await changes.get(change.id))?.status).toBe('accepted')
})

test('a page that gets a title added is shown, hashed and written in its final form', async () => {
  const { change, agent: live } = await propose({ ...INPUT, html: '<button>go</button>', title: 'Go' })
  const shown = newFilePartOf(change)
  expect(shown?.content).toContain('<title>Go</title>')
  expect((await live.resolveChange(change.id, 'accept')).applied).toBe(true)
  expect(await readFile(join(root, FILE), 'utf8')).toBe(shown!.content)
})

test('discarding the proposal writes nothing', async () => {
  const { changes, change, agent: live } = await propose()
  expect((await live.resolveChange(change.id, 'reject')).applied).toBe(true)
  await nothingWritten()
  expect((await changes.get(change.id))?.status).toBe('rejected')
})

const rewriteJournal = async (edit: (line: Record<string, unknown>) => void): Promise<void> => {
  const journal = join(root, '.writeflex/changes.jsonl')
  const records = (await readFile(journal, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
  for (const record of records) edit(record)
  await writeFile(journal, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
}

test('shown content that was altered after the proposal is refused at accept; nothing is written', async () => {
  const { changes, change, agent: live } = await propose()
  // The record the pane displays now shows a different page than the proposal will write (hash left as it was).
  await rewriteJournal((record) => { (record.newFile as { content: string }).content = PAGE.replace('"1"', '"2"') })
  const result = await live.resolveChange(change.id, 'accept')
  expect(result.applied).toBe(false)
  expect(result.message).toContain('was not shown for review')
  await nothingWritten()
  expect((await changes.get(change.id))?.status).toBe('pending')
})

test('shown content swapped together with its hash is refused too: what would be written is not what is shown', async () => {
  const { change, agent: live } = await propose()
  const other = PAGE.replace('"1"', '"2"')
  await rewriteJournal((record) => { record.newFile = { path: FILE, content: other, sha256: widgetFileSha256(other) } })
  const result = await live.resolveChange(change.id, 'accept')
  expect(result.applied).toBe(false)
  await nothingWritten()
})

test('a shown path that differs from the path the proposal would write is refused', async () => {
  const { change, agent: live } = await propose()
  await rewriteJournal((record) => { (record.newFile as { path: string }).path = 'essays/assets/other.html' })
  expect((await live.resolveChange(change.id, 'accept')).applied).toBe(false)
  await nothingWritten()
})

test('a proposal whose shown file part is gone is refused', async () => {
  const { change, agent: live } = await propose()
  await rewriteJournal((record) => { delete record.newFile })
  expect((await live.resolveChange(change.id, 'accept')).applied).toBe(false)
  await nothingWritten()
})

for (const key of ['permissions.createFiles', 'permissions.proseEdits']) {
  test(`${key} switched off between the proposal and the accept: refused, nothing written`, async () => {
    const settings: Record<string, unknown> = {}
    const { changes, change, agent: live } = await propose(INPUT, (name) => capabilityEnabled(name, (k) => settings[k]))
    settings[key] = false
    const result = await live.resolveChange(change.id, 'accept')
    expect(result.applied).toBe(false)
    await nothingWritten()
    expect((await changes.get(change.id))?.status).toBe('pending')
    // Through the other accept door as well.
    const [suggestion] = await live.suggestions()
    if (suggestion) expect((await live.applySuggestion(suggestion.id)).isError).toBe(true)
    await nothingWritten()
  })
}

test('with a switch off, the agent cannot even propose a widget', async () => {
  const changes = new ChangeStore(ws)
  const off = (name: string): boolean => capabilityEnabled(name, (k) => k === 'permissions.proseEdits' ? false : undefined)
  agent = await WorkspaceAgent.create({
    workspace: ws, appDataDir: appData, changes, isCapabilityEnabled: off,
    onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory([{ prompt: 'p', rounds: [{ kind: 'tool-calls', calls: [{ name: 'widgets.create', arguments: INPUT }] }, { kind: 'message', text: 'x' }] }]),
  })
  await agent.runScriptedTurn('p', [{ cap: 'widgets.create', input: INPUT }]).catch(() => undefined)
  expect(await agent.suggestions()).toEqual([])
  await nothingWritten()
})

test('a ledger record that creates a file is never replayed without its live proposal: no line without a file', async () => {
  const { changes, change, agent: live } = await propose()
  const [suggestion] = await live.suggestions()
  await live.discardSuggestion(suggestion.id) // the proposal is gone
  // Someone flips the record back to pending and accepts it from the ledger.
  await changes.setStatus(change.id, 'pending')
  const result = await live.resolveChange(change.id, 'accept')
  expect(result.applied).toBe(false)
  expect(result.message).toContain('no longer live')
  await nothingWritten()
})

// ---- review round 2 ----------------------------------------------------------------------------

test('another Change with the same document, path and hash cannot vouch for the one being accepted', async () => {
  // review finding round 2, finding 1: two proposals for the same file; the older is held; the newer's shown part is rewritten
  // (content and hash together) with the editor's own save. Accepting the newer must not write the older's page.
  const { changes, staged, agent: live } = await proposeMany([INPUT, INPUT])
  const [older, newer] = staged
  expect(newFilePartOf(older)).toEqual(newFilePartOf(newer)) // identical document, path and hash
  await changes.setStatus(older.id, 'held')
  const other = '<title>B</title><p>SHOWN INSTEAD</p>'
  const journal = changeJournalPath()
  const records = (await readFile(join(root, journal), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
  for (const record of records) if (record.id === newer.id) record.newFile = { path: FILE, content: other, sha256: widgetFileSha256(other) }
  await ws.saveEditorText(journal, records.map((record) => JSON.stringify(record)).join('\n') + '\n', { kind: 'disk', text: await readFile(join(root, journal), 'utf8') }) // the route review finding used, below the IPC refusal
  expect(newFilePartOf(await changes.get(newer.id))?.content).toBe(other) // the card now shows B

  const result = await live.resolveChange(newer.id, 'accept')
  expect(result.applied).toBe(false)
  expect(result.message).toContain('was not shown for review')
  await nothingWritten()
  // The held record's own proposal was superseded when the second was staged, so it cannot be accepted either:
  // it only ever served as a stand-in match for the old any-Change lookup.
  expect((await live.resolveChange(older.id, 'accept')).applied).toBe(false)
  await nothingWritten()
})

test('a shown file part rewritten back to something else and then restored is still bound to what was ingested', async () => {
  const { change, agent: live } = await propose()
  // The journal agrees with itself but not with what main froze at ingest: path moved, hash kept.
  await rewriteJournal((record) => { record.newFile = { path: 'essays/assets/elsewhere.html', content: PAGE, sha256: widgetFileSha256(PAGE) } })
  expect((await live.resolveChange(change.id, 'accept')).applied).toBe(false)
  await nothingWritten()
})

test('outside an accept the review check answers no: the verb run directly writes nothing', async () => {
  await propose()
  // The same manifest shape the agent builds, but with nobody accepting: there is no Change to check against.
  const direct = buildWriteFlexManifest(ws, undefined, {}).capabilities.find((c): c is Capability => c.name === 'widgets.create')!
  const result = await direct.execute(INPUT, { trigger: { id: 't', source: 'user', trust: 'interactive' }, sessionId: 's', attemptId: 'a', idempotencyKey: 'a', audit: () => {} })
  expect(result.isError).toBe(true)
  await nothingWritten()
})

// review finding rounds 2 and 3, through the real accept route. During an accept the Change is fetched four times: twice by
// resolveChange, once by applySuggestion, and last by the review lookup inside the verb. The store marks that
// fourth fetch; from then on the verb reads the permission three times. `offFrom` 1: switched off while the place
// is validated, before the widget file. 2: after the file, before the document save starts. 3: after the
// document's temp file is written, in the tick of the rename that would commit it (review finding round 3, finding 1). If the
// fetch count ever changes, these tests fail on the message (the policy would refuse first), not silently pass.
class LookupMarkingStore extends ChangeStore {
  accepting = false
  fetches = 0
  lookedUp = false
  override async get(id: string): ReturnType<ChangeStore['get']> {
    const found = await super.get(id)
    if (this.accepting && (this.fetches += 1) === 4) this.lookedUp = true
    return found
  }
}
for (const key of ['permissions.createFiles', 'permissions.proseEdits']) {
  for (const offFrom of [1, 2, 3]) {
    test(`${key} switched off during the accept (permission read ${offFrom} after the review lookup): nothing is left written`, async () => {
      const store = new LookupMarkingStore(ws)
      let reads = 0
      const isCapabilityEnabled = (name: string): boolean => {
        const read = store.lookedUp && name === 'widgets.create' ? (reads += 1) : 0
        return capabilityEnabled(name, (k) => k === key && read >= offFrom ? false : undefined)
      }
      const { staged, agent: live } = await proposeMany([INPUT], { isCapabilityEnabled, changes: store })
      store.accepting = true
      const result = await live.resolveChange(staged[0].id, 'accept')
      expect(store.lookedUp).toBe(true)
      expect(reads).toBe(offFrom) // refused at exactly that read, by the verb
      expect(result.applied).toBe(false)
      expect(result.message).toContain('switched off')
      if (offFrom >= 2) expect(result.message).toContain('was removed again')
      await nothingWritten()
      expect((await readdir(join(root, 'essays'))).sort()).toEqual(['doc.md']) // no temp file, no assets/
    })
  }
}

/** A workspace whose save commits and whose read-back then fails. The agent's verbs save through the guarded
 *  (document-only) write, whose read-back is the guarded read, not `readFile`: so the failure is raised where
 *  saveFile raises it for a failed read-back, after the write has committed. */
class ReadBackFails extends Workspace {
  failing = false
  override async saveFile(...args: Parameters<Workspace['saveFile']>): ReturnType<Workspace['saveFile']> {
    const saved = await super.saveFile(...args)
    if (this.failing && args[0] === 'essays/doc.md') throw new SavedButNotReadBack(args[0], 'post-save read failed')
    return saved
  }
}

test('the accept response carries what the verb said when the document saved but could not be read back', async () => {
  // review finding round 2, finding 3: the disk was right, the writer was told only "applied".
  const failing = new ReadBackFails(root)
  const { changes, change, agent: live } = await propose(INPUT, undefined, failing)
  failing.failing = true
  const result = await live.resolveChange(change.id, 'accept')
  expect(result.applied).toBe(true)
  expect(result.message).toContain('Both were written and kept')
  expect(result.message).toContain('could not be read back')
  expect(result.message).toContain(FILE)
  expect(await readFile(join(root, FILE), 'utf8')).toBe(PAGE)
  expect(await readFile(join(root, 'essays/doc.md'), 'utf8')).toBe(`${DOC}\n[Simulation: assets/pace.html]\n`)
  expect((await changes.get(change.id))?.status).toBe('accepted')
})

/** A workspace whose document save fails before writing, after making assets/ refuse removals. */
class SaveFailsOrphan extends Workspace {
  failing = false
  override async saveFile(...args: Parameters<Workspace['saveFile']>): ReturnType<Workspace['saveFile']> {
    if (!this.failing || args[0] !== 'essays/doc.md') return super.saveFile(...args)
    await chmod(join(this.root, 'essays/assets'), 0o555)
    throw new Error('disk full')
  }
}

test('the accept response names the orphan file when the rollback fails', async () => {
  const failing = new SaveFailsOrphan(root)
  const { change, agent: live } = await propose(INPUT, undefined, failing)
  failing.failing = true
  try {
    const result = await live.resolveChange(change.id, 'accept')
    expect(result.applied).toBe(false)
    expect(result.message).toContain(`the new widget file ${FILE} could not be removed`)
    expect(result.message).toContain('no line pointing to it')
    expect(await readFile(join(root, 'essays/doc.md'), 'utf8')).toBe(DOC)
    expect(await exists(join(root, FILE))).toBe(true)
  } finally {
    await chmod(join(root, 'essays/assets'), 0o755).catch(() => undefined)
  }
})

// ---- review round 3 ----------------------------------------------------------------------------

const HIDDEN = ['.writeflex/changes.jsonl', '.WRITEFLEX/changes.jsonl', '.writeflex./changes.jsonl', '.writeflex /changes.jsonl', ' .writeflex/changes.jsonl', './.writeflex/changes.jsonl', 'essays/../.writeflex/changes.jsonl', '.writeflex\\changes.jsonl', '.bridle/x.md', '.git/config', 'essays/.hidden/doc.md', '../outside.md', 'essays/../../outside.md', '/abs/doc.md', '']

test('one rule says what is not a writer\'s document: any path inside a dot-folder, in any spelling', () => {
  for (const path of HIDDEN) expect(isHiddenWorkspacePath(path), JSON.stringify(path)).toBe(true)
  for (const path of ['essays/doc.md', 'doc.md', 'essays/.draft.md', 'a.b/doc.md', 'essays/assets/pace.html']) expect(isHiddenWorkspacePath(path), path).toBe(false)
})

test('no Change can be recorded against a hidden folder, by the general door or the agent\'s', async () => {
  // review finding round 3, finding 2: changes:add reaches ChangeStore.add; an agent edit aimed at the journal rewrote it.
  const store = new ChangeStore(ws)
  const base = { provenance: 'agent' as const, editClass: 'content' as const, category: 'other', summary: 's', oldText: 'a', newText: 'b', isCorrection: false }
  for (const path of HIDDEN) {
    await expect(store.add({ ...base, path }), JSON.stringify(path)).rejects.toThrow('visible folder')
    await expect(store.addWithNewFile({ ...base, path }, { path: 'x', content: 'x', sha256: 'x' }), JSON.stringify(path)).rejects.toThrow('visible folder')
  }
  expect(await store.list()).toEqual([])
  const writer = await store.add({ ...base, provenance: 'writer', path: 'essays/doc.md' })
  await expect(store.updateWriterChange(writer.id, { ...base, provenance: 'writer', path: '.writeflex/changes.jsonl' })).rejects.toThrow('visible folder')
})

test('a record that targets a hidden folder is refused again at accept, and no verb that writes may aim at one', async () => {
  const { changes, change, agent: live } = await propose()
  const journal = join(root, '.writeflex/changes.jsonl')
  // The record is made to point at the journal itself, as an accepted-able whole-file edit.
  await rewriteJournal((record) => { delete record.newFile; delete record.capability; record.path = '.writeflex/changes.jsonl'; record.oldText = 'x'; record.newText = 'y' })
  const before = await readFile(journal, 'utf8')
  const result = await live.resolveChange(change.id, 'accept')
  expect(result.applied).toBe(false)
  expect(result.message).toContain('outside the visible folders')
  expect(await readFile(journal, 'utf8')).toBe(before)
  expect((await changes.get(change.id))?.status).toBe('pending')
  await nothingWritten()

  const policy = writeflexApprovalPolicy(undefined, ws)
  const trigger = { id: 't', source: 'user' as const, trust: 'interactive' as const }
  for (const name of ['prose.edit', 'prose.insert', 'frontmatter.set', 'housekeeping.create_file', 'widgets.create', 'widgets.insert', 'tasks.toggle']) {
    const decision = await policy({ capability: { name, risk: 'write' }, input: { path: '.writeflex/changes.jsonl', oldText: 'a', newText: 'b' }, trigger })
    expect(typeof decision === 'object' ? decision.decision : decision, name).toBe('deny')
  }
  const moved = await policy({ capability: { name: 'housekeeping.rename_file', risk: 'write' }, input: { path: 'essays/doc.md', newPath: '.writeflex/changes.jsonl' }, trigger })
  expect(typeof moved === 'object' ? moved.decision : moved).toBe('deny')
})

test('a widget proposal whose record lost its file part is still a widget proposal: never applied as a plain edit, before or after a restart', async () => {
  const { change, agent: live } = await propose()
  await rewriteJournal((record) => { delete record.newFile }) // the downgrade review finding performed through the journal
  expect((await live.resolveChange(change.id, 'accept')).applied).toBe(false)
  await nothingWritten()

  // Restart: a new agent over the same workspace and app data. Nothing frozen in memory, no live link.
  live.dispose()
  const changes = new ChangeStore(ws)
  agent = await WorkspaceAgent.create({
    workspace: ws, appDataDir: appData, changes,
    onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory([]),
  })
  const after = await agent.resolveChange(change.id, 'accept')
  expect(after.applied).toBe(false)
  expect(after.message).toContain('no longer live')
  await nothingWritten()
  // Through the other accept door, by proposal id: known by its verb, no frozen record, refused.
  for (const suggestion of await agent.suggestions()) {
    if (suggestion.capabilityName === 'widgets.create') expect((await agent.applySuggestion(suggestion.id)).isError).toBe(true)
  }
  await nothingWritten()
})

test('an intact widget proposal is refused plainly after a restart, by either door', async () => {
  const { change, agent: live } = await propose()
  live.dispose()
  agent = await WorkspaceAgent.create({
    workspace: ws, appDataDir: appData, changes: new ChangeStore(ws),
    onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory([]),
  })
  expect((await agent.resolveChange(change.id, 'accept')).applied).toBe(false)
  for (const suggestion of await agent.suggestions()) expect((await agent.applySuggestion(suggestion.id)).isError).toBe(true)
  await nothingWritten()
})

test('notes.create through the agent still refreshes the notes pane and records the active skill', async () => {
  // review finding round 3, finding 3: the two manifest-service assignments were dropped from WorkspaceAgent.create.
  const notified: string[] = []
  const step: ScriptedStep = { cap: 'notes.create', input: { sourceDocument: 'essays/doc.md', kind: 'review', body: 'One point.' } }
  agent = await WorkspaceAgent.create({
    workspace: ws, appDataDir: appData, changes: new ChangeStore(ws),
    onAgentNotesChanged: (path) => { notified.push(path) },
    composition: { activeSkill: { name: 'review', description: 'Review a piece', tools: ['notes.create', 'files.read'], input: 'document', instructions: 'Review it.', source: join(root, 'review.md') } as never },
    onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory([{ prompt: 'Review this', rounds: [{ kind: 'tool-calls', calls: [{ name: step.cap, arguments: step.input as Record<string, unknown> }] }, { kind: 'message', text: 'Done.' }] }]),
  })
  await agent.runScriptedTurn('Review this', [step])
  const note = 'essays/agent-notes/doc.review.md'
  const written = await readFile(join(root, note), 'utf8')
  expect(parseFrontmatter(written)?.extra).toMatchObject({ skill: 'review', source_document: 'essays/doc.md' })
  expect(notified).toContain(note)
})

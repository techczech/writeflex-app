/**
 * Command line and skill, ticket 01: a Change that cannot be placed is closed with its reason, and a
 * Change whose path is not a document the sidebar would show is never accepted. Seams: the Workspace
 * agent's resolve-change operation over the Change store, with `Workspace.classifyPath` as the rule.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedSessionFactory } from '@bridle/core'
import { WorkspaceAgent, type ScriptedStep } from '../../src/main/agent'
import { ChangeStore, changeJournalPath, closedReasonOf, type NewChange } from '../../src/main/changes'
import { NotADocumentPathError, Workspace } from '../../src/main/workspace'
import { guardedReadSeams } from '../../src/main/guarded-document-read'
import { isHiddenWorkspacePath } from '../../src/main/workspace'
import { plantChangeAt } from '../helpers/plant-change-path'

let root: string
let outside: string
let appData: string
let workspace: Workspace
let changes: ChangeStore
let agent: WorkspaceAgent | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-close-root-'))
  outside = await mkdtemp(join(tmpdir(), 'wf-close-outside-'))
  appData = await mkdtemp(join(tmpdir(), 'wf-close-data-'))
  workspace = new Workspace(root)
  changes = new ChangeStore(workspace)
  agent = undefined
})
afterEach(async () => {
  agent?.dispose()
  for (const dir of [root, outside, appData]) await rm(dir, { recursive: true, force: true })
})

async function makeAgent(script?: { text: string; steps: ScriptedStep[] }): Promise<WorkspaceAgent> {
  agent = await WorkspaceAgent.create({
    workspace,
    appDataDir: appData,
    changes,
    onChangesChanged: () => {},
    onTrace: () => {},
    onApprovalRequest: () => {},
    onSuggestionsChanged: () => {},
    ...(script
      ? {
          sessionFactory: scriptedSessionFactory([{
            prompt: script.text,
            rounds: [
              { kind: 'tool-calls', calls: script.steps.map((step) => ({ name: step.cap, arguments: step.input as Record<string, unknown> })) },
              { kind: 'message', text: 'Scripted turn complete.' },
            ],
          }]),
        }
      : {}),
  })
  return agent
}

const agentEdit = (over: Partial<NewChange> = {}): NewChange => ({
  path: 'a.md',
  provenance: 'agent',
  editClass: 'content',
  category: 'wording',
  summary: 'Tighten the sentence',
  oldText: 'The draft is too wordy.',
  newText: 'The draft is concise.',
  isCorrection: false,
  ...over,
})

/** The Change is closed: neither pending nor accepted, with a reason the store returns after a reload. */
async function expectClosed(id: string, reason: RegExp): Promise<void> {
  const reloaded = await new ChangeStore(new Workspace(root)).get(id)
  expect(reloaded?.status).toBe('rejected')
  expect(closedReasonOf(reloaded!)).toMatch(reason)
  expect(await changes.list({ status: 'pending' })).toEqual([])
  expect(await changes.list({ status: 'accepted' })).toEqual([])
}

/** Ticket 14: the Accept was refused and decided nothing. The Change is as it was (`status`), with no
 *  closing reason, after a reload; the document is untouched. */
async function expectWaiting(id: string, status: 'pending' | 'held'): Promise<void> {
  const reloaded = await new ChangeStore(new Workspace(root)).get(id)
  expect(reloaded?.status).toBe(status)
  expect(closedReasonOf(reloaded!)).toBeNull()
  expect(await changes.list({ status: 'accepted' })).toEqual([])
  expect(await changes.list({ status: 'rejected' })).toEqual([])
}

test('accepting a Change whose target text has gone is refused with the reason and leaves it pending (ticket 14)', async () => {
  const draft = '# A\n\nThe writer rewrote this sentence.\n'
  await writeFile(join(root, 'a.md'), draft)
  const change = await changes.add(agentEdit())

  const result = await (await makeAgent()).resolveChange(change.id, 'accept')

  expect(result).toEqual({ applied: false, message: expect.stringMatching(/not found in a\.md/) })
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe(draft)
  await expectWaiting(change.id, 'pending')
})

test('accepting a Change whose target text now occurs twice is refused with the reason and leaves it pending (ticket 14)', async () => {
  const draft = '# A\n\nRepeat me.\n\nRepeat me.\n'
  await writeFile(join(root, 'a.md'), draft)
  const change = await changes.add(agentEdit({ oldText: 'Repeat me.', newText: 'Say this once.' }))

  const result = await (await makeAgent()).resolveChange(change.id, 'accept')

  expect(result).toEqual({ applied: false, message: expect.stringMatching(/not unique in a\.md/) })
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe(draft)
  await expectWaiting(change.id, 'pending')
})

test('a second accept of a Change that could not be placed is refused the same way and still decides nothing', async () => {
  await writeFile(join(root, 'a.md'), '# A\n\nSomething else.\n')
  const change = await changes.add(agentEdit())
  const live = await makeAgent()
  const first = await live.resolveChange(change.id, 'accept')

  const second = await live.resolveChange(change.id, 'accept')

  expect(second).toEqual(first)
  expect(second).toEqual({ applied: false, message: expect.stringMatching(/not found/) })
  await expectWaiting(change.id, 'pending')
})

test('a Change that could not be placed and was then declined is declined, with no closing reason', async () => {
  await writeFile(join(root, 'a.md'), '# A\n\nSomething else.\n')
  const change = await changes.add(agentEdit())
  const live = await makeAgent()
  expect((await live.resolveChange(change.id, 'accept')).applied).toBe(false)

  expect((await live.resolveChange(change.id, 'reject')).applied).toBe(true)

  const declined = (await changes.get(change.id))!
  expect(declined.status).toBe('rejected')
  expect(closedReasonOf(declined)).toBeNull()
})

test('a held Change that cannot be placed stays held on accept (ticket 14)', async () => {
  await writeFile(join(root, 'a.md'), '# A\n\nSomething else.\n')
  const change = await changes.add(agentEdit({ status: 'held' }))

  const result = await (await makeAgent()).resolveChange(change.id, 'accept')

  expect(result).toEqual({ applied: false, message: expect.stringMatching(/not found/) })
  await expectWaiting(change.id, 'held')
})

test('an insertion whose anchor text has gone is refused with the reason and leaves it pending (ticket 14)', async () => {
  const draft = '# A\n\nNo anchor here.\n'
  await writeFile(join(root, 'a.md'), draft)
  const change = await changes.add(agentEdit({ editClass: 'insert', oldText: '', newText: 'New paragraph.', insertAfter: 'The anchor sentence.' }))

  const result = await (await makeAgent()).resolveChange(change.id, 'accept')

  expect(result.applied).toBe(false)
  expect(result.closed).toBeUndefined()
  expect(result.message).toMatch(/.+/)
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe(draft)
  await expectWaiting(change.id, 'pending')
})

test('a recorded move whose source no longer matches is refused with the reason and waits (ticket 14)', async () => {
  const draft = '# A\n\nMove this.\n\nAnchor.\n'
  await writeFile(join(root, 'a.md'), '# A\n\nRewritten since.\n\nAnchor.\n')
  const change = await changes.add(agentEdit({
    editClass: 'move',
    category: 'structure',
    oldText: 'Move this.',
    newText: 'Move this.',
    moveFrom: { from: draft.indexOf('Move this.'), to: draft.indexOf('Move this.') + 'Move this.'.length },
    moveTo: { from: draft.length - 1, to: draft.length - 1 },
  }))

  const result = await (await makeAgent()).resolveChange(change.id, 'accept')

  expect(result).toEqual({ applied: false, message: expect.stringMatching(/recorded move/) })
  await expectWaiting(change.id, 'pending')
})

test('a recorded move the document no longer reaches is refused and waits; one with unsound coordinates still closes', async () => {
  const draft = '# A\n\nMove this.\n\nAnchor.\n'
  const at = draft.indexOf('Move this.')
  const shortened = '# A\n'
  await writeFile(join(root, 'a.md'), shortened)
  const reach = await changes.add(agentEdit({
    editClass: 'move', category: 'structure', oldText: 'Move this.', newText: 'Move this.',
    moveFrom: { from: at, to: at + 'Move this.'.length }, moveTo: { from: draft.length - 1, to: draft.length - 1 },
  }))
  const live = await makeAgent()

  expect(await live.resolveChange(reach.id, 'accept')).toEqual({ applied: false, message: expect.stringMatching(/no longer fits/) })
  await expectWaiting(reach.id, 'pending')

  const unsound = await changes.add(agentEdit({
    editClass: 'move', category: 'structure', oldText: 'Move this.', newText: 'Move this.',
    moveFrom: { from: 4, to: 2 }, moveTo: { from: 1, to: 1 },
  }))
  expect(await live.resolveChange(unsound.id, 'accept')).toMatchObject({ applied: false, closed: true })
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe(shortened)
})

test('a live recorded move that can no longer be placed is refused and waits (ticket 14)', async () => {
  const text = 'Second paragraph to move.'
  const insertAfter = 'Third paragraph stays.'
  await writeFile(join(root, 'draft.md'), `# Draft\n\nFirst paragraph.\n\n${text}\n\n${insertAfter}\n`)
  const move: ScriptedStep = { cap: 'prose.move', input: { path: 'draft.md', text, insertAfter, summary: 'Move the second paragraph.' } }
  const live = await makeAgent({ text: 'Move it', steps: [move] })
  await live.runScriptedTurn('Move it', [move])
  let all = await changes.list()
  for (let i = 0; i < 50 && all.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    all = await changes.list()
  }
  expect(all).toHaveLength(1)
  expect(await live.suggestions()).toHaveLength(1)
  const rewritten = '# Draft\n\nThe writer replaced everything.\n'
  await writeFile(join(root, 'draft.md'), rewritten)

  const result = await live.resolveChange(all[0].id, 'accept')

  expect(result).toEqual({ applied: false, message: expect.stringMatching(/recorded move/) })
  expect(await readFile(join(root, 'draft.md'), 'utf8')).toBe(rewritten)
  await expectWaiting(all[0].id, 'pending')
  // Asked again (its proposal now gone stale, or not): the same refusal, still waiting.
  expect(await live.resolveChange(all[0].id, 'accept')).toMatchObject({ applied: false })
  await expectWaiting(all[0].id, 'pending')
})

test('a Change for a file that no longer exists closes with the reason instead of throwing', async () => {
  const change = await changes.add(agentEdit({ path: 'gone/trashed.md' }))

  const result = await (await makeAgent()).resolveChange(change.id, 'accept')

  expect(result).toEqual({ applied: false, closed: true, message: expect.stringMatching(/gone\/trashed\.md no longer exists/) })
  expect(existsSync(join(root, 'gone'))).toBe(false)
  await expectClosed(change.id, /no longer exists/)
})

test('a Change that targets the review ledger itself is refused; the ledger is not rewritten by it', async () => {
  await writeFile(join(root, 'a.md'), '# A\n\nThe draft is too wordy.\n')
  const victim = await changes.add(agentEdit({ summary: 'Victim edit' }))
  // next/0.23: the store refuses to record it at all; it can reach the journal only by a hand edit.
  await expect(changes.add(agentEdit({ path: changeJournalPath() }))).rejects.toThrow('visible folder')
  // The quotes make the target unique in the journal: inside the planted record's own JSON they are escaped.
  const planted = await plantChangeAt(root, changes, agentEdit({
    summary: 'Planted',
    oldText: '"summary":"Victim edit"',
    newText: '"summary":"Forged","status":"accepted","x":"Victim edit"',
  }), changeJournalPath())
  const journal = join(root, '.writeflex', 'changes.jsonl')
  const before = await readFile(journal, 'utf8')
  expect(before.split('\n')[0]).toContain('"summary":"Victim edit"')

  const result = await (await makeAgent()).resolveChange(planted.id, 'accept')

  // Refused at accept as at add (next/0.23's rule for a path in a hidden folder): nothing written, the record left as it stands.
  expect(result.applied).toBe(false)
  expect(result.message).toContain('outside the visible folders')
  expect(await readFile(journal, 'utf8')).toBe(before)
  expect(await changes.get(victim.id)).toEqual(victim)
  // Nothing under the app's own folders was snapshotted or written on the way to the refusal.
  expect(existsSync(join(root, '.bridle', 'journal.jsonl'))).toBe(false)
  expect(await changes.list({ status: 'accepted' })).toEqual([])
})

test('a Change under any dot-folder or tooling folder is refused and closed with no file written', async () => {
  await mkdir(join(root, '.bridle'), { recursive: true })
  await mkdir(join(root, '.git'), { recursive: true })
  await mkdir(join(root, 'talks', '.private'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
  const targets = ['.bridle/journal.jsonl', '.git/config', 'talks/.private/notes.md', 'node_modules/pkg/readme.md', '.WriteFlex/owner.lock']
  for (const path of targets) {
    if (path !== '.WriteFlex/owner.lock') await writeFile(join(root, path), 'The draft is too wordy.\n')
  }
  const live = await makeAgent()

  for (const path of targets) {
    // A dot-folder path is refused at add (next/0.23) and so can only be planted in the journal; it is refused
    // again at accept and left as it stands. A tooling folder (node_modules) is recorded, and closed at accept.
    const hidden = isHiddenWorkspacePath(path)
    const change = hidden ? await plantChangeAt(root, changes, agentEdit(), path) : await changes.add(agentEdit({ path }))
    const result = await live.resolveChange(change.id, 'accept')
    if (hidden) {
      expect(result).toEqual({ applied: false, message: expect.stringContaining('outside the visible folders') })
      expect((await changes.get(change.id))?.status).toBe('pending')
    } else {
      expect(result).toEqual({ applied: false, closed: true, message: expect.stringContaining(path) })
      expect(closedReasonOf((await changes.get(change.id))!)).toContain(path)
    }
    if (path !== '.WriteFlex/owner.lock') expect(await readFile(join(root, path), 'utf8')).toBe('The draft is too wordy.\n')
  }
  expect(existsSync(join(root, '.WriteFlex', 'owner.lock'))).toBe(false)
  expect(await changes.list({ status: 'accepted' })).toEqual([])
})

test('a Change reached through a link to a hidden folder, or out of the Collection, is refused and closed', async () => {
  await mkdir(join(root, '.bridle'), { recursive: true })
  await writeFile(join(root, '.bridle', 'journal.md'), 'The draft is too wordy.\n')
  await symlink(join(root, '.bridle'), join(root, 'notes'))
  await writeFile(join(outside, 'secret.md'), 'The draft is too wordy.\n')
  await symlink(outside, join(root, 'elsewhere'))
  const live = await makeAgent()

  const hidden = await changes.add(agentEdit({ path: 'notes/journal.md' }))
  const hiddenResult = await live.resolveChange(hidden.id, 'accept')
  expect(hiddenResult).toEqual({ applied: false, closed: true, message: expect.stringMatching(/keeps for itself/) })
  expect(await readFile(join(root, '.bridle', 'journal.md'), 'utf8')).toBe('The draft is too wordy.\n')

  const out = await changes.add(agentEdit({ path: 'elsewhere/secret.md' }))
  expect(await live.resolveChange(out.id, 'accept')).toEqual({ applied: false, closed: true, message: expect.stringMatching(/outside this Collection/) })
  expect(closedReasonOf((await changes.get(out.id))!)).toMatch(/outside this Collection/)
  // A path that climbs out with `..` is refused at add (next/0.23); planted in the journal, it is refused at accept.
  await expect(changes.add(agentEdit({ path: '../escape.md' }))).rejects.toThrow('visible folder')
  const escape = await plantChangeAt(root, changes, agentEdit(), '../escape.md')
  expect(await live.resolveChange(escape.id, 'accept')).toEqual({ applied: false, message: expect.stringContaining('outside the visible folders') })
  expect(existsSync(join(root, '..', 'escape.md'))).toBe(false)
  expect(await readFile(join(outside, 'secret.md'), 'utf8')).toBe('The draft is too wordy.\n')
  expect(await changes.list({ status: 'accepted' })).toEqual([])
})

test('a writer or reviewer Change with a hidden path cannot be marked accepted through resolve either', async () => {
  const change = await plantChangeAt(root, changes, agentEdit({ provenance: 'writer', editClass: null, category: null }), '.writeflex/versions.jsonl')

  const result = await (await makeAgent()).resolveChange(change.id, 'accept')

  expect(result.applied).toBe(false)
  expect((await changes.get(change.id))?.status).not.toBe('accepted')
  // A path the sidebar hides that is not a dot-folder is recorded, and closed at accept.
  await mkdir(join(root, 'node_modules'), { recursive: true })
  const tooling = await changes.add(agentEdit({ path: 'node_modules/versions.md', provenance: 'writer', editClass: null, category: null }))
  expect((await (await makeAgent()).resolveChange(tooling.id, 'accept')).applied).toBe(false)
  expect((await changes.get(tooling.id))?.status).toBe('rejected')
})

test('a closed Change reopened by mistake is closed again on accept, never applied', async () => {
  // A dot-folder path cannot be recorded (next/0.23); a folder the sidebar hides by name can, and is closed at accept.
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await writeFile(join(root, 'node_modules', 'journal.md'), 'The draft is too wordy.\n')
  const change = await changes.add(agentEdit({ path: 'node_modules/journal.md' }))
  const live = await makeAgent()
  await live.resolveChange(change.id, 'accept')
  await changes.setStatus(change.id, 'pending')

  expect((await live.resolveChange(change.id, 'accept')).closed).toBe(true)
  expect(await readFile(join(root, 'node_modules', 'journal.md'), 'utf8')).toBe('The draft is too wordy.\n')
  await expectClosed(change.id, /keeps for itself/)
})

test('a document-only save refuses a hidden or outside path and writes nothing', async () => {
  await mkdir(join(root, '.writeflex'), { recursive: true })
  await symlink(join(root, '.writeflex'), join(root, 'alias'))

  for (const path of ['.writeflex/planted.md', 'alias/planted.md']) {
    await expect(workspace.saveFile(path, 'x\n', { documentOnly: true })).rejects.toBeInstanceOf(NotADocumentPathError)
  }
  expect(existsSync(join(root, '.writeflex', 'planted.md'))).toBe(false)
  expect((await workspace.saveFile('ok.md', 'x\n', { documentOnly: true })).content).toBe('x\n')
})

test('rejecting a pending Change that has no Agent note attached completes cleanly', async () => {
  const draft = '# A\n\nThe draft is too wordy.\n'
  await writeFile(join(root, 'a.md'), draft)
  // An inserted diagram is the kind of Change an Agent note is kept for; this one has none on disk yet.
  const diagram = '```mermaid\ngraph TD\nA-->B\n```'
  const plain = await changes.add(agentEdit())
  const object = await changes.add(agentEdit({ editClass: 'insert', category: 'other', oldText: '', newText: diagram, insertAfter: 'The draft is too wordy.' }))
  const live = await makeAgent()

  // No warning in either result: the reject did not trip over the missing note.
  expect(await live.resolveChange(plain.id, 'reject')).toMatchObject({ applied: true })
  expect(await live.resolveChange(object.id, 'reject')).toMatchObject({ applied: true })

  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe(draft)
  for (const id of [plain.id, object.id]) {
    const rejected = (await changes.get(id))!
    expect(rejected.status).toBe('rejected')
    expect(closedReasonOf(rejected)).toBeNull()
  }
  // The discarded diagram is recorded as a new Agent note; the plain edit leaves none.
  const notes = await readdir(join(root, 'agent-notes'))
  expect(notes).toHaveLength(1)
  expect(await readFile(join(root, 'agent-notes', notes[0]), 'utf8')).toContain('agent_note_status: discarded')
})

// ---- Follow-up round: every door judges the path, and "accepted" always means the text was placed ----

/** Every file and folder under the Collection, links not followed, so "nothing new was written" is checkable. */
async function everythingUnder(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).filter((entry) => entry !== '.writeflex/changes.jsonl').sort()
}

test('rejecting a Change whose path is not a document writes no Agent note anywhere and closes it', async () => {
  await mkdir(join(root, '.bridle'), { recursive: true })
  await mkdir(join(root, '.writeflex'), { recursive: true })
  await symlink(join(root, '.bridle'), join(root, 'notes'))
  const diagram = '```mermaid\ngraph TD\nA-->B\n```'
  // A dot-folder path cannot be recorded (next/0.23), so it is planted in the journal as a hand edit would.
  const planted = (path: string): Promise<Awaited<ReturnType<ChangeStore['add']>>> =>
    isHiddenWorkspacePath(path)
      ? plantChangeAt(root, changes, agentEdit({ editClass: 'insert', category: 'other', oldText: '', newText: diagram, insertAfter: '' }), path)
      : changes.add(agentEdit({ path, editClass: 'insert', category: 'other', oldText: '', newText: diagram, insertAfter: '' }))
  const direct = await planted('.writeflex/x.md')
  const linked = await planted('notes/x.md')
  const live = await makeAgent()
  const before = await everythingUnder(root)

  const results = [await live.resolveChange(direct.id, 'reject'), await live.resolveChange(linked.id, 'reject')]

  expect(await everythingUnder(root)).toEqual(before)
  expect(existsSync(join(root, '.writeflex', 'agent-notes'))).toBe(false)
  expect(existsSync(join(root, '.bridle', 'agent-notes'))).toBe(false)
  for (const result of results) expect(result).toEqual({ applied: true, closed: true, message: expect.stringMatching(/keeps for itself/) })
  for (const id of [direct.id, linked.id]) {
    const rejected = (await changes.get(id))!
    expect(rejected.status).toBe('rejected')
    expect(closedReasonOf(rejected)).toMatch(/keeps for itself/)
  }
})

test('accepting a rejected Change is refused and leaves it rejected; reopening it first applies it', async () => {
  const draft = '# A\n\nThe draft is too wordy.\n'
  await writeFile(join(root, 'a.md'), draft)
  const change = await changes.add(agentEdit())
  const live = await makeAgent()
  await live.resolveChange(change.id, 'reject')

  const refused = await live.resolveChange(change.id, 'accept')

  expect(refused).toEqual({ applied: false, message: expect.stringMatching(/rejected.*reopen/i) })
  expect((await changes.get(change.id))?.status).toBe('rejected')
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe(draft)

  await changes.setReviewStatus(change.id, 'pending')
  expect(await live.resolveChange(change.id, 'accept')).toMatchObject({ applied: true })
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('# A\n\nThe draft is concise.\n')
  expect((await changes.get(change.id))?.status).toBe('accepted')
})

test('a rejected writer Change is not marked accepted through resolve either', async () => {
  const change = await changes.add(agentEdit({ provenance: 'writer', editClass: null, category: null, status: 'rejected' }))

  expect((await (await makeAgent()).resolveChange(change.id, 'accept')).applied).toBe(false)
  expect((await changes.get(change.id))?.status).toBe('rejected')
})

test('a Change whose file cannot be read closes with the reason instead of throwing', async () => {
  await writeFile(join(root, 'a.md'), '# A\n\nThe draft is too wordy.\n')
  const change = await changes.add(agentEdit())
  const live = await makeAgent()
  await chmod(join(root, 'a.md'), 0o000)
  try {
    const result = await live.resolveChange(change.id, 'accept')

    // Under Bun a file with no permissions cannot even be located, so the path rule answers first;
    // under Node (the app) the read itself fails. Either way it is closed with a reason, not thrown.
    expect(result).toEqual({ applied: false, closed: true, message: expect.stringMatching(/a\.md (could not be read|is outside this Collection)/) })
    await expectClosed(change.id, /a\.md/)
  } finally {
    await chmod(join(root, 'a.md'), 0o644)
  }
})

test('a read that fails with a permissions error closes the Change, naming what the system said', async () => {
  await writeFile(join(root, 'a.md'), '# A\n\nThe draft is too wordy.\n')
  const change = await changes.add(agentEdit())
  const live = await makeAgent()
  // Accept reads the document through the guarded read's one handle, not `Workspace.readFile`; the
  // seam stands where the open is, and fails as an open without permission does.
  guardedReadSeams.beforeOpen = async () => { throw Object.assign(new Error('EACCES: permission denied, open a.md'), { code: 'EACCES' }) }

  const result = await live.resolveChange(change.id, 'accept').finally(() => { delete guardedReadSeams.beforeOpen })

  expect(result).toEqual({ applied: false, closed: true, message: 'a.md could not be read (EACCES), so this change cannot be applied.' })
  await expectClosed(change.id, /could not be read \(EACCES\)/)
})

// ---- Review findings: the path judged is the path acted on, and no route skips the judgement ----

test('restaging an Agent note refuses a hidden note path or source document and files no Change', async () => {
  await mkdir(join(root, '.writeflex', 'agent-notes'), { recursive: true })
  await writeFile(join(root, '.writeflex', 'secret.md'), 'secret\n')
  await writeFile(join(root, 'a.md'), '# A\n')
  const live = await makeAgent()

  await expect(live.restageAgentNote('agent-notes/n.md', { sourceDocument: '.writeflex/secret.md' })).rejects.toThrow(/keeps for itself/)
  await expect(live.restageAgentNote('.writeflex/agent-notes/n.md', { sourceDocument: 'a.md' })).rejects.toThrow(/keeps for itself/)
  expect(await changes.list()).toEqual([])
})

test('nothing but a document is snapshotted: a checkpoint is skipped and a version refused for a hidden path', async () => {
  await mkdir(join(root, '.writeflex'), { recursive: true })
  await writeFile(join(root, '.writeflex', 'versions.jsonl'), 'private\n')
  await symlink(join(root, '.writeflex'), join(root, 'alias'))
  const live = await makeAgent()

  for (const path of ['.writeflex/versions.jsonl', 'alias/versions.jsonl']) {
    await live.checkpointFile(path)
    await expect(live.snapshotReviewVersion(path)).rejects.toThrow(/A version cannot be saved/)
  }

  expect(existsSync(join(root, '.bridle', 'journal.jsonl'))).toBe(false)
  expect(existsSync(join(root, '.bridle', 'objects')) ? await readdir(join(root, '.bridle', 'objects')) : []).toEqual([])
  // A document still checkpoints.
  await writeFile(join(root, 'a.md'), '# A\n')
  await live.checkpointFile('a.md')
  expect(existsSync(join(root, '.bridle', 'journal.jsonl'))).toBe(true)
})

test('Agent notes are not listed from a hidden folder', async () => {
  // A real note, written by rejecting an inserted diagram, then moved into the app's own folder.
  await writeFile(join(root, 'a.md'), '# A\n\nThe draft is too wordy.\n')
  const diagram = '```mermaid\ngraph TD\nA-->B\n```'
  const change = await changes.add(agentEdit({ editClass: 'insert', category: 'other', oldText: '', newText: diagram, insertAfter: 'The draft is too wordy.' }))
  const live = await makeAgent()
  await live.resolveChange(change.id, 'reject')
  expect(await live.agentNotes('')).toHaveLength(1)
  await rename(join(root, 'agent-notes'), join(root, '.writeflex', 'agent-notes'))

  expect(await live.agentNotes('.writeflex')).toEqual([])
  expect(await live.agentNotes('')).toEqual([])
})

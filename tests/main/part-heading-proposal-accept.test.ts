import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedSessionFactory } from '@bridle/core'
import { WorkspaceAgent } from '../../src/main/agent'
import { ChangeStore, closedCodeOf } from '../../src/main/changes'
import { invalidateFolioPlaces } from '../../src/main/folio-place'
import { ADD_HEADING_NO_LONGER_SAFE, proposePartTitles, replacementFor } from '../../src/main/folio-part-proposals'
import { fingerprintOf } from '../../src/main/guarded-document-read'
import { registerPlanIpcHandlers, type PlanIpcHandler } from '../../src/main/plan-ipc'
import { WRITEFLEX_AGENT_AUTHOR, WRITEFLEX_SELF_AUTHOR } from '../../src/main/versions'
import { Workspace } from '../../src/main/workspace'

// Fix round 2 on the top-of-body rule (2026-10-21): WriteFlex's "Add the heading" change is the one way a Folio
// part gets its title heading, and Accept writes it only while it is exactly what the rule proposes now.

let root: string
let appData: string
let ws: Workspace
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-part-heading-'))
  appData = await mkdtemp(join(tmpdir(), 'wf-part-heading-data-'))
  ws = new Workspace(root)
  invalidateFolioPlaces(root)
})
afterEach(async () => {
  invalidateFolioPlaces(root)
  await rm(root, { recursive: true, force: true })
  await rm(appData, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}
const read = (rel: string): Promise<string> => readFile(join(root, rel), 'utf8')

async function accept(changes: ChangeStore, id: string) {
  const agent = await WorkspaceAgent.create({
    workspace: ws, appDataDir: appData, changes,
    onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory([]),
  })
  try { return await agent.resolveChange(id, 'accept') } finally { agent.dispose() }
}

const PART = 'report/p.md'
async function folio(content: string): Promise<void> {
  await write('report/_report_INDEX.md', '# Report\n\n## Running order\n\n- [[p]]\n')
  await write(PART, content)
}

test('an add-a-heading change an older version filed with an unsafe title: Accept refuses and writes nothing; opening the Folio closes it', async () => {
  // `title: "T\n\n```"` decodes to a line break and a fence; an older version proposed `# T`, a blank line and a fence.
  const source = '---\ntitle: "T\\n\\n```"\n---\n\nIntroduction.\n'
  await folio(source)
  const unsafe = source.replace('\nIntroduction.', '\n# T\n\n```\n\nIntroduction.')
  const replacement = replacementFor(source, unsafe)!
  const changes = new ChangeStore(ws)
  const stored = await changes.add({
    path: PART, provenance: 'agent', editClass: 'housekeeping', category: 'structure',
    summary: 'Add the heading “T\n\n```”', oldText: replacement.oldText, newText: replacement.newText,
    anchor: replacement.anchor, isCorrection: false, author: WRITEFLEX_SELF_AUTHOR,
  })
  const result = await accept(changes, stored.id)
  expect(result).toMatchObject({ applied: false, message: ADD_HEADING_NO_LONGER_SAFE })
  expect(await read(PART)).toBe(source)
  expect((await changes.get(stored.id))!.status).not.toBe('accepted')

  // The same change left pending (another ledger): opening the Folio closes it as superseded and files nothing new.
  const again = await changes.add({
    path: PART, provenance: 'agent', editClass: 'housekeeping', category: 'structure',
    summary: 'Add the heading “T\n\n```”', oldText: replacement.oldText, newText: `${replacement.newText} `,
    anchor: replacement.anchor, isCorrection: false, author: WRITEFLEX_SELF_AUTHOR,
  })
  const outcome = await proposePartTitles(ws, changes, 'report')
  expect(outcome.proposed).toBe(0)
  expect(closedCodeOf((await changes.get(again.id))!)).toBe('superseded')
  expect(await read(PART)).toBe(source)
})

test('a part given its heading another way: its waiting change can no longer add a second one', async () => {
  const source = '---\ntitle: Cost\n---\n\nIntroduction.\n\n## Items\n'
  await folio(source)
  const changes = new ChangeStore(ws)
  expect(await proposePartTitles(ws, changes, 'report')).toMatchObject({ proposed: 1 })
  const [pending] = await changes.list({ path: PART, status: 'pending' })

  // The bridge's fixPart refuses to insert: the waiting change is the one way.
  const handlers = new Map<string, PlanIpcHandler>()
  registerPlanIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    stateForSender: () => ({ workspace: ws }), requireWorkspace: (state) => state.workspace,
    checkpointFile: async () => {}, notifyCollectionChanged: () => {}, notifyChangedOnDisk: () => {},
  })
  const item = { path: PART, fingerprint: fingerprintOf(await readFile(join(root, PART))) }
  const answer = await handlers.get('title:fix-part')!({ sender: { id: 1 } }, { dir: 'report', item, direction: 'title-to-heading' })
  expect(answer).toMatchObject({ ok: false })
  expect(await read(PART)).toBe(source)

  // The heading typed in by hand: Accept of the old change refuses, and the file keeps one heading.
  const typed = '---\ntitle: Cost\n---\n\n# Cost\n\nIntroduction.\n\n## Items\n'
  await write(PART, typed)
  expect(await accept(changes, pending.id)).toMatchObject({ applied: false, message: ADD_HEADING_NO_LONGER_SAFE })
  expect(await read(PART)).toBe(typed)
})

test('the change as filed still applies, adding the heading once', async () => {
  const source = '---\ntitle: Cost\n---\n\nIntroduction.\n'
  await folio(source)
  const changes = new ChangeStore(ws)
  await proposePartTitles(ws, changes, 'report')
  const [pending] = await changes.list({ path: PART, status: 'pending' })
  expect(await accept(changes, pending.id)).toMatchObject({ applied: true })
  expect(await read(PART)).toBe('---\ntitle: Cost\n---\n\n# Cost\n\nIntroduction.\n')
  // Opening the Folio again proposes nothing more.
  expect(await proposePartTitles(ws, changes, 'report')).toMatchObject({ proposed: 0 })
})

// Fix rounds 3-4 (2026-10-21): before WriteFlex had its own author (commit 93b98c19), these changes were filed
// under 'WriteFlex Agent' with the title put in unchecked. The in-app agent still files under that author, so
// such a change is never closed by its shape; at Accept it is refused only when it would write a line break
// from the title or a new code fence.
const UNSAFE_SOURCE = '---\ntitle: "T\\n\\n```"\n---\n\nIntroduction.\n'
async function legacyAdd(changes: ChangeStore, source: string, next: string, summary: string) {
  // Exactly the record the pre-93b98c19 proposePartTitles made from `source` and its withTopHeading result.
  const replacement = replacementFor(source, next)!
  return changes.add({
    path: PART, provenance: 'agent', editClass: replacement.oldText === '' ? 'insert' : 'housekeeping', category: 'structure',
    summary, oldText: replacement.oldText, newText: replacement.newText,
    anchor: replacement.anchor, ...(replacement.oldText === '' ? { insertAfter: '' } : {}),
    isCorrection: false, author: WRITEFLEX_AGENT_AUTHOR,
  })
}
const legacyUnsafeAdd = (changes: ChangeStore) =>
  legacyAdd(changes, UNSAFE_SOURCE, UNSAFE_SOURCE.replace('\nIntroduction.', '\n# T\n\n```\n\nIntroduction.'), 'Add the heading “T\n\n```”')

test('an older version\'s add-a-heading change under "WriteFlex Agent" with an unsafe title: Accept refuses, writes nothing, closes it', async () => {
  await folio(UNSAFE_SOURCE)
  const changes = new ChangeStore(ws)
  const stored = await legacyUnsafeAdd(changes)
  expect(await accept(changes, stored.id)).toMatchObject({ applied: false, message: ADD_HEADING_NO_LONGER_SAFE })
  expect(await read(PART)).toBe(UNSAFE_SOURCE)
  expect(closedCodeOf((await changes.get(stored.id))!)).toBe('superseded')
})

test('an older version\'s add-a-heading change under "WriteFlex Agent" left pending: opening the Folio leaves it; Accept still refuses', async () => {
  await folio(UNSAFE_SOURCE)
  const changes = new ChangeStore(ws)
  const stored = await legacyUnsafeAdd(changes)
  await proposePartTitles(ws, changes, 'report')
  expect((await changes.get(stored.id))!.status).toBe('pending')
  expect(await accept(changes, stored.id)).toMatchObject({ applied: false, message: ADD_HEADING_NO_LONGER_SAFE })
  expect(await read(PART)).toBe(UNSAFE_SOURCE)
})

test('an unsafe older record whose stored text was trimmed past the heading line: Accept refuses, writes nothing', async () => {
  // A part that already starts with `# **`: the older version put `# **`, a blank line and a fence above it,
  // and its replacement kept only the differing lines, so the stored new text no longer holds `# **` + fence.
  const source = '---\ntitle: "**\\n\\n```"\n---\n\n# **\n\nIntroduction.\n'
  const next = source.replace('\n# **\n', '\n# **\n\n```\n\n# **\n')
  await folio(source)
  const changes = new ChangeStore(ws)
  const stored = await legacyAdd(changes, source, next, 'Add the heading “**\n\n```”')
  expect(stored.newText).not.toContain('# **\n\n```')
  expect(stored.newText).toContain('```')
  expect(await accept(changes, stored.id)).toMatchObject({ applied: false, message: ADD_HEADING_NO_LONGER_SAFE })
  expect(await read(PART)).toBe(source)
  expect(closedCodeOf((await changes.get(stored.id))!)).toBe('superseded')
})

test('an ordinary agent edit under "WriteFlex Agent" that adds a heading: left open by the Folio, applied by Accept', async () => {
  const source = '---\ntitle: Cost\n---\n\nIntroduction.\n'
  await folio(source)
  const changes = new ChangeStore(ws)
  const notes = await changes.add({
    path: PART, provenance: 'agent', editClass: 'insert', category: 'structure', summary: 'Add the heading “Notes”',
    oldText: '', newText: '\n# Notes\n', insertAfter: 'Introduction.', isCorrection: false, author: WRITEFLEX_AGENT_AUTHOR,
  })
  const edit = await changes.add({
    path: PART, provenance: 'agent', editClass: 'housekeeping', category: 'structure', summary: 'Tighten the opening',
    oldText: 'Introduction.', newText: 'An introduction.', isCorrection: false, author: WRITEFLEX_AGENT_AUTHOR,
  })
  // Opening the Folio leaves both pending (it files its own add-a-heading beside them).
  expect(await proposePartTitles(ws, changes, 'report')).toMatchObject({ proposed: 1 })
  expect((await changes.get(notes.id))!.status).toBe('pending')
  expect((await changes.get(edit.id))!.status).toBe('pending')

  expect(await accept(changes, notes.id)).toMatchObject({ applied: true })
  expect(await read(PART)).toContain('Introduction.\n\n\n# Notes\n')
  expect(await accept(changes, edit.id)).toMatchObject({ applied: true })
  expect(await read(PART)).toContain('An introduction.')
})

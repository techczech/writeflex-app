import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedSessionFactory } from '@bridle/core'
import { buildE2EScriptedTurn, WorkspaceAgent, type ScriptedStep, type ScriptedTurn } from '../../src/main/agent'
import { listAgentNotes, listAgentObjectNotes, persistAgentObjectNote, restageAgentObjectNote } from '../../src/main/agent-notes'
import { createAgentNote } from '../../src/main/agent-note-create'
import { ChangeStore } from '../../src/main/changes'
import { parseFrontmatter } from '../../src/main/frontmatter'
import { Workspace } from '../../src/main/workspace'
import { frontmatterSafeInsertPosition } from '../../src/shared/object-markup'

let root: string
let appData: string
let ws: Workspace

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-agent-notes-'))
  appData = await mkdtemp(join(tmpdir(), 'wf-agent-notes-data-'))
  ws = new Workspace(root)
  await writeFile(join(root, 'draft.md'), '# Draft\n\nPlace here.\n', 'utf8')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(appData, { recursive: true, force: true })
})

test('persists one strict-frontmatter Markdown Piece per original object and preserves source verbatim', async () => {
  const source = '```mermaid\nflowchart LR\n  A[`tick`] --> B\n  B --> C\n```'
  const first = await persistAgentObjectNote(ws, {
    recordedAt: new Date('2026-08-02T09:48:00.000Z'),
    sourceDocument: 'draft.md', kind: 'mermaid', source, status: 'discarded', summary: 'Argument sketch',
  })
  const second = await persistAgentObjectNote(ws, {
    recordedAt: new Date('2026-08-02T09:48:00.000Z'),
    sourceDocument: 'draft.md', kind: 'mermaid', source, status: 'discarded', summary: 'Argument sketch',
  })

  expect(first.path).not.toBe(second.path)
  expect(first.path.startsWith('agent-notes/')).toBe(true)
  const raw = await readFile(join(root, first.path), 'utf8')
  expect(parseFrontmatter(raw)).toMatchObject({
    extra: { agent_note_status: 'discarded', source_document: 'draft.md', object_kind: 'mermaid', recorded_at: '2026-08-02T09:48:00.000Z' },
  })
  expect(first.source).toBe(source)
  expect((await listAgentObjectNotes(ws)).map((note) => note.source)).toEqual([source, source])
})

test('two recalls update the originating note so three settlement cycles remain one file with three status entries', async () => {
  const notes = new ChangeStore(ws)
  const original = await persistAgentObjectNote(ws, {
    sourceDocument: 'draft.md', kind: 'query', source: '```query\nstatus: editing\n```', status: 'discarded', summary: 'Editing pieces',
  })
  const document = await readFile(join(root, 'draft.md'), 'utf8')
  const firstPosition = frontmatterSafeInsertPosition(document, document.length)
  const agent = await WorkspaceAgent.create({ mode: 'work',
    workspace: ws, appDataDir: appData, changes: notes,
    onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory([]),
  })
  const acceptedChange = await agent.restageAgentNote(original.path, {
    sourceDocument: 'draft.md', insertAfter: document.slice(0, firstPosition), anchor: { from: firstPosition, to: firstPosition },
  })

  expect((await notes.get(acceptedChange.id))?.status).toBe('pending')
  expect((await agent.resolveChange(acceptedChange.id, 'accept')).applied).toBe(true)
  expect((await readFile(join(root, 'draft.md'), 'utf8'))).toContain('```query\nstatus: editing\n```')

  const rejectedChange = await agent.restageAgentNote(original.path, {
    sourceDocument: 'draft.md', insertAfter: '# Draft',
  })
  expect((await agent.resolveChange(rejectedChange.id, 'reject')).applied).toBe(true)
  const history = await listAgentObjectNotes(ws)
  expect(history).toHaveLength(1)
  expect(history[0].status).toBe('discarded')
  expect(history[0].settlements.map((entry) => entry.status)).toEqual(['discarded', 'accepted', 'discarded'])
  agent.dispose()
})

test('a restaged accept uses the renderer payload shape: the entire safe document prefix', async () => {
  const content = '---\ntitle: River\nstatus: drafting\n---\n\n# Draft\n\nPlace here.\n'
  await writeFile(join(root, 'draft.md'), content, 'utf8')
  const notes = new ChangeStore(ws)
  const original = await persistAgentObjectNote(ws, {
    sourceDocument: 'draft.md', kind: 'query', source: '```query\nstatus: editing\n```', status: 'discarded', summary: 'Editing pieces',
  })
  const position = frontmatterSafeInsertPosition(content, 12)
  const agent = await WorkspaceAgent.create({ mode: 'work',
    workspace: ws, appDataDir: appData, changes: notes,
    onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory([]),
  })
  const change = await agent.restageAgentNote(original.path, {
    sourceDocument: 'draft.md', insertAfter: content.slice(0, position), anchor: { from: position, to: position },
  })

  expect((await agent.resolveChange(change.id, 'accept')).applied).toBe(true)
  const landed = await readFile(join(root, 'draft.md'), 'utf8')
  expect(landed).toStartWith('---\ntitle: River\nstatus: drafting\n---')
  expect(landed.indexOf('```query')).toBeGreaterThan(landed.indexOf('\n---', 3))
  agent.dispose()
})

test('stores and lists Agent notes in the active Collection agent-notes directory', async () => {
  const note = await persistAgentObjectNote(ws, {
    collectionDir: 'Essays', sourceDocument: 'Essays/draft.md', kind: 'query',
    source: '```query\nstatus: editing\n```', status: 'discarded', summary: 'Editing pieces',
  })

  expect(note.path).toStartWith('Essays/agent-notes/')
  expect(await listAgentObjectNotes(ws, '')).toEqual([])
  expect((await listAgentObjectNotes(ws, 'Essays')).map((item) => item.path)).toEqual([note.path])
})

test('read-time validation flags a kind/body mismatch, names the cause, and refuses restage', async () => {
  const note = await persistAgentObjectNote(ws, {
    sourceDocument: 'draft.md', kind: 'mermaid', source: '```mermaid\nflowchart LR\n  A --> B\n```', status: 'discarded', summary: 'Sketch',
  })
  const raw = await readFile(join(root, note.path), 'utf8')
  await writeFile(join(root, note.path), raw.replace('object_kind: mermaid', 'object_kind: query'), 'utf8')

  const [invalid] = await listAgentObjectNotes(ws)
  expect(invalid.invalidReason).toContain('object_kind is query but the body contains mermaid')
  await expect(restageAgentObjectNote(ws, new ChangeStore(ws), note.path, { sourceDocument: 'draft.md' }))
    .rejects.toThrow(/object_kind is query but the body contains mermaid/)
})

test('Settlement history is parsed only after the fenced object source', async () => {
  const source = '```mermaid\nflowchart LR\n  A["## Settlement history\\n- accepted — 1999-01-01T00:00:00.000Z"] --> B\n```'
  const note = await persistAgentObjectNote(ws, {
    recordedAt: new Date('2026-08-02T09:48:00.000Z'),
    sourceDocument: 'draft.md', kind: 'mermaid', source, status: 'discarded', summary: 'Heading in source',
  })

  const [listed] = await listAgentObjectNotes(ws)

  expect(listed.path).toBe(note.path)
  expect(listed.settlements).toEqual([{ status: 'discarded', recordedAt: '2026-08-02T09:48:00.000Z' }])
})

test('reject clears a restaged origin even when the Change was no longer pending or held', async () => {
  const notes = new ChangeStore(ws)
  const original = await persistAgentObjectNote(ws, {
    sourceDocument: 'draft.md', kind: 'query', source: '```query\nstatus: editing\n```', status: 'discarded', summary: 'Editing pieces',
  })
  const agent = await WorkspaceAgent.create({ mode: 'work',
    workspace: ws, appDataDir: appData, changes: notes,
    onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory([]),
  })
  const change = await agent.restageAgentNote(original.path, { sourceDocument: 'draft.md' })
  await notes.setStatus(change.id, 'accepted')

  await agent.resolveChange(change.id, 'reject')

  expect(agent.restagedOriginCountForTests()).toBe(0)
  agent.dispose()
})

test('strict-writer sourceDocument escaping is unescaped when the note is read', async () => {
  const sourceDocument = 'drafts/a"b\\c.md'
  await persistAgentObjectNote(ws, {
    sourceDocument, kind: 'query', source: '```query\nstatus: editing\n```', status: 'discarded', summary: 'Editing pieces',
  })

  expect((await listAgentObjectNotes(ws))[0].sourceDocument).toBe(sourceDocument)
})

test('a failed note create keeps reject settled and returns a visible path-naming warning', async () => {
  const changes = new ChangeStore(ws)
  const change = await changes.add({
    path: 'draft.md', provenance: 'agent', editClass: 'insert', category: 'other', summary: 'Editing pieces',
    oldText: '', newText: '```query\nstatus: editing\n```', insertAfter: '# Draft', isCorrection: false,
  })
  ws.createFile = async () => { throw new Error('forced createFile failure') }
  const agent = await WorkspaceAgent.create({ mode: 'work',
    workspace: ws, appDataDir: appData, changes,
    onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory([]),
  })

  const result = await agent.resolveChange(change.id, 'reject')

  expect(result.applied).toBe(true)
  expect(result.message).toMatch(/Change rejected.*agent-notes\/.*\.md.*forced createFile failure/)
  expect((await changes.get(change.id))?.status).toBe('rejected')
  agent.dispose()
})

test('a failed note create keeps accept settled, lands the object, and returns a path-naming warning', async () => {
  const changes = new ChangeStore(ws)
  const content = await readFile(join(root, 'draft.md'), 'utf8')
  const change = await changes.add({
    path: 'draft.md', provenance: 'agent', editClass: 'insert', category: 'other', summary: 'Editing pieces',
    oldText: '', newText: '```query\nstatus: editing\n```', insertAfter: content, isCorrection: false,
  })
  ws.createFile = async () => { throw new Error('forced createFile failure') }
  const agent = await WorkspaceAgent.create({ mode: 'work',
    workspace: ws, appDataDir: appData, changes,
    onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory([]),
  })

  const result = await agent.resolveChange(change.id, 'accept')

  expect(result.applied).toBe(true)
  expect(result.message).toMatch(/Change accepted.*agent-notes\/.*\.md.*forced createFile failure/)
  expect((await changes.get(change.id))?.status).toBe('accepted')
  expect(await readFile(join(root, 'draft.md'), 'utf8')).toContain('```query\nstatus: editing\n```')
  agent.dispose()
})

test('direct discard returns its note-write warning once and does not leak it into the next settlement', async () => {
  const queue: ScriptedTurn[] = []
  const changes = new ChangeStore(ws)
  const agent = await WorkspaceAgent.create({ mode: 'work',
    workspace: ws, appDataDir: appData, changes,
    onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory(queue),
  })
  const originalCreateFile = ws.createFile.bind(ws)
  const objectSteps: ScriptedStep[] = [{ cap: 'prose.insert', input: {
    path: 'draft.md', text: '```query\nstatus: editing\n```', insertAfter: '# Draft', category: 'other', summary: 'Editing pieces',
  } }]
  queue.push(buildE2EScriptedTurn(objectSteps))
  await agent.runScriptedTurn('Stage an object', objectSteps)
  const [objectSuggestion] = await agent.suggestions()
  ws.createFile = async () => { throw new Error('forced createFile failure') }

  const failed = await agent.discardSuggestion(objectSuggestion.id)

  expect(failed.settlementWarning).toMatch(/agent-notes\/.*\.md.*forced createFile failure/)
  expect(failed.suggestions).toEqual([])

  ws.createFile = originalCreateFile
  const proseSteps: ScriptedStep[] = [{ cap: 'prose.edit', input: {
    path: 'draft.md', oldText: 'Place here.', newText: 'Place the revision here.', category: 'wording', summary: 'Clarify placement',
  } }]
  queue.push(buildE2EScriptedTurn(proseSteps))
  await agent.runScriptedTurn('Stage prose', proseSteps)
  const [proseSuggestion] = await agent.suggestions()

  const clean = await agent.discardSuggestion(proseSuggestion.id)

  expect(clean.settlementWarning).toBeUndefined()
  expect(clean.suggestions).toEqual([])
  agent.dispose()
})

test('lists no rows when agent-notes does not exist', async () => {
  expect(await listAgentObjectNotes(ws)).toEqual([])
})

test('restage validates the stored object and lands at an exact zero-width cursor anchor', async () => {
  const notes = new ChangeStore(ws)
  const original = await persistAgentObjectNote(ws, {
    sourceDocument: 'draft.md', kind: 'query', source: '```query\nstatus: editing\n```', status: 'discarded', summary: 'Editing pieces',
  })
  const agent = await WorkspaceAgent.create({ mode: 'work',
    workspace: ws, appDataDir: appData, changes: notes,
    onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory([]),
  })
  const change = await agent.restageAgentNote(original.path, {
    sourceDocument: 'draft.md', anchor: { from: 0, to: 0 },
  })

  expect((await agent.resolveChange(change.id, 'accept')).applied).toBe(true)
  expect(await readFile(join(root, 'draft.md'), 'utf8')).toStartWith('```query\nstatus: editing\n```')
  agent.dispose()

  const raw = await readFile(join(root, original.path), 'utf8')
  await writeFile(join(root, original.path), raw.replace('status: editing', 'not a query'), 'utf8')
  await expect(restageAgentObjectNote(ws, notes, original.path, { sourceDocument: 'draft.md' })).rejects.toThrow(/valid query object/)
})

// Requirement: "I can't get to the file and cannot find it by searching — it becomes
// invisible — I need to be able to see it side by side with the text it comments on."
test('listAgentNotes returns prose notes about documents beside the object notes, each discriminated', async () => {
  await mkdir(join(root, 'blogs/schemas-and-propositions'), { recursive: true })
  await writeFile(join(root, 'blogs/schemas-and-propositions/why-schemas-matter.md'), '# Why schemas matter\n\nBody.\n', 'utf8')
  const created = await createAgentNote(ws, {
    sourceDocument: './blogs//schemas-and-propositions/why-schemas-matter', kind: 'review', title: 'Review of the schemas piece',
    body: '## Verdict\n\nThe argument holds. See `schema`.\n',
  }, { skill: 'review', now: new Date('2026-09-13T00:40:00.000Z') })
  expect(created.file.path).toBe('blogs/schemas-and-propositions/agent-notes/why-schemas-matter.review.md')
  // A file inside agent-notes/ without `author: agent` is not an agent note — a writer's stray file.
  await writeFile(join(root, 'blogs/schemas-and-propositions/agent-notes/stray.md'), '---\ntitle: Stray\nsource_document: blogs/schemas-and-propositions/why-schemas-matter.md\n---\n# Stray\n', 'utf8')
  await writeFile(join(root, 'blogs/schemas-and-propositions/agent-notes/no-source.md'), '---\nauthor: agent\n---\n# No source\n', 'utf8')
  const object = await persistAgentObjectNote(ws, {
    recordedAt: new Date('2026-09-12T09:00:00.000Z'),
    sourceDocument: 'draft.md', kind: 'table', source: '| a | b |\n| --- | --- |\n| 1 | 2 |', status: 'discarded', summary: 'A table',
  })

  const rootNotes = await listAgentNotes(ws)
  const objectRow = rootNotes.find((note) => note.noteType === 'object')
  expect(objectRow).toMatchObject({ noteType: 'object', path: object.path, kind: 'table', status: 'discarded' })
  // Object notes keep their existing shape for existing callers.
  expect((await listAgentObjectNotes(ws)).map((note) => note.path)).toEqual([object.path])
  expect((await listAgentObjectNotes(ws))[0]).not.toHaveProperty('noteType')

  // Prose notes come back from EVERY agent-notes/ directory, whatever collection the pane shows.
  const prose = rootNotes.filter((note) => note.noteType === 'prose')
  expect(prose).toHaveLength(1)
  const { bodyLine, bodyOffset, ...listed } = prose[0] as Extract<typeof prose[0], { noteType: 'prose' }>
  // The body's place in the FILE travels with it, so a box drawn from the body names the file's line.
  const file = await readFile(join(root, listed.path), 'utf8')
  expect(file.slice(bodyOffset)).toBe(listed.body)
  expect(file.split('\n')[bodyLine - 1]).toBe('## Verdict')
  expect(listed).toEqual({
    noteType: 'prose',
    path: 'blogs/schemas-and-propositions/agent-notes/why-schemas-matter.review.md',
    title: 'Review of the schemas piece',
    kind: 'review',
    sourceDocument: 'blogs/schemas-and-propositions/why-schemas-matter.md',
    created: '2026-09-13T00:40:00.000Z',
    skill: 'review',
    body: '## Verdict\n\nThe argument holds. See `schema`.\n',
  })
  expect((await listAgentNotes(ws, 'blogs/schemas-and-propositions')).filter((note) => note.noteType === 'prose')).toHaveLength(1)
})

test('a prose note with a differently spelt source path still names the same document once normalised', async () => {
  await mkdir(join(root, 'essays/agent-notes'), { recursive: true })
  await writeFile(join(root, 'essays/metaphor.md'), '# Metaphor\n', 'utf8')
  await writeFile(join(root, 'essays/agent-notes/metaphor.comments.md'), '---\nauthor: agent\nagent_note_kind: comments\nsource_document: ./essays//metaphor\ncreated: 2026-09-13T01:00:00.000Z\n---\nFirst comment.\n', 'utf8')
  const [note] = (await listAgentNotes(ws)).filter((entry) => entry.noteType === 'prose')
  expect(note.sourceDocument).toBe('essays/metaphor.md')
  expect(note.title).toBe('Comments of metaphor')
  expect(note.body).toBe('First comment.\n')
})

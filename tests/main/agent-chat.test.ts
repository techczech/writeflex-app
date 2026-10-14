import { test, expect } from 'bun:test'
import {
  applyArmsUndo,
  emptyAgentChat,
  reduceAgentChat,
  stagedLabel,
  type AgentChatState,
  type AgentTurn,
} from '../../src/renderer/src/hooks/agent-chat'
import type { ChatMessage, Suggestion, TraceEvent } from '../../src/preload'

// Task 15: the agent panel's transcript model, driven headlessly. The reducer is the single
// source for what the panel renders (user bubbles, activity rows, staged-row lifecycle,
// undo bookkeeping), so its rules are pinned here rather than through the Electron harness.

const trace = (over: Partial<TraceEvent>): TraceEvent => ({
  id: 'e1',
  type: 'policy.decision',
  timestamp: 1000,
  title: 'x',
  ...over,
})

const suggestion = (over: Partial<Suggestion> = {}): Suggestion => ({
  id: 'sug-1',
  capabilityName: 'prose.edit',
  input: { path: 'draft.md', oldText: 'a', newText: 'b', category: 'typo', summary: 's' },
  preview: 'typo edit — s',
  stagedAt: 900,
  ...over,
})

function promptedState(): AgentChatState {
  let s = emptyAgentChat()
  s = reduceAgentChat(s, { type: 'hydrate', available: true, messages: [], suggestions: [] })
  return reduceAgentChat(s, { type: 'prompt', text: 'tidy up', at: 2000 })
}

const lastAgent = (s: AgentChatState): AgentTurn => {
  const turn = s.turns[s.turns.length - 1]
  if (turn.kind !== 'agent') throw new Error('expected an agent turn last')
  return turn
}

test('hydrate maps session history into compact turns and keeps it out of the live list', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'rename my draft', createdAt: 1 },
    { role: 'assistant', content: 'Renamed it.', createdAt: 2 },
    { role: 'tool', content: 'Renamed to lakoff-quotes.md.\nlong details', createdAt: 2 },
  ]
  const s = reduceAgentChat(emptyAgentChat(), { type: 'hydrate', available: true, messages, suggestions: [] })
  expect(s.available).toBe(true)
  expect(s.turns).toEqual([])
  expect(s.history).toHaveLength(2)
  expect(s.history[0]).toMatchObject({ kind: 'user', text: 'rename my draft' })
  const reply = s.history[1] as AgentTurn
  expect(reply.text).toBe('Renamed it.')
  // The tool result folds into the reply as a one-line receipt, not a third bubble.
  expect(reply.activity).toHaveLength(1)
  expect(reply.activity[0].text).toBe('Renamed to lakoff-quotes.md.')
})

test('completed-turn execution metadata follows the assistant turn into the receipt view', () => {
  const execution = { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'high' as const }
  const s = reduceAgentChat(emptyAgentChat(), {
    type: 'hydrate',
    available: true,
    messages: [{ role: 'assistant', content: 'Done.', createdAt: 2, execution }],
    suggestions: [],
  })
  expect(s.history[0]).toMatchObject({ kind: 'agent', execution })
})

test('prompt appends a user bubble plus a running reply; a second prompt while running is ignored', () => {
  const s = promptedState()
  expect(s.running).toBe(true)
  expect(s.turns).toHaveLength(2)
  expect(s.turns[0]).toMatchObject({ kind: 'user', text: 'tidy up' })
  expect(lastAgent(s)).toMatchObject({ running: true, text: null })
  expect(reduceAgentChat(s, { type: 'prompt', text: 'again', at: 3000 })).toBe(s)
})

test('run-as-is appends only a running agent turn, with no empty user bubble', () => {
  const hydrated = reduceAgentChat(emptyAgentChat(), { type: 'hydrate', available: true, messages: [], suggestions: [] })
  const state = reduceAgentChat(hydrated, { type: 'prompt-silent', at: 2000 })

  expect(state.running).toBe(true)
  expect(state.turns).toHaveLength(1)
  expect(state.turns[0]).toMatchObject({ kind: 'agent', running: true, text: null })
})

test('replace swaps the complete transcript instead of retaining live turns from another thread', () => {
  const current = promptedState()
  const state = reduceAgentChat(current, {
    type: 'replace',
    available: true,
    messages: [
      { role: 'user', content: 'Review this draft', createdAt: 10 },
      { role: 'assistant', content: 'I left notes.', createdAt: 11 },
    ],
    suggestions: [],
  })

  expect(state.running).toBe(false)
  expect(state.turns).toEqual([])
  expect(state.history).toHaveLength(2)
  expect(state.history[0]).toMatchObject({ kind: 'user', text: 'Review this draft' })
})

test('allow-decision traces become activity rows; housekeeping rows carry Snapshot kept', () => {
  let s = promptedState()
  s = reduceAgentChat(s, {
    type: 'trace',
    event: trace({ metadata: { capability: 'files.read', decision: 'allow', path: 'draft.md' } }),
  })
  s = reduceAgentChat(s, {
    type: 'trace',
    event: trace({ metadata: { capability: 'housekeeping.create_file', decision: 'allow', path: 'references.md' } }),
  })
  const rows = lastAgent(s).activity
  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({ kind: 'read', text: 'Read', target: 'draft.md' })
  expect(rows[1]).toMatchObject({ kind: 'create', target: 'references.md', sub: 'Snapshot kept' })
})

test('a real-pipeline trace without path metadata degrades to the capability alone', () => {
  let s = promptedState()
  s = reduceAgentChat(s, {
    type: 'trace',
    event: trace({ metadata: { capability: 'housekeeping.create_file', decision: 'allow' } }),
  })
  expect(lastAgent(s).activity[0]).toMatchObject({ kind: 'create', text: 'Created', target: 'a file' })
})

test('notes.create traces read as a note left, marked agent-authored', () => {
  let s = promptedState()
  s = reduceAgentChat(s, {
    type: 'trace',
    event: trace({ metadata: { capability: 'notes.create', decision: 'allow', path: 'essays/agent-notes/metaphor.review.md' } }),
  })
  expect(lastAgent(s).activity[0]).toMatchObject({ kind: 'create', text: 'Left a note', target: 'essays/agent-notes/metaphor.review.md', sub: 'Agent-authored' })
})

test('stage decisions are silent (the suggestion.staged trace carries the row); pi.* is ignored', () => {
  let s = promptedState()
  s = reduceAgentChat(s, {
    type: 'trace',
    event: trace({ metadata: { capability: 'prose.edit', decision: 'stage' } }),
  })
  s = reduceAgentChat(s, { type: 'trace', event: trace({ type: 'pi.message_end', metadata: {} }) })
  expect(lastAgent(s).activity).toHaveLength(0)
  s = reduceAgentChat(s, {
    type: 'trace',
    event: trace({ type: 'suggestion.staged', metadata: { suggestionId: 'sug-1' } }),
  })
  expect(lastAgent(s).activity[0]).toMatchObject({
    kind: 'staged',
    suggestionId: 'sug-1',
    pending: true,
    sub: 'Waiting for your review',
  })
})

test('traces arriving with no conversation at all are dropped', () => {
  const s = reduceAgentChat(emptyAgentChat(), {
    type: 'trace',
    event: trace({ metadata: { capability: 'files.read', decision: 'allow' } }),
  })
  expect(s.turns).toEqual([])
})

test('the IPC-lane race: traces landing after complete still attach, arm Undo, and reconcile staged rows', () => {
  // Electron delivers the invoke reply (prompt resolution) on a faster lane than webContents.send,
  // so a turn's traces routinely arrive AFTER it settled — the panel must not lose them.
  let s = promptedState()
  s = reduceAgentChat(s, {
    type: 'complete',
    messages: [{ role: 'assistant', content: 'Created references.md.', createdAt: 2400 }],
    suggestions: [suggestion()],
    at: 2500,
  })
  expect(lastAgent(s).undoable).toBe(false) // no rows had arrived by completion
  s = reduceAgentChat(s, {
    type: 'trace',
    event: trace({ metadata: { capability: 'housekeeping.create_file', decision: 'allow', path: 'references.md' } }),
  })
  s = reduceAgentChat(s, {
    type: 'trace',
    event: trace({ type: 'suggestion.staged', metadata: { suggestionId: 'sug-1' } }),
  })
  const turn = lastAgent(s)
  expect(turn.activity[0]).toMatchObject({ kind: 'create', target: 'references.md' })
  expect(turn.undoable).toBe(true) // the late housekeeping row still arms Undo turn
  // The staged row reconciled against the already-delivered suggestions list, no fresh push needed.
  expect(turn.activity[1]).toMatchObject({ kind: 'staged', text: 'Staged 1 typo edit', path: 'draft.md', pending: true })
})

test('a suggestions push enriches staged rows and later marks resolved ones Reviewed', () => {
  let s = promptedState()
  s = reduceAgentChat(s, {
    type: 'trace',
    event: trace({ type: 'suggestion.staged', metadata: { suggestionId: 'sug-1' } }),
  })
  s = reduceAgentChat(s, { type: 'suggestions', suggestions: [suggestion()] })
  let row = lastAgent(s).activity[0]
  expect(row).toMatchObject({ text: 'Staged 1 typo edit', path: 'draft.md', pending: true })
  // The writer reviews it (apply or discard): the push no longer lists it.
  s = reduceAgentChat(s, { type: 'suggestions', suggestions: [] })
  row = lastAgent(s).activity[0]
  expect(row).toMatchObject({ pending: false, sub: 'Reviewed' })
  expect(s.suggestions).toEqual([])
})

test('complete settles the running turn with the last assistant text and marks housekeeping undoable', () => {
  let s = promptedState()
  s = reduceAgentChat(s, {
    type: 'trace',
    event: trace({ metadata: { capability: 'housekeeping.create_file', decision: 'allow', path: 'references.md' } }),
  })
  const messages: ChatMessage[] = [
    { role: 'user', content: 'tidy up', createdAt: 2000 },
    { role: 'assistant', content: 'Created references.md.', createdAt: 2400, execution: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'high' } },
  ]
  s = reduceAgentChat(s, { type: 'complete', messages, suggestions: [suggestion()], at: 2500 })
  expect(s.running).toBe(false)
  const turn = lastAgent(s)
  expect(turn).toMatchObject({ text: 'Created references.md.', running: false, undoable: true, execution: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'high' } })
  expect(s.suggestions).toHaveLength(1)
  // A stray late completion (e.g. after abort) is a no-op.
  expect(reduceAgentChat(s, { type: 'complete', messages, suggestions: [], at: 2600 })).toBe(s)
})

test('a read-only turn is not undoable', () => {
  let s = promptedState()
  s = reduceAgentChat(s, {
    type: 'trace',
    event: trace({ metadata: { capability: 'files.read', decision: 'allow', path: 'draft.md' } }),
  })
  s = reduceAgentChat(s, { type: 'complete', messages: [], suggestions: [], at: 2500 })
  expect(lastAgent(s)).toMatchObject({ text: 'Done.', undoable: false })
})

test('error and abort settle the running turn in place', () => {
  const errored = reduceAgentChat(promptedState(), { type: 'error', message: 'No provider signed in', at: 2100 })
  expect(lastAgent(errored)).toMatchObject({ text: 'No provider signed in', error: true, running: false })
  const aborted = reduceAgentChat(promptedState(), { type: 'aborted', at: 2100 })
  expect(lastAgent(aborted)).toMatchObject({ text: 'Stopped.', running: false })
  expect(aborted.running).toBe(false)
})

test('abort after a housekeeping trace keeps the turn undoable — the file is on disk, the restore point live', () => {
  let s = promptedState()
  s = reduceAgentChat(s, {
    type: 'trace',
    event: trace({ metadata: { capability: 'housekeeping.create_file', decision: 'allow', path: 'references.md' } }),
  })
  const aborted = reduceAgentChat(s, { type: 'aborted', at: 2100 })
  expect(lastAgent(aborted)).toMatchObject({ text: 'Stopped.', running: false, undoable: true })
})

test('abort with no writes stays not-undoable', () => {
  let s = promptedState()
  s = reduceAgentChat(s, {
    type: 'trace',
    event: trace({ metadata: { capability: 'files.read', decision: 'allow', path: 'draft.md' } }),
  })
  expect(lastAgent(reduceAgentChat(s, { type: 'aborted', at: 2100 })).undoable).toBe(false)
})

test('error after a housekeeping trace keeps the turn undoable, mirroring complete', () => {
  let s = promptedState()
  s = reduceAgentChat(s, {
    type: 'trace',
    event: trace({ metadata: { capability: 'housekeeping.rename_file', decision: 'allow', path: 'a.md → b.md' } }),
  })
  const errored = reduceAgentChat(s, { type: 'error', message: 'stream broke', at: 2100 })
  expect(lastAgent(errored)).toMatchObject({ text: 'stream broke', error: true, running: false, undoable: true })
})

test('undone appends a restore note and consumes every earlier Undo offer', () => {
  let s = promptedState()
  s = reduceAgentChat(s, {
    type: 'trace',
    event: trace({ metadata: { capability: 'housekeeping.create_file', decision: 'allow', path: 'references.md' } }),
  })
  s = reduceAgentChat(s, {
    type: 'complete',
    messages: [{ role: 'assistant', content: 'Created references.md.', createdAt: 2400 }],
    suggestions: [],
    at: 2500,
  })
  expect(lastAgent(s).undoable).toBe(true)
  s = reduceAgentChat(s, { type: 'undone', paths: ['/ws/references.md'], at: 2600 })
  const note = lastAgent(s)
  expect(note.activity[0]).toMatchObject({ kind: 'undo', text: 'Turn undone — 1 file restored', sub: 'references.md' })
  expect(s.turns.filter((t) => t.kind === 'agent' && t.undoable)).toHaveLength(0)
})

test('stagedLabel names prose edit categories and falls back to the capability', () => {
  expect(stagedLabel(suggestion())).toBe('Staged 1 typo edit')
  expect(stagedLabel(suggestion({ input: { category: 'clarity' } }))).toBe('Staged 1 clarity edit')
  expect(stagedLabel(suggestion({ capabilityName: 'housekeeping.create_file', input: {} }))).toBe(
    'Staged housekeeping.create_file',
  )
})

// --- Task 16: the undo-disarm on user saves, and the accept-path re-arm ---------------------------

/** A settled turn that created a file — the canonical undoable state. */
function undoableState(): AgentChatState {
  let s = promptedState()
  s = reduceAgentChat(s, {
    type: 'trace',
    event: trace({ metadata: { capability: 'housekeeping.create_file', decision: 'allow', path: 'references.md' } }),
  })
  return reduceAgentChat(s, {
    type: 'complete',
    messages: [{ role: 'assistant', content: 'Created references.md.', createdAt: 2400 }],
    suggestions: [],
    at: 2500,
  })
}

test('a user save after the agent turn disarms Undo turn (the T16 must-fix)', () => {
  let s = undoableState()
  expect(lastAgent(s).undoable).toBe(true)
  s = reduceAgentChat(s, { type: 'user-saved' })
  expect(s.userSavedSinceTurn).toBe(true)
  expect(s.turns.filter((t) => t.kind === 'agent' && t.undoable)).toHaveLength(0)
})

test('a user save DURING the turn keeps it disarmed at settle — complete, error and abort alike', () => {
  const base = reduceAgentChat(
    reduceAgentChat(promptedState(), {
      type: 'trace',
      event: trace({ metadata: { capability: 'housekeeping.create_file', decision: 'allow', path: 'references.md' } }),
    }),
    { type: 'user-saved' },
  )
  const completed = reduceAgentChat(base, {
    type: 'complete',
    messages: [{ role: 'assistant', content: 'Created references.md.', createdAt: 2400 }],
    suggestions: [],
    at: 2500,
  })
  expect(lastAgent(completed).undoable).toBe(false)
  expect(lastAgent(reduceAgentChat(base, { type: 'error', message: 'x', at: 2500 })).undoable).toBe(false)
  expect(lastAgent(reduceAgentChat(base, { type: 'aborted', at: 2500 })).undoable).toBe(false)
})

test('a late housekeeping trace cannot re-arm a turn once the user has saved', () => {
  let s = reduceAgentChat(promptedState(), { type: 'complete', messages: [], suggestions: [], at: 2500 })
  s = reduceAgentChat(s, { type: 'user-saved' })
  s = reduceAgentChat(s, {
    type: 'trace',
    event: trace({ metadata: { capability: 'housekeeping.create_file', decision: 'allow', path: 'references.md' } }),
  })
  expect(lastAgent(s).undoable).toBe(false)
})

test('the next prompt opens a fresh restore point and lifts the disarm', () => {
  let s = undoableState()
  s = reduceAgentChat(s, { type: 'user-saved' })
  s = reduceAgentChat(s, { type: 'prompt', text: 'again', at: 3000 })
  expect(s.userSavedSinceTurn).toBe(false)
  s = reduceAgentChat(s, {
    type: 'trace',
    event: trace({ metadata: { capability: 'housekeeping.create_file', decision: 'allow', path: 'notes.md' } }),
  })
  s = reduceAgentChat(s, { type: 'complete', messages: [], suggestions: [], at: 3500 })
  expect(lastAgent(s).undoable).toBe(true)
})

test('accepting a suggestion arms Undo turn on the settled turn', () => {
  let s = reduceAgentChat(promptedState(), { type: 'complete', messages: [], suggestions: [suggestion()], at: 2500 })
  expect(lastAgent(s).undoable).toBe(false) // staged-only turn: nothing on disk yet
  expect(applyArmsUndo(s)).toBe(true)
  s = reduceAgentChat(s, { type: 'suggestion-applied' })
  expect(lastAgent(s).undoable).toBe(true)
})

test('the accept re-arm is blocked after a user save and while a newer turn runs', () => {
  let saved = reduceAgentChat(promptedState(), { type: 'complete', messages: [], suggestions: [suggestion()], at: 2500 })
  saved = reduceAgentChat(saved, { type: 'user-saved' })
  expect(applyArmsUndo(saved)).toBe(false)
  expect(reduceAgentChat(saved, { type: 'suggestion-applied' })).toBe(saved)
  const running = promptedState()
  expect(applyArmsUndo(running)).toBe(false)
  expect(reduceAgentChat(running, { type: 'suggestion-applied' })).toBe(running)
})

// usability review regression (2026-07-03): errored model requests must settle as designed error rows,
// not vanish behind a '[used tools]' placeholder.
test('complete threads the error flag from the last assistant message', () => {
    let s = reduceAgentChat(emptyAgentChat(), { type: 'hydrate', available: true, messages: [], suggestions: [] })
    s = reduceAgentChat(s, { type: 'prompt', text: 'hello', at: 1 })
    s = reduceAgentChat(s, {
      type: 'complete',
      messages: [
        { role: 'user', content: 'hello', createdAt: 1 },
        { role: 'assistant', content: 'The model request failed — Codex error: invalid tool name', createdAt: 2, error: true },
      ],
      suggestions: [],
      at: 2,
    })
    const last = s.turns[s.turns.length - 1]
    expect(last.kind).toBe('agent')
    expect((last as { error?: boolean }).error).toBe(true)
    expect((last as { text: string | null }).text).toContain('The model request failed')
})

test('hydrate preserves error rows from session history', () => {
    const s = reduceAgentChat(emptyAgentChat(), {
      type: 'hydrate', available: true, suggestions: [],
      messages: [
        { role: 'user', content: 'hi', createdAt: 1 },
        { role: 'assistant', content: 'The model request failed — boom', createdAt: 2, error: true },
      ],
    })
    const last = s.history[s.history.length - 1]
    expect((last as { error?: boolean }).error).toBe(true)
})

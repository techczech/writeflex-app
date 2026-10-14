import { expect, test } from 'bun:test'
import { AmbientState, ambientToPrompt, type AmbientSnapshot } from '../../src/main/ambient'

const empty = (): AmbientSnapshot => ({ workspaceRoot: '/writing', activeFile: null, mode: null, selection: null, process: null, recency: {} })
test('window snapshots replace atomically, copy inputs, and retain main-owned agent recency', () => {
  const state = new AmbientState('/writing')
  const input = { ...empty(), activeFile: { path: 'a.md', title: 'A' } }
  state.set(input)
  input.activeFile.title = 'mutated'
  expect(state.get().activeFile?.title).toBe('A')
  state.noteAgentAction('2026-09-04T10:00:00Z')
  state.set(empty())
  expect(state.get()).toEqual({ ...empty(), recency: { lastAgentActionAt: '2026-09-04T10:00:00Z' } })
  expect(() => state.set({ ...empty(), workspaceRoot: '/other' })).toThrow()
})
test('selection including its truncation marker is bounded to 2000 characters', () => {
  const state = new AmbientState('/writing')
  state.set({ ...empty(), selection: { from: 0, to: 3000, text: 'x'.repeat(3000) } })
  expect(state.get().selection?.text).toHaveLength(2000)
  expect(state.get().selection?.text.endsWith(' […]')).toBe(true)
})
test('serialises a labelled compact paragraph including null state without JSON', () => {
  expect(ambientToPrompt(empty())).toBe('Workspace: /writing\nOpen piece: none\nMode: unavailable\nSelection: none\nProcess: unavailable\nRecency: none')
  const paragraph = ambientToPrompt({ ...empty(), activeFile: { path: 'a.md', title: 'A', collection: '', folio: { path: '', index: 1, of: 3 } }, mode: { writer: 'drafting', view: 'clean' }, selection: { from: 4, to: 15, text: 'One.\n\nTwo.' }, process: { session: 'running', wordsThisSession: 12, goal: { target: 200, due: '2026-09-05' } } })
  expect(paragraph).toContain('Selection (4–15): “One. Two.”')
  expect(paragraph).toContain('Folio: .; part 1 of 3')
  expect(paragraph.split('\n').length).toBeLessThanOrEqual(10)
})

test('rejects malformed IPC snapshots without replacing the last valid state', () => {
  const state = new AmbientState('/writing')
  for (const bad of [null, {}, { ...empty(), selection: { from: -1, to: 10, text: 'x' } }, { ...empty(), mode: { writer: 'other', view: 'raw' } }, { ...empty(), activeFile: { path: '../outside.md', title: 'Outside' } }]) {
    expect(() => state.set(bad as AmbientSnapshot)).toThrow()
    expect(state.get()).toEqual(empty())
  }
})

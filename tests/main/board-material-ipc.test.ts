import { expect, test } from 'bun:test'
import { registerBoardMaterialIpcHandlers } from '../../src/main/board-material-ipc'
import type { PieceSourceListing } from '../../src/shared/piece-sources'

// The list-sources channel checks what the renderer sends before main reads anything.

function harness() {
  const handlers = new Map<string, (event: { sender: { id: number } }, input: unknown) => unknown>()
  const calls: Array<{ path: string; dir?: string }> = []
  registerBoardMaterialIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    stateForSender: () => ({}),
    deskFor: async () => { throw new Error('no desk in this test') },
    listSources: async (_state, input) => { calls.push(input); return { piece: input.path } as PieceSourceListing },
    publish: () => {},
  })
  const invoke = async (input: unknown) => handlers.get('board-material:list-sources')!({ sender: { id: 1 } }, input)
  return { calls, invoke }
}

test('list-sources passes a relative path and dir through', async () => {
  const { calls, invoke } = harness()
  await invoke({ path: 'essays/piece.md', dir: 'essays' })
  await invoke({ path: 'essays/piece.md' })
  expect(calls).toEqual([{ path: 'essays/piece.md', dir: 'essays' }, { path: 'essays/piece.md' }])
})

test('list-sources rejects a dir that is not text, a dir that escapes, and an escaping path', async () => {
  const { calls, invoke } = harness()
  await expect(invoke({ path: 'essays/piece.md', dir: 7 })).rejects.toThrow('dir must be text')
  await expect(invoke({ path: 'essays/piece.md', dir: '..' })).rejects.toThrow('workspace-relative')
  await expect(invoke({ path: 'essays/piece.md', dir: '../outside' })).rejects.toThrow('workspace-relative')
  await expect(invoke({ path: '../piece.md' })).rejects.toThrow('workspace-relative')
  await expect(invoke({ path: '/abs/piece.md' })).rejects.toThrow('workspace-relative')
  expect(calls).toEqual([])
})

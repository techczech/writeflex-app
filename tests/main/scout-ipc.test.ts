import { expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerScoutIpcHandlers } from '../../src/main/scout-ipc'

function register() {
  const handlers = new Map<string, (event: { sender: { id: number } }, input: unknown) => unknown>()
  const opened: Array<{ state: string; path: string; line?: number }> = []
  registerScoutIpcHandlers<string>({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    stateForSender: (id) => `window-${id}`,
    openFile: async (state, path, line) => { opened.push({ state, path, line }) },
  })
  const invoke = (channel: string, input: unknown) => handlers.get(channel)!({ sender: { id: 7 } }, input)
  return { handlers, opened, invoke }
}

test('an archive link clicked in a draft opens that file at its line in the sender window', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-scout-ipc-'))
  const piece = join(dir, 'repaved.md')
  await writeFile(piece, '# Repaved\n')
  const { opened, invoke } = register()
  expect(await invoke('links:open-writeflex', `writeflex://open?path=${encodeURIComponent(piece)}&line=36`)).toEqual({ ok: true })
  expect(opened).toEqual([{ state: 'window-7', path: piece, line: 36 }])
})

test('a malformed, foreign or dangling link is refused with a reason and opens nothing', async () => {
  const { opened, invoke, handlers } = register()
  expect([...handlers.keys()].sort()).toEqual(['archive:passage', 'archive:search', 'links:open-writeflex'])
  expect(await invoke('links:open-writeflex', 'https://example.org')).toEqual({ ok: false, reason: 'The link does not use the writeflex scheme.' })
  expect(await invoke('links:open-writeflex', 'writeflex://open?path=%2Fno%2Fsuch%2Ffile.md&line=2')).toEqual({ ok: false, reason: 'The linked piece is not an existing file.' })
  expect(await invoke('links:open-writeflex', 42)).toEqual({ ok: false, reason: 'The link is not a valid URL.' })
  expect(opened).toEqual([])
})

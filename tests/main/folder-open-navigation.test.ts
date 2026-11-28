import { expect, test } from 'bun:test'
import { readFolderOpenDestination } from '../../src/renderer/src/app/folder-open-navigation'

const parts = [
  { path: 'A/first.md', title: 'First' },
  { path: 'A/remembered.md', title: 'Remembered' },
]
const stages = ['declaration', 'parts', 'remembered'] as const

for (const [index, stage] of stages.entries()) {
  test(`a folder open retired during ${stage} stops before its next read or destination`, async () => {
    const entered = Promise.withResolvers<void>()
    const reply = Promise.withResolvers<void>()
    const calls: string[] = []
    let current = true
    async function read<T>(name: string, value: T): Promise<T> {
      calls.push(name)
      if (name === stage) {
        entered.resolve()
        await reply.promise
      }
      return value
    }
    const destination = readFolderOpenDestination('A', () => current, {
      declaration: () => read('declaration', { isFolio: true }),
      parts: () => read('parts', parts),
      rememberedPath: () => read('remembered', 'A/remembered.md'),
    })
    await entered.promise
    current = false
    reply.resolve()
    expect(await destination).toBeNull()
    expect(calls).toEqual(stages.slice(0, index + 1))
  })
}

test('a current Folio prefers its remembered openable part and falls back to the first', async () => {
  const reads = {
    declaration: async () => ({ isFolio: true }),
    parts: async () => parts,
    rememberedPath: async () => 'A/remembered.md',
  }
  expect(await readFolderOpenDestination('A', () => true, reads)).toEqual({ isFolio: true, path: 'A/remembered.md' })
  expect(await readFolderOpenDestination('A', () => true, { ...reads, rememberedPath: async () => 'A/gone.md' }))
    .toEqual({ isFolio: true, path: 'A/first.md' })
  expect(await readFolderOpenDestination('A', () => true, { ...reads, parts: async () => [] }))
    .toEqual({ isFolio: true, path: null })
})

test('a current Collection needs no chapter or remembered-state reads', async () => {
  const unexpected = async () => { throw new Error('Unexpected Folio read') }
  expect(await readFolderOpenDestination('B', () => true, {
    declaration: async () => ({ isFolio: false }),
    parts: unexpected,
    rememberedPath: unexpected,
  })).toEqual({ isFolio: false, path: null })
})

import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RendererErrorLog } from '../../src/main/renderer-errors'

test('renderer error log keeps the newest 200 valid JSONL entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'writeflex-renderer-errors-'))
  const path = join(root, 'renderer-errors.log')
  const log = new RendererErrorLog(path, () => '0.5.0-alpha.12')
  try {
    for (let index = 0; index < 205; index += 1) {
      await log.capture({ message: `failure ${index}`, stack: `stack ${index}`, url: `writeflex://test/${index}` }, index)
    }
    const entries = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(entries).toHaveLength(200)
    expect(entries[0]).toEqual({ ts: 5, version: '0.5.0-alpha.12', message: 'failure 5', stack: 'stack 5', url: 'writeflex://test/5' })
    expect(entries.at(-1)?.message).toBe('failure 204')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('renderer error log sanitises unknown payload fields at the main-process boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'writeflex-renderer-errors-'))
  const path = join(root, 'renderer-errors.log')
  const log = new RendererErrorLog(path, () => 'test')
  try {
    await log.capture({ message: 42, stack: null, url: undefined } as never, 10)
    expect(JSON.parse((await readFile(path, 'utf8')).trim())).toEqual({ ts: 10, version: 'test', message: 'Unknown renderer error', stack: '', url: '' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

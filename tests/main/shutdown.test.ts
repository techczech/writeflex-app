import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('quit cleanup exposes a bounded wait helper', async () => {
  const shutdown = await import('../../src/main/shutdown') as Record<string, unknown>
  expect(typeof shutdown.waitForCleanupWithTimeout).toBe('function')
})

test('quit cleanup stops waiting when its deadline wins and reports the timeout', async () => {
  const { waitForCleanupWithTimeout } = await import('../../src/main/shutdown')
  let warnings = 0
  const never = new Promise<void>(() => {})
  const result = await waitForCleanupWithTimeout(never, 10, () => { warnings += 1 })
  expect(result).toBe('timed-out')
  expect(warnings).toBe(1)
})

test('main-process diagnostics serialise timestamped lifecycle lines', async () => {
  const { MainProcessDiagnostics } = await import('../../src/main/shutdown')
  const root = await mkdtemp(join(tmpdir(), 'wf-main-diagnostics-'))
  const path = join(root, 'main-process.log')
  try {
    const diagnostics = new MainProcessDiagnostics(path)
    await diagnostics.record('window.closed', { windowId: 7 }, 123)
    expect((await readFile(path, 'utf8')).trim()).toBe('{"ts":123,"event":"window.closed","windowId":7}')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

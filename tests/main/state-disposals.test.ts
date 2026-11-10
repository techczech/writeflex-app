import { test, expect } from 'bun:test'
import { registerWindow, trackPendingDisposal, waitForAgentDisposals } from '../../src/main/state'

/**
 * review finding B1 round-3/4: the will-quit wait must cover teardowns TRACKED AFTER the wait began (a thread
 * boot resolving post-disposeAll) — a single snapshot of the pending set lets quit race the flush.
 */
test('waitForAgentDisposals covers disposals tracked after the wait starts', async () => {
  let resolveFirst!: () => void
  let resolveLate!: () => void
  const first = new Promise<void>((resolve) => { resolveFirst = resolve })
  const late = new Promise<void>((resolve) => { resolveLate = resolve })

  trackPendingDisposal(first)
  let settled = false
  const wait = waitForAgentDisposals().then(() => { settled = true })

  // While the wait is in flight, a LATE teardown joins; then the first settles.
  trackPendingDisposal(late)
  resolveFirst()
  await new Promise((r) => setTimeout(r, 20))
  expect(settled).toBe(false) // the late teardown still holds the quit open

  resolveLate()
  await wait
  expect(settled).toBe(true)
})

test.each([true, false])('a refused final diary write is logged with a surviving window: %s', async (hasSurvivor) => {
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Workspace } = await import('../../src/main/workspace')
  const { DiaryCaptureTracker } = await import('../../src/main/diary-capture')
  const { configureMainProcessDiagnostics, recordMainProcessDiagnostic } = await import('../../src/main/shutdown')
  const root = await mkdtemp(join(tmpdir(), 'wf-close-diary-'))
  const messages: unknown[][] = []
  const closed = new Map<number, () => void>()
  function window(id: number) {
    return {
      webContents: { id, isDestroyed: () => false, send: (...args: unknown[]) => messages.push(args) },
      isDestroyed: () => false,
      on: (event: string, fn: () => void) => { if (event === 'closed') closed.set(id, fn) },
    } as unknown as Parameters<typeof registerWindow>[0]
  }
  try {
    configureMainProcessDiagnostics(join(root, 'diagnostics.jsonl'))
    if (hasSurvivor) {
      const survivor = registerWindow(window(90002))
      survivor.workspace = new Workspace(root)
    }
    const closing = registerWindow(window(90001))
    closing.diaryRoot = root
    // A synthetic incomplete block forces the final write to refuse.
    const now = new Date(2026, 10, 2, 9).getTime()
    await writeFile(join(root, '2026-11-02.md'), '<!-- writeflex:recorded:start -->\n')
    closing.diaryCapture = new DiaryCaptureTracker()
    closing.diaryCapture.begin('a.md', 0, now)
    closing.diaryCapture.observe('a.md', 20, now + 60_000)
    closed.get(90001)!()
    await waitForAgentDisposals()
    await recordMainProcessDiagnostic('test.barrier')
    const log = await readFile(join(root, 'diagnostics.jsonl'), 'utf8')
    expect(log).toContain('diary.write.failed')
    if (hasSurvivor) expect(messages).toContainEqual(['diary:error', expect.stringContaining('incomplete')])
    else expect(messages).toHaveLength(0)
  } finally {
    closed.get(90002)?.()
    await waitForAgentDisposals()
    await recordMainProcessDiagnostic('test.cleanup')
    configureMainProcessDiagnostics(null)
    await rm(root, { recursive: true, force: true })
  }
})

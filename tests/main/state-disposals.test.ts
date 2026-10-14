import { test, expect } from 'bun:test'
import { trackPendingDisposal, waitForAgentDisposals } from '../../src/main/state'

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

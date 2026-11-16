// Updating in place (ADR-0054), review round 1 finding 5: making a shared link holds an update's restart for the whole
// operation, from the call until it settles, not only once the link has an id and a queue of its own
// (src/main/sharing-publisher.ts `inFlight`). The service may already hold a link this Mac has not recorded yet.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServiceAnswer, ServiceClient } from '../../src/main/sharing-client'
import { memorySecrets } from '../helpers/memory-secrets'

test('making a link counts as in flight from the call until it settles, however it ends', async () => {
  const { createSharingPublisher } = await import('../../src/main/sharing-publisher')
  const root = mkdtempSync(join(tmpdir(), 'wf-share-hold-'))
  try {
    let answer!: (value: ServiceAnswer<unknown>) => void
    let asked = 0
    const client = {
      createShare: () => { asked += 1; return new Promise<ServiceAnswer<unknown>>((resolve) => { answer = resolve }) },
      turnOff: async () => ({ kind: 'unreachable' as const }),
    } as unknown as ServiceClient
    let cache: unknown = []
    const publisher = createSharingPublisher({
      access: () => ({ base: 'https://fixture.test', address: 'https://fixture.test', key: 'fixture' }),
      secrets: memorySecrets().store, client,
      records: { read: () => cache, write: (next) => { cache = next; return true } },
      render: async () => { throw new Error('not publishing') },
    })
    expect(publisher.inFlight()).toBe(false)
    const making = publisher.make(root, 'paper.md', { name: 'Paper', comments: false })
    // Held from the call, before the service is even asked.
    expect(publisher.inFlight()).toBe(true)
    for (let i = 0; i < 50 && asked === 0; i++) await new Promise((r) => setTimeout(r, 5))
    expect(asked).toBe(1)
    expect(publisher.inFlight()).toBe(true)
    answer({ kind: 'unreachable' })
    const result = await making
    expect(result.ok).toBe(false)
    expect(publisher.inFlight()).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

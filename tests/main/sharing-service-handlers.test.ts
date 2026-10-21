// The sharing service's request handlers, driven from its sources. The suite itself is in
// tests/helpers/sharing-service-handler-suite.ts; sharing-service-bundle.test.ts runs it against the
// built bundle.
import { describe, expect, test } from 'bun:test'
import * as service from '../../sharing-service/index.ts'
import { SHARE_ID_ENTROPY_BITS, SHARE_ID_LENGTH, generateShareId } from '../../sharing-service/share-id.ts'
import { runSharingServiceHandlerSuite } from '../helpers/sharing-service-handler-suite.ts'
import type { ServiceModule } from '../helpers/sharing-service-runtime.ts'

runSharingServiceHandlerSuite('sources', async () => service as unknown as ServiceModule)

describe('the share address', () => {
  test(`is ${SHARE_ID_LENGTH} characters from 62, about ${SHARE_ID_ENTROPY_BITS} bits, with every character equally likely`, () => {
    expect(SHARE_ID_ENTROPY_BITS).toBe(130)
    const counts = new Map<string, number>()
    const ids = new Set<string>()
    for (let i = 0; i < 4000; i += 1) {
      const id = generateShareId()
      ids.add(id)
      for (const char of id) counts.set(char, (counts.get(char) ?? 0) + 1)
    }
    expect(ids.size).toBe(4000)
    expect(counts.size).toBe(62)
    const expected = (4000 * SHARE_ID_LENGTH) / 62
    for (const count of counts.values()) expect(Math.abs(count - expected) / expected).toBeLessThan(0.15)
  })

  test('throws away the random bytes that would favour some characters', () => {
    let calls = 0
    const id = generateShareId((length) => { calls += 1; return new Uint8Array(length).fill(calls === 1 ? 250 : 0) })
    expect(id).toBe('A'.repeat(SHARE_ID_LENGTH))
    expect(calls).toBe(2)
  })
})

// Fix round 0.23-alpha2: "No heading in the text" declines the proposal before it writes `heading: none`.
import { expect, test } from 'bun:test'
import { CLOSE_REFUSED_MESSAGE, keepTitleInMetadataOnlySteps, type KeepTitleSteps } from '../../src/renderer/src/app/keep-title-in-metadata'

const change = { id: 'p1', path: 'report/03.md' }

function harness(over: Partial<KeepTitleSteps> = {}): { steps: KeepTitleSteps; log: string[] } {
  const log: string[] = []
  const steps: KeepTitleSteps = {
    decline: async (id) => { log.push(`decline ${id}`); return true },
    writeHeadingNone: async (path) => { log.push(`write ${path}`) },
    reopen: async (id, message) => { log.push(`reopen ${id}: ${message}`) },
    refusal: (error) => (error as Error).message,
    ...over,
  }
  return { steps, log }
}

test('declines first, then writes heading: none', async () => {
  const { steps, log } = harness()
  expect(await keepTitleInMetadataOnlySteps(change, steps)).toBe('kept')
  expect(log).toEqual(['decline p1', 'write report/03.md'])
})

test('a failed decline writes nothing, so no heading proposal is left pending on a heading: none part', async () => {
  const { steps, log } = harness({ decline: async (id) => { log.push(`decline ${id}`); return false } })
  expect(await keepTitleInMetadataOnlySteps(change, steps)).toBe('not-declined')
  expect(log).toEqual(['decline p1'])
})

test('a refused write reopens the proposal with the plain refusal message', async () => {
  const { steps, log } = harness({ writeHeadingNone: async () => { log.push('write refused'); throw new Error('report/03.md changed while its heading choice was being saved, so nothing was written. Choose again.') } })
  expect(await keepTitleInMetadataOnlySteps(change, steps)).toBe('refused')
  expect(log).toEqual(['decline p1', 'write refused', 'reopen p1: report/03.md changed while its heading choice was being saved, so nothing was written. Choose again.'])
})

test('the message shown when a proposal cannot be closed says plainly that nothing changed', () => {
  expect(CLOSE_REFUSED_MESSAGE).toBe('WriteFlex could not close that proposal, so nothing was changed.')
})

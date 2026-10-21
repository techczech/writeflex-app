// What the Sharing page says about a link (src/renderer/src/components/sharing/sharing-page-model.ts and
// src/shared/sharing-links.ts; sharing ticket 03, frames shared-several and problems).
import { expect, test } from 'bun:test'
import { linkState, notPublishedText } from '../../src/renderer/src/components/sharing/sharing-page-model.ts'
import { cleanLinkName, linkLabel, linkSettingsLabel, type ShareLinkView } from '../../src/shared/sharing-links.ts'

const LINK: ShareLinkView = {
  shareId: 'AbCdEfGhIjKlMnOpQrStUv', name: null, address: 'https://writeflex-sharing.x.workers.dev/s/AbCdEfGhIjKlMnOpQrStUv', comments: true, notes: 'private',
  on: true, madeAt: Date.UTC(2026, 9, 13, 8, 5), publishedAt: null, publishedSavedAt: null, problem: null, publishing: false,
}

test('a link without a name is listed by its settings and the date it was made', () => {
  expect(linkLabel(LINK)).toBe('Private comments · 13 Oct')
  expect(linkLabel({ ...LINK, comments: false })).toBe('No comments · 13 Oct')
  expect(linkLabel({ ...LINK, name: 'Marta' })).toBe('Marta')
  expect(linkSettingsLabel(LINK)).toBe('Comments on, private')
  expect(linkSettingsLabel({ ...LINK, comments: false })).toBe('Comments off')
})

test('names are one line, trimmed, at most 60 characters; empty is none', () => {
  expect(cleanLinkName('  Workshop\n group ')).toBe('Workshop group')
  expect(cleanLinkName('   ')).toBeNull()
  expect(cleanLinkName(7)).toBeNull()
  expect(cleanLinkName('x'.repeat(80))).toHaveLength(60)
})

test('states: off, not published, publishing, published', () => {
  expect(linkState({ ...LINK, on: false }).kind).toBe('off')
  expect(linkState({ ...LINK, problem: { kind: 'offline', reason: 'x', at: 1 } }).kind).toBe('not-published')
  expect(linkState({ ...LINK, publishing: true }).kind).toBe('publishing')
  expect(linkState({ ...LINK, publishedAt: 5 }).kind).toBe('published')
})

test('Not published says the last time publishing worked, or that nothing went out yet', () => {
  const now = Date.UTC(2026, 9, 15, 14, 0)
  const problem = { kind: 'offline' as const, reason: 'WriteFlex cannot reach your sharing service.', at: now }
  const at = new Date(Date.UTC(2026, 9, 15, 13, 41)).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  expect(notPublishedText({ ...LINK, problem, publishedAt: Date.UTC(2026, 9, 15, 13, 41) }, now)).toBe(`WriteFlex cannot reach your sharing service. The last copy went out at ${at}. Readers see that version, labelled with its time. Saves since then are published when it works again.`)
  expect(notPublishedText({ ...LINK, problem }, now)).toContain('Nothing has been published on this link yet')
})

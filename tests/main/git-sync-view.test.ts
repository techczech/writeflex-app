import { test, expect } from 'bun:test'
import { gitState, stopSentences, shortReason, documents, stopSentence, shortPath, type GitView } from '../../src/shared/git-sync-view'
function view(): GitView { return { root: '/test', gitFolder: true, discovery: { state: 'no-remote', reason: 'No place yet.' }, busy: false, wait: 3, result: { state: 'up-to-date', enabled: true, computerName: 'This Mac', pending: [], incoming: [], pairs: [], warnings: [], internalPending: [] } } }
test('stopped, attention, outgoing and incoming precedence retains every lower list', () => {
  const v = view(); v.result.incoming.push({ path: 'incoming.md', kind: 'changed' }); expect(gitState(v)).toBe(2)
  v.result.pending.push({ path: 'local.md', kind: 'changed' }); expect(gitState(v)).toBe(3)
  v.result.pairs.push({ id: 'pair', local: 'a.md', other: 'b.md', from: 'Other Mac', at: 1 }); expect(gitState(v)).toBe(5)
  v.result.reason = { code: 'auth-refused', message: 'not displayed' }; expect(gitState(v)).toBe(4)
  expect(v.result.pending).toHaveLength(1); expect(v.result.incoming).toHaveLength(1); expect(v.result.pairs).toHaveLength(1)
})
test('offline waiting stays outgoing until exactly fifteen minutes; every reason has words and a short label', () => {
  const v = view(); v.result.pending.push({ path: 'local.md', kind: 'changed' }); v.result.reason = { code: 'network-unavailable', message: 'not displayed' }; v.failedAt = 1000
  expect(gitState(v, 900999)).toBe(3); expect(gitState(v, 901000)).toBe(4)
  expect(Object.keys(stopSentences)).toHaveLength(20)
  for (const code of Object.keys(stopSentences) as Array<keyof typeof stopSentences>) { expect(stopSentences[code]).toMatch(/\.$/); expect(shortReason[code].split(' ').length).toBeLessThanOrEqual(4) }
})

test('every stopped reason maps to a compact approved phrase', () => {
  expect(Object.keys(shortReason).sort()).toEqual(Object.keys(stopSentences).sort())
  for (const phrase of Object.values(shortReason)) expect(['offline', 'sign in', 'check a document', 'check a large file', 'needs attention']).toContain(phrase)
  expect(shortReason['network-unavailable']).toBe('offline')
  expect(shortReason['auth-refused']).toBe('sign in')
  expect(shortReason['secret-found']).toBe('check a document')
  expect(documents(1)).toBe('1 document'); expect(documents(2)).toBe('2 documents')
  expect(stopSentence({code: 'secret-found', message: '', document: 'draft.md'})).toBe('A possible password or key was found in draft.md. Remove it, then try again.')
  expect(stopSentence({code: 'secret-found', message: '', document: '.bridle/objects/abc'})).toContain('a saved version of a document')
  expect(shortPath('/a/very/long/path/to/a/repository/on/a/mounted/disk')).toContain('…')
})

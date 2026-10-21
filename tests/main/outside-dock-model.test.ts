import { expect, test } from 'bun:test'
import {
  allowanceStrip, arrivalText, clockTime, reasonSentence, tagTitle, whenPhrase,
} from '../../src/renderer/src/components/outside-dock-model'
import { DISMISSED_LIMIT, loadDismissed, saveDismissed, withDismissed } from '../../src/renderer/src/app/dismissed-not-applied'
import type { Change, OutsideLook, OutsideSummary } from '../../src/preload'

const at = new Date(2026, 9, 7, 14, 2).getTime()

test('tag titles and times follow the string table', () => {
  expect(clockTime(at)).toBe('14:02')
  expect(tagTitle('Claude Code', at, 2, 5, at)).toBe('From Claude Code, 14:02 today, change 2 of 5')
  expect(tagTitle('Codex', at, 1, 1, at)).toBe('From Codex, 14:02 today')
  expect(whenPhrase(at, at + 3 * 86_400_000)).toBe('7 Oct 14:02')
  expect(tagTitle('Codex', at, 3, 4, at + 3 * 86_400_000)).toBe('From Codex, 7 Oct 14:02, change 3 of 4')
})

const look = (over: Partial<OutsideLook> = {}): OutsideLook => ({
  at, filed: 0, changes: 0, closed: 0, unrecorded: 0, repeats: 0, left: 0, leftBecause: [], refusedFull: 0, repliesNotWritten: 0,
  limits: { requestsPerLook: 500, bytesPerLook: 1, undecidedInLedger: 1000, undecidedPerSource: 400, undecidedBytesInLedger: 1, refusedRecordsInLedger: 2000, changesPerRequest: 20 }, ...over,
})
const sum = (claude: number, over: Partial<OutsideSummary> = {}): OutsideSummary => ({
  undecided: claude, limit: 1000, limitPerSource: 400,
  bySource: [{ source: 'claude-code', label: 'Claude Code', undecided: claude }, { source: 'codex', label: 'Codex', undecided: 0 }, { source: 'outside-agent', label: 'Outside agent', undecided: 0 }],
  byRequest: [], lastLook: null, ...over,
})

test('the allowance strip: silent below nine tenths, then one wording by the design’s precedence', () => {
  expect(allowanceStrip(null)).toBeNull()
  expect(allowanceStrip(sum(40))).toBeNull()
  expect(allowanceStrip(sum(359))).toBeNull()
  expect(allowanceStrip(sum(372))).toBe('**372 of 400** changes from Claude Code are waiting. At 400, WriteFlex stops adding requests from Claude Code until you decide some.')
  expect(allowanceStrip(sum(1000, { bySource: sum(300).bySource, lastLook: look({ left: 120, leftBecause: ['ledger-full'] }) }))).toBe('**1,000** changes from outside are waiting, the most WriteFlex keeps. **120 more requests** are waiting and will be added as you decide some of these.')
  expect(allowanceStrip(sum(400, { lastLook: look({ left: 3, leftBecause: ['ledger-full'] }) }))).toContain('the most WriteFlex keeps from one source. **3 more requests** are waiting')
  expect(allowanceStrip(sum(400, { lastLook: look({ refusedFull: 2 }) }))).toContain('**2 new requests** were turned away, and Claude Code was told why.')
  expect(allowanceStrip(sum(5, { lastLook: look({ left: 4, leftBecause: ['look-limit', 'not-held'] }) }))).toBe('**4 requests** are waiting. They cannot be added from this window, because another copy of WriteFlex has this collection open.')
  expect(allowanceStrip(sum(5, { lastLook: look({ left: 3, leftBecause: ['ledger-not-writable'] }) }))).toContain('could not save them to this collection’s review list and will try again.')
  expect(allowanceStrip(sum(5, { lastLook: look({ left: 120, leftBecause: ['look-limit'] }) }))).toBe('**120 more requests** are waiting. WriteFlex adds them a batch at a time; they will appear here shortly.')
})

test('arrival wording names one source or says outside', () => {
  const c = (source: Change['outsideSource']) => ({ outsideSource: source }) as Change
  expect(arrivalText([c('claude-code')])).toBe('1 change arrived from Claude Code')
  expect(arrivalText([c('codex'), c('codex')])).toBe('2 changes arrived from Codex')
  expect(arrivalText([c('codex'), c('claude-code'), c('claude-code')])).toBe('3 changes arrived from outside')
})

test('the reason sentence is chosen by code for the four commonest and is the app’s own text for the rest', () => {
  const r = (closedCode: Change['closedCode'], closedReason = 'as written') => ({ closedCode, closedReason }) as Change
  expect(reasonSentence(r('not-a-document'))).toBe('This path is not a document, so nothing was opened or changed.')
  expect(reasonSentence(r(undefined))).toBe('as written')
  expect(reasonSentence(r('unreadable'))).toBe('as written')
  expect(reasonSentence({ closedCode: 'not-a-real-code', closedReason: 'as written' } as unknown as Change)).toBe('as written')
})

test('dismissed ids are kept per Collection in storage, newest last, capped, and tolerate no storage', () => {
  const data = new Map<string, string>()
  const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) }
  expect(loadDismissed('/c/one', store)).toEqual([])
  saveDismissed('/c/one', withDismissed(['a'], ['b', 'a']), store)
  expect(loadDismissed('/c/one', store)).toEqual(['b', 'a'])
  expect(loadDismissed('/c/two', store)).toEqual([])
  saveDismissed('/c/one', [], store)
  expect(data.size).toBe(0)
  const full = Array.from({ length: DISMISSED_LIMIT }, (_, i) => `id${i}`)
  expect(withDismissed(full, ['new']).at(-1)).toBe('new')
  expect(withDismissed(full, ['new'])).toHaveLength(DISMISSED_LIMIT)
  expect(loadDismissed('/c/one', null)).toEqual([])
  expect(() => saveDismissed('/c/one', ['a'], null)).not.toThrow()
  data.set('writeflex.dismissedNotApplied:/c/bad', '{not json')
  expect(loadDismissed('/c/bad', store)).toEqual([])
})

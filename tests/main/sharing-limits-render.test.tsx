// 0.24 ticket 07: the Limits panel and the Notes waiting cell as drawn (frame `problems`, "Limit reached:
// 14 comments refused"; frame `shared-one`, the Notes waiting column). The link's name is the writer's
// text and is drawn as text.
import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LimitsPanel, WaitingCell } from '../../src/renderer/src/components/sharing/SharingLimits'
import { limitHeading, limitText } from '../../src/shared/sharing-notes'

const limit = { refused: 14, more: false, kind: 'share_rate' as const, figure: 200, raisable: true }
const panel = (over: Partial<Parameters<typeof LimitsPanel>[0]> = {}) => renderToStaticMarkup(createElement(LimitsPanel, {
  linkName: 'Workshop group', limit, comments: true, busy: null, onClear: () => {}, onRaise: () => {}, onCommentsOff: () => {}, ...over,
}))

test('the panel says how many were refused, on which link, and offers Clear, Raise and Turn comments off', () => {
  expect(limitHeading(limit)).toBe('Limit reached: 14 comments refused')
  expect(limitText('Workshop group', limit).map((run) => run.text).join('')).toBe('Readers on Workshop group sent more than the 200 comments a link takes in an hour. 14 were refused, and those readers were told you are not receiving more comments on this link for now.')
  const html = panel()
  expect(html).toContain('data-problem="limit-reached"')
  expect(html).toContain('<b>Workshop group</b>')
  for (const label of ['Clear handled comments', 'Raise the limit for this link', 'Turn comments off']) expect(html).toContain(label)
})

test('more than counted, one refused, the most reached, comments already off', () => {
  expect(limitHeading({ ...limit, more: true })).toBe('Limit reached: more than 14 comments refused')
  expect(limitHeading({ ...limit, refused: 1 })).toBe('Limit reached: 1 comment refused')
  expect(limitText('X', { ...limit, refused: 1 }).at(-1)!.text).toContain('One was refused')
  const most = panel({ limit: { ...limit, raisable: false }, comments: false })
  expect(most).toMatch(/disabled=""[^>]*title="The limit for this link is already as high as it goes."/)
  expect(most).not.toContain('Turn comments off')
})

test('the link name is drawn as text', () => {
  const html = panel({ linkName: '<img src=x onerror=alert(1)>' })
  expect(html).not.toContain('<img')
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
})

test('Notes waiting: the count, marked when notes wait; a dash when not known', () => {
  expect(renderToStaticMarkup(createElement(WaitingCell, { count: 6, shareId: 's' }))).toContain('shr-num hot')
  expect(renderToStaticMarkup(createElement(WaitingCell, { count: 0, shareId: 's' }))).not.toContain('hot')
  expect(renderToStaticMarkup(createElement(WaitingCell, { count: null, shareId: 's' }))).toContain('–')
})

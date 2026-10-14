import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Change } from '../../src/preload'
import { ProvisionalCard } from '../../src/renderer/src/components/change-cards'

const change: Change = {
  id: 'change-1',
  path: 'draft.md',
  ts: 1,
  provenance: 'agent',
  editClass: 'content',
  category: 'wording',
  summary: 'Change one word',
  oldText: 'old',
  newText: 'new',
  status: 'pending',
  isCorrection: false,
}

test('a provisional review card offers Accept and next through its named action', () => {
  const html = renderToStaticMarkup(createElement(ProvisionalCard, {
    change,
    selected: true,
    picked: false,
    onTogglePick: () => {},
    onSelect: () => {},
    onAccept: () => {},
    onAcceptNext: () => {},
    onReject: () => {},
    onHold: () => {},
    onRevertToActive: () => {},
    onSendOriginalToScratchpad: () => {},
  }))

  expect(html).toContain('Accept and next')
})

const render = (c: Change): string =>
  renderToStaticMarkup(createElement(ProvisionalCard, {
    change: c,
    selected: true,
    picked: false,
    onTogglePick: () => {},
    onSelect: () => {},
    onAccept: () => {},
    onAcceptNext: () => {},
    onReject: () => {},
    onHold: () => {},
    onRevertToActive: () => {},
    onSendOriginalToScratchpad: () => {},
  }))
const labels = (html: string): string[] => [...html.matchAll(/<button[^>]*class="ca(?: [^"]*)?"[^>]*>(.*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]*>/g, ''))

test('a text-edit card keeps Keep old / Change to new / Accept and next / Hold both / Send original', () => {
  const html = render(change)
  expect(labels(html)).toEqual(['Keep old', 'Change to new', 'Accept and next', 'Hold both', 'Send original to Scratchpad'])
  expect(html).toContain('Wording · provisional')
})

test('a new-widget card reads Don\'t add / Add widget / Add and next, with no Hold both and no original to send', () => {
  const html = render({ ...change, category: 'other', newFile: { path: 'notes/assets/x.html', content: '<p>x</p>' } } as Change)
  expect(labels(html)).toEqual(["Don&#x27;t add", 'Add widget', 'Add and next'])
  expect(html).toContain('Widget · provisional')
  expect(html).not.toContain('Hold both')
  expect(html).not.toContain('Scratchpad')
})

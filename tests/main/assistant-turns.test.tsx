import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { expect, test } from 'bun:test'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { ModeChip, TurnStrip, TurnSelection } from '../../src/renderer/src/components/AssistantTurns'
import { refusalMessage, storeNotice, groupStopMessage, latestChangedTurn } from '../../src/shared/assistant-turns'
import type { TurnActivity } from '@bridle/core'

const turn: TurnActivity = {
  turnId: 'one', startedAt: 1, outcome: 'completed', mode: 'work',
  responder: { providerId: 'openai-codex', modelId: 'test-model', authLane: 'oauth' },
  counts: { read: 4, created: 1, modified: 0, moved: 3, trashed: 0, deleted: 0 },
  items: [{ kind: 'created', path: 'sources/note.md', capability: 'housekeeping.create_file' }, { kind: 'waiting', path: 'outline.md', capability: 'prose.edit' }],
  undo: { available: true },
}
const noop = () => {}

test('mode chip defaults to Work and the open menu explains all three modes', () => {
  const html = render(<ModeChip mode="work" open onToggle={noop} onChoose={noop} onClose={noop} />)
  expect(html).toContain('aria-expanded="true"')
  expect(html).toContain('Suggest')
  expect(html).toContain('Every write is shown first')
  expect(html).toContain('New files, folders and moves apply at once; edits are shown first')
  expect(html).toContain('The assistant can look but not change anything')
  expect(html).toContain('aria-checked="true"')
  expect(render(<ModeChip mode="read-only" open={false} onToggle={noop} onChoose={noop} onClose={noop} />)).not.toContain('role="menu"')
})

test('strip numbers turns oldest first, marks stopped and failed turns and exposes reasons', () => {
  const html = render(<TurnStrip turns={[turn, { ...turn, turnId: 'two', outcome: 'aborted', reason: 'aborted' }, { ...turn, turnId: 'three', outcome: 'error', reason: 'auth' }]} selected="two" onSelect={noop} />)
  expect(html).toContain('2 stopped')
  expect(html).toContain('3 failed')
  expect(html).toContain('Sign-in expired')
  expect(html).toContain('aria-pressed="true"')
})

test('selected step shows all counts, relative clickable files, model, auth lane and undo', () => {
  const html = render(<TurnSelection turn={turn} number={2} busy={false} refusal={null} onUndo={noop} onOpen={noop} />)
  for (const text of ['Turn 2', 'Read 4', 'Created 1', 'Moved 3', 'Modified 0', 'Trashed 0', 'Deleted 0', '1 waiting', 'sources/note.md', 'test-model', 'ChatGPT', 'Undo turn']) expect(html).toContain(text)
  expect(html).toContain('Sign-in')
})

test('refusal bar offers the explicit undo chain and names changed files', () => {
  const html = render(<TurnSelection turn={turn} number={1} busy={false} refusal={{ undone: false, reason: 'later-turns-exist' }} onUndo={noop} onOpen={noop} />)
  expect(html).toContain('Undo this and later turns')
  expect(refusalMessage({ undone: false, reason: 'changed-after-turn', paths: ['sources/note.md'] })).toContain('sources/note.md')
  for (const reason of ['partially-undone', 'journal-damaged', 'store-read-only', 'adoption-in-flight', 'disposed']) expect(refusalMessage({ undone: false, reason })).not.toContain(reason)
})

test('store notices ignore renewal and explain both read-only reasons; group stops use plain words', () => {
  expect(storeNotice({ status: 'writable', renewing: true })).toBeNull()
  expect(storeNotice({ status: 'read-only', reason: 'lease-lost' })).toContain('write access')
  expect(storeNotice({ status: 'read-only', reason: 'store-in-use-in-process' })).toContain('another assistant')
  for (const reason of ['stale', 'error', 'store-locked', 'conflict']) expect(groupStopMessage(reason)).toBeTruthy()
})


test('strip tiles keep equal bounded widths for one, four and thirteen turns', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const css = await readFile(new URL('../../src/renderer/src/styles/app.css', import.meta.url), 'utf8')
    for (const width of [280, 340, 480]) {
      let singleWidth = 0
      for (const count of [1, 4, 13]) {
        const turns = Array.from({ length: count }, (_, i) => ({ ...turn, turnId: String(i), outcome: i === 2 ? 'aborted' as const : i === 3 ? 'error' as const : 'completed' as const }))
        await page.setContent(`<style>${css}</style><div style="width:${width}px">${render(<TurnStrip turns={turns} selected="1" onSelect={noop} />)}</div>`)
        const geometry = await page.locator('.assistant-turn-strip').evaluate((strip) => ({
          left: strip.getBoundingClientRect().left,
          width: strip.clientWidth,
          scrollWidth: strip.scrollWidth,
          tiles: [...strip.querySelectorAll('button')].map((tile) => ({ width: tile.getBoundingClientRect().width, left: tile.getBoundingClientRect().left, textFits: tile.scrollWidth <= tile.clientWidth })),
        }))
        if (count === 1) singleWidth = geometry.tiles[0].width
        expect(singleWidth).toBeGreaterThanOrEqual(64)
        expect(singleWidth).toBeLessThanOrEqual(width / 3)
        expect(geometry.tiles.every(tile => Math.abs(tile.width - singleWidth) < 1 && tile.textFits)).toBe(true)
        expect(geometry.tiles[0].left - geometry.left).toBe(10)
        if (count === 13) expect(geometry.scrollWidth).toBeGreaterThan(geometry.width)
      }
    }
  } finally { await browser.close() }
})

test('selected turn disclosure starts closed and discovery is absent from counts and receipts', () => {
  const noisy = { ...turn, counts: { ...turn.counts, read: 6 }, items: [...turn.items,
    { kind: 'read' as const, capability: 'tools.search', message: 'Internal discovery search' },
    { kind: 'read' as const, capability: 'tools.enable', message: 'Internal discovery enable' },
    { kind: 'asked' as const, capability: 'tools.enable' },
    { kind: 'tool-error' as const, capability: 'tools.search', message: 'Internal discovery error' },
    { kind: 'read' as const, capability: 'tools.search_documents', path: 'real-search.md' },
  ] }
  const html = render(<TurnSelection turn={noisy} number={2} busy={false} refusal={null} onUndo={noop} onOpen={noop} />)
  expect(html).toContain('<details class="assistant-turn-files">')
  expect(html).toContain('Read 4')
  expect(html).not.toContain('Read 6')
  expect(html).not.toContain('Internal discovery')
  expect(html).not.toContain('tools.enable')
  expect(html).toContain('real-search.md')
  expect(html).toContain('sources/note.md')
})


test('undo skips a newer question and an already undone change', () => {
  const question = { ...turn, turnId: 'question', startedAt: 30, counts: { read: 4, created: 0, modified: 0, moved: 0, trashed: 0, deleted: 0 } }
  const undone = { ...turn, turnId: 'undone', startedAt: 40, undo: { available: false, undoneAt: 50 } }
  expect(latestChangedTurn([question, undone, turn])?.turnId).toBe('one')
  expect(latestChangedTurn([question, undone])).toBeUndefined()
})

test('only current created, modified and moved destinations are links', () => {
  const items: TurnActivity['items'] = [
    { kind: 'created', path: 'created.md', capability: 'create' },
    { kind: 'modified', path: 'modified.md', capability: 'edit' },
    { kind: 'moved', path: 'old.md', toPath: 'new.md', capability: 'move' },
    ...(['trashed', 'deleted', 'outside', 'read', 'waiting'] as const).map(kind => ({ kind, path: kind + '.md', capability: kind })),
    { kind: 'created', path: 'missing.md', capability: 'create' },
  ]
  const html = render(<TurnSelection turn={{ ...turn, items, openPaths: ['created.md', 'modified.md', 'new.md', 'trashed.md', 'deleted.md', 'outside.md', 'read.md', 'waiting.md'] }} number={1} busy={false} refusal={null} onUndo={noop} onOpen={noop} />)
  expect((html.match(/class="alink"/g) ?? [])).toHaveLength(3)
  expect(html).toContain('old.md → new.md')
  expect(html).toContain('<span>outside.md</span>')
  expect(html).toContain('<span>missing.md</span>')
})

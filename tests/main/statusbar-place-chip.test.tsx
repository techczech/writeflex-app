import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { StatusBar } from '../../src/renderer/src/components/StatusBar'
import { placeChipText, statusBarLayout, type PlaceChipWidths, type StatusBarModeId } from '../../src/renderer/src/components/status-bar-model'
import { paneRowFromElement } from '../../src/renderer/src/hooks/usePlace'

const session = { observe: () => {}, sessionWords: 3, elapsedLabel: '0:12', wpm: 15, idle: false, now: 4_500 }
const snapshot = { docText: '## Heading\n\nOne two three.', countText: '## Heading\n\nOne two three.', selEmpty: true, selFrom: 0, selTo: 0, selHead: 5, outline: [{ level: 2, text: 'Heading', from: 0, to: 10 }] }

function renderStatus(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    <StatusBar
      snapshot={snapshot}
      workspaceRoot="/tmp/walking-book"
      typewriterOn={false}
      onToggleTypewriter={() => {}}
      focus={null}
      onOpenFocusPicker={() => {}}
      readAloud={null}
      goal={null}
      onOpenGoal={() => {}}
      writerMode="drafting"
      session={session}
      status=""
      outboxWaiting={0}
      outboxRejected={0}
      outboxNeedsZoteroClosed={false}
      onSyncHighlights={() => {}}
      onOpenRejectedHighlights={() => {}}
      version={null}
      {...overrides}
    />,
  )
}
const visible = (html: string): string => html.slice(0, html.indexOf('class="sb-measure"'))

test('the chip’s words are the drawn ones: the place, a middle dot, the count, "actions"', () => {
  expect(placeChipText('On a heading', 15)).toEqual({ place: 'On a heading', count: ' · 15 actions', full: 'On a heading · 15 actions' })
  expect(placeChipText('In a paragraph', 13).full).toBe('In a paragraph · 13 actions')
  expect(placeChipText('On a file', 9).full).toBe('On a file · 9 actions')
  expect(placeChipText('On a link', 1).full).toBe('On a link · 1 action')
})

test('the chip is drawn after the folder name: icon, place and count, and the ⌘K key cap', () => {
  const html = renderStatus({ place: { label: 'On a heading', count: 15 } })
  const bar = visible(html)
  expect(bar).toContain('data-testid="place-chip"')
  expect(bar).toMatch(/class="place-chip-text">On a heading · 15 actions<\/span><kbd[^>]*>⌘K<\/kbd>/)
  expect(bar).toMatch(/data-testid="place-chip"[^>]*>\s*<svg[^>]*lucide-text-cursor-input/)
  expect(bar.indexOf('class="sb-collection')).toBeLessThan(bar.indexOf('data-testid="place-chip"'))
  expect(bar.indexOf('data-testid="place-chip"')).toBeLessThan(bar.indexOf('sb-disclosure'))
  expect(bar.indexOf('data-testid="place-chip"')).toBeLessThan(bar.indexOf('count-btn'))
  // The absorption measures the chip whole and its count alone.
  expect(html).toContain('data-sb-measure="place"')
  expect(html).toMatch(/data-sb-measure="place-count"> · 15 actions</)
})

test('with no place (the setting off, or nothing open) there is no chip and nothing to measure', () => {
  for (const html of [renderStatus(), renderStatus({ place: null })]) {
    expect(html).not.toContain('place-chip')
    expect(html).not.toContain('data-sb-measure="place"')
    expect(html).toContain('count-btn')
  }
})

const NO_SAVINGS = { collectionWidth: 0, collectionFloor: 0, goalDueWidth: 0, agentLabelWidth: 0 }
const SAVINGS = { collectionWidth: 240, collectionFloor: 96, goalDueWidth: 70, agentLabelWidth: 100 }
const CHIP: PlaceChipWidths = { width: 210, countWidth: 70 }
const MODES: Array<{ id: StatusBarModeId; width: number }> = [{ id: 'reviewing', width: 84 }, { id: 'focus', width: 96 }, { id: 'typewriter', width: 88 }]

test('with room the chip is whole; a layout that measured no chip says nothing about one', () => {
  expect(statusBarLayout(900, 500, 0, [], NO_SAVINGS, false, CHIP).place).toBe('full')
  expect('place' in statusBarLayout(900, 500, 0, [], NO_SAVINGS)).toBe(false)
  expect('place' in statusBarLayout(900, 500, 0, [], NO_SAVINGS, false, null)).toBe(false)
})

test('a narrowing bar drops the chip’s "· N actions" first, then the chip, and never the count', () => {
  // residents 500 + chip 210 = 710
  expect(statusBarLayout(710, 500, 0, [], NO_SAVINGS, false, CHIP).place).toBe('full')
  expect(statusBarLayout(709, 500, 0, [], NO_SAVINGS, false, CHIP).place).toBe('no-count')
  expect(statusBarLayout(640, 500, 0, [], NO_SAVINGS, false, CHIP).place).toBe('no-count')
  expect(statusBarLayout(639, 500, 0, [], NO_SAVINGS, false, CHIP).place).toBe('absorbed')
  expect(statusBarLayout(100, 500, 0, [], NO_SAVINGS, false, CHIP).place).toBe('absorbed')
})

test('the chip stands while "Message the agent…" becomes its icon (state 34), and shrinks only after that', () => {
  // residents 500 + chip 210 = 710; the agent label saves 100.
  const agentOnly = { ...NO_SAVINGS, agentLabelWidth: 100 }
  expect(statusBarLayout(650, 500, 0, [], agentOnly, false, CHIP)).toMatchObject({ agentIconOnly: true, place: 'full' })
  expect(statusBarLayout(609, 500, 0, [], agentOnly, false, CHIP)).toMatchObject({ agentIconOnly: true, place: 'no-count' })
  // The chip gone, the label has its room back; narrower still, the label goes as it does with no chip.
  expect(statusBarLayout(539, 500, 0, [], agentOnly, false, CHIP)).toMatchObject({ agentIconOnly: false, place: 'absorbed' })
  expect(statusBarLayout(450, 500, 0, [], agentOnly, false, CHIP)).toMatchObject({ agentIconOnly: true, place: 'absorbed' })
})

test('the bar’s existing steps come first, in their existing order; the chip leaves before Typewriter does', () => {
  // residents 500 + event 120 + modes 268 + chip 210 = 1098
  expect(statusBarLayout(1098, 500, 120, MODES, SAVINGS, false, CHIP)).toMatchObject({ absorbed: [], place: 'full' })
  expect(statusBarLayout(978, 500, 120, MODES, SAVINGS, false, CHIP)).toMatchObject({ absorbed: ['event'], place: 'full' })
  expect(statusBarLayout(798, 500, 120, MODES, SAVINGS, false, CHIP)).toMatchObject({ absorbed: ['event', 'reviewing', 'focus'], collectionAtFloor: false, place: 'full' })
  // 500 + 88 + 210 = 798 left; floor saves 144, due 70, agent 100 → 484; then the count 70, then the chip.
  expect(statusBarLayout(484, 500, 120, MODES, SAVINGS, false, CHIP)).toMatchObject({ collectionAtFloor: true, goalWithoutDue: true, agentIconOnly: true, place: 'full', absorbed: ['event', 'reviewing', 'focus'] })
  expect(statusBarLayout(483, 500, 120, MODES, SAVINGS, false, CHIP)).toMatchObject({ place: 'no-count', absorbed: ['event', 'reviewing', 'focus'] })
  expect(statusBarLayout(413, 500, 120, MODES, SAVINGS, false, CHIP)).toMatchObject({ place: 'absorbed', absorbed: ['event', 'reviewing', 'focus'] })
  expect(statusBarLayout(273, 500, 120, MODES, SAVINGS, false, CHIP)).toMatchObject({ place: 'absorbed', absorbed: ['event', 'reviewing', 'focus', 'typewriter'] })
})

test('once the chip has left, everything else is laid out exactly as it is with no chip at all', () => {
  for (let width = 100; width <= 520; width += 7) {
    const { place, ...withChip } = statusBarLayout(width, 500, 120, MODES, SAVINGS, false, CHIP)
    if (place !== 'absorbed') continue
    expect(withChip, `at ${width}`).toEqual(statusBarLayout(width, 500, 120, MODES, SAVINGS))
  }
  expect(statusBarLayout(300, 500, 120, MODES, SAVINGS, false, CHIP).place).toBe('absorbed')
})

test('an unmeasured bar keeps the chip whole', () => {
  expect(statusBarLayout(Number.POSITIVE_INFINITY, 500, 0, [], NO_SAVINGS, false, CHIP).place).toBe('full')
})

// The focused element is read through `closest`; a stand-in answers for the selectors that match.
const element = (matches: Record<string, string[]>) => ({
  closest: (selector: string) => selector in matches ? { classList: { contains: (name: string) => matches[selector].includes(name) } } : null,
})

test('the keyboard in the Files pane or the Outline gives a row; in the editor it gives none; elsewhere it changes nothing', () => {
  expect(paneRowFromElement(element({ '.cm-editor': [] }))).toBeNull()
  expect(paneRowFromElement(element({ '.tree [data-row]': ['trow'] }))).toEqual({ kind: 'file' })
  expect(paneRowFromElement(element({ '.tree [data-row]': ['trow', 'folder'] }))).toEqual({ kind: 'folder', focused: false })
  expect(paneRowFromElement(element({ '.tree [data-row]': ['trow', 'folder', 'focused'] }))).toEqual({ kind: 'folder', focused: true })
  expect(paneRowFromElement(element({ '.tree [data-row]': ['trow', 'renaming'] }))).toBeUndefined()
  expect(paneRowFromElement(element({ '.ol-item[role="treeitem"][data-kind="heading"]': [], '.ol-item[role="treeitem"]': [] }))).toEqual({ kind: 'outline-row' })
  expect(paneRowFromElement(element({ '.ol-item[role="treeitem"]': [] }))).toBeNull()
  expect(paneRowFromElement(element({}))).toBeUndefined()
  expect(paneRowFromElement(null)).toBeUndefined()
})

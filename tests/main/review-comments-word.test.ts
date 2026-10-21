// Ticket 11 (review margin): a review item is a Comment everywhere the app words it; no string in the review
// UI sources says Note. Unrelated notes (Agent notes, Index Note, version notes, the note a writer sends back
// to the agent) live in files this scan does not cover. Internal identifiers (kind 'note', readerNote,
// data-margin-note-text) are not strings a person reads and are skipped.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const FILES = [
  'src/renderer/src/components/ReviewMargin.tsx', 'src/renderer/src/components/ReviewCountMenu.tsx',
  'src/renderer/src/components/ReviewNotPlacedPopover.tsx', 'src/renderer/src/components/ReviewElsewherePopover.tsx',
  'src/renderer/src/app/margin-count-menu.ts', 'src/renderer/src/app/margin-card.ts', 'src/renderer/src/app/margin-filter.ts',
  'src/renderer/src/app/margin-mode.ts', 'src/renderer/src/app/margin-outside.ts', 'src/renderer/src/app/review-actions.ts',
  'src/renderer/src/components/sharing/SharingPage.tsx', 'src/renderer/src/components/sharing/SharesList.tsx',
  'src/renderer/src/components/sharing/SharingLimits.tsx', 'src/shared/sharing-notes.ts', 'src/shared/sharing-links.ts',
  'src/renderer/src/components/ExportOptionControls.tsx', 'src/renderer/src/components/ExportPresetControls.tsx',
]

const WORD = /(?<![-\w.])[Nn]otes?(?![-\w])/
/** String literals and JSX text of a source file, with comments cut out. */
function strings(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  const found: string[] = []
  for (const match of code.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`|>([^<>{}\n]+)</g)) found.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? '')
  return found
}

test('no review UI string says Note or Notes for a review item', () => {
  const hits: string[] = []
  for (const file of FILES) {
    for (const text of strings(readFileSync(join(ROOT, file), 'utf8'))) {
      if (/^notes?$/.test(text)) continue // the internal kind
      if (text.includes('My note —')) continue // the writer's own note to the agent, not a review item
      if (WORD.test(text)) hits.push(`${file}: ${text}`)
    }
  }
  expect(hits).toEqual([])
})

test('the command registry labels say Comments and Inline', () => {
  const source = readFileSync(join(ROOT, 'src/renderer/src/commands/registry.ts'), 'utf8')
  const labels = [...source.matchAll(/id: 'review\.[^']+', label: '([^']*)'/g)].map((m) => m[1])
  expect(labels.length).toBeGreaterThan(5)
  expect(labels.filter((label) => WORD.test(label) || /\bUnder\b/.test(label))).toEqual([])
  expect(labels).toContain('Switch Margin / Inline')
  expect(labels).toContain('Show comments only')
})

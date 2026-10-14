import type { Change } from '../../../preload'
import { groupByLocation, type LocationGroup, UNCATEGORISED_CATEGORY } from '../../../engine'
import { resolveChangeRange } from '../editor/change-marks'

export type CategoryOption = { key: string; label: string; count: number }
export type LocationLabel = { mark: string; name: string }

export const CATEGORY_LABELS: Record<string, string> = {
  typo: 'Typo',
  grammar: 'Grammar',
  wording: 'Wording',
  structure: 'Structure',
  clarity: 'Clarity',
  tone: 'Tone',
  other: 'Other',
  [UNCATEGORISED_CATEGORY]: 'Uncategorised',
}

export function categoryKey(change: Change): string {
  return change.category ?? UNCATEGORISED_CATEGORY
}

export function categoryLabel(key: string): string {
  return CATEGORY_LABELS[key] ?? key.replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())
}

export function categoryOptions(changes: Change[]): CategoryOption[] {
  const counts = new Map<string, number>()
  for (const change of changes) counts.set(categoryKey(change), (counts.get(categoryKey(change)) ?? 0) + 1)
  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, label: categoryLabel(key), count }))
    .sort((a, b) => {
      const preferred = ['typo', 'grammar', 'wording', 'structure', 'clarity', 'tone', 'other', UNCATEGORISED_CATEGORY]
      const ai = preferred.indexOf(a.key)
      const bi = preferred.indexOf(b.key)
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
      return a.label.localeCompare(b.label)
    })
}

export function primaryOffset(change: Change): number | null {
  return change.anchor?.from ?? change.moveTo?.from ?? change.moveFrom?.from ?? null
}

export function groupByLiveDocumentLocation(docText: string | undefined, changes: Change[]): LocationGroup[] {
  if (!docText) return groupByLocation(changes)
  return groupByLocation(changes.map((change) => {
    const range = resolveChangeRange(docText, change)
    if (range) return { ...change, anchor: range, moveFrom: undefined, moveTo: undefined }
    return { ...change, anchor: undefined, moveFrom: undefined, moveTo: undefined }
  }))
}

export function locationLabel(docText: string | undefined, from: number | null): LocationLabel {
  if (from == null || !docText) return { mark: '—', name: 'Unanchored changes' }
  const blocks: Array<{ text: string; index: number }> = []
  let index = 0
  for (const text of docText.split(/\n{2,}/)) {
    if (text.trim() !== '') blocks.push({ text, index })
    index += text.length + 2
  }
  let paragraph = 0
  for (const block of blocks) {
    const trimmed = block.text.trim()
    const isHeading = trimmed.startsWith('#')
    if (!isHeading) paragraph += 1
    if (from >= block.index && from <= block.index + block.text.length) {
      const preview = trimmed.replace(/^#+\s*/, '').replace(/\s+/g, ' ')
      return { mark: isHeading ? '§' : `¶${paragraph}`, name: preview.length > 64 ? `${preview.slice(0, 61)}...` : preview }
    }
  }
  return { mark: '—', name: 'Unanchored changes' }
}

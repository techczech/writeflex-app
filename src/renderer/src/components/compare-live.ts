import type { AttributedChange, VersionCompareEndpointId } from '../../../preload'

export type CompareViewSelection = {
  fromId: VersionCompareEndpointId
  toId: VersionCompareEndpointId
} | null

export type CompareToColumnMode = 'editable-working' | 'readonly-version'

export type CompareEditorHighlight = {
  id: string
  from: number
  to: number
  provenance: AttributedChange['provenance']
}

export type CompareEditorHighlights = {
  marks: CompareEditorHighlight[]
}

export function compareToColumnMode(toId: VersionCompareEndpointId): CompareToColumnMode {
  return toId === 'working' ? 'editable-working' : 'readonly-version'
}

export function shouldRefreshWorkingCompare(
  compareView: CompareViewSelection,
  activePath: string | null,
  changedPath: string,
): boolean {
  return compareView?.toId === 'working' && activePath === changedPath
}

function lineStartOffset(doc: string, lineNumber: number): number {
  const target = Math.max(1, lineNumber)
  if (target === 1) return 0
  let line = 1
  for (let index = 0; index < doc.length; index += 1) {
    if (doc[index] === '\n') {
      line += 1
      if (line === target) return index + 1
    }
  }
  return doc.length
}

export function compareHighlightsForEditor(
  changes: readonly AttributedChange[],
  doc: string,
): CompareEditorHighlights {
  const marks: CompareEditorHighlight[] = []

  for (const change of changes) {
    const lineAt = lineStartOffset(doc, change.compareNewStart ?? 1)
    let pos = lineAt
    const segments = change.compareSegments?.length
      ? change.compareSegments
      : [{ kind: change.diffKind === 'removed' ? 'removed' : 'added', text: change.compareNewText }]

    for (const segment of segments) {
      if (segment.kind === 'removed') continue
      const from = pos
      pos += segment.text.length
      if (segment.kind === 'added' && pos > from) {
        marks.push({ id: change.id, from, to: Math.min(pos, doc.length), provenance: change.provenance })
      }
    }
  }

  return {
    marks: marks
      .filter((mark) => mark.to > mark.from && mark.from >= 0 && mark.to <= doc.length)
      .sort((a, b) => a.from - b.from || a.to - b.to),
  }
}

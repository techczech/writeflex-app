import type { CollectionRow, Folio, Plan, PlanPart, StubInput } from '../../../preload'
import { planStageForStatus, type PlanStage } from '../../../shared/plan-stage'

export type PlanDisplayRow = PlanPart & {
  number: number
  written: boolean
  stage: PlanStage | null
  words: number | null
}

export type PlanSummary = { parts: number; written: number; unwritten: number; words: number }

function joinPath(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/')
}

function slugifyFileName(input: string): string {
  const withoutExtension = input.replace(/\.(md|markdown|mdx)$/i, '')
  const slug = withoutExtension.toLowerCase().replace(/['"']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `${slug || 'untitled'}.md`
}

export function buildPlanRows(plan: Plan, collectionRows: CollectionRow[]): PlanDisplayRow[] {
  const byPath = new Map(collectionRows.map((row) => [row.path, row]))
  return plan.parts.map((part, index) => {
    const metadata = part.path ? byPath.get(part.path) : undefined
    return {
      ...part,
      number: index + 1,
      written: part.path !== null,
      stage: metadata ? planStageForStatus(metadata.status) : null,
      words: metadata?.words ?? null,
    }
  })
}

export function planSummary(rows: PlanDisplayRow[]): PlanSummary {
  const written = rows.filter((row) => row.written).length
  return {
    parts: rows.length,
    written,
    unwritten: rows.length - written,
    words: rows.reduce((total, row) => total + (row.words ?? 0), 0),
  }
}

export function composerPosition(parts: PlanPart[], at: number): { ordinal: string; between: string } {
  const before = parts[at - 1]
  const after = parts[at]
  const between = before && after
    ? `between “${before.title}” and “${after.title}”`
    : before
      ? `after “${before.title}”`
      : after
        ? `before “${after.title}”`
        : 'as the first part'
  return { ordinal: `part ${at + 1} of ${parts.length + 1}`, between }
}

export function materialisationPreview(plan: Plan, folio: Folio | null, index: number): {
  path: string
  stubInput: StubInput
  manifestLine: string
} {
  const part = plan.parts[index]
  if (!part) throw new Error('Choose a Plan part before previewing it.')
  const filename = `${String(index + 1).padStart(2, '0')}-${slugifyFileName(part.title)}`
  const path = joinPath(plan.dir, folio?.contentRoot, filename)
  return {
    path,
    stubInput: {
      dir: plan.dir,
      title: part.title,
      gist: part.gloss ?? '',
      path,
      role: part.role,
      titleInFrontmatter: true,
      suppressBacklink: true,
      ...(part.gloss ? { bodyLead: part.gloss } : {}),
    },
    manifestLine: `{ "path": ${JSON.stringify(filename)}, "role": ${JSON.stringify(part.role)} }`,
  }
}

export function pluralisedSummary(summary: PlanSummary): string {
  if (summary.parts === 0) return 'No parts yet'
  if (summary.written === 0) return `${summary.parts} ${summary.parts === 1 ? 'part' : 'parts'} · none written`
  return `${summary.parts} ${summary.parts === 1 ? 'part' : 'parts'} · ${summary.written} written · ${summary.unwritten} jotted`
}

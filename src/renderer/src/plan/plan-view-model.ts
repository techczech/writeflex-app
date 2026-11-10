import type { CollectionRow, Folio, Plan, PlanPart, StubInput } from '../../../preload'
import { planStageForStatus, type PlanStage } from '../../../shared/plan-stage'
import { isFrontMatterRole } from '../../../shared/folio-front-matter'

export type PlanDisplayRow = PlanPart & {
  /** The part's place among the contents, counted from 1; 0 for front matter, which the contents never number (ADR-0046). */
  number: number
  /** The part's index in the running order (every part, front matter included); absent: its place in the list given. */
  index?: number
  /** The part is front matter: listed in the Front matter group, exported before the contents. */
  frontMatter?: boolean
  written: boolean
  stage: PlanStage | null
  words: number | null
}

export type PlanSummary = { parts: number; written: number; unwritten: number; words: number; frontMatter?: number }

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
  let contents = 0
  return plan.parts.map((part, index) => {
    const metadata = part.path ? byPath.get(part.path) : undefined
    const frontMatter = isFrontMatterRole(part.role)
    return {
      ...part,
      number: frontMatter ? 0 : ++contents,
      index,
      frontMatter,
      written: part.path !== null && !part.resolution,
      stage: metadata ? planStageForStatus(metadata.status) : null,
      words: metadata?.words ?? null,
    }
  })
}

/** The running order's counts. Front matter is counted apart (`frontMatter`); `parts`, `written` and `unwritten` are the contents. */
export function planSummary(rows: PlanDisplayRow[]): PlanSummary {
  const front = rows.filter((row) => row.frontMatter === true)
  const contents = rows.filter((row) => row.frontMatter !== true)
  const written = contents.filter((row) => row.written).length
  return {
    parts: contents.length,
    written,
    unwritten: contents.length - written,
    words: rows.reduce((total, row) => total + (row.words ?? 0), 0),
    ...(front.length ? { frontMatter: front.length } : {}),
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
  if (!part) throw new Error('Choose a Folio outline part before previewing it.')
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

/** One unit for a Folio's members: parts (house rule R4). `unwritten` parts are named where the count could be read as fewer ("13 parts, 2 not written yet"). `chapters` is kept for callers and ignored. */
export function pluralisedSummary(summary: PlanSummary, chapters: number | null = null): string {
  void chapters
  if (!summary.frontMatter) return contentsSummary(summary)
  const front = `${summary.frontMatter} front matter`
  return summary.parts === 0 ? `${front} · nothing in the contents yet` : `${front} · ${contentsSummary(summary)}`
}

function contentsSummary(summary: PlanSummary): string {
  if (summary.parts === 0) return 'No parts yet'
  const count = `${summary.parts} ${summary.parts === 1 ? 'part' : 'parts'}`
  return summary.unwritten > 0 ? `${count}, ${summary.unwritten} not written yet` : count
}

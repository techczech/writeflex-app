import { parsePlanLine } from './plan-line'
import type { RoomPriority } from './folio-room'

export type PlanLineChange = { gloss?: string | null; label?: string | null; priority?: RoomPriority | null }
const TAGS = /(?:\s+#[\p{L}\p{N}_-]+)+\s*$/u
const PRIORITY = /^priority-(high|medium|low)$/

/** Splice only the requested synopsis and recognised tags; keep the writer's link, marker and other tags. */
export function editPlanLine(raw: string, change: PlanLineChange, vocabulary: readonly string[]): string {
  const before = parsePlanLine(raw)
  const link = /^\s*(?:-|\*|\d+\.)\s+\[\[[^\]\n]+\]\]/.exec(raw)
  if (!before || !link) throw new Error('That is no longer a Folio outline line.')
  if (change.gloss !== undefined && change.gloss !== null && (typeof change.gloss !== 'string' || /[\r\n]/.test(change.gloss))) throw new Error('A synopsis must be one line.')
  const gloss = change.gloss?.trim() || null
  if (gloss && /(?:^|\s)#[\p{L}\p{N}_-]+$/u.test(gloss)) throw new Error('A synopsis cannot end with a #tag.')
  if (change.priority !== undefined && change.priority !== null && !['high', 'medium', 'low'].includes(change.priority)) throw new Error('Choose High, Medium, Low or no priority.')
  if (change.label !== undefined && change.label !== null && !vocabulary.includes(change.label)) throw new Error('Choose a label from this Folio’s labels.')
  let body = raw.slice(link[0].length)
  const trailing = TAGS.exec(body)
  let tags = trailing?.[0] ?? ''
  body = trailing ? body.slice(0, trailing.index) : body
  if (change.gloss !== undefined) {
    const separators = [body.indexOf(' — '), body.indexOf(' - ')].filter((at) => at >= 0)
    const at = separators.length ? Math.min(...separators) : -1
    if (at >= 0) {
      const tail = body.match(/\s*$/)![0]
      body = body.slice(0, at) + (gloss ? body.slice(at, at + 3) + gloss + tail : '')
    } else if (gloss) body = body.trimEnd() + ' — ' + gloss
  }
  tags = tags.replace(/(\s+)#([\p{L}\p{N}_-]+)/gu, (whole, _space, tag: string) => {
    if (change.priority !== undefined && PRIORITY.test(tag)) return ''
    if (change.label !== undefined && tag.startsWith('label-') && vocabulary.includes(tag.slice(6))) return ''
    return whole
  })
  const additions = [change.label ? `#label-${change.label}` : null, change.priority ? `#priority-${change.priority}` : null].filter(Boolean)
  if (additions.length) {
    const end = tags.match(/\s*$/)![0]
    tags = tags.slice(0, tags.length - end.length) + ' ' + additions.join(' ') + end
  }
  const next = link[0] + body + tags
  const parsed = parsePlanLine(next)
  if (!parsed || parsed.title !== before.title || parsed.role !== before.role || parsed.frontMatter !== before.frontMatter
    || (change.gloss !== undefined && parsed.gloss !== gloss)) throw new Error('That change cannot be represented in the Folio outline.')
  return next
}

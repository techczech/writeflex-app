import { segmentSentences } from './editor/sentences'

/**
 * The archive panel's "Passage" preview and its ⇧↑ / ⇧↓ widening (WF-4B).
 *
 * The engine gives the hit sentence (search) and its whole passage (cite); a writing piece also gets
 * the prose line before and after it. Widening takes one more sentence before or after the hit, but
 * the quote is always a SLICE of those original lines — never re-typed, re-spaced or normalised — so
 * "quotes are original text" holds for a widened quote exactly as for the CLI's own.
 */

export type PassageContext = { before: string | null; passage: string; after: string | null }

/** One piece of a unit (line) of the context: `from`/`to` are offsets inside that unit's text. */
type Piece = { unit: number; from: number; to: number }

export type PassageModel = {
  units: string[]
  /** The unit index that holds the passage (0 or 1, depending on whether a line precedes it). */
  passageUnit: number
  hit: Piece
  /** Sentences wholly before the hit, in document order. */
  pre: Piece[]
  /** Sentences wholly after the hit, in document order. */
  post: Piece[]
}

/** How many extra sentences are taken on each side of the hit. */
export type Widening = { before: number; after: number }

export const NO_WIDENING: Widening = { before: 0, after: 0 }

/** The model, or null when the hit cannot be found verbatim in its passage (then nothing widens). */
export function buildPassageModel(context: PassageContext, hitQuote: string): PassageModel | null {
  const units: string[] = []
  if (context.before) units.push(context.before)
  const passageUnit = units.length
  units.push(context.passage)
  if (context.after) units.push(context.after)
  const hitFrom = context.passage.indexOf(hitQuote)
  if (hitFrom < 0 || hitQuote === '') return null
  const hit: Piece = { unit: passageUnit, from: hitFrom, to: hitFrom + hitQuote.length }
  const pre: Piece[] = []
  const post: Piece[] = []
  units.forEach((text, unit) => {
    for (const sentence of segmentSentences(text)) {
      const piece = { unit, from: sentence.from, to: sentence.to }
      if (unit < passageUnit || (unit === passageUnit && sentence.to <= hit.from)) pre.push(piece)
      else if (unit > passageUnit || (unit === passageUnit && sentence.from >= hit.to)) post.push(piece)
    }
  })
  return { units, passageUnit, hit, pre, post }
}

/** Take one more sentence on `side`; a side with nothing left stays as it is. */
export function widen(model: PassageModel | null, widening: Widening, side: 'before' | 'after'): Widening {
  if (!model) return widening
  if (side === 'before') return widening.before < model.pre.length ? { ...widening, before: widening.before + 1 } : widening
  return widening.after < model.post.length ? { ...widening, after: widening.after + 1 } : widening
}

/** Per unit, the [from, to) span the widened quote covers. */
export function selectedSpans(model: PassageModel, widening: Widening): Map<number, { from: number; to: number }> {
  const pieces = [...model.pre.slice(model.pre.length - widening.before), model.hit, ...model.post.slice(0, widening.after)]
  const spans = new Map<number, { from: number; to: number }>()
  for (const piece of pieces) {
    const span = spans.get(piece.unit)
    spans.set(piece.unit, span ? { from: Math.min(span.from, piece.from), to: Math.max(span.to, piece.to) } : { from: piece.from, to: piece.to })
  }
  return spans
}

/** The quote text: the hit alone when unwidened, else each covered unit's original slice, one per line. */
export function widenedQuote(model: PassageModel, widening: Widening): string {
  const spans = selectedSpans(model, widening)
  return [...spans.entries()]
    .sort(([a], [b]) => a - b)
    .map(([unit, span]) => model.units[unit].slice(span.from, span.to))
    .join('\n')
}

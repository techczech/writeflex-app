import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'
import { uniqueRange } from './suggestion-anchor'
import type { Change } from '../../../preload'

/**
 * The quiet marks in the text (review margin ticket 13, ADR-0046, locked frames `mixed`, `focused`,
 * `hover-vs-focus`, `filter-notes`, `many`): every item that has a card in the margin wears a highlight on
 * its words (violet for an edit, amber for a comment) and its card's marker number as a small superscript
 * after them. Nothing else: no struck old words, no inserted new words, no buttons; acting happens on the
 * card. Hover on a card outlines its words (`is-linked`); focus outlines them more strongly (`is-focus`).
 *
 * The margin owns the list (it knows the filter, the marker numbers and which card is focused) and pushes
 * it through `setChangeMarks`; between pushes the marks MAP through the writer's edits, so a marked phrase
 * tracks typing exactly as suggestion anchors do (editor/suggestion-anchor.ts). The marks show in Drafting
 * and Reviewing alike: they are not track changes (the brief: "No track-changes marks in the text in
 * Drafting, ever") and the card is where the change is read.
 *
 * Clicking a mark is the reverse link: the ref-driven `changeMarkClicks` handler reads App's latest
 * onSelect (extensions are built once per EditorState, so it dereferences a getter) and selects that
 * Change's card without stealing the caret.
 */

/** `quiet`: a quiet fix (typo, grammar) that waits with no card while Show quiet fixes is off: a faint marker only (ADR-0016 §3). */
export type ChangeMarkKind = 'edit' | 'note' | 'quiet'
export type ChangeMark = {
  id: string
  from: number
  to: number
  pending: boolean
  /** Violet for an edit, amber for a comment. Defaults to edit. */
  kind?: ChangeMarkKind
  /** The card's marker number, drawn as a superscript after the words; none when absent. */
  marker?: number | null
  /** The item was written on words that changed under it (ticket 06, frame `stale`): a dashed underline, no tint. */
  stale?: boolean
}
export type ChangeMarkState = {
  marks: ChangeMark[]
  /** The card selected (⌥⌘G, a click): its words are outlined strongly. */
  selectedId: string | null
  /** Cards with keyboard focus inside them: outlined strongly too. */
  focusedIds?: readonly string[]
  /** The card under the pointer: its words are outlined. */
  hoveredId?: string | null
}

/**
 * The text side of a change that is actually present in the live buffer — which differs by who made it:
 * an agent's proposal only enters the document once accepted (until then its ORIGINAL text is what's
 * there, and a rejected proposal is never applied), whereas a writer's or reviewer's edit is in the
 * document the moment it is typed, so its NEW text is what's there regardless of ledger status.
 */
function liveText(c: Change): string {
  if (c.provenance === 'agent') return (c.status === 'accepted' ? c.newText : c.oldText) ?? ''
  // A writer/reviewer edit is in the document as its NEW text; a deletion (newText '') leaves no span,
  // so it resolves to no mark rather than chasing the removed text to some unrelated occurrence.
  return c.newText ?? ''
}

/**
 * Resolve a change to its span in `doc` for the dock↔document link (Task 5). A stored `anchor` wins when
 * it still covers the expected text (it was captured at edit time and is exact); otherwise the text is
 * matched uniquely — the anchor-free path agent changes always take. Null when neither locates it (the
 * text drifted to non-unique, or a deletion left no span to mark).
 */
export function resolveChangeRange(doc: string, c: Change): { from: number; to: number } | null {
  if (c.editClass === 'insert') {
    // An insertion has no text in the buffer yet, so it resolves to a ZERO-WIDTH point at its anchor —
    // the inline surface then renders the proposed text there. An empty anchor (or one that has drifted to
    // missing/ambiguous) appends at the end of the document rather than vanishing: a staged agent change
    // must always be visible in the text, never survive only as a review-pane card.
    const anchor = c.insertAfter ?? ''
    if (anchor === '') return { from: doc.length, to: doc.length }
    const at = uniqueRange(doc, anchor)
    const point = at ? at.to : doc.length
    return { from: point, to: point }
  }
  const target = liveText(c)
  // A replacement the store minimised to a pure insertion ("sat on mat" → "sat on the mat" keeps only
  // "the ") is an undecided agent proposal with no original text in the buffer: its zero-width stored
  // anchor is the point the new words will land, exactly as for an editClass 'insert'. Without this it
  // resolved to nothing and the proposal survived only as a review-pane card.
  if (
    target === '' && c.provenance === 'agent' && (c.status === 'pending' || c.status === 'held') && c.newText !== '' &&
    c.anchor && c.anchor.from === c.anchor.to && c.anchor.from >= 0 && c.anchor.from <= doc.length
  ) {
    return { from: c.anchor.from, to: c.anchor.to }
  }
  // TRULY empty text means no span exists — a deletion, or an agent insertion not yet applied — so it
  // resolves to nothing even when a (now-stale) anchor is stored. Whitespace-only text is NOT empty: a
  // blank line the writer added is present in the buffer, and its exact anchor can still locate it below.
  if (target === '') return null
  // Move.anchor records the destination anchor for host-side re-basing, not the moved source span.
  if (c.editClass !== 'move' && c.anchor && c.anchor.from >= 0 && c.anchor.to <= doc.length && c.anchor.to > c.anchor.from) {
    if (doc.slice(c.anchor.from, c.anchor.to) === target) return { from: c.anchor.from, to: c.anchor.to }
  }
  // A text match needs distinguishing text; whitespace-only never matches uniquely, so it relies on the
  // anchor above and otherwise resolves to nothing.
  return target.trim() ? uniqueRange(doc, target) : null
}

export const setChangeMarks = StateEffect.define<Omit<ChangeMarkState, 'hoveredId'>>()
/** The card under the pointer (null when none): display only, kept apart so hovering never re-sends the list. */
export const setChangeMarkHover = StateEffect.define<string | null>()

/** What one item with a card needs to be marked: the margin's cards satisfy it (margin-model.ts `MarginCard`). */
export type MarkableCard = {
  id: string
  kind: 'edit' | 'note'
  status: 'pending' | 'held' | 'closed'
  source: { type: string }
  anchor: { from: number; to: number }
  /** Not beside its own words (ticket 06): drawn dashed. */
  stale?: 'changed' | 'gone'
}

/**
 * The marks for the margin's shown cards, in card order. The marker is the card's place in that order
 * (the number its card draws). Your own recorded edits are left out: Drafting draws nothing for them
 * (ADR-0025) and Reviewing draws them as its own struck/inserted marks; their card outlines its words
 * through the margin's outline field instead. Cards hidden by the filter are not in `cards`, so their
 * words carry no mark.
 */
export function reviewMarksOf(cards: readonly MarkableCard[], quiet: ReadonlyArray<{ id: string; anchor: { from: number; to: number } }> = [], markers?: ReadonlyMap<string, number>): ChangeMark[] {
  const shown = new Set(cards.map((card) => card.id))
  return [
    // `markers` is the margin's one numbering (settled rows keep theirs, ticket 06); without it, the card's place.
    ...cards.flatMap((card, index) => card.source.type === 'you' ? [] : [{
      id: card.id,
      from: card.anchor.from,
      to: card.anchor.to,
      pending: card.status === 'pending',
      kind: card.kind,
      marker: markers?.get(card.id) ?? index + 1,
      ...(card.stale === 'changed' ? { stale: true } : {}),
    }]),
    // A quiet fix that waits with no card: faint, unnumbered (there is no card to number), never a button.
    ...quiet.filter((item) => !shown.has(item.id)).map((item) => ({ id: item.id, from: item.anchor.from, to: item.anchor.to, pending: true, kind: 'quiet' as const, marker: null })),
  ]
}

/** One mark as drawn: the highlight's span and classes, and where its marker number goes. Pure. */
export type ChangeMarkSpec = {
  id: string
  from: number
  to: number
  className: string
  marker: { at: number; text: string; className: string } | null
}

/**
 * The decoration builder, as data (items, focus, hover → what is drawn). A mark with no span (a proposed
 * insertion: nothing is in the text yet) draws only its marker, at the point the words would land, with a
 * thin caret so the place shows. Marks are clamped to the document.
 */
export function changeMarkSpecs(state: ChangeMarkState, docLength: number, doc?: string): ChangeMarkSpec[] {
  const focused = new Set(state.focusedIds ?? [])
  if (state.selectedId) focused.add(state.selectedId)
  return state.marks
    .filter((m) => m.from >= 0 && m.to >= m.from && m.to <= docLength)
    .slice()
    .sort((a, b) => a.from - b.from || a.to - b.to)
    .map((m) => {
      const kind = m.kind ?? 'edit'
      const states = [
        m.id === state.hoveredId ? 'is-linked' : '',
        m.stale ? 'is-stale' : '',
        focused.has(m.id) ? 'is-focus' : '',
        m.id === state.selectedId ? 'cid-active' : '',
      ].filter(Boolean)
      // The highlight covers the words, not the spaces around them, so the number sits right after the last word.
      let from = m.from
      let to = m.to
      if (doc !== undefined) {
        while (to > from && /\s/.test(doc[to - 1] ?? '')) to -= 1
        while (from < to && /\s/.test(doc[from] ?? '')) from += 1
        if (to === from && m.to > m.from) { from = m.from; to = m.to }
      }
      const point = m.to === m.from
      return {
        id: m.id,
        from,
        to,
        className: ['change-mark', 'rv-mark', `k-${kind}`, ...states].join(' '),
        marker: m.marker == null && !point ? null : {
          at: to,
          text: m.marker == null ? '' : String(m.marker),
          className: ['rv-mn', `k-${kind}`, point ? 'rv-point' : '', ...states].filter(Boolean).join(' '),
        },
      }
    })
}

/** The marker number after the words. Its digits come from CSS (`attr(data-mn)`), so the text's own
 *  content (copy, `textContent`, search) never gains a stray number. */
class MarkerWidget extends WidgetType {
  constructor(readonly id: string, readonly text: string, readonly className: string) {
    super()
  }

  eq(other: MarkerWidget): boolean {
    return other.id === this.id && other.text === this.text && other.className === this.className
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = this.className
    el.dataset.cid = this.id
    el.dataset.mn = this.text
    el.setAttribute('aria-hidden', 'true')
    return el
  }

  ignoreEvent(): boolean {
    return false
  }
}

function decorate(state: ChangeMarkState, doc: string): DecorationSet {
  const ranges = changeMarkSpecs(state, doc.length, doc).flatMap((spec) => [
    ...(spec.to > spec.from ? [Decoration.mark({ class: spec.className, attributes: { 'data-cid': spec.id } }).range(spec.from, spec.to)] : []),
    ...(spec.marker ? [Decoration.widget({ widget: new MarkerWidget(spec.id, spec.marker.text, spec.marker.className), side: 1 }).range(spec.marker.at)] : []),
  ])
  return Decoration.set(ranges, true)
}

const EMPTY: ChangeMarkState = { marks: [], selectedId: null, focusedIds: [], hoveredId: null }

const changeMarksField = StateField.define<{ value: ChangeMarkState; deco: DecorationSet }>({
  create: () => ({ value: EMPTY, deco: Decoration.none }),
  update(field, tr) {
    let value = field.value
    let rebuilt = false
    for (const effect of tr.effects) {
      if (effect.is(setChangeMarks)) { value = { ...effect.value, hoveredId: value.hoveredId ?? null }; rebuilt = true }
      if (effect.is(setChangeMarkHover)) { value = { ...value, hoveredId: effect.value }; rebuilt = true }
    }
    if (tr.docChanged) {
      // Keep the marks pinned to their text by mapping through the edit. A mark whose words were all
      // deleted goes; a proposed insertion (no span) stays at its point.
      value = {
        ...value,
        marks: value.marks.flatMap((mark) => {
          if (mark.from === mark.to) { const at = tr.changes.mapPos(mark.from, 1); return [{ ...mark, from: at, to: at }] }
          const from = tr.changes.mapPos(mark.from, 1)
          const to = tr.changes.mapPos(mark.to, -1)
          return to > from ? [{ ...mark, from, to }] : []
        }),
      }
      if (!rebuilt) return { value, deco: field.deco.map(tr.changes) }
    }
    if (rebuilt) return { value, deco: decorate(value, tr.state.doc.toString()) }
    return field
  },
  provide: (f) => EditorView.decorations.from(f, (s) => s.deco),
})

/** The marks now in the field (mapped through edits since the last push). */
export function changeMarksOf(state: EditorState): ChangeMarkState {
  return state.field(changeMarksField, false)?.value ?? EMPTY
}

export function changeMarkRanges(state: EditorState): Array<{ from: number; to: number }> {
  return state.field(changeMarksField, false)?.value.marks.filter(({ pending }) => pending).map(({ from, to }) => ({ from, to })) ?? []
}

/** Whether two mark lists draw the same thing (the margin skips a push that would change nothing). */
export function sameChangeMarks(a: Omit<ChangeMarkState, 'hoveredId'>, b: Omit<ChangeMarkState, 'hoveredId'>): boolean {
  const fa = a.focusedIds ?? []
  const fb = b.focusedIds ?? []
  return a.selectedId === b.selectedId && fa.length === fb.length && fa.every((id, i) => id === fb[i]) &&
    a.marks.length === b.marks.length && a.marks.every((m, i) => {
      const n = b.marks[i]
      return m.id === n.id && m.from === n.from && m.to === n.to && m.pending === n.pending && (m.kind ?? 'edit') === (n.kind ?? 'edit') && (m.marker ?? null) === (n.marker ?? null) && (m.stale ?? false) === (n.stale ?? false)
    })
}

/** The field alone (no click routing) — headless/test editors carry it so the margin can still dispatch marks. */
export const changeMarking: Extension = changeMarksField

/** Field + ref-driven click routing. `onSelect` is a getter so the built-once extension always reaches
 *  App's current handler. mousedown returns false: the mark is a link, but the caret still lands. */
export function changeMarkClicks(onSelect: () => (id: string) => void): Extension {
  return [
    changeMarksField,
    EditorView.domEventHandlers({
      mousedown: (event) => {
        const el = (event.target as HTMLElement | null)?.closest('.change-mark, .rv-mn')
        const cid = el instanceof HTMLElement ? el.dataset.cid : undefined
        if (!cid) return false
        onSelect()(cid)
        return false
      },
    }),
  ]
}

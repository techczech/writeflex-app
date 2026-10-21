import { markdown } from '@codemirror/lang-markdown'
import { EditorState, StateEffect, StateField, type Extension, type Transaction } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType, keymap } from '@codemirror/view'
import { markdownDialect } from '../../../shared/markdown/dialect'
import { frontmatterBlock } from '../../../shared/markdown/frontmatter'
import { detectLivePreviewBlocks, type LivePreviewBlock, widgetFor } from './live-preview'

/**
 * Pending agent changes in the editor (ADR-0014 data, redrawn by review margin ticket 13 / ADR-0046).
 *
 * App resolves each pending agent change's original-text range (reusing change-marks.resolveChangeRange)
 * and pushes the set via setInlineChanges; between pushes the offsets MAP through the writer's edits. The
 * field is the editor's record of where undecided proposals sit: the keymap acts on the one at the caret,
 * live preview keeps a block with a pending change as source, and App learns which ones could not be placed.
 *
 * What it draws: nothing for prose. Since ADR-0046 a proposed change is read on its card in the margin and
 * the text carries only the quiet mark (editor/change-marks.ts): no struck old words, no inserted new words,
 * no Accept / Decline / Reply buttons in the prose, in Drafting or Reviewing. The one exception is an agent's
 * proposed OBJECT (a table, query, diagram or mind map): ADR-0024 keeps its approval over the rendered object,
 * which the card cannot draw, so it still renders staged at its point with its own Accept and Decline.
 */

export type InlineTextChange = {
  kind: 'text'
  id: string
  /** The original-text span in the live buffer. */
  from: number
  to: number
  /** The live original text shown struck through for within-paragraph edits. */
  oldText: string
  /** The proposed replacement; empty means a pure deletion marker. */
  newText: string
  /** Writer-facing category, used for colour. */
  category: string | null
  /** Dock-linked selection: pending agent changes are selected on their inline widget, not change-marks. */
  selected: boolean
}

export type InlineMoveChange = {
  kind: 'move'
  id: string
  /** The live source span still present in the buffer until accept. */
  from: number
  to: number
  oldText: string
  newText: string
  category: string | null
  selected: boolean
  /** The zero-width insertion point where the moved block will land on accept. */
  destination: number
}

export type InlineChange = InlineTextChange | InlineMoveChange

export type InlineAction = 'accept' | 'reject' | 'revise'

const APPROVABLE_OBJECT_KINDS = new Set<LivePreviewBlock['kind']>(['query', 'table', 'mermaid', 'markmap'])

function hasCompleteFence(source: string): boolean {
  const lines = source.endsWith('\n') ? source.slice(0, -1).split('\n') : source.split('\n')
  return lines.length >= 3 && /^ {0,3}```\s*$/.test(lines.at(-1) ?? '')
}

/** A proposal earns approve-over-render only when its bytes are exactly one complete object block.
 * Ambiguous, partial, multi-block and ordinary-code insertions stay on the raw ChangeWidget path. */
export function approvableObjectProposal(source: string): LivePreviewBlock | null {
  // The app's ONE dialect (shared/markdown/dialect.ts), not a GFM-only state of its own: a proposal
  // is judged against the same Markdown the writer is looking at and the exporters will render.
  const state = EditorState.create({ doc: source, extensions: [markdown({ extensions: markdownDialect() })] })
  const blocks = detectLivePreviewBlocks(state)
  if (blocks.length !== 1) return null
  const [block] = blocks
  if (!APPROVABLE_OBJECT_KINDS.has(block.kind) || block.from !== 0 || block.to !== source.length || block.source !== source) return null
  if (block.kind !== 'table' && !hasCompleteFence(source)) return null
  return block
}

export const setInlineChanges = StateEffect.define<InlineChange[]>()

/** Whether a proposed edit reaches into the document's frontmatter — in which case it is a metadata
 *  proposal and does not render as a prose strike diff. What frontmatter IS comes from the one
 *  shared definition (shared/markdown/frontmatter.ts), so this guard cannot claim a document that
 *  merely opens on a thematic break and refuse to render real edits to its first paragraph. */
export function inlineChangeOverlapsFrontmatter(doc: string, change: { from: number; to: number }): boolean {
  const block = frontmatterBlock(doc)
  return block !== null && change.from < block.end && change.to > 0
}

/** Category → mockup tint class. Secondary categories reuse stable existing tints until their own
 * palette is designed: clarity/tone ride the wording tint; other/null ride the unobtrusive typo tint. */
export function categoryClassForInlineChange(category: string | null): string {
  switch (category) {
    case 'grammar':
      return 'cat-grammar'
    case 'wording':
    case 'clarity':
    case 'tone':
      return 'cat-wording'
    case 'structure':
      return 'cat-structure'
    case 'typo':
    case 'other':
    default:
      return 'cat-typo'
  }
}

export type InlineChangeTextDiff = {
  prefix: string
  oldMiddle: string
  newMiddle: string
  suffix: string
}

function wordBoundary(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return true
  return /\s/.test(text[index - 1] ?? '') || /\s/.test(text[index] ?? '')
}

function boundaryPrefixLength(oldText: string, newText: string): number {
  const max = Math.min(oldText.length, newText.length)
  let shared = 0
  while (shared < max && oldText[shared] === newText[shared]) shared += 1

  for (let length = shared; length > 0; length -= 1) {
    if (wordBoundary(oldText, length) && wordBoundary(newText, length)) return length
  }
  return 0
}

function boundarySuffixLength(oldText: string, newText: string, prefixLength: number): number {
  const max = Math.min(oldText.length - prefixLength, newText.length - prefixLength)
  let shared = 0
  while (
    shared < max &&
    oldText[oldText.length - 1 - shared] === newText[newText.length - 1 - shared]
  ) {
    shared += 1
  }

  for (let length = shared; length > 0; length -= 1) {
    const oldStart = oldText.length - length
    const newStart = newText.length - length
    if (
      oldStart >= prefixLength &&
      newStart >= prefixLength &&
      wordBoundary(oldText, oldStart) &&
      wordBoundary(newText, newStart)
    ) {
      return length
    }
  }
  return 0
}

/** Minimal inline visual diff for a single staged change. Shared prefix/suffix is only stripped at
 * word boundaries, so the renderer never presents a misleading half-word context split. */
export function diffInlineChangeText(oldText: string, newText: string): InlineChangeTextDiff {
  const prefixLength = boundaryPrefixLength(oldText, newText)
  const suffixLength = boundarySuffixLength(oldText, newText, prefixLength)
  return {
    prefix: oldText.slice(0, prefixLength),
    oldMiddle: oldText.slice(prefixLength, oldText.length - suffixLength),
    newMiddle: newText.slice(prefixLength, newText.length - suffixLength),
    suffix: oldText.slice(oldText.length - suffixLength),
  }
}

// lucide paths, drawn as real SVG (never letter/unicode stand-ins — the M1 lesson).
const ICONS: Record<InlineAction, string[]> = {
  accept: ['M20 6 9 17l-5-5'],
  reject: ['M18 6 6 18', 'm6 6 12 12'],
  revise: ['M20 20v-7a4 4 0 0 0-4-4H4', 'm9 14-5-5 5-5'],
}

function icon(paths: string[]): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  for (const d of paths) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    p.setAttribute('d', d)
    svg.appendChild(p)
  }
  return svg
}

const AGENT_ICON = ['M12 8V4H8', 'M4 8h16v12H4z', 'M2 14h2', 'M20 14h2', 'M15 13v2', 'M9 13v2']

function stagedObjectButton(cid: string, action: Extract<InlineAction, 'accept' | 'reject'>, label: string, primary = false): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `qa-btn${primary ? ' primary' : ''}`
  button.dataset.cid = cid
  button.dataset.act = action
  button.setAttribute('aria-label', label)
  button.append(icon(ICONS[action]), document.createTextNode(label))
  if (primary) {
    const shortcut = document.createElement('kbd')
    shortcut.textContent = '⏎'
    button.appendChild(shortcut)
  }
  return button
}

const OBJECT_LABELS: Record<Extract<LivePreviewBlock['kind'], 'query' | 'table' | 'mermaid' | 'markmap'>, string> = {
  query: 'query',
  table: 'table',
  mermaid: 'diagram',
  markmap: 'mind map',
}

/** The locked W1c approval surface: attribution and controls surround the same renderer used after
 * acceptance. The underlying document stays untouched until the existing accept action resolves it. */
class StagedObjectWidget extends WidgetType {
  constructor(readonly change: InlineTextChange, readonly block: LivePreviewBlock) {
    super()
  }

  eq(other: StagedObjectWidget): boolean {
    return other.change.id === this.change.id && other.change.newText === this.change.newText && other.change.selected === this.change.selected
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = `agent-object-proposal inline-change${this.change.selected ? ' sel cid-active' : ''}`
    wrap.dataset.cid = this.change.id

    const marker = document.createElement('span')
    marker.className = 'insert-marker'
    const leftLine = document.createElement('span'); leftLine.className = 'ln'
    const rightLine = document.createElement('span'); rightLine.className = 'ln l'
    marker.append(leftLine, document.createTextNode('Agent inserted here'), rightLine)

    const staged = document.createElement('span')
    staged.className = 'qobj staged'

    const attribution = document.createElement('span')
    attribution.className = 'q-attr'
    const iconShell = document.createElement('span'); iconShell.className = 'qa-ic'; iconShell.appendChild(icon(AGENT_ICON))
    const text = document.createElement('span'); text.className = 'qa-t'
    const title = document.createElement('b')
    title.textContent = `Agent inserted a ${OBJECT_LABELS[this.block.kind as keyof typeof OBJECT_LABELS]}`
    const detail = document.createElement('small'); detail.textContent = 'staged · not written to the file until you accept'
    text.append(title, document.createTextNode(' at your cursor'), detail)
    const actions = document.createElement('span'); actions.className = 'qa-act'
    actions.append(
      stagedObjectButton(this.change.id, 'accept', 'Accept', true),
      stagedObjectButton(this.change.id, 'reject', 'Decline'),
    )
    attribution.append(iconShell, text, actions)

    const renderedWidget = widgetFor(this.block, '', false, false)
    const rendered = renderedWidget.toDOM(view)
    rendered.classList.add('staged-object-render')
    staged.append(attribution, rendered)
    wrap.append(marker, staged)
    ;(wrap as HTMLElement & { __wfDestroyRendered?: () => void }).__wfDestroyRendered = () => renderedWidget.destroy(rendered)
    return wrap
  }

  ignoreEvent(): boolean {
    return false
  }

  destroy(dom: HTMLElement): void {
    ;(dom as HTMLElement & { __wfDestroyRendered?: () => void }).__wfDestroyRendered?.()
  }
}

/** What the field draws: only an agent's proposed object, staged over its render (ADR-0024). Prose edits,
 * insertions of prose and moves draw nothing here; their words wear the margin's quiet mark. */
export function inlineObjectProposals(doc: string, changes: InlineChange[]): Array<{ change: InlineTextChange; block: LivePreviewBlock }> {
  return changes.flatMap((c) => {
    if (c.kind !== 'text' || c.from !== c.to || inlineChangeOverlapsFrontmatter(doc, c)) return []
    const block = approvableObjectProposal(c.newText)
    return block ? [{ change: c, block }] : []
  })
}

function build(doc: string, changes: InlineChange[]): DecorationSet {
  const ranges = inlineObjectProposals(doc, changes).map(({ change, block }) =>
    Decoration.widget({ widget: new StagedObjectWidget(change, block), side: 1 }).range(change.from))
  return Decoration.set(ranges, true)
}

function mapInlineChange(c: InlineChange, tr: Transaction): InlineChange {
  if (c.kind === 'move') {
    return {
      ...c,
      from: tr.changes.mapPos(c.from, 1),
      to: tr.changes.mapPos(c.to, -1),
      destination: tr.changes.mapPos(c.destination, 1),
    }
  }
  return { ...c, from: tr.changes.mapPos(c.from, 1), to: tr.changes.mapPos(c.to, -1) }
}

const inlineField = StateField.define<{ changes: InlineChange[]; deco: DecorationSet }>({
  create: () => ({ changes: [], deco: Decoration.none }),
  update(field, tr) {
    const effect = tr.effects.find((e) => e.is(setInlineChanges))
    if (effect) return {
      changes: effect.value,
      deco: build(tr.state.doc.toString(), effect.value),
    }
    if (tr.docChanged) {
      // Map BOTH the decorations and the raw offsets through the edit, so the ⌘⏎/⇧⌘⏎/⌘R keymap (which
      // reads change.from/to via nearest()) targets the right change after the writer types above one.
      const changes = field.changes.map((c) => mapInlineChange(c, tr))
      return { changes, deco: field.deco.map(tr.changes) }
    }
    return field
  },
  provide: (f) => EditorView.decorations.from(f, (s) => s.deco),
})

export function inlineChangeRanges(state: EditorState): Array<{ from: number; to: number }> {
  return state.field(inlineField, false)?.changes.map(({ from, to }) => ({ from, to })) ?? []
}

/** The decoration field alone (no click routing / keymap) — headless/test editors carry it so App can
 *  still dispatch inline changes into any buffer. */
export const inlineChangesField: Extension = inlineField

/** Resolve the pending change the cursor sits in, else the nearest one — the keyboard entry point so the
 *  retired popup's "act on the change in front of me" model survives without a floating card. */
function nearest(view: EditorView): InlineChange | null {
  const changes = view.state.field(inlineField).changes
  if (changes.length === 0) return null
  const pos = view.state.selection.main.head
  let best: InlineChange | null = null
  let bestDist = Infinity
  for (const c of changes) {
    if (pos >= c.from && pos <= c.to) return c
    const d = c.kind === 'move'
      ? Math.min(Math.abs(pos - c.from), Math.abs(pos - c.to), Math.abs(pos - c.destination))
      : Math.min(Math.abs(pos - c.from), Math.abs(pos - c.to))
    if (d < bestDist) {
      bestDist = d
      best = c
    }
  }
  return best
}

/**
 * The whole extension: the decoration field, ref-driven click routing on the action bar, and a keymap so
 * the change nearest the cursor is keyboard-operable (⌘⏎ accept · ⇧⌘⏎ reject · ⌘R revise) — the editor's
 * own ⏎/⌫ still type, which is why these are modified. `onAction`/`onSelect` are getters (built-once
 * extension).
 */
export function inlineChanges(
  onAction: () => (id: string, act: InlineAction) => void,
  onSelect: () => (id: string) => void,
): Extension {
  const act = (view: EditorView, action: InlineAction): boolean => {
    const c = nearest(view)
    if (!c) return false
    onAction()(c.id, action)
    return true
  }
  return [
    inlineField,
    EditorView.domEventHandlers({
      mousedown: (event, view) => {
        const el = (event.target as HTMLElement | null)?.closest('.mini[data-act], .qa-btn[data-act]')
        if (el instanceof HTMLElement && el.dataset.cid && el.dataset.act) {
          event.preventDefault() // keep the caret; the widget is a control, not text
          if (el.dataset.act === 'accept' || el.dataset.act === 'reject') view.focus()
          onAction()(el.dataset.cid, el.dataset.act as InlineAction)
          return true
        }

        const changeEl = (event.target as HTMLElement | null)?.closest('.inline-change[data-cid]')
        const cid = changeEl instanceof HTMLElement ? changeEl.dataset.cid : undefined
        if (cid && view.state.field(inlineField).changes.some((c) => c.id === cid)) {
          onSelect()(cid)
        }
        return false
      },
    }),
    keymap.of([
      { key: 'Mod-Enter', run: (v) => act(v, 'accept') },
      { key: 'Shift-Mod-Enter', run: (v) => act(v, 'reject') },
      { key: 'Mod-r', run: (v) => act(v, 'revise') },
    ]),
  ]
}

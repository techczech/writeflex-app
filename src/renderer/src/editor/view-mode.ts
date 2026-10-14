import { syntaxTree } from '@codemirror/language'
import { getSearchQuery } from '@codemirror/search'
import { Facet, StateEffect, StateField, type EditorState, type Extension, type Range, type StateCommand } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'

export type EditorViewMode = 'clean' | 'markup' | 'raw'
export type TextRange = { from: number; to: number }

export const setEditorViewMode = StateEffect.define<EditorViewMode>()

const VIEW_MODES: readonly EditorViewMode[] = ['clean', 'markup', 'raw']

export function normaliseEditorViewMode(value: unknown): EditorViewMode {
  return VIEW_MODES.includes(value as EditorViewMode) ? value as EditorViewMode : 'clean'
}

export function nextEditorViewMode(mode: EditorViewMode): EditorViewMode {
  return VIEW_MODES[(VIEW_MODES.indexOf(mode) + 1) % VIEW_MODES.length]
}

const initialViewMode = Facet.define<EditorViewMode, EditorViewMode>({
  combine: (values) => values[0] ?? 'clean',
})

const viewModeField = StateField.define<EditorViewMode>({
  create: (state) => state.facet(initialViewMode),
  update(value, transaction) {
    return transaction.effects.find((effect) => effect.is(setEditorViewMode))?.value ?? value
  },
})

type ConcealableElement = TextRange & { markers: TextRange[]; cap?: TextRange }
type ConcealmentState = { decorations: DecorationSet; ranges: TextRange[] }

const KBD_OPEN = /^<kbd>$/i
const KBD_CLOSE = /^<\/kbd>$/i
const keyCap = Decoration.mark({ class: 'wf-kbd' })

function markerWithTrailingSpace(state: EditorState, from: number, to: number): TextRange {
  while (to < state.doc.length && state.doc.sliceString(to, to + 1) === ' ') to += 1
  return { from, to }
}

function concealableElements(state: EditorState): ConcealableElement[] {
  const elements = new Map<string, ConcealableElement>()
  const add = (kind: string, from: number, to: number, marker: TextRange): void => {
    const key = `${kind}:${from}:${to}`
    const element = elements.get(key) ?? { from, to, markers: [] }
    element.markers.push(marker)
    elements.set(key, element)
  }

  syntaxTree(state).iterate({
    enter(ref) {
      const node = ref.node
      const parent = node.parent
      if (node.name === 'HTMLTag' && KBD_OPEN.test(state.sliceDoc(node.from, node.to))) {
        // `<kbd>…</kbd>`: the inline-HTML key cap. The tags are sibling HTMLTag nodes; pair the
        // opener with the next closer in the same parent. An unpaired tag stays visible source.
        for (let next = node.nextSibling; next; next = next.nextSibling) {
          if (next.name === 'HTMLTag' && KBD_CLOSE.test(state.sliceDoc(next.from, next.to))) {
            const key = `kbd:${node.from}:${next.to}`
            elements.set(key, {
              from: node.from, to: next.to, cap: { from: node.to, to: next.from },
              markers: [{ from: node.from, to: node.to }, { from: next.from, to: next.to }],
            })
            break
          }
          if (next.name === 'HTMLTag' && KBD_OPEN.test(state.sliceDoc(next.from, next.to))) break
        }
        return
      }
      if (node.name === 'Link') {
        const url = node.getChild('URL')
        if (url && node.from < url.from) {
          add('link', node.from, node.to, { from: node.from, to: node.from + 1 })
          add('link', node.from, node.to, { from: Math.max(node.from + 1, url.from - 2), to: node.to })
        }
        return
      }
      if (!parent) return
      if (node.name === 'HeaderMark') {
        add('heading', parent.from, parent.to, markerWithTrailingSpace(state, node.from, node.to))
      } else if (node.name === 'EmphasisMark') {
        add('emphasis', parent.from, parent.to, { from: node.from, to: node.to })
      } else if (node.name === 'CodeMark') {
        add('code', parent.from, parent.to, { from: node.from, to: node.to })
      } else if (node.name === 'StrikethroughMark') {
        add('strikethrough', parent.from, parent.to, { from: node.from, to: node.to })
      } else if (node.name === 'QuoteMark') {
        add('blockquote', parent.from, parent.to, markerWithTrailingSpace(state, node.from, node.to))
      }
    },
  })
  return [...elements.values()]
}

function activeSearchMatches(state: EditorState): TextRange[] {
  const query = getSearchQuery(state)
  if (!query.valid || query.search === '') return []
  const matches: TextRange[] = []
  const cursor = query.getCursor(state)
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    matches.push(next.value)
    if (matches.length >= 1_000) break
  }
  return matches
}

function intersects(a: TextRange, b: TextRange): boolean {
  return a.from < b.to && a.to > b.from
}

function elementIsRevealed(state: EditorState, element: ConcealableElement, searchMatches: TextRange[]): boolean {
  if (searchMatches.some((match) => intersects(element, match))) return true
  // Selection focus is element focus in Clean mode. Derive it synchronously from the transaction's
  // state so a formatting command reveals its newly selected markers before the DOM selection sync.
  // Every range participates: a caret may sit on either boundary, while a non-empty range must
  // overlap document text in the element (merely ending at its opening boundary does not select it).
  return state.selection.ranges.some((selection) =>
    selection.empty
      ? selection.head >= element.from && selection.head <= element.to
      : intersects(element, { from: selection.from, to: selection.to }),
  )
}

function buildConcealment(state: EditorState): ConcealmentState {
  if (state.field(viewModeField) !== 'clean') {
    return { decorations: Decoration.none, ranges: [] }
  }
  const searchMatches = activeSearchMatches(state)
  const hidden = concealableElements(state).filter((element) => !elementIsRevealed(state, element, searchMatches))
  const ranges = hidden
    .flatMap((element) => element.markers)
    .sort((a, b) => a.from - b.from || a.to - b.to)
  const decorations: Range<Decoration>[] = ranges.map(({ from, to }) => Decoration.replace({}).range(from, to))
  // A concealed `<kbd>` shows its text as a key cap; revealed (caret in or on it) it is plain source.
  for (const element of hidden) if (element.cap && element.cap.to > element.cap.from) decorations.push(keyCap.range(element.cap.from, element.cap.to))
  const set = Decoration.set(decorations, true)
  return { decorations: set, ranges }
}

const concealmentField = StateField.define<ConcealmentState>({
  create: buildConcealment,
  update(value, transaction) {
    if (!transaction.docChanged && !transaction.selection && transaction.effects.length === 0) return value
    return buildConcealment(transaction.state)
  },
  // These are visual replacements, not atomic document ranges. Making concealed markers atomic
  // lets the DOM selection reconciler shorten a freshly formatted selection at its hidden trailing
  // marker (for example `**bravo**` becomes `**bravo`), so the next smart-pair input wraps the wrong
  // document span in Clean mode. Cursor entry already reveals the whole element; atomic skipping is
  // both unnecessary and destructive here.
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
})

export function editorViewMode(initial: EditorViewMode = 'clean'): Extension {
  return [initialViewMode.of(initial), viewModeField, concealmentField]
}

export function editorViewModeOf(state: EditorState): EditorViewMode {
  // `livePreview()` is also a reusable standalone extension in headless command tests. Treat an
  // omitted presentation field as the product default rather than making that extension depend on
  // the full app stack.
  return state.field(viewModeField, false) ?? 'clean'
}

export function setViewModeCommand(mode: EditorViewMode): StateCommand {
  return ({ state, dispatch }) => {
    dispatch?.(state.update({ effects: setEditorViewMode.of(mode) }))
    return true
  }
}

export function concealedMarkupRanges(state: EditorState): TextRange[] {
  return state.field(concealmentField).ranges
}

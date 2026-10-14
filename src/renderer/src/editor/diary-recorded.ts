import { RangeSetBuilder } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

const START = '<!-- writeflex:recorded:start -->'
const END = '<!-- writeflex:recorded:end -->'

/** Paint the machine-owned region without changing its ordinary Markdown source or editor behaviour. */
function recordedDecorations(view: EditorView): DecorationSet {
  const ranges = new RangeSetBuilder<Decoration>()
  let recorded = false
  for (let number = 1; number <= view.state.doc.lines; number += 1) {
    const line = view.state.doc.line(number)
    if (line.text.includes(START)) recorded = true
    if (recorded) ranges.add(line.from, line.from, Decoration.line({ attributes: { class: 'diary-recorded-line' } }))
    if (line.text.includes(END)) recorded = false
  }
  return ranges.finish()
}

export const diaryRecordedBlock = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = recordedDecorations(view)
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) this.decorations = recordedDecorations(update.view)
  }
}, { decorations: (plugin) => plugin.decorations })

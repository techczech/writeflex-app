// Ask the agent about this… (Actions here menu, ticket 03): the quoted context that goes into the agent
// composer. Pure: an editor state and a place in, text out. Nothing here sends anything; App puts the
// text in the composer (`focusComposer`) and the writer types the question and presses send.
//
// What is quoted, per place (final spec, "New commands needed" 1):
//   selection                              the selected text
//   paragraph, quotation, list/task item   the block (a list item with its children)
//   link                                   the block the link is in
//   heading                                the section (the heading to the next heading of the same or a higher level)
//   table, code block                      the block's source
//   image                                  the image's path
//   empty document                         nothing
import type { EditorState } from '@codemirror/state'
import { getSectionRange } from '@bridle/outline'
import { blockSpanAt } from '../editor/block-actions'
import { livePreviewBlocks } from '../editor/live-preview'
import type { Place } from './place'

/** The most context quoted, in characters. Longer text is cut at a block boundary. */
export const ASK_CONTEXT_LIMIT = 4_000
/** The visible note that follows a cut quotation. */
export const SHORTENED_NOTE = '(shortened)'

/** The row's label at a place ("Ask the agent about this table…"). */
export const askLabelAt = (place: Place): string => {
  switch (place) {
    case 'heading': case 'heading-top': return 'Ask the agent about this section…'
    case 'table': return 'Ask the agent about this table…'
    case 'code-block': return 'Ask the agent about this block…'
    case 'image': return 'Ask the agent about this image…'
    case 'empty-document': return 'Ask the agent…'
    default: return 'Ask the agent about this…'
  }
}

/** The text to quote at a place, uncut; '' when there is nothing to quote. */
export function askContextAt(state: EditorState, place: Place): string {
  const { from, to, empty } = state.selection.main
  if (place === 'empty-document') return ''
  if (place === 'selection' && !empty) return state.sliceDoc(from, to)
  if (place === 'heading' || place === 'heading-top') {
    const section = getSectionRange(state.doc.toString(), from)
    return section ? state.sliceDoc(section.from, section.to).replace(/\n+$/, '') : ''
  }
  if (place === 'table' || place === 'code-block' || place === 'image') {
    const block = livePreviewBlocks(state).find((item) => from >= item.from && (from < item.to || (item.to >= state.doc.length && from <= item.to)))
    if (!block) return ''
    if (place === 'image') return block.url ?? /\]\(([^)]*)\)/.exec(block.source)?.[1] ?? block.source
    return block.source.replace(/\n+$/, '')
  }
  const span = blockSpanAt(state)
  return span ? state.sliceDoc(span.from, span.to) : ''
}

/** `text` cut to the limit at a block boundary (a blank line, else a line), or as a last resort at the limit itself. */
export function cutAtBlock(text: string, limit = ASK_CONTEXT_LIMIT): { text: string; shortened: boolean } {
  if (text.length <= limit) return { text, shortened: false }
  const window = text.slice(0, limit)
  for (const boundary of [/\n\s*\n(?![\s\S]*\n\s*\n)/, /\n(?![\s\S]*\n)/]) {
    const match = boundary.exec(window)
    if (match && match.index > 0) return { text: window.slice(0, match.index).replace(/\s+$/, ''), shortened: true }
  }
  return { text: window, shortened: true }
}

/**
 * The composer's text: the context as a quotation, the "(shortened)" note when it was cut, then an
 * empty line for the writer's question. With nothing to quote the composer is simply empty.
 */
export function askComposerText(context: string): string {
  if (context.trim() === '') return ''
  const { text, shortened } = cutAtBlock(context)
  const quoted = text.split('\n').map((line) => (line === '' ? '>' : `> ${line}`)).join('\n')
  return `${quoted}\n${shortened ? `\n${SHORTENED_NOTE}\n` : ''}\n`
}

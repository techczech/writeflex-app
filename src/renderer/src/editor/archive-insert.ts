import { isolateHistory } from '@codemirror/commands'
import type { EditorState, TransactionSpec } from '@codemirror/state'
import { frontmatterSafeInsertPosition } from '../../../shared/object-markup'
import { safeLabel, safeUrl } from './citation'

/**
 * Inserting an archive quote into the draft (WF-4B), as editor state → ONE transaction.
 *
 * The quote block is the scout CLI's own Markdown citation (`> quote`, a blank line, the `— …` line),
 * never re-formatted here; only when the writer widens the quote by a sentence (⇧↑/⇧↓) is the `> `
 * quote rebuilt around the CLI's unchanged citation line.
 *
 * Block boundaries (ADR-0039, a line is a block): the block never splits a line. On an empty line it
 * takes that line; otherwise it lands on its own lines after the caret's line. The caret ends on the
 * empty line after the block, ready to write. `isolateHistory` keeps the whole insert one undo step,
 * never merged with typing before or after it, so ⌘Z removes the quote and its citation together.
 */

/** The citation line (`— Author, *Title*, date · [archive](…) · [public](…)`) out of the CLI's Markdown. */
export function citationLineOf(citationMarkdown: string): string | null {
  const lines = citationMarkdown.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].startsWith('— ')) return lines[index]
  }
  return null
}

/** The block ⏎ inserts. With the CLI's own quote it is the CLI's Markdown verbatim; with a widened
 *  quote (original text, possibly several lines) each line is `> `-marked above the same citation line. */
export function archiveQuoteBlock(citationMarkdown: string, cliQuote: string, quote: string): string {
  const verbatim = citationMarkdown.replace(/\s+$/, '')
  if (quote === cliQuote) return verbatim
  const citation = citationLineOf(citationMarkdown)
  if (!citation) return verbatim
  const quoted = quote.split('\n').map((line) => `> ${line}`).join('\n')
  return `${quoted}\n\n${citation}`
}

/** ⌘⏎'s link: the piece's full title as text, pointing at the archive link when it is a WriteFlex
 *  link, else at the public URL (tweets, highlights), else at whatever link the CLI gave. */
export function archiveLinkMarkdown(result: { title: string; link: string; publicUrl: string | null }): string {
  const target = result.link.startsWith('writeflex:') ? result.link : result.publicUrl ?? result.link
  const label = result.title.trim() || 'Archive piece'
  return `[${safeLabel(label)}](${safeUrl(target)})`
}

/** The quote block's one transaction: own lines, caret on the empty line after it, one undo step. */
export function archiveQuoteInsert(state: EditorState, block: string): TransactionSpec {
  const text = block.replace(/\s+$/, '')
  const doc = state.doc
  const head = frontmatterSafeInsertPosition(doc.toString(), state.selection.main.head)
  const line = doc.lineAt(head)
  let from: number
  let to: number
  let insert: string
  let cursor: number
  if (line.text.trim() === '') {
    // An empty line becomes the block; the newline after it leaves the caret on a fresh empty line.
    from = line.from
    to = line.to
    insert = `${text}\n`
    cursor = from + insert.length
  } else {
    from = line.to
    to = line.to
    const next = line.number < doc.lines ? doc.line(line.number + 1) : null
    if (next && next.text.trim() === '') {
      // An empty line already follows the block: the caret lands on it rather than on a second one.
      insert = `\n${text}`
      cursor = from + insert.length + 1
    } else {
      insert = `\n${text}\n`
      cursor = from + insert.length
    }
  }
  return {
    changes: { from, to, insert },
    selection: { anchor: cursor },
    scrollIntoView: true,
    userEvent: 'input.paste',
    annotations: isolateHistory.of('full'),
  }
}

/** The link-only insert: replaces the selection (or lands at the caret), caret after the link. */
export function archiveLinkInsert(state: EditorState, link: string): TransactionSpec {
  const selection = state.selection.main
  const from = selection.empty ? frontmatterSafeInsertPosition(state.doc.toString(), selection.from) : selection.from
  const to = selection.empty ? from : selection.to
  return {
    changes: { from, to, insert: link },
    selection: { anchor: from + link.length },
    scrollIntoView: true,
    userEvent: 'input.paste',
    annotations: isolateHistory.of('full'),
  }
}

/** The inserted range of a quote transaction, for the applied-edit flash. */
export function insertedRange(spec: TransactionSpec): { from: number; to: number } | null {
  const changes = spec.changes as { from: number; insert: string } | undefined
  if (!changes) return null
  const leading = changes.insert.startsWith('\n') ? 1 : 0
  const body = changes.insert.replace(/^\n/, '').replace(/\n$/, '')
  return { from: changes.from + leading, to: changes.from + leading + body.length }
}

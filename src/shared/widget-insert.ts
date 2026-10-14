/**
 * Putting an embed line into a document, and taking one out (interactive-widgets-in-documents,
 * ticket 05). Pure: no DOM, no fs. The editor's Insert widget… command, the drop onto the text and
 * the agent verbs widgets.insert / widgets.remove all use these, so the line, the blank lines around
 * it and the refusal to split a paragraph or a code fence are decided in one place.
 *
 * Inserting writes ONE line into the text. It never touches the widget file.
 */
import { frontmatterSafeInsertPosition } from './object-markup'
import { scanWidgets } from './markdown/widgets'

/** `[Simulation: path]`, the one line that makes a widget. Paths cannot carry a line break. */
export function widgetEmbedLine(rawPath: string): string {
  if (/[\r\n\0]/.test(rawPath) || rawPath.trim() === '') throw new Error('A widget path must be one non-empty line.')
  return `[Simulation: ${rawPath.trim()}]`
}

/** The path as typed in the embed line: from the document's folder to the widget, `/` separators. Both paths are workspace-relative. */
export function relativeEmbedPath(documentPath: string, widgetPath: string): string {
  const from = documentPath.split('/').slice(0, -1)
  const to = widgetPath.split('/')
  let shared = 0
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared += 1
  return [...Array(from.length - shared).fill('..'), ...to.slice(shared)].join('/')
}

export type WidgetInsertPlan = { from: number; to: number; insert: string; /** Where the embed line starts after the change. */ caret: number }

type Line = { from: number; to: number; text: string }
function linesOf(doc: string): Line[] {
  const lines: Line[] = []
  let from = 0
  for (;;) {
    const end = doc.indexOf('\n', from)
    const to = end < 0 ? doc.length : end
    lines.push({ from, to, text: doc.slice(from, to) })
    if (end < 0) break
    from = end + 1
  }
  return lines
}

/** The end of the code fence `position` is inside, or null when it is not inside one. */
function fenceEndAround(lines: Line[], position: number): number | null {
  let open: { marker: string; length: number } | null = null
  for (const line of lines) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line.text)
    if (open) {
      if (fence && fence[1][0] === open.marker && fence[1].length >= open.length && line.text.trim() === fence[1]) {
        if (position <= line.to) return line.to
        open = null
      }
    } else if (fence) {
      open = { marker: fence[1][0], length: fence[1].length }
      if (position < line.from) return null
    }
    if (!open && line.from > position) return null
  }
  return open ? lines[lines.length - 1].to : null
}

/**
 * Where and how `embed` goes into `doc` for a caret at `position`. The line lands on its own line with a
 * blank line either side (none at the very start or end). A caret in the middle of a paragraph does not
 * split it: the line goes after the paragraph. A caret inside a code fence goes after the fence; one in
 * frontmatter goes after it. `snap: 'none'` puts the line exactly at `position` (agent verbs name an
 * exact place).
 */
export function planWidgetInsert(doc: string, position: number, embed: string, options: { snap?: 'paragraph' | 'none' } = {}): WidgetInsertPlan {
  let at = frontmatterSafeInsertPosition(doc, Math.max(0, Math.min(position, doc.length)))
  if (options.snap !== 'none') {
    const lines = linesOf(doc)
    const fenceEnd = fenceEndAround(lines, at)
    if (fenceEnd !== null) at = fenceEnd
    else {
      const here = lines.find((line) => at >= line.from && at <= line.to)!
      const blank = here.text.trim() === ''
      if (!blank && at > here.from) {
        // Mid-paragraph or at a line's end: after the paragraph's last line.
        let index = lines.indexOf(here)
        while (index + 1 < lines.length && lines[index + 1].text.trim() !== '') index += 1
        at = lines[index].to
      } else if (!blank) {
        // At the start of a paragraph's first line it goes before it; mid-paragraph at a line start goes after the paragraph.
        const index = lines.indexOf(here)
        if (index > 0 && lines[index - 1].text.trim() !== '') {
          let last = index
          while (last + 1 < lines.length && lines[last + 1].text.trim() !== '') last += 1
          at = lines[last].to
        }
      }
    }
  }
  const before = doc.slice(0, at)
  const after = doc.slice(at)
  const prefix = before === '' ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
  let suffix: string
  if (after === '') suffix = doc.endsWith('\n') ? '\n' : ''
  else if (after.startsWith('\n\n')) suffix = ''
  else if (after.startsWith('\n')) suffix = after.slice(1).trim() === '' ? '' : '\n'
  else suffix = '\n\n'
  return { from: at, to: at, insert: `${prefix}${embed}${suffix}`, caret: at + prefix.length }
}

/** Apply a plan to a text. */
export const applyWidgetPlan = (doc: string, plan: WidgetInsertPlan): string => doc.slice(0, plan.from) + plan.insert + doc.slice(plan.to)

/**
 * widgets.insert: the document text with the embed line added at `position`: 'start' (after any
 * frontmatter), 'end', or a widget's 1-based ordinal (directly after that widget's line). The result
 * is checked: it must hold exactly one more widget than before, or this throws.
 */
export function insertWidgetInText(doc: string, rawPath: string, position: 'start' | 'end' | number): string {
  const embed = widgetEmbedLine(rawPath)
  const before = scanWidgets(doc)
  let plan: WidgetInsertPlan
  if (position === 'start') plan = planWidgetInsert(doc, 0, embed)
  else if (position === 'end') plan = planWidgetInsert(doc, doc.length, embed)
  else {
    const line = widgetLines(doc)[position - 1]
    if (!line) throw new Error(`There is no widget ${position} in this document; it has ${before.length}.`)
    plan = planWidgetInsert(doc, line.to, embed, { snap: 'none' })
  }
  const next = applyWidgetPlan(doc, plan)
  if (scanWidgets(next).length !== before.length + 1) throw new Error('The line could not be inserted as a widget at that place (is it inside a code block?).')
  return next
}

/** The raw line of each widget, in ordinal order, found by matching the model's widgets against the text's lines. */
function widgetLines(doc: string): Line[] {
  const widgets = scanWidgets(doc)
  const lines = linesOf(doc)
  const found: Line[] = []
  let cursor = 0
  for (const widget of widgets) {
    // A line that reads the same inside a code block is skipped by checking the model agrees afterwards.
    let matched: Line | null = null
    for (let i = cursor; i < lines.length; i += 1) {
      if (lines[i].text.trim() !== widget.source) continue
      const without = doc.slice(0, lines[i].from) + doc.slice(lines[i].to)
      if (scanWidgets(without).length === widgets.length - 1) { matched = lines[i]; cursor = i + 1; break }
    }
    if (!matched) throw new Error('A widget line could not be located in the text.')
    found.push(matched)
  }
  return found
}

/** widgets.remove: the document without widget `ordinal`'s line (and the blank line that separated it). */
export function removeWidgetInText(doc: string, ordinal: number): string {
  const widgets = scanWidgets(doc)
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > widgets.length) throw new Error(`There is no widget ${ordinal} in this document; it has ${widgets.length}.`)
  const line = widgetLines(doc)[ordinal - 1]
  let from = line.from
  let to = line.to
  if (doc[to] === '\n') to += 1
  // Take one separating blank line with it so no double gap is left.
  if (doc.slice(0, from).endsWith('\n\n') && (to >= doc.length || doc[to] === '\n')) from -= 1
  else if (from === 0 && doc[to] === '\n') to += 1
  const next = doc.slice(0, from) + doc.slice(to)
  if (scanWidgets(next).length !== widgets.length - 1) throw new Error('The widget line could not be removed cleanly.')
  return next
}

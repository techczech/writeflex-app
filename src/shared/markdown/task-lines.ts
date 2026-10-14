import { parseMarkdown } from './dialect'
import { LIST_MARKER_SOURCE } from './fancy-lists'
import { frontmatterBlock } from './frontmatter'

/**
 * The task items of a Markdown file, by LINE — the one reading the Agent notes pane, the
 * `tasks.list` / `tasks.toggle` agent verbs and the pane's tick write share
 * (docs/design/2026-09-27-checkbox-lists, hifi-direction-1 frame 10).
 *
 * A task item is what the dialect's own parser calls one (GFM `Task` inside a real `ListItem`), so a
 * `- [ ]` inside a code fence or in frontmatter is text, exactly as the editor (task-items.ts) and
 * every exporter read it. Any list marker counts: `- [ ]`, `1. [ ]`, `a) [x]`.
 *
 * Lines are 1-based and counted in the text given, frontmatter included, so a line named here is a
 * line of the file on disk. A tick is ONE character, space ↔ `x` (ADR-0039: the rest of the line is
 * never rewritten).
 */
export type TaskLine = {
  /** 1-based line of the text the item's box sits on. */
  line: number
  /** Offset of the one character a tick rewrites (inside the brackets). */
  tick: number
  /** Offset of the `[`. */
  from: number
  checked: boolean
  /** The item's words on the box's line, after the box. */
  text: string
}

/** Blank the frontmatter block to spaces, keeping its newlines, so offsets and lines stay the file's. */
function withoutFrontmatter(text: string): string {
  const block = frontmatterBlock(text)
  if (!block) return text
  return text.slice(0, block.end).replace(/[^\n]/g, ' ') + text.slice(block.end)
}

/** Every task item of `text`, in document order. */
export function readTaskLines(text: string): TaskLine[] {
  const source = withoutFrontmatter(text ?? '')
  const items: TaskLine[] = []
  const lineStarts = [0]
  for (let at = source.indexOf('\n'); at !== -1; at = source.indexOf('\n', at + 1)) lineStarts.push(at + 1)
  const lineOf = (pos: number): number => {
    let low = 0
    let high = lineStarts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (lineStarts[mid] <= pos) low = mid
      else high = mid - 1
    }
    return low + 1
  }
  const cursor = parseMarkdown(source).cursor()
  do {
    if (cursor.name !== 'Task') continue
    const task = cursor.node
    if (task.parent?.name !== 'ListItem') continue
    const marker = task.getChild('TaskMarker')
    if (!marker || marker.to - marker.from !== 3) continue
    const tick = marker.from + 1
    const line = lineOf(marker.from)
    const lineEnd = line < lineStarts.length ? lineStarts[line] - 1 : source.length
    items.push({
      line,
      tick,
      from: marker.from,
      checked: source[tick] !== ' ',
      text: source.slice(marker.to, Math.min(task.to, lineEnd)).trim(),
    })
  } while (cursor.next())
  return items
}

export type TaskCounts = { open: number; done: number; total: number }

export function countTaskLines(items: TaskLine[]): TaskCounts {
  const done = items.filter((item) => item.checked).length
  return { open: items.length - done, done, total: items.length }
}

/**
 * Tick or untick the box on `line`: the text with exactly one character changed. `expected` is the
 * state the caller saw; when the box no longer stands that way (the file changed under a stale view)
 * nothing is written and the refusal says so.
 */
export function toggleTaskLine(text: string, line: number, expected?: boolean): { text: string; item: TaskLine; checked: boolean } {
  const item = readTaskLines(text).find((candidate) => candidate.line === line)
  if (!item) throw new Error(`Line ${line} has no checkbox.`)
  if (expected !== undefined && item.checked !== expected) {
    throw new Error(`The box on line ${line} is already ${item.checked ? 'ticked' : 'unticked'}; nothing was changed.`)
  }
  const checked = !item.checked
  return { text: text.slice(0, item.tick) + (checked ? 'x' : ' ') + text.slice(item.tick + 1), item, checked }
}

/**
 * What a file's boxes add up to — the one summary the Files tree, Quick Open and the Board card
 * share (docs/design/2026-09-27-checkbox-lists, hifi-direction-1 frames 7–9), and the editor's test
 * for sinking done items.
 *
 * A **checklist note** is a note that is mostly boxes: at least CHECKLIST_NOTE_MIN_BOXES box lines,
 * and more box lines than prose lines. A prose line is any other non-blank line of the body:
 * frontmatter, blank lines and headings (a note's title is not prose) do not count; a plain list
 * item, a paragraph line or a line of code does.
 */
export type TaskSummary = { open: number; done: number; isChecklistNote: boolean }

export const CHECKLIST_NOTE_MIN_BOXES = 3

export const NO_TASKS: TaskSummary = Object.freeze({ open: 0, done: 0, isChecklistNote: false }) as TaskSummary

// A line that could hold a box (any list marker, inside a quote too). Only a cheap gate: a file with
// no such line has no boxes and is never parsed; the parser still decides which candidates are real.
const CANDIDATE_BOX_LINE = new RegExp(`^[ \\t>]*(?:${LIST_MARKER_SOURCE})[ \\t]+\\[[ xX]\\]`, 'm')
const CANDIDATE_BOX_LINES = new RegExp(CANDIDATE_BOX_LINE.source, 'gm')
const HEADING_LINE = /^ {0,3}#{1,6}(?:[ \t]|$)/

/**
 * A cheap gate for the checklist-note rule that never parses: false only when `text` cannot be a
 * checklist note (every real box line is a candidate line, so the candidates bound the boxes from
 * above and the prose from below). The editor asks it on every edit before paying for the parse.
 */
export function mayBeChecklistNote(text: string): boolean {
  const candidates = (text ?? '').match(CANDIDATE_BOX_LINES)?.length ?? 0
  if (candidates < CHECKLIST_NOTE_MIN_BOXES) return false
  let otherLines = 0
  for (const line of withoutFrontmatter(text).split('\n')) {
    if (line.trim() !== '' && !HEADING_LINE.test(line)) otherLines += 1
  }
  return candidates > otherLines - candidates
}

export function summariseTasks(text: string): TaskSummary {
  const source = text ?? ''
  if (!CANDIDATE_BOX_LINE.test(source)) return NO_TASKS
  const items = readTaskLines(source)
  if (items.length === 0) return NO_TASKS
  const { open, done } = countTaskLines(items)
  const boxLines = new Set(items.map((item) => item.line))
  let prose = 0
  withoutFrontmatter(source).split('\n').forEach((line, index) => {
    if (boxLines.has(index + 1) || line.trim() === '' || HEADING_LINE.test(line)) return
    prose += 1
  })
  return { open, done, isChecklistNote: boxLines.size >= CHECKLIST_NOTE_MIN_BOXES && boxLines.size > prose }
}

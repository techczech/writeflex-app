// Keeps the Example collection's lesson files honest (ADR-0043, ticket 09). A lesson teaches the
// commands of one chapter, and the chapter's rows come from `deriveChapters` (the function the Guide
// lists and counts from), so nothing here is typed per lesson.
//
// How a lesson names a command:
//   - by its effective default chord as a key cap, `<kbd>⌘8</kbd>` (the first chord when it has several);
//   - by its palette name in bold, `**Strikethrough**`, when it has no key;
//   - or, where ⌘K lists it, by the label the Actions here menu gives it (`**UPPER CASE**`): a lesson that sends the
//     writer to ⌘K names the row the writer will see.

// A lesson is a run of quotations. The quotation that opens a sub-group starts with the sub-group's
// name in bold and a full stop (`> **Fold.** …`); the sub-groups come in the chapter's order, and a
// command counts as covered only when it is named in its own sub-group's part of the file.
//
// A row of one command or a pair (up / down) is covered when every command in it is named. A row of
// variants (the six highlight colours) is covered when at least one variant is named, which is also
// when the Guide ticks it.
//
// Nothing may be named that does not exist: every key cap must be a chord some built command or key
// answers to, and every bold phrase in a quotation must be a lead-in (the first bold phrase of its
// quotation, ending in a full stop), a built command's name, the name of a lesson file (the ten chapters,
// the welcome and `11 Objects`), or words that
// stand in the file's own text (the heading or line the instruction points at).
import { EXAMPLE_OBJECTS_FILE } from '../../../shared/example-files'
import { effectiveChords } from './chords'
import { TASK_GROUPS } from './command-task-groups'
import { lessonFileFor, type Chapter, type ChapterCommand } from './guide-chapters'
import { MENU_LABELS, menuLabelsOf } from './actions-layout'
import { commandRegistry, type Command } from './registry'

/** A command the lesson should name and does not: `expects` is the exact text that would name it. */
export type LessonGap = { subgroup: string; row: string; id: string; expects: string }

export type LessonCheck = {
  /** Rows of the chapter. */
  total: number
  /** Rows whose commands the lesson names in the right sub-group. */
  covered: number
  missing: LessonGap[]
  /** Sub-groups with no opening quotation, or opened out of the chapter's order. */
  subgroupProblems: string[]
  /** Key caps that no built command or key answers to. */
  unknownKeys: string[]
  /** Bold phrases in quotations that are none of: a lead-in, a command name, a file name, the file's own words. */
  unknownNames: string[]
}

const built = (commands: readonly ChapterCommand[]): ChapterCommand[] => commands.filter((command) => !command.future)

/** The exact text a lesson uses to name a command: a key cap of its first effective default chord, else its name in bold. */
export function lessonMention(command: ChapterCommand): string {
  const [chord] = effectiveChords(command as Command, {})
  return chord ? `<kbd>${chord}</kbd>` : `**${command.label}**`
}

/** The contents of every key cap in a lesson, in order. */
export const keyCapsIn = (text: string): string[] => [...text.matchAll(/<kbd>(.*?)<\/kbd>/g)].map((match) => match[1]!)

type Quotation = { text: string; start: number }

/** The quotations of a file: each run of lines starting with `>`, with where it begins. */
function quotationsIn(text: string): Quotation[] {
  const out: Quotation[] = []
  let offset = 0
  let open: Quotation | null = null
  for (const line of text.split('\n')) {
    if (line.startsWith('>')) {
      if (open) open.text += `\n${line}`
      else out.push((open = { text: line, start: offset }))
    } else open = null
    offset += line.length + 1
  }
  return out
}

const boldIn = (text: string): string[] => [...text.matchAll(/\*\*(.+?)\*\*/g)].map((match) => match[1]!)
const leadInOf = (quotation: Quotation): string | null => /^>\s*\*\*(.+?\.)\*\*/.exec(quotation.text)?.[1] ?? null

/** Check any Example collection file for names of things that do not exist. */
export function unknownIn(text: string, commands: readonly ChapterCommand[] = commandRegistry): Pick<LessonCheck, 'unknownKeys' | 'unknownNames'> {
  const real = built(commands)
  const chords = new Set(real.flatMap((command) => effectiveChords(command as Command, {})))
  const labels = new Set([...real.map((command) => command.label), ...MENU_LABELS])
  const files = new Set(['00 Start here', EXAMPLE_OBJECTS_FILE.replace(/\.md$/, ''), ...TASK_GROUPS.map((task) => lessonFileFor(task).replace(/\.md$/, ''))])
  const ownWords = text.split('\n').filter((line) => !line.startsWith('>')).join('\n')
  const unknownNames: string[] = []
  for (const quotation of quotationsIn(text)) {
    const leadIn = leadInOf(quotation)
    for (const phrase of boldIn(quotation.text)) {
      if (phrase === leadIn || labels.has(phrase) || files.has(phrase) || ownWords.includes(phrase)) continue
      if (!unknownNames.includes(phrase)) unknownNames.push(phrase)
    }
  }
  const unknownKeys = [...new Set(keyCapsIn(text).filter((chord) => !chords.has(chord)))]
  return { unknownKeys, unknownNames }
}

/** Check one chapter's lesson file against the chapter the Guide derives. */
export function checkLesson(chapter: Chapter, text: string, commands: readonly ChapterCommand[] = commandRegistry): LessonCheck {
  const byId = new Map(commands.map((command) => [command.id, command]))
  const quotations = quotationsIn(text)
  // Where each sub-group's part of the file begins: its opening quotation, up to the next sub-group's.
  const opens = chapter.subgroups.map((group) => quotations.find((quotation) => leadInOf(quotation) === `${group.name}.`)?.start ?? -1)
  const subgroupProblems: string[] = []
  chapter.subgroups.forEach((group, index) => {
    if (opens[index]! < 0) subgroupProblems.push(`${group.name}: no quotation opens with **${group.name}.**`)
    else if (index > 0 && opens[index]! < Math.max(...opens.slice(0, index))) subgroupProblems.push(`${group.name}: opens before an earlier sub-group`)
  })
  const missing: LessonGap[] = []
  let covered = 0
  chapter.subgroups.forEach((group, index) => {
    const from = opens[index]!
    const later = opens.filter((start) => start > from)
    const part = from < 0 ? '' : text.slice(from, later.length ? Math.min(...later) : text.length)
    for (const row of group.rows) {
      const members = row.ids.map((id) => byId.get(id)).filter((command): command is ChapterCommand => Boolean(command))
      const unnamed = members.filter((command) => !part.includes(lessonMention(command)) && !menuLabelsOf(command.id).some((label) => part.includes(`**${label}**`)))
      const rowCovered = row.merged === 'variants' ? unnamed.length < members.length : unnamed.length === 0
      if (rowCovered) covered += 1
      else for (const command of unnamed) missing.push({ subgroup: group.name, row: row.label, id: command.id, expects: lessonMention(command) })
    }
  })
  return { total: chapter.rows.length, covered, missing, subgroupProblems, ...unknownIn(text, commands) }
}

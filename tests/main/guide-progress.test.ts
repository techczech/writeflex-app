import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  chapterHistory, chapterHistoryText, emptyGuideProgress, guideDate, parseGuideProgress, serialiseGuideProgress,
  withChapterFinished, withChapterOpened, withCommandRan, withStepDone, withTopicRead,
} from '../../src/shared/guide-progress'
import {
  chapterFor, chapterOfLessonFile, deriveChapters, lessonFileFor, MERGED_ROWS, nextUntried, rowChords, rowTried, triedCount, type ChapterCommand,
} from '../../src/renderer/src/commands/guide-chapters'
import { TASK_GROUPS } from '../../src/renderer/src/commands/command-task-groups'
import { commandRegistry } from '../../src/renderer/src/commands/registry'

const fake = (id: string, task: ChapterCommand['task'], subgroup: string, extra: Partial<ChapterCommand> = {}): ChapterCommand =>
  ({ id, label: id.toUpperCase(), task, subgroup, ...extra }) as ChapterCommand

// ── events in ──────────────────────────────────────────────────────────────

test('a command is ticked the first time it runs, once, and the record survives a save and a read', () => {
  const first = withCommandRan(emptyGuideProgress(), 'fold.current')
  expect(first.ran).toEqual(['fold.current'])
  expect(withCommandRan(first, 'fold.current')).toBe(first)
  const again = parseGuideProgress(serialiseGuideProgress(withCommandRan(first, 'fold.all')))
  expect(again.ran).toEqual(['fold.current', 'fold.all'])
})

test('bad events change nothing: empty, non-string and over-long ids, unknown chapters', () => {
  const start = emptyGuideProgress()
  expect(withCommandRan(start, '')).toBe(start)
  expect(withCommandRan(start, 42)).toBe(start)
  expect(withCommandRan(start, 'x'.repeat(101))).toBe(start)
  expect(withChapterOpened(start, 'Not a chapter')).toBe(start)
  expect(withChapterFinished(start, 'Not a chapter', 1)).toBe(start)
})

test('a chapter opens once; its finish date is the first one and is kept', () => {
  const opened = withChapterOpened(emptyGuideProgress(), 'Listen')
  expect(withChapterOpened(opened, 'Listen')).toBe(opened)
  const done = withChapterFinished(opened, 'Listen', 1000)
  expect(withChapterFinished(done, 'Listen', 2000)).toBe(done)
  expect(done.finished).toEqual({ Listen: 1000 })
})

test('the three steps tick once and keep the first detail', () => {
  let progress = withStepDone(emptyGuideProgress(), 'folder', 'walking-book')
  progress = withStepDone(progress, 'folder', 'other')
  progress = withStepDone(progress, 'file', 'Chapter 1.md')
  progress = withStepDone(progress, 'example')
  expect(progress.steps).toEqual({ folder: 'walking-book', file: 'Chapter 1.md', example: true })
  expect(withStepDone(emptyGuideProgress(), 'folder')).toEqual(emptyGuideProgress())
})

test('a stored value that is damaged reads as empty; stray fields and bad entries are dropped', () => {
  expect(parseGuideProgress(null)).toEqual(emptyGuideProgress())
  expect(parseGuideProgress('{not json')).toEqual(emptyGuideProgress())
  expect(parseGuideProgress('[1]')).toEqual(emptyGuideProgress())
  const read = parseGuideProgress(JSON.stringify({ ran: ['a', 3, '', 'a'], opened: ['Write', 'Nope'], finished: { Write: 5, Nope: 6, Listen: 'x' }, steps: { folder: 'f', file: 9, example: 1 } }))
  expect(read).toEqual({ ran: ['a'], opened: ['Write'], finished: { Write: 5 }, steps: { folder: 'f' }, read: [] })
})

// ── states out ─────────────────────────────────────────────────────────────

test('the four histories, from real data', () => {
  const none = emptyGuideProgress()
  expect(chapterHistoryText(chapterHistory(none, 'Write', 0, 10))).toBe('Not opened')
  expect(chapterHistoryText(chapterHistory(withChapterOpened(none, 'Write'), 'Write', 0, 10))).toBe('Opened')
  expect(chapterHistoryText(chapterHistory(none, 'Write', 6, 25))).toBe('6 of 25 tried')
  const at = new Date(2026, 9, 6, 12).getTime()
  expect(chapterHistoryText(chapterHistory(withChapterFinished(none, 'Write', at), 'Write', 25, 25))).toBe('Finished 6 Oct')
  expect(guideDate(new Date(2026, 0, 1).getTime())).toBe('1 Jan')
})

// ── derivation: pairs, variants and commands the build does not have ───────

test('a two-key pair is one row with two ids, counted once and ticked by either key', () => {
  const commands = [
    fake('a.up', 'Write', 'S'), fake('a.down', 'Write', 'S'), fake('a.other', 'Write', 'S'),
  ]
  const chapter = chapterFor(deriveChapters(commands, [{ label: 'Up / down', kind: 'pair', ids: ['a.up', 'a.down'] }]), 'Write')!
  expect(chapter.rows.map((row) => [row.label, row.ids])).toEqual([['Up / down', ['a.up', 'a.down']], ['A.OTHER', ['a.other']]])
  expect(triedCount(chapter, new Set())).toBe(0)
  expect(triedCount(chapter, new Set(['a.down']))).toBe(1)
  expect(triedCount(chapter, new Set(['a.up', 'a.down']))).toBe(1)
  expect(rowTried(chapter.rows[0], new Set(['a.up']))).toBe(true)
})

test('a merged row never counts a command the build does not have; a set with one member left is a plain row', () => {
  const commands = [fake('a.up', 'Write', 'S')]
  const chapter = chapterFor(deriveChapters(commands, [{ label: 'Up / down', kind: 'pair', ids: ['a.up', 'a.down'] }]), 'Write')!
  expect(chapter.rows).toHaveLength(1)
  expect(chapter.rows[0]).toMatchObject({ label: 'A.UP', ids: ['a.up'], merged: null })
})

test('mirror rows, key-only rows and not-built commands are left out', () => {
  const commands = [
    fake('real', 'Write', 'S'),
    fake('sheet.x.0', 'Write', 'S', { sheetSource: { kind: 'command', commandId: 'real' } }),
    fake('sheet.x.1', 'Write', 'S', { sheetSource: { kind: 'literal' } }),
    fake('later', 'Write', 'S', { future: 'build' }),
  ]
  expect(chapterFor(deriveChapters(commands, []), 'Write')!.rows.map((row) => row.id)).toEqual(['real'])
})

test('sub-groups follow the drawn order where there is one, else the order the commands name them', () => {
  const commands = [fake('j', 'Shape the document', 'Jump between headings'), fake('f', 'Shape the document', 'Fold'), fake('z', 'Write', 'Zed'), fake('y', 'Write', 'Why')]
  const chapters = deriveChapters(commands, [])
  expect(chapterFor(chapters, 'Shape the document')!.subgroups.map((group) => group.name)).toEqual(['Fold', 'Jump between headings'])
  expect(chapterFor(chapters, 'Write')!.subgroups.map((group) => group.name)).toEqual(['Zed', 'Why'])
})

test('variants are one row naming the variants and showing no chord; a pair shows both chords', () => {
  const chapters = deriveChapters()
  const listen = chapterFor(chapters, 'Listen')!
  const colours = listen.rows.find((row) => row.ids.includes('readAloudHighlight.amber'))!
  expect(colours.merged).toBe('variants')
  expect(colours.ids).toHaveLength(6)
  expect(rowChords(colours, {})).toEqual([])
  const faster = listen.rows.find((row) => row.ids.includes('readAloud.faster'))!
  expect(rowChords(faster, {})).toEqual(['⌃⌥.', '⌃⌥,'])
  expect(rowChords(faster, { 'readAloud.faster': '⌘9' })).toEqual(['⌘9', '⌃⌥,'])
})

test('the next row to try is the first not yet ticked', () => {
  const shape = chapterFor(deriveChapters(), 'Shape the document')!
  expect(nextUntried(shape, new Set())!.id).toBe(shape.rows[0].id)
  expect(nextUntried(shape, new Set(shape.rows.flatMap((row) => row.ids)))).toBeNull()
})

// ── the real registry ──────────────────────────────────────────────────────

test('every id in the merge table is a registry command in one task group, and no id is in two sets', () => {
  const ids = new Map(commandRegistry.map((command) => [command.id, command]))
  const seen = new Set<string>()
  for (const set of MERGED_ROWS) {
    expect(set.ids.length, set.label).toBeGreaterThan(1)
    const tasks = new Set(set.ids.map((id) => ids.get(id)?.task))
    expect(ids.has(set.ids[0]), `${set.label} first id`).toBe(true)
    for (const id of set.ids) {
      expect(ids.has(id), `${id} exists`).toBe(true)
      expect(seen.has(id), `${id} is in two sets`).toBe(false)
      seen.add(id)
    }
    expect(tasks.size, `${set.label} spans one task`).toBe(1)
  }
})

test('each chapter lists exactly the registry rows that count, and every row has a command that exists', () => {
  const chapters = deriveChapters()
  expect(chapters.map((chapter) => chapter.task)).toEqual([...TASK_GROUPS])
  const ids = new Set(commandRegistry.map((command) => command.id))
  for (const chapter of chapters) {
    expect(chapter.rows.length, chapter.task).toBeGreaterThan(0)
    expect(chapter.subgroups.flatMap((group) => group.rows)).toEqual(chapter.rows)
    for (const row of chapter.rows) for (const id of row.ids) expect(ids.has(id), id).toBe(true)
    const all = chapter.rows.flatMap((row) => row.ids)
    expect(new Set(all).size, `${chapter.task} lists a command twice`).toBe(all.length)
  }
})

test('the derived rows of each chapter, as built (counts are the build\'s, not the drawing\'s 25)', () => {
  const chapters = deriveChapters()
  const listed = Object.fromEntries(chapters.map((chapter) => [chapter.task, chapter.subgroups.map((group) => ({ subgroup: group.name, rows: group.rows.map((row) => `${row.label}${row.merged ? ` [${row.merged}: ${row.ids.join(', ')}]` : ''}`) }))]))
  expect(listed).toEqual(JSON.parse(readFileSync(new URL('../fixtures/guide-chapter-rows.json', import.meta.url), 'utf8')))
  expect(Object.fromEntries(chapters.map((chapter) => [chapter.task, chapter.rows.length]))).toEqual({
    'Write': 60,
    'Shape the document': 28,
    'Stay focused': 20,
    'Listen': 9,
    'Review and versions': 25, // +2 Accept all / Decline all from one agent (2026-10-27)
    'Find and manage files': 33,
    'Collect and plan': 104, // +4 sheet-only Folio workspace keys (2026-10-25); +19 option A collection page commands (2026-10-21); +2 the Folio workspace's Files tab and inspector (2026-10-24).
    // // +1 Capture to research;  +5 Folio page redesign (0.26: the agent pill's three writes, Choose a file as front matter, Show or hide the files not in the outline); then 58: 41 at the fork; +5 title-conflict buttons, +1 Open Folio (next/0.25.1); +1 Add existing part to Folio outline as front matter (ADR-0046); +1 Go to the Details (0.26 ticket 4); +9 Folio outline keys (0.26 ticket 7: Open Folio at another part, Choose the role of a part, Open the file, six Details rows)
    'Work with the agent': 28, // +10 Scratchpad commands (2026-10-28, ADR-0050); fixture completed at the 2026-10-29 installed-base merge
    'Share and export': 15,
    'Set up WriteFlex': 17,
  })
  expect(chapterFor(chapters, 'Shape the document')!.subgroups.map((group) => [group.name, group.rows.map((row) => row.label)])).toEqual([
    ['Fold', ['Fold Current Heading', 'Fold All Headings', 'Unfold All']],
    ['Move blocks and sections', ['Move this block up / down', 'Move this with everything under it up / down', 'Delete this section', 'Select this section']],
    ['Headings and levels', [
      'Raise / lower the level of this line', 'Raise / lower the level with everything under it', 'New heading before this section', 'New subheading under this section',
      'Make this line a heading at the surrounding level', 'Make this line a heading one level deeper',
      'Insert heading, level 1', 'Insert heading, level 2', 'Insert heading, level 3', 'Insert heading, level 4', 'Insert heading, level 5', 'Insert heading, level 6',
    ]],
    ['Jump between headings', [
      'Next / previous block', 'Outline: Open the menu for this row', 'Outline: Expand all', 'Outline: Collapse all',
      'Outline: show levels 1 to 1 … 1 to 6', 'Outline: Show all levels', 'Outline: Show / hide word counts', 'Previous / next heading', 'Open Outline',
    ]],
  ])
})

test('lesson files map to chapters by name; the welcome file is no chapter', () => {
  expect(lessonFileFor('Write')).toBe('01 Write.md')
  expect(lessonFileFor('Set up WriteFlex')).toBe('10 Set up WriteFlex.md')
  expect(chapterOfLessonFile('02 Shape the document.md')).toBe('Shape the document')
  expect(chapterOfLessonFile('00 Start here.md')).toBeNull()
  expect(chapterOfLessonFile('notes.md')).toBeNull()
})

// ── topics read (ticket 08) ────────────────────────────────────────────────

test('a topic is read once; unknown or non-string ids change nothing; the record survives a save and a read', () => {
  const start = emptyGuideProgress()
  expect(start.read).toEqual([])
  const one = withTopicRead(start, 'feature.2')
  expect(one.read).toEqual(['feature.2'])
  expect(withTopicRead(one, 'feature.2')).toBe(one)
  expect(withTopicRead(start, 'how.99')).toBe(start)
  expect(withTopicRead(start, 3)).toBe(start)
  const again = parseGuideProgress(serialiseGuideProgress(withTopicRead(one, 'how.3')))
  expect(again.read).toEqual(['feature.2', 'how.3'])
})

test('a record saved before topics existed reads with nothing read; stored junk is dropped', () => {
  expect(parseGuideProgress(JSON.stringify({ ran: [], opened: [], finished: {}, steps: {} })).read).toEqual([])
  expect(parseGuideProgress(JSON.stringify({ read: ['how.1', 'how.1', 'nope', 7, 'feature.11'] })).read).toEqual(['how.1', 'feature.11'])
})

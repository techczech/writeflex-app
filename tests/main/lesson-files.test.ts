import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deriveChapters, lessonFileFor, type ChapterCommand } from '../../src/renderer/src/commands/guide-chapters'
import { checkLesson, keyCapsIn, lessonMention, unknownIn } from '../../src/renderer/src/commands/lesson-coverage'
import { MENU_LABELS, menuLabelsOf } from '../../src/renderer/src/commands/actions-layout'
import { commandRegistry } from '../../src/renderer/src/commands/registry'
import { ALL_TOPICS } from '../../src/shared/guide-topics'
import { INSERT_OBJECT_IDS } from '../../src/renderer/src/commands/actions-here'
import { EXAMPLE_OBJECTS_FILE } from '../../src/shared/example-files'

// Onboarding ticket 09 (ADR-0043): the Example collection's lesson files stay honest as commands
// change. The chapters come from `deriveChapters`, the function the Guide lists and counts from; the
// rules for how a lesson names a command are in src/renderer/src/commands/lesson-coverage.ts.

const BUNDLE = resolve(import.meta.dir, '../../resources/example-collection')
const lesson = (name: string): string => readFileSync(join(BUNDLE, name), 'utf8')
const chapters = deriveChapters()

for (const chapter of chapters) {
  const file = lessonFileFor(chapter.task)
  test(`${file} names every command its chapter counts, in sub-group order, and nothing that does not exist`, () => {
    const check = checkLesson(chapter, lesson(file))
    expect(check.subgroupProblems).toEqual([])
    expect(check.missing.map((gap) => `${gap.subgroup} · ${gap.row} · ${gap.id} needs ${gap.expects}`)).toEqual([])
    expect(check.unknownKeys).toEqual([])
    expect(check.unknownNames).toEqual([])
    expect(check.covered).toBe(check.total)
    expect(check.total).toBe(chapter.rows.length)
  })
}

test('00 Start here.md names no key or command that does not exist, and links the ten lesson files in order', () => {
  const text = lesson('00 Start here.md')
  expect(unknownIn(text)).toEqual({ unknownKeys: [], unknownNames: [] })
  expect([...text.matchAll(/^- \[\[(.+?)\]\]: \S/gm)].map((match) => `${match[1]}.md`)).toEqual(chapters.map((chapter) => lessonFileFor(chapter.task)))
})

test('a command added to a task group without a lesson line fails the check, naming the line to write', () => {
  const shape = chapters.find((chapter) => chapter.task === 'Shape the document')!
  const added: ChapterCommand = { id: 'fold.invented', label: 'Fold everything but this', task: 'Shape the document', subgroup: 'Fold', keys: undefined }
  const keyed: ChapterCommand = { id: 'fold.inventedKey', label: 'Fold the rest', task: 'Shape the document', subgroup: 'Fold', keys: 'Ctrl-Alt-Shift-F9' }
  const commands = [...commandRegistry, added, keyed]
  const withAdded = deriveChapters(commands).find((chapter) => chapter.task === 'Shape the document')!
  expect(withAdded.rows.length).toBe(shape.rows.length + 2)
  const check = checkLesson(withAdded, lesson(lessonFileFor('Shape the document')), commands)
  expect(check.covered).toBe(check.total - 2)
  expect(check.missing).toEqual([
    { subgroup: 'Fold', row: 'Fold everything but this', id: 'fold.invented', expects: '**Fold everything but this**' },
    { subgroup: 'Fold', row: 'Fold the rest', id: 'fold.inventedKey', expects: lessonMention(keyed) },
  ])
  expect(lessonMention(keyed)).toMatch(/^<kbd>.+<\/kbd>$/)
})

test('a command named in the wrong sub-group, a key nothing answers to, and a made-up command name are all reported', () => {
  const shape = chapters.find((chapter) => chapter.task === 'Shape the document')!
  const text = lesson(lessonFileFor('Shape the document'))
  // Fold's key cap moved out of the Fold part of the file.
  const moved = `${text.replace('<kbd>⌘8</kbd>', 'the fold key')}\n> **A late note.** <kbd>⌘8</kbd> folds.\n`
  expect(checkLesson(shape, moved).missing.map((gap) => gap.id)).toEqual(['fold.current'])
  // A sub-group whose opening quotation is gone.
  expect(checkLesson(shape, text.replace('**Fold.**', '**Folding.**')).subgroupProblems).toEqual(['Fold: no quotation opens with **Fold.**'])
  const invented = `${text}\n> **More.** Press <kbd>⌃⌥⇧⌘F19</kbd>, or choose **Tidy the whole essay**.\n`
  expect(unknownIn(invented)).toEqual({ unknownKeys: ['⌃⌥⇧⌘F19'], unknownNames: ['Tidy the whole essay'] })
})

test('every key cap in the twelve files is written as a key cap, never as inline code', () => {
  for (const name of ['00 Start here.md', ...chapters.map((chapter) => lessonFileFor(chapter.task)), EXAMPLE_OBJECTS_FILE]) {
    const text = lesson(name)
    expect(keyCapsIn(text).length, name).toBeGreaterThan(0)
    expect(text.match(/`[^`\n]*[⌘⌥⌃⇧][^`\n]*`/g) ?? [], name).toEqual([])
    expect(text, name).not.toMatch(/lorem|This lesson is coming/i)
  }
})

test('a Guide topic whose Try it opens a lesson file finds what its caption promises there', () => {
  const promised: Record<string, { file: string; has: string[] }> = {
    'how.3': { file: '05 Review and versions.md', has: ['<kbd>⌘S</kbd>', 'checkpoint', '<kbd>⇧⌘S</kbd>'] },
    'how.4': { file: '02 Shape the document.md', has: ['<kbd>⌘8</kbd>', '<kbd>⌥⌘↑</kbd>'] },
    'how.5': { file: '05 Review and versions.md', has: ['Drafting', 'Reviewing', '<kbd>⌥⌘M</kbd>'] },
    'how.6': { file: '08 Work with the agent.md', has: ['<kbd>⌘J</kbd>', 'suggestion'] },
    'how.7': { file: '08 Work with the agent.md', has: ['**Skills.**', 'Copy-edit', '**Manage skills…**'] },
    'how.8': { file: '07 Collect and plan.md', has: ['Board', 'Folio outline', '<kbd>⇧⌘B</kbd>'] },
  }
  const lessonTopics = ALL_TOPICS.filter((topic) => topic.tryIt?.target.kind === 'chapter')
  expect(lessonTopics.map((topic) => topic.id).sort()).toEqual(Object.keys(promised).sort())
  for (const topic of lessonTopics) {
    const target = topic.tryIt!.target as { kind: 'chapter'; chapter: Parameters<typeof lessonFileFor>[0] }
    const want = promised[topic.id]!
    expect(lessonFileFor(target.chapter), topic.id).toBe(want.file)
    expect(topic.tryIt!.does, topic.id).toContain(want.file)
    for (const phrase of want.has) expect(lesson(want.file).includes(phrase), `${topic.id}: ${want.file} lacks ${phrase}`).toBe(true)
  }
})

// The objects lesson (11 Objects.md) is no chapter, so `checkLesson` does not read it. It is held to
// the same honesty rules by `unknownIn`, and to one more: a working sample of every object the Insert
// object list offers, each with a block that says how to edit, add and remove it.
const OBJECT_SAMPLES: Record<string, { lead: string; sample: RegExp }> = {
  'insert.table': { lead: 'Table.', sample: /^\| --- \| --- \| --- \|$/m },
  'insert.image': { lead: 'Image.', sample: /^!\[[^\]]+\]\(assets\/[^)]+\.png\)$/m },
  'insert.widget': { lead: 'Widget.', sample: /^\[Simulation: assets\/walking-pace\.html\]$[\s\S]*^\[Simulation: assets\/packing-list\.html\]$/m },
  'insert.code': { lead: 'Code block.', sample: /^```\n[^`]+\n```$/m },
  'insert.mermaid': { lead: 'Flow diagram.', sample: /^```mermaid\nflowchart LR\n[\s\S]+?\n```$/m },
  'insert.markmap': { lead: 'Mind map.', sample: /^```markmap\n- [\s\S]+?\n```$/m },
  'insert.svg': { lead: 'SVG.', sample: /^```svg\n<svg [\s\S]+?<\/svg>\n```$/m },
  'insert.divider': { lead: 'Divider.', sample: /\n\n---\n\n/ },
  'insert.footnote': { lead: 'Footnote.', sample: /\S\[\^1\]\n\n\[\^1\]: \S/ },
  'insert.metadata': { lead: 'Metadata.', sample: /^---\ntitle: .+\n[\s\S]*?\n---\n/ },
  'insert.reference': { lead: 'Reference.', sample: /\[⟨[^⟩]+⟩\]\(zotero:\/\/[^)]+\)/ },
}

test('11 Objects.md names no key or command that does not exist', () => {
  expect(unknownIn(lesson(EXAMPLE_OBJECTS_FILE))).toEqual({ unknownKeys: [], unknownNames: [] })
})

test('11 Objects.md holds a working sample of every object Insert object offers, each with how to edit, add and remove it', () => {
  const text = lesson(EXAMPLE_OBJECTS_FILE)
  expect(Object.keys(OBJECT_SAMPLES).sort()).toEqual([...INSERT_OBJECT_IDS].sort())
  for (const id of INSERT_OBJECT_IDS) {
    const { lead, sample } = OBJECT_SAMPLES[id]!
    expect(sample.test(text), `${id}: no sample`).toBe(true)
    const block = text.split('\n').filter((line) => line.startsWith(`> **${lead}**`))
    expect(block, `${id}: one block opens with ${lead}`).toHaveLength(1)
    expect(block[0], `${id}: how to edit`).toMatch(/\bedit\b/i)
    expect(block[0], `${id}: how to add`).toMatch(/Insert object/)
    expect(block[0], `${id}: how to remove`).toMatch(/\bremove\b/i)
  }
  for (const asset of ['assets/walking-pace.html', 'assets/packing-list.html', 'assets/wold-view.png']) {
    expect(() => readFileSync(join(BUNDLE, asset)), asset).not.toThrow()
  }
})

test('the Guide topic about diagrams, mind maps and live tables opens 11 Objects.md and 01 Write.md points to it', () => {
  const topic = ALL_TOPICS.find((candidate) => candidate.id === 'feature.6')!
  expect(topic.tryIt?.target).toEqual({ kind: 'objects' })
  expect(topic.tryIt?.does).toContain(EXAMPLE_OBJECTS_FILE)
  expect(lesson('01 Write.md')).toContain('**11 Objects**')
  expect(lesson('00 Start here.md')).toContain('[[11 Objects]]')
})

// Actions here, final menu: where a lesson says "press ⌘K and choose X", X is a row the menu shows.
describe('⌘K instructions name rows the menu shows', () => {
  const LESSONS = ['01 Write.md', '02 Shape the document.md', '06 Find and manage files.md', '08 Work with the agent.md', '09 Share and export.md', '11 Objects.md']
  const registryLabels = new Map(commandRegistry.map((command) => [command.id, command.label]))
  /** Old names: the registry label of a command the menu now shows under a different label everywhere. */
  const RENAMED = new Set([...registryLabels].flatMap(([id, label]) => { const shown = menuLabelsOf(id); return shown.length > 0 && !shown.includes(label) ? [label] : [] }))

  for (const file of LESSONS) {
    test(`${file}: no ⌘K instruction uses a name the menu no longer shows`, () => {
      const quotations = lesson(file).split(/\n(?!>)/).filter((block) => block.startsWith('>') && block.includes('<kbd>⌘K</kbd>'))
      for (const quotation of quotations) {
        for (const phrase of [...quotation.matchAll(/\*\*(.+?)\*\*/g)].map((match) => match[1]!)) {
          expect(RENAMED.has(phrase) && !MENU_LABELS.has(phrase), `${file}: "${phrase}" is not a row ⌘K shows`).toBe(false)
        }
      }
    })
  }

  test('the renamed set is not empty, so the check can fail', () => {
    expect(RENAMED.has('Delete block…')).toBe(true)
    expect(RENAMED.has('Transform to UPPERCASE')).toBe(true)
  })
})

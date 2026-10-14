import { expect, test } from 'bun:test'
import type { MarkdownFile } from '../../src/preload'
import { buildCommandPaletteSections } from '../../src/renderer/src/components/CommandPalette'

function file(path: string): MarkdownFile {
  const name = path.split('/').at(-1) ?? path
  const slash = path.lastIndexOf('/')
  return { path, name, directory: slash === -1 ? '' : path.slice(0, slash), modifiedAt: 0, size: 0 }
}

function filesMode(files: MarkdownFile[], folders: string[], query: string) {
  return buildCommandPaletteSections({
    mode: 'files', query, files, folders, commands: [], skills: [], activeFile: null, recentIds: [],
  })
}

test('quick-open groups folded file and folder matches with files first', () => {
  const sections = filesMode(
    [file('journalism/a-piece-of-koláč.md'), file('mýty/plain.md')],
    ['journalism', 'mýty'],
    'myty',
  )

  expect(sections.map((section) => section.label)).toEqual(['Files', 'Folders'])
  expect(sections[0].items.map((item) => item.key)).toEqual(['mýty/plain.md'])
  expect(sections[1].items.map((item) => item.key)).toEqual(['mýty'])
})

test('quick-open excludes top-level cache and indexes but keeps ordinary nested names', () => {
  const sections = filesMode(
    [file('cache/hidden.md'), file('indexes/generated.md'), file('notes/cache-visible.md')],
    ['cache', 'indexes', 'notes'],
    '',
  )

  expect(sections.flatMap((section) => section.items.map((item) => item.key))).toEqual([
    'notes/cache-visible.md',
    'notes',
  ])
})

test('quick-open finds a piece from two words of its folder name in either order', () => {
  const files = [file('blogs/schemas-and-propositions/why-schemas-matter.md'), file('blogs/other/plain.md')]
  for (const query of ['prop schem', 'schem prop', 'prop-schem']) {
    const sections = filesMode(files, ['blogs', 'blogs/schemas-and-propositions', 'blogs/other'], query)
    expect(sections[0].items.map((item) => item.key)).toEqual(['blogs/schemas-and-propositions/why-schemas-matter.md'])
    expect(sections[1].items.map((item) => item.key)).toEqual(['blogs/schemas-and-propositions'])
  }
})

test('an agent note is a quick-open candidate by its own name and by the folder it sits in', () => {
  const note = 'blogs/schemas-and-propositions/agent-notes/why-schemas-matter.review.md'
  const files = [file('blogs/schemas-and-propositions/why-schemas-matter.md'), file(note)]
  const folders = ['blogs', 'blogs/schemas-and-propositions', 'blogs/schemas-and-propositions/agent-notes']
  expect(filesMode(files, folders, 'schem review')[0].items.map((item) => item.key)).toEqual([note])
  expect(filesMode(files, folders, 'agent notes')[1]?.items.map((item) => item.key)).toEqual(['blogs/schemas-and-propositions/agent-notes'])
})

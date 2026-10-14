import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'

function workspaceWith(content: string): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'wf-search-context-'))
  writeFileSync(join(root, 'note.md'), content)
  return new Workspace(root)
}

test('search includes two raw lines on each side of a middle-of-file hit', async () => {
  const ws = workspaceWith('zero\none\ntwo\nneedle\nfour\nfive\nsix')

  const { matches } = await ws.search('needle')

  expect(matches[0].context).toEqual({ before: ['one', 'two'], after: ['four', 'five'] })
})

test('search context has no before lines for a first-line hit and no after lines for a last-line hit', async () => {
  // One result per piece, at its best line: the earliest when the lines tie.
  const first = await workspaceWith('first needle\nmiddle\nlast needle').search('needle')
  expect(first.matches[0].context).toEqual({ before: [], after: ['middle', 'last needle'] })

  const last = await workspaceWith('first\nmiddle\nlast needle').search('needle')
  expect(last.matches[0].context).toEqual({ before: ['first', 'middle'], after: [] })
})

test('search slices every context line to 200 characters', async () => {
  const longBefore = `before-${'b'.repeat(220)}`
  const longAfter = `after-${'a'.repeat(220)}`
  const ws = workspaceWith(`${longBefore}\nneedle\n${longAfter}`)

  const { matches } = await ws.search('needle')

  expect(matches[0].context).toEqual({ before: [longBefore.slice(0, 200)], after: [longAfter.slice(0, 200)] })
})

test('tag-only hits carry context around the matching frontmatter tag line', async () => {
  const ws = workspaceWith('---\ntitle: Context\ntags:\n  - draft\n  - review\n---\n\nBody')

  const { matches } = await ws.search('tag:draft')

  expect(matches[0].context).toEqual({
    before: ['title: Context', 'tags:'],
    after: ['  - review', '---'],
  })
})

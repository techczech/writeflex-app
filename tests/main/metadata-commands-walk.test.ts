import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EditorState } from '@codemirror/state'
import { scriptedSessionFactory } from '@bridle/core'
import { buildE2EScriptedTurn, WorkspaceAgent, type ScriptedStep, type ScriptedTurn } from '../../src/main/agent'
import { ChangeStore } from '../../src/main/changes'
import { Workspace } from '../../src/main/workspace'
import { TASK_GROUPS } from '../../src/renderer/src/commands/command-task-groups'
import { keyboardSheet } from '../../src/renderer/src/commands/keyboard-sheet'
import { detectLivePreviewBlocks } from '../../src/renderer/src/editor/live-preview'
import { metadataEntry } from '../../src/renderer/src/editor/insert-objects'

// The logic of tests/e2e/metadata-commands.spec.ts without Electron.

describe('the palette\'s Edit metadata and ⌘K Metadata', () => {
  const hasBlock = (doc: string): boolean => detectLivePreviewBlocks(EditorState.create({ doc })).some((block) => block.kind === 'frontmatter' && block.from === 0)

  test('a bare document gets a new metadata block with an empty title, opened for editing', () => {
    const entry = metadataEntry('# Bare\n', hasBlock('# Bare\n'))
    expect(entry).toEqual({ kind: 'create', insert: '---\ntitle: \n---\n\n' })
    // The title the e2e then typed, "Bare title", lands in a block the editor reads as metadata.
    const written = '---\ntitle: Bare title\n---\n\n# Bare\n'
    expect(hasBlock(written)).toBe(true)
  })

  test('a document with metadata opens the block it has and never adds a second', () => {
    const doc = '---\ntitle: Existing\n---\n\nBody\n'
    expect(metadataEntry(doc, hasBlock(doc))).toEqual({ kind: 'open' })
  })

  test('a mid-edit or malformed block is refused with its own sentence rather than doubled', () => {
    const doc = '---\ntitle: [broken\n\nBody\n'
    expect(metadataEntry(doc, hasBlock(doc))).toEqual({ kind: 'malformed' })
  })
})

describe('scripted frontmatter.set', () => {
  let root: string
  let appData: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wf-metadata-commands-'))
    appData = await mkdtemp(join(tmpdir(), 'wf-metadata-commands-data-'))
    await writeFile(join(root, 'bare.md'), '# Bare\n', 'utf8')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(appData, { recursive: true, force: true })
  })

  test('stages a suggestion and applying it writes a canonical block on disk', async () => {
    const workspace = new Workspace(root)
    const queue: ScriptedTurn[] = []
    const agent = await WorkspaceAgent.create({ mode: 'work',
      workspace, appDataDir: appData, changes: new ChangeStore(workspace),
      onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
      sessionFactory: scriptedSessionFactory(queue),
    })
    const steps: ScriptedStep[] = [{ cap: 'frontmatter.set', input: { path: 'bare.md', set: { title: 'Bare', tags: ['draft', 'review'] } } }]
    queue.push(buildE2EScriptedTurn(steps))
    const turn = await agent.runScriptedTurn('Add metadata', steps)
    try {
      expect(turn.suggestions).toHaveLength(1)
      expect(turn.suggestions[0].capabilityName).toBe('frontmatter.set')
      expect(await readFile(join(root, 'bare.md'), 'utf8')).toBe('# Bare\n') // staged, not written
      await agent.applySuggestion(turn.suggestions[0].id)
      expect(await readFile(join(root, 'bare.md'), 'utf8')).toBe('---\ntitle: Bare\ntags: [draft, review]\n---\n\n# Bare\n')
    } finally {
      agent.dispose()
    }
  })
})

describe('the keyboard sheet', () => {
  const sections = keyboardSheet({ place: null, state: null, overrides: {} })
  const rowsOf = (id: string) => sections.find((section) => section.id === id)!.groups.flatMap((group) => group.rows)

  test('keeps the ten locked groups, in order', () => {
    expect(sections.map((section) => section.label)).toEqual([...TASK_GROUPS])
    expect(sections.map((section) => section.label)).toEqual(['Write', 'Shape the document', 'Stay focused', 'Listen', 'Review and versions', 'Find and manage files', 'Collect and plan', 'Work with the agent', 'Share and export', 'Set up WriteFlex'])
  })

  test('advertises file and object commands with their keys', () => {
    expect(rowsOf('Find and manage files').find((row) => row.label.includes('Move to Bin'))?.chords).toContain('⌘⌫')
    expect(rowsOf('Write').find((row) => row.label.includes('Insert object'))?.chords).toContain('⌘K')
  })
})

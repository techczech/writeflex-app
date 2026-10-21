import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { renderActionsHere, renderedRows } from '../helpers/actions-here-render'
import { ROW_ACTION_OF, Sidebar, type SidebarFileOps } from '../../src/renderer/src/components/Sidebar'
import { BinPopover } from '../../src/renderer/src/components/file-menu'
import { filesHeaderSummary } from '../../src/renderer/src/components/files-header-summary'
import { Workspace } from '../../src/main/workspace'
import { evaluateCollectionQuery } from '../../src/main/query-engine'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MarkdownFile } from '../../src/preload'

const md = (path: string): MarkdownFile => ({
  path,
  name: path.split('/').at(-1) ?? path,
  directory: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
  modifiedAt: 1,
  size: 10,
})

const ops: SidebarFileOps = {
  createFile: async () => true,
  createFolder: async () => true,
  renameFile: async () => true,
  renameFolder: async () => true,
  moveFile: async () => true,
  duplicateFile: async () => null,
  trashFile: async () => {},
  trashFolder: async () => {},
  revealFile: () => {},
  copyPath: () => {},
}

const renderSidebar = (over: { files?: MarkdownFile[]; folders?: string[]; pieceCount?: number; folderPiecePaths?: Set<string>; dashboardDir?: string | null } = {}): string =>
  renderToStaticMarkup(
    <Sidebar
      files={over.files ?? [md('note.md'), md('chapters/one.md')]}
      folders={over.folders ?? ['chapters']}
      pieceCount={over.pieceCount}
      folderPiecePaths={over.folderPiecePaths}
      favourites={[]}
      activePath={null}
      onOpen={() => {}}
      onToggleFavourite={() => {}}
      onOpenCollection={() => {}}
      onOpenBoard={() => {}}
      dashboardDir={over.dashboardDir ?? null}
      root="/tmp/ws"
      onCollapse={() => {}}
      onStatus={() => {}}
      onOpenSettings={() => {}}
      onFocusedRowChange={() => {}}
      onRequestCreate={() => {}}
      focusFilterTick={0}
      fileOps={ops}
      createRequest={null}
    />,
  )

test('sidebar shows the Collection piece count and marks Folder Piece rows with a folder glyph', () => {
  const html = renderSidebar({
    files: [md('draft.md'), md('report/report.md')],
    folders: ['report'],
    pieceCount: 2,
    folderPiecePaths: new Set(['report']),
  })
  expect(html).toContain('2 pieces · 1 folder piece')
  expect(html).toContain('class="trow folder folder-piece')
  expect(html).toContain('aria-label="Folder Piece"')
})

// 2026-09-26, the alpha.13 photograph: two pieces and one agent note read "3 pieces".
test('an agent note is not a piece: two pieces plus one note in agent-notes/ read "2 pieces"', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-files-header-'))
  try {
    const folder = join(root, 'blogs', 'schemas-and-propositions')
    await mkdir(join(folder, 'agent-notes'), { recursive: true })
    await writeFile(join(folder, 'why-schemas-matter.md'), '# Why schemas matter\n\nBody.\n')
    await writeFile(join(folder, 'what-models-want.md'), '# What models want\n\nBody.\n')
    await writeFile(join(folder, 'agent-notes', 'why-schemas-matter.review.md'),
      '---\nauthor: agent\nsource_document: blogs/schemas-and-propositions/why-schemas-matter.md\nagent_note_kind: review\n---\n\n# Review of Why schemas matter\n\n1. A point.\n')
    const result = await evaluateCollectionQuery(new Workspace(root), '', '')
    if (!result.ok) throw new Error(result.error.message)
    expect(result.rows).toHaveLength(3) // the query still lists the note, marked agent-authored
    const summary = filesHeaderSummary(result.rows)
    expect(summary.pieceCount).toBe(2)
    expect(renderSidebar({ files: [md('blogs/schemas-and-propositions/why-schemas-matter.md')], folders: ['blogs'], ...summary })).toContain('2 pieces · 0 folder pieces')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the agent-notes folder carries the agent badge; the writer’s folders do not', () => {
  const html = renderSidebar({
    files: [md('essays/metaphor.md'), md('essays/agent-notes/metaphor.review.md'), md('chapters/one.md')],
    folders: ['essays', 'essays/agent-notes', 'chapters'],
  })
  expect(html).toContain('class="trow folder agent-authored')
  expect(html).toContain('aria-label="Agent-authored folder"')
  expect(html).toContain('title="Agent notes — written by the agent, not by you"')
  expect(html).toContain('title="chapters"')
  expect(html).not.toContain('class="trow folder agent-authored" data-row="chapters"')
  expect(html.match(/aria-label="Agent-authored folder"/g)).toHaveLength(1)
})

test('the workspace name is the vault switcher on a plain folder too; the Folder dashboard button beside it opens the root Collection', () => {
  const html = renderSidebar()

  // Vaults ticket 06 (spec § Sidebar): the name opens the switcher menu; the dashboard is its own button.
  expect(html).toContain('<button class="wsname" title="Switch vault or open a folder" aria-haspopup="menu" aria-expanded="false"><span>ws</span>')
  expect(html).toContain('aria-label="Folder dashboard for ws"')
})

test('Folder dashboard button: always on the collection name row, filled when its page shows; on folder rows only as a hidden-by-CSS button that is filled for the showing folder', () => {
  const rest = renderSidebar()
  expect(rest).toContain('aria-label="Folder dashboard for ws"')
  expect(rest).toContain('title="Open the Folder dashboard for ws (the whole collection)"')
  expect(rest).toContain('title="Open the Folder dashboard for chapters"')
  expect(rest).not.toContain('class="fdash on"')
  expect(rest).not.toContain('aria-current="true"')
  const folder = renderSidebar({ dashboardDir: 'chapters' })
  expect(folder.match(/class="fdash on"/g)).toHaveLength(1)
  expect(folder).toContain('aria-current="true"')
  expect(folder).toContain('class="trow folder dash-on')
  const whole = renderSidebar({ dashboardDir: '' })
  expect(whole.match(/class="fdash on"/g)).toHaveLength(1)
  expect(whole).not.toContain('class="trow folder dash-on')
})

// --- The locked menus (ADR-0017; quiet-menu-v1.html is the spec) — order, labels, shortcuts. ---

test('Actions here at a file lists the file menu\'s verbs, in the drawn order, separated by thin rules', () => {
  const html = renderActionsHere('file')
  expect(renderedRows(html).map((row) => row.label)).toEqual([
    'Open',
    'Rename',
    'Move to folder…',
    'Duplicate',
    'Pin favourite',
    // Round B (ADR-0029): the Export sheet is reached from the palette, the panel and the cheat-sheet; the
    // row exports the ROW the panel was opened on, not the active document.
    'Export…',
    'Reveal in Finder',
    'Copy file path',
    'Move to Bin…',
  ])
  // The drawn menu has no grey group headers: thin rules separate four runs of rows.
  expect(html).not.toContain('class="ak-g"')
  expect(html.match(/class="ak-sep"/g)).toHaveLength(3)
  const byId = new Map(renderedRows(html).map((row) => [row.id, row]))
  expect(byId.get('file.rename')?.chords).toEqual(['F2'])
  expect(byId.get('file.move')?.chords).toEqual(['M'])
  expect(byId.get('file.duplicate')?.chords).toEqual(['⌘D'])
  expect(byId.get('file.pin')?.chords).toEqual([])
  expect(byId.get('file.trash')?.chords).toEqual(['⌘⌫'])
})

test('Actions here at a folder: create verbs first, the delete last (the drawn order)', () => {
  const labels = renderedRows(renderActionsHere('folder')).map((row) => row.label)
  expect(labels).toEqual(['New file here', 'New subfolder…', 'Rename folder', 'Reveal in Finder', 'Focus on this folder', 'Help with this report', 'Delete folder…'])
})

test('every row of the old file and folder menus is a row of the panel at that place', () => {
  const ids = (place: 'file' | 'folder' | 'focused-folder') => renderedRows(renderActionsHere(place)).map((row) => row.id)
  for (const [action, id] of [['open', 'file.open'], ['rename', 'file.rename'], ['move', 'file.move'], ['duplicate', 'file.duplicate'], ['pin', 'file.pin'], ['export', 'file.export'], ['reveal', 'file.reveal'], ['copy-path', 'file.copyPath'], ['trash', 'file.trash']] as const) {
    expect(ROW_ACTION_OF[id]).toBe(action)
    expect(ids('file')).toContain(id)
  }
  for (const [action, id] of [['new-file', 'folder.newFile'], ['new-folder', 'folder.newFolder'], ['focus', 'folder.focus'], ['help-report', 'folder.helpWithReport'], ['rename', 'folder.rename'], ['reveal', 'folder.reveal'], ['trash', 'folder.trash']] as const) {
    expect(ROW_ACTION_OF[id]).toBe(action)
    expect(ids('folder')).toContain(id)
  }
  expect(ROW_ACTION_OF['folder.clearFocus']).toBe('clear-focus')
  expect(ids('focused-folder')).toContain('folder.clearFocus')
})

test('Actions here renders the file place with its role and rows', () => {
  const html = renderActionsHere('file')
  expect(html).toContain('data-testid="actions-here"')
  expect(html).toContain('role="dialog"')
  expect(html).toContain('On a file')
  expect(html).toContain('Move to Bin…')
  expect(html).toContain('<kbd>⌘⌫</kbd>')
})

// --- Bin popover copy: always names the recovery path; folder deletes carry their file count. ---

test('bin popover says Recoverable from Finder', () => {
  const html = renderToStaticMarkup(<BinPopover x={0} y={0} name="note.md" onConfirm={() => {}} onCancel={() => {}} />)
  expect(html).toContain('Recoverable from Finder')
  expect(html).toContain('Move to Bin')
  expect(html).not.toContain('and its')
})

test('folder bin popover names the file count riding along', () => {
  const html = renderToStaticMarkup(
    <BinPopover x={0} y={0} name="chapters" fileCount={4} onConfirm={() => {}} onCancel={() => {}} />,
  )
  expect(html).toContain('and its 4 files')
})

// --- The tree itself ---

test('an EMPTY folder is a visible row (ADR-0017 folder-completion rule)', () => {
  const html = renderSidebar({ files: [md('note.md')], folders: ['empty-folder'] })
  expect(html).toContain('empty-folder')
})

test('footer creation buttons are real and advertise ⌘N / ⌃⌘N', () => {
  const html = renderSidebar()
  expect(html).toContain('New file (⌘N)')
  expect(html).toContain('New folder (⌃⌘N)')
  expect(html).not.toContain('lands later in this build') // only Archive/Trash/Tags stubs may say this
})

test('file favourites do not claim the tab-pin chord', () => {
  const html = renderSidebar()
  expect(html).not.toContain('Pin to Favourites (⌥⌘P)')
  expect(html).not.toContain('Unpin from Favourites (⌥⌘P)')
})

test('file finder is summoned on demand with no permanent input, Contents mode, or grep rows', () => {
  const html = renderSidebar()
  expect(html).toContain('aria-label="Filter files"')
  expect(html).toContain('⌕')
  expect(html).not.toContain('class="file-filter"')
  expect(html).not.toContain('Contents')
  expect(html).not.toContain('grep-file')
})

test('tree rows share a 14px per-depth indent and every file reserves the chevron gutter', () => {
  const html = renderSidebar({
    files: [md('root.md'), md('parent/child.md'), md('parent/nested/grandchild.md'), md('parent/nested/deeper/great.md')],
    folders: ['parent', 'parent/nested', 'parent/nested/deeper'],
  })
  const paddingLeftFor = (path: string): number => {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const row = html.match(new RegExp(`<[^>]+data-row="${escaped}"[^>]*style="([^"]+)"`))
    const padding = row?.[1].match(/padding-left:([0-9]+)px/)
    if (!padding) throw new Error(`No inline padding-left found for ${path}`)
    return Number(padding[1])
  }
  const hasChevronGutter = (path: string): boolean => {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`<button[^>]+data-row="${escaped}"[^>]*>\\s*<span class="gtr"`).test(html)
  }

  expect(paddingLeftFor('parent')).toBe(8)
  expect(paddingLeftFor('parent/child.md')).toBe(22)
  expect(paddingLeftFor('parent/nested')).toBe(22)
  expect(paddingLeftFor('parent/nested/grandchild.md')).toBe(36)
  expect(paddingLeftFor('parent/nested/deeper/great.md')).toBe(50)
  expect(paddingLeftFor('parent/child.md') - paddingLeftFor('parent')).toBe(14)
  expect(hasChevronGutter('root.md')).toBe(true)
  expect(hasChevronGutter('parent/child.md')).toBe(true)
  expect(hasChevronGutter('parent/nested/grandchild.md')).toBe(true)
  expect(hasChevronGutter('parent/nested/deeper/great.md')).toBe(true)
})

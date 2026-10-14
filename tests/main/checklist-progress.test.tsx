import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { Workspace } from '../../src/main/workspace'
import { evaluateCollectionQuery } from '../../src/main/query-engine'
import { Sidebar, type SidebarFileOps } from '../../src/renderer/src/components/Sidebar'
import { CommandPalette } from '../../src/renderer/src/components/CommandPalette'
import { BoardCardTasks } from '../../src/renderer/src/components/BoardCardMaterial'
import type { MarkdownFile } from '../../src/preload'

// Checkbox-lists ticket 03, frames 8–9: "done / total" beside checklist notes in Files and Quick
// Open (green when finished), and "n / m to do" on the Board card of any piece with boxes. One
// summary (shared/markdown/task-lines.ts) feeds all three; Files and Quick Open read it from the
// search content cache, the Board from the bytes its query already reads.

let root: string
let ws: Workspace

const write = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), text)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-checklist-progress-'))
  ws = new Workspace(root)
  await write('notes/workshop-prep.md', '# Before the workshop\n- [ ] Check the room has HDMI\n- [ ] Rehearse part 3\n- [x] Send slides to the organiser\n- [x] Print the handout\n')
  await write('notes/sources-to-chase.md', Array.from({ length: 9 }, (_, i) => `- [ ] source ${i + 1}`).join('\n'))
  await write('notes/packing.md', Array.from({ length: 6 }, (_, i) => `- [x] thing ${i + 1}`).join('\n'))
  await write('notes/york-talk-draft.md', '# York talk\n\nThe opening paragraph.\n\nA second paragraph.\n\nA third.\n\n- [ ] fix the opening\n- [x] cut the aside\n- [ ] add an example\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test('Workspace.checklistProgress lists checklist notes only, as done / total', async () => {
  const progress = await ws.checklistProgress()
  expect(progress.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
    { path: 'notes/packing.md', done: 6, total: 6 },
    { path: 'notes/sources-to-chase.md', done: 0, total: 9 },
    { path: 'notes/workshop-prep.md', done: 2, total: 4 },
  ])
})

test('progress shares the search content cache: no file is read twice between changes', async () => {
  await ws.search('York')
  const afterSearch = ws.searchIndex.reads
  expect(afterSearch).toBe(4)
  await ws.checklistProgress()
  await ws.checklistProgress()
  expect(ws.searchIndex.reads).toBe(afterSearch) // the summary adds no disk read

  // A tick on disk re-reads that one file and its chip moves.
  await write('notes/workshop-prep.md', '# Before the workshop\n- [x] Check the room has HDMI\n- [ ] Rehearse part 3\n- [x] Send slides to the organiser\n- [x] Print the handout\n')
  const later = new Date(Date.now() + 5_000)
  await utimes(join(root, 'notes/workshop-prep.md'), later, later)
  const progress = await ws.checklistProgress()
  expect(ws.searchIndex.reads).toBe(afterSearch + 1)
  expect(progress.find((row) => row.path === 'notes/workshop-prep.md')).toEqual({ path: 'notes/workshop-prep.md', done: 3, total: 4 })
  await ws.search('York')
  expect(ws.searchIndex.reads).toBe(afterSearch + 1)
})

const md = (path: string): MarkdownFile => ({ path, name: path.split('/').at(-1)!, directory: path.slice(0, path.lastIndexOf('/')), modifiedAt: 1, size: 10 })
const files = ['notes/workshop-prep.md', 'notes/sources-to-chase.md', 'notes/packing.md', 'notes/york-talk-draft.md'].map(md)
const progress = new Map([
  ['notes/workshop-prep.md', { done: 2, total: 4 }],
  ['notes/sources-to-chase.md', { done: 0, total: 9 }],
  ['notes/packing.md', { done: 6, total: 6 }],
])
const ops = new Proxy({}, { get: () => async () => true }) as SidebarFileOps

/** The chip rendered right after a row's name, or null when the row has none. */
function chipAfter(html: string, name: string): string | null {
  const at = html.indexOf(`>${name}</span>`)
  expect(at).toBeGreaterThan(-1)
  const rest = html.slice(at, html.indexOf('</button>', at))
  return /<span class="checklist-chip( done)?"[^>]*>([^<]+)<\/span>/.exec(rest)?.slice(1).join('|') ?? null
}

test('the Files tree shows the chip beside checklist notes only, green when finished (frame 8)', () => {
  const html = renderToStaticMarkup(
    <Sidebar
      files={files}
      checklistProgress={progress}
      folders={['notes']}
      favourites={[]}
      activePath={null}
      onOpen={() => {}}
      onToggleFavourite={() => {}}
      onOpenCollection={() => {}}
      onOpenBoard={() => {}}
      root="/tmp/ws-checklist"
      onCollapse={() => {}}
      onStatus={() => {}}
      onOpenSettings={() => {}}
      onFocusedRowChange={() => {}}
      onRequestCreate={() => {}}
      version={null}
      focusFilterTick={0}
      fileOps={ops}
      createRequest={null}
    />,
  )
  expect(chipAfter(html, 'workshop-prep.md')).toBe('|2 / 4')
  expect(chipAfter(html, 'sources-to-chase.md')).toBe('|0 / 9')
  expect(chipAfter(html, 'packing.md')).toBe(' done|6 / 6')
  expect(chipAfter(html, 'york-talk-draft.md')).toBeNull()
})

test('Quick Open shows the same chips on its file rows', () => {
  const html = renderToStaticMarkup(
    <CommandPalette
      mode="files"
      files={files}
      checklistProgress={progress}
      folders={[]}
      commands={[]}
      skills={[]}
      activeFile={null}
      recentIds={[]}
      onRun={() => {}}
      onOpenFile={() => {}}
      onRevealFile={() => {}}
      onRevealFolder={() => {}}
      onAskAgent={() => {}}
      onRunSkill={() => {}}
      onOpenSkill={() => {}}
      onManageSkills={() => {}}
      onClose={() => {}}
    />,
  )
  expect(html.match(/class="checklist-chip"/g)).toHaveLength(2)
  expect(html.match(/class="checklist-chip done"/g)).toHaveLength(1)
  expect(html).toContain('>2 / 4<')
  expect(html).toContain('>6 / 6<')
})

test('a Board card counts the boxes of any piece: "n / m to do", "m / m done", nothing without boxes (frame 9)', () => {
  expect(renderToStaticMarkup(<BoardCardTasks row={{ taskOpen: 1, taskDone: 3 }} />)).toContain('>1 / 4 to do<')
  const done = renderToStaticMarkup(<BoardCardTasks row={{ taskOpen: 0, taskDone: 3 }} />)
  expect(done).toContain('class="bc-chip tasks done"')
  expect(done).toContain('>3 / 3 done<')
  expect(renderToStaticMarkup(<BoardCardTasks row={{ taskOpen: 0, taskDone: 0 }} />)).toBe('')
})

test('Board rows carry each piece\'s open and ticked boxes from the bytes the query already read', async () => {
  const reads: string[] = []
  const readFile = ws.readFile.bind(ws)
  ws.readFile = async (path: string) => {
    reads.push(path)
    return readFile(path)
  }
  const result = await evaluateCollectionQuery(ws, 'notes', '')
  if (!result.ok) throw new Error(result.error.message)
  const counts = Object.fromEntries(result.rows.map((row) => [row.path.split('/').at(-1), [row.taskOpen, row.taskDone]]))
  // The draft is no checklist note, but its card still counts its to-do list.
  expect(counts).toEqual({
    'packing.md': [0, 6],
    'sources-to-chase.md': [9, 0],
    'workshop-prep.md': [2, 2],
    'york-talk-draft.md': [2, 1],
  })
  expect(reads.filter((path) => path.endsWith('.md')).sort()).toEqual(files.map((file) => file.path).sort())
})

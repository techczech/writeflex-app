import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MarkdownFile } from '../../src/preload'
import { WorkspaceEmpty, WorkspaceRecentRow } from '../../src/renderer/src/components/WorkspaceEmpty'

const file = (path: string, modifiedAt: number): MarkdownFile => ({
  path,
  name: path.split('/').at(-1) ?? path,
  directory: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
  modifiedAt,
  size: 1,
})

const files = [
  file('oldest.md', 100),
  file('notes/newest.md', 400),
  file('middle.md', 300),
  file('older.md', 200),
]

test('workspace empty renders the locked copy and both keyboard-labelled actions', () => {
  const html = renderToStaticMarkup(
    <WorkspaceEmpty files={files} onNewFile={() => {}} onSearchFiles={() => {}} onOpenFile={() => {}} />,
  )

  expect(html).toContain('No file open')
  expect(html).toContain('Pick a file from the sidebar, or start something new.')
  expect(html).toMatch(/New file[\s\S]*<kbd>⌘N<\/kbd>/)
  expect(html).toMatch(/Search files[\s\S]*<kbd>⇧⌘F<\/kbd>/)
  expect(html).not.toContain('Open folder')
})

test('workspace recent files are capped at three and sorted by durable modified time', () => {
  const html = renderToStaticMarkup(
    <WorkspaceEmpty files={files} onNewFile={() => {}} onSearchFiles={() => {}} onOpenFile={() => {}} />,
  )

  expect(html).toContain('Recent in this workspace')
  expect(html.match(/class="workspace-rec-row"/g)?.length).toBe(3)
  expect(html.indexOf('newest.md')).toBeLessThan(html.indexOf('middle.md'))
  expect(html.indexOf('middle.md')).toBeLessThan(html.indexOf('older.md'))
  expect(html).not.toContain('oldest.md')
})

test('clicking a workspace recent row opens its file path', () => {
  let opened = ''
  const recent = file('notes/newest.md', Date.now())
  const row = WorkspaceRecentRow({
    file: recent,
    index: 0,
    active: 0,
    count: 1,
    rowRef: () => {},
    onFocus: () => {},
    onKeyDown: () => {},
    onOpenFile: (path) => { opened = path },
  })

  row.props.onClick()
  expect(opened).toBe('notes/newest.md')
})

test('workspace empty omits the recent list when the workspace has no files', () => {
  const html = renderToStaticMarkup(
    <WorkspaceEmpty files={[]} onNewFile={() => {}} onSearchFiles={() => {}} onOpenFile={() => {}} />,
  )

  expect(html).not.toContain('Recent in this workspace')
})

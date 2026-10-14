import { expect, test } from 'bun:test'
import { classifyExternalDrop } from '../../src/renderer/src/external-drop'

test('opens one Markdown file or one directory', () => {
  expect(classifyExternalDrop([{ path: '/tmp/draft.md', kind: 'file' }])).toEqual({ openable: true, path: { path: '/tmp/draft.md', kind: 'file' } })
  expect(classifyExternalDrop([{ path: '/tmp/notes', kind: 'directory' }])).toEqual({ openable: true, path: { path: '/tmp/notes', kind: 'directory' } })
})

test('refuses unsupported and mixed drops with a useful reason', () => {
  expect(classifyExternalDrop([{ path: '/tmp/app.js', kind: 'file' }])).toEqual({ openable: false, reason: 'WriteFlex opens Markdown files and folders, not app.js.' })
  expect(classifyExternalDrop([
    { path: '/tmp/draft.md', kind: 'file' },
    { path: '/tmp/app.js', kind: 'file' },
  ])).toEqual({ openable: false, reason: 'WriteFlex opens Markdown files and folders, not app.js.' })
})

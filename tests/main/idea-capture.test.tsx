import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { IdeaCapture, isCaptureSubmitShortcut } from '../../src/renderer/src/components/IdeaCapture'

test('Capture submits only on Command/Ctrl+Enter', () => {
  expect(isCaptureSubmitShortcut({ key: 'Enter', metaKey: true, ctrlKey: false })).toBe(true)
  expect(isCaptureSubmitShortcut({ key: 'Enter', metaKey: false, ctrlKey: true })).toBe(true)
  expect(isCaptureSubmitShortcut({ key: 'Enter', metaKey: false, ctrlKey: false })).toBe(false)
})

test('Capture save control advertises Command+Enter without native form submission', () => {
  const html = renderToStaticMarkup(<IdeaCapture
    dir=""
    onCreated={() => {}}
    onOpenExisting={() => {}}
    onClose={() => {}}
    onError={() => {}}
  />)
  expect(html).toContain('Save idea <kbd>⌘↵</kbd>')
  expect(html).toContain('type="button"')
  expect(html).not.toContain('type="submit"')
})

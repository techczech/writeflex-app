import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// Outline package ticket 15: the formatting toolbar renders inside the document pane (main.editor-wrap),
// above the transient bars and the editor, and no longer between the tab strip and the whole body.
const app = readFileSync(new URL('../../src/renderer/src/app/App.tsx', import.meta.url), 'utf8')

test('the action bar is rendered inside the document pane, before the read-aloud bar and the editor', () => {
  const pane = app.indexOf('<main className="editor-wrap"')
  const bar = app.indexOf('<ActionBar ')
  expect(app.split('<ActionBar ').length - 1).toBe(1)
  expect(pane).toBeGreaterThan(0)
  expect(bar).toBeGreaterThan(pane)
  expect(bar).toBeLessThan(app.indexOf('<ReadAloudBar'))
  expect(bar).toBeLessThan(app.indexOf('<EditorPane'))
  expect(bar).toBeLessThan(app.indexOf('className="historical-banner"'))
  expect(app.indexOf('</Toolbar>')).toBeLessThan(app.indexOf('<div className={`body tabbed-shell'))
  // not between the toolbar and the body any more
  const betweenToolbarAndBody = app.slice(app.indexOf('</Toolbar>'), app.indexOf('<div className={`body tabbed-shell'))
  expect(betweenToolbarAndBody).not.toContain('<ActionBar')
})

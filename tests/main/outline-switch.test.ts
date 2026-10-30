import { expect, test } from 'bun:test'
import { folioSidebarLayout, noteDocumentInteraction, noteFileOpened, OUTLINE_SWITCH_IDLE } from '../../src/renderer/src/app/outline-switch'

test('entering either Folio surface selects the sidebar contents; leaving restores the previous tab and collapse state', () => {
  const before = { tab: 'search' as const, collapsed: true }
  const entered = folioSidebarLayout(null, 'f', before)
  expect(entered).toEqual({ saved: before, layout: { tab: 'outline', collapsed: false } })
  // Moving between workspace and editing keeps the original layout, and lets Files/Search work meanwhile.
  expect(folioSidebarLayout(entered.saved, 'f', { tab: 'files', collapsed: false })).toEqual({ saved: before, layout: null })
  expect(folioSidebarLayout(entered.saved, null, { tab: 'outline', collapsed: false })).toEqual({ saved: null, layout: before })
  expect(folioSidebarLayout(null, null, before)).toEqual({ saved: null, layout: null })
})

test('clicking through three files in Files keeps Files; the first document click switches once', () => {
  let state = OUTLINE_SWITCH_IDLE
  for (const path of ['a.md', 'b.md', 'c.md']) {
    state = noteFileOpened(state, path, 'files')
    // no document interaction in between: nothing to switch
  }
  const first = noteDocumentInteraction(state, 'c.md', 'files')
  expect(first.switchToOutline).toBe(true)
  const again = noteDocumentInteraction(first.state, 'c.md', 'files')
  expect(again.switchToOutline).toBe(false)
})

test('going back to Files and clicking the document again does not switch', () => {
  let state = noteFileOpened(OUTLINE_SWITCH_IDLE, 'a.md', 'files')
  state = noteDocumentInteraction(state, 'a.md', 'files').state
  expect(noteDocumentInteraction(state, 'a.md', 'files').switchToOutline).toBe(false)
})

test('Search arms it like Files; other ways of opening do not', () => {
  expect(noteDocumentInteraction(noteFileOpened(OUTLINE_SWITCH_IDLE, 'a.md', 'search'), 'a.md', 'search').switchToOutline).toBe(true)
  expect(noteDocumentInteraction(noteFileOpened(OUTLINE_SWITCH_IDLE, 'a.md', 'other'), 'a.md', 'files').switchToOutline).toBe(false)
  const disarmed = noteFileOpened(noteFileOpened(OUTLINE_SWITCH_IDLE, 'a.md', 'files'), 'b.md', 'other')
  expect(noteDocumentInteraction(disarmed, 'b.md', 'files').switchToOutline).toBe(false)
})

test('an interaction in a different file than the armed one neither switches nor consumes', () => {
  const armed = noteFileOpened(OUTLINE_SWITCH_IDLE, 'b.md', 'files')
  const result = noteDocumentInteraction(armed, 'a.md', 'files')
  expect(result.switchToOutline).toBe(false)
  expect(result.state).toBe(armed)
})

test('already on Outline: the arm is consumed without a switch', () => {
  const armed = noteFileOpened(OUTLINE_SWITCH_IDLE, 'a.md', 'files')
  const result = noteDocumentInteraction(armed, 'a.md', 'outline')
  expect(result.switchToOutline).toBe(false)
  expect(result.state.armedPath).toBeNull()
})

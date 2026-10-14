import { expect, test } from 'bun:test'
import { decideNavigation } from '../../src/main/navigation'

const shell = 'file:///Applications/WriteFlex.app/Contents/Resources/app.asar/out/renderer/index.html'

test('allows only the shell document, including its hash and query', () => {
  expect(decideNavigation(shell, shell)).toBe('allow')
  expect(decideNavigation(shell, `${shell}?tab=notes#heading`)).toBe('allow')
  expect(decideNavigation('http://localhost:5173/', 'http://localhost:5173/?tab=notes#heading')).toBe('allow')
})

test('refuses bundled siblings, other files, deep links, and blank pages', () => {
  expect(decideNavigation(shell, 'file:///Applications/WriteFlex.app/Contents/Resources/app.asar/out/renderer/assets/whatever.js')).toBe('refuse')
  expect(decideNavigation(shell, 'file:///tmp/other.html')).toBe('refuse')
  expect(decideNavigation(shell, 'writeflex://open?path=%2Ftmp%2Fdraft.md')).toBe('refuse')
  expect(decideNavigation(shell, 'about:blank')).toBe('refuse')
})

test('opens web links externally', () => {
  expect(decideNavigation(shell, 'http://example.com/')).toBe('external')
  expect(decideNavigation(shell, 'https://example.com/')).toBe('external')
})

import { decideFrameNavigation, type FrameNavigation } from '../../src/main/navigation'

const nav = (patch: Partial<FrameNavigation>): FrameNavigation => ({ isMainFrame: false, isSameDocument: false, initiator: 'top', frameOpaque: false, url: 'https://example.com/', ...patch })

test('the top window is moved only by itself or by the app, never by a frame inside it (widgets ticket 02)', () => {
  expect(decideFrameNavigation(nav({ isMainFrame: true, initiator: 'top' }))).toBe('continue')
  expect(decideFrameNavigation(nav({ isMainFrame: true, initiator: 'none' }))).toBe('continue')
  for (const url of ['https://example.com/', 'file:///etc/hosts', 'writeflex://open?path=x', 'about:blank']) {
    expect(decideFrameNavigation(nav({ isMainFrame: true, initiator: 'opaque', url }))).toBe('refuse')
    expect(decideFrameNavigation(nav({ isMainFrame: true, initiator: 'other', url }))).toBe('refuse')
  }
})

test('a widget frame goes nowhere that reaches the network; the window may still load it', () => {
  // The window's own srcdoc load, and a frame that is not a widget's (the Reading Room's), go ahead.
  expect(decideFrameNavigation(nav({ initiator: 'top', frameOpaque: true, url: 'about:srcdoc' }))).toBe('continue')
  expect(decideFrameNavigation(nav({ initiator: 'other', frameOpaque: false, url: 'https://example.com/' }))).toBe('continue')
  // The widget sending itself, or a frame it made, to the network or a file is refused.
  for (const url of ['https://example.com/', 'http://127.0.0.1:9/', 'file:///etc/hosts', 'wf-asset://token/x.png', 'writeflex://open?path=x']) {
    expect(decideFrameNavigation(nav({ initiator: 'opaque', frameOpaque: true, url }))).toBe('refuse')
    expect(decideFrameNavigation(nav({ initiator: 'opaque', frameOpaque: false, url }))).toBe('refuse')
    expect(decideFrameNavigation(nav({ initiator: 'none', frameOpaque: true, url }))).toBe('refuse')
    expect(decideFrameNavigation(nav({ initiator: 'other', frameOpaque: true, url }))).toBe('refuse')
  }
  // Only a move within the same document goes ahead: a document of the widget's own making (srcdoc,
  // data:, blob:, even about:blank) would run scripts the agent never saw.
  expect(decideFrameNavigation(nav({ initiator: 'opaque', frameOpaque: true, isSameDocument: true }))).toBe('continue')
  for (const url of ['about:srcdoc', 'about:blank', 'data:text/html,x', 'blob:null/1234', 'javascript:1']) {
    expect(decideFrameNavigation(nav({ initiator: 'opaque', frameOpaque: true, url }))).toBe('refuse')
    expect(decideFrameNavigation(nav({ initiator: 'opaque', frameOpaque: false, url }))).toBe('refuse')
  }
  // A frame inside a widget is never navigated, whoever starts it, and an unknown frame of a widget too.
  for (const initiator of ['top', 'opaque', 'other', 'none'] as const) {
    expect(decideFrameNavigation(nav({ initiator, parentOpaque: true, url: 'about:srcdoc' }))).toBe('refuse')
    expect(decideFrameNavigation(nav({ initiator, parentOpaque: true, isSameDocument: true }))).toBe('continue')
  }
  // The Reading Room's frames (the app's own origin) are not touched.
  expect(decideFrameNavigation(nav({ initiator: 'other', frameOpaque: false, parentOpaque: false, url: 'about:srcdoc' }))).toBe('continue')
})

import { test, expect } from 'bun:test'
import { EditorState, EditorSelection, type StateCommand } from '@codemirror/state'
import * as editorCommands from '../../src/renderer/src/editor/commands'
import {
  toggleMark,
  duplicateLine,
  joinLines,
  upperCase,
  lowerCase,
  titleCase,
  selectBodyExceptMetadata,
  paletteCommands,
} from '../../src/renderer/src/editor/commands'

// Headless StateCommand harness (the M1 pattern): drive a command over a doc + selection and read
// back the resulting doc, whether it handled the key, and the primary selection span.
function run(
  command: StateCommand,
  doc: string,
  anchor: number,
  head?: number,
): { doc: string; handled: boolean; from: number; to: number } {
  let state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head ?? anchor) })
  const handled = command({ state, dispatch: (tr) => { state = tr.state } })
  const main = state.selection.main
  return { doc: state.doc.toString(), handled, from: main.from, to: main.to }
}

function runRanges(
  command: StateCommand,
  doc: string,
  ranges: Array<[number, number]>,
): { doc: string; selections: Array<{ from: number; to: number; text: string }> } {
  let state = EditorState.create({
    doc,
    selection: EditorSelection.create(ranges.map(([anchor, head]) => EditorSelection.range(anchor, head))),
    extensions: [EditorState.allowMultipleSelections.of(true)],
  })
  command({ state, dispatch: (tr) => { state = tr.state } })
  return {
    doc: state.doc.toString(),
    selections: state.selection.ranges.map((range) => ({
      from: range.from,
      to: range.to,
      text: state.sliceDoc(range.from, range.to),
    })),
  }
}

const newCommand = (name: string): StateCommand => {
  const command = (editorCommands as unknown as Record<string, unknown>)[name]
  expect(command, `${name} is exported`).toBeFunction()
  return command as StateCommand
}

// ── formatting shortcuts (C9.3) ─────────────────────────────────────────────
test('bold and italic wrap selections, trim edge whitespace, and insert an empty pair at a caret', () => {
  expect(run(newCommand('toggleBold'), 'alpha bravo', 6, 11)).toMatchObject({ doc: 'alpha **bravo**', from: 6, to: 15 })
  expect(run(newCommand('toggleItalic'), 'alpha bravo', 6, 11)).toMatchObject({ doc: 'alpha *bravo*', from: 6, to: 13 })

  const spaced = run(newCommand('toggleBold'), 'alpha  bravo ', 5, 13)
  expect(spaced.doc).toBe('alpha  **bravo** ')
  expect(spaced.doc.slice(spaced.from, spaced.to)).toBe('**bravo**')

  const empty = run(newCommand('toggleItalic'), 'alpha ', 6)
  expect(empty.doc).toBe('alpha **')
  expect([empty.from, empty.to]).toEqual([7, 7])
})

test('bold and italic toggle off with selected markers, flanking markers, or a caret inside', () => {
  expect(run(newCommand('toggleBold'), '**bravo**', 0, 9)).toMatchObject({ doc: 'bravo', from: 0, to: 5 })
  expect(run(newCommand('toggleBold'), '**bravo**', 2, 7)).toMatchObject({ doc: 'bravo', from: 0, to: 5 })
  expect(run(newCommand('toggleBold'), '**bravo**', 4).doc).toBe('bravo')
  expect(run(newCommand('toggleItalic'), '*bravo*', 0, 7)).toMatchObject({ doc: 'bravo', from: 0, to: 5 })
  expect(run(newCommand('toggleItalic'), '*bravo*', 3).doc).toBe('bravo')
})

test('bold and italic format every selection range independently', () => {
  const bold = runRanges(newCommand('toggleBold'), 'one two three', [[0, 3], [8, 13]])
  expect(bold.doc).toBe('**one** two **three**')
  expect(bold.selections).toEqual([
    { from: 0, to: 7, text: '**one**' },
    { from: 12, to: 21, text: '**three**' },
  ])

  const italic = runRanges(newCommand('toggleItalic'), 'one two three', [[0, 3], [8, 13]])
  expect(italic.doc).toBe('*one* two *three*')
  expect(italic.selections).toEqual([
    { from: 0, to: 5, text: '*one*' },
    { from: 10, to: 17, text: '*three*' },
  ])
})

test('link inserts an empty destination or a structural clipboard URL with the requested field selected', () => {
  const linkFactory = (editorCommands as unknown as Record<string, unknown>).insertMarkdownLinkFromClipboard
  expect(linkFactory).toBeFunction()

  const destination = run((linkFactory as (text: string) => StateCommand)('not a url'), 'alpha bravo', 6, 11)
  expect(destination.doc).toBe('alpha [bravo]()')
  expect([destination.from, destination.to]).toEqual([14, 14])

  const clipboard = run((linkFactory as (text: string) => StateCommand)('https://example.com/path'), 'alpha bravo', 6, 11)
  expect(clipboard.doc).toBe('alpha [bravo](https://example.com/path)')
  expect(clipboard.doc.slice(clipboard.from, clipboard.to)).toBe('bravo')

  const empty = run((linkFactory as (text: string) => StateCommand)(''), 'alpha ', 6)
  expect(empty.doc).toBe('alpha []()')
  expect([empty.from, empty.to]).toEqual([7, 7])
})

// ── synchronous link command ─────────────────────────────────────────────────────────────────────
test('link command reads the preload clipboard bridge and dispatches synchronously', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const runWithClipboard = (clipboardText: string) => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { writeflex: { clipboardText: () => clipboardText } },
    })
    return run(newCommand('insertMarkdownLink'), 'alpha bravo', 6, 11)
  }

  try {
    const empty = runWithClipboard('')
    expect(empty.doc).toBe('alpha [bravo]()')
    expect([empty.from, empty.to]).toEqual([14, 14])

    const url = runWithClipboard('https://example.com/path')
    expect(url.doc).toBe('alpha [bravo](https://example.com/path)')
    expect(url.doc.slice(url.from, url.to)).toBe('bravo')

    const ordinaryText = runWithClipboard('not a url')
    expect(ordinaryText.doc).toBe('alpha [bravo]()')
    expect([ordinaryText.from, ordinaryText.to]).toEqual([14, 14])
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

// ── toggleMark (⌘E) ──────────────────────────────────────────────────────────────────────
test('toggleMark wraps a selection in == markers and keeps it selected', () => {
  const r = run(toggleMark, 'alpha bravo charlie', 6, 11) // "bravo"
  expect(r.handled).toBe(true)
  expect(r.doc).toBe('alpha ==bravo== charlie')
  expect(r.doc.slice(r.from, r.to)).toBe('bravo')
})

test('toggleMark on a caret marks the word under the cursor', () => {
  const r = run(toggleMark, 'alpha bravo charlie', 8) // caret inside "bravo"
  expect(r.doc).toBe('alpha ==bravo== charlie')
})

test('toggleMark unwraps when the selection is already ==marked==', () => {
  const r = run(toggleMark, 'alpha ==bravo== charlie', 6, 15) // "==bravo=="
  expect(r.doc).toBe('alpha bravo charlie')
})

test('toggleMark unwraps when the markers sit just outside the selection', () => {
  const r = run(toggleMark, 'alpha ==bravo== charlie', 8, 13) // "bravo", flanked by ==
  expect(r.doc).toBe('alpha bravo charlie')
})

test('toggleMark on an empty doc with no word does nothing', () => {
  expect(run(toggleMark, '', 0).handled).toBe(false)
})

// ── duplicateLine (⇧⌘D) ──────────────────────────────────────────────────────
test('duplicateLine copies the current line below', () => {
  const r = run(duplicateLine, 'one\ntwo\n', 1) // caret on "one"
  expect(r.handled).toBe(true)
  expect(r.doc).toBe('one\none\ntwo\n')
})

// ── joinLines (⌘⇧J) ──────────────────────────────────────────────────────────
test('joinLines joins the current line with the next by a single space', () => {
  const r = run(joinLines, 'one\ntwo\n', 1)
  expect(r.handled).toBe(true)
  expect(r.doc).toBe('one two\n')
})

test('joinLines collapses every line in a multi-line selection', () => {
  const r = run(joinLines, 'a\n  b\nc\n', 0, 6) // spans a, b, c; trims b's indent
  expect(r.doc).toBe('a b c\n')
})

// ── case transforms (palette-only, no keybinding) ─────────────────────────────
test('upperCase / lowerCase / titleCase transform the selection', () => {
  expect(run(upperCase, 'hello world', 0, 11).doc).toBe('HELLO WORLD')
  expect(run(lowerCase, 'HELLO World', 0, 11).doc).toBe('hello world')
  expect(run(titleCase, 'hello world', 0, 11).doc).toBe('Hello World')
})

test('case transforms fall back to the word under a bare caret', () => {
  expect(run(upperCase, 'alpha bravo', 8).doc).toBe('alpha BRAVO')
})

// ── selectBodyExceptMetadata (⌘A) ───────────────────────────────────────────
test('select all spares document-leading metadata and its separator', () => {
  const doc = '---\ntitle: River\n---\n\nBody one.\nBody two.'
  const r = run(selectBodyExceptMetadata, doc, doc.indexOf('Body two'))
  expect(r.handled).toBe(true)
  expect(doc.slice(r.from, r.to)).toBe('Body one.\nBody two.')
})

test('select all keeps normal whole-document behaviour without closed leading metadata', () => {
  for (const doc of ['Body only.', '---\nunclosed\nBody']) {
    const r = run(selectBodyExceptMetadata, doc, doc.length)
    expect([r.from, r.to]).toEqual([0, doc.length])
  }
})

// ── palette registry ─────────────────────────────────────────────────────────
test('paletteCommands exposes the case transforms as keyless palette rows', () => {
  const byId = new Map(paletteCommands.map((c) => [c.id, c]))
  for (const id of ['text.upperCase', 'text.lowerCase', 'text.titleCase']) {
    const entry = byId.get(id)
    expect(entry).toBeDefined()
    expect(entry!.keys).toBeUndefined()
    expect(typeof entry!.run).toBe('function')
  }
  // Bound commands carry their key hint for T13's palette rows.
  expect(byId.get('edit.mark')?.keys).toBe('Mod-e')
  expect(byId.get('edit.selectBodyExceptMetadata')?.keys).toBe('Mod-a')
})

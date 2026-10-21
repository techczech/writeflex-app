// Every caller of the editor's save (`window.writeflex.saveFile`, IPC `file:save`) says which version of the
// file its text was based on. These tests read the renderer and the preload and fail on a call that passes a
// stand-in basis, so a new route cannot bypass main's comparison by accident. The count of every caller,
// e2e specs included, is in save-callers-carry-a-basis-e2e.test.ts.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { callArguments, files } from '../helpers/save-call-arguments'

const ROOT = new URL('../..', import.meta.url).pathname

/** The basis each renderer call passes, as written: the one computed for it, never a stand-in. A
 *  hard-coded `{ kind: 'new' }` or an unrelated text in place of these fails here; what the computed basis
 *  is, is proved by behaviour (write-buffer.test.ts, resolution-routes.test.ts, unsaved-text.test.ts). */
const EXPECTED_BASIS: Record<string, string[]> = {
  'src/renderer/src/app/App.tsx': ['basis'], // write-buffer.ts: saveBasisFor(baselineDisk, notice, answered)
  'src/renderer/src/app/resolution-routes.ts': ['basis'], // basisFromBaseline(owner.baselineDiskOf(path)), read in the queue
  'src/renderer/src/app/unsaved-text.ts': ["{ kind: 'create' }", 'basisOf(path)'], // recovery copy; the document
  'src/renderer/src/main.tsx': ['basis'], // passes the caller's through
}

test('each renderer call passes the basis computed for it, not a stand-in', () => {
  const found: Record<string, string[]> = {}
  for (const path of files(join(ROOT, 'src/renderer'))) {
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(/\.saveFile\(/g)) {
      const args = callArguments(source, match.index + match[0].length - 1)
      ;(found[relative(ROOT, path)] ??= []).push(args[2] ?? '')
    }
  }
  expect(found).toEqual(EXPECTED_BASIS)
  const writeBuffer = readFileSync(join(ROOT, 'src/renderer/src/app/write-buffer.ts'), 'utf8')
  expect(writeBuffer).toContain('const basis = saveBasisFor(ports.baselineDisk(path), ports.notice(path), answered)')
  expect(writeBuffer).toContain('const result = await ports.save(path, doc, basis)')
  const redo = readFileSync(join(ROOT, 'src/renderer/src/app/resolution-routes.ts'), 'utf8')
  expect(redo).toContain('const basis = basisFromBaseline(owner.baselineDiskOf(path))')
})

test('every version restore from the renderer carries a basis (the restore replaces the open document)', () => {
  const found: string[] = []
  for (const path of files(join(ROOT, 'src/renderer'))) {
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(/\.restoreVersion\(/g)) {
      const args = callArguments(source, match.index + match[0].length - 1)
      found.push(`${relative(ROOT, path)}:${/\bbasis\s*:/.test(args[0] ?? '') ? 'basis' : 'NO BASIS'}`)
    }
  }
  expect(found).toEqual(['src/renderer/src/app/App.tsx:basis'])
})

test('the preload sends the basis over file:save', () => {
  const preload = readFileSync(join(ROOT, 'src/preload/index.ts'), 'utf8')
  expect(preload).toContain("saveFile: (path, content, basis) => ipcRenderer.invoke('file:save', { path, content, basis })")
})

test('every writing-goal write from the renderer carries the basis the flush left (goal:set)', () => {
  const found: string[] = []
  for (const path of files(join(ROOT, 'src/renderer'))) {
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(/\.setGoal\(/g)) {
      const args = callArguments(source, match.index + match[0].length - 1)
      found.push(`${relative(ROOT, path)}:${args[3] ?? 'NO BASIS'}`)
    }
  }
  expect(found).toEqual(['src/renderer/src/app/App.tsx:basisFromBaseline(snapshot.baselineDisk)'])
  const preload = readFileSync(join(ROOT, 'src/preload/index.ts'), 'utf8')
  expect(preload).toContain("setGoal: (path, target, due, basis) => ipcRenderer.invoke('goal:set', { path, target, due, basis })")
})

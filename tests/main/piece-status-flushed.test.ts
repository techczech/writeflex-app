// setPieceStatusFlushed (src/renderer/src/app/piece-status.ts; spec-folio-room-data-model § 3 D-STA-1, T-STATUS):
// the one renderer route to a piece's status. Driven with the real document owner and unsaved registry, fake
// editor ports and a main that compares bytes as main does (as tests/main/document-owner.test.ts).
import { describe, expect, it } from 'bun:test'
import { textForSave } from '../../src/shared/line-endings'
import { basisAllows } from '../../src/shared/save-basis'
import { createUnsavedRegistry } from '../../src/renderer/src/app/unsaved-registry'
import { createDocumentOwner } from '../../src/renderer/src/app/document-owner'
import { PIECE_STATUS_NOT_SAVED, setPieceStatusFlushed } from '../../src/renderer/src/app/piece-status'
import type { FileReadResult } from '../../src/preload'

const P = 'series/piece.md'
const START = '---\nstatus: idea\n---\n\n# Piece\n'
const withStatus = (text: string, status: string): string => text.replace(/status: [^\n]*/, `status: ${status}`)

function harness() {
  const h = { disk: START as string | null, buffer: START as string | null, saves: [] as string[], refuseSave: false }
  const owner = createDocumentOwner({
    buffer: (path) => (path === P ? h.buffer : null),
    notice: () => undefined,
    registry: createUnsavedRegistry(),
    write: async (_path, doc, basis) => {
      h.saves.push(doc)
      if (h.refuseSave) return { refused: 'disk-changed', diskText: h.disk, message: 'changed on disk' }
      const next = textForSave(doc, h.disk)
      if (!basisAllows(basis, h.disk)) return { refused: 'disk-changed', diskText: h.disk, message: 'changed on disk' }
      h.disk = next
      return { content: next, written: next }
    },
    setReadOnly: () => {},
    forgetBuffer: () => { h.buffer = null },
    renameBuffer: () => {},
    replaceBuffer: (path, diskText) => { if (path === P) h.buffer = diskText },
    dirtyChanged: () => {},
    report: { slow: () => {}, refusedByNotice: () => {}, refusedByMain: () => {}, diskChanged: () => {}, saved: () => {}, outsideAfterWrite: () => {}, unknown: () => {} },
  })
  owner.activated(P, START, () => h.buffer as string)
  const type = (text: string): void => { h.buffer = text; owner.edited(P, text) }
  /** Main's status route: plans from the disk as it is when called and writes over it. */
  const calls: Array<{ dir: string; path: string; status: string; diskWhenCalled: string | null }> = []
  let during: (() => void) | null = null
  const setStatus = async (dir: string, path: string, status: string): Promise<FileReadResult> => {
    calls.push({ dir, path, status, diskWhenCalled: h.disk })
    during?.()
    const next = withStatus(h.disk as string, status)
    h.disk = next
    return { file: { path, name: 'piece.md' } as FileReadResult['file'], content: next, written: next } as FileReadResult
  }
  return { h, owner, type, setStatus, calls, setDuring: (fn: () => void) => { during = fn } }
}

describe('setPieceStatusFlushed', () => {
  it('flushes unsaved text first, writes the status over it, and the editor takes main’s text', async () => {
    const { h, owner, type, setStatus, calls } = harness()
    type(`${START}\nTyped, not yet saved.\n`)
    const saved = await setPieceStatusFlushed(owner, setStatus, 'series', P, 'editing')
    expect(h.saves).toEqual([`${START}\nTyped, not yet saved.\n`])
    expect(calls).toEqual([{ dir: 'series', path: P, status: 'editing', diskWhenCalled: `${START}\nTyped, not yet saved.\n` }])
    const expected = `---\nstatus: editing\n---\n\n# Piece\n\nTyped, not yet saved.\n`
    expect(saved.content).toBe(expected)
    expect(h.disk).toBe(expected)
    expect(h.buffer).toBe(expected)
    expect(owner.isSaved(P)).toBe(true)
  })

  it('a keystroke typed while main writes the status is kept, not replaced', async () => {
    const { h, owner, type, setStatus, setDuring } = harness()
    setDuring(() => type(`${START}\nTyped during the write.\n`))
    await setPieceStatusFlushed(owner, setStatus, 'series', P, 'editing')
    expect(h.disk).toBe(withStatus(START, 'editing'))
    expect(h.buffer).toBe(`${START}\nTyped during the write.\n`)
    expect(owner.isSaved(P)).toBe(false)
  })

  it('a buffer that could not be written first stops the route: no status write, the plain answer', async () => {
    const { h, owner, type, setStatus, calls } = harness()
    type(`${START}\nTyped.\n`)
    h.refuseSave = true
    await expect(setPieceStatusFlushed(owner, setStatus, 'series', P, 'editing')).rejects.toThrow(PIECE_STATUS_NOT_SAVED)
    expect(calls).toEqual([])
    expect(h.disk).toBe(START)
    expect(h.buffer).toBe(`${START}\nTyped.\n`)
  })

  it('main’s refusal reaches the caller and leaves the editor’s text as it was', async () => {
    const { h, owner, calls } = harness()
    const refusing = async (dir: string, path: string, status: string): Promise<FileReadResult> => {
      calls.push({ dir, path, status, diskWhenCalled: h.disk })
      throw new Error("Error invoking remote method 'collection:set-status': Error: Could not save this document. Try again.")
    }
    await expect(setPieceStatusFlushed(owner, refusing, 'series', P, 'ready')).rejects.toThrow('Could not save this document. Try again.')
    expect(calls).toHaveLength(1)
    expect(h.buffer).toBe(START)
    expect(h.disk).toBe(START)
  })

  it('a piece with no open buffer is written once, with no flush', async () => {
    const { h, owner, setStatus, calls } = harness()
    const other = 'series/other.md'
    h.disk = START
    await setPieceStatusFlushed(owner, setStatus, 'series', other, 'ready')
    expect(h.saves).toEqual([])
    expect(calls.map((call) => call.path)).toEqual([other])
    expect(h.buffer).toBe(START) // the open piece's editor is untouched
  })
})

it('no renderer code calls the status IPC itself: every status write goes through setPieceStatusFlushed', async () => {
  const { Glob } = await import('bun')
  const callers: string[] = []
  for await (const file of new Glob('src/renderer/src/**/*.{ts,tsx}').scan({ cwd: new URL('../..', import.meta.url).pathname })) {
    const text = await Bun.file(new URL(`../../${file}`, import.meta.url)).text()
    if (/collection\.setStatus\(/.test(text)) callers.push(file)
  }
  expect(callers).toEqual([])
})

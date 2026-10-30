import { registerRoomPending } from '../../src/renderer/src/folio-room-pending'
// The page's record of unsaved text and its one close gate (src/renderer/src/app/unsaved-text.ts; rules
// R-A and R-B of docs/plans/quit-does-not-stall/quit-and-window-close-spec.md): what a window whose app
// has broken still knows, and that no route lets the window go while text is unsaved or being written.
import { beforeEach, describe, expect, it } from 'bun:test'
import { flushUntilClean } from '../../src/renderer/src/app/close-flush'
import {
  closeWindowIfClean, closeWithEditor, closeWithoutEditor, editorIsPresent, installUnsavedText, queueCloseRetry, resetUnsavedTextForTests, saveUnsavedText,
  setEditorPresent, takeCloseRetry, setSaveBasisSource, unsaved, unsavedFileNames, unsavedStatus, unsavedTextForClipboard, watchUnsaved,
} from '../../src/renderer/src/app/unsaved-text'
import { basisAllows, type SaveBasis } from '../../src/shared/save-basis'
import { isConflictCopyOf, recoveryCopyPath } from '../../src/shared/conflict-copy'

/** A page: its disk, the calls it makes to main, and writes that can be failed, refused or held. */
function fakePage(options: { failing?: string[]; refusing?: string[]; failingText?: string[]; readsBack?: Record<string, string>; writtenAs?: Record<string, string>; notReadBack?: string[]; outside?: Record<string, string> } = {}) {
  const disk = new Map<string, string>()
  const calls: string[] = []
  const bases: Array<[string, SaveBasis]> = []
  const held: Array<() => void> = []
  let holding = false
  let request: (() => void) | null = null
  let abandonListener: (() => void) | null = null
  const saveFile = async (path: string, content: string, basis: SaveBasis = { kind: 'new' }) => {
    bases.push([path, basis])
    if (holding) await new Promise<void>((resolve) => { held.push(resolve) })
    if (options.failing?.includes(path) || options.failingText?.includes(content)) throw new Error('EACCES')
    // `outside`: files (or, as FOLDER, folders) another program holds on disk. As main does, a write is made
    // over one only when its basis names that version; a recovery copy (basis `create`) only where nothing is.
    if (basis.kind === 'create' && (disk.has(path) || (options.outside && path in options.outside))) {
      return { refused: 'name-taken' as const, path, message: `${path} already exists` }
    }
    if (options.outside && (path in options.outside || basis.kind === 'new' && disk.has(path))) {
      const there = options.outside?.[path] ?? disk.get(path) ?? null
      if (!basisAllows(basis, there)) return { refused: 'disk-changed' as const, path, diskText: there, message: 'changed on disk' }
    }
    if (options.refusing?.includes(path)) return { refused: true as const }
    // `writtenAs`: the bytes main writes for this text (the file's own line endings and BOM restored).
    // `readsBack`: what the file holds when the save reads it back, when another program wrote it after.
    const wrote = options.writtenAs?.[path] ?? content
    const onDisk = options.readsBack?.[path] ?? wrote
    disk.set(path, onDisk)
    // `notReadBack`: the write is made and its readback fails, as main's SavedButNotReadBack reaches a page.
    if (options.notReadBack?.includes(path)) throw new Error(`Error invoking remote method 'file:save': SavedButNotReadBack: ${path} was saved, but could not be read back afterwards (EIO).`)
    return { content: onDisk, written: wrote }
  }
  const api = {
    saveFile,
    onCloseRequested: (fn: () => void) => { request = fn; return () => { request = null } },
    acknowledgeClose: async () => { calls.push('ack') },
    closeWindow: async (opts?: { checkpoint?: string[] }) => { calls.push(`close:${(opts?.checkpoint ?? []).join(',')}`) },
    closeUnsaved: async () => { calls.push('unsaved') },
    onAbandonClose: (fn: () => void) => { abandonListener = fn; return () => { abandonListener = null } },
    acknowledgeAbandonClose: async () => { calls.push('abandon-ack') },
  }
  installUnsavedText(api)
  /** The mounted editor's write of one path, as App.tsx makes it: announced when the buffer is read. */
  const editorWrite = async (path: string, text: string): Promise<boolean> => {
    const write = unsaved.beginWrite(path, text)
    try {
      const result = await saveFile(path, text)
      if ('refused' in result) { write.failed(); return false }
      write.succeeded()
      return true
    } catch { write.unknown(); return false }
  }
  return {
    api, disk, calls, bases, options, editorWrite,
    requestClose: () => request?.(),
    /** Main calls the close off (window:abandon-close). */
    abandon: () => abandonListener?.(),
    hold: () => { holding = true },
    release: () => { holding = false; for (const go of held.splice(0)) go() },
  }
}
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)) }

/** The app's flush as App.tsx wires it: unsaved paths from the registry while the editor is present. */
const flushWith = (save: (path: string) => Promise<boolean>) => () =>
  flushUntilClean({ unsaved: () => (editorIsPresent() ? unsaved.pending() : []), save })

beforeEach(() => resetUnsavedTextForTests())

describe('the gate: the one sender of window:close', () => {
  it('sends when nothing is unsaved and nothing is being written', () => {
    const page = fakePage()
    expect(closeWindowIfClean({ checkpoint: ['a.md'] })).toBe(true)
    expect(page.calls).toEqual(['close:a.md'])
  })

  it('does not send while a document is unsaved', () => {
    const page = fakePage()
    unsaved.typed('a.md', 'text')
    expect(closeWindowIfClean()).toBe(false)
    expect(page.calls).toEqual([])
  })

  it('does not send while a write is in flight, even with no document unsaved', async () => {
    const page = fakePage()
    page.hold()
    const writing = page.editorWrite('a.md', 'same as disk')
    expect(closeWindowIfClean()).toBe(false)
    page.release()
    await writing
    expect(closeWindowIfClean()).toBe(true)
    expect(page.calls).toEqual(['close:'])
  })

  it('reads the registry at the moment it is asked, not what a caller saw earlier', () => {
    const page = fakePage()
    expect(unsaved.clean()).toBe(true) // what a flush that just finished would report
    unsaved.typed('a.md', 'typed in the same turn')
    expect(closeWindowIfClean()).toBe(false)
    expect(page.calls).toEqual([])
  })
})

describe('writing what the registry holds', () => {
  it('writes each entry and removes it', async () => {
    const page = fakePage()
    unsaved.typed('a.md', 'typed last')
    expect(await saveUnsavedText()).toEqual({ written: ['a.md'], left: [], copied: [] })
    expect(page.disk.get('a.md')).toBe('typed last')
  })

  it('writes behind the editor’s own write in flight, so the older text cannot land last', async () => {
    const page = fakePage()
    unsaved.typed('a.md', 'older text')
    page.hold()
    const editor = page.editorWrite('a.md', 'older text')
    unsaved.typed('a.md', 'newer text')
    const saved = saveUnsavedText()
    await settle()
    expect(page.disk.has('a.md')).toBe(false) // waiting behind the editor's write
    page.release()
    await editor
    expect(await saved).toEqual({ written: ['a.md'], left: [], copied: [] })
    expect(page.disk.get('a.md')).toBe('newer text')
  })

  it('a failed or refused write stays unsaved', async () => {
    const page = fakePage({ failing: ['fails.md'], refusing: ['refused.md'] })
    for (const path of ['fails.md', 'refused.md', 'ok.md']) unsaved.typed(path, path)
    expect(await saveUnsavedText()).toEqual({ written: ['ok.md'], left: ['fails.md', 'refused.md'], copied: [] })
    expect(page.disk.has('fails.md')).toBe(false)
  })

  it('a save that reads back other text (another program wrote the file) stays unsaved, and a close asks', async () => {
    const page = fakePage({ readsBack: { 'a.md': 'written by another program' } })
    unsaved.typed('a.md', 'typed last')
    expect(await saveUnsavedText()).toEqual({ written: [], left: ['a.md'], copied: [] })
    expect(unsaved.textOf('a.md')).toBe('typed last')
    expect(closeWindowIfClean()).toBe(false)
    page.requestClose()
    await settle()
    expect(page.calls).toEqual(['ack', 'unsaved']) // asked, not closed and not left waiting
  })

  it('a save that reads back the same text with the file’s own line endings and BOM is saved', async () => {
    const page = fakePage({ writtenAs: { 'a.md': '\uFEFFone\r\ntwo\r\n' } })
    unsaved.typed('a.md', 'one\ntwo\n')
    expect(await saveUnsavedText()).toEqual({ written: ['a.md'], left: [], copied: [] })
    expect(unsaved.clean()).toBe(true)
    page.requestClose()
    await settle()
    expect(page.calls).toEqual(['ack', 'close:a.md'])
  })

  // Review round 3, finding 3: the write was made, its readback failed, and the app's saved baseline
  // still holds what was on disk before it.
  it('a save that was made but not read back, then undo to the old saved text: held, and a close asks', async () => {
    const page = fakePage({ notReadBack: ['a.md'] })
    page.disk.set('a.md', 'A')
    unsaved.typed('a.md', 'B')
    expect(await saveUnsavedText()).toEqual({ written: [], left: ['a.md'], copied: [] })
    expect(page.disk.get('a.md')).toBe('B') // the write happened
    unsaved.matchesDisk('a.md', 'A') // undo: the buffer equals the baseline, which is no longer the disk
    expect(unsaved.textOf('a.md')).toBe('A')
    expect(closeWindowIfClean()).toBe(false)
    page.requestClose()
    await settle()
    expect(page.calls).toEqual(['ack', 'unsaved'])

    // A save that is read back ends it: A is on disk, and the window may go.
    page.options.notReadBack = []
    expect(await saveUnsavedText()).toEqual({ written: ['a.md'], left: [], copied: [] })
    expect(page.disk.get('a.md')).toBe('A')
    expect(closeWindowIfClean()).toBe(true)
  })

  it('the same through the mounted editor’s write: undo after it does not let the window go', async () => {
    const page = fakePage({ notReadBack: ['a.md'] })
    page.disk.set('a.md', 'A')
    setEditorPresent(true)
    unsaved.typed('a.md', 'B')
    expect(await page.editorWrite('a.md', 'B')).toBe(false)
    unsaved.matchesDisk('a.md', 'A') // the undo, as App.tsx reports a buffer equal to its baseline
    const outcome = await closeWithEditor({
      flush: flushWith(async () => true), // a flush that writes nothing, to show the gate alone decides
      checkpoint: () => [],
    })
    expect(outcome.outcome).toBe('still-unsaved')
    expect(page.calls).toEqual([])

    page.options.notReadBack = []
    const closed = await closeWithEditor({
      flush: flushWith((path) => page.editorWrite(path, unsaved.textOf(path) ?? '')),
      checkpoint: () => [],
    })
    expect(closed.outcome).toBe('closed')
    expect(page.disk.get('a.md')).toBe('A')
  })

  it('a save that reads back other text, then undo to the old saved text: still held', async () => {
    fakePage({ readsBack: { 'a.md': 'written by another program' } })
    unsaved.typed('a.md', 'B')
    await saveUnsavedText()
    unsaved.matchesDisk('a.md', 'A') // the baseline is A; the disk is neither A nor B
    expect(unsaved.textOf('a.md')).toBe('A')
    expect(closeWindowIfClean()).toBe(false)
  })
})

describe('a close request when the app is not mounted', () => {
  it('while the app is mounted it does nothing: the app answers', async () => {
    const page = fakePage()
    setEditorPresent(true)
    unsaved.typed('a.md', 'text')
    page.requestClose()
    await settle()
    expect(page.calls).toEqual([])
  })

  it('nothing unsaved: acknowledges and lets the window go', async () => {
    const page = fakePage()
    page.requestClose()
    await settle()
    expect(page.calls).toEqual(['ack', 'close:'])
  })

  it('text typed before the app broke is written first, then the window goes', async () => {
    const page = fakePage()
    setEditorPresent(true)
    unsaved.typed('a.md', 'typed inside the auto-save delay')
    setEditorPresent(false)
    page.requestClose()
    await settle()
    expect(page.disk.get('a.md')).toBe('typed inside the auto-save delay')
    expect(page.calls).toEqual(['ack', 'close:a.md'])
  })

  it('text that cannot be written: the person is asked; the window is never let go from here', async () => {
    const page = fakePage({ failing: ['a.md'] })
    unsaved.typed('a.md', 'cannot be written')
    page.requestClose()
    await settle()
    expect(page.calls).toEqual(['ack', 'unsaved'])
    // The next request tries the write again; once it works the window goes.
    page.options.failing = []
    page.requestClose()
    await settle()
    expect(page.calls).toEqual(['ack', 'unsaved', 'ack', 'close:a.md'])
    expect(page.disk.get('a.md')).toBe('cannot be written')
  })

  it('a second request during the first joins it: one write, one answer', async () => {
    const page = fakePage()
    unsaved.typed('a.md', 'text')
    page.hold()
    page.requestClose()
    page.requestClose()
    await settle()
    page.release()
    await settle()
    expect(page.calls).toEqual(['ack', 'ack', 'close:a.md'])
  })
})

describe('the mounted app’s close', () => {
  it('nothing unsaved: closed, with the checkpoint list', async () => {
    const page = fakePage()
    setEditorPresent(true)
    const result = await closeWithEditor({ flush: flushWith(async () => true), checkpoint: () => ['a.md'] })
    expect(result).toEqual({ outcome: 'closed', failed: 0 })
    expect(page.calls).toEqual(['close:a.md'])
  })

  it('a failed write: not closed', async () => {
    const page = fakePage({ failing: ['a.md'] })
    setEditorPresent(true)
    unsaved.typed('a.md', 'text')
    const result = await closeWithEditor({ flush: flushWith((path) => page.editorWrite(path, unsaved.textOf(path)!)), checkpoint: () => [] })
    expect(result).toEqual({ outcome: 'save-failed', failed: 1 })
    expect(page.calls).toEqual([])
  })

  it('a flush that reports success while the registry still holds text: not closed (the flush’s word is not the decision)', async () => {
    const page = fakePage()
    setEditorPresent(true)
    unsaved.typed('a.md', 'text')
    const result = await closeWithEditor({ flush: async () => ({ flushed: ['a.md'], failed: 0 }), checkpoint: () => [] })
    expect(result.outcome).toBe('still-unsaved')
    expect(page.calls).toEqual([])
  })

  it('unmounted while the flush ran, nothing left unsaved: handed over, and the page’s own close lets the window go', async () => {
    const page = fakePage()
    setEditorPresent(true)
    const result = await closeWithEditor({ flush: async () => { setEditorPresent(false); return { flushed: [], failed: 0 } }, checkpoint: () => ['never used'] })
    expect(result.outcome).toBe('handed-over')
    await settle()
    expect(page.calls).toEqual(['close:'])
  })
})

describe('the two failures review round 2 found, end to end in the page', () => {
  // "Disk contains A. The writer changes it to B, starts saving B, then undoes back to A. The registry
  // entry disappears. The app errors before B finishes; B subsequently overwrites A. The standing close
  // handler sees an empty registry and closes without asking."
  it('finding 1: after undo during a save and an app error, the disk ends on A before the window goes', async () => {
    const page = fakePage()
    page.disk.set('a.md', 'A')
    setEditorPresent(true)
    unsaved.typed('a.md', 'B')
    page.hold()
    const savingB = page.editorWrite('a.md', 'B')
    unsaved.matchesDisk('a.md', 'A') // undo back to what was on disk
    setEditorPresent(false) // the app errors before B finishes
    void saveUnsavedText() // the save made on the error
    page.requestClose()
    await settle()
    expect(page.calls).toEqual(['ack']) // not closed while B is in flight
    page.release() // B lands, over A
    await savingB
    await settle()
    expect(page.disk.get('a.md')).toBe('A')
    expect(unsaved.clean()).toBe(true)
    expect(page.calls).toEqual(['ack', 'close:a.md'])
  })

  it('finding 1, when A cannot be written back: the person is asked', async () => {
    const page = fakePage({ failingText: ['A'] }) // B can be written; A cannot be written back
    page.disk.set('a.md', 'A')
    setEditorPresent(true)
    unsaved.typed('a.md', 'B')
    page.hold()
    const savingB = page.editorWrite('a.md', 'B')
    unsaved.matchesDisk('a.md', 'A')
    setEditorPresent(false)
    page.requestClose()
    await settle()
    page.release()
    await savingB
    await settle()
    expect(page.disk.get('a.md')).toBe('B')
    expect(page.calls).toEqual(['ack', 'unsaved'])
  })

  // "Close starts saving B. The writer types C during that write, then the app errors and unmounts. B
  // succeeds; recovery of C fails. The original close callback nevertheless considers the document clean
  // and closes."
  it('finding 2: the close that began before the unmount asks instead of closing', async () => {
    const page = fakePage({ failingText: ['C'] }) // B succeeds; recovery of C fails
    setEditorPresent(true)
    unsaved.typed('a.md', 'B')
    page.hold()
    // The close's flush, as App.tsx wires it: the editor writes its buffer; once unmounted it has no
    // buffer to read and writes nothing (on the old code this is where the saved content that came
    // back from the write of B stood in for the missing buffer, and the document was called clean).
    const closing = closeWithEditor({
      flush: flushWith((path) => (editorIsPresent() ? page.editorWrite(path, 'B') : Promise.resolve(true))),
      checkpoint: (flushed) => flushed,
    })
    await settle()
    unsaved.typed('a.md', 'C') // typed during the write of B
    setEditorPresent(false) // the app errors and unmounts
    const recovery = saveUnsavedText() // the save made on the error
    await settle()
    page.release() // B succeeds
    await recovery
    expect((await closing).outcome).toBe('handed-over')
    await settle()
    expect(page.disk.get('a.md')).toBe('B')
    expect(unsaved.textOf('a.md')).toBe('C')
    expect(page.calls).toEqual(['unsaved']) // asked; `close` was never sent
  })
})
describe('what the error screen is told', () => {
  it('safe only when nothing is held and nothing is being written; saving while a run is going', async () => {
    const page = fakePage({ failing: ['a.md'] })
    expect(unsavedStatus()).toEqual({ saving: false, safe: true, documents: [], copies: [] })
    unsaved.typed('a.md', 'held')
    let told = 0
    const stop = watchUnsaved(() => { told += 1 })
    const run = saveUnsavedText()
    expect(unsavedStatus().saving).toBe(true)
    await run
    await settle()
    expect(unsavedStatus()).toEqual({ saving: false, safe: false, documents: [{ path: 'a.md', text: 'held' }], copies: [] })
    expect(told).toBeGreaterThan(0)
    stop()
    page.options.failing = []
    await saveUnsavedText()
    expect(unsavedStatus().safe).toBe(true)
  })

  it('names files by base name, and gives the text for the clipboard', () => {
    const one = [{ path: 'notes/one.md', text: 'first' }]
    const three = [...one, { path: 'two.md', text: 'second' }, { path: 'deep/er/three.md', text: 'third' }]
    expect(unsavedFileNames(one)).toBe('one.md')
    expect(unsavedFileNames(three.slice(0, 2))).toBe('one.md and two.md')
    expect(unsavedFileNames(three)).toBe('one.md, two.md and three.md')
    expect(unsavedTextForClipboard(one)).toBe('first')
    expect(unsavedTextForClipboard(three.slice(0, 2))).toBe('one.md\n\nfirst\n\n\ntwo.md\n\nsecond')
  })
})

describe('with no page installed', () => {
  it('nothing is sent and nothing is written', async () => {
    unsaved.typed('a.md', 'text')
    expect(closeWindowIfClean()).toBe(false)
    expect(await saveUnsavedText()).toEqual({ written: [], left: ['a.md'], copied: [] })
    await closeWithoutEditor()
  })
})

describe('error recovery writes only over the version the text was based on', () => {
  const SEEN = 'The version the writer saw.\n'
  const OUTSIDE = 'Another program wrote this.\n'
  const MINE = 'The version the writer saw, and more.\n'

  it('every write carries the baseline the app gave for its document', async () => {
    const page = fakePage()
    setSaveBasisSource((path) => (path === 'a.md' ? { kind: 'disk', text: SEEN } : { kind: 'new' }))
    unsaved.typed('a.md', MINE)
    unsaved.typed('b.md', 'New text.\n')
    await saveUnsavedText()
    expect(page.bases).toEqual([['a.md', { kind: 'disk', text: SEEN }], ['b.md', { kind: 'new' }]])
  })

  it('a file changed on disk is left as it is; the text goes to a recovery copy beside it, listed for the error screen', async () => {
    const page = fakePage({ outside: { 'notes/a.md': OUTSIDE } })
    setSaveBasisSource(() => ({ kind: 'disk', text: SEEN }))
    unsaved.typed('notes/a.md', MINE)
    const result = await saveUnsavedText()
    expect(page.disk.has('notes/a.md')).toBe(false) // never written over
    expect(page.disk.get('notes/a (WriteFlex recovery).md')).toBe(MINE)
    expect(result.copied).toEqual([{ path: 'notes/a.md', copyPath: 'notes/a (WriteFlex recovery).md' }])
    expect(result.written).toEqual([])
    // The text is on disk in the copy: it no longer holds the close, and the screen says where it is.
    expect(unsavedStatus()).toMatchObject({ safe: true, documents: [], copies: [{ path: 'notes/a.md', copyPath: 'notes/a (WriteFlex recovery).md' }] })
  })

  it('a recovery-copy name already taken: the next one, never over the taken file', async () => {
    const page = fakePage({ outside: { 'a.md': OUTSIDE, 'a (WriteFlex recovery).md': 'An earlier copy.\n' } })
    setSaveBasisSource(() => ({ kind: 'disk', text: SEEN }))
    unsaved.typed('a.md', MINE)
    const result = await saveUnsavedText()
    expect(result.copied).toEqual([{ path: 'a.md', copyPath: 'a (WriteFlex recovery 2).md' }])
    expect(page.disk.has('a (WriteFlex recovery).md')).toBe(false)
    expect(page.disk.get('a (WriteFlex recovery 2).md')).toBe(MINE)
  })

  it('recovery copies are created exclusively: an empty file or a folder at the name is never replaced, the next name is tried (Sol S7)', async () => {
    const page = fakePage({ outside: { 'a.md': OUTSIDE, 'a (WriteFlex recovery).md': '', 'a (WriteFlex recovery 2).md': 'FOLDER' } })
    setSaveBasisSource(() => ({ kind: 'disk', text: SEEN }))
    unsaved.typed('a.md', MINE)
    const result = await saveUnsavedText()
    expect(page.bases.filter(([path]) => path.includes('recovery')).map(([, basis]) => basis.kind)).toEqual(['create', 'create', 'create'])
    expect(result.copied).toEqual([{ path: 'a.md', copyPath: 'a (WriteFlex recovery 3).md' }])
    expect(page.disk.has('a (WriteFlex recovery).md')).toBe(false)
    expect(page.disk.get('a (WriteFlex recovery 3).md')).toBe(MINE)
  })

  it('a readback that differs from what main wrote is another program\'s write, even when it equals the text as a document (Sol M1)', async () => {
    const page = fakePage({ readsBack: { 'a.md': 'Mine.\r\n' } })
    setSaveBasisSource(() => ({ kind: 'disk', text: SEEN }))
    unsaved.typed('a.md', 'Mine.\n')
    const result = await saveUnsavedText()
    expect(page.disk.get('a.md')).toBe('Mine.\r\n')
    expect(result.written).toEqual([])
    expect(unsaved.textOf('a.md')).toBe('Mine.\n') // held: a close asks
  })

  it('the copy cannot be written either: the text stays held, and a close asks', async () => {
    const page = fakePage({ outside: { 'a.md': OUTSIDE }, failing: ['a (WriteFlex recovery).md'] })
    setSaveBasisSource(() => ({ kind: 'disk', text: SEEN }))
    unsaved.typed('a.md', MINE)
    const result = await saveUnsavedText()
    expect(result.copied).toEqual([])
    expect(result.left).toEqual(['a.md'])
    expect(unsaved.textOf('a.md')).toBe(MINE)
    await closeWithoutEditor()
    expect(page.calls).toEqual(['unsaved'])
  })

  it('names recovery copies by the conflict-copy convention', () => {
    expect(recoveryCopyPath('notes.md')).toBe('notes (WriteFlex recovery).md')
    expect(recoveryCopyPath('a/b/Chapter 1.markdown', 3)).toBe('a/b/Chapter 1 (WriteFlex recovery 3).markdown')
    expect(recoveryCopyPath('plain')).toBe('plain (WriteFlex recovery)')
    for (const attempt of [1, 2, 12]) expect(isConflictCopyOf(recoveryCopyPath('dir/notes.md', attempt), 'dir/notes.md')).toBe(true)
  })
})

// Vaults 06 review round 2: main calls off a close it asked for (the vault switcher's bound). The page's
// flush may still finish well afterwards; it must then send nothing, and it acknowledges at once.
describe('a close main calls off', () => {
  it('the mounted app\'s close: the flush ends after the call-off, nothing is sent', async () => {
    const page = fakePage()
    setEditorPresent(true)
    unsaved.typed('a.md', 'slow to write')
    page.hold()
    const closing = closeWithEditor({ flush: flushWith((path) => page.editorWrite(path, unsaved.textOf(path)!)), checkpoint: () => ['a.md'] })
    await settle()
    page.abandon()
    page.release()
    expect(await closing).toEqual({ outcome: 'abandoned', failed: 0 })
    expect(page.calls).toEqual(['abandon-ack'])
    expect(page.disk.get('a.md')).toBe('slow to write') // the text is still written
  })

  it('a close begun after the call-off is a new close and goes as usual', async () => {
    const page = fakePage()
    setEditorPresent(true)
    page.abandon()
    const result = await closeWithEditor({ flush: flushWith(async () => true), checkpoint: () => [] })
    expect(result.outcome).toBe('closed')
    expect(page.calls).toEqual(['abandon-ack', 'close:'])
  })

  it('a page whose app is not mounted: nothing sent after the call-off, not even the question', async () => {
    const page = fakePage({ failing: ['a.md'] })
    unsaved.typed('a.md', 'cannot be written')
    page.hold()
    page.requestClose()
    await settle()
    page.abandon()
    page.release()
    await settle()
    expect(page.calls).toEqual(['ack', 'abandon-ack'])
  })
})

/** The mounted app's close handler as App.tsx wires it: one close at a time; a request that arrives
 *  while one runs is queued and run when that close ends abandoned, if still wanted. */
function appCloseHandler(flush: () => Promise<{ flushed: string[]; failed: number }>) {
  let inFlight = false
  const onRequest = async (): Promise<void> => {
    if (inFlight) { queueCloseRetry(); return }
    inFlight = true
    void takeCloseRetry()
    let abandoned = false
    try {
      const { outcome } = await closeWithEditor({ flush, checkpoint: () => [] })
      abandoned = outcome === 'abandoned'
    } finally {
      inFlight = false
      if (takeCloseRetry() && abandoned) void onRequest()
    }
  }
  return onRequest
}

// Vaults 06 review round 3.
describe('a queued close request and the call-off (S1)', () => {
  it('two switches called off while one save is pending: the queued request does not close the window afterwards', async () => {
    const page = fakePage()
    setEditorPresent(true)
    unsaved.typed('a.md', 'slow to write')
    page.hold()
    const request = appCloseHandler(flushWith((path) => page.editorWrite(path, unsaved.textOf(path)!)))
    void request() // switch 1 asks the window to close
    await settle()
    page.abandon() // switch 1 reaches its bound
    void request() // switch 2 asks: queued behind the running close
    page.abandon() // switch 2 reaches its bound too; both targets are discarded
    page.release() // the save finally finishes
    await settle()
    expect(page.calls).toEqual(['abandon-ack', 'abandon-ack'])
    expect(page.calls.some((call) => call.startsWith('close:'))).toBe(false)
  })

  it('a request queued after one call-off, with none after it, still runs once the abandoned close ends', async () => {
    const page = fakePage()
    setEditorPresent(true)
    unsaved.typed('a.md', 'slow to write')
    page.hold()
    const request = appCloseHandler(flushWith((path) => page.editorWrite(path, unsaved.textOf(path)!)))
    void request()
    await settle()
    page.abandon()
    void request() // switch 2, still live
    page.release()
    await settle()
    expect(page.calls).toEqual(['abandon-ack', 'close:'])
  })

  it('takeCloseRetry forgets the request either way', () => {
    fakePage()
    expect(takeCloseRetry()).toBe(false)
    queueCloseRetry()
    expect(takeCloseRetry()).toBe(true)
    expect(takeCloseRetry()).toBe(false)
  })
})

describe('documents detached for a close main then calls off (S2)', () => {
  it('window:close sent and documents detached before the call-off arrived: they are attached again', async () => {
    const page = fakePage()
    setEditorPresent(true)
    const readOnly = new Set<string>()
    const result = await closeWithEditor({
      flush: flushWith(async () => true),
      checkpoint: () => [],
      closing: () => { readOnly.add('a.md') },
      reopen: () => { readOnly.delete('a.md') },
    })
    expect(result.outcome).toBe('closed')
    expect(readOnly.has('a.md')).toBe(true)
    page.abandon() // main had reached its bound and drops the window:close
    expect(readOnly.has('a.md')).toBe(false)
    expect(page.calls).toEqual(['close:', 'abandon-ack'])
  })

  it('reattaches once, and not for a close that detached nothing', async () => {
    const page = fakePage()
    setEditorPresent(true)
    let reopened = 0
    await closeWithEditor({ flush: flushWith(async () => true), checkpoint: () => [], closing: () => {}, reopen: () => { reopened += 1 } })
    page.abandon()
    page.abandon()
    expect(reopened).toBe(1)
    unsaved.typed('b.md', 'typed after')
    const kept = await closeWithEditor({ flush: async () => ({ flushed: [], failed: 0 }), checkpoint: () => [], closing: () => {}, reopen: () => { reopened += 1 } })
    expect(kept.outcome).toBe('still-unsaved')
    page.abandon()
    expect(reopened).toBe(1)
  })
})

it('the final close gate refuses notes typed after the room flush and refuses a no-tabs shortcut', async () => {
 const page = fakePage(); setEditorPresent(true)
 let dirty = false
 const off = registerRoomPending({path:'paper/evidence.md',dirty:()=>dirty,flush:async()=>{dirty=false;return true}})
 try {
  const result = await closeWithEditor({flush:async()=>{dirty=true;return {flushed:[],failed:0}},checkpoint:()=>[]})
  expect(result.outcome).toBe('still-unsaved');expect(page.calls).toEqual([])
  expect(closeWindowIfClean()).toBe(false)
  dirty=false;expect(closeWindowIfClean()).toBe(true)
 } finally {dirty=false;off()}
})

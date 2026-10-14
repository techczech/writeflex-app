// Which documents hold text not confirmed on disk (src/renderer/src/app/unsaved-registry.ts, rule R-A of
// docs/plans/quit-and-window-close-spec.md). The registry is driven with the events a window produces,
// in every order that matters: typing, undo back to the saved text, a write starting, succeeding or
// failing, the app going away (which is no event here at all), and what a close would then find.
import { describe, expect, it } from 'bun:test'
import { createUnsavedRegistry } from '../../src/renderer/src/app/unsaved-registry'

const P = 'a.md'

describe('an entry is the latest text not confirmed on disk', () => {
  it('nothing typed: clean', () => {
    const r = createUnsavedRegistry()
    expect(r.clean()).toBe(true)
    expect(r.paths()).toEqual([])
    expect(r.textOf(P)).toBeUndefined()
  })

  it('typing makes an entry and later typing replaces its text', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'B')
    r.typed(P, 'B more')
    expect(r.paths()).toEqual([P])
    expect(r.textOf(P)).toBe('B more')
    expect(r.clean()).toBe(false)
  })

  it('type, write starts, write succeeds: the entry goes', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'B')
    const write = r.beginWrite(P, 'B')
    expect(r.clean()).toBe(false)
    write.succeeded()
    expect(r.clean()).toBe(true)
  })

  it('type, write starts, write fails: the entry stays', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'B')
    r.beginWrite(P, 'B').failed()
    expect(r.textOf(P)).toBe('B')
    expect(r.clean()).toBe(false)
  })

  it('typing during a write: the write of the older text succeeds and the entry stays, with the newer text', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'B')
    const write = r.beginWrite(P, 'B')
    r.typed(P, 'C')
    write.succeeded()
    expect(r.textOf(P)).toBe('C')
    // Only a write of C removes it.
    r.beginWrite(P, 'C').succeeded()
    expect(r.clean()).toBe(true)
  })

  it('a write in flight with no entry is still not clean, and is until it settles either way', () => {
    for (const end of ['succeeded', 'failed'] as const) {
      const r = createUnsavedRegistry()
      const write = r.beginWrite(P, 'same as disk')
      expect(r.paths()).toEqual([])
      expect(r.pending()).toEqual([P])
      expect(r.clean()).toBe(false)
      write[end]()
      expect(r.clean()).toBe(true) // a write of text that was never unsaved leaves nothing behind, even refused
    }
  })

  it('a write that starts takes the buffer it read as the latest text of an existing entry', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'stale')
    const write = r.beginWrite(P, 'what the editor holds')
    expect(r.textOf(P)).toBe('what the editor holds')
    write.succeeded()
    expect(r.clean()).toBe(true)
  })

  it('settling a write twice counts once', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'B')
    const first = r.beginWrite(P, 'B')
    const second = r.beginWrite(P, 'B')
    first.failed()
    first.succeeded()
    first.failed()
    expect(r.pending()).toEqual([P])
    expect(r.clean()).toBe(false) // the second is still in flight
    second.succeeded()
    expect(r.clean()).toBe(true)
  })
})

describe('undo back to the saved text', () => {
  it('with no write in flight the entry goes: the disk already has that text', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'B')
    r.matchesDisk(P, 'A')
    expect(r.clean()).toBe(true)
  })

  it('after a failed write (the entry is kept, nothing is in flight) the report that the buffer equals the disk removes it', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'B')
    r.beginWrite(P, 'B').failed()
    r.matchesDisk(P, 'A')
    expect(r.clean()).toBe(true)
  })

  it('with a write of other text in flight the entry stays, holding the text undone to', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'B')
    const writeB = r.beginWrite(P, 'B')
    r.matchesDisk(P, 'A')
    expect(r.textOf(P)).toBe('A')
    writeB.succeeded() // the disk is now B, not A
    expect(r.textOf(P)).toBe('A')
    expect(r.clean()).toBe(false)
    r.beginWrite(P, 'A').succeeded() // the write of A that has to follow
    expect(r.clean()).toBe(true)
  })

  it('the same when that write then fails: the entry stays until A is written or the claim is repeated with nothing in flight', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'B')
    const writeB = r.beginWrite(P, 'B')
    r.matchesDisk(P, 'A')
    writeB.failed()
    expect(r.textOf(P)).toBe('A') // kept: costs one write of A, loses nothing
    r.matchesDisk(P, 'A')
    expect(r.clean()).toBe(true)
  })

  it('with a write of the same text in flight the entry goes: the disk ends as claimed whether it succeeds or fails', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'A')
    const writeA = r.beginWrite(P, 'A')
    r.matchesDisk(P, 'A')
    expect(r.paths()).toEqual([])
    expect(r.clean()).toBe(false) // still in flight
    writeA.failed()
    expect(r.clean()).toBe(true)
  })

  it('undo, then typing again during the same write: the entry follows the latest text', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'B')
    const writeB = r.beginWrite(P, 'B')
    r.matchesDisk(P, 'A')
    r.typed(P, 'B') // redo: back to exactly what is being written
    writeB.succeeded()
    expect(r.clean()).toBe(true)
  })

  it('a claim for a document with no entry and nothing in flight changes nothing', () => {
    let changes = 0
    const r = createUnsavedRegistry(() => { changes += 1 })
    r.matchesDisk(P, 'A')
    expect(changes).toBe(0)
    expect(r.clean()).toBe(true)
  })
})

describe('writes that overlap', () => {
  it('the older write finishing last: a success of the newer text does not remove the entry while the older is in flight', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'B')
    const older = r.beginWrite(P, 'B')
    r.typed(P, 'C')
    const newer = r.beginWrite(P, 'C')
    newer.succeeded()
    expect(r.textOf(P)).toBe('C') // B may still land after it
    older.succeeded()
    expect(r.textOf(P)).toBe('C') // and what landed last was B
    r.beginWrite(P, 'C').succeeded()
    expect(r.clean()).toBe(true)
  })

  it('two writes of the same text: the entry goes when the last of them succeeds', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'B')
    const one = r.beginWrite(P, 'B')
    const two = r.beginWrite(P, 'B')
    one.succeeded()
    expect(r.paths()).toEqual([P])
    two.succeeded()
    expect(r.clean()).toBe(true)
  })

  it('documents are independent', () => {
    const r = createUnsavedRegistry()
    r.typed('a.md', 'a')
    r.typed('b.md', 'b')
    const writeA = r.beginWrite('a.md', 'a')
    r.beginWrite('b.md', 'b').succeeded()
    expect(r.paths()).toEqual(['a.md'])
    writeA.succeeded()
    expect(r.clean()).toBe(true)
  })
})

describe('the app going away, and a document leaving the window', () => {
  it('unmounting is not an event: whatever the app reported last is what a close finds', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'B')
    const writeB = r.beginWrite(P, 'B')
    r.typed(P, 'C')
    // The app is unmounted here. Its write of B finishes afterwards.
    writeB.succeeded()
    expect(r.textOf(P)).toBe('C')
    expect(r.clean()).toBe(false)
  })

  it('error recovery writes the entry; a failed recovery leaves it, a later one removes it', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'C')
    r.beginWrite(P, 'C').failed()
    expect(r.clean()).toBe(false)
    r.beginWrite(P, 'C').succeeded()
    expect(r.clean()).toBe(true)
  })

  it('a closed, deleted or renamed document is discarded; a write of it still in flight keeps the window until it settles', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'B')
    const write = r.beginWrite(P, 'B')
    r.discard(P)
    expect(r.paths()).toEqual([])
    expect(r.clean()).toBe(false)
    write.succeeded()
    expect(r.clean()).toBe(true)
  })
})

describe('waiting for the writes of a path', () => {
  it('resolves at once with nothing in flight, and otherwise when the last write of that path settles', async () => {
    const r = createUnsavedRegistry()
    await r.settled(P)
    const one = r.beginWrite(P, 'x')
    const two = r.beginWrite(P, 'y')
    let done = false
    void r.settled(P).then(() => { done = true })
    one.succeeded()
    await Promise.resolve()
    expect(done).toBe(false)
    two.failed()
    await Promise.resolve()
    expect(done).toBe(true)
  })
})

describe('the two failures review round 2 found, as sequences of events', () => {
  // "Disk contains A. The writer changes it to B, starts saving B, then undoes back to A. The registry
  // entry disappears. The app errors before B finishes; B subsequently overwrites A. The standing close
  // handler sees an empty registry and closes without asking."
  it('finding 1: undo during a save in flight does not empty the registry', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'B')
    const savingB = r.beginWrite(P, 'B')
    r.matchesDisk(P, 'A') // the undo
    // The app errors here. A close now must not find the registry clean:
    expect(r.clean()).toBe(false)
    savingB.succeeded() // B overwrites A
    expect(r.clean()).toBe(false)
    expect(r.textOf(P)).toBe('A') // what the writer wanted is held, to be written
  })

  // "Close starts saving B. The writer types C during that write, then the app errors and unmounts. B
  // succeeds; recovery of C fails. The original close callback nevertheless considers the document clean
  // and closes."
  it('finding 2: B succeeding and the recovery of C failing leaves C held', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'B')
    const savingB = r.beginWrite(P, 'B') // the close's flush
    r.typed(P, 'C')
    // The app errors and unmounts here.
    savingB.succeeded()
    r.beginWrite(P, 'C').failed() // recovery
    expect(r.clean()).toBe(false)
    expect(r.textOf(P)).toBe('C')
  })
})

// Review round 3, finding 3. A save that was made and could not be read back (main's
// SavedButNotReadBack) leaves the app's saved baseline at what the disk held before it. "The buffer
// equals the baseline" is then not "the buffer equals the disk".
describe('a write of unknown outcome: the disk is unknown until a save is read back', () => {
  it('finding 3: B written but not read back, undo to A: A is held, not called saved', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'B')
    r.beginWrite(P, 'B').unknown() // B is on disk; the baseline still says A
    expect(r.textOf(P)).toBe('B')
    r.matchesDisk(P, 'A') // the undo: the buffer equals the stale baseline
    expect(r.clean()).toBe(false)
    expect(r.textOf(P)).toBe('A') // to be written over the B on disk
  })

  it('a later write that succeeds makes the disk known again and removes the entry', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'B')
    r.beginWrite(P, 'B').unknown()
    r.matchesDisk(P, 'A')
    r.beginWrite(P, 'A').succeeded()
    expect(r.clean()).toBe(true)
    // and "equals the disk" is believed again
    r.typed(P, 'C')
    r.matchesDisk(P, 'A')
    expect(r.clean()).toBe(true)
  })

  it('a later write that fails or is again of unknown outcome clears nothing', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'B')
    r.beginWrite(P, 'B').unknown()
    r.matchesDisk(P, 'A')
    r.beginWrite(P, 'A').failed()
    r.matchesDisk(P, 'A')
    expect(r.textOf(P)).toBe('A')
    r.beginWrite(P, 'A').unknown()
    r.matchesDisk(P, 'A')
    expect(r.textOf(P)).toBe('A')
  })

  it('a document with no entry gets one, holding the text the write carried', () => {
    const r = createUnsavedRegistry()
    r.beginWrite(P, 'B').unknown() // written while the buffer was taken to equal the disk
    expect(r.clean()).toBe(false)
    expect(r.textOf(P)).toBe('B')
  })

  it('text typed during the write is what stays held, not the text written', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'B')
    const write = r.beginWrite(P, 'B')
    r.typed(P, 'B and more')
    write.unknown()
    expect(r.textOf(P)).toBe('B and more')
  })

  it('a successful write of older text makes the disk known but keeps the later text', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'B')
    r.beginWrite(P, 'B').unknown()
    const write = r.beginWrite(P, 'B')
    r.typed(P, 'C')
    write.succeeded() // the disk holds B, read back
    expect(r.textOf(P)).toBe('C')
    r.matchesDisk(P, 'B') // undo to what that save read back
    expect(r.clean()).toBe(true)
  })

  it('a success while another write is in flight does not make the disk known', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'B')
    r.beginWrite(P, 'B').unknown()
    const first = r.beginWrite(P, 'B')
    const second = r.beginWrite(P, 'B')
    first.succeeded()
    r.matchesDisk(P, 'A')
    expect(r.textOf(P)).toBe('A') // still unknown, and a write of other text is in flight
    second.unknown()
    r.matchesDisk(P, 'A')
    expect(r.clean()).toBe(false)
  })

  it('a refused write (nothing was written) leaves "equals the disk" believed', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'B')
    r.beginWrite(P, 'B').failed()
    r.matchesDisk(P, 'A')
    expect(r.clean()).toBe(true)
  })

  it('the document leaving the window forgets it, also when it left during the write', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'B')
    r.beginWrite(P, 'B').unknown()
    r.discard(P)
    expect(r.clean()).toBe(true)
    r.typed(P, 'C') // opened again later, read from disk, typed in, undone
    r.matchesDisk(P, 'B')
    expect(r.clean()).toBe(true)

    const write = r.beginWrite('b.md', 'B')
    r.discard('b.md') // the tab was closed, or the file renamed, while its save ran
    write.unknown()
    expect(r.paths()).toEqual([]) // no entry comes back for a document that is not in the window
    expect(r.clean()).toBe(true)
    r.typed('b.md', 'C') // opened again later and undone to what was then read from disk
    r.matchesDisk('b.md', 'B')
    expect(r.clean()).toBe(true)
  })

  it('settling twice counts once', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'B')
    const write = r.beginWrite(P, 'B')
    write.succeeded()
    write.unknown()
    r.typed(P, 'C')
    r.matchesDisk(P, 'B')
    expect(r.clean()).toBe(true)
  })
})

// Redoing an undone suggestion writes the document's file by calls made outside the save queue
// (main-wrote-document.ts). While they are in flight a close must wait, though no text may be unsaved
// and no write was announced: that is a hold.
describe('a hold: calls that write the document are in flight', () => {
  it('a held document is pending and not clean, with no entry', () => {
    const r = createUnsavedRegistry()
    const release = r.hold(P)
    expect(r.clean()).toBe(false)
    expect(r.pending()).toEqual([P])
    expect(r.paths()).toEqual([])
    expect(r.textOf(P)).toBeUndefined()
    release()
    expect(r.clean()).toBe(true)
    expect(r.pending()).toEqual([])
  })

  it('claims nothing about text: an entry is neither made, changed nor kept by it', () => {
    const r = createUnsavedRegistry()
    r.typed(P, 'B')
    const release = r.hold(P)
    expect(r.textOf(P)).toBe('B')
    r.matchesDisk(P, 'A') // undo back to the saved text while held: the entry goes as without a hold
    expect(r.textOf(P)).toBeUndefined()
    r.typed(P, 'C')
    r.beginWrite(P, 'C').succeeded() // a write succeeds while held: rule 1 as without a hold
    expect(r.textOf(P)).toBeUndefined()
    expect(r.clean()).toBe(false)
    release()
    expect(r.clean()).toBe(true)
  })

  it('settled waits for every hold and every write, in either order, and a release counts once', async () => {
    const r = createUnsavedRegistry()
    const first = r.hold(P)
    const second = r.hold(P)
    const write = r.beginWrite(P, 'B')
    let settled = false
    void r.settled(P).then(() => { settled = true })
    first()
    first() // a second call of the same release does not release the other hold
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(r.pending()).toEqual([P])
    write.succeeded()
    await Promise.resolve()
    expect(settled).toBe(false)
    second()
    await Promise.resolve()
    expect(settled).toBe(true)
    expect(r.clean()).toBe(true)
  })

  it('a hold released while a write is still in flight leaves settled waiting for the write', async () => {
    const r = createUnsavedRegistry()
    const release = r.hold(P)
    const write = r.beginWrite(P, 'B')
    let settled = false
    void r.settled(P).then(() => { settled = true })
    release()
    await Promise.resolve()
    expect(settled).toBe(false)
    write.failed()
    await Promise.resolve()
    expect(settled).toBe(true)
  })

  it('closing the tab does not release it: the calls are still in flight', () => {
    const r = createUnsavedRegistry()
    const release = r.hold(P)
    r.discard(P)
    expect(r.clean()).toBe(false)
    release()
    expect(r.clean()).toBe(true)
  })

  it('tells the listener when it starts and when it ends', () => {
    let told = 0
    const r = createUnsavedRegistry(() => { told += 1 })
    const release = r.hold(P)
    expect(told).toBe(1)
    release()
    expect(told).toBe(2)
  })
})

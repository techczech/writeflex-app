// Merge on the changed-on-disk banner (src/renderer/src/app/disk-merge.ts), driven through the real
// document owner with fake ports and a main that compares bytes as main does. Each test names the guard
// it proves: cancel writes nothing; neither version is lost; every write is over the version it saw.
import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { preserveVersion } from '../../src/main/preserve-version'
import { textForSave } from '../../src/shared/line-endings'
import { basisAllows, type SaveBasis } from '../../src/shared/save-basis'
import type { ExternalDiskNotice } from '../../src/renderer/src/editor/reconcile'
import { createUnsavedRegistry } from '../../src/renderer/src/app/unsaved-registry'
import { createDocumentOwner } from '../../src/renderer/src/app/document-owner'
import { applyDiskMerge, beginDiskMerge, diskMergeMessage, offersMerge, type DiskMergePorts } from '../../src/renderer/src/app/disk-merge'

const P = 'note.md'
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const BASE = 'Intro.\n\nThe cat sat on the mat.\n\nOutro.\n'

function world(base = BASE) {
  const h = {
    disk: base as string | null,
    buffer: base as string,
    notices: new Map<string, ExternalDiskNotice>(),
    writes: [] as Array<{ doc: string; basis: SaveBasis }>,
    history: [] as string[],
    /** Runs inside the next write, before main compares (another program writing meanwhile). */
    during: null as (() => void) | null,
    /** No History in this window (no agent: a Workspace waiting for a model choice). */
    noHistory: false,
    /** History is there but its snapshot fails (the store refused, or the agent did not start). */
    historyFails: false,
    /** Runs while History reads the file (another program writes it then, and perhaps puts it back). */
    duringSnapshot: null as (() => void) | null,
    /** The preserve answer is replaced by this (a main that returns a receipt for other bytes). */
    forgedReceipt: null as unknown,
  }
  const owner = createDocumentOwner({
    buffer: () => h.buffer,
    notice: (path) => h.notices.get(path),
    registry: createUnsavedRegistry(),
    write: async (_path, doc, basis) => {
      h.writes.push({ doc, basis })
      const during = h.during
      h.during = null
      during?.()
      const next = textForSave(doc, h.disk)
      if (h.disk !== null && next === h.disk) return { content: h.disk, written: h.disk }
      if (!basisAllows(basis, h.disk)) return { refused: 'disk-changed', diskText: h.disk, message: 'changed on disk' }
      h.disk = next
      return { content: next, written: next }
    },
    setReadOnly: () => {},
    forgetBuffer: () => {},
    renameBuffer: () => {},
    replaceBuffer: (_path, diskText) => { h.buffer = diskText },
    dirtyChanged: () => {},
    report: {
      slow: () => {},
      refusedByNotice: () => {},
      refusedByMain: () => {},
      // As App does: a refused save raises the notice for the version main found.
      diskChanged: (path, diskText) => { h.notices.set(path, { kind: 'changed', dirty: true, diskText, again: true }) },
      saved: () => {},
      outsideAfterWrite: () => {},
      unknown: () => {},
    },
  })
  owner.activated(P, base, () => h.buffer)
  const type = (text: string): void => { h.buffer = text; owner.edited(P, text) }
  /** Another program writes the file; the watcher raises the notice over the unsaved buffer. */
  const outside = (text: string): void => {
    h.disk = text
    h.notices.set(P, { kind: 'changed', dirty: true, diskText: text })
  }
  const ports: DiskMergePorts = {
    notice: (path) => h.notices.get(path),
    buffer: () => h.buffer,
    // Main's preserve operation, with History snapshotting the fake disk as Bridle does (sha256 of its bytes).
    preserve: async (_path, text) => {
      if (h.forgedReceipt) return h.forgedReceipt
      return preserveVersion({
        text,
        history: h.noHistory ? null : async () => {
          if (h.historyFails) throw new Error('snapshot failed')
          const during = h.duringSnapshot
          h.duringSnapshot = null
          let read: string | null
          if (during) { const restore = h.disk; during(); read = h.disk; h.disk = restore } else read = h.disk
          if (read === null) return null
          h.history.push(read)
          return { id: `e${h.history.length}`, hash: sha(read) }
        },
      })
    },
    saved: (path) => ({ editor: owner.baselineOf(path), disk: owner.baselineDiskOf(path) }),
    checkpoint: async () => {
      if (h.noHistory) throw new Error('no history store')
      if (h.disk !== null) h.history.push(h.disk)
    },
    keepMine: (path, notice) => owner.keepMine(path, notice),
    answered: (path) => { h.notices.delete(path) },
    placeMerged: (_path, merged) => { type(merged); return true },
    save: (path) => owner.save(path),
  }
  const open = () => beginDiskMerge({ path: P, notice: h.notices.get(P), buffer: h.buffer, baseline: owner.baselineOf(P) })
  return { h, owner, type, outside, ports, open }
}

const MINE = 'Intro.\n\nThe cat sat on the red mat.\n\nOutro.\n'
const THEIRS_CLEAN = 'Intro, changed on disk.\n\nThe cat sat on the mat.\n\nOutro.\n'
const THEIRS_CLASH = 'Intro.\n\nThe dog sat on the mat.\n\nOutro.\n'

describe('Merge on the changed-on-disk banner', () => {
  it('is offered only for a changed file under unsaved text', () => {
    expect(offersMerge({ kind: 'changed', dirty: true, diskText: 'x' })).toBe(true)
    expect(offersMerge({ kind: 'changed', dirty: false, diskText: 'x' })).toBe(false)
    expect(offersMerge({ kind: 'removed', dirty: true, diskText: null })).toBe(false)
    expect(offersMerge(undefined)).toBe(false)
  })

  it('cancel writes nothing: opening the sheet and closing it leaves disk, buffer, notice and history as they were', async () => {
    const { h, type, outside, open } = world()
    type(MINE)
    outside(THEIRS_CLASH)
    const notice = h.notices.get(P)
    const session = open()
    expect(session?.merge.conflicts).toBe(1)
    // Cancel is closing the sheet: the session is dropped and nothing is called.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.writes).toEqual([])
    expect(h.history).toEqual([])
    expect(h.disk).toBe(THEIRS_CLASH)
    expect(h.buffer).toBe(MINE)
    expect(h.notices.get(P)).toBe(notice)
  })

  it('an unresolved conflict writes nothing', async () => {
    const { h, type, outside, open, ports } = world()
    type(MINE)
    outside(THEIRS_CLASH)
    const outcome = await applyDiskMerge(ports, open()!, [])
    expect(outcome).toEqual({ kind: 'unresolved' })
    expect(h.writes).toEqual([])
    expect(h.history).toEqual([])
    expect(h.disk).toBe(THEIRS_CLASH)
  })

  it('a clean merge: the disk version, then mine, go to History before the merged text is written', async () => {
    const { h, owner, type, outside, open, ports } = world()
    type(MINE)
    outside(THEIRS_CLEAN)
    const session = open()!
    expect(session.merge.conflicts).toBe(0)
    const outcome = await applyDiskMerge(ports, session, [])
    expect(outcome).toEqual({ kind: 'merged' })
    const merged = 'Intro, changed on disk.\n\nThe cat sat on the red mat.\n\nOutro.\n'
    expect(h.disk).toBe(merged)
    expect(h.buffer).toBe(merged)
    expect(h.history).toEqual([THEIRS_CLEAN, MINE, merged])
    // Mine went over exactly the disk version the banner showed; the merge over exactly mine.
    expect(h.writes.map((w) => w.basis)).toEqual([{ kind: 'keep-mine', text: THEIRS_CLEAN }, { kind: 'disk', text: MINE }])
    expect(h.notices.has(P)).toBe(false)
    expect(owner.isSaved(P)).toBe(true)
    expect(diskMergeMessage(P, outcome)).toBe('Merged note.md. Both earlier versions are in History.')
  })

  it('an overlapping hunk takes the pick: theirs', async () => {
    const { h, type, outside, open, ports } = world()
    type(MINE)
    outside(THEIRS_CLASH)
    expect(await applyDiskMerge(ports, open()!, ['theirs'])).toEqual({ kind: 'merged' })
    expect(h.disk).toBe(THEIRS_CLASH)
    expect(h.history).toEqual([THEIRS_CLASH, MINE, THEIRS_CLASH])
  })

  it('an overlapping hunk takes the pick: both', async () => {
    const { h, type, outside, open, ports } = world()
    type(MINE)
    outside(THEIRS_CLASH)
    expect(await applyDiskMerge(ports, open()!, ['both'])).toEqual({ kind: 'merged' })
    expect(h.disk).toBe('Intro.\n\nThe cat sat on the red mat.\n\nThe dog sat on the mat.\n\nOutro.\n')
  })

  it('picking mine: mine is written over the disk version; the save after it finds it already there', async () => {
    const { h, type, outside, open, ports } = world()
    type(MINE)
    outside(THEIRS_CLASH)
    expect(await applyDiskMerge(ports, open()!, ['mine'])).toEqual({ kind: 'merged' })
    expect(h.disk).toBe(MINE)
    expect(h.writes.map((w) => w.doc)).toEqual([MINE, MINE])
    expect(h.history).toEqual([THEIRS_CLASH, MINE, MINE])
  })

  it('the disk moved since the sheet opened: nothing written, nothing checkpointed', async () => {
    const { h, type, outside, open, ports } = world()
    type(MINE)
    outside(THEIRS_CLEAN)
    const session = open()!
    outside('A third version.\n')
    expect(await applyDiskMerge(ports, session, [])).toEqual({ kind: 'disk-moved' })
    expect(h.writes).toEqual([])
    expect(h.history).toEqual([])
    expect(h.disk).toBe('A third version.\n')
  })

  it('the buffer moved behind the sheet: nothing written', async () => {
    const { h, type, outside, open, ports } = world()
    type(MINE)
    outside(THEIRS_CLEAN)
    const session = open()!
    type(`${MINE}More.\n`)
    expect(await applyDiskMerge(ports, session, [])).toEqual({ kind: 'buffer-moved' })
    expect(h.writes).toEqual([])
    expect(h.disk).toBe(THEIRS_CLEAN)
  })

  it('a merge with no conflicts whose text is empty (yours deletes A, the disk deletes B): not placed or saved, both versions in History', async () => {
    const base = 'A.\n\nB.\n'
    const { h, type, outside, open, ports } = world(base)
    type('B.\n')
    outside('A.\n')
    const session = open()!
    expect(session.merge.conflicts).toBe(0)
    const outcome = await applyDiskMerge(ports, session, [])
    expect(outcome).toEqual({ kind: 'merged-empty' })
    // Keep mine's write only: the empty text was never placed in the editor or saved.
    expect(h.writes.map((w) => w.doc)).toEqual(['B.\n'])
    expect(h.disk).toBe('B.\n')
    expect(h.buffer).toBe('B.\n')
    expect(h.history).toEqual(['A.\n', 'B.\n'])
    expect(diskMergeMessage(P, outcome)).toBe('The merged text would be empty, so WriteFlex did not save it. Both versions are in History.')
  })

  it('no History (a Workspace waiting for a model choice): no receipt, so nothing written anywhere', async () => {
    const { h, type, outside, open, ports } = world()
    type(MINE)
    outside(THEIRS_CLASH)
    h.noHistory = true
    const outcome = await applyDiskMerge(ports, open()!, ['mine'])
    expect(outcome).toEqual({ kind: 'no-history' })
    expect(h.writes).toEqual([])
    expect(h.disk).toBe(THEIRS_CLASH)
    expect(h.buffer).toBe(MINE)
    expect(diskMergeMessage(P, outcome)).toBe('History is not available for note.md, so WriteFlex cannot keep a copy of the version on disk. Nothing was changed.')
  })

  it('History whose snapshot fails: no receipt, so nothing written', async () => {
    const { h, type, outside, open, ports } = world()
    type(MINE)
    outside(THEIRS_CLASH)
    h.historyFails = true
    expect(await applyDiskMerge(ports, open()!, ['mine'])).toEqual({ kind: 'no-history' })
    expect(h.writes).toEqual([])
    expect(h.disk).toBe(THEIRS_CLASH)
  })

  it('another program writes E while History reads, then puts the disk version D back: the receipt is for E, so nothing is written', async () => {
    const { h, type, outside, open, ports } = world()
    type(MINE)
    outside(THEIRS_CLASH)
    h.duringSnapshot = () => { h.disk = 'E, written for a moment.\n' }
    const outcome = await applyDiskMerge(ports, open()!, ['mine'])
    expect(outcome).toEqual({ kind: 'disk-moved' })
    expect(h.writes).toEqual([])
    // D is still the file, untouched; History holds E, and nothing replaced D.
    expect(h.disk).toBe(THEIRS_CLASH)
    expect(h.history).toEqual(['E, written for a moment.\n'])
  })

  it('a receipt for other bytes than the sheet\'s disk version is no receipt: nothing written', async () => {
    const { h, type, outside, open, ports } = world()
    type(MINE)
    outside(THEIRS_CLASH)
    h.forgedReceipt = { kept: true, receipt: { store: 'history', entryId: 'x', sha256: sha('something else') } }
    expect(await applyDiskMerge(ports, open()!, ['mine'])).toEqual({ kind: 'disk-moved' })
    expect(h.writes).toEqual([])
    expect(h.disk).toBe(THEIRS_CLASH)
  })

  it('your version cannot be kept after it is written: the merge is not saved over it', async () => {
    const { h, type, outside, open, ports } = world()
    type(MINE)
    outside(THEIRS_CLEAN)
    const session = open()!
    // The disk version is kept; then History reads another program's text instead of yours.
    let calls = 0
    const preserve = ports.preserve
    ports.preserve = async (path, text, label) => {
      calls += 1
      if (calls === 2) h.duringSnapshot = () => { h.disk = 'Someone else.\n' }
      return preserve(path, text, label)
    }
    const outcome = await applyDiskMerge(ports, session, [])
    expect(outcome).toEqual({ kind: 'mine-only', why: 'disk-moved' })
    expect(h.disk).toBe(MINE) // the one write was yours over the kept disk version
    expect(h.writes.map((w) => w.doc)).toEqual([MINE])
    expect(h.buffer).toBe(MINE)
  })

  it('another program writes between the checkpoint and the write: main refuses mine, nothing replaced', async () => {
    const { h, type, outside, open, ports } = world()
    type(MINE)
    outside(THEIRS_CLEAN)
    h.during = () => { h.disk = 'Written meanwhile.\n' }
    const outcome = await applyDiskMerge(ports, open()!, [])
    expect(outcome).toEqual({ kind: 'mine-refused' })
    expect(h.disk).toBe('Written meanwhile.\n')
    expect(h.buffer).toBe(MINE)
    expect(h.history).toEqual([THEIRS_CLEAN]) // the version the banner showed is kept
    expect(h.notices.get(P)).toMatchObject({ kind: 'changed', diskText: 'Written meanwhile.\n' })
  })

  it('CRLF on disk: the merge keeps the file\'s line endings', async () => {
    const crlf = BASE.replace(/\n/g, '\r\n')
    const { h, type, outside, open, ports } = world(crlf)
    type(MINE) // the editor holds LF
    outside(THEIRS_CLEAN.replace(/\n/g, '\r\n'))
    const session = open()!
    expect(session.merge.conflicts).toBe(0)
    expect(await applyDiskMerge(ports, session, [])).toEqual({ kind: 'merged' })
    expect(h.disk).toBe('Intro, changed on disk.\r\n\r\nThe cat sat on the red mat.\r\n\r\nOutro.\r\n')
  })
})

// Rename, move and duplicate through the document owner (src/renderer/src/app/document-owner.ts;
// docs/plans/saving-over-an-outside-change/document-owner-plan.md, parcel 2b), the owner's `exclusive`
// gate (review S5), and a proposal resolved from the Agent notes pane (residual c of parcel 2a round 4).
// Fake ports with one buffer and one file per path, the real unsaved registry, and a main that compares
// bytes as main does. Each test names the guard it proves.
import { describe, expect, it } from 'bun:test'
import { textForSave } from '../../src/shared/line-endings'
import { basisAllows } from '../../src/shared/save-basis'
import { createUnsavedRegistry } from '../../src/renderer/src/app/unsaved-registry'
import { createDocumentOwner } from '../../src/renderer/src/app/document-owner'
import type { ExternalDiskNotice } from '../../src/renderer/src/editor/reconcile'
import { acceptThroughOwner, resolveProposalThroughOwner, type AcceptAnswer } from '../../src/renderer/src/app/resolution-routes'
import { documentsUnder, renameMembers } from '../../src/renderer/src/app/documents-under'
import { changedOnDiskMessage, writeFolioThroughSaveQueue } from '../../src/shared/folio-write-preparation'

const tick = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function harness(files: Record<string, string>) {
  const registry = createUnsavedRegistry()
  const h = {
    disk: new Map<string, string>(Object.entries(files)),
    buffers: new Map<string, string>(Object.entries(files)),
    /** Every write main was asked for, in order. */
    writes: [] as Array<{ path: string; doc: string }>,
    /** A write held on its way to main until `release` is called. */
    hold: null as Promise<void> | null,
    /** Per path: the next write of that path is held until the promise resolves. */
    holds: new Map<string, Promise<void>>(),
    /** Changed-on-disk notices standing (the app raises them; a confirmed write clears its path's). */
    notices: new Map<string, ExternalDiskNotice>(),
    /** The editor's active path, with EditorPane's semantics: `forget` clears it, `renamePath` moves it,
     *  and typing is reported for it (nothing is reported when it is null). */
    active: null as string | null,
    readOnly: new Set<string>(),
    registry,
  }
  const owner = createDocumentOwner({
    buffer: (path) => h.buffers.get(path) ?? null,
    notice: (path) => h.notices.get(path),
    registry,
    write: async (path, doc, basis) => {
      h.writes.push({ path, doc })
      if (h.hold) await h.hold
      const held = h.holds.get(path)
      if (held) { h.holds.delete(path); await held }
      const disk = h.disk.get(path) ?? null
      const next = textForSave(doc, disk)
      if (disk !== null && next === disk) return { content: disk, written: disk }
      if (!basisAllows(basis, disk)) return { refused: 'disk-changed', diskText: disk, message: 'changed on disk' }
      h.disk.set(path, next)
      return { content: next, written: next }
    },
    setReadOnly: (paths, readOnly) => { for (const path of paths) { if (readOnly) h.readOnly.add(path); else h.readOnly.delete(path) } },
    forgetBuffer: (path) => {
      h.buffers.delete(path)
      if (h.active === path) h.active = null
    },
    renameBuffer: (from, to) => {
      const text = h.buffers.get(from)
      h.buffers.delete(from)
      if (text !== undefined) h.buffers.set(to, text)
      if (h.active === from) h.active = to
    },
    replaceBuffer: (path, diskText) => { h.buffers.set(path, diskText) },
    dirtyChanged: () => {},
    report: { slow: () => {}, refusedByNotice: () => {}, refusedByMain: () => {}, diskChanged: () => {}, saved: (path) => { h.notices.delete(path) }, outsideAfterWrite: () => {}, unknown: () => {} },
  })
  for (const [path, text] of Object.entries(files)) owner.activated(path, text, () => h.buffers.get(path)!)
  const type = (path: string, text: string): void => { h.buffers.set(path, text); owner.edited(path, text) }
  /** The writer types into the visible editor: the text lands in the view, and the editor reports it for
   *  its active path, if it has one (EditorPane's onDocChanged). Returns whether it was reported. */
  const typeInEditor = (text: string): boolean => {
    if (h.active === null) return false
    if (h.readOnly.has(h.active)) return false
    type(h.active, text)
    return true
  }
  /** The app's activation of a tab: the file is read and the buffer shown (a cached one, or the read). */
  const activate = (path: string): void => {
    const disk = h.disk.get(path)!
    owner.activated(path, disk, () => {
      if (!h.buffers.has(path)) h.buffers.set(path, disk)
      h.active = path
      return h.buffers.get(path)!
    })
  }
  /** Main's rename: the file moves on disk. */
  const mainMoves = (from: string, to: string): void => {
    h.disk.set(to, h.disk.get(from)!)
    h.disk.delete(from)
  }
  return { h, owner, type, typeInEditor, activate, mainMoves }
}

describe('rename and move: the generation decides whether the buffer moves with the file (Sol r3 M2)', () => {
  it('typing during main\'s move, undone back to the snapshot\'s text, is carried to the new name, unsaved', async () => {
    const { h, owner, type, mainMoves } = harness({ 'a.md': 'A\n' })
    const outcome = await owner.withFlushed(['a.md'], async () => {
      await tick()
      type('a.md', 'A\nTyped.\n') // typed while main moved the file, then undone
      type('a.md', 'A\n')
      mainMoves('a.md', 'b.md')
      return owner.moved('a.md', 'b.md')
    })
    expect(outcome).toMatchObject({ status: 'acted', result: 'carried' })
    expect(h.buffers.get('b.md')).toBe('A\n')
    expect(h.buffers.has('a.md')).toBe(false)
    expect(owner.isSaved('b.md')).toBe(false) // the registry holds it: a close writes it or asks
    expect(h.registry.textOf('b.md')).toBe('A\n')
    expect(owner.baselineDiskOf('b.md')).toBe('A\n') // still based on the version it was saved as
    expect(owner.generationsOf('a.md')).toBeUndefined()
  })

  it('typing during main\'s move is kept under the new name and written there, never at the old path', async () => {
    const { h, owner, type, mainMoves } = harness({ 'a.md': 'A\n' })
    type('a.md', 'A\nFlushed.\n')
    let autosave: Promise<boolean> | null = null
    const outcome = await owner.withFlushed(['a.md'], async () => {
      await tick()
      type('a.md', 'A\nFlushed.\nTyped during the move.\n')
      autosave = owner.save('a.md') // the autosave armed by that typing fires while main moves the file
      await tick(20)
      mainMoves('a.md', 'b.md')
      return owner.moved('a.md', 'b.md')
    })
    expect(outcome).toMatchObject({ status: 'acted', result: 'carried' })
    expect(await autosave!).toBe(true)
    // The flush wrote a.md; the autosave queued behind the move found no buffer at a.md and wrote nothing.
    expect(h.writes).toEqual([{ path: 'a.md', doc: 'A\nFlushed.\n' }])
    expect(h.disk.has('a.md')).toBe(false)
    // The next save of the new name writes the typing over the version it was based on.
    expect(await owner.save('b.md')).toBe(true)
    expect(h.disk.get('b.md')).toBe('A\nFlushed.\nTyped during the move.\n')
    expect(owner.isSaved('b.md')).toBe(true)
  })

  it('a buffer unchanged since the flush goes to the new name saved: nothing is left at the old one', async () => {
    const { h, owner, type, mainMoves } = harness({ 'a.md': 'A\n' })
    type('a.md', 'A\nFlushed.\n')
    const outcome = await owner.withFlushed(['a.md'], () => {
      mainMoves('a.md', 'b.md')
      return owner.moved('a.md', 'b.md')
    })
    expect(outcome).toMatchObject({ status: 'acted', result: 'renamed' })
    expect([...h.buffers.keys()]).toEqual(['b.md'])
    expect(h.registry.clean()).toBe(true)
    expect(owner.isSaved('b.md')).toBe(true)
    expect(owner.isDirty('b.md')).toBe(false)
    expect(owner.generationsOf('a.md')).toBeUndefined()
    expect(h.disk.get('b.md')).toBe('A\nFlushed.\n')
  })

  it('a buffer never shown (no buffer resident) is forgotten: the new name is read when its tab opens', async () => {
    const { h, owner, mainMoves } = harness({ 'a.md': 'A\n' })
    h.buffers.delete('a.md')
    const outcome = await owner.withFlushed(['a.md'], () => {
      mainMoves('a.md', 'b.md')
      return owner.moved('a.md', 'b.md')
    })
    expect(outcome).toMatchObject({ status: 'acted', result: 'forgotten' })
    expect(owner.generationsOf('a.md')).toBeUndefined()
    expect(owner.generationsOf('b.md')).toBeUndefined()
  })

  // 2b review round 2, finding 1: Rename confirmed with the existing name. Guard: \`moved\`'s
  // \`from === to\` no-op (document-owner.ts); without it the buffer is forgotten with its active path.
  it('a rename to its own name changes nothing: the buffer stays resident and active, and typing after it is saved', async () => {
    const { h, owner, typeInEditor, activate } = harness({ 'a.md': 'A\n' })
    activate('a.md')
    const outcome = await owner.withFlushed(['a.md'], () => owner.moved('a.md', 'a.md'))
    expect(outcome).toMatchObject({ status: 'acted', result: 'renamed' })
    expect(h.active).toBe('a.md')
    expect(h.buffers.get('a.md')).toBe('A\n')
    expect(owner.generationsOf('a.md')).toBeDefined()
    expect(owner.baselineDiskOf('a.md')).toBe('A\n')
    expect(typeInEditor('A\nTyped after the rename.\n')).toBe(true)
    expect(h.buffers.get('a.md')).toBe('A\nTyped after the rename.\n')
    expect(owner.isSaved('a.md')).toBe(false)
    expect(await owner.save('a.md')).toBe(true)
    expect(h.disk.get('a.md')).toBe('A\nTyped after the rename.\n')
  })

  // 2b review round 1, P1 (remaining gap): a saved active buffer was forgotten by \`moved\`, which cleared
  // the editor's active path; typing while the app refreshed the tree was reported to no path, and opening
  // the new name replaced it with the disk text.
  it('typing into the editor after a saved rename, before the new name opens, is kept under the new name', async () => {
    const { h, owner, typeInEditor, activate, mainMoves } = harness({ 'a.md': 'A\n' })
    activate('a.md')
    const outcome = await owner.withFlushed(['a.md'], () => {
      mainMoves('a.md', 'b.md')
      return owner.moved('a.md', 'b.md')
    })
    expect(outcome.status).toBe('acted')
    // The app awaits its refresh of the tree; the editor is still on screen and the writer types.
    expect(typeInEditor('A\nTyped while the tree refreshed.\n')).toBe(true)
    expect(h.registry.textOf('b.md')).toBe('A\nTyped while the tree refreshed.\n')
    // The new name opens: its read is reconciled with the buffer, which is kept, unsaved.
    activate('b.md')
    expect(h.buffers.get('b.md')).toBe('A\nTyped while the tree refreshed.\n')
    expect(owner.isSaved('b.md')).toBe(false)
    expect(await owner.save('b.md')).toBe(true)
    expect(h.disk.get('b.md')).toBe('A\nTyped while the tree refreshed.\n')
  })
})

// 2b review round 1, P1: a document held unwritten (\`holdOnly\`) still waits for what its queue holds.
describe('a document held unwritten is still serialised', () => {
  it('Keep mine pressed, then Duplicate while its write is in flight: the copy is made after Keep mine, of the chosen text', async () => {
    const { h, owner, type } = harness({ 'a.md': 'A\n' })
    type('a.md', 'A\nB\n')
    h.disk.set('a.md', 'C outside.\n') // another program writes; the app raises the notice
    const notice: ExternalDiskNotice = { kind: 'changed', dirty: true, diskText: 'C outside.\n' }
    h.notices.set('a.md', notice)
    type('a.md', 'A\n') // Undo back to the baseline: no dot, nothing in the registry, still under the notice
    const cleanUnderNotice = (path: string): boolean => h.notices.has(path) && !owner.isDirty(path) && h.registry.textOf(path) === undefined
    expect(cleanUnderNotice('a.md')).toBe(true)
    let release!: () => void
    h.holds.set('a.md', new Promise<void>((resolve) => { release = resolve }))
    const keepMine = owner.keepMine('a.md', notice)
    await tick()
    let copiedAt: { copy: string; keepMineDone: boolean } | null = null
    let keepMineDone = false
    void keepMine.then(() => { keepMineDone = true })
    const duplicate = owner.withFlushed(['a.md'], async () => {
      copiedAt = { copy: h.disk.get('a.md')!, keepMineDone }
      h.disk.set('a (copy).md', h.disk.get('a.md')!)
      return 'a (copy).md'
    }, { holdOnly: cleanUnderNotice })
    await tick(20)
    expect(copiedAt).toBeNull() // Keep mine's write is in flight: Duplicate waits for it
    release()
    expect(await keepMine).toBe(true)
    expect(await duplicate).toMatchObject({ status: 'acted' })
    expect(copiedAt).toEqual({ copy: 'A\n', keepMineDone: true })
    expect(h.disk.get('a (copy).md')).toBe('A\n')
  })

  it('a rename of a document held unwritten waits for a save of it in flight, and no save runs beside main\'s move', async () => {
    const { h, owner, type, mainMoves } = harness({ 'a.md': 'A\n' })
    const notice: ExternalDiskNotice = { kind: 'changed', dirty: true, diskText: 'C outside.\n' }
    type('a.md', 'A\nB\n')
    h.disk.set('a.md', 'C outside.\n')
    h.notices.set('a.md', notice)
    type('a.md', 'A\n')
    let release!: () => void
    h.holds.set('a.md', new Promise<void>((resolve) => { release = resolve }))
    const keepMine = owner.keepMine('a.md', notice)
    let keepMineSettled = false
    void keepMine.then(() => { keepMineSettled = true })
    await tick()
    let movedAfterKeepMine: boolean | null = null
    const rename = owner.withFlushed(['a.md'], () => {
      movedAfterKeepMine = keepMineSettled
      mainMoves('a.md', 'b.md')
      return owner.moved('a.md', 'b.md')
    }, { holdOnly: (path) => h.notices.has(path) && !owner.isDirty(path) && h.registry.textOf(path) === undefined })
    await tick(20)
    expect(movedAfterKeepMine).toBeNull() // main is not asked while Keep mine's write is in flight
    release()
    await keepMine
    expect(await rename).toMatchObject({ status: 'acted', result: 'renamed' })
    expect(movedAfterKeepMine).toBe(true)
    expect(h.disk.get('b.md')).toBe('A\n')
    expect(h.disk.has('a.md')).toBe(false)
  })
})

// 2b review round 1, P2: an export (any route that reads the file as the screen's text) under a notice the
// writer has not answered is refused; the owner's flush never reports saved with the screen off disk.
describe('a flush under an unanswered notice', () => {
  it('typed, changed on disk, undone to the baseline: the flush is refused and nothing is written', async () => {
    const { h, owner, type } = harness({ 'a.md': 'A\n' })
    type('a.md', 'A\nB\n')
    h.disk.set('a.md', 'C outside.\n')
    h.notices.set('a.md', { kind: 'changed', dirty: true, diskText: 'C outside.\n' })
    type('a.md', 'A\n')
    expect(await owner.flush(['a.md'])).toEqual({ status: 'refused', path: 'a.md' })
    expect(h.writes).toEqual([])
    expect(h.disk.get('a.md')).toBe('C outside.\n')
  })

  // 2b review round 2, finding 2: a collection's export validates every document under its folder the app
  // knows of. Guard: \`documentsUnder\` takes the owner's records, the notices and the tabs as well as the
  // registry; the old selection (dots and registry entries) left B out, and the flush said saved.
  it('a collection export from clean A refuses at sibling B, typed, changed on disk and undone, with nothing written', async () => {
    const { h, owner, type } = harness({ 'f/a.md': 'A\n', 'f/b.md': 'B\n' })
    type('f/b.md', 'B\nTyped.\n')
    h.disk.set('f/b.md', 'B outside.\n')
    h.notices.set('f/b.md', { kind: 'changed', dirty: true, diskText: 'B outside.\n' })
    type('f/b.md', 'B\n') // Undo back to the baseline: no dot, nothing in the registry
    expect(owner.isDirty('f/b.md')).toBe(false)
    expect(h.registry.pending()).toEqual([])
    const members = documentsUnder('f/', { owned: owner.pathsUnder('f/'), notices: h.notices.keys(), registry: h.registry.pending(), tabs: ['f/a.md'] })
    expect(await owner.flush(members)).toEqual({ status: 'refused', path: 'f/b.md' })
    expect(members.sort()).toEqual(['f/a.md', 'f/b.md'])
    expect(h.writes).toEqual([])
    expect(h.disk.get('f/b.md')).toBe('B outside.\n')
  })

  // Guard: \`documentsUnder\` takes the notices: a document under an unanswered notice is a member even
  // when nothing else names it (no record, no tab, no registry entry).
  it('a document under an unanswered notice is under its folder for an export even with no record, tab or entry', () => {
    const members = documentsUnder('f/', { owned: [], notices: ['f/b.md', 'g/c.md'], registry: [], tabs: ['f/a.md'] })
    expect(members.sort()).toEqual(['f/a.md', 'f/b.md'])
  })
})

// 2b review round 1, P2: a folder's documents are its members at the final check, and one opened under the
// folder while the route holds joins the hold.
describe('a folder\'s rename or trash covers documents opened during it', () => {
  it('a document opened under the folder while another is written is written and held too', async () => {
    const { h, owner, type, activate, mainMoves } = harness({ 'f/a.md': 'A\n', 'f/b.md': 'B\n' })
    h.buffers.delete('f/b.md')
    const tabs = ['f/a.md']
    type('f/a.md', 'A\nTyped.\n')
    let release!: () => void
    h.holds.set('f/a.md', new Promise<void>((resolve) => { release = resolve }))
    const moved: string[] = []
    const rename = owner.withFlushed(() => tabs.filter((t) => t.startsWith('f/')), async (snapshots) => {
      for (const path of snapshots.keys()) {
        mainMoves(path, path.replace('f/', 'g/'))
        owner.moved(path, path.replace('f/', 'g/'))
        moved.push(path)
      }
    }, { scope: 'f/' })
    await tick()
    // While f/a.md is written, the writer opens f/b.md and types in it.
    tabs.push('f/b.md')
    activate('f/b.md')
    type('f/b.md', 'B\nTyped in the second.\n')
    release()
    expect(await rename).toMatchObject({ status: 'acted' })
    expect(moved.sort()).toEqual(['f/a.md', 'f/b.md'])
    expect(h.disk.get('g/b.md')).toBe('B\nTyped in the second.\n') // written before the hold, then moved
    expect(h.buffers.has('f/b.md')).toBe(false)
    expect(h.writes.map((w) => w.path)).toEqual(['f/a.md', 'f/b.md'])
  })

  it('a document opened under the folder while main renames it joins the hold: its save waits, and it moves with the folder', async () => {
    const { h, owner, type, activate, mainMoves } = harness({ 'f/a.md': 'A\n', 'f/b.md': 'B\n' })
    h.buffers.delete('f/b.md')
    const tabs = ['f/a.md']
    let autosave: Promise<boolean> | null = null
    let writesDuringMain: string[] = []
    const rename = owner.withFlushed(() => tabs.filter((t) => t.startsWith('f/')), async (snapshots) => {
      // Main is renaming the folder; the writer opens f/b.md and types, and its autosave fires.
      tabs.push('f/b.md')
      activate('f/b.md')
      type('f/b.md', 'B\nTyped during the rename.\n')
      autosave = owner.save('f/b.md')
      await tick(20)
      writesDuringMain = h.writes.map((w) => w.path)
      const results: Record<string, string> = {}
      for (const path of snapshots.keys()) {
        mainMoves(path, path.replace('f/', 'g/'))
        results[path] = owner.moved(path, path.replace('f/', 'g/'))
      }
      return results
    }, { scope: 'f/' })
    const outcome = await rename
    expect(outcome).toMatchObject({ status: 'acted', result: { 'f/a.md': 'renamed', 'f/b.md': 'carried' } })
    expect(writesDuringMain).toEqual([]) // the autosave of f/b.md did not run beside main's rename
    expect(await autosave!).toBe(true) // ran after: no buffer at f/b.md, nothing written
    expect(h.disk.has('f/b.md')).toBe(false)
    expect(h.registry.textOf('g/b.md')).toBe('B\nTyped during the rename.\n')
    expect(await owner.save('g/b.md')).toBe(true)
    expect(h.disk.get('g/b.md')).toBe('B\nTyped during the rename.\n')
  })

  it('a document opened under the folder while main trashes it is detached with the others, and forgotten with them', async () => {
    const { h, owner, typeInEditor, activate } = harness({ 'f/a.md': 'A\n', 'f/b.md': 'B\n' })
    h.buffers.delete('f/b.md')
    const tabs = ['f/a.md']
    let typed = true
    const trash = owner.withFlushed(() => tabs.filter((t) => t.startsWith('f/')), async (snapshots) => {
      tabs.push('f/b.md')
      activate('f/b.md')
      typed = typeInEditor('B\nTyped during the trash.\n')
      await tick()
      const forgotten: string[] = []
      for (const path of snapshots.keys()) if (owner.forgetIfSaved(path)) forgotten.push(path)
      return forgotten
    }, { detach: true, scope: 'f/' })
    expect(await trash).toMatchObject({ status: 'acted', result: ['f/a.md', 'f/b.md'] })
    expect(typed).toBe(false) // the detached editor took no typing
    expect(h.registry.clean()).toBe(true)
  })
})

// 2b review round 2, finding 3: a folder's scope is locked in the owner. The rename starts only once every
// path the owner has a record for under the folder is idle, and until it returns no operation on any path
// under the folder starts, including one on a path the owner had no record for.
describe('a folder\'s scope lock', () => {
  /** A folder rename as App runs it: members are the tabs under the folder (the owner adds its records under
   *  the scope); the action moves every file under \`f/\` to \`g/\` on the fake disk, then the documents. */
  function renameFolder(h: ReturnType<typeof harness>['h'], owner: ReturnType<typeof harness>['owner'], tabs: string[], during: () => Promise<void> = async () => {}) {
    return owner.withFlushed(() => tabs.filter((t) => t.startsWith('f/')), async (snapshots) => {
      await during()
      for (const path of [...h.disk.keys()].filter((p) => p.startsWith('f/'))) {
        h.disk.set(path.replace('f/', 'g/'), h.disk.get(path)!)
        h.disk.delete(path)
      }
      for (const path of snapshots.keys()) owner.moved(path, path.replace('f/', 'g/'))
    }, { scope: 'f/' })
  }

  // Guard: \`withFlushed\` takes every path the owner has a record for under the scope as a member, not
  // only the ones the caller names (tabs).
  it('an accept of a document not open, in flight when the folder is renamed, runs first: its text is at the new path only', async () => {
    const { h, owner } = harness({ 'f/a.md': 'A\n' })
    h.disk.set('f/b.md', 'B\n- [ ] box\n') // under the folder, never opened: no tab, no buffer
    let mainAnswers!: () => void
    const answered = new Promise<void>((resolve) => { mainAnswers = resolve })
    // The accept as resolution-routes runs it: in the owner's route for its path; main reads the file,
    // then (after a while) writes the accepted text at the path it was asked for.
    const accept = owner.withFlushed(['f/b.md'], async () => {
      const read = h.disk.get('f/b.md')!
      await answered
      h.disk.set('f/b.md', read.replace('[ ]', '[x]'))
    })
    await tick()
    let renameStarted = false
    const rename = renameFolder(h, owner, ['f/a.md'], async () => { renameStarted = true })
    await tick(20)
    expect(renameStarted).toBe(false) // the accept is in flight under the folder: the rename waits
    mainAnswers()
    expect(await accept).toMatchObject({ status: 'acted' })
    expect(await rename).toMatchObject({ status: 'acted' })
    expect(h.disk.get('g/b.md')).toBe('B\n- [x] box\n')
    expect(h.disk.has('f/b.md')).toBe(false)
  })

  // Guard: \`enqueue\` waits for a folder scope covering the path (\`covering\` in document-owner.ts).
  it('an operation asked for under the folder while it is renamed, on a path with no record, runs after the rename returns', async () => {
    const { h, owner } = harness({ 'f/a.md': 'A\n' })
    const order: string[] = []
    let queued: Promise<void> | null = null
    const rename = renameFolder(h, owner, ['f/a.md'], async () => {
      expect(owner.generationsOf('f/c.md')).toBeUndefined()
      queued = owner.inQueue('f/c.md', async () => { order.push('f/c.md') })
      await tick(20)
      order.push('rename')
    })
    await rename
    await queued
    expect(order).toEqual(['rename', 'f/c.md'])
  })

  // Guard: as above (\`idle\`/\`idleNow\` and \`enqueue\` honour the scope).
  it('a route asked for under the folder while it is renamed waits for the rename', async () => {
    const { h, owner } = harness({ 'f/a.md': 'A\n' })
    h.disk.set('f/d.md', 'D\n')
    const order: string[] = []
    let route: Promise<unknown> | null = null
    const rename = renameFolder(h, owner, ['f/a.md'], async () => {
      route = owner.withFlushed(['f/d.md'], async () => { order.push('f/d.md') })
      await tick(20)
      order.push('rename')
    })
    await rename
    await route
    expect(order).toEqual(['rename', 'f/d.md'])
  })
})

// 2b round 3 review, finding 2: folder scopes conflict by prefix, whatever documents either holds.
// Guard: `withFlushed` waits for every held scope whose prefix overlaps its own (`overlapping` in
// document-owner.ts) before its final check.
describe('folder scopes with overlapping prefixes never run at once', () => {
  const folderRoute = (owner: ReturnType<typeof harness>['owner'], prefix: string, order: string[], during = 20) =>
    owner.withFlushed(() => [], async () => {
      order.push(`${prefix} starts`)
      await tick(during)
      order.push(`${prefix} ends`)
    }, { scope: prefix })

  it('a rename of an empty folder inside one being renamed waits for the parent to return', async () => {
    const { owner } = harness({ 'f/a.md': 'A\n' })
    const order: string[] = []
    const parent = folderRoute(owner, 'f/', order)
    await tick(1)
    const child = folderRoute(owner, 'f/empty/', order)
    await Promise.all([parent, child])
    expect(order).toEqual(['f/ starts', 'f/ ends', 'f/empty/ starts', 'f/empty/ ends'])
  })

  it('a parent folder\'s route waits for an empty child\'s route held first', async () => {
    const { owner } = harness({})
    const order: string[] = []
    const child = folderRoute(owner, 'f/empty/', order)
    await tick(1)
    const parent = folderRoute(owner, 'f/', order)
    await Promise.all([parent, child])
    expect(order).toEqual(['f/empty/ starts', 'f/empty/ ends', 'f/ starts', 'f/ ends'])
  })

  it('two routes on the same empty folder run one after the other; a sibling folder\'s does not wait', async () => {
    const { owner } = harness({})
    const order: string[] = []
    const first = folderRoute(owner, 'f/', order)
    await tick(1)
    const second = folderRoute(owner, 'f/', order, 5)
    const sibling = folderRoute(owner, 'fo/', order, 5)
    await Promise.all([first, second, sibling])
    expect(order.indexOf('fo/ starts')).toBeLessThan(order.indexOf('f/ ends'))
    expect(order.filter((step) => step.startsWith('f/ '))).toEqual(['f/ starts', 'f/ ends', 'f/ starts', 'f/ ends'])
  })
})

// 2b round 3 review, finding 1: a single file's rename holds every document main's link repair may rewrite
// and every document the app has a record of, for the whole rename including the repair's write. Guard:
// `renameMembers` (documents-under.ts) as App's `withRenameScopeSaved` takes it; the old selection (dots,
// registry entries and the file moved) left closed B out while an accept of it was in flight.
describe('a single file\'s rename with link repair', () => {
  it('closed B links to A; an accept of B is in flight when A is renamed to C: the repair lands on the accepted text', async () => {
    const { h, owner } = harness({ 'a.md': '# A\n' })
    h.disk.set('b.md', 'See [[A]]. old\n') // closed: no tab, no buffer, no dot, no registry entry
    let mainAnswers!: () => void
    const answered = new Promise<void>((resolve) => { mainAnswers = resolve })
    // The accept as resolution-routes runs it (`inOrder`): main reads B, then awaits its snapshot, then
    // writes the accepted text.
    const accept = owner.withFlushed(['b.md'], async () => {
      const read = h.disk.get('b.md')!
      await answered
      h.disk.set('b.md', read.replace('old', 'accepted'))
    }, { inOrder: true })
    await tick(1)
    expect(owner.isDirty('b.md')).toBe(false)
    expect(h.registry.pending()).toEqual([])
    // Main's plan for renaming A to C: B is the one document its repair may rewrite.
    const repairPaths = ['b.md']
    const known = documentsUnder('', { owned: owner.pathsUnder(''), notices: h.notices.keys(), registry: h.registry.pending(), tabs: ['a.md'] })
    const members = renameMembers(['a.md'], repairPaths, known)
    setTimeout(mainAnswers, 30)
    const rename = owner.withFlushed(members, async () => {
      // Main renames A, then repairs B: it reads B, checkpoints it (a wait), and writes the repaired text.
      h.disk.set('c.md', h.disk.get('a.md')!)
      h.disk.delete('a.md')
      owner.moved('a.md', 'c.md')
      const read = h.disk.get('b.md')!
      await tick(60)
      h.disk.set('b.md', read.replace('[[A]]', '[[C]]'))
    }, { holdOnly: () => false })
    expect(await accept).toMatchObject({ status: 'acted' })
    expect(await rename).toMatchObject({ status: 'acted' })
    expect(h.disk.get('b.md')).toBe('See [[C]]. accepted\n')
  })

  it('a document with a record and no link at plan time is held: an accept that adds a link finishes first', () => {
    // Guard: `renameMembers` takes every document the app has a record of (`known`), not only the plan's.
    const members = renameMembers(['a.md'], [], ['e.md', 'notes/f.md'])
    expect(members.sort()).toEqual(['a.md', 'e.md', 'notes/f.md'])
  })
})

// 2b round 3 sweep: a Folio running-order write's documents are every document the app has a record of
// under the Folio's folder. Guard: App passes `documentsUnder('')` as `open`; the old selection (tabs and
// dots) left a closed piece with an accept in flight out, and main's write ran beside the accept.
describe('a Folio running-order write', () => {
  it('waits for an accept of a closed piece in flight, and runs after it', async () => {
    const { h, owner } = harness({ 'f/index.md': '# Index\n' })
    h.disk.set('f/b.md', 'B\n- [ ] box\n') // a piece of the Folio, never opened
    const order: string[] = []
    let mainAnswers!: () => void
    const answered = new Promise<void>((resolve) => { mainAnswers = resolve })
    const accept = owner.withFlushed(['f/b.md'], async () => {
      await answered
      order.push('accept writes f/b.md')
    }, { inOrder: true })
    await tick(1)
    setTimeout(mainAnswers, 30)
    const known = (): string[] => documentsUnder('', { owned: owner.pathsUnder(''), notices: h.notices.keys(), registry: h.registry.pending(), tabs: ['f/index.md'] })
    const written = writeFolioThroughSaveQueue('f', {
      open: known,
      isSaved: (path) => owner.isSaved(path),
      settled: (path) => owner.settled(path),
      save: (path) => owner.save(path),
      exclusive: (paths, run) => owner.exclusive(paths, run),
    }, async () => { order.push('running order writes f/b.md') })
    expect(await written).toMatchObject({ ok: true })
    await accept
    expect(order).toEqual(['accept writes f/b.md', 'running order writes f/b.md'])
  })

  // 2b round 4 Sol P2: the readiness predicate is the owner's savedness, never the dot. Guard: App passes
  // `owner.isSaved` (and the notice's sentence); with `owner.isDirty` the undone Index Note passed both
  // checks with no save attempted, and main changed the file before the notice was answered.
  it('an Index Note typed, changed on disk, and undone to the baseline refuses the reorder with the notice\'s sentence; main is not asked', async () => {
    const { h, owner, type } = harness({ 'f/index.md': '# Index\n\n1. [[a]]\n2. [[b]]\n' })
    type('f/index.md', '# Index\n\nTyped.\n\n1. [[a]]\n2. [[b]]\n')
    const outside = '# Index, edited elsewhere\n\n1. [[a]]\n2. [[b]]\n'
    h.disk.set('f/index.md', outside)
    h.notices.set('f/index.md', { kind: 'changed', dirty: true, diskText: outside })
    type('f/index.md', '# Index\n\n1. [[a]]\n2. [[b]]\n') // Undo back to the baseline: no dot
    expect(owner.isDirty('f/index.md')).toBe(false)
    expect(owner.isSaved('f/index.md')).toBe(false)
    let mainAsked = 0
    const known = (): string[] => documentsUnder('', { owned: owner.pathsUnder(''), notices: h.notices.keys(), registry: h.registry.pending(), tabs: ['f/index.md'] })
    const answer = await writeFolioThroughSaveQueue('f', {
      open: known,
      isSaved: (path) => owner.isSaved(path),
      refusedUnderNotice: (path) => { const notice = h.notices.get(path); return notice ? changedOnDiskMessage(path, notice.kind) : undefined },
      settled: (path) => owner.settled(path),
      save: (path) => owner.save(path),
      exclusive: (paths, run) => owner.exclusive(paths, run),
    }, async () => { mainAsked += 1; h.disk.set('f/index.md', '# Index, edited elsewhere\n\n1. [[b]]\n2. [[a]]\n') })
    expect(answer).toEqual({ ok: false, message: 'index.md changed on disk. Choose Reload or Keep mine above the text, then try again.' })
    expect(mainAsked).toBe(0)
    expect(h.writes).toEqual([])
    expect(h.disk.get('f/index.md')).toBe(outside)
  })
})

describe('duplicate: the copy is the saved text', () => {
  it('typing during main\'s copy is saved after the copy, in the original only', async () => {
    const { h, owner, type } = harness({ 'a.md': 'A\n' })
    type('a.md', 'A\nFlushed.\n')
    let autosave: Promise<boolean> | null = null
    const outcome = await owner.withFlushed(['a.md'], async () => {
      type('a.md', 'A\nFlushed.\nTyped during the copy.\n')
      autosave = owner.save('a.md')
      await tick(20)
      h.disk.set('a (copy).md', h.disk.get('a.md')!) // main copies the file as it is on disk now
      return 'a (copy).md'
    })
    expect(outcome.status).toBe('acted')
    await autosave
    expect(h.disk.get('a (copy).md')).toBe('A\nFlushed.\n')
    expect(h.disk.get('a.md')).toBe('A\nFlushed.\nTyped during the copy.\n')
  })
})

describe('flush', () => {
  it('writes every path until saved; a refusal is the route\'s refusal', async () => {
    const { h, owner, type } = harness({ 'a.md': 'A\n', 'b.md': 'B\n' })
    type('a.md', 'A\nTyped.\n')
    expect(await owner.flush(['a.md', 'b.md'])).toEqual({ status: 'saved' })
    expect(h.disk.get('a.md')).toBe('A\nTyped.\n')
    type('b.md', 'B\nTyped.\n')
    h.disk.set('b.md', 'Outside.\n')
    expect(await owner.flush(['b.md'])).toEqual({ status: 'refused', path: 'b.md' })
  })
})

describe('exclusive (review S5)', () => {
  it('installs its gate in the turn every path is found idle: a write of one path begun while it waited for another runs before the hold, never beside it', async () => {
    const { h, owner, type } = harness({ 'a.md': 'A\n', 'b.md': 'B\n' })
    const held = (path: string): () => void => {
      let release!: () => void
      h.holds.set(path, new Promise<void>((resolve) => { release = resolve }))
      return () => release()
    }
    type('b.md', 'B\nTyped.\n')
    const releaseB = held('b.md')
    const saveB = owner.save('b.md')
    await tick()
    let running = false
    const exclusive = owner.exclusive(['a.md', 'b.md'], async () => { running = true })
    // a.md is idle at once; while exclusive waits for b.md, a save of a.md begins and is held at main.
    await tick()
    type('a.md', 'A\nTyped.\n')
    const releaseA = held('a.md')
    const saveA = owner.save('a.md')
    await tick()
    releaseB()
    await saveB
    await tick(20)
    expect(running).toBe(false) // a.md's write is still in flight: the hold waits for it
    releaseA()
    await saveA
    await exclusive
    expect(running).toBe(true)
  })
})

describe('a proposal resolved from the Agent notes pane (residual c of parcel 2a)', () => {
  function ports(owner: ReturnType<typeof harness>['owner'], h: ReturnType<typeof harness>['h'], calls: string[]) {
    return {
      accept: (path: string, id: string, resolve: () => Promise<AcceptAnswer>) => acceptThroughOwner({
        owner,
        bufferOf: (p) => h.buffers.get(p) ?? null,
        recordInEditor: () => false,
        askAbout: () => {},
        refusalReason: () => undefined,
      }, path, id, resolve),
      inQueue: <T,>(path: string, run: () => Promise<T>) => owner.inQueue(path, run),
      resolveChange: async (id: string, action: 'accept' | 'reject'): Promise<AcceptAnswer> => {
        calls.push(`${action} ${id} with writes ${h.writes.length}`)
        return { applied: true }
      },
    }
  }

  it('an accept waits for a save of the document in flight, and runs after it', async () => {
    const { h, owner, type } = harness({ 'note.md': 'N\n' })
    const calls: string[] = []
    type('note.md', 'N\nTyped.\n')
    let release!: () => void
    h.hold = new Promise<void>((resolve) => { release = resolve })
    const save = owner.save('note.md')
    await tick()
    const resolved = resolveProposalThroughOwner(ports(owner, h, calls), { id: 'c1', path: 'note.md' }, 'accept')
    await tick(20)
    expect(calls).toEqual([]) // main is not asked while the save is held
    h.hold = null
    release()
    await save
    expect(await resolved).toEqual({ applied: true })
    expect(calls).toEqual(['accept c1 with writes 1'])
  })

  it('a discard runs in the document\'s queue, after a save asked for before it', async () => {
    const { h, owner, type } = harness({ 'note.md': 'N\n' })
    const calls: string[] = []
    type('note.md', 'N\nTyped.\n')
    let release!: () => void
    h.hold = new Promise<void>((resolve) => { release = resolve })
    const save = owner.save('note.md')
    await tick()
    const resolved = resolveProposalThroughOwner(ports(owner, h, calls), { id: 'c2', path: 'note.md' }, 'reject')
    await tick(20)
    expect(calls).toEqual([])
    h.hold = null
    release()
    await save
    expect(await resolved).toEqual({ applied: true })
    expect(calls).toEqual(['reject c2 with writes 1'])
  })
})

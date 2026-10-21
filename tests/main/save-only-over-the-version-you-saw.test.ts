// The editor's save writes only over the version the buffer was based on (spec:
// docs/plans/saving-over-an-outside-change/spec-save-only-over-the-version-you-saw.md). Main side: the basis
// is compared before anything is written and again in the tick of the rename.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeMaterial } from '../../src/main/board-material'
import { ChangedSinceRead, DiskChangedUnderBuffer, EmptyWriteRefusal, NameTaken, SaveWithoutBasis, Workspace } from '../../src/main/workspace'
import { buildE2EScriptedTurn, WorkspaceAgent } from '../../src/main/agent'
import { scriptedSessionFactory } from '@bridle/core'
import { ChangeStore } from '../../src/main/changes'
import { basisAllows, isSaveBasis, type SaveBasis } from '../../src/shared/save-basis'

const SEEN = '# Note\n\nThe version the writer saw.\n'
const OUTSIDE = '# Note\n\nWritten by another program.\n'
const MINE = '# Note\n\nThe version the writer saw, and more.\n'

let root: string
let ws: Workspace
const disk = (name = 'note.md'): Promise<string> => readFile(join(root, name), 'utf8')
const tempFiles = async (): Promise<string[]> => (await readdir(root)).filter((name) => name.endsWith('.tmp'))
const refusal = async (save: Promise<unknown>): Promise<DiskChangedUnderBuffer> => {
  try { await save } catch (error) {
    expect(error).toBeInstanceOf(DiskChangedUnderBuffer)
    return error as DiskChangedUnderBuffer
  }
  throw new Error('the save was not refused')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-save-basis-'))
  ws = new Workspace(root)
  await writeFile(join(root, 'note.md'), SEEN)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

test('a basis that matches the disk writes the buffer', async () => {
  const saved = await ws.saveEditorText('note.md', MINE, { kind: 'disk', text: SEEN })
  expect(saved.content).toBe(MINE)
  expect(await disk()).toBe(MINE)
})

test('a basis that does not match the disk writes nothing, leaves no temp file, and names what is on disk', async () => {
  await writeFile(join(root, 'note.md'), OUTSIDE)
  const refused = await refusal(ws.saveEditorText('note.md', MINE, { kind: 'disk', text: SEEN }))
  expect(refused.path).toBe('note.md')
  expect(refused.diskText).toBe(OUTSIDE)
  expect(await disk()).toBe(OUTSIDE)
  expect(await tempFiles()).toEqual([])
})

test('a file removed under the buffer is not recreated by a save based on it', async () => {
  await unlink(join(root, 'note.md'))
  const refused = await refusal(ws.saveEditorText('note.md', MINE, { kind: 'disk', text: SEEN }))
  expect(refused.diskText).toBeNull()
  expect(await readdir(root)).toEqual([])
})

test('`new` writes a file that is not there or is empty, and refuses one with content', async () => {
  expect((await ws.saveEditorText('fresh.md', MINE, { kind: 'new' })).content).toBe(MINE)
  await writeFile(join(root, 'empty.md'), '')
  expect((await ws.saveEditorText('empty.md', MINE, { kind: 'new' })).content).toBe(MINE)
  const refused = await refusal(ws.saveEditorText('note.md', MINE, { kind: 'new' }))
  expect(refused.diskText).toBe(SEEN)
  expect(await disk()).toBe(SEEN)
  expect(await tempFiles()).toEqual([])
})

test('Keep mine writes over exactly the version the banner showed, and is refused over a newer one', async () => {
  await writeFile(join(root, 'note.md'), OUTSIDE)
  const banner: SaveBasis = { kind: 'keep-mine', text: OUTSIDE }
  const newer = '# Note\n\nA second outside edit, after the banner.\n'
  await writeFile(join(root, 'note.md'), newer)
  const refused = await refusal(ws.saveEditorText('note.md', MINE, banner))
  expect(refused.diskText).toBe(newer)
  expect(await disk()).toBe(newer)
  // Against the newer version (the banner updated to it), Keep mine writes.
  expect((await ws.saveEditorText('note.md', MINE, { kind: 'keep-mine', text: newer })).content).toBe(MINE)
})

test('a change between the first comparison and the rename is caught in the rename tick (beforeCommit seam)', async () => {
  // The first comparison passes; the outside write lands after the temp file is written, just before the
  // rename. Nothing is awaited between the second comparison and the rename, so this is the last moment.
  const refused = await refusal(ws.saveEditorText('note.md', MINE, { kind: 'disk', text: SEEN }, {
    beforeCommit: () => { writeFileSync(join(root, 'note.md'), OUTSIDE) },
  }))
  expect(refused.diskText).toBe(OUTSIDE)
  expect(await disk()).toBe(OUTSIDE)
  expect(await tempFiles()).toEqual([])
  // The same for a removal in that window.
  await writeFile(join(root, 'note.md'), SEEN)
  const removed = await refusal(ws.saveEditorText('note.md', MINE, { kind: 'disk', text: SEEN }, {
    beforeCommit: () => { writeFileSync(join(root, 'gone.marker'), ''); unlinkSync(join(root, 'note.md')) },
  }))
  expect(removed.diskText).toBeNull()
  expect((await readdir(root)).sort()).toEqual(['gone.marker'])
})

test('a save without a basis, or with a malformed one, is refused and writes nothing', async () => {
  for (const basis of [undefined, null, {}, { kind: 'disk' }, { kind: 'keep-mine', text: 3 }, { kind: 'whatever', text: SEEN }]) {
    await expect(ws.saveEditorText('note.md', MINE, basis as unknown as SaveBasis)).rejects.toBeInstanceOf(SaveWithoutBasis)
  }
  expect(await disk()).toBe(SEEN)
  expect(isSaveBasis({ kind: 'new' })).toBe(true)
})

test('the basis is compared byte for byte: a CRLF/BOM file saves against its on-disk baseline, and a line-ending or BOM change by another program is a change (Sol M3)', async () => {
  const crlfBom = '\uFEFF# Note\r\n\r\nThe version the writer saw.\r\n'
  await writeFile(join(root, 'note.md'), crlfBom)
  // The editor's form of the same document is another version on disk: an outside program converted the file.
  for (const seen of ['\uFEFF# Note\n\nThe version the writer saw.\n', SEEN]) {
    expect(basisAllows({ kind: 'disk', text: seen }, crlfBom)).toBe(false)
    const refused = await refusal(ws.saveEditorText('note.md', MINE, { kind: 'disk', text: seen }))
    expect(refused.diskText).toBe(crlfBom)
  }
  expect(await disk()).toBe(crlfBom)
  // Against the bytes it was read as, the edit is written in the file's own form.
  const saved = await ws.saveEditorText('note.md', MINE, { kind: 'disk', text: crlfBom })
  expect(saved.content).toBe('\uFEFF# Note\r\n\r\nThe version the writer saw, and more.\r\n')
  expect(saved.written).toBe(saved.content)
  // Keep mine likewise: a form change after the banner is a newer version.
  await writeFile(join(root, 'note.md'), OUTSIDE.replace(/\n/g, '\r\n'))
  await refusal(ws.saveEditorText('note.md', MINE, { kind: 'keep-mine', text: OUTSIDE }))
})

test('a format change in the rename tick is caught (beforeCommit seam)', async () => {
  const refused = await refusal(ws.saveEditorText('note.md', MINE, { kind: 'disk', text: SEEN }, {
    beforeCommit: () => { writeFileSync(join(root, 'note.md'), `\uFEFF${SEEN.replace(/\n/g, '\r\n')}`) },
  }))
  expect(refused.diskText).toBe(`\uFEFF${SEEN.replace(/\n/g, '\r\n')}`)
  expect(await tempFiles()).toEqual([])
})

test('a save answers what it wrote: `written` is the bytes put on disk, and the no-write path answers the bytes it found', async () => {
  const saved = await ws.saveEditorText('note.md', MINE, { kind: 'disk', text: SEEN })
  expect(saved.written).toBe(MINE)
  const same = await ws.saveEditorText('note.md', MINE, { kind: 'disk', text: MINE })
  expect(same.written).toBe(MINE)
  expect(same.content).toBe(MINE)
})

test('a write by another program between the commit and the readback shows as content differing from written (Sol M1)', async () => {
  // The readback is saveFile's readFile; another program writes just after the rename.
  const original = ws.readFile.bind(ws)
  let raced = false
  ws.readFile = async (path: string) => {
    if (!raced) { raced = true; writeFileSync(join(root, 'note.md'), OUTSIDE) }
    return original(path)
  }
  const saved = await ws.saveEditorText('note.md', MINE, { kind: 'disk', text: SEEN })
  expect(saved.written).toBe(MINE)
  expect(saved.content).toBe(OUTSIDE)
})

test('`create` makes a new file and never replaces anything: an existing file (even empty) or folder is a taken name (Sol S7)', async () => {
  expect((await ws.saveEditorText('copy.md', MINE, { kind: 'create' })).content).toBe(MINE)
  await writeFile(join(root, 'empty.md'), '')
  await expect(ws.saveEditorText('empty.md', MINE, { kind: 'create' })).rejects.toBeInstanceOf(NameTaken)
  expect(await disk('empty.md')).toBe('')
  await mkdir(join(root, 'folder.md'))
  await expect(ws.saveEditorText('folder.md', MINE, { kind: 'create' })).rejects.toBeInstanceOf(NameTaken)
  // Taken between the check and the link: still refused, nothing replaced, no temp file.
  await expect(ws.saveFileOver('late.md', MINE, { kind: 'create' }, {
    beforeCommit: () => { writeFileSync(join(root, 'late.md'), 'Someone else.\n') },
  })).rejects.toBeInstanceOf(NameTaken)
  expect(await disk('late.md')).toBe('Someone else.\n')
  expect(await tempFiles()).toEqual([])
  // The commit itself is a create: with no check before it at all, a taken name is still not replaced.
  await expect(ws.saveFile('late.md', MINE, { exclusive: true })).rejects.toBeInstanceOf(NameTaken)
  expect(await disk('late.md')).toBe('Someone else.\n')
  expect(await tempFiles()).toEqual([])
})

test('`create`: a folder that appears at the name while the copy is staged is a taken name, not a read error (Sol S2 / Muse S2, round 2)', async () => {
  const taken = ws.saveEditorText('late-folder.md', MINE, { kind: 'create' }, {
    beforeCommit: () => { mkdirSync(join(root, 'late-folder.md')) },
  })
  await expect(taken).rejects.toBeInstanceOf(NameTaken)
  expect(await tempFiles()).toEqual([])
})

// Per-call receipts (document-owner plan, parcel 1): every write call answers what IT wrote, never what a
// workspace-wide record of writes says was written last (Sol r3 M1, Muse r3 S1).
test('two overlapping saveFile calls to one path each return their own content as `written`, with distinct seq', async () => {
  const A = '# Note\n\nWritten by call A.\n'
  const B = '# Note\n\nWritten by call B.\n'
  const [a, b] = await Promise.all([ws.saveFile('note.md', A), ws.saveFile('note.md', B)])
  expect(a.written).toBe(A)
  expect(b.written).toBe(B)
  expect(a.seq).not.toBe(b.seq)
  expect(typeof a.seq).toBe('number')
  // The readbacks may both be the later write: the receipt is the call's, the readback is the disk's.
  expect([a.content, b.content]).toContain(await disk())
})

test('an accept returns the receipt of its own write when a second writer lands between the accept and the readback (Sol r3 M1)', async () => {
  const draft = '# A\n\nThe draft is too wordy.\n'
  const accepted = '# A\n\nThe draft is concise.\n'
  const second = '# A\n\nA second writer (a link repair, another accept) wrote this.\n'
  await writeFile(join(root, 'a.md'), draft)
  const appData = await mkdtemp(join(tmpdir(), 'wf-receipt-agent-'))
  try {
    const changes = new ChangeStore(ws)
    const agent = await WorkspaceAgent.create({
      workspace: ws, appDataDir: appData, changes,
      onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    })
    const change = await changes.add({
      path: 'a.md', provenance: 'agent', editClass: 'content', category: 'wording', summary: 'Tighten',
      oldText: 'The draft is too wordy.', newText: 'The draft is concise.', isCorrection: false,
    })
    // The accept has written and is settling its status when another operation (outside this call) writes.
    let reached!: () => void
    const atStatus = new Promise<void>((resolve) => { reached = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const setStatus = changes.setStatus.bind(changes)
    changes.setStatus = async (...args: Parameters<ChangeStore['setStatus']>) => { reached(); await gate; return setStatus(...args) }
    const accepting = agent.resolveChange(change.id, 'accept')
    await atStatus
    expect(await disk('a.md')).toBe(accepted)
    // The Collection's write turn (0.23) holds the second writer until the accept's turn ends: it is asked
    // for now, lands after, and the accept's answer is still the receipt of its own write.
    const otherWrite = ws.saveFile('a.md', second)
    release()
    const result = await accepting
    const other = await otherWrite
    expect(result.applied).toBe(true)
    expect(result.receipt?.written).toBe(accepted)
    expect(result.receipt?.seq).toBeLessThan(other.seq)
    expect(await disk('a.md')).toBe(second)
  } finally {
    await rm(appData, { recursive: true, force: true })
  }
}, 30_000)

test('a live-suggestion accept (proposals.adopt under acceptScope.run) returns the receipt of its own write when a second writer lands before the readback (review gap, parcel 1)', async () => {
  const draft = '# A\n\nThe draft is too wordy.\n'
  const accepted = '# A\n\nThe draft is concise.\n'
  const second = '# A\n\nA second writer wrote this.\n'
  await writeFile(join(root, 'a.md'), draft)
  const appData = await mkdtemp(join(tmpdir(), 'wf-receipt-live-'))
  try {
    const changes = new ChangeStore(ws)
    const steps = [{ cap: 'prose.edit', input: { path: 'a.md', oldText: 'The draft is too wordy.', newText: 'The draft is concise.', category: 'wording', summary: 'Tighten' } }]
    const agent = await WorkspaceAgent.create({
      workspace: ws, appDataDir: appData, changes,
      onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
      sessionFactory: scriptedSessionFactory([buildE2EScriptedTurn(steps)]),
    })
    await agent.runScriptedTurn('Tighten', steps)
    const [suggestion] = await agent.suggestions()
    expect(suggestion?.capabilityName).toBe('prose.edit')
    const [change] = await changes.list()
    expect(change).toBeDefined()
    // The verb has written through Bridle and the accept is settling the Change's status when another
    // operation, outside this call, writes the same file.
    let reached!: () => void
    const atStatus = new Promise<void>((resolve) => { reached = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const setStatus = changes.setStatus.bind(changes)
    changes.setStatus = async (...args: Parameters<ChangeStore['setStatus']>) => { reached(); await gate; return setStatus(...args) }
    const accepting = agent.resolveChange(change!.id, 'accept')
    await atStatus
    expect(await disk('a.md')).toBe(accepted)
    // The Collection's write turn (0.23) holds the second writer until the accept's turn ends: it is asked
    // for now, lands after, and the accept's answer is still the receipt of its own write.
    const otherWrite = ws.saveFile('a.md', second)
    release()
    const result = await accepting
    const other = await otherWrite
    expect(result.applied).toBe(true)
    expect(result.receipt?.written).toBe(accepted)
    expect(result.receipt?.seq).toBeLessThan(other.seq)
    expect(await disk('a.md')).toBe(second)
    agent.dispose()
  } finally {
    await rm(appData, { recursive: true, force: true })
  }
}, 30_000)

test('a buffer that already is the disk version writes nothing and is not refused, whatever it was based on', async () => {
  await writeFile(join(root, 'note.md'), OUTSIDE)
  const saved = await ws.saveEditorText('note.md', OUTSIDE, { kind: 'disk', text: SEEN })
  expect(saved.content).toBe(OUTSIDE)
})

test('an empty save over a changed file is refused as a disk change before the empty-write rescue runs', async () => {
  await writeFile(join(root, 'note.md'), OUTSIDE)
  await refusal(ws.saveEditorText('note.md', '', { kind: 'disk', text: SEEN }))
  expect(await readdir(root)).toEqual(['note.md']) // no .writeflex/rescue copies
})

// The IPC door itself: a renderer save without a basis is refused, and a refusal comes back as data the
// renderer turns into its banner (an Error's class does not cross IPC).
const ipcProbe = String.raw`
  import { mock } from 'bun:test'
  import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  const root = await mkdtemp(join(tmpdir(), 'writeflex-save-door-'))
  const handlers = new Map()
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) }
  void mock.module('electron', () => ({
    app: { getPath: () => root, getVersion: () => '0.0.0-test', isPackaged: false },
    clipboard: { write: () => {} }, ipcMain,
    // Clear document's confirmation: another program writes while it is up, then the writer confirms.
    dialog: { showMessageBox: async () => { await writeFile(join(root, 'clear.md'), 'Written during the dialog.\n'); return { response: 1 } } },
    shell: { openExternal: async () => {}, showItemInFolder: () => {}, trashItem: async () => {} },
  }))
  const [{ registerIpc }, { registerWindow }, { Workspace }] = await Promise.all([
    import('./src/main/ipc.ts'), import('./src/main/state.ts'), import('./src/main/workspace.ts'),
  ])
  const state = registerWindow({ webContents: { id: 23, send: () => {} }, on: () => {}, isDestroyed: () => false })
  state.workspace = new Workspace(root)
  registerIpc(
    { openFolder: async () => {}, openFile: async () => {}, recents: () => [], openRecent: async () => {} },
    { modelDefaults: () => ({}), recents: () => [] },
    {},
  )
  const save = handlers.get('file:save')
  const event = { sender: { id: 23 } }
  await writeFile(join(root, 'note.md'), 'Seen.\n')
  let missing = null
  try { await save(event, { path: 'note.md', content: 'Mine.\n' }) } catch (error) { missing = String(error && error.message) }
  const afterMissing = await readFile(join(root, 'note.md'), 'utf8')
  await writeFile(join(root, 'note.md'), 'Outside.\n')
  const refused = await save(event, { path: 'note.md', content: 'Mine.\n', basis: { kind: 'disk', text: 'Seen.\n' } })
  const afterRefused = await readFile(join(root, 'note.md'), 'utf8')
  const kept = await save(event, { path: 'note.md', content: 'Mine.\n', basis: { kind: 'keep-mine', text: 'Outside.\n' } })
  const taken = await save(event, { path: 'note.md', content: 'Copy.\n', basis: { kind: 'create' } })
  await writeFile(join(root, 'clear.md'), 'Rescued before the dialog.\n')
  const cleared = await handlers.get('file:clear')(event, { path: 'clear.md' })
  const afterClear = await readFile(join(root, 'clear.md'), 'utf8')
  // goal:set answers the receipt of its own write (the goal write), not a readback.
  await writeFile(join(root, 'goal.md'), '---\ntitle: G\n---\n\nBody.\n')
  const goalSaved = await handlers.get('goal:set')(event, { path: 'goal.md', target: 10, due: null, basis: { kind: 'disk', text: '---\ntitle: G\n---\n\nBody.\n' } })
  // goal:set carries a basis like file:save (parcel 2a): none is refused; over an unseen version nothing is written.
  let goalMissing = null
  try { await handlers.get('goal:set')(event, { path: 'goal.md', target: 12, due: null }) } catch (error) { goalMissing = String(error && error.message) }
  await writeFile(join(root, 'goal.md'), '---\ntitle: G\n---\n\nWritten by another program.\n')
  const goalRefused = await handlers.get('goal:set')(event, { path: 'goal.md', target: 12, due: null, basis: { kind: 'disk', text: goalSaved.written } })
  const afterGoalRefused = await readFile(join(root, 'goal.md'), 'utf8')
  let restoreMissing = null
  try { await handlers.get('versions:restore')(event, { id: 'v1' }) } catch (error) { restoreMissing = String(error && error.message) }
  console.log(JSON.stringify({ missing, afterMissing, refused, afterRefused, kept: kept.content, taken, restoreMissing, cleared, afterClear, goal: { written: goalSaved.written, seq: goalSaved.seq, content: goalSaved.content }, goalMissing, goalRefused, afterGoalRefused }))
`

test('file:save refuses a call with no basis and returns a disk-changed refusal as data', async () => {
  const child = Bun.spawn([process.execPath, '-e', ipcProbe], { cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' })
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (exitCode !== 0) throw new Error(`file:save probe failed: ${stderr}`)
  const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}')
  expect(result.missing).toContain('did not say which version')
  expect(result.afterMissing).toBe('Seen.\n')
  expect(result.refused).toEqual({ refused: 'disk-changed', path: 'note.md', diskText: 'Outside.\n', message: expect.stringContaining('changed on disk') })
  expect(result.restoreMissing).toContain('did not say which version')
  expect(result.cleared).toMatchObject({ refused: 'disk-changed', path: 'clear.md', diskText: 'Written during the dialog.\n' })
  expect(result.afterClear).toBe('Written during the dialog.\n')
  expect(result.taken).toEqual({ refused: 'name-taken', path: 'note.md', message: expect.stringContaining('already exists') })
  expect(result.afterRefused).toBe('Outside.\n')
  expect(result.kept).toBe('Mine.\n')
  // goal:set returns the goal write's own receipt.
  expect(result.goal.written).toBe('---\ntitle: G\ngoal: 10\n---\n\nBody.\n')
  expect(typeof result.goal.seq).toBe('number')
  // goal:set over a version the buffer did not see: refused as data, nothing written (parcel 2a).
  expect(result.goalMissing).toContain('did not say which version')
  expect(result.goalRefused).toMatchObject({ refused: 'disk-changed', path: 'goal.md', diskText: '---\ntitle: G\n---\n\nWritten by another program.\n' })
  expect(result.afterGoalRefused).toBe('---\ntitle: G\n---\n\nWritten by another program.\n')
}, 30_000)

test('Clear document empties only the version that was rescued before its dialog (Muse S1)', async () => {
  await writeFile(join(root, 'note.md'), SEEN)
  let rescued: EmptyWriteRefusal | null = null
  try { await ws.saveFile('note.md', '') } catch (error) { rescued = error as EmptyWriteRefusal }
  expect(rescued).toBeInstanceOf(EmptyWriteRefusal)
  expect(rescued?.previousText).toBe(SEEN)
  // Another program writes while the dialog is up: the clear (file:clear's final write) is refused.
  await writeFile(join(root, 'note.md'), OUTSIDE)
  await refusal(ws.saveFile('note.md', '', { allowExplicitEmpty: true, beforeCommit: ws.commitOnlyOver('note.md', { kind: 'disk', text: rescued!.previousText }) }))
  expect(await disk()).toBe(OUTSIDE)
  // Over the rescued version it clears.
  await writeFile(join(root, 'note.md'), SEEN)
  await ws.saveFile('note.md', '', { allowExplicitEmpty: true, beforeCommit: ws.commitOnlyOver('note.md', { kind: 'disk', text: rescued!.previousText }) })
  expect(await disk()).toBe('')
})

test('the `create` basis allows only a name with nothing there: not even an empty file (Sol S7, pure rule)', () => {
  expect(basisAllows({ kind: 'create' }, null)).toBe(true)
  expect(basisAllows({ kind: 'create' }, '')).toBe(false)
  expect(basisAllows({ kind: 'create' }, 'Text.\n')).toBe(false)
  expect(isSaveBasis({ kind: 'create' })).toBe(true)
})

// Final review round 1, finding 1: an accept writes only over the text it read. Another program writes the
// file just after the accept has read it (while it snapshots and stages); the accept writes nothing and says
// so, and the other program's text stays for the watcher's notice.
// Since 0.23 every accept door reads the document through the guarded read, not `Workspace.readFile`, so the
// outside write is made at the accept's write instead: after its read, before its save's first check.
const outsideAfterNextRead = (path: string, text: string): { fired: () => boolean } => {
  let fired = false
  const saveFileOverRead = ws.saveFileOverRead.bind(ws)
  ws.saveFileOverRead = async (p, next, read, options) => {
    if (!fired && p === path) { fired = true; writeFileSync(join(root, path), text) }
    return saveFileOverRead(p, next, read, options)
  }
  return { fired: () => fired }
}

test('a ledger accept writes only over the text it read: an outside write after its read is not replaced (finding 1)', async () => {
  const draft = '# A\n\ncat\n\nparagraph A\n'
  const outside = '# A\n\ncat\n\nparagraph X\n'
  const appData = await mkdtemp(join(tmpdir(), 'wf-accept-basis-'))
  try {
    const changes = new ChangeStore(ws)
    const agent = await WorkspaceAgent.create({
      workspace: ws, appDataDir: appData, changes,
      onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    })
    for (const editClass of ['content', 'insert'] as const) {
      await writeFile(join(root, 'a.md'), draft)
      const change = editClass === 'content'
        ? await changes.add({ path: 'a.md', provenance: 'agent', editClass, category: 'wording', summary: 'Dog', oldText: 'cat', newText: 'dog', isCorrection: false })
        : await changes.add({ path: 'a.md', provenance: 'agent', editClass, category: 'other', summary: 'Add', oldText: '', newText: '\n\nAdded.', insertAfter: 'cat', isCorrection: false })
      const injected = outsideAfterNextRead('a.md', outside)
      const result = await agent.resolveChange(change.id, 'accept')
      expect(injected.fired()).toBe(true)
      expect(result.applied).toBe(false)
      expect(result.message).toContain('changed on disk while the change was being applied')
      expect(result.receipt).toBeUndefined()
      expect(await disk('a.md')).toBe(outside)
      expect((await changes.get(change.id))?.status).toBe('pending')
      expect(await tempFiles()).toEqual([])
    }
    agent.dispose()
  } finally {
    await rm(appData, { recursive: true, force: true })
  }
}, 30_000)

test('a live-suggestion accept (the verb run by proposals.adopt) writes only over the text it read (finding 1)', async () => {
  const draft = '# A\n\ncat\n\nparagraph A\n'
  const outside = '# A\n\ncat\n\nparagraph X\n'
  await writeFile(join(root, 'a.md'), draft)
  const appData = await mkdtemp(join(tmpdir(), 'wf-accept-basis-live-'))
  try {
    const changes = new ChangeStore(ws)
    const steps = [{ cap: 'prose.edit', input: { path: 'a.md', oldText: 'cat', newText: 'dog', category: 'wording', summary: 'Dog' } }]
    const agent = await WorkspaceAgent.create({
      workspace: ws, appDataDir: appData, changes,
      onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
      sessionFactory: scriptedSessionFactory([buildE2EScriptedTurn(steps)]),
    })
    await agent.runScriptedTurn('Dog', steps)
    const [change] = await changes.list()
    expect(change).toBeDefined()
    const injected = outsideAfterNextRead('a.md', outside)
    const result = await agent.resolveChange(change!.id, 'accept')
    expect(injected.fired()).toBe(true)
    expect(result.applied).toBe(false)
    expect(result.message).toContain('changed on disk while the change was being applied')
    expect(await disk('a.md')).toBe(outside)
    expect(await tempFiles()).toEqual([])
    agent.dispose()
  } finally {
    await rm(appData, { recursive: true, force: true })
  }
}, 30_000)

// Final review round 1, finding 2: Clear's "already empty" write empties only the empty text it found.
test('an empty write over a file with no text commits only over that text: text written while it is staged is kept (finding 2)', async () => {
  for (const found of ['', '  \n']) {
    await writeFile(join(root, 'note.md'), found)
    const refused = await refusal(ws.saveFile('note.md', '', { beforeCommit: () => { writeFileSync(join(root, 'note.md'), OUTSIDE) } }))
    expect(refused.diskText).toBe(OUTSIDE)
    expect(await disk()).toBe(OUTSIDE)
    expect(await tempFiles()).toEqual([])
  }
  // No file there: a file that appears while the empty file is staged is not replaced.
  await unlink(join(root, 'note.md'))
  await refusal(ws.saveFile('note.md', '', { beforeCommit: () => { writeFileSync(join(root, 'note.md'), OUTSIDE) } }))
  expect(await disk()).toBe(OUTSIDE)
  // Unchanged meanwhile: it empties.
  await writeFile(join(root, 'note.md'), '  \n')
  await ws.saveFile('note.md', '')
  expect(await disk()).toBe('')
})

const clearProbe = String.raw`
  import { mock } from 'bun:test'
  import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
  import { writeFileSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  const root = await mkdtemp(join(tmpdir(), 'writeflex-clear-door-'))
  const handlers = new Map()
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) }
  let asked = 0
  void mock.module('electron', () => ({
    app: { getPath: () => root, getVersion: () => '0.0.0-test', isPackaged: false },
    clipboard: { write: () => {} }, ipcMain,
    dialog: { showMessageBox: async () => { asked++; return { response: 0 } } },
    shell: { openExternal: async () => {}, showItemInFolder: () => {}, trashItem: async () => {} },
  }))
  const [{ registerIpc }, { registerWindow }, { Workspace }] = await Promise.all([
    import('./src/main/ipc.ts'), import('./src/main/state.ts'), import('./src/main/workspace.ts'),
  ])
  const state = registerWindow({ webContents: { id: 24, send: () => {} }, on: () => {}, isDestroyed: () => false })
  const workspace = new Workspace(root)
  // Another program writes the file while Clear's first (already empty) write is staged.
  const saveFile = workspace.saveFile.bind(workspace)
  let injected = false
  workspace.saveFile = (path, content, options = {}) => injected ? saveFile(path, content, options) : saveFile(path, content, {
    ...options, beforeCommit: () => { injected = true; writeFileSync(join(root, path), 'Written while Clear staged.\n'); options.beforeCommit?.() },
  })
  state.workspace = workspace
  registerIpc(
    { openFolder: async () => {}, openFile: async () => {}, recents: () => [], openRecent: async () => {} },
    { modelDefaults: () => ({}), recents: () => [] },
    {},
  )
  await writeFile(join(root, 'empty.md'), '  \n')
  const cleared = await handlers.get('file:clear')({ sender: { id: 24 } }, { path: 'empty.md' })
  const after = await readFile(join(root, 'empty.md'), 'utf8')
  const rescue = await readdir(join(root, '.writeflex/rescue')).catch(() => [])
  console.log(JSON.stringify({ injected, asked, cleared, after, rescue: rescue.length }))
`

test('Clear over a file with no text: text written while its write is staged takes the guarded path (rescue, confirmation) (finding 2)', async () => {
  const child = Bun.spawn([process.execPath, '-e', clearProbe], { cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' })
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (exitCode !== 0) throw new Error(`file:clear probe failed: ${stderr}`)
  const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}')
  expect(result.injected).toBe(true)
  // The writer is asked (and here keeps the text); nothing was cleared; both sides were rescued.
  expect(result.asked).toBe(1)
  expect(result.cleared).toBeNull()
  expect(result.after).toBe('Written while Clear staged.\n')
  expect(result.rescue).toBe(2)
}, 30_000)

// Final review round 2, finding 1: the Board's material writes (an accepted sources.attach or scraps.promote,
// and the writer's own Board steps) commit only over the text their plan read, in every branch, and each
// refusal is recorded for the call (withWriteReceipts' `refusals`) so the accept can say so by type.
test('writeMaterial writes, creates and removes only over what its plan read (round 2, finding 1)', async () => {
  const refusedBy = async (writes: Parameters<typeof writeMaterial>[1]) => {
    let thrown: unknown
    const { refusals } = await ws.withWriteReceipts(async () => { try { await writeMaterial(ws, writes) } catch (error) { thrown = error } })
    expect(thrown).toBeInstanceOf(ChangedSinceRead)
    return refusals
  }
  // An existing file changed at the moment its write is staged (after the up-front check): not replaced.
  const saveFile = ws.saveFile.bind(ws)
  let inject = true
  ws.saveFile = (p, content, options) => {
    if (inject && p === 'note.md') { inject = false; writeFileSync(join(root, 'note.md'), OUTSIDE) }
    return saveFile(p, content, options)
  }
  expect(await refusedBy([{ path: 'note.md', before: SEEN, after: MINE }])).toEqual([{ path: 'note.md', diskText: OUTSIDE }])
  expect(await disk()).toBe(OUTSIDE)
  expect(await tempFiles()).toEqual([])
  // A file the plan read and would remove, changed since: kept.
  await writeFile(join(root, 'note.md'), OUTSIDE)
  expect(await refusedBy([{ path: 'note.md', before: SEEN, after: null }])).toEqual([{ path: 'note.md', diskText: OUTSIDE }])
  expect(await disk()).toBe(OUTSIDE)
  // A file the plan found absent and would create, made by another program since: kept.
  await writeFile(join(root, 'new.md'), OUTSIDE)
  expect(await refusedBy([{ path: 'new.md', before: null, after: MINE }])).toEqual([{ path: 'new.md', diskText: OUTSIDE }])
  expect(await disk('new.md')).toBe(OUTSIDE)
  // A later file in the plan changed: checked before the first write, so nothing at all is written.
  await writeFile(join(root, 'note.md'), SEEN)
  expect(await refusedBy([{ path: 'note.md', before: SEEN, after: MINE }, { path: 'new.md', before: null, after: MINE }])).toHaveLength(1)
  expect(await disk()).toBe(SEEN)
  // Unchanged since the read: written, created and removed.
  await unlink(join(root, 'new.md'))
  await writeMaterial(ws, [{ path: 'note.md', before: SEEN, after: MINE }, { path: 'new.md', before: null, after: SEEN }])
  expect(await disk()).toBe(MINE)
  expect(await disk('new.md')).toBe(SEEN)
  await writeMaterial(ws, [{ path: 'new.md', before: SEEN, after: null }])
  expect(existsSync(join(root, 'new.md'))).toBe(false)
})

test('createFile never replaces a file that appears after its check (round 2, finding 1)', async () => {
  const exists = ws.absolute('fresh.md')
  // The file appears between createFile's check and its commit: the exclusive create refuses.
  const original = ws.recordOwnWrite.bind(ws)
  ws.recordOwnWrite = (path, at) => { if (path === 'fresh.md') writeFileSync(exists, OUTSIDE); original(path, at) }
  await expect(ws.createFile('fresh.md', MINE)).rejects.toThrow('File already exists: fresh.md')
  expect(await disk('fresh.md')).toBe(OUTSIDE)
  expect(await tempFiles()).toEqual([])
})

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Workspace } from '../../src/main/workspace'
import { FolioWorkspace } from '../../src/main/folio-workspace'
import { mixedFolio } from '../fixtures/folio-room/folio-room-fixtures'
import { writeEvidence, undoEvidence, evidencePath } from '../../src/main/folio-evidence'
import type { EvidenceOp } from '../../src/shared/folio-evidence'

// r7 review. Undo either restores exactly what the save changed, or refuses and writes nothing: it never moves, merges
// or hides text written since. S7-1: a whole-section restore matched the saved section by prefix, so text added at its
// end was carried into the section before it. S7-2: a recreated section went before the first heading with the text
// that had followed it, so a same-text heading added earlier took it to the wrong place (S8-1 below replaced that anchor).
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'wf-evidence-undo-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const changedElsewhere = { ok: false, token: null, message: 'The evidence or notes changed elsewhere. Your edit was not applied.' }
const undone = { ok: true, message: 'Undone. Other evidence and notes were kept.' }
const beta: EvidenceOp = { kind: 'item', part: 'Costs', key: 'note:beta', expect: null, value: '- [[Beta]]\n' }
const meeting = (part: string): EvidenceOp => ({ kind: 'item', part, key: 'note:meeting', expect: '- [[Meeting]]\n', value: null })

/** A real Folio whose underlying workspace counts every write. */
async function folio() {
  await mixedFolio(root)
  const inner = new Workspace(root) as unknown as Record<string, (...args: unknown[]) => unknown>
  const tally = { writes: 0 }
  for (const member of ['saveFile', 'saveFileWithoutReadBack', 'saveFileOver', 'saveFileOverRead', 'createFile']) {
    const real = inner[member].bind(inner)
    inner[member] = (...args: unknown[]) => { tally.writes++; return real(...args) }
  }
  const ws = new FolioWorkspace(inner as unknown as Workspace, 'mixed')
  const file = join(root, evidencePath(ws))
  const read = () => readFile(file, 'utf8')
  return { ws, tally, file, read, options: { session: 'undo-exact' } }
}
/** Undo is refused with the hand edit in place: nothing written, the file byte-identical, the token still good. */
async function refusedWith(f: Awaited<ReturnType<typeof folio>>, token: string, handEdited: string): Promise<void> {
  await writeFile(f.file, handEdited)
  const writes = f.tally.writes
  expect(await undoEvidence(f.ws, token, f.options)).toMatchObject(changedElsewhere)
  expect(await f.read()).toBe(handEdited)
  expect(f.tally.writes).toBe(writes)
}

test('S7-1: text added at the end of an appended section since the save refuses the Undo; untouched, it undoes exactly', async () => {
  for (const eol of ['\n', '\r\n']) {
    const f = await folio()
    const original = '## [[Intro]]\n\n### Notes\nIntro notes.\n'.replace(/\n/g, eol)
    await writeFile(f.file, original)
    const saved = await writeEvidence(f.ws, [{ ...beta, value: '- [[Beta]]' + eol }], f.options)
    expect(saved.ok).toBe(true)
    const after = await f.read()
    expect(after.startsWith(original)).toBe(true)
    // The reviewer's shape: prose at the end of the file, inside the Costs section, would have become Intro's notes.
    await refusedWith(f, saved.token!, after + 'Hand prose for Costs.' + eol)
    // The second shape: a `### Notes` block added under Costs would have become a hidden second Notes under Intro.
    await refusedWith(f, saved.token!, after + eol + '### Notes' + eol + 'Hand notes.' + eol)
    // A blank line written where the save put its separator is not taken for the separator.
    await refusedWith(f, saved.token!, after.replace('## [[Costs]]', eol + '## [[Costs]]'))
    // Put back as saved, the Undo runs and gives back the original bytes.
    await writeFile(f.file, after)
    expect(await undoEvidence(f.ws, saved.token!, f.options)).toMatchObject(undone)
    expect(await f.read()).toBe(original)
  }
})

test('S7-1, app only: attach to a part with no section, save its notes, then the first Undo is refused; in order, both undo', async () => {
  const f = await folio()
  const original = '## [[Intro]]\n\n### Notes\nIntro notes.\n'
  await writeFile(f.file, original)
  const attached = await writeEvidence(f.ws, [beta], f.options)
  const noted = await writeEvidence(f.ws, [{ kind: 'notes', part: 'Costs', expect: null, value: 'Costs notes.\n' }], f.options)
  expect([attached.ok, noted.ok]).toEqual([true, true])
  await refusedWith(f, attached.token!, await f.read())
  expect(await undoEvidence(f.ws, noted.token!, f.options)).toMatchObject(undone)
  expect(await undoEvidence(f.ws, attached.token!, f.options)).toMatchObject(undone)
  expect(await f.read()).toBe(original)
})

test('S7-1: text added at the end of an existing section after an edit that took a section restore refuses the Undo', async () => {
  const f = await folio()
  // Removing the only item of the first of two `### Evidence` subsections takes a whole-section restore (S6-2).
  const original = '## [[Intro]]\n\n### Evidence\n- [[Meeting]]\n\n### Evidence\n- [[Alpha]]\n\n## [[Method]]\n\n### Notes\nMethod notes.\n'
  await writeFile(f.file, original)
  const saved = await writeEvidence(f.ws, [meeting('Intro')], f.options)
  expect(saved.ok).toBe(true)
  const after = await f.read()
  await refusedWith(f, saved.token!, after.replace('## [[Method]]', 'Hand prose for Intro.\n\n## [[Method]]'))
  // A hand edit in another section is kept exactly where it sat.
  await writeFile(f.file, after + 'More method notes.\n')
  expect(await undoEvidence(f.ws, saved.token!, f.options)).toMatchObject(undone)
  expect(await f.read()).toBe(original + 'More method notes.\n')
})

// r8 review, S8-1: a removed section's place was re-found by look-alikes (heading text and occurrence, or the file's
// recorded ending), which a paired delete-and-add or a pasted copy satisfied elsewhere. A section an Undo recreates now
// goes back only into the whole file exactly as the save left it; any change since refuses.
test('S8-1: a removed section with a heading after it goes back only into the untouched file', async () => {
  const f = await folio()
  const original = '## Aside\n\nOne.\n\n## [[Intro]]\n\n### Evidence\n- [[Meeting]]\n\n## Aside\n\nTwo.\n'
  await writeFile(f.file, original)
  const saved = await writeEvidence(f.ws, [meeting('Intro')], f.options)
  expect(saved.ok).toBe(true)
  const after = await f.read()
  expect(after).toBe('## Aside\n\nOne.\n\n## Aside\n\nTwo.\n')
  // The reviewer's shape: the first Aside deleted and a new one appended, so the count of `## Aside` is unchanged.
  await refusedWith(f, saved.token!, '## Aside\n\nTwo.\n\n## Aside\n\nThree.\n')
  // A same-text heading added since, and a hand edit in another section, both refuse too.
  await refusedWith(f, saved.token!, '## Aside\n\nHand.\n\n' + after)
  await refusedWith(f, saved.token!, after.replace('One.\n', 'One.\nHand one.\n'))
  // Untouched, the Undo puts the section back exactly.
  await writeFile(f.file, after)
  expect(await undoEvidence(f.ws, saved.token!, f.options)).toMatchObject(undone)
  expect(await f.read()).toBe(original)
})

test('S8-1: a section removed at the end goes back only into the untouched file', async () => {
  for (const eol of ['\n', '\r\n']) {
    const f = await folio()
    const original = '## [[Method]]\n\n### Notes\nMethod notes.\n\n## [[Intro]]\n\n### Evidence\n- [[Meeting]]\n'.replace(/\n/g, eol)
    await writeFile(f.file, original)
    const saved = await writeEvidence(f.ws, [{ ...meeting('Intro'), expect: '- [[Meeting]]' + eol }], f.options)
    expect(saved.ok).toBe(true)
    const after = await f.read()
    expect(after).toBe('## [[Method]]\n\n### Notes\nMethod notes.\n\n'.replace(/\n/g, eol))
    // The reviewer's shape: a copy of the last subsection pasted at the end, so the file still ends as it did.
    const notes = after.slice(after.indexOf('### Notes'))
    await refusedWith(f, saved.token!, after + notes)
    // A section or prose added at the end, or a hand edit ahead of the end, all refuse.
    await refusedWith(f, saved.token!, after + '## [[Costs]]' + eol + eol + 'Hand.' + eol)
    await refusedWith(f, saved.token!, after + 'Hand prose.' + eol)
    await refusedWith(f, saved.token!, 'Hand lead.' + eol + eol + after)
    await writeFile(f.file, after)
    expect(await undoEvidence(f.ws, saved.token!, f.options)).toMatchObject(undone)
    expect(await f.read()).toBe(original)
  }
})

test('S8-1: removing a section from a file with no other heading undoes exactly when untouched, refuses after any edit', async () => {
  const f = await folio()
  const original = 'Lead prose.\n\n## [[Intro]]\n\n### Evidence\n- [[Meeting]]\n'
  await writeFile(f.file, original)
  const saved = await writeEvidence(f.ws, [meeting('Intro')], f.options)
  expect(saved.ok).toBe(true)
  const after = await f.read()
  await refusedWith(f, saved.token!, after + after)
  await refusedWith(f, saved.token!, after.replace('Lead', 'Hand lead'))
  await writeFile(f.file, after)
  expect(await undoEvidence(f.ws, saved.token!, f.options)).toMatchObject(undone)
  expect(await f.read()).toBe(original)
})

test('an item or notes Undo acts only on the section it left: a same-title copy added since, or an emptied heading, refuses', async () => {
  // A same-title section with the very notes the save wrote, added at the top: the Undo must not write into it.
  const f = await folio()
  const original = '## [[Intro]]\n\n### Evidence\n- [[Alpha]]\n\n### Notes\nOld.\n\n## [[Method]]\n\n### Notes\nMethod notes.\n'
  await writeFile(f.file, original)
  const noted = await writeEvidence(f.ws, [{ kind: 'notes', part: 'Intro', expect: 'Old.\n\n', value: 'New.\n\n' }], f.options)
  expect(noted.ok).toBe(true)
  const after = await f.read()
  await refusedWith(f, noted.token!, '## [[Intro]]\n\n### Notes\nNew.\n\n' + after)
  await writeFile(f.file, after)
  expect(await undoEvidence(f.ws, noted.token!, f.options)).toMatchObject(undone)
  expect(await f.read()).toBe(original)
  // Alpha removed by hand since an attach: undoing the attach would empty `### Evidence`, a heading the save did not
  // write, and take it away too. Refused.
  const attached = await writeEvidence(f.ws, [{ kind: 'item', part: 'Intro', key: 'note:beta', expect: null, value: '- [[Beta]]\n' }], f.options)
  expect(attached.ok).toBe(true)
  const withBeta = await f.read()
  expect(withBeta).toBe(original.replace('- [[Alpha]]\n', '- [[Alpha]]\n- [[Beta]]\n'))
  await refusedWith(f, attached.token!, withBeta.replace('- [[Alpha]]\n', ''))
  await writeFile(f.file, withBeta.replace('Method notes.', 'Method notes, edited by hand.'))
  expect(await undoEvidence(f.ws, attached.token!, f.options)).toMatchObject(undone)
  expect(await f.read()).toBe(original.replace('Method notes.', 'Method notes, edited by hand.'))
})

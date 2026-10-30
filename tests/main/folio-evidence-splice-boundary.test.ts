import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Workspace } from '../../src/main/workspace'
import { FolioWorkspace } from '../../src/main/folio-workspace'
import { mixedFolio } from '../fixtures/folio-room/folio-room-fixtures'
import { writeEvidence, undoEvidence, evidencePath, countAttachedEvidence } from '../../src/main/folio-evidence'
import { EVIDENCE_TWO_NOTES, EVIDENCE_TWO_SECTIONS, evidenceKey, evidenceModel, parseEvidence, type EvidenceOp } from '../../src/shared/folio-evidence'

// r4 review. S4-1: a fence flip whose resync window holds only lines the model does not cover (prose, a code sample).
// S4-2: a line edit without its line break glues the first highlight onto the item line. Both pass a model check that
// is blind there; the splice-boundary invariant refuses them because the text after the span would read differently.
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'wf-evidence-splice-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const rest = 'would change how the rest of the evidence file reads, so nothing was changed. Check the code blocks in the file and try again.'
const meeting = evidenceKey('notes/meeting.md')
const owned = '- [meeting.md](notes/meeting.md)\n  ````\n  code\n'
const tail = '## [[Method]]\n\n### Notes\nMethod notes.\n'
const blindEvidence = '## [[Intro]]\n\n### Evidence\n' + owned + '````\nPlain prose.\n```\nsample\n````\n\n### Notes\nIntro notes.\n\n' + tail
const glued = '## [[Intro]]\n\n### Evidence\n- [[Meeting]]\n  - “A quotation.”\n\n### Notes\nIntro notes.\n\n' + tail

const scenarios: Record<string, { source: string; ops: EvidenceOp[]; message: string }> = {
  'S4-1 delete: prose and a sample under Evidence would turn into code': {
    source: blindEvidence, ops: [{ kind: 'item', part: 'Intro', key: meeting, expect: owned, value: null }], message: `Changing “meeting.md” in “Intro” ${rest}`,
  },
  'S4-1 replace: the same flip by a replacement without the subtree': {
    source: blindEvidence, ops: [{ kind: 'item', part: 'Intro', key: meeting, expect: owned, value: '- [meeting.md](notes/meeting.md)\n' }], message: `Changing “meeting.md” in “Intro” ${rest}`,
  },
  'S4-1 batch: an ordinary notes edit beside the flip is not applied either': {
    source: blindEvidence, ops: [{ kind: 'notes', part: 'Method', expect: 'Method notes.\n', value: 'Changed.\n' }, { kind: 'item', part: 'Intro', key: meeting, expect: owned, value: null }], message: `Changing “meeting.md” in “Intro” ${rest}`,
  },
  'S4-2: a line edit without its line break would glue the highlight onto the item': {
    source: glued, ops: [{ kind: 'line', part: 'Intro', key: 'note:meeting', expect: '- [[Meeting]]\n', value: '- [[Meeting]]' }], message: 'Changing “Meeting” in “Intro” would join it onto the next line of the evidence file, so nothing was changed.',
  },
  // S5-2 (r5): emptying the first of two same-title sections removes it, and its Undo would land in the second.
  'S5-2: clearing the only notes of the first of two Intro sections': {
    source: '## [[Intro]]\n\n### Notes\nFirst notes.\n\n## [[Intro]]\n\n### Evidence\n- [[Meeting]]\n\n' + tail, ops: [{ kind: 'notes', part: 'Intro', expect: 'First notes.\n\n', value: null }], message: EVIDENCE_TWO_SECTIONS,
  },
  'S5-2: removing the only item of the first of two Intro sections': {
    source: '## [[Intro]]\n\n### Evidence\n- [meeting.md](notes/meeting.md)\n\n## [[Intro]]\n\n### Notes\nSecond notes.\n\n' + tail, ops: [{ kind: 'item', part: 'Intro', key: meeting, expect: '- [meeting.md](notes/meeting.md)\n', value: null }], message: EVIDENCE_TWO_SECTIONS,
  },
  'S4-3: clearing notes where the part has two Notes headings': {
    source: '## [[Intro]]\n\n### Notes\nFirst.\n\n### Notes\nSecond.\n\n' + tail, ops: [{ kind: 'notes', part: 'Intro', expect: 'First.\n\n', value: null }], message: EVIDENCE_TWO_NOTES,
  },
}

/** A real Folio whose underlying workspace counts every write and checkpoint. */
async function counted(name: string) {
  await mixedFolio(root)
  const inner = new Workspace(root) as unknown as Record<string, (...args: unknown[]) => unknown>
  const tally = { writes: 0, checkpoints: 0 }
  for (const member of ['saveFile', 'saveFileWithoutReadBack', 'saveFileOver', 'saveFileOverRead', 'createFile']) {
    const real = inner[member].bind(inner)
    inner[member] = (...args: unknown[]) => { tally.writes++; return real(...args) }
  }
  const ws = new FolioWorkspace(inner as unknown as Workspace, 'mixed')
  return { ws, tally, file: join(root, evidencePath(ws)), options: { session: name, beforeWrite: async () => { tally.checkpoints++ } } }
}

for (const [name, scenario] of Object.entries(scenarios)) {
  for (const shape of ['LF', 'CRLF', 'tilde'] as const) {
    test(`refused byte-identically with no write (${shape}): ${name}`, async () => {
      const shaped = (text: string): string => shape === 'CRLF' ? text.replace(/\n/g, '\r\n') : shape === 'tilde' ? text.replace(/`/g, '~') : text
      const source = shaped(scenario.source)
      const ops = scenario.ops.map(op => ({ ...op, expect: op.expect === null ? null : shaped(op.expect), value: op.value === null ? null : shaped(op.value) }) as EvidenceOp)
      const { ws, tally, file, options } = await counted(name)
      await writeFile(file, source)
      const answer = await writeEvidence(ws, ops, options)
      expect(answer.message).toBe(scenario.message)
      expect(answer.ok).toBe(false)
      expect(answer.token).toBeNull()
      expect(await readFile(file, 'utf8')).toBe(source)
      expect(tally).toEqual({ writes: 0, checkpoints: 0 })
    })
  }
}

test('the S4-1 file was blind to the model: the delete would have parsed exactly as intended', () => {
  // What made S4-1 reachable: the result of the splice has the intended model, so only the lexical check sees it.
  const spliced = blindEvidence.replace(owned, '')
  expect(evidenceModel(spliced)).toEqual({ ...evidenceModel(blindEvidence), sections: evidenceModel(blindEvidence).sections.map(section => section.title === 'Intro' ? { ...section, items: [] } : section) })
})

test('the same edits save when they keep the rest of the file: a line edit with its break, an unterminated last item', async () => {
  const { ws, file, options } = await counted('saves')
  await writeFile(file, glued)
  const edited = await writeEvidence(ws, [{ kind: 'line', part: 'Intro', key: 'note:meeting', expect: '- [[Meeting]]\n', value: '- [[Meeting]] (read)\n' }], options)
  expect(edited.ok).toBe(true)
  expect(parseEvidence(await readFile(file, 'utf8')).sections[0].items[0].highlights.map(highlight => highlight.quote)).toEqual(['A quotation.'])
  expect((await undoEvidence(ws, edited.token!, options)).ok).toBe(true)
  expect(await readFile(file, 'utf8')).toBe(glued)
  // A file link gets its fingerprint on the way in, and with it a line break, so its highlight stays its own line.
  const linked = glued.replace('- [[Meeting]]\n', '- [meeting.md](notes/meeting.md)\n')
  await writeFile(file, linked)
  expect((await writeEvidence(ws, [{ kind: 'line', part: 'Intro', key: meeting, expect: '- [meeting.md](notes/meeting.md)\n', value: '- [meeting.md](notes/meeting.md)' }], options)).ok).toBe(true)
  expect(parseEvidence(await readFile(file, 'utf8')).sections[0].items[0].highlights.map(highlight => highlight.quote)).toEqual(['A quotation.'])
  // At the end of the file nothing follows the line, so a value without a break keeps everything after it (nothing).
  const last = '## [[Intro]]\n\n### Evidence\n- [[Meeting]]'
  await writeFile(file, last)
  expect((await writeEvidence(ws, [{ kind: 'line', part: 'Intro', key: 'note:meeting', expect: '- [[Meeting]]', value: '- [[Meeting]] (read)' }], options)).ok).toBe(true)
  expect(await readFile(file, 'utf8')).toBe('## [[Intro]]\n\n### Evidence\n- [[Meeting]] (read)')
})

test('with two Notes headings, setting the first notes still saves; only clearing is refused', async () => {
  const { ws, file, options } = await counted('two notes')
  const source = '## [[Intro]]\n\n### Notes\nFirst.\n\n### Notes\nSecond.\n\n' + tail
  await writeFile(file, source)
  const answer = await writeEvidence(ws, [{ kind: 'notes', part: 'Intro', expect: 'First.\n\n', value: 'Rewritten.\n\n' }], options)
  expect(answer.ok).toBe(true)
  expect(await readFile(file, 'utf8')).toBe(source.replace('First.', 'Rewritten.'))
})

// St4-1: the summary resolves `[[note]]` links against the workspace's note titles, so a counted wikilink costs one
// listing; file links and wikilinks under parts that are not counted cost none.
test('the evidence count lists the workspace once when a counted part attaches a [[note]], and never otherwise', async () => {
  await mixedFolio(root)
  const real = new Workspace(root)
  let listed = 0
  const ws = new Proxy(real, { get(target, name) {
    if (name === 'listFiles') return (...args: unknown[]) => { listed++; return (target as any).listFiles(...args) }
    const value = (target as any)[name]
    return typeof value === 'function' ? value.bind(target) : value
  } }) as Workspace
  await writeFile(join(root, 'mixed/_mixed_EVIDENCE-AND-NOTES.md'), '## [[Intro]]\n\n### Evidence\n- [[Meeting]]\n- [meeting.md](notes/meeting.md)\n\n## [[Method]]\n\n### Evidence\n- [meeting.md](notes/meeting.md)\n')
  expect((await countAttachedEvidence(ws, 'mixed', ['Intro'])).counts.intro).toBe(1)
  expect(listed).toBe(1)
  listed = 0
  expect((await countAttachedEvidence(ws, 'mixed', ['Method'])).counts.method).toBe(1)
  expect(listed).toBe(0)
})

// S5-1 (r5): an item inserted without its line break before other text is saved with the file's break after it, so the
// Undo expects exactly those bytes and runs.
test('an item inserted without its line break before other text saves, and its Undo restores the file', async () => {
  for (const shape of ['LF', 'CRLF'] as const) {
    const { ws, file, options } = await counted('insert ' + shape)
    const eol = shape === 'CRLF' ? '\r\n' : '\n'
    const source = glued.replace(/\n/g, eol)
    await writeFile(file, source)
    for (const value of ['- [[Beta]]', '- [[Beta]]' + eol + '  - “Q.”']) {
      const saved = await writeEvidence(ws, [{ kind: 'item', part: 'Intro', key: 'note:beta', expect: null, value }], options)
      expect(saved.ok).toBe(true)
      const items = parseEvidence(await readFile(file, 'utf8')).sections[0].items
      expect(items.map(item => item.raw)).toEqual([`- [[Meeting]]${eol}  - “A quotation.”${eol}`, value + eol])
      const undone = await undoEvidence(ws, saved.token!, options)
      expect(undone.message).toBe('Undone. Other evidence and notes were kept.')
      expect(await readFile(file, 'utf8')).toBe(source)
    }
  }
})

test('with two Intro sections, an edit that leaves the first one with content still saves and undoes', async () => {
  const { ws, file, options } = await counted('two sections')
  const source = '## [[Intro]]\n\n### Evidence\n- [[Meeting]]\n\n### Notes\nFirst notes.\n\n## [[Intro]]\n\n### Notes\nSecond notes.\n\n' + tail
  await writeFile(file, source)
  const saved = await writeEvidence(ws, [{ kind: 'notes', part: 'Intro', expect: 'First notes.\n\n', value: null }], options)
  expect(saved.ok).toBe(true)
  expect((await undoEvidence(ws, saved.token!, options)).ok).toBe(true)
  expect(await readFile(file, 'utf8')).toBe(source)
})

// S6-1 (r6): an insert whose value ends in a break that is not the file's own (a bare `\r` in an LF file coalesced with
// the break written after it). Every value's breaks become the file's on the way in, and no save keeps an Undo that
// does not give back the original bytes.
test('items inserted with any line break, or none, in LF, CRLF and CR files save and undo byte for byte', async () => {
  for (const [shape, eol] of [['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r']] as const) {
    const { ws, file, options } = await counted('S6-1 ' + shape)
    const source = glued.replace(/\n/g, eol)
    for (const end of ['\n', '\r\n', '\r', '']) {
      await writeFile(file, source)
      for (const value of ['- [[Beta]]' + end, '- [[Beta]]' + (end || '\n') + '  - “Q.”' + end]) {
        const saved = await writeEvidence(ws, [{ kind: 'item', part: 'Intro', key: 'note:beta', expect: null, value }], options)
        expect(saved).toMatchObject({ ok: true, message: 'Saved the evidence and notes.' })
        const items = parseEvidence(await readFile(file, 'utf8')).sections[0].items
        expect(items.map(item => item.raw)).toEqual([`- [[Meeting]]${eol}  - “A quotation.”${eol}`, value.replace(/\r\n|\r|\n/g, eol).replace(/(?<![\r\n])$/, eol)])
        expect((await undoEvidence(ws, saved.token!, options)).message).toBe('Undone. Other evidence and notes were kept.')
        expect(await readFile(file, 'utf8')).toBe(source)
      }
    }
  }
})

// S6-2 (r6): two `### Evidence` subsections in one part, and the only item of the first removed. The first subsection
// goes with it; the Undo puts back the whole section as it was, heading included, rather than re-adding the item under
// the surviving subsection.
test('removing the only item of the first of two Evidence subsections saves, and Undo restores the file byte for byte', async () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    const { ws, file, options } = await counted('S6-2 ' + JSON.stringify(eol))
    const source = ('## [[Intro]]\n\n### Evidence\n- [[Alpha]]\n\n### Evidence\n- [[Meeting]]\n\n### Notes\nIntro notes.\n\n' + tail).replace(/\n/g, eol)
    await writeFile(file, source)
    const saved = await writeEvidence(ws, [{ kind: 'item', part: 'Intro', key: 'note:alpha', expect: '- [[Alpha]]' + eol, value: null }], options)
    expect(saved.ok).toBe(true)
    const after = await readFile(file, 'utf8')
    expect(after).toBe(source.replace(`### Evidence${eol}- [[Alpha]]${eol}${eol}`, ''))
    expect(parseEvidence(after).sections[0].items.map(item => item.target)).toEqual(['Meeting'])
    expect((await undoEvidence(ws, saved.token!, options)).message).toBe('Undone. Other evidence and notes were kept.')
    expect(await readFile(file, 'utf8')).toBe(source)
  }
})

test('a whole-section restore is an Undo only: a save that sends one is refused and writes nothing', async () => {
  const { ws, tally, file, options } = await counted('restore authority')
  await writeFile(file, glued)
  const restore = { kind: 'section', part: 'Intro', before: '', expect: glued.slice(0, glued.indexOf('## [[Method]]')), value: '', next: null }
  const answer = await writeEvidence(ws, [restore as unknown as EvidenceOp], options)
  expect(answer).toMatchObject({ ok: false, message: 'Invalid evidence edit.' })
  expect(await readFile(file, 'utf8')).toBe(glued)
  expect(tally).toEqual({ writes: 0, checkpoints: 0 })
})

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Workspace } from '../../src/main/workspace'
import { FolioWorkspace } from '../../src/main/folio-workspace'
import { mixedFolio } from '../fixtures/folio-room/folio-room-fixtures'
import { writeEvidence, undoEvidence, evidencePath } from '../../src/main/folio-evidence'
import { applyEvidenceOps, undoEvidenceOps, evidenceKey, evidenceModel, leavesFenceOpen, parseEvidence, parseEvidenceLink, type EvidenceOp } from '../../src/shared/folio-evidence'

// S3-1 (r3 review): an item's span can own a fence line whose removal re-pairs later fences and resyncs before the next
// `##` heading. Every such write must be refused whole: the parsed model of the result must be the op's intended model.
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'wf-evidence-model-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const meeting = evidenceKey('notes/meeting.md')
const owned = '- [meeting.md](notes/meeting.md)\n  ````\n  code\n'
const replacement = '- [meeting.md](notes/meeting.md)\n'
const removeOwned = (part = 'Intro'): EvidenceOp => ({ kind: 'item', part, key: meeting, expect: owned, value: null })
const replaceOwned: EvidenceOp = { kind: 'item', part: 'Intro', key: meeting, expect: owned, value: replacement }
const tail = '## [[Method]]\n\n### Notes\nMethod notes.\n\n## [[Costs]]\n\n### Notes\nCosts notes.\n'

const scenarios: Record<string, { source: string; ops: EvidenceOp[]; titles: string[] }> = {
  // (a) Intro's own `### Notes` falls inside the fence the item's column-0 closer opens once the item is gone.
  'own notes hidden': {
    source: '## [[Intro]]\n\n### Evidence\n' + owned + '````\n\n### Notes\nIntro notes.\n```\nx\n````\n\n' + tail,
    ops: [removeOwned()], titles: ['Intro', 'Method', 'Costs'],
  },
  'own notes hidden by a replace': {
    source: '## [[Intro]]\n\n### Evidence\n' + owned + '````\n\n### Notes\nIntro notes.\n```\nx\n````\n\n' + tail,
    ops: [replaceOwned], titles: ['Intro', 'Method', 'Costs'],
  },
  // (a, second form) a fenced phantom item becomes a real one the room never attached.
  'fenced phantom exposed': {
    source: '## [[Intro]]\n\n### Evidence\n- [meeting.md](notes/meeting.md)\n  ````\n- [phantom.md](notes/phantom.md)\n````\n```\nx\n````\n\n### Notes\nIntro notes.\n\n' + tail,
    ops: [{ kind: 'item', part: 'Intro', key: meeting, expect: '- [meeting.md](notes/meeting.md)\n  ````\n', value: null }], titles: ['Intro', 'Method', 'Costs'],
  },
  // (b) Two Method headings, the first fenced: removing the Intro item swaps which one Method reads.
  'duplicate section swap': {
    source: '## [[Intro]]\n\n### Evidence\n- [other.md](notes/other.md)\n' + owned + '## [[Method]]\n\n### Notes\nReal notes.\n````\n## [[Method]]\n\n### Notes\nShadow notes.\n```\ny\n````\n\n## [[Costs]]\n\n### Notes\nCosts notes.\n',
    ops: [removeOwned()], titles: ['Intro', 'Method', 'Costs'],
  },
  // (c) The removal empties the first Intro's `### Evidence` while the flip hides the second Intro section.
  'cleanEmpty allowance spent elsewhere': {
    source: '## [[Intro]]\n\n### Evidence\n' + owned + '\n### Notes\nFirst notes.\n````\n\n## [[Intro]]\n\n### Notes\nSecond notes.\n```\nz\n````\n\n' + tail,
    ops: [removeOwned()], titles: ['Intro', 'Intro', 'Method', 'Costs'],
  },
  // Undo of a batch: an ordinary Method notes edit beside the damaging removal. The batch is refused whole, so there
  // is no half-applied edit and no Undo that could never succeed.
  'batch with an ordinary edit': {
    source: '## [[Intro]]\n\n### Evidence\n' + owned + '````\n\n### Notes\nIntro notes.\n```\nx\n````\n\n' + tail,
    ops: [{ kind: 'notes', part: 'Method', expect: 'Method notes.\n\n', value: 'Changed.\n\n' }, removeOwned()], titles: ['Intro', 'Method', 'Costs'],
  },
}

for (const [name, scenario] of Object.entries(scenarios)) {
  test(`refused byte-identically with no write: ${name}`, async () => {
    expect(parseEvidence(scenario.source).sections.map(section => section.title)).toEqual(scenario.titles)
    await mixedFolio(root)
    // Every writing member of the workspace underneath the room counts as a write.
    const inner = new Workspace(root) as unknown as Record<string, (...args: unknown[]) => unknown>
    let writes = 0, checkpoints = 0
    for (const member of ['saveFile', 'saveFileWithoutReadBack', 'saveFileOver', 'saveFileOverRead', 'createFile']) {
      const real = inner[member].bind(inner)
      inner[member] = (...args: unknown[]) => { writes++; return real(...args) }
    }
    const ws = new FolioWorkspace(inner as unknown as Workspace, 'mixed')
    const file = join(root, evidencePath(ws))
    await writeFile(file, scenario.source)
    const answer = await writeEvidence(ws, scenario.ops, { session: name, beforeWrite: async () => { checkpoints++ } })
    expect(answer.ok).toBe(false)
    expect(answer.message).toBe('Changing “meeting.md” in “Intro” would change how the rest of the evidence file reads, so nothing was changed. Check the code blocks in the file and try again.')
    expect(answer.token).toBeNull()
    expect(await readFile(file, 'utf8')).toBe(scenario.source)
    expect([writes, checkpoints]).toEqual([0, 0])
  })
}

test('the same scenarios in CRLF and with ~~~ fences are refused too', () => {
  for (const scenario of Object.values(scenarios)) {
    for (const source of [scenario.source.replace(/\n/g, '\r\n'), scenario.source.replace(/`/g, '~')]) {
      const crlf = source.includes('\r\n')
      const ops = scenario.ops.map(op => {
        const shaped = (text: string | null): string | null => text === null ? null : crlf ? text.replace(/\n/g, '\r\n') : text.replace(/`/g, '~')
        return { ...op, expect: shaped(op.expect), value: shaped(op.value) } as EvidenceOp
      })
      expect(() => applyEvidenceOps(source, ops)).toThrow('would change how the rest of the evidence file reads')
    }
  }
})

test('after the refusal the ordinary edit alone saves and its Undo restores the file', async () => {
  await mixedFolio(root)
  const ws = new FolioWorkspace(new Workspace(root), 'mixed')
  const file = join(root, evidencePath(ws))
  const source = scenarios['batch with an ordinary edit'].source
  await writeFile(file, source)
  const saved = await writeEvidence(ws, [scenarios['batch with an ordinary edit'].ops[0]], { session: 'ordinary' })
  expect(saved.ok).toBe(true)
  expect(evidenceModel(await readFile(file, 'utf8')).sections.map(section => section.notes)).toEqual([
    'Intro notes.\n```\nx\n````', 'Changed.', 'Costs notes.',
  ])
  expect((await undoEvidence(ws, saved.token!, { session: 'ordinary' })).ok).toBe(true)
  expect(await readFile(file, 'utf8')).toBe(source)
})

// Property sweep: fences of several kinds in five slots of six layouts; every op on every parsed item and notes either
// refuses or leaves exactly its intended change, judged here by separate oracles: section byte slices, and (S4-1, S4-2)
// the full bytes after the op's span with the fence state they are read in. The last three layouts put model-blind
// lines — plain prose, highlights, a plain `##` section, an unknown `###`, a second `### Notes` — where a flip can reach.
const fences = ['', '```', '````', '~~~', '~~~~']
const at = (fence: string, indent = ''): string => fence ? indent + fence + '\n' : ''
const layouts: Array<(slot: string[]) => string> = [
  slot => `Lead\n\n## [[Intro]]\n\n### Evidence\n- [meeting.md](notes/meeting.md)\n${at(slot[0], '  ')}  code\n- [phantom.md](notes/phantom.md)\n${at(slot[1])}\n### Notes\nIntro notes.\n${at(slot[2])}x\n${at(slot[3])}\n## [[Method]]\n\n### Notes\nMethod notes.\n${at(slot[4])}\n## [[Costs]]\n\n### Evidence\n- [other.md](notes/other.md)\n`,
  slot => `## [[Intro]]\n\n### Evidence\n- [meeting.md](notes/meeting.md)\n${at(slot[0], '  ')}## [[Method]]\n\n### Notes\nReal.\n${at(slot[1])}## [[Method]]\n\n### Notes\nShadow.\n${at(slot[2])}y\n${at(slot[3])}\n## [[Costs]]\n\n### Notes\nCosts.\n${at(slot[4])}`,
  slot => `## [[Intro]]\n\n### Evidence\n- [meeting.md](notes/meeting.md)\n${at(slot[0], '  ')}  code\n\n### Notes\nFirst.\n${at(slot[1])}\n## [[Intro]]\n\n### Evidence\n- [other.md](notes/other.md)\n${at(slot[2], '  ')}\n### Notes\nSecond.\n${at(slot[3])}z\n${at(slot[4])}\n## [[Method]]\n\n### Notes\nMethod.\n`,
  // S4-1's shape: plain prose and a sample under `### Evidence`, prose before a `###`, a plain `##` and an unknown `###`.
  slot => `Lead\n\n## [[Intro]]\n\nIntro prose.\n\n### Evidence\n- [meeting.md](notes/meeting.md)\n${at(slot[0], '  ')}  code\n${at(slot[1])}Plain prose.\n${at(slot[2])}sample\n${at(slot[3])}\n### Notes\nIntro notes.\n\n## Plain heading\n\nLoose prose.\n${at(slot[4])}more\n\n## [[Method]]\n\nMethod prose.\n\n### Other\nUnknown body.\n\n### Notes\nMethod notes.\n`,
  // Highlights, quoted and linked, with fences between them and a list line that is no item.
  slot => `## [[Intro]]\n\n### Evidence\n- [meeting.md](notes/meeting.md)\n  - “First quote.”\n${at(slot[0], '  ')}  - “Second quote.”\n${at(slot[1])}- [[Meeting]]\n  - [[Meeting#Part]]\n${at(slot[2], '  ')}- not a link\n${at(slot[3])}\n### Notes\nNotes.\n${at(slot[4])}\n## [[Method]]\n\n### Evidence\n- [other.md](notes/other.md)\n  - “Other quote.”\n`,
  // A second `### Notes` in the same part.
  slot => `## [[Intro]]\n\n### Evidence\n- [meeting.md](notes/meeting.md)\n${at(slot[0], '  ')}  code\n${at(slot[1])}\n### Notes\nFirst.\n${at(slot[2])}\n### Notes\nSecond.\n${at(slot[3])}w\n${at(slot[4])}\n## [[Method]]\n\n### Notes\nMethod.\n`,
  // S5-2: duplicate sections whose first holds one thing only, so an op can empty it: notes first, then an item first.
  slot => `## [[Intro]]\n\n### Notes\nOnly notes.\n${at(slot[0])}\n## [[Intro]]\n\n### Evidence\n- [meeting.md](notes/meeting.md)\n${at(slot[1], '  ')}  code\n${at(slot[2])}\n## [[Method]]\n\n### Evidence\n- [other.md](notes/other.md)\n${at(slot[3], '  ')}\n## [[Method]]\n\n### Notes\nMethod notes.\n${at(slot[4])}`,
  // S6-2: two `### Evidence` subsections in one part, the first holding one item, so an op can empty it.
  slot => `Lead\n\n## [[Intro]]\n\n### Evidence\n- [meeting.md](notes/meeting.md)\n${at(slot[0], '  ')}\n### Evidence\n- [[Meeting]]\n${at(slot[1], '  ')}  code\n${at(slot[2])}\n### Notes\nIntro notes.\n${at(slot[3])}\n## [[Method]]\n\n### Evidence\n- [other.md](notes/other.md)\n${at(slot[4])}`,
]
function* placements(depth: number, kinds: readonly string[] = fences, prefix: string[] = []): Generator<string[]> {
  if (prefix.length === depth) { yield prefix; return }
  for (const fence of kinds) yield* placements(depth, kinds, [...prefix, fence])
}
const trimmed = (text: string): string => text.replace(/\s+$/, '')
// St6-1: values end in every kind of line break or none, whatever the file's own break is.
const endings = ['\n', '\r\n', '\r', '']
const inserts = (endings: readonly string[]): string[] => endings.flatMap(end => ['- [[Beta]]' + end, '- [[Beta]]' + (end || '\n') + '  - “Q.”' + end])
function opsFor(source: string, ends: readonly string[]): EvidenceOp[] {
  const ops: EvidenceOp[] = []
  const seen = new Set<string>()
  for (const section of parseEvidence(source).sections) {
    const part = section.title
    if (seen.has(part)) continue
    seen.add(part)
    for (const item of section.items) {
      const bare = item.line.replace(/[\r\n]+$/, '')
      ops.push({ kind: 'item', part, key: item.key, expect: item.raw, value: null })
      // S4-2: a line edit with and without its line break.
      ops.push({ kind: 'line', part, key: item.key, expect: item.line, value: bare })
      for (const end of ends.filter(Boolean)) {
        ops.push({ kind: 'item', part, key: item.key, expect: item.raw, value: bare + end })
        ops.push({ kind: 'line', part, key: item.key, expect: item.line, value: bare + ' edited' + end })
      }
    }
    for (const end of ends) ops.push({ kind: 'notes', part, expect: section.notes?.raw ?? null, value: 'Replaced.' + end + end })
    if (section.notes) ops.push({ kind: 'notes', part, expect: section.notes.raw, value: null })
    // S5-1, S6-1: item inserts, terminated and not, one line and with a highlight.
    for (const value of inserts(ends)) ops.push({ kind: 'item', part, key: 'note:beta', expect: null, value })
  }
  // A part with no section yet: the section is appended, for notes and for an item.
  ops.push({ kind: 'notes', part: 'Extra', expect: null, value: 'Extra notes.\n\n' })
  for (const value of inserts(ends)) ops.push({ kind: 'item', part: 'Extra', key: 'note:beta', expect: null, value })
  return ops
}
/** The op as the file saves it: every line break of its value is the file's own. */
const asSaved = (source: string, op: EvidenceOp): EvidenceOp => {
  const eol = /\r\n|\n|\r/.exec(source)?.[0] ?? '\n'
  return { ...op, value: op.value === null ? null : op.value.replace(/\r\n|\r|\n/g, eol) } as EvidenceOp
}
/** The oracle: the op's first section shows exactly the change; every other section keeps its bytes. */
function holds(before: string, op: EvidenceOp, after: string): boolean {
  const old = parseEvidence(before).sections, now = parseEvidence(after).sections
  const index = old.findIndex(section => section.title === op.part)
  const own = old[index]
  const added = op.kind === 'notes' ? { notes: op.value === null ? null : trimmed(op.value), items: [] as string[][] } : { notes: null, items: op.value === null ? [] : [[op.key, trimmed(op.value)]] }
  const slice = (source: string, section: { from: number; to: number }) => trimmed(source.slice(section.from, section.to))
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  // A missing part: every section keeps its bytes and one section, with exactly the op's change, is added at the end.
  if (!own) return now.length === old.length + 1 && now.at(-1)!.title === op.part && same(old.map(section => slice(before, section)), now.slice(0, -1).map(section => slice(after, section)))
    && same(now.at(-1)!.items.map(item => [item.key, trimmed(item.raw)]), added.items) && (now.at(-1)!.notes ? trimmed(now.at(-1)!.notes!.raw) : null) === added.notes
  const others = (list: typeof old, source: string, skip: number) => list.filter((_, n) => n !== skip).map(section => slice(source, section))
  const insert = op.kind === 'item' && op.expect === null
  const changed = (item: (typeof own.items)[number]): string | null => op.kind === 'notes' || item.key !== op.key ? item.raw : op.kind === 'line' ? op.value + item.raw.slice(item.line.length) : op.value
  const keyed = (item: (typeof own.items)[number]): string => op.kind === 'line' && item.key === op.key ? parseEvidenceLink(op.value)!.key : item.key
  const wantItems = own.items.flatMap(item => { const raw = changed(item); return raw === null ? [] : [[keyed(item), trimmed(raw)]] })
  const wantNotes = op.kind === 'notes' ? op.value === null ? null : trimmed(op.value) : own.notes ? trimmed(own.notes.raw) : null
  // An insert adds one item to the part's list.
  if (insert) wantItems.push(added.items[0])
  // Only an emptied section may go; nothing else may appear or vanish.
  if (now.length === old.length - 1) return wantItems.length === 0 && wantNotes === null && same(others(old, before, index), now.map(section => slice(after, section)))
  if (now.length !== old.length || now[index].title !== op.part) return false
  return same(others(old, before, index), others(now, after, index))
    && same(now[index].items.map(item => [item.key, trimmed(item.raw)]).sort(), insert ? [...wantItems].sort() : wantItems)
    && (now[index].notes ? trimmed(now[index].notes!.raw) : null) === wantNotes
}

/** The fence state a scan carries into offset `at`, written out here apart from the module's own scanner. */
function fenceBefore(source: string, at: number): string {
  let open: { char: string; size: number } | null = null
  for (const line of source.slice(0, at).replace(/^﻿/, '').split(/\r\n|\n|\r/)) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (!fence) continue
    if (!open) open = { char: fence[1][0], size: fence[1].length }
    else if (fence[1][0] === open.char && fence[1].length >= open.size && !line.slice(fence[0].length).trim()) open = null
  }
  return JSON.stringify(open)
}
const opensLine = (source: string, at: number): boolean => at === 0 || at === source.length || /[\r\n]/.test(source[at - 1]) && !(source[at - 1] === '\r' && source[at] === '\n')
/** The byte range of `before` an op replaces, from the parse before it. */
function spanOf(before: string, op: EvidenceOp): { from: number; to: number; end: number } {
  const own = parseEvidence(before).sections.find(section => section.title === op.part)
  // A missing part is appended at the end of the file; an insert goes after the last item of the part's evidence list
  // when it can, else at the end of the part's evidence.
  if (!own) return { from: before.length, to: before.length, end: before.length }
  if (op.kind === 'item' && op.expect === null) {
    const last = own.evidence ? own.items.filter(item => item.from >= own.evidence!.bodyFrom && item.from < own.evidence!.to).at(-1) : undefined
    const at = last && fenceBefore(before, last.to) === 'null' ? last.to : own.evidence?.to ?? own.notes?.from ?? own.to
    return { from: at, to: at, end: own.to }
  }
  if (op.kind === 'notes') return own.notes ? { from: op.value === null ? own.notes.from : own.notes.bodyFrom, to: own.notes.to, end: own.to } : { from: own.to, to: own.to, end: own.to }
  const item = own.items.find(item => item.key === op.key)!
  return { from: item.from, to: op.kind === 'line' ? item.from + item.line.length : item.to, end: own.to }
}
/** S4-1/S4-2 oracle: the bytes after the op's span survive whole — past only the blank run an emptied subsection or
 *  section may take with it — and the scan enters them on a line start in the same fence state. */
function keepsRest(before: string, op: EvidenceOp, after: string): boolean {
  const span = spanOf(before, op)
  const blank = /^\s*/.exec(before.slice(span.to))![0].length
  for (let k = 0; k <= blank && span.to + k <= span.end; k++) {
    const rest = before.slice(span.to + k)
    if (!after.endsWith(rest)) continue
    if (!rest) return true
    const now = after.length - rest.length
    if (opensLine(before, span.to + k) && opensLine(after, now) && fenceBefore(before, span.to + k) === fenceBefore(after, now)) return true
  }
  return false
}

/** Every op on one file: refused whole, or saved with exactly its intended model, the rest kept, and an Undo that gives
 *  back the original bytes exactly. */
function sweep(sources: Iterable<string>, ends: readonly string[]) {
  const tally = { saved: 0, refused: 0, undone: 0, insertsUndone: 0, mixedUndone: 0 }
  const failures: string[] = []
  for (const source of sources) {
    const eol = /\r\n|\n|\r/.exec(source)?.[0] ?? '\n'
    for (const op of opsFor(source, ends)) {
      let result
      try { result = applyEvidenceOps(source, [op]) } catch { tally.refused++; continue }
      if (result.source === source) continue
      tally.saved++
      const where = `${JSON.stringify(source)} ${JSON.stringify(op)}`
      if (!holds(source, asSaved(source, op), result.source)) { failures.push('model ' + where); continue }
      if (!keepsRest(source, op, result.source)) { failures.push('rest ' + where); continue }
      // No saved op leaves an item or notes Undo that the write path would always reject (r4: a fence-owning deletion).
      if (result.inverse.some(back => back.kind !== 'section' && back.value !== null && leavesFenceOpen(back.value))) { failures.push('inverse ' + where); continue }
      // The Undo oracle: it runs, and it gives back the original bytes exactly.
      try {
        const undo = undoEvidenceOps(result.source, result.inverse)
        if (undo.refused.length) { failures.push(`undo refused ${where}`); continue }
        if (undo.source !== source) { failures.push(`undo ${where}`); continue }
        tally.undone++
        if (op.kind === 'item' && op.expect === null) tally.insertsUndone++
        if (op.value !== null && /[\r\n]/.test(op.value) && op.value.replace(/\r\n|\r|\n/g, eol) !== op.value) tally.mixedUndone++
      } catch (error) { failures.push(`undo threw ${where}: ${(error as Error).message}`) }
    }
  }
  return { tally, failures }
}

for (const [n, layout] of layouts.entries()) {
  test(`fence placement sweep, layout ${n}: every op either refuses or yields exactly its intended model, keeps the rest and undoes byte for byte`, () => {
    const { tally, failures } = sweep((function* () { for (const slot of placements(5)) yield layout(slot) })(), ['\n', ''])
    expect(failures).toEqual([])
    // The sweep exercises both outcomes, and the S3-1 and S4 shapes are among the refusals.
    expect(tally.saved).toBeGreaterThan(1000)
    expect(tally.refused).toBeGreaterThan(100)
    expect(tally.undone).toBeGreaterThan(1000)
    // Inserts, terminated and not, into existing and appended parts, save and undo.
    expect(tally.insertsUndone).toBeGreaterThan(1000)
  }, 60_000)

  // St6-1: LF, CRLF and CR files, each with values ending in `\n`, `\r\n`, a bare `\r` or nothing.
  test(`line-break sweep, layout ${n}: values ending in every break, in LF, CRLF and CR files, undo byte for byte`, () => {
    const shapes = ['\n', '\r\n', '\r'].flatMap(eol => [...placements(5, ['', '```', '~~~~'])].map(slot => layout(slot).replace(/\n/g, eol)))
    const { tally, failures } = sweep(shapes, endings)
    expect(failures).toEqual([])
    expect(tally.saved).toBeGreaterThan(1000)
    expect(tally.insertsUndone).toBeGreaterThan(500)
    // Values whose breaks are not the file's own are saved with the file's breaks and still undo exactly.
    expect(tally.mixedUndone).toBeGreaterThan(500)
  }, 60_000)
}

// St7-1 (r7): batches of two and three ops across parts, a share of them taking a whole-section Undo. A saved batch is
// the same file its ops give one at a time, and its Undo gives back the original bytes exactly.
/** A fixed, seeded choice, so a failure names a batch that can be run again. */
function* seeded(seed: number): Generator<number> { let s = seed; for (;;) { s = (s * 1103515245 + 12345) % 2147483648; yield s } }
function batchesFor(source: string, ends: readonly string[], count: number, seed: number): EvidenceOp[][] {
  const ops = opsFor(source, ends)
  const random = seeded(seed)
  const pick = () => ops[random.next().value! % ops.length]
  const batches: EvidenceOp[][] = []
  while (batches.length < count) {
    const first = pick()
    // Across parts: the second op is on another part; a third, when there is one, on any part.
    const others = ops.filter(op => op.part !== first.part)
    if (!others.length) break
    const batch = [first, others[random.next().value! % others.length]]
    if (batches.length % 2) batch.push(pick())
    batches.push(batch)
  }
  return batches
}
const singly = (source: string, ops: readonly EvidenceOp[]): string => ops.reduce((text, op) => applyEvidenceOps(text, [op]).source, source)

for (const [n, layout] of layouts.entries()) {
  test(`batch sweep, layout ${n}: a saved batch is its ops one at a time, and its Undo gives back the original bytes`, () => {
    const tally = { saved: 0, sectionUndone: 0 }
    const failures: string[] = []
    const sources = ['\n', '\r\n'].flatMap(eol => [...placements(5, ['', '```'])].map(slot => layout(slot).replace(/\n/g, eol)))
    for (const [k, source] of sources.entries()) {
      for (const batch of batchesFor(source, ['\n', ''], 40, n * 1000 + k)) {
        let result
        try { result = applyEvidenceOps(source, batch) } catch { continue }
        if (result.source === source) continue
        tally.saved++
        const where = `${JSON.stringify(source)} ${JSON.stringify(batch)}`
        try { if (singly(source, batch) !== result.source) { failures.push('batch ' + where); continue } } catch (error) { failures.push(`singly threw ${where}: ${(error as Error).message}`); continue }
        const undo = undoEvidenceOps(result.source, result.inverse)
        if (undo.refused.length || undo.source !== source) { failures.push('undo ' + where); continue }
        if (result.inverse.some(back => back.kind === 'section')) tally.sectionUndone++
      }
    }
    expect(failures).toEqual([])
    expect(tally.saved).toBeGreaterThan(500)
    // Some batches hold an op whose narrow inverse would not restore the bytes, so they take a section restore.
    expect(tally.sectionUndone).toBeGreaterThan(100)
  }, 60_000)
}

// St7-1 (r7): text written by hand between a save and its Undo. Each hand edit is a place named by the file's structure,
// so it can be made in the saved file and in the original alike. The oracle: the Undo is refused (and so writes nothing),
// or it gives exactly the original with the same hand edit made where it sat. It never moves, merges or hides that text.
/** A hand edit, fixed from the original file, the op and the saved file, then made in the saved file and in the
 *  original alike. */
type HandEdit = (original: string, op: EvidenceOp, saved: string) => (text: string) => string | null
const eolOf = (text: string): string => /\r\n|\n|\r/.exec(text)?.[0] ?? '\n'
const opens = (text: string, at: number): boolean => at === 0 || /[\r\n]/.test(text[at - 1])
/** Insert `lines` (each followed by the file's break) at `at`, on a line of their own. */
const insertLines = (text: string, at: number, lines: string[]): string => {
  const eol = eolOf(text)
  return text.slice(0, at) + (opens(text, at) ? '' : eol) + lines.map(line => line + eol).join('') + text.slice(at)
}
const sectionOf = (text: string, part: string) => parseEvidence(text).sections.find(section => section.title === part)
const atEndOf = (part: string | undefined, lines: string[]) => (text: string) => { const own = part === undefined ? undefined : sectionOf(text, part); return own ? insertLines(text, own.to, lines) : null }
const handEdits: Record<string, HandEdit> = {
  'prose at the end of the same section': (_, op) => atEndOf(op.part, ['Hand prose.']),
  'prose at the end of another section': (original, op) => atEndOf(parseEvidence(original).sections.find(section => section.title !== op.part)?.title, ['Other hand prose.']),
  'a Notes heading at the end of the same section': (_, op) => atEndOf(op.part, ['', '### Notes', 'Hand notes.', '']),
  'a same-title section at the top': (_, op) => text => insertLines(text, 0, [`## [[${op.part}]]`, '', 'Hand section.', '']),
  // The heading that followed the op's section in the original (S7-2's anchor), copied into a new section at the top.
  'a same-text heading at the top': (original, op) => {
    const own = sectionOf(original, op.part)
    const next = own && own.to < original.length ? /^[^\r\n]*/.exec(original.slice(own.to))![0] : '## Aside'
    return text => insertLines(text, 0, [next, '', 'Hand heading.', ''])
  },
  'prose at the end of the file': () => text => insertLines(text, text.length, ['Final hand prose.']),
  // St8-1 (r8): hand edits that delete, move and duplicate existing text, the class that can reproduce a recorded place.
  // S8-1's first shape: the first section of another part deleted and a new one with the same heading appended.
  'another section deleted and its heading appended': (original, op) => {
    const span = sameSpan(original, op)
    return text => { const own = span(text); return own ? appendBlock(cut(text, own), [`## [[${own.title}]]`, '', 'Hand copy.']) : null }
  },
  'another section moved to the end': (original, op) => {
    const span = sameSpan(original, op)
    return text => { const own = span(text); return own ? appendBytes(cut(text, own), text.slice(own.from, own.to)) : null }
  },
  // The copy is the section's bytes in the original, pasted alike into both files.
  'another section copied to the top': (original, op) => {
    const title = otherTitle(original, op), own = title === undefined ? undefined : sectionOf(original, title)
    const copy = own ? atLineEnd(original.slice(own.from, own.to), eolOf(original)) : null
    return text => copy === null ? null : copy + text
  },
  'the last line with text of another section deleted': (original, op) => {
    const title = otherTitle(original, op)
    return text => {
      const own = title === undefined ? undefined : sectionOf(text, title)
      if (!own) return null
      const body = text.slice(own.headingEnd, own.to), line = /[^\r\n]*\S[^\r\n]*(?:\r\n|\n|\r)?(?=(?:\r\n|\n|\r|\s)*$)/.exec(body)
      return line ? text.slice(0, own.headingEnd + line.index) + text.slice(own.headingEnd + line.index + line[0].length) : null
    }
  },
  // S8-1's second shape: a copy of the saved file's last subsection (from its last `###` line) pasted at the end.
  'a copy of the last subsection pasted at the end': (_, __, saved) => {
    const heads = [...saved.matchAll(/^###[^\r\n]*/gm)].filter(head => opens(saved, head.index!))
    const copy = heads.length ? saved.slice(heads.at(-1)!.index) : null
    return text => copy === null ? null : appendBytes(text, copy)
  },
}
/** The first part in the original, other than the op's, whose section a hand edit works on. */
function otherTitle(original: string, op: EvidenceOp): string | undefined { return parseEvidence(original).sections.find(section => section.title !== op.part)?.title }
/** That section in a file, only when its bytes are the original's: a span holding bytes the save wrote (the separator
 *  ahead of an appended section) is not one edit that can be made in both files alike. */
const sameSpan = (original: string, op: EvidenceOp) => {
  const title = otherTitle(original, op), was = title === undefined ? undefined : sectionOf(original, title)
  return (text: string) => { const own = was && sectionOf(text, was.title); return own && text.slice(own.from, own.to) === original.slice(was.from, was.to) ? own : null }
}
const cut = (text: string, span: { from: number; to: number }): string => text.slice(0, span.from) + text.slice(span.to)
/** Moved or copied bytes are taken verbatim, so the edit is the same in the saved file and the original; a break is
 *  added only where they would otherwise join a line. */
const atLineEnd = (text: string, eol: string): string => !text || /[\r\n]$/.test(text) ? text : text + eol
const appendBytes = (text: string, bytes: string): string => atLineEnd(text, eolOf(text)) + bytes
/** `lines` appended at the end of the file after a blank line, each followed by the file's break. */
const appendBlock = (text: string, lines: string[]): string => {
  const eol = eolOf(text), ended = !text || /[\r\n]$/.test(text)
  return text + (ended ? '' : eol) + (text.trim() ? eol : '') + lines.map(line => line + eol).join('')
}
for (const [n, layout] of layouts.entries()) {
  test(`concurrent-edit sweep, layout ${n}: Undo after a hand edit restores the original with the edit where it sat, or refuses`, () => {
    const tally = { undone: 0, refused: 0 }
    const failures: string[] = []
    const sources = ['\n', '\r\n', '\r'].flatMap(eol => [...placements(5, ['', '```'])].map(slot => layout(slot).replace(/\n/g, eol)))
    for (const source of sources) {
      const singles = opsFor(source, ['\n', '']).map(op => [op])
      for (const batch of [...singles, ...batchesFor(source, ['\n'], 10, n)]) {
        let result
        try { result = applyEvidenceOps(source, batch) } catch { continue }
        if (result.source === source) continue
        for (const [name, edit] of Object.entries(handEdits)) {
          const made = edit(source, batch[0], result.source)
          const handled = made(result.source)
          if (handled === null || handled === result.source || leavesFenceOpen(handled)) continue
          const wanted = made(source)
          let undo
          try { undo = undoEvidenceOps(handled, result.inverse) } catch { tally.refused++; continue }
          if (undo.refused.length) { tally.refused++; continue }
          if (undo.source !== wanted) failures.push(`${name}: ${JSON.stringify(source)} ${JSON.stringify(batch)} gave ${JSON.stringify(undo.source)}`)
          else tally.undone++
        }
      }
    }
    expect(failures.slice(0, 5)).toEqual([])
    expect(tally.undone).toBeGreaterThan(500)
    expect(tally.refused).toBeGreaterThan(500)
  }, 120_000)
}

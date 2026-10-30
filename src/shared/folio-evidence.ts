/** Plain Markdown evidence. Reads retain byte spans; operations own only the exact values they replace. */
export const EVIDENCE_LEAD = 'WriteFlex keeps the evidence and notes for each part of this Folio here. Each ## heading names one part.'
export type EvidenceKind = 'file' | 'note' | 'zotero' | 'archive'
export type EvidenceHighlight = { key: string; raw: string; from: number; to: number; quote: string | null; target: string | null }
export type EvidenceItem = { key: string; kind: EvidenceKind; target: string; label: string; fingerprint: string | null; from: number; to: number; line: string; raw: string; highlights: EvidenceHighlight[] }
export type EvidenceSection = { title: string; from: number; to: number; headingEnd: number; items: EvidenceItem[]; evidence: { from: number; bodyFrom: number; to: number } | null; notes: { from: number; bodyFrom: number; to: number; raw: string } | null }
export type EvidenceDocument = { source: string; eol: string; sections: EvidenceSection[] }
export type EvidenceOp =
  | { kind: 'item'; part: string; key: string; expect: string | null; value: string | null }
  | { kind: 'line'; part: string; key: string; expect: string; value: string }
  | { kind: 'notes'; part: string; expect: string | null; value: string | null }
/** Undo only, never sent by the room: put a part's section back exactly as it was. The part must have exactly
 *  `sections` sections, as it had after the save. With `expect`, the first one must be exactly those bytes (heading to
 *  the next `##` heading or the end) with `before` just ahead of it; both are replaced by `value`. With `expect` null the
 *  save removed the section, and `value` goes back at offset `at` only when the whole file is still exactly `whole`, the
 *  bytes the save left: a removed section's place is never re-found by look-alike text, so any change since refuses. */
export type EvidenceRestore = { kind: 'section'; part: string; sections: number; before: string; expect: string | null; value: string; recreate: { whole: string; at: number } | null }
export type EvidenceUndoOp = EvidenceOp | EvidenceRestore
export type EvidenceApply<Op = EvidenceOp> = { source: string; applied: Op[]; refused: Op[]; inverse: EvidenceUndoOp[] }
export type EvidenceOrigin = 'attached here' | 'listed in the part’s sources' | 'cited in the text'
export type RoomEvidenceRow = { key: string; kind: EvidenceKind; target: string; title: string; path: string | null; origins: EvidenceOrigin[]; item: EvidenceItem | null; removable: boolean; state: 'ready' | 'missing' | 'changed since attached' | 'Zotero not available' | 'not found in Zotero'; highlights: Array<EvidenceHighlight & { state?: string; citation?: string; quote: string | null }>; citation?: string; citationLabel?: string; sourceTitle?: string }
export type RoomPartEvidence = { rows: RoomEvidenceRow[]; notes: string; notesBasis: string | null; additionalNotes: string[]; duplicate: boolean }
export type RoomEvidence = { path: string; state: 'missing' | 'ready' | 'unreadable'; message?: string; eol: string; parts: Record<string, RoomPartEvidence>; orphans: Array<{ title: string; notes: string }>; candidates: Array<{ path: string; title: string; kind: 'file' | 'note' }> }

export const evidencePartKey = (title: string): string => title.normalize('NFC').trim().toLocaleLowerCase('en-GB')
export const normaliseQuote = (text: string): string => text.replace(/\s+/g, ' ').trim()
export function evidenceKey(target: string, kind?: EvidenceKind): string {
  if (kind === 'note') return `note:${evidencePartKey(target.split('|')[0])}`
  if (/^zotero:\/\/select\//.test(target)) return 'zotero:' + target.replace(/^zotero:\/\/select\//, '').replace(/\/items\//, '/')
  if (/^[a-z][a-z\d+.-]*:/i.test(target)) return target
  let decoded = target
  try { decoded = decodeURIComponent(target) } catch { /* preserve an unencoded hand-written target */ }
  const parts: string[] = []
  for (const part of decoded.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop()
    else parts.push(part)
  }
  return 'file:' + parts.join('/').normalize('NFC')
}

type Line = { text: string; raw: string; from: number; to: number; heading: boolean; prose: boolean }
const linesOf = (source: string): Line[] => scan(source).lines
type Fence = { char: string; size: number } | null
function scan(source: string): { lines: Line[]; open: boolean; fence: Fence } {
  const lines: Line[] = []
  let fenced: Fence = null
  for (const match of source.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    if (!match[0]) continue
    const bom = match.index === 0 && match[0].startsWith('\ufeff') ? 1 : 0
    const text = match[0].slice(bom).replace(/[\r\n]+$/, '')
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(text)
    const prose = !fenced && !fence
    const heading = prose && /^#{2,3} /.test(text)
    if (fence) {
      if (!fenced) fenced = { char: fence[1][0], size: fence[1].length }
      else if (fence[1][0] === fenced.char && fence[1].length >= fenced.size && text.slice(fence[0].length).trim() === '') fenced = null
    }
    lines.push({ text, raw: match[0], from: match.index! + bom, to: match.index! + match[0].length, heading, prose })
  }
  return { lines, open: fenced !== null, fence: fenced }
}

export const EVIDENCE_OPEN_FENCE = 'The evidence file has a code block that is never closed, so nothing was changed. Close it in the file and try again.'
/** True when a code fence opened in `text` is still open at its end: everything after it would stop being sections. */
export const leavesFenceOpen = (text: string): boolean => scan(text).open
/** True when any line of `text` would read as a `##` or `###` heading of the evidence file. */
export const holdsSectionHeading = (text: string): boolean => linesOf(text).some(line => line.heading)

/** Only an item's first inline is read. The rest of its line and subtree remain owned byte-for-byte. */
export function parseEvidenceLink(line: string): Pick<EvidenceItem, 'key' | 'kind' | 'target' | 'label' | 'fingerprint'> | null {
  const body = line.replace(/^\s*[-*+]\s+/, '')
  const wiki = /^\[\[([^\]\r\n]+)\]\]/.exec(body)
  if (wiki) return { key: evidenceKey(wiki[1], 'note'), kind: 'note', target: wiki[1].split('|')[0], label: wiki[1].split('|')[1] ?? wiki[1], fingerprint: null }
  const link = /^\[((?:\\.|[^\]\\])*)\]\((<[^>\r\n]+>|[^)\r\n]+)\)/.exec(body)
  if (!link) return null
  const target = link[2].replace(/^<|>$/g, '')
  const kind: EvidenceKind = target.startsWith('zotero://') ? 'zotero' : /^(?:https?:|file:|writeflex:)/i.test(target) ? 'archive' : 'file'
  if (/^[a-z][a-z\d+.-]*:/i.test(target) && kind === 'file') return null
  return { key: evidenceKey(target, kind), kind, target, label: link[1].replace(/\\([\\[\]])/g, '$1'), fingerprint: /<!--wf:sha1-16=([a-f\d]{16})-->/.exec(line)?.[1] ?? null }
}

export function parseEvidence(source: string): EvidenceDocument {
  const lines = linesOf(source)
  const sections: EvidenceSection[] = []
  const boundaries = lines.filter(line => line.heading && /^## /.test(line.text))
  for (let at = 0; at < boundaries.length; at += 1) {
    const heading = boundaries[at]
    const title = /^## \[\[([^\]\r\n]+)\]\]\s*$/.exec(heading.text)?.[1]
    if (!title) continue
    const to = boundaries[at + 1]?.from ?? source.length
    const headings = lines.filter(line => line.from >= heading.to && line.from < to && line.heading && /^### /.test(line.text))
    const section: EvidenceSection = { title, from: heading.from, to, headingEnd: heading.to, items: [], evidence: null, notes: null }
    headings.forEach((line, n) => {
      const end = headings[n + 1]?.from ?? to
      if (/^### Notes\s*$/.test(line.text) && !section.notes) section.notes = { from: line.from, bodyFrom: line.to, to: end, raw: source.slice(line.to, end) }
      if (!/^### Evidence\s*$/.test(line.text)) return
      section.evidence ??= { from: line.from, bodyFrom: line.to, to: end }
      const body = lines.filter(candidate => candidate.from >= line.to && candidate.from < end)
      body.forEach((candidate, i) => {
        if (!candidate.prose || !/^[-*+]\s+/.test(candidate.text)) return
        const link = parseEvidenceLink(candidate.text)
        if (!link) return
        let last = candidate.to
        const highlights: EvidenceHighlight[] = []
        for (const nested of body.slice(i + 1)) {
          if (!nested.text.trim()) continue
          if (!/^\s/.test(nested.text)) break
          last = nested.to
          const quote = nested.prose ? /^\s+[-*+]\s+[“"](.*)[”"]\s*$/.exec(nested.text)?.[1] : undefined
          const linked = nested.prose && /^\s+[-*+]\s+/.test(nested.text) ? parseEvidenceLink(nested.text) : null
          if (quote !== undefined || linked) highlights.push({ key: linked?.key ?? 'quote:' + normaliseQuote(quote!), raw: nested.raw, from: nested.from, to: nested.to, quote: quote ?? null, target: linked?.target ?? null })
        }
        section.items.push({ ...link, from: candidate.from, to: last, line: candidate.raw, raw: source.slice(candidate.from, last), highlights })
      })
    })
    sections.push(section)
  }
  return { source, eol: /\r\n|\n|\r/.exec(source)?.[0] ?? '\n', sections }
}

/** A line starts at `at`: the file's start (after its byte order mark, which the scanner drops), or just after a line
 *  break that is not the `\r` of a `\r\n`. */
const startsLine = (source: string, at: number): boolean => at === 0 || (at === 1 && source[0] === '\ufeff') || source[at - 1] === '\n' || (source[at - 1] === '\r' && source[at] !== '\n')
/** Everything the scanner carries from the text before `at` into the line at `at`: the fence state, and whether a byte
 *  order mark there would be read as one (only at the very start). */
const contextAt = (source: string, at: number): string => JSON.stringify([scan(source.slice(0, at)).fence, at === 0 && source.startsWith('\ufeff')])
/** The splice-boundary invariant. Text after the replaced span is kept as untouched bytes, and the scanner reads those
 *  bytes the same way exactly when it enters them in the same state. So the span starts and ends on line boundaries, the
 *  replacement leaves the kept text starting a line (and does not glue itself onto an unterminated last line), and the
 *  fence state where the kept text begins is the one it had. Otherwise refused: the splice would change how the rest of
 *  the file reads, which no model of the file has to cover for this to hold. The refusal names its cause: a line break
 *  the splice would lose (lines would join), or a code fence state it would change. */
function spliceKeepingRest(source: string, from: number, to: number, text: string): { next: string } | { cause: 'break' | 'fence' } {
  const next = source.slice(0, from) + text + source.slice(to)
  const end = from + text.length
  const rest = to < source.length
  if (!(startsLine(source, from) || from === source.length) || !(startsLine(source, to) || !rest)) return { cause: 'break' }
  if (text && !startsLine(next, from) && !/^[\r\n]/.test(text)) return { cause: 'break' }
  if (rest && !startsLine(next, end)) return { cause: 'break' }
  if (rest && contextAt(source, to) !== contextAt(next, end)) return { cause: 'fence' }
  return { next }
}
function appendSection(source: string, part: string, eol: string): string {
  if (/[\r\n\[\]]/.test(part) || !part.trim()) throw new Error('That part title cannot be used for evidence.')
  const head = source || EVIDENCE_LEAD + eol
  return head + (head.endsWith(eol + eol) ? '' : head.endsWith(eol) ? eol : eol + eol) + `## [[${part}]]${eol}${eol}`
}
/** Notes always end on a line break, so the next `## [[…]]` heading stays on a line of its own whatever the caller sent. */
function notesValue(value: string | null, eol: string): string | null {
  if (!value) return value
  return /(?:\r\n|\n|\r)$/.test(value) ? value : value + eol + eol
}

/** What the evidence file means, as the room reads it: every `##`/`###` heading in order, and per `## [[…]]` section
 *  its items (identity and text) and notes. Trailing line breaks are separators, not content, so they are not compared. */
export type EvidenceModel = { outline: string[]; sections: Array<{ title: string; items: Array<{ key: string; raw: string }>; notes: string | null }> }
type Placed<T> = T & { from: number }
type WorkingModel = { outline: Array<Placed<{ text: string }>>; sections: Array<{ title: string; items: Array<Placed<{ key: string; raw: string }>>; notes: string | null }> }
const meaning = (text: string): string => text.replace(/\s+$/, '')
/** Every line break of a value the room sends becomes the file's own, so what is saved is what the file reads back. */
const withEol = (text: string | null, eol: string): string | null => text === null ? null : text.replace(/\r\n|\r|\n/g, eol)
const terminated = (text: string): boolean => /[\r\n]$/.test(text)
function workingModel(read: EvidenceDocument): WorkingModel {
  return {
    outline: linesOf(read.source).filter(line => line.heading).map(line => ({ text: meaning(line.text), from: line.from })),
    sections: read.sections.map(section => ({ title: section.title, items: section.items.map(item => ({ key: item.key, raw: item.raw, from: item.from })), notes: section.notes?.raw ?? null })),
  }
}
const settled = (model: WorkingModel): EvidenceModel => ({
  outline: model.outline.map(heading => heading.text),
  sections: model.sections.map(section => ({ title: section.title, items: section.items.map(item => ({ key: item.key, raw: meaning(item.raw) })), notes: section.notes === null ? null : meaning(section.notes) })),
})
export const evidenceModel = (source: string): EvidenceModel => settled(workingModel(parseEvidence(source)))
const sameModel = (a: EvidenceModel, b: EvidenceModel): boolean => JSON.stringify(a) === JSON.stringify(b)
/** Insert into an offset-ordered list at the place `at` takes in the file. */
const insertAt = <T extends { from: number }>(list: T[], value: T): void => { const index = list.findIndex(entry => entry.from >= value.from); list.splice(index < 0 ? list.length : index, 0, value) }
const dropAt = <T extends { from: number }>(list: T[], from: number): void => { const index = list.findIndex(entry => entry.from === from); if (index >= 0) list.splice(index, 1) }

type Splice = (source: string, from: number, to: number, text: string) => string
/** After one splice, an emptied `### Evidence` subsection goes, then a section with nothing left under its heading.
 *  Decided from the op's own section at its known offsets, never by re-finding a section by title in the new text. */
function cleanEmpty(source: string, section: EvidenceSection, cut: { from: number; to: number; length: number }, splice: Splice): { source: string; evidence: boolean; section: boolean } {
  const delta = cut.length - (cut.to - cut.from)
  const moved = (at: number): number => at < cut.from || (at === cut.from && cut.to > cut.from) ? at : at >= cut.to ? at + delta : cut.from
  let end = moved(section.to), evidence = false
  if (section.evidence) {
    const from = moved(section.evidence.from), to = moved(section.evidence.to)
    if (!source.slice(moved(section.evidence.bodyFrom), to).trim()) { source = splice(source, from, to, ''); end -= to - from; evidence = true }
  }
  if (source.slice(section.headingEnd, end).trim()) return { source, evidence, section: false }
  return { source: splice(source, section.from, end, ''), evidence, section: true }
}

/** Undo of a whole-section inverse (`EvidenceRestore`); null when the file no longer has the section it expects. */
function restoreSection(source: string, op: EvidenceRestore): string | null {
  const all = parseEvidence(source).sections.filter(section => evidencePartKey(section.title) === evidencePartKey(op.part))
  // A same-title section added or removed since makes "the part's section" a different one: refused, never guessed.
  if (all.length !== op.sections) return null
  const found = all[0]
  let from: number, to: number
  if (op.expect === null) {
    // Recreating a removed section: only into the file exactly as the save left it, so the place is the save's own.
    if (found || !op.recreate || source !== op.recreate.whole) return null
    from = to = op.recreate.at
  } else {
    // Exactly the section as saved: any text added to it since, even at its end, is refused rather than carried along.
    if (!found || found.from < op.before.length || source.slice(found.from - op.before.length, found.from) !== op.before || source.slice(found.from, found.to) !== op.expect) return null
    from = found.from - op.before.length; to = found.to
  }
  const kept = spliceKeepingRest(source, from, to, op.value)
  const name = `the evidence for “${op.part}”`
  if ('cause' in kept) throw new Error(kept.cause === 'break'
    ? `Changing ${name} would join it onto the next line of the evidence file, so nothing was changed.`
    : `Changing ${name} would change how the rest of the evidence file reads, so nothing was changed. Check the code blocks in the file and try again.`)
  if (leavesFenceOpen(kept.next)) throw new Error(`Changing ${name} would leave a code block in the evidence file unclosed, so nothing was changed. Fix the code block in the file and try again.`)
  keptOutside(source, kept.next, from, to, op.value)
  return kept.next
}
/** An Undo writes only the span it restores: every byte before and after it is the file's as it stood before the Undo. */
function keptOutside(before: string, after: string, from: number, to: number, text: string): void {
  if (after.length !== before.length - (to - from) + text.length || after.slice(0, from) !== before.slice(0, from) || after.slice(from + text.length) !== before.slice(to))
    throw new Error('This Undo would change text outside what it restores, so nothing was changed.')
}

export const EVIDENCE_TWO_NOTES = 'This part has two Notes headings in the evidence file, so nothing was changed. Remove one in the file and try again.'
export const EVIDENCE_TWO_SECTIONS = 'This part has two sections in the evidence file, so nothing was changed. Remove one in the file and try again.'
/** Independent operations rebase; each compound item's subtree is checked whole before replacement. Three invariants
 *  hold for every op, or the whole batch is refused and nothing is written:
 *  - lexical: every splice keeps the text after its span reading exactly as before (`spliceKeepingRest`), so no change
 *    — a fence a hand edit left in an item's span, a line without its break — can reach text the op does not own,
 *    whether or not the model below covers that text (prose, highlights, a second `### Notes`);
 *  - model: the op's own region parses to exactly the change the op intends, computed from the parsed model before the
 *    op, never from the spliced text;
 *  - undo: the batch's inverse, applied to the saved text, gives back the original bytes exactly. Each op takes the
 *    narrowest inverse that does — its own item or notes when that replaces exactly the bytes it wrote, else its whole
 *    section — and the batch is checked whole. The writer applies an Undo whole or not at all; each op writes only
 *    the span it restores. */
export function applyEvidenceOps(original: string, ops: readonly EvidenceOp[]): EvidenceApply {
  const result = run(original, ops, 'save') as EvidenceApply
  if (result.source !== original && undoes(result.source, result.inverse) !== original) throw new Error('This change could not be undone cleanly, so nothing was changed.')
  return result
}
/** Applies an Undo's inverse as recorded: values exactly as they were, no faithfulness check of its own (no redo). */
export function undoEvidenceOps(current: string, ops: readonly EvidenceUndoOp[]): EvidenceApply<EvidenceUndoOp> { return run(current, ops, 'undo') }
/** What `inverse` makes of `text`, or null when any of it is refused or throws. */
function undoes(text: string, inverse: readonly EvidenceUndoOp[]): string | null {
  try { const back = run(text, inverse, 'undo'); return back.refused.length ? null : back.source } catch { return null }
}
/** The whole-section inverse of one op: the part's section bytes (with the separator an appended section brought) as
 *  they were before it. */
function sectionRestore(before: string, after: string, part: string): EvidenceRestore {
  const find = (text: string) => parseEvidence(text).sections.filter(section => evidencePartKey(section.title) === evidencePartKey(part))
  const was = find(before)[0], all = find(after), now = all[0], sections = all.length
  if (was && now) return { kind: 'section', part, sections, before: '', expect: after.slice(now.from, now.to), value: before.slice(was.from, was.to), recreate: null }
  // Removed: its place is where it stood, valid only in the whole file exactly as the save left it.
  if (was) return { kind: 'section', part, sections, before: '', expect: null, value: before.slice(was.from, was.to), recreate: { whole: after, at: was.from } }
  // Appended: the new section and the break or lead written ahead of it go, back to the start of the old last line with
  // text on it, so a blank line written there since is not taken for the save's own separator.
  const last = linesOf(before).filter(line => line.text.trim()).at(-1)
  const from = last ? last.from : 0
  return { kind: 'section', part, sections, before: after.slice(from, now!.from), expect: after.slice(now!.from, now!.to), value: before.slice(from), recreate: null }
}
function run(original: string, ops: readonly EvidenceUndoOp[], mode: 'save' | 'undo'): EvidenceApply<EvidenceUndoOp> {
  // An unclosed fence hides every later heading, so no section after it can be found or appended safely.
  if (leavesFenceOpen(original)) throw new Error(EVIDENCE_OPEN_FENCE)
  let source = original
  const applied: EvidenceUndoOp[] = [], refused: EvidenceUndoOp[] = [], inverse: EvidenceUndoOp[] = []
  for (const given of ops) {
    const start = source
    if (given.kind === 'section') {
      if (mode !== 'undo') throw new Error('Invalid evidence edit.')
      const restored = restoreSection(source, given)
      if (restored === null) refused.push(given)
      else { source = restored; applied.push(given) }
      continue
    }
    const read = parseEvidence(source)
    // A save writes every value with the file's own line breaks; an Undo writes back exactly the bytes it took away.
    const value = mode === 'save' ? withEol(given.value, read.eol) : given.value
    const op = (given.kind === 'notes' ? { ...given, value: mode === 'save' ? notesValue(value, read.eol) : value } : { ...given, value }) as EvidenceOp
    const matches = read.sections.filter(section => evidencePartKey(section.title) === evidencePartKey(op.part))
    let section = matches[0]
    const item = op.kind === 'notes' ? undefined : section?.items.find(item => item.key === op.key)
    const exists = op.kind !== 'notes' && matches.some(section => section.items.some(item => item.key === op.key))
    const actual = op.kind === 'notes' ? section?.notes?.raw ?? null : op.kind === 'line' ? item?.line ?? null : item?.raw ?? null
    // An Undo of one item or notes acts only on the part's one section as it stood: a same-title section added since, or
    // the section gone (it would be appended somewhere new), is refused, so nothing lands in a section it did not leave.
    if ((mode === 'undo' && matches.length !== 1) || (op.kind !== 'notes' && op.expect !== null && matches.flatMap(section => section.items).filter(candidate => candidate.key === op.key).length > 1) || actual !== op.expect || (op.kind === 'item' && op.expect === null && exists)) { refused.push(op); continue }
    let parsedValue: EvidenceItem | undefined
    if (op.kind !== 'notes' && op.value !== null) {
      const value = parsedValue = parseEvidence(`## [[Part]]\n### Evidence\n${op.value}`).sections[0]?.items[0]
      if (!value || value.from !== '## [[Part]]\n### Evidence\n'.length || (op.kind === 'item' && value.raw !== op.value) || (op.kind === 'line' && value.line !== op.value)) throw new Error('The evidence item cannot be saved safely.')
      if (op.kind === 'line' && value.key !== op.key && matches.some(section => section.items.some(candidate => candidate.key === value.key))) { refused.push(op); continue }
      if (op.kind === 'item' && value.key !== op.key) throw new Error('The evidence item identity changed.')
    }
    // Clearing what is not there changes nothing.
    if (op.value === null && (!section || (op.kind === 'notes' ? !section.notes : !item))) { applied.push(given); continue }
    const name = item ? `“${item.label}” in “${op.part}”` : `the evidence for “${op.part}”`
    const splice: Splice = (text, from, to, value) => {
      const kept = spliceKeepingRest(text, from, to, value)
      if ('cause' in kept) throw new Error(kept.cause === 'break'
        ? `Changing ${name} would join it onto the next line of the evidence file, so nothing was changed.`
        : `Changing ${name} would change how the rest of the evidence file reads, so nothing was changed. Check the code blocks in the file and try again.`)
      return kept.next
    }
    // The intended model: the file as parsed before this op, with exactly this op's change applied.
    const intended = workingModel(read)
    let target = section ? read.sections.indexOf(section) : -1
    if (!section) {
      const appended = appendSection(source, op.part, read.eol)
      source = splice(source, source.length, source.length, appended.slice(source.length))
      // Found by its title, never by position: a heading that does not parse must not hand the write to another part.
      const added = parseEvidence(source).sections.find(found => found.from >= read.source.length - 1 && evidencePartKey(found.title) === evidencePartKey(op.part))
      if (!added) throw new Error('The new evidence section could not be found after adding it, so nothing was changed.')
      section = added
      intended.outline.push({ text: `## [[${op.part}]]`, from: added.from })
      intended.sections.push({ title: op.part, items: [], notes: null })
      target = intended.sections.length - 1
    }
    const own = intended.sections[target]
    let cut: { from: number; to: number; text: string }
    // The op's own inverse, in the order an Undo applies it.
    const back: EvidenceOp[] = []
    if (op.kind === 'notes') {
      const notes = section.notes
      if (notes) {
        // Clearing the first of two `### Notes` would make the second one the part's notes.
        if (op.value === null && linesOf(source).filter(line => line.heading && line.from >= section!.from && line.from < section!.to && /^### Notes\s*$/.test(line.text)).length > 1) throw new Error(EVIDENCE_TWO_NOTES)
        cut = op.value === null ? { from: notes.from, to: notes.to, text: '' } : { from: notes.bodyFrom, to: notes.to, text: op.value }
        if (op.value === null) dropAt(intended.outline, notes.from)
      } else {
        cut = { from: section.to, to: section.to, text: `${source.slice(section.from, section.to).endsWith(read.eol + read.eol) ? '' : read.eol}### Notes${read.eol}${op.value}` }
        insertAt(intended.outline, { text: '### Notes', from: section.to })
      }
      own.notes = op.value
      back.push({ ...op, expect: op.value, value: actual })
    } else if (item) {
      const index = own.items.findIndex(found => found.from === item.from)
      cut = { from: item.from, to: op.kind === 'line' ? item.from + item.line.length : item.to, text: op.value ?? '' }
      if (op.value === null) own.items.splice(index, 1)
      else own.items[index] = { key: parsedValue!.key, raw: op.kind === 'line' ? op.value + item.raw.slice(item.line.length) : op.value, from: item.from }
      back.push(op.kind === 'line'
        ? { ...op, key: parseEvidenceLink(op.value)!.key, expect: op.value, value: actual! }
        : { ...op, expect: op.value, value: actual })
    } else {
      // A new item goes straight after the last item of the part's evidence list (outside any code block), so deleting
      // it again gives back exactly the bytes there were; with no list yet, at the end of `### Evidence` or a new one.
      const evidence = section.evidence
      const last = evidence ? section.items.filter(candidate => candidate.from >= evidence.bodyFrom && candidate.from < evidence.to).at(-1) : undefined
      const at = last && !scan(source.slice(0, last.to)).fence ? last.to : evidence?.to ?? section.notes?.from ?? section.to
      const prefix = evidence ? '' : `${source.slice(section.from, at).endsWith(read.eol + read.eol) ? '' : read.eol}### Evidence${read.eol}`
      const boundary = at > 0 && !/[\r\n]/.test(source[at - 1]) ? read.eol : ''
      const previousItem = section.items.find(candidate => candidate.to === at)
      // The item's bytes as saved: its value (line breaks already the file's), with the file's break when text follows.
      const written = op.value! + (at < source.length && !terminated(op.value!) ? read.eol : '')
      cut = { from: at, to: at, text: boundary + prefix + written + (prefix && at < source.length ? read.eol : '') }
      if (!evidence) insertAt(intended.outline, { text: '### Evidence', from: at })
      insertAt(own.items, { key: op.key, raw: written, from: at })
      back.push({ kind: 'item', part: op.part, key: op.key, expect: written, value: null })
      if (boundary && previousItem) back.push({ kind: 'item', part: op.part, key: previousItem.key, expect: previousItem.raw + boundary, value: previousItem.raw })
    }
    source = splice(source, cut.from, cut.to, cut.text)
    const cleaned = cleanEmpty(source, section, { from: cut.from, to: cut.to, length: cut.text.length }, splice)
    // An Undo restores its own span only. Were it also to drop an emptied heading, that heading was not the save's to
    // give back when text changed since: refused (a save whose inverse needs that takes a whole-section restore instead).
    if (mode === 'undo' && (cleaned.evidence || cleaned.section)) { source = start; refused.push(given); continue }
    source = cleaned.source
    if (mode === 'undo') keptOutside(start, source, cut.from, cut.to, cut.text)
    if (cleaned.evidence && section.evidence) dropAt(intended.outline, section.evidence.from)
    // Ops find a section by title, first match; with that one gone, its Undo would land in the other same-title section.
    if (cleaned.section && matches.length > 1) throw new Error(EVIDENCE_TWO_SECTIONS)
    if (cleaned.section) { dropAt(intended.outline, section.from); intended.sections.splice(target, 1) }
    if (leavesFenceOpen(source)) throw new Error(`Changing ${name} would leave a code block in the evidence file unclosed, so nothing was changed. Fix the code block in the file and try again.`)
    if (!sameModel(evidenceModel(source), settled(intended))) throw new Error(`Changing ${name} would change other parts of the evidence file, so nothing was changed. Check the code blocks in the file and try again.`)
    if (mode === 'save') {
      // Undo-faithfulness: the op's own item or notes inverse when it restores the bytes exactly, else its whole section.
      // An inverse that puts back removed text (an item or notes) has only a position to go by, and text written there
      // since would end up on the wrong side of it; so it takes the whole section, which any change since refuses.
      const restore = back.every(undoOp => undoOp.expect !== null) && undoes(source, back) === start ? back : [sectionRestore(start, source, op.part)]
      if (restore !== back && undoes(source, restore) !== start) throw new Error(`Changing ${name} could not be undone cleanly, so nothing was changed.`)
      inverse.unshift(...restore)
    }
    applied.push(given)
  }
  return { source, applied, refused, inverse }
}


export function evidenceOps(raw: unknown): EvidenceOp[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 100) throw new Error('Invalid evidence edit.')
  return raw.map(value => {
    if (!value || typeof value !== 'object' || !['item', 'line', 'notes'].includes(value.kind) || typeof value.part !== 'string' || value.part.length > 500
      || ![null, 'string'].includes(value.expect === null ? null : typeof value.expect)
      || ![null, 'string'].includes(value.value === null ? null : typeof value.value)
      || (typeof value.expect === 'string' && value.expect.length > 256000) || (typeof value.value === 'string' && value.value.length > 256000)) throw new Error('Invalid evidence edit.')
    if (value.kind === 'notes') return { kind: 'notes', part: value.part, expect: value.expect, value: value.value }
    if (typeof value.key !== 'string' || value.key.length > 4000 || (value.kind === 'line' && (typeof value.expect !== 'string' || typeof value.value !== 'string'))) throw new Error('Invalid evidence edit.')
    return { kind: value.kind, part: value.part, key: value.key, expect: value.expect, value: value.value }
  })
}


/** Repoint the first source link; all provenance, labels and comments outside its URL stay byte-identical. */
export function repointEvidenceLine(line: string, target: string): string {
  const link = /^(\s*[-*+]\s+\[(?:\\.|[^\]\\])*\]\()(<[^>\r\n]+>|[^)\r\n]+)(\))/.exec(line)
  if (!link || /[\r\n<>]/.test(target)) throw new Error('That source link cannot be changed safely.')
  const url = /[()\s]/.test(target) ? `<${target}>` : target
  return line.slice(0, link[1].length) + url + line.slice(link[1].length + link[2].length)
}

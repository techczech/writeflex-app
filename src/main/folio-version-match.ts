/**
 * Match a co-author's Word sections to the parts of a Folio version (Folio versions, ticket 13;
 * ADR-0052 changes 6 and 7; journeys J3 and J6).
 *
 * judgement-vs-code: whether a differently worded heading is "the same section" depends on meaning, so
 * code never settles it. CODE decides exactly one thing: two headings are the same when they are equal
 * after Unicode (NFKC) normalisation and trimming. Everything looser is a PROPOSAL carrying a
 * confidence word and its reason. This function never confirms a proposal on its own; the writer does,
 * and the only way a proposal becomes `confirmed` is a confirmation passed in (`--match "<heading>=<part>"`),
 * which changes that item's status and nothing else.
 *
 * Whatever judges the looser matches is named in `mechanism`: the mechanical stand-in
 * (`folio-version-match-stub.ts`, marked `judgement-stub`) when no judgements are passed, or the
 * judgements the caller supplied (a model or the writer) in `MatchOptions.judged`.
 *
 * What counts as what, for one Word file against one base version:
 *  - exact:     the heading equals exactly one part's title (and appears once in her file).
 *  - proposed:  a close match, one section to one part, to confirm.
 *  - confirmed: a proposal the writer confirmed.
 *  - ambiguous: the writer must resolve it. A heading that appears twice in her file; a heading that
 *               equals two parts' titles; two of her sections that could match one part; one section
 *               that could match several parts; any section of a file with no heading styles.
 *  - new:       a section with no part it could be.
 *  - missing:   a part in the running order that nothing in her file matches or could match.
 *  - moved:     a matched section whose place relative to the other matched sections differs from its
 *               part's (structural: the longest run of sections still in the base order stays put).
 * Parts that an ambiguous item could be are `held`: neither missing nor available to another section.
 *
 * Tables are reported, never applied (ADR-0052 change 7): "<file>: 2 cells differ".
 *
 * Pure: no file system, no model, no clock. It reads a reader result (`word-reader`) and base parts
 * handed in; it writes nothing. Section headings, titles and reasons in the result are plain text, not
 * Markdown: whoever puts them in a document must escape them.
 */
import { movedFlags } from '../shared/folio-version-decide'
import { clueFor, headingKey, type Clue, type ConfidenceWord } from './folio-version-match-stub'
import type { WordBlock, WordReading, WordSection, WordTable } from './word-reader'

export type { ConfidenceWord } from './folio-version-match-stub'

/** A table the part inserts from a file (`data/…`), as it stood in the base version. */
export type BaseTable = { file: string; rows: string[][] }

/** One part of the base Folio version. `role: 'part'` is in the running order and is reported missing when
 *  her file has nothing for it; `unlisted` (Not in the outline) can be matched but is never reported missing.
 *  Pass parts in running order. `markdown` is the body without its heading line. `tables` are in the order
 *  the part inserts them. */
export type BasePart = { path: string; title: string; role: 'part' | 'unlisted'; markdown?: string; tables?: BaseTable[] }

/** A judgement from outside the function (a model, or the writer): this section may be this part. */
export type JudgedMatch = { sectionIndex: number; part: string; confidence: ConfidenceWord; reason: string }

/** A confirmation as `--match "<her heading>=<part>"` gives it: `heading` as she wrote it, `part` as its path or its title. */
export type MatchConfirmation = { heading: string; part: string }

/**
 * The writer's own decision about one of her sections (Folio versions ticket 14): which part it is (`part`, a part's path), or that it
 * is none of them (`part: null`: a new section). This is the writer's way to settle what code and the judge could not: it resolves an
 * ambiguous section, and it overrides a close match, whether to a different part or to none. It is never produced by this file or by any
 * judge: it comes only from the writer (the import view). An ambiguous item stays ambiguous until every one of its sections has one.
 */
export type MatchResolution = { section: number; part: string | null }

export type MatchOptions = {
  /** When present (even empty) these judge the close matches and the stand-in is not used. */
  judged?: JudgedMatch[]
  confirmations?: MatchConfirmation[]
  /** The writer's decisions (see `MatchResolution`). */
  resolutions?: MatchResolution[]
}

export type SectionRef = { index: number; heading: string | null }
export type PartRef = { path: string; title: string }

export type MatchedItem = {
  /** `exact` by code; `proposed` is a guess for the writer; `confirmed` is a proposal the writer confirmed. */
  status: 'exact' | 'proposed' | 'confirmed'
  section: SectionRef
  part: PartRef
  /** Present on a proposal and kept when it is confirmed. */
  confidence?: ConfidenceWord
  reason?: string
  /** Where the proposal came from; `writer` when the writer chose the part (a resolution) rather than confirmed a proposal. */
  source?: 'judgement-stub' | 'judged' | 'writer'
  /** Her section sits in a different place among the matched sections than its part does in the base. */
  moved: boolean
}

export type AmbiguityReason =
  | 'no-heading-styles'
  | 'heading-appears-twice'
  | 'heading-equals-several-parts'
  | 'two-sections-one-part'
  | 'several-parts-could-match'

export type AmbiguousItem = {
  status: 'ambiguous'
  reason: AmbiguityReason
  /** A plain sentence for the writer. */
  message: string
  sections: SectionRef[]
  candidates: PartRef[]
}

export type NewItem = {
  status: 'new'
  section: SectionRef
  /** Present when the section resembles a part that her other section already matches exactly (a split). */
  note?: string
}

export type SectionItem = MatchedItem | AmbiguousItem | NewItem

export type TableNote = {
  /** The base file the table comes from. */
  file: string
  section: SectionRef
  part: PartRef
  /** How sure the match under this note is. */
  match: MatchedItem['status']
  cellsDiffering: number
  /** A plain sentence. It reports; it never says to apply anything. */
  message: string
}

export type UnpairedTable = { side: 'hers' | 'base'; section?: SectionRef; part?: PartRef; file?: string; message: string }

export type IgnoredJudgement = { judged: JudgedMatch; why: string }
export type UnusedConfirmation = { confirmation: MatchConfirmation; why: string }
export type UnusedResolution = { resolution: MatchResolution; why: string }

export type MatchCounts = {
  exact: number
  confirmed: number
  close: number
  ambiguous: number
  new: number
  missing: number
  held: number
  moved: number
  tableNotes: number
}

export type SectionMatchResult = {
  /** Who judged the looser matches. */
  mechanism: 'judgement-stub' | 'judged'
  noHeadingStyles: boolean
  /** Every item, her sections in her order (an ambiguous item stands at its first section). */
  items: SectionItem[]
  /** Derived from `items`: exact and confirmed matches. */
  matched: MatchedItem[]
  /** Derived: close matches still waiting for the writer. */
  close: MatchedItem[]
  ambiguous: AmbiguousItem[]
  new: NewItem[]
  /** Parts in the running order that nothing in her file is or could be. */
  missing: PartRef[]
  /** Parts an ambiguous item could be: neither missing nor free for another section. */
  held: PartRef[]
  /** Derived: matched or proposed items with `moved`. */
  moved: MatchedItem[]
  tableNotes: TableNote[]
  unpairedTables: UnpairedTable[]
  ignoredJudgements: IgnoredJudgement[]
  unusedConfirmations: UnusedConfirmation[]
  /** Resolutions that named no section or part, or whose part was not free; they changed nothing. */
  unusedResolutions: UnusedResolution[]
  /** What the verb reports; each equals the length of its list above. */
  counts: MatchCounts
}

const RANK: Record<ConfidenceWord, number> = { possible: 1, likely: 2, strong: 3 }

type Candidate = { part: number; confidence: ConfidenceWord; reason: string; score: number; source: 'judgement-stub' | 'judged' }

export function matchSections(base: readonly BasePart[], reading: Pick<WordReading, 'sections' | 'noHeadingStyles'>, options: MatchOptions = {}): SectionMatchResult {
  const sections = reading.sections
  const ref = (index: number): SectionRef => ({ index, heading: sections[index].heading })
  const partRef = (index: number): PartRef => ({ path: base[index].path, title: base[index].title })
  const items = new Map<number, SectionItem>() // keyed by the section's index (an ambiguous item by its first section)
  const mechanism = options.judged === undefined ? 'judgement-stub' : 'judged'
  const ignoredJudgements: IgnoredJudgement[] = []
  const held = new Set<number>()

  // A file with no heading styles: nothing to match by. Every section is the writer's to place.
  if (reading.noHeadingStyles) {
    sections.forEach((_, index) => {
      items.set(index, {
        status: 'ambiguous',
        reason: 'no-heading-styles',
        message: 'This Word file has no heading styles, so its sections cannot be matched to parts by heading. Place this section yourself.',
        sections: [ref(index)],
        candidates: []
      })
    })
    base.forEach((_, index) => held.add(index))
    return finish(base, sections, items, held, mechanism, ignoredJudgements, options, partRef)
  }

  // 1. Code: exact equality of headings.
  const claimed = new Set<number>() // parts taken by an exact match
  const settled = new Set<number>() // sections that are exact or in an ambiguous item
  const keysBySection = sections.map((s) => headingKey(s.heading))
  const sectionsByKey = new Map<string, number[]>()
  keysBySection.forEach((key, index) => {
    if (key !== null) sectionsByKey.set(key, [...(sectionsByKey.get(key) ?? []), index])
  })
  const partsByKey = new Map<string, number[]>()
  base.forEach((part, index) => {
    const key = headingKey(part.title)
    if (key !== null) partsByKey.set(key, [...(partsByKey.get(key) ?? []), index])
  })
  for (const [key, indexes] of sectionsByKey) {
    const equal = partsByKey.get(key) ?? []
    if (indexes.length > 1) {
      items.set(indexes[0], {
        status: 'ambiguous',
        reason: 'heading-appears-twice',
        message: `The heading “${sections[indexes[0]].heading?.trim()}” appears ${indexes.length} times in the Word file. Say which section is which.`,
        sections: indexes.map(ref),
        candidates: equal.map(partRef)
      })
      indexes.forEach((i) => settled.add(i))
      equal.forEach((p) => held.add(p))
    } else if (equal.length === 1) {
      items.set(indexes[0], { status: 'exact', section: ref(indexes[0]), part: partRef(equal[0]), moved: false })
      settled.add(indexes[0])
      claimed.add(equal[0])
    } else if (equal.length > 1) {
      items.set(indexes[0], {
        status: 'ambiguous',
        reason: 'heading-equals-several-parts',
        message: `The heading “${sections[indexes[0]].heading?.trim()}” is the title of ${equal.length} parts. Say which part this section is.`,
        sections: [ref(indexes[0])],
        candidates: equal.map(partRef)
      })
      settled.add(indexes[0])
      equal.forEach((p) => held.add(p))
    }
  }

  // 2. Judgement (or its stand-in): candidates for every section not yet settled.
  const free = (part: number): boolean => !claimed.has(part) && !held.has(part)
  const candidates = new Map<number, Candidate[]>()
  const addCandidate = (section: number, candidate: Candidate): void => {
    candidates.set(section, [...(candidates.get(section) ?? []), candidate])
  }
  if (options.judged === undefined) {
    sections.forEach((section, s) => {
      if (settled.has(s)) return
      base.forEach((part, p) => {
        if (!free(p)) return
        const clue: Clue | null = clueFor(section, part.title, part.markdown)
        if (clue) addCandidate(s, { part: p, ...clue, source: 'judgement-stub' })
      })
    })
  } else {
    for (const judged of options.judged) {
      const why = judgedProblem(judged)
      if (why) ignoredJudgements.push({ judged, why })
      else addCandidate(judged.sectionIndex, { part: base.findIndex((p) => p.path === judged.part), confidence: judged.confidence, reason: judged.reason, score: 0, source: 'judged' })
    }
  }
  function judgedProblem(judged: JudgedMatch): string | null {
    if (!Number.isInteger(judged.sectionIndex) || judged.sectionIndex < 0 || judged.sectionIndex >= sections.length) return 'There is no such section in the Word file.'
    const part = base.findIndex((p) => p.path === judged.part)
    if (part < 0) return 'There is no such part in the base version.'
    if (!(judged.confidence in RANK)) return 'The confidence is not strong, likely or possible.'
    if (settled.has(judged.sectionIndex)) return 'That section is already matched exactly or is waiting on an ambiguity.'
    if (!free(part)) return 'That part is already matched exactly or is held by an ambiguity.'
    return null
  }

  // Keep each section's best-ranked candidates; more than one at the top means it could be several parts.
  const top = new Map<number, Candidate[]>()
  for (const [s, list] of candidates) {
    const best = Math.max(...list.map((c) => RANK[c.confidence] * 10 + c.score))
    const winners = list.filter((c) => Math.abs(RANK[c.confidence] * 10 + c.score - best) < 1e-9)
    // The same part named twice is one candidate.
    top.set(s, winners.filter((c, i) => winners.findIndex((o) => o.part === c.part) === i))
  }

  // Sections that share a candidate part are one question: join them.
  const group = new Map<number, number>()
  const find = (s: number): number => {
    let root = s
    while ((group.get(root) ?? root) !== root) root = group.get(root) as number
    return root
  }
  for (const s of top.keys()) group.set(s, s)
  const byPart = new Map<number, number>()
  for (const [s, list] of top) {
    for (const c of list) {
      const seen = byPart.get(c.part)
      if (seen === undefined) byPart.set(c.part, s)
      else group.set(find(s), find(seen))
    }
  }
  const groups = new Map<number, number[]>()
  for (const s of [...top.keys()].sort((a, b) => a - b)) groups.set(find(s), [...(groups.get(find(s)) ?? []), s])
  for (const members of groups.values()) {
    const parts = [...new Set(members.flatMap((s) => (top.get(s) ?? []).map((c) => c.part)))].sort((a, b) => a - b)
    if (members.length === 1 && parts.length === 1) {
      const s = members[0]
      const pick = (top.get(s) as Candidate[])[0]
      items.set(s, { status: 'proposed', section: ref(s), part: partRef(pick.part), confidence: pick.confidence, reason: pick.reason, source: pick.source, moved: false })
    } else {
      const several = members.length > 1
      items.set(members[0], {
        status: 'ambiguous',
        reason: several ? 'two-sections-one-part' : 'several-parts-could-match',
        message: several
          ? 'More than one section of the Word file could be the same part. Say which section is which part.'
          : `The section “${sections[members[0]].heading?.trim()}” could be any of ${parts.length} parts. Say which one.`,
        sections: members.map(ref),
        candidates: parts.map(partRef)
      })
      parts.forEach((p) => held.add(p))
    }
    members.forEach((s) => settled.add(s))
  }

  // 3. Everything left in her file is new. Say when it looks like a part that another section already matched exactly.
  sections.forEach((section, s) => {
    if (settled.has(s)) return
    let note: string | undefined
    for (let p = 0; p < base.length && note === undefined; p += 1) {
      if (!claimed.has(p) || clueFor(section, base[p].title, base[p].markdown) === null) continue
      const owner = [...items.values()].find((it): it is MatchedItem => it.status === 'exact' && it.part.path === base[p].path)
      note = `This section resembles “${base[p].title.trim()}”, which “${owner?.section.heading?.trim()}” already matches exactly. It may be a split from it.`
    }
    items.set(s, note === undefined ? { status: 'new', section: ref(s) } : { status: 'new', section: ref(s), note })
  })

  return finish(base, sections, items, held, mechanism, ignoredJudgements, options, partRef)
}

/** Steps shared by every route: confirmations, moved, tables, lists and counts. */
function finish(
  base: readonly BasePart[],
  sections: readonly WordSection[],
  itemMap: Map<number, SectionItem>,
  heldSet: Set<number>,
  mechanism: SectionMatchResult['mechanism'],
  ignoredJudgements: IgnoredJudgement[],
  options: MatchOptions,
  partRef: (index: number) => PartRef
): SectionMatchResult {
  let items = [...itemMap.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item)
  const noHeadingStyles = items.length > 0 && items.every((i) => i.status === 'ambiguous' && i.reason === 'no-heading-styles')
  const matchedItems = (): MatchedItem[] => items.filter((i): i is MatchedItem => i.status === 'exact' || i.status === 'proposed' || i.status === 'confirmed')

  // Confirmations: a proposal the writer names becomes confirmed; nothing else about it changes.
  const unusedConfirmations: UnusedConfirmation[] = []
  for (const confirmation of options.confirmations ?? []) {
    const heading = headingKey(confirmation.heading)
    const target = headingKey(confirmation.part)
    const named = (item: { section: SectionRef }): boolean => heading !== null && headingKey(item.section.heading) === heading
    const hit = items.find((i): i is MatchedItem => i.status === 'proposed' && named(i) && (i.part.path === confirmation.part || headingKey(i.part.title) === target))
    if (hit) hit.status = 'confirmed'
    else if (items.some((i) => (i.status === 'exact' || i.status === 'confirmed') && named(i))) unusedConfirmations.push({ confirmation, why: 'That section is already matched.' })
    else if (items.some((i) => i.status === 'ambiguous' && i.sections.some((s) => named({ section: s })))) unusedConfirmations.push({ confirmation, why: 'That section is ambiguous and has to be resolved, not confirmed.' })
    else unusedConfirmations.push({ confirmation, why: 'There is no close match proposed for that heading and part.' })
  }

  // Resolutions: the writer's own decisions. They are the only way an ambiguous section is settled, and they never come from code or a judge.
  const unusedResolutions: UnusedResolution[] = []
  const heldSetNow = new Set(heldSet)
  if ((options.resolutions ?? []).length > 0) {
    const applied = applyResolutions(base, sections, items, options.resolutions ?? [], unusedResolutions)
    items = applied
    // What is held now: the candidates of the ambiguous items still waiting (every part, for a file with no heading styles), less what is matched.
    heldSetNow.clear()
    const matchedNow = new Set(items.filter((i): i is MatchedItem => i.status !== 'ambiguous' && i.status !== 'new').map((i) => base.findIndex((p) => p.path === i.part.path)))
    for (const item of items) {
      if (item.status !== 'ambiguous') continue
      if (item.reason === 'no-heading-styles') base.forEach((_, p) => { if (!matchedNow.has(p)) heldSetNow.add(p) })
      else for (const candidate of item.candidates) { const p = base.findIndex((part) => part.path === candidate.path); if (!matchedNow.has(p)) heldSetNow.add(p) }
    }
  }

  // Moved: among matched sections, the longest run still in the base order stays put; the rest moved.
  const matched = matchedItems()
  const baseIndex = (item: MatchedItem): number => base.findIndex((p) => p.path === item.part.path)
  const moves = movedFlags(matched.map(baseIndex))
  matched.forEach((item, i) => {
    item.moved = moves[i]!
  })

  // Tables: reported, never applied.
  const tableNotes: TableNote[] = []
  const unpairedTables: UnpairedTable[] = []
  for (const item of matched) {
    const theirs = sections[item.section.index].blocks.filter((b: WordBlock): b is WordTable => b.type === 'table')
    const ours = base[baseIndex(item)].tables ?? []
    for (let t = 0; t < Math.min(theirs.length, ours.length); t += 1) {
      const cellsDiffering = countDifferingCells(ours[t].rows, theirs[t].rows)
      if (cellsDiffering > 0) {
        tableNotes.push({
          file: ours[t].file,
          section: item.section,
          part: item.part,
          match: item.status,
          cellsDiffering,
          message: `${ours[t].file}: ${cellsDiffering} ${cellsDiffering === 1 ? 'cell differs' : 'cells differ'} in the Word table.`
        })
      }
    }
    for (let t = ours.length; t < theirs.length; t += 1) {
      unpairedTables.push({ side: 'hers', section: item.section, part: item.part, message: `The Word section has a table that “${item.part.title.trim()}” has no file for.` })
    }
    for (let t = theirs.length; t < ours.length; t += 1) {
      unpairedTables.push({ side: 'base', part: item.part, file: ours[t].file, message: `${ours[t].file} has no table in the Word section.` })
    }
  }

  const heldParts = [...heldSetNow].sort((a, b) => a - b)
  const missing: PartRef[] = []
  base.forEach((part, p) => {
    if (part.role !== 'part' || heldSetNow.has(p)) return
    if (!matched.some((m) => m.part.path === part.path)) missing.push(partRef(p))
  })

  const ambiguous = items.filter((i): i is AmbiguousItem => i.status === 'ambiguous')
  const fresh = items.filter((i): i is NewItem => i.status === 'new')
  const exactAndConfirmed = matched.filter((m) => m.status !== 'proposed')
  const close = matched.filter((m) => m.status === 'proposed')
  const moved = matched.filter((m) => m.moved)
  return {
    mechanism,
    noHeadingStyles,
    items,
    matched: exactAndConfirmed,
    close,
    ambiguous,
    new: fresh,
    missing,
    held: heldParts.map(partRef),
    moved,
    tableNotes,
    unpairedTables,
    ignoredJudgements,
    unusedConfirmations,
    unusedResolutions,
    counts: {
      exact: exactAndConfirmed.filter((m) => m.status === 'exact').length,
      confirmed: exactAndConfirmed.filter((m) => m.status === 'confirmed').length,
      close: close.length,
      ambiguous: ambiguous.length,
      new: fresh.length,
      missing: missing.length,
      held: heldParts.length,
      moved: moved.length,
      tableNotes: tableNotes.length
    }
  }
}

const cell = (grid: string[][], r: number, c: number): string => (grid[r]?.[c] ?? '').normalize('NFKC').trim()

/** Cells that differ between two grids, comparing the larger of the two shapes; a missing cell counts as empty. */
export function countDifferingCells(ours: string[][], theirs: string[][]): number {
  const rows = Math.max(ours.length, theirs.length)
  let columns = 0
  for (const grid of [ours, theirs]) for (const row of grid) if (row.length > columns) columns = row.length
  let differing = 0
  for (let r = 0; r < rows; r += 1) for (let c = 0; c < columns; c += 1) if (cell(ours, r, c) !== cell(theirs, r, c)) differing += 1
  return differing
}

/**
 * Apply the writer's resolutions to the items, in order, and return the items by the place of their first section. A resolution is
 * refused (listed in `unused`, changing nothing) when it names no section of hers or no part of the base, when the section is already
 * matched exactly or confirmed, or when the part is not free for that section: taken by another matched section, proposed for another
 * section that is still waiting (resolve that one first), or held by an ambiguous item the section is not in.
 * An ambiguous item gives up each section as it is resolved and goes when none is left.
 */
function applyResolutions(base: readonly BasePart[], sections: readonly WordSection[], start: readonly SectionItem[], resolutions: readonly MatchResolution[], unused: UnusedResolution[]): SectionItem[] {
  let items: SectionItem[] = [...start]
  const ref = (index: number): SectionRef => ({ index, heading: sections[index].heading })
  const partRef = (index: number): PartRef => ({ path: base[index].path, title: base[index].title })
  const done = new Set<number>() // sections the writer has resolved already in this call
  const firstSection = (item: SectionItem): number => (item.status === 'ambiguous' ? Math.min(...item.sections.map((s) => s.index)) : item.section.index)
  const ownerOf = (section: number): SectionItem | undefined => items.find((item) => (item.status === 'ambiguous' ? item.sections.some((s) => s.index === section) : item.section.index === section))

  for (const resolution of resolutions) {
    const refuse = (why: string): void => { unused.push({ resolution, why }) }
    const { section, part } = resolution
    if (!Number.isInteger(section) || section < 0 || section >= sections.length) { refuse('There is no such section in the Word file.'); continue }
    if (part !== null && typeof part !== 'string') { refuse('A part is named by its path, or null for none.'); continue }
    const partIndex = part === null ? -1 : base.findIndex((p) => p.path === part)
    if (part !== null && partIndex < 0) { refuse('There is no such part in the base version.'); continue }
    if (done.has(section)) { refuse('That section already has a decision.'); continue }
    const owner = ownerOf(section)
    if (!owner) { refuse('There is no such section in the Word file.'); continue }
    if (owner.status === 'exact') { refuse('That section is matched exactly by its heading; it needs no decision.'); continue }
    if (owner.status === 'confirmed') { refuse('That section is already confirmed.'); continue }
    if (partIndex >= 0) {
      const blocked = items.find((item): boolean => {
        if (item === owner) return false
        if (item.status === 'exact' || item.status === 'confirmed') return item.part.path === part
        if (item.status === 'proposed') return item.part.path === part
        if (item.status === 'ambiguous') return item.reason !== 'no-heading-styles' && item.candidates.some((c) => c.path === part)
        return false
      })
      if (blocked) {
        refuse(blocked.status === 'exact' || blocked.status === 'confirmed'
          ? 'That part is already matched to another section.'
          : blocked.status === 'proposed' ? 'That part is proposed for another section that is still waiting. Decide that section first.'
            : 'That part is one an ambiguous section could be. Decide that section first.')
        continue
      }
    }
    const decided: SectionItem = partIndex < 0
      ? { status: 'new', section: ref(section) }
      : owner.status === 'proposed' && owner.part.path === part
        ? { ...owner, status: 'confirmed' }
        : { status: 'confirmed', section: ref(section), part: partRef(partIndex), source: 'writer', moved: false }
    done.add(section)
    if (owner.status === 'ambiguous') {
      const left = owner.sections.filter((s) => s.index !== section)
      items = items.filter((item) => item !== owner)
      if (left.length > 0) items.push({ ...owner, sections: left })
      items.push(decided)
    } else items = items.map((item) => (item === owner ? decided : item))
  }
  return items.sort((a, b) => firstSection(a) - firstSection(b))
}

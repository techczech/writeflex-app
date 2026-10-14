import {
  continuesNumbering,
  fancyMarkerAt,
  labelFor,
  labelFits,
  numberingOfFirst,
  ordinalOf,
  type ListDelimiter,
  type ListNumbering,
} from '../../../shared/markdown/fancy-lists'

/**
 * List lines as TEXT — the pure half of lettered and roman lists and of changing a list's type
 * (docs/design/2026-09-27-checkbox-lists, hifi-direction-1 frames 5–6). No CodeMirror here: the
 * commands in list-types.ts confirm with the syntax tree that a line really is a list item, then hand
 * the lines to these functions, so every rule below is testable on plain strings.
 *
 * Three seams:
 *  - {@link readListLine}: a line's indent, marker, the space after it, any `[ ]` box, and the words;
 *  - {@link listRunAt}: "the list the cursor is in" — the items at one indent, with their children
 *    and continuation lines between them (children are part of the run but are not its items);
 *  - {@link relist}: the List type rewrite — the run's lines and a target type in, new lines out.
 *    Only the items' markers change; boxes (`[x]` included) and words never do.
 */

export type ListLine = {
  /** Whitespace before the marker, as typed. */
  indent: string
  indentColumns: number
  /** `-`, `*`, `+`, `3.`, `b)`, `iv.` */
  marker: string
  kind: 'bullet' | 'ordered'
  /** The ordered label without its delimiter (`3`, `b`, `iv`); null for a bullet. */
  label: string | null
  delimiter: ListDelimiter | null
  /** The whitespace after the marker ('' on a marker-only line). */
  spacing: string
  /** `[ ] `, `[x] ` (with its trailing whitespace), or ''. */
  box: string
  /** Everything after the prefix. Never rewritten. */
  body: string
}

export type ListType = 'lower-alpha' | 'lower-roman' | 'decimal' | 'bullet' | 'checkboxes'

function columnsOf(indent: string): number {
  let columns = 0
  for (const character of indent) columns += character === '\t' ? 4 - (columns % 4) : 1
  return columns
}

const BOX = /^\[[ xX]\](?:[ \t]+|$)/

/** Read a list item line, or null. Fancy markers are CANDIDATES here (the caller asks the tree). */
export function readListLine(text: string): ListLine | null {
  const indent = /^[ \t]*/.exec(text)![0]
  const rest = text.slice(indent.length)
  let marker: string
  let kind: ListLine['kind']
  let label: string | null = null
  let delimiter: ListDelimiter | null = null
  const bullet = /^[-+*](?=[ \t]|$)/.exec(rest)
  const decimal = /^(\d{1,9})([.)])(?=[ \t]|$)/.exec(rest)
  if (bullet) {
    marker = bullet[0]
    kind = 'bullet'
  } else if (decimal) {
    marker = decimal[0]
    kind = 'ordered'
    label = decimal[1]
    delimiter = decimal[2] as ListDelimiter
  } else {
    const fancy = fancyMarkerAt(rest)
    if (!fancy) return null
    marker = `${fancy.label}${fancy.delimiter}`
    kind = 'ordered'
    label = fancy.label
    delimiter = fancy.delimiter
  }
  const afterMarker = rest.slice(marker.length)
  const spacing = /^[ \t]*/.exec(afterMarker)![0]
  const afterSpacing = afterMarker.slice(spacing.length)
  const box = spacing !== '' ? (BOX.exec(afterSpacing)?.[0] ?? '') : ''
  return {
    indent,
    indentColumns: columnsOf(indent),
    marker,
    kind,
    label,
    delimiter,
    spacing,
    box,
    body: afterSpacing.slice(box.length),
  }
}

/** The line's prefix: everything a list command may rewrite. */
export function prefixOf(line: ListLine): string {
  return line.indent + line.marker + line.spacing + line.box
}

/** Rebuild a line from its parts. */
export function writeListLine(line: ListLine): string {
  return prefixOf(line) + line.body
}

/**
 * Pandoc reads a single capital followed by a period as an initial unless two spaces follow it
 * (fancy-lists.ts), so a marker that becomes `V.` or `B.` gets the second space it needs to stay
 * a list item. Everything else keeps the spacing the writer typed.
 */
export function spacingAfter(label: string, delimiter: ListDelimiter, spacing: string): string {
  if (delimiter === '.' && /^[A-Z]$/.test(label) && spacing === ' ') return '  '
  return spacing
}

/** Read access to a document's lines, 0-based, so a run never needs the whole text as an array. */
export type Lines = { count: number; text: (index: number) => string }

export function linesOf(texts: readonly string[]): Lines {
  return { count: texts.length, text: (index) => texts[index] ?? '' }
}

export type ListRun = {
  /** The indent, in columns, of the run's items. */
  level: number
  /** Line indexes of the run's items, in order. */
  members: number[]
  /** First and last line index the run covers (items, children, continuation and inner blanks). */
  from: number
  to: number
}

const isBlank = (text: string): boolean => text.trim() === ''
const isHeading = (text: string): boolean => /^ {0,3}#{1,6}(?:[ \t]|$)/.test(text)

/**
 * The item line a position on line `index` belongs to: the line itself when it is an item, else the
 * nearest item above it through continuation lines (a blank line or a heading ends the search).
 */
export function itemLineAt(lines: Lines, index: number): number | null {
  for (let at = index; at >= 0; at -= 1) {
    const text = lines.text(at)
    if (readListLine(text)) return at
    if (isBlank(text) || isHeading(text)) return null
  }
  return null
}

/**
 * THE LIST the item on line `index` is in: its siblings at the same indent, found by walking out
 * from it. Deeper items and continuation lines belong to the run without being its items; a blank
 * line belongs only when the run carries on after it (a loose list); a heading, an item at a
 * shallower indent, or prose back at the list's indent after a blank line ends it.
 */
export function listRunAt(lines: Lines, index: number): ListRun | null {
  const own = readListLine(lines.text(index))
  if (!own) return null
  const level = own.indentColumns
  /** Does line `at` carry the run on? 'member', 'inside' (child or continuation) or null (it ends). */
  const classify = (at: number, afterBlank: boolean): 'member' | 'inside' | 'blank' | null => {
    const text = lines.text(at)
    if (isBlank(text)) return 'blank'
    if (isHeading(text)) return null
    const item = readListLine(text)
    if (item) {
      if (item.indentColumns === level) return 'member'
      return item.indentColumns > level ? 'inside' : null
    }
    // Prose: a lazy continuation directly under a line of the run, or indented past the marker.
    if (!afterBlank) return 'inside'
    return columnsOf(/^[ \t]*/.exec(text)![0]) > level ? 'inside' : null
  }

  const members = [index]
  let to = index
  let blankRun = false
  for (let at = index + 1; at < lines.count; at += 1) {
    const kind = classify(at, blankRun)
    if (kind === null) break
    if (kind === 'blank') {
      blankRun = true
      continue
    }
    blankRun = false
    if (kind === 'member') members.push(at)
    to = at
  }

  let from = index
  // Upward, a line is only known to be inside the run once an item at the run's level is found
  // above it, so candidates are held until then.
  let pending: number[] = []
  for (let at = index - 1; at >= 0; at -= 1) {
    const text = lines.text(at)
    if (isBlank(text)) {
      pending.push(at)
      continue
    }
    if (isHeading(text)) break
    const item = readListLine(text)
    if (item && item.indentColumns < level) break
    if (item && item.indentColumns === level) {
      members.unshift(at)
      from = at
      pending = []
      continue
    }
    // A child item, or prose: inside the run if an item of the run is found above it.
    pending.push(at)
    if (!item && pending.some((line) => isBlank(lines.text(line))) && columnsOf(/^[ \t]*/.exec(text)![0]) <= level) break
  }
  // One indent can hold several lists, as the parser reads them: bullets, then `1.`, then `a.`, or a
  // lettered list followed by a roman one. The run is the one holding `index`.
  const segments: number[][] = []
  let open: { numbering: ListNumbering | 'bullet' | null; delimiter: ListDelimiter | null } | null = null
  for (const member of members) {
    const item = readListLine(lines.text(member))!
    const carriesOn = open !== null && (item.kind === 'bullet'
      ? open.numbering === 'bullet'
      : open.numbering !== 'bullet' && open.numbering !== null && item.delimiter === open.delimiter &&
        item.label !== null && continuesNumbering(item.label, open.numbering))
    if (carriesOn) {
      segments[segments.length - 1].push(member)
      continue
    }
    segments.push([member])
    open = { numbering: item.kind === 'bullet' ? 'bullet' : numberingOpenedBy(item.label ?? ''), delimiter: item.delimiter }
  }
  const at = segments.findIndex((segment) => segment.includes(index))
  const segment = segments[at]
  const next = segments[at + 1]
  let end = next ? next[0] - 1 : to
  while (next && end > segment[segment.length - 1] && isBlank(lines.text(end))) end -= 1
  return { level, members: segment, from: at === 0 ? from : segment[0], to: end }
}

/** The numbering a list opening on `label` counts in; `aa.` (a list cut off above) still counts in letters. */
function numberingOpenedBy(label: string): ListNumbering | null {
  const opens = numberingOfFirst(label)
  if (opens) return opens
  if (labelFits(label, 'lower-alpha')) return 'lower-alpha'
  if (labelFits(label, 'upper-alpha')) return 'upper-alpha'
  return null
}

/** The numbering a run counts in, read from its first item; null for a bullet list. */
export function numberingOfRun(lines: Lines, run: ListRun): ListNumbering | null {
  const first = readListLine(lines.text(run.members[0]))
  if (!first || first.kind !== 'ordered' || first.label === null) return null
  return numberingOpenedBy(first.label)
}

/** The ordinal the run's first item stands for (1 for a bullet list or an unreadable label). */
export function startOfRun(lines: Lines, run: ListRun, numbering: ListNumbering | null): number {
  const first = readListLine(lines.text(run.members[0]))
  if (!numbering || !first?.label) return 1
  return ordinalOf(first.label, numbering) ?? 1
}

/**
 * THE LIST TYPE REWRITE: the lines of one run (`lines[0]` is its first item; the run's items are the
 * item lines at that indent) and a target type in, the new lines out. Items are renumbered in the
 * target numbering from the list's own start (a list that began at 3 becomes c., iii. or 3.; a bullet
 * list starts at 1), and keep the delimiter an ordered list already had. `checkboxes` gives every
 * item a box — an existing `[x]` stays ticked — and `bullet` and the numberings keep whatever boxes
 * there are. Children, continuation lines and words are returned untouched.
 */
export function relist(lines: readonly string[], target: ListType): string[] {
  const read = lines.map(readListLine)
  const first = read[0]
  if (!first) return [...lines]
  const run: ListRun = {
    level: first.indentColumns,
    members: read.flatMap((line, index) => (line && line.indentColumns === first.indentColumns ? [index] : [])),
    from: 0,
    to: lines.length - 1,
  }
  const source = linesOf(lines)
  const sourceNumbering = numberingOfRun(source, run)
  const start = startOfRun(source, run, sourceNumbering)
  const delimiter: ListDelimiter = first.delimiter ?? '.'
  const out = [...lines]
  run.members.forEach((index, offset) => {
    const line = read[index]!
    if (target === 'bullet' || target === 'checkboxes') {
      const marker = line.kind === 'bullet' ? line.marker : '-'
      const box = target === 'checkboxes' && line.box === '' ? '[ ] ' : line.box
      // A marker-only item still needs the space that makes the box a box.
      const spacing = box !== '' && line.spacing === '' ? ' ' : line.spacing
      out[index] = writeListLine({ ...line, marker, spacing, box })
      return
    }
    const label = labelFor(start + offset, target)
    out[index] = writeListLine({ ...line, marker: `${label}${delimiter}`, spacing: spacingAfter(label, delimiter, line.spacing) })
  })
  return out
}

/**
 * Renumber a run's items in place from `start`, in `numbering`, keeping each item's delimiter and
 * box. Used after Return adds an item mid-list and after Tab moves one between lists.
 */
export function renumberRun(texts: string[], members: readonly number[], numbering: ListNumbering, start: number): void {
  members.forEach((index, offset) => {
    const line = readListLine(texts[index] ?? '')
    if (!line || line.kind !== 'ordered') return
    const label = labelFor(start + offset, numbering)
    const delimiter = line.delimiter ?? '.'
    texts[index] = writeListLine({ ...line, marker: `${label}${delimiter}`, spacing: spacingAfter(label, delimiter, line.spacing) })
  })
}

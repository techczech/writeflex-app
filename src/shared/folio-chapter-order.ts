/**
 * THE chapter order for a Folio's part files. The chapter number is the first run of digits in the base name
 * that stands on its own: at the start of the name or right after a separator (`-`, `_`, space, `.`), and
 * ending at a separator or the end of the name. `kapitola-2-x.md` is 2 and sorts before `kapitola-10-y.md`,
 * `01-intro.md` is 1; `README-v2.md` and `ch2.md` have none. Make a Folio's "is numbered" check is this
 * same function (main/folio.ts `draftManifest`). Numbered files are grouped by their stem (the base name before
 * the chapter digits, lower-cased, trailing separators trimmed); groups go in alphabetical order of stem (an empty
 * stem first), and within a group by number (ties by name, numeric-aware). Unnumbered files follow by name.
 * Used wherever unlisted files are offered (Make a Folio, "Also in this folder", the Plan's unlisted
 * list). A running order the writer already set is never re-sorted by it, only by "Sort by chapter number".
 */

/** A digit run with a separator or the name's edge on both sides (the `.` of `.md` counts as a separator). */
const CHAPTER_DIGITS = /(?:^|[-_ .])(\d+)(?=[-_ .]|$)/

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** The chapter number of a file name or path, or null when no digit run in the base name stands on its own. */
export function chapterNumber(path: string): number | null {
  const match = CHAPTER_DIGITS.exec(baseName(path))
  return match ? Number(match[1]) : null
}

/**
 * The series a numbered file belongs to: the base name before its chapter digits, lower-cased, with trailing
 * separators trimmed. `case-2.md` and `kapitola-2.md` are in different series; `01-intro.md` has the empty one.
 */
function stemOf(path: string): string {
  const base = baseName(path)
  const match = CHAPTER_DIGITS.exec(base)
  return match ? base.slice(0, match.index).toLowerCase().replace(/[-_ .]+$/, '') : ''
}

/** Compare two part files (names or paths) in chapter order. */
export function compareChapterOrder(a: string, b: string): number {
  const na = chapterNumber(a)
  const nb = chapterNumber(b)
  if (na !== null && nb === null) return -1
  if (na === null && nb !== null) return 1
  if (na !== null && nb !== null) {
    const series = stemOf(a).localeCompare(stemOf(b), undefined, { numeric: true })
    if (series !== 0) return series
    if (na !== nb) return na - nb
  }
  const ba = baseName(a)
  const bb = baseName(b)
  // Last, plain code-unit order (base name, then the whole path): `ch-02` and `ch-2` are equal to a
  // numeric-aware compare, and must still come out in one order every time.
  return ba.localeCompare(bb, undefined, { numeric: true }) || plainCompare(ba, bb) || plainCompare(a, b)
}

function plainCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** A copy of `items` in chapter order, by the path (or name) `key` gives. Stable. */
export function sortByChapterOrder<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((x, y) => compareChapterOrder(key(x), key(y)))
}

/**
 * "Sort by chapter number" as an order for a running order: `order[k]` is the current index of the part that
 * goes to position k. Only the parts that have a file (`path` not null) are sorted, by chapter order, into
 * the positions they occupy now; a part with no file yet keeps its position. Stable. With `frontMatter` (one
 * flag per part, ADR-0046) the front matter and the contents are each sorted among the positions they hold,
 * so no part crosses the front-matter boundary.
 */
export function chapterSortOrder(paths: ReadonlyArray<string | null>, frontMatter?: readonly boolean[]): number[] {
  const order = paths.map((_, index) => index)
  const sides: Array<boolean | null> = frontMatter ? [true, false] : [null]
  for (const side of sides) {
    const written = paths.flatMap((path, index) => (path === null || (side !== null && (frontMatter?.[index] === true) !== side) ? [] : [index]))
    const sorted = [...written].sort((x, y) => compareChapterOrder(paths[x] as string, paths[y] as string) || x - y)
    written.forEach((slot, at) => { order[slot] = sorted[at] })
  }
  return order
}

/** The order that undoes `order` (both as `chapterSortOrder` gives them). */
export function inverseOrder(order: readonly number[]): number[] {
  const inverse = new Array<number>(order.length)
  order.forEach((from, to) => { inverse[from] = to })
  return inverse
}

/** Whether an order leaves every part where it is. */
export function isIdentityOrder(order: readonly number[]): boolean {
  return order.every((from, to) => from === to)
}

/**
 * Front matter in a Folio (ADR-0046): parts that export before the contents page and are never listed in it
 * (a title page, a preface, acknowledgements). The one reading of what marks a part as front matter, and the
 * one rule for where front matter sits in the running order. Pure: main (the Plan, the manifest-only writes,
 * the export, the Outline facts) and the renderer (the Plan's groups, the Outline's groups) share it.
 *
 * What marks a part (`partIsFrontMatter`): ANY ONE of these, each sufficient on its own; none vetoes another.
 * - a running-order line tagged `#front-matter` (the Plan role `front-matter`);
 * - a manifest entry whose `role` is `front-matter` or `title-matter`;
 * - the manifest's `title_matter` file, whatever role its entry names.
 * `toc: false` alone does not make a part front matter: such a part stays where it is, as it always did.
 * WriteFlex writes `"role": "front-matter", "toc": false` for an entry it creates or changes to front matter.
 *
 * A file whose own frontmatter says `role: title-matter` is a title page; so is the manifest's `title_matter`
 * file. A file under Not in the outline is offered "Add as front matter" when its header says
 * `role: title-matter` or `role: front-matter`, it is front matter by its manifest entry, or its entry says `toc: false`.
 *
 * Where it sits: every front-matter part comes before every contents part. Adding keeps the front matter a
 * leading block; a move never crosses the boundary (a part crosses it by changing its role).
 */

import { titleFromFileName, type PartTitle } from './folio-part-title'

export const FRONT_MATTER_ROLE = 'front-matter'
export const TITLE_MATTER_ROLE = 'title-matter'

/** Why a write was refused: it would put a contents part before front matter, or front matter after the contents. */
export const FRONT_MATTER_STAYS_LEADING = 'Front matter stays ahead of the contents. Change the part’s role to move it across. Nothing was changed.'

function normalised(role: unknown): string {
  return typeof role === 'string' ? role.trim().toLocaleLowerCase() : ''
}

/** A role string (a Plan role, a manifest entry's role) that means front matter. */
export function isFrontMatterRole(role: unknown): boolean {
  const value = normalised(role)
  return value === FRONT_MATTER_ROLE || value === TITLE_MATTER_ROLE
}

/**
 * Whether a manifest entry counts as front matter when read: its role is `front-matter` or `title-matter`, or it
 * is the manifest's `title_matter` file (`isTitleMatter`), whatever its role says. `toc: false` alone does not count.
 */
export function manifestEntryIsFrontMatter(entry: { role?: unknown }, isTitleMatter = false): boolean {
  return isFrontMatterRole(entry.role) || isTitleMatter
}

/**
 * The one reading of whether a part is front matter (ADR-0046), for every surface (the Plan, the Outline, the
 * export): its running-order line's role (`lineRole`) or its `#front-matter` tag wherever it stands among the line's
 * role tags (`lineFrontMatter`, plan-line.ts), its manifest entry, or its being the manifest's `title_matter` file. Any one suffices; a role the line or the entry names otherwise never
 * takes the part out of front matter.
 */
export function partIsFrontMatter(markers: { lineRole?: unknown; lineFrontMatter?: boolean; entry?: { role?: unknown } | null; isTitleMatter?: boolean }): boolean {
  return isFrontMatterRole(markers.lineRole) || markers.lineFrontMatter === true || (markers.entry != null && isFrontMatterRole(markers.entry.role)) || markers.isTitleMatter === true
}

/** Why the role menu is off on the manifest's `title_matter` part: that file is front matter whatever its role. */
export const TITLE_PAGE_SET_IN_MANIFEST = 'Title page set in the folio’s manifest'

/** Whether a file under Not in the outline is offered "Add as front matter" by its manifest entry: it is front matter, or its `toc` is `false`. */
export function manifestEntryOffersFrontMatter(entry: { role?: unknown; toc?: unknown }, isTitleMatter = false): boolean {
  return manifestEntryIsFrontMatter(entry, isTitleMatter) || entry.toc === false
}

/** A file header's `role` that makes the file a title page. */
export function headerSaysTitlePage(role: unknown): boolean {
  return normalised(role) === TITLE_MATTER_ROLE
}

/** A file header's `role` that offers the file as front matter. */
export function headerSaysFrontMatter(role: unknown): boolean {
  return isFrontMatterRole(role)
}

/** Whether every front-matter part (true) comes before every contents part (false). */
export function frontMatterLeads(flags: readonly boolean[]): boolean {
  const firstContents = flags.indexOf(false)
  return firstContents < 0 || !flags.slice(firstContents).includes(true)
}

/** The place just after the last front-matter part (0 when there is none): where front matter is added. */
export function frontBlockEnd(flags: readonly boolean[]): number {
  return flags.lastIndexOf(true) + 1
}

/**
 * Where a part asked for at `at` goes, so that front matter stays a leading block: front matter no later than
 * the end of the block, a contents part no earlier. An order that does not lead already is left as asked.
 */
export function placeInOrder(flags: readonly boolean[], at: number, frontMatter: boolean): number {
  if (!frontMatterLeads(flags)) return at
  const end = frontBlockEnd(flags)
  return frontMatter ? Math.min(at, end) : Math.max(at, end)
}

/**
 * Refuse a write that turns an order whose front matter leads into one where it does not. An order that did
 * not lead before (an edit made outside WriteFlex) is not made a reason to refuse every later change.
 */
export function assertFrontMatterStaysLeading(before: readonly boolean[], after: readonly boolean[]): void {
  if (frontMatterLeads(before) && !frontMatterLeads(after)) throw new Error(FRONT_MATTER_STAYS_LEADING)
}

/** Whether moving the part at `from` to `to` (its index once taken out and put back) keeps it on its side of the boundary. */
export function moveStaysInBlock(flags: readonly boolean[], from: number, to: number): boolean {
  const order = flags.map((_, index) => index)
  const [moved] = order.splice(from, 1)
  order.splice(to, 0, moved)
  return !frontMatterLeads(flags) || frontMatterLeads(order.map((index) => flags[index]))
}

/** A copy of `items` with the front matter first, each side keeping its order. */
export function frontMatterFirst<T>(items: readonly T[], isFront: (item: T) => boolean): T[] {
  return [...items.filter(isFront), ...items.filter((item) => !isFront(item))]
}

/** How a role is named in the Plan's menu and on its cards: "Front matter", "Section". */
export function roleLabel(role: string): string {
  const words = role.replace(/-/g, ' ')
  return `${words.charAt(0).toLocaleUpperCase()}${words.slice(1)}`
}

/**
 * The order an Add makes (ADR-0046): the added front matter at the end of the front-matter block, the rest at the
 * end, each group in the order added. `isFront` says which pieces are front matter. Pure.
 */
export function orderAfterAdd<T>(before: readonly T[], added: readonly T[], isFront: (item: T) => boolean): T[] {
  const at = frontBlockEnd(before.map(isFront))
  return [...before.slice(0, at), ...added.filter(isFront), ...before.slice(at), ...added.filter((item) => !isFront(item))]
}

/**
 * The heading checks (title conflicts, "No heading in the text", "Add the heading") are off for front matter: a
 * title page has no heading by design (frontmatter plus a byline), so its title comes only from frontmatter
 * `title:`. The signals below are the same three `partIsFrontMatter` reads, named the way the heading-check
 * callers hold them: the running-order line's tags (its role may be passed with them), the manifest
 * `files[].role`, and the manifest's `title_matter` resolved to a workspace path.
 */
export const FRONT_MATTER_TAG = FRONT_MATTER_ROLE

export type FrontMatterSignals = {
  /** The tags of the part's running-order line (its role may be passed with them). */
  lineTags?: readonly string[]
  /** The part's manifest `files[].role`, as written. */
  manifestRole?: string
  /** The part's resolved workspace path. */
  path: string
  /** The manifest's `title_matter`, resolved to a workspace path; null or absent when there is none. */
  titleMatterPath?: string | null
}

/** `partIsFrontMatter`, from the signals the heading checks hold. */
export function isFrontMatterPart(signals: FrontMatterSignals): boolean {
  return partIsFrontMatter({
    lineRole: signals.lineTags?.some((tag) => normalised(tag) === FRONT_MATTER_TAG) ? FRONT_MATTER_ROLE : undefined,
    entry: signals.manifestRole === undefined ? null : { role: signals.manifestRole },
    isTitleMatter: typeof signals.titleMatterPath === 'string' && signals.titleMatterPath !== '' && signals.titleMatterPath === signals.path,
  })
}

/** A front-matter part's title facts: the title is frontmatter `title:` only (else the file name, as
 *  `partTitle` falls back with no heading), and nothing about it differs. */
export function asFrontMatterTitle(named: PartTitle, path: string): PartTitle {
  return {
    ...named,
    title: named.frontmatterTitle ?? titleFromFileName(path),
    from: named.frontmatterTitle !== null ? 'frontmatter' : 'file-name',
    mismatch: false,
  }
}

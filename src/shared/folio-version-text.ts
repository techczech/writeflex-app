/**
 * The three-text view of a part both sides changed (ADR-0052 § Decision 1, journey J3; Folio versions ticket 17): the types main answers with,
 * the request the window makes, the words. Pure. Main reads and decides (`main/folio-version-text.ts`); the alignment itself is
 * `shared/folio-version-align.ts`; the window draws (`FolioVersionThreeText.tsx`).
 *
 * WHAT A ROW IS. One stretch of paragraphs of the part, as it was sent, as the co-author wrote it and as it stands now. A row decides itself
 * (`self`) where one side changed it alone (the writer: the result is theirs) or both made the same change. Otherwise the writer decides it:
 *  - "Use theirs" stages the co-author's paragraphs as a suggestion in the part's margin, attributed to the co-author, and the window accepts
 *    it through the one Accept every proposal has: the text is written there, by the same route, with the same checks;
 *  - "Keep mine" leaves the text as it is and is recorded as the writer's decision (nothing is written to the part). Where the co-author's change is
 *    already a suggestion in the margin it is declined there instead, so the margin, the progress and this row always say the same;
 *  - "Edit by hand in Text" stages the co-author's paragraphs as a suggestion that WAITS in the margin (her text and the writer's text on one
 *    card, the part's own text beside it) and opens the part.
 * Nothing is written by looking, and nothing an agent can reach decides a row.
 */
import type { AlignKind, SideChange } from './folio-version-align'

/** The choices of a row the writer decides. */
export type TextChoice = 'theirs' | 'mine' | 'hand'
export const TEXT_CHOICES: readonly TextChoice[] = ['theirs', 'mine', 'hand']

/** What happened to a row. `self`: nothing to decide. `open`: waiting for a choice. `waiting`: her change is a suggestion in the margin, undecided. `accepted`/`declined`: decided through the margin's own Accept or Decline. `kept`: Keep mine, recorded. */
export type TextRowState = 'self' | 'open' | 'waiting' | 'accepted' | 'declined' | 'kept' | 'closed'

export type ThreeTextRow = {
  /** The decision row's key (`text:…`); empty for a `same` row. */
  key: string
  kind: AlignKind
  herChange: SideChange
  yourChange: SideChange
  /** The paragraphs of each text in this row (Markdown, as written). Empty lists for a text that has nothing here. */
  sent: string[]
  hers: string[]
  yours: string[]
  state: TextRowState
  /** The suggestion in the margin that is this row's, when there is one. */
  changeId?: string
  /** Why a suggestion of this row was closed without being applied (the ledger's words). */
  why?: string
}

/** The sha256 of each text as main read it: the decision is made over exactly these, and refused if any has moved. */
export type ThreeTextSeen = { sent: string; hers: string; yours: string }

export type ThreeText = {
  revision: { id: string; name: string; from: string }
  part: { path: string; title: string; position: number | null }
  /** Her section's index and heading. */
  section: { index: number; heading: string }
  /** The rows in the order of the sent text. */
  rows: ThreeTextRow[]
  seen: ThreeTextSeen
  /** The rows that are not `same`, and how many of them are settled. */
  counts: { changed: number; settled: number }
}

export type ThreeTextRead = ThreeText | { unavailable: string }
export const isThreeText = (value: ThreeTextRead | null): value is ThreeText => value !== null && !('unavailable' in value)

export type TextDecideRequest = { dir: string; revision: string; part: string; row: string; choice: TextChoice; seen: ThreeTextSeen }

export type TextRefusalCode =
  | 'bad-request' | 'not-found' | 'withdrawn' | 'stale' | 'already-decided' | 'nothing-to-decide' | 'not-placeable' | 'collection-closed' | 'not-recorded'

export type TextAnswer =
  /** Kept as the writer's own: recorded, nothing written to the part. */
  | { status: 'done'; message: string; text: ThreeText }
  /** The window resolves this suggestion now, through the margin's own route, then reads again. */
  | { status: 'resolve'; changeId: string; path: string; action: 'accept' | 'reject' }
  /** The suggestion waits in the part's margin; the window opens the part. */
  | { status: 'hand'; changeId?: string; path: string; message: string }
  | { status: 'refused'; code: TextRefusalCode; message: string; nothingWritten: boolean; text?: ThreeText }

// ---- Words -------------------------------------------------------------------------------------

export const TEXT_STALE = 'The part, the Word file’s text or the version she started from is not what you were looking at, so nothing was changed. The three texts are shown as they are now; decide again.'
export const TEXT_ALREADY_DECIDED = 'That row has already been decided, so nothing was changed.'
export const TEXT_NOTHING_TO_DECIDE = 'That row decides itself, so there is nothing to choose. Nothing was changed.'
export const TEXT_NOT_FOUND = 'That is not a row of this part’s three texts, so nothing was changed.'
export const TEXT_BAD_REQUEST = 'That request was not understood, so nothing was changed.'

/** What each side did, for the line above a row's buttons. `who` is the co-author's name. */
export function whyLine(row: Pick<ThreeTextRow, 'kind' | 'herChange' | 'yourChange'>, who: string): string {
  switch (row.kind) {
    case 'same': return 'Neither of you changed this.'
    case 'only-mine': return 'Only you changed this paragraph. Kept as yours.'
    case 'both-same': return 'You both made the same change. Nothing to decide.'
    case 'only-hers':
      return row.herChange === 'delete' ? `${who} deleted this paragraph.`
        : row.herChange === 'insert' ? `${who} added a paragraph here.`
        : `${who} changed this paragraph.`
    case 'both-different':
      return row.herChange === 'delete' ? `${who} deleted this paragraph and you changed it.`
        : row.yourChange === 'delete' ? `${who} changed this paragraph and you deleted it.`
        : row.herChange === 'insert' && row.yourChange === 'insert' ? `You both added a paragraph here.`
        : 'You both changed it, in different ways.'
  }
}

/** The labels of the first two buttons of a row the writer decides, by what the co-author did. No pronouns: a co-author's are not known. */
export function choiceLabels(row: Pick<ThreeTextRow, 'herChange' | 'yourChange' | 'kind'>): { theirs: string; mine: string } {
  if (row.kind === 'only-hers') {
    if (row.herChange === 'delete') return { theirs: 'Accept their deletion', mine: 'Keep my paragraph' }
    if (row.herChange === 'insert') return { theirs: 'Accept', mine: 'Reject' }
  }
  return { theirs: 'Use theirs', mine: 'Keep mine' }
}

export const textStateWords: Record<TextRowState, string> = {
  self: 'decided',
  open: 'to decide',
  waiting: 'waiting in the margin',
  accepted: 'their text taken',
  declined: 'kept as yours',
  kept: 'kept as yours',
  closed: 'closed in the margin',
}

export const isSettled = (state: TextRowState): boolean => state === 'self' || state === 'accepted' || state === 'declined' || state === 'kept'

export const KEPT_MESSAGE = 'Kept your text. Nothing in the part was changed.'
export const handMessage = (title: string): string => `Their text is waiting in the margin of “${title}” beside yours. Edit the part by hand, then accept or decline it there.`

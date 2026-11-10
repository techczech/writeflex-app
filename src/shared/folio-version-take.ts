/**
 * Taking one part's text from another Folio version (ADR-0052 § The eight changes 4 and 5, journey J4; Folio versions ticket 09).
 * Pure types, the words and the marker: main stages the take (`main/folio-version-take.ts`), the Versions tab asks for it and
 * says what happened, the margin names where the proposal came from.
 *
 * A take is a PROPOSAL, shown first: it files one change over the whole part in the change ledger and writes no file. The part's
 * text changes only when the writer accepts it in the margin, through the same Accept every proposal has (it saves a restore point of
 * the text first, then writes through the guarded door). Declining or "Undo" on the take takes the proposal back; nothing was ever
 * written.
 */

/** What the ledger record carries beside the shared ledger's fields: which Folio version the text is from. Extra field; older builds pass it through. */
export type FolioTakeFields = { folioTake?: { versionId: string; versionName: string } }

/** The Folio version a change was staged from, or null for any other change. Tolerates any record. */
export function folioTakeOf(change: object): { versionId: string; versionName: string } | null {
  const take = (change as FolioTakeFields).folioTake as unknown
  if (!take || typeof take !== 'object') return null
  const { versionId, versionName } = take as { versionId?: unknown; versionName?: unknown }
  return typeof versionId === 'string' && versionId !== '' && typeof versionName === 'string' && versionName !== '' ? { versionId, versionName } : null
}

/** Why a take was not staged. */
export type FolioTakeRefusal =
  /** The part has text typed in the editor that is not saved, or a notice about the file changing on disk is open. */
  | 'unsaved'
  /** The part changed since the comparison was drawn. */
  | 'changed'
  /** Writer changes to the part wait in the margin and would be overwritten. */
  | 'writer-changes'
  /** A take of this part is already waiting. */
  | 'waiting'
  /** The two texts are the same. */
  | 'same'
  | 'unreadable'
  | 'too-large'
  /** The working part is empty: a change over the whole of it cannot be drawn beside nothing. */
  | 'empty'
  /** Not a part that both sides have, or not a comparison of a version with the working draft. */
  | 'not-a-take'
  /** "Take that text, keep mine in Scratchpad" (ticket 10): the writer's current text could not be kept first, so nothing was taken. */
  | 'keep-failed'
  /** "Keep mine" copied the text to the Scratchpad, staging the take then failed, and the unused copy could not be withdrawn either: the copy is still there (`keptItemId`). */
  | 'stage-failed'

export type FolioTakeInput = {
  dir: string
  /** The two ends of the comparison as drawn: a Folio version id and `working`, in either order. */
  from: string
  to: string
  /** The line's key in that comparison. */
  key: string
  /** The fingerprint of the working part when the comparison was drawn (`FolioCompareEntry.workingSha256`). */
  expected: string
  /** "Take that text, keep mine in Scratchpad" (ticket 10): the text being replaced is sent to the Scratchpad first, and only then is the take staged. */
  keepMine?: true
}

export type FolioTakeResult =
  | { ok: true; changeId: string; path: string; title: string; versionName: string; /** The Scratchpad item that now holds the replaced text (only for "keep mine"); Undo withdraws it. */ keptItemId?: string }
  | { ok: false; reason: FolioTakeRefusal; message: string; /** Only for `stage-failed`: the Scratchpad card that was left behind, so the window can offer to remove it. */ keptItemId?: string }

/** What "Undo" on a staged take asked of main (`folio-versions:undo-take`): the change the take filed, and the Scratchpad card "keep mine" made, if any. */
export type FolioUndoTakeInput = { dir: string; changeId: string; keptItemId?: string }

/** Undo of a staged take. `ok`: the take is no longer waiting (declined now, or already declined or closed); `cardWithdrawn` says whether the kept copy is gone (`null`: there was none). Refused: nothing was changed. */
export type FolioUndoTakeResult =
  | { ok: true; cardWithdrawn: boolean | null; message: string }
  | { ok: false; reason: 'accepted' | 'not-a-take' | 'failed'; message: string }

/** The sentence for each refusal. Plain words, one thing said. */
export function takeRefusalText(reason: FolioTakeRefusal, title: string, versionName?: string): string {
  switch (reason) {
    case 'unsaved': return `“${title}” has text you have typed that is not saved yet. Save it or undo it, then take the other text.`
    case 'changed': return `“${title}” has changed since this comparison was drawn. Nothing was taken. The comparison has been read again; look at it and take the text if it is still what you want.`
    case 'writer-changes': return `“${title}” has changes of yours still waiting in the margin, and taking the other text would overwrite them. Accept or decline them first.`
    case 'waiting': return `A take of “${title}” is already waiting in its margin. Accept or decline it there first.`
    case 'same': return `“${title}” already reads the same as ${versionName ? `“${versionName}”` : 'that version'}. There is nothing to take.`
    case 'empty': return `“${title}” is empty, so the other text cannot be shown beside it for review. Open the part and paste the text in.`
    case 'too-large': return `“${title}” is too large to be shown for review as one change. Nothing was taken.`
    case 'unreadable': return `The text of “${title}” could not be read on one side. Nothing was taken.`
    case 'not-a-take': return 'Only a part that changed between a saved version and the working draft can be taken. Nothing was taken.'
    case 'stage-failed': return `“${title}” could not be taken, so the part was not changed. Your current text had been copied to the Scratchpad first, and that copy is still there. Remove it from the Scratchpad if you do not want it.`
    case 'keep-failed': return `Your current text of “${title}” could not be kept in the Scratchpad, so nothing was taken. ${versionName ?? ''}`.trim()
  }
}

/** The one-line summary the ledger record and the margin carry. */
export function takeSummary(versionName: string, title: string): string {
  return `Take “${title}” as it was in “${versionName.slice(0, 120)}”`
}

/** What the line says once the take is staged with the writer's own text kept in the Scratchpad first. */
export function stagedKeptText(title: string, versionName: string): string {
  return `Your text of “${title}” is in the Scratchpad. The text from “${versionName}” is waiting in the margin of “${title}”. Nothing is written until you accept it there.`
}

/** What the line says once the take is staged. */
export function stagedText(title: string, versionName: string): string {
  return `The text from “${versionName}” is waiting in the margin of “${title}”. Nothing is written until you accept it there.`
}

/** Undo refused because the take was accepted (in another window, or in the margin) before this Undo reached main. Nothing was changed. */
export const UNDO_TAKE_ACCEPTED = 'That take was already accepted in the part’s margin, so it can no longer be taken back from here. Nothing was changed. To go back, press ⌘Z in the part or restore the text kept before accepting.'
export const UNDO_TAKE_NOT_THERE = 'That take is not waiting any more, so there is nothing to take back. Nothing was changed.'
export const UNDO_TAKE_DONE = 'Taken back. The part was not changed.'
export const UNDO_TAKE_DONE_CARD = 'Taken back, and the copy of your text removed from the Scratchpad. The part was not changed.'
export const UNDO_TAKE_DONE_CARD_KEPT = 'Taken back. The part was not changed. The copy of your text stays in the Scratchpad.'

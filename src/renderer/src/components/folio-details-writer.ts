import { isSectionExportField, type FolioSectionExportField } from '../../../shared/folio-sections'
type WriteField = FolioDetailField | FolioSectionExportField
/**
 * The Details card's writes for one Folio, in order (0.26, Sol round 2 finding 2). Every change, Undo and re-read is
 * one turn of a queue: a change made while another is still being saved waits for it and is then sent, over the Index
 * Note text the earlier change left; none is ever dropped. Each turn's basis is the text the card last saw (the last
 * answer's or the last read's), never one read behind the writer's back.
 *
 * A change is only ever written over text the card was showing when it was made (Sol round 3). When a read shows text
 * the queue did not write (another editor changed the Index Note: a `disk-changed` refusal, or a read after a write
 * that finds more than that write), every change queued before that read is dropped, not sent over the new text, and
 * the card says so (`FOLIO_DETAILS_CHANGED_ELSEWHERE`).
 *
 * No React here: the card (FolioDetailsCard.tsx) holds one writer per Folio and shows what it reports. A writer
 * whose Folio the card has left (`detach`) still finishes what was queued, into its own Folio, and reports nothing to
 * the card; a change it could not save is still said, through the app's status line (`elsewhere`), naming the Folio.
 */
import {
  FOLIO_DETAIL_LABEL,
  type FolioDetailAnswer,
  type FolioDetailField,
  type FolioDetailUndoAnswer,
  type FolioDetailsRead,
  normaliseFolioDetailValue,
} from '../../../shared/folio-details'

/** Said when changes were not saved because the Index Note changed elsewhere (they are dropped, not rebased). */
export const FOLIO_DETAILS_CHANGED_ELSEWHERE = 'The Index Note changed elsewhere, so your last changes were not saved. Make them again.'

/** The same, said in the app's status line once the card has left the Folio (Sol round 4). */
export const folioDetailsChangedElsewhereAway = (folio: string): string =>
  `The Index Note of “${folio}” changed elsewhere, so your last changes there were not saved. Make them again.`

/**
 * Whether choosing or typing `value` for a field changes nothing: compared with the value the queue will leave when a
 * change to the field is still queued or being saved (`queued`, from `FolioDetailsWriter.queued`), else with what the
 * card shows (`shown`). So choosing "ready" and then "draft" again while "ready" is saving writes "draft".
 */
export function folioDetailUnchanged(value: string | null, queued: string | null | undefined, shown: string | null): boolean {
  return normaliseFolioDetailValue(value) === normaliseFolioDetailValue(queued === undefined ? shown : queued)
}

export type FolioDetailsApi = {
  read: (dir: string) => Promise<FolioDetailsRead>
  set: (dir: string, field: WriteField, value: string | null, basis: string) => Promise<FolioDetailAnswer>
  undo: (dir: string, token: string) => Promise<FolioDetailUndoAnswer>
}

/** One request run after the Folio's open buffers are saved (or straight away); a refusal comes back as a sentence. */
export type FolioDetailsThrough = <T>(call: () => Promise<T>) => Promise<{ ok: true; value: T } | { ok: false; message: string }>

export type FolioDetailsReport = {
  /** A fresh read of the Folio (what the card shows). */
  read: (read: FolioDetailsRead) => void
  /** A sentence for the card, or null to clear it. */
  message: (message: string | null) => void
  /** The changes queued or being saved, field by field, with the value each is saving (the last one asked for). */
  pending: (pending: ReadonlyMap<WriteField, string | null>) => void
  /** After `detach`: a sentence for the app's status line, for a change that was not saved (never dropped silently). */
  elsewhere?: (message: string) => void
}

const UNREADABLE: FolioDetailsRead = { ok: false, refused: 'unwritable', message: 'WriteFlex could not read this Folio’s details.' }

export class FolioDetailsWriter {
  /** The Index Note text the card last saw: the basis of the next change. Null until read. */
  #basis: string | null = null
  #tokens: string[] = []
  #chain: Promise<unknown> = Promise.resolve()
  #pending: Array<{ field: WriteField; value: string | null }> = []
  /** Bumped by every read that shows text the queue did not leave; a change made before the bump is not sent. */
  #shown = 0
  #detached = false
  /** The Folio as the user knows it, for a sentence said after the card has left it: its title, else its folder. */
  #name: string

  constructor(
    readonly dir: string,
    private readonly api: FolioDetailsApi,
    private readonly through: FolioDetailsThrough,
    private readonly report: FolioDetailsReport,
  ) {
    this.#name = dir.split('/').filter(Boolean).at(-1) ?? dir
  }

  /** Stop reporting into the card (it has left this Folio). What is queued still runs. */
  detach(): void {
    this.#detached = true
  }

  /** Run `task` after every turn queued before it, whatever they answered. */
  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const turn = this.#chain.then(task, task)
    this.#chain = turn.catch(() => undefined)
    return turn
  }

  #say(message: string | null): void {
    if (!this.#detached) { this.report.message(message); return }
    // The card has left this Folio: a change that was not saved is said in the app's status line, naming the Folio.
    if (message === null) return
    this.report.elsewhere?.(message === FOLIO_DETAILS_CHANGED_ELSEWHERE ? folioDetailsChangedElsewhereAway(this.#name) : `${this.#name}: ${message}`)
  }

  #showPending(): void {
    if (this.#detached) return
    const map = new Map<WriteField, string | null>()
    for (const entry of this.#pending) map.set(entry.field, entry.value)
    this.report.pending(map)
  }

  async #readNow(): Promise<FolioDetailsRead> {
    let next: FolioDetailsRead
    try { next = await this.api.read(this.dir) } catch { next = UNREADABLE }
    const text = next.ok ? next.text : null
    const title = next.ok ? next.fields?.title?.value?.trim() : undefined
    // Named as the card last showed it: kept once the card has left, so the sentence names the Folio the user saw.
    if (title && !this.#detached) this.#name = title
    if (text === null || text !== this.#basis) this.#shown += 1
    this.#basis = text
    if (!this.#detached) this.report.read(next)
    return next
  }

  /** Read the Folio again, in its turn (after any change queued before it). */
  reload(): Promise<FolioDetailsRead> {
    return this.#enqueue(() => this.#readNow())
  }

  /** The value the queue will leave for `field` (the last change asked for), or undefined when none is queued. */
  queued(field: WriteField): string | null | undefined {
    for (let i = this.#pending.length - 1; i >= 0; i -= 1) if (this.#pending[i].field === field) return this.#pending[i].value
    return undefined
  }

  /**
   * Write `field` (null removes it), in its turn, over the text the card last saw. Resolves true when it was
   * written (or already held), false when refused; the refusal is said in the card.
   */
  set(field: WriteField, value: string | null): Promise<boolean> {
    const entry = { field, value }
    const shownAt = this.#shown
    this.#pending.push(entry)
    this.#showPending()
    return this.#enqueue(async () => {
      try {
        const basis = this.#basis
        if (basis === null) { this.#say('WriteFlex has not read this Folio’s details yet, so nothing was changed.'); return false }
        // The card has shown other text since this change was made: dropped, never sent over text the user did not see.
        if (shownAt !== this.#shown) { this.#say(FOLIO_DETAILS_CHANGED_ELSEWHERE); return false }
        const sent = await this.through(() => this.api.set(this.dir, field, value, basis))
        if (!sent.ok) { this.#say(sent.message); return false }
        const answer = sent.value
        if (answer.ok) {
          this.#basis = answer.text
          if (answer.undoToken) this.#tokens.push(answer.undoToken)
          this.#say(null)
          await this.#readNow()
          return true
        }
        if (answer.refused === 'disk-changed') {
          // The re-read shows the other editor's text and drops every change queued behind this one.
          this.#say(FOLIO_DETAILS_CHANGED_ELSEWHERE)
          await this.#readNow()
          return false
        }
        this.#say(answer.message)
        return false
      } catch {
        this.#say(`Could not save the ${(isSectionExportField(field) ? field : FOLIO_DETAIL_LABEL[field]).toLocaleLowerCase()}. Nothing was changed.`)
        return false
      } finally {
        this.#pending.splice(this.#pending.indexOf(entry), 1)
        this.#showPending()
      }
    })
  }

  /** Undo the card's last change, in its turn (so a change still being saved is the one undone). */
  undo(): Promise<void> {
    return this.#enqueue(async () => {
      const token = this.#tokens.at(-1)
      if (!token) { this.#say('There is no change in the Details to undo.'); return }
      try {
        const sent = await this.through(() => this.api.undo(this.dir, token))
        if (!sent.ok) { this.#say(sent.message); return }
        this.#tokens.pop()
        // The text the Undo left is the card's own: changes queued after the Undo are sent over it.
        if (sent.value.ok) this.#basis = sent.value.text
        this.#say(sent.value.ok ? null : sent.value.message)
        await this.#readNow()
      } catch {
        this.#say('Could not undo that change. Nothing was changed.')
      }
    })
  }
}

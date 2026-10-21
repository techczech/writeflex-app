/**
 * Who has a request: the app, or the command that may still take it back.
 *
 * A request waits in the inbox as `<id>.json`. BEFORE THE APP READS IT, the app renames it to
 * `<id>.json.taken` in the same folder (cli/request-format.ts). A rename of one name is a thing only
 * one caller can win, and `writeflex withdraw` takes a request back by removing `<id>.json`, so:
 *  - the app's rename won: the request is the app's. `withdraw` finds nothing to remove at
 *    `<id>.json`, sees the claimed name, and says the request is being added and must be rejected in
 *    WriteFlex. It never says "will not be shown" for a request the app has read;
 *  - `withdraw`'s removal won: the app's rename finds nothing, and the request is never read.
 *
 * NO REQUEST STAYS CLAIMED PAST THE LOOK THAT CLAIMED IT. A look either settles a request (answers it
 * and removes its file, under either name) or leaves it for a later look, and what it leaves is given
 * its own name back when the look ends (`giveBack`), so `withdraw` works on it again.
 *
 * WHEN THE APP STOPS WITH A REQUEST CLAIMED, the file stays as `<id>.json.taken`. The next look (this
 * app started again, or the other variant) lists it like any request and takes it up from that name.
 * Whether it was already acted on is not read from the file or its name: the receipt in application
 * data decides (request-executor.ts), so it is acted on at most once. A claimed file is never left
 * unread: every look that lists it either settles it or gives its name back.
 *
 * `waiting` lists a claimed request as being added (cli/review-waiting.ts).
 */
import type { CappedRead, HeldFolder } from './cli/request-files'
import { claimedFileName, requestFileName } from './cli/request-format'

export class InboxClaims {
  /** Requests under their claimed name, as far as this look knows, and not yet settled. */
  readonly #held = new Set<string>()
  /** Requests this look has settled: what may still stand at their names is not a request any more. */
  readonly #settled = new Set<string>()

  constructor(private readonly inbox: HeldFolder) {}

  /** The listing showed `<id>.json.taken`: left by an earlier look or an app that stopped. Unless
   *  this look settles the request, the name is given back at its end, so that a request standing
   *  under both names (the app stopped, and sync delivered it again) is one file again. */
  found(id: string): void {
    if (!this.#settled.has(id)) this.#held.add(id)
  }

  /** What stands for this request, under either name, without following a link; null when nothing does. */
  async look(id: string): ReturnType<HeldFolder['look']> {
    return (await this.inbox.look(requestFileName(id))) ?? this.inbox.look(claimedFileName(id))
  }

  /**
   * Claim the request, then read it from its claimed name. `not-claimable` when the rename was
   * refused (something that is not a file stands at the claimed name): the request was not read.
   * `missing` when it is under neither name (withdrawn, or cleared by another look).
   */
  async take(id: string, maxBytes: number): Promise<CappedRead | { kind: 'not-claimable' }> {
    // `missing` here may only mean it is claimed already; the read from the claimed name says.
    if (await this.inbox.rename(requestFileName(id), claimedFileName(id)) === 'failed') return { kind: 'not-claimable' }
    this.#held.add(id)
    const read = await this.inbox.read(claimedFileName(id), maxBytes)
    if (read.kind === 'missing') this.#held.delete(id)
    return read
  }

  /** The request is answered or added: its file goes, under both names. */
  async settle(id: string): Promise<void> {
    this.#held.delete(id)
    this.#settled.add(id)
    await this.inbox.remove(claimedFileName(id))
    await this.inbox.remove(requestFileName(id))
  }

  /** The look is over: every request still claimed is left for a later look under its own name. */
  async giveBack(): Promise<void> {
    for (const id of this.#held) await this.inbox.rename(claimedFileName(id), requestFileName(id)).catch(() => 'failed')
    this.#held.clear()
  }
}

// The Sharing page's IPC (sharing ticket 03). The decisions are the publisher's (sharing-publisher.ts);
// this file routes and checks what a window sends.
//
// The boundary (adviser ruling, round 3, A). The sharing page's threat model is the app's: the
// renderer is trusted with the Workspace it was given; main is the boundary for WHICH Workspace, WHICH
// kind of file, and secrets. What main enforces here:
//   - the window's own Workspace: a path outside it is refused;
//   - the writer's piece: a Markdown file the sidebar would show (document-path.ts, the one document
//     rule), so nothing in a dot-folder (`.writeflex`, where versions live; `.bridle`; `.git`) or in
//     `agent-notes`; `sharing:piece` only reads (the title-bar mark), under the same rule;
//   - a Folio (ticket 09): a folder in the window's Workspace, no dot-folder or `agent-notes` on the
//     way, that is a Folio by the app's own rule (sharing-folio.ts isFolio: a manifest, or an Index
//     Note that declares a running order); `sharing:folio` only reads (the title-bar mark);
//   - links whose source went away (review round 1, finding 4): a folder that is no longer a Folio, or
//     a file that is no longer a writer's piece, can still be opened while it has links, for Turn off,
//     Copy link and Open only; making, renaming, republishing and turning on need a valid source;
//   - other links on the page (review round 1, findings 3 and 4): a Folio's page opened from a part
//     also binds that part's own piece links, and a piece's or Folio's page the links of any folder above
//     it that is no longer a Folio, for Turn off, Copy link and Open only, so every live link stays reachable;
//   - one piece (or Folio) per window per page: main keeps, per window, the piece its Sharing page has open
//     (`sharing:open`, cleared by `sharing:close` or when the window's Workspace changes); making a
//     link needs that piece, and every link action must name a link of that piece;
//   - no answer carries a token or a key (every answer is a PieceSharingView, or a link's address);
//   - a link's address is decided when it is asked for (`sharing:copy-address`, `sharing:open-link`):
//     the publisher's view at that moment, which takes it from linksAddressNow (sharing-own-address.ts
//     THE RULE). Copy link copies that answer, never the window's last view (review round 3).
//   - the Shares list (ticket 10): `sharing:open-list` lists the links made in the window's own
//     Workspace (the publisher's records with that root, nothing the window names) and binds exactly
//     those to the window, in place of a piece. On the list, every listed link can be turned off, copied
//     and opened; turning on, Readers can leave notes and renaming need its source still to be a piece
//     or a Folio, as on its own page; no link is made from the list. On the list and on a page, that
//     check is made again at the moment of the action (ticket 10 review round 1, P2-1): a source deleted,
//     moved or no longer a Folio since the read refuses, as the gone case does. `sharing:opened` asks the service
//     how many times the window's bound links were opened (the page's or the list's), and no others.
//   - "Follow to" (ticket 04, ruling R-B): a link whose piece is not found, the page's or the list's (as
//     Turn off), follows to the place MAIN found holding the same file (the publisher's `followTo`); the
//     window names only the link, never a path.
// The per-window binding is a CORRECTNESS guard: a stale request, a race or a wrong tab cannot act on
// another piece's link (review round 1, finding 8). It is NOT a defence against a hostile renderer and
// must not be described as one: the piece in `sharing:open` is the renderer's choice, as the open
// document is everywhere in this app (main keeps no record of what a window has open), and a renderer
// that could lie here can already read any file in its Workspace (`file:read`) and send it anywhere.
// A renderer-hostile boundary for the Workspace would be its own change across the whole IPC surface.
//
// No Electron import: index.ts passes `ipcMain`, the test for WriteFlex's own windows, the sending
// window's Workspace root, and `shell.openExternal`.
import { basename, resolve } from 'node:path'
import { isEligiblePiece, isFileOnDisk, isSharablePiece, piecePath } from './sharing-source-eligibility'
import { folioDirPath, isFolio } from './sharing-folio'
import type { SharingPublisher } from './sharing-publisher'
import { LINK_UNKNOWN, NO_PIECE, type OtherLinks, type PieceSharingView, type ShareKind, type SharingLinkResult } from '../shared/sharing-links'
import type { ShareListEntry, SharesListView } from '../shared/sharing-shares-list'
import { LIMITS_NOT_HERE, LIMITS_OFFLINE, LIMITS_OLD_SERVICE, RAISE_AT_MOST, clearedMessage, raisedMessage, type LimitsActionResult, type NotesCounts } from '../shared/sharing-notes'
import { checkedLimits, limitReachedOf } from './sharing-reader-notes'
import { limitsFor, readerLinksChanged, refusedFor, setLimitsFor } from './sharing-reader-notes-run'

type Registrar = { handle: (channel: string, listener: (event: { sender: { id: number } }, input?: unknown) => unknown) => void }

export const SHARING_PIECE_CHANNELS = [
  'sharing:piece', 'sharing:open', 'sharing:folio', 'sharing:open-folio', 'sharing:close', 'sharing:make', 'sharing:rename', 'sharing:set-comments', 'sharing:turn-off', 'sharing:follow-to', 'sharing:turn-on', 'sharing:retry', 'sharing:open-link', 'sharing:copy-address',
  'sharing:open-list', 'sharing:opened', 'sharing:notes', 'sharing:clear-handled', 'sharing:raise-limit',
] as const

export type SharingPieceIpcOptions = {
  isAppWindow: (senderId: number) => boolean
  /** The Workspace root open in the sending window, or null. */
  rootFor: (senderId: number) => string | null
  openExternal: (url: string) => void
  /**
   * Ticket 07: the readers' notes and proposed edits in the review list of the sending window's
   * Collection (its ledger): each one's link, its key on the service, and whether it is decided
   * (settled). Null when that list cannot be read. Absent: no counts, nothing to clear.
   */
  readerNotes?: (senderId: number) => Promise<Array<{ shareId: string; key: string; settled: boolean }> | null>
  /**
   * Clear handled notes went through (review round 1 of ticket 11, F1): these notes of the link are no
   * longer on its service. The sending window's review list marks their records so, and keeps the
   * link's closed records within its bound (`ChangeStore.markReaderNotesGone`). Absent: nothing marked.
   */
  readerNotesGone?: (senderId: number, shareId: string, keys: readonly string[]) => Promise<unknown>
}

// The source rule (piecePath, isSharablePiece, isFileOnDisk) lives in sharing-source-eligibility.ts, shared
// with the publisher's boundary and a Folio's parts (Sol review round 3 of ticket 11, P1).
export { piecePath, isSharablePiece } from './sharing-source-eligibility'

/** A link's source is still there: a writer's piece on disk, or a Folio (the Shares list's own rule for gone). */
async function sourceStillThere(root: string, path: string, kind: ShareKind): Promise<boolean> {
  if (kind === 'folio') return isFolio(root, path)
  return isEligiblePiece(root, path)
}

const EMPTY: PieceSharingView = { ready: false, address: null, links: [], mark: { kind: 'share' } }

/**
 * What a window's Sharing page is bound to. `path`/`kind`: the piece or Folio the page is for; every
 * link action may name its links. `manageOnly`: its source went away (a folder that is no longer a
 * Folio, a file no longer a writer's piece) but it still has links: they can be turned off, copied and
 * opened, never made, renamed, republished or turned on (review round 1, finding 4). `also`: links of
 * another kind on the same file or folder, shown on the page for the same three actions only (review
 * round 1, findings 3 and 4; round 2): a part's own piece links on its Folio's page, and on a piece's or
 * a Folio's page the links of a folder above it that is no longer a Folio.
 */
type Binding = { root: string; path: string; kind: ShareKind; manageOnly: boolean; also: { path: string; kind: ShareKind }[]; list?: ListBinding; notFound?: boolean }
/** The Shares list's binding (ticket 10): the links listed, and those whose source went away (manage only). */
type ListBinding = { ids: ReadonlySet<string>; gone: ReadonlySet<string>; view: SharesListView }

export function registerSharingPieceIpc(ipc: Registrar, publisher: SharingPublisher, options: SharingPieceIpcOptions): void {
  /** The piece each window's Sharing page has open: the only piece that window may act on. */
  const open = new Map<number, Binding>()

  const handle = (channel: (typeof SHARING_PIECE_CHANNELS)[number], listener: (senderId: number, input?: unknown) => unknown): void => {
    ipc.handle(channel, (event, input) => {
      if (!options.isAppWindow(event.sender.id)) throw new Error('Not a WriteFlex window.')
      return listener(event.sender.id, input)
    })
  }
  /** The records of the piece or Folio at `path` in `root`. */
  const recordsOf = (root: string, path: string, kind: ShareKind) => publisher.records()
    .filter((record) => record.kind === kind && record.root === root && resolve(record.root, record.path) === resolve(root, path))
  /** Folders above `path` (its own folder first, the Workspace '' last) that hold Folio links but are no longer a Folio. */
  const formerFolios = async (root: string, path: string): Promise<{ path: string; kind: ShareKind }[]> => {
    const dirs = [...new Set(publisher.records()
      .filter((record) => record.kind === 'folio' && record.root === root && (record.path === '' || path.startsWith(`${record.path}/`)))
      .map((record) => record.path))]
    const gone: { path: string; kind: ShareKind }[] = []
    for (const dir of dirs.sort((a, b) => b.length - a.length)) if (!(await isFolio(root, dir))) gone.push({ path: dir, kind: 'folio' })
    return gone
  }
  /**
   * A piece the window names, in its own Workspace: a writer's piece, or a file that is no longer one but
   * still has links (manage only). Null otherwise. Folders above it that are no longer a Folio come too.
   */
  const pieceOf = async (senderId: number, input: unknown): Promise<Binding | null> => {
    const root = options.rootFor(senderId)
    const path = piecePath(input)
    if (!root || !path) return null
    const sharable = isSharablePiece(root, path)
    const linked = recordsOf(root, path, 'piece').length > 0
    if (!sharable && !linked) return null
    // Its links' file no longer on disk (ticket 11, review 10 note): the view is manage only, as on the
    // Shares list, so the page offers no Turn on and says the piece is not found. The binding is not
    // narrowed by it (review round 1 of ticket 11, F2): whether the file is there is checked when the
    // writer acts (`actionLink`, `sharing:make`), so a page opened while it was missing may turn a link
    // on once the file is back at its path (ticket 04 R-C: the same path is the same piece).
    const notFound = linked && !isFileOnDisk(root, path)
    const also = await formerFolios(root, path)
    // The Workspace may have changed while the Folios were read.
    return options.rootFor(senderId) === root ? { root, path, kind: 'piece', manageOnly: !sharable, also, ...(notFound ? { notFound } : {}) } : null
  }
  /**
   * A Folio the window names (its folder; `{ dir, part }` with the part open), in its own Workspace: a
   * Folio, or a folder that is no longer one but still has Folio links (manage only). The part's own
   * piece links come too, and the links of any folder above it that is no longer a Folio. Null otherwise.
   */
  const folioOf = async (senderId: number, input: unknown): Promise<Binding | null> => {
    const root = options.rootFor(senderId)
    const named = input !== null && typeof input === 'object' ? input as { dir?: unknown; part?: unknown } : { dir: input }
    const dir = folioDirPath(named.dir)
    if (!root || dir === null) return null
    const folio = await isFolio(root, dir)
    if (!folio && recordsOf(root, dir, 'folio').length === 0) return null
    const part = named.part === undefined ? null : piecePath(named.part)
    const partLinks = part && (dir === '' || part.startsWith(`${dir}/`)) && recordsOf(root, part, 'piece').length > 0 ? [{ path: part, kind: 'piece' as const }] : []
    // Folders above this one that are no longer a Folio (review round 2): every file below them may open
    // this Folio's page, so their links are listed here too. Never the Folio's own folder (at the
    // Workspace root, formerFolios also names '' itself).
    const also = [...partLinks, ...(await formerFolios(root, dir)).filter((other) => other.path !== dir)]
    // The Workspace may have changed while the Folio was read.
    return options.rootFor(senderId) === root ? { root, path: dir, kind: 'folio', manageOnly: !folio, also } : null
  }
  /** The page's view: the publisher's, with the other links the page shows (`also`). */
  const viewOf = (binding: Binding): PieceSharingView => {
    const view = publisher.view(binding.root, binding.path, binding.kind)
    const otherLinks: OtherLinks[] = binding.also
      .map((other) => ({ kind: other.kind, path: other.path, links: publisher.view(binding.root, other.path, other.kind).links }))
      .filter((group) => group.links.length > 0)
    return { ...view, ...(binding.manageOnly || binding.notFound ? { sourceGone: true } : {}), ...(binding.notFound ? { pieceNotFound: true } : {}), ...(otherLinks.length > 0 ? { otherLinks } : {}) }
  }
  /** The window's open piece, while its Workspace is still the one it was opened in. */
  const openPiece = (senderId: number): Binding | null => {
    const piece = open.get(senderId)
    if (!piece) return null
    if (options.rootFor(senderId) !== piece.root) { open.delete(senderId); return null }
    return piece
  }
  /**
   * The link named, if the window's Sharing page may act on it: a link of the piece it has open (not
   * when that piece's source went away), or, for `manage` (turn off, copy, open), any link the page shows.
   * Read from the binding only; `actionLink` adds the check of the source at the moment of the action.
   */
  const ownLink = (senderId: number, input: unknown, manage = false): { shareId: string } | null => {
    const piece = openPiece(senderId)
    const shareId = (input as { shareId?: unknown } | null)?.shareId ?? input
    if (!piece || typeof shareId !== 'string') return null
    const record = publisher.records().find((entry) => entry.shareId === shareId)
    if (!record || record.root !== piece.root) return null
    // The Shares list: a listed link; manage only when its source went away.
    if (piece.list) return piece.list.ids.has(record.shareId) && (manage || !piece.list.gone.has(record.shareId)) ? { shareId: record.shareId } : null
    const of = (path: string, kind: ShareKind): boolean => record.kind === kind && resolve(record.root, record.path) === resolve(piece.root, path)
    if (of(piece.path, piece.kind)) return manage || !piece.manageOnly ? { shareId: record.shareId } : null
    return manage && piece.also.some((other) => of(other.path, other.kind)) ? { shareId: record.shareId } : null
  }
  /**
   * A link to turn on, rename, change notes on or retry (review round 1 of ticket 10, P2-1): `ownLink`,
   * and its source still a writer's piece on disk or still a Folio, checked now, not when the page or
   * the list was read (a file deleted or moved, a manifest removed since). Refused as the gone case is.
   */
  const actionLink = async (senderId: number, input: unknown): Promise<{ shareId: string } | null> => {
    const link = ownLink(senderId, input)
    if (!link) return null
    const record = publisher.records().find((entry) => entry.shareId === link.shareId)
    if (!record || !(await sourceStillThere(record.root, record.path, record.kind))) return null
    // The binding may have changed while the source was read.
    return ownLink(senderId, input)?.shareId === link.shareId ? link : null
  }
  const unknownLink = (): SharingLinkResult => ({ ok: false, view: EMPTY, problem: LINK_UNKNOWN })
  const orUnknown = async (result: Promise<SharingLinkResult | null>): Promise<SharingLinkResult> => (await result) ?? unknownLink()

  handle('sharing:piece', async (senderId, input) => {
    const piece = await pieceOf(senderId, input)
    return piece ? viewOf(piece) : EMPTY
  })
  /** A `sharing:open` or `sharing:open-folio` still reading, per window: a later open or close supersedes it. */
  const pendingOpen = new Map<number, symbol>()
  const bindAs = async <T>(senderId: number, read: () => Promise<Binding | null>, answer: (binding: Binding) => T, empty: T): Promise<T> => {
    // Asked again before the answer: the later request wins (an earlier one still on its way changes nothing).
    const asked = Symbol('open')
    pendingOpen.set(senderId, asked)
    const binding = await read()
    if (pendingOpen.get(senderId) !== asked) return empty
    pendingOpen.delete(senderId)
    if (!binding) { open.delete(senderId); return empty }
    open.set(senderId, binding)
    return answer(binding)
  }
  const bind = (senderId: number, read: () => Promise<Binding | null>): Promise<PieceSharingView> => bindAs(senderId, read, viewOf, EMPTY)
  handle('sharing:open', (senderId, input) => bind(senderId, () => pieceOf(senderId, input)))
  handle('sharing:folio', async (senderId, input) => {
    const folio = await folioOf(senderId, input)
    return folio ? viewOf(folio) : EMPTY
  })
  handle('sharing:open-folio', (senderId, input) => bind(senderId, () => folioOf(senderId, input)))
  handle('sharing:close', (senderId) => { open.delete(senderId); pendingOpen.delete(senderId); return true })
  handle('sharing:make', async (senderId, input) => {
    const piece = openPiece(senderId)
    const request = input as { path?: unknown; folio?: unknown; name?: unknown; comments?: unknown } | null
    // The piece (or Folio) is main's; what the window sends must name that same one.
    const named = piece?.kind === 'folio' ? (request?.path === undefined ? folioDirPath(request?.folio) : null) : (request?.folio === undefined ? piecePath(request?.path) : null)
    // A folder that is no longer a Folio, a file no longer a piece: its links can be turned off, never added to.
    if (!piece || piece.list || piece.manageOnly || named !== piece.path) return { ok: false, view: EMPTY, problem: NO_PIECE } satisfies SharingLinkResult
    // Opened while its file was missing: a new link only once a writer's piece is back at its path,
    // checked now by the rule the binding would have applied had it been there at open (review round 2
    // of ticket 11, P1): on disk, and a sharable piece where it really lives, links resolved, so a link
    // (symlink) put at the path to a hidden or support file, or out of the Collection, is refused.
    if (piece.notFound) {
      if (!(await sourceStillThere(piece.root, piece.path, piece.kind))) return { ok: false, view: EMPTY, problem: NO_PIECE } satisfies SharingLinkResult
      // The binding may have changed while the source was read.
      if (openPiece(senderId) !== piece) return { ok: false, view: EMPTY, problem: NO_PIECE } satisfies SharingLinkResult
    }
    return publisher.make(piece.root, piece.path, { name: request?.name, comments: request?.comments }, piece.kind)
  })
  handle('sharing:rename', async (senderId, input) => {
    const link = await actionLink(senderId, input)
    return link ? orUnknown(publisher.rename(link.shareId, (input as { name?: unknown }).name)) : unknownLink()
  })
  handle('sharing:set-comments', async (senderId, input) => {
    const link = await actionLink(senderId, input)
    if (!link) return unknownLink()
    const comments = (input as { comments?: unknown }).comments
    const result = await orUnknown(publisher.setComments(link.shareId, comments))
    // Turn comments off (the Limits panel's third action, or the switch): what was refused so far is seen.
    if (result.ok && comments !== true) acknowledge(link.shareId)
    return result
  })
  handle('sharing:turn-off', (senderId, input) => {
    const link = ownLink(senderId, input, true)
    return link ? orUnknown(publisher.turnOff(link.shareId)) : unknownLink()
  })
  // Ticket 04 (R-B): the window names the link; the place is the one main found, checked again by the publisher.
  handle('sharing:follow-to', (senderId, input) => {
    const link = ownLink(senderId, input, true)
    return link ? orUnknown(publisher.followTo(link.shareId)) : unknownLink()
  })
  handle('sharing:turn-on', async (senderId, input) => {
    const link = await actionLink(senderId, input)
    return link ? orUnknown(publisher.turnOn(link.shareId)) : unknownLink()
  })
  handle('sharing:retry', async (senderId, input) => {
    const link = await actionLink(senderId, input)
    return link ? orUnknown(publisher.retry(link.shareId)) : unknownLink()
  })
  /** The address a link of the window's open piece has now (THE RULE, applied at this moment); null otherwise. */
  const addressNow = (senderId: number, input: unknown): string | null => {
    const link = ownLink(senderId, input, true)
    if (!link) return null
    const record = publisher.records().find((entry) => entry.shareId === link.shareId)!
    const address = publisher.view(record.root, record.path, record.kind).links.find((entry) => entry.shareId === link.shareId)?.address
    return address && /^https:\/\//.test(address) ? address : null
  }
  // Opens only a link this Mac made, at the address the publisher gives it: never a URL from the window.
  handle('sharing:open-link', (senderId, input) => {
    const address = addressNow(senderId, input)
    if (!address) return false
    options.openExternal(address)
    return true
  })
  // Copy link: the address to copy, decided now; the window copies this, never its last view.
  handle('sharing:copy-address', (senderId, input) => addressNow(senderId, input))

  // ── The Shares list (ticket 10) ───────────────────────────────────────────────────────────────
  /** The Shares list of the window's Workspace: main's own records for that root, nothing the window names. */
  const listOf = async (senderId: number): Promise<Binding | null> => {
    const root = options.rootFor(senderId)
    if (!root) return null
    const found = publisher.linksIn(root)
    const gone = new Set<string>()
    const entries: ShareListEntry[] = []
    for (const { kind, path, parts, link } of found.links) {
      let openPath: string | null = null
      if (kind === 'piece') {
        // Gone: no longer a writer's piece, or no longer on disk (deleted, moved outside WriteFlex).
        if (await sourceStillThere(root, path, 'piece')) openPath = path
        else gone.add(link.shareId)
      } else if (await isFolio(root, path)) {
        // Its page opens on a part (App: a part open shows its Folio's page): the first published part still a piece.
        openPath = parts.find((part) => !part.missing && piecePath(part.path) === part.path && (path === '' || part.path.startsWith(`${path}/`)) && isSharablePiece(root, part.path) && isFileOnDisk(root, part.path))?.path ?? null
      } else gone.add(link.shareId)
      const name = kind === 'piece' ? basename(path).replace(/\.(md|markdown)$/i, '') : `${path === '' ? basename(root) : basename(path)} (Folio)`
      entries.push({ link, kind, path, piece: name, sourceGone: gone.has(link.shareId), openPath })
    }
    // The Workspace may have changed while the Folios were read.
    if (options.rootFor(senderId) !== root) return null
    const { links: _links, ...address } = found
    const view: SharesListView = { ...address, entries }
    return { root, path: '', kind: 'piece', manageOnly: true, also: [], list: { ids: new Set(entries.map((entry) => entry.link.shareId)), gone, view } }
  }
  const EMPTY_LIST: SharesListView = { ready: false, address: null, entries: [] }
  // The list opened (and read again on every change): binds exactly the links it lists.
  handle('sharing:open-list', (senderId) => bindAs(senderId, () => listOf(senderId), (binding) => binding.list!.view, EMPTY_LIST))
  /** How many times each link the window has bound was opened, from the service; nothing for other links. */
  handle('sharing:opened', async (senderId) => {
    const bound = openPiece(senderId)
    if (!bound) return {}
    const ids = bound.list
      ? [...bound.list.ids]
      : [{ path: bound.path, kind: bound.kind }, ...bound.also].flatMap((group) => recordsOf(bound.root, group.path, group.kind).map((record) => record.shareId))
    return publisher.opened(ids)
  })

  // ── Readers' notes (ticket 07) ────────────────────────────────────────────────────────────────
  /** The links the window has bound (the page's, with the other links it shows, or the list's). */
  const boundIds = (senderId: number): string[] => {
    const bound = openPiece(senderId)
    if (!bound) return []
    return bound.list
      ? [...bound.list.ids]
      : [{ path: bound.path, kind: bound.kind }, ...bound.also].flatMap((group) => recordsOf(bound.root, group.path, group.kind).map((record) => record.shareId))
  }
  /**
   * Notes waiting and handled for each link the window has bound, from the window's own review list
   * (undecided and decided reader records), and the Limits panel from what its service last said it
   * refused. Nothing for other links; no figure names a reader.
   */
  handle('sharing:notes', async (senderId) => {
    const ids = boundIds(senderId)
    if (ids.length === 0) return {}
    const records = options.readerNotes ? await options.readerNotes(senderId).catch(() => null) : null
    const counts: NotesCounts = {}
    for (const shareId of ids) {
      const own = records?.filter((record) => record.shareId === shareId) ?? null
      counts[shareId] = {
        waiting: own ? own.filter((record) => !record.settled).length : null,
        handled: own ? own.filter((record) => record.settled).length : null,
        limit: limitReachedOf(refusedFor(shareId), publisher.refusedSeen(shareId), limitsFor(shareId)),
      }
    }
    return counts
  })
  /** The writer acted on the panel: what was refused so far is seen. */
  const acknowledge = (shareId: string): void => {
    const refused = refusedFor(shareId)
    if (refused) publisher.acknowledgeRefused(shareId, refused.byReason)
  }
  /** A service that answered notes but stated no limits is older than build 5: it has neither route. */
  const oldService = (shareId: string): boolean => refusedFor(shareId) !== null && limitsFor(shareId) === null
  // Clear handled notes: the keys of this link's notes the window's review list holds as decided,
  // deleted on the service (collected ones only, the service's own rule). A link the page shows, as Turn off.
  handle('sharing:clear-handled', async (senderId, input): Promise<LimitsActionResult> => {
    const link = ownLink(senderId, input, true)
    if (!link) return { ok: false, problem: LIMITS_NOT_HERE }
    if (oldService(link.shareId)) return { ok: false, problem: LIMITS_OLD_SERVICE }
    const records = options.readerNotes ? await options.readerNotes(senderId).catch(() => null) : null
    if (records === null) return { ok: false, problem: { reason: 'WriteFlex could not read this collection’s review list.', fix: 'Try again in a moment.' } }
    // The binding may have changed while the list was read.
    if (ownLink(senderId, input, true)?.shareId !== link.shareId) return { ok: false, problem: LIMITS_NOT_HERE }
    const keys = records.filter((record) => record.shareId === link.shareId && record.settled).map((record) => record.key)
    const done = keys.length === 0 ? { ok: true as const, cleared: 0, gone: [] } : await publisher.clearNotes(link.shareId, keys)
    if (!done.ok) return { ok: false, problem: done.why === 'old-service' ? LIMITS_OLD_SERVICE : LIMITS_OFFLINE }
    // The review list cannot be written just now: the notes are cleared all the same; their records stay unmarked.
    if (done.gone.length > 0 && options.readerNotesGone) await options.readerNotesGone(senderId, link.shareId, done.gone).catch(() => null)
    acknowledge(link.shareId)
    readerLinksChanged()
    return { ok: true, message: clearedMessage(done.cleared) }
  })
  // Raise the limit for this link: more notes may come, so its source must still be there, as Turn on.
  handle('sharing:raise-limit', async (senderId, input): Promise<LimitsActionResult> => {
    const link = await actionLink(senderId, input)
    if (!link) return { ok: false, problem: LIMITS_NOT_HERE }
    if (oldService(link.shareId)) return { ok: false, problem: LIMITS_OLD_SERVICE }
    const done = await publisher.raiseLimit(link.shareId)
    if (!done.ok && done.why === 'at-most') {
      // A body not as the service promises says nothing: the limits last known stand (never null, which reads as an older service).
      const atMost = checkedLimits(done.limits)
      if (atMost) setLimitsFor(link.shareId, atMost)
      return { ok: false, problem: { reason: RAISE_AT_MOST, fix: 'Clear handled comments, or turn comments off for this link.' } }
    }
    if (!done.ok) return { ok: false, problem: done.why === 'old-service' ? LIMITS_OLD_SERVICE : LIMITS_OFFLINE }
    const limits = checkedLimits(done.limits)
    if (limits) setLimitsFor(link.shareId, limits)
    acknowledge(link.shareId)
    readerLinksChanged()
    return { ok: true, message: limits ? raisedMessage(limits.perHour) : 'The limit for this link is raised.' }
  })
}

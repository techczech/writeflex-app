// One link's record as settings.json keeps it (`sharingLinks`; sharing tickets 03, 04, 07, 09) and the
// reader that checks it on the way in. Never a secret: owner tokens live in the secrets store. Split from
// sharing-publisher.ts (ticket 04), which decides every change to a record.
//
// No Electron import.
import { isAbsolute } from 'node:path'
import { SHARE_LIMITS } from '../../sharing-service/share-protocol.ts'
import { PIECE_ID } from './sharing-piece-identity'
import { cleanLinkName, type ShareKind, type SharePublishProblem } from '../shared/sharing-links'

/** A part as the last publish sent it (Folio links). */
export type PublishedPartRecord = { path: string; title: string; missing: boolean }

export type ShareRecord = {
  shareId: string
  /** A piece, or a whole Folio (ticket 09). Absent in records from before ticket 09: a piece. */
  kind: ShareKind
  /** The Workspace root the link was made in, and the piece's path in it (a Folio: its folder, '' for the Workspace itself). */
  root: string
  path: string
  name: string | null
  comments: boolean
  on: boolean
  madeAt: number
  /** The revision the service holds (0: nothing published yet). */
  revision: number
  publishedAt: number | null
  publishedSavedAt: number | null
  /** The pictures the last publish named. */
  images: string[]
  problem: SharePublishProblem | null
  /** What the last publish left out (PICTURES_REFUSED), or null. */
  note: string | null
  /** Folio links: each part file's key (sharing-folio.ts), kept so a part keeps its ids when the order changes. */
  partKeys: Record<string, string>
  /** Folio links: the parts the last publish sent, in running order. */
  parts: PublishedPartRecord[]
  /** Ticket 07, the Limits panel: refusals by reason the writer has acted on (Clear, Raise, Turn
   *  comments off); the panel shows only those counted since. Absent: none acted on yet. */
  refusedSeen?: Record<string, number>
  /** Ticket 04 (R12): the time of the first save not yet published; null when none is waiting. */
  queuedAt: number | null
  /** Ticket 04 (R11): the share ended because its piece went to the Trash; `removed`: the copy is off the service. */
  ended: { at: number; removed: boolean } | null
  /** Ticket 04 (ruling R-A): the piece's file (a Folio: its folder) as `<dev>:<ino>`, recorded when the
   *  share is made and refreshed on every publish, save and rename; null when not known (a record from
   *  before, a file that could not be read). A share follows a move only to the same file. */
  fileId: string | null
  /** Ticket 04 (R-G): bumped on every move of the share, so a command-line signal made for another
   *  place of it is never applied. */
  generation: number
  /** Ticket 04 (R-D): a hash of what the last publish sent, so a start publishes only what changed. */
  publishedHash: string | null
  /** Ticket 04 (R-B): the piece is not where the share has it (gone, or its folder cannot be read): the
   *  link stops publishing and nothing is removed until the writer turns it off or follows it. `candidate`:
   *  the one place in the Workspace that holds the same file, offered as "Follow to". */
  lost: ShareLost | null
}

export type ShareLost = { at: number; why: 'gone' | 'unreadable'; candidate: string | null }

/** A Workspace-relative path as records keep them: `/` separators, no climbing out. */
export function relativePathOk(path: unknown): path is string {
  return typeof path === 'string' && path !== '' && path.length <= 4096 && !isAbsolute(path) && !path.includes('\\') && !path.includes('\0')
    && !path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
}

export function readRecords(raw: unknown): ShareRecord[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 2000).flatMap((entry): ShareRecord[] => {
    const r = entry as Partial<ShareRecord> | null
    if (!r || typeof r !== 'object' || typeof r.shareId !== 'string' || !/^[A-Za-z0-9]{8,64}$/.test(r.shareId)) return []
    const kind: ShareKind = r.kind === 'folio' ? 'folio' : 'piece'
    // A Folio's folder may be the Workspace itself ('').
    if (typeof r.root !== 'string' || !r.root || typeof r.path !== 'string' || (!r.path && kind === 'piece')) return []
    const time = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null)
    const problem = r.problem && typeof r.problem === 'object' && typeof r.problem.reason === 'string' && typeof r.problem.kind === 'string'
      ? { kind: r.problem.kind, reason: r.problem.reason, at: time(r.problem.at) ?? 0 } as SharePublishProblem : null
    const partKeys = r.partKeys && typeof r.partKeys === 'object' && !Array.isArray(r.partKeys)
      ? Object.fromEntries(Object.entries(r.partKeys as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && /^[a-z][a-z0-9]{5}$/.test(entry[1])).slice(0, 2000))
      : {}
    const parts = Array.isArray(r.parts)
      ? r.parts.slice(0, SHARE_LIMITS.folioParts).flatMap((part): PublishedPartRecord[] => {
        const p = part as Partial<PublishedPartRecord> | null
        return p && typeof p.path === 'string' && typeof p.title === 'string' ? [{ path: p.path, title: p.title, missing: p.missing === true }] : []
      })
      : []
    const seen = r.refusedSeen && typeof r.refusedSeen === 'object' && !Array.isArray(r.refusedSeen)
      ? Object.fromEntries(Object.entries(r.refusedSeen as Record<string, unknown>).filter((entry): entry is [string, number] => /^[a-z_]{1,40}$/.test(entry[0]) && Number.isSafeInteger(entry[1]) && (entry[1] as number) >= 0).slice(0, 20))
      : null
    return [{
      shareId: r.shareId,
      kind,
      root: r.root,
      path: r.path,
      name: cleanLinkName(r.name),
      comments: r.comments === true,
      on: r.on === true,
      madeAt: time(r.madeAt) ?? 0,
      revision: Number.isSafeInteger(r.revision) && (r.revision as number) >= 0 ? r.revision as number : 0,
      publishedAt: time(r.publishedAt),
      publishedSavedAt: time(r.publishedSavedAt),
      images: Array.isArray(r.images) ? r.images.filter((name): name is string => typeof name === 'string').slice(0, SHARE_LIMITS.shareImages) : [],
      problem,
      note: typeof r.note === 'string' && r.note ? r.note.slice(0, 400) : null,
      partKeys,
      parts,
      ...(seen ? { refusedSeen: seen } : {}),
      queuedAt: time(r.queuedAt),
      ended: r.ended && typeof r.ended === 'object' ? { at: time(r.ended.at) ?? 0, removed: r.ended.removed === true } : null,
      fileId: typeof r.fileId === 'string' && PIECE_ID.test(r.fileId) ? r.fileId : null,
      generation: Number.isSafeInteger(r.generation) && (r.generation as number) >= 0 ? r.generation as number : 0,
      publishedHash: typeof r.publishedHash === 'string' && /^[0-9a-f]{64}$/.test(r.publishedHash) ? r.publishedHash : null,
      lost: r.lost && typeof r.lost === 'object'
        ? { at: time(r.lost.at) ?? 0, why: r.lost.why === 'unreadable' ? 'unreadable' : 'gone', candidate: relativePathOk(r.lost.candidate) ? r.lost.candidate : null }
        : null,
    }]
  })
}

/** How a reader's card names the link (spec section 2): its name, or its settings and the date it was made. */
export function readerLinkLabel(record: Pick<ShareRecord, 'name' | 'comments' | 'madeAt'>): string {
  if (record.name) return record.name
  const made = record.madeAt > 0 ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(record.madeAt)) : ''
  return `${record.comments ? 'Comments on, private' : 'Comments off'}${made ? ` · ${made}` : ''}`
}


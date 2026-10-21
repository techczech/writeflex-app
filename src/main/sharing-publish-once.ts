// One publish of a link (sharing tickets 03, 04, 09; split from sharing-publisher.ts in ticket 04). The
// rules are the publisher's R5, R8 and R9 (see its header): every picture the new copy needs is sent,
// then the page once; nothing here writes a record. A publish that cannot go through throws
// PublishStop with the problem to show, never another exception.
//
// No Electron import.
import { createHash } from 'node:crypto'
import type { ServiceAccess, ServiceAnswer, ServiceClient } from './sharing-client'
import type { RenderedPiece, SharedPicture } from './sharing-render'
import type { RenderedFolio } from './sharing-folio'
import type { PublishedPartRecord, ShareRecord } from './sharing-share-record'
import { SHARE_LIMITS } from '../../sharing-service/share-protocol.ts'
import {
  FOLIO_EMPTY, FOLIO_GONE, FOLIO_TOO_MANY_PARTS, IMAGE_TOO_BIG, IMAGES_OVER_BYTES, IMAGES_OVER_COUNT, PAGE_TOO_BIG, PICTURES_REFUSED, SHARE_AUTH, SHARE_NOT_SET_UP, SHARE_OFFLINE,
  RECORD_NOT_SAVED, SHARE_REFUSED, SHARE_UNREADABLE, type SharePublishProblem,
} from '../shared/sharing-links'

const MB = 1024 * 1024
const megabytes = (bytes: number): number => Math.round((bytes / MB) * 10) / 10
const SHARE_TOO_LARGE = 'Your sharing service refused part of the piece as too large.'

/** A publish that did not go through: the problem to show, never an exception. */
export class PublishStop extends Error {
  constructor(readonly problem: SharePublishProblem) { super(problem.reason) }
}

export type PublishOutcome = Pick<ShareRecord, 'revision' | 'publishedAt' | 'publishedSavedAt' | 'images' | 'note' | 'publishedHash'> & Partial<Pick<ShareRecord, 'partKeys' | 'parts'>>

export type PublishOnceDeps = {
  access(): ServiceAccess | null
  client: ServiceClient
  render(root: string, path: string, imagePath: string): Promise<RenderedPiece>
  renderFolio?(root: string, dir: string, imagePath: string, kept: Readonly<Record<string, string>>): Promise<{ folio: RenderedFolio; keys: Record<string, string> } | null>
  tokenFor(shareId: string): string | null
  now(): number
  timeZone(): string | null
}

export function createPublishOnce(ports: PublishOnceDeps) {
  const now = ports.now
  const timeZone = ports.timeZone
  const tokenFor = ports.tokenFor
  function stop(kind: SharePublishProblem['kind'], reason: string): never { throw new PublishStop({ kind, reason, at: now() }) }
  function answerProblem(answer: ServiceAnswer<unknown>): never {
    if (answer.kind === 'unreachable') stop('offline', SHARE_OFFLINE)
    if (answer.kind === 'refused' && answer.status === 401) stop('auth', SHARE_AUTH)
    if (answer.kind === 'refused' && answer.code === 'body_too_large') stop('too-big', SHARE_TOO_LARGE)
    stop('refused', SHARE_REFUSED)
  }

  /** What one publish sends: a piece as one part, or a Folio's parts in running order (R9). */
  type Copy = {
    title: string
    chips: { label: string; value: string }[]
    savedAt: number
    pictures: SharedPicture[]
    refusedPictures: number
    parts: Array<{ title: string; html: string; headings: { id: string; text: string }[] } | { title: string; missing: true; headings: [] }>
    partKeys: Record<string, string>
    partRecords: PublishedPartRecord[]
  }
  async function copyOf(record: ShareRecord, imagePath: string): Promise<Copy> {
    if (record.kind === 'piece') {
      const piece = await ports.render(record.root, record.path, imagePath).catch(() => stop('unreadable', SHARE_UNREADABLE))
      return { ...piece, parts: [{ title: piece.title, html: piece.html, headings: piece.headings }], partKeys: {}, partRecords: [] }
    }
    if (!ports.renderFolio) stop('unreadable', SHARE_UNREADABLE)
    const rendered = await ports.renderFolio(record.root, record.path, imagePath, record.partKeys).catch(() => stop('unreadable', SHARE_UNREADABLE))
    if (!rendered) stop('unreadable', FOLIO_GONE)
    const { folio, keys } = rendered
    if (folio.parts.length === 0) stop('refused', FOLIO_EMPTY)
    if (folio.parts.length > SHARE_LIMITS.folioParts) stop('too-big', FOLIO_TOO_MANY_PARTS(folio.parts.length, SHARE_LIMITS.folioParts))
    return {
      title: folio.title, chips: folio.chips, savedAt: folio.savedAt, pictures: folio.pictures, refusedPictures: folio.refusedPictures,
      parts: folio.parts.map((part) => (part.missing || part.html === null
        ? { title: part.title, missing: true as const, headings: [] as [] }
        : { title: part.title, html: part.html, headings: part.headings })),
      partKeys: keys,
      partRecords: folio.parts.map((part) => ({ path: part.path, title: part.title, missing: part.missing || part.html === null })),
    }
  }

  /** One publish of `record` (R5, R8): the fields its one update writes, or null when `onlyIfChanged` and
   *  the copy is what the last publish sent (ticket 04, R-D). Throws PublishStop with the problem.
   *  `beforeSend` (R-F, Sol round 2 P2-2): asked once the copy is known to go and before anything is
   *  sent; false (the queue could not be saved) stops it with nothing sent ('not-saved'). */
  async function publishOnce(record: ShareRecord, onlyIfChanged = false, beforeSend?: () => boolean): Promise<PublishOutcome | null> {
    const access = ports.access()
    if (!access) stop('not-set-up', SHARE_NOT_SET_UP)
    const owner = tokenFor(record.shareId)
    if (!owner) stop('auth', SHARE_AUTH)
    const base = access.base
    const imagePath = `/s/${record.shareId}/images/`
    const piece = await copyOf(record, imagePath)

    // What can never fit is refused before anything is sent.
    const biggest = piece.pictures.reduce((most, picture) => Math.max(most, picture.bytes.byteLength), 0)
    if (biggest > SHARE_LIMITS.imageBytes) stop('too-big', IMAGE_TOO_BIG(megabytes(biggest), SHARE_LIMITS.imageBytes / MB))
    if (piece.pictures.length > SHARE_LIMITS.shareImages) stop('too-big', IMAGES_OVER_COUNT(piece.pictures.length, SHARE_LIMITS.shareImages))
    const totalBytes = piece.pictures.reduce((sum, picture) => sum + picture.bytes.byteLength, 0)
    if (totalBytes > SHARE_LIMITS.shareImageBytes) stop('too-big', IMAGES_OVER_BYTES(megabytes(totalBytes), SHARE_LIMITS.shareImageBytes / MB))

    // R-D: what this copy is, so a start publishes only a piece that changed while WriteFlex was closed.
    const wanted = piece.pictures.map((picture) => picture.name)
    const hash = createHash('sha256').update(JSON.stringify({ kind: record.kind, comments: record.comments, title: piece.title, chips: piece.chips, parts: piece.parts, images: wanted })).digest('hex')
    if (onlyIfChanged && hash === record.publishedHash) return null
    if (beforeSend && !beforeSend()) stop('not-saved', RECORD_NOT_SAVED)

    let revision = record.revision
    const body = (images: readonly string[]): string => JSON.stringify({
      revision: revision + 1,
      savedAt: piece.savedAt > 0 ? piece.savedAt : now(),
      timeZone: timeZone(),
      lang: 'en',
      comments: record.comments,
      kind: record.kind,
      title: piece.title,
      chips: piece.chips,
      parts: piece.parts,
      images,
    })
    const overCap = (answer: ServiceAnswer<unknown>): never => (answer.kind === 'refused' && answer.extra.count !== undefined
      ? stop('too-big', IMAGES_OVER_COUNT(piece.pictures.length, SHARE_LIMITS.shareImages))
      : stop('too-big', IMAGES_OVER_BYTES(megabytes(totalBytes), SHARE_LIMITS.shareImageBytes / MB)))

    const known = new Set(record.images)
    // The pictures the service already holds for the new copy, as far as this Mac knows.
    const held = new Set(wanted.filter((name) => known.has(name)))
    /** Send every picture of `pictures` not in `held`. The service's "full" answer, or null when all arrived. */
    const sendPictures = async (pictures: RenderedPiece['pictures']): Promise<ServiceAnswer<unknown> | null> => {
      for (const picture of pictures) {
        if (held.has(picture.name)) continue
        const answer = await ports.client.putImage(base, record.shareId, owner, picture.name, picture.bytes)
        if (answer.kind === 'ok') { held.add(picture.name); continue }
        if (answer.kind === 'refused' && answer.code === 'share_images_full') return answer
        answerProblem(answer)
      }
      return null
    }
    let cleared = false
    /** R5: send `pictures`; when the service is full, clear what stopped publishes left waiting, once, and send again. */
    const sendWithRoom = async (pictures: RenderedPiece['pictures']): Promise<void> => {
      let full = await sendPictures(pictures)
      if (!full) return
      if (cleared) overCap(full)
      cleared = true
      const deleted = await ports.client.deleteStaged(base, record.shareId, owner)
      if (deleted.kind !== 'ok') answerProblem(deleted)
      // Only the published copy's pictures are still there.
      for (const name of [...held]) if (!known.has(name)) held.delete(name)
      full = await sendPictures(piece.pictures)
      if (full) overCap(full)
    }

    await sendWithRoom(piece.pictures)
    // The page, once. Every attempt below sends the same complete copy.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const text = body(wanted)
      if (Buffer.byteLength(text) > SHARE_LIMITS.publishBodyBytes) stop('too-big', PAGE_TOO_BIG(megabytes(Buffer.byteLength(text)), SHARE_LIMITS.publishBodyBytes / MB))
      const answer = await ports.client.putPage(base, record.shareId, owner, text)
      if (answer.kind === 'ok') {
        const note = piece.refusedPictures > 0 ? PICTURES_REFUSED(piece.refusedPictures) : null
        return {
          revision: answer.body.revision, publishedAt: answer.body.publishedAt || now(), publishedSavedAt: piece.savedAt || null, images: wanted, note, publishedHash: hash,
          ...(record.kind === 'folio' ? { partKeys: { ...record.partKeys, ...piece.partKeys }, parts: piece.partRecords } : {}),
        }
      }
      // Another publish got there first (another run of this app): follow its revision.
      if (answer.kind === 'refused' && answer.code === 'revision_conflict' && Number.isSafeInteger(answer.extra.revision)) {
        revision = answer.extra.revision as number
        continue
      }
      // Pictures the service does not hold after all (another Mac's publish, a lost one): this Mac was
      // wrong to think it held them, so they are sent again.
      if (answer.kind === 'refused' && answer.code === 'missing_images' && Array.isArray(answer.extra.missing)) {
        const missing = new Set(answer.extra.missing.filter((name): name is string => typeof name === 'string'))
        for (const name of missing) held.delete(name)
        await sendWithRoom(piece.pictures.filter((picture) => missing.has(picture.name)))
        continue
      }
      if (answer.kind === 'refused' && answer.code === 'share_images_full') overCap(answer)
      answerProblem(answer)
    }
    return stop('refused', SHARE_REFUSED)
  }


  return { publishOnce, stop }
}

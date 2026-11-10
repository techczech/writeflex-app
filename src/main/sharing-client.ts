import type { PeopleChange, SharePerson } from '../shared/sharing-people'
import type { LinkRecord, WorkspaceIdentity } from '../../sharing-service/share-record-protocol.ts'
import { isShareId } from '../../sharing-service/share-id.ts'
import { probeService } from './sharing-identity'
// Requests from this Mac to the sharing service (sharing ticket 03). Routes and answers:
// sharing-service/README-sharing-service.md. The admin key goes only on share creation, workspace
// discovery and per-share owner-token minting; an owner token only on its share's routes, in the Authorization
// header. The Cloudflare token never reaches this module.
//
// Every call answers a ServiceAnswer: `ok` with the parsed body, `refused` with the service's error
// code (and its extra fields), or `unreachable` (no answer, a timeout, or an answer that is not the
// service's JSON). No error ever carries a header, a token or the request.
//
// No Electron import.

export type ServiceAnswer<T> =
  | { kind: 'ok'; status: number; body: T }
  | { kind: 'refused'; status: number; code: string; extra: Record<string, unknown> }
  | { kind: 'unreachable' }

/**
 * Where the service is (`address`, the workers.dev address requests go to; `base`, where they are sent)
 * and this Mac's key. Ticket 05: `linkAddress`, the address new and copied links use (the own address
 * only while linksAddressNow allows; `address` when absent), and the own address's state for the Sharing page.
 */
export type ServiceAccess = {
  address: string; base: string; key: string
  linkAddress?: string
  /** When `linkAddress` is the own address: the instant (ms) THE RULE stops allowing it (sharing-own-address.ts linksAddressUntil). */
  linkAddressUntil?: number | null
  ownAddress?: import('../shared/sharing-setup').OwnAddressState | null
}

export type CreatedShare = { shareId: string; ownerToken: string; readerPath: string; imagePath: string }
/** `images`, `imageBytes`: every picture the service holds for the share; `staged`, `stagedBytes`: those no publish names yet (service build 3). */
export type ShareState = {
  shareId: string; status: 'on' | 'off'; revision: number; publishedAt: number | null; savedAt: number | null; images: number; imageBytes: number; staged: number; stagedBytes: number
  /** How many times readers opened the page (service build 4; absent from an older service). */
  sourceHash?: string | null
  folioState?: Pick<LinkRecord, 'partKeys' | 'parts'>
  comments?: boolean
  opened?: number
  commentsMode?: 'private' | 'open'
  hasPrivateComments?: boolean
}

export type RemoteShareRecord = LinkRecord & ShareState & { on: boolean; notes: 'private' | 'open' }

export const SERVICE_TIMEOUT_MS = 20_000
export const IMAGE_TIMEOUT_MS = 60_000
/** A new key can take a few seconds to reach the service (README, "Installed by the app"). */
export const ADMIN_RETRY_PAUSES_MS: readonly number[] = [1000, 2000, 3000]

export interface ServiceClientPorts {
  fetch: typeof fetch
  wait?(ms: number): Promise<void>
  timeouts?: { request: number; image: number }
}

const realWait = (ms: number): Promise<void> => new Promise((resolve) => { const timer = setTimeout(resolve, ms); (timer as { unref?: () => void }).unref?.() })

export function createServiceClient(ports: ServiceClientPorts) {
  const wait = ports.wait ?? realWait
  const timeouts = ports.timeouts ?? { request: SERVICE_TIMEOUT_MS, image: IMAGE_TIMEOUT_MS }
  const builds = new Map<string, { until: number; task: Promise<number | null> }>()
  function serviceBuild(base: string): Promise<number | null> {
    const kept = builds.get(base)
    if (kept && kept.until > Date.now()) return kept.task
    const task = probeService(ports.fetch, `${base}/version`, timeouts.request).then((answer) => answer.kind === 'sharing' ? answer.build : null)
    builds.set(base, { until: Date.now() + 60_000, task })
    return task
  }
  const oldService = async (base: string): Promise<boolean> => { const build = await serviceBuild(base); return build !== null && build < 15 }

  async function call<T>(base: string, path: string, init: { method: string; bearer: string; body?: BodyInit; contentType?: string; timeoutMs?: number }): Promise<ServiceAnswer<T>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? timeouts.request)
    ;(timer as { unref?: () => void }).unref?.()
    let response: Response
    try {
      const headers: Record<string, string> = { authorization: `Bearer ${init.bearer}` }
      if (init.contentType) headers['content-type'] = init.contentType
      response = await ports.fetch(`${base}${path}`, { method: init.method, headers, body: init.body, signal: controller.signal, redirect: 'error' })
    } catch {
      clearTimeout(timer)
      return { kind: 'unreachable' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(await response.text())
    } catch {
      clearTimeout(timer)
      return { kind: 'unreachable' }
    } finally {
      clearTimeout(timer)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'unreachable' }
    const body = parsed as Record<string, unknown>
    if (response.ok) return { kind: 'ok', status: response.status, body: body as T }
    // The service's refusal: `{error: {code, message}, ...details}` (sharing-service/http.ts).
    const error = body.error as { code?: unknown } | null | undefined
    const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : `http_${response.status}`
    const { error: _error, ...extra } = body
    return { kind: 'refused', status: response.status, code, extra }
  }

  return {
    serviceBuild,
    async people(base: string, shareId: string, owner: string, change?: PeopleChange): Promise<ServiceAnswer<{ people?: Array<SharePerson & { token: string }>; person?: SharePerson & { token: string }; plainLink: boolean; title?: string }>> {
      const build = await serviceBuild(base)
      if (build !== null && build < 17) return { kind: 'refused', status: 426, code: 'older_service', extra: {} }
      return call(base, `/shares/${shareId}/people`, { method: change ? 'POST' : 'GET', bearer: owner, ...(change ? { contentType: 'application/json', body: JSON.stringify(change) } : {}) })
    },
    /** `POST /shares` with this Mac's admin key. A 401 is asked again after a pause or three (a new key travelling). */
    async createShare(access: ServiceAccess): Promise<ServiceAnswer<CreatedShare>> {
      for (let attempt = 0; ; attempt += 1) {
        const answer = await call<CreatedShare>(access.base, '/shares', { method: 'POST', bearer: access.key })
        if (answer.kind === 'ok') {
          const b = answer.body
          if (!b || typeof b.shareId !== 'string' || !isShareId(b.shareId) || typeof b.ownerToken !== 'string' || b.ownerToken.length < 16) return { kind: 'unreachable' }
          return { kind: 'ok', status: answer.status, body: { shareId: b.shareId, ownerToken: b.ownerToken, readerPath: `/s/${b.shareId}`, imagePath: `/s/${b.shareId}/images/` } }
        }
        if (answer.kind === 'refused' && answer.status === 401 && attempt < ADMIN_RETRY_PAUSES_MS.length) {
          await wait(ADMIN_RETRY_PAUSES_MS[attempt])
          continue
        }
        return answer
      }
    },
    async listShares(access: ServiceAccess, workspaces: WorkspaceIdentity[]): Promise<ServiceAnswer<{ workspace: WorkspaceIdentity; records: RemoteShareRecord[] }>> {
      if (await oldService(access.base)) return { kind: 'refused', status: 426, code: 'older_service', extra: {} }
      return call(access.base, '/shares/list', { method: 'POST', bearer: access.key, contentType: 'application/json', body: JSON.stringify({ workspaces }) })
    },
    async mintOwner(access: ServiceAccess, shareId: string): Promise<ServiceAnswer<{ shareId: string; ownerToken: string }>> {
      if (await oldService(access.base)) return { kind: 'refused', status: 426, code: 'older_service', extra: {} }
      return call(access.base, `/shares/${shareId}/owner-token`, { method: 'POST', bearer: access.key })
    },
    async getRecord(base: string, shareId: string, owner: string): Promise<ServiceAnswer<RemoteShareRecord>> {
      if (await oldService(base)) return { kind: 'refused', status: 426, code: 'older_service', extra: {} }
      return call(base, `/shares/${shareId}/record`, { method: 'GET', bearer: owner })
    },
    async putRecord(base: string, shareId: string, owner: string, record: LinkRecord, baseRecord?: LinkRecord): Promise<ServiceAnswer<{ kept: boolean }>> {
      if (await oldService(base)) return { kind: 'refused', status: 426, code: 'older_service', extra: {} }
      return call(base, `/shares/${shareId}/record`, { method: 'PUT', bearer: owner, contentType: 'application/json', body: JSON.stringify(baseRecord ? { record, baseRecord } : record) })
    },
    async noteState(base: string, shareId: string, owner: string): Promise<ServiceAnswer<{ notes: unknown[]; more: boolean; refused: unknown; limits?: unknown }>> {
      if (await oldService(base)) return call(base, `/shares/${shareId}/notes`, { method: 'GET', bearer: owner })
      const notes: unknown[] = []
      let after = 0
      for (let page = 0; page < 100; page++) {
        const answer = await call<{ notes: unknown[]; more: boolean; cursor: number; refused: unknown; limits?: unknown }>(base, `/shares/${shareId}/notes/state`, { method: 'POST', bearer: owner, contentType: 'application/json', body: JSON.stringify({ after }) })
        if (answer.kind !== 'ok') return answer
        if (!Array.isArray(answer.body.notes)) return { kind: 'unreachable' }
        notes.push(...answer.body.notes)
        if (!answer.body.more) return { ...answer, body: { ...answer.body, notes } }
        if (!Number.isSafeInteger(answer.body.cursor) || answer.body.cursor <= after) return { kind: 'unreachable' }
        after = answer.body.cursor
      }
      return { kind: 'unreachable' }
    },
    async claimNote(base: string, shareId: string, owner: string, key: string, claim: string): Promise<ServiceAnswer<{ allowed: boolean; status?: string }>> {
      if (await oldService(base)) return { kind: 'ok', status: 200, body: { allowed: true } }
      const send = () => call<{ allowed: boolean; status?: string }>(base, `/shares/${shareId}/notes/claim`, { method: 'POST', bearer: owner, contentType: 'application/json', body: JSON.stringify({ key, claim }) })
      const answer = await send()
      return answer.kind === 'unreachable' ? send() : answer
    },
    async releaseClaim(base: string, shareId: string, owner: string, key: string, claim: string, force = false, expectedAt?: number): Promise<ServiceAnswer<unknown>> {
      if (await oldService(base)) return { kind: 'ok', status: 200, body: {} }
      return call(base, `/shares/${shareId}/notes/claim`, { method: 'POST', bearer: owner, contentType: 'application/json', body: JSON.stringify({ key, claim, release: true, ...(force ? { force: true, expectedAt } : {}) }) })
    },
    async setComments(base: string, shareId: string, owner: string, comments: boolean): Promise<ServiceAnswer<{ comments: boolean }>> {
      if (await oldService(base)) return { kind: 'refused', status: 426, code: 'older_service', extra: {} }
      return call(base, `/shares/${shareId}/settings`, { method: 'POST', bearer: owner, contentType: 'application/json', body: JSON.stringify({ comments }) })
    },
    state(base: string, shareId: string, owner: string): Promise<ServiceAnswer<ShareState>> {
      return call<ShareState>(base, `/shares/${shareId}`, { method: 'GET', bearer: owner })
    },
    setNotes(base: string, shareId: string, owner: string, notes: 'private' | 'open'): Promise<ServiceAnswer<{ notes: 'private' | 'open'; hasPrivateComments: boolean }>> {
      return call(base, `/shares/${shareId}/settings`, { method: 'POST', bearer: owner, contentType: 'application/json', body: JSON.stringify({ notes }) })
    },
    putImage(base: string, shareId: string, owner: string, name: string, bytes: Uint8Array): Promise<ServiceAnswer<{ stored: string; already: boolean }>> {
      return call(base, `/shares/${shareId}/images/${name}`, { method: 'PUT', bearer: owner, body: bytes as Uint8Array<ArrayBuffer>, contentType: 'application/octet-stream', timeoutMs: timeouts.image })
    },
    putPage(base: string, shareId: string, owner: string, body: string): Promise<ServiceAnswer<{ revision: number; publishedAt: number; savedAt?: number; unchanged?: boolean; sourceHash?: string; skippedParts?: string[] }>> {
      return call(base, `/shares/${shareId}/page`, { method: 'PUT', bearer: owner, body, contentType: 'application/json', timeoutMs: timeouts.image })
    },
    /** Delete the pictures sent for a publish that never finished (no publish names them); the published copy stays. */
    deleteStaged(base: string, shareId: string, owner: string): Promise<ServiceAnswer<{ deleted: number }>> {
      return call(base, `/shares/${shareId}/images/staged`, { method: 'DELETE', bearer: owner })
    },
    turnOff(base: string, shareId: string, owner: string): Promise<ServiceAnswer<{ status: 'off'; revision: number }>> {
      return call(base, `/shares/${shareId}/off`, { method: 'POST', bearer: owner })
    },
    turnOn(base: string, shareId: string, owner: string): Promise<ServiceAnswer<{ status: 'on'; revision: number }>> {
      return call(base, `/shares/${shareId}/on`, { method: 'POST', bearer: owner })
    },
    /** Ticket 07: readers' notes not collected yet, and what was refused (checked by sharing-reader-notes.ts). */
    notes(base: string, shareId: string, owner: string): Promise<ServiceAnswer<{ notes: unknown[]; more: boolean; refused: unknown; limits?: unknown }>> {
      return call(base, `/shares/${shareId}/notes`, { method: 'GET', bearer: owner })
    },
    /** Ticket 07, Clear handled notes (service build 5): delete these notes, collected ones only, on the service. */
    clearNotes(base: string, shareId: string, owner: string, keys: string[]): Promise<ServiceAnswer<{ cleared: string[]; waiting: string[]; unknown: string[] }>> {
      return call(base, `/shares/${shareId}/notes/clear`, { method: 'POST', bearer: owner, body: JSON.stringify({ keys }), contentType: 'application/json' })
    },
    /** Ticket 07, Raise the limit for this link (service build 5). */
    raiseLimit(base: string, shareId: string, owner: string): Promise<ServiceAnswer<{ limits: unknown }>> {
      return call(base, `/shares/${shareId}/notes/raise`, { method: 'POST', bearer: owner })
    },
    /** Ticket 08 (service build 6): the outcome and the writer's replies on collected notes (sharing-reader-replies.ts). */
    outcomes(base: string, shareId: string, owner: string, outcomes: unknown[]): Promise<ServiceAnswer<{ recorded: unknown; waiting: unknown; unknown: unknown; full: unknown; replies?: unknown }>> {
      return call(base, `/shares/${shareId}/notes/outcomes`, { method: 'POST', bearer: owner, body: JSON.stringify({ outcomes }), contentType: 'application/json' })
    },
    /** Ticket 07: mark notes collected, once the review ledger holds them. */
    collected(base: string, shareId: string, owner: string, keys: string[]): Promise<ServiceAnswer<{ collected: string[]; already: string[]; unknown: string[] }>> {
      return call(base, `/shares/${shareId}/notes/collected`, { method: 'POST', bearer: owner, body: JSON.stringify({ keys }), contentType: 'application/json' })
    },
  }
}

export type ServiceClient = ReturnType<typeof createServiceClient>

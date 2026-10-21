// Requests from this Mac to the sharing service (sharing ticket 03). Routes and answers:
// sharing-service/README-sharing-service.md. The admin key (this Mac's, ticket 02) goes only on
// `POST /shares`; an owner token only on its own share's routes; each only in the Authorization
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
  opened?: number
}

export const SERVICE_TIMEOUT_MS = 20_000
export const IMAGE_TIMEOUT_MS = 60_000
/** A new key can take a few seconds to reach the service (README, "Installed by the app"). */
export const ADMIN_RETRY_PAUSES_MS: readonly number[] = [1000, 2000, 3000]

/** The service's share ids (sharing-service/share-id.ts): letters and digits only, so one is safe in a path. */
const SHARE_ID = /^[A-Za-z0-9]{8,64}$/

export interface ServiceClientPorts {
  fetch: typeof fetch
  wait?(ms: number): Promise<void>
  timeouts?: { request: number; image: number }
}

const realWait = (ms: number): Promise<void> => new Promise((resolve) => { const timer = setTimeout(resolve, ms); (timer as { unref?: () => void }).unref?.() })

export function createServiceClient(ports: ServiceClientPorts) {
  const wait = ports.wait ?? realWait
  const timeouts = ports.timeouts ?? { request: SERVICE_TIMEOUT_MS, image: IMAGE_TIMEOUT_MS }

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
    /** `POST /shares` with this Mac's admin key. A 401 is asked again after a pause or three (a new key travelling). */
    async createShare(access: ServiceAccess): Promise<ServiceAnswer<CreatedShare>> {
      for (let attempt = 0; ; attempt += 1) {
        const answer = await call<CreatedShare>(access.base, '/shares', { method: 'POST', bearer: access.key })
        if (answer.kind === 'ok') {
          const b = answer.body
          if (!b || typeof b.shareId !== 'string' || !SHARE_ID.test(b.shareId) || typeof b.ownerToken !== 'string' || b.ownerToken.length < 16) return { kind: 'unreachable' }
          return { kind: 'ok', status: answer.status, body: { shareId: b.shareId, ownerToken: b.ownerToken, readerPath: `/s/${b.shareId}`, imagePath: `/s/${b.shareId}/images/` } }
        }
        if (answer.kind === 'refused' && answer.status === 401 && attempt < ADMIN_RETRY_PAUSES_MS.length) {
          await wait(ADMIN_RETRY_PAUSES_MS[attempt])
          continue
        }
        return answer
      }
    },
    state(base: string, shareId: string, owner: string): Promise<ServiceAnswer<ShareState>> {
      return call<ShareState>(base, `/shares/${shareId}`, { method: 'GET', bearer: owner })
    },
    putImage(base: string, shareId: string, owner: string, name: string, bytes: Uint8Array): Promise<ServiceAnswer<{ stored: string; already: boolean }>> {
      return call(base, `/shares/${shareId}/images/${name}`, { method: 'PUT', bearer: owner, body: bytes as Uint8Array<ArrayBuffer>, contentType: 'application/octet-stream', timeoutMs: timeouts.image })
    },
    putPage(base: string, shareId: string, owner: string, body: string): Promise<ServiceAnswer<{ revision: number; publishedAt: number }>> {
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

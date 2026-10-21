// Shared HTTP helpers and the service's bindings. Copied from TalkWeaver's worker/http.ts, cut down.

export interface Env {
  /** One object per share, named by the share id (shared-piece.ts). */
  SHARES: DurableObjectNamespace
  /** The singleton that keeps the signing key (signing-key.ts). */
  SHARING_REGISTRY: DurableObjectNamespace
  /** `ADMIN_SECRET_<computer id>`: one admin key per Mac (admin-keys.ts). */
  [secret: `ADMIN_SECRET_${string}`]: string | undefined
}

export const REGISTRY_NAME = 'writeflex-sharing-registry'

export function registryStub(env: Env): DurableObjectStub {
  return env.SHARING_REGISTRY.get(env.SHARING_REGISTRY.idFromName(REGISTRY_NAME))
}

export function shareStub(env: Env, shareId: string): DurableObjectStub {
  return env.SHARES.get(env.SHARES.idFromName(shareId))
}

/** Headers on every API answer: never cached, never read by a page on another site (no CORS). */
const API_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: API_HEADERS })
}

export function errorResponse(code: string, message: string, status: number, details: Record<string, unknown> = {}): Response {
  return jsonResponse({ error: { code, message }, ...details }, status)
}

/**
 * Read a refused request's body to its end and throw it away, holding none of it. In the Workers
 * runtime a response sent while the client is still sending its body loses the connection, and the
 * client sees no answer at all; a body left unread or cancelled does that. Cloudflare caps a request
 * body (100 MB on the smaller plans), which bounds what this reads.
 */
export async function drainBody(request: Request): Promise<void> {
  if (!request.body || request.bodyUsed) return
  const reader = request.body.getReader()
  try {
    for (;;) {
      const { done } = await reader.read()
      if (done) return
    }
  } catch {
    // The client went away; nothing to answer.
  }
}

/**
 * Read a body without ever holding more than `maxBytes` of it. Returns null when the body is too
 * large: a declared Content-Length over the cap, or a body that passes the cap as it arrives. Either
 * way the rest is read and thrown away (drainBody), so the client gets the refusal. (TalkWeaver's
 * readBoundedBytes, which cancels instead.)
 */
export async function readBoundedBytes(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const declared = request.headers.get('content-length')
  if (declared !== null && Number(declared) > maxBytes) {
    await drainBody(request)
    return null
  }
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      chunks.length = 0
      for (;;) {
        const rest = await reader.read().catch(() => ({ done: true as const }))
        if (rest.done) return null
      }
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

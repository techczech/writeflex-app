/** One cancellable device flow, fixed endpoints, bounded responses and no idle account polling. */
export type Pair = { accessToken: string; refreshToken: string; expiresAt: number; refreshExpiresAt: number }
export class GitHubRequestError extends Error { constructor(readonly code: 'offline' | 'invalid-response' | 'unauthorised' | 'not-authorised', readonly retryAfter = 0) { super(code) } }
export type GitHubRequest = (path: string, form?: Record<string, string>, token?: string, signal?: AbortSignal) => Promise<any>
export function createGitHubRequest(fetcher: typeof fetch = fetch): GitHubRequest {
  return async (path, form, token, signal) => {
    const oauth = path === '/login/device/code' || path === '/login/oauth/access_token'
    if (!oauth && !/^\/(?:user|user\/installations(?:\?per_page=100&page=[1-9][0-9]?)?|user\/installations\/[1-9][0-9]*\/repositories\?per_page=100&page=[1-9][0-9]?|repos\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+)$/.test(path)) throw new GitHubRequestError('invalid-response')
    const controller = new AbortController(), abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
    const timer = setTimeout(abort, 10_000)
    try {
      const response = await fetcher(`${oauth ? 'https://github.com' : 'https://api.github.com'}${path}`, {
        method: form ? 'POST' : 'GET', redirect: 'manual', signal: controller.signal,
        headers: { Accept: 'application/json', ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      })
      if (response.status === 401) throw new GitHubRequestError('unauthorised')
      if (response.status === 403 || response.status === 404) throw new GitHubRequestError('not-authorised')
      if (!response.ok || response.redirected) throw new GitHubRequestError('invalid-response')
      if (!response.body) throw new GitHubRequestError('invalid-response')
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 256 * 1024) throw new GitHubRequestError('invalid-response'); chunks.push(value) } } finally { await reader.cancel().catch(() => undefined) }
      const text = Buffer.concat(chunks), result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(text))
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new GitHubRequestError('invalid-response')
      const retry = response.headers.get('retry-after')
      if (retry) Object.defineProperty(result, '_retryAfter', { value: Math.min(900_000, /^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now())), enumerable: false })
      return result
    } catch (e) { if (e instanceof GitHubRequestError) throw e; throw new GitHubRequestError('offline') }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
  }
}
export function tokenPair(v: any, now: number): Pair {
  if (!v || typeof v !== 'object' || (typeof v.token_type !== 'string' || v.token_type.toLowerCase() !== 'bearer') || !['access_token', 'refresh_token'].every(k => typeof v[k] === 'string' && /^[A-Za-z0-9_.-]{1,8192}$/.test(v[k])) || !['expires_in', 'refresh_token_expires_in'].every(k => Number.isSafeInteger(v[k]) && v[k] > 0 && v[k] <= 366 * 86400)) throw new GitHubRequestError('invalid-response')
  return { accessToken: v.access_token, refreshToken: v.refresh_token, expiresAt: now + v.expires_in * 1000, refreshExpiresAt: now + v.refresh_token_expires_in * 1000 }
}
export function verifiedUser(v: any): { accountId: number; login: string } {
  if (!Number.isSafeInteger(v?.id) || v.id < 1 || typeof v.login !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(v.login)) throw new GitHubRequestError('invalid-response')
  return { accountId: v.id, login: v.login }
}
export function createDeviceFlow(options: { clientId: string; request: GitHubRequest; now?: () => number; wait?: (ms: number, signal: AbortSignal) => Promise<void> }) {
  const controller = new AbortController(), now = options.now ?? Date.now
  const wait = options.wait ?? ((ms, signal) => new Promise<void>(resolve => {
    const end = () => { clearTimeout(timer); signal.removeEventListener('abort', end); resolve() }
    const timer = setTimeout(end, ms); signal.addEventListener('abort', end, { once: true }); if (signal.aborted) end()
  }))
  return {
    cancel: () => controller.abort(),
    async run(waiting: (code: string, expiresAt: number) => void, commit: (pair: Pair, user: { accountId: number; login: string }) => Promise<void>): Promise<'connected' | 'cancelled' | 'expired' | 'denied' | 'offline' | 'invalid-response'> {
      try {
        const started = now(), v = await options.request('/login/device/code', { client_id: options.clientId, scope: 'offline_access' }, undefined, controller.signal)
        if (controller.signal.aborted) return 'cancelled'
        if (v.verification_uri !== 'https://github.com/login/device' || typeof v.device_code !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(v.device_code) || typeof v.user_code !== 'string' || !/^[A-Z0-9-]{4,32}$/.test(v.user_code) || !Number.isSafeInteger(v.expires_in) || v.expires_in <= 0 || !Number.isSafeInteger(v.interval) || v.interval <= 0 || v.interval > 900) throw new GitHubRequestError('invalid-response')
        const expiresAt = started + Math.min(v.expires_in * 1000, 900_000)
        let interval = Math.max(1000, v.interval * 1000)
        waiting(v.user_code, expiresAt)
        while (!controller.signal.aborted && now() < expiresAt && now() >= started) {
          await wait(Math.min(interval, expiresAt - now()), controller.signal)
          if (controller.signal.aborted) return 'cancelled'
          if (now() >= expiresAt || now() < started) return 'expired'
          const r = await options.request('/login/oauth/access_token', { client_id: options.clientId, device_code: v.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }, undefined, controller.signal)
          if (controller.signal.aborted) return 'cancelled'
          if (now() >= expiresAt || now() < started) return 'expired'
          if (r.error) {
            if (r.error === 'authorization_pending' || r.error === 'slow_down') { if (r.error === 'slow_down') interval += 5000; interval = Math.max(interval, Number.isSafeInteger(r.interval) && r.interval > 0 ? Math.min(r.interval, 900) * 1000 : 0, Number.isFinite(r._retryAfter) ? r._retryAfter : 0); continue }
            return r.error === 'access_denied' ? 'denied' : ['expired_token', 'token_expired', 'expired_device_code'].includes(r.error) ? 'expired' : 'invalid-response'
          }
          const pair = tokenPair(r, now()), user = verifiedUser(await options.request('/user', undefined, pair.accessToken, controller.signal))
          if (controller.signal.aborted || now() >= expiresAt) return 'cancelled'
          await commit(pair, user)
          return controller.signal.aborted ? 'cancelled' : 'connected'
        }
        return controller.signal.aborted ? 'cancelled' : 'expired'
      } catch (e) { return controller.signal.aborted ? 'cancelled' : e instanceof GitHubRequestError && e.code === 'invalid-response' ? 'invalid-response' : 'offline' }
    },
  }
}

// Which deployment is on the account (sharing ticket 02, rule R2). The one place that decides
// whether the Worker named `writeflex-sharing` is the sharing service this Mac set up.
//
// Two parts:
//   probeService(...)   `GET <address>/version`, no credential. Three answers only:
//                         sharing(build)  200, JSON object, service "writeflex-sharing", a build >= 1
//                         foreign         200, JSON object that names another service (or none)
//                         unknown         anything else: not 200, network error, timeout, not JSON,
//                                         not an object, our name without a usable build
//   judgeIdentity(...)  the four answers, from the probe and what Cloudflare lists:
//                         ours      sharing(build), build is one this Mac can account for (the one it
//                                   recorded, or the one it sent in an upload), this Mac holds its key
//                                   AND Cloudflare lists that key's name on the Worker
//                         replaced  sharing(build) and any of those does not hold
//                         foreign   the probe answered as something else
//                         unknown   the probe was inconclusive, or the key list could not be read
// An inconclusive read is never `ours`. The address probed is built by the caller from the account's
// CURRENT workers.dev subdomain, read from Cloudflare just before (sharing-setup.ts `identify`).
//
// No Electron import.
import { readCapped, within } from './cloudflare-api'
import { SHARING_SERVICE_NAME } from '../../sharing-service/version.ts'

export type Probe = { kind: 'sharing'; build: number } | { kind: 'foreign' } | { kind: 'unknown'; why: string }

/** The service's own answer at `url` (`…/version`). Never throws; never sends a credential. */
export async function probeService(fetcher: typeof fetch, url: string, timeoutMs: number): Promise<Probe> {
  let text: string | null
  try {
    text = await within(async (signal) => {
      const response = await fetcher(url, { method: 'GET', signal, redirect: 'error', headers: { accept: 'application/json' } })
      if (response.status !== 200) { await response.body?.cancel().catch(() => {}); return null }
      return readCapped(response, 4096)
    }, timeoutMs)
  } catch {
    return { kind: 'unknown', why: 'The sharing service did not answer.' }
  }
  if (text === null) return { kind: 'unknown', why: 'The sharing service did not answer with its build.' }
  let reply: unknown
  try { reply = JSON.parse(text) } catch { return { kind: 'unknown', why: 'The sharing service\'s answer could not be read.' } }
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return { kind: 'unknown', why: 'The sharing service\'s answer could not be read.' }
  const { service, build } = reply as { service?: unknown; build?: unknown }
  if (service !== SHARING_SERVICE_NAME) return { kind: 'foreign' }
  if (!Number.isSafeInteger(build) || (build as number) < 1) return { kind: 'unknown', why: 'The sharing service did not say which build it is.' }
  return { kind: 'sharing', build: build as number }
}

export type IdentityKind = 'ours' | 'replaced' | 'foreign' | 'unknown'
/** `build`: what the service answered (null when it did not say). `why`: one plain sentence, for Details. */
export type Identity = { kind: IdentityKind; build: number | null; why: string }

export type IdentityEvidence = {
  probe: Probe
  /** Builds this Mac can account for: the one it recorded and the one it sent in an upload. */
  accountable: ReadonlyArray<number | null>
  /** This Mac holds a key for this account's service. */
  keyHeld: boolean
  /** Cloudflare lists this Mac's key name on the Worker; null: the list could not be read. */
  keyListed: boolean | null
}

export function judgeIdentity(evidence: IdentityEvidence): Identity {
  const { probe } = evidence
  if (probe.kind === 'foreign') return { kind: 'foreign', build: null, why: 'Something other than WriteFlex\'s sharing service answers at its address.' }
  if (probe.kind === 'unknown') return { kind: 'unknown', build: null, why: probe.why }
  const build = probe.build
  if (evidence.keyListed === null) return { kind: 'unknown', build, why: 'The service\'s keys could not be read.' }
  const accountable = evidence.accountable.filter((value): value is number => typeof value === 'number')
  if (!accountable.includes(build)) {
    const recorded = accountable.length ? `this Mac set up build ${accountable.join(' or ')}` : 'this Mac recorded no build'
    return { kind: 'replaced', build, why: `The sharing service answers as build ${build}; ${recorded}.` }
  }
  if (!evidence.keyHeld) return { kind: 'replaced', build, why: 'This Mac holds no key for the sharing service.' }
  if (!evidence.keyListed) return { kind: 'replaced', build, why: 'This Mac\'s key is not among the service\'s keys.' }
  return { kind: 'ours', build, why: 'The sharing service this Mac set up.' }
}

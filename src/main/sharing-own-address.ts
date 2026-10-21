// Your own address (sharing ticket 05; spec docs/plans/spec-writeflex-sharing-and-reader-notes-
// 2026-10-14.md sections 4.1, 6.1 rows "No domain attached" to "Domain removed or lapsed", 8 "Own
// address"). A user who holds a domain on the same Cloudflare account as the sharing service picks it
// and types a name in front of it (`drafts` on `writeflex.app`); WriteFlex attaches the sharing service
// there as a Workers Custom Domain. sharing-setup.ts calls in here inside its one-at-a-time queue and
// supplies the context (the token, the account, the record, the requests); nothing here holds a secret.
//
// THE RULE (review round 2; sharing-service/README-sharing-service.md "Own address"):
//   New and copied links use the own address only while a token-backed ownership confirmation
//   (Cloudflare's Custom Domains list names the hostname for writeflex-sharing on the recorded zone,
//   and that zone is active on our account) is younger than OWN_ADDRESS_TRUST_MS (24 hours), and the
//   address's latest /version answered as the sharing service. Otherwise links use the workers.dev
//   address. A /version answer is never proof; saved state is never authority; an 'unknown'
//   confirmation does not refresh the timestamp.
// One function applies it: linksAddressNow(record, now). Every path that makes a link, copies a link,
// shows a copyable link address or hands link addresses to a window goes through it (sharing-setup.ts
// status() and serviceAccess(), and through serviceAccess the publisher's link views). Copy link asks
// main at the moment of copying (`sharing:copy-address`), never the window's last view; a view showing
// the own address carries the instant trust ends (linksAddressUntil), and the page reads it again then
// (review round 3).
//
// The rules that serve it:
//   O1 What the window sends is untrusted: the name in front must be one DNS label (letters, digits,
//      hyphens; no dot), the domain plain lower-case labels; anything else is refused before any request.
//   O2 Refused with the reason BEFORE any change at Cloudflare: a domain on another account (found by
//      name among the zones the token can see, and its account is not the service's), a domain this
//      token cannot reach on the account, a domain that is not active, a name already in use (a Worker
//      Custom Domain for another Worker, or any DNS record at that name), and a token that cannot read
//      the domain's Custom Domains or DNS. The name in front is used for sharing alone: it must have
//      nothing at it before, so a reader page never shares a name with another site.
//   O3 The record is saved before the attach request (attachedAt null) and put back as it was only on
//      a definitive refusal (REFUSALS: a 4xx that denies the token or says the name is in use). Any other
//      answer (5xx, unreadable, none at all) may mean it happened, so the pending record stays (state
//      `not-attached`, OWN_NO_ANSWER) and a later Try again (the attach sent again: a Custom Domain
//      already there for the sharing service is taken as attached, not as a name in use) or Remove own
//      address finds it. Success only on proof: ownershipOf must answer 'yes',
//      which is also the first confirmation (O7).
//   O4 Readiness: the own address must have answered as the sharing service at
//      `https://<name>.<domain>/version` (answeredAt) and not have stopped since (lapsed, O5). The
//      workers.dev address is never switched off, so links sent on it still open; an own address
//      replaced by another is left attached (`earlier`).
//   O5 Lapsed: an own address that answered before and now does not, twice, while the workers.dev
//      address does, is flagged; links use the workers.dev address until it answers again. Flagging
//      needs no token: it only ever moves links AWAY from the own address.
//   O6 Remove own address takes off only Custom Domains that Cloudflare lists for the sharing service
//      at those hostnames: never one that points at another Worker. As soon as the current one is
//      confirmed off, links stop using it (ownAddress cleared, saved); the earlier ones still to take
//      off are kept in `ownAddressesLeft`, so a retry finishes them.
//   O7 Authority: `ownershipConfirmedAt`, set only when ownershipOf answers 'yes' (attach, and every
//      status check with a usable token, whichever /version probe answered and whether or not one
//      did). 'no' moves links away at once: the timestamp is cleared, and an address that answered
//      before is flagged lapsed. 'unknown' (an answer that cannot be read, a domain the token cannot
//      see, no usable token) changes nothing: the old timestamp stays, and once it is older than
//      OWN_ADDRESS_TRUST_MS links use the workers.dev address until a 'yes' (state `unconfirmed`).
//      After a restart the saved timestamp is the only thing carried over: fresh, the own address may
//      be used; missing or stale, nothing is trusted until a check confirms it (state `checking`).
//      No credential is ever sent to the own address: the probe carries none, and every request with
//      a key or owner token goes to the workers.dev address.
//
// No Electron import.
import { answeredInNumbers, deniedFor, type Answer, type OutgoingRequest } from './cloudflare-api'
import { isHostname, type OwnAddressRecord, type SharingRecord } from './sharing-record'
import type { Probe } from './sharing-identity'
import {
  OFFLINE, OWN_DOMAIN_SHAPE, OWN_LACKS_DNS, OWN_LACKS_ROUTES, OWN_NAME_SHAPE, OWN_NAME_TAKEN, OWN_NO_DOMAINS, OWN_NOT_ACTIVE, OWN_NOT_ON_ACCOUNT,
  OWN_NO_ANSWER, OWN_NOT_REMOVED, OWN_OTHER_ACCOUNT, OWN_REMOVED_NOTICE, OWN_UNCONFIRMED, SETTINGS_NOT_SAVED, ownAttachedNotice, ownWaitingText,
  type OwnAddressState, type SharingProblem,
} from '../shared/sharing-setup'

// ── O1: what may be asked for ──────────────────────────────────────────────────────────────────

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** The name in front as typed: one label, lower-cased; null when it is not one. */
export function ownName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim().toLowerCase()
  return LABEL.test(name) ? name : null
}

/** A domain as picked: plain lower-case labels, no trailing dot; null otherwise. */
export function ownDomain(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 253) return null
  const domain = value.trim().toLowerCase()
  return isHostname(domain) ? domain : null
}

/** `drafts` + `writeflex.app` → `drafts.writeflex.app`, or null when the whole is not a hostname. */
export function ownHostname(name: string, domain: string): string | null {
  const hostname = `${name}.${domain}`
  return isHostname(hostname) ? hostname : null
}

// ── Link addresses ──────────────────────────────────────────────────────────────────────────────

export const hostnameOf = (own: Pick<OwnAddressRecord, 'name' | 'domain'>): string => `${own.name}.${own.domain}`
export const originOf = (hostname: string): string => `https://${hostname}`

/** How long one token-backed ownership confirmation lets links use the own address (THE RULE). */
export const OWN_ADDRESS_TRUST_MS = 24 * 60 * 60 * 1000

/** The time of the last 'yes' (ms), or null when there is none or it is unreadable. */
function confirmedAt(own: OwnAddressRecord): number | null {
  if (own.ownershipConfirmedAt === null) return null
  const at = Date.parse(own.ownershipConfirmedAt)
  return Number.isFinite(at) ? at : null
}

/**
 * THE RULE, for one record at `now`: ready (attached, answered, not lapsed: O4, O5) and confirmed with
 * the token less than OWN_ADDRESS_TRUST_MS ago. A confirmation dated after `now` (the clock went back,
 * or the file was edited) is not trusted: the next check confirms again.
 */
export function ownTrusted(own: OwnAddressRecord, now: number): boolean {
  if (own.lapsed || own.attachedAt === null || own.answeredAt === null) return false
  const at = confirmedAt(own)
  return at !== null && at <= now && now - at < OWN_ADDRESS_TRUST_MS
}

/**
 * What the window shows of the own address. `unconfirmed`: the last status check could not confirm it
 * with Cloudflare (sharing-setup.ts keeps that in memory, per hostname).
 */
export function ownState(own: OwnAddressRecord, now: number, unconfirmed = false): OwnAddressState['state'] {
  if (own.lapsed) return 'lapsed'
  // Asked for and never confirmed attached: not `waiting`, which says Cloudflare has it (O3).
  if (own.attachedAt === null) return 'not-attached'
  if (own.answeredAt === null) return 'waiting'
  if (ownTrusted(own, now)) return 'attached'
  return unconfirmed ? 'unconfirmed' : 'checking'
}

export function ownAddressView(own: OwnAddressRecord | null, now: number, unconfirmed = false): OwnAddressState | null {
  if (!own) return null
  return { hostname: hostnameOf(own), name: own.name, domain: own.domain, state: ownState(own, now, unconfirmed), earlier: [...own.earlier] }
}

/**
 * THE RULE: the address new and copied links use at `now`. The own address only while ownTrusted;
 * otherwise the address Cloudflare gives the account (`record.address`), which is never switched off.
 * Null when sharing has no address. The one place this is decided.
 */
export function linksAddressNow(record: Pick<SharingRecord, 'address' | 'ownAddress'>, now: number): string | null {
  if (record.address === null) return null
  return record.ownAddress && ownTrusted(record.ownAddress, now) ? originOf(hostnameOf(record.ownAddress)) : record.address
}

/**
 * The instant (ms) THE RULE stops letting links use the own address, when they use it at `now`: the
 * last confirmation plus OWN_ADDRESS_TRUST_MS. Null when links do not use it. A window showing the own
 * address reads its view again at this instant (review round 3: the shown address never outlives trust).
 */
export function linksAddressUntil(record: Pick<SharingRecord, 'address' | 'ownAddress'>, now: number): number | null {
  if (record.address === null || !record.ownAddress || !ownTrusted(record.ownAddress, now)) return null
  return confirmedAt(record.ownAddress)! + OWN_ADDRESS_TRUST_MS
}

/** A link's address: `<address>/s/<share id>`. */
export const linkAddress = (address: string, shareId: string): string => `${address}/s/${shareId}`

// ── What is asked of Cloudflare, and what is kept of each answer ─────────────────────────────────

type Zone = { id: string; name: string; status: string; accountId: string | null }
type CustomDomain = { id: string; hostname: string; service: string; zoneId: string | null }

const ZONE_ID = /^[A-Za-z0-9_-]{1,64}$/
const DOMAIN_ID = /^[A-Za-z0-9_-]{1,64}$/

export function pickZones(result: unknown): Zone[] | null {
  if (!Array.isArray(result)) return null
  return result.slice(0, 50).flatMap((entry): Zone[] => {
    const zone = entry as { id?: unknown; name?: unknown; status?: unknown; account?: { id?: unknown } | null } | null
    if (!zone || typeof zone.id !== 'string' || !ZONE_ID.test(zone.id) || !isHostname(zone.name)) return []
    const accountId = typeof zone.account?.id === 'string' ? zone.account.id : null
    return [{ id: zone.id, name: zone.name, status: typeof zone.status === 'string' ? zone.status : 'unknown', accountId }]
  })
}

export function pickCustomDomains(result: unknown): CustomDomain[] | null {
  if (!Array.isArray(result)) return null
  return result.slice(0, 100).flatMap((entry): CustomDomain[] => {
    const domain = entry as { id?: unknown; hostname?: unknown; service?: unknown; zone_id?: unknown } | null
    if (!domain || typeof domain.id !== 'string' || !DOMAIN_ID.test(domain.id) || typeof domain.hostname !== 'string') return []
    return [{
      id: domain.id, hostname: domain.hostname.toLowerCase(), service: typeof domain.service === 'string' ? domain.service : '',
      zoneId: typeof domain.zone_id === 'string' ? domain.zone_id : null,
    }]
  })
}

const pickCount = (result: unknown): { count: number } | null => (Array.isArray(result) ? { count: result.length } : null)
const pickAny = (): true => true

export const zonesByNameRequest = (domain: string): OutgoingRequest => ({ method: 'GET', path: `/zones?name=${domain}&per_page=50` })
export const zonesOnAccountRequest = (accountId: string, page: number): OutgoingRequest => ({ method: 'GET', path: `/zones?account.id=${accountId}&status=active&per_page=50&page=${page}` })
export const customDomainsRequest = (accountId: string, hostname: string): OutgoingRequest => ({ method: 'GET', path: `/accounts/${accountId}/workers/domains?hostname=${hostname}` })
export const dnsRecordsRequest = (zoneId: string, hostname: string): OutgoingRequest => ({ method: 'GET', path: `/zones/${zoneId}/dns_records?name=${hostname}&per_page=5` })
export function attachRequest(accountId: string, hostname: string, scriptName: string, zoneId: string): OutgoingRequest {
  return { method: 'PUT', path: `/accounts/${accountId}/workers/domains`, contentType: 'application/json', body: JSON.stringify({ environment: 'production', hostname, service: scriptName, zone_id: zoneId }) }
}
export const detachRequest = (accountId: string, domainId: string): OutgoingRequest => ({ method: 'DELETE', path: `/accounts/${accountId}/workers/domains/${domainId}` })

/** Cloudflare's numbers for a hostname that already has DNS records, or a Custom Domain elsewhere. */
const NAME_IN_USE_CODES = [100116, 100117]
/**
 * O3: the answers to an attach that are a definitive refusal, so nothing was attached and the record is
 * put back: a 4xx that denies the token, a conflict, or a name-in-use code. Anything else keeps it pending.
 */
export function refusedOutright(answer: Answer<unknown>): boolean {
  if (answer.http === null || answer.http < 400 || answer.http > 499) return false
  return deniedFor(answer) || answer.kind === 'conflict' || answer.codes.some((code) => NAME_IN_USE_CODES.includes(code))
}
/** At most this many pages of the account's domains are listed for the picker. */
const ZONE_PAGES = 4

// ── The work ────────────────────────────────────────────────────────────────────────────────────

export type OwnAddressContext = {
  token: string
  accountId: string
  accountName: string
  scriptName: string
  /** The address Cloudflare gives the account (`https://writeflex-sharing.<subdomain>.workers.dev`). */
  cloudflareAddress: string
  request<Result>(outgoing: OutgoingRequest, pick: (result: unknown) => Result | null): Promise<Answer<Result>>
  /** `GET <origin>/version`, no credential. */
  probe(origin: string): Promise<Probe>
  record(): SharingRecord
  save(next: SharingRecord): boolean
  now(): number
}

export type OwnOutcome = { ok: true; notice?: string } | { ok: false; problem: SharingProblem; details?: string }

const failed = (problem: SharingProblem, answer?: Answer<unknown>, what?: string): OwnOutcome =>
  ({ ok: false, problem, ...(answer && what ? { details: `${what}: ${answeredInNumbers(answer)}.` } : {}) })

/** The domains on the account the token can reach, active ones only, for the picker. */
export async function listDomains(context: OwnAddressContext): Promise<{ ok: true; domains: string[] } | { ok: false; problem: SharingProblem; details?: string }> {
  const names = new Set<string>()
  for (let page = 1; page <= ZONE_PAGES; page += 1) {
    const answer = await context.request(zonesOnAccountRequest(context.accountId, page), pickZones)
    if (answer.kind === 'unreachable') return { ok: false, problem: OFFLINE, details: `Listing your domains: ${answeredInNumbers(answer)}.` }
    if (answer.kind !== 'ok' || !answer.result) return { ok: false, problem: OWN_NO_DOMAINS(context.accountName), details: `Listing your domains: ${answeredInNumbers(answer)}.` }
    for (const zone of answer.result) if (zone.status === 'active' && (zone.accountId === null || zone.accountId === context.accountId)) names.add(zone.name)
    if (answer.result.length < 50) break
  }
  if (names.size === 0) return { ok: false, problem: OWN_NO_DOMAINS(context.accountName) }
  return { ok: true, domains: [...names].sort() }
}

/** O2: the zone for `domain` on the service's account, or why it cannot be used. Reads only. */
async function zoneFor(context: OwnAddressContext, domain: string): Promise<{ ok: true; zone: Zone } | { ok: false; outcome: OwnOutcome }> {
  const byName = await context.request(zonesByNameRequest(domain), pickZones)
  if (byName.kind === 'unreachable') return { ok: false, outcome: failed(OFFLINE, byName, 'Looking up the domain') }
  if (byName.kind !== 'ok' || !byName.result) {
    return { ok: false, outcome: failed(deniedFor(byName) ? OWN_NO_DOMAINS(context.accountName) : OWN_NOT_ON_ACCOUNT(domain, context.accountName), byName, 'Looking up the domain') }
  }
  const named = byName.result.filter((zone) => zone.name === domain)
  const mine = named.find((zone) => zone.accountId === context.accountId)
  if (!mine) {
    if (named.length > 0) return { ok: false, outcome: failed(OWN_OTHER_ACCOUNT(domain, context.accountName)) }
    // Not found: not on this account, or the token reaches no domain here at all.
    const any = await context.request(zonesOnAccountRequest(context.accountId, 1), pickZones)
    const none = any.kind === 'ok' && any.result !== null && any.result.length === 0
    return { ok: false, outcome: failed(none ? OWN_NO_DOMAINS(context.accountName) : OWN_NOT_ON_ACCOUNT(domain, context.accountName)) }
  }
  if (mine.status !== 'active') return { ok: false, outcome: failed(OWN_NOT_ACTIVE(domain)) }
  return { ok: true, zone: mine }
}

/** The Custom Domains Cloudflare lists at `hostname`. */
function customDomainsAt(context: OwnAddressContext, hostname: string): Promise<Answer<CustomDomain[]>> {
  return context.request(customDomainsRequest(context.accountId, hostname), pickCustomDomains)
}

/** Attach `<name>.<domain>` to the sharing service (O1 to O4). The record must be `ready`. */
export async function attachOwnAddress(context: OwnAddressContext, nameInput: unknown, domainInput: unknown): Promise<OwnOutcome> {
  // O1.
  const name = ownName(nameInput)
  if (!name) return failed(OWN_NAME_SHAPE)
  const domain = ownDomain(domainInput)
  if (!domain) return failed(OWN_DOMAIN_SHAPE)
  const hostname = ownHostname(name, domain)
  if (!hostname) return failed(OWN_NAME_SHAPE)
  const before = context.record()
  const previous = before.ownAddress
  // Already attached here and in use, or attached and still waiting: nothing to do. In use but not
  // confirmed lately (THE RULE): the attach runs again, and its proof is the new confirmation.
  if (previous && hostnameOf(previous) === hostname && previous.attachedAt !== null && !previous.lapsed
    && (previous.answeredAt === null || ownTrusted(previous, context.now()))) {
    return { ok: true, ...(previous.answeredAt !== null ? {} : { notice: ownWaitingText(hostname) }) }
  }

  // O2: every refusal before any change.
  const found = await zoneFor(context, domain)
  if (!found.ok) return found.outcome
  const { zone } = found
  const existing = await customDomainsAt(context, hostname)
  if (existing.kind !== 'ok' || !existing.result) {
    if (deniedFor(existing)) return failed(OWN_LACKS_ROUTES(domain), existing, 'Reading the domain\'s Worker addresses')
    return failed(existing.kind === 'unreachable' ? OFFLINE : OWN_UNCONFIRMED(hostname), existing, 'Reading the domain\'s Worker addresses')
  }
  const atName = existing.result.filter((entry) => entry.hostname === hostname)
  if (atName.some((entry) => entry.service !== context.scriptName)) return failed(OWN_NAME_TAKEN(hostname, domain))
  const already = atName.some((entry) => entry.service === context.scriptName)
  if (!already) {
    const records = await context.request(dnsRecordsRequest(zone.id, hostname), pickCount)
    if (records.kind !== 'ok' || !records.result) {
      if (deniedFor(records)) return failed(OWN_LACKS_DNS(domain), records, 'Reading the domain\'s DNS')
      return failed(records.kind === 'unreachable' ? OFFLINE : OWN_UNCONFIRMED(hostname), records, 'Reading the domain\'s DNS')
    }
    if (records.result.count > 0) return failed(OWN_NAME_TAKEN(hostname, domain))
  }

  // O3: the record first, then the attach.
  const earlier = previous && previous.attachedAt !== null && !previous.lapsed && hostnameOf(previous) !== hostname
    ? [...previous.earlier, hostnameOf(previous)] : previous?.earlier ?? []
  const pending: OwnAddressRecord = { name, domain, zoneId: zone.id, attachedAt: null, answeredAt: null, lapsed: false, ownershipConfirmedAt: null, earlier: [...new Set(earlier)].filter((entry) => entry !== hostname).slice(-20) }
  const latest = context.record()
  if (!context.save({ ...latest, ownAddress: pending, ownAddressesLeft: latest.ownAddressesLeft.filter((entry) => entry !== hostname) })) return failed(SETTINGS_NOT_SAVED)
  if (!already) {
    const attached = await context.request(attachRequest(context.accountId, hostname, context.scriptName, zone.id), pickAny)
    if (attached.kind !== 'ok') {
      // Any answer short of a refusal (5xx, unreadable, none): it may have happened, so the pending
      // record stays for Try again or Remove own address (O3), and the window says so (OWN_NO_ANSWER).
      if (!refusedOutright(attached)) return failed(OWN_NO_ANSWER(hostname), attached, 'Attaching the address')
      // Refused outright: as it was, with the reason.
      context.save({ ...context.record(), ownAddress: previous })
      if (deniedFor(attached)) return failed(OWN_LACKS_ROUTES(domain), attached, 'Attaching the address')
      return failed(OWN_NAME_TAKEN(hostname, domain), attached, 'Attaching the address')
    }
  }
  // The proof is the ownership confirmation itself (O7): the Custom Domain on the recorded zone, for
  // the sharing service, and that zone active on this account. Anything short of 'yes': still pending.
  const at = context.now()
  if (await ownershipOf(context, pending) !== 'yes') return failed(OWN_UNCONFIRMED(hostname))
  const seen = await context.probe(originOf(hostname))
  const answering = seen.kind === 'sharing'
  const attachedRecord: OwnAddressRecord = { ...pending, attachedAt: at, answeredAt: answering ? at : null, ownershipConfirmedAt: new Date(at).toISOString() }
  if (!context.save({ ...context.record(), ownAddress: attachedRecord })) return failed(SETTINGS_NOT_SAVED)
  return { ok: true, notice: answering ? ownAttachedNotice(hostname) : ownWaitingText(hostname) }
}

/** O6: take the Custom Domains Cloudflare lists for the sharing service at `hostname` off it. */
async function detachAt(context: OwnAddressContext, hostname: string, inUse: boolean): Promise<OwnOutcome> {
  const domain = hostname.split('.').slice(1).join('.')
  const listed = await customDomainsAt(context, hostname)
  if (listed.kind !== 'ok' || !listed.result) {
    if (deniedFor(listed)) return failed(OWN_LACKS_ROUTES(domain), listed, 'Reading the domain\'s Worker addresses')
    return failed(listed.kind === 'unreachable' ? OFFLINE : OWN_NOT_REMOVED(hostname, inUse), listed, 'Reading the domain\'s Worker addresses')
  }
  for (const entry of listed.result.filter((item) => item.hostname === hostname && item.service === context.scriptName)) {
    const removed = await context.request(detachRequest(context.accountId, entry.id), pickAny)
    if (removed.kind !== 'ok' && removed.kind !== 'missing') {
      if (deniedFor(removed)) return failed(OWN_LACKS_ROUTES(domain), removed, 'Removing the address')
      return failed(removed.kind === 'unreachable' ? OFFLINE : OWN_NOT_REMOVED(hostname, inUse), removed, 'Removing the address')
    }
  }
  return { ok: true }
}

/**
 * O6: take every own address off the sharing service: the current one first, then those left attached
 * (`earlier`) and any an earlier Remove did not finish (`ownAddressesLeft`).
 */
export async function removeOwnAddress(context: OwnAddressContext): Promise<OwnOutcome> {
  const own = context.record().ownAddress
  if (!own && context.record().ownAddressesLeft.length === 0) return { ok: true }
  if (own) {
    const hostname = hostnameOf(own)
    const done = await detachAt(context, hostname, ownTrusted(own, context.now()))
    if (!done.ok) return done
    // Confirmed off: links stop using it now; the earlier ones are kept apart for a retry to finish.
    const latest = context.record()
    const left = [...new Set([...latest.ownAddressesLeft, ...(latest.ownAddress ?? own).earlier])].filter((entry) => entry !== hostname)
    if (!context.save({ ...latest, ownAddress: null, ownAddressesLeft: left })) return failed(SETTINGS_NOT_SAVED)
  }
  for (const hostname of [...context.record().ownAddressesLeft]) {
    const done = await detachAt(context, hostname, false)
    if (!done.ok) return done
    const latest = context.record()
    if (!context.save({ ...latest, ownAddressesLeft: latest.ownAddressesLeft.filter((entry) => entry !== hostname) })) return failed(SETTINGS_NOT_SAVED)
  }
  return { ok: true, notice: OWN_REMOVED_NOTICE }
}

/** O7: what Cloudflare says of an own address. `unknown`: it could not be read, or the token cannot see the domain. */
export type Ownership = 'yes' | 'no' | 'unknown'

/**
 * O7: Cloudflare's own word, read with the token, that `own` is the sharing service's on this account:
 * the account's Custom Domains list names the hostname for the sharing service's script on the zone
 * recorded at attach, and that zone is active on this account. Reads only.
 */
export async function ownershipOf(context: OwnAddressContext, own: OwnAddressRecord): Promise<Ownership> {
  const hostname = hostnameOf(own)
  const listed = await customDomainsAt(context, hostname)
  if (listed.kind !== 'ok' || !listed.result) return 'unknown'
  if (!listed.result.some((entry) => entry.hostname === hostname && entry.service === context.scriptName && entry.zoneId === own.zoneId)) return 'no'
  const byName = await context.request(zonesByNameRequest(own.domain), pickZones)
  if (byName.kind !== 'ok' || !byName.result) return 'unknown'
  const named = byName.result.filter((zone) => zone.name === own.domain)
  const recorded = named.find((zone) => zone.id === own.zoneId)
  if (recorded) {
    if (recorded.accountId === null) return 'unknown'
    return recorded.accountId === context.accountId && recorded.status === 'active' ? 'yes' : 'no'
  }
  // The domain is there under another zone (re-added, or on another account): not the one attached.
  return named.length > 0 ? 'no' : 'unknown'
}

export type RecheckPorts = {
  /** `GET <origin>/version`, no credential. */
  probe(origin: string): Promise<Probe>
  /** The workers.dev address's answer. */
  cloudflareSeen(): Promise<Probe>
  /** O7, with the token; null when this Mac cannot ask Cloudflare (no usable token): taken as 'unknown'. */
  confirm: ((own: OwnAddressRecord) => Promise<Ownership>) | null
  now: number
}

/** A recheck's outcome: the record to save (null: nothing changed), and what Cloudflare said. */
export type Recheck = { record: OwnAddressRecord | null; ownership: Ownership }

/**
 * O4, O5 and O7, on one status check: is the own address answering, and does Cloudflare, read with the
 * token, still say it is the sharing service's? Ownership is asked every time an own address is
 * configured, whichever /version probe answered and whether one did (review round 2, finding 1).
 *   'yes'     the timestamp is refreshed; a first answer, or an answer after lapsed, makes it ready.
 *   'no'      links move away at once: the timestamp is cleared; an address that answered before is
 *             flagged lapsed.
 *   'unknown' nothing is refreshed (finding 2): the old timestamp ages out under THE RULE.
 * A lapse is still flagged from the service's reads alone (O5): that only ever moves links away.
 */
export async function recheckOwnAddress(own: OwnAddressRecord, ports: RecheckPorts): Promise<Recheck> {
  const origin = originOf(hostnameOf(own))
  const answeredBefore = own.answeredAt !== null && !own.lapsed
  let seen = await ports.probe(origin)
  // One retry for an address that answered before, so one dropped answer does not flag it (O5).
  if (seen.kind !== 'sharing' && answeredBefore) seen = await ports.probe(origin)
  const ownership: Ownership = ports.confirm ? await ports.confirm(own) : 'unknown'
  let next: OwnAddressRecord = own
  if (ownership === 'no') {
    next = { ...own, ownershipConfirmedAt: null, lapsed: own.lapsed || own.answeredAt !== null }
  } else {
    if (ownership === 'yes') next = { ...next, ownershipConfirmedAt: new Date(ports.now).toISOString() }
    // Cloudflare lists it for the sharing service: attached after all (an attach that got no clear
    // answer landed), so `not-attached` becomes `waiting` until it answers.
    if (ownership === 'yes' && own.attachedAt === null) next = { ...next, attachedAt: ports.now }
    if (seen.kind === 'sharing') {
      // The answer alone proves nothing: only with Cloudflare's 'yes' does it become ready (again).
      if (ownership === 'yes' && (own.attachedAt === null || own.answeredAt === null || own.lapsed)) {
        next = { ...next, attachedAt: own.attachedAt ?? ports.now, answeredAt: ports.now, lapsed: false }
      }
    } else if (answeredBefore) {
      const cloudflare = await ports.cloudflareSeen()
      if (cloudflare.kind === 'sharing') next = { ...next, lapsed: true }
    }
  }
  return { record: JSON.stringify(next) === JSON.stringify(own) ? null : next, ownership }
}

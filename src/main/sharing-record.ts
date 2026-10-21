// What WriteFlex remembers about sharing in settings.json (sharing ticket 02). NEVER a secret: the
// token and this Mac's key live in the secrets store (secrets-store.ts) and nowhere else. This record
// is how set-up is never asked for again on a Mac once done, and how an interrupted set-up resumes.
//
// `stage`:
//   checked      the token was accepted (it is in the Keychain); no account chosen yet
//   chosen       an account was chosen; Set up sharing not yet pressed
//   installing   Set up sharing was pressed and did not finish (resumed by pressing it again)
//   ready        set-up finished: `address` and `build` are the service's
//   removing     a removal was confirmed and saved BEFORE anything was deleted (rule R1). With
//                `serviceDeleted` the service is gone from Cloudflare and only this Mac's clean-up (its
//                key, the token, this record) is left; without it, the deletion itself may not have
//                happened. Either way Retry finishes it, in this app or a fresh one
//
// `wrote`: set-up wrote at Cloudflare on `account` (the code, the workers.dev switch or this Mac's
// key). An interrupted set-up that wrote is bound to that account: it is finished there, or removed,
// never left behind by choosing another account.
//
// `build` is the build this Mac recorded: the service's when set up, or the one found on the account
// when an interrupted set-up joined it. `sentBuild` is the build this Mac sent in an upload whose
// outcome is not recorded yet. Both are builds this Mac can account for (sharing-identity.ts).
//
// No Electron import.
import type { SharingAccount } from '../shared/sharing-setup'

export type SharingStage = 'checked' | 'chosen' | 'installing' | 'ready' | 'removing'
export type SharingRecord = {
  stage: SharingStage
  /** When Cloudflare last accepted the token (ms). */
  tokenAcceptedAt: number | null
  /** Cloudflare refused the saved token at the last check or request. */
  tokenRejected: boolean
  accounts: SharingAccount[]
  account: { id: string; name: string } | null
  address: string | null
  build: number | null
  setUpAt: number | null
  wrote: boolean
  sentBuild: number | null
  /** Stage `removing` only: the service is known to be gone from the account. */
  serviceDeleted: boolean
  /** Ticket 05: your own address (sharing-own-address.ts); null when none. */
  ownAddress: OwnAddressRecord | null
  /**
   * Ticket 05 (review round 1, finding 4): own addresses a Remove own address has not finished taking
   * off. The current one leaves `ownAddress` as soon as Cloudflare confirms it detached, so links stop
   * using it at once; the earlier ones wait here until a retry finishes them.
   */
  ownAddressesLeft: string[]
}

/**
 * Your own address as kept. `attachedAt` null: an attach was sent and Cloudflare's answer was not seen
 * (it may have happened). `answeredAt`: when it last answered as the sharing service; null until it
 * first does (no link has used it yet). `lapsed`: it answered before and no longer does.
 */
export type OwnAddressRecord = {
  name: string
  domain: string
  zoneId: string
  attachedAt: number | null
  answeredAt: number | null
  lapsed: boolean
  /**
   * Review round 2: when Cloudflare last confirmed, read with the token, that this address is the
   * sharing service's (sharing-own-address.ts ownershipOf answered 'yes'), as an ISO time; null when
   * never, or when Cloudflare last said no. Set only by a 'yes'. Links use the own address only while
   * it is younger than OWN_ADDRESS_TRUST_MS (sharing-own-address.ts linksAddressNow).
   */
  ownershipConfirmedAt: string | null
  /** Own addresses attached before this one, left attached so links sent on them still open. */
  earlier: string[]
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const ZONE_ID = /^[A-Za-z0-9_-]{1,64}$/
/** A hostname of plain lower-case labels, at most 253 characters, at least two labels. */
export const isHostname = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 253 && value.split('.').length >= 2 && value.split('.').every((label) => LABEL.test(label)) && !/^\d+$/.test(value.split('.').at(-1)!)

function readOwnAddress(value: unknown): OwnAddressRecord | null {
  const r = value as Partial<OwnAddressRecord> | null
  if (!r || typeof r !== 'object' || typeof r.name !== 'string' || !LABEL.test(r.name) || !isHostname(r.domain) || typeof r.zoneId !== 'string' || !ZONE_ID.test(r.zoneId)) return null
  if (!isHostname(`${r.name}.${r.domain}`)) return null
  return {
    name: r.name,
    domain: r.domain,
    zoneId: r.zoneId,
    attachedAt: isTime(r.attachedAt) ? r.attachedAt : null,
    answeredAt: isTime(r.answeredAt) ? r.answeredAt : null,
    lapsed: r.lapsed === true,
    ownershipConfirmedAt: isIsoTime(r.ownershipConfirmedAt) ? r.ownershipConfirmedAt : null,
    earlier: Array.isArray(r.earlier) ? r.earlier.filter(isHostname).slice(0, 20) : [],
  }
}

const STAGES: readonly string[] = ['checked', 'chosen', 'installing', 'ready', 'removing']
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/
const ADDRESS = /^https:\/\/[a-z0-9-]{1,63}\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev$/
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
/** An ISO time as `Date.prototype.toISOString` writes it. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const isIsoTime = (value: unknown): value is string => typeof value === 'string' && ISO_TIME.test(value) && Number.isFinite(Date.parse(value))
const isName = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 80

function readAccount(value: unknown): SharingAccount | null {
  const account = value as Partial<SharingAccount> | null
  if (!account || typeof account !== 'object' || typeof account.id !== 'string' || !ACCOUNT_ID.test(account.id) || !isName(account.name)) return null
  const address = typeof account.address === 'string' && ADDRESS.test(account.address) ? account.address : null
  return { id: account.id, name: account.name, workers: account.workers === true, address }
}

/** The record as settings.json held it, or null when there is none or it is not one. */
export function readSharingRecord(raw: unknown): SharingRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.stage !== 'string' || !STAGES.includes(r.stage)) return null
  const chosen = r.account as { id?: unknown; name?: unknown } | null | undefined
  const account = chosen && typeof chosen === 'object' && typeof chosen.id === 'string' && ACCOUNT_ID.test(chosen.id) && isName(chosen.name)
    ? { id: chosen.id, name: chosen.name } : null
  const record: SharingRecord = {
    stage: r.stage as SharingStage,
    tokenAcceptedAt: isTime(r.tokenAcceptedAt) ? r.tokenAcceptedAt : null,
    tokenRejected: r.tokenRejected === true,
    accounts: Array.isArray(r.accounts) ? r.accounts.slice(0, 200).map(readAccount).filter((entry): entry is SharingAccount => entry !== null) : [],
    account,
    address: typeof r.address === 'string' && ADDRESS.test(r.address) ? r.address : null,
    build: Number.isSafeInteger(r.build) && (r.build as number) >= 1 ? r.build as number : null,
    setUpAt: isTime(r.setUpAt) ? r.setUpAt : null,
    wrote: r.wrote === true,
    sentBuild: Number.isSafeInteger(r.sentBuild) && (r.sentBuild as number) >= 1 ? r.sentBuild as number : null,
    serviceDeleted: r.stage === 'removing' && r.serviceDeleted === true,
    ownAddress: readOwnAddress(r.ownAddress),
    ownAddressesLeft: Array.isArray(r.ownAddressesLeft) ? [...new Set(r.ownAddressesLeft.filter(isHostname))].slice(0, 40) : [],
  }
  // A stage that needs what is missing reads as the stage before it.
  if (record.stage !== 'checked' && record.stage !== 'removing' && !record.account) record.stage = 'checked'
  if (record.stage === 'ready' && (!record.address || !record.build)) record.stage = 'installing'
  return record
}

export const emptySharingRecord = (): SharingRecord => ({
  stage: 'checked', tokenAcceptedAt: null, tokenRejected: false, accounts: [], account: null, address: null, build: null, setUpAt: null, wrote: false, sentBuild: null, serviceDeleted: false, ownAddress: null, ownAddressesLeft: [],
})

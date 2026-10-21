// What the set-up of sharing looks like from the window (sharing ticket 02). The main process
// (src/main/sharing-setup.ts) decides; this file holds the shapes it answers in, the permission list
// and the fixed sentences. Nothing here is a secret, and no status ever carries the token or a key.

/** One permission the Cloudflare token needs, as Cloudflare's token page names it. */
export type SharingPermission = { scope: 'Account' | 'Zone'; name: string; level: 'Edit' | 'Read'; purpose: string; optional: boolean }

/**
 * The token's permissions, in the order the set-up lists them (frame `setup`). The two Zone rows are
 * only for an own address (ticket 05). Workers KV Storage is not asked for: the sharing service keeps
 * shares in Durable Objects, which Workers Scripts · Edit covers.
 */
export const SHARING_PERMISSIONS: readonly SharingPermission[] = [
  { scope: 'Account', name: 'Workers Scripts', level: 'Edit', purpose: 'installs the sharing service', optional: false },
  { scope: 'Account', name: 'Account Settings', level: 'Read', purpose: 'finds your account', optional: false },
  { scope: 'Zone', name: 'Workers Routes', level: 'Edit', purpose: 'own address only', optional: true },
  { scope: 'Zone', name: 'DNS', level: 'Edit', purpose: 'own address only', optional: true },
]

export const permissionLabel = (permission: SharingPermission): string => `${permission.scope} · ${permission.name} · ${permission.level}`
export const WORKERS_PERMISSION = permissionLabel(SHARING_PERMISSIONS[0])
export const ACCOUNTS_PERMISSION = permissionLabel(SHARING_PERMISSIONS[1])

/** The list as one plain text, for Copy the list. */
export function permissionListText(): string {
  return SHARING_PERMISSIONS.map((permission) => `${permissionLabel(permission)}${permission.optional ? ' (own address only)' : ''}`).join('\n')
}

/** Where Open Cloudflare goes: the page where API tokens are made. */
export const CLOUDFLARE_TOKENS_PAGE = 'https://dash.cloudflare.com/profile/api-tokens'

/** A problem with a reason and what to do about it, both plain sentences. */
export type SharingProblem = { reason: string; fix: string }

/** An account the token can see, and whether the token may install the sharing service there. */
export type SharingAccount = {
  id: string
  name: string
  /** The token reaches Workers on this account. False: it lacks Workers Scripts there. */
  workers: boolean
  /** The address links will use (`https://writeflex-sharing.<subdomain>.workers.dev`), when the account has one. */
  address: string | null
}

/** The service as installed on the account. */
export type SharingServiceState = {
  /** The build the service answers with on `/version`; null when it did not answer. */
  installedBuild: number | null
  /** The build this WriteFlex carries. */
  appBuild: number
  /** `update`: older than this WriteFlex. `newer`: put there by a newer WriteFlex. */
  compare: 'current' | 'update' | 'newer' | 'unknown'
}

export type SharingSetupStatus = {
  /** Set-up finished on this Mac: Share works without asking again. */
  ready: boolean
  /** Secure storage refuses writes on this Mac: set-up cannot keep the token. */
  storageUnavailable: boolean
  token: {
    /** A token is kept in the Keychain. */
    stored: boolean
    /** When Cloudflare last accepted it (ms). */
    acceptedAt: number | null
    /** Cloudflare refused it at the last check or request. */
    problem: SharingProblem | null
  }
  /** The accounts the token can see, from the last check. Empty when none is known. */
  accounts: SharingAccount[]
  /** The account chosen (step 3), with its name. */
  account: { id: string; name: string } | null
  /** The address links use, once set up. */
  address: string | null
  /** Set-up was started and did not finish (it is resumed by pressing Set up sharing again). */
  interrupted: boolean
  /** The interrupted set-up already wrote on `account`: it is finished there or removed, never moved to another account. */
  accountLocked: boolean
  /** Remove took the service off the account, and this Mac's clean-up (key, token, record) did not all finish. */
  removalPending: boolean
  /** Only once set up: the service on the account. */
  service: SharingServiceState | null
  setUpAt: number | null
  /** Ticket 05: your own address, when one is attached (or being attached). */
  ownAddress: OwnAddressState | null
  /** Own addresses a Remove own address has not finished taking off (still attached; Remove again finishes them). */
  ownAddressesLeft: string[]
  /**
   * The address new and copied links use (sharing-own-address.ts linksAddressNow): the own address only
   * while Cloudflare's confirmation is fresh and it answers; else `address`. The only copyable address.
   */
  linksAddress: string | null
}

/**
 * Your own address (ticket 05; spec 4.1, 6.1, 8). `attached`: it answers as your sharing service, and
 * new and copied links use it. `waiting`: Cloudflare confirmed it attached, not answering yet (Cloudflare
 * is still preparing it); links use the Cloudflare address until it does. `not-attached`: WriteFlex asked
 * Cloudflare to attach it and never had it confirmed (the attach got no clear answer: a timeout, a network
 * failure, a 5xx, an unreadable reply), so it may or may not be attached; Try again sends the attach again
 * and finishes it, and links use the Cloudflare address until then. `lapsed`: it answered before and no
 * longer does while the Cloudflare address still answers (the domain was removed or lapsed): links
 * sent on it no longer open. `checking` (review round 2): it answered before, and WriteFlex has not
 * confirmed with Cloudflare within the last day (after a restart, or a check still to come); new links
 * use the Cloudflare address until it does. `unconfirmed`: the same, and the last check could not
 * confirm it with Cloudflare (the token cannot read it, or Cloudflare did not answer). The hostname is
 * shown as the address configured, never as an address to copy.
 */
export type OwnAddressState = {
  /** `drafts.writeflex.app` */
  hostname: string
  /** The name in front: `drafts`. */
  name: string
  /** The domain on the account: `writeflex.app`. */
  domain: string
  state: 'attached' | 'waiting' | 'not-attached' | 'lapsed' | 'checking' | 'unconfirmed'
  /** Own addresses attached before this one and left attached, so links sent on them still open. */
  earlier: string[]
}

/** What `sharing:domains` answers: the domains on the chosen account that the token can reach. */
export type SharingDomainsResult = { ok: true; domains: string[] } | { ok: false; problem: SharingProblem; details?: string }
/** What `sharing:attach-address` takes. Both are untrusted: main checks them before any request. */
export type AttachAddressRequest = { name: string; domain: string }

// ── Own address: the fixed sentences ────────────────────────────────────────────────────────────

const ZONE_ROUTES = 'Zone · Workers Routes · Edit'
const ZONE_DNS = 'Zone · DNS · Edit'
const CARRY_ON = 'Sharing carries on with the earlier address.'

export const OWN_NAME_SHAPE: SharingProblem = {
  reason: 'That name in front cannot be used.',
  fix: 'Use one word of letters, digits and hyphens, with no dots, for example drafts.',
}
export const OWN_DOMAIN_SHAPE: SharingProblem = {
  reason: 'That is not a domain name.',
  fix: 'Choose a domain from the list.',
}
export const OWN_NO_DOMAINS = (account: string): SharingProblem => ({
  reason: `This token cannot see any domain on ${account}.`,
  fix: `For your own address the domain must be on this Cloudflare account, and the token needs “${ZONE_ROUTES}” and “${ZONE_DNS}” for it. Replace the token in Settings › Sharing, or carry on with the address Cloudflare gives your account.`,
})
export const cannotAttach = (domain: string, why: string, what: string): SharingProblem => ({
  reason: `${domain} cannot be attached.`,
  fix: `${why} ${what}`,
})
export const OWN_OTHER_ACCOUNT = (domain: string, account: string): SharingProblem => cannotAttach(domain,
  `It is on another Cloudflare account, not on ${account}. Your own address must be a domain on the same account as your sharing service.`,
  `Choose a domain on ${account}. ${CARRY_ON}`)
export const OWN_NOT_ON_ACCOUNT = (domain: string, account: string): SharingProblem => cannotAttach(domain,
  `It is not a domain on ${account} that this token can reach.`,
  `Add the domain to this Cloudflare account, or give the token “${ZONE_ROUTES}” and “${ZONE_DNS}” for it. ${CARRY_ON}`)
export const OWN_NOT_ACTIVE = (domain: string): SharingProblem => cannotAttach(domain,
  'Cloudflare does not serve it yet: the domain is not active on the account.',
  `Finish adding the domain in Cloudflare, then try again. ${CARRY_ON}`)
export const OWN_NAME_TAKEN = (hostname: string, domain: string): SharingProblem => cannotAttach(domain,
  `${hostname} is already in use: something else on your account answers at that name.`,
  `Choose another name in front, for example share. ${CARRY_ON}`)
export const OWN_LACKS_DNS = (domain: string): SharingProblem => cannotAttach(domain,
  `Your token cannot change DNS for this domain; it lacks “${ZONE_DNS}”.`,
  'Replace the token with one that has it, or carry on with the address Cloudflare gives your account and add your own address later in Settings.')
export const OWN_LACKS_ROUTES = (domain: string): SharingProblem => cannotAttach(domain,
  `Your token cannot attach your sharing service to this domain; it lacks “${ZONE_ROUTES}” or “${ZONE_DNS}”.`,
  'Replace the token with one that has both, or carry on with the address Cloudflare gives your account and add your own address later in Settings.')
export const OWN_UNCONFIRMED = (hostname: string): SharingProblem => ({
  reason: `WriteFlex asked Cloudflare to attach ${hostname} but could not confirm that it did.`,
  fix: `Press Try again in a minute. ${CARRY_ON}`,
})
/**
 * The attach request got no clear answer (a timeout, a network failure, a 5xx, an unreadable reply): it
 * may or may not have happened. A refusal keeps its own reason (OWN_LACKS_ROUTES, OWN_NAME_TAKEN).
 */
export const OWN_NO_ANSWER = (hostname: string): SharingProblem => ({
  reason: `Cloudflare did not answer in time when WriteFlex asked it to attach ${hostname}, so it may or may not have been attached.`,
  fix: 'Press Try again: WriteFlex checks with Cloudflare and finishes attaching it. New links use the address Cloudflare gives your account until then.',
})
/** `inUse`: new links use this address now (the current one, answering); otherwise they never do. */
export const OWN_NOT_REMOVED = (hostname: string, inUse: boolean): SharingProblem => ({
  reason: `${hostname} could not be taken off your sharing service.`,
  fix: inUse ? 'Try again. New links keep using it until it is removed.' : 'Try again. New links do not use it.',
})
/** The flag on the Sharing page and in Settings when the own address no longer answers. */
export const ownLapsedText = (hostname: string): string =>
  `Links on ${hostname} no longer open: the address does not reach your sharing service any more (the domain was removed from Cloudflare, or it lapsed). New links use the address Cloudflare gives your account.`
export const ownWaitingText = (hostname: string): string =>
  `${hostname} is attached. Cloudflare is still preparing it, which usually takes a few minutes; links use the address Cloudflare gives your account until it answers.`
/** State `not-attached`: asked for, never confirmed attached. `where`: where Try again is (Settings › Sharing, from the Sharing page). */
export const ownNotAttachedText = (hostname: string, where: 'here' | 'settings' = 'here'): string =>
  `${hostname} is not attached yet. Cloudflare did not answer in time when WriteFlex asked it to attach the address, so it may or may not have been attached. Press Try again${where === 'settings' ? ' in Settings › Sharing' : ''} to check and finish it. New links use the address Cloudflare gives your account until then.`
/** Review round 2: the own address is configured, and Cloudflare has not confirmed it within the last day yet. */
export const ownCheckingText = (hostname: string): string =>
  `Checking ${hostname} with Cloudflare. New links use the address Cloudflare gives your account until it is confirmed.`
/** Review round 2: the last check could not confirm the own address with Cloudflare, and the last confirmation is over a day old. */
export const ownUnconfirmedText = (hostname: string): string =>
  `WriteFlex could not confirm ${hostname} with Cloudflare. New links use the address Cloudflare gives your account until it can. Check again, or replace the token if it cannot read this domain's Worker addresses.`
export const ownAttachedNotice = (hostname: string): string => `Links now read ${hostname}. Links sent on the earlier address still open.`
export const OWN_REMOVED_NOTICE = 'Your own address was removed. New links use the address Cloudflare gives your account.'

export type SharingResult =
  | { ok: true; status: SharingSetupStatus; notice?: string }
  /**
   * `removeAnyway`: Remove stopped because the service is not one this Mac can confirm as its own; only
   * an explicit Remove anyway deletes it, with `anywayConfirmation`, which main issued with this answer
   * and bound to the service as it was just found.
   */
  | { ok: false; status: SharingSetupStatus; problem: SharingProblem; details?: string; removeAnyway?: true; anywayConfirmation?: string }

/** What `sharing:remove` takes: a confirmation main issued to this window. What it may delete is bound to it in main. */
export type SharingRemoveRequest = { confirmation: string }
/** What `sharing:removal-confirmation` answers: the confirmation and the account the question names (null: nothing to remove). */
export type SharingRemovalQuestion = { confirmation: string; accountName: string | null; retry: boolean } | { confirmation: null }

// ── The fixed sentences ─────────────────────────────────────────────────────────────────────────

export const TOKEN_SHAPE: SharingProblem = {
  reason: 'This is not a Cloudflare API token.',
  fix: 'A token is one line of letters, digits and punctuation with no spaces. Copy it again from Cloudflare and paste it here.',
}
export const TOKEN_REJECTED: SharingProblem = {
  reason: 'Cloudflare did not accept this token.',
  fix: 'Check that you copied all of it, or make a new token in Cloudflare and paste it here.',
}
export const TOKEN_EXPIRED: SharingProblem = {
  reason: 'This token has expired or was turned off in Cloudflare.',
  fix: 'Make a new token in Cloudflare with the permissions listed, and paste it here.',
}
/** A token that worked before and is now refused (frame `problems`, Token rejected). */
export const SAVED_TOKEN_REJECTED: SharingProblem = {
  reason: 'Cloudflare no longer accepts the saved token; it may have expired. Links keep working, but nothing is published and no notes are collected until you paste a new one.',
  fix: 'Paste a new token.',
}
export const missingPermission = (permission: string): SharingProblem => ({
  reason: `The token is missing the permission “${permission}”.`,
  fix: 'Open the token in Cloudflare, add that permission, save it, and paste it again.',
})
export const NO_ACCOUNTS: SharingProblem = missingPermission(ACCOUNTS_PERMISSION)
export const NO_WORKERS_ACCOUNT: SharingProblem = missingPermission(WORKERS_PERMISSION)
export const NO_WORKERS_ADDRESS: SharingProblem = {
  reason: 'This Cloudflare account has no workers.dev address yet, so links would have nowhere to point.',
  fix: 'Open Workers & Pages in Cloudflare once and choose a workers.dev subdomain, then press Check again.',
}
export const OFFLINE: SharingProblem = {
  reason: 'WriteFlex could not reach Cloudflare.',
  fix: 'Check that this Mac is online, then try again.',
}
export const NO_TOKEN: SharingProblem = { reason: 'There is no Cloudflare token on this Mac yet.', fix: 'Paste a token first.' }
export const NOT_LISTED: SharingProblem = { reason: 'That account is not one this token can see.', fix: 'Choose an account from the list.' }
export const STORAGE_UNAVAILABLE: SharingProblem = {
  reason: 'This Mac\'s secure storage is unavailable, so the token cannot be kept.',
  fix: 'Unlock the login Keychain, then try again.',
}
export const SETUP_FAILED: SharingProblem = { reason: 'The sharing service could not be set up.', fix: 'Try again. Your token and account are kept.' }
export const INSTALLATION_PROBLEM: SharingProblem = {
  reason: 'This WriteFlex installation is incomplete, so sharing cannot be set up.',
  fix: 'Install WriteFlex again.',
}
export const APP_OLDER: SharingProblem = {
  reason: 'Your sharing service was installed by a newer WriteFlex than this one.',
  fix: 'Update WriteFlex on this Mac. Links keep working.',
}
export const NOT_ANSWERING: SharingProblem = {
  reason: 'The sharing service was installed but does not answer at its address yet.',
  fix: 'Wait a minute, then press Set up sharing again. Nothing is sent twice.',
}
export const KEY_NOT_ADDED: SharingProblem = { reason: 'This Mac could not be added to the sharing service.', fix: 'Try again.' }
export const SETTINGS_NOT_SAVED: SharingProblem = { reason: 'WriteFlex could not save its settings, so set-up is not finished.', fix: 'Check that the disk is not full, then try again.' }
export const REMOVE_FAILED: SharingProblem = { reason: 'The sharing service could not be removed from your Cloudflare account.', fix: 'Try again. Nothing on this Mac was changed.' }
export const NOT_SET_UP: SharingProblem = { reason: 'Sharing is not set up on this Mac.', fix: 'Set up sharing first.' }
export const REMOVE_NOT_CONFIRMED: SharingProblem = { reason: 'Removing sharing was not confirmed, so nothing was removed.', fix: 'Press Remove sharing from this account again and confirm.' }
export const SERVICE_CHANGED: SharingProblem = {
  reason: 'The sharing service on your account is not the one this Mac set up: another Mac or a newer WriteFlex has replaced it since. Nothing was removed.',
  fix: 'Remove it anyway only if you mean to stop sharing for every Mac on this account.',
}
export const SERVICE_UNCONFIRMED: SharingProblem = {
  reason: 'WriteFlex could not confirm that the sharing service on your account is the one this Mac set up: it did not answer clearly. Nothing was removed.',
  fix: 'Try again in a minute. Remove it anyway only if you mean to stop sharing for every Mac on this account.',
}
export const REMOVAL_TARGET_CHANGED: SharingProblem = {
  reason: 'Sharing on your Cloudflare account changed after you were asked, so nothing was removed.',
  fix: 'Press Remove sharing again to see what is there now.',
}
export const REMOVAL_NOT_SAVED: SharingProblem = {
  reason: 'WriteFlex could not save its settings, so nothing was removed.',
  fix: 'Check that the disk is not full, then try again.',
}
/** The deletion went through (or the service was already gone) but the record of it could not be saved: nothing on this Mac is cleared. */
export const REMOVAL_DONE_NOT_SAVED: SharingProblem = {
  reason: 'The sharing service is gone from your Cloudflare account, but WriteFlex could not save that. Nothing else was changed.',
  fix: 'Press Retry.',
}
/** A removal that did not finish, with no token on this Mac to finish it with. */
export const REMOVAL_NEEDS_TOKEN: SharingProblem = {
  reason: 'Finishing the removal needs a working Cloudflare token, and there is none on this Mac.',
  fix: 'Use Replace token in Settings › Sharing to paste a working token, then press Retry.',
}
export const REMOVAL_PENDING: SharingProblem = {
  reason: 'Removing sharing from your Cloudflare account did not finish.',
  fix: 'Press Retry in Settings › Sharing.',
}
export const accountLocked = (name: string): SharingProblem => ({
  reason: `Set-up on ${name} did not finish, and WriteFlex had already started installing the sharing service there.`,
  fix: `Press Set up sharing to finish on ${name}. To use another account, remove sharing from ${name} in Settings › Sharing first.`,
})
export const OVERWRITTEN_OLDER: SharingProblem = {
  reason: 'Another Mac replaced the sharing service at the same moment, with an older WriteFlex.',
  fix: 'Press Set up sharing again on this Mac.',
}
export const OVERWRITTEN_NEWER: SharingProblem = {
  reason: 'Another Mac replaced the sharing service at the same moment, with a newer WriteFlex than this one.',
  fix: 'Update WriteFlex on this Mac. Links keep working.',
}
export const OVERWRITTEN: SharingProblem = {
  reason: 'Another Mac replaced the sharing service at the same moment.',
  fix: 'Press Set up sharing again on this Mac.',
}
/** After an upload, Cloudflare did not show it running within the wait (rule R5): never reported as success. */
export const UPLOAD_UNCONFIRMED: SharingProblem = {
  reason: 'WriteFlex uploaded the sharing service but could not confirm yet that Cloudflare is running it.',
  fix: 'Press Check again in a minute.',
}
export const BUSY: SharingProblem = { reason: 'Set-up is already running.', fix: 'Wait for it to finish.' }

/** Said after a set-up that found the service already on the account (a second Mac). */
export const JOINED_NOTICE = 'The sharing service was already on this account. This Mac has been added to it.'
export const UPDATED_NOTICE = 'The sharing service was updated. Links kept working throughout.'

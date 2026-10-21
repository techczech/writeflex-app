// Setting up sharing, once (sharing ticket 02; spec docs/plans/spec-writeflex-sharing-and-reader-
// notes-2026-10-14.md sections 4.1, 6.1 and 8). The one module that decides the set-up: the IPC
// (sharing-ipc.ts) is a thin caller that supplies the ports. Ported in shape from TalkWeaver's
// live-service-deploy.ts and cloudflare-connection.ts, cut down to what sharing needs.
//
// Interface (every call answers a SharingSetupStatus, never the token or a key):
//   status()          what the window shows; asks the service its build only when set up
//   checkToken(t)     step 2: check a pasted token at Cloudflare; kept in the Keychain only if accepted
//   checkSavedToken() Settings › Check token: the kept token, again
//   chooseAccount(id) step 3
//   setUp()           Set up sharing, and Update: install or update the service, add this Mac's key
//   remove(target)    Remove sharing from this account: delete the service and everything in it,
//                     under the rules below, for the target a confirmation was bound to (R3)
//   removalTarget()   the removal the record stands for now (what a confirmation is bound to)
//   serviceAccess()   main process only (ticket 03): where the service is, the address links use and
//                     this Mac's key. Ticket 05: status() and serviceAccess() give link addresses only
//                     through linksAddressNow (sharing-own-address.ts, THE RULE): the own address only
//                     while Cloudflare's confirmation, read with the token, is under a day old
//   domains()         ticket 05: the domains on the chosen account the token can reach (own address)
//   attachAddress(n, d) ticket 05: attach `<n>.<d>` to the service (sharing-own-address.ts, O1 to O4)
//   removeAddress()   ticket 05: take the own address off the service (O6)
//
// The set-up, in order (setUp):
//   0. the shipped bundle is checked against its manifest; a mismatch is "This WriteFlex
//      installation is incomplete" and NOTHING is sent;
//   1. the token (Keychain) and the chosen account; this Mac's key slot must be readable;
//   2. reads: the script as deployed (whether it exists; its migration tag) and the account's
//      workers.dev subdomain (the address). When the script exists, the build the service answers
//      on `/version` (sharing-identity.ts probeService). No answer at all: the workers.dev switch
//      alone is sent again (a first set-up that stopped between its two requests leaves exactly
//      that) and the build is asked for again. A newer build, a migration tag this build does not
//      list, or something else answering, stops here: nothing is sent;
//   3. this Mac's key for this account, STORED in the Keychain before anything is written at
//      Cloudflare (the one held, or a new one);
//   4. the record: `wrote`, the build found and the build about to be sent, so a removal can
//      account for them (R2);
//   5. the code, only when there is no service yet or it is older than this WriteFlex's (Update):
//      the script and its workers.dev switch; no secret, no domain or route;
//   6. R5, success only on proof: after an upload, Cloudflare's own list of deployments must show the
//      version this upload made as the one serving all traffic (judgeDeployment). Another version
//      that is not the one from before: another Mac's upload landed over this one, said so. Anything
//      else when the wait is over (the old version still serving included): "could not confirm yet",
//      Check again. Read before step 7, because a secret change makes a new version at Cloudflare;
//   7. this Mac's key added (`PATCH …/secrets-bulk`, merge-patch: every other Mac's key stays), and
//      its name read back from the Worker's list of secrets; after an upload, the address is asked
//      once more, and another build answering there is reported as overwritten (OVERWRITTEN_*);
//   8. the record in settings: ready, with the address and build. From then on set-up is not asked
//      for again on this Mac.
// Every step can be repeated: a set-up stopped anywhere is resumed by pressing Set up sharing again,
// and a second Mac on an account that already has the service only adds its own key (step 7). The
// record is marked `wrote` before the first write at Cloudflare; from then on an interrupted set-up
// is bound to its account (chooseAccount refuses another) until it is finished or removed.
//
// Remove (remove), the same from set up, from an interrupted set-up that wrote, and from Retry:
//   R3  the target confirmed must be the target now (sharing-removal.ts targetChanged), or nothing
//       is deleted;
//   1.  the service is looked up; gone already: nothing is deleted at Cloudflare;
//   R2  identity (identify → sharing-identity.ts judgeIdentity), from the account's CURRENT
//       workers.dev subdomain: ours is deleted; replaced or unknown is asked about (Remove it anyway,
//       bound to that answer); foreign is never deleted (decideRemoval);
//   R1  the record becomes `removing` and is read back BEFORE the deletion and before anything on
//       this Mac is cleared (beginRemoval); a failed save stops here with nothing deleted;
//   2.  `DELETE …?force=true`. Refused by Cloudflare: the record goes back to what it was; no answer
//       at all (it may have happened): the record stays `removing`, for Retry;
//   3.  `serviceDeleted` saved and read back (beginRemoval again); not saved: nothing is cleared, and
//       Retry finds the service absent and finishes. Then this Mac's key, the token, then the record
//       (finishRemoval, which clears nothing unless the record read back says `removing` with
//       `serviceDeleted`). A step that fails leaves `removing`, which the window shows with Retry, in
//       this app or after a restart. A `removing` record with no token on this Mac: REMOVAL_NEEDS_TOKEN.
//
// The token goes to Cloudflare's API in the Authorization header (cloudflare-api.ts `send`) and
// nowhere else: never to the sharing service, never into settings, a log, an error or a status.
// Requests to the sharing service itself (`GET /version`) carry no credential at all.
//
// One operation at a time: calls queue behind each other.
//
// No Electron import.
import {
  ask, answeredInNumbers, deniedFor, listAccounts, pickVerify, send, validAccountId, validCloudflareToken, within, readCapped,
  REQUEST_TIMEOUT_MS, UPLOAD_TIMEOUT_MS, type Answer, type OutgoingRequest, type RequestPort,
} from './cloudflare-api'
import { SecretsError, type SecretsStore } from './secrets-store'
import { verifySharingServiceBundle, type ShippedFiles } from './sharing-service-bundle'
import {
  UnknownMigrationTagError, addKeyBody, addKeyRequest, computerSecretName, listSecretsRequest, migrationsToApply, newAdminKey, newComputerId,
  planSharingServiceUpload, removeServiceRequest, validComputerId, workersDevAddress, workersDevRequest, type PlannedRequest,
  deploymentsRequest, judgeDeployment, pickLatestDeployment, pickUploadedVersion, type DeploymentJudgement,
} from './sharing-service-upload'
import { emptySharingRecord, type SharingRecord } from './sharing-record'
import { judgeIdentity, probeService, type Identity, type Probe } from './sharing-identity'
import { anywayTarget, decideRemoval, removalTargetOf, targetChanged, type RemovalTarget } from './sharing-removal'
import {
  attachOwnAddress, hostnameOf, linksAddressNow, linksAddressUntil, listDomains, ownAddressView, ownershipOf, recheckOwnAddress, removeOwnAddress, type OwnAddressContext, type OwnOutcome,
} from './sharing-own-address'
import { SHARING_SERVICE_BUILD, SHARING_SERVICE_NAME } from '../../sharing-service/version.ts'
import {
  APP_OLDER, BUSY, OVERWRITTEN, OVERWRITTEN_NEWER, OVERWRITTEN_OLDER, REMOVAL_DONE_NOT_SAVED, REMOVAL_NEEDS_TOKEN, REMOVAL_NOT_SAVED, REMOVAL_PENDING, REMOVAL_TARGET_CHANGED, SERVICE_CHANGED, SERVICE_UNCONFIRMED, UPLOAD_UNCONFIRMED, accountLocked, INSTALLATION_PROBLEM, JOINED_NOTICE, KEY_NOT_ADDED, NO_ACCOUNTS, NO_TOKEN, NO_WORKERS_ACCOUNT, NO_WORKERS_ADDRESS,
  NOT_ANSWERING, NOT_LISTED, NOT_SET_UP, OFFLINE, REMOVE_FAILED, SAVED_TOKEN_REJECTED, SETTINGS_NOT_SAVED, SETUP_FAILED, STORAGE_UNAVAILABLE,
  TOKEN_EXPIRED, TOKEN_REJECTED, TOKEN_SHAPE, UPDATED_NOTICE,
  type SharingAccount, type SharingDomainsResult, type SharingProblem, type SharingResult, type SharingServiceState, type SharingSetupStatus,
} from '../shared/sharing-setup'

/** How long a set-up waits for the service to answer as the expected build. */
export const SERVICE_WAIT_MS = 60_000
export const SERVICE_REQUEST_MS = 10_000
const POLL_PAUSES_MS: readonly number[] = [500, 1000, 1500, 2000, 3000, 5000]
/** At most this many accounts are asked whether the token reaches Workers there. */
export const ACCOUNTS_PROBED = 20
/** How much of a failure's details is kept. */
export const DETAILS_CHARS = 600

export const NOT_OURS: SharingProblem = {
  reason: `A Worker named ${SHARING_SERVICE_NAME} on this account is not WriteFlex's sharing service, so WriteFlex will not replace it.`,
  fix: 'Rename or delete that Worker in Cloudflare, then press Set up sharing again.',
}
export const OTHER_ACCOUNT: SharingProblem = {
  reason: 'This token cannot install on the account sharing is set up on.',
  fix: 'Make the new token on that account, or remove sharing first.',
}

/** This Mac's key for one sharing service, as kept in the `sharing-keys` slot. */
export type StoredKey = { accountId: string; scriptName: string; computerId: string; key: string }
const KEY_BLOB_FORMAT = 1

export function readKeyBlob(text: string | null): StoredKey[] {
  if (text === null) return []
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error('keys-unreadable') }
  const blob = parsed as { format?: unknown; entries?: unknown } | null
  if (!blob || blob.format !== KEY_BLOB_FORMAT || !Array.isArray(blob.entries)) throw new Error('keys-unreadable')
  return blob.entries.flatMap((entry) => {
    const e = entry as Partial<StoredKey> | null
    return e && validAccountId(e.accountId) && typeof e.scriptName === 'string' && validComputerId(e.computerId) && typeof e.key === 'string' && e.key.length >= 16
      ? [{ accountId: e.accountId, scriptName: e.scriptName, computerId: e.computerId, key: e.key }] : []
  })
}
export const keyBlob = (entries: readonly StoredKey[]): string => JSON.stringify({ format: KEY_BLOB_FORMAT, entries })

export interface SharingSetupPorts {
  secrets: SecretsStore
  /** settings.json's sharing record (SettingsStore.sharingRecord / setSharingRecord). */
  record: { read(): SharingRecord | null; write(record: SharingRecord | null): boolean }
  /** The shipped sharing-service-dist files (null for one that is not there). */
  shipped(): ShippedFiles
  /** SHARING_SERVICE_BUILD of this app. */
  expectedBuild?: number
  /** Requests to Cloudflare's API. */
  fetch: typeof fetch
  /** The API's address (cloudflareApiBase). */
  apiBase(): string
  /** Requests to the sharing service itself. */
  serviceFetch: typeof fetch
  /** Where requests for the service at `address` go: itself, or a loopback stand-in in an e2e run. */
  serviceBase?(address: string): string
  now?(): number
  /** Tests: a pause that does not really wait, and shorter limits. */
  wait?(ms: number): Promise<void>
  serviceWaitMs?: number
  timeouts?: { request: number; upload: number; service: number }
  random?: (bytes: number) => Buffer
}

/** A removal's answer; `ask`: the target a "Remove it anyway" confirmation is to be bound to (never sent to a window). */
export type RemoveOutcome = SharingResult & { ask?: RemovalTarget }

export interface SharingSetup {
  status(options?: { askService?: boolean }): Promise<SharingSetupStatus>
  checkToken(token: unknown): Promise<SharingResult>
  checkSavedToken(): Promise<SharingResult>
  chooseAccount(accountId: unknown): Promise<SharingResult>
  setUp(): Promise<SharingResult>
  /** Removes only what `target` names (R3); `ask` is set when the answer needs Remove anyway (R2). */
  remove(target: RemovalTarget): Promise<RemoveOutcome>
  removalTarget(): RemovalTarget | null
  /** `linkAddress`: the address new and copied links use (linksAddressNow: the own address only while confirmed and answering). */
  serviceAccess(): { address: string; base: string; key: string; linkAddress: string; linkAddressUntil: number | null; ownAddress: SharingSetupStatus['ownAddress'] } | null
  domains(): Promise<SharingDomainsResult>
  attachAddress(name: unknown, domain: unknown): Promise<SharingResult>
  removeAddress(): Promise<SharingResult>
}

const pickAny = (): true => true
function pickMigrationTag(result: unknown): { tag: string | null } | null {
  const script = (result as { default_environment?: { script?: { migration_tag?: unknown } } } | null)?.default_environment?.script
  if (!script || typeof script !== 'object') return null
  const tag = script.migration_tag
  return { tag: typeof tag === 'string' && tag ? tag : null }
}
function pickSubdomain(result: unknown): { subdomain: unknown } | null {
  return result && typeof result === 'object' ? { subdomain: (result as { subdomain?: unknown }).subdomain } : null
}
function pickSecretNames(result: unknown): { names: string[] } | null {
  if (!Array.isArray(result)) return null
  return { names: result.slice(0, 500).map((entry) => (entry as { name?: unknown } | null)?.name).filter((name): name is string => typeof name === 'string') }
}
/** Cloudflare's numbers for "no such Worker" and "no workers.dev subdomain". */
const NO_SUCH_WORKER = [10090, 10007]
const isAbsent = (answer: Answer<unknown>): boolean => answer.kind === 'missing' || (answer.kind === 'refused' && answer.codes.some((code) => NO_SUCH_WORKER.includes(code)))

const realWait = (ms: number): Promise<void> => new Promise((resolve) => { const timer = setTimeout(resolve, ms); (timer as { unref?: () => void }).unref?.() })

export function createSharingSetup(ports: SharingSetupPorts): SharingSetup {
  const expectedBuild = ports.expectedBuild ?? SHARING_SERVICE_BUILD
  const now = ports.now ?? Date.now
  const wait = ports.wait ?? realWait
  const limits = ports.timeouts ?? { request: REQUEST_TIMEOUT_MS, upload: UPLOAD_TIMEOUT_MS, service: SERVICE_REQUEST_MS }
  const serviceWaitMs = ports.serviceWaitMs ?? SERVICE_WAIT_MS
  const serviceBase = (address: string): string => ports.serviceBase?.(address) ?? address
  const port = (timeoutMs: number): RequestPort => ({ fetch: ports.fetch, base: ports.apiBase(), timeoutMs })

  // ── One at a time ─────────────────────────────────────────────────────────────────────────────
  let tail: Promise<unknown> = Promise.resolve()
  let running = false
  /** The operation in the queue is a status check's own-address reconciliation (short; others wait behind it, not refused). */
  let reconciling = false
  function serial<Result>(work: () => Promise<Result>): Promise<Result> {
    const next = tail.then(async () => { running = true; try { return await work() } finally { running = false } })
    tail = next.catch(() => undefined)
    return next
  }
  /** Another operation holds the queue (a reconciliation does not count: what comes next waits for it). */
  const busy = (): boolean => running && !reconciling

  /**
   * The hostname whose last token-backed check could not confirm it ('unknown', or no usable token);
   * null after a 'yes' or 'no'. Shown only, never authority: a restart forgets it (state `checking`).
   */
  let unconfirmedHost: string | null = null
  const viewOf = (own: SharingRecord['ownAddress']) => ownAddressView(own, now(), own !== null && unconfirmedHost === hostnameOf(own))

  // ── What is kept ─────────────────────────────────────────────────────────────────────────────
  const record = (): SharingRecord => ports.record.read() ?? emptySharingRecord()
  const hasRecord = (): boolean => ports.record.read() !== null
  const save = (next: SharingRecord | null): boolean => ports.record.write(next)

  function storedToken(): string | null {
    const token = ports.secrets.read('cloudflare-token')
    return token !== null && validCloudflareToken(token) ? token : null
  }
  function keys(): StoredKey[] { return readKeyBlob(ports.secrets.read('sharing-keys')) }
  function keyFor(accountId: string, scriptName: string): StoredKey | null {
    return keys().find((entry) => entry.accountId === accountId && entry.scriptName === scriptName) ?? null
  }
  /** This Mac's key for the service: the one held, or a new one stored beside the others. Throws when it cannot be stored. */
  function ownKeyFor(accountId: string, scriptName: string): StoredKey {
    const held = keys()
    const found = held.find((entry) => entry.accountId === accountId && entry.scriptName === scriptName)
    if (found) return found
    const made: StoredKey = { accountId, scriptName, computerId: newComputerId(ports.random), key: newAdminKey(ports.random) }
    ports.secrets.write('sharing-keys', keyBlob([...held, made]))
    return made
  }
  function forgetKey(accountId: string, scriptName: string): void {
    const rest = keys().filter((entry) => !(entry.accountId === accountId && entry.scriptName === scriptName))
    if (rest.length === 0) ports.secrets.clear('sharing-keys')
    else ports.secrets.write('sharing-keys', keyBlob(rest))
  }

  // ── The service's own answer ──────────────────────────────────────────────────────────────────
  /** `GET <service>/version`, no credential (sharing-identity.ts: sharing, foreign or unknown). */
  const probe = (address: string): Promise<Probe> => probeService(ports.serviceFetch, `${serviceBase(address)}/version`, limits.service)
  /** Ask until `done(probe)` or the wait is over; the last answer is returned. */
  async function probeUntil(address: string, done: (seen: Probe) => boolean): Promise<Probe> {
    const started = now()
    let seen = await probe(address)
    for (let attempt = 0; !done(seen) && now() - started < serviceWaitMs; attempt += 1) {
      await wait(POLL_PAUSES_MS[Math.min(attempt, POLL_PAUSES_MS.length - 1)])
      seen = await probe(address)
    }
    return seen
  }
  const compareOf = (build: number | null): SharingServiceState['compare'] =>
    build === null ? 'unknown' : build < expectedBuild ? 'update' : build > expectedBuild ? 'newer' : 'current'

  // ── Status ────────────────────────────────────────────────────────────────────────────────────
  async function statusOf(askService = false): Promise<SharingSetupStatus> {
    const kept = record()
    const stored = ports.secrets.has('cloudflare-token')
    const ready = kept.stage === 'ready' && stored && kept.account !== null && kept.address !== null
    const removing = kept.stage === 'removing'
    let service: SharingServiceState | null = null
    let own = ready ? kept.ownAddress : null
    let left = ready ? kept.ownAddressesLeft : []
    if (ready && kept.address) {
      let build = kept.build
      let seen: Probe | null = null
      if (askService) { seen = await probe(kept.address); build = seen.kind === 'sharing' ? seen.build : null }
      service = { installedBuild: build, appBuild: expectedBuild, compare: compareOf(build) }
      // Ticket 05 (O4, O5, O7): is the own address answering, and may links use it? Run in the one-at-a-time
      // queue with attach, change and remove (review round 1, finding 2), on the record as it is when its
      // turn comes; saved only if the own address is still the one it checked.
      const address = kept.address
      if (askService && own && !running) {
        await serial(async () => {
          reconciling = true
          try { await reconcileOwnAddress(seen, address) } finally { reconciling = false }
        }).catch(() => undefined)
        const after = record()
        if (after.stage === 'ready') { own = after.ownAddress; left = after.ownAddressesLeft }
      }
    }
    return {
      ready,
      storageUnavailable: !ports.secrets.availability().ok,
      token: { stored, acceptedAt: stored ? kept.tokenAcceptedAt : null, problem: stored && kept.tokenRejected ? SAVED_TOKEN_REJECTED : null },
      accounts: stored && !removing ? kept.accounts : [],
      account: stored || removing ? kept.account : null,
      address: ready ? kept.address : null,
      interrupted: stored && kept.stage === 'installing',
      accountLocked: stored && kept.stage === 'installing' && kept.wrote && kept.account !== null,
      removalPending: removing,
      service,
      setUpAt: ready ? kept.setUpAt : null,
      ownAddress: viewOf(own),
      ownAddressesLeft: [...left],
      linksAddress: ready ? linksAddressNow({ address: kept.address, ownAddress: own }, now()) : null,
    }
  }
  /** One reconciliation (statusOf, inside the queue). With the token when it can be read; without, links only ever move away (O7). */
  async function reconcileOwnAddress(seen: Probe | null, address: string): Promise<void> {
    const kept = record()
    const own = kept.ownAddress
    if (kept.stage !== 'ready' || !own) return
    const made = ownContext(true)
    // Ownership is asked whenever an own address is configured and the token can be read (O7).
    const checked = await recheckOwnAddress(own, {
      probe, cloudflareSeen: async () => seen ?? probe(address), now: now(),
      confirm: made.ok ? (current) => ownershipOf(made.context, current) : null,
    })
    const latest = ports.record.read()
    if (!latest || latest.stage !== 'ready' || JSON.stringify(latest.ownAddress) !== JSON.stringify(own)) return
    unconfirmedHost = checked.ownership === 'unknown' ? hostnameOf(own) : null
    if (checked.record) save({ ...latest, ownAddress: checked.record })
  }
  const succeed = async (notice?: string): Promise<SharingResult> => ({ ok: true, status: await statusOf(), ...(notice ? { notice } : {}) })
  const fail = async (problem: SharingProblem, details?: string): Promise<Extract<SharingResult, { ok: false }>> => ({
    ok: false, status: await statusOf(), problem, ...(details ? { details: details.trim().slice(-DETAILS_CHARS) } : {}),
  })

  /** The token was refused for a request: rejected outright, or lacking the Workers permission? One more read tells. */
  async function deniedProblem(token: string): Promise<SharingProblem> {
    const verified = await ask(port(limits.request), token, 'GET', '/user/tokens/verify', pickVerify)
    if (verified.kind === 'ok' && verified.result?.status === 'active') return NO_WORKERS_ACCOUNT
    if (verified.kind === 'unreachable') return OFFLINE
    markRejected(true)
    return SAVED_TOKEN_REJECTED
  }
  function markRejected(rejected: boolean, acceptedAt?: number): void {
    if (!hasRecord()) return
    const kept = record()
    save({ ...kept, tokenRejected: rejected, ...(acceptedAt !== undefined ? { tokenAcceptedAt: acceptedAt } : {}) })
  }

  /** Accept a token: verify it, list the accounts, ask each whether it reaches Workers. Sends nothing anywhere else. */
  async function examineToken(token: string): Promise<{ ok: true; accounts: SharingAccount[] } | { ok: false; problem: SharingProblem; details?: string }> {
    const verified = await ask(port(limits.request), token, 'GET', '/user/tokens/verify', pickVerify)
    if (verified.kind === 'unreachable') return { ok: false, problem: OFFLINE, details: answeredInNumbers(verified) }
    if (verified.kind !== 'ok') return { ok: false, problem: TOKEN_REJECTED, details: answeredInNumbers(verified) }
    if (verified.result?.status !== 'active') return { ok: false, problem: TOKEN_EXPIRED }
    const listed = await listAccounts(port(limits.request), token)
    if (listed.kind === 'unreachable') return { ok: false, problem: OFFLINE, details: answeredInNumbers(listed) }
    if (listed.kind !== 'ok' || !listed.result || listed.result.length === 0) return { ok: false, problem: NO_ACCOUNTS, details: answeredInNumbers(listed) }
    const accounts: SharingAccount[] = []
    for (const [index, account] of listed.result.entries()) {
      if (index >= ACCOUNTS_PROBED) { accounts.push({ ...account, workers: false, address: null }); continue }
      const subdomain = await ask(port(limits.request), token, 'GET', `/accounts/${account.id}/workers/subdomain`, pickSubdomain)
      if (subdomain.kind === 'unreachable') return { ok: false, problem: OFFLINE, details: answeredInNumbers(subdomain) }
      if (deniedFor(subdomain)) { accounts.push({ ...account, workers: false, address: null }); continue }
      const address = subdomain.kind === 'ok' ? workersDevAddress(SHARING_SERVICE_NAME, subdomain.result?.subdomain) : null
      accounts.push({ ...account, workers: subdomain.kind === 'ok' || isAbsent(subdomain), address })
    }
    if (!accounts.some((account) => account.workers)) return { ok: false, problem: NO_WORKERS_ACCOUNT }
    return { ok: true, accounts }
  }

  async function checkToken(input: unknown): Promise<SharingResult> {
    const token = typeof input === 'string' ? input.trim() : ''
    if (!validCloudflareToken(token)) return fail(TOKEN_SHAPE)
    if (!ports.secrets.availability().ok) return fail(STORAGE_UNAVAILABLE)
    // A removal whose deletion is still to come may need a new token to finish; one that only has this Mac's clean-up left does not.
    if (record().stage === 'removing' && (record().serviceDeleted || !record().account)) return fail(REMOVAL_PENDING)
    const examined = await examineToken(token)
    if (!examined.ok) return fail(examined.problem, examined.details)
    const kept = record()
    const set = kept.stage === 'ready' || kept.stage === 'installing' || kept.stage === 'removing'
    // After set-up the token is replaced in Settings; it must reach the account the service is on.
    if (set && kept.account && !examined.accounts.some((account) => account.id === kept.account?.id && account.workers)) return fail(OTHER_ACCOUNT)
    try { ports.secrets.write('cloudflare-token', token) } catch (error) {
      return fail(error instanceof SecretsError && error.code === 'unavailable' ? STORAGE_UNAVAILABLE : { reason: 'The token could not be saved on this Mac.', fix: 'Try again.' })
    }
    const usable = examined.accounts.filter((account) => account.workers)
    const still = kept.account && usable.find((account) => account.id === kept.account?.id)
    const chosen = still ? { id: still.id, name: still.name } : usable.length === 1 ? { id: usable[0].id, name: usable[0].name } : null
    const next: SharingRecord = {
      ...kept,
      stage: set ? kept.stage : chosen ? 'chosen' : 'checked',
      account: set ? kept.account : chosen,
      tokenAcceptedAt: now(),
      tokenRejected: false,
      accounts: examined.accounts,
    }
    if (!save(next)) return fail(SETTINGS_NOT_SAVED)
    return succeed()
  }

  async function checkSavedToken(): Promise<SharingResult> {
    let token: string | null
    try { token = storedToken() } catch { return fail(STORAGE_UNAVAILABLE) }
    if (!token) return fail(NO_TOKEN)
    const verified = await ask(port(limits.request), token, 'GET', '/user/tokens/verify', pickVerify)
    if (verified.kind === 'unreachable') return fail(OFFLINE, answeredInNumbers(verified))
    if (verified.kind !== 'ok' || verified.result?.status !== 'active') {
      markRejected(true)
      return fail(SAVED_TOKEN_REJECTED, verified.kind === 'ok' ? `Cloudflare reports the token as ${verified.result?.status}.` : answeredInNumbers(verified))
    }
    markRejected(false, now())
    return succeed()
  }

  async function chooseAccount(input: unknown): Promise<SharingResult> {
    if (!ports.secrets.has('cloudflare-token')) return fail(NO_TOKEN)
    const kept = record()
    if (kept.stage === 'removing') return fail(REMOVAL_PENDING)
    if (kept.stage === 'ready') return fail({ reason: 'Sharing is already set up on an account.', fix: 'Remove sharing from that account first.' })
    const account = kept.accounts.find((entry) => entry.id === input && entry.workers)
    if (!account) return fail(NOT_LISTED)
    const previous = kept.account
    const moving = previous !== null && previous.id !== account.id
    // An interrupted set-up that wrote on its account stays bound to it: switching would leave that deployment behind.
    if (moving && kept.stage === 'installing' && kept.wrote) return fail(accountLocked(previous.name))
    // Nothing was written there: the key made for that account is not needed any more.
    if (moving) { try { forgetKey(previous.id, SHARING_SERVICE_NAME) } catch { /* a stale key for an account with nothing on it is harmless */ } }
    const stage = kept.stage === 'installing' && !moving ? 'installing' : 'chosen'
    if (!save({ ...kept, stage, account: { id: account.id, name: account.name }, wrote: moving ? false : kept.wrote })) return fail(SETTINGS_NOT_SAVED)
    return succeed()
  }

  /** One request to Cloudflare with the token; the key, once known, is refused in any address. */
  function request<Result>(token: string, outgoing: OutgoingRequest, pick: (result: unknown) => Result | null, timeoutMs: number, key: StoredKey | null): Promise<Answer<Result>> {
    return send(port(timeoutMs), token, key ? { ...outgoing, forbidden: [key.key] } : outgoing, pick)
  }
  function outgoingFor(planned: PlannedRequest<string>): OutgoingRequest {
    const base = { method: planned.method, path: planned.path, ...(planned.headers ? { headers: planned.headers } : {}) }
    const body = planned.body
    if (!body) return base
    if (body.kind === 'json') return { ...base, body: JSON.stringify(body.json), contentType: body.contentType ?? 'application/json' }
    // As wrangler's createWorkerUploadForm: the metadata as a plain field, then the module as a file.
    const form = new FormData()
    form.set('metadata', JSON.stringify(body.metadata))
    form.set(body.module.name, new File([new Uint8Array(body.module.bytes)], body.module.name, { type: body.module.type }))
    return { ...base, body: form }
  }

  async function setUp(): Promise<SharingResult> {
    // 0. The shipped files, before anything is sent.
    const shipped = ports.shipped()
    const verified = verifySharingServiceBundle(shipped.manifest, { bundle: shipped.bundle, config: shipped.config }, expectedBuild)
    if (!verified.ok) return fail(INSTALLATION_PROBLEM, verified.details)
    const { config, manifest, bundle } = verified
    const scriptName = config.name

    // 1. The token, the account, and a readable key slot.
    let token: string | null
    try { token = storedToken() } catch { return fail(STORAGE_UNAVAILABLE) }
    if (!token) return fail(NO_TOKEN)
    const kept = record()
    if (kept.stage === 'removing') return fail(REMOVAL_PENDING)
    if (!kept.account) return fail({ reason: 'No Cloudflare account is chosen.', fix: 'Choose the account in step 3.' })
    const accountId = kept.account.id
    try { keys() } catch { return fail({ reason: 'This Mac\'s sharing key could not be read, so nothing was changed.', fix: 'Unlock the login Keychain, then try again.' }) }
    const wasReady = kept.stage === 'ready'
    if (!wasReady && !save({ ...kept, stage: 'installing' })) return fail(SETTINGS_NOT_SAVED)
    /** Before the first write at Cloudflare: this set-up is bound to the account (chooseAccount), and what it accounts for is kept. */
    const markWrote = (also: Partial<SharingRecord> = {}): boolean => {
      const latest = record()
      const next = { ...latest, wrote: true, ...also }
      return (Object.keys(next) as Array<keyof SharingRecord>).every((name) => next[name] === latest[name]) || save(next)
    }

    // 2. The reads.
    const service = await request(token, { method: 'GET', path: `/accounts/${accountId}/workers/services/${scriptName}` }, pickMigrationTag, limits.request, null)
    const exists = !isAbsent(service)
    if (exists && service.kind !== 'ok') {
      if (deniedFor(service)) return fail(await deniedProblem(token), `Looking up the sharing service: ${answeredInNumbers(service)}.`)
      return fail(service.kind === 'unreachable' ? OFFLINE : SETUP_FAILED, `Looking up the sharing service: ${answeredInNumbers(service)}.`)
    }
    const deployedTag = exists ? service.result?.tag ?? null : null
    try { migrationsToApply(config.migrations, deployedTag) } catch (error) {
      if (!(error instanceof UnknownMigrationTagError)) throw error
      return fail(APP_OLDER, `Cloudflare reports migration tag ${/^[A-Za-z0-9._-]{1,64}$/.test(error.tag) ? error.tag : '(not a plain name)'}; this WriteFlex knows ${config.migrations.map((migration) => migration.tag).join(', ')}.`)
    }
    const subdomain = await request(token, { method: 'GET', path: `/accounts/${accountId}/workers/subdomain` }, pickSubdomain, limits.request, null)
    if (subdomain.kind !== 'ok') {
      if (deniedFor(subdomain)) return fail(await deniedProblem(token), `Looking up the workers.dev address: ${answeredInNumbers(subdomain)}.`)
      if (isAbsent(subdomain)) return fail(NO_WORKERS_ADDRESS)
      return fail(subdomain.kind === 'unreachable' ? OFFLINE : SETUP_FAILED, `Looking up the workers.dev address: ${answeredInNumbers(subdomain)}.`)
    }
    const address = workersDevAddress(scriptName, subdomain.result?.subdomain)
    if (!address) return fail(NO_WORKERS_ADDRESS, 'The workers.dev subdomain Cloudflare reported is not a plain name.')

    let uploadDue = !exists
    let buildBefore: number | null = null
    if (exists) {
      let seen = await probe(address)
      if (seen.kind === 'foreign') return fail(NOT_OURS)
      if (seen.kind === 'unknown') {
        // The script is there and its address gives no build: send its workers.dev switch alone, then ask again.
        if (!markWrote()) return fail(SETTINGS_NOT_SAVED)
        const switched = await request(token, outgoingFor(workersDevRequest(accountId, scriptName)), pickAny, limits.request, null)
        if (switched.kind !== 'ok') {
          if (deniedFor(switched)) return fail(await deniedProblem(token), `Switching on its workers.dev address: ${answeredInNumbers(switched)}.`)
          return fail(switched.kind === 'unreachable' ? OFFLINE : SETUP_FAILED, `Switching on its workers.dev address: ${answeredInNumbers(switched)}.`)
        }
        seen = await probeUntil(address, (answer) => answer.kind !== 'unknown')
        if (seen.kind === 'foreign') return fail(NOT_OURS)
        if (seen.kind === 'unknown') return fail(NOT_ANSWERING, 'Asking the sharing service which build it is: no answer.')
      }
      if (seen.build > expectedBuild) return fail(APP_OLDER, `The sharing service answers as build ${seen.build}; this WriteFlex carries build ${expectedBuild}.`)
      uploadDue = seen.build < expectedBuild
      buildBefore = seen.build
    }

    // 3. This Mac's key, stored before anything is written at Cloudflare.
    let key: StoredKey
    try { key = ownKeyFor(accountId, scriptName) } catch {
      return fail({ reason: 'This Mac\'s sharing key could not be saved, so nothing was changed.', fix: 'Unlock the login Keychain, then try again.' })
    }

    // 4. Bound to the account, with the builds a removal can account for: the one found (an
    // interrupted first set-up that joins) and the one about to be sent.
    const sentBefore = record().sentBuild
    if (!markWrote({ ...(wasReady ? {} : { build: buildBefore }), ...(uploadDue ? { sentBuild: expectedBuild } : {}) })) return fail(SETTINGS_NOT_SAVED)

    // 5. The code, and 6. the proof that it is what runs.
    if (uploadDue) {
      const before = exists ? await liveVersions(token, accountId, scriptName, key) : { known: true, ids: [] }
      let uploaded: string | null = null
      for (const planned of planSharingServiceUpload({ config, manifest, bundle, accountId, deployedMigrationTag: deployedTag })) {
        const step = planned.step === 'upload' ? 'Uploading the sharing service' : 'Switching on its workers.dev address'
        const answer = planned.step === 'upload'
          ? await request(token, outgoingFor(planned), pickUploadedVersion, limits.upload, key)
          : await request(token, outgoingFor(planned), pickAny, limits.request, key)
        if (answer.kind === 'ok') {
          if (planned.step === 'upload') uploaded = (answer.result as { version: string | null } | null)?.version ?? null
          continue
        }
        if (deniedFor(answer)) return fail(await deniedProblem(token), `${step}: ${answeredInNumbers(answer)}.`)
        return fail(answer.kind === 'unreachable' ? OFFLINE : SETUP_FAILED, `${step}: ${answeredInNumbers(answer)}.`)
      }
      const judged = await proveUpload(token, accountId, scriptName, key, uploaded, before)
      if (judged === 'overwritten') {
        const answering = await probe(address)
        return overwritten(answering.kind === 'sharing' ? answering.build : null)
      }
      if (judged !== 'proven') {
        return fail(UPLOAD_UNCONFIRMED, uploaded
          ? 'Cloudflare did not list this upload as the deployment serving all traffic within the wait.'
          : 'Cloudflare\'s answer to the upload did not name the version it made.')
      }
    }

    // 7. This Mac's key at the service: one merge-patch naming this Mac's secret only, then read back by name.
    const added = await request(token, { ...outgoingFor(addKeyRequest(accountId, scriptName)), body: addKeyBody(key.computerId, key.key), contentType: 'application/merge-patch+json' }, pickAny, limits.request, key)
    if (added.kind !== 'ok') {
      if (deniedFor(added)) return fail(await deniedProblem(token), `Adding this Mac's key: ${answeredInNumbers(added)}.`)
      return fail(added.kind === 'unreachable' ? OFFLINE : KEY_NOT_ADDED, `Adding this Mac's key: ${answeredInNumbers(added)}.`)
    }
    const listed = await request(token, outgoingFor(listSecretsRequest(accountId, scriptName)), pickSecretNames, limits.request, key)
    if (listed.kind !== 'ok' || !listed.result?.names.includes(computerSecretName(key.computerId))) {
      return fail(KEY_NOT_ADDED, listed.kind === 'ok' ? 'Reading the service\'s keys: this Mac\'s key is not among them.' : `Reading the service's keys: ${answeredInNumbers(listed)}.`)
    }
    // After an upload, the address once more now the key is listed: another Mac's upload that landed
    // after the proof (step 6) answers as its own build, and this set-up is not reported as done. No
    // clear answer: carry on (the proof stands). The build found before this upload is not taken as
    // proof: Cloudflare's edge goes on answering it for a while after an upload (the reason step 6
    // reads deployments, not `/version`). What this read cannot see is a residual
    // (README-sharing-service.md, Residuals).
    if (uploadDue) {
      const answering = await probe(address)
      if (answering.kind === 'sharing' && answering.build !== expectedBuild && answering.build !== buildBefore) return overwritten(answering.build)
    }

    // 8. The record: set up, never asked again on this Mac.
    const build = uploadDue ? expectedBuild : buildBefore as number
    // Found the build this Mac sent earlier (Check again after an unconfirmed upload): its own, not a join.
    const ownEarlierUpload = !uploadDue && sentBefore !== null && sentBefore === buildBefore
    const notice: string | undefined = !exists ? undefined
      : uploadDue ? UPDATED_NOTICE
        : ownEarlierUpload ? (wasReady ? UPDATED_NOTICE : undefined)
          : JOINED_NOTICE
    const latest = record()
    const done: SharingRecord = {
      ...latest, stage: 'ready', account: kept.account, address, build, sentBuild: null, tokenRejected: false,
      setUpAt: latest.setUpAt ?? now(),
    }
    if (!save(done)) return fail(SETTINGS_NOT_SAVED)
    return succeed(notice)
  }

  /** Another upload landed over this one; `theirs`: the build the address answers as, when it said. */
  function overwritten(theirs: number | null): Promise<SharingResult> {
    const problem = theirs === null ? OVERWRITTEN : theirs > expectedBuild ? OVERWRITTEN_NEWER : OVERWRITTEN_OLDER
    return fail(problem, `This WriteFlex uploaded build ${expectedBuild}; Cloudflare now runs another upload${theirs === null ? '' : `, which answers as build ${theirs}`}.`)
  }

  /** The versions serving before an upload; `known` false when Cloudflare's list could not be read. */
  async function liveVersions(token: string, accountId: string, scriptName: string, key: StoredKey): Promise<{ known: boolean; ids: string[] }> {
    const live = await request(token, outgoingFor(deploymentsRequest(accountId, scriptName)), pickLatestDeployment, limits.request, key)
    if (live.kind !== 'ok' || !live.result) return { known: false, ids: [] }
    return { known: true, ids: live.result.latest?.versions.map((entry) => entry.id) ?? [] }
  }

  /** R5: Cloudflare's deployments, read until they prove the upload or show another landed over it, or the wait is over. */
  async function proveUpload(token: string, accountId: string, scriptName: string, key: StoredKey, uploaded: string | null, before: { known: boolean; ids: string[] }): Promise<DeploymentJudgement> {
    if (!uploaded) return 'pending'
    const started = now()
    for (let attempt = 0; ; attempt += 1) {
      const live = await request(token, outgoingFor(deploymentsRequest(accountId, scriptName)), pickLatestDeployment, limits.request, key)
      const latest = live.kind === 'ok' ? live.result?.latest ?? null : null
      const judged = judgeDeployment({ uploaded, before: before.ids, beforeKnown: before.known, latest })
      if (judged !== 'pending' || now() - started >= serviceWaitMs) return judged
      await wait(POLL_PAUSES_MS[Math.min(attempt, POLL_PAUSES_MS.length - 1)])
    }
  }

  /** The script name sharing uses: the shipped config's, or the fixed name when the files are not there. */
  function scriptNameNow(): string {
    const shipped = ports.shipped()
    const verified = verifySharingServiceBundle(shipped.manifest, { bundle: shipped.bundle, config: shipped.config }, expectedBuild)
    return verified.ok ? verified.config.name : SHARING_SERVICE_NAME
  }

  type Identified = { ok: true; identity: Identity } | { ok: false; problem: SharingProblem; details: string }
  /**
   * R2: which deployment is on the account. Reads only. The address is built from the account's
   * subdomain as Cloudflare reports it NOW, never only from the one saved. A read Cloudflare refuses the
   * token, or that does not reach Cloudflare, stops the removal (nothing could be deleted anyway); what
   * the service itself answers decides the identity (sharing-identity.ts).
   */
  async function identify(kept: SharingRecord, token: string, accountId: string, scriptName: string, held: StoredKey | null): Promise<Identified> {
    const subdomain = await request(token, { method: 'GET', path: `/accounts/${accountId}/workers/subdomain` }, pickSubdomain, limits.request, held)
    const why = (what: string, answer: Answer<unknown>): string => `${what}: ${answeredInNumbers(answer)}.`
    if (subdomain.kind !== 'ok' && deniedFor(subdomain)) return { ok: false, problem: await deniedProblem(token), details: why('Looking up the workers.dev address', subdomain) }
    if (subdomain.kind === 'unreachable') return { ok: false, problem: OFFLINE, details: why('Looking up the workers.dev address', subdomain) }
    const address = subdomain.kind === 'ok' ? workersDevAddress(scriptName, subdomain.result?.subdomain) : null
    const seen: Probe = address ? await probe(address) : { kind: 'unknown', why: 'The account has no usable workers.dev address now.' }
    let keyListed: boolean | null = false
    if (seen.kind === 'sharing' && held) {
      const listed = await request(token, outgoingFor(listSecretsRequest(accountId, scriptName)), pickSecretNames, limits.request, held)
      if (listed.kind !== 'ok' && deniedFor(listed)) return { ok: false, problem: await deniedProblem(token), details: why('Reading the service\'s keys', listed) }
      if (listed.kind === 'unreachable') return { ok: false, problem: OFFLINE, details: why('Reading the service\'s keys', listed) }
      keyListed = listed.kind === 'ok' && listed.result ? listed.result.names.includes(computerSecretName(held.computerId)) : null
    }
    return { ok: true, identity: judgeIdentity({ probe: seen, accountable: [kept.build, kept.sentBuild], keyHeld: held !== null, keyListed }) }
  }

  const REMOVED_NOTICE = 'Sharing was removed from your Cloudflare account. Your pieces on this Mac were not touched.'

  /**
   * R1: the removal is saved as `removing`, and read back, before anything is deleted at Cloudflare or
   * cleared on this Mac. False: it could not be, and nothing may be destroyed.
   */
  function beginRemoval(kept: SharingRecord, serviceDeleted: boolean): boolean {
    const next: SharingRecord = { ...kept, stage: 'removing', serviceDeleted }
    if (!save(next)) return false
    const back = ports.record.read()
    return back !== null && back.stage === 'removing' && back.serviceDeleted === serviceDeleted && (back.account?.id ?? null) === (kept.account?.id ?? null)
  }

  /**
   * The clean-up on this Mac, in order: key, token, record. Clears nothing unless the record, read back,
   * says a removal is under way AND that the service is gone (R1). Anything left keeps `removing` for Retry.
   */
  function finishRemoval(scriptName: string): Promise<SharingResult> {
    const kept = ports.record.read()
    if (!kept || kept.stage !== 'removing' || !kept.serviceDeleted) return fail(REMOVAL_NOT_SAVED)
    const leftovers: string[] = []
    if (kept.account) { try { forgetKey(kept.account.id, scriptName) } catch { leftovers.push('this Mac\'s sharing key') } }
    try { ports.secrets.clear('cloudflare-token') } catch { leftovers.push('the token') }
    if (leftovers.length === 0 && save(null)) return succeed(REMOVED_NOTICE)
    if (leftovers.length === 0) leftovers.push('the sharing settings')
    return fail({ reason: `The sharing service is gone from your Cloudflare account, but ${leftovers.join(' and ')} could not be removed from this Mac.`, fix: 'Press Retry.' })
  }

  async function remove(confirmed: RemovalTarget): Promise<RemoveOutcome> {
    const scriptName = scriptNameNow()
    // R3: what was confirmed is what is there now, or nothing is removed.
    if (targetChanged(confirmed, removalTargetOf(ports.record.read(), scriptName))) return fail(REMOVAL_TARGET_CHANGED)
    const kept = record()
    if (kept.stage === 'removing' && kept.serviceDeleted) return finishRemoval(scriptName)
    const accountId = kept.account?.id ?? null
    // Nothing this Mac wrote at Cloudflare: nothing there is this Mac's to delete.
    if (accountId === null || (kept.stage !== 'ready' && kept.stage !== 'removing' && !kept.wrote)) {
      return beginRemoval(kept, true) ? finishRemoval(scriptName) : fail(REMOVAL_NOT_SAVED)
    }
    let token: string | null
    try { token = storedToken() } catch { return fail(STORAGE_UNAVAILABLE) }
    // A removal saved but not finished (the service not yet known gone) needs a working token: say where to put one.
    if (!token) return fail(kept.stage === 'removing' ? REMOVAL_NEEDS_TOKEN : NO_TOKEN)
    let held: StoredKey | null = null
    try { held = keyFor(accountId, scriptName) } catch { held = null }

    // 1. Is it there?
    const service = await request(token, { method: 'GET', path: `/accounts/${accountId}/workers/services/${scriptName}` }, pickMigrationTag, limits.request, held)
    if (isAbsent(service)) {
      if (beginRemoval(kept, true)) return finishRemoval(scriptName)
      // Already `removing`: the service is gone and Retry finishes it. Otherwise nothing was changed here.
      return fail(kept.stage === 'removing' ? REMOVAL_DONE_NOT_SAVED : REMOVAL_NOT_SAVED)
    }
    if (service.kind !== 'ok') {
      if (deniedFor(service)) return fail(await deniedProblem(token), `Looking up the sharing service: ${answeredInNumbers(service)}.`)
      return fail(service.kind === 'unreachable' ? OFFLINE : REMOVE_FAILED, `Looking up the sharing service: ${answeredInNumbers(service)}.`)
    }

    // R2: which deployment it is, and whether this confirmation may delete it.
    const identified = await identify(kept, token, accountId, scriptName, held)
    if (!identified.ok) return fail(identified.problem, identified.details)
    const { identity } = identified
    const decision = decideRemoval(confirmed, identity)
    if (decision === 'never') return fail(NOT_OURS)
    if (decision === 'changed') return fail(REMOVAL_TARGET_CHANGED, identity.why)
    if (decision === 'ask') {
      return { ...(await fail(identity.kind === 'unknown' ? SERVICE_UNCONFIRMED : SERVICE_CHANGED, identity.why)), removeAnyway: true, ask: anywayTarget(confirmed, identity) }
    }

    // R1: saved before anything is destroyed.
    if (!beginRemoval(kept, false)) return fail(REMOVAL_NOT_SAVED)
    // 2. Delete.
    const removed = await request(token, outgoingFor(removeServiceRequest(accountId, scriptName)), pickAny, limits.request, held)
    if (removed.kind !== 'ok' && !isAbsent(removed)) {
      // Cloudflare answered no: back to how it was (a record left at `removing` by this save failing is
      // finished by Retry just the same). No answer at all: it may have been deleted, so `removing` stays for Retry.
      if (removed.http !== null) save(kept)
      if (deniedFor(removed)) return fail(await deniedProblem(token), `Removing the sharing service: ${answeredInNumbers(removed)}.`)
      return fail(removed.kind === 'unreachable' ? OFFLINE : REMOVE_FAILED, `Removing the sharing service: ${answeredInNumbers(removed)}.`)
    }
    // 3. The deletion is saved and read back; only then does this Mac forget it. Not saved: nothing is
    // cleared, `removing` stays (the service not yet known gone), and Retry finds it absent and finishes.
    if (!beginRemoval(record(), true)) return fail(REMOVAL_DONE_NOT_SAVED)
    return finishRemoval(scriptName)
  }

  // ── Your own address (ticket 05; sharing-own-address.ts) ──────────────────────────────────────
  /** The context for an own-address operation: set up (or an account chosen, for listing), with the token. */
  function ownContext(needReady: boolean): { ok: true; context: OwnAddressContext } | { ok: false; problem: SharingProblem } {
    let token: string | null
    try { token = storedToken() } catch { return { ok: false, problem: STORAGE_UNAVAILABLE } }
    if (!token) return { ok: false, problem: NO_TOKEN }
    const kept = record()
    if (kept.stage === 'removing') return { ok: false, problem: REMOVAL_PENDING }
    if (needReady && (kept.stage !== 'ready' || !kept.address)) return { ok: false, problem: NOT_SET_UP }
    if (!kept.account) return { ok: false, problem: { reason: 'No Cloudflare account is chosen.', fix: 'Choose the account first.' } }
    const held = (() => { try { return kept.account ? keyFor(kept.account.id, SHARING_SERVICE_NAME) : null } catch { return null } })()
    const accountId = kept.account.id
    return {
      ok: true,
      context: {
        token, accountId, accountName: kept.account.name, scriptName: scriptNameNow(), cloudflareAddress: kept.address ?? '',
        request: (outgoing, pick) => request(token, outgoing, pick, limits.request, held),
        probe: (origin) => probe(origin),
        record, save: (next) => save(next), now,
      },
    }
  }
  const ownResult = async (outcome: OwnOutcome): Promise<SharingResult> => (outcome.ok ? succeed(outcome.notice) : fail(outcome.problem, outcome.details))

  async function domains(): Promise<SharingDomainsResult> {
    const made = ownContext(false)
    if (!made.ok) return { ok: false, problem: made.problem }
    return listDomains(made.context)
  }
  async function attachAddress(name: unknown, domain: unknown): Promise<SharingResult> {
    const made = ownContext(true)
    if (!made.ok) return fail(made.problem)
    return ownResult(await attachOwnAddress(made.context, name, domain))
  }
  async function removeAddress(): Promise<SharingResult> {
    if (!record().ownAddress && record().ownAddressesLeft.length === 0) return succeed()
    const made = ownContext(true)
    if (!made.ok) return fail(made.problem)
    return ownResult(await removeOwnAddress(made.context))
  }

  const guard = <Args extends unknown[], Result extends SharingResult>(work: (...args: Args) => Promise<Result>) => (...args: Args): Promise<Result | SharingResult> => {
    if (busy()) return fail(BUSY)
    return serial(() => work(...args)).catch(async () => fail(SETUP_FAILED))
  }

  return {
    status: (options) => statusOf(options?.askService === true),
    checkToken: guard(checkToken),
    checkSavedToken: guard(checkSavedToken),
    chooseAccount: guard(chooseAccount),
    setUp: guard(setUp),
    remove: guard(remove),
    removalTarget: () => removalTargetOf(ports.record.read(), scriptNameNow()),
    serviceAccess() {
      const kept = record()
      if (kept.stage !== 'ready' || !kept.account || !kept.address) return null
      try {
        const key = keyFor(kept.account.id, SHARING_SERVICE_NAME)
        // Requests always go to the workers.dev address (never switched off); links read what linksAddressNow says.
        if (!key) return null
        const at = now()
        return {
          address: kept.address, base: serviceBase(kept.address), key: key.key,
          linkAddress: linksAddressNow(kept, at) ?? kept.address, linkAddressUntil: linksAddressUntil(kept, at), ownAddress: viewOf(kept.ownAddress),
        }
      } catch { return null }
    },
    domains: () => (busy() ? Promise.resolve({ ok: false as const, problem: BUSY }) : serial(domains).catch(() => ({ ok: false as const, problem: SETUP_FAILED }))),
    attachAddress: guard(attachAddress),
    removeAddress: guard(removeAddress),
  }
}

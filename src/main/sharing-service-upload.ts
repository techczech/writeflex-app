// The requests that put the sharing service at Cloudflare, take this Mac's key there and remove the
// service again (sharing ticket 02). Ported from TalkWeaver's src/main/live-service-upload.ts (the
// request half; the shipped bundle and its manifest are sharing-service-bundle.ts).
//
// Pure functions, the seam the tests drive: each returns a planned request (method, path, headers,
// body by kind). The request bodies follow what wrangler 4 sends for `deploy` and `secret bulk`
// (createWorkerUploadForm, getMigrationsToUpload, subdomainDeploy, putBulkSecrets).
//
// The code upload sends NO secret: `bindings_inherit=strict` keeps every secret the Worker already
// has (other Macs' admin keys). It touches no custom domain or route. A secret travels in one other
// request only, `PATCH …/secrets-bulk` (merge-patch), naming this Mac's `ADMIN_SECRET_<computer id>`
// and nothing else, so every other Mac's key is left as it is. The value is put in by the caller as
// it is sent (`addKeyBody`).
//
// No Electron import.
import { randomBytes } from 'node:crypto'
import type { Migration, SharingServiceConfig, SharingServiceManifest } from './sharing-service-bundle'

/** wrangler 4 sends this for a Worker with Durable Objects. */
export const CODE_UPDATE_STRATEGY = { mode: 'deferred', max_delay: 300 } as const
/** The header wrangler 4 sends with the workers.dev switch. */
export const SCRIPT_API_DATE = '2025-08-01'
export const ADMIN_SECRET_PREFIX = 'ADMIN_SECRET_'
export const SECRETS_CONTENT_TYPE = 'application/merge-patch+json'

const SCRIPT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/
/** Path segments the plan puts in an address: an account id. */
export const validAccountSegment = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
export const validScriptName = (value: unknown): value is string => typeof value === 'string' && SCRIPT_NAME.test(value)

/**
 * The script deployed is at a migration tag this build does not list: it was set up by a newer
 * WriteFlex (or by hand). Replaying every migration would ask Cloudflare to create classes that
 * already exist, so nothing is sent.
 */
export class UnknownMigrationTagError extends Error {
  readonly tag: string
  constructor(tag: string) {
    super('The deployed migration tag is not one this build lists')
    this.name = 'UnknownMigrationTagError'
    this.tag = tag
  }
}

/** What wrangler's getMigrationsToUpload sends, given the tag of the script already deployed (null: none). */
export function migrationsToApply(migrations: Migration[], deployedTag: string | null): { old_tag?: string; new_tag: string; steps: Record<string, unknown>[] } | null {
  if (migrations.length === 0) return null
  const steps = (list: Migration[]): Record<string, unknown>[] => list.map(({ tag: _tag, ...rest }) => rest)
  const newTag = migrations[migrations.length - 1].tag
  if (!deployedTag) return { new_tag: newTag, steps: steps(migrations) }
  const at = migrations.findIndex((migration) => migration.tag === deployedTag)
  if (at === -1) throw new UnknownMigrationTagError(deployedTag)
  if (at === migrations.length - 1) return null
  return { old_tag: deployedTag, new_tag: newTag, steps: steps(migrations.slice(at + 1)) }
}

export type UploadStep = 'upload' | 'workers-dev'
export type PlannedBody =
  | { kind: 'multipart'; metadata: Record<string, unknown>; module: { name: string; type: string; bytes: Uint8Array } }
  | { kind: 'json'; json: Record<string, unknown>; contentType?: string }
export type PlannedRequest<Step extends string = UploadStep> = {
  step: Step
  method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE'
  /** Under the API's base address, with its query when it has one. */
  path: string
  headers?: Record<string, string>
  body?: PlannedBody
}

export type UploadInput = {
  config: SharingServiceConfig
  manifest: SharingServiceManifest
  bundle: Uint8Array
  accountId: string
  /** The migration tag of the script already deployed; null when there is none (first set-up). */
  deployedMigrationTag: string | null
}

export const scriptPath = (accountId: string, scriptName: string): string => {
  if (!validAccountSegment(accountId) || !validScriptName(scriptName)) throw new TypeError('Not an account or a Worker name.')
  return `/accounts/${accountId}/workers/scripts/${scriptName}`
}

/**
 * The write requests that put the shipped bundle at Cloudflare, in order: the script (bundle,
 * settings, migrations still to apply) and its workers.dev address switched on. Exactly those two.
 */
export function planSharingServiceUpload(input: UploadInput): PlannedRequest[] {
  const { config, manifest, bundle, accountId, deployedMigrationTag } = input
  const script = scriptPath(accountId, config.name)
  const migrations = migrationsToApply(config.migrations, deployedMigrationTag)
  const metadata: Record<string, unknown> = {
    main_module: manifest.mainModule,
    bindings: config.durable_objects.bindings.map(({ name, class_name }) => ({ name, type: 'durable_object_namespace', class_name })),
    compatibility_date: config.compatibility_date,
    ...(config.compatibility_flags.length ? { compatibility_flags: config.compatibility_flags } : {}),
    ...(migrations ? { migrations } : {}),
    code_update_strategy: { ...CODE_UPDATE_STRATEGY },
    ...(config.observability ? { observability: { ...config.observability } } : {}),
  }
  return [
    {
      step: 'upload', method: 'PUT', path: `${script}?excludeScript=true&bindings_inherit=strict`,
      body: { kind: 'multipart', metadata, module: { name: manifest.mainModule, type: 'application/javascript+module', bytes: bundle } },
    },
    workersDevRequest(accountId, config.name),
  ]
}

/**
 * The workers.dev switch on its own. It changes no code, no secret and no domain, and sending it
 * again changes nothing. Also sent alone by a set-up that finds the script but no answer at its
 * address (a first set-up that stopped between its two requests).
 */
export function workersDevRequest(accountId: string, scriptName: string): PlannedRequest<'workers-dev'> {
  return {
    step: 'workers-dev', method: 'POST', path: `${scriptPath(accountId, scriptName)}/subdomain`,
    headers: { 'Cloudflare-Workers-Script-Api-Date': SCRIPT_API_DATE },
    body: { kind: 'json', json: { enabled: true } },
  }
}

/** Remove the service and everything in it: the script, and with `force` its Durable Objects. */
export function removeServiceRequest(accountId: string, scriptName: string): PlannedRequest<'remove'> {
  return { step: 'remove', method: 'DELETE', path: `${scriptPath(accountId, scriptName)}?force=true` }
}

// ── This Mac's key ──────────────────────────────────────────────────────────────────────────────
// A computer id as sharing-service/admin-keys.ts accepts one under `ADMIN_SECRET_<id>`: lower-case
// letters and digits, 1 to 64 characters.
const COMPUTER_ID = /^[a-z0-9]{1,64}$/
export const validComputerId = (value: unknown): value is string => typeof value === 'string' && COMPUTER_ID.test(value)

/** A new id for this Mac: 16 lower-case letters and digits. */
export function newComputerId(random: (bytes: number) => Buffer = randomBytes): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return [...random(16)].map((byte) => alphabet[byte % alphabet.length]).join('')
}

/** A new admin key: 32 random bytes as base64url (43 characters). */
export function newAdminKey(random: (bytes: number) => Buffer = randomBytes): string {
  return random(32).toString('base64url')
}

/** `ADMIN_SECRET_<id>`: the only name under which a Mac's key is ever sent. */
export function computerSecretName(computerId: string): string {
  if (!validComputerId(computerId)) throw new TypeError('Not a computer id.')
  return ADMIN_SECRET_PREFIX + computerId
}

/** Add this Mac's key: ONE request naming ONE secret. The body is made by `addKeyBody` as it is sent. */
export function addKeyRequest(accountId: string, scriptName: string): PlannedRequest<'add-key'> {
  return { step: 'add-key', method: 'PATCH', path: `${scriptPath(accountId, scriptName)}/secrets-bulk` }
}

/** The body of addKeyRequest: exactly one entry, this Mac's. Every other secret stays as it is. */
export function addKeyBody(computerId: string, key: string): string {
  const name = computerSecretName(computerId)
  if (typeof key !== 'string' || key.trim().length === 0) throw new TypeError('A secret needs a value.')
  return JSON.stringify({ secrets: { [name]: { name, text: key, type: 'secret_text' } } })
}

/** Read the names (never the values) of the Worker's secrets: how a set-up sees its key arrived. */
export function listSecretsRequest(accountId: string, scriptName: string): PlannedRequest<'list-secrets'> {
  return { step: 'list-secrets', method: 'GET', path: `${scriptPath(accountId, scriptName)}/secrets` }
}

/** The Worker's workers.dev address, from the account's subdomain; null when that is not a plain label. */
export function workersDevAddress(scriptName: string, subdomain: unknown): string | null {
  if (!validScriptName(scriptName) || typeof subdomain !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) return null
  return `https://${scriptName}.${subdomain}.workers.dev`
}

// ── Proof that the upload is what runs (rule R5) ────────────────────────────────────────────────
// Cloudflare's own identity of a deployment, as wrangler 4 reads it: the upload's answer carries
// `deployment_id`, the id of the version it made (wrangler prints it as "Current Version ID", often
// without hyphens), and `GET …/scripts/<name>/deployments` lists deployments newest first, each with
// `versions: [{version_id, percentage}]` ("The first deployment in the list is the latest deployment
// actively serving traffic"). Note: changing a secret makes a new version, so the proof is read
// after the upload and before this Mac's key is added.

/** A version id compared as Cloudflare means it: hyphens and case ignored. Null when it is not one. */
export function versionId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const plain = value.replace(/-/g, '').toLowerCase()
  return /^[0-9a-f]{32}$/.test(plain) ? plain : null
}

/** From the upload's `result`: the version it made (null when the answer does not say). Never null for the pick itself. */
export function pickUploadedVersion(result: unknown): { version: string | null } {
  return { version: versionId((result as { deployment_id?: unknown } | null)?.deployment_id) }
}

export function deploymentsRequest(accountId: string, scriptName: string): PlannedRequest<'deployments'> {
  return { step: 'deployments', method: 'GET', path: `${scriptPath(accountId, scriptName)}/deployments` }
}

/** The deployment serving now: its versions and their shares of traffic. Null when the answer is not that shape. */
export type LiveDeployment = { versions: Array<{ id: string; percentage: number }> }
export function pickLatestDeployment(result: unknown): { latest: LiveDeployment | null } | null {
  const deployments = (result as { deployments?: unknown } | null)?.deployments
  if (!Array.isArray(deployments)) return null
  if (deployments.length === 0) return { latest: null }
  const versions = (deployments[0] as { versions?: unknown } | null)?.versions
  if (!Array.isArray(versions)) return null
  const read = versions.slice(0, 4).map((entry) => {
    const e = entry as { version_id?: unknown; percentage?: unknown } | null
    return { id: versionId(e?.version_id), percentage: typeof e?.percentage === 'number' ? e.percentage : NaN }
  })
  if (read.some((entry) => entry.id === null || !Number.isFinite(entry.percentage))) return null
  return { latest: { versions: read as Array<{ id: string; percentage: number }> } }
}

export type DeploymentJudgement = 'proven' | 'overwritten' | 'pending'
/**
 * Is the upload what runs? `proven`: the latest deployment is this upload's version alone. `overwritten`:
 * it is a version that is neither this upload's nor the one that ran before it (another upload landed
 * after this one). Anything else (no version id from the upload, no readable deployment, the version
 * from before still serving, a split of traffic) is `pending`: never success.
 * `before`: the versions serving before the upload (none for a first upload); `beforeKnown` false when
 * that could not be read (then a version that is not this upload's proves nothing).
 */
export function judgeDeployment(input: { uploaded: string | null; before: readonly string[]; beforeKnown: boolean; latest: LiveDeployment | null }): DeploymentJudgement {
  const { uploaded, before, beforeKnown, latest } = input
  if (!uploaded || !latest || latest.versions.length === 0) return 'pending'
  const ids = latest.versions.map((entry) => entry.id)
  if (ids.length === 1 && ids[0] === uploaded && latest.versions[0].percentage === 100) return 'proven'
  if (ids.includes(uploaded)) return 'pending'
  if (!beforeKnown) return 'pending'
  if (ids.some((id) => before.includes(id))) return 'pending'
  return 'overwritten'
}

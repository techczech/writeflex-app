/**
 * Model-list refresh copy (fix 04, 2026-10-06: "when the provider updates its models, the list is
 * out of date"). Bridle owns the behaviour: `refreshModels({ force: true })` asks the providers and
 * reports added/removed ids per provider; an empty discovery is a failure that keeps the old list.
 * This module only turns Bridle's report and `lastDiscovery()` into the words the palette command,
 * the chat model picker and Settings show. Pure: main and renderer both import it.
 */

export type ModelDiscoveryReason = 'offline' | 'provider-error' | 'empty-catalogue' | 'not-signed-in'

/** Bridle's `lastDiscovery()`: when the model list was last checked, and how that went. */
export type ModelsChecked = {
  at: number
  discovery: 'succeeded' | 'failed' | 'skipped'
  reason?: ModelDiscoveryReason
}

/** What one "Refresh models" did, as the renderer receives it over IPC. */
export type ModelRefreshResult = {
  status: 'updated' | 'up-to-date' | 'failed' | 'not-signed-in'
  added: string[]
  removed: string[]
  reason?: ModelDiscoveryReason
  checked: ModelsChecked
  /** Bridle answered with a forced check from the last few seconds instead of asking again. */
  reused?: true
}

/** The slice of Bridle's `BridleModelRefreshReport` this module reads (structural, so it stays pure). */
export type ModelRefreshReportLike = {
  at: number
  discovery: ModelsChecked['discovery']
  reason?: ModelDiscoveryReason
  /** Bridle 0.14.0: a forced call inside the floor after a successful forced check. */
  reused?: boolean
  providers: Record<string, { added: string[]; removed: string[] }>
}

export function summariseModelRefresh(report: ModelRefreshReportLike): ModelRefreshResult {
  const changes = Object.values(report.providers)
  const added = changes.flatMap((change) => change.added)
  const removed = changes.flatMap((change) => change.removed)
  const checked: ModelsChecked = { at: report.at, discovery: report.discovery, ...(report.reason ? { reason: report.reason } : {}) }
  const reason = report.reason ? { reason: report.reason } : {}
  const reused = report.reused ? { reused: true as const } : {}
  if (report.discovery === 'failed') return { status: 'failed', added, removed, ...reason, checked, ...reused }
  if (report.discovery === 'skipped') return { status: 'not-signed-in', added, removed, ...reason, checked, ...reused }
  return { status: added.length + removed.length > 0 ? 'updated' : 'up-to-date', added, removed, checked, ...reused }
}

const FAILURE_COPY: Record<ModelDiscoveryReason, string> = {
  offline: 'you are offline',
  'provider-error': 'the provider returned an error',
  'empty-catalogue': 'the provider listed no models, so the current list was kept',
  'not-signed-in': 'no signed-in account lists its models',
}

const SHORT_REASON: Record<ModelDiscoveryReason, string> = {
  offline: 'offline',
  'provider-error': 'provider error',
  'empty-catalogue': 'provider listed no models',
  'not-signed-in': 'not signed in',
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** One line for the result of a refresh: "3 new models", "Up to date", or why it failed. A reused
 *  check reads "Checked just now — {that check's result}". */
export function describeModelRefresh(result: ModelRefreshResult): string {
  const text = describeOutcome(result)
  return result.reused ? `Checked just now — ${text.charAt(0).toLowerCase()}${text.slice(1)}` : text
}

function describeOutcome(result: ModelRefreshResult): string {
  switch (result.status) {
    case 'updated': {
      const parts: string[] = []
      if (result.added.length > 0) parts.push(plural(result.added.length, 'new model', 'new models'))
      if (result.removed.length > 0) parts.push(`${plural(result.removed.length, 'model', 'models')} removed`)
      return parts.join(', ')
    }
    case 'up-to-date':
      return 'Up to date'
    case 'not-signed-in':
      return 'Sign in to an account to check for new models'
    case 'failed':
      return `Couldn't refresh: ${FAILURE_COPY[result.reason ?? 'provider-error']}`
  }
}

function when(at: number, now: number): string {
  const age = now - at
  if (age < 60_000) return 'just now'
  if (age < 60 * 60_000) return `${Math.floor(age / 60_000)} min ago`
  const then = new Date(at)
  const time = then.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (then.toDateString() === new Date(now).toDateString()) return `today at ${time}`
  const day = then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  return `on ${day} at ${time}`
}

/** "Last checked 5 min ago" — or a failed check, or "Not checked yet". */
export function lastCheckedLine(checked: ModelsChecked | null, now: number = Date.now()): string {
  if (!checked) return 'Model list not checked yet'
  const at = when(checked.at, now)
  if (checked.discovery === 'failed') return `Last check failed ${at} (${SHORT_REASON[checked.reason ?? 'provider-error']})`
  if (checked.discovery === 'skipped') return `Last checked ${at} (not signed in)`
  return `Last checked ${at}`
}

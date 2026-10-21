// What a removal of sharing is allowed to delete (sharing ticket 02, rules R2 and R3). Pure: the
// set-up (sharing-setup.ts `remove`) asks these and acts; the IPC (sharing-ipc.ts) holds the
// confirmations.
//
// R3, a confirmation names its target. The confirmation main issues when a question is shown is bound
// to the window that asked (createRemovalConfirmations) AND to a RemovalTarget: the operation, the
// account id, the script name, the recorded build, when set-up finished, and, for "Remove it anyway",
// the identity answer the question showed. At execution `targetChanged` compares it with the target
// as it is now; any difference refuses and nothing is deleted.
//
// R2, who may be deleted (decideRemoval):
//   foreign                   never, whatever was confirmed
//   ours                      deleted on a plain Remove (or Retry)
//   replaced / unknown        asked: Remove stops and offers "Remove it anyway", whose confirmation is
//                             bound to that answer and build; it deletes only while the answer is the same
//
// No Electron import.
import { randomBytes } from 'node:crypto'
import type { Identity } from './sharing-identity'
import type { SharingRecord } from './sharing-record'

/** `remove`: from set up, or an interrupted set-up. `retry`: a removal that did not finish (stage `removing`). */
export type RemovalOperation = 'remove' | 'retry'
/** The identity answer a "Remove it anyway" question showed. */
export type ShownIdentity = { kind: 'replaced' | 'unknown'; build: number | null }

export type RemovalTarget = {
  operation: RemovalOperation
  accountId: string | null
  /** For the question; not compared (an account's name can change at Cloudflare). */
  accountName: string | null
  scriptName: string
  recordedBuild: number | null
  setUpAt: number | null
  /** Null: a plain Remove or Retry, which deletes only `ours`. */
  anyway: ShownIdentity | null
}

/** The removal the record stands for now (a plain one), or null when there is nothing to remove. */
export function removalTargetOf(record: SharingRecord | null, scriptName: string): RemovalTarget | null {
  if (!record) return null
  if (record.stage !== 'removing' && !record.account) return null
  return {
    operation: record.stage === 'removing' ? 'retry' : 'remove',
    accountId: record.account?.id ?? null,
    accountName: record.account?.name ?? null,
    scriptName,
    recordedBuild: record.build,
    setUpAt: record.setUpAt,
    anyway: null,
  }
}

/** The confirmed target and the target now differ in what the question named (the identity is judged by decideRemoval). */
export function targetChanged(confirmed: RemovalTarget, now: RemovalTarget | null): boolean {
  if (!now) return true
  return confirmed.operation !== now.operation
    || confirmed.accountId !== now.accountId
    || confirmed.scriptName !== now.scriptName
    || confirmed.recordedBuild !== now.recordedBuild
    || confirmed.setUpAt !== now.setUpAt
}

export type RemovalDecision = 'delete' | 'ask' | 'changed' | 'never'

/** R2 under R3: may the deployment judged `identity` be deleted on this confirmation? */
export function decideRemoval(confirmed: RemovalTarget, identity: Identity): RemovalDecision {
  if (identity.kind === 'foreign') return 'never'
  if (confirmed.anyway === null) return identity.kind === 'ours' ? 'delete' : 'ask'
  return identity.kind === confirmed.anyway.kind && identity.build === confirmed.anyway.build ? 'delete' : 'changed'
}

/** The target a "Remove it anyway" question is bound to: the one confirmed, with the answer shown. */
export function anywayTarget(confirmed: RemovalTarget, identity: Identity): RemovalTarget {
  if (identity.kind !== 'replaced' && identity.kind !== 'unknown') throw new TypeError('Only a replaced or unknown service is asked about.')
  return { ...confirmed, anyway: { kind: identity.kind, build: identity.build } }
}

// ── Confirmations ───────────────────────────────────────────────────────────────────────────────

/** How long a confirmation may be acted on, as the example removal's (example-removal.ts rule H). */
export const REMOVAL_CONFIRMATION_MS = 5 * 60 * 1000
const CONFIRMATION_SHAPE = /^[0-9a-f]{64}$/

export type RemovalConfirmations = {
  /**
   * A new confirmation for `sender`, bound to `target`. Two slots, one per kind: plain (Remove, Retry)
   * and anyway ("Remove it anyway"). Issuing replaces the one held of the same kind only, so a fresh
   * plain question does not void a live "Remove it anyway" (and the reverse).
   */
  issue(sender: number, target: RemovalTarget): string
  /**
   * The target `presented` was issued for, when it is one of the two held, for this window and recent.
   * Every call uses up both slots, whether or not it matched: single use, as before.
   */
  take(presented: unknown, sender: number): RemovalTarget | null
}

type Held = { token: string; sender: number; at: number; target: RemovalTarget }

export function createRemovalConfirmations(options: { now?: () => number; random?: (bytes: number) => Buffer } = {}): RemovalConfirmations {
  const now = options.now ?? Date.now
  const random = options.random ?? randomBytes
  const held: { plain: Held | null; anyway: Held | null } = { plain: null, anyway: null }
  const valid = (confirmation: Held | null, presented: unknown, sender: number): confirmation is Held =>
    confirmation !== null && typeof presented === 'string' && CONFIRMATION_SHAPE.test(presented)
    && presented === confirmation.token && sender === confirmation.sender
    && now() >= confirmation.at && now() - confirmation.at < REMOVAL_CONFIRMATION_MS
  return {
    issue(sender, target) {
      const confirmation: Held = { token: random(32).toString('hex'), sender, at: now(), target: structuredClone(target) }
      held[target.anyway === null ? 'plain' : 'anyway'] = confirmation
      return confirmation.token
    },
    take(presented, sender) {
      const { plain, anyway } = held
      held.plain = null
      held.anyway = null
      if (valid(plain, presented, sender)) return plain.target
      if (valid(anyway, presented, sender)) return anyway.target
      return null
    },
  }
}

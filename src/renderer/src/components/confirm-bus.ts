import type { ConfirmSpec } from '../../../shared/confirm-card'

/**
 * Ask for a decision through the confirm card (R11). `askConfirm` resolves true on the red verb and false on Cancel,
 * Esc or a click outside. The ConfirmHost mounted once at the app root draws it. One card at a time: a second
 * request waits its turn. Each request has its own id, so the host draws a fresh card (and Cancel takes the focus
 * again) for the next one instead of reusing the last card with its focus still on the red verb.
 */
type Pending = { id: number; spec: ConfirmSpec; resolve: (ok: boolean) => void }
let nextId = 1
let host: ((pending: Pending | null) => void) | null = null
const queue: Pending[] = []
let showing: Pending | null = null

function pump(): void {
  if (showing || !host) return
  showing = queue.shift() ?? null
  host(showing)
}
export function registerConfirmHost(set: ((pending: Pending | null) => void) | null): void {
  host = set
  if (set) pump()
}
export function settleConfirm(ok: boolean): void {
  const done = showing
  showing = null
  host?.(null)
  done?.resolve(ok)
  pump()
}
export function askConfirm(spec: ConfirmSpec): Promise<boolean> {
  return new Promise<boolean>((resolve) => { queue.push({ id: nextId++, spec, resolve }); pump() })
}
export type { Pending as PendingConfirm }

// Ambient Workers runtime types this service uses (no @cloudflare/workers-types dependency).
// Copied from TalkWeaver's worker/workers-runtime.d.ts and cut to what the sharing service calls.

interface DurableObjectNamespace {
  idFromName(name: string): unknown
  get(id: unknown): DurableObjectStub
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>
}

interface SqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Iterable<T>
}

interface DurableObjectStorage {
  sql: SqlStorage
  /** SQLite-backed objects: run `callback` as one transaction (rolled back if it throws). */
  transactionSync<T>(callback: () => T): T
  /** The object's one alarm: `alarm()` runs at (or soon after) this time. Replaces any alarm set. */
  setAlarm(scheduledTime: number): Promise<void>
}

interface DurableObjectState {
  storage: DurableObjectStorage
}

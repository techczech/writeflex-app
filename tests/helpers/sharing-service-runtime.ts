// An in-memory stand-in for the Workers runtime the sharing service runs in: Durable Object
// namespaces whose objects keep real SQLite storage (bun:sqlite, in memory) behind the same
// `storage.sql.exec(query, ...bindings)` and `transactionSync` shape, so the service's own SQL runs
// unchanged. Like the real runtime, a blob comes back as an ArrayBuffer and an ArrayBuffer can be
// bound. (TalkWeaver's worker tests use the same fake state; this adds namespaces and an env.)
//
// `service`: the module to drive, the sources (sharing-service/index.ts) or the built bundle.
import { Database } from 'bun:sqlite'
import { ADMIN_KEY, FakeNamespaceOf, ORIGIN, fakeServiceWith, type ServiceModule } from './sharing-service-runtime-core.ts'

export interface FakeObjectState {
  db: Database
  /** The time the object's alarm is set for, or null. Tests run `alarm()` themselves. */
  alarmAt: number | null
  storage: {
    sql: { exec: (query: string, ...bindings: unknown[]) => Record<string, unknown>[] }
    transactionSync: <T>(callback: () => T) => T
    setAlarm: (time: number) => Promise<void>
  }
}

export function fakeObjectState(): FakeObjectState {
  const db = new Database(':memory:')
  const bind = (value: unknown): unknown => (value instanceof ArrayBuffer ? new Uint8Array(value) : value)
  const unbind = (row: Record<string, unknown>): Record<string, unknown> => {
    for (const [key, value] of Object.entries(row)) {
      if (value instanceof Uint8Array) row[key] = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
    }
    return row
  }
  const sql = {
    exec: (query: string, ...bindings: unknown[]) =>
      (db.query(query).all(...(bindings.map(bind) as [])) as Record<string, unknown>[]).map(unbind),
  }
  const state: FakeObjectState = {
    db,
    alarmAt: null,
    storage: {
      sql,
      transactionSync: <T>(callback: () => T): T => db.transaction(callback)() as T,
      setAlarm: async (time: number) => { state.alarmAt = time },
    },
  }
  return state
}

/** Table names an object's storage holds. */
export function tablesOf(state: FakeObjectState): string[] {
  return (state.db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((row) => row.name)
}

export class FakeNamespace extends FakeNamespaceOf<FakeObjectState> {
  constructor(make: ServiceModule['SharedPiece'], env: () => unknown) {
    super(make, env, fakeObjectState)
  }
}

export { ADMIN_KEY, ORIGIN, type ServiceModule }

export function fakeService(service: ServiceModule, extraEnv: Record<string, unknown> = {}) {
  return fakeServiceWith(service, fakeObjectState, extraEnv)
}

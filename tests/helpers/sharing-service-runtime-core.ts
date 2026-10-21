// The engine-free half of the in-memory Workers runtime (sharing-service-runtime.ts): Durable Object
// namespaces and the service's env, over whatever object state a runtime makes. bun tests use
// bun:sqlite (sharing-service-runtime.ts); the e2e run, which Playwright runs under Node, uses
// node:sqlite (sharing-service-runtime-node.ts). The service's own SQL runs unchanged on either.

export interface ObjectStorage {
  sql: { exec: (query: string, ...bindings: unknown[]) => Record<string, unknown>[] }
  transactionSync: <T>(callback: () => T) => T
  setAlarm: (time: number) => Promise<void>
}

type ObjectClass = new (state: never, env: never) => { fetch(request: Request): Promise<Response>; alarm?: () => Promise<void> }

export class FakeNamespaceOf<S extends { storage: ObjectStorage }> {
  readonly states = new Map<string, S>()
  /** Every request any object of this namespace received, in order. */
  readonly received: { name: string; method: string; path: string }[] = []
  private readonly objects = new Map<string, { fetch(request: Request): Promise<Response>; alarm?: () => Promise<void> }>()

  constructor(private readonly make: ObjectClass, private readonly env: () => unknown, private readonly makeState: () => S) {}

  /** Run an object's alarm, as the runtime would when its time comes. */
  async alarm(name: string): Promise<void> {
    let object = this.objects.get(name)
    const state = this.states.get(name)
    if (!object && state) {
      object = new this.make(state as never, this.env() as never)
      this.objects.set(name, object)
    }
    if (object?.alarm) await object.alarm()
  }

  /** Drop an object from memory and keep its storage, as the runtime does when it evicts an idle object. */
  evict(name: string): void {
    this.objects.delete(name)
  }

  idFromName(name: string): string {
    return name
  }

  get(id: unknown): { fetch(request: Request): Promise<Response> } {
    const name = id as string
    return {
      fetch: async (request: Request) => {
        let object = this.objects.get(name)
        if (!object) {
          const state = this.states.get(name) ?? this.makeState()
          this.states.set(name, state)
          object = new this.make(state as never, this.env() as never)
          this.objects.set(name, object)
        }
        this.received.push({ name, method: request.method, path: new URL(request.url).pathname })
        return object.fetch(request)
      },
    }
  }
}

export interface ServiceModule {
  default: { fetch(request: Request, env: unknown): Promise<Response> }
  SharedPiece: ObjectClass
  SharingRegistry: ObjectClass
}

export const ADMIN_KEY = 'admin-key-for-testmac-0123456789abcdef'
export const ORIGIN = 'https://writeflex-sharing.example.workers.dev'

export function fakeServiceWith<S extends { storage: ObjectStorage }>(service: ServiceModule, makeState: () => S, extraEnv: Record<string, unknown> = {}) {
  const env: Record<string, unknown> = { ADMIN_SECRET_testmac: ADMIN_KEY, ...extraEnv }
  const shares = new FakeNamespaceOf(service.SharedPiece, () => env, makeState)
  const registry = new FakeNamespaceOf(service.SharingRegistry, () => env, makeState)
  env.SHARES = shares
  env.SHARING_REGISTRY = registry
  const call = (path: string, init: RequestInit = {}): Promise<Response> => service.default.fetch(new Request(`${ORIGIN}${path}`, init), env)
  return { env, shares, registry, call }
}

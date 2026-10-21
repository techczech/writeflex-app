// The real sharing service (sharing-service/, in an in-memory Workers runtime) behind the stand-in
// Cloudflare (fake-cloudflare.ts), for publishing tests. The service's admin keys are the
// secrets the set-up added to the fake account's script, read again on every request, so a Mac's key
// works exactly when the set-up put it there. No network: requests are handed to the service's fetch.
import type { FakeCloudflare } from './fake-cloudflare.ts'
import type { ServiceModule } from './sharing-service-runtime-core.ts'

export type AttachedService = { env: Record<string, unknown> }

export function attachSharingService(fake: FakeCloudflare, service: ServiceModule, svc: AttachedService): void {
  fake.sharingService = async (request) => {
    for (const name of Object.keys(svc.env)) if (name.startsWith('ADMIN_SECRET_')) delete svc.env[name]
    const script = Object.values(fake.accounts).find((account) => account.script)?.script
    if (!script) return new Response('There is nothing here yet', { status: 404 })
    Object.assign(svc.env, script.secrets)
    return service.default.fetch(request, svc.env)
  }
}

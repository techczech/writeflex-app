import type { CopySource } from '@app-patterns/updates'

/** Unpackaged hidden tests only. Production ignores every override. */
export function updateTestOptions(packaged: boolean, env: Record<string, string | undefined>): { source: CopySource | null; feedUrl: string | null } {
  if (packaged || env.WRITEFLEX_E2E !== '1') return { source: null, feedUrl: null }
  const source = env.WRITEFLEX_E2E_UPDATES_SOURCE
  let feedUrl: string | null = null
  try {
    const url = new URL(env.WRITEFLEX_E2E_UPDATES_FEED ?? '')
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1') feedUrl = url.href
  } catch { /* no stand-in */ }
  return { source: source === 'website' || source === 'store' || source === 'preview' ? source : null, feedUrl }
}


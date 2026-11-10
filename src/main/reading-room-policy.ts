import { randomBytes } from 'node:crypto'

export type ReaderOwner = { id: number; top: string; epoch: number; origin: string }
export type ReaderLease = {
  id: string; origin: string; url: string; nonce: string; generation: number; slot: 0 | 1
}
export type ReaderGrant = ReaderLease & { owner: ReaderOwner; documentIdentity: string; live: boolean; entryUsed: boolean; frame?: string; frameNode?: number; frameGeneration?: number }

/** URL parsers normalise dot segments; exact map lookup remains the authority after parsing. */
export function canonicalReaderResource(raw: string, method: string): { origin: string; key: string } | null {
  // Fragments belong to the host's bootstrap data, never to a network resource key.
  const resource = raw.split('#', 1)[0]
  if (method !== 'GET' || !/^wf-reader:\/\/[a-f0-9]{32}\//.test(resource) || /[\\\0]/.test(resource)) return null
  try {
    const url = new URL(resource)
    if (url.protocol !== 'wf-reader:' || !/^[a-f0-9]{32}$/.test(url.host)
      || url.username || url.password || url.port || url.search) return null
    // No percent alias is needed by the fixed ASCII asset set. This also rejects encoded separators,
    // NUL, multiple decoding and case aliases without ever joining an untrusted path to a disk root.
    if (url.pathname.includes('%') || url.pathname.includes('//')) return null
    const key = url.pathname.slice(1)
    if (!key || key.split('/').some(part => !part || part === '.' || part === '..')) return null
    return { origin: `wf-reader://${url.host}`, key }
  } catch { return null }
}

export class ReaderRegistry {
  readonly grants = new Map<string, ReaderGrant>()
  #generation = 0
  create(owner: ReaderOwner, slot: 0 | 1, documentIdentity = ''): ReaderGrant {
    // At most two live slots per top frame; reuse requires explicit normal teardown and revocation.
    if ([...this.grants.values()].some(g => g.live && g.owner.id === owner.id && g.slot === slot)) {
      throw new Error('The reader slot has not finished closing.')
    }
    const id = randomBytes(16).toString('hex')
    const origin = `wf-reader://${id}`
    const grant: ReaderGrant = { id, origin, url: `${origin}/reader-host.html`, nonce: randomBytes(24).toString('hex'),
      generation: ++this.#generation, slot, owner: { ...owner }, documentIdentity, live: true, entryUsed: false }
    this.grants.set(id, grant)
    return grant
  }
  owned(id: unknown, owner: ReaderOwner): ReaderGrant {
    const g = typeof id === 'string' ? this.grants.get(id) : undefined
    if (!g?.live || g.owner.id !== owner.id || g.owner.top !== owner.top || g.owner.epoch !== owner.epoch) {
      throw new Error('The reader lease is stale or belongs to another window.')
    }
    return g
  }
  commitFrame(owner: number, frame: Electron.WebFrameMain): void {
    try {
      const grant = [...this.grants.values()].find(g => g.live && g.owner.id === owner && g.origin === frame.origin && g.frameNode === frame.frameTreeNodeId)
      if (!grant || !frame.parent || frame.parent.parent || `${frame.parent.processId}:${frame.parent.routingId}` !== grant.owner.top || frame.url.split('#', 1)[0] !== grant.url) return
      grant.frame = `${frame.processId}:${frame.routingId}`
      grant.frameGeneration = grant.generation
    } catch { /* A detached or unreadable frame cannot acquire keyboard authority. */ }
  }
  keyboardFrame(owner: number, top: Electron.WebFrameMain, focused: Electron.WebFrameMain | null): boolean {
    try {
      if (!focused || focused === top) return false
      const grant = [...this.grants.values()].find(g => g.live && g.entryUsed && g.owner.id === owner && g.origin === focused.origin)
      if (!grant || grant.owner.top !== `${top.processId}:${top.routingId}` || grant.frameGeneration !== grant.generation) return false
      let anchor = focused
      while (anchor.parent && anchor.parent !== top) {
        if (anchor.origin !== grant.origin) return false
        anchor = anchor.parent
      }
      return anchor.parent === top && anchor.origin === grant.origin && anchor.frameTreeNodeId === grant.frameNode
        && `${anchor.processId}:${anchor.routingId}` === grant.frame
    } catch { return false }
  }
  revoke(id: string): void { const g = this.grants.get(id); if (g) g.live = false }
  revokeOwner(id: number): void { for (const g of this.grants.values()) if (g.owner.id === id) g.live = false }
  /** Tombstones survive revocation, so late frame-less worker requests cannot become editor traffic. */
  classify(initiator: string | undefined, target: string): 'allow' | 'deny' | 'other' {
    const principal = [...this.grants.values()].find(g => g.origin === initiator)
    const parsed = canonicalReaderResource(target, 'GET')
    if (principal) return principal.live && parsed?.origin === principal.origin ? 'allow' : 'deny'
    if (initiator?.startsWith('wf-reader:') || target.startsWith('wf-reader:')) return 'deny'
    return 'other'
  }
}

export const readerRegistry = new ReaderRegistry()
export function readerFrameOrigin(frame: Electron.WebFrameMain | null | undefined): string | undefined {
  try {
    for (let current = frame; current; current = current.parent) {
      if (current.origin.startsWith('wf-reader://')) return current.origin
    }
  } catch { return 'wf-reader://unknown' }
  return undefined
}

export type ReaderPolicyReceipt = { request: number; url: string; initiator?: string; allowed: boolean; bootstrap: boolean }
export const readerPolicyReceipts: ReaderPolicyReceipt[] = []
const bootstrapRequests = new Map<string, { grant: ReaderGrant; generation: number; owner: ReaderOwner }>()
const resourceIdentity = (resource: { origin: string; key: string }): string => `${resource.origin}/${resource.key}`

/** Sole session listener. The existing editor/widget policies use navigation/permission handlers;
 * wf-asset performs its own sender validation in its handler. Neither installs onBeforeRequest. */
export function installReaderRequestPolicy(session: Electron.Session, keys: ReadonlySet<string>): void {
  session.webRequest.onBeforeRequest((details, callback) => {
    const parsed = canonicalReaderResource(details.url, details.method)
    const g = parsed ? readerRegistry.grants.get(parsed.origin.slice('wf-reader://'.length)) : undefined
    const frameOrigin = readerFrameOrigin(details.frame)
    const origin = details.initiatorOrigin
    const decision = readerRegistry.classify(origin, details.url)
    let bootstrap = false
    if (g?.live && !g.entryUsed && parsed?.key === 'reader-host.html' && keys.has(parsed.key) && details.resourceType === 'subFrame'
      && details.webContentsId === g.owner.id && origin === g.owner.origin) {
      try {
        const parent = details.frame?.parent
        bootstrap = !!parent && `${parent.processId}:${parent.routingId}` === g.owner.top && !parent.parent
        if (bootstrap) {
          g.entryUsed = true
          g.frame = `${details.frame!.processId}:${details.frame!.routingId}`
          g.frameNode = details.frame!.frameTreeNodeId
          bootstrapRequests.set(resourceIdentity(parsed), { grant: g, generation: g.generation, owner: { ...g.owner } })
        }
      } catch { bootstrap = false }
    }
    const reader = !!frameOrigin || decision !== 'other'
    const allowed = bootstrap || (reader
      ? !!g?.live && !!parsed && keys.has(parsed.key) && decision === 'allow' && (!frameOrigin || frameOrigin === g.origin)
      : true)
    if (reader || bootstrap) {
      readerPolicyReceipts.push({ request: details.id, url: details.url, initiator: origin, allowed, bootstrap })
      if (readerPolicyReceipts.length > 512) readerPolicyReceipts.shift()
    }
    callback({ cancel: !allowed })
  })
}
export function consumeReaderBootstrap(url: string): boolean {
  const parsed = canonicalReaderResource(url, 'GET')
  if (!parsed || parsed.key !== 'reader-host.html') return false
  const key = resourceIdentity(parsed)
  const pending = bootstrapRequests.get(key)
  if (!pending) return false
  bootstrapRequests.delete(key)
  const { grant, generation, owner } = pending
  return grant.live && grant.entryUsed && readerRegistry.grants.get(grant.id) === grant
    && grant.generation === generation && grant.owner.id === owner.id && grant.owner.top === owner.top
    && grant.owner.epoch === owner.epoch && grant.owner.origin === owner.origin
}

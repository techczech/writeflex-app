import { readScratchInventory } from './scratchpad-inventory'
import { attachCanonicalReference, collectCanonicalSource, prepareCanonicalReference, readCanonicalSources, undoCanonicalAttach } from './scratchpad-references'
import { readCheckedScratchWidget } from './scratchpad-assets'
import { scratchpadHolder } from './scratchpad-holders'
export { scratchpadHolder, liveScratchpadHolders } from './scratchpad-holders'
import type { ScratchpadStore } from './scratchpad-store'
import type { Workspace } from './workspace'
import type { ScratchExternalResult, ScratchExternalStatus, ScratchItem, ScratchReply, ScratchSnapshot } from '../shared/scratchpad-items'
import { scratchpadExternalSources, type ScratchpadExternalSources } from './scratchpad-external'

type ScratchpadIpcEvent = { sender: { id: number } }
export type ScratchpadIpcRegistrar = { handle: (channel: string, handler: (event: ScratchpadIpcEvent, input: unknown) => unknown) => void }

export type ScratchpadIpcDependencies = {
  /** The calling window's binding; the store is the one made for that window's Workspace. */
  stateForSender: (id: number) => { workspace: Workspace | null; scratchpad: ScratchpadStore | null }
  /** Something in `root`'s Scratchpad changed: every window bound to that folder re-lists. */
  announce: (root: string) => void
  /** The restore point an evidence write is made under (the same checkpoint the Folio room uses);
   *  absent in tests, where the evidence operation's own expectation guard still applies. */
  checkpointFile?: (sender: number, path: string) => Promise<void>
  /** The optional-source service (ticket 05); absent in tests, where the shared unbound
   *  service answers every source off without any discovery. */
  external?: ScratchpadExternalSources
}

type Bound = { workspace: Workspace; store: ScratchpadStore; root: string; input: Record<string, unknown>; sender: number }

const STALE = 'This window now shows another folder, so nothing was changed. Try again.'

const NO_FOLDER = 'Open a folder first.'

/**
 * The floating Scratchpad's IPC (ticket 01). Every call names the folder the renderer believes it is in;
 * main answers only when that is the calling window's bound folder, so an answer started before a folder
 * switch can neither write into the new one nor be shown there. Paths are workspace-relative and checked
 * by the store against the Workspace guard. Replies are `{ ok }` values: a refusal is a message for the
 * writer, never an exception across the bridge.
 */
export function registerScratchpadIpc(ipc: ScratchpadIpcRegistrar, deps: ScratchpadIpcDependencies): void {
  const bind = (event: ScratchpadIpcEvent, raw: unknown): Bound | string => {
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
    if (!input) return 'The request was not complete, so nothing was changed.'
    const state = deps.stateForSender(event.sender.id)
    if (!state.workspace || !state.scratchpad) return NO_FOLDER
    if (input.root !== state.workspace.root) return STALE
    return { workspace: state.workspace, store: state.scratchpad, root: state.workspace.root, input, sender: event.sender.id }
  }
  const handle = <T extends Record<string, unknown>>(channel: string, run: (bound: Bound) => Promise<T>, options: { announces?: boolean } = {}): void => {
    ipc.handle(channel, async (event, raw): Promise<ScratchReply<T>> => {
      const bound = bind(event, raw)
      if (typeof bound === 'string') return { ok: false, error: bound }
      try {
        const value = await run(bound)
        if (options.announces !== false) deps.announce(bound.root)
        return { ok: true, ...value } as ScratchReply<T>
      } catch (error) {
        return { ok: false, error: error instanceof Error && error.message ? error.message : 'The Scratchpad could not do that.' }
      }
    })
  }
  const str = (value: unknown, what: string): string => {
    if (typeof value !== 'string') throw new Error(`The request named no ${what}, so nothing was changed.`)
    return value
  }
  const ids = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length === 0 || value.length > 500 || value.some((id) => typeof id !== 'string')) throw new Error('Choose Scratchpad items first.')
    return value as string[]
  }

  handle('scratchpad:list', async ({ store, input }): Promise<{ snapshot: ScratchSnapshot }> => ({
    snapshot: await store.list({ activePath: typeof input.activePath === 'string' ? input.activePath : null }),
  }), { announces: false })
  handle('scratchpad:get', async ({ store, input }): Promise<{ item: ScratchItem }> => ({ item: await store.get(str(input.id, 'item')) }), { announces: false })
  handle('scratchpad:inventory', async ({ workspace, input }) => {
    if (input.scope !== 'part' && input.scope !== 'folio') throw new Error('Choose This part or Whole Folio.')
    return readScratchInventory(workspace, { activePath: str(input.activePath, 'document'), scope: input.scope })
  }, { announces: false })
  handle('scratchpad:collect-asset', async ({ workspace, store, root, sender, input }) => {
    if (!['pic', 'svg', 'table', 'widget'].includes(str(input.kind, 'asset kind'))) throw new Error('Unsupported Scratchpad asset.')
    const origin = str(input.origin, 'document')
    const current = await readScratchInventory(workspace, { activePath: origin, scope: 'part' })
    const source = current.items.find(item => item.kind === input.kind && item.markdown === input.markdown && item.document?.from === input.from && item.document?.to === input.to)
    if (!source) throw new Error('That source changed. Refresh In this document and collect it again.')
    if (deps.stateForSender(sender).workspace?.root !== root) throw new Error(STALE)
    if (source.kind !== 'pic' && source.kind !== 'svg' && source.kind !== 'table' && source.kind !== 'widget') throw new Error('Choose a visual asset.')
    return { item: await store.addAsset({ origin, markdown: source.markdown, kind: source.kind, heading: source.origin.heading, capturedSpan: source.document }) }
  })
  handle('scratchpad:sources', async ({ workspace, store, root, sender, input }) => {
    const result = await readCanonicalSources(workspace, store, str(input.activePath, 'document'))
    if (deps.stateForSender(sender).workspace?.root !== root) throw new Error(STALE)
    return result
  }, { announces: false })
  handle('scratchpad:collect-source', async ({ workspace, store, root, sender, input }) => {
    const item = await collectCanonicalSource(workspace, store, { activePath: str(input.activePath, 'document'), sourceId: str(input.sourceId, 'source') })
    if (deps.stateForSender(sender).workspace?.root !== root) throw new Error(STALE)
    return { item }
  })
  handle('scratchpad:prepare-reference', async ({ workspace, store, root, sender, input }) => {
    if (input.action !== 'quote' && input.action !== 'cite' && input.action !== 'link') throw new Error('Choose Cite, Insert link or Insert quote with citation.')
    const prepared = await prepareCanonicalReference(workspace, store, { id: str(input.id, 'item'), action: input.action, destination: str(input.destination, 'document') })
    if (deps.stateForSender(sender).workspace?.root !== root) throw new Error(STALE)
    return prepared
  }, { announces: false })
  handle('scratchpad:attach-reference', async ({ workspace, store, root, sender, input }) => {
    const result = await attachCanonicalReference(workspace, store,
      { id: str(input.id, 'item'), destination: str(input.destination, 'document') },
      { session: `scratchpad-${sender}`, ...(deps.checkpointFile ? { checkpoint: (path: string) => deps.checkpointFile!(sender, path) } : {}) })
    if (deps.stateForSender(sender).workspace?.root !== root) throw new Error(STALE)
    return result
  })
  handle('scratchpad:undo-attach', async ({ workspace, store, root, sender, input }) => {
    const result = await undoCanonicalAttach(workspace, store,
      { id: str(input.id, 'item'), token: str(input.token, 'undo token'), destination: str(input.destination, 'document') },
      { session: `scratchpad-${sender}`, ...(deps.checkpointFile ? { checkpoint: (path: string) => deps.checkpointFile!(sender, path) } : {}) })
    if (deps.stateForSender(sender).workspace?.root !== root) throw new Error(STALE)
    return result
  })
  handle('scratchpad:send-text', async ({ store, input }): Promise<{ item: ScratchItem }> => ({
    item: await store.addText({
      origin: str(input.origin, 'document'), markdown: str(input.markdown, 'text'), how: 'copy', by: 'writer',
      heading: typeof input.heading === 'string' ? input.heading : null,
    }),
  }))
  handle('scratchpad:reserve-cut', async ({ store, input, sender }) => { await store.reserveCut(str(input.id, 'item'), scratchpadHolder(sender)); return {} })
  handle('scratchpad:cancel-cut', async ({ store, input, sender }) => { await store.cancelCut(str(input.id, 'item'), scratchpadHolder(sender)); return {} })
  handle('scratchpad:confirm-cut', async ({ store, input, sender }) => { await store.confirmCut(str(input.id, 'item'), scratchpadHolder(sender)); return {} })
  handle('scratchpad:discard-copy', async ({ store, input }) => { await store.discardCopy(str(input.id, 'item')); return {} })
  handle('scratchpad:delete-forever', async ({ store, input }) => { await store.deleteRejected(str(input.id, 'item'), str(input.version, 'shown item version')); return {} })
  handle('scratchpad:set-status', async ({ store, input }) => {
    if (input.status !== 'active' && input.status !== 'rejected') throw new Error('Unknown status.')
    await store.setStatus(ids(input.ids), input.status)
    return {}
  })
  handle('scratchpad:set-group', async ({ store, input }) => {
    await store.setGroup(ids(input.ids), input.group === null ? null : str(input.group, 'group'))
    return {}
  })
  handle('scratchpad:create-group', async ({ store, input }) => ({ group: await store.createGroup(str(input.name, 'group name')) }))
  handle('scratchpad:toggle-done', async ({ store, input }) => { await store.toggleDone(str(input.id, 'item')); return {} })
  handle('scratchpad:set-colour', async ({ store, input }) => {
    await store.setColour(str(input.id, 'item'), input.colour === null ? null : str(input.colour, 'colour'))
    return {}
  })
  handle('scratchpad:record-use', async ({ store, input, sender }) => {
    const use = input.use && typeof input.use === 'object' ? (input.use as Record<string, unknown>) : {}
    if (use.mode !== 'copy' && use.mode !== 'put-back') throw new Error('Not a use record.')
    await store.recordUse(str(input.id, 'item'), { useId: str(use.useId, 'use'), path: str(use.path, 'document'), mode: use.mode, holder: scratchpadHolder(sender) })
    return {}
  })
  handle('scratchpad:release-uses', async ({ store, input, sender, root }) => {
    const keep = Array.isArray(input.keep) && input.keep.length <= 10_000 && input.keep.every((id) => typeof id === 'string') ? (input.keep as string[]) : null
    if (!keep) throw new Error('The request was not complete, so nothing was changed.')
    const dropped = await store.releaseUses(str(input.path, 'document'), scratchpadHolder(sender), keep)
    if (dropped > 0) deps.announce(root)
    return { dropped }
  }, { announces: false })
  handle('scratchpad:drop-use', async ({ store, input, sender }) => { await store.dropUse(str(input.id, 'item'), str(input.useId, 'use'), scratchpadHolder(sender)); return {} })
  handle('scratchpad:prepare-insert', async ({ store, input }) => {
    const prepared = await store.prepareInsert(str(input.id, 'item'), str(input.destination, 'document'))
    if (!prepared.ok) throw new Error(prepared.error)
    return { markdown: prepared.markdown, rewritten: prepared.rewritten }
  }, { announces: false })
  // One read, checked once, mounted as returned: there is no renderer-side widget read on this
  // path, so the bytes that run are the bytes that passed. A saved item is named by id only —
  // any payload the renderer also sends is ignored; the store's current payload governs. A
  // document asset is re-derived from the live inventory at its exact span first.
  handle('scratchpad:prepare-widget-preview', async ({ workspace, store, root, sender, input }) => {
    let prepared: { html: string; title: string; markdown: string }
    if (typeof input.id === 'string') {
      const item = await store.get(input.id)
      if (item.external) {
        // An external widget runs from its checked source bytes (or its recorded local
        // copy), through the external service — the returned page is exactly what passed.
        const external = deps.external ?? scratchpadExternalSources()
        prepared = { ...(await external.prepareWidget(workspace, item)), markdown: item.markdown }
      } else {
        const result = await store.prepareWidgetPreview(input.id)
        if (!result.ok) throw new Error(result.error)
        prepared = result
      }
    } else {
      const origin = str(input.origin, 'document')
      const current = await readScratchInventory(workspace, { activePath: origin, scope: 'part' })
      const source = current.items.find(item => item.kind === 'widget' && item.markdown === input.markdown && item.document?.from === input.from && item.document?.to === input.to)
      if (!source) throw new Error('The source changed. Refresh In this document and try again.')
      if (source.problem) throw new Error(source.problem)
      prepared = { ...(await readCheckedScratchWidget(root, origin, source.markdown)), markdown: source.markdown }
    }
    if (deps.stateForSender(sender).workspace?.root !== root) throw new Error(STALE)
    return prepared
  }, { announces: false })

  // ── Optional source connections (ticket 05) ────────────────────────────────────────────
  // The service owns the off-by-default gate and the epoch: these handlers only validate the
  // request shape and the window's folder. A disabled source is refused HERE in main even
  // when a renderer calls the channel directly; the service makes zero discovery calls then.
  const externalService = (): ScratchpadExternalSources => deps.external ?? scratchpadExternalSources()
  const sourceOf = (value: unknown): 'talkweaver' | 'slidewell' => {
    if (value !== 'talkweaver' && value !== 'slidewell') throw new Error('Choose TalkWeaver vaults or SlideWell.')
    return value
  }
  handle('scratchpad:external-status', async ({ root, sender, input }): Promise<{ status: ScratchExternalStatus }> => {
    const status = await externalService().status(sourceOf(input.source))
    if (deps.stateForSender(sender).workspace?.root !== root) throw new Error(STALE)
    return { status }
  }, { announces: false })
  handle('scratchpad:external-search', async ({ store, root, sender, input }): Promise<{ results: ScratchExternalResult[]; status: ScratchExternalStatus; note?: string }> => {
    const source = sourceOf(input.source)
    const service = externalService()
    const found = await service.search(source, {
      query: typeof input.query === 'string' ? input.query : '',
      ...(typeof input.vault === 'string' ? { vault: input.vault } : {}),
      ...(input.mode === 'meaning' || input.mode === 'words' ? { mode: input.mode } : {}),
    })
    if (deps.stateForSender(sender).workspace?.root !== root) throw new Error(STALE)
    // Say which results this folder already collected (same provider identity + shown
    // version), so the tab offers each asset once. Provider ids stay inside main.
    const collected = new Map<string, string>()
    for (const item of await store.listLossless([])) {
      if (item.external && item.status === 'active') collected.set(`${item.external.providerId}\n${item.external.sha256}`, item.id)
    }
    if (deps.stateForSender(sender).workspace?.root !== root) throw new Error(STALE)
    const results = found.results.map((result) => {
      const identity = service.identityOf(result.handle)
      const collectedId = identity ? collected.get(`${identity.providerId}\n${identity.sha256}`) : undefined
      return collectedId ? { ...result, collectedId } : result
    })
    const status = await service.status(source)
    if (deps.stateForSender(sender).workspace?.root !== root) throw new Error(STALE)
    return { results, status, ...(found.note ? { note: found.note } : {}) }
  }, { announces: false })
  handle('scratchpad:external-collect', async ({ store, root, sender, input }): Promise<{ item: ScratchItem }> => {
    const item = await externalService().collect(store, {
      handle: str(input.handle, 'result'),
      activePath: str(input.activePath, 'document'),
      by: 'writer',
      group: input.group === null || input.group === undefined ? null : str(input.group, 'group'),
    })
    if (deps.stateForSender(sender).workspace?.root !== root) throw new Error(STALE)
    return { item }
  })
  handle('scratchpad:external-import', async ({ workspace, store, root, sender, input }): Promise<{ markdown: string; copied: boolean }> => {
    const item = await store.get(str(input.id, 'item'))
    if (!item.external) throw new Error('That item did not come from a connected source.')
    const done = await externalService().importForInsert(workspace, store, item, store.documentPath(str(input.destination, 'document')))
    if (deps.stateForSender(sender).workspace?.root !== root) throw new Error(STALE)
    return { markdown: done.markdown, copied: done.copied }
  })
}

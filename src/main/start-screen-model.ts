import { statSync } from 'node:fs'
import type { ExampleCollection, ExampleView } from './example-collection'
import type { RecentWorkspace, SettingsStore } from './settings'

/**
 * What the start screen shows, as one answer (ADR-0043): the two marked entries or none, the
 * person's pins in the order they are numbered, and the recents that are not pins. The native
 * menu's Open Recent list is built from the same lists. The renderer compares no paths itself.
 */
export type StartScreenModel = {
  example: ExampleView | null
  pinned: Array<{ root: string; missing: boolean }>
  recents: RecentWorkspace[]
}

type Lists = Pick<SettingsStore, 'pinned' | 'recents'>

/** The person's pins, and their recents that are not pins — with the shown Example collection in
 *  neither (the store's one rule). Read from memory: no filesystem call. */
export function startScreenLists(settings: Lists): { pinned: string[]; recents: RecentWorkspace[] } {
  const pinned = settings.pinned()
  return { pinned, recents: settings.recents().filter((recent) => !pinned.includes(recent.root)) }
}

/**
 * The whole model. The example check resolves FIRST, so the lists are read knowing whether the
 * marked entry stands in place of an entry for its path: the example can never take a ⌘ number.
 */
export async function startScreenModel(settings: Lists, example: Pick<ExampleCollection, 'view'> | undefined): Promise<StartScreenModel> {
  const view = (await example?.view()) ?? null
  const lists = startScreenLists(settings)
  return {
    example: view,
    pinned: lists.pinned.map((root) => {
      let missing = true
      try { missing = !statSync(root).isDirectory() } catch { /* absent */ }
      return { root, missing }
    }),
    recents: lists.recents,
  }
}

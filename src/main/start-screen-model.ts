import { statSync } from 'node:fs'
import type { ExampleCollection, ExampleView } from './example-collection'
import { vaultFigures } from './vault-presence'
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

/** A vault as its start-screen card shows it. `works` and `inProgress` are null until the vault's index has been saved once. */
export type StartVault = {
  root: string
  name: string
  /** The root's path, home written `~`. */
  location: string
  works: number | null
  inProgress: number | null
  /** When this Mac last opened it (ms), or null. The nearest record of "last worked by you". */
  lastWorked: number | null
}

export type StartScreenModelWithVaults = StartScreenModel & { vaults: StartVault[] }

function tilde(root: string, home: string): string {
  const base = home.replace(/\/+$/, '')
  return base && (root === base || root.startsWith(`${base}/`)) ? `~${root.slice(base.length)}` : root
}

/**
 * Vaults are listed once, in their own row: every pinned or recent root that holds a vault file is
 * taken out of `pinned` and `recents` and becomes a card (a pinned vault keeps its pin in settings;
 * it simply has no ⌘ number here, and the remaining pins number from ⌘1). Order: pins, then recents.
 */
export async function withVaults(
  model: StartScreenModel,
  settings: Pick<SettingsStore, 'recents'>,
  options: { cacheDir: string | null; home: string },
): Promise<StartScreenModelWithVaults> {
  const opened = new Map(settings.recents().map((r) => [r.root, r.openedAt]))
  const roots = [...new Set([...model.pinned.filter((p) => !p.missing).map((p) => p.root), ...model.recents.map((r) => r.root)])]
  const found = await Promise.all(roots.map(async (root) => [root, await vaultFigures(root, options.cacheDir)] as const))
  const vaults: StartVault[] = []
  for (const [root, figures] of found) {
    if (!figures) continue
    vaults.push({ root, name: figures.name, location: tilde(root, options.home), works: figures.works, inProgress: figures.inProgress, lastWorked: opened.get(root) ?? null })
  }
  const isVault = new Set(vaults.map((v) => v.root))
  return {
    ...model,
    vaults,
    pinned: model.pinned.filter((p) => !isVault.has(p.root)),
    recents: model.recents.filter((r) => !isVault.has(r.root)),
  }
}

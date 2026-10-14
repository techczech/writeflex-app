// The one small notifier every route by which a registry command runs calls (ADR-0043, ticket 07):
// `commandRan(id)`. Commands do not pass through one function (the palette, Actions here, the editor
// keymap, the app chord table, and the surfaces that own a place each run their own), so each route
// reports here once it has run the command, and listeners decide what that means. The Guide's
// progress is one listener: App forwards each id to main, which keeps the record for every window.
//
// Call it only when the command ran. A command that declined (a `when` that no longer holds, a
// keymap command returning false) is not a run, so it must not tick a row.

type Listener = (id: string) => void
const listeners = new Set<Listener>()

/** A registry command ran, by any route. Safe to call with ids that belong to no chapter. */
export function commandRan(id: string): void {
  for (const listener of listeners) listener(id)
}

/**
 * The native menu's items that are registry commands: menu action (as `src/main/menu.ts` sends it) to
 * the command id. The menu is a route of its own (a click arrives as `menu:action`, not through the
 * palette's rows), so App reports these from one listener. Items that are not registry commands
 * (Checkpoint, Close Tab, the zoom steps, New File/Folder, Open…) are key-only rows and are not here.
 */
export const MENU_ACTION_COMMANDS: Readonly<Record<string, string>> = {
  'capture-idea': 'idea.capture',
  'follow-wikilink': 'navigation.followWikilink',
  'materialise-stub': 'idea.materialise',
  'toggle-outline': 'view.outline',
  'open-board': 'collection.openBoard',
  'open-tabs': 'view.openTabs',
  'next-tab': 'navigation.nextTab',
  'previous-tab': 'navigation.previousTab',
  'next-folder-file': 'navigation.nextFolderFile',
  'previous-folder-file': 'navigation.previousFolderFile',
  'open-review': 'app.review',
  'open-versions': 'app.versions',
  'toggle-typewriter': 'view.typewriter',
  'quick-open': 'app.quickOpen',
  'command-palette': 'app.commandPalette',
  'open-files': 'view.files',
  'search': 'app.search',
  'archive-search': 'archive.search',
  'name-version': 'file.nameVersion',
  'redo': 'edit.redo',
}

/** Listen for runs; returns the stop function. */
export function onCommandRan(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

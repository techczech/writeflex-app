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

/** Listen for runs; returns the stop function. */
export function onCommandRan(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

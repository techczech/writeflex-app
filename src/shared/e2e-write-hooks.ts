/**
 * The e2e write hooks: the harness's ways of holding, failing or interleaving a write (another program
 * writing between a save and its readback, a save held at main, a rename, accept or export held inside
 * the owner's route). They exist only in an unpackaged build run with `WRITEFLEX_E2E=1`, as
 * example-collection.ts gates its own (save fix, parcel 1 review S1; parcel 3 for the renderer's).
 *
 * Main decides (it alone knows `app.isPackaged`) and tells the window's preload by one command-line
 * argument; the preload exposes it as `e2eWriteHooks`. A packaged build never passes the argument, so
 * none of the renderer's hold or fail hooks is installed there, whatever the environment says.
 */
export const E2E_WRITE_HOOKS_ARGUMENT = '--writeflex-e2e-write-hooks'

export function e2eWriteHooksAllowed(environment: Readonly<Record<string, string | undefined>>, isPackaged: boolean): boolean {
  return environment.WRITEFLEX_E2E === '1' && !isPackaged
}

/** The window's `additionalArguments` for the hooks: the one argument, or none. */
export function e2eWriteHooksArguments(environment: Readonly<Record<string, string | undefined>>, isPackaged: boolean): string[] {
  return e2eWriteHooksAllowed(environment, isPackaged) ? [E2E_WRITE_HOOKS_ARGUMENT] : []
}

/** The preload's reading: the argument main passed, and the e2e flag as well. */
export function e2eWriteHooksFromProcess(argv: readonly string[], environment: Readonly<Record<string, string | undefined>>): boolean {
  return environment.WRITEFLEX_E2E === '1' && argv.includes(E2E_WRITE_HOOKS_ARGUMENT)
}

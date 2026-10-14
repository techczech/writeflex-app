/**
 * The e2e harness's stand-in for the Bin (ticket 10). A test run must never reach the real Bin, so
 * `resolveExampleTrash` hands the removal this function instead, and only when the app is unpackaged,
 * `WRITEFLEX_E2E` is `1` and `WRITEFLEX_E2E_BIN` names a directory that is not a symlink and lies
 * inside the system temporary directory (`harnessBinInsideTemp`, checked on every call). `bin` is
 * that directory's real path. It moves the folder into it, as the Bin would, and creates nothing.
 * No normal launch can reach this file's one call.
 */
import { rename } from 'node:fs/promises'
import { basename, join } from 'node:path'

export async function moveIntoHarnessBin(path: string, bin: string): Promise<void> {
  await rename(path, join(bin, `${basename(path)} ${Date.now()}`))
}

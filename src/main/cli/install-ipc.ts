import { installShim, type InstallResult } from './shim'

type Registrar = { handle: (channel: string, listener: () => unknown) => void }

/** The Settings button's one channel. The bundle identifier is the running app's own, so a beta build
 *  installs a shim that finds the beta app. */
export function registerCliInstallIpc(ipc: Registrar, bundleId: string, install: typeof installShim = installShim): void {
  ipc.handle('cli:install', (): Promise<InstallResult> => install({ bundleId }))
}

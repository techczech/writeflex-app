// Pure logic of the main-process bootstrap (bootstrap.ts). It imports no app code and no Electron,
// so a module-load failure in the real main bundle is reported by us (marker + exit in smoke mode,
// error box otherwise) instead of by Electron's own dialog.
// No imports: bootstrap.js must be self-contained (a chunk that fails to link would fail before the
// bootstrap's handlers exist). The condition is a superset of packaged-smoke.ts's; a test checks that.

export const MAIN_LOAD_FAILED_MARKER = 'WRITEFLEX_MAIN_LOAD_FAILED'
export const SMOKE_DIALOG_MARKER = 'WRITEFLEX_SMOKE_DIALOG'

type Env = Readonly<Record<string, string | undefined>>

export interface BootstrapDependencies {
  env: Env
  exit(code: number): void
  importer(): Promise<unknown>
  isPackaged: boolean
  showErrorBox(title: string, content: string): void
  writeStderr(text: string): void
}

/**
 * Automated mode: the packaged launch smoke or any e2e launch (WRITEFLEX_E2E=1, packaged or not).
 * Nothing may reach the screen in it, so failures and dialogs become a marker plus exit. A normal
 * user launch, and a plain dev run without the variable, are not automated.
 */
export function isSmokeMode(env: Env, _isPackaged?: boolean): boolean {
  return env.WRITEFLEX_E2E === '1'
}

function wordsFor(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error)
}

export function reportMainLoadFailure(error: unknown, dependencies: BootstrapDependencies): void {
  if (isSmokeMode(dependencies.env, dependencies.isPackaged)) {
    try {
      dependencies.writeStderr(`${MAIN_LOAD_FAILED_MARKER}\n${wordsFor(error)}\n`)
    } catch {
      // A closed stderr must not stop the exit.
    }
  } else {
    dependencies.showErrorBox('WriteFlex could not start', error instanceof Error ? error.message : String(error))
  }
  dependencies.exit(1)
}

export async function loadMain(dependencies: BootstrapDependencies): Promise<void> {
  try {
    await dependencies.importer()
  } catch (error) {
    reportMainLoadFailure(error, dependencies)
  }
}

/** In smoke mode, any uncaught error prints the marker and exits; no UI. */
export function installSmokeFatalHandlers(
  emitter: { on(event: 'uncaughtException' | 'unhandledRejection', listener: (error: unknown) => void): unknown },
  dependencies: Pick<BootstrapDependencies, 'env' | 'exit' | 'isPackaged' | 'writeStderr'>,
): void {
  if (!isSmokeMode(dependencies.env, dependencies.isPackaged)) return
  const handler = (kind: string) => (error: unknown): void => {
    try {
      dependencies.writeStderr(`${MAIN_LOAD_FAILED_MARKER}\n${kind}: ${wordsFor(error)}\n`)
    } catch {
      // ignore
    }
    dependencies.exit(1)
  }
  emitter.on('uncaughtException', handler('uncaughtException'))
  emitter.on('unhandledRejection', handler('unhandledRejection'))
}

const DIALOG_METHODS = ['showMessageBox', 'showMessageBoxSync', 'showErrorBox', 'showOpenDialog', 'showOpenDialogSync', 'showSaveDialog', 'showSaveDialogSync', 'showCertificateTrustDialog'] as const

/**
 * Smoke mode must never put a dialog on screen: every Electron dialog call prints a marker and
 * exits instead (the smoke script fails on the marker). Backstop for any startup path not gated.
 */
export function installSmokeDialogGuard(
  dialogLike: Record<string, unknown>,
  dependencies: Pick<BootstrapDependencies, 'env' | 'exit' | 'isPackaged' | 'writeStderr'>,
): void {
  if (!isSmokeMode(dependencies.env, dependencies.isPackaged)) return
  for (const method of DIALOG_METHODS) {
    dialogLike[method] = (...args: unknown[]): never | Promise<never> => {
      try { dependencies.writeStderr(`${SMOKE_DIALOG_MARKER}: dialog.${method} called in smoke mode\n`) } catch { /* ignore */ }
      dependencies.exit(1)
      return method.endsWith('Sync') || method === 'showErrorBox' ? (undefined as never) : Promise.resolve(undefined as never)
    }
  }
}

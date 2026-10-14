import { withoutAbsolutePaths } from '../../shared/plain-error-text'

/** Remove Electron's invoke wrapper so renderer errors retain the main process's human message. */
export function humanReadableError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  const stripped = error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  return stripped || fallback
}

/** The same, with no absolute path left in it: for text that goes straight to the status bar. */
export function plainErrorForScreen(error: unknown, fallback: string): string {
  return withoutAbsolutePaths(humanReadableError(error, fallback)) || fallback
}

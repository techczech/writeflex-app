// `writeflex settings <list|get|set|reset|changes|export|import|undo-import> [--json]`
// The agent path to the same settings file and changelog the Settings window uses (changes are logged
// as made by an agent). Runs with bun (`bun run settings -- list`, bin/writeflex.mjs) or inside the
// installed `writeflex` command (main/writeflex-cli.ts); needs no Electron.
// Keys and sign-ins are never read or printed here: they show only as connected or missing in Settings.
import { runShortcutMutation } from './settings-shortcuts'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runSettingsCli, type LockOptions, type SettingsCliIO } from '@app-patterns/settings/node'
import { APP_NAME } from '../shared/settings-schema'
import { runMigration, storeOptions } from '../main/settings-migration'
import { userDataDir } from './paths'

export const SETTINGS_ROUTE = { verb: 'settings', args: '<list|get|set|reset|changes|export|import|undo-import> [--json]', summary: 'Read and change app preferences through the Settings store and changelog; never returns account keys.', group: 'App settings', behaviour: 'direct' } as const

export const SETTINGS_USAGE = 'Usage: writeflex settings <list|get|set|reset|changes|export|import|undo-import> [--json]\n'

/** The app's version from its package.json (the bundle's own when run inside the installed app). */
export function appVersion(packageJsonPath: string = fileURLToPath(new URL('../../package.json', import.meta.url))): string {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const processIO: SettingsCliIO = { stdout: (t) => void process.stdout.write(t), stderr: (t) => void process.stderr.write(t) }

/** `dir`, `io`, `version` and `lock` are injectable for tests; by default the real userData folder and the terminal. */
export async function run(argv: string[], io: SettingsCliIO = processIO, dir: string = userDataDir(), version: string = appVersion(), lock?: LockOptions): Promise<number> {
  // Run before the app has started this version: move the old settings.json's preferences first,
  // exactly as the app would, so the CLI never creates an empty settings file that would hide them.
  const migration = await runMigration(dir, version, lock ? { lock } : {})
  if (migration.kind === 'unreadable' || migration.kind === 'refused') {
    io.stderr(`WriteFlex could not move its settings to the new settings file (${migration.reason}). Nothing was changed.\n`)
    return 1
  }
  if (migration.kind === 'not-saved') {
    io.stderr('WriteFlex could not write its new settings file. Nothing was changed.\n')
    return 1
  }
  if (migration.kind === 'again' && migration.notSaved.length > 0) {
    io.stderr(`${migration.notSaved.length} setting(s) changed in an older WriteFlex could not be applied yet; they are tried again next time.\n`)
  }
  const shortcutResult = await runShortcutMutation(argv, io, dir, version, lock)
  if (shortcutResult !== undefined) return shortcutResult
  const { appVersion: _appVersion, ...options } = storeOptions(dir, version)
  return runSettingsCli(argv, { ...options, version, appName: APP_NAME, ...(lock ? { lock } : {}) }, io)
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)))

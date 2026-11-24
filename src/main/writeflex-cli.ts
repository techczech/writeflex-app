/** Headless command entry. Bootstrap selects this bundled module before starting the desktop app. */
import { setSyncAppendProtection, syncSwitchedOnIn } from './git-vault-sync-private-history'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentArguments, commandLineAgentParams, runWriteFlexAgent } from './agent-skill-host'
import { resolveAppVariant } from './app-variant'
import { runCli } from './cli/run'
import { readCapped } from './cli/stdin'
import { userDataDir } from '../cli/paths'
import { REPLY_KEY_FOLDER } from './reply-key'

/**
 * Which app this command line belongs to, and so whose application-data folder it writes its undo
 * journal in (collection-records.ts): the bundle it runs from says, in the same `package.json` the app
 * reads for itself (`<bundle>/package.json`, two folders above this file). Run from anywhere else, or
 * when that cannot be read, it is the release app's, as the app itself decides.
 */
function ownVariant(): ReturnType<typeof resolveAppVariant>['userDataDirectoryName'] {
  try {
    return resolveAppVariant(JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as unknown).userDataDirectoryName
  } catch {
    return resolveAppVariant(undefined).userDataDirectoryName
  }
}

/**
 * `writeflex agent status|install|remove [--agent <id>] [--json]`: the agent's path to the built-in agent skill, the same
 * module as the Settings card (agent-skill-host.ts). Not an operation on a Collection, so it needs no root and takes no lock.
 */
async function runAgentRoute(args: string[]): Promise<number> {
  let packageJson: unknown
  try { packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as unknown } catch { packageJson = undefined }
  const params = commandLineAgentParams({ appRoot: dirname(dirname(dirname(fileURLToPath(import.meta.url)))), home: homedir(), packageJson })
  return runWriteFlexAgent(args, params, { stdout: (text) => { process.stdout.write(text) }, stderr: (text) => { process.stderr.write(text) } })
}

export async function runCommandLine(args: string[]): Promise<number> {
  try {
    const variant = ownVariant()
    const profile = userDataDir(variant)
    // Vault sync's history-append protection follows the app's launch-time switch (off by default).
    setSyncAppendProtection(syncSwitchedOnIn(profile))
    if (args[0] === 'settings') {
      const { run } = await import('../cli/settings-cli')
      return await run(args.slice(1), undefined, profile)
    }
    const agentArgs = agentArguments(args)
    if (agentArgs) return await runAgentRoute(agentArgs)
    const appRoot = fileURLToPath(new URL('../../', import.meta.url))
    const resources = basename(appRoot) === 'app.asar' ? dirname(appRoot) : undefined
    return await runCli(args, {
      write: {
        variant,
        ...(process.env.WRITEFLEX_DATA_DIR?.trim() ? { keyFolders: [join(profile, REPLY_KEY_FOLDER)] } : {})
      },
      cwd: process.cwd(),
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      // Read once, before any lock, and never past the limit (cli/stdin.ts).
      stdin: () => readCapped(process.stdin as AsyncIterable<Uint8Array>),
      // A document read to a terminal is shown with its control characters made visible; piped, it is exact.
      stdoutIsTerminal: process.stdout.isTTY === true,
    })
  } catch (error) {
    process.stderr.write(`writeflex: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

/**
 * The `writeflex` command, built to `out/main/writeflex-cli.js` beside the app's main bundle and run by
 * the installed app's own binary in Node mode:
 *
 *   ELECTRON_RUN_AS_NODE=1 <WriteFlex binary> writeflex-cli.js [--root <folder>] [--json] <operation> ...
 *
 * Nothing it imports may reach Electron: it runs without the app's runtime.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveAppVariant } from './app-variant'
import { runCli } from './cli/run'
import { readCapped } from './cli/stdin'

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

runCli(process.argv.slice(2), {
  write: { variant: ownVariant() },
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  // Read once, before any lock, and never past the limit (cli/stdin.ts).
  stdin: () => readCapped(process.stdin as AsyncIterable<Uint8Array>),
  // A document read to a terminal is shown with its control characters made visible; piped, it is exact.
  stdoutIsTerminal: process.stdout.isTTY === true,
}).then(
  (code) => { process.exitCode = code },
  (error) => { process.stderr.write(`writeflex: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 },
)

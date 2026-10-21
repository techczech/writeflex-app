/**
 * A second real process for tests/main/cli-versions.test.ts: the command line saving a version.
 *   <root> <path> <name>   prints `started`, runs `save-version`, prints the JSON document, then `exit <code>`
 */
import { tmpdir } from 'node:os'
import { runCli } from '../../src/main/cli/run'

const [root, path, name] = process.argv.slice(2)
const say = (line: string): void => { process.stdout.write(`${line}\n`) }

say('started')
let out = ''
const code = await runCli(['--root', root, '--json', 'save-version', path, '--name', name], {
  cwd: tmpdir(), stdout: (text) => { out += text }, stderr: () => {},
})
say(out.trim())
say(`exit ${code}`)

/**
 * Run one command-line write in this process and, at the Nth write step, print `paused` and wait for
 * a line on standard input before going on. Nothing is killed: the test does what it wants to the
 * Collection while this process waits (takes the owner lock over, writes a file), then lets it go on
 * and reads what the command said.
 *
 *   bun tests/fixtures/cli-paused-write.ts <root> <application data> <pause at step> <operation and arguments...>
 *
 * It says where it is on standard output, a line at a time (`started`, `step 1 <path>`, ..., `paused`,
 * `said <the command's JSON>`, `finished <exit code>`). The undo journal goes to the application-data
 * folder given, never the real one.
 */
import { tmpdir } from 'node:os'
import { runCli } from '../../src/main/cli/run'

const [root, appData, pauseAt, ...argv] = process.argv.slice(2)
const say = (line: string): void => { process.stdout.write(`${line}\n`) }
const released = new Promise<void>((resolve) => { process.stdin.once('data', () => resolve()) })
say('started')
let step = 0
const code = await runCli(['--root', root, '--json', ...argv], {
  cwd: tmpdir(), stdout: (text) => say(`said ${text.trim()}`), stderr: () => {}, openUrl: async () => {},
  write: {
    appDataFolders: [appData], keyFolders: [],
    trash: async () => { throw new Error('no Trash in this fixture') },
    seams: {
      beforeWrite: async (path) => {
        step += 1
        say(`step ${step} ${path}`)
        if (step !== Number(pauseAt)) return
        say('paused')
        await released
      },
    },
  },
})
say(`finished ${code}`)
process.stdin.destroy()

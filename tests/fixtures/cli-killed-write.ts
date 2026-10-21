/**
 * Run one command-line write in this process and stop for ever at the Nth write step, having printed
 * `stopped`, so the test can kill the process between two file writes. `mark-undone` in place of a
 * step number stops an undo after its last change to the Collection, before its entry is marked undone.
 *
 *   bun tests/fixtures/cli-killed-write.ts <root> <application data> <stop at step | mark-undone> <operation and arguments...>
 *
 * It says where it is on standard output, a line at a time (`started`, `step 1`, ..., `stopped`), so a
 * test whose child never stops can say how far it got. The undo journal goes to the application-data
 * folder given, never the real one. The owner lock is taken without asking the process table for this
 * process's start time: these tests are about the journal, and the test kills this process itself.
 */
import { tmpdir } from 'node:os'
import { runCli } from '../../src/main/cli/run'

const [root, appData, stopAt, ...argv] = process.argv.slice(2)
const say = (line: string): void => { process.stdout.write(`${line}\n`) }
say('started')
let step = 0
const stop = async (): Promise<never> => {
  say('stopped')
  return new Promise<never>(() => { setInterval(() => {}, 1000) })
}
const code = await runCli(['--root', root, '--json', ...argv], {
  cwd: tmpdir(), stdout: (text) => say(`said ${text.trim()}`), stderr: () => {}, openUrl: async () => {},
  write: {
    appDataFolders: [appData], keyFolders: [],
    trash: async () => { throw new Error('no Trash in this fixture') },
    lockEnv: { processStartedAt: async () => null },
    seams: {
      beforeWrite: async (path) => {
        step += 1
        say(`step ${step} ${path}`)
        if (step === Number(stopAt)) await stop()
      },
    },
    journalSeams: { beforeMarkUndone: async () => { if (stopAt === 'mark-undone') await stop() } },
  },
})
say(`finished ${code}`)

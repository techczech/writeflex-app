/**
 * Vault sync with Git switched off at launch wires none of its code (the default; Settings › Advanced, next launch).
 * On synthetic vaults left with an interrupted receive or a forked journal, startup, a save, the periodic check and
 * quit start no Git process and change no byte, and the Sync tab writes nothing (git-sync-off-probe.ts).
 */
import { expect, test } from 'bun:test'
import { testWithSafeSyncGit } from './git-sync-prerequisites'

async function probe(scenario: string) {
  const child = Bun.spawn([process.execPath, 'tests/main/git-sync-off-probe.ts', scenario], { cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`${scenario} failed (${code}):\n${err}\n${out}`)
  return JSON.parse(out.trim().split('\n').pop()!).result
}
const expected = { gitProcesses: 0, writes: 0, engines: 0, unchanged: true, marker: true }

testWithSafeSyncGit('switched off: a vault with an interrupted receive is left byte for byte, with no Git process at startup, save or quit', async () => {
  expect(await probe('interrupted')).toEqual(expected)
}, 120000)

test('switched off: a vault with a forked journal is left byte for byte, and app and command-line history saves only append', async () => {
  expect(await probe('forked')).toEqual({ ...expected, history: ['app', 'cli'] })
}, 120000)

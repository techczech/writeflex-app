import { expect } from 'bun:test'
import { testWithSafeSyncGitAndGitleaks } from './git-sync-prerequisites'
for (const mode of ['engine', 'stale', 'invalidation', 'controller', 'held', 'held-controller'] as const) {
  testWithSafeSyncGitAndGitleaks(`large payload selection: ${mode}`, async () => {
    const child = Bun.spawn([process.execPath, 'tests/main/git-vault-sync-large-files-probe.ts', mode], { stdout: 'pipe', stderr: 'pipe' })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    console.info(out.trim()); if (err) console.error(err.trim())
    expect(code).toBe(0)
    const measured = JSON.parse(out.trim().split('\n').at(-1)!)
    expect(measured.nodePayloadReads).toBe(0)
    expect(measured.filterCalls).toEqual([])
    expect(measured.controlDenied).toBe(true)
  }, 240_000)
}

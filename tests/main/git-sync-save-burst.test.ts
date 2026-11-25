import { expect } from 'bun:test'
import { testWithSafeSyncGitAndGitleaks } from './git-sync-prerequisites'

// Electron and timer stand-ins stay in a separate process, as in the quit regressions.
for (const mode of ['burst', 'crash'] as const) {
  testWithSafeSyncGitAndGitleaks(`save bookkeeping: ${mode === 'burst' ? '20 saves share a status pass and send every edit at the deadline' : 'the first save survives a controller crash'}`, async () => {
    const child = Bun.spawn([process.execPath, 'tests/main/git-sync-save-burst-probe.ts', mode], { stdout: 'pipe', stderr: 'pipe' })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    console.info(out.trim())
    expect(err).toBe('')
    expect(code).toBe(0)
    const result = JSON.parse(out.trim().split('\n').at(-1)!)
    if (mode === 'burst') {
      expect(result.statusPasses).toBeLessThanOrEqual(2)
      expect(result.pendingWrites).toBe(1)
      expect(result.settingsWrites).toBe(1)
      expect(result.pendingRequests).toBe(1)
      expect(result.gitProcesses).toBeGreaterThan(0)
      expect(result.immediateState).toBe(3)
      expect(result.beforeDeadline).toBe(result.initialHead)
      expect(result.remoteText).toBe(result.expectedText)
      expect(result.pendingAfterSend).toBe(0)
    } else {
      expect(result.durableBeforeStatus).toBe(true)
      expect(result.reopenedState).toBe(3)
      expect(result.remoteText).toBe(result.expectedText)
    }
  }, 120_000)
}

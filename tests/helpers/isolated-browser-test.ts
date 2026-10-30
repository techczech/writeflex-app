import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { text as consumeText } from 'node:stream/consumers'

// Isolate the complete Bun/Playwright lifecycle: compiler-only isolation still
// timed out in the second browser test on Bun 1.3.10 (see release evidence).
export function isolatedBrowserTest(entryPath: string, name: string, body: () => Promise<void>, timeout: number) {
  if (process.env.WRITEFLEX_BROWSER_TEST_CHILD === entryPath) {
    test(name, body, timeout)
    return
  }
  test(name, async () => {
    const child = spawn(process.execPath, ['test', entryPath], {
      env: { ...process.env, WRITEFLEX_BROWSER_TEST_CHILD: entryPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        consumeText(child.stdout), consumeText(child.stderr), exited,
      ])
      const report = (stdout + stderr).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      if (exitCode !== 0) throw new Error(`Isolated browser test exited ${exitCode}:\n${report}`)
      expect(report).toMatch(/^\s*1 pass\s*$/m)
      expect(report).toMatch(/^\s*0 fail\s*$/m)
      expect(report).toMatch(/^Ran 1 test across 1 file\./m)
      // Keep the original child's assertion count and cleanup receipts visible.
      console.error(report.trim())
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
        await exited.catch(() => {})
      }
    }
  }, timeout)
}

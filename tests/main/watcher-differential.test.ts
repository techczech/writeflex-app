import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

// The review's differential check (tests/helpers/watcher-differential.mjs), run in Node, the runtime of
// Electron's main process. Injected: libuv's event projection replayed through the shared watches, always.
// Native: real FSEvents on macOS, both ways at once; slow (a 12 s positive control) and only meaningful
// where fseventsd delivers events, so it runs with WRITEFLEX_NATIVE_WATCH_TESTS=1.
const helper = fileURLToPath(new URL('../helpers/watcher-differential.mjs', import.meta.url))

async function run(args: string[]): Promise<{ code: number; out: string }> {
  const child = Bun.spawn(['node', helper, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { code, out: stdout + stderr }
}

test('shared folder watches report what plain watches would (injected libuv events)', async () => {
  const { code, out } = await run(['--injected'])
  expect(code, out).toBe(0)
})

test.skipIf(process.platform !== 'darwin' || process.env.WRITEFLEX_NATIVE_WATCH_TESTS !== '1')(
  'shared folder watches report the same names as plain watches (native FSEvents)', async () => {
    const { code, out } = await run([])
    // 77: no positive control arrived (fseventsd not delivering): inconclusive, which is a failure here.
    expect(code, out.slice(-4000)).toBe(0)
  }, 180_000)

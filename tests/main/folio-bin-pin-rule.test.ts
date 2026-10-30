/**
 * The Folio bin's pin rule and its take-backs (src/main/folio-bin.ts module comment; Sol review r3,
 * docs/reviews/sol-review-folio-workspace-01-r3.md):
 * - B1: a folder swap injected at every await of Remove, Restore and both Undos (the module's own awaits through its
 *   test hook, and the Plan's history checkpoints) never makes a file outside the Folio linked, moved, read or
 *   chmod'ed, and every file-system call lands in the Folio's real folder (the FolioWorkspace guard is never bypassed).
 * - M2: a failure injected at every synchronous step (fchmod, link, unlink, and the bin's list and folder writes) is
 *   taken back in full: nothing moved, every byte and permission as before, and the refusal says so.
 * - r4: both sweeps run again where hard links are not supported (link(2) refused, the exclusive copy runs), the copy
 *   being a step that can fail.
 * - The rule by construction: every await of the module goes through `settle`, and no pinned block is async.
 */
import { afterEach, expect, test } from 'bun:test'
import { chmod, lstat, readFile } from 'node:fs/promises'
import { copyFileSync, fchmodSync, linkSync, mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FOLIO_BIN, setBinAwaitHookForTest, setBinIoForTest } from '../../src/main/folio-bin'
import { cleanUpBinTests, inodes, ok, OPS, prepare, refusingLink, runWithPoints, swapOut, tempDir, treeWithModes, watchCalls, type LinkFallback } from '../helpers/folio-bin-harness'

afterEach(cleanUpBinTests)

/** Each sweep runs with hard links, and again where link(2) is not supported, so the exclusive copy runs (Sol r4). */
const LINK_MODES: LinkFallback[] = [null, 'ENOTSUP']

test('r3 B1 (r4: with and without hard links): a folder swapped at any await of Remove, Restore or Undo never makes a file outside the Folio linked, moved, read or chmod\'ed, and every call stays in the Folio', async () => {
  let injections = 0
  for (const noLinks of LINK_MODES) {
    for (const op of OPS) {
      // How many awaits this operation passes through when nothing is swapped.
      const dry = await prepare(op, await tempDir('dry'))
      let points = 0
      setBinIoForTest(noLinks ? { linkSync: refusingLink(noLinks) } : null)
      ok(await runWithPoints(dry.run, async () => { points += 1 }))
      setBinAwaitHookForTest(null)
      setBinIoForTest(null)
      expect(points).toBeGreaterThan(2)

      for (let at = 0; at < points; at += 1) {
        for (const target of [FOLIO_BIN, 'contents']) {
          for (const mode of ['left', 'put back at the next await'] as const) {
            const base = await tempDir('swap')
            const outside = await tempDir('outside')
            const { folio, run } = await prepare(op, base)
            const folioReal = realpathSync(folio)
            let outsideFiles = new Map<string, string>()
            let outsideIno = new Set<number>()
            const violations: string[] = []
            watchCalls(folioReal, () => outsideIno, violations, noLinks)
            let putBack: (() => Promise<void>) | null = null
            let seen = 0
            await runWithPoints(run, async () => {
              const now = seen
              seen += 1
              if (now === at) {
                putBack = await swapOut(join(folio, target), outside, now)
                outsideIno = await inodes(join(outside, `evil-${now}`))
                outsideFiles = await treeWithModes(join(outside, `evil-${now}`))
                injections += 1
              } else if (now === at + 1 && mode === 'put back at the next await' && putBack) {
                await (putBack as () => Promise<void>)()
              }
            })
            setBinAwaitHookForTest(null)
            setBinIoForTest(null)
            if (putBack) await (putBack as () => Promise<void>)()
            const where = `${noLinks ? `no links (${noLinks})` : 'links'}: ${op}, ${target} swapped at await ${at} and ${mode}`
            expect({ where, violations }).toEqual({ where, violations: [] })
            // The files outside: the same bytes and permissions, no new name for any of them inside the Folio.
            if (outsideIno.size) {
              expect({ where, outside: await treeWithModes(join(outside, `evil-${at}`)) }).toEqual({ where, outside: outsideFiles })
              const inside = await inodes(folio)
              expect({ where, shared: [...outsideIno].filter((ino) => inside.has(ino)) }).toEqual({ where, shared: [] })
            }
          }
        }
      }
    }
  }
  expect(injections).toBeGreaterThan(80)
}, 300_000)

test('r3 M2 (r4: with and without hard links): a failure at any synchronous step of Remove, Restore or Undo (fchmod, link or copy, unlink, the bin\'s list and folder) is taken back in full and said so', async () => {
  const real = { fchmodSync, linkSync, copyFileSync, unlinkSync, renameSync, writeFileSync, mkdirSync } as Record<string, (...a: unknown[]) => unknown>
  let failures = 0
  let copyFailures = 0
  for (const noLinks of LINK_MODES) {
    // Where link(2) is not supported, every placement is a copy: the copy is the step that can fail, not the link.
    const base = noLinks ? { linkSync: refusingLink(noLinks) } : {}
    const steps = ['fchmodSync', noLinks ? 'copyFileSync' : 'linkSync', 'unlinkSync', 'renameSync', 'writeFileSync', 'mkdirSync']
    for (const op of OPS) {
      // How often this operation makes each call when nothing fails.
      const dry = await prepare(op, await tempDir('dry'))
      const counts = new Map<string, number>()
      const counting = Object.fromEntries(steps.map((step) => [step, (...args: unknown[]) => {
        counts.set(step, (counts.get(step) ?? 0) + 1)
        return real[step]!(...args)
      }]))
      setBinIoForTest({ ...counting, ...base } as never)
      ok(await dry.run())
      setBinIoForTest(null)
      if (op === 'restore') for (const step of ['fchmodSync', steps[1]!, 'unlinkSync']) expect({ noLinks, op, step, made: counts.get(step) ?? 0 }).toEqual({ noLinks, op, step, made: 1 })

      for (const step of steps) {
        for (let nth = 0; nth < (counts.get(step) ?? 0); nth += 1) {
          const { folio, run } = await prepare(op, await tempDir('fail'))
          const before = await treeWithModes(folio)
          let calls = 0
          setBinIoForTest({ ...base, [step]: (...args: unknown[]) => {
            if (calls++ === nth) throw Object.assign(new Error(`Synthetic ${step} failure`), { code: 'EIO' })
            return real[step]!(...args)
          } } as never)
          const answer = await run()
          setBinIoForTest(null)
          failures += 1
          if (step === 'copyFileSync') copyFailures += 1
          const where = `${noLinks ? `no links (${noLinks})` : 'links'}: ${op}: ${step} #${nth + 1} fails`
          expect({ where, ok: answer.ok }).toEqual({ where, ok: false })
          const message = answer.ok ? '' : answer.message
          expect({ where, message }).toEqual({ where, message: expect.stringContaining(`Synthetic ${step} failure`) })
          expect({ where, message }).toEqual({ where, message: expect.stringMatching(/[Nn]othing was changed/) })
          expect({ where, message }).toEqual({ where, message: expect.not.stringContaining('Not everything could be put back') })
          expect({ where, tree: await treeWithModes(folio) }).toEqual({ where, tree: before })
        }
      }
    }
  }
  expect(failures).toBeGreaterThanOrEqual(24)
  expect(copyFailures).toBeGreaterThanOrEqual(4)
}, 240_000)

test('r3 M2: Restore clears the execute and set-id bits through the file\'s handle before the file has its name in the Folio', async () => {
  const base = await tempDir('bits')
  const { folio, run } = await prepare('restore', base)
  await chmod(join(folio, FOLIO_BIN, '02-report.md'), 0o6755)
  const order: string[] = []
  setBinIoForTest({
    fchmodSync: ((fd: number, mode: number) => { order.push(`fchmod ${mode.toString(8)}`); return fchmodSync(fd, mode) }) as never,
    linkSync: ((from: string, to: string) => { order.push('link'); return linkSync(from, to) }) as never,
    unlinkSync: ((path: string) => { order.push('unlink'); return unlinkSync(path) }) as never,
  })
  ok(await run())
  expect(order).toEqual(['fchmod 644', 'link', 'unlink'])
  expect((await lstat(join(folio, 'contents/02-report.md'))).mode & 0o7777).toBe(0o644)
})

test('the pin rule by construction: every await of the bin goes through settle, and no pinned block is async', async () => {
  const source = await readFile(join(import.meta.dir, '../../src/main/folio-bin.ts'), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const awaits = code.match(/\bawait\b(?! settle\()[^\n]*/g) ?? []
  // The only two are inside settle itself: the awaited work, and the test hook.
  expect(awaits.map((line) => line.trim())).toEqual(['await work', 'await awaitHook(label)'])
  expect(code).not.toMatch(/withPinned\([^,]+,\s*async\b/)
  // Real paths are made only by the pinned block's own methods: no free function pins a bin file or a Folio file.
  expect(code).not.toMatch(/function (?:inBin|inFolioNow|rePin|ensureBin)\(/)
  expect(code.match(/binPinNow\(/g)?.length).toBe(5) // its definition, Pinned.binNow and Pinned.bin, readFolioBin and binFolderToShow (exported reads, each one synchronous block)
})

/**
 * The Folio bin where hard links are not supported (src/main/folio-bin.ts `placeBeside`; Sol review r4,
 * docs/reviews/sol-review-folio-workspace-01-r4.md MAJOR): link(2) refused with each fallback code (ENOTSUP, EXDEV,
 * EPERM) while the real exclusive copy runs. Remove, Restore and both Undos succeed; each leaves the Folio byte for
 * byte (and permission for permission) as the same operation does with hard links; the Undo of a Remove or a Restore
 * made by copy puts everything back; the copy is a file of its own, never a second name of the bin's file; and a copy
 * changed before the move completes is never taken for the bin's file.
 */
import { afterEach, expect, test } from 'bun:test'
import { lstat, readFile } from 'node:fs/promises'
import { copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FOLIO_BIN, setBinAwaitHookForTest, setBinIoForTest } from '../../src/main/folio-bin'
import { cleanUpBinTests, comparableTree, expectAt, LINK_FALLBACK_CODES, ok, OPS, prepare, refusingLink, tempDir } from '../helpers/folio-bin-harness'

afterEach(cleanUpBinTests)

test('r4: with link(2) refused (ENOTSUP, EXDEV, EPERM), Remove, Restore and both Undos succeed by copy, leave what hard links leave, and their Undo puts every byte back', async () => {
  let cases = 0
  for (const op of OPS) {
    // The same operation with hard links, in a Folio of its own: what the copy path must match.
    const linked = await prepare(op, await tempDir('linked'))
    const linkedAnswer = ok(await linked.run())
    const expected = await comparableTree(linked.folio)
    // And its Undo (a Remove's or a Restore's), with hard links. The execute bits a Restore cleared stay cleared there too.
    const undoable = op === 'remove' || op === 'restore'
    if (undoable) ok(await linked.undo(linkedAnswer.token!))
    const expectedUndone = undoable ? await comparableTree(linked.folio) : null

    for (const code of LINK_FALLBACK_CODES) {
      const where = `${op}, link refused with ${code}`
      const { folio, run, undo } = await prepare(op, await tempDir('copy'))
      const before = await comparableTree(folio)
      let links = 0
      let copies = 0
      setBinIoForTest({
        linkSync: ((from: string, to: string) => { links += 1; return (refusingLink(code) as (a: string, b: string) => never)(from, to) }) as never,
        copyFileSync: ((from: string, to: string, mode: number) => { copies += 1; return copyFileSync(from, to, mode) }) as never,
      })
      const answer = await run()
      expectAt(where, answer.ok ? '' : answer.message, '')
      expectAt(where, answer.ok && answer.message, linkedAnswer.message)
      expectAt(where, copies > 0 && copies === links, true)
      expectAt(where, await comparableTree(folio), expected)
      if (op === 'restore') {
        // The restored file is the copy alone: the bin's name is gone, and nothing else shares its inode.
        expectAt(where, (await lstat(join(folio, 'contents/02-report.md'))).nlink, 1)
        await expect(lstat(join(folio, FOLIO_BIN, '02-report.md'))).rejects.toThrow()
      }
      // The Undo of a Remove or a Restore made by copy, also by copy: exactly as before it.
      const token = answer.ok ? answer.token : null
      if (undoable) {
        expectAt(where, typeof token, 'string')
        ok(await undo(token!))
        expectAt(`${where}, then undone`, await comparableTree(folio), expectedUndone)
        // Every byte as before the operation; only the execute bits a Restore clears stay cleared.
        const bytes = (tree: Map<string, string>): Map<string, string> => new Map([...tree].map(([path, value]) => [path, value.slice(value.indexOf(' ') + 1)]))
        expectAt(`${where}, then undone (bytes)`, bytes(await comparableTree(folio)), bytes(before))
      }
      setBinIoForTest(null)
      cases += 1
    }
  }
  expect(cases).toBe(OPS.length * LINK_FALLBACK_CODES.length)
}, 60_000)

test('r4: a copy edited before Restore completes is never taken for the bin\'s file: Restore refuses, the edit stays, the bin keeps its file', async () => {
  const { folio, run } = await prepare('restore', await tempDir('edited-copy'))
  const binFile = join(folio, FOLIO_BIN, '02-report.md')
  const original = await readFile(binFile)
  setBinIoForTest({ linkSync: refusingLink('ENOTSUP') })
  // Another program writes into the copy (in place: same inode) once the documents are written, before the move's last step.
  setBinAwaitHookForTest((label) => { if (label === 'restore:documents') writeFileSync(join(folio, 'contents/02-report.md'), 'EDITED\n') })
  const answer = await run()
  setBinIoForTest(null)
  setBinAwaitHookForTest(null)
  expect(answer.ok).toBe(false)
  expect(await readFile(binFile)).toEqual(original)
  expect(await readFile(join(folio, 'contents/02-report.md'), 'utf8')).toBe('EDITED\n')
  expect(answer.ok ? '' : answer.message).toContain('Not everything could be put back')
})

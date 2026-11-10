// Backup activation r7 (R6-U1), Settings › Backup: the unavailable view Settings returns early with now shows
// a Turn on whose outcome is unknown as such (alert, never "stays off" or a success flash) and keeps the
// Turn on problem visible. The status rendered is the one the real enrolment returned (real files, an
// unreadable record, FAKE supervisor/helper/services as in backup-activation-fixture.ts).
import { afterEach, expect, test } from 'bun:test'
import { chmodSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { durableSeams } from '../../src/main/backup-helper/durable-file'
import type { BackupEnrolmentResult, BackupEnrolmentStatus } from '../../src/shared/backup-enrolment'
import { BackupUnavailableBody, enableReport } from '../../src/renderer/src/components/settings/BackupSettingsPanel'
import { fixture } from './backup-activation-fixture'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  delete durableSeams.beforeRename
  delete durableSeams.atRename
  while (cleanups.length) await cleanups.pop()!()
})

const ATTEMPTS = 'activation-attempts.json'
type Unavailable = Extract<BackupEnrolmentStatus, { state: 'unavailable' }>
const render = (status: Unavailable, problem: string | null) => renderToStaticMarkup(<BackupUnavailableBody status={status} problem={problem} />)

test('unknown outcome: the status and reason enable returned are shown as unconfirmed, with the problem, no success', async () => {
  const f = await fixture(cleanups)
  expect((await f.turnOn(f.b)).ok).toBe(true)
  f.setWindow(f.a)
  const p = await f.e.preview(1)
  if (p.state !== 'ready') throw new Error('not ready')
  let writes = 0
  let injected = false
  durableSeams.beforeRename = (t) => { if (t.endsWith(ATTEMPTS)) writes++ }
  durableSeams.atRename = (t, renamed) => {
    if (injected || !t.endsWith(ATTEMPTS) || writes !== 2 || !renamed) return
    injected = true
    chmodSync(t, 0o000)
    durableSeams.beforeRename = () => { throw Object.assign(new Error('continuing I/O refusal'), { code: 'EIO' }) }
    throw Object.assign(new Error('rename outcome uncertain'), { code: 'EIO' })
  }
  const result = await f.e.enable(1, { previewId: p.previewId, confirmPublic: false })
  cleanups.push(() => chmodSync(`${f.dir}/${ATTEMPTS}`, 0o600))
  expect(result.ok).toBeNull()
  const report = enableReport(result)
  expect('flash' in report).toBe(false)
  if (result.status.state !== 'unavailable') throw new Error(`expected unavailable, got ${result.status.state}`)
  const problem = 'problem' in report ? report.problem : null
  for (const status of [result.status, await f.e.status(1)]) {
    if (status.state !== 'unavailable') throw new Error('expected unavailable')
    const html = render(status, problem)
    expect(html).toContain('data-panel="backup-unconfirmed"')
    expect(html).toContain('role="alert"')
    expect(html).toContain('Turning backup on could not be confirmed')
    expect(html).toMatch(/may still be in place, so backup may start for this folder once that record can be read again/)
    expect(html).toContain('Backup may not have been turned on')
    expect(html).not.toMatch(/stays off|is on for this vault/)
  }
})

test('ordinary unavailable status: reason as before, and a Turn on problem is no longer hidden by the early return', () => {
  const status: Unavailable = { state: 'unavailable', reason: 'The record of unfinished backup changes on this Mac cannot be read; backup stays off.' }
  expect(render(status, null)).toBe('<p class="sub">The record of unfinished backup changes on this Mac cannot be read; backup stays off.</p>')
  const html = render(status, 'Backup was not turned on.')
  expect(html).not.toContain('backup-unconfirmed')
  expect(html).toContain('<div class="shr-panel problem" role="alert"><div class="shr-panel-b"><p class="shr-p">Backup was not turned on.</p></div></div>')
})

test('enableReport is exhaustive: success flashes only for ok true; known failure and unknown outcome are problems', () => {
  const status: BackupEnrolmentStatus = { state: 'no-folder' }
  const results: BackupEnrolmentResult[] = [{ ok: true, status }, { ok: false, reason: 'known', status }, { ok: null, reason: 'unknown', status }]
  expect(results.map(enableReport)).toEqual([{ flash: 'Automatic backup is on for this vault.' }, { problem: 'known' }, { problem: 'unknown' }])
})

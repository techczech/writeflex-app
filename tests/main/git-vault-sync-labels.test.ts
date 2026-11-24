// Git vault sync: Labels and provenance.
// Guards ADR-0055 "Parcel 2b presentation metadata" and parcel 7 labels: which computer name an incoming change carries, and which commit labels are never trusted.
// Real `git`, a bare remote and two clones through the shared fixture; no Electron.
import { expect } from 'bun:test'
import { fixture, text } from './git-vault-sync-fixture'
import { testWithGitleaks } from '../helpers/built-output'

testWithGitleaks('incoming WriteFlex computer labels prefer trailers, support older subjects and never adopt ordinary commit labels', async () => {
  const f = await fixture()
  try {
    const B = f.engineB({ computerName: 'MacBook Air' })
    await f.put(f.b, 'draft.md', 'From Air.\n')
    expect((await B.send(f.bv)).reason).toBeUndefined()
    expect(f.git(f.b, 'show', '-s', '--format=%B')).toContain('WriteFlex-Computer: MacBook Air')
    expect((await f.A.fetchAndIntegrate(f.av)).lastReceived?.from).toBe('MacBook Air')
    const incoming = async (subject: string, body: string, app: boolean) => {
      await f.put(f.b, 'draft.md', subject + '\n')
      f.git(f.b, 'add', 'draft.md')
      f.git(f.b, '-c', `user.name=${app ? 'WriteFlex on Air' : 'Writer'}`, '-c', `user.email=${app ? 'writeflex@localhost' : 'writer@example.invalid'}`, 'commit', '-m', subject, '-m', body)
      f.git(f.b, 'push')
      return f.A.fetchAndIntegrate(f.av)
    }
    expect((await incoming('WriteFlex: 1 documents from Wrong Name', 'WriteFlex-Computer: MacBook Air', true)).lastReceived?.from).toBe('MacBook Air')
    expect((await incoming('WriteFlex: 1 documents from Older Air', '', true)).lastReceived?.from).toBe('Older Air')
    expect((await incoming('WriteFlex: 1 documents from Spoof', 'WriteFlex-Computer: Spoof', false)).lastReceived?.from).toBe('another computer')
    await f.put(f.a, 'draft.md', 'Local stays byte for byte.\n')
    await f.put(f.b, 'draft.md', 'Air stays byte for byte.\n'); await B.send(f.bv)
    const result = await f.A.send(f.av), pair = result.pairs[0]
    expect(result.reason).toBeUndefined(); expect(pair.from).toBe('MacBook Air')
    expect(pair.other).toMatch(/^draft \(from MacBook Air \d{4}-\d{2}-\d{2}(?: \d+)?\)\.md$/)
    expect(await text(f.a, pair.local)).toBe('Local stays byte for byte.\n')
    expect(await text(f.a, pair.other)).toBe('Air stays byte for byte.\n')
  } finally { await f.close() }
}, 120_000)

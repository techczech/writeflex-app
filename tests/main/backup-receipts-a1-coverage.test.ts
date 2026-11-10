/**
 * The §12 green predicate and the §13.7 document states, pure (receipt-coverage.ts). A positive control
 * shows the predicate can be true; each other case changes one fact of it and must make it false. Rows
 * CX-S10a (counts only), CX-S10b (other-client debt), CX-S10c (proof evicted), CX-S10d (another record),
 * CX-S5a (mismatch), CX-S7a (another owner) and the outbox's own debts.
 */
import { describe, expect, test } from 'bun:test'
import type { ReceiptStatusView } from '@app-patterns/vault-sync'
import { emptyOutbox, type Outbox } from '../../src/main/backup-helper/outbox-store'
import { computeCoverage, type CoverageInput } from '../../src/main/backup-helper/receipt-coverage'

const OWNER = 'a'.repeat(32)
const DOC = { owner: OWNER, ownerEpoch: 2, docEpoch: 1 }
const RECORD = 'r'.repeat(0) + '1'.repeat(32)
const BLOB = { sha1: 'b'.repeat(40), sha256: 'c'.repeat(64) }
const SNAP = 'd'.repeat(40)
const agg = () => ({ count: 0, oldestAt: null })

function outbox(): Outbox {
  const o = emptyOutbox('e'.repeat(32), 'vault-a')
  o.recordId = RECORD
  o.streamId = 'f'.repeat(32)
  o.objectFormat = 'sha1'
  o.nextSeq = 3
  o.ackedThrough = 2
  o.docs = [{ doc: { ...DOC }, path: 'notes/a.md', unreported: null, editRefs: [], intents: [], saved: { gen: 4, blob: BLOB, at: 10 }, flushed: { gen: 4, blobOid: BLOB.sha1, seq: 2, at: 10 }, uncertain: null }]
  return o
}

function view(): ReceiptStatusView {
  const limits = { window: 4, maxClients: 4, maxOwners: 64, maxDocs: 256, maxSegments: 4, maxEditRefs: 4, maxActiveWrites: 16, maxProof: 256, maxVerified: 256, maxWant: 64 }
  return {
    recordId: RECORD, observedGeneration: 9, observedAt: 1_000,
    activation: { by: { host: 'h', pid: 1, startedAt: 1, helperVersion: '0.2.0' }, at: 1, handovers: 0 },
    captureQuarantine: null,
    stream: { clientId: 'e'.repeat(32), streamId: 'f'.repeat(32), epochHighWater: 2, sessionEpoch: 2, base: 0, appliedThrough: 2, ackedThrough: 2, replies: 0, docs: 1, limits },
    vault: {
      oldestUnprotectedEdit: null, legacyVaultWide: agg(), legacyPerPath: agg(), capturedUnverified: agg(), pending: agg(), unlisted: agg(),
      activeWrites: { untagged: agg(), thisClient: agg(), otherClient: agg(), unknownOwner: agg() },
      otherClientDebt: { ...agg(), clients: 0 }, captureQuarantine: null, resetFloor: null, counters: { resets: 0, proofEvicted: 0 },
    },
    thisClient: { unflushed: agg(), blobDebt: agg(), activeWrites: agg(), owners: { count: 0, items: [], omitted: 0 } },
    docs: { count: 1, omitted: 0, items: [{
      path: 'notes/a.md', doc: { ...DOC }, state: 'verified', unflushedThroughGen: null, flushed: null,
      proof: null, verified: { gen: 4, blobOid: BLOB.sha1, snapshot: SNAP, snapshotSeq: 3, at: 900 }, activeWrite: false,
    }] },
  }
}

const base = (): CoverageInput => ({ lane: 'open', outbox: outbox(), view: view(), want: [{ path: 'notes/a.md', doc: { ...DOC }, gen: 4 }] })
const covered = (input: CoverageInput) => computeCoverage(input).covered

describe('the green predicate', () => {
  test('positive control: everything holds, so covered; the document is remote-verified with main\'s blob', () => {
    const c = computeCoverage(base())
    expect(c.covered).toBe(true)
    expect(c.docs[0]).toEqual({ path: 'notes/a.md', docEpoch: 1, gen: 4, owner: OWNER, state: 'remote-verified', blobOid: BLOB.sha1, since: null, observedAt: 1_000, verifiedAt: 900, snapshot: SNAP })
  })

  const cases: Array<[string, (i: CoverageInput) => void]> = [
    ['counts only: the row omitted (CX-S10a)', (i) => { i.view!.docs = { count: 1, items: [], omitted: 1 } }],
    ['a row omitted beside the verified one', (i) => { i.view!.docs = { ...i.view!.docs, count: 2, omitted: 1 } }],
    ['other-client debt only (CX-S10b)', (i) => { i.view!.vault.otherClientDebt = { count: 1, oldestAt: 5, clients: 1 } }],
    ['proof evicted: the row registered, not verified (CX-S10c)', (i) => { const r = i.view!.docs.items[0]!; r.state = 'registered'; r.verified = null; i.view!.vault.counters.proofEvicted = 1 }],
    ['another record (CX-S10d)', (i) => { i.view!.recordId = '2'.repeat(32) }],
    ['the lane is not live', (i) => { i.lane = 'offline' }],
    ['no status could be read', (i) => { i.view = null }],
    ['not activated', (i) => { i.view!.activation = null }],
    ['capture quarantined', (i) => { i.view!.vault.captureQuarantine = { since: 1, reason: 'incomplete-guards' } }],
    ['a reset floor', (i) => { i.view!.vault.resetFloor = { from: 1, reason: 'converted' } }],
    ['an unprotected edit somewhere in the vault', (i) => { i.view!.vault.oldestUnprotectedEdit = 3 }],
    ['an untagged active write', (i) => { i.view!.vault.activeWrites.untagged = { count: 1, oldestAt: 2 } }],
    ['this client still owes blob debt', (i) => { i.view!.thisClient.blobDebt = { count: 1, oldestAt: 2 } }],
    ['verified at another gen', (i) => { i.view!.docs.items[0]!.verified!.gen = 3 }],
    ['verified with another blob: never substituted for main\'s', (i) => { i.view!.docs.items[0]!.verified!.blobOid = '9'.repeat(40) }],
    ['the row is another owner\'s (CX-S7a)', (i) => { i.view!.docs.items[0]!.doc = { ...DOC, owner: 'f'.repeat(32) } }],
    ['the captured buffer is a newer gen than main saved', (i) => { i.want = [{ ...i.want[0]!, gen: 5 }] }],
    ['main recorded another blob for that gen', (i) => { i.outbox!.docs[0]!.saved!.blob = { sha1: '8'.repeat(40), sha256: '7'.repeat(64) } }],
    ['an unacknowledged receipt', (i) => { i.outbox!.sent = [{ seq: 3, body: { method: 'noteEdit', vault: 'vault-a', seq: 3, path: 'notes/a.md', doc: { ...DOC }, throughGen: 5, at: 1 }, result: null }]; i.outbox!.ackedThrough = 2; i.outbox!.nextSeq = 4 }],
    ['held bytes', (i) => { i.outbox!.held = [{ intent: '1'.repeat(32), path: 'notes/b.md', doc: { ...DOC }, gen: 1, blob: BLOB, at: 1, file: `${'1'.repeat(32)}.bin` }] }],
    ['another owner\'s unreported debt in the outbox (prior-owner debt)', (i) => { i.outbox!.docs.push({ ...i.outbox!.docs[0]!, doc: { ...DOC, owner: 'f'.repeat(32) }, unreported: { throughGen: 2, at: 1 }, saved: null, flushed: null }) }],
    ['outbox overflow', (i) => { i.outbox!.overflowSince = 1 }],
    ['a stopped stream', (i) => { i.outbox!.stopped = { reason: 'conflict', at: 1 } }],
    ['an uncertain document', (i) => { i.outbox!.docs[0]!.uncertain = 'the helper refused a receipt (out-of-scope)' }],
    ['nothing captured', (i) => { i.want = []; i.view!.docs = { count: 0, items: [], omitted: 0 } }],
  ]
  for (const [name, change] of cases) {
    test(`not covered: ${name}`, () => {
      const input = base()
      change(input)
      expect(covered(input)).toBe(false)
    })
  }
})

describe('per-document states (§13.7)', () => {
  test('mismatch and a proof of another blob are unknown, never captured (CX-S5a)', () => {
    const i = base()
    const r = i.view!.docs.items[0]!
    r.state = 'mismatch'; r.verified = null; r.proof = { gen: 4, blobOid: '9'.repeat(40), state: 'mismatch', snapshotSeq: 2 }
    expect(computeCoverage(i).docs[0]!.state).toBe('unknown')
  })
  test('captured needs the exact gen and main\'s blob', () => {
    const i = base()
    const r = i.view!.docs.items[0]!
    r.state = 'captured'; r.verified = null; r.proof = { gen: 4, blobOid: BLOB.sha1, state: 'captured', snapshotSeq: 2 }
    expect(computeCoverage(i).docs[0]!.state).toBe('captured')
    r.proof.gen = 3
    expect(computeCoverage(i).docs[0]!.state).toBe('receipt-registered')
  })
  test('a flush of a newer gen than the captured one: unknown for the older buffer', () => {
    const i = base()
    i.outbox!.docs[0]!.saved = { gen: 3, blob: BLOB, at: 1 }
    i.want = [{ ...i.want[0]!, gen: 3 }]
    expect(computeCoverage(i).docs[0]!.state).toBe('unknown')
  })
  test('gen 0 and no row are unknown; durable bytes without a flush are saved-not-registered', () => {
    const i = base()
    i.want = [{ ...i.want[0]!, gen: 0 }]
    expect(computeCoverage(i).docs[0]!.state).toBe('unknown')
    const j = base()
    j.outbox!.docs[0]!.flushed = null
    expect(computeCoverage(j).docs[0]!.state).toBe('saved-not-registered')
    const k = base()
    k.outbox!.docs = []
    expect(computeCoverage(k).docs[0]!.state).toBe('unknown')
  })
})

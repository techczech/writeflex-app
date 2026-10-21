// Main's preserve operation (src/main/preserve-version.ts): a receipt only when History holds a copy whose
// sha256 equals the text the caller meant. No History, or a History that made no snapshot: nothing is kept
// and nothing is written anywhere.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preserveVersion } from '../../src/main/preserve-version'
import { receiptFor, sha256OfText } from '../../src/shared/preserve-receipt'

const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
const D = 'The disk version, ž and 🎉.\r\n'
const E = 'Another program wrote this.\n'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'preserve-version-'))
  writeFileSync(join(root, 'note.md'), D)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** Everything in the Workspace folder: preserving never adds a file there. */
const everything = (): string[] => readdirSync(root, { recursive: true }).map(String).sort()

describe('preserveVersion', () => {
  it('History holds exactly the text: a history receipt with its hash', async () => {
    const result = await preserveVersion({ text: D, history: async () => ({ id: 'e1', hash: sha(readFileSync(join(root, 'note.md'))) }) })
    expect(result).toEqual({ kept: true, receipt: { store: 'history', entryId: 'e1', sha256: sha(D) } })
    expect(everything()).toEqual(['note.md'])
    expect(await receiptFor(result, D)).toEqual({ store: 'history', entryId: 'e1', sha256: sha(D) })
  })

  it('History read other bytes (E instead of D): mismatch, no receipt, nothing written', async () => {
    const result = await preserveVersion({ text: D, history: async () => ({ id: 'e1', hash: sha(E) }) })
    expect(result).toEqual({ kept: false, refused: 'mismatch' })
    expect(await receiptFor(result, D)).toBeNull()
    expect(everything()).toEqual(['note.md'])
  })

  it('no History (no agent): unavailable, no receipt, nothing written anywhere', async () => {
    const result = await preserveVersion({ text: D, history: null })
    expect(result).toEqual({ kept: false, refused: 'unavailable' })
    expect(await receiptFor(result, D)).toBeNull()
    expect(everything()).toEqual(['note.md'])
  })

  it('History failed (the agent did not start, or made no snapshot): unavailable, nothing written', async () => {
    const failing = await preserveVersion({ text: D, history: async () => { throw new Error('boot failed') } })
    expect(failing).toEqual({ kept: false, refused: 'unavailable' })
    const none = await preserveVersion({ text: D, history: async () => null })
    expect(none).toEqual({ kept: false, refused: 'unavailable' })
    expect(everything()).toEqual(['note.md'])
  })
})

describe('receiptFor (the renderer\'s check before it writes)', () => {
  it('hashes the UTF-8 bytes as main does', async () => {
    expect(await sha256OfText(D)).toBe(sha(D))
  })
  it('accepts only a kept receipt whose hash is the text\'s', async () => {
    const receipt = { store: 'history', entryId: 'e1', sha256: sha(D) }
    expect(await receiptFor({ kept: true, receipt }, D)).toEqual(receipt as never)
    expect(await receiptFor({ kept: true, receipt }, E)).toBeNull()
    expect(await receiptFor({ kept: false, refused: 'unavailable' }, D)).toBeNull()
    expect(await receiptFor(undefined, D)).toBeNull()
    expect(await receiptFor({ kept: true, receipt: { store: 'elsewhere', sha256: sha(D) } }, D)).toBeNull()
    // A receipt for a copy outside History is no longer one (review round 3: History is the only store).
    expect(await receiptFor({ kept: true, receipt: { store: 'rescue', path: 'x', sha256: sha(D) } }, D)).toBeNull()
  })
})

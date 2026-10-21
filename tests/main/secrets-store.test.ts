// The secrets module (src/main/secrets-store.ts; sharing ticket 02, spec section 8 "The token"), with
// an injected cipher so it runs under bun: each slot keeps exactly what the cipher returned and never
// the text; encryption unavailable refuses every write and writes nothing; no failure carries a
// secret; the real files are written whole and private; and no other file touches safeStorage.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Glob } from 'bun'
import {
  SECRET_SLOTS, SECRET_SLOT_NAMES, SecretsError, createSecretsStore, nodeSecretsFiles, type SecretSlot,
} from '../../src/main/secrets-store.ts'
import { memorySecrets, testCipher } from '../helpers/memory-secrets.ts'

const FAKE: Record<SecretSlot, string> = {
  'cloudflare-token': 'cfut_test-token-0001-abcdefghijklmnop',
  'sharing-keys': JSON.stringify({ format: 1, entries: [{ accountId: 'acc1', scriptName: 'writeflex-sharing', computerId: 'mac1', key: 'test-admin-key-0002-abcdefgh' }] }),
  'sharing-links': JSON.stringify({ format: 1, tokens: { AbCdEfGhIjKlMnOpQrStUv: 'test-owner-token-0003-abcdefgh' } }),
}
const holds = (haystack: Buffer, needle: string) => haystack.includes(Buffer.from(needle))
const errorText = (error: unknown) => [String(error), (error as Error)?.message, (error as Error)?.stack, JSON.stringify(error), String((error as Error)?.cause ?? '')].join('\n')

describe('slots', () => {
  test('the three slots, each one file in the user-data folder holding what the cipher returned', () => {
    expect(SECRET_SLOT_NAMES).toEqual(['cloudflare-token', 'sharing-keys', 'sharing-links'])
    for (const slot of SECRET_SLOT_NAMES) {
      const { store, files, cipher, dir } = memorySecrets()
      const path = join(dir, SECRET_SLOTS[slot].file)
      expect(store.has(slot)).toBe(false)
      expect(store.read(slot)).toBeNull()
      store.write(slot, FAKE[slot])
      expect(store.has(slot)).toBe(true)
      expect(store.read(slot) === FAKE[slot]).toBe(true)
      expect([...files.blobs.keys()]).toEqual([path])
      expect(files.blobs.get(path)!.equals(cipher.encryptString(FAKE[slot]))).toBe(true)
      expect(holds(files.blobs.get(path)!, FAKE[slot])).toBe(false)
      store.clear(slot)
      expect(store.has(slot)).toBe(false)
      expect(() => store.clear(slot)).not.toThrow()
    }
  })

  test('an unknown slot names no file, and only non-empty text is stored', () => {
    const { store, files } = memorySecrets()
    for (const bad of ['constructor', '__proto__', '../sharing-cloudflare-token.bin', '']) {
      expect(() => store.read(bad as SecretSlot)).toThrow(TypeError)
      expect(() => store.write(bad as SecretSlot, 'test-token-unknown')).toThrow(TypeError)
    }
    for (const empty of ['', null, undefined, 7]) expect(() => store.write('cloudflare-token', empty as unknown as string)).toThrow(TypeError)
    expect(files.blobs.size).toBe(0)
  })
})

describe('refusals', () => {
  test('encryption unavailable: every write refused with a plain sentence, nothing written', () => {
    const { store, files } = memorySecrets({ available: false })
    for (const slot of SECRET_SLOT_NAMES) {
      expect(() => store.write(slot, FAKE[slot])).toThrow(SecretsError)
      try { store.write(slot, FAKE[slot]) } catch (error) {
        expect((error as SecretsError).code).toBe('unavailable')
        expect((error as Error).message).toMatch(/^This Mac's secure storage is unavailable/)
      }
    }
    expect(store.availability()).toEqual({ ok: false, reason: 'no-encryption' })
    expect(files.blobs.size).toBe(0)
  })

  test('a cipher that hands the text back unchanged is not encryption', () => {
    const { files } = memorySecrets()
    const store = createSecretsStore({
      dir: '/user-data', platform: 'darwin', files,
      cipher: { isEncryptionAvailable: () => true, encryptString: (text) => Buffer.from(`x${text}`), decryptString: (bytes) => bytes.toString().slice(1) },
    })
    expect(() => store.write('cloudflare-token', FAKE['cloudflare-token'])).toThrow(SecretsError)
    expect(files.blobs.size).toBe(0)
  })

  test('Linux without a real keyring is refused for writing', () => {
    const store = createSecretsStore({ dir: '/user-data', platform: 'linux', cipher: testCipher(), files: memorySecrets().files, backend: () => 'basic_text' })
    expect(store.availability()).toEqual({ ok: false, reason: 'weak-backend' })
  })

  test('no failure carries a secret or another error\'s text', () => {
    const { store, files, dir } = memorySecrets()
    store.write('cloudflare-token', FAKE['cloudflare-token'])
    const throwing = createSecretsStore({
      dir, platform: 'darwin', files: { ...files, writeAtomic: () => { throw new Error(`disk said ${FAKE['cloudflare-token']}`) } },
      cipher: { ...testCipher(), decryptString: () => { throw new Error(`cipher said ${FAKE['cloudflare-token']}`) } },
    })
    const caught: unknown[] = []
    try { throwing.read('cloudflare-token') } catch (error) { caught.push(error) }
    try { throwing.write('cloudflare-token', FAKE['cloudflare-token']) } catch (error) { caught.push(error) }
    expect(caught).toHaveLength(2)
    for (const error of caught) {
      expect(error).toBeInstanceOf(SecretsError)
      expect(errorText(error)).not.toContain(FAKE['cloudflare-token'])
      expect((error as Error).cause).toBeUndefined()
    }
  })
})

describe('the real files', () => {
  test('written whole, private to this user, no temporary file left; a link is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'writeflex-secrets-'))
    try {
      const store = createSecretsStore({ dir, platform: 'darwin', cipher: testCipher(), files: nodeSecretsFiles })
      store.write('cloudflare-token', FAKE['cloudflare-token'])
      const path = join(dir, SECRET_SLOTS['cloudflare-token'].file)
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(readdirSync(dir)).toEqual([SECRET_SLOTS['cloudflare-token'].file])
      expect(holds(readFileSync(path), FAKE['cloudflare-token'])).toBe(false)
      expect(store.read('cloudflare-token') === FAKE['cloudflare-token']).toBe(true)
      rmSync(path)
      require('node:fs').symlinkSync(join(dir, 'elsewhere'), path)
      expect(() => store.write('cloudflare-token', FAKE['cloudflare-token'])).toThrow(SecretsError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test('one door: only secrets-store-electron.ts touches safeStorage, and only the store names a slot file', () => {
  const src = resolve(import.meta.dir, '..', '..', 'src')
  const touching: string[] = []
  const naming: string[] = []
  for (const file of new Glob('**/*.{ts,tsx}').scanSync(src)) {
    const text = readFileSync(join(src, file), 'utf8')
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    if (/\bsafeStorage\b/.test(code) && file !== 'main/secrets-store-electron.ts') touching.push(file)
    if (Object.values(SECRET_SLOTS).some((slot) => text.includes(slot.file)) && file !== 'main/secrets-store.ts') naming.push(file)
  }
  expect(touching).toEqual([])
  expect(naming).toEqual([])
})

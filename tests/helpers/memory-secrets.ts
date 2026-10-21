// An in-memory secrets store for tests: a stand-in cipher (reversible, never the plain text) and
// in-memory files. The real safeStorage is only reached through src/main/secrets-store-electron.ts.
import { join } from 'node:path'
import { createSecretsStore, type SecretsCipher, type SecretsFiles, type SecretsStore } from '../../src/main/secrets-store.ts'

export const testCipher = (available = true): SecretsCipher => ({
  isEncryptionAvailable: () => available,
  encryptString: (text) => Buffer.from(Buffer.from(text, 'utf8').map((byte) => byte ^ 0x5a)).reverse(),
  decryptString: (bytes) => Buffer.from(Buffer.from(bytes).reverse().map((byte) => byte ^ 0x5a)).toString('utf8'),
})

export function memoryFiles(): SecretsFiles & { blobs: Map<string, Buffer> } {
  const blobs = new Map<string, Buffer>()
  return {
    blobs,
    exists: (path) => blobs.has(path),
    read: (path) => {
      const found = blobs.get(path)
      if (!found) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return Buffer.from(found)
    },
    writeAtomic: (path, bytes) => { blobs.set(path, Buffer.from(bytes)) },
    remove: (path) => { blobs.delete(path) },
  }
}

export function memorySecrets(options: { available?: boolean; dir?: string } = {}): { store: SecretsStore; files: ReturnType<typeof memoryFiles>; cipher: SecretsCipher; dir: string } {
  const dir = options.dir ?? join('/user-data')
  const files = memoryFiles()
  const cipher = testCipher(options.available ?? true)
  return { store: createSecretsStore({ dir, cipher, platform: 'darwin', files }), files, cipher, dir }
}

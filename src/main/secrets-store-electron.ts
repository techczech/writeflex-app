// The secrets module's Electron side: the ONLY file in the app that touches `safeStorage`
// (tests/main/secrets-store.test.ts fails if another one does). Everything else goes through the
// store this opens. The logic, the slots and what the module defends are in secrets-store.ts.
import { safeStorage } from 'electron'
import { createSecretsStore, type SecretsStore } from './secrets-store'

/** The store over the operating system's encryption, for the given user-data folder. */
export function openSecretsStore(userDataDir: string): SecretsStore {
  return createSecretsStore({
    dir: userDataDir,
    platform: process.platform,
    cipher: {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (text) => safeStorage.encryptString(text),
      decryptString: (bytes) => safeStorage.decryptString(bytes),
    },
    // Linux only: which keyring holds the key. `basic_text` (a fixed password) and `unknown` are
    // refused for writing by the store.
    backend: () => (typeof safeStorage.getSelectedStorageBackend === 'function' ? safeStorage.getSelectedStorageBackend() : 'unknown'),
  })
}

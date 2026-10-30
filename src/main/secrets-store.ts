// The one secrets module (sharing ticket 02; spec docs/plans/spec-writeflex-sharing-and-reader-notes-
// 2026-10-14.md section 8, "The token"). Ported from TalkWeaver's src/main/secrets-store.ts.
//
// Every secret the main process keeps sits in a named slot here: `has / read / write / clear`. A slot
// is one file in the app's user-data folder holding what the operating system's own encryption
// returned for the secret's text (Electron `safeStorage`: on macOS the key lives in the login
// Keychain). Nothing else in WriteFlex writes a secret anywhere: not settings.json, not a log, not an
// error message.
//
// Why not Bridle's `@bridle/secrets` keychain store: it runs the `security` command through
// `Bun.spawn`, which does not exist in Electron's main process (Node), and hands the secret to that
// command's input. safeStorage keeps the secret inside this process.
//
// What this defends, and what it does not. A slot file is useless to anyone who has the file but not
// this person's login on this Mac: a backup, a synced or copied user-data folder, another account on
// the same machine. It is NOT a defence against code running as this person while they are logged in
// (on macOS the Keychain asks before handing the key to a different application: a prompt, not a
// wall), and such a party can delete or replace a slot file (the secret is then lost or swapped,
// never revealed). "Encryption unavailable" (safeStorage says so, or on Linux a session with no real
// keyring) refuses every write with a message, and nothing is written anywhere, in any form.
//
// No secret ever travels in an error from this module: every failure is a SecretsError with a fixed
// sentence, and the underlying error (which could quote decrypted text) is dropped, never attached.
//
// Shape: the logic takes its cipher, platform and files as arguments, so it runs under bun in tests.
// The one file that touches Electron's `safeStorage` is secrets-store-electron.ts.
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

/** Slot → its file in the user-data folder and how a message names what it holds. */
export const SECRET_SLOTS = {
  'cloudflare-token': { file: 'sharing-cloudflare-token.bin', what: 'the Cloudflare token' },
  'sharing-keys': { file: 'sharing-admin-keys.bin', what: 'this Mac\'s sharing key' },
  // Ticket 03: each link's owner token (publish, turn off, turn on), by share id.
  'sharing-links': { file: 'sharing-link-keys.bin', what: 'the keys of your links' },
} as const

export type SecretSlot = keyof typeof SECRET_SLOTS
export const SECRET_SLOT_NAMES = Object.keys(SECRET_SLOTS) as SecretSlot[]

/** The three calls of Electron's `safeStorage` this module needs. */
export interface SecretsCipher {
  isEncryptionAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(bytes: Buffer): string
}

/**
 * Smoke mode (packaged launch check): safeStorage is never called, because on macOS it reaches the
 * Keychain. The returned cipher reports encryption unavailable and refuses to encrypt or decrypt.
 */
export function gateCipherForSmoke(real: () => SecretsCipher, smoke: boolean): SecretsCipher {
  if (!smoke) return { isEncryptionAvailable: () => real().isEncryptionAvailable(), encryptString: (t) => real().encryptString(t), decryptString: (b) => real().decryptString(b) }
  return {
    isEncryptionAvailable: () => false,
    encryptString: () => { throw new Error('encryption unavailable in smoke mode') },
    decryptString: () => { throw new Error('encryption unavailable in smoke mode') },
  }
}

/** The files a slot lives in. `read` throws an error with code ENOENT when the file is not there. */
export interface SecretsFiles {
  exists(path: string): boolean
  read(path: string): Buffer
  /** All of `bytes` at `path`, or the file as it was: never a part of it. */
  writeAtomic(path: string, bytes: Buffer): void
  /** Gone afterwards; no error when it was not there. */
  remove(path: string): void
}

export interface SecretsStoreOptions {
  /** The app's user-data folder. */
  dir: string
  cipher: SecretsCipher
  /** `process.platform` of the running app. */
  platform: string
  /** Linux only: `safeStorage.getSelectedStorageBackend()`. */
  backend?: () => string
  files?: SecretsFiles
}

export type SecretsAvailability = { ok: true } | { ok: false; reason: 'no-encryption' | 'weak-backend' }

export type SecretsFailure = 'unavailable' | 'unreadable' | 'not-saved' | 'not-removed'

/** The Linux backends that keep the key in a real keyring. Anything else is refused for writing. */
export const STRONG_LINUX_BACKENDS: readonly string[] = ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** The sentence a person sees for a failure. Fixed text: never a secret, never another error's text. */
export function secretsFailureMessage(code: SecretsFailure, slot: SecretSlot, doing: 'save' | 'read' = 'save'): string {
  const what = SECRET_SLOTS[slot].what
  if (code === 'unavailable') return `This Mac's secure storage is unavailable, so ${what} cannot be ${doing === 'read' ? 'read' : 'saved'}.`
  if (code === 'unreadable') return `${capital(what)} could not be read from this Mac's secure storage.`
  if (code === 'not-removed') return `${capital(what)} could not be removed.`
  return `${capital(what)} could not be saved.`
}

export class SecretsError extends Error {
  readonly code: SecretsFailure
  readonly slot: SecretSlot
  constructor(code: SecretsFailure, slot: SecretSlot, doing: 'save' | 'read' = 'save') {
    super(secretsFailureMessage(code, slot, doing))
    this.name = 'SecretsError'
    this.code = code
    this.slot = slot
  }
}

export interface SecretsStore {
  /** Something is stored in the slot (its file is there). Decrypts nothing. */
  has(slot: SecretSlot): boolean
  /** The slot's text, or null when nothing is stored. Throws SecretsError when it cannot be read. */
  read(slot: SecretSlot): string | null
  /** Replace the slot's text. Throws SecretsError (and writes nothing) when it cannot be kept safely. */
  write(slot: SecretSlot, text: string): void
  /** Empty the slot. Throws SecretsError when the file could not be removed. */
  clear(slot: SecretSlot): void
  /** Whether a write would be accepted now. */
  availability(): SecretsAvailability
}

function isMissing(error: unknown): boolean {
  return Boolean(error) && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** The real files. A write is a private temporary file beside the target, flushed, then renamed over it. */
export const nodeSecretsFiles: SecretsFiles = {
  exists: (path) => existsSync(path),
  read: (path) => readFileSync(path),
  writeAtomic(path, bytes) {
    mkdirSync(dirname(path), { recursive: true })
    const refuseLink = () => {
      try {
        if (lstatSync(path).isSymbolicLink()) throw new Error('secrets-file-is-a-link')
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
    refuseLink()
    const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
    try {
      const handle = openSync(temporary, 'wx', 0o600)
      try {
        // One call may take only part of the bytes (a full disk): every byte is written, and the
        // file's length is checked, before the rename may replace a good slot.
        for (let written = 0; written < bytes.length;) {
          const count = writeSync(handle, bytes, written, bytes.length - written)
          if (!Number.isInteger(count) || count <= 0) throw new Error('secrets-file-short-write')
          written += count
        }
        fsyncSync(handle)
        if (fstatSync(handle).size !== bytes.length) throw new Error('secrets-file-short-write')
      } finally {
        closeSync(handle)
      }
      refuseLink()
      renameSync(temporary, path)
    } catch (error) {
      try { unlinkSync(temporary) } catch { /* never made, or already renamed */ }
      throw error
    }
  },
  remove: (path) => rmSync(path, { force: true }),
}

export function createSecretsStore(options: SecretsStoreOptions): SecretsStore {
  const { cipher } = options
  const files = options.files ?? nodeSecretsFiles

  function pathOf(slot: SecretSlot): string {
    // Own-property lookup: a slot name from anywhere else ("constructor", "../x") names no file.
    if (!Object.prototype.hasOwnProperty.call(SECRET_SLOTS, slot)) throw new TypeError('Unknown secrets slot.')
    return join(options.dir, SECRET_SLOTS[slot].file)
  }

  function canDecrypt(): boolean {
    try { return cipher.isEncryptionAvailable() === true } catch { return false }
  }

  function availability(): SecretsAvailability {
    if (!canDecrypt()) return { ok: false, reason: 'no-encryption' }
    if (options.platform === 'linux') {
      let backend = 'unknown'
      try { backend = String(options.backend?.() ?? 'unknown') } catch { /* unknown */ }
      if (!STRONG_LINUX_BACKENDS.includes(backend)) return { ok: false, reason: 'weak-backend' }
    }
    return { ok: true }
  }

  return {
    has(slot) {
      const path = pathOf(slot)
      try { return files.exists(path) } catch { return false }
    },

    read(slot) {
      const path = pathOf(slot)
      let bytes: Buffer
      try {
        bytes = files.read(path)
      } catch (error) {
        if (isMissing(error)) return null
        throw new SecretsError('unreadable', slot)
      }
      if (!canDecrypt()) throw new SecretsError('unavailable', slot, 'read')
      let text: unknown
      try { text = cipher.decryptString(bytes) } catch { throw new SecretsError('unreadable', slot) }
      if (typeof text !== 'string') throw new SecretsError('unreadable', slot)
      return text
    },

    write(slot, text) {
      const path = pathOf(slot)
      if (typeof text !== 'string' || text.length === 0) throw new TypeError('A secrets slot takes non-empty text.')
      if (!availability().ok) throw new SecretsError('unavailable', slot)
      let bytes: Buffer
      try { bytes = cipher.encryptString(text) } catch { throw new SecretsError('unavailable', slot) }
      // What is about to be written must decrypt to what was given; plain text is never written.
      let back: unknown
      try { back = cipher.decryptString(bytes) } catch { back = undefined }
      if (!Buffer.isBuffer(bytes) || bytes.length === 0 || back !== text) throw new SecretsError('unavailable', slot)
      // A cipher that hands the text back unchanged is not encryption (too short a text could match by chance).
      if (text.length >= 8 && bytes.includes(Buffer.from(text, 'utf8'))) throw new SecretsError('unavailable', slot)
      try { files.writeAtomic(path, bytes) } catch { throw new SecretsError('not-saved', slot) }
    },

    clear(slot) {
      const path = pathOf(slot)
      try { files.remove(path) } catch { throw new SecretsError('not-removed', slot) }
    },

    availability,
  }
}

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import {
  builtinProviders,
} from "@earendil-works/pi-ai/providers/all";
import {
  defaultProviderAuthContext,
  type AuthInteraction,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
} from "@earendil-works/pi-ai";
import type { SecretScope, SecretStore } from "@bridle/contract";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";

type AuthCredential = Credential;
/**
 * `committed` runs once the backend has committed `next` (for the file store: right after the
 * rename, before the directory fsync), and never if the commit failed before that point.
 */
type LockResult<T> = { result: T; next?: string; committed?: () => void };

interface AuthStorageBackend {
  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
  withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

/** Default bound on one OAuth token refresh. pi-ai's OpenAI Codex refresh has no timeout of its own. */
export const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 60_000;
const WRITE_RETRIES = 5;
/** Directory fsync errors that mean "this platform rejects directory descriptors", not an I/O failure. */
const UNSUPPORTED_DIR_SYNC = new Set(["EINVAL", "ENOTSUP", "EPERM", ...(process.platform === "win32" ? ["EISDIR"] : [])]);

type OAuthProvider = NonNullable<ReturnType<typeof builtinProviders>[number]["auth"]["oauth"]>;

/**
 * Options for a file-backed auth store. `refreshTimeoutMs` is a real setting; the rest are test
 * seams with production defaults.
 */
export type BridleAuthFileOptions = {
  /** Bound on one OAuth token refresh. Default DEFAULT_OAUTH_REFRESH_TIMEOUT_MS. */
  refreshTimeoutMs?: number;
  /** @internal One diagnostic line (path and reason, never content). Default console.warn. */
  log?: (line: string) => void;
  /** @internal OAuth flows by provider id. Default: pi-ai's built-in providers. */
  oauthProvider?: (providerId: string) => OAuthProvider | undefined;
  /** @internal File-system steps that tests make fail. */
  io?: { rename?: (from: string, to: string) => void };
};

/**
 * Coordination shared by every `AuthStorage` on one file in this process: committed content is
 * published to all of them, one refresh runs per provider, `modify` calls per provider are queued,
 * and a rotated credential whose save failed is held as pending until a later commit saves it.
 */
type StoreCoordination = {
  subscribe(listener: (committed: string, generation: number) => void): void;
  /** Generation of the latest commit to this file (what a new reader of the file is at). */
  currentGeneration(): number;
  refreshes: Map<string, Promise<AuthCredential | undefined>>;
  modifyTails: Map<string, Promise<unknown>>;
  pending: Map<string, AuthCredential>;
  /**
   * Per-provider revision, bumped when a commit that writes that provider succeeds. A refresh whose
   * save fails holds its rotation as pending only if the revision is unchanged since it began, so a
   * sign-in or sign-out that succeeded meanwhile wins.
   */
  revisions: Map<string, number>;
};

type PathState = StoreCoordination & {
  /** Serialises asynchronous critical sections on this file within the process. */
  tail: Promise<void>;
  /** Bumped by every commit. A section that read an older generation re-runs instead of committing. */
  generation: number;
  listeners: Set<(committed: string, generation: number) => void>;
  legacyChecked: boolean;
  /** True while a commit callback or publication runs: commits from there are forbidden. */
  inCommitCallback: boolean;
};

/** One entry per resolved auth file path, shared by every backend instance in this process. */
const pathStates = new Map<string, PathState>();

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

/** @internal Test helper: forget per-path state so a test starts as a fresh process would. */
export function resetAuthPathStatesForTests(): void {
  pathStates.clear();
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * File-backed auth store (core 0.14.2).
 *
 * Contract: **one process writes a given file, and the host guarantees it** (for example with a
 * single-instance lock). Reads take no lock and always see a complete file, because every commit
 * is an atomic rename. A second writing process breaks the contract: it can lose an update, but it
 * can never corrupt or truncate the file.
 *
 * - Within the process: synchronous sections run one at a time (one JavaScript thread);
 *   asynchronous sections are queued per path. Every commit bumps a per-path generation, and a
 *   section whose callback ran against an older generation re-runs it (bounded) instead of
 *   committing, so a continuation never overwrites a newer commit.
 * - Commit: temporary file (exclusive create, 0600), fsync, rename over the auth file, then
 *   directory fsync. Errors surface, except a platform's refusal of directory descriptors.
 * - Init: `{}` is written to a temporary file and linked into place only if the auth file is
 *   absent; an existing file is never overwritten or truncated.
 * - Legacy: on the first commit, an empty `<auth>.lock` folder left by an earlier Bridle version is
 *   removed with one diagnostic line.
 */
export class FileAuthStorageBackend implements AuthStorageBackend {
  readonly #authPath: string;
  readonly #legacyLockPath: string;
  readonly #log: (line: string) => void;
  readonly #rename: (from: string, to: string) => void;

  constructor(authPath: string, options: BridleAuthFileOptions = {}) {
    this.#authPath = resolve(authPath);
    this.#legacyLockPath = `${this.#authPath}.lock`;
    this.#log = options.log ?? ((line) => console.warn(line));
    this.#rename = options.io?.rename ?? renameSync;
  }

  #state(): PathState {
    let state = pathStates.get(this.#authPath);
    if (!state) {
      const listeners = new Set<(committed: string, generation: number) => void>();
      state = {
        tail: Promise.resolve(),
        generation: 0,
        listeners,
        legacyChecked: false,
        inCommitCallback: false,
        subscribe: (listener) => { listeners.add(listener); },
        currentGeneration: () => pathStates.get(this.#authPath)?.generation ?? 0,
        refreshes: new Map(),
        modifyTails: new Map(),
        pending: new Map(),
        revisions: new Map(),
      };
      pathStates.set(this.#authPath, state);
    }
    return state;
  }

  /** @internal Shared coordination for AuthStorage instances on this file. */
  coordination(): StoreCoordination {
    return this.#state();
  }

  #temporaryPath(): string {
    return `${this.#authPath}.${process.pid}.${randomUUID()}.tmp`;
  }

  /** Writes `content` to a new temporary file (exclusive create, 0600) and fsyncs it. */
  #writeTemporary(content: string): string {
    const temporary = this.#temporaryPath();
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeFileSync(fd, content, "utf8");
      fsyncSync(fd);
    } catch (error) {
      closeSync(fd);
      try { unlinkSync(temporary); } catch { /* Best effort. */ }
      throw error;
    }
    closeSync(fd);
    return temporary;
  }

  #ensureFile(): void {
    mkdirSync(dirname(this.#authPath), { recursive: true, mode: 0o700 });
    try {
      lstatSync(this.#authPath);
      return;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const temporary = this.#writeTemporary("{}");
    try {
      // link fails with EEXIST if another writer created the file meanwhile: never overwrites.
      linkSync(temporary, this.#authPath);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    } finally {
      try { unlinkSync(temporary); } catch { /* Best effort. */ }
    }
  }

  #read(): string {
    this.#ensureFile();
    return readFileSync(this.#authPath, "utf8");
  }

  #removeLegacyLock(): void {
    try {
      rmdirSync(this.#legacyLockPath);
      this.#log(`[bridle] auth storage: removed ${this.#legacyLockPath} because it is a lock folder left by an earlier Bridle version.`);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return;
      if (code === "ENOTEMPTY" || code === "EEXIST") {
        this.#log(`[bridle] auth storage: left ${this.#legacyLockPath} in place because it is not empty.`);
        return;
      }
      this.#log(`[bridle] auth storage: could not remove ${this.#legacyLockPath} (${code ?? "error"}).`);
    }
  }

  /**
   * Atomic replace, then publish. A failure before the rename leaves the previous file and removes
   * the temporary one. After the rename the commit has happened: the generation is bumped and the
   * content published before the directory fsync, whose error (if any) is then thrown.
   */
  #commit(state: PathState, next: string, committed?: () => void): void {
    if (state.inCommitCallback) {
      throw new Error("Internal error: a commit callback or publication tried to commit to the auth file; commits from there are forbidden.");
    }
    if (!state.legacyChecked) {
      state.legacyChecked = true;
      this.#removeLegacyLock();
    }
    const temporary = this.#writeTemporary(next);
    try {
      this.#rename(temporary, this.#authPath);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* Best effort. */ }
      throw error;
    }
    // Committed. Whatever the callback does, publication and the directory fsync still happen,
    // and the callback's error (if any) is thrown afterwards.
    state.generation += 1;
    const generation = state.generation;
    let callbackError: unknown;
    let failed = false;
    state.inCommitCallback = true;
    try {
      committed?.();
    } catch (error) {
      failed = true;
      callbackError = error;
    } finally {
      try {
        // Nested commits are forbidden above, so this generation is still current; the check
        // keeps a superseded commit from ever being published.
        if (state.generation === generation) {
          for (const listener of state.listeners) listener(next, generation);
        }
      } finally {
        state.inCommitCallback = false;
      }
    }
    let syncError: unknown;
    try {
      fsyncPath(dirname(this.#authPath));
    } catch (error) {
      if (!UNSUPPORTED_DIR_SYNC.has(errorCode(error) ?? "")) syncError = error;
    }
    if (failed) throw callbackError;
    if (syncError !== undefined) throw syncError;
  }

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    const state = this.#state();
    for (let attempt = 0; attempt < WRITE_RETRIES; attempt += 1) {
      const generation = state.generation;
      const outcome = fn(this.#read());
      // The callback itself committed (re-entrantly) on this file: re-run on the new content.
      if (state.generation !== generation) continue;
      if (outcome.next !== undefined) this.#commit(state, outcome.next, outcome.committed);
      return outcome.result;
    }
    throw new Error(`The auth file ${this.#authPath} kept changing; the change was not saved.`);
  }

  async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
    const state = this.#state();
    const previous = state.tail;
    let release!: () => void;
    state.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      for (let attempt = 0; attempt < WRITE_RETRIES; attempt += 1) {
        const generation = state.generation;
        const outcome = await fn(this.#read());
        // A commit landed while this section awaited: re-run on the new content.
        if (state.generation !== generation) continue;
        if (outcome.next !== undefined) this.#commit(state, outcome.next, outcome.committed);
        return outcome.result;
      }
      throw new Error(`The auth file ${this.#authPath} kept changing; the change was not saved.`);
    } finally {
      release();
    }
  }
}

class InMemoryAuthStorageBackend implements AuthStorageBackend {
  #value: string | undefined;

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    const outcome = fn(this.#value);
    if (outcome.next !== undefined) { this.#value = outcome.next; outcome.committed?.(); }
    return outcome.result;
  }

  async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
    const outcome = await fn(this.#value);
    if (outcome.next !== undefined) { this.#value = outcome.next; outcome.committed?.(); }
    return outcome.result;
  }
}

function sameCredential(a: AuthCredential | undefined, b: AuthCredential | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function needsRefresh(credential: AuthCredential | undefined): boolean {
  return credential?.type === "oauth" && credential.expires <= Date.now() + 300_000;
}

class AuthStorage implements CredentialStore {
  #data: Record<string, AuthCredential> = {};
  /** Generation of the last commit installed in `#data` (shared stores only). */
  #installedGeneration = 0;
  #loadError: unknown;
  #errors: Error[] = [];
  readonly #runtimeOverrides = new Map<string, string>();
  readonly #coordination: StoreCoordination;
  /** True when the backend publishes every commit to this instance (file stores). */
  readonly #published: boolean;
  readonly #refreshTimeoutMs: number;
  readonly #oauthProvider: (providerId: string) => OAuthProvider | undefined;

  private constructor(private readonly backend: AuthStorageBackend, options: BridleAuthFileOptions = {}) {
    this.#refreshTimeoutMs = options.refreshTimeoutMs ?? DEFAULT_OAUTH_REFRESH_TIMEOUT_MS;
    this.#oauthProvider = options.oauthProvider
      ?? ((providerId) => builtinProviders().find((candidate) => candidate.id === providerId)?.auth.oauth);
    const shared = backend instanceof FileAuthStorageBackend ? backend.coordination() : undefined;
    this.#published = shared !== undefined;
    this.#coordination = shared ?? {
      subscribe: () => {},
      currentGeneration: () => 0,
      refreshes: new Map(),
      modifyTails: new Map(),
      pending: new Map(),
      revisions: new Map(),
    };
    if (shared) {
      const self = new WeakRef(this);
      shared.subscribe((committed, generation) => {
        const target = self.deref();
        if (target) target.#installCommitted(committed, generation);
      });
    }
    this.reload();
  }

  static create(authPath: string, options: BridleAuthFileOptions = {}): AuthStorage {
    return new AuthStorage(new FileAuthStorageBackend(authPath, options), options);
  }

  static fromStorage(backend: AuthStorageBackend): AuthStorage {
    return new AuthStorage(backend);
  }

  static inMemory(data: Record<string, AuthCredential> = {}): AuthStorage {
    const backend = new InMemoryAuthStorageBackend();
    backend.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
    return new AuthStorage(backend);
  }

  /** Installs a commit published by the file backend, in commit order; an older generation is ignored. */
  #installCommitted(committed: string, generation: number): void {
    if (generation <= this.#installedGeneration) return;
    try {
      this.#data = parseAuthData(committed);
      this.#installedGeneration = generation;
      this.#loadError = undefined;
    } catch (error) {
      this.#recordError(error);
    }
  }

  /** Non-publishing backends (memory, secret store): install after the call returns, as before. */
  #installReturned(data: Record<string, AuthCredential>): void {
    if (this.#published) return;
    this.#data = data;
    this.#loadError = undefined;
  }

  reload(): void {
    try {
      this.backend.withLock((current) => {
        this.#data = parseAuthData(current ?? "{}");
        // What was just read is the file as of the latest commit: older publications are stale.
        if (this.#published) this.#installedGeneration = Math.max(this.#installedGeneration, this.#coordination.currentGeneration());
        return { result: undefined };
      });
      this.#loadError = undefined;
    } catch (error) {
      this.#loadError = error;
      this.#recordError(error);
    }
  }

  /** The credential this process uses: a pending (saved-later) rotation first, then the stored one. */
  get(providerId: string): AuthCredential | undefined {
    return this.#coordination.pending.get(providerId) ?? this.#data[providerId];
  }

  /** Saves first; memory changes only after the save. Throws when the save fails. */
  set(providerId: string, credential: AuthCredential): void {
    this.#persist(providerId, credential);
  }

  /** Saves first; memory changes only after the save. Throws when the save fails. */
  remove(providerId: string): void {
    this.#persist(providerId, undefined);
  }

  getAuthLane(providerId: string): import("./events.ts").TurnAuthLane {
    if (this.#runtimeOverrides.has(providerId)) return "apikey";
    const status = this.getAuthStatus(providerId);
    return status.configured ? status.label === "OAuth" ? "oauth" : "apikey" : "none";
  }

  getAuthStatus(providerId: string): { configured: boolean; label?: string } {
    const credential = this.get(providerId);
    if (credential) return { configured: true, label: credential.type === "oauth" ? "OAuth" : "API key" };
    if (this.#runtimeOverrides.has(providerId)) return { configured: true, label: "runtime API key" };
    return { configured: false };
  }

  setRuntimeApiKey(providerId: string, key: string): void {
    this.#runtimeOverrides.set(providerId, key);
  }

  removeRuntimeApiKey(providerId: string): void {
    this.#runtimeOverrides.delete(providerId);
  }

  drainErrors(): Error[] {
    const errors = [...this.#errors];
    this.#errors = [];
    return errors;
  }

  async read(providerId: string): Promise<AuthCredential | undefined> {
    const runtime = this.#runtimeOverrides.get(providerId);
    return runtime ? { type: "api_key", key: runtime } : this.get(providerId);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const ids = [...Object.keys(this.#data), ...this.#coordination.pending.keys(), ...this.#runtimeOverrides.keys()];
    return [...new Set(ids)]
      .sort()
      .map((providerId) => ({
        providerId,
        type: this.#runtimeOverrides.has(providerId) ? "api_key" : this.get(providerId)!.type,
      }));
  }

  /**
   * Adds pending rotations to `data` (they are newer than the file), except `skip`. Returns the
   * entries applied, so they can be cleared once the commit that carries them succeeds.
   */
  #applyPending(data: Record<string, AuthCredential>, skip?: string): Array<[string, AuthCredential]> {
    const applied: Array<[string, AuthCredential]> = [];
    for (const [providerId, credential] of this.#coordination.pending) {
      if (providerId === skip) continue;
      data[providerId] = credential;
      applied.push([providerId, credential]);
    }
    return applied;
  }

  /** Commit-point bookkeeping: the written provider's revision moves on and its pending rotation (if any) is superseded. */
  #onCommitted(providerId: string, applied: Array<[string, AuthCredential]>, pendingAtWrite: AuthCredential | undefined): void {
    const { revisions, pending } = this.#coordination;
    revisions.set(providerId, (revisions.get(providerId) ?? 0) + 1);
    // Only the rotation this write superseded is cleared: one installed after the write was
    // prepared (possible when a backend commits later, as the secret store does) is kept.
    if (pending.get(providerId) === pendingAtWrite) pending.delete(providerId);
    this.#clearPending(applied);
  }

  #clearPending(applied: Array<[string, AuthCredential]>): void {
    for (const [providerId, credential] of applied) {
      if (this.#coordination.pending.get(providerId) === credential) this.#coordination.pending.delete(providerId);
    }
  }

  /**
   * Runs `fn` on the current credential (a pending rotation, else the stored one) without holding
   * the store, then commits its result for this provider only. If the provider's credential changed
   * while `fn` ran (another refresh or a new sign-in), that one wins and is returned. Memory changes
   * only after the commit. Calls for one provider are queued across every instance on the file, so a
   * second refresh sees the first one's result.
   */
  modify(
    providerId: string,
    fn: (current: AuthCredential | undefined) => Promise<AuthCredential | undefined>,
  ): Promise<AuthCredential | undefined> {
    return this.#queued(providerId, () => this.#modifyNow(providerId, fn, false));
  }

  #queued<T>(providerId: string, run: () => Promise<T>): Promise<T> {
    const tails = this.#coordination.modifyTails;
    const previous = tails.get(providerId) ?? Promise.resolve();
    const result = previous.then(run, run);
    const tail = result.then(() => undefined, () => undefined);
    tails.set(providerId, tail);
    void tail.then(() => { if (tails.get(providerId) === tail) tails.delete(providerId); });
    return result;
  }

  #current(providerId: string): AuthCredential | undefined {
    return this.#coordination.pending.get(providerId)
      ?? this.backend.withLock((current) => ({ result: parseAuthData(current ?? "{}")[providerId] }));
  }

  async #modifyNow(
    providerId: string,
    fn: (current: AuthCredential | undefined) => Promise<AuthCredential | undefined>,
    keepPendingOnFailure: boolean,
  ): Promise<AuthCredential | undefined> {
    const revision = this.#coordination.revisions.get(providerId) ?? 0;
    const before = this.#current(providerId);
    const next = await fn(before);
    if (next === undefined) return before;
    let reachedCommit = false;
    try {
      const committed = await this.backend.withLockAsync(async (current) => {
        const data = parseAuthData(current ?? "{}");
        const pendingAtWrite = this.#coordination.pending.get(providerId);
        const applied = this.#applyPending(data);
        // A sign-in or sign-out for this provider committed while `fn` ran: it wins, even with identical bytes.
        const superseded = (this.#coordination.revisions.get(providerId) ?? 0) !== revision;
        if (superseded || !sameCredential(data[providerId], before)) {
          return { result: { credential: data[providerId], data, wrote: false } };
        }
        data[providerId] = next;
        return {
          result: { credential: next, data, wrote: true },
          next: JSON.stringify(data, null, 2),
          committed: () => { reachedCommit = true; this.#onCommitted(providerId, applied, pendingAtWrite); },
        };
      });
      if (committed.wrote) this.#installReturned(committed.data);
      return committed.credential;
    } catch (error) {
      if (!keepPendingOnFailure) throw error;
      this.#recordError(error);
      // Committed (the error came after the rename, e.g. directory fsync): the rotation is on disk
      // and already published; report whatever is current now, which a later sign-out may have removed.
      if (reachedCommit) return this.get(providerId);
      // A sign-in or sign-out for this provider succeeded while the save was in flight: it wins.
      if ((this.#coordination.revisions.get(providerId) ?? 0) !== revision) return this.get(providerId);
      // The refreshed credential exists only here; the one it replaced may already be revoked.
      // Serve it and save it with the next commit; never refresh again with the superseded token.
      this.#coordination.pending.set(providerId, next);
      return next;
    }
  }

  async delete(providerId: string): Promise<void> {
    const data = await this.backend.withLockAsync(async (current) => {
      const data = parseAuthData(current ?? "{}");
      const pendingAtWrite = this.#coordination.pending.get(providerId);
      const applied = this.#applyPending(data, providerId);
      delete data[providerId];
      return { result: data, next: JSON.stringify(data, null, 2), committed: () => this.#onCommitted(providerId, applied, pendingAtWrite) };
    });
    this.#installReturned(data);
    this.#runtimeOverrides.delete(providerId);
  }

  async getApiKey(providerId: string, options: { includeFallback?: boolean } = {}): Promise<string | undefined> {
    const runtime = this.#runtimeOverrides.get(providerId);
    if (runtime) return runtime;
    const credential = this.get(providerId);
    if (credential?.type === "api_key") return credential.key;
    const provider = builtinProviders().find((candidate) => candidate.id === providerId);
    const oauth = credential?.type === "oauth" ? this.#oauthProvider(providerId) : undefined;
    if (credential?.type === "oauth" && oauth) {
      const current = needsRefresh(credential) ? await this.#refreshOAuth(providerId, oauth) : credential;
      if (current?.type === "oauth") return (await oauth.toAuth(current)).apiKey;
      if (current?.type === "api_key") return current.key;
    }
    if (options.includeFallback === false || !provider?.auth.apiKey) return undefined;
    const resolved = await provider.auth.apiKey.resolve({ ctx: defaultProviderAuthContext() });
    return resolved?.auth.apiKey;
  }

  /**
   * Refreshes outside the store (see `modify`), bounded by the refresh timeout. One refresh runs per
   * provider for every instance on the file; callers that arrive while it runs join it. A caller
   * whose deadline passes gets an error, but the refresh keeps its slot until it settles and a late
   * result is still committed (or held as pending), so a rotated refresh token is not lost and no
   * second refresh is started with the old one.
   */
  #refreshOAuth(providerId: string, oauth: OAuthProvider): Promise<AuthCredential | undefined> {
    const refreshes = this.#coordination.refreshes;
    let flight = refreshes.get(providerId);
    if (!flight) {
      const started: Promise<AuthCredential | undefined> = this.#queued(providerId, () => this.#modifyNow(
        providerId,
        async (stored) => (stored?.type === "oauth" && needsRefresh(stored) ? oauth.refresh(stored) : stored),
        true,
      )).finally(() => {
        if (refreshes.get(providerId) === started) refreshes.delete(providerId);
      });
      started.catch(() => { /* Each caller observes the failure through its own race below. */ });
      refreshes.set(providerId, started);
      flight = started;
    }
    const timeoutMs = this.#refreshTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(
        `OAuth token refresh for ${providerId} did not finish within ${Math.round(timeoutMs / 1000)} s; the stored sign-in is unchanged.`,
      )), timeoutMs);
    });
    return Promise.race([flight, deadline]).finally(() => clearTimeout(timer));
  }

  #persist(providerId: string, credential: AuthCredential | undefined): void {
    if (this.#loadError) {
      throw new Error("The auth file could not be read, so the change was not saved.");
    }
    // A pending rotation for this provider is superseded only once this save has committed.
    const data = this.backend.withLock((current) => {
      const data = parseAuthData(current ?? "{}");
      const pendingAtWrite = this.#coordination.pending.get(providerId);
      const applied = this.#applyPending(data, providerId);
      if (credential) data[providerId] = credential;
      else delete data[providerId];
      return { result: data, next: JSON.stringify(data, null, 2), committed: () => this.#onCommitted(providerId, applied, pendingAtWrite) };
    });
    this.#installReturned(data);
  }

  #recordError(error: unknown): void {
    this.#errors.push(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * ADR-0002: subscription auth uses pi-ai's official OAuth flows; Bridle only
 * owns where credentials live (the host app's data directory) and the status
 * surface. Never expose credential values; status only.
 */
export class BridleAuth {
  #listeners = new Set<() => void>();

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #notifyChange(): void {
    for (const listener of this.#listeners) {
      try { listener(); } catch { /* Observers cannot fail an auth operation. */ }
    }
  }

  private constructor(readonly storage: AuthStorage) {}

  /**
   * A file-backed store. Contract: one process writes a given file, and the host guarantees it
   * (for example with a single-instance lock). Reads always see a complete file; a second writing
   * process breaks the contract and can lose an update, but never corrupts or truncates the file.
   */
  static file(authPath: string, options: BridleAuthFileOptions = {}): BridleAuth {
    return new BridleAuth(AuthStorage.create(authPath, options));
  }

  static inMemory(): BridleAuth {
    return new BridleAuth(AuthStorage.inMemory());
  }

  static secretStore(store: SecretStore, appId: string): BridleAuth {
    const backend = new SecretAuthStorageBackend(store, appId);
    const storage = AuthStorage.fromStorage(backend);
    backend.attach(storage);
    const auth = new BridleAuth(storage);
    secretBackends.set(auth, backend);
    return auth;
  }

  async login(providerId: string, callbacks: OAuthLoginCallbacks): Promise<void> {
    const oauth = builtinProviders().find((provider) => provider.id === providerId)?.auth.oauth;
    if (!oauth) throw new Error(`Unknown OAuth provider: ${providerId}`);
    const credentials = await oauth.login(oauthInteraction(callbacks));
    this.storage.set(providerId, credentials);
    await prepareAuthProvider(this, providerId);
    this.#notifyChange();
  }

  /** Uses stored status and Pi's already-cached availability; never resolves credentials. */
  authLane(providerId: string, availability?: { configured: boolean; source?: string }): import("./events.ts").TurnAuthLane {
    const stored = this.storage.getAuthLane(providerId);
    if (stored !== "none") return stored;
    if (!availability?.configured) return "none";
    return availability.source === "environment" ? "env" : "apikey";
  }

  status(providerId: string): { configured: boolean; label?: string } {
    const status = this.storage.getAuthStatus(providerId);
    return { configured: status.configured, label: status.label };
  }

  setApiKey(providerId: string, key: string): void {
    this.storage.set(providerId, { type: "api_key", key });
    this.#notifyChange();
  }

  logout(providerId: string): void {
    this.storage.remove(providerId);
    this.#notifyChange();
  }
}

function oauthInteraction(callbacks: OAuthLoginCallbacks): AuthInteraction {
  return {
    signal: callbacks.signal,
    async prompt(prompt) {
      if (prompt.type === "select") {
        const selected = await callbacks.onSelect({
          message: prompt.message,
          options: prompt.options.map(({ id, label }) => ({ id, label })),
        });
        if (selected === undefined) throw new Error("OAuth login cancelled.");
        return selected;
      }
      if (prompt.type === "manual_code" && callbacks.onManualCodeInput) {
        return callbacks.onManualCodeInput();
      }
      return callbacks.onPrompt({ message: prompt.message, placeholder: prompt.placeholder });
    },
    notify(event) {
      if (event.type === "auth_url") {
        callbacks.onAuth({ url: event.url, instructions: event.instructions });
      } else if (event.type === "device_code") {
        callbacks.onDeviceCode(event);
      } else if (event.type === "progress" || event.type === "info") {
        callbacks.onProgress?.(event.message);
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isAuthCredential(value: unknown): value is AuthCredential {
  if (!isRecord(value)) return false;
  if (value.type === "api_key") {
    return typeof value.key === "string" && (value.env === undefined || isStringRecord(value.env));
  }
  return value.type === "oauth"
    && typeof value.refresh === "string"
    && typeof value.access === "string"
    && typeof value.expires === "number"
    && Number.isFinite(value.expires);
}

function parseAuthData(raw: string): Record<string, AuthCredential> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Invalid auth data: expected JSON object");
  }
  if (!isRecord(value)) throw new Error("Invalid auth data: expected provider map");
  const entries = Object.entries(value);
  if (entries.some(([providerId, credential]) => !/^[A-Za-z0-9._-]+$/.test(providerId) || !isAuthCredential(credential))) {
    throw new Error("Invalid auth data: malformed provider credential");
  }
  return Object.fromEntries(entries) as Record<string, AuthCredential>;
}

function scope(appId: string, providerId: string): SecretScope {
  return { appId, name: `auth.${providerId}` };
}

class SecretAuthStorageBackend implements AuthStorageBackend {
  private current = "{}";
  private tail: Promise<void> = Promise.resolve();
  private readonly revisions = new Map<string, number>();
  private readonly errors: Error[] = [];
  private readonly immediateErrors = new Map<string, Error[]>();
  private authStorage: AuthStorage | undefined;

  constructor(private readonly store: SecretStore, private readonly appId: string) {}

  attach(storage: AuthStorage): void {
    this.authStorage = storage;
    const getApiKey = storage.getApiKey.bind(storage);
    storage.getApiKey = async (providerId, options) => {
      const result = await getApiKey(providerId, options);
      this.throwImmediateError(providerId);
      return result;
    };
  }

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    const before = parseAuthData(this.current);
    const outcome = fn(this.current);
    if (outcome.next !== undefined) {
      const after = parseAuthData(outcome.next);
      const changes = this.applyChanges(before, after);
      void this.enqueue(async () => {
        // The commit point for a deferred write is successful persistence, not the memory update.
        if (!(await this.persistChanges(changes, "deferred"))) return;
        try {
          outcome.committed?.();
        } catch (error) {
          this.errors.push(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }
    return outcome.result;
  }

  async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
    return this.enqueue(async () => {
      const before = parseAuthData(this.current);
      const startRevisions = new Map(this.revisions);
      const outcome = await fn(this.current);
      if (outcome.next !== undefined) {
        const desired = parseAuthData(outcome.next);
        const currentBeforeMerge = parseAuthData(this.current);
        const merged = { ...currentBeforeMerge };
        for (const providerId of new Set([...Object.keys(before), ...Object.keys(desired)])) {
          if ((this.revisions.get(providerId) ?? 0) !== (startRevisions.get(providerId) ?? 0)) continue;
          if (providerId in desired) merged[providerId] = desired[providerId]!;
          else delete merged[providerId];
        }
        const changes = this.applyChanges(currentBeforeMerge, merged);
        try {
          await this.persistChanges(changes, "immediate");
          outcome.committed?.();
        } finally {
          this.authStorage?.reload();
        }
      }
      return outcome.result;
    });
  }

  async prepare(providerId: string): Promise<void> {
    await this.tail;
    this.throwNextError();
    await this.enqueue(async () => {
      const revision = this.revisions.get(providerId) ?? 0;
      let raw: string | null;
      try {
        raw = await this.store.get(scope(this.appId, providerId));
      } catch {
        throw new Error(`Secret retrieval failed for auth.${providerId}`);
      }
      if ((this.revisions.get(providerId) ?? 0) !== revision) return;
      const data = parseAuthData(this.current);
      if (raw === null) {
        delete data[providerId];
      } else {
        let credential: unknown;
        try {
          credential = JSON.parse(raw);
        } catch {
          throw new Error(`Invalid auth secret for provider: ${providerId}`);
        }
        if (!isAuthCredential(credential)) throw new Error(`Invalid auth secret for provider: ${providerId}`);
        data[providerId] = credential;
      }
      this.setCurrent(data);
      this.revisions.set(providerId, revision + 1);
    });
    await this.tail;
    this.throwNextError();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private setCurrent(data: Record<string, AuthCredential>): void {
    this.current = JSON.stringify(data, null, 2);
  }

  private applyChanges(before: Record<string, AuthCredential>, after: Record<string, AuthCredential>) {
    const changes: { providerId: string; before?: AuthCredential; after?: AuthCredential; revision: number }[] = [];
    for (const providerId of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[providerId]) === JSON.stringify(after[providerId])) continue;
      const revision = (this.revisions.get(providerId) ?? 0) + 1;
      this.revisions.set(providerId, revision);
      changes.push({ providerId, before: before[providerId], after: after[providerId], revision });
    }
    this.setCurrent(after);
    return changes;
  }

  private async persistChanges(
    changes: { providerId: string; before?: AuthCredential; after?: AuthCredential; revision: number }[],
    failureMode: "deferred" | "immediate",
  ): Promise<boolean> {
    let allPersisted = true;
    for (const change of changes) {
      try {
        if (change.after === undefined) {
          await this.store.delete(scope(this.appId, change.providerId));
        } else {
          await this.store.set(scope(this.appId, change.providerId), JSON.stringify(change.after));
        }
      } catch {
        if ((this.revisions.get(change.providerId) ?? 0) === change.revision) {
          const data = parseAuthData(this.current);
          if (change.before === undefined) delete data[change.providerId];
          else data[change.providerId] = change.before;
          this.setCurrent(data);
          this.revisions.set(change.providerId, change.revision + 1);
        }
        const error = new Error(`Secret persistence failed for auth.${change.providerId}`);
        if (failureMode === "immediate") {
          const providerErrors = this.immediateErrors.get(change.providerId) ?? [];
          providerErrors.push(error);
          this.immediateErrors.set(change.providerId, providerErrors);
          throw error;
        }
        this.errors.push(error);
        allPersisted = false;
      }
    }
    return allPersisted;
  }

  private throwNextError(): void {
    const error = this.errors.shift();
    if (error) throw error;
  }

  private throwImmediateError(providerId: string): void {
    const providerErrors = this.immediateErrors.get(providerId);
    const error = providerErrors?.shift();
    if (providerErrors?.length === 0) this.immediateErrors.delete(providerId);
    if (error) throw error;
  }
}

const secretBackends = new WeakMap<BridleAuth, SecretAuthStorageBackend>();

/** @internal Runtime bridge: await pending mutations and hydrate the selected provider. */
export async function prepareAuthProvider(auth: BridleAuth, providerId: string): Promise<void> {
  const backend = secretBackends.get(auth);
  if (!backend) return;
  try {
    await backend.prepare(providerId);
  } finally {
    auth.storage.reload();
  }
}

export async function migrateAuthFile(path: string, store: SecretStore, appId: string): Promise<void> {
  const target = `${path}.migrated`;
  const initial = lstatSync(path, { bigint: true });
  if (!initial.isFile() || initial.isSymbolicLink()) throw new Error("Invalid auth file: expected a regular file");
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const sourceFd = openSync(path, constants.O_RDONLY | noFollow);
  let targetFd: number | undefined;
  let targetCreated = false;
  try {
    const sourceStat = fstatSync(sourceFd, { bigint: true });
    if (!sourceStat.isFile() || sourceStat.dev !== initial.dev || sourceStat.ino !== initial.ino) {
      throw new Error("Invalid auth file: source identity changed");
    }
    const raw = readFileSync(sourceFd, { encoding: "utf8" });
    const data = parseAuthData(raw);
    targetFd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    targetCreated = true;
    fchmodSync(targetFd, 0o600);
    for (const [providerId, credential] of Object.entries(data)) {
      try {
        await store.set(scope(appId, providerId), JSON.stringify(credential));
      } catch {
        throw new Error(`Migration secret write failed for auth.${providerId}`);
      }
    }
    writeFileSync(targetFd, raw, { encoding: "utf8" });
    fsyncSync(targetFd);
    closeSync(targetFd);
    targetFd = undefined;

    const current = statSync(path, { bigint: true });
    const currentLink = lstatSync(path, { bigint: true });
    if (currentLink.isSymbolicLink() || current.dev !== sourceStat.dev || current.ino !== sourceStat.ino) {
      throw new Error("Invalid auth file: source identity changed");
    }
    unlinkSync(path);
  } catch (error) {
    if (targetFd !== undefined) closeSync(targetFd);
    if (targetCreated) {
      try { unlinkSync(target); } catch { /* best-effort cleanup of our exclusive target */ }
    }
    if (isRecord(error) && error.code === "EEXIST") {
      throw new Error("Migration target already exists");
    }
    throw error;
  } finally {
    closeSync(sourceFd);
  }
}

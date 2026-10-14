import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { secretKey, type SecretStatus, type SecretStore } from "@bridle/contract";
import type { SecretEvent } from "./index.ts";

type Entry = { value: string; setAt: string; expiresAt?: string };
type Data = Record<string, Entry>;

function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isData(value: unknown): value is Data {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const candidate = entry as Record<string, unknown>;
    return Object.keys(candidate).every((key) => key === "value" || key === "setAt" || key === "expiresAt")
      && typeof candidate.value === "string"
      && isCanonicalIso(candidate.setAt)
      && (candidate.expiresAt === undefined || isCanonicalIso(candidate.expiresAt));
  });
}

export function createDevFileStore(opts: {
  dir: string;
  acknowledgeInsecure: true;
  onEvent?: (event: SecretEvent) => void;
}): SecretStore {
  if (opts.acknowledgeInsecure !== true) throw new Error("insecure-secret-storage-not-acknowledged");
  const path = join(opts.dir, "SECRETS-DEV-INSECURE.json");
  let mutationTail: Promise<void> = Promise.resolve();
  const reportedExpired = new Set<string>();

  function emit(event: SecretEvent): void {
    try { opts.onEvent?.(event); } catch { /* Audit observers cannot change persisted secret state. */ }
  }

  async function read(): Promise<Data> {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!isData(parsed)) throw new Error("invalid-dev-secret-file");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      if (error instanceof SyntaxError) throw new Error("invalid-dev-secret-file");
      throw error;
    }
  }

  async function write(data: Data): Promise<void> {
    await mkdir(opts.dir, { recursive: true });
    const temporaryPath = join(opts.dir, `.secrets-dev-${process.pid}-${crypto.randomUUID()}.tmp`);
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(data, null, 2)}\n`);
      await file.sync();
      await file.close();
      await rename(temporaryPath, path);
    } catch (error) {
      await file.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  function mutate(update: (data: Data) => void): Promise<void> {
    const mutation = mutationTail.then(async () => {
      const data = await read();
      update(data);
      await write(data);
    });
    mutationTail = mutation.catch(() => undefined);
    return mutation;
  }

  function status(entry: Entry | undefined): SecretStatus {
    if (!entry) return { state: "absent" };
    return {
      state: "present", setAt: entry.setAt,
      ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
      expired: entry.expiresAt !== undefined && new Date(entry.expiresAt).getTime() <= Date.now(),
    };
  }

  function observeStatus(key: string, entry: Entry | undefined): SecretStatus {
    const current = status(entry);
    if (current.state === "present" && current.expired && !reportedExpired.has(key)) {
      reportedExpired.add(key);
      emit({ type: "secret.expired", key, ...(current.expiresAt ? { expiresAt: current.expiresAt } : {}) });
    }
    return current;
  }

  return {
    async set(scope, value, setOpts) {
      const setAt = new Date();
      const ttl = setOpts?.ttlSeconds;
      if (ttl !== undefined && (!Number.isFinite(ttl) || ttl < 0)) throw new Error("invalid-ttl-seconds");
      const expiry = ttl === undefined ? undefined : new Date(setAt.getTime() + ttl * 1_000);
      if (expiry && Number.isNaN(expiry.getTime())) throw new Error("invalid-ttl-seconds");
      await mutate((data) => {
        data[secretKey(scope)] = { value, setAt: setAt.toISOString(), ...(expiry ? { expiresAt: expiry.toISOString() } : {}) };
      });
      const key = secretKey(scope);
      const expiresAt = expiry?.toISOString();
      reportedExpired.delete(key);
      emit({ type: "secret.set", key, ...(expiresAt ? { expiresAt } : {}) });
    },
    async get(scope) {
      const key = secretKey(scope);
      const entry = (await read())[key];
      const currentStatus = observeStatus(key, entry);
      return currentStatus.state === "present" && !currentStatus.expired ? entry?.value ?? null : null;
    },
    async delete(scope) {
      await mutate((data) => { delete data[secretKey(scope)]; });
      const key = secretKey(scope);
      reportedExpired.delete(key);
      emit({ type: "secret.deleted", key });
    },
    async status(scope) {
      const key = secretKey(scope);
      return observeStatus(key, (await read())[key]);
    },
  };
}

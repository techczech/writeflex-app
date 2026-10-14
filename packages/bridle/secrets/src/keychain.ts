import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { secretKey, type SecretScope, type SecretStatus, type SecretStore } from "@bridle/contract";
import type { SecretEvent } from "./index.ts";

type CommandResult = { exitCode: number; stdout: string; stderr: string };

export type SecurityRunner = (args: string[], stdin?: string) => Promise<CommandResult>;

type KeychainOptions = {
  appId: string;
  metaDir: string;
  onEvent?: (event: SecretEvent) => void;
};

type KeychainDependencies = {
  platform: string;
  runSecurity: SecurityRunner;
  now?: () => Date;
  writeMetadata?: (path: string, metadata: Metadata) => Promise<void>;
};

type MetadataEntry = { setAt: string; expiresAt?: string };
type Metadata = Record<string, MetadataEntry>;

async function readMetadata(path: string): Promise<Metadata> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isMetadata(parsed)) throw new Error("invalid-secret-metadata");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof SyntaxError) throw new Error("invalid-secret-metadata");
    throw error;
  }
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}

function isMetadata(value: unknown): value is Metadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const candidate = entry as Record<string, unknown>;
    const keys = Object.keys(candidate);
    return keys.every((key) => key === "setAt" || key === "expiresAt")
      && isIsoTimestamp(candidate.setAt)
      && (candidate.expiresAt === undefined || isIsoTimestamp(candidate.expiresAt));
  });
}

async function writeMetadata(path: string, metadata: Metadata): Promise<void> {
  const directory = join(path, "..");
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.secrets-meta-${process.pid}-${crypto.randomUUID()}.tmp`);
  const file = await open(temporaryPath, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(metadata, null, 2)}\n`);
    await file.sync();
    await file.close();
    await rename(temporaryPath, path);
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function statusFor(entry: MetadataEntry | undefined, now: Date): SecretStatus {
  if (!entry) return { state: "absent" };
  return {
    state: "present",
    setAt: entry.setAt,
    ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
    expired: entry.expiresAt !== undefined && new Date(entry.expiresAt).getTime() <= now.getTime(),
  };
}

export function createKeychainStore(
  opts: KeychainOptions,
  dependencies: KeychainDependencies,
): SecretStore {
  if (dependencies.platform !== "darwin") {
    throw new Error("unsupported-platform: macOS Keychain is available only on darwin");
  }

  const metadataPath = join(opts.metaDir, "secrets-meta.json");
  const service = `bridle.${opts.appId}`;
  const now = dependencies.now ?? (() => new Date());
  const persistMetadata = dependencies.writeMetadata ?? writeMetadata;
  let mutationTail: Promise<void> = Promise.resolve();
  const reportedExpired = new Set<string>();

  function emit(event: SecretEvent): void {
    try { opts.onEvent?.(event); } catch { /* Audit observers cannot change persisted secret state. */ }
  }

  function observeStatus(key: string, entry: MetadataEntry | undefined): SecretStatus {
    const status = statusFor(entry, now());
    if (status.state === "present" && status.expired && !reportedExpired.has(key)) {
      reportedExpired.add(key);
      emit({ type: "secret.expired", key, ...(status.expiresAt ? { expiresAt: status.expiresAt } : {}) });
    }
    return status;
  }

  function validateScope(scope: SecretScope): void {
    if (scope.appId !== opts.appId) throw new Error("scope-app-mismatch");
  }

  function mutateMetadata(update: (metadata: Metadata) => void): Promise<void> {
    const mutation = mutationTail.then(async () => {
      const metadata = await readMetadata(metadataPath);
      update(metadata);
      await persistMetadata(metadataPath, metadata);
    });
    mutationTail = mutation.catch(() => undefined);
    return mutation;
  }

  return {
    async set(scope, value, setOpts) {
      validateScope(scope);
      const setAt = now();
      let expiresAt: string | undefined;
      if (setOpts?.ttlSeconds !== undefined
        && (!Number.isFinite(setOpts.ttlSeconds) || setOpts.ttlSeconds < 0)) {
        throw new Error("invalid-ttl-seconds");
      }
      if (setOpts?.ttlSeconds !== undefined) {
        const expiry = new Date(setAt.getTime() + setOpts.ttlSeconds * 1_000);
        if (Number.isNaN(expiry.getTime())) throw new Error("invalid-ttl-seconds");
        expiresAt = expiry.toISOString();
      }
      const key = secretKey(scope);
      const metadata = await readMetadata(metadataPath);
      let priorValue: string | undefined;
      if (metadata[key]) {
        const prior = await dependencies.runSecurity([
          "find-generic-password", "-w", "-s", service, "-a", scope.name,
        ]);
        if (prior.exitCode !== 0 && prior.exitCode !== 44) {
          throw new Error("security find-generic-password failed");
        }
        if (prior.exitCode === 0) priorValue = prior.stdout.replace(/\r?\n$/, "");
      }
      const result = await dependencies.runSecurity(
        ["add-generic-password", "-U", "-s", service, "-a", scope.name, "-w"],
        value,
      );
      if (result.exitCode !== 0) throw new Error("security add-generic-password failed");

      try {
        await mutateMetadata((currentMetadata) => {
          currentMetadata[key] = {
            setAt: setAt.toISOString(),
            ...(expiresAt ? { expiresAt } : {}),
          };
        });
      } catch {
        const rollback = priorValue === undefined
          ? dependencies.runSecurity(["delete-generic-password", "-s", service, "-a", scope.name])
          : dependencies.runSecurity(
            ["add-generic-password", "-U", "-s", service, "-a", scope.name, "-w"],
            priorValue,
          );
        try {
          const rollbackResult = await rollback;
          if (rollbackResult.exitCode !== 0 && !(priorValue === undefined && rollbackResult.exitCode === 44)) {
            throw new Error("rollback-failed");
          }
        } catch {
          throw new Error("secret metadata write failed; keychain rollback failed");
        }
        throw new Error("secret metadata write failed");
      }
      reportedExpired.delete(key);
      emit({ type: "secret.set", key, ...(expiresAt ? { expiresAt } : {}) });
    },

    async get(scope) {
      validateScope(scope);
      const metadata = await readMetadata(metadataPath);
      const key = secretKey(scope);
      const status = observeStatus(key, metadata[key]);
      if (status.state === "absent" || status.expired) return null;

      const result = await dependencies.runSecurity([
        "find-generic-password", "-w", "-s", service, "-a", scope.name,
      ]);
      if (result.exitCode === 44) return null;
      if (result.exitCode !== 0) throw new Error("security find-generic-password failed");
      return result.stdout.replace(/\r?\n$/, "");
    },

    async delete(scope) {
      validateScope(scope);
      await readMetadata(metadataPath);
      const result = await dependencies.runSecurity([
        "delete-generic-password", "-s", service, "-a", scope.name,
      ]);
      if (result.exitCode !== 0 && result.exitCode !== 44) {
        throw new Error("security delete-generic-password failed");
      }
      await mutateMetadata((metadata) => {
        delete metadata[secretKey(scope)];
      });
      const key = secretKey(scope);
      reportedExpired.delete(key);
      emit({ type: "secret.deleted", key });
    },

    async status(scope) {
      validateScope(scope);
      const key = secretKey(scope);
      return observeStatus(key, (await readMetadata(metadataPath))[key]);
    },
  };
}

export async function runSecurity(args: string[], stdin?: string): Promise<CommandResult> {
  const process = Bun.spawn(["security", ...args], {
    stdin: stdin === undefined ? undefined : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

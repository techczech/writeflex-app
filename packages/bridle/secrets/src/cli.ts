import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { secretKey, type SecretScope, type SecretStatus, type SecretStore } from "@bridle/contract";
import type { SecretEvent } from "./index.ts";

type CommandResult = { exitCode: number; stdout: string; stderr: string };
export type CliRunner = (args: string[], stdin?: string) => Promise<CommandResult>;
export type CliSpawn = (cliPath: string, args: string[], stdin?: string) => Promise<CommandResult>;

type MetadataEntry = { setAt: string; expiresAt?: string };
type Metadata = Record<string, MetadataEntry>;

type CliStoreOptions = {
  kind: "bws" | "op";
  appId: string;
  metaDir: string;
  cliPath: string;
  onEvent?: (event: SecretEvent) => void;
};

type MetadataWriter = (path: string, metadata: Metadata) => Promise<void>;
type CliDependencies = { run: CliRunner; now?: () => Date; writeMetadata?: MetadataWriter };

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
    return Object.keys(candidate).every((key) => key === "setAt" || key === "expiresAt")
      && isIsoTimestamp(candidate.setAt)
      && (candidate.expiresAt === undefined || isIsoTimestamp(candidate.expiresAt));
  });
}

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

export function createCliStore(opts: CliStoreOptions, dependencies: CliDependencies): SecretStore {
  const metadataPath = join(opts.metaDir, "secrets-meta.json");
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

  function validateTtl(ttlSeconds: number | undefined, setAt: Date): string | undefined {
    if (ttlSeconds === undefined) return undefined;
    if (!Number.isFinite(ttlSeconds) || ttlSeconds < 0) throw new Error("invalid-ttl-seconds");
    const expiresAt = new Date(setAt.getTime() + ttlSeconds * 1_000);
    if (Number.isNaN(expiresAt.getTime())) throw new Error("invalid-ttl-seconds");
    return expiresAt.toISOString();
  }

  function mutateMetadata(update: (metadata: Metadata) => void, attempts = 1): Promise<void> {
    const mutation = mutationTail.then(async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const metadata = await readMetadata(metadataPath);
          update(metadata);
          await persistMetadata(metadataPath, metadata);
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    });
    mutationTail = mutation.catch(() => undefined);
    return mutation;
  }

  async function command(operation: "set" | "get" | "delete", scope: SecretScope, value?: string): Promise<CommandResult> {
    let result: CommandResult;
    try {
      result = await dependencies.run([operation, secretKey(scope)], value);
    } catch {
      throw new Error(`${opts.kind} ${operation} failed`);
    }
    if (result.exitCode !== 0) throw new Error(`${opts.kind} ${operation} failed`);
    return result;
  }

  return {
    async set(scope, value, setOpts) {
      validateScope(scope);
      const setAt = now();
      const expiresAt = validateTtl(setOpts?.ttlSeconds, setAt);
      const key = secretKey(scope);
      const metadata = await readMetadata(metadataPath);
      const priorValue = metadata[key]
        ? (await command("get", scope)).stdout.replace(/\r?\n$/, "")
        : undefined;
      const remoteResult = await command("set", scope, value);
      try {
        await mutateMetadata((metadata) => {
          metadata[secretKey(scope)] = { setAt: setAt.toISOString(), ...(expiresAt ? { expiresAt } : {}) };
        });
      } catch {
        try {
          if (remoteResult.stdout === "created") await command("delete", scope);
          else if (priorValue !== undefined) await command("set", scope, priorValue);
        } catch {
          throw new Error("secret metadata write failed; remote rollback failed");
        }
        throw new Error("secret metadata write failed");
      }
      reportedExpired.delete(key);
      emit({ type: "secret.set", key, ...(expiresAt ? { expiresAt } : {}) });
    },
    async get(scope) {
      validateScope(scope);
      const key = secretKey(scope);
      const status = observeStatus(key, (await readMetadata(metadataPath))[key]);
      if (status.state === "absent" || status.expired) return null;
      const result = await command("get", scope);
      return result.stdout.replace(/\r?\n$/, "");
    },
    async delete(scope) {
      validateScope(scope);
      await readMetadata(metadataPath);
      await command("delete", scope);
      try {
        await mutateMetadata((metadata) => { delete metadata[secretKey(scope)]; }, 2);
      } catch {
        throw new Error("secret metadata write failed");
      }
      const key = secretKey(scope);
      reportedExpired.delete(key);
      emit({ type: "secret.deleted", key });
    },
    async status(scope) {
      validateScope(scope);
      let probe: CommandResult;
      try {
        probe = await dependencies.run(["--version"]);
      } catch {
        throw new Error(`${opts.kind} unavailable`);
      }
      if (probe.exitCode !== 0) throw new Error(`${opts.kind} unavailable`);
      const key = secretKey(scope);
      return observeStatus(key, (await readMetadata(metadataPath))[key]);
    },
  };
}

const spawnCli: CliSpawn = async (cliPath, args, stdin) => {
  const child = Bun.spawn([cliPath, ...args], {
    stdin: stdin === undefined ? undefined : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

type BwsSecret = { id?: string; key?: string; value?: string };

export function bwsRunner(cliPath: string): CliRunner {
  return async (args, stdin) => {
    if (args[0] === "--version") return spawnCli(cliPath, args);
    const projectId = process.env.BRIDLE_BWS_PROJECT_ID;
    if (!projectId) return { exitCode: 1, stdout: "", stderr: "missing-project" };
    const key = args[1] ?? "";
    const listed = await spawnCli(cliPath, ["secret", "list", projectId]);
    if (listed.exitCode !== 0) return listed;
    let secrets: BwsSecret[];
    try { secrets = JSON.parse(listed.stdout) as BwsSecret[]; } catch { return { exitCode: 1, stdout: "", stderr: "invalid-response" }; }
    const existing = secrets.find((secret) => secret.key === key);
    if (args[0] === "set") {
      const result = existing?.id
        ? spawnCli(cliPath, ["secret", "edit", existing.id, "--value", stdin ?? ""])
        : spawnCli(cliPath, ["secret", "create", key, stdin ?? "", projectId]);
      const completed = await result;
      return completed.exitCode === 0
        ? { ...completed, stdout: existing?.id ? "updated" : "created" }
        : completed;
    }
    if (!existing?.id) return { exitCode: 1, stdout: "", stderr: "not-found" };
    if (args[0] === "delete") return spawnCli(cliPath, ["secret", "delete", existing.id]);
    const result = await spawnCli(cliPath, ["secret", "get", existing.id]);
    if (result.exitCode !== 0) return result;
    try {
      const secret = JSON.parse(result.stdout) as BwsSecret;
      return typeof secret.value === "string"
        ? { exitCode: 0, stdout: secret.value, stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "invalid-response" };
    } catch { return { exitCode: 1, stdout: "", stderr: "invalid-response" }; }
  };
}

type OpItem = { id?: string; title?: string };

export function opRunner(cliPath: string, spawn: CliSpawn = spawnCli): CliRunner {
  return async (args, stdin) => {
    if (args[0] === "--version") return spawn(cliPath, args);
    const vault = process.env.BRIDLE_OP_VAULT;
    if (!vault) return { exitCode: 1, stdout: "", stderr: "missing-vault" };
    const title = `bridle.${args[1] ?? ""}`;
    const listed = await spawn(cliPath, ["item", "list", "--vault", vault, "--format", "json"]);
    if (listed.exitCode !== 0) return listed;
    let items: OpItem[];
    try { items = JSON.parse(listed.stdout) as OpItem[]; } catch { return { exitCode: 1, stdout: "", stderr: "invalid-response" }; }
    const existing = items.find((item) => item.title === title && typeof item.id === "string");
    if (args[0] === "get") {
      if (!existing?.id) return { exitCode: 1, stdout: "", stderr: "not-found" };
      return spawn(cliPath, ["item", "get", existing.id, "--vault", vault, "--fields", "label=password", "--reveal"]);
    }
    if (args[0] === "delete") {
      if (!existing?.id) return { exitCode: 0, stdout: "", stderr: "" };
      return spawn(cliPath, ["item", "delete", existing.id, "--vault", vault, "--archive"]);
    }
    const template = JSON.stringify({
      category: "PASSWORD",
      title,
      fields: [{ id: "password", type: "CONCEALED", purpose: "PASSWORD", label: "password", value: stdin ?? "" }],
    });
    const result = existing?.id
      ? await spawn(cliPath, ["item", "edit", existing.id, "--vault", vault], template)
      : await spawn(cliPath, ["item", "create", "--vault", vault, "-"], template);
    return result.exitCode === 0
      ? { ...result, stdout: existing?.id ? "updated" : "created" }
      : result;
  };
}

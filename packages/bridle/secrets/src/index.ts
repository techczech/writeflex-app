import type { SecretStore } from "@bridle/contract";
import { createKeychainStore, runSecurity } from "./keychain.ts";
import { bwsRunner, createCliStore, opRunner } from "./cli.ts";
import { createDevFileStore } from "./dev-file.ts";

export type SecretEvent = {
  type: "secret.set" | "secret.deleted" | "secret.expired";
  key: string;
  expiresAt?: string;
};

export function keychainStore(opts: {
  appId: string;
  metaDir: string;
  onEvent?: (event: SecretEvent) => void;
}): SecretStore {
  return createKeychainStore(opts, {
    platform: process.platform,
    runSecurity,
  });
}

export function bwsStore(opts: {
  appId: string;
  metaDir: string;
  onEvent?: (event: SecretEvent) => void;
  cliPath?: string;
}): SecretStore {
  const cliPath = opts.cliPath ?? "bws";
  return createCliStore({ ...opts, kind: "bws", cliPath }, { run: bwsRunner(cliPath) });
}

export function opStore(opts: {
  appId: string;
  metaDir: string;
  onEvent?: (event: SecretEvent) => void;
  cliPath?: string;
}): SecretStore {
  const cliPath = opts.cliPath ?? "op";
  return createCliStore({ ...opts, kind: "op", cliPath }, { run: opRunner(cliPath) });
}

export function devFileStore(opts: {
  dir: string;
  acknowledgeInsecure: true;
  onEvent?: (event: SecretEvent) => void;
}): SecretStore {
  return createDevFileStore(opts);
}

#!/usr/bin/env node
// Explicit Windows helper build; never part of the default JS build or check.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const target = "x86_64-pc-windows-msvc";
const separator = "\u001f";

/** Preserve Cargo's flag precedence, then append path-safe privacy flags. */
export function helperBuildEnvironment({ home = homedir(), checkoutRoot = resolve(packageRoot, "../.."), env = process.env } = {}) {
  // Cargo prefers the encoded variable even when explicitly empty. Legacy
  // RUSTFLAGS uses whitespace splitting, not shell quoting; retain that meaning.
  const flags = env.CARGO_ENCODED_RUSTFLAGS !== undefined
    ? (env.CARGO_ENCODED_RUSTFLAGS === "" ? [] : env.CARGO_ENCODED_RUSTFLAGS.split(separator))
    : (env.RUSTFLAGS ?? "").split(/\s+/).filter(Boolean);
  flags.push(
    `--remap-path-prefix=${home}=/bridle-home`,
    `--remap-path-prefix=${checkoutRoot}=/bridle-source`,
    "-C", "link-arg=/PDBALTPATH:%_PDB%",
  );
  return { ...env, CARGO_ENCODED_RUSTFLAGS: flags.join(separator) };
}

/** Build with argument arrays, then copy the successful executable into bin/. */
export function buildHelper({ packageRoot: root = packageRoot, home = homedir(), env = process.env, run = spawnSync } = {}) {
  const crate = join(root, "native/runner-sandbox");
  const result = run("cargo", [
    "build", "--release", "--manifest-path", join(crate, "Cargo.toml"), "--target", target,
  ], {
    cwd: root,
    env: helperBuildEnvironment({ home, checkoutRoot: resolve(root, "../.."), env }),
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`cargo build failed (exit ${result.status}, signal ${result.signal ?? "none"})`);
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const destination = join(bin, "bridle-runner-sandbox.exe");
  copyFileSync(join(crate, "target", target, "release/bridle-runner-sandbox.exe"), destination);
  return destination;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    buildHelper();
  } catch (error) {
    console.error(`build:helper failed: ${error.message}`);
    process.exitCode = 1;
  }
}

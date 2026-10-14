#!/usr/bin/env bun
/**
 * TypeScript's declaration emitter does not honor `rewriteRelativeImportExtensions`
 * (verified against typescript@6.0.3: `shouldRewriteModuleSpecifier` in
 * node_modules/typescript/lib/typescript.js excludes declaration files via
 * `!isDeclarationFileName(specifier)` — that helper backs the JS emitter's
 * specifier rewriting, and the declaration emitter has no equivalent path).
 * `tsc -p tsconfig.build.json` therefore emits `dist/*.d.ts` with untouched
 * `./foo.ts` relative specifiers, which a plain-tsc consumer under
 * `moduleResolution: NodeNext` can still resolve (TS strips the `.ts` and
 * retries as `.d.ts`), but that leaves a literal `.ts` specifier in shipped
 * declarations — the thing this script exists to remove.
 *
 * Runs after `tsc -p tsconfig.build.json`: rewrites `.ts`/`.tsx` extensions
 * in relative import/export specifiers inside `dist/**\/*.d.ts` to `.js`.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SPECIFIER_PATTERN = /((?:from|import)\s*\(?\s*["'])(\.\.?\/[^"']+?)(\.tsx?)(["'])/g;

async function fixFile(path: string): Promise<boolean> {
  const original = await readFile(path, "utf8");
  const fixed = original.replace(SPECIFIER_PATTERN, (_m, pre, spec, _ext, post) => `${pre}${spec}.js${post}`);
  if (fixed !== original) await writeFile(path, fixed, "utf8");
  return fixed !== original;
}

async function main(): Promise<void> {
  const distDir = join(import.meta.dirname, "..", "dist");
  const entries = await readdir(distDir);
  let changed = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".d.ts")) continue;
    if (await fixFile(join(distDir, entry))) changed++;
  }
  console.log(`fix-dts-extensions: rewrote .ts -> .js specifiers in ${changed} declaration file(s).`);
}

await main();

/// <reference types="bun" />

import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export interface ZoteroDataDirectoryDiscoveryOptions {
  configurationDirectory?: string;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
}

export interface ZoteroDataDirectoryDiscovery {
  path: string;
  preferenceFilePath?: string;
  source: "preference" | "fallback";
  warnings: string[];
}

export interface ProtectedZoteroDataDirectory {
  inputPath: string;
  path: string;
  source: "preference" | "fallback" | "override";
  status: "resolved" | "unresolved";
  warning?: string;
}

export interface ZoteroWriteGuardReport {
  candidatePath: string;
  protectedDirectories: ProtectedZoteroDataDirectory[];
  warnings: string[];
}

export interface ZoteroWriteGuardOptions {
  zoteroDataDirectory?: string;
}

export interface ZoteroAnnotationWriteTargetReport
  extends ZoteroWriteGuardReport {
  /**
   * Whether the target is the live Zotero database inside a protected tree, or a copy somewhere
   * else. Every test writes to a copy, so both are legitimate — and a caller that wants to know
   * which one it got can ask.
   */
  insideProtectedDirectory: boolean;
}

export interface ZoteroApplicationDiscoveryOptions {
  applicationsDirectory?: string;
}

export interface ZoteroApplication {
  name: string;
  path: string;
  version: string;
}

interface IniSection {
  name: string;
  values: Map<string, string>;
}

interface CanonicalPathResult {
  path: string;
  status: "resolved" | "unresolved";
  warning?: string;
}

function defaultConfigurationDirectory(
  homeDirectory: string,
  operatingSystem: NodeJS.Platform,
): string {
  if (operatingSystem === "darwin") {
    return join(
      homeDirectory,
      "Library",
      "Application Support",
      "Zotero",
    );
  }
  if (operatingSystem === "win32") {
    const appData = process.env.APPDATA;
    return appData
      ? join(appData, "Zotero")
      : join(homeDirectory, "AppData", "Roaming", "Zotero");
  }
  return join(homeDirectory, ".zotero", "zotero");
}

function parseIni(content: string): IniSection[] {
  const sections: IniSection[] = [];
  let current: IniSection | undefined;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) {
      continue;
    }
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      current = {
        name: sectionMatch[1]!,
        values: new Map(),
      };
      sections.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }
    current.values.set(
      line.slice(0, separatorIndex).trim(),
      line.slice(separatorIndex + 1).trim(),
    );
  }

  return sections;
}

function profilePathFromIni(
  configurationDirectory: string,
  content: string,
): string | undefined {
  const sections = parseIni(content);
  const installDefault = sections
    .find((section) => section.name.startsWith("Install"))
    ?.values.get("Default");
  if (installDefault) {
    return isAbsolute(installDefault)
      ? installDefault
      : resolve(configurationDirectory, installDefault);
  }

  const profile =
    sections.find(
      (section) =>
        section.name.startsWith("Profile") &&
        section.values.get("Default") === "1",
    ) ??
    sections.find((section) => section.name.startsWith("Profile"));
  const path = profile?.values.get("Path");
  if (!path) {
    return undefined;
  }
  return profile?.values.get("IsRelative") === "1"
    ? resolve(configurationDirectory, path)
    : resolve(path);
}

function readDataDirectoryPreference(
  preferenceFilePath: string,
): string | undefined {
  const content = readFileSync(preferenceFilePath, "utf8");
  const pattern =
    /user_pref\(\s*"extensions\.zotero\.dataDir"\s*,\s*("(?:\\.|[^"\\])*")\s*\)/g;
  let match: RegExpExecArray | null;
  let value: string | undefined;

  while ((match = pattern.exec(content)) !== null) {
    const parsed = JSON.parse(match[1]!) as unknown;
    if (typeof parsed === "string" && parsed.trim()) {
      value = parsed;
    }
  }
  return value;
}

function expandHome(path: string, homeDirectory: string): string {
  return path === "~"
    ? homeDirectory
    : path.startsWith(`~${sep}`)
      ? join(homeDirectory, path.slice(2))
      : path;
}

async function readBundleVersion(applicationPath: string): Promise<string> {
  const infoPlistPath = join(applicationPath, "Contents", "Info.plist");
  const process = Bun.spawn(
    [
      "/usr/bin/plutil",
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      "-o",
      "-",
      infoPlistPath,
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `Could not read Zotero version from ${infoPlistPath}: ${stderr.trim()}`,
    );
  }

  return stdout.trim();
}

export async function discoverZoteroApplication(
  options: ZoteroApplicationDiscoveryOptions = {},
): Promise<ZoteroApplication> {
  const applicationsDirectory =
    options.applicationsDirectory ?? "/Applications";
  const glob = new Bun.Glob("Zotero*.app");
  const applications: ZoteroApplication[] = [];

  for await (const relativePath of glob.scan({
    cwd: applicationsDirectory,
    onlyFiles: false,
  })) {
    const path = join(applicationsDirectory, relativePath);
    try {
      applications.push({
        name: basename(path),
        path,
        version: await readBundleVersion(path),
      });
    } catch {
      // One incomplete bundle must not hide a readable Zotero install.
    }
  }

  if (applications.length === 0) {
    throw new Error(
      `No readable Zotero*.app bundle was found in ${applicationsDirectory}`,
    );
  }

  const versionOrder = new Intl.Collator("en", {
    numeric: true,
    sensitivity: "base",
  });
  applications.sort((left, right) =>
    versionOrder.compare(right.version, left.version),
  );

  return applications[0]!;
}

export function discoverZoteroDataDirectory(
  options: ZoteroDataDirectoryDiscoveryOptions = {},
): ZoteroDataDirectoryDiscovery {
  const homeDirectory = options.homeDirectory ?? homedir();
  const configurationDirectory =
    options.configurationDirectory ??
    defaultConfigurationDirectory(
      homeDirectory,
      options.platform ?? platform(),
    );
  const warnings: string[] = [];
  const profilesIniPath = join(configurationDirectory, "profiles.ini");

  try {
    const profilePath = profilePathFromIni(
      configurationDirectory,
      readFileSync(profilesIniPath, "utf8"),
    );
    if (profilePath) {
      const preferenceFilePath = join(profilePath, "prefs.js");
      try {
        const preference = readDataDirectoryPreference(preferenceFilePath);
        if (preference) {
          return {
            path: resolve(expandHome(preference, homeDirectory)),
            preferenceFilePath,
            source: "preference",
            warnings,
          };
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          warnings.push(
            `Could not read Zotero preferences at ${preferenceFilePath}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      warnings.push(
        `Could not read Zotero profile registry at ${profilesIniPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    path: join(homeDirectory, "Zotero"),
    source: "fallback",
    warnings,
  };
}

function canonicalPath(path: string): CanonicalPathResult {
  let existingPath = resolve(path);
  const missingParts: string[] = [];

  while (true) {
    try {
      lstatSync(existingPath);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        return {
          path: resolve(path),
          status: "unresolved",
          warning:
            error instanceof Error ? error.message : String(error),
        };
      }
      const parent = dirname(existingPath);
      if (parent === existingPath) {
        break;
      }
      missingParts.unshift(existingPath.slice(parent.length + 1));
      existingPath = parent;
    }
  }

  try {
    return {
      path: resolve(realpathSync.native(existingPath), ...missingParts),
      status: "resolved",
    };
  } catch (error) {
    return {
      path: resolve(path),
      status: "unresolved",
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}

function pathIsInside(directory: string, candidate: string): boolean {
  const foldedDirectory = directory.toLocaleLowerCase("en");
  const foldedCandidate = candidate.toLocaleLowerCase("en");
  const relativePath = relative(foldedDirectory, foldedCandidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) &&
      relativePath !== ".." &&
      !isAbsolute(relativePath))
  );
}

interface ResolvedGuard {
  candidate: CanonicalPathResult;
  report: ZoteroWriteGuardReport;
  /** The protected trees the candidate is inside, resolved and confirmed. */
  containing: ProtectedZoteroDataDirectory[];
}

function resolveGuard(
  candidatePath: string,
  options: ZoteroWriteGuardOptions,
): ResolvedGuard {
  const discovery = discoverZoteroDataDirectory();
  const protectedInputs: Array<{
    path: string;
    source: ProtectedZoteroDataDirectory["source"];
  }> = [
    {
      path: discovery.path,
      source: discovery.source,
    },
  ];
  if (options.zoteroDataDirectory) {
    protectedInputs.push({
      path: options.zoteroDataDirectory,
      source: "override",
    });
  }

  const candidate = canonicalPath(candidatePath);
  const protectedDirectories = protectedInputs.map(
    ({ path, source }): ProtectedZoteroDataDirectory => {
      const canonical = canonicalPath(path);
      return {
        inputPath: path,
        path: canonical.path,
        source,
        status: canonical.status,
        ...(canonical.warning ? { warning: canonical.warning } : {}),
      };
    },
  );
  const warnings = [
    ...discovery.warnings,
    ...protectedDirectories.flatMap((directory) =>
      directory.warning
        ? [
            `Could not resolve protected Zotero data directory ${directory.inputPath}: ${directory.warning}`,
          ]
        : [],
    ),
  ];

  return {
    candidate,
    containing: protectedDirectories.filter(
      (directory) =>
        directory.status === "resolved" &&
        pathIsInside(directory.path, candidate.path),
    ),
    report: {
      candidatePath: candidate.path,
      protectedDirectories,
      warnings,
    },
  };
}

export function assertNotInZoteroDataDirectory(
  candidatePath: string,
  options: ZoteroWriteGuardOptions = {},
): ZoteroWriteGuardReport {
  const { containing, report } = resolveGuard(candidatePath, options);

  for (const directory of containing) {
    throw new Error(
      `Write path cannot be inside the Zotero data directory protected at ${directory.path}: ${candidatePath}`,
    );
  }

  return report;
}

/** The one file inside Zotero's data directory ReadFlex may open for writing (ADR-0031 §5). */
const WRITABLE_ZOTERO_DATABASE_FILENAME = "zotero.sqlite";

/**
 * **The single named exception to `assertNotInZoteroDataDirectory` (ADR-0031, decision 5.)**
 *
 * ADR-0012 made the guard absolute because a guard with an off-switch is not a guard. ADR-0031 then
 * needed exactly one write inside that tree — the annotation insert into `zotero.sqlite` — so the
 * exception is a function with its own name rather than a flag the general guard accepts. Nothing
 * else can reach it by passing an option, and a reviewer finds every use of it by grepping one name.
 *
 * What it permits, and nothing more:
 *
 * - `<Zotero data directory>/zotero.sqlite` itself — the library ADR-0031 writes annotations into.
 * - Any path entirely **outside** every protected tree, which is how every test writes to a copy.
 *
 * What it still refuses, exactly as the general guard would: `zotero.sqlite-wal`, `-shm`, the
 * `.bak` files, `better-bibtex.sqlite`, anything under `storage/`, and any nested `zotero.sqlite`
 * in a subdirectory — the file must be a direct child of the protected directory.
 */
export function assertZoteroAnnotationWriteTarget(
  candidatePath: string,
  options: ZoteroWriteGuardOptions = {},
): ZoteroAnnotationWriteTargetReport {
  const { candidate, containing, report } = resolveGuard(
    candidatePath,
    options,
  );

  for (const directory of containing) {
    // Folded the same way `pathIsInside` folds, so a case-insensitive volume cannot smuggle
    // `ZOTERO.SQLITE-WAL` past a case-sensitive comparison.
    const isTheLibraryDatabase =
      dirname(candidate.path).toLocaleLowerCase("en") ===
        directory.path.toLocaleLowerCase("en") &&
      basename(candidate.path).toLocaleLowerCase("en") ===
        WRITABLE_ZOTERO_DATABASE_FILENAME;
    if (!isTheLibraryDatabase) {
      throw new Error(
        `The only file ReadFlex may write inside the Zotero data directory protected at ${directory.path} is ${WRITABLE_ZOTERO_DATABASE_FILENAME}: ${candidatePath}`,
      );
    }
  }

  return {
    ...report,
    insideProtectedDirectory: containing.length > 0,
  };
}

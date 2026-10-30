// Shared content/restore rules. Restore may follow checked in-root parent links;
// content calls and structural sources never do.
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, parse, relative, sep } from "node:path";

export const TRASH_FOLDER = ".bridle-trash";
const TURN_ID = /^[a-zA-Z0-9_-]{1,128}$/;
export const validTurnId = (id: unknown): id is string => typeof id === "string" && TURN_ID.test(id);
export const isControlName = (name: string): boolean => [".git", ".bridle", TRASH_FOLDER].includes(name.toLowerCase());
export const dotNameRefused = (name: string, index: number, trash = false): boolean =>
  (isControlName(name) || name.startsWith(".")) && !(trash && index === 0 && name === TRASH_FOLDER);

export function workspacePathRefusal(base: string, target: string, what: string, options: {
  allowRoot?: boolean; trashSource?: boolean; trashTraversal?: boolean;
} = {}): string | null {
  const rel = relative(base, target);
  if (rel === "") return options.allowRoot ? null : `${what} is the root itself`;
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return `${what} is outside the root`;
  const segments = rel.split(sep);
  const managed = segments.length === 3 && segments[0] === TRASH_FOLDER
    && validTurnId(segments[1]) && /^[a-f0-9]{24}-[^.]/.test(segments[2]!);
  const traversal = options.trashTraversal && segments[0] === TRASH_FOLDER
    && (segments.length === 1 || (segments.length === 2 && validTurnId(segments[1])) || managed);
  const trash = Boolean((options.trashSource && managed) || traversal);
  if (segments.some((name, index) => dotNameRefused(name, index, trash))) return `${what} is under a dot-folder or is a dot-file`;
  return null;
}

export function linkRefusal(isLink: boolean, kind: "content" | "trash-source" | "move-source" | "restore-parent"): string | null {
  if (!isLink || kind === "restore-parent") return null;
  if (kind === "trash-source") return "a Trash source is reached through a link";
  if (kind === "move-source") return "an undo step would move a link";
  return "Refused path through a symlink.";
}

/** Walk links before interpreting traversal; absent suffixes cannot contain traversal. */
function physicalPath(path: string): string | undefined {
  // Joining text preserves `..` until the physical parent has been established.
  const absolute = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
  const components = (value: string) => value.split(sep === "\\" ? /[\\/]/ : /\//);
  let current = parse(absolute).root;
  const remaining = components(absolute.slice(current.length));
  let hops = 0;
  while (remaining.length > 0) {
    const component = remaining.shift()!;
    if (component === "" || component === ".") continue;
    if (component === "..") {
      current = dirname(current);
      continue;
    }
    const candidate = `${current}${current.endsWith(sep) ? "" : sep}${component}`;
    let stat;
    try { stat = lstatSync(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      // Keep nested creation paths compatible. No links can exist below the
      // first missing component, but traversal there cannot be proven safe.
      if (remaining.includes("..")) return undefined;
      return [candidate, ...remaining.filter((part) => part !== "" && part !== ".")].join(sep);
    }
    if (stat.isSymbolicLink()) {
      if (++hops > 40) return undefined;
      const target = readlinkSync(candidate);
      const root = isAbsolute(target) ? parse(target).root : "";
      if (root) current = root;
      remaining.unshift(...components(target.slice(root.length)));
    } else {
      if (remaining.length > 0 && !stat.isDirectory()) return undefined;
      current = candidate;
    }
  }
  return current;
}

/** Unresolvable roots or targets and physical escapes count as outside. */
export function physicalWorkspacePath(root: string, path: string): {
  canonicalRoot: string;
} | undefined {
  try {
    const canonicalRoot = realpathSync(root);
    const physical = physicalPath(path);
    if (physical === undefined) return undefined;
    const rel = relative(canonicalRoot, physical);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return undefined;
    return { canonicalRoot };
  } catch {
    // Permission errors, link loops and filesystem races cannot establish containment.
    return undefined;
  }
}

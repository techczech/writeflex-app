// Internal checked-files adapter for the folder-confined content tools.
import { PATH_SHOWN_LIMIT, UNSHOWABLE } from "./shown-text.ts";
import { realpathSync, type BigIntStats } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isMissing, openLastName, realFolderAt, sameFile, type FileIdentity } from "./checked-files.ts";
import { workspacePathRefusal, isControlName, linkRefusal } from "./workspace-containment.ts";

class ContentPathRefused extends Error {}
export class ContentReadLimitError extends Error {
  constructor(readonly bytesRead = 0) { super("File exceeds the search size limit."); }
}
export class ContentNonTextError extends Error {
  constructor(readonly bytesRead: number) { super("Only UTF-8 text files can be read or edited."); }
}

// Internal filesystem seam: tests can model multiple spellings of one folder on
// any filesystem without weakening the production checks.
type ContentPathIO = {
  stat?: (path: string) => Promise<BigIntStats>;
  realpath?: (path: string) => string;
  openFile?: typeof openLastName;
};

function physicalPath(path: string, canonicalise: (path: string) => string = realpathSync.native): string {
  const suffix: string[] = [];
  let cursor = resolve(path);
  for (;;) {
    try { return join(canonicalise(cursor), ...suffix); }
    catch (error) {
      if (!isMissing(error) || dirname(cursor) === cursor) throw error;
      suffix.unshift(basename(cursor));
      cursor = dirname(cursor);
    }
  }
}

export function contentPaths(workspaceRoot: string, snapshotDir?: string, io: ContentPathIO = {}) {
  if (!isAbsolute(workspaceRoot)) throw new Error("Content tools require an absolute workspaceRoot.");
  const givenRoot = resolve(workspaceRoot);
  const storePath = resolve(snapshotDir ?? join(givenRoot, ".bridle"));
  const storeRelative = relative(physicalPath(givenRoot, io.realpath), physicalPath(storePath, io.realpath));
  if (storeRelative === "" || (!isAbsolute(storeRelative) && storeRelative !== ".." && !storeRelative.startsWith(`..${sep}`)
    && !storeRelative.split(sep)[0]!.startsWith("."))) {
    throw new Error("snapshotDir inside the workspace root must have a dot-name as its first segment.");
  }
  const statAt = io.stat ?? ((path: string) => lstat(path, { bigint: true }));
  const openFile = io.openFile ?? openLastName;
  const storeIdentities: FileIdentity[] = [];
  const refuseStore = async (identity: FileIdentity) => {
    const store = await statAt(storePath).catch((error: unknown) => { if (isMissing(error)) return null; throw error; });
    if (store) {
      if (!store.isDirectory()) throw new ContentPathRefused("The snapshot store is not a real folder.");
      if (!storeIdentities.some((known) => sameFile(known, store))) storeIdentities.push({ dev: store.dev, ino: store.ino });
    }
    if (storeIdentities.some((known) => sameFile(known, identity))) throw new ContentPathRefused("Refused path in the snapshot store.");
  };
  let anchor: Promise<{ root: string; identity: FileIdentity }> | undefined;
  const rootState = () => anchor ??= (async () => {
    const named = await statAt(givenRoot);
    if (!named.isDirectory()) throw new ContentPathRefused("workspaceRoot must be a real folder, not a symlink.");
    // fs/promises.realpath already uses the native realpath binding.
    const root = await realpath(givenRoot);
    const identity = await realFolderAt(root, "the content workspace");
    if (!identity || !sameFile(named, identity)) throw new ContentPathRefused("The workspace changed while it was checked.");
    await refuseStore(identity);
    return { root, identity };
  })();
  const lexical = (path: string, allowRoot = false, trash = false): string => {
    if (typeof path !== "string" || UNSHOWABLE.test(path) || /[\\]/.test(path)
      || path.split("/").some((part) => part === ".." || part.endsWith(" ") || part.endsWith(".") || part.includes(":"))) {
      throw new ContentPathRefused("Refused path: use plain paths without '..', backslashes or control characters.");
    }
    const absolute = resolve(givenRoot, path);
    if (absolute.length > PATH_SHOWN_LIMIT) throw new ContentPathRefused("Refused path longer than the restore store permits.");
    const refused = workspacePathRefusal(givenRoot, absolute, "the path", { allowRoot, trashTraversal: trash });
    if (refused) throw new ContentPathRefused(refused);
    return absolute;
  };
  const check = async (path: string, options: { allowRoot?: boolean; missing?: boolean; trash?: boolean } = {}) => {
    const given = lexical(path, options.allowRoot, options.trash);
    const { root, identity } = await rootState();
    const stillGiven = await statAt(givenRoot);
    const stillRoot = await realFolderAt(root, "the content workspace");
    if (!stillGiven.isDirectory() || !stillRoot || !sameFile(identity, stillGiven) || !sameFile(identity, stillRoot)) {
      throw new ContentPathRefused("The workspace folder was replaced.");
    }
    await refuseStore(stillRoot);
    const absolute = join(root, relative(givenRoot, given));
    const parents: Array<{ path: string; identity: FileIdentity }> = [{ path: root, identity }];
    const parts = relative(root, absolute).split(sep).filter(Boolean);
    let current = root;
    let stat: BigIntStats | null = stillGiven;
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]!);
      const standing = await statAt(current).catch((error: unknown) => {
        if (isMissing(error) && options.missing && index === parts.length - 1) return null;
        throw error;
      });
      if (standing === null) return { absolute, stat: null, parents };
      const linked = linkRefusal(standing.isSymbolicLink(), "content");
      if (linked) throw new ContentPathRefused(linked);
      if (standing.isDirectory()) await refuseStore(standing);
      if (standing.isFile() && standing.nlink !== 1n) throw new ContentPathRefused("Refused hard-linked file.");
      if (!standing.isFile() && !standing.isDirectory()) throw new ContentPathRefused("Refused path that is not a regular file or folder.");
      if (index < parts.length - 1) {
        const identity = await realFolderAt(current, "a content folder");
        if (!identity || !sameFile(identity, standing)) throw new ContentPathRefused("A content folder changed.");
        parents.push({ path: current, identity });
      }
      stat = standing;
    }
    return { absolute, stat, parents };
  };
  const confirm = async (parents: Array<{ path: string; identity: FileIdentity }>) => {
    for (const parent of parents) {
      const named = await statAt(parent.path);
      await refuseStore(named);
      const now = await realFolderAt(parent.path, "a content folder");
      if (!now || !sameFile(now, parent.identity) || !sameFile(named, parent.identity)) throw new ContentPathRefused("A checked content folder was replaced.");
    }
  };
  const readMeasured = async (path: string, maxBytes?: number): Promise<{ text: string; bytesRead: number }> => {
    const target = await check(path);
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) throw new Error("Invalid read size limit.");
    if (maxBytes !== undefined && target.stat!.size > BigInt(maxBytes)) throw new ContentReadLimitError();
    const { handle } = await openFile(target.absolute, "read", { oneName: true });
    try {
      await confirm(target.parents);
      let bytes: Buffer;
      if (maxBytes === undefined) bytes = await handle.readFile();
      else {
        if ((await handle.stat()).size > maxBytes) throw new ContentReadLimitError();
        const chunks: Buffer[] = [];
        let size = 0;
        while (size < maxBytes) {
          const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - size));
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, size);
          if (!bytesRead) break;
          chunks.push(chunk.subarray(0, bytesRead));
          size += bytesRead;
        }
        if ((await handle.stat()).size > maxBytes) throw new ContentReadLimitError(size);
        bytes = Buffer.concat(chunks, size);
      }
      if (bytes.includes(0)) throw new ContentNonTextError(bytes.length);
      try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), bytesRead: bytes.length }; }
      catch { throw new ContentNonTextError(bytes.length); }
    } finally { await handle.close(); }
  };
  const read = async (path: string, maxBytes?: number) => (await readMeasured(path, maxBytes)).text;
  const entries = async (path = "", structural = false, limit = 10_000) => {
    const base = await check(path, { allowRoot: true });
    if (!base.stat?.isDirectory()) throw new Error("Expected a folder.");
    const result: Array<{ path: string; kind: "file" | "folder" }> = [];
    let truncated = false;
    let visited = 0;
    const walk = async (folder: string) => {
      for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (structural && ++visited > limit) throw new Error(`Content tree exceeds ${limit} entries; structural operation refused.`);
        if (result.length >= limit) {
          if (structural) throw new Error(`Content tree exceeds ${limit} entries; structural operation refused.`);
          truncated = true;
          return;
        }
        const absolute = join(folder, entry.name);
        const given = join(givenRoot, relative((await rootState()).root, absolute));
        try {
          if (structural && isControlName(entry.name)) throw new ContentPathRefused("Refused folder containing control metadata.");
          if (structural && entry.name.startsWith(".") && entry.isFile()) {
            const stat = await statAt(absolute);
            if (stat.nlink !== 1n) throw new ContentPathRefused("Refused hard-linked file.");
            continue;
          }
          const target = await check(given);
          const kind = target.stat!.isDirectory() ? "folder" : "file";
          result.push({ path: relative(givenRoot, given), kind });
          if (kind === "folder") await walk(absolute);
          if (truncated) return;
        } catch (error) {
          if (structural || !(error instanceof ContentPathRefused)) throw error;
        }
      }
    };
    await walk(base.absolute);
    return { entries: result, truncated };
  };
  return { lexical, check, confirm, read, readMeasured, entries };
}

import { TRASH_FOLDER, validTurnId } from "./workspace-containment.ts";
import { createHash } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { Type } from "typebox";
import { makeRealFolder, openLastName, sameFile } from "./checked-files.ts";
import { contentPaths, ContentNonTextError, ContentReadLimitError } from "./content-paths.ts";
import type { Capability, CapabilityContext } from "./types.ts";

type ContentEdit = { path: string; operation: string; oldText?: string; newText?: string; line?: number; text?: string; content?: string };

export type ContentToolsOptions = {
  workspaceRoot: string;
  /** Host-owned current turn identity, used verbatim as one safe folder name. */
  turnId: () => string;
  /** Required when the app places its snapshot store outside the default .bridle folder. */
  snapshotDir?: string;
  /** Search/list bounds. Defaults: 2 MiB per file, 20 MiB total, 1000 results, 10000 tree entries. */
  limits?: { searchFileBytes?: number; searchTotalBytes?: number; searchResults?: number; treeEntries?: number };
  /** App-owned Trash dispatch: move source to this contained, undoable destination. */
  trash?: (source: string, destination: string) => Promise<void>;
};

/** Opt-in folder tools. All writes use checked files and the executor's existing undo seam. */
export function createContentTools(options: ContentToolsOptions): Capability[] {
  const paths = contentPaths(options.workspaceRoot, options.snapshotDir);
  const limits = { searchFileBytes: 2 * 1024 * 1024, searchTotalBytes: 20 * 1024 * 1024,
    searchResults: 1000, treeEntries: 10_000, ...options.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid content limit: ${name}.`);
  }
  const pathSchema = Type.Object({ path: Type.String() });
  const confirmTouched = (ctx: CapabilityContext, actual: string[]) => {
    const resolved = ctx.resolvedTouchedPaths;
    if (resolved?.length && (resolved.length !== actual.length || actual.some((path) => !resolved.includes(path)))) {
      throw new Error("The write targets differ from the executor's frozen touched paths.");
    }
  };
  const touched = async ({ path }: { path: string }) => [(await paths.check(path, { missing: true })).absolute];
  const trashDestinations = new WeakMap<object, string>();
  const trashPath = (input: { path: string }) => {
    const saved = trashDestinations.get(input);
    if (saved) return saved;
    const path = input.path;
    const turnId = options.turnId();
    if (!validTurnId(turnId)) throw new Error("Invalid turn id for Trash.");
    const source = paths.lexical(path);
    const key = createHash("sha256").update(source).digest("hex").slice(0, 24);
    const destination = join(options.workspaceRoot, TRASH_FOLDER, turnId, `${key}-${basename(source)}`);
    trashDestinations.set(input, destination);
    return destination;
  };
  const structural = async (path: string) => {
    const target = await paths.check(path);
    if (target.stat?.isDirectory()) await paths.entries(path, true);
    return target;
  };
  const renderEdit = async (input: ContentEdit) => {
    const before = await paths.read(input.path);
    let after: string;
    if (input.operation === "write" && typeof input.content === "string") after = input.content;
    else if (input.operation === "replace" && typeof input.oldText === "string" && input.oldText.length > 0 && typeof input.newText === "string") {
      const first = before.indexOf(input.oldText);
      if (first === -1 || before.indexOf(input.oldText, first + 1) !== -1) throw new Error("Replacement requires exactly one exact match.");
      after = before.slice(0, first) + input.newText + before.slice(first + input.oldText.length);
    } else if (input.operation === "insert" && Number.isSafeInteger(input.line) && typeof input.text === "string") {
      const lines = before.split("\n");
      if (input.line! < 1 || input.line! > lines.length + 1) throw new Error("Invalid insertion line.");
      const offset = input.line! > lines.length ? before.length : lines.slice(0, input.line! - 1).reduce((sum, line) => sum + line.length + 1, 0);
      after = before.slice(0, offset) + input.text + before.slice(offset);
    } else throw new Error("Invalid edit operation.");
    return { before, after };
  };
  return [
    {
      name: "content.search", description: "Search text literally across workspace files, returning paths and line numbers.", risk: "read",
      parameters: Type.Object({ query: Type.String({ minLength: 1 }), path: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: limits.searchResults })) }),
      execute: async ({ query, path = "", limit = Math.min(100, limits.searchResults) }: { query: string; path?: string; limit?: number }) => {
        if (typeof query !== "string" || !query || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid search query or limit.");
        limit = Math.min(limit, limits.searchResults);
        const listing = await paths.entries(path, false, limits.treeEntries);
        const files = listing.entries.filter((entry) => entry.kind === "file");
        const matches: Array<{ path: string; line: number; text: string }> = [];
        let truncated = listing.truncated;
        let skippedFiles = 0;
        let scannedBytes = 0;
        const result = () => {
          const details = { matches, truncated, skippedFiles, scannedBytes };
          return { text: JSON.stringify(details), details };
        };
        for (const [fileIndex, entry] of files.entries()) {
          const target = await paths.check(entry.path);
          const budget = Math.min(limits.searchFileBytes, limits.searchTotalBytes - scannedBytes);
          if (target.stat!.size > BigInt(budget)) { skippedFiles++; truncated = true; continue; }
          let text: string;
          try {
            const read = await paths.readMeasured(entry.path, budget);
            text = read.text;
            scannedBytes += read.bytesRead;
          } catch (error) {
            if (!(error instanceof ContentNonTextError) && !(error instanceof ContentReadLimitError)) throw error;
            scannedBytes += error.bytesRead;
            skippedFiles++;
            truncated = true;
            continue;
          }
          for (const [index, line] of text.split("\n").entries()) {
            if (!line.includes(query)) continue;
            if (matches.length >= limit) {
              truncated = true;
              skippedFiles += files.length - fileIndex - 1;
              return result();
            }
            matches.push({ path: entry.path, line: index + 1, text: line });
          }
        }
        return result();
      },
    },
    {
      name: "content.list_tree", description: "List the workspace tree without following links or including control folders.", risk: "read",
      parameters: Type.Object({ path: Type.Optional(Type.String()) }),
      execute: async ({ path = "" }: { path?: string }) => {
        const entries = await paths.entries(path, false, limits.treeEntries);
        return { text: JSON.stringify(entries), details: entries };
      },
    },
    {
      name: "content.read_file", description: "Read a UTF-8 text file, optionally by inclusive, one-based line range.", risk: "read",
      parameters: Type.Object({ path: Type.String(), startLine: Type.Optional(Type.Integer({ minimum: 1 })), endLine: Type.Optional(Type.Integer({ minimum: 1 })) }),
      execute: async ({ path, startLine = 1, endLine }: { path: string; startLine?: number; endLine?: number }) => {
        if (!Number.isSafeInteger(startLine) || startLine < 1 || (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < startLine))) throw new Error("Invalid line range.");
        const text = await paths.read(path);
        return { text: startLine === 1 && endLine === undefined ? text : text.split("\n").slice(startLine - 1, endLine).join("\n") };
      },
    },
    {
      name: "content.create_file", description: "Create a text file without overwriting an existing path. Its parent folder must exist.", risk: "write",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }), touchedPaths: touched,
      renderUndo: ({ path }: { path: string }) => [{ do: "remove", path: paths.lexical(path) }],
      execute: async ({ path, content }: { path: string; content: string }, ctx) => {
        if (typeof content !== "string") throw new Error("File content must be text.");
        const target = await paths.check(path, { missing: true });
        confirmTouched(ctx, [target.absolute]);
        const { handle } = await openLastName(target.absolute, "create", { oneName: true });
        try { await paths.confirm(target.parents); await handle.writeFile(content, "utf8"); } finally { await handle.close(); }
        return { text: `Created ${path}` };
      },
    },
    {
      name: "content.create_folder", description: "Create one new folder. Its parent must exist.", risk: "write",
      parameters: pathSchema, touchedPaths: touched,
      renderUndo: ({ path }: { path: string }) => [{ do: "remove", path: paths.lexical(path) }],
      execute: async ({ path }: { path: string }, ctx) => {
        const target = await paths.check(path, { missing: true });
        confirmTouched(ctx, [target.absolute]);
        if (target.stat) throw new Error("Destination already exists.");
        await paths.confirm(target.parents);
        await mkdir(target.absolute);
        return { text: `Created folder ${path}` };
      },
    },
    {
      name: "content.edit_file", description: "Edit a text file: replace one exact match, insert text before a one-based line, or write the whole file.", risk: "write",
      parameters: Type.Object({
        path: Type.String(), operation: Type.Union([Type.Literal("replace"), Type.Literal("insert"), Type.Literal("write")]),
        oldText: Type.Optional(Type.String({ minLength: 1 })), newText: Type.Optional(Type.String()),
        line: Type.Optional(Type.Integer({ minimum: 1 })), text: Type.Optional(Type.String()), content: Type.Optional(Type.String()),
      }), touchedPaths: touched,
      validateStage: async (input: ContentEdit) => {
        try { await renderEdit(input); return { decision: "pass" }; }
        catch (error) { return { decision: "deny", reason: { code: "content.invalid_edit", message: error instanceof Error ? error.message : String(error) } }; }
      },
      execute: async (input: ContentEdit, ctx) => {
        const { before, after } = await renderEdit(input);
        const target = await paths.check(input.path);
        confirmTouched(ctx, [target.absolute]);
        const { handle } = await openLastName(target.absolute, "read", { oneName: true });
        try {
          if (await handle.readFile("utf8") !== before) throw new Error("File changed during the edit.");
        } finally { await handle.close(); }
        const opened = await openLastName(target.absolute, "rewrite", { oneName: true });
        try {
          await paths.confirm(target.parents);
          if (!target.stat || !sameFile(target.stat, opened.identity)) throw new Error("File was replaced during the edit.");
          await opened.handle.truncate(0);
          await opened.handle.writeFile(after, "utf8");
        } finally { await opened.handle.close(); }
        return { text: `Edited ${input.path}` };
      },
    },
    {
      name: "content.move", description: "Move or rename a file or folder inside the workspace without overwriting. Leaving the folder is refused, not asked.", risk: "write",
      parameters: Type.Object({ path: Type.String(), toPath: Type.String() }),
      touchedPaths: async ({ path, toPath }: { path: string; toPath: string }) => {
        const source = await structural(path);
        const destination = await paths.check(toPath, { missing: true });
        return [source.absolute, destination.absolute];
      },
      renderUndo: ({ path, toPath }: { path: string; toPath: string }) => [{ do: "rename", from: paths.lexical(toPath), to: paths.lexical(path) }],
      execute: async ({ path, toPath }: { path: string; toPath: string }, ctx) => {
        const source = await structural(path);
        const destination = await paths.check(toPath, { missing: true });
        confirmTouched(ctx, [source.absolute, destination.absolute]);
        if (destination.stat) throw new Error("Destination already exists.");
        const rel = relative(source.absolute, destination.absolute);
        if (source.stat?.isDirectory() && rel !== ".." && !rel.startsWith("../")) throw new Error("Cannot move a folder into itself.");
        await paths.confirm([...source.parents, ...destination.parents]);
        await rename(source.absolute, destination.absolute);
        return { text: `Moved ${path} to ${toPath}` };
      },
    },
    {
      name: "content.trash", description: "Move a file or folder to the workspace Trash with an undo; always requires approval.", risk: "destructive", asks: true,
      parameters: pathSchema,
      touchedPaths: async (input: { path: string }) => {
        const source = await structural(input.path);
        return [source.absolute, trashPath(input)];
      },
      renderUndo: (input: { path: string }) => [{ do: "rename", from: trashPath(input), to: paths.lexical(input.path) }],
      execute: async (input: { path: string }, ctx) => {
        const { path } = input;
        const source = await structural(path);
        const destinationPath = trashPath(input);
        confirmTouched(ctx, [source.absolute, destinationPath]);
        // Each folder is created and checked on its own using the snapshot store's primitives.
        const trashRoot = join(options.workspaceRoot, TRASH_FOLDER);
        await paths.confirm(source.parents);
        const realRoot = (await paths.check("", { allowRoot: true })).absolute;
        await makeRealFolder(join(realRoot, TRASH_FOLDER), "the content Trash");
        await paths.check(trashRoot, { trash: true });
        await makeRealFolder(join(realRoot, relative(options.workspaceRoot, dirname(destinationPath))), "the turn's content Trash");
        const destination = await paths.check(destinationPath, { missing: true, trash: true });
        if (destination.stat) throw new Error("This path already has a Trash entry for the turn.");
        await paths.confirm([...source.parents, ...destination.parents]);
        await (options.trash ?? rename)(source.absolute, destination.absolute);
        return { text: `Moved ${path} to Trash`, details: { path: destinationPath } };
      },
    },
  ];
}

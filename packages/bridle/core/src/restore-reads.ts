// What the restore plan (restore-plan.ts) reads from the disk and the store, kept
// for both runs of its model, and the refusal a doubt raises. Internal: absent
// from the package barrel.
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Bounds of a plan. `movedFolderEntries`: most entries one plan will look through
 *  below the folders its undo steps move; a restore that needs more is refused.
 *  An object so that tests can lower it. */
export const restorePlanLimits = { movedFolderEntries: 10_000 };

/** A doubt: the record at hand, and so the whole Restore Point, is refused. */
export class Refuse extends Error {
  constructor(reason: string, public path?: unknown, readonly also?: unknown) {
    super(reason);
  }
}
export const refuse = (reason: string, path?: unknown, also?: unknown): never => {
  throw new Refuse(reason, path, also);
};

/** Two names with different keys are two files on every disk this store meets.
 *  Two different names with one key may be one file on some disk: not decided here. */
export const foldKey = (name: string): string =>
  name.normalize("NFKD").toUpperCase().toLowerCase().normalize("NFKD").replace(/[. ]+$/u, "");

/** Disk reads that do not depend on the model, kept for both runs. */
export class Reads {
  private listings = new Map<string, string[]>();
  private movableAnswers = new Map<string, string | null>();
  private objects = new Map<string, Buffer | { refusal: string }>();
  private budget = restorePlanLimits.movedFolderEntries;
  constructor(private view: {
    storeDir?: string;
    readObject(hash: unknown): Promise<Buffer | { refusal: string }>;
  }) {}

  async listing(folder: string): Promise<string[]> {
    let names = this.listings.get(folder);
    if (!names) {
      names = await readdir(folder).catch(() => refuse("its folder cannot be listed"));
      this.listings.set(folder, names);
    }
    return names;
  }

  /** How the disk spells the entry that `name` reaches in `folder`. */
  async spelling(folder: string, name: string, identity: { dev: bigint; ino: bigint }): Promise<string> {
    const names = await this.listing(folder);
    if (names.includes(name)) return name;
    const key = foldKey(name);
    for (const candidate of names) {
      if (foldKey(candidate) !== key) continue;
      const standing = await lstat(join(folder, candidate), { bigint: true }).catch(() => null);
      if (standing && standing.dev === identity.dev && standing.ino === identity.ino) return candidate;
    }
    return refuse("how the disk spells its name cannot be established");
  }

  /**
   * Why the folder at `folder` may not be moved back, or null. Links are not followed.
   *
   * The journal is hostile, so a move it asks for is held to what an ordinary
   * turn does. Moving a folder back relocates what is in it and changes no byte,
   * so dot-named regular files (a `.DS_Store` that Finder writes into every
   * folder it shows, a `.gitkeep`) travel with their folder: they are not read,
   * rewritten or reported, and are still never a target of their own. A
   * dot-named folder such as `.git` is refused, because relocating it breaks what
   * points at it and nothing in an ordinary turn does that; so are a dot-named
   * link, anything that is not a regular file, a folder or a link (a socket, a
   * pipe, a device), and a folder with more entries than the bound.
   */
  async movable(folder: string): Promise<string | null> {
    if (this.movableAnswers.has(folder)) return this.movableAnswers.get(folder)!;
    const answer = await this.lookThrough(folder);
    this.movableAnswers.set(folder, answer);
    return answer;
  }

  private async lookThrough(folder: string): Promise<string | null> {
    const queue = [folder];
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (current === this.view.storeDir) return "an undo step would move the snapshot store";
      const entries = await readdir(current, { withFileTypes: true }).catch(() => null);
      if (entries === null) return "an undo step would move a folder that cannot be listed";
      for (const entry of entries) {
        this.budget -= 1;
        if (this.budget < 0) {
          return "an undo step would move a folder holding more entries than a restore will look through";
        }
        const dotNamed = entry.name.startsWith(".");
        if (entry.isDirectory()) {
          if (dotNamed) return "an undo step would move a folder that holds a dot-folder";
          queue.push(join(current, entry.name));
        } else if (entry.isSymbolicLink()) {
          if (dotNamed) return "an undo step would move a folder that holds a dot-named link";
        } else if (!entry.isFile()) {
          return "an undo step would move a folder that holds something that is not a file, a folder or a link";
        }
      }
    }
    return null;
  }

  async object(hash: unknown): Promise<Buffer> {
    const key = typeof hash === "string" ? hash : "";
    const read = this.objects.get(key) ?? await this.view.readObject(hash);
    if (typeof hash === "string") this.objects.set(key, read);
    return Buffer.isBuffer(read) ? read : refuse(read.refusal);
  }
}

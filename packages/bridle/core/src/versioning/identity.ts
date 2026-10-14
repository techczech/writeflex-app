import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Workspace identity (PRD Decision 3, ticket T3). A hidden marker file inside the
 * folder holds a random opaque ID — NOT the history, just the key. The version
 * store keys off this ID, so history follows the folder through renames and moves
 * even though the store itself lives outside the folder. Auto-created on first
 * sight (no user setup); the walk excludes it so it is never versioned.
 *
 * Safety: the marker is only READ when it is a real regular file — never through a
 * symlink — and it is written atomically into a cleared path, so an agent that
 * pre-plants `.bridle-workspace` as a symlink cannot make us read or write outside
 * the folder.
 */
export const WORKSPACE_MARKER = ".bridle-workspace";

const ID_RE = /^[0-9a-f-]{16,64}$/i;

export type WorkspaceIdentity = { id: string; created: boolean };

/** Read a workspace marker without creating or replacing one. */
export async function readWorkspaceIdentityId(root: string): Promise<string | null> {
  const markerPath = join(root, WORKSPACE_MARKER);
  try {
    const stat = await lstat(markerPath);
    if (!stat.isFile()) return null;
    const raw = (await readFile(markerPath, "utf8")).trim();
    return ID_RE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

async function writeFreshWorkspaceIdentity(root: string): Promise<WorkspaceIdentity> {
  const markerPath = join(root, WORKSPACE_MARKER);
  await rm(markerPath, { recursive: true, force: true });
  const id = randomUUID();
  const tmp = `${markerPath}.tmp-${randomUUID()}`;
  await writeFile(tmp, `${id}\n`, "utf8");
  await rename(tmp, markerPath);
  return { id, created: true };
}

/** Read the folder's stable ID, creating one the first time. */
export async function resolveWorkspaceIdentity(root: string): Promise<WorkspaceIdentity> {
  const id = await readWorkspaceIdentityId(root);
  if (id) return { id, created: false };
  return writeFreshWorkspaceIdentity(root);
}

/** Replace a copied folder's inherited marker with a fresh workspace identity. */
export async function reissueWorkspaceIdentity(root: string): Promise<WorkspaceIdentity> {
  return writeFreshWorkspaceIdentity(root);
}

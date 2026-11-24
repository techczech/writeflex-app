/**
 * Files an operation created outside the Workspace's write log (a widget file, made by its own exclusive
 * create), each with the SHA-256 of the bytes it wrote. The rewind of a refused adoption removes such a file
 * only while it still holds those bytes (agent.ts, rewindAdoption): without a record, nothing proves the file
 * holds only the adoption's writing, so it is kept.
 *
 * Recorded in the operation's own async context, like `Workspace.recordingOperationWrites`: a file created
 * by another call is never in the record. Outside a recording, noting a file does nothing.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/** Workspace-relative path (`/` separators) → SHA-256 (hex) of what the operation wrote there. */
export type CreatedFiles = Map<string, string>

const createdFileScope = new AsyncLocalStorage<CreatedFiles>()

export function recordingCreatedFiles<T>(record: CreatedFiles, call: () => Promise<T>): Promise<T> {
  return createdFileScope.run(record, call)
}

/** Called by the code that created `path` and wrote exactly the bytes hashing to `sha256`. */
export function noteCreatedFile(path: string, sha256: string): void {
  createdFileScope.getStore()?.set(path, sha256)
}

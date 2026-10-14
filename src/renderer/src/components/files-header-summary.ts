import type { QueryRow } from '../../../preload'

export type FilesHeaderSummary = { pieceCount: number; folderPiecePaths: Set<string> }

/**
 * What the Files header counts ("2 pieces · 0 folder pieces"), from the workspace query's rows.
 *
 * A note the agent leaves in an `agent-notes/` folder is a query row (the Board, Rail and Digest show
 * it, marked agent-authored) but it is not one of the writer's pieces, so it is never counted here —
 * the same rule the Board applies when it leaves agent notes out of the pipeline.
 */
export function filesHeaderSummary(rows: ReadonlyArray<Pick<QueryRow, 'agentAuthored' | 'folderPath'>>): FilesHeaderSummary {
  const pieces = rows.filter((row) => !row.agentAuthored)
  return {
    pieceCount: pieces.length,
    folderPiecePaths: new Set(pieces.flatMap((row) => row.folderPath ? [row.folderPath] : [])),
  }
}

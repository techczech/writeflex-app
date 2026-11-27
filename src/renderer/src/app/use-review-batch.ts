import { useEffect, useState } from 'react'
import { EMPTY_BATCH, nextBatch, type ReviewBatch } from './margin-bulk'

/** Tracks every edit that has waited in this piece during the current review pass. */
export function useReviewBatch(key: string | null, waitingIds: readonly string[]): ReviewBatch {
  const [batch, setBatch] = useState(EMPTY_BATCH)

  useEffect(() => {
    const next = nextBatch(batch, key, waitingIds)
    // A rebuilt review model can supply a fresh array for the same batch.
    if (next !== batch) setBatch(next)
  }, [batch, key, waitingIds])

  return batch
}

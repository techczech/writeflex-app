import type { Player } from '../editor/read-aloud-player'
import type { SpeakableOptions } from '../editor/speakable'

export type ReadAloudInput = {
  source: string
  fromOffset: number
  options: SpeakableOptions
}

export type PauseResumeResult = 'started' | 'paused' | 'resumed' | 'unavailable'

/** One control path for the transport bar, voice picker and palette command. */
export function runPauseResumeReadAloud({
  player,
  currentInput,
  start,
  resumeFromPausedPosition = false,
}: {
  player: Player
  currentInput: () => ReadAloudInput | null
  start: () => void
  resumeFromPausedPosition?: boolean
}): PauseResumeResult {
  const state = player.state()
  if (!state.speaking) {
    start()
    return 'started'
  }
  if (!state.paused) {
    player.pause()
    return 'paused'
  }
  if (resumeFromPausedPosition) {
    player.continuePaused()
    return 'resumed'
  }

  const input = currentInput()
  if (!input) return 'unavailable'
  player.resume(input.source, input.fromOffset, input.options)
  return 'resumed'
}

/** Typing is an inferred pause only; an already-paused session stays untouched. */
export function pauseReadAloudForDocumentChange(player: Player): boolean {
  const state = player.state()
  if (!state.speaking || state.paused) return false
  player.pause()
  return true
}

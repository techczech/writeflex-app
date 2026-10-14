import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  LocateFixed,
  Pause,
  Play,
  Square,
} from 'lucide-react'
import { READ_ALOUD_RATES, type PlayerState } from '../editor/read-aloud-player'

export type ReadAloudBarProps = {
  state: PlayerState
  voiceName: string
  onPauseResume: () => void
  onStop: () => void
  onSkipSentence: (direction: 1 | -1) => void
  onSkipParagraph: (direction: 1 | -1) => void
  onOpenReadAloudSettings: () => void
  onSetRate: (rate: number) => void
  readingPositionOutsideViewport: boolean
  onReturnToReading: () => void
}

/**
 * The active reading transport. It is a normal-flow child of the editor stack, so mounting it
 * reduces the editor's available height instead of covering any prose.
 */
export function ReadAloudBar({
  state,
  voiceName,
  onPauseResume,
  onStop,
  onSkipSentence,
  onSkipParagraph,
  onOpenReadAloudSettings,
  onSetRate,
  readingPositionOutsideViewport,
  onReturnToReading,
}: ReadAloudBarProps): JSX.Element | null {
  if (!state.speaking) return null

  return (
    <div
      className={`read-aloud-bar${state.paused ? ' paused' : ''}`}
      data-testid="read-aloud-bar"
      role="toolbar"
      aria-label="Read aloud controls"
    >
      {state.paused && readingPositionOutsideViewport && (
        <button
          type="button"
          className="read-aloud-bar-return"
          aria-label="Return to the reading"
          onClick={onReturnToReading}
        >
          <LocateFixed aria-hidden="true" />
          <span>Return to the reading</span>
        </button>
      )}
      <div className="read-aloud-bar-transport" role="group" aria-label="Reading transport">
        <button type="button" aria-label="Previous paragraph" onClick={() => onSkipParagraph(-1)}>
          <ChevronsLeft aria-hidden="true" />
        </button>
        <button type="button" aria-label="Previous sentence" onClick={() => onSkipSentence(-1)}>
          <ChevronLeft aria-hidden="true" />
        </button>
        <button
          type="button"
          className="primary"
          aria-label={state.paused ? 'Resume reading' : 'Pause reading'}
          aria-pressed={state.paused}
          onClick={onPauseResume}
        >
          {state.paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
        </button>
        <button type="button" aria-label="Next sentence" onClick={() => onSkipSentence(1)}>
          <ChevronRight aria-hidden="true" />
        </button>
        <button type="button" aria-label="Next paragraph" onClick={() => onSkipParagraph(1)}>
          <ChevronsRight aria-hidden="true" />
        </button>
        <button type="button" className="stop" aria-label="Stop reading" onClick={onStop}>
          <Square aria-hidden="true" />
        </button>
      </div>
      <div className="read-aloud-bar-options">
        <button
          type="button"
          className="read-aloud-bar-voice"
          aria-label={`Open Read aloud settings. Current voice: ${voiceName}`}
          onClick={onOpenReadAloudSettings}
        >
          <span>{voiceName}</span>
        </button>
        <select
          className="read-aloud-bar-rate"
          aria-label="Reading speed"
          title="Reading speed"
          value={state.rate.toFixed(1)}
          onChange={(event) => onSetRate(Number(event.target.value))}
        >
          {READ_ALOUD_RATES.map((rate) => (
            <option key={rate} value={rate.toFixed(1)}>
              {rate.toFixed(1)}×
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

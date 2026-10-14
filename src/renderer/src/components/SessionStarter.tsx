import { useEffect, useRef, useState } from 'react'
import { Play, Volume2 } from 'lucide-react'
import {
  applyMinuteDigit,
  createSessionStarterState,
  removeMinuteDigit,
  selectMinutePreset,
  SESSION_PRESETS,
  sessionStarterRequest,
  setWordsTarget,
  type SessionStarterRequest,
} from '../app/session-starter'

export type SessionStarterProps = {
  tick: boolean
  onTickChange: (tick: boolean) => void
  onStart: (request: SessionStarterRequest) => void
  onCancel: () => void
}

export function SessionStarter({ tick, onTickChange, onStart, onCancel }: SessionStarterProps): JSX.Element {
  const [state, setState] = useState(() => createSessionStarterState(tick))
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => cardRef.current?.focus(), [])

  const start = (): void => onStart(sessionStarterRequest(state))
  const face = `${String(Number.parseInt(state.minutes || '0', 10) || 0).padStart(2, '0')}:00`

  return (
    <div className="overlay session-starter-scrim" role="presentation">
      <div
        ref={cardRef}
        className="session-starter"
        role="dialog"
        aria-modal="true"
        aria-label="Start session"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
            return
          }
          if (event.key === 'Enter') {
            event.preventDefault()
            start()
            return
          }
          if ((event.target as HTMLElement).tagName === 'INPUT') return
          if (/^\d$/.test(event.key)) {
            event.preventDefault()
            setState((current) => applyMinuteDigit(current, event.key))
          } else if (event.key === 'Backspace' || event.key === 'Delete') {
            event.preventDefault()
            setState((current) => removeMinuteDigit(current))
          }
        }}
      >
        <div className="session-starter-time" aria-live="polite">{face}</div>
        <div className="session-starter-presets" aria-label="Session duration presets">
          {SESSION_PRESETS.map((minutes) => (
            <button
              type="button"
              key={minutes}
              aria-pressed={Number(state.minutes) === minutes}
              onClick={() => setState((current) => selectMinutePreset(current, minutes))}
            >
              {minutes}
            </button>
          ))}
          <span>min</span>
        </div>
        <input
          className="session-starter-target"
          inputMode="numeric"
          aria-label="Words target, optional"
          placeholder="words — optional"
          value={state.words}
          onChange={(event) => setState((current) => setWordsTarget(current, event.target.value))}
        />
        <label className="session-starter-tick">
          <span className="session-starter-tick-label"><span>Tick</span><small>volume follows Typing sound</small></span>
          <Volume2 aria-hidden="true" />
          <input
            type="checkbox"
            aria-label="Tick"
            checked={state.tick}
            onChange={(event) => {
              const next = event.target.checked
              setState((current) => ({ ...current, tick: next }))
              onTickChange(next)
            }}
          />
          <span className="session-starter-switch" aria-hidden="true" />
        </label>
        <button className="session-starter-start" type="button" onClick={start}>
          <Play aria-hidden="true" />
          Start
        </button>
        <div className="session-starter-hints" aria-hidden="true">
          <span>digits set minutes</span>
          <span><kbd>⏎</kbd> start</span>
          <span><kbd>esc</kbd> cancel</span>
        </div>
      </div>
    </div>
  )
}

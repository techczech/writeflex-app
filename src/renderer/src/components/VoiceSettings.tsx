import { useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronUp, Volume2 } from 'lucide-react'
import {
  groupReadAloudVoices,
  resolveReadAloudVoice,
  voiceBadges,
  type SpeechVoiceInfo,
} from '../editor/speech-engine'

export type VoiceSettingsProps = {
  voices: SpeechVoiceInfo[]
  selectedVoiceURI: string | null
  query?: string
  onChoose: (voice: SpeechVoiceInfo) => void
}

/**
 * The one voice-selection surface. Premium, Enhanced and system-default voices stay visible;
 * the long multilingual system inventory remains one explicit, keyboard-reachable toggle away.
 */
export function VoiceSettings({
  voices,
  selectedVoiceURI,
  query = '',
  onChoose,
}: VoiceSettingsProps): JSX.Element {
  const [showAll, setShowAll] = useState(false)
  const { featured, other } = useMemo(() => groupReadAloudVoices(voices), [voices])
  const effective = resolveReadAloudVoice(voices, selectedVoiceURI)
  const filter = query.trim().toLocaleLowerCase()
  const listed = filter
    ? [...featured, ...other].filter((voice) =>
        `${voice.name} ${voice.lang} ${voiceBadges(voice).join(' ')}`.toLocaleLowerCase().includes(filter),
      )
    : showAll
      ? [...featured, ...other]
      : featured

  return (
    <div className="card voice-settings-card">
      <div className="crow voice-settings-heading">
        <Volume2 className="icon" aria-hidden="true" />
        <span className="grow">
          <span className="lbl">Voice</span>
          <small>Premium, Enhanced and the system default are shown first</small>
        </span>
        {!filter && other.length > 0 && (
          <button
            type="button"
            className="ghost voice-settings-toggle"
            aria-expanded={showAll}
            onClick={() => setShowAll((shown) => !shown)}
          >
            {showAll ? <ChevronUp className="icon sm" aria-hidden="true" /> : <ChevronDown className="icon sm" aria-hidden="true" />}
            {showAll ? 'Show featured voices' : 'Show all voices'}
          </button>
        )}
      </div>
      {voices.length === 0 && (
        <div className="voice-settings-empty">System voices are still loading.</div>
      )}
      {voices.length > 0 && listed.length === 0 && filter && (
        <div className="voice-settings-empty">No installed voice matches this search.</div>
      )}
      {listed.map((voice) => {
        const selected = effective.voiceURI === voice.uri
          || (effective.voiceURI === null && voice.isDefault)
        return (
          <button
            key={voice.uri}
            type="button"
            className={`crow voice-settings-row${selected ? ' selected' : ''}`}
            aria-pressed={selected}
            onClick={() => onChoose(voice)}
          >
            <span className="grow">
              <span className="lbl">{voice.name}</span>
              <small>{voice.lang}</small>
            </span>
            <span className="voice-settings-badges">
              {voiceBadges(voice).map((badge) => (
                <span className={`voice-badge ${badge.toLowerCase()}`} key={badge}>
                  {badge}
                </span>
              ))}
            </span>
            {selected && <Check className="icon sm voice-settings-check" aria-hidden="true" />}
          </button>
        )
      })}
    </div>
  )
}

export type SpeechVoiceInfo = {
  uri: string
  name: string
  lang: string
  isDefault: boolean
}

export type SpeechHandlers = {
  /** `name` is the platform's boundary kind; 'word' marks a word start. Absent means unknown. */
  onBoundary(charIndex: number, name?: 'word' | 'sentence'): void
  onEnd(): void
  onError(error: string): void
}

export type SpeechEngine = {
  speak(
    text: string,
    opts: { voiceURI: string | null; rate: number },
    handlers: SpeechHandlers
  ): void
  pause(): void
  resume(): void
  cancel(): void
  /** Best-effort in-place update: current speech changes where supported; queued speech always does. */
  setRate(rate: number): void
  voices(): SpeechVoiceInfo[]
}

export function voiceBadges(voice: SpeechVoiceInfo): Array<'Premium' | 'Enhanced' | 'Default'> {
  const badges: Array<'Premium' | 'Enhanced' | 'Default'> = []
  if (/\(premium\)/i.test(voice.name)) badges.push('Premium')
  else if (/\(enhanced\)/i.test(voice.name)) badges.push('Enhanced')
  if (voice.isDefault) badges.push('Default')
  return badges
}

export function groupReadAloudVoices(
  voices: SpeechVoiceInfo[],
): { featured: SpeechVoiceInfo[]; other: SpeechVoiceInfo[] } {
  const rank = (voice: SpeechVoiceInfo): number => {
    const badges = voiceBadges(voice)
    if (badges.includes('Premium') || badges.includes('Enhanced')) return 0
    if (badges.includes('Default')) return 1
    return 2
  }
  const byRankAndName = (left: SpeechVoiceInfo, right: SpeechVoiceInfo): number =>
    rank(left) - rank(right) || left.name.localeCompare(right.name) || left.lang.localeCompare(right.lang)
  return {
    featured: voices.filter((voice) => rank(voice) < 2).sort(byRankAndName),
    other: voices.filter((voice) => rank(voice) === 2).sort(byRankAndName),
  }
}

/**
 * A missing saved voice returns `voiceURI: null`, deliberately handing selection back to the
 * platform instead of substituting another explicit voice. The name still reports the installed
 * default when the platform identifies one.
 */
export function resolveReadAloudVoice(
  voices: SpeechVoiceInfo[],
  savedVoiceURI: string | null,
): { voiceURI: string | null; name: string } {
  if (savedVoiceURI) {
    const saved = voices.find((voice) => voice.uri === savedVoiceURI)
    if (saved) return { voiceURI: saved.uri, name: saved.name }
  }
  const systemDefault = voices.find((voice) => voice.isDefault)
  return {
    voiceURI: null,
    name: systemDefault?.name ?? 'System voice',
  }
}

/**
 * Web speech engine: wraps globalThis.speechSynthesis
 */
export function webSpeechEngine(): SpeechEngine {
  let synth: SpeechSynthesis | null = null
  let voicesCached: SpeechVoiceInfo[] | null = null
  const outstanding = new Set<SpeechSynthesisUtterance>()

  function getSynth(): SpeechSynthesis {
    if (!synth) {
      if (typeof globalThis === 'undefined' || !globalThis.speechSynthesis) {
        throw new Error('Speech synthesis API not available in this environment')
      }
      synth = globalThis.speechSynthesis
    }
    return synth
  }

  function clampRate(rate: number): number {
    return Math.max(0.5, Math.min(2.5, rate))
  }

  return {
    speak(text: string, opts: { voiceURI: string | null; rate: number }, handlers: SpeechHandlers): void {
      const synth = getSynth()

      const utterance = new SpeechSynthesisUtterance(text)
      utterance.rate = clampRate(opts.rate)
      outstanding.add(utterance)

      // Set voice if specified
      if (opts.voiceURI !== null) {
        const voices = synth.getVoices()
        const voice = voices.find((v) => v.voiceURI === opts.voiceURI)
        if (voice) {
          utterance.voice = voice
        }
      }

      // Wire up event handlers
      utterance.onboundary = (event) => {
        if (event.charIndex !== undefined) {
          handlers.onBoundary(event.charIndex, event.name === 'word' || event.name === 'sentence' ? event.name : undefined)
        }
      }

      utterance.onend = () => {
        outstanding.delete(utterance)
        handlers.onEnd()
      }

      utterance.onerror = (event) => {
        outstanding.delete(utterance)
        handlers.onError(event.error)
      }

      synth.speak(utterance)
    },

    pause(): void {
      const synth = getSynth()
      synth.pause()
    },

    resume(): void {
      const synth = getSynth()
      synth.resume()
    },

    cancel(): void {
      const synth = getSynth()
      synth.cancel()
      outstanding.clear()
    },

    setRate(rate: number): void {
      const next = clampRate(rate)
      // Chromium reads queued utterance properties when each item begins. Updating the live item is
      // also harmless: macOS applies it where supported and otherwise the next utterance takes it.
      for (const utterance of outstanding) utterance.rate = next
    },

    voices(): SpeechVoiceInfo[] {
      const synth = getSynth()
      const allVoices = synth.getVoices()

      // If voices are empty, they may not be loaded yet
      if (allVoices.length === 0 && !voicesCached) {
        return []
      }

      if (voicesCached) {
        return voicesCached
      }

      // Map SpeechSynthesisVoice to SpeechVoiceInfo
      voicesCached = allVoices.map((v) => ({
        uri: v.voiceURI,
        name: v.name,
        lang: v.lang,
        isDefault: v.default,
      }))

      // Listen for voiceschanged event to update cache when voices load
      synth.onvoiceschanged = () => {
        voicesCached = synth.getVoices().map((v) => ({
          uri: v.voiceURI,
          name: v.name,
          lang: v.lang,
          isDefault: v.default,
        }))
      }

      return voicesCached
    },
  }
}

/**
 * Fake speech engine for testing: records calls and allows scripted boundary/end events
 */
export function fakeSpeechEngine(): SpeechEngine & {
  emitBoundary(charIndex: number, name?: 'word' | 'sentence'): void
  emitEnd(): void
  emitError(error: string): void
  spoken: string[]
} {
  const spoken: string[] = []
  const queuedHandlers: SpeechHandlers[] = []
  let currentHandlers: SpeechHandlers | null = null

  return {
    spoken,

    speak(
      text: string,
      opts: { voiceURI: string | null; rate: number },
      handlers: SpeechHandlers
    ): void {
      spoken.push(text)
      if (currentHandlers) {
        queuedHandlers.push(handlers)
      } else {
        currentHandlers = handlers
      }
    },

    pause(): void {
      // No-op for fake
    },

    resume(): void {
      // No-op for fake
    },

    cancel(): void {
      const interrupted = currentHandlers
      currentHandlers = null
      queuedHandlers.length = 0
      interrupted?.onError('interrupted')
    },

    setRate(): void {
      // The fake has no clock; Player state is the assertion surface in unit tests.
    },

    voices(): SpeechVoiceInfo[] {
      return []
    },

    emitBoundary(charIndex: number, name: 'word' | 'sentence' = 'word'): void {
      currentHandlers?.onBoundary(charIndex, name)
    },

    emitEnd(): void {
      const ended = currentHandlers
      if (!ended) return
      currentHandlers = queuedHandlers.shift() ?? null
      ended.onEnd()
    },

    emitError(error: string): void {
      const failed = currentHandlers
      if (!failed) return
      currentHandlers = queuedHandlers.shift() ?? null
      failed.onError(error)
    },
  }
}

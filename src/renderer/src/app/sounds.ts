/** Recorded one-shots and ambient loops. Provenance is in resources/sounds/CREDITS.md. */

import {
  AMBIENT_SAMPLES,
  ambientSample,
  clampVolume,
  DEFAULT_TYPING_SCHEME,
  keystrokeVoice,
  nextVariant,
  normaliseTypingScheme,
  strikeJitter,
  SOUND_PACK_FILES,
  SESSION_CUE_FILES,
  TYPING_SAMPLES,
  typingSamples,
  type AmbientLoop,
  type KeystrokeVoice,
  type StrikeJitter,
  type TypingScheme,
} from '../../../shared/sound-pack'

export {
  AMBIENT_SAMPLES,
  ambientSample,
  clampVolume,
  DEFAULT_TYPING_SCHEME,
  keystrokeVoice,
  nextVariant,
  normaliseTypingScheme,
  strikeJitter,
  SOUND_PACK_FILES,
  TYPING_SAMPLES,
  typingSamples,
}
export type { AmbientLoop, KeystrokeVoice, StrikeJitter, TypingScheme }

/** How long the ambient bed takes to arrive and to leave. Long enough that switching loops or
 *  nudging the volume never lands as a click, short enough to feel like a switch. */
const AMBIENT_FADE_S = 0.8

type AmbientGraph = { source: AudioBufferSourceNode; gain: GainNode; file: string }
type SessionCue = 'tick' | 'complete'
type SessionCueState = { running: boolean; timed: boolean; tick: boolean; volume: number }
const MAX_TYPING_VOICES = 6

/**
 * The app-level sound engine (one per window; the blur/focus suspend keeps only the focused window
 * audible, which is what makes ambient effectively one loop app-wide). The AudioContext is created
 * lazily on the first enable so a silent app never touches audio hardware, and every sample a
 * channel needs is decoded when that channel is enabled — never on the keystroke path, where a
 * decode would put tens of milliseconds between the key and its click.
 */
export class SoundEngine {
  #ctx: AudioContext | null = null
  #buffers = new Map<string, AudioBuffer>()
  #pending = new Map<string, Promise<AudioBuffer | null>>()
  #typingOn = false
  #scheme: TypingScheme = DEFAULT_TYPING_SCHEME
  #typingVolume = 0.6
  #lastVariant = new Map<string, number>()
  #typingVoices = new Set<AudioBufferSourceNode>()
  #ambientOn = false
  #ambientLoop: AmbientLoop = 'white'
  #ambientVolume = 0.35
  #ambient: AmbientGraph | null = null
  #sessionCues: SessionCueState = { running: false, timed: false, tick: false, volume: 0.6 }

  /** Injected in tests; in the app it is the preload bridge. Returns null for anything not in the pack. */
  constructor(
    private readonly load: (file: string) => Promise<Uint8Array | null> =
      (file) => window.writeflex?.sounds?.load(file) ?? Promise.resolve(null),
    private readonly sessionCueTestHook?: (kind: SessionCue, volume: number) => void,
  ) {}

  #context(): AudioContext {
    if (!this.#ctx) this.#ctx = new AudioContext({ latencyHint: 'interactive' })
    return this.#ctx
  }

  /** Decode once, cache forever. Concurrent asks for the same file share one decode. */
  async #buffer(file: string): Promise<AudioBuffer | null> {
    const cached = this.#buffers.get(file)
    if (cached) return cached
    const inFlight = this.#pending.get(file)
    if (inFlight) return inFlight
    const ctx = this.#context()
    const work = (async () => {
      try {
        const bytes = await this.load(file)
        if (!bytes) return null
        // decodeAudioData DETACHES what it is given, so hand it a copy of the transferred bytes.
        const decoded = await ctx.decodeAudioData(bytes.slice().buffer as ArrayBuffer)
        this.#buffers.set(file, decoded)
        return decoded
      } catch {
        return null // a pack file that will not decode leaves the app silent, never noisy
      } finally {
        this.#pending.delete(file)
      }
    })()
    this.#pending.set(file, work)
    return work
  }

  /** Warm every sample a scheme can speak with, so the first keystroke is as tight as the hundredth. */
  #primeTyping(scheme: TypingScheme): void {
    for (const files of Object.values(TYPING_SAMPLES[scheme])) {
      for (const file of files) void this.#buffer(file)
    }
  }

  setTyping(on: boolean, scheme: TypingScheme, volume: number): void {
    this.#typingOn = on
    this.#scheme = scheme
    this.#typingVolume = clampVolume(volume, 0.6)
    if (!on) {
      this.#stopTypingVoices()
      return
    }
    this.#primeTyping(scheme)
    void this.#context().resume()
  }

  keystroke(key: string): void {
    if (!this.#typingOn || this.#typingVolume === 0 || this.#typingVoices.size >= MAX_TYPING_VOICES) return
    const voice = keystrokeVoice(key)
    if (!voice) return
    const ctx = this.#context()
    if (ctx.state !== 'running') {
      // A persisted preference can be enabled before Chromium grants audio playback. Let this
      // keystroke unlock the context, without queueing a click to play late.
      void ctx.resume()
      return
    }
    const variants = typingSamples(this.#scheme, voice)
    const slot = `${this.#scheme}/${voice}`
    const index = nextVariant(variants.length, this.#lastVariant.get(slot) ?? -1, Math.random())
    const buffer = this.#buffers.get(variants[index])
    // Still decoding (the first keystrokes of a freshly enabled channel): skip rather than await.
    // A click that arrives late is worse than one that never arrives.
    if (!buffer) return
    this.#lastVariant.set(slot, index)
    const jitter = strikeJitter(Math.random)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = jitter.rate
    const gain = ctx.createGain()
    gain.gain.value = this.#typingVolume * jitter.gain
    source.connect(gain)
    gain.connect(ctx.destination)
    this.#typingVoices.add(source)
    source.onended = () => {
      this.#typingVoices.delete(source)
      source.disconnect()
      gain.disconnect()
    }
    source.start()
  }

  #stopTypingVoices(): void {
    for (const source of this.#typingVoices) source.stop()
    this.#typingVoices.clear()
  }

  setAmbient(on: boolean, loop: AmbientLoop, volume: number): void {
    const level = clampVolume(volume, 0.35)
    const wanted = ambientSample(loop)
    const changed = !this.#ambient || this.#ambient.file !== wanted
    this.#ambientOn = on
    this.#ambientLoop = loop
    this.#ambientVolume = level
    if (!on || level === 0) {
      this.#stopAmbient()
      return
    }
    // A volume nudge on the loop already playing must not restart it — riding the gain keeps the
    // bed continuous while the slider moves.
    if (!changed && this.#ambient) {
      const ctx = this.#context()
      this.#ambient.gain.gain.cancelScheduledValues(ctx.currentTime)
      this.#ambient.gain.gain.setTargetAtTime(level, ctx.currentTime, 0.05)
      void ctx.resume()
      return
    }
    void this.#startAmbient(wanted, level)
  }

  setSessionCues(input: SessionCueState): void {
    this.#sessionCues = { ...input, volume: clampVolume(input.volume, 0.6) }
    if (!input.running || !input.timed || !input.tick) return
    if (this.sessionCueTestHook) return
    for (const file of Object.values(SESSION_CUE_FILES)) void this.#buffer(file)
    void this.#context().resume()
  }

  tickSession(): void {
    if (!this.#sessionCues.running || !this.#sessionCues.timed || !this.#sessionCues.tick) return
    this.#playSessionCue('tick')
  }

  completeSession(): void {
    if (!this.#sessionCues.running || !this.#sessionCues.timed || !this.#sessionCues.tick) return
    this.#playSessionCue('complete')
  }

  #playSessionCue(kind: SessionCue): void {
    const volume = this.#sessionCues.volume
    if (volume === 0) return
    if (this.sessionCueTestHook) {
      this.sessionCueTestHook(kind, volume)
      return
    }
    const ctx = this.#context()
    if (ctx.state !== 'running') return
    const buffer = this.#buffers.get(SESSION_CUE_FILES[kind])
    if (!buffer) return
    const source = ctx.createBufferSource()
    source.buffer = buffer
    const gain = ctx.createGain()
    gain.gain.value = volume * (kind === 'tick' ? 0.28 : 0.36)
    source.connect(gain)
    gain.connect(ctx.destination)
    source.onended = () => gain.disconnect()
    source.start()
  }

  async #startAmbient(file: string, level: number): Promise<void> {
    const ctx = this.#context()
    const buffer = await this.#buffer(file)
    // The user may have switched loop or turned the channel off while the file decoded.
    if (!buffer || !this.#ambientOn || ambientSample(this.#ambientLoop) !== file) return
    this.#stopAmbient()
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.loop = true
    // The file is built to loop on itself: its head is an equal-power crossfade of its own tail, so
    // the whole buffer is the loop and the seam is inaudible.
    source.loopStart = 0
    source.loopEnd = buffer.duration
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(Math.max(level, 0.0002), ctx.currentTime + AMBIENT_FADE_S)
    source.connect(gain)
    gain.connect(ctx.destination)
    source.start()
    this.#ambient = { source, gain, file }
    void ctx.resume()
  }

  #stopAmbient(): void {
    const graph = this.#ambient
    if (!graph) return
    this.#ambient = null
    const ctx = this.#context()
    const stopAt = ctx.currentTime + AMBIENT_FADE_S
    try {
      graph.gain.gain.cancelScheduledValues(ctx.currentTime)
      graph.gain.gain.setValueAtTime(Math.max(graph.gain.gain.value, 0.0001), ctx.currentTime)
      graph.gain.gain.exponentialRampToValueAtTime(0.0001, stopAt)
      graph.source.stop(stopAt + 0.02)
    } catch {
      // A source that never started throws on stop; nothing to clean up.
    }
    graph.source.onended = () => graph.gain.disconnect()
  }

  /** Window blur: pause the clock (ambient falls silent; typing is naturally silent unfocused). */
  suspend(): void {
    this.#stopTypingVoices()
    if (this.#ctx && this.#ctx.state === 'running') void this.#ctx.suspend()
  }

  /** Window focus: resume only when a channel actually wants sound. */
  resume(): void {
    if (this.#ctx && (this.#ambientOn || this.#typingOn || (this.#sessionCues.running && this.#sessionCues.tick))) void this.#ctx.resume()
  }
}

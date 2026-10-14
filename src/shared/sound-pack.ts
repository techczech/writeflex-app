/**
 * The bundled sound pack: which recording speaks for which voice, and the pure choices around it.
 *
 * Shared because BOTH sides need the same table — main reads files off disk against it (it is the
 * allowlist: nothing outside this table can be read through the sounds IPC), and the renderer's
 * SoundEngine decodes the same names into AudioBuffers. Every file is a real field recording cut to
 * a SINGLE transient; provenance and licences are in resources/sounds/CREDITS.md.
 */

/** Three machines the writer chooses between: `deep` is a 1940 Erika 5 manual typewriter, `crisp` an
 *  electric Smith-Corona, `soft` an ordinary keyboard. `deep` was stored as `typewriter` before the
 *  second machine existed — normaliseTypingScheme still accepts it. */
export type TypingScheme = 'deep' | 'crisp' | 'soft'
export type AmbientLoop = 'white' | 'rain'
export type KeystrokeVoice = 'key' | 'space' | 'enter'

/** scheme → voice → the sample variants that voice may speak with. Letter keys carry several so
 *  fast typing never machine-guns one waveform; space and Enter carry one apiece. */
export const TYPING_SAMPLES: Record<TypingScheme, Record<KeystrokeVoice, readonly string[]>> = {
  deep: {
    key: [
      'deep-key-1.wav',
      'deep-key-2.wav',
      'deep-key-3.wav',
      'deep-key-4.wav',
      'deep-key-5.wav',
    ],
    space: ['deep-space.wav'],
    enter: ['deep-enter.wav'], // the line bell — the one voice that is not a click
  },
  crisp: {
    key: [
      'crisp-key-1.wav',
      'crisp-key-2.wav',
      'crisp-key-3.wav',
      'crisp-key-4.wav',
      'crisp-key-5.wav',
    ],
    space: ['crisp-space.wav'],
    enter: ['crisp-enter.wav'], // the same bell recording, cut shorter and a semitone up
  },
  soft: {
    key: [
      'soft-key-1.wav',
      'soft-key-2.wav',
      'soft-key-3.wav',
      'soft-key-4.wav',
    ],
    space: ['soft-space.wav'],
    enter: ['soft-enter.wav'], // no bell: the flourish is the typewriter's alone
  },
}

/** loop → the seam-crossfaded recording it plays. `white` keeps its settings key for compatibility;
 *  what it now plays is a warm broadband hush, not synthesised white noise (which was the complaint). */
export const AMBIENT_SAMPLES: Record<AmbientLoop, string> = {
  white: 'ambient-noise.flac',
  rain: 'ambient-rain.flac',
}

/** Every file the pack must contain — the IPC allowlist, and what the pack test asserts exists. */
export const SOUND_PACK_FILES: readonly string[] = [
  ...new Set([
    ...Object.values(TYPING_SAMPLES).flatMap((voices) => Object.values(voices).flat()),
    ...Object.values(AMBIENT_SAMPLES),
  ]),
]

export function typingSamples(scheme: TypingScheme, voice: KeystrokeVoice): readonly string[] {
  return TYPING_SAMPLES[scheme][voice]
}

/**
 * A stored scheme value → the scheme to play. `typewriter` is the value written before there were
 * two typewriters to choose between; it maps to `deep`, the machine it always meant, so nobody's
 * preference resets when they upgrade. Anything unrecognised falls back to the same default.
 */
export function normaliseTypingScheme(value: unknown): TypingScheme {
  if (value === 'crisp' || value === 'soft' || value === 'deep') return value
  return 'deep' // includes the legacy 'typewriter'
}

export function ambientSample(loop: AmbientLoop): string {
  return AMBIENT_SAMPLES[loop]
}

/** Clamp a stored volume to 0..1; junk (non-numbers, NaN) falls back to the channel default. */
export function clampVolume(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback
  return Math.min(1, Math.max(0, value))
}

/** Which voice a KeyboardEvent.key speaks with — or null for keys that are not writing (modifiers,
 *  navigation, function keys). Backspace/Delete/Tab edit the document, so they sound. */
export function keystrokeVoice(key: string): KeystrokeVoice | null {
  if (key === ' ') return 'space'
  if (key === 'Enter') return 'enter'
  if (key === 'Backspace' || key === 'Delete' || key === 'Tab') return 'key'
  if (key.length === 1) return 'key'
  return null
}

/**
 * Pick the next variant: random, but never the one that just played. Pure round-robin is audibly
 * mechanical over a fast run of letters and pure randomness repeats often enough to hear; excluding
 * the previous index is what makes a real keyboard's irregularity.
 */
export function nextVariant(count: number, previous: number, random: number): number {
  if (count <= 1) return 0
  // No previous strike (the first of a session): every variant is fair game.
  if (previous < 0 || previous >= count) return Math.min(count - 1, Math.floor(random * count))
  const choice = Math.min(count - 2, Math.floor(random * (count - 1)))
  return choice >= previous ? choice + 1 : choice
}

/** Per-strike humanising: a small gain and playback-rate wobble so repeated keys are never identical.
 *  Kept tight — ±3 % rate is a shade of pitch, not a detune anyone would notice as an effect. */
export type StrikeJitter = { gain: number; rate: number }

export function strikeJitter(random: () => number): StrikeJitter {
  return { gain: 0.88 + random() * 0.24, rate: 0.97 + random() * 0.06 }
}

import { expect, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  AMBIENT_SAMPLES,
  ambientSample,
  clampVolume,
  keystrokeVoice,
  nextVariant,
  normaliseTypingScheme,
  strikeJitter,
  SOUND_PACK_FILES,
  TYPING_SAMPLES,
  typingSamples,
  SoundEngine,
} from '../../src/renderer/src/app/sounds'
import { isPackFile, readSoundFile, soundPackDir } from '../../src/main/sound-pack'

// The Sounds feature plays REAL RECORDINGS now (resources/sounds, provenance in CREDITS.md), so what
// is provable headless has moved: the pack table, the variant choice that stops fast typing
// machine-gunning one waveform, the jitter bounds, the shape of the shipped files, and the IPC
// allowlist that keeps a sample read from becoming an arbitrary file read. How it SOUNDS is still
// usability review territory — that needs ears.

const PACK = join(import.meta.dir, '..', '..', 'resources', 'sounds')

test('clampVolume clamps to 0..1 and falls back on junk', () => {
  expect(clampVolume(0.6, 0.5)).toBe(0.6)
  expect(clampVolume(0, 0.5)).toBe(0)
  expect(clampVolume(1, 0.5)).toBe(1)
  expect(clampVolume(4, 0.5)).toBe(1)
  expect(clampVolume(-3, 0.5)).toBe(0)
  expect(clampVolume('loud', 0.35)).toBe(0.35)
  expect(clampVolume(null, 0.35)).toBe(0.35)
  expect(clampVolume(undefined, 0.6)).toBe(0.6)
  expect(clampVolume(Number.NaN, 0.6)).toBe(0.6)
})

test('keystrokeVoice: writing keys sound; modifiers and navigation stay silent', () => {
  expect(keystrokeVoice('a')).toBe('key')
  expect(keystrokeVoice('A')).toBe('key')
  expect(keystrokeVoice('.')).toBe('key')
  expect(keystrokeVoice('č')).toBe('key')
  expect(keystrokeVoice(' ')).toBe('space')
  expect(keystrokeVoice('Enter')).toBe('enter')
  expect(keystrokeVoice('Backspace')).toBe('key')
  expect(keystrokeVoice('Delete')).toBe('key')
  expect(keystrokeVoice('Tab')).toBe('key')
  expect(keystrokeVoice('Shift')).toBeNull()
  expect(keystrokeVoice('Meta')).toBeNull()
  expect(keystrokeVoice('ArrowLeft')).toBeNull()
  expect(keystrokeVoice('Escape')).toBeNull()
  expect(keystrokeVoice('F5')).toBeNull()
})

const SCHEMES = ['deep', 'crisp', 'soft'] as const

test('all three schemes map every voice to a sample, and letter keys carry several', () => {
  expect(Object.keys(TYPING_SAMPLES).sort()).toEqual([...SCHEMES].sort())
  for (const scheme of SCHEMES) {
    for (const voice of ['key', 'space', 'enter'] as const) {
      const samples = typingSamples(scheme, voice)
      expect(samples.length, `${scheme}/${voice} has no sample`).toBeGreaterThan(0)
      for (const file of samples) expect(SOUND_PACK_FILES).toContain(file)
    }
    // Repeated letters are what a reader hears most; one waveform for all of them machine-guns.
    expect(typingSamples(scheme, 'key').length).toBeGreaterThanOrEqual(3)
    // Each scheme's files carry its own name, so the pack reads as three machines on disk too.
    for (const file of Object.values(TYPING_SAMPLES[scheme]).flat()) {
      expect(file.startsWith(`${scheme}-`), `${file} does not belong to ${scheme}`).toBe(true)
    }
  }
  // No scheme borrows another's CLICKS — they are different machines. (The bell is shared by the two
  // typewriters on purpose: neither recording contains one, and each gets its own cut of it.)
  for (const [a, b] of [['deep', 'crisp'], ['deep', 'soft'], ['crisp', 'soft']] as const) {
    const clicks = (scheme: typeof SCHEMES[number]): Set<string> =>
      new Set([...typingSamples(scheme, 'key'), ...typingSamples(scheme, 'space')])
    for (const file of clicks(b)) expect(clicks(a).has(file), `${a} and ${b} share ${file}`).toBe(false)
  }
  // Every scheme rings its own Enter file, even where the underlying recording is shared.
  const enters = SCHEMES.map((scheme) => typingSamples(scheme, 'enter')[0])
  expect(new Set(enters).size).toBe(SCHEMES.length)
})

test('a stored scheme resolves, and the legacy "typewriter" value still means Deep', () => {
  for (const scheme of SCHEMES) expect(normaliseTypingScheme(scheme)).toBe(scheme)
  // The value written before there were two typewriters. Nobody's preference may reset on upgrade.
  expect(normaliseTypingScheme('typewriter')).toBe('deep')
  // Anything unset or unrecognised falls back to the same default the UI shows.
  for (const junk of [null, undefined, '', 'Deep', 'erika', 42, {}, []]) {
    expect(normaliseTypingScheme(junk)).toBe('deep')
  }
})

test('both ambient loops resolve to a bundled file and the two differ', () => {
  expect(ambientSample('rain')).toBe(AMBIENT_SAMPLES.rain)
  expect(ambientSample('white')).toBe(AMBIENT_SAMPLES.white)
  expect(AMBIENT_SAMPLES.rain).not.toBe(AMBIENT_SAMPLES.white)
  for (const file of Object.values(AMBIENT_SAMPLES)) expect(SOUND_PACK_FILES).toContain(file)
})

test('nextVariant never repeats the previous strike and covers every variant', () => {
  expect(nextVariant(1, 0, 0.99)).toBe(0) // one variant: no choice to make
  const seen = new Set<number>()
  for (let i = 0; i < 200; i += 1) {
    const chosen = nextVariant(5, 2, i / 200)
    expect(chosen).not.toBe(2)
    expect(chosen).toBeGreaterThanOrEqual(0)
    expect(chosen).toBeLessThan(5)
    seen.add(chosen)
  }
  expect(seen).toEqual(new Set([0, 1, 3, 4]))
  // The very first strike of a session has no previous, so nothing is excluded.
  const first = new Set(Array.from({ length: 200 }, (_, i) => nextVariant(4, -1, i / 200)))
  expect(first).toEqual(new Set([0, 1, 2, 3]))
  // A random of exactly 1 must still land in range rather than off the end.
  expect(nextVariant(4, 1, 1)).toBeLessThan(4)
  expect(nextVariant(4, -1, 1)).toBeLessThan(4)
})

test('strikeJitter stays a human wobble, never an effect', () => {
  for (const value of [0, 0.25, 0.5, 0.75, 0.999]) {
    const jitter = strikeJitter(() => value)
    expect(jitter.gain).toBeGreaterThanOrEqual(0.88)
    expect(jitter.gain).toBeLessThanOrEqual(1.12)
    expect(jitter.rate).toBeGreaterThanOrEqual(0.97)
    expect(jitter.rate).toBeLessThanOrEqual(1.03)
  }
})

test('the pack on disk is the pack the table names, and it is small enough to bundle', () => {
  let total = 0
  for (const file of SOUND_PACK_FILES) {
    const stats = statSync(join(PACK, file))
    expect(stats.size, `${file} is empty`).toBeGreaterThan(1024)
    total += stats.size
  }
  expect(total).toBeLessThan(8 * 1024 * 1024)
  // Provenance is not optional: every shipped file must be named in CREDITS.md.
  const credits = readFileSync(join(PACK, 'CREDITS.md'), 'utf8')
  for (const file of SOUND_PACK_FILES) expect(credits).toContain(file)
})

test('one-shots are short and lossless; loops are FLAC so the seam stays sample-exact', () => {
  for (const file of Object.values(TYPING_SAMPLES).flatMap((voices) => Object.values(voices).flat())) {
    expect(file.endsWith('.wav'), `${file} must be WAV — no encoder delay on the keystroke path`).toBe(true)
    const bytes = readFileSync(join(PACK, file))
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('RIFF')
    const rate = bytes.readUInt32LE(24)
    const channels = bytes.readUInt16LE(22)
    const seconds = (bytes.length - 44) / (rate * channels * 2)
    expect(channels).toBe(1)
    // Keystroke clicks stay under 150 ms so playback is tight; the Enter bell is allowed to ring.
    expect(seconds).toBeLessThan(file.includes('enter') ? 0.6 : 0.15)
    expect(seconds).toBeGreaterThan(0.05)
  }
  for (const file of Object.values(AMBIENT_SAMPLES)) {
    expect(file.endsWith('.flac')).toBe(true)
    expect(readFileSync(join(PACK, file)).subarray(0, 4).toString('latin1')).toBe('fLaC')
  }
})

test('every keystroke sample is ONE hit — the defect that failed the live check', () => {
  for (const file of Object.values(TYPING_SAMPLES).flatMap((voices) => Object.values(voices).flat())) {
    const bytes = readFileSync(join(PACK, file))
    const rate = bytes.readUInt32LE(24)
    const samples = (bytes.length - 44) / 2
    // 4 ms peak envelope of the PCM.
    const frame = Math.round(0.004 * rate)
    const envelope: number[] = []
    for (let i = 0; i + frame <= samples; i += frame) {
      let peak = 0
      for (let j = 0; j < frame; j += 1) peak = Math.max(peak, Math.abs(bytes.readInt16LE(44 + (i + j) * 2)))
      envelope.push(peak / 32768)
    }
    const loudest = Math.max(...envelope)
    const attack = envelope.indexOf(loudest)
    // The strike lands in the first 60 ms — nothing may creep in ahead of the key press.
    expect(attack * 0.004, `${file} attacks late`).toBeLessThan(0.06)
    // After the envelope has fallen to a quarter of the peak it must never climb back near it: a
    // second tap there is exactly what made typing sound unsynchronised in the synthesised version.
    const fell = envelope.findIndex((value, index) => index > attack && value < loudest * 0.25)
    expect(fell, `${file} never decays`).toBeGreaterThan(-1)
    const rebound = Math.max(...envelope.slice(fell))
    expect(rebound / loudest, `${file} has a second transient`).toBeLessThan(0.35)
  }
})

test('the sounds IPC serves the pack and nothing else', async () => {
  expect(isPackFile(SOUND_PACK_FILES[0])).toBe(true)
  for (const attempt of ['../../package.json', '/etc/passwd', 'ambient-rain.flac/../CREDITS.md', 'CREDITS.md', '', 42, null]) {
    expect(isPackFile(attempt), `${String(attempt)} must be refused`).toBe(false)
    expect(await readSoundFile(PACK, attempt)).toBeNull()
  }
  const bytes = await readSoundFile(PACK, AMBIENT_SAMPLES.rain)
  expect(bytes).toBeInstanceOf(Uint8Array)
  expect(bytes!.length).toBeGreaterThan(1024)
  // A pack file that is missing must leave the app silent, not throw on a keystroke.
  expect(await readSoundFile('/nowhere-at-all', AMBIENT_SAMPLES.rain)).toBeNull()
})

test('the pack directory follows the bundled-skills precedent in both dev and packaged builds', () => {
  expect(soundPackDir({ packaged: true, resourcesPath: '/Apps/WriteFlex.app/Contents/Resources', entryDir: '/x' }))
    .toBe('/Apps/WriteFlex.app/Contents/Resources/sounds')
  // Unpackaged, resolve from the BUILT ENTRY (out/main → ../../resources/sounds): e2e launches
  // Electron on out/main directly, where the app path is the entry dir rather than the repo root.
  expect(soundPackDir({ packaged: false, resourcesPath: '/ignored', entryDir: '/repo/out/main' }))
    .toBe('/repo/resources/sounds')
})

test('session cues are gated to a timed running session with Tick on', () => {
  const calls: Array<{ kind: 'tick' | 'complete'; volume: number }> = []
  const engine = new SoundEngine(async () => null, (kind, volume) => calls.push({ kind, volume }))

  engine.setSessionCues({ running: true, timed: false, tick: true, volume: 0.4 })
  engine.tickSession()
  engine.completeSession()
  engine.setSessionCues({ running: true, timed: true, tick: false, volume: 0.4 })
  engine.tickSession()
  engine.completeSession()
  engine.setSessionCues({ running: false, timed: true, tick: true, volume: 0.4 })
  engine.tickSession()
  engine.completeSession()
  expect(calls).toEqual([])

  engine.setSessionCues({ running: true, timed: true, tick: true, volume: 0.4 })
  engine.tickSession()
  engine.completeSession()
  expect(calls).toEqual([
    { kind: 'tick', volume: 0.4 },
    { kind: 'complete', volume: 0.4 },
  ])
})

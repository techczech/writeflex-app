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
  expect(keystrokeVoice('Backspace')).toBe('backspace')
  expect(keystrokeVoice('Delete')).toBe('backspace')
  expect(keystrokeVoice('Tab')).toBe('key')
  expect(keystrokeVoice('Shift')).toBeNull()
  expect(keystrokeVoice('Meta')).toBeNull()
  expect(keystrokeVoice('ArrowLeft')).toBeNull()
  expect(keystrokeVoice('Escape')).toBeNull()
  expect(keystrokeVoice('F5')).toBeNull()
})

const SCHEMES = ['deep', 'crisp', 'soft', 'olivetti', 'hermes'] as const

test('all five schemes map every voice to a sample, and letter keys carry several', () => {
  expect(Object.keys(TYPING_SAMPLES).sort()).toEqual([...SCHEMES].sort())
  for (const scheme of SCHEMES) {
    for (const voice of ['key', 'space', 'enter', 'backspace'] as const) {
      const samples = typingSamples(scheme, voice)
      expect(samples.length, `${scheme}/${voice} has no sample`).toBeGreaterThan(0)
      for (const file of samples) expect(SOUND_PACK_FILES).toContain(file)
    }
    // Repeated letters are what a reader hears most; one waveform for all of them machine-guns.
    expect(typingSamples(scheme, 'key').length).toBeGreaterThanOrEqual(3)
    // Each scheme maps to its own recordings on disk.
    for (const file of Object.values(TYPING_SAMPLES[scheme]).flat()) {
      expect(file.startsWith(`${scheme}-`), `${file} does not belong to ${scheme}`).toBe(true)
    }
  }
  const clicks = SCHEMES.flatMap((scheme) => [...typingSamples(scheme, 'key'), ...typingSamples(scheme, 'space')])
  expect(new Set(clicks).size).toBe(clicks.length)
  // Every scheme rings its own Enter file, even where the underlying recording is shared.
  const enters = SCHEMES.map((scheme) => typingSamples(scheme, 'enter')[0])
  expect(new Set(enters).size).toBe(SCHEMES.length)
})

test('a stored scheme resolves, and the legacy "typewriter" value still means Classic manual', () => {
  for (const scheme of SCHEMES) expect(normaliseTypingScheme(scheme)).toBe(scheme)
  // The value written before there were two typewriters. Nobody's preference may reset on upgrade.
  expect(normaliseTypingScheme('typewriter')).toBe('deep')
  // Anything unset or unrecognised falls back to the same default the UI shows.
  for (const junk of [null, undefined, '', 'Deep', 'erika', '__proto__', 'constructor', 42, {}, []]) {
    expect(normaliseTypingScheme(junk)).toBe('crisp')
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

test('typing sounds are compact mono FLAC with short, padding-free playback', () => {
  let total = 0
  for (const file of Object.values(TYPING_SAMPLES).flatMap((voices) => Object.values(voices).flat())) {
    const bytes = readFileSync(join(PACK, file))
    total += bytes.length
    expect(file.endsWith('.flac')).toBe(true)
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('fLaC')
    // STREAMINFO starts at byte 8. The packed fields start 10 bytes into that block.
    const rate = bytes.readUIntBE(18, 3) >>> 4
    const channels = ((bytes[20] >>> 1) & 7) + 1
    const samples = bytes.readUIntBE(21, 5) % 2 ** 36
    expect(channels).toBe(1)
    expect(rate).toBe(32_000)
    expect(samples / rate).toBeGreaterThan(0.05)
    // The two new machines retain their bell and whole carriage sweep on Return.
    const maxSeconds = file === 'hermes-enter.flac' ? 1.3
      : file === 'olivetti-enter.flac' ? 0.65
      : file.includes('enter') ? 0.4
      : /^(olivetti|hermes)-/.test(file) ? 0.15 : 0.12
    expect(samples / rate, file).toBeLessThan(maxSeconds)
  }
  expect(total).toBeLessThan(210 * 1024)
  for (const file of Object.values(AMBIENT_SAMPLES)) {
    expect(file.endsWith('.flac')).toBe(true)
    expect(readFileSync(join(PACK, file)).subarray(0, 4).toString('latin1')).toBe('fLaC')
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

test('enabled typing preloads once, plays decoded strikes synchronously, and caps overlapping voices', async () => {
  const originalContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext')
  const loaded: string[] = []
  const played: number[] = []
  const finished: Array<() => void> = []
  const bufferIds = new Map<string, number>()
  class TestAudioContext {
    state = 'running'
    destination = {}
    decodeAudioData(bytes: ArrayBuffer): Promise<number> {
      return Promise.resolve(new Uint8Array(bytes)[0])
    }
    resume(): Promise<void> { return Promise.resolve() }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
    createBufferSource() {
      return {
        buffer: 0,
        playbackRate: { value: 1 },
        onended: () => {},
        connect() {},
        disconnect() {},
        start() {
          played.push(this.buffer)
          finished.push(() => this.onended())
        },
        stop() { this.onended() },
      }
    }
  }
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: TestAudioContext })
  try {
    const engine = new SoundEngine(async (name) => {
      loaded.push(name)
      const id = loaded.length
      bufferIds.set(name, id)
      return new Uint8Array([id])
    })
    engine.setTyping(true, 'deep', 0.6)
    const expected = Object.values(TYPING_SAMPLES.deep).flat()
    expect(loaded.sort()).toEqual([...expected].sort())
    engine.keystroke('a')
    expect(played).toHaveLength(0)
    await new Promise(resolve => setTimeout(resolve, 0))

    for (const key of ['a', 'a', ' ', 'Backspace', 'Enter']) engine.keystroke(key)
    expect(new Set(played.slice(0, 2)).size).toBe(2)
    expect(played.slice(2)).toEqual(['space', 'backspace', 'enter'].map(voice => bufferIds.get(`deep-${voice}.flac`)))
    for (let i = 0; i < 20; i += 1) engine.keystroke('x')
    expect(played).toHaveLength(6)
    finished[0]()
    engine.keystroke('x')
    expect(played).toHaveLength(7)
    engine.setTyping(true, 'deep', 0.5)
    expect(loaded).toHaveLength(expected.length)
  } finally {
    if (originalContext) Object.defineProperty(globalThis, 'AudioContext', originalContext)
    else Reflect.deleteProperty(globalThis, 'AudioContext')
  }
})

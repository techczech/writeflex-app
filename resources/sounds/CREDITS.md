# WriteFlex sound pack — sources, licences, processing

Every file in this folder is cut from a field recording that is public domain, CC0, or CC BY. Nothing
here is synthesised, and nothing ships that cannot be attributed. The cuts are produced by
`tools/build-sound-pack.py`, which downloads the originals from Wikimedia Commons and applies exactly
the processing listed below — re-run it to reproduce the pack byte for byte.

If you add a sound, add its row here in the same turn. A file with no row does not ship.

## Sources

### A. Deep typewriter — keystrikes and space — *WWS Typewriter.ogg*

- **Source page**: <https://commons.wikimedia.org/wiki/File:WWS_Typewriter.ogg>
- **Author**: Work With Sounds / Konrad Gutkowski (recorded 2015-05-08)
- **Licence**: **CC BY 4.0** — <https://creativecommons.org/licenses/by/4.0>
- **What it is**: an "Erika 5" mechanical typewriter, made by Seidel & Naumann in 1940, recorded by
  the EU-funded Work With Sounds archive and donated to Commons via Wikimedia Sverige.
- **Why it is clean**: CC BY permits redistribution and use in software, commercial included, on
  condition of attribution — which this file provides and Settings → Sounds repeats in the app.
- **Attribution string to keep visible**: *Typewriter (Erika 5) — Work With Sounds / Konrad
  Gutkowski, CC BY 4.0.*
- **Scheme**: **Deep**.

### B. Both typewriters' Enter (the line bell) — *406243 stubb typewriter-ding-near-mono.wav*

- **Source page**: <https://commons.wikimedia.org/wiki/File:406243_stubb_typewriter-ding-near-mono.wav>
- **Original**: <https://freesound.org/people/_stubb/sounds/406243/> (Freesound, 2017-10-29)
- **Author**: `_stubb`
- **Licence**: **CC0 1.0** — <https://creativecommons.org/publicdomain/zero/1.0/>
- **What it is**: the bell a typewriter rings at the end of a line.
- **Why it is clean**: CC0 is a public-domain dedication; no conditions, no attribution required. It
  is recorded here anyway.
- **Used by both typewriter schemes.** Neither typewriter recording contains a bell of its own — the
  tonal peaks in the Smith-Corona are a steady recording whistle, not a margin bell — so Deep and
  Crisp ring the same recording, cut differently (see the file table).

### C. Crisp typewriter — keystrikes and space — *Smith-Corona Prestige Auto 12 typing.ogg*

- **Source page**: <https://commons.wikimedia.org/wiki/File:Smith-Corona_Prestige_Auto_12_typing.ogg>
- **Original**: <https://freesound.org/people/lonemonk/sounds/47044/> (Freesound, uploaded to Commons 2012-09-27)
- **Author**: `lonemonk`
- **Licence**: **CC BY 3.0** — <https://creativecommons.org/licenses/by/3.0>
- **What it is**: typing on a Smith-Corona Prestige Auto 12 **electric** typewriter — a brighter,
  snappier machine than the Erika, which is why both ship and the writer picks.
- **Why it is clean**: CC BY permits redistribution and use in software, commercial included, on
  condition of attribution — which this file provides and Settings → Sounds repeats in the app.
  Commons records `AttributionRequired: true` for it.
- **Attribution string to keep visible**: *Typewriter (Smith-Corona Prestige Auto 12) — lonemonk,
  CC BY 3.0.*
- **Scheme**: **Crisp**.

### D. Soft-scheme keystrikes — *Typing medium speed.ogg*

- **Source page**: <https://commons.wikimedia.org/wiki/File:Typing_medium_speed.ogg>
- **Original**: pdsounds.org record 71, <http://www.pdsounds.org/sounds/typing_medium_speed> (2007-04-02)
- **Author**: `teto_yasha`
- **Licence**: **Public domain** (pdsounds.org released its whole library into the public domain;
  Commons carries it under the public-domain tag)
- **What it is**: an ordinary computer keyboard typed at a moderate pace — quieter and duller than
  either typewriter, which is exactly the "soft" scheme's job.
- **Scheme**: **Soft**.

### E. Ambient rain — *Rain against the window.ogg*

- **Source page**: <https://commons.wikimedia.org/wiki/File:Rain_against_the_window.ogg>
- **Original**: pdsounds.org record 600, <http://www.pdsounds.org/sounds/rain_against_the_window> (2008-07-07)
- **Author**: `cori`
- **Licence**: **Public domain**
- **What it is**: rain on a window on an English summer day. Chosen over a dozen other Commons rain
  recordings because almost none of its energy sits above 2 kHz: it is warm rain, not hiss, which is
  the whole complaint about the sound it replaces.

### F. Ambient soft noise — *433589 jackthemurray stream-river-water-up-close.wav*

- **Source page**: <https://commons.wikimedia.org/wiki/File:433589_jackthemurray_stream-river-water-up-close.wav>
- **Original**: <https://freesound.org/people/jackthemurray/sounds/433589/> (Freesound, 2018-06-22)
- **Author**: `jackthemurray`
- **Licence**: **CC0 1.0**
- **What it is**: a soft stream, shelved down until the splash reads as a warm broadband hush. It
  replaces the synthesised white noise, which was flat, bright and — the verdict that started this —
  distracting.

## Files

The file's prefix is the typing scheme it belongs to: `deep-*`, `crisp-*`, `soft-*`.

| File | Source | Cut from | Processing |
| --- | --- | --- | --- |
| `deep-key-1.wav` | A | 13.267 s | high-pass 60 Hz · 115 ms cut · 1.5 ms in / 25 ms out fade · DC removed · attack-RMS level-match |
| `deep-key-2.wav` | A | 16.429 s | as above |
| `deep-key-3.wav` | A | 11.131 s | as above |
| `deep-key-4.wav` | A | 12.396 s | as above |
| `deep-key-5.wav` | A | 15.209 s | as above |
| `deep-space.wav` | A | 5.277 s | as above, 130 ms cut, trimmed 8 % under the letter keys (the dullest strike in the recording — a space bar sounds like this) |
| `deep-enter.wav` | B | 0.025 s | high-pass 200 Hz · 400 ms cut · peak-matched to 88 % of the key level |
| `crisp-key-1.wav` | C | 5.505 s | high-pass 70 Hz · 100 ms cut · fades, DC removal and level-match as above |
| `crisp-key-2.wav` | C | 33.087 s | as above |
| `crisp-key-3.wav` | C | 20.761 s | as above |
| `crisp-key-4.wav` | C | 5.095 s | as above |
| `crisp-key-5.wav` | C | 8.839 s | as above |
| `crisp-space.wav` | C | 31.512 s | as above, 115 ms cut, trimmed 8 % (the dullest strike in the recording) |
| `crisp-enter.wav` | B | 0.025 s | **resampled +6 % (a semitone up)** before the cut, so the smaller electric machine rings a smaller bell · high-pass 200 Hz · 280 ms cut · peak-matched to 88 % of the key level |
| `soft-key-1.wav` | D | 25.780 s | high-pass 90 Hz · 110 ms cut · fades and level-match as above |
| `soft-key-2.wav` | D | 41.748 s | as above |
| `soft-key-3.wav` | D | 31.575 s | as above |
| `soft-key-4.wav` | D | 24.135 s | as above |
| `soft-space.wav` | D | 36.161 s | as above, 125 ms cut, trimmed 8 % |
| `soft-enter.wav` | D | 27.800 s | as above, 125 ms cut, trimmed 12 % |
| `ambient-rain.flac` | E | 36.0 s | high-pass 80 Hz · −3 dB at 3 kHz · slow-drift level-riding (4 s window, ±4 dB) · 28 s loop with a 2.5 s equal-power seam crossfade · mono 32 kHz |
| `ambient-noise.flac` | F | 20.0 s | high-pass 55 Hz · −9 dB at 3.2 kHz and 8 kHz · low-pass 6 kHz · same level-riding · 28 s loop with a 2.5 s seam crossfade · stereo 32 kHz |

Every one-shot was chosen by scanning its recording for a transient with at least 150 ms of quiet in
front of it and no second transient inside the cut, so **each file is exactly one hit**. The previous
synthesised voices layered two transients per keystroke, which is why typing sounded unsynchronised.

## Formats

- One-shots: 16-bit mono WAV at 48 kHz. WAV has no encoder delay, so a keystroke starts on the sample
  we cut rather than 25 ms later, which MP3 would impose.
- Loops: FLAC. Lossless and frame-exact, so `loopEnd` lands on the sample the crossfade was built
  around; a lossy codec's padding would put a tick in the seam.
- Both decode natively in the Chromium that Electron bundles.

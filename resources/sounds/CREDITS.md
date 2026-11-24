# WriteFlex sound credits

The one-shots are cut from mechanical typewriter recordings, level-matched on the attack and
exported as mono 32 kHz FLAC without encoder padding. The Olivetti and Hermes returns combine a bell with the carriage
sweep. Backspace uses a carriage-mechanism click as a proxy for the reverse escapement.
The two ambient recordings remain seam-crossfaded 28-second FLAC loops.

## Recordings

- A — Joseph Sardin, [Typewriter #3](https://bigsoundbank.com/typewriter-3-s2836.html), Hermes Precisa 305. [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
- B — Joseph Sardin, [Typewriter #4](https://bigsoundbank.com/typewriter-4-s2837.html), Hermes Precisa 305. [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
- C — Joseph Sardin, [Typewriter, space](https://bigsoundbank.com/typewriter-space-s2843.html), Hermes Precisa 305. [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
- D — _stubb, [Typewriter keys_slow_near_mono.wav](https://freesound.org/people/_stubb/sounds/406241/). [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
- E — knufds, [Typewriter bell & carriage reset](https://freesound.org/people/knufds/sounds/345955/). [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
- F — teto_yasha, [Typing medium speed](https://commons.wikimedia.org/wiki/File:Typing_medium_speed.ogg), pdsounds.org recording 71. Public domain.
- G — cori, [Rain against the window](https://commons.wikimedia.org/wiki/File:Rain_against_the_window.ogg), pdsounds.org recording 600. Public domain.
- H — jackthemurray, [stream river water up close](https://commons.wikimedia.org/wiki/File:433589_jackthemurray_stream-river-water-up-close.wav). [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).

- I — keithpeter, [typewriter-olivetti-lettra-22.wav](https://freesound.org/people/keithpeter/sounds/123344/), Olivetti Lettera 22. [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
- J — evsecrets, [Typing on a typewriter with ding at end of each line.wav](https://freesound.org/people/evsecrets/sounds/334458/), Hermes Baby. [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).

## Bundled files

| File | Source | Cut |
| --- | --- | --- |
| `deep-key-1.flac` | A | 0.540 s |
| `deep-key-2.flac` | A | 1.540 s |
| `deep-key-3.flac` | A | 1.780 s |
| `deep-key-4.flac` | A | 2.896 s |
| `deep-key-5.flac` | A | 3.088 s |
| `deep-space.flac` | C | 0.136 s |
| `deep-backspace.flac` | E | Carriage engagement at 1.514 s |
| `deep-enter.flac` | E | Bell at 0.018 s, with carriage stop from 2.386 s mixed under it |
| `crisp-key-1.flac` | D | 1.570 s |
| `crisp-key-2.flac` | D | 2.286 s |
| `crisp-key-3.flac` | D | 2.628 s |
| `crisp-key-4.flac` | D | 6.200 s |
| `crisp-key-5.flac` | D | 5.088 s |
| `crisp-space.flac` | C | 0.136 s, raised midrange |
| `crisp-backspace.flac` | E | Short carriage stop at 2.386 s |
| `crisp-enter.flac` | E | Ratchet and carriage stop from 2.375 s |
| `soft-key-1.flac` | B | 0.516 s, damped |
| `soft-key-2.flac` | B | 1.372 s, damped |
| `soft-key-3.flac` | B | 2.332 s, damped |
| `soft-key-4.flac` | B | 3.320 s, damped |
| `soft-space.flac` | C | 0.136 s, damped |
| `soft-backspace.flac` | E | Carriage engagement at 1.514 s, damped |
| `soft-enter.flac` | E | Carriage stop at 2.386 s, damped |
| `olivetti-key-1.flac` | I | 13.145–13.275 s |
| `olivetti-key-2.flac` | I | 31.711–31.845 s |
| `olivetti-key-3.flac` | I | 52.731–52.866 s |
| `olivetti-space.flac` | I | 71.425–71.555 s, quieter same-machine strike |
| `olivetti-backspace.flac` | I | 28.743–28.843 s, carriage click |
| `olivetti-enter.flac` | I | Bell 41.797–42.368 s, carriage 28.388–28.847 s with a 120 ms offset |
| `hermes-key-1.flac` | J | 13.051–13.183 s |
| `hermes-key-2.flac` | J | 30.511–30.644 s |
| `hermes-key-3.flac` | J | 50.041–50.172 s |
| `hermes-space.flac` | J | 63.078–63.213 s, quieter same-machine strike |
| `hermes-backspace.flac` | J | 41.442–41.568 s, carriage click |
| `hermes-enter.flac` | J | Bell 39.539–40.115 s, carriage 40.449–41.622 s with an 80 ms offset |
| `session-tick.wav` | F | 25.780 s, unchanged from the original session cue |
| `session-complete.wav` | F | 27.800 s, unchanged from the original session cue |
| `ambient-rain.flac` | G | From 36.0 s, high-pass, level-riding and equal-power crossfade |
| `ambient-noise.flac` | H | From 20.0 s, high-pass, shelf and low-pass, level-riding and equal-power crossfade |

To reproduce the typing files, run `python3 tools/build-sound-pack.py --typing-only` from the repo
root with ffmpeg and NumPy. The script uses the public preview files cited above, with no account
required. Omit the flag to render the session cues and ambient loops as well.

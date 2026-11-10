# Third-party notices

WriteFlex's own source is MIT licensed; integration packages retain their explicitly recorded licences. This does not relicense the third-party assets below.

## Zotero reader

The Zotero reader is a separate AGPL-3.0 program that WriteFlex loads at run time. WriteFlex remains MIT; the root licence covers its own code and does not cover the reader. The full AGPL-3.0 text and a short README are in `packages/readflex/reader-embed/vendor/`. Included PDF.js components, fonts and libraries retain their own notices there.

Upstream source: https://github.com/zotero/reader. The reader was taken from a Zotero 10.0 pre-release build on 2026-07-26, before 10.0.0 was tagged. The exact upstream commit is not pinned. `vendor/PROVENANCE.json` records the extraction date and file hashes. WriteFlex's changes are included in source form in that folder. The full AGPL-3.0 text is in `vendor/COPYING`. Source will be provided on request through [the repository issue tracker](https://github.com/techczech/writeflex-app/issues).

The local `vendor/reader/reader.html` change replaces three `resource://zotero/` React, React DOM and PropTypes script references with `../lib/` references. The changed HTML is included in source form, with the libraries supplied locally. No reader-internals change is recorded.

## Sounds

The sound pack includes CC BY and CC0/public-domain material. Attribution and processing details are in `resources/sounds/CREDITS.md`.

## App Patterns outline

`@app-patterns/outline` 0.3.0 is MIT licensed, copyright 2026 Dominik Lukeš. The public release archive at `vendor/app-patterns/app-patterns-outline-0.3.0.tgz` includes the compiled module, type declarations and full MIT licence in `package/LICENSE`. Installation uses the archive directly; it does not rebuild the package.

Upstream source and releases: https://github.com/techczech/app-patterns.

## Bridle contract

The Bridle packages are installed from their exact immutable release archives under `vendor/bridle/`. The contract 0.3.1 archive contains its compiled module, declarations and manifest, and does not contain a LICENSE member. All Bridle releases share the separate upstream MIT notice at `vendor/bridle/LICENSE`; its exact 1,071 bytes have SHA-256 `e03b2f3461d86a2d8b396eb5b049d4cc8cbe8bc8b024f4cb56ccbe48164f1c99`. Application packaging copies that notice to `third-party-notices/bridle/LICENSE`. The app-owned contract provenance records its origin in the retired licensed app archive; that archive is retained as private preservation evidence. Published releases use the official archive unchanged.

Pi 1.4.0 is consumed through Bridle's pinned dependencies. The obsolete app-owned Pi 0.83.0 derivative is no longer part of the active dependency or packaging closure. The exact root undici 8.12.2 override applies to the installed graph.

## Vault backup helper

`@app-patterns/vault-sync` 0.5.1 is MIT licensed, copyright 2026 Dominik Lukeš. Its exact 53-member archive is a development-only build input for the separate backup helper. The full upstream MIT notice is shipped at `vendor/app-patterns/LICENSE` and packaged at `third-party-notices/vault-sync/LICENSE`. Upstream: https://github.com/techczech/app-patterns.

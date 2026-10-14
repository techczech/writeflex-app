# Third-party notices

WriteFlex's own source is MIT licensed; integration packages retain their explicitly recorded licences. This does not relicense the third-party assets below.

## Zotero reader

The Zotero reader is a separate AGPL-3.0 program that WriteFlex loads at run time. WriteFlex remains MIT; the root licence covers its own code and does not cover the reader. The full AGPL-3.0 text and a short README are in `packages/readflex/reader-embed/vendor/`. Included PDF.js components, fonts and libraries retain their own notices there.

Upstream source: https://github.com/zotero/reader. The reader was taken from a Zotero 10.0 pre-release build on 2026-07-26, before 10.0.0 was tagged. The exact upstream commit is not pinned. `vendor/PROVENANCE.json` records the extraction date and file hashes. WriteFlex's changes are included in source form in that folder. The full AGPL-3.0 text is in `vendor/COPYING`. Source will be provided on request through [the repository issue tracker](https://github.com/techczech/writeflex-app/issues).

The local `vendor/reader/reader.html` change replaces three `resource://zotero/` React, React DOM and PropTypes script references with `../lib/` references. The changed HTML is included in source form, with the libraries supplied locally. No reader-internals change is recorded.

## Sounds

The sound pack includes CC BY and CC0/public-domain material. Attribution and processing details are in `resources/sounds/CREDITS.md`.

## Dependencies

Installed dependencies retain their own licences. Their notices ship with the dependencies in the packaged app.

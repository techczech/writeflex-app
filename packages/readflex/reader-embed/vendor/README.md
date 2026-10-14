# Zotero reader

This directory contains a separate program licensed under AGPL-3.0. WriteFlex loads it at run time through the reader integration package. WriteFlex's root MIT licence does not cover this program. The full AGPL-3.0 text is in COPYING. Included libraries, PDF.js and fonts retain their own licence notices.

Upstream repository: https://github.com/zotero/reader

The reader was taken from a Zotero 10.0 pre-release build on 2026-07-26, before 10.0.0 was tagged. The exact upstream commit is not pinned. PROVENANCE.json records the extraction date and file hashes. WriteFlex's changes are included in source form in this folder. The full AGPL-3.0 text is in COPYING. Source will be provided on request through [the repository issue tracker](https://github.com/techczech/writeflex-app/issues).

The local change is in reader/reader.html, included here in source form. Its three script references to resource://zotero/react.js, resource://zotero/react-dom.js and resource://zotero/prop-types.js were replaced with ../lib/react.js, ../lib/react-dom.js and ../lib/prop-types.js. Those libraries are supplied in lib/. No other reader HTML change is recorded.

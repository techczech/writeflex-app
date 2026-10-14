# WriteFlex

WriteFlex is a keyboard-first Markdown writing app for macOS and Windows. Open a folder and write in plain Markdown files. It includes Drafting and Reviewing modes, an outline, document history, read-aloud and HTML or Word export.

An optional in-app agent proposes prose changes for you to accept or reject. It can also create and rename supporting files. You need a model account only to use the agent.

## Download and first open

Download an installer from [Releases](https://github.com/techczech/writeflex-app/releases).

- On an Apple Silicon Mac, open the `.dmg` and drag WriteFlex to Applications. Public release builds are signed and notarised.
- On Windows, run the `.exe` installer. Windows builds are unsigned; if SmartScreen warns, choose **More info → Run anyway** after checking the download came from this repository.

Open WriteFlex, choose a folder of Markdown files, or explore the Example collection. On a Mac, press `⌘/` to see the shortcuts. Model sign-in and keys are available in the Agent pane.

## Build from source

Install [Bun](https://bun.sh) 1.3.14 and Node.js 24. On Windows, also install Rust and the Visual Studio C++ build tools for the sandbox helper.

```sh
bun install
bun run typecheck
bun test
bun run build
bun run dev
```

Installation builds the included Bridle and ReadFlex source packages before the app. No private repository is needed. To make an unsigned local Mac app directory:

```sh
bun run build
bunx electron-builder --mac --dir --publish never -c.mac.identity=null -c.mac.notarize=false
```

## Licence

WriteFlex's own code is [MIT licensed](LICENSE), copyright 2026 Dominik Lukeš. The bundled Zotero reader is a separate AGPL-3.0 program loaded at run time; it keeps its own [COPYING](packages/readflex/reader-embed/vendor/COPYING), [README and changed HTML source](packages/readflex/reader-embed/vendor/README.md). Its upstream repository is https://github.com/zotero/reader; the exact upstream commit is not pinned. See [third-party notices](docs/THIRD-PARTY-NOTICES.md) for recorded provenance and how to request source, and the sound pack's [credits](resources/sounds/CREDITS.md).

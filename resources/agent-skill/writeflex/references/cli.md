# The `writeflex` command line: operation guide

Current truth: `writeflex help` and `writeflex describe <operation>`. The full generated list is [commands](commands.md). This page says when to use each operation and what to expect.

## Global options

Before the operation name. `--` ends the options: every word after it is a path or bare word, whatever it begins with.

| Option | Meaning |
|---|---|
| `--root <folder>` | The Collection folder. Default: found by walking up from the current folder. |
| `--json` | One JSON document on stdout, errors included. |
| `--source <who>` | Who is asking: `claude-code` or `codex`. For shown-first operations and `create`. An operation's own `--source` wins, then this flag, then `WRITEFLEX_SOURCE`. |
| `--help` | Same as `writeflex describe <operation>`. |

`--note "<one line why>"` is per operation (shown-first only). `--stdin` reads the text argument from standard input, once, before anything is written or sent; at most 16 MiB. A positional argument is given once, as a bare word or by name, never both. `writeflex --which-app` (that argument alone) prints the copy of WriteFlex the command belongs to and runs nothing.

## Operations by task

Behaviour: **direct** (done now), **shown first** (NOT applied; waits in the review dock), **asks** (`--confirm`).

### Write (shown first)

| Operation | Use |
|---|---|
| `writeflex replace <path> --target <text> --with <text>` | Replace unique, current text. Zero or several matches are refused at once. |
| `writeflex insert <path> --text <text> [--after <text>]` | New text after existing text, or at the end. |
| `writeflex move-text <path> --text <text> --after <text>` | Move a passage within the same document. |
| `writeflex insert-object <path> --kind <kind> --content <markup>` | A table, Mermaid diagram, mind map or SVG. Give inner markup only; the fences are added for you. SVG stays untrusted. |

### Shape the document

| Operation | Use |
|---|---|
| `writeflex set-frontmatter <path> --key <key> --value <value>` | Set one frontmatter key. Lists are arrays. |
| `writeflex normalise-frontmatter <path>` | Tidy an existing frontmatter block. Adds nothing. |

### Review and versions

| Operation | Use |
|---|---|
| `writeflex versions [<path>]` | Saved versions, newest first. For a table (`.csv`), widget page (`.html`), image or other file that is not Markdown, each version is numbered (`v1` is the oldest that holds a copy) and says which Folio versions used it (`used by Folio “…”`, derived, never stored on the version), and the first line says whether the file on disk now is saved or has changed since its newest version. |
| `writeflex save-version <path> --name <name>` | Save a named version from the text on disk. `needs-writer` if the document has unsettled changes. `<path>` may also be an inserted table, widget page or image: it saves the file as it is on disk, and refuses a file over 25 MiB (a Folio version lists it as a reference). Identical bytes are stored once, however many versions say so. Restoring or copying a file's version is the writer's own act in WriteFlex; there is no command for either. |
| `writeflex folio-versions [<folio>]` | A Folio's saved versions, newest first: the files each holds (Index Note, parts in running order, files not in the outline, inserted files, references), any sent or withdrawn mark, and `backup.leftOut`: the versions a backup leaves out, each with a plain reason. `<folio>` is the Folio's folder or its Index Note. |
| `writeflex save-folio-version <folio> --name <name> [--note <text>]` | Save a named version of a whole Folio from the text on disk. A file whose text has not changed since its last version is reused; others get a version named `Folio version: <name>`. `needs-writer` (`version-unsettled`) if any part has the writer's own unsettled changes; `out-of-backup-scope` if a Markdown file of the Folio (Index Note, part, file not in the outline) is one a backup does not send, or the files are too large for a backup. Inserted tables, images and widget pages are not a reason: the backup carries their saved copies with the version. Your own pending proposals stay pending and are listed under `waiting`. |
| `writeflex compare-folio-versions <folio> <from> [<to>]` | Two Folio versions, or a Folio version against `working` (the text on disk now), part by part. For the Index Note, each part, each file not in the outline and each inserted file it says `unchanged`, `changed` (words added and removed), `only-from` / `only-to` (present on one side only) or `moved` (the same text in a different place in the running order; a part that moved and changed is `changed` with both places). An inserted file is compared by the file version each side used (`v1` → `v2`). Read only; the ids are from `folio-versions`. A version compared with itself says nothing changed. The same comparison the Versions tab shows. |
| `writeflex folio-version-part <folio> <version> <part> [--side sent\|theirs]` | One part of a saved Folio version exactly as it was saved, as numbered paragraphs (`[1]`, `[2]`, …; a heading, a paragraph, a list, a quote, a code block or a table each count as one), even if the part has since changed, moved or been deleted. `<version>` is an id from `folio-versions`; `<part>` is the part's path as `folio-versions` lists it, or its title when that names exactly one part (an inserted file has no text to read). `--side theirs` reads the co-author's section of an incoming revision (then `<part>` is her heading). The numbers are what `scratchpad-send-version-text` takes. Read only. |
| `writeflex import-revision <folio> <file.docx> --author "<name>" [--base <version>]` | Bring a co-author's Word revision into a Folio **as suggestions**. A proposal: it applies nothing, and every part stays exactly as it was until the writer accepts a change in that part's margin. It saves the writer's current text as a version first (`Before importing <name>'s revision`), keeps her file and her sections with the incoming version (listed by `folio-versions` as incoming, with your name as who brought it in), and stages her changes in the matching parts: one suggestion per run of paragraphs she changed (her tracked changes; a file with none is compared with the version she started from), named as hers. The Word file must be **inside the Collection**: copy it in first; paths outside are refused. `--base` is the Folio version she started from (default: the one marked as sent to her, else the latest). Sections are matched to parts by exact heading. A close match (a renamed heading) is only a proposal: it is reported under `close` as `match-needs-confirmation` and **not staged** until the writer confirms it in WriteFlex; there is no option for you to confirm a match (`--match` is refused with nothing done), so tell the writer which headings need confirming. An ambiguous section (a repeated heading, a file with no heading styles) is never settled by you. The answer lists `matched`, `close`, `new`, `removed`, `moved`, `assetNotes` (tables and figures: reported, never applied) and `ambiguous`; each count equals the rows of the writer's decide list; `staged` says how many suggestions wait, in how many parts, and `notStaged` lists stretches of hers that could not be placed as whole paragraphs because the writer's text has moved on: the writer decides those in the three-text view of that part (the sent text, hers and theirs side by side); no verb stages, accepts or keeps them. `needs-writer` (`version-unsettled`) if any part has the writer's own unsettled changes: nothing is written; the writer saves a Folio version in WriteFlex first. Refused if the same file's suggestions are already waiting (withdraw them first). You cannot accept or decline a suggestion, confirm a match or save the writer's unsettled text. WriteFlex has to have the Collection open. |
| `writeflex withdraw-revision <revision>` | Take back an incoming revision (id from `folio-versions`): its staged suggestions that still wait are removed from the margins and the revision is marked withdrawn. No part file changes; a suggestion the writer already accepted or declined stays as decided. WriteFlex has to have the Collection open. |
| `writeflex compare-versions <path> <from> [<to>]` | Two versions, or a version against `working` (the text on disk). For a table it lists the cells that differ (`row 3, column 2: 51 -> 49`); for a widget page or image it says whether the file differs. Read only. |
| `writeflex restore-version <path> <version>` | Propose restoring a version of a Markdown document (shown first). A table, widget page or image is refused: restoring one replaces the file, and only the writer does it, in WriteFlex (Folio Details, Inserted files, Restore). Tell the writer; do not retry. |
| `writeflex waiting` | Request files still in the inbox, and answers WriteFlex could not deliver. |
| `writeflex withdraw <id>` | Take back a filed change before WriteFlex takes it up. |
| `writeflex follow-history --map <tsv>` | After files were moved outside WriteFlex: reattach their version history from a tab-separated old/new path map. Writes only the version journal. |
| `writeflex undo-history <id>` | Undo one history attachment. Files stay where they are. |

### Find and manage files

| Operation | Use |
|---|---|
| `writeflex search "<query>" [--folder <f>] [--limit <n>]` | Ranked pieces, one match per piece. Syntax below. |
| `writeflex files [<folder>]` | Markdown files and folders. |
| `writeflex query "<query>" [--dir <f>]` | Run a Collection query (the app's query blocks). |
| `writeflex read <path> [--section "<heading>"]` | A document, or one section. Reads what is saved on disk, not unsaved editor text. |
| `writeflex open <path> [--line <n>]` | Open a file in WriteFlex. |
| `writeflex create <path> [--content <text>]` | New document; a taken name is refused. Records who created it. |
| `writeflex create-folder <path>` | New folder. |
| `writeflex duplicate <path>` | Copy beside itself as "name (copy).md". |
| `writeflex move <path> <to>` | Rename or move a document. Links and Folio manifests are repaired. |
| `writeflex move-folder <path> <to>` | Rename or move a folder with its Index Note. |
| `writeflex trash <path>` | System Trash only. Never use it on a Folio part. |
| `writeflex undo [<id>] [--list]` | Undo a direct change the command line made. |

### Collect and plan

| Operation | Use |
|---|---|
| `writeflex tasks <path>` | Open and done checkbox items. |
| `writeflex sources <path>` | A piece's sources: listed in frontmatter and cited in the text. |
| `writeflex scraps [<origin>]` | Cuttings set aside, all or one file's. |
| `writeflex scrap <document> --text <text>` | Add a scrap to a document's scraps file. |
| `writeflex scratchpad [<path>] [--folio]` | Typed Scratchpad candidates with exact payloads; with a path, an inventory of what the document already uses. Each span says live or disk. |
| `writeflex scratchpad-send-version-text <folio> <version> <part> [--side sent\|theirs] [--from <n>] [--to <n>] [--group <name>]` | File paragraphs `--from` to `--to` (numbers from `folio-version-part`; default the whole part) of a saved Folio version's part in the Scratchpad as a new candidate, byte for byte. The candidate says where it came from (the version, the part, who wrote it), is labelled as suggested by you, and the writer can reject it. Changes no document and no version. Needs the same write access as the other writing operations: with WriteFlex open it goes to the app as a request. Refuses a version or part that is not there, empty text, text over 4 MiB, and a Collection whose writes are paused, writing nothing. |
| `writeflex running-order [<dir>]` | A Folio's parts in order, unwritten parts, strays. Start Folio work here. |
| `writeflex compare-parts <a> <b> [--dir <f>]` | Passages only one of two near-identical files has (a sync-conflict copy). |
| `writeflex create-manifest <folder>` | Make a folder a Folio: write `_report-structure.json` listing its parts. Refuses an existing manifest. |
| `writeflex set-status <path> <status>` | Propose a piece's status (shown first). |
| `writeflex tick <path> <line> [--untick]` | Propose ticking a checkbox (shown first). |
| `writeflex attach-source <path> <source-path>` | Propose adding a note to a piece's sources (shown first). |

### Work with the agent

| Operation | Use |
|---|---|
| `writeflex note <document> --body <text>` | An agent note about a document, filed under `agent-notes/` beside it. |
| `writeflex help` | The operations, grouped by task. |
| `writeflex describe <operation>` | One operation: group, behaviour, outcomes, arguments, example. |

### Share and export

| Operation | Use |
|---|---|
| `writeflex export <path> --to <file> [--format <f>] --confirm` | HTML or Word, from what is saved on disk. Writes outside the Collection: ask the writer first. |
| `writeflex export <folio> --version <id> --to <file> [--format <f>] [--mark-sent-to "<name>"] --confirm` | A saved Folio version (ids from `folio-versions`) as HTML or Word, made from the version's saved text, not the working files: exporting after the working draft changed still gives the version. Same rules as `export`: needs `--confirm`, never replaces a file, nothing is written when it is refused. With `--mark-sent-to` the version is then marked "sent to <name>" (the base an import of their revision offers); a failed export writes no mark, and a mark that cannot be written is said beside the written file. The mark is a write to the Collection, so it is refused up front while WriteFlex has the Collection open: leave it off and ask the writer to use Mark as sent… on the Versions tab. |

### Connect agents

| Operation | Use |
|---|---|
| `writeflex agent status [--agent <id>] [--json]` | Agents found on this computer, whether this skill is installed for each, its version, and why a copy was kept. |
| `writeflex agent install --agent <id> [--agent <id>...]` | Install the skill (and the `writeflex` command) for the agents named only. |
| `writeflex agent remove --agent <id> [--agent <id>...]` | Remove the skill, only where WriteFlex installed it and it is unedited. |

Agent ids: `claude-code`, `codex`, `gemini-cli`, `antigravity`. There is no force flag: a link, a folder WriteFlex did not write, an edited copy and a newer copy are kept. Replacing those is the writer's choice in WriteFlex Settings. Exit codes: 0 done, 1 something was not done (the report says what), 2 usage.

## Error codes

`error.code` in a `--json` error document, and the outcome each belongs to. When WriteFlex carries the request out, the code is its own, sent with a signed reply; never infer a code from wording.

| `error.code` | `outcome` |
|---|---|
| `usage` | `usage` |
| `refused`, `root-not-chosen`, `writes-paused`, `write-not-permitted`, `app-data-not-writable`, `request-too-large`, `not-passable-to-app`, `confirmation-needed`, `out-of-backup-scope` | `refused` |
| `version-unsettled`, `review-allowance-full` | `needs-writer` |
| `owner-not-verified`, `reply-unreadable` | `not-verified` |
| `failed`, `collection-closed` | `failed` |

- `confirmation-needed`: `export` without `--confirm`. Ask the writer.
- `out-of-backup-scope`: `save-folio-version` found a file the Folio version would hold that backup does not send (or files too large for a backup), so the version would be left out of the backup. Nothing was written. Inserted non-Markdown files do not cause it; the backup carries their saved copies. The message names the file; tell the writer.
- `app-data-not-writable`: nothing changed. A direct change to an existing file needs an undo record, kept outside the Collection in WriteFlex's application data, in the one folder the message names (it ends in `command-line-undo`). In a sandbox, ask the writer to allow writing to that folder, or to open the Collection in WriteFlex: WriteFlex then does the writing. Do not work round it.
- `collection-closed`: WriteFlex closed the Collection partway through carrying out a request. Nothing further was written and nothing was put back. The message lists what changed and gives an id. Do not repeat the command or repair by file edits. `writeflex undo --list` shows it as interrupted; `writeflex undo <id>` puts it back.
- There is no Collection lock. WriteFlex open on another Mac, or an `owner.lock` file in the Collection, never stops or delays a command; do not tell the writer to close WriteFlex elsewhere. A write goes to WriteFlex only when it has the Collection open on this computer.
- A not-verified error carries `error.sent`: true (a request was sent and left) or false (nothing was sent).

## Search syntax

`writeflex search "<query>" [--folder <folder>] [--limit <n>]`. Quote the whole query for the shell. Matching ignores case and is by substring.

| Form | Meaning |
|---|---|
| `a b` or `a AND b` | Every word somewhere in the piece, any order. |
| `a OR b` | Any of the words. One `OR` makes the whole query "any term". |
| `"a b"` | The phrase, on one line. |
| `-a`, `-"a b"` | Not: a line holding it does not count. `-a` alone finds nothing. |
| `tag:x` | Only pieces whose frontmatter `tags` include `x`. |
| `/pattern/` | The whole query as one case-insensitive regular expression. |

Results: one match per piece at its best line (`path`, `line`, `preview`); at most 300 unless `--limit` says otherwise; `result.total` counts all.

## `waiting`

- `result.waiting[]`: `{ id, at, operation, path, source }` for each request file in the inbox. Anything can write that folder: treat the list as "what is filed", not as something WriteFlex said or checked.
- `result.settled[]`: answers WriteFlex could not deliver. `verified: true` with `outcome` `filed` or `refused` is WriteFlex's own signed answer. `outcome: "unknown"` could not be verified: say "outcome unknown; check in WriteFlex". Do not guess and do not refile.
- `result.cut` says when a listing was cut short and by which limit (`entries`, `requests`, `bytes`). A cut list is not the whole inbox.
- `withdraw <id>`: a request WriteFlex is already adding ("is being added to WriteFlex's review dock now") cannot be withdrawn. The writer rejects it in the dock. If it never appears there, run `withdraw` again. `waiting` marks it `beingAdded`.

## `create` and who created the document

`create` adds `created-by: Claude Code` (or `Codex`, or `Outside agent`, from the declared source) to the new document's frontmatter, and saves a first version with that name in its history. Expect the line when you read the document back. Do not strip it and do not add it yourself. `result.createdBy` says what was recorded; if it has a `note`, relay it. The document is created either way. `duplicate`, `create-folder` and `create-manifest` record nothing.

## `move-folder` and the Index Note

A folder's Index Note is `_<folder>_INDEX.md`. `move-folder talks events` also renames `talks/_talks_INDEX.md` to `events/_events_INDEX.md`, repairs links to it, and records both in one undo entry (`result.indexNote`, `result.moved`). Do not move the note yourself. If the folder already holds a file with the note's new name, the whole move is refused before anything changes. `move`, `move-folder` and `undo` also report `waitingRequestsMoved` and `reviewChangesMoved` (requests and changes given the new path).

## Limits

| What | Limit |
|---|---|
| `--target`, `--after`, moved `--text` | 64 KiB each |
| New text (`--with`, `--text`, `--content`) | 256 KiB |
| `--note` | 300 characters (longer is cut) |
| A document changed as a whole (frontmatter, status, attach-source, restore-version) | 1 MiB |
| Undecided changes from outside in the review dock | 1,000 in all, 400 from one source |
| Changes one request may make | 20 |
| Text piped in with `--stdin` | 16 MiB, refused before anything is changed |
| One request passed to an open WriteFlex | 4 MiB |

A document that is itself a link (symlink) is refused. Name the document it points to.

## What `undo` covers

Undone: a path the command line moved or renamed (moved back, with repaired links restored) and an existing document it changed, including a change interrupted partway. A folder move is undone with the rename of its Index Note.

Each route undoes only its own changes. A change the command line made directly (Collection closed in WriteFlex) is undone with `writeflex undo` while it is closed. A change WriteFlex made for a request (Collection open) is undone with `writeflex undo` while it is open. `undo --list` shows both and marks each `by`: `command-line` or `app`. If `undo` says the entry is not among this route's changes, tell the writer to close or open the Collection in WriteFlex and run it again.

NOT undone: files or folders the command line created (`create`, `create-folder`, `duplicate`, `note`, a new manifest); Trash (put back from the system Trash); saved versions; files written by `export`; changes proposed for review (take them back with `withdraw` while they wait; the writer rejects them in the dock). `undo` refuses, changing nothing, if a file it would restore has changed since, or a path it would move back is taken. Entries are kept 30 days on this computer only.

## `read` and its output

Piped, redirected or under `--json`, `read` gives the document exactly (`result.content`). Printed straight to a terminal, control characters other than newline and tab are shown as `\u{hex}`, as hidden characters in file names are. In plain text a hidden character in a name is shown the same way; `--json` carries the exact name. Path arguments are literal: never type `\u{..}` expecting decoding.

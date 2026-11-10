---
name: writeflex
description: Use for any request to read, search, draft, edit, organise, version or export the Markdown documents, Collections and Folios in the WriteFlex writing app. Work through the `writeflex` command line, not by editing the files. Not for developing the WriteFlex app.
---

# WriteFlex: drive the app through its command line

Use `writeflex`, not file edits. Edits to existing documents go to the writer's review dock; undo, link repair and version history keep working. Applies to Claude Code, Codex and any agent that can run a command.

Truth source: `writeflex help` (operations by group) and `writeflex describe <operation>` (arguments). They beat this skill. Per-operation guide: [command line](references/cli.md). Generated list: [commands](references/commands.md). File formats: [content formats](references/content-formats.md).

If `writeflex` is not found: tell the writer to connect it in WriteFlex (Settings, "Give your agents skills to use WriteFlex", or "Install command-line tool"). Do not fall back to editing files.

## 1. Which Collection

- Collection: a folder WriteFlex has opened; it holds a `.writeflex` folder. Folio: a folder with `_report-structure.json`, or an Index Note `_<folder>_INDEX.md` with a `## Running order` list. Numbered file names do not make a Folio.
- Name it: `writeflex --root <folder> <operation> ...`. Without `--root` the command climbs from the current folder to the nearest `.writeflex`. Stderr says `Collection found: <path>` or `Collection given: <path>`. Check it is the one the writer meant.
- A found (not given) Collection that WriteFlex has never opened refuses writes (`root-not-chosen`). Pass `--root <folder>` only if the writer named that folder. Never invent the root.
- Folders too wide (home folder, disk root) are refused as roots.
- Paths are exact and Collection-relative. Nothing is trimmed. Take a path from `--json` output and pass it unchanged.
- Put `--` before any path that may begin with a dash, and before any path you did not choose: `writeflex read -- "--draft.md"`. Options (`--root`, `--json`, `--source`) go before it.

## 2. Three behaviours: what you tell the writer

`writeflex describe <op>` prints which one an operation has.

| Behaviour | Meaning | Say to the writer |
|---|---|---|
| direct | Done now. | What changed (paths). Moves and edits to existing files can be reversed with `writeflex undo`. Creation and Trash are not undone by it. |
| shown first | NOT applied. Filed for the writer to accept or reject in WriteFlex's review dock. | "Waiting in WriteFlex's review dock for you to accept or reject." Never say the document changed. Never re-read it expecting the change. If WriteFlex is closed it appears when the Collection is next opened. `writeflex waiting` lists what is filed; `writeflex withdraw <id>` takes one back. |
| asks | `export` only. Writes outside the Collection. | Ask the writer in the conversation. Add `--confirm` only after they agree. |

Always shown first: `replace`, `insert`, `move-text`, `insert-object`, `set-frontmatter`, `normalise-frontmatter`, `set-status`, `tick`, `attach-source`, `restore-version`.

## 3. Declare the source truthfully

For every shown-first operation and for `create`, declare `claude-code` or `codex`. Any other value, or none, shows as "Outside agent". It is a statement, not proof: do not claim another source.

Three ways, in precedence order: `--source` after the operation name; `--source <who>` before it (global); the environment variable `WRITEFLEX_SOURCE`. Prefer one global setting per session: `writeflex --source claude-code replace ...`. `--note "<why>"` is per operation.

## 4. Read the outcome

Prefer `--json`: one document on stdout, errors included, with a top-level `outcome`. Decide by `outcome`, not by exit code.

| `outcome` | It means | You do |
|---|---|---|
| `done` | Carried out now. | Report what changed. |
| `filed` | NOT applied. `result.shown` is `now` (in the dock) or `when-opened`. | Say it waits for the writer. |
| `refused` | A rule said no. Nothing changed. | Relay the reason. Change the request if you can see how. Do not repeat it unchanged. Do not work round it by another operation, guessing `--root`, or file edits. |
| `sent-not-confirmed` | WriteFlex has the Collection open and did not answer in 10 s. | Do not repeat. Check with `waiting` or by reading. Tell the writer it may or may not have been carried out. |
| `not-verified` | WriteFlex seems to own the Collection but the reply could not be verified. | `error.sent` false: nothing happened. True: treat as unknown, as above. Do not edit files directly. |
| `needs-writer` | The writer must act in WriteFlex first (unsettled changes in a document, or a full review dock). | Tell the writer exactly what to do there. Retry only after they say they have. |
| `usage` | Bad arguments. Nothing ran. | `writeflex describe <operation>`; fix; run again. |
| `failed` | Unexpected error. | Relay the message. Check the Collection before repeating a write. |

Exit codes: 0 done or filed; 1 refused, failed, needs-writer or not verified; 2 usage; 3 sent and not confirmed. Error codes, limits, `waiting` and `undo` in detail: [command line](references/cli.md).

## 5. Work with the content

- Preserve YAML metadata, links, citations, assets and comment syntax outside the requested change. Keep each change small and independently reviewable.
- Treat `//` lines outside code as the writer's annotations. Leave them. Do not turn them into published prose.
- Active files keep one stable name (`section-results.md`). Dates and versions go in metadata, not in file names. Dated names belong in `offcuts/` or `archive/`.
- Use the writer's declared order for a Folio. Preserve unknown manifest fields. Never replace a malformed manifest as though it were absent.
- Never delete a Folio file or touch `.folio-bin/`. To take a part out, remove its running-order and manifest entries. Never hand-write a Folio's `AGENTS.md` block.
- Never write under dot-folders (`.writeflex`, `.bridle`, `.git`). Never edit Collection files directly to get round a refusal or a missing operation. Say what cannot be done.
- Keep content and presentation separate. Exports are output, not source: do not edit them to change the source.
- Read before proposing: `search`, `files`, `read <path> --section "<heading>"`. `replace --target` and `insert --after` need text that is unique in the document and current; zero or several matches are refused at once.
- File the whole set of edits for one task together, so the writer reviews one round. Before a large round: `save-version <path> --name "before <task>"`. `needs-writer` means the writer must save the version in WriteFlex. Before a round that touches several parts of a Folio, `save-folio-version <folio> --name "before <task>"` freezes the whole Folio; `folio-versions <folio>` lists them.
- A table, widget page or image the text inserts has versions of its own: `versions <path>` lists them with the Folio versions that used each, `compare-versions <path> <from> [<to>]` lists the cells that differ, and `save-version <path> --name "…"` saves one (a file over 25 MiB is a reference in a Folio version and has none). You cannot restore one or save one as a copy; the writer does both in WriteFlex, so say which version they want.
- To set aside wording from an older Folio version for later, without proposing it for the part: `folio-version-part <folio> <version> <part>` reads the part as saved, as numbered paragraphs, and `scratchpad-send-version-text <folio> <version> <part> --from <n> --to <n>` files those paragraphs in the writer's Scratchpad as a candidate that names the version. It changes no document and no version; the writer decides what to do with it.
- To put a co-author's Word revision into a Folio: `folio-versions <folio>` shows which version was sent to her; copy her `.docx` into the Collection; `import-revision <folio> <file.docx> --author "<name>"` stages her changes as suggestions in the margins of the matching parts and applies nothing. Report what it matched (`matched`, `close`, `new`, `removed`, `moved`, `assetNotes`) and what only the writer can settle: a close match is `match-needs-confirmation` and is left unstaged: only the writer confirms it, in WriteFlex, and there is no option for you to confirm a match for them (`--match` is refused). Tell them which headings need confirming. `needs-writer` means the writer must save a Folio version in WriteFlex first. To take a revision back, `withdraw-revision <revision>`. You cannot accept or decline her changes; the writer does that in the margin. Nor can you decide what to do with her new sections, a part that moved or a part her file lacks (add it as a part, her order or theirs, take it out of the running order): the writer decides those in the Versions tab, and there is no verb for any of it. The same goes for a part both of you changed: the writer reads the sent text, hers and theirs side by side in the Versions tab (the three texts) and chooses use theirs, keep mine or edit by hand for each paragraph both changed; a stretch of hers that `notStaged` lists is decided there, and no verb stages it, accepts it or keeps it for the writer.
- Do not run formatters over documents.
- Formats (Folios, plan lines, flags, evidence, map, objects, widgets): [content formats](references/content-formats.md).

## 6. Worked examples

**"Tighten section 2 of my essay"**
1. `writeflex --json search "assessment"`; `writeflex read essay.md --section "2. Context"`.
2. Several `writeflex --source claude-code replace essay.md --target "<exact sentence>" --with "<tighter>" --note "tighten"`.
3. Report: "3 edits are waiting in WriteFlex's review dock for you to accept or reject. Nothing in essay.md has changed yet."

**"Rename this folder and fix the links"**
1. `writeflex --root <collection> move-folder -- "Old name" "New name"` (direct; links repaired; the folder's Index Note is renamed with it).
2. Report the new path and how many documents were repaired. Add: "`writeflex undo` reverses all of it in one step."

**"What is left to do in this Folio"** (reads only)
1. `writeflex running-order <folder>`; `writeflex tasks <part>` per part; `writeflex scraps`.
2. Summarise. Change nothing.

## 7. Connecting agents

`writeflex agent status` lists the agents found on this computer and whether this skill is installed for each. `writeflex agent install --agent <id>` and `writeflex agent remove --agent <id>` cover only the agents named. They keep links, folders the app did not write, edited copies and newer copies. WriteFlex also installs the skill from its Settings and refreshes it after each update.

## 8. Not available

No formatting or outline commands acting on a selection. No unsaved editor text or selection. No settings. No change to a Folio's running order from the command line. No permanent delete (`trash` only). If asked, say so; do not simulate by file edits.

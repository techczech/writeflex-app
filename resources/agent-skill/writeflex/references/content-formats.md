# WriteFlex content formats

## Folios

The required manifest name is `_report-structure.json`. This is application syntax, not a suggested naming convention. Example for three pieces inside a `contents/` subfolder, in the requested reading order:

```json
{
  "schema_version": 1,
  "content_root": "contents",
  "files": [
    { "path": "02-context.md", "role": "section" },
    { "path": "01-question.md", "role": "section" },
    { "path": "03-conclusion.md", "role": "section" }
  ]
}
```

For pieces beside the manifest, `content_root` is `""`. The `files` array controls order. Existing manifests may carry `output`, `title_matter`, per-file `role`, `render`, `toc` and additional keys; retain them unless the request changes them. New entries should use paths relative to `content_root`. Existing manifests may include that prefix in their paths; preserve working paths rather than normalising speculatively.

## What is a Folio

- A folder is a Folio when it has `_report-structure.json`, or an Index Note `_<folder>_INDEX.md` with a `## Running order` list. Either one is enough.
- `.folio-backup.json` alone does not make a Folio. Numbered file names alone do not either.
- Turning a Folio back into a collection clears both the manifest and the Running order. Clearing only one leaves a Folio.
- A folder has at most one Index Note with a Running order at its top level. When a Folio's contents move in, the incoming one replaces the old one.
- The Index Note, the map and the evidence-and-notes file carry the folder's name. When the folder is renamed, or its contents move to another folder, rename all three to match, or WriteFlex stops finding them.
- A plan line's `[[Title]]` is matched case-insensitively, without `.md`, in three tiers: a file's title (frontmatter `title:`, else the first `# ` heading), then a file name, then an alias. A `[[./path]]` line names the file at that path. A part with only `##` headings and no `title:` is named by its file name.
- After any change, check that every Running order line resolves and that the line count equals the manifest's `files`.

## Folio folders

- Top level: the parts, the manifest, the Index Note, the map, the evidence-and-notes file, `AGENTS.md`, `CLAUDE.md`. Everything else goes in one of five folders, made when first needed. Subfolders at any depth are allowed.
- `data/`: datasets and analysis output. `research/`: what the text relies on (sources, literature, notes on sources, evidence, author notes). `assets/`: images, media, widget HTML. `offcuts/`: words that might go back into a part (cut passages, earlier drafts to reuse). `archive/`: superseded material (old drafts, old exports, dated copies).
- Sort by function, not by file name or type: `research/` if the text relies on it, `offcuts/` if its words might go back into a part, `archive/` if it is superseded and kept for the record. File-type rules apply to loose single files only.
- Keep a self-contained unit together in one subfolder: a report with its widgets, a literature bundle with its CSV. Do not split it by file type.
- A Folio's folders hold supporting material, never another Folio. If you find a folder there with `_report-structure.json`, an Index Note `_<folder>_INDEX.md` with a `## Running order` list, or a `.folio-backup.json`, ask the writer. To undo it: remove the `## Running order` section, rename `_<folder>_INDEX.md` and `_<folder>_MAP.canvas` to plain names, and move `.folio-backup.json` into `archive/` under a plain name. Never delete.
- There is no exports folder. Current exports stay where the writer exported them. Move superseded exports to `archive/exports-<YYYY-MM-DD>/`.
- Captured research units (one Markdown file each, indexed in `research/_manifest.jsonl`) may sit in subfolders of `research/`. After moving one yourself, fix any `sources[].file` value in `research/_manifest.jsonl` that still points at the old location (paths relative to the Folio root). Anything else may use any subfolder.

## Canonical active files

Keep one stable filename for each active document, including working drafts in `research/` and current reading copies: for example, `section-results.md`. Store draft dates, versions and update history in YAML metadata. Do not rename the active file with a date, version, `revised`, `updated` or `final` suffix on each revision.

```yaml
---
title: Results
version: 3
updated: 2026-10-27
---
```

Preserve existing metadata and known history; do not invent earlier creation dates or version numbers. Within the authorised edit scope, update the canonical working file for each revision. Preserve reviewed previous states as snapshots in `archive/` or `offcuts/` before replacing them. When promoting a separate revision to its canonical path, move any displaced file into `archive/` or `offcuts/` first. Dated or versioned filenames are permitted there. Preserve user edits, then repair the manifest, running order, links and move map in the same change. This naming rule concerns active authoring files; it does not authorise a mass rename of historical evidence or imported source files.

## Moving files in a Folio

- A move is one change. In the same change, rewrite every reference to the moved file inside the Folio: relative Markdown links and images, includes, frontmatter `source:` paths, `research/_manifest.jsonl` `sources[].file` (relative to the Folio root, not to `research/`), `[Simulation: …]` lines, and relative links that leave the Folio (recount the `../`).
- Absolute paths and `writeflex://` links in archived records stay as they were; they describe the past.
- Use `git mv` when the Folio is in git. Never delete to tidy; move.
- Write a canonical move map `research/move-map.tsv` in the same change: one row per moved file, old path, a tab, new path, workspace-relative. Keep move dates and versions in the associated record’s metadata. WriteFlex version history is keyed by path, and a move made outside WriteFlex detaches it until it is reattached with that map: `writeflex follow-history --map research/move-map.tsv` does that (it writes only the version journal; `writeflex undo-history <id>` reverses it). Do not edit `.writeflex/` or `.bridle/` to fix history.
- To prove nothing was deleted, check every row of the move map: the new path exists and the old one is gone. If an old path is intentionally reused for the current canonical document, verify the archived previous content and hash and the new canonical document’s provenance and body instead of requiring that path to be absent. Do not rely on git rename detection, which reports a heavily edited moved file as a deletion plus an addition.
- A `*.writeflex-backup` belongs to the file as it was when WriteFlex made it. After files are moved or renamed outside WriteFlex it may describe a different file. Never restore from one by hand.

## Folio manifest

Verify every declared file exists within the intended collection. Missing parts must be reported even if the app quietly omits them. Do not include covers, Index Notes, backups or underscore-prefixed support files, `.canvas` files or anything under `.folio-bin/` as prose chapters merely because they are Markdown. Never infer a Folio from a numbered directory.

`writeflex create-manifest <folder>` derives the initial list and order from existing files and refuses any existing manifest. It does not take an arbitrary chapter order: read the manifest it wrote before claiming an order is satisfied.

## Folio workspace files

WriteFlex opens a Folio as one workspace: tabs Outline, Text, Cards, Map, Flags, Evidence, Files; the binder in the sidebar; an inspector that replaces it. The tabs add no file types beyond those below. Everything an agent reads or edits is a file in the Folio folder.

- **Running order and plan lines.** The Index Note (`_<folder>_INDEX.md`) `## Running order` list is the order of record; the manifest is the export order. Keep both aligned. A plan line is `- [[Part title]] — synopsis #priority-high #label-method #section`. Synopsis is the text after ` — ` (or ` - `). Priority is `#priority-high`, `#priority-medium` or `#priority-low`. A label is `#label-<slug>`, counted only when the Index Note frontmatter `labels:` list (block or inline) has that name. Role is a trailing tag (`#section`, `#vignette`, `#appendix`, `#summary`, `#front-matter`). Other tags stay ordinary. A line whose link points at nothing is an unwritten part (an idea).
- **Status** is the `status` key in each written part's own frontmatter, not on the plan line. An unwritten part has none. Cards groups parts by it.
- **Flags** mark words that need work: `==words==<!--flag:needs-citation-->`, `==words==<!--flag:rewrite-->`, `==words==<!--flag:check-fact-->` and `==words==<!--flag:expand-->`. Flags are found anywhere in the text except code and metadata; they are left out of exports, shared pages, word counts, outline headings and search. Clearing a flag keeps the words. Do not strip flags to publish, and do not add them in code or frontmatter.
- **Evidence and notes** live in `_<folder>_EVIDENCE-AND-NOTES.md`. Sections are `## [[Part title]]`, with `### Evidence` (linked sources: files, workspace notes, archive sources, Zotero items) and `### Notes` (prose). File fingerprints are owned comments `<!--wf:sha1-16=...-->`: never write or change them. Zotero quotation text is read live from its annotation links: keep the links, never invent quote text. Preserve the author's text.
- **Map** is `_<folder>_MAP.canvas`, JSON Canvas: nodes (parts, sources, notes, text cards, labelled clusters) and edges. Keep unknown fields. Only edges labelled exactly `path` propose an order; a path is a proposal until the writer writes it to the running order in WriteFlex. Part metadata comes from the plan, not from map nodes.
- **Reserved files.** `_<folder>_EVIDENCE-AND-NOTES.md`, any `.canvas` file, `AGENTS.md`, `CLAUDE.md`, covers and `_`-prefixed files are never parts and never exported.
- **Folio bin.** `.folio-bin/` (hidden, with `.bin-index.json`) holds files the writer removed from the Folio. Never a part, never exported or shared. Never add to, edit, rename, delete or empty it, and never treat its list as the running order. The writer restores or empties it (WriteFlex never deletes; the writer deletes in Finder). Restore puts the file at the Folio's top level and at the end of the running order.
- **Never delete a Folio file.** To take a part out, remove its entry from the manifest and the Running order; the file stays. The `writeflex trash` command moves to the system Trash and has no bin route: do not use it on a part.
- **Folio AGENTS.md.** WriteFlex keeps a block between `BEGIN`/`END WriteFlex Folio instructions` marker lines current and never changes the author's text below it. Do not edit the block (an edited block stops being refreshed). Follow both parts. WriteFlex writes the block only on Make Folio, or when the writer clicks Restore in the Folio's agent-instructions panel. Never write or repair it yourself. If `AGENTS.md` is empty or has no block, leave it and tell the writer that Restore writes it again. Write your own instructions only below an existing END line.

## Markdown and objects

Retain the file's YAML frontmatter, wikilinks, citation identifiers and relative assets. Edit prose narrowly; do not run a formatter over unrelated content.

A portable pipe table is valid preparation material:

```markdown
| Topic | Decision |
| --- | --- |
| Scope | Keep the introduction |
```

With `writeflex insert-object`, supply inner markup only; the command adds the fences. `writeflex describe insert-object` gives the kinds (table, Mermaid, mind map, SVG). Do not nest an already fenced object inside another fence. SVG content remains untrusted; retain the app's validation and sanitisation path.

WriteFlex post-it annotations are lines beginning with `//` outside fenced or indented code. Preserve them in the working source. The app's export pipeline strips frontmatter and these annotations; a plain copy of the source does not. Keep code comments inside code blocks intact. Before sharing any independently prepared output, inspect the resulting artefact for notes and metadata; do not claim it passed WriteFlex's export pipeline.

## Interactive widgets

A widget is an interactive HTML page (a calculator, a chart, a simulation, a quiz) that runs live inside the document as a block, with a caption bar (title from the file's `<title>`, file name, Reload, Open file). It is one self-contained HTML file inside the Workspace, put in the text by one line.

**The embed line**

- Write it as a line of its own, outside code, lists and quotes, with blank lines around it: `[Simulation: assets/compound-interest.html]`. The path is relative to the document's folder. The wording is the same as TalkWeaver's, so a widget moves between a document and a deck unchanged.
- Typed or pasted HTML in the text is shown as text and never run. Only the `[Simulation: …]` line runs anything. Do not wrap the line in a fence, do not put it inside an HTML block, and do not add words on the same line.
- Only files inside the Workspace run. A path that leaves the Workspace (including through a symlink), a missing file, a non-HTML file or a folder is refused. `[Embed: https://…]` (a web address) is recognised and refused: web pages do not run in WriteFlex; save the page as an HTML file in the Workspace instead.

**Putting one in (the writer's routes)**

- Insert object → Widget… (straight after Image…), or the command **Insert widget…** in the palette: a picker lists the HTML files in the document's folder and below; Enter inserts the line at the cursor.
- Drag an HTML file from inside the Workspace onto the text: the line lands at the drop point. A file from outside the Workspace is refused.
- The command line has no widget operation. To embed an HTML file that already sits in the Collection, `writeflex insert` the embed line (shown first: the writer accepts or discards it). A new HTML file is not a document: write one only when the writer asked you to, into `assets/` beside the document, and say so.

**How to write a good widget (checklist)**

- Self-contained: one `.html` file with inline CSS and JavaScript. Images only as `data:` or `blob:` URLs or inline SVG. No external scripts, stylesheets, fonts or images, and no sibling files. If you need a library, inline it.
- No network of any kind. The widget runs sealed: no `fetch`, `XMLHttpRequest`, `WebSocket`, `import`, and no web address in the page. What keeps it offline is the sealed frame, not a filter: when an agent proposes a page that obviously reaches for the network, WriteFlex refuses it straight away with the reason, but that check only catches the obvious cases, and a page that gets past it still has no network and simply does not work. It cannot read or change the document, other files, storage, the writer's sign-ins or the app; no pop-ups, no navigation. Do not build one that expects to.
- Give it a `<title>`: it is the caption under the widget.
- Compact: the block sizes to its content, so do not fill the screen; a widget taller than about seven tenths of the editor scrolls inside its block. Leave out page margins and big headings.
- Accessible: real `<label>`s on inputs, buttons that are `<button>`s, readable contrast in light and dark, text that does not depend on colour alone, the result in an element a screen reader can read (`<output>` or `aria-live="polite"`).
- Works without the keyboard until clicked: typing belongs to the document until the writer clicks into the widget, which then takes the keyboard; Esc, or a click in the text, hands it back. Never call `focus()` on load or trap Tab or Esc.
- Make something that still makes sense with its defaults showing: the writer sees it before touching it, and in a Word export it is a still picture of that state.

**Exports**

- Do not promise a reader that an exported file carries a working widget until you have checked the export. A Word export holds a still picture.

Treat widget HTML as untrusted code even when you wrote it: keep it in the Workspace, never point a widget line outside it, and do not weaken the sealing to make a widget work.

## Source and app ownership

The application handles snapshots, proposal acceptance, internal history and export models. Ordinary external file edits do not establish those effects. A live buffer and disk can differ: preparing a separate revision is preferable when its current state cannot be obtained. Do not edit app configuration, `.bridle` or `.writeflex` journals, caches or compiled application files during content work.

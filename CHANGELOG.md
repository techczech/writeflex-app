# Changelog

## [0.28.0] — 2026-11-10

<!-- The date is set at publication. -->

Covers everything since 0.22.0, the first public release.

### Added

**Sharing and readers**
- Share a piece or whole Folio read-only through multiple named browser links, each with its own comments and limits, Copy link, and on/off.
- Set up, update and remove the sharing service inside WriteFlex; tokens are stored encrypted in the system keychain. Sharing uploads to your own Cloudflare account.
- Use a domain held on the same Cloudflare account for links; earlier service-address links keep working.
- Saves and external edits republish shared writing, images and Folio running-order changes; offline changes catch up on return, with last-success and Retry information on failure.
- The Shares list shows links across the collection, their settings, opening counts and waiting or handled comments.
- Readers select words to comment or propose an edit, keep their name in the browser, and queue comments offline.
- Reader comments and edits arrive as review cards attributed to the reader and link. Only your Accept changes prose. Limits have Clear, Raise for this share and Turn comments off.
- Private or open discussion per link; readers of an open link see one another's comments and edits.
- Sharing links, reader edits, replies and handled states work across Macs on the same Cloudflare account and synced workspace.
- Open reader pages receive discussion within about ten seconds and refresh published text while keeping the reading position.
- Named people with individual links by email: opening and comment counts, on/off, New link and Remove.
- Email invitation opens a prepared draft in your mail app and sends nothing itself.

**Reviewing**
- Review cards aligned with their passages, showing source, kind, time and unread marks, with replies, Accept, Decline, Done and More.
- A status-bar review line with counts, All / Comments / Edits, navigation, filters, bulk actions on picked cards, Held both, Send back and Save version.
- Settled today and My edits show past decisions and recorded changes, with Reopen and Return to review. Other-piece waiting lists, sidebar counts and Next piece with items waiting.
- Accept all / Decline all for the suggestions of one outside agent across the collection.
- Suggest / Work / Read only for agent behaviour, with a numbered turn strip and turn Undo.

**Folio planning**
- Cards, Table, Map, Flags, Text and Evidence views; cards group by status with drag and keyboard moves; split editing puts text beside cards.
- Edit part synopses, labels, status and priority; manage Folio labels; start unwritten parts; add cards by title.
- Select several parts and remove them from the running order and export while keeping their files, with Undo.
- Reorder cards or rows by drag or keyboard, with placement notices and Undo.
- Flag selected words as Needs citation, Rewrite, Check fact or Expand; filter, jump to or clear flags.
- Attach files, notes, archive sources and Zotero items to written or planned parts; keep quotations, insert citations, spot evidence gaps.
- Map parts, sources, notes, cards, clusters and labelled arrows; preview a path and write its order, with Undo.
- Folio Details for title, standfirst, author, date, status, audience and language.
- Front matter as a block before the chapters, kept out of contents; title pages become covers; per-part roles, Put back, Add all and Sort by chapter number.
- Section pages group the parts that follow them; optional page breaks and section contents.
- Turn back into a collection and Make Folio restore a Folio's running order.

**Versions and reviewers' files**
- Save versions of a whole Folio, including inserted files frozen for Git backup. Versions lists saved Folios and their parts.
- Changed-part dots, a status-bar count and a working-draft row compare the current Folio with its latest saved version; read old Folios read-only.
- Compare any two Folio versions, or a version and the working draft, part by part, including from the command line.
- Take one old part's text as a margin suggestion, optionally keeping today's text in the Scratchpad.
- Export a saved version to HTML or Word and mark who it was sent to.
- Send selections or paragraphs from old versions and comparisons to the Scratchpad, with Open in that version.
- Import a reviewer's returned Word file as an incoming version; tracked changes, or a comparison with the sent text, become named suggestions.
- Decide lists the suggested changes and the added, moved and removed parts of a returned file, tracks your decisions and offers a version when you finish.
- Side-by-side sent, reviewer and current paragraphs with Use theirs, Keep mine and Edit by hand.
- Versions of inserted CSV, image and HTML-widget files: save, compare, restore, or save a separate copy.

**Scratchpad and reuse**
- The Scratchpad keeps exact Markdown selections or heading sections; float, dock, collapse, group, search, preview, mark done, colour, reject and restore.
- Insert a copy and Put back, following editor Undo and Redo.
- Browse pictures, SVG, tables and widgets used in a document or Folio, with Show in document and Add to Scratchpad.
- Browse Folio sources and evidence, Zotero and archive candidates; insert a quote with citation, cite, link or attach to a part.
- Compare two to four candidates side by side.
- Optional TalkWeaver vaults and SlideWell search, each off by default.
- Capture selected or clipboard text to research files with `scout capture`.
- A record-browser widget; widget folders for standalone documents; support for copying and syncing outside files.
- Filter the Reading Room Shelf by Zotero collection.

**Backup, sync and history**
- GitHub sign-in and automatic per-vault Git backup, with destination and scope confirmed first. Experimental: not yet proven with a real GitHub account from the installed app.
- OneDrive writes enter local recovery before they sync; Versions, Compare and Restore include text held only on this Mac.
- Reconcile proven sync copies: both texts are kept, identical or superseded copies are set aside recoverably, and non-overlapping edits merge.
- Merge compares your text and the disk text with their shared original and offers Keep mine, Take disk or Keep both.

**Finding, details and agents**
- Make a vault: previewed structure and status mapping, writing-only and title views, ordered pins, vault switching and palette actions.
- Collection page search, filtering and bulk actions.
- Document metadata with labelled fields, workspace suggestions, tag chips and protected system fields; Edit as Markup remains.
- External agents read and propose through `writeflex`; suggestions arrive for review. Folio context includes synopsis, labels, priority, status, evidence and flags.
- Folio agent instructions written to AGENTS.md and CLAUDE.md, separately or together.
- Install the WriteFlex skill and command for Claude Code, Codex, Gemini CLI or Antigravity agents you choose; `writeflex agent status|install|remove --agent <id>`.
- Diary glance in the rail with today's words, day number and fourteen days of activity; saved queries across workspaces with project, date and word filters.
- Check for Updates in the menu, palette and Settings; What's new ships with the app.
- Quick-open matches titles and filenames loosely, includes and marks hidden files; sidebar filter field.

**Export**
- Contents depth per piece or Folio, with presets and All levels.
- Export detects a Folio export order that differs from its running order; Make export follow the running order repairs it, and Export anyway keeps it.
- Exported pages have a Contents button on phones that closes on heading selection or Escape.
- Fix a title and leading-heading disagreement in either direction, for one piece or a Folio, with Undo.

### Changed

- Versions, Agent and Research share one Right Sidebar, which starts closed once after updating and then remembers your choice. Agent notes live in Agent; Archive is a Research scope. Labels use vault, Left Sidebar and Right Sidebar.
- Track my changes is one on/off toggle replacing the Drafting and Reviewing mode names. Review names the margin; proposals use Accept / Decline.
- Notes are called Comments throughout the app and the reader page. Existing comments and links stay readable.
- The Review tab, dock review area and bar above the text are replaced by margin and status-bar controls. Earlier margin-position choices reset to Margin; Inline replaces Under.
- Plan is renamed Folio outline. Folios open into text, Manage Folio holds the planning views, and the separate Folio page and Board route are gone. Earlier outline views are called Table.
- The Left Sidebar has one Outline tree; Folio parts and unwritten parts are named consistently, and Contents counts written parts.
- Delete moves Folio parts to the Folio bin with Undo; Restore recovers them, and Show bin in Finder leaves permanent emptying to you.
- One Folio per project; creating a nested or parent Folio is refused.
- Focus and readability separates text effects from the Line focus and Ruler overlays, allowing one of each.
- Renaming or moving a shared piece keeps its links; moving it to Trash ends them and removes its published copy. External deletion pauses publishing as Piece not found.
- Anyone with the link can be disabled so that only personal links work; it starts on for new and existing links.
- Shared Folios show cover metadata, nested collapsible contents, reading position, a phone Contents control and right-column comments. Existing pages adopt the layout after you update the service and publish again.
- The reader proposal box says Edit selected text here and its comparison says Preview of changes.
- The collection lock between synced Macs is removed; two Macs can open and save the same synced folder, with conflict checks, history and local undo kept.
- History defaults to retention forever, which uses more disk until you change it.
- Scratchpad's status-bar chip counts candidates and opens a closed sidebar; expanded, it docks in the Right Sidebar unless you choose Float.
- The Reading Room sends highlights, colours, comments and deletions to open Zotero through WriteFlex for Zotero instead of writing Zotero's library directly. Install the bundled plugin and close PDFs in Zotero first.
- Start lists vaults in their own rows with location, counts and last opening; Dashboard groups folders before files.
- Sidebar file search lists ranked matches with folders and takes `fo:`, `fi:`, `met:` and `da:` filters; Escape restores the previous tree.
- Compact title-bar icons, one-row sidebar headers, one Manage Folio bar and status-bar notices leave more room for writing. Below 1260 pixels the sidebars take turns. Favourites is merged into Pinned.
- Main-area modes use Back and Escape. One in-app confirmation card replaces browser and system prompts; Restore confirms; Settings Reset offers Undo.
- Menus consistently show Settings, Export, Share and themes, with Help last.
- HTML and Word titles, covers, browser titles and suggested filenames use the declared title or Folio Details first. Front matter stays out of contents and the title appears once. Output filenames and headings may differ from earlier exports.
- Exported HTML now contains one small script for the phone Contents menu; contents links also work without JavaScript.
- Opening large folders, typing in long documents, autosave and Folio operations are faster. In recorded tests, opening a 3,934-file folder went from 7.8 to 2.5 seconds and visible keystroke latency in a 20,000-line document from about 1.1 to 0.09 seconds. These are specific tests, not general figures.
- Electron updated to 43.8.6; patched bundled dependencies include the agent runtime's HTTP and discovery libraries.

### Fixed

- Wide tables scroll inside their boxes on phones; Cloudflare setup names the cause of a connection failure, and an unconfirmed custom address says Address not attached with a working Try again.
- Metadata changes apply only if the complete original metadata still matches; unrelated body edits do not block them.
- Surrounding words locate an edit when the same words occur more than once. An Accept that cannot be placed stays waiting rather than recording Declined; a failed Decline reports why.
- Outside suggestions and counts stay with the correct document or Folio; empty margins no longer squeeze prose because work is waiting elsewhere; More menus open left; passage outlines are lighter.
- File links survive title edits and renames; older Folios link unambiguous parts once on opening, with Undo. Missing or ambiguous parts stay visible with Locate file and Link to a file.
- Parts outside a content subfolder still appear in order; missing parts keep their entries and do not block reordering. Other files open their own text without changing the selected part.
- Folio refreshes keep evidence forms, notes, Map and current text; dragging keeps the grabbed part, waits through refreshes and cancels safely.
- Nested folders offer breadcrumbs, Up a level and Return to Folio. Broken outlines open as editable text, and an existing Folio never gets a second Index Note.
- History follows moves and renames, including case-only renames; ambiguous history is held for Attach here.
- Backup restoration checks the recorded file identity and asks when it is missing or different. History of a moved vault can confirm exact earlier locations on this Mac, followed by a separate preview and Turn on; the original history is unchanged.
- Ambiguous moved-file history can be reattached from the command line or by an agent only after you approve the exact move list; orphan backup records move into `.writeflex/` without deletion.
- Sync-created copies of version, change and Bridle journals and Folio completion records stay readable; late saves and closed-window flushes keep their own recovery.
- Saving, recovery, proposal acceptance, renames and planning operations refuse to overwrite content changed on disk; failed multi-file operations roll back only their own writes and report files that changed meanwhile.
- Vault switches wait for saves and the new window, time out safely, and closing records pending edits across documents.
- Put back Undo and Redo restore text and placement without replaying a spent suggestion or creating a false disk conflict.
- Nested document pictures resolve beside their file.
- The Reading Room's library-wide list survives initial draft binding.
- Word and HTML use the same Folio parts and order, including content subfolders; Export defaults to the whole Folio. Contents indent each heading level and nest chapter continuations as the Outline does.
- Leading part titles do not repeat in the running order, headings are recognised at any level without a duplicate proposal, moving a part keeps its nested notes and code, and captured links update immediately.
- Sidebar drags reserve at least 55% for the editor and narrow the left side only as far as needed; a late update cannot reopen a sidebar you closed; overlays collapse only over the caret.
- Settings opens at the top, metadata has more editing space, the archive footer wraps, and status controls hide whole, leave the keyboard focus order and remeasure when neighbours change width. Renamed commands still resolve in saved shortcut history.
- Command-[ and Command-] toggle the left and right sidebars consistently in Folio management and editing; widgets respect Command-W and Command-Q, and Escape ends engagement.
- Viewing an earlier version and one harmless drawn-object layout notice no longer show Something broke; real errors still reach recovery. New-file and sidebar row controls stay reachable in narrow windows.

## [0.26.0] — 2026-10-21

### Added

- **Sharing by link.** You can share a piece or a Folio read-only with anyone who has a browser. The Sharing page lists a piece's links, each with its own name, address and limits, and lets you copy a link or turn it off and on again at the same address; a Folio link shows the parts in running order with a contents list. The Shares list one level up shows every link in the collection, with when it was made, how many times it was opened and how many comments are waiting.
- **Set up sharing from inside WriteFlex.** Paste a Cloudflare token, pick the account and press Set up sharing. WriteFlex stores the token encrypted in the system keychain and installs the sharing service on your own Cloudflare account. Settings › Sharing offers Update for an older service and Remove sharing, which deletes the service and everything in it from your account.
- **Shared pages follow the piece.** Each save reaches the reader page within a few seconds, and renaming or moving the piece keeps its links. Moving it to Trash ends them and removes the published copy. A piece deleted outside the app is marked "Piece not found" and nothing is removed.
- **Your own address for links.** If you hold a domain on the same Cloudflare account, you can pick it and type a name in front of it, such as `drafts`. Links sent on the earlier address still open.
- **Readers can comment and propose edits.** On the reader page a reader selects words and chooses Comment or Propose edit; the reader's name is kept in that browser, and a comment written offline is sent when the reader reconnects. Readers see only their own comments.
- **Readers' comments arrive in the review margin.** Each comment and proposed edit is a card with the reader's name and the link's name. Only your Accept changes a piece, and it changes exactly the proposed words; an edit on text that has since changed cannot be accepted. Your outcome (Accepted, Declined, Done or Could not be applied) and any reply are shown to the reader the next time the page loads.
- **Review changes beside the text.** Each waiting change is a quiet card level with its words, joined to them by a leader line. The words are highlighted in the text (violet for edits, amber for comments) with the card's number. Pointing at a card shows Accept and Decline, or Done and Reply; focusing it shows the thread and more actions. The Review tab and the Review bar above the text are gone.
- **A review line in the status bar.** When something is waiting, the status bar shows the count, All / Comments / Edits, and previous and next arrows. The count menu holds bulk actions (Accept all edits, Mark all comments done, Decline all, Send back to the agent) that act only on the items shown or picked, and Decline all asks first. Settled today and My edits show what you have already settled or edited, and a list shows other pieces with items waiting (⌃⌥⌘G goes to the next one).
- **Margin or Inline.** The cards sit in the margin whenever at least 400 pixels are left for the text, and move under their paragraphs otherwise. A Margin | Inline switch (⇧⌥⌘V) sits next to All / Comments / Edits, and the reader page has the same switch.
- **Agents can propose changes from the command line.** Claude Code, Codex or another agent can read the collection with `writeflex` and propose changes, which arrive in the margin as cards. With WriteFlex closed the command line can write directly, with undo.
- **Agent instructions for every Folio.** Each Folio gets an AGENTS.md and a CLAUDE.md that tell any agent in the folder how the Folio works; an AGENTS.md you already had keeps your text and gains a WriteFlex section. A pill beside Open Folio writes either file or both, and the same three writes are palette commands.
- **Vaults.** Make this folder a vault… previews what WriteFlex found and what it will hide, then writes one file, `.writeflex/vault.json`, in the folder. In a vault the sidebar can show only your writing and each work by its title, folders and documents can be pinned in an order you can drag, and the name at the top of the sidebar switches between vaults and recent folders. The start screen lists each vault in its own row with its name, location, number of works, number in progress and when you last opened it.
- **Open Folio.** Clicking a Folio in the file list shows its page with an Open Folio button (⌘↩) that opens the first part with the Folio outline in the sidebar. The page has the running order in the main column and the Details card, the selected part's settings and the front matter in a side rail. Files in the Folio's folder that are not in the running order are listed under Not in the outline, with Put back.
- **A Details card for a Folio.** One card holds the Folio's title, standfirst, author, date, status, audience and language, saved in the Index Note's header. Status, Date, Author, Audience and Language are picked from lists (Date from a calendar), and the exported cover shows what you picked.
- **Front matter, and a title page that is the cover.** A part is front matter when its running-order line is tagged `#front-matter` or the manifest gives it that role. Front matter comes first, is never listed in the contents, and a Folio's title page becomes the HTML export's cover.
- **The sidebar Outline shows a Folio's headings across files.** Outline → Folio lists every part's headings as one flow, with a dashed line naming each file where it starts. A part that opens one heading level deeper than most parts is listed under the chapter before it, and the HTML contents uses the same tree.
- **Fix a title that disagrees with its heading in one click.** When a document starts with a heading and its `title:` differs from that heading, the warning offers "Use heading as title" and "Use title as heading", for one part or for every part at once; Undo takes each back. A heading further down the document is never compared or changed: if the document does not start with a heading, Use title as heading adds the title as a `#` heading at the very top. A part whose first line is a first-level heading takes it as its title, and a part without one gets a proposed heading to accept.
- **Contents depth in the Export sheet.** Choose how many heading levels the HTML contents lists, from Level 1 only to All levels. WriteFlex remembers the choice for each Folio or document in its header.
- **Chapter order, Add all and Sort by chapter number.** Files are ordered by the number anywhere in the file name, so `chapter-2` comes before `chapter-10`. In the Folio outline, Add all from this folder adds every file not yet in the running order in one undoable step, and Sort by chapter number reorders the running order by those numbers.
- **Capture to research…** Files a title, kind, optional prompt and body (your selection or the clipboard) as its own file in the `research/` folder beside the piece, through the `scout capture` tool, and indexes it for search. Needs `scout` installed.
- **Merge when a file changes on disk.** When a file you are editing changes on disk, Merge shows your version and the disk version against the one they both began from. What does not overlap is combined on its own; each place where both changed is a card with Keep mine, Take disk or Keep both. Both versions are kept in History first, and Cancel writes nothing.
- **A collection page.** A collection's page lists its pieces with search and filters, and lets you change several pieces at once.
- **A document metadata panel.** Labelled fields, suggestions from the workspace, tag chips and protected system fields replace the key/value form. Keys WriteFlex does not know, such as those from imported pieces, are always kept and shown as ordinary fields; editing one field never changes another. Edit as Markup is still available, and edits keep comments, unknown values and body text.
- **More from widgets.** There is a standard record browser widget for the records of a document or folder. A widget in a single document gets its own folder and the document moves into it, and a file from outside the Folio can be brought in as a copy or kept in sync. One undo takes each step back.
- **Focus and readability.** The Focus picker has two columns, one for text readability (fade other paragraphs, highlight sentence, segment focus, sentence breakup, anchored reading) and one for overlays (Line focus and Ruler). One choice from each column can be on at once.

### Changed

- **The Plan is called the Folio outline, and Notes are called Comments.** The names change in buttons, menus, messages, the Guide and the shortcut sheet; shortcuts, saved files and existing comments are unchanged.
- **Exports use the declared title.** HTML and Word exports of a Folio or a piece take their title from the declared title, then the first heading, then "Untitled", for the browser title, masthead, contents and suggested file name. A Folio's HTML contents lists chapters as the top rows, with front matter left out.
- **Big folders open faster and typing keeps up.** On a copy of a 3,934-file folder, opening took 2.5 s instead of 7.8 s. In a 20,000-line document a keystroke shows in about 0.09 s instead of 1.1 s, and a save no longer re-lists the folder.

### Fixed

- **WriteFlex writes only over the version of a file it read.** Before, ordinary saves, error recovery, accepting or redoing a suggestion, renaming and several other steps could write over a file another program had changed on disk. Now nothing is written in that case, and the notice above the text offers Reload or Keep mine. A step that changes several files and fails partway puts back only the files WriteFlex wrote.
- **Accepting an edit applies it in the right place.** An edit whose old words occur twice in the piece is placed by the words around it. If the place cannot be found, the item stays waiting with a message, instead of being recorded as declined.
- **"Something broke" no longer appears for two harmless causes.** Showing an earlier version that was shorter than the current text, and opening a page with drawn objects, could each put up the crash screen.
- **Tables fit a phone screen on the reader page.** A wide table scrolls inside its own box instead of pushing the page sideways.
- **Sharing set-up reports problems accurately.** When Cloudflare could not be reached, the details now name the cause in one word. If attaching your own address timed out, Settings › Sharing says "Address not attached" and Try again finishes the job.
- **Folio exports and the Folio page.** Word export of a Folio contains the Folio's parts, in the same order as HTML. Inside a Folio the Export sheet opens on the whole Folio. The Folio title appears once in an HTML export. The Folio page no longer offers to start an outline for a Folio that exists, and WriteFlex never creates a second Index Note.
- **Smaller fixes.** The New file (+) button is no longer cut off in a narrow window, and a decline that cannot be applied now says so. A link turns into a normal link as soon as Capture creates its note. Settings › About shows the current release notes. Esc ends a widget's engagement.

### Known issues

- A reader's answer to your reply on a shared page does not appear in the thread yet.
- Pages shared before the current sharing-service build keep the old table layout until the piece is saved again.
- A piece shared from one Mac shows as not shared on another Mac.
- A different file put in place of a shared piece under the same name is treated as the same piece.
- Undoing an agent's turn can replace an edit you saved after that turn.
- Repairing links after a rename writes without checking whether the linking files changed on disk.

## [0.22.0] — 2026-10-14

### Changed

- Line focus and the Ruler can follow the typewriter line, with or without Typewriter mode enabled.

### Known issue

- Saving over a file changed outside the app remains possible through some error-recovery and concurrent-change paths. Keep a separate backup of important writing.

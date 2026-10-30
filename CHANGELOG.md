# Changelog

## [0.28.0-alpha.1] — 2026-10-29

### Added

- A floating Scratchpad keeps formatted paragraphs and section fragments for later review and reuse. It can dock beside the document or collapse to a pill, with groups, search, previews and side-by-side comparison.
- Insert a copy keeps the candidate. Put back is available for recorded cuttings and follows editor Undo and Redo. A cut is saved before text is removed, and existing scraps remain readable.
- Browse pictures, SVG graphics, tables and compatible widgets already used in a document or across a Folio. Collect candidates, preview them and show their location in the document.
- Review Folio references and evidence beside the text, with actions to cite, link, insert a quote with its citation or attach evidence.
- Optional TalkWeaver vault browsing and SlideWell search have separate switches in Settings, both off by default. Insertion copies the chosen asset into the writing workspace and retains its source.
- Folio section pages group the parts that follow them in the running order and outline, with optional section-page export settings.

### Changed

- Updated the Electron runtime and patched bundled dependencies, including the agent runtime's HTTP dependency through a reviewed MIT derivative that changes its dependency pin.

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

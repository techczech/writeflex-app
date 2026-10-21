# Write

These are the notes for a piece about a walk: out of the village, over the wold and back through the wood. Use them to try the commands for writing. Where a command has no key, its name is in bold: put the caret where the instruction says, press <kbd>⌘K</kbd> and choose it from the list.

> **Format text.** Select **nearly seven** in the paragraph below and press <kbd>⌘B</kbd> for bold, <kbd>⌘I</kbd> for italic or <kbd>⌘E</kbd> to mark it. <kbd>⌥⌘K</kbd> makes the selection a link. With words selected, <kbd>⌘K</kbd> also offers **Strikethrough**, **Inline code** and **Clear formatting** in its Format strip (**Inline code** sets the words as code; **Clear formatting** takes bold, italic, strikethrough, mark and code off again), and **Change case…**, which holds **UPPER CASE**, **lower case** and **Title Case**. Select the line that begins **Check the distance** and press <kbd>⌥⌘/</kbd> to turn it into a comment. With the caret in a paragraph and nothing selected, the same commands are under **Format**.

The walk is four miles if you go by the road and nearly seven if you go the long way. I have always gone the long way.

Check the distance on the map before this goes to the magazine.

> **Quotations and plain paragraphs.** Put the caret in the line that begins **You can't hurry** and choose **Blockquote** to set it as a quotation. **Make this a plain paragraph** turns a quotation, a heading or a list item back into ordinary text. **Turn into…** on a quotation also offers **Heading**, **Bullet list**, **Numbered list**, **Task list** and **Code block**, and does it in one step.

You can't hurry a wall, the waller told me, and you can't hurry the walk up to it either.

> **Edit lines.** Put the caret on the line **The third is hardly a stile at all,** and press <kbd>⌥⌘J</kbd> to join it to the line below. <kbd>⇧⌘D</kbd> duplicates the paragraph or list item the caret is in, with the items under it, and puts the caret in the copy; **Delete block** in <kbd>⌘K</kbd> removes it again without asking, and <kbd>⌘Z</kbd> brings it back (<kbd>⇧⌘Z</kbd> does it again). **Duplicate Line**, from the command palette, copies only the line the caret is on. Select the word **stile** and press <kbd>⌘D</kbd> to select the next place it appears as well, so that what you type changes both. <kbd>⇧⌘←</kbd> and <kbd>⇧⌘→</kbd> select to the start and the end of the line, <kbd>⇧⌘↑</kbd> and <kbd>⇧⌘↓</kbd> to the start and the end of the file, and <kbd>⌘A</kbd> selects all the text. **Copy source** belongs to an object such as the table at the end of this file: put the caret on the table, press <kbd>⌘K</kbd> and choose it to copy the table as Markdown.

## The stiles

There are three stiles on the way up. The first stile is new and still smells of creosote. The second stile is a ladder stile, grey with lichen, and someone has cut a notch in the top rail for a dog to get through.

The third is hardly a stile at all,
just two stones set on end with a gap a sheep cannot manage.

> **Insert objects.** Put the caret at the end of the paragraph under **The route**, press <kbd>⌘K</kbd> and choose Insert object. The list holds **Metadata**, **Image…**, **Code block**, **Flow diagram**, **Mind map**, **SVG**, **Divider** and **Footnote**; **Insert widget…** adds a widget, which is shown just below. **New record browser…** makes a widget from a CSV or JSON file, **Edit record browser…** reopens it, and **Undo last widget step** takes the last widget step back. Insert a **Flow diagram** and draw the route in it: village, second stile, wold top, wood, village. **Metadata** puts a block at the top of the file for facts about the piece, such as its date and status. **Show metadata** opens its labelled fields and workspace suggestions; **Collapse metadata** reduces it to a summary, remembered for this workspace.

## The route

Out by the church path, up the hedgerow to the second stile, along the wall to the top of the wold, down through the hanging wood and back in by the mill.

> **A widget.** The box below is a widget: a small interactive page, kept in the file beside this one. Click it once to give it the keyboard, move the sliders to see how the time changes, and press the Esc key to hand the keyboard back to the text. To add one of your own, run **Insert widget…** from the command palette, or see **11 Objects** for that and every other object.

[Simulation: assets/walking-pace.html]

> **Change an object.** With the caret on an object, <kbd>↵</kbd> opens it for editing, and <kbd>⌘K</kbd> offers **Turn into…**, which holds **Text** and **Code block**, and **Delete table** or **Delete block**. On a code block **Turn into…** also holds **Flow diagram**, **Mind map** and **Table**; on a paragraph it holds **Code block**, which puts the paragraph in a fence; on the metadata block <kbd>⌘K</kbd> offers **Edit metadata**. Select the list under **Things to notice**, press <kbd>⌘K</kbd>, choose **Turn into…** and then **Mind map** to turn them into a mind map.

## Things to notice

- Hedgerow
  - Hawthorn
  - Blackberries
- Walls
  - Dry stone, no mortar
- Weather

> **Lists and checkboxes.** Select the three lines under **Things to carry**, press <kbd>⌘K</kbd>, choose **Turn into…** and then **Bullet list**; with the list selected, **Numbered list** numbers it. With the caret on a list item, <kbd>⌘K</kbd> then **Turn into…** offers **Bullet list**, **Numbered list**, **Task list**, **Lettered list (a. b. c.)** and **Roman list (i. ii. iii.)**. On a paragraph, **Turn into…** offers **Task list** too: select the three lines under **Things to carry** and it makes one task of each. Choose the **Task list**, then press <kbd>⌘↵</kbd> on an item to tick it. <kbd>⇥</kbd> moves an item in a level, with the items under it, and <kbd>⇧⇥</kbd> moves it back out.

## Things to carry

A flask
A waterproof
The map, folded to the right square

> **Tables.** Put the caret in a cell of the table below and press <kbd>⌘K</kbd> and choose **Column**. **Align left**, **Align centre** and **Align right** set the column the caret is in. **Insert column left** and **Insert column right** add a column beside it, and **Delete column…** removes it after asking. To make a new table, press <kbd>⌘K</kbd>, choose **Insert object…** and then **Table**. On a code block, <kbd>⌘K</kbd> then **Turn into…** also offers **Table**. **Turn into a table**, from the command palette, makes the paragraph the first cell of a new table.

## The stages

| Stage | Miles | What to look for |
| --- | --- | --- |
| Village to the second stile | 1 | Hawthorn and blackberries |
| Second stile to the wold top | 2 | Dry stone walls |
| Wold top to the hanging wood | 2½ | Weather from the west |
| The wood to the village | 1½ | The roofs, one at a time |

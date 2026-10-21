/* Vendored from the single-html-document feedback runtime. Media, screenshot, audio,
   attachment storage, edit-diff generation and workbook helpers are deliberately omitted. */
(function attachWriteFlexReaderNotes(globalScope) {
  "use strict";

  function createId(prefix) {
    if (globalScope.crypto && typeof globalScope.crypto.randomUUID === "function") {
      return `${prefix}-${globalScope.crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function createTextAnnotation({
    documentId,
    targetId,
    sourceRef = "",
    quote,
    note,
    contextBefore = "",
    contextAfter = "",
    startOffset = null,
    endOffset = null,
  }) {
    const trimmedQuote = String(quote || "").replace(/\s+/g, " ").trim();
    const trimmedNote = String(note || "").trim();
    if (!documentId || !targetId || !trimmedQuote) return null;
    const createdAt = new Date().toISOString();
    const annotation = {
      id: createId(`${targetId}-annotation`),
      documentId,
      targetId,
      sourceRef,
      quote: trimmedQuote,
      note: trimmedNote,
      contextBefore,
      contextAfter,
      createdAt,
      updatedAt: createdAt,
    };
    if (Number.isFinite(startOffset)) annotation.startOffset = startOffset;
    if (Number.isFinite(endOffset)) annotation.endOffset = endOffset;
    return annotation;
  }

  function buildInteractionExport({ documentId, annotations }) {
    const payload = {
      singleHtmlDocumentFeedbackVersion: 1,
      documentId,
      generatedAt: new Date().toISOString(),
      reviewer: "anonymous",
      annotations,
      edits: [],
    };
    return { ...payload, encodedSizeBytes: new Blob([JSON.stringify(payload)]).size };
  }

  const manifestElement = document.getElementById("writeflex-interaction-manifest");
  if (!manifestElement) return;
  const manifest = JSON.parse(manifestElement.textContent || "{}");
  if (!manifest.annotations?.enabled || !manifest.documentId) return;

  const targetIds = new Set(manifest.annotations.targets || []);
  const storageKey = `writeflex:reader-notes:${manifest.documentId}`;
  const openButton = document.getElementById("wf-reader-notes-open");
  const closeButton = document.getElementById("wf-reader-notes-close");
  const drawer = document.getElementById("wf-reader-notes-drawer");
  const list = document.getElementById("wf-reader-notes-list");
  const empty = document.getElementById("wf-reader-notes-empty");
  const prompt = document.getElementById("wf-reader-selection-prompt");
  const promptButton = prompt?.querySelector("button");
  let pendingSelection = null;

  function readNotes() {
    try {
      const parsed = JSON.parse(globalScope.localStorage.getItem(storageKey) || "[]");
      return Array.isArray(parsed)
        ? parsed.filter((note) => note && note.documentId === manifest.documentId && targetIds.has(note.targetId))
        : [];
    } catch (_error) {
      return [];
    }
  }

  let notes = readNotes();

  function persist() {
    try { globalScope.localStorage.setItem(storageKey, JSON.stringify(notes)); } catch (_error) { /* file stays usable */ }
  }

  function setDrawer(open) {
    if (open) {
      document.querySelectorAll("[data-writeflex-reader-drawer]").forEach((candidate) => {
        if (candidate !== drawer) {
          candidate.classList.remove("open");
          candidate.setAttribute("aria-hidden", "true");
        }
      });
    }
    drawer?.classList.toggle("open", open);
    drawer?.setAttribute("aria-hidden", String(!open));
    openButton?.setAttribute("aria-expanded", String(open));
  }

  function targetForSelection(selection) {
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const start = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer
      : range.startContainer.parentElement;
    const target = start?.closest?.("[id]");
    if (!target || !targetIds.has(target.id) || !target.contains(range.endContainer)) return null;
    if (start.closest("input, textarea, button, dialog, .notes-drawer, .reader-selection-prompt")) return null;
    return { target, range };
  }

  function offsetWithin(target, node, offset) {
    const range = document.createRange();
    range.selectNodeContents(target);
    range.setEnd(node, offset);
    return range.toString().length;
  }

  function captureSelection() {
    const selected = targetForSelection(globalScope.getSelection());
    if (!selected) return null;
    const quote = selected.range.toString().replace(/\s+/g, " ").trim();
    if (!quote) return null;
    const text = selected.target.textContent || "";
    const startOffset = offsetWithin(selected.target, selected.range.startContainer, selected.range.startOffset);
    const endOffset = offsetWithin(selected.target, selected.range.endContainer, selected.range.endOffset);
    return {
      targetId: selected.target.id,
      quote,
      contextBefore: text.slice(Math.max(0, startOffset - 80), startOffset),
      contextAfter: text.slice(endOffset, endOffset + 80),
      startOffset,
      endOffset,
      rect: selected.range.getBoundingClientRect(),
    };
  }

  function showSelectionPrompt() {
    pendingSelection = captureSelection();
    if (!prompt || !pendingSelection) {
      if (prompt) prompt.hidden = true;
      return;
    }
    prompt.style.left = `${Math.max(8, Math.min(globalScope.innerWidth - 120, pendingSelection.rect.left))}px`;
    prompt.style.top = `${Math.max(8, pendingSelection.rect.bottom + 8)}px`;
    prompt.hidden = false;
  }

  function unwrapHighlights() {
    document.querySelectorAll("mark.wf-reader-note-highlight").forEach((highlight) => {
      const parent = highlight.parentNode;
      while (highlight.firstChild) parent?.insertBefore(highlight.firstChild, highlight);
      highlight.remove();
      parent?.normalize();
    });
  }

  function textPosition(root, offset) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    let node = walker.nextNode();
    while (node) {
      if (remaining <= node.data.length) return { node, offset: remaining };
      remaining -= node.data.length;
      node = walker.nextNode();
    }
    return null;
  }

  function highlight(note) {
    const target = document.getElementById(note.targetId);
    if (!target) return;
    let start = Number.isFinite(note.startOffset) ? note.startOffset : -1;
    let end = Number.isFinite(note.endOffset) ? note.endOffset : -1;
    if (start < 0 || end <= start || (target.textContent || "").slice(start, end).replace(/\s+/g, " ").trim() !== note.quote) {
      start = (target.textContent || "").indexOf(note.quote);
      end = start + note.quote.length;
    }
    if (start < 0) return;
    const startAt = textPosition(target, start);
    const endAt = textPosition(target, end);
    if (!startAt || !endAt) return;
    const range = document.createRange();
    range.setStart(startAt.node, startAt.offset);
    range.setEnd(endAt.node, endAt.offset);
    const marker = document.createElement("mark");
    marker.className = "wf-reader-note-highlight";
    marker.dataset.readerNoteId = note.id;
    marker.append(range.extractContents());
    range.insertNode(marker);
  }

  function renderHighlights() {
    unwrapHighlights();
    [...notes].sort((a, b) => (b.startOffset || 0) - (a.startOffset || 0)).forEach(highlight);
  }

  function jumpToNote(id) {
    const note = notes.find((candidate) => candidate.id === id);
    if (!note) return false;
    const marker = document.querySelector(`[data-reader-note-id="${CSS.escape(id)}"]`);
    const target = marker || document.getElementById(note.targetId);
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
    marker?.classList.add("wf-reader-note-focus");
    globalScope.setTimeout(() => marker?.classList.remove("wf-reader-note-focus"), 1200);
    return Boolean(target);
  }

  function removeNote(id) {
    const before = notes.length;
    notes = notes.filter((note) => note.id !== id);
    if (notes.length === before) return false;
    persist();
    render();
    return true;
  }

  function editNote(id, text) {
    const note = notes.find((candidate) => candidate.id === id);
    if (!note) return false;
    note.note = String(text || "");
    note.updatedAt = new Date().toISOString();
    persist();
    return true;
  }

  function noteCard(note, index) {
    const card = document.createElement("section");
    card.className = "drawer-note";
    const quote = document.createElement("button");
    quote.className = "drawer-quote";
    quote.type = "button";
    quote.textContent = `“${note.quote}”`;
    quote.title = "Jump to highlight";
    quote.addEventListener("click", () => jumpToNote(note.id));
    const label = document.createElement("label");
    label.textContent = `Comment ${index + 1}`;
    const textarea = document.createElement("textarea");
    textarea.value = note.note;
    textarea.setAttribute("aria-label", `Comment ${index + 1}`);
    textarea.addEventListener("input", () => editNote(note.id, textarea.value));
    const actions = document.createElement("div");
    actions.className = "drawer-note-actions";
    const jump = document.createElement("button");
    jump.type = "button";
    jump.textContent = "Jump to highlight";
    jump.addEventListener("click", () => jumpToNote(note.id));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => removeNote(note.id));
    actions.append(jump, remove);
    card.append(quote, label, textarea, actions);
    return card;
  }

  function render() {
    if (list) {
      // One card at a time into a fragment: replaceChildren(...cards) passes one argument per card.
      const cards = document.createDocumentFragment();
      notes.forEach((note, index) => cards.appendChild(noteCard(note, index)));
      list.replaceChildren(cards);
    }
    if (empty) empty.hidden = notes.length > 0;
    if (openButton) openButton.textContent = `Comments · ${notes.length}`;
    renderHighlights();
  }

  function createNote(noteText = "") {
    const captured = captureSelection() || pendingSelection;
    if (!captured) return null;
    const note = createTextAnnotation({
      documentId: manifest.documentId,
      targetId: captured.targetId,
      quote: captured.quote,
      note: noteText,
      contextBefore: captured.contextBefore,
      contextAfter: captured.contextAfter,
      startOffset: captured.startOffset,
      endOffset: captured.endOffset,
    });
    if (!note) return null;
    notes.push(note);
    pendingSelection = null;
    if (prompt) prompt.hidden = true;
    globalScope.getSelection()?.removeAllRanges();
    persist();
    render();
    setDrawer(true);
    if (!noteText) list?.querySelector(".drawer-note:last-child textarea")?.focus();
    return { ...note };
  }

  function exportJson() {
    return JSON.stringify(buildInteractionExport({ documentId: manifest.documentId, annotations: notes }), null, 2);
  }

  function exportMarkdown() {
    const lines = ["# Reader comments", "", `Document: \`${manifest.documentId}\``, ""];
    notes.forEach((note, index) => {
      lines.push(`## ${index + 1}. “${note.quote}”`, "", note.note || "_(No comment text.)_", "", `Target: \`${note.targetId}\``, "");
    });
    return lines.join("\n");
  }

  function download(text, extension, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${manifest.documentId}.notes.${extension}`;
    link.click();
    globalScope.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  openButton?.addEventListener("click", () => setDrawer(true));
  closeButton?.addEventListener("click", () => { setDrawer(false); openButton?.focus(); });
  promptButton?.addEventListener("click", () => createNote(""));
  document.getElementById("wf-reader-notes-markdown")?.addEventListener("click", () => download(exportMarkdown(), "md", "text/markdown"));
  document.addEventListener("mouseup", showSelectionPrompt);
  document.addEventListener("keyup", (event) => {
    if (event.key === "Escape") {
      if (prompt) prompt.hidden = true;
      setDrawer(false);
      return;
    }
    showSelectionPrompt();
  });

  globalScope.WriteFlexReaderNotes = {
    createNote,
    editNote,
    exportJson,
    exportMarkdown,
    getNotes: () => notes.map((note) => ({ ...note })),
    jumpToNote,
    openDrawer: () => setDrawer(true),
    removeNote,
    storageKey,
  };
  globalScope.WriteFlexInteractionNotes = {
    getAnnotations: () => notes.map((note) => ({ ...note })),
  };
  globalScope.WriteFlexReaderReturn = globalScope.WriteFlexReaderReturn || {};
  globalScope.WriteFlexReaderReturn.file = () => ({ text: exportJson(), suffix: "notes" });
  render();
})(typeof window !== "undefined" ? window : globalThis);

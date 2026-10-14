/* Vendored from the single-html-document feedback runtime. This asset contains only
   edit-diff generation, combined interaction export, and the WriteFlex edit surface. */
(function attachWriteFlexReaderEdits(globalScope) {
  "use strict";

  function createId(prefix) {
    if (globalScope.crypto && typeof globalScope.crypto.randomUUID === "function") {
      return `${prefix}-${globalScope.crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function tokenizeForDiff(text, granularity) {
    const value = String(text || "");
    if (granularity === "line") return value.split(/(\n)/).filter((token) => token !== "");
    return value.match(/\s+|[^\s]+/g) || [];
  }

  function compactDiff(ops) {
    const compacted = [];
    for (const op of ops) {
      if (!op.text) continue;
      const previous = compacted[compacted.length - 1];
      if (previous && previous.op === op.op) previous.text += op.text;
      else compacted.push({ ...op });
    }
    return compacted;
  }

  function diffTokens(originalTokens, editedTokens) {
    const maxCells = 120_000;
    if (originalTokens.length * editedTokens.length > maxCells) {
      return compactDiff([
        { op: "delete", text: originalTokens.join("") },
        { op: "insert", text: editedTokens.join("") },
      ]);
    }

    const rows = originalTokens.length + 1;
    const cols = editedTokens.length + 1;
    const table = Array.from({ length: rows }, () => Array(cols).fill(0));

    for (let i = originalTokens.length - 1; i >= 0; i -= 1) {
      for (let j = editedTokens.length - 1; j >= 0; j -= 1) {
        table[i][j] = originalTokens[i] === editedTokens[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }

    const ops = [];
    let i = 0;
    let j = 0;
    while (i < originalTokens.length && j < editedTokens.length) {
      if (originalTokens[i] === editedTokens[j]) {
        ops.push({ op: "equal", text: originalTokens[i] });
        i += 1;
        j += 1;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        ops.push({ op: "delete", text: originalTokens[i] });
        i += 1;
      } else {
        ops.push({ op: "insert", text: editedTokens[j] });
        j += 1;
      }
    }
    while (i < originalTokens.length) {
      ops.push({ op: "delete", text: originalTokens[i] });
      i += 1;
    }
    while (j < editedTokens.length) {
      ops.push({ op: "insert", text: editedTokens[j] });
      j += 1;
    }
    return compactDiff(ops);
  }

  function createTextEditRecord({
    itemId,
    targetId,
    sourceRef = "",
    originalText,
    editedText,
    granularity = "word",
  }) {
    const idBase = targetId || itemId;
    const original = String(originalText || "");
    const edited = String(editedText || "");
    if (!idBase || original === edited) return null;
    return {
      id: createId(`${idBase}-edit`),
      itemId: itemId || targetId,
      targetId: targetId || itemId,
      sourceRef,
      originalText: original,
      editedText: edited,
      diffGranularity: granularity,
      diff: diffTokens(tokenizeForDiff(original, granularity), tokenizeForDiff(edited, granularity)),
      createdAt: new Date().toISOString(),
    };
  }

  function buildInteractionExport({
    documentId,
    reviewer = "anonymous",
    annotations = [],
    edits = [],
    extra = {},
  }) {
    const payload = {
      singleHtmlDocumentFeedbackVersion: 1,
      documentId: documentId || "",
      generatedAt: new Date().toISOString(),
      reviewer,
      annotations,
      edits,
      ...extra,
    };
    return { ...payload, encodedSizeBytes: new Blob([JSON.stringify(payload)]).size };
  }

  globalScope.WriteFlexReaderEditsRuntime = { buildInteractionExport, createTextEditRecord };
  if (typeof document === "undefined") return;

  const manifestElement = document.getElementById("writeflex-interaction-manifest");
  if (!manifestElement) return;
  const manifest = JSON.parse(manifestElement.textContent || "{}");
  if (!manifest.editDiff?.enabled || !manifest.documentId) return;

  // Links inside an editable passage: a click without Option or Shift follows the link, and
  // Option-click places the caret so the link text can be edited. The export already applied
  // safeUrl() from src/shared/markdown/url-safety.ts when it wrote the file; this runtime repeats
  // the link rule (http, https, mailto, tel, relative paths and same-page #fragments) so that a
  // click never opens a javascript:, data: or other scheme.
  const LINK_EDIT_HINT = "Option-click to edit the link text";
  const OPENABLE_LINK_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

  function openableLinkTarget(rawHref) {
    const cleaned = String(rawHref || "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (cleaned === "") return null;
    if (cleaned.startsWith("#")) return cleaned;
    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
    // No scheme: a relative path or a protocol-relative URL. Nothing here can execute.
    if (!scheme) return cleaned;
    return OPENABLE_LINK_SCHEMES.has(scheme[1].toLowerCase()) ? cleaned : null;
  }

  function linkForEvent(event, element) {
    for (let node = event.target; node && node !== element; node = node.parentNode) {
      if (node.tagName === "A" && node.hasAttribute("href")) return node;
    }
    return null;
  }

  // Option (Alt) is the edit gesture, so it is the only key that leaves a click to the caret.
  // Shift is left to the browser's default as well.
  function isFollowClick(event) {
    return !event.altKey && !event.shiftKey;
  }

  function decorateLinks(element) {
    element.querySelectorAll("a[href]").forEach((link) => {
      link.style.cursor = "pointer";
      if (!link.hasAttribute("title")) link.setAttribute("title", LINK_EDIT_HINT);
    });
  }

  function followLink(link) {
    const href = openableLinkTarget(link.getAttribute("href"));
    if (href === null) return;
    if (href.startsWith("#")) {
      let id = href.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch (error) {
        // A malformed escape is not a valid fragment; look for the raw text instead.
      }
      const destination = document.getElementById(id);
      if (destination) destination.scrollIntoView();
      return;
    }
    globalScope.open(href, "_blank", "noopener,noreferrer");
  }

  function attachLinkBehaviour(element) {
    // Preventing the mousedown default stops the caret moving into the link on a plain click.
    element.addEventListener("mousedown", (event) => {
      if ((event.button ?? 0) !== 0 || !isFollowClick(event)) return;
      if (linkForEvent(event, element)) event.preventDefault();
    });
    element.addEventListener("click", (event) => {
      if (!isFollowClick(event)) return;
      const link = linkForEvent(event, element);
      if (!link) return;
      event.preventDefault();
      followLink(link);
    });
  }

  const targets =(manifest.editDiff.targets || []).flatMap((targetId) => {
    const element = document.getElementById(targetId);
    if (!element) return [];
    const originalText = element.textContent || "";
    const originalHtml = element.innerHTML;
    element.dataset.editable = "";
    element.dataset.originalText = originalText;
    element.contentEditable = "true";
    element.setAttribute("spellcheck", "true");
    element.setAttribute("aria-label", `Editable passage: ${originalText.slice(0, 80)}`);
    decorateLinks(element);
    attachLinkBehaviour(element);
    return [{ element, originalHtml, originalText, sourceRef: element.dataset.sourceRef || "", targetId }];
  });

  const openButton = document.getElementById("wf-reader-edits-open");
  const closeButton = document.getElementById("wf-reader-edits-close");
  const drawer = document.getElementById("wf-reader-edits-drawer");
  const list = document.getElementById("wf-reader-edits-list");
  const empty = document.getElementById("wf-reader-edits-empty");

  function getEdits() {
    return targets.flatMap((target) => {
      const record = createTextEditRecord({
        targetId: target.targetId,
        sourceRef: target.sourceRef,
        originalText: target.originalText,
        editedText: target.element.textContent || "",
      });
      return record ? [record] : [];
    });
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

  function resetEdit(targetId) {
    const target = targets.find((candidate) => candidate.targetId === targetId);
    if (!target) return false;
    target.element.innerHTML = target.originalHtml;
    decorateLinks(target.element);
    render();
    return true;
  }

  function editCard(edit, index) {
    const card = document.createElement("section");
    card.className = "drawer-edit";
    const label = document.createElement("strong");
    label.textContent = `Edit ${index + 1}`;
    const original = document.createElement("p");
    original.className = "drawer-edit-original";
    original.textContent = edit.originalText;
    const changed = document.createElement("p");
    changed.className = "drawer-edit-changed";
    changed.textContent = edit.editedText;
    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "Reset passage";
    reset.addEventListener("click", () => resetEdit(edit.targetId));
    card.append(label, original, changed, reset);
    return card;
  }

  function render() {
    const edits = getEdits();
    const changedIds = new Set(edits.map((edit) => edit.targetId));
    targets.forEach((target) => target.element.classList.toggle("wf-reader-edit-changed", changedIds.has(target.targetId)));
    if (list) {
      // One card at a time into a fragment: replaceChildren(...cards) passes one argument per card.
      const cards = document.createDocumentFragment();
      edits.forEach((edit, index) => cards.appendChild(editCard(edit, index)));
      list.replaceChildren(cards);
    }
    if (empty) empty.hidden = edits.length > 0;
    if (openButton) openButton.textContent = `Edits · ${edits.length}`;
  }

  function exportJson() {
    const annotations = globalScope.WriteFlexInteractionNotes?.getAnnotations?.() || [];
    return JSON.stringify(buildInteractionExport({
      documentId: manifest.documentId,
      annotations,
      edits: getEdits(),
    }), null, 2);
  }

  targets.forEach((target) => target.element.addEventListener("input", render));
  openButton?.addEventListener("click", () => setDrawer(true));
  closeButton?.addEventListener("click", () => { setDrawer(false); openButton?.focus(); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && drawer?.classList.contains("open")) {
      setDrawer(false);
      openButton?.focus();
    }
  });

  globalScope.WriteFlexReaderEdits = {
    exportJson,
    getEdits,
    openDrawer: () => setDrawer(true),
    resetEdit,
  };
  globalScope.WriteFlexReaderReturn = globalScope.WriteFlexReaderReturn || {};
  globalScope.WriteFlexReaderReturn.file = () => ({
    text: exportJson(),
    suffix: manifest.annotations?.enabled ? "feedback" : "edits",
  });
  render();
})(typeof window !== "undefined" ? window : globalThis);

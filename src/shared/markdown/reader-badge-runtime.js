/* The one badge and the one return action for a reader document. This asset owns no note storage
   and no diff generation: it reads the interaction manifest to learn which modes the document was
   exported with, opens the explainer, and asks whichever reader runtimes are present for the
   payload the reader is sending back. */
(function attachWriteFlexReaderBadge(globalScope) {
  "use strict";

  if (typeof document === "undefined") return;
  const manifestElement = document.getElementById("writeflex-interaction-manifest");
  if (!manifestElement) return;
  const manifest = JSON.parse(manifestElement.textContent || "{}");
  const notesEnabled = Boolean(manifest.annotations?.enabled);
  const editsEnabled = Boolean(manifest.editDiff?.enabled);
  if (!manifest.documentId || (!notesEnabled && !editsEnabled)) return;

  const badge = document.getElementById("wf-reader-badge");
  const explainer = document.getElementById("wf-reader-badge-explainer");
  const shell = badge?.closest(".reader-badge-region");
  const returnButton = document.getElementById("wf-reader-return");
  let pinned = false;

  function setExplainer(open) {
    if (!explainer) return;
    explainer.hidden = !open;
  }

  function hover(open) {
    if (pinned) return;
    setExplainer(open);
  }

  /** The return file, from whichever reader runtime registered it. The edit runtime is injected
   *  after the note runtime, so a document carrying both returns the combined payload. This badge
   *  never names a runtime: naming one would put its marker into an export that does not have it. */
  function returnFile() {
    const contributed = globalScope.WriteFlexReaderReturn?.file?.();
    if (!contributed || typeof contributed.text !== "string") return null;
    return { text: contributed.text, name: `${manifest.documentId}.${contributed.suffix}.json` };
  }

  function download() {
    const file = returnFile();
    if (!file) return false;
    const url = URL.createObjectURL(new Blob([file.text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.click();
    globalScope.setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  }

  badge?.addEventListener("click", () => {
    pinned = !pinned;
    setExplainer(pinned);
  });
  badge?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    pinned = !pinned;
    setExplainer(pinned);
  });
  shell?.addEventListener("mouseenter", () => hover(true));
  shell?.addEventListener("mouseleave", () => hover(false));
  shell?.addEventListener("focusin", () => hover(true));
  shell?.addEventListener("focusout", (event) => {
    if (!shell.contains(event.relatedTarget)) hover(false);
  });
  returnButton?.addEventListener("click", download);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || explainer?.hidden !== false) return;
    pinned = false;
    setExplainer(false);
    badge?.focus();
  });

  /** The drawers open over the right-hand corner, so the return action steps aside while one is
   *  open. The drawers are parsed after this badge, so the watch starts once the document is. */
  function watchDrawers() {
    const drawers = [...document.querySelectorAll("[data-writeflex-reader-drawer]")];
    if (!drawers.length) return;
    const sync = () => document.body.classList.toggle(
      "wf-reader-drawer-open",
      drawers.some((drawer) => drawer.classList.contains("open")),
    );
    const observer = new MutationObserver(sync);
    drawers.forEach((drawer) => observer.observe(drawer, { attributes: true, attributeFilter: ["class"] }));
    sync();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watchDrawers);
  else watchDrawers();

  globalScope.WriteFlexReaderBadge = {
    exportReturnFile: () => returnFile(),
    openExplainer: () => setExplainer(true),
    closeExplainer: () => { pinned = false; setExplainer(false); },
    saveReturnFile: download,
  };
})(typeof window !== "undefined" ? window : globalThis);

// Live delivery stays inside the reader runtime's closure. The page and notes rendering remain
// its adapters; this module owns polling, deferred publication swaps and reading-position recovery.
export const READER_RUNTIME_LIVE = String.raw`
// Generated numbers have no text nodes, so an incoming marker cannot change selected/copied prose.
var liveStyle = document.createElement('style');
liveStyle.textContent = 'sup.mn::after{content:attr(data-number)}';
document.head.appendChild(liveStyle);
var pollTimer = 0, pollRunning = false, pollAgain = false, pollFailures = 0;
var readyPublication = null, contentUnavailable = false, updatedTimer = 0, updatedJustNow = false;
var notesWaiting = false, notesFingerprint = null;

function selectionActive() {
  var selection = window.getSelection();
  return selection && !selection.isCollapsed;
}
function readingPoint(node, offset) {
  var block = blockOf(content, node);
  return block ? { hint: hintOf(content, block), index: allBlocks(content).indexOf(block), offset: offsetIn(block, node, offset) } : null;
}
function domPoint(point) {
  var block = blockByHint(content, point.hint) || allBlocks(content)[point.index];
  if (!block) return null;
  var nodes = textNodes(block), left = point.offset;
  for (var i = 0; i < nodes.length; i += 1) {
    if (left <= nodes[i].length) return [nodes[i], left];
    left -= nodes[i].length;
  }
  return nodes.length ? [nodes[nodes.length - 1], nodes[nodes.length - 1].length] : [block, 0];
}
/** Remember the visible block, not a document-height ratio: preceding edits must not move it. */
function preserveReading(change) {
  var x = window.scrollX, y = window.scrollY, blocks = allBlocks(content);
  var top = blocks.filter(function (b) { return b.getBoundingClientRect().bottom > Math.max(0, rbar.getBoundingClientRect().bottom); })[0];
  var anchor = top ? { hint: hintOf(content, top), index: blocks.indexOf(top), text: textOf(top), y: top.getBoundingClientRect().top } : null;
  var focused = document.activeElement, start = focused && focused.selectionStart, end = focused && focused.selectionEnd, direction = focused && focused.selectionDirection;
  var focusCard = focused && focused.closest && focused.closest('.card[data-key]');
  var focusId = focused && focused.id, focusHref = focused && focused.getAttribute && focused.getAttribute('href');
  var focusView = focused && focused.getAttribute && focused.getAttribute('data-view');
  var focusClose = focused && focused.classList && focused.classList.contains('close-contents');
  var focusKey = focusCard && focusCard.getAttribute('data-key'), focusAct = focused && focused.getAttribute && focused.getAttribute('data-act');
  var selection = window.getSelection(), a = null, b = null;
  if (selection && !selection.isCollapsed) { a = readingPoint(selection.anchorNode, selection.anchorOffset); b = readingPoint(selection.focusNode, selection.focusOffset); }
  change();
  if (focused && focused !== document.body) {
    if (!focused.isConnected && focusKey) {
      var card = [].slice.call(rp.querySelectorAll('.card[data-key]')).filter(function (c) { return c.getAttribute('data-key') === focusKey; })[0];
      focused = card && [].slice.call(card.querySelectorAll('[data-act]')).filter(function (el) { return el.getAttribute('data-act') === focusAct; })[0];
    }
    if (focused && !focused.isConnected) {
      focused = (focusId && document.getElementById(focusId)) || (focusClose && rp.querySelector('.close-contents'))
        || [].slice.call(rp.querySelectorAll('a[href],button[data-view]')).filter(function (el) {
          return focusHref !== null && focusHref !== undefined ? el.getAttribute('href') === focusHref : focusView && el.getAttribute('data-view') === focusView;
        })[0];
    }
    if (focused && focused.isConnected && focused !== document.activeElement) focused.focus({ preventScroll: true });
    if (focused && typeof start === 'number' && focused.setSelectionRange) focused.setSelectionRange(start, end, direction);
  }
  if (a && b) {
    var ap = domPoint(a), bp = domPoint(b);
    if (ap && bp) selection.setBaseAndExtent(ap[0], ap[1], bp[0], bp[1]);
  }
  if (anchor) {
    var nextBlocks = allBlocks(content);
    var next = nextBlocks.filter(function (el) { return textOf(el) === anchor.text; })[0]
      || blockByHint(content, anchor.hint) || nextBlocks[Math.min(anchor.index, nextBlocks.length - 1)];
    if (next) y += next.getBoundingClientRect().top - anchor.y;
  }
  window.scrollTo({ left: x, top: y, behavior: 'instant' });
}
function renderLiveNotes() {
  // Selection in a card cannot be reconstructed from the author's block offsets. Keep its DOM
  // until the reader finishes selecting. A selection in the published text is restored by offsets.
  var selection = window.getSelection();
  if (selectionActive() && (!blockOf(content, selection.anchorNode) || !blockOf(content, selection.focusNode))) { notesWaiting = true; return; }
  var fingerprint = JSON.stringify([sent, outbox, openComments, olderComments]);
  if (fingerprint === notesFingerprint) return;
  var known = {};
  items.forEach(function (it) { if (it.card) known[it.el.getAttribute('data-key')] = true; });
  preserveReading(function () {
    // Reusing this node retains its value, undo history and input selection across both layouts.
    if (state.composer) state.composer.el.remove();
    render();
  });
  if (notesFingerprint !== null) items.forEach(function (it) {
    if (it.card && !known[it.el.getAttribute('data-key')] && it.el.animate && !matchMedia('(prefers-reduced-motion: reduce)').matches)
      it.el.animate([{ backgroundColor: 'rgba(100,140,180,.16)' }, { backgroundColor: 'transparent' }], { duration: 1800 });
  });
  notesFingerprint = fingerprint;
  notesWaiting = false;
}
function renderUpdateNotice() {
  var old = rbar && rbar.querySelector('[data-live-update]');
  var mode = readyPublication ? 'ready' : 'updated';
  if (old && !state.linkOff && (readyPublication || updatedJustNow) && old.getAttribute('data-live-update') === mode) return;
  if (old) old.remove();
  if (!rbar || state.linkOff || (!readyPublication && !updatedJustNow)) return;
  var notice = h('span', 'live-update', readyPublication ? 'A newer version is ready ' : 'Updated just now');
  notice.setAttribute('data-live-update', mode);
  if (readyPublication) notice.appendChild(button('', 'update-now', ['Update now']));
  rbar.appendChild(notice);
}
function applyReadyContent(force) {
  if (!readyPublication || state.linkOff || document.hidden) return;
  if (!force && (state.composer || selectionActive())) { renderUpdateNotice(); return; }
  var fresh = readyPublication, next = fresh.querySelector(':scope > .rbody > article.content');
  if (!next) return;
  preserveReading(function () {
    if (state.composer) state.composer.el.remove();
    unmarkAll(content);
    // Keep unchanged Folio parts and their DOM when the section order/identity still agrees.
    var oldParts = [].slice.call(content.querySelectorAll(':scope > .wf-bundle-section'));
    var newParts = [].slice.call(next.querySelectorAll(':scope > .wf-bundle-section'));
    if (oldParts.length && oldParts.length === newParts.length && oldParts.every(function (p, i) { return p.id === newParts[i].id; })) {
      oldParts.forEach(function (p, i) { if (p.isEqualNode(newParts[i])) newParts[i].replaceWith(p); });
    }
    content.replaceChildren.apply(content, [].slice.call(next.childNodes));
    var hero = kid(rbody, 'HEADER', 'hero'), nextHero = fresh.querySelector(':scope > .rbody > header.hero');
    if (hero && nextHero) hero.replaceWith(nextHero);
    var sidebar = kid(rbody, 'ASIDE', 'sidebar'), nextSidebar = fresh.querySelector(':scope > .rbody > aside.sidebar');
    if (sidebar && nextSidebar && !sidebar.isEqualNode(nextSidebar)) sidebar.replaceChildren.apply(sidebar, [].slice.call(nextSidebar.childNodes));
    revision = Number(fresh.getAttribute('data-revision'));
    rp.setAttribute('data-revision', String(revision));
    // A forced swap keeps the draft and re-places its quoted passage on the new text.
    if (state.composer && state.composer.cap) {
      var resolved = resolveAnchor(content, state.composer.cap.anchor);
      state.composer.cap.block = resolved.block;
      state.composer.cap.start = resolved.start;
      state.composer.cap.end = resolved.end;
    }
    var nextBar = fresh.querySelector(':scope > header.rbar');
    var meta = rbar.querySelector(':scope > .bar-meta'), nextMeta = nextBar && nextBar.querySelector(':scope > .bar-meta');
    if (meta && nextMeta) meta.replaceWith(nextMeta);
    var crumb = rbar.querySelector('.crumb > b'), nextCrumb = nextBar && nextBar.querySelector('.crumb > b');
    if (crumb && nextCrumb) crumb.textContent = nextCrumb.textContent;
    hardenReaderLinks();
    render();
    document.dispatchEvent(new Event('writeflex-content-updated'));
  });
  readyPublication = null;
  updatedJustNow = true;
  clearTimeout(updatedTimer);
  updatedTimer = setTimeout(function () { updatedJustNow = false; renderUpdateNotice(); }, 5000);
  renderUpdateNotice();
}
function refreshPublication(nextRevision) {
  if (document.hidden || contentUnavailable || !Number.isSafeInteger(nextRevision) || nextRevision <= revision) return Promise.resolve();
  if (readyPublication && Number(readyPublication.getAttribute('data-revision')) >= nextRevision) { applyReadyContent(false); return Promise.resolve(); }
  // A refresh problem never counts as offline: comments keep flowing and the next poll tries again.
  return post('/content', { reader: secret }).then(function (response) {
    if (!response.ok) { if (response.body) response.body.cancel(); return; }
    return response.json().then(function (body) {
      if (!body || typeof body.html !== 'string') return;
      var parsed = new DOMParser().parseFromString(body.html, 'text/html');
      var fresh = parsed.body.firstElementChild;
      // Not a reader page this script can swap: stop trying for this page load.
      if (!fresh || !fresh.classList.contains('rp') || !fresh.querySelector(':scope > .rbody > article.content')) { contentUnavailable = true; return; }
      // Pages stored before build 16 carry no revision: take the service's.
      var stored = fresh.getAttribute('data-revision');
      if (stored === null || stored === '') fresh.setAttribute('data-revision', String(nextRevision));
      else if (Number(stored) <= revision) return;
      readyPublication = fresh;
      applyReadyContent(false);
    });
  }).catch(function () { /* the next poll tries again */ });
}
function pollNotes() {
  clearTimeout(pollTimer);
  if (document.hidden || state.linkOff) return;
  if (pollRunning) { pollAgain = true; return; }
  pollRunning = true;
  fetchMine().then(function () { pollFailures = 0; if (!document.hidden) return flush(); }).catch(function (error) {
    pollFailures += 1;
    // A refusal or server error backs off quietly; only a failed connection shows Offline.
    if (!(error && error.serviceAnswered)) setOffline(true);
  }).finally(function () {
    pollRunning = false;
    if (document.hidden || state.linkOff) return;
    if (pollAgain) { pollAgain = false; pollNotes(); return; }
    pollTimer = setTimeout(pollNotes, Math.min(60000, 10000 * Math.pow(2, Math.max(0, pollFailures - 1))));
  });
}
function startLiveReader() {
  document.addEventListener('visibilitychange', function () {
    clearTimeout(pollTimer);
    if (!document.hidden) { applyReadyContent(false); pollNotes(); }
  });
  document.addEventListener('selectionchange', function () {
    if (!selectionActive()) {
      if (notesWaiting) renderLiveNotes();
      applyReadyContent(false);
    }
  });
  pollNotes();
}
`

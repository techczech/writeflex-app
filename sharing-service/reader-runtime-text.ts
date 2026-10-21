// The reader page's script, part 1 of 2: the text. Finding the block a selection is in, anchoring
// a note by its quoted words (the export's anchoring: quote, up to 80 characters of context each
// side, offsets in the block, the block as a hint; src/shared/markdown/reader-notes-runtime.js),
// finding those words again after the text has changed, marking them, and the word-by-word change
// of a proposed edit.
//
// This is browser JavaScript kept as a string, because the service sends it inside the page and
// pins it in the page's content security policy by its SHA-256 (reader-runtime.ts). It runs inside
// the function reader-runtime.ts wraps around both parts, so the names below are shared with part 2
// (reader-runtime-ui.ts). No backticks and no template placeholders in the string.
//
// Every piece of text from a reader or from storage is put on the page with textContent or as a
// text node; nothing here writes HTML.
export const READER_RUNTIME_TEXT = String.raw`
var BLOCK_SEL = 'p,h1,h2,h3,h4,h5,h6,li,dt,dd,td,th,pre,figcaption,blockquote';
var NOT_TEXT = '.hero,.made-with,.plabel';
var CONTEXT = 80;
var HINT_ID = /^[A-Za-z0-9_:.-]{1,125}$/;
/** The longest selection a note may quote (NOTE_LIMITS.quoteChars in reader-notes.ts). */
var QUOTE_MAX = 1000;

/*
 * What this script put on the page. The author's HTML is not sanitised and may use any class this
 * script uses (wf-ui, wf-hl), so a class never says who made an element: only these sets do. They
 * live inside this script's closure, where nothing in the author's HTML can reach (no author script
 * runs, by the page's policy). UI_MADE: elements this script made (cards, markers, the notes head),
 * taken out again on every redraw. MARKS: the marks around quoted words, unwrapped on every redraw;
 * the words inside them are the author's.
 */
var UI_MADE = new WeakSet();
var MARKS = [];
function made(el) { UI_MADE.add(el); return el; }
/** Whether a node is inside something this script made (never true of the author's own elements). */
function isMade(node) {
  for (var el = node && (node.nodeType === 1 ? node : node.parentElement); el; el = el.parentElement) if (UI_MADE.has(el)) return true;
  return false;
}

function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

/** The page's text blocks, in document order (the author's text only, never this script's UI). */
function allBlocks(content) {
  return [].slice.call(content.querySelectorAll(BLOCK_SEL)).filter(function (b) { return !b.closest(NOT_TEXT) && !isMade(b); });
}

/** The text block a node is in, or null when it is not in the author's text. */
function blockOf(content, node) {
  var el = node && (node.nodeType === 1 ? node : node.parentElement);
  var b = el && el.closest(BLOCK_SEL);
  if (!b || !content.contains(b) || b.closest(NOT_TEXT) || isMade(b)) return null;
  return b;
}

/** The text nodes that make up a block's text: the markers and cards this script adds are left out. */
function textNodes(block) {
  var out = [];
  var walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode: function (n) { return isMade(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; }
  });
  for (var n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
  return out;
}

function textOf(block) { return textNodes(block).map(function (n) { return n.data; }).join(''); }

/** The offset in the block's text of a point (node, offset) inside it. */
function offsetIn(block, node, offset) {
  var r = document.createRange();
  r.setStart(block, 0);
  r.setEnd(node, offset);
  var total = 0;
  textNodes(block).forEach(function (t) {
    if (!r.intersectsNode(t)) return;
    if (t === r.endContainer) total += r.endOffset;
    else total += t.data.length;
  });
  return total;
}

function hintOf(content, block) {
  if (block.id && HINT_ID.test(block.id)) return 'id:' + block.id;
  return 'n:' + allBlocks(content).indexOf(block);
}

function blockByHint(content, hint) {
  if (!hint) return null;
  if (hint.indexOf('id:') === 0) {
    var id = hint.slice(3);
    var found = allBlocks(content).filter(function (b) { return b.id === id; });
    return found[0] || null;
  }
  if (hint.indexOf('n:') === 0) return allBlocks(content)[+hint.slice(2)] || null;
  return null;
}

/**
 * The selected words as an anchor, or null when the selection is not words inside one block. A
 * selection longer than a note may quote comes back as {block, tooLong: true} and no anchor, so
 * the quote, its offsets and its context always describe the same words.
 *
 * Offsets are in the block's text with runs of white space made one space (as the quote is), so
 * end - start is always the quote's length; the service refuses an anchor where it is not.
 * {start, end} beside the anchor are the same words in the block's own text, for marking them.
 */
function captureSelection(content, range) {
  if (!range || range.collapsed) return null;
  var b1 = blockOf(content, range.startContainer), b2 = blockOf(content, range.endContainer);
  if (!b1 || b1 !== b2) return null;
  var text = textOf(b1);
  var start = offsetIn(b1, range.startContainer, range.startOffset);
  var end = offsetIn(b1, range.endContainer, range.endOffset);
  // Trim the spaces at either end of the selection off the offsets too.
  while (start < end && /\s/.test(text.charAt(start))) start += 1;
  while (end > start && /\s/.test(text.charAt(end - 1))) end -= 1;
  var quote = norm(text.slice(start, end));
  if (!quote) return null;
  if (quote.length > QUOTE_MAX) return { block: b1, tooLong: true };
  var at = normalised(text).map.indexOf(start);
  return {
    block: b1,
    start: start,
    end: end,
    anchor: {
      quote: quote,
      before: norm(text.slice(Math.max(0, start - CONTEXT), start)),
      after: norm(text.slice(end, end + CONTEXT)),
      block: hintOf(content, b1),
      start: at,
      end: at + quote.length
    }
  };
}

/** A block's text with runs of white space made one space, and where each character came from. */
function normalised(text) {
  var out = '', map = [], space = false;
  for (var i = 0; i < text.length; i += 1) {
    var c = text.charAt(i);
    if (/\s/.test(c)) {
      if (!space && out.length) { out += ' '; map.push(i); }
      space = true;
    } else { out += c; map.push(i); space = false; }
  }
  return { text: out, map: map };
}

function commonSuffix(a, b) { var n = 0; while (n < a.length && n < b.length && a.charAt(a.length - 1 - n) === b.charAt(b.length - 1 - n)) n += 1; return n; }
function commonPrefix(a, b) { var n = 0; while (n < a.length && n < b.length && a.charAt(n) === b.charAt(n)) n += 1; return n; }

/**
 * Every place the quote occurs in a block, scored by how much of the context still matches. at is
 * the place in the block's text with white space collapsed, as the anchor's offsets count it.
 */
function occurrences(block, anchor) {
  var raw = textOf(block), nt = normalised(raw), out = [], from = 0;
  for (;;) {
    var at = nt.text.indexOf(anchor.quote, from);
    if (at < 0) break;
    var endN = at + anchor.quote.length;
    var start = nt.map[at], end = nt.map[endN - 1] + 1;
    var score = commonSuffix(anchor.before, norm(nt.text.slice(Math.max(0, at - 220), at))) + commonPrefix(anchor.after, norm(nt.text.slice(endN, endN + 220)));
    out.push({ block: block, at: at, start: start, end: end, score: score });
    from = at + 1;
  }
  return out;
}

/**
 * Where a note's words are on the page now. The quote and its context decide; the block and the
 * offsets are hints only. Each place the quote occurs is scored by how much of the context still
 * matches there; in the hinted block first, and where the offsets point only breaks a tie. So an
 * offset that points at another occurrence of the same words (an anchor counted another way, or text
 * changed since) never moves a note onto words whose context fits less well. When the words are
 * gone: changed, beside the block they were in (or the first block) with no words marked.
 */
function resolveAnchor(content, anchor) {
  var hinted = blockByHint(content, anchor.block);
  var best = null;
  function consider(list, bonus) {
    list.forEach(function (o) {
      var s = o.score + bonus + (bonus && anchor.start !== null && o.at === anchor.start ? 0.5 : 0);
      if (!best || s > best.s) best = { o: o, s: s };
    });
  }
  if (hinted) consider(occurrences(hinted, anchor), 1000);
  if (!best) allBlocks(content).forEach(function (b) { consider(occurrences(b, anchor), 0); });
  if (best) return { block: best.o.block, start: best.o.start, end: best.o.end, changed: false };
  return { block: hinted || allBlocks(content)[0] || null, start: null, end: null, changed: true };
}

/** Mark the characters [start, end) of a block's text, one mark per text node they cover. */
function markRange(block, start, end, className, key) {
  var marks = [], at = 0;
  textNodes(block).forEach(function (node) {
    var len = node.data.length, from = Math.max(start, at), to = Math.min(end, at + len);
    at += len;
    if (to <= from) return;
    var target = node;
    if (from - (at - len) > 0) target = target.splitText(from - (at - len));
    if (to - from < target.data.length) target.splitText(to - from);
    var mark = document.createElement('mark');
    MARKS.push(mark);
    mark.className = 'wf-hl ' + className;
    if (key) mark.setAttribute('data-key', key);
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
    marks.push(mark);
  });
  return marks;
}

/** Take every mark and marker this script put in the text out again, and nothing the author wrote. */
function unmarkAll(content) {
  MARKS.splice(0).forEach(function (mark) {
    var parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  });
  [].slice.call(content.querySelectorAll('*')).forEach(function (el) { if (UI_MADE.has(el) && el.isConnected) el.remove(); });
}

/** The change from one wording to another, word by word, as nodes: kept words, <del> and <ins>. */
function wordDiff(a, b) {
  var x = norm(a).split(' ').filter(Boolean), y = norm(b).split(' ').filter(Boolean);
  var n = x.length, m = y.length, i, j, L = [];
  for (i = 0; i <= n; i += 1) { L.push([]); for (j = 0; j <= m; j += 1) L[i].push(0); }
  for (i = n - 1; i >= 0; i -= 1) for (j = m - 1; j >= 0; j -= 1) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  var frag = document.createDocumentFragment(), del = [], ins = [], first = true;
  function word(node) { if (!first) frag.appendChild(document.createTextNode(' ')); frag.appendChild(node); first = false; }
  function flush() {
    if (del.length) { var d = document.createElement('del'); d.textContent = del.join(' '); word(d); }
    if (ins.length) { var s = document.createElement('ins'); s.textContent = ins.join(' '); word(s); }
    del = []; ins = [];
  }
  i = 0; j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { flush(); word(document.createTextNode(x[i])); i += 1; j += 1; }
    else if (j < m && (i === n || L[i][j + 1] >= L[i + 1][j])) { ins.push(y[j]); j += 1; }
    else { del.push(x[i]); i += 1; }
  }
  flush();
  return frag;
}
`

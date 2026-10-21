// The reader page's script, part 2 of 2: the notes. Selecting words offers Note and Propose edit;
// the first time the page asks for a name; a sent note shows on its passage, marked Open; notes on
// the same words are one thread; a note written offline is kept in this browser, marked "Not sent
// yet", and sent when the connection returns, once (the service de-duplicates by note id); a note
// the author's limits refuse is kept in the composer with Copy your note. Margin and Inline
// views (V), crowding rules, phone width. Hearing back: each
// note shows the author's outcome (Accepted, Declined, Done, Could not be applied) and the author's
// replies, from /notes/mine, the next time the page loads.
//
// The reader's identity is a secret made here (32 random bytes) and kept in localStorage for this
// share only; the service stores a digest of it and answers "my notes" for that digest only
// (reader-notes.ts). The name is kept in this browser for every share and can be changed; it is
// sent with each note.
//
// Browser JavaScript kept as a string; see reader-runtime-text.ts. It runs after part 1, inside one
// function, with `rp` (the page's root element) defined. Reader text is only ever set with
// textContent or text nodes.
export const READER_RUNTIME_UI = String.raw`
/* ---------- links out of the page never carry this address ---------- */
// The author's text is not sanitised: a <meta name="referrer"> in it would loosen the page's
// no-referrer policy, so any such element outside <head> is removed, and every link says so too.
[].slice.call(document.querySelectorAll('meta[name="referrer" i]')).forEach(function (m) { if (m.parentNode !== document.head) m.remove(); });
[].slice.call(rp.querySelectorAll('a[href]')).forEach(function (a) {
  a.setAttribute('rel', ((a.getAttribute('rel') || '') + ' noopener noreferrer').trim());
  a.setAttribute('referrerpolicy', 'no-referrer');
});
if (rp.getAttribute('data-comments') !== 'on') return;

function kid(parent, tag, cls) {
  if (!parent) return null;
  for (var i = 0; i < parent.children.length; i += 1) { var c = parent.children[i]; if (c.tagName === tag && c.classList.contains(cls)) return c; }
  return null;
}
var rbar = kid(rp, 'HEADER', 'rbar'), rbody = kid(rp, 'DIV', 'rbody');
var content = kid(rbody, 'ARTICLE', 'content'), col = kid(rbody, 'ASIDE', 'notes-col');
var addr = /^\/s\/([A-Za-z0-9]{22})\/?$/.exec(location.pathname);
if (!rbar || !content || !col || !addr) return;
var shareId = addr[1];
var author = rp.getAttribute('data-author') || '';
var revision = parseInt(rp.getAttribute('data-revision') || '', 10) || null;

/* ---------- this browser's storage ---------- */
var memory = {};
function load(key, fallback) {
  try { var v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
  catch (e) { return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : fallback; }
}
function save(key, value) { memory[key] = value; try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* kept for this visit */ } }
function randomId(bytes) {
  var a = new Uint8Array(bytes), s = '';
  crypto.getRandomValues(a);
  for (var i = 0; i < a.length; i += 1) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
var KEY = 'writeflex-share:' + shareId + ':';
var NAME_KEY = 'writeflex-share:name', VIEW_KEY = 'writeflex-reader-notes-view';
var secret = load(KEY + 'reader', null);
if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) { secret = randomId(32); save(KEY + 'reader', secret); }
var readerName = load(NAME_KEY, '');
if (typeof readerName !== 'string') readerName = '';

function isNote(n) {
  return n && typeof n === 'object' && typeof n.id === 'string' && (n.kind === 'note' || n.kind === 'edit') && typeof n.text === 'string'
    && typeof n.name === 'string' && n.anchor && typeof n.anchor === 'object' && typeof n.anchor.quote === 'string';
}
function cleanAnchor(a) {
  return { quote: a.quote, before: typeof a.before === 'string' ? a.before : '', after: typeof a.after === 'string' ? a.after : '',
    block: typeof a.block === 'string' ? a.block : null, start: typeof a.start === 'number' ? a.start : null, end: typeof a.end === 'number' ? a.end : null };
}
var OUTCOME = { accepted: true, declined: true, done: true, failed: true };
/** A held note's state: refused, its outcome from the service (or kept here from the last look), or the fallback. */
function stateOf(n, fallbackState) {
  if (n.state === 'refused') return 'refused';
  if (fallbackState !== 'open') return fallbackState;
  if (typeof n.status === 'string' && OUTCOME[n.status] === true) return n.status;
  if (typeof n.state === 'string' && OUTCOME[n.state] === true) return n.state;
  return 'open';
}
/** The author's replies on a note: text only, oldest first. */
function replyList(value) {
  return (Array.isArray(value) ? value : []).filter(function (r) { return r && typeof r === 'object' && typeof r.id === 'string' && typeof r.text === 'string' && typeof r.at === 'number'; })
    .map(function (r) { return { id: r.id, text: r.text, at: r.at }; });
}
function noteList(value, fallbackState) {
  return (Array.isArray(value) ? value : []).filter(isNote).map(function (n) {
    var st = stateOf(n, fallbackState);
    return { id: n.id, kind: n.kind, name: n.name, text: n.text, anchor: cleanAnchor(n.anchor),
      writtenAt: typeof n.writtenAt === 'number' ? n.writtenAt : null, receivedAt: typeof n.receivedAt === 'number' ? n.receivedAt : null,
      state: st, reason: typeof n.reason === 'string' ? n.reason : null,
      outcomeAt: OUTCOME[st] === true && typeof n.outcomeAt === 'number' ? n.outcomeAt : null,
      replies: fallbackState === 'open' ? replyList(n.replies) : [] };
  });
}
/** Notes the service holds (as it last said), and notes written here that it does not hold yet. */
var sent = noteList(load(KEY + 'notes', []), 'open');
var outbox = noteList(load(KEY + 'outbox', []), 'unsent');
function keepSent() { save(KEY + 'notes', sent); }
function keepOutbox() { save(KEY + 'outbox', outbox); }

var state = { view: 'margin', composer: null, offline: navigator.onLine === false, linkOff: false, fold: {}, flushing: false };
var narrow = window.matchMedia ? window.matchMedia('(max-width: 1099px)') : null;

/* ---------- elements ---------- */
var ICONS = {
  user: [['path', 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2'], ['circle', '12,7,4']],
  lock: [['rect', '3,11,18,11,2'], ['path', 'M7 11V7a5 5 0 0 1 10 0v4']],
  info: [['circle', '12,12,10'], ['path', 'M12 16v-4'], ['path', 'M12 8h.01']],
  select: [['path', 'M14 21h1'], ['path', 'M14 3h1'], ['path', 'M19 3a2 2 0 0 1 2 2'], ['path', 'M21 14v1'], ['path', 'M21 19a2 2 0 0 1-2 2'], ['path', 'M21 9v1'], ['path', 'M3 14v1'], ['path', 'M3 9v1'], ['path', 'M5 21a2 2 0 0 1-2-2'], ['path', 'M5 3a2 2 0 0 0-2 2'], ['path', 'M7 12h10'], ['path', 'M7 16h6'], ['path', 'M7 8h8'], ['path', 'M9 21h1'], ['path', 'M9 3h1']],
  note: [['path', 'M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z']],
  noteplus: [['path', 'M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z'], ['path', 'M12 8v6'], ['path', 'M9 11h6']],
  pencil: [['path', 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z'], ['path', 'm15 5 4 4']],
  send: [['path', 'M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z'], ['path', 'm21.854 2.147-10.94 10.939']],
  open: [['circle', '12,12,10'], ['circle', '12,12,1']],
  cloudoff: [['path', 'M10.94 5.274A7 7 0 0 1 15.71 10h1.79a4.5 4.5 0 0 1 4.222 6.057'], ['path', 'M18.796 18.81A4.5 4.5 0 0 1 17.5 19H9A7 7 0 0 1 5.79 5.78'], ['path', 'm2 2 20 20']],
  wifioff: [['path', 'M12 20h.01'], ['path', 'M8.5 16.429a5 5 0 0 1 7 0'], ['path', 'M5 12.859a10 10 0 0 1 5.17-2.69'], ['path', 'M19 12.859a10 10 0 0 0-2.007-1.523'], ['path', 'M2 8.82a15 15 0 0 1 4.177-2.643'], ['path', 'M22 8.82a15 15 0 0 0-11.288-3.764'], ['path', 'm2 2 20 20']],
  up: [['path', 'm18 15-6-6-6 6']],
  right: [['path', 'm9 18 6-6-6-6']],
  layers: [['path', 'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z'], ['path', 'M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12'], ['path', 'M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17']],
  ban: [['circle', '12,12,10'], ['path', 'M4.929 4.929 19.07 19.071']],
  copy: [['rect', '8,8,14,14,2'], ['path', 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2']],
  margin: [['rect', '3,3,18,18,2'], ['path', 'M15 3v18']],
  rows: [['rect', '3,3,18,18,2'], ['path', 'M21 9H3'], ['path', 'M21 15H3']],
  changed: [['path', 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8'], ['path', 'M3 3v5h5'], ['path', 'M12 7v5l4 2']],
  accepted: [['circle', '12,12,10'], ['path', 'm9 12 2 2 4-4']],
  declined: [['circle', '12,12,10'], ['path', 'm15 9-6 6'], ['path', 'm9 9 6 6']],
  done: [['path', 'M18 6 7 17l-5-5'], ['path', 'm22 10-7.5 7.5L13 16']],
  failed: [['path', 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3'], ['path', 'M12 9v4'], ['path', 'M12 17h.01']],
  reply: [['path', 'M20 18v-2a4 4 0 0 0-4-4H4'], ['path', 'm9 17-5-5 5-5']]
};
var SVG = 'http://www.w3.org/2000/svg';
function icon(name, size) {
  var svg = document.createElementNS(SVG, 'svg');
  var attrs = { 'class': 'ic', width: size || 14, height: size || 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' };
  Object.keys(attrs).forEach(function (k) { svg.setAttribute(k, attrs[k]); });
  ICONS[name].forEach(function (part) {
    var el = document.createElementNS(SVG, part[0]);
    if (part[0] === 'path') el.setAttribute('d', part[1]);
    else {
      var v = part[1].split(',');
      if (part[0] === 'circle') { el.setAttribute('cx', v[0]); el.setAttribute('cy', v[1]); el.setAttribute('r', v[2]); }
      else { el.setAttribute('x', v[0]); el.setAttribute('y', v[1]); el.setAttribute('width', v[2]); el.setAttribute('height', v[3]); el.setAttribute('rx', v[4]); }
    }
    svg.appendChild(el);
  });
  return svg;
}
/** An element with a class and children: strings become text nodes, never markup. */
function h(tag, cls) {
  var el = made(document.createElement(tag));
  if (cls) el.className = cls;
  for (var i = 2; i < arguments.length; i += 1) {
    var c = arguments[i];
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}
function button(cls, act, children, key) {
  var b = h('button', 'btn ' + cls);
  b.type = 'button';
  b.setAttribute('data-act', act);
  children.forEach(function (c) { b.appendChild(typeof c === 'string' ? h('span', '', c) : c); });
  if (key) b.appendChild(h('kbd', '', key));
  return b;
}
function quoted(s) { return '\u201c' + s + '\u201d'; }
function when(ms) {
  if (typeof ms !== 'number') return '';
  try {
    var p = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
    var g = function (t) { var f = p.filter(function (x) { return x.type === t; })[0]; return f ? f.value : ''; };
    return g('day') + ' ' + g('month') + ', ' + g('hour') + ':' + g('minute');
  } catch (e) { return ''; }
}
var authorName = author || 'The author';

/* ---------- statuses and cards ---------- */
var STATUS = { open: ['open', 'Open', 'st-open'], unsent: ['cloudoff', 'Not sent yet', 'st-unsent'], refused: ['ban', 'Not sent', 'st-failed'],
  accepted: ['accepted', 'Accepted', 'st-accepted'], declined: ['declined', 'Declined', 'st-declined'], done: ['done', 'Done', 'st-done'], failed: ['failed', 'Could not be applied', 'st-failed'] };
function status(s) { var d = STATUS[s]; return h('span', 'st ' + d[2], icon(d[0], 14), d[1]); }
function kindOf(n) { return n.kind === 'edit' ? h('span', 'kind', icon('pencil', 14), 'Proposed edit') : h('span', 'kind', icon('note', 14), 'Comment'); }
function whenLine(n) {
  if (OUTCOME[n.state] === true) return when(n.outcomeAt || n.receivedAt);
  return n.state === 'open' ? 'Sent ' + when(n.receivedAt) : 'Written ' + when(n.writtenAt);
}
/** The author's reply in a thread: their name as the page says it, the author tag, the reply as text. */
function replyEntry(r) {
  return h('li', 't-entry by-author',
    h('div', 't-head', icon('reply', 13), h('span', 'who', authorName), h('span', 'role r-author', 'author'), h('span', 'kind', 'Reply'), h('span', 'when', when(r.at))),
    h('p', 't-body', r.text));
}
function replyCount(group) { return group.notes.reduce(function (sum, n) { return sum + (n.replies ? n.replies.length : 0); }, 0); }
function bodyOf(n, cls) {
  if (n.kind === 'edit') { var p = h('p', cls === 't-body' ? 't-body' : 'c-diff'); p.appendChild(wordDiff(n.anchor.quote, n.text)); return p; }
  return h('p', cls, n.text);
}
function refusalText(reason) {
  if (reason === 'comments_off') return 'Comments are off for this link. Your comment has not been sent.';
  if (reason === 'invalid') return 'This comment could not be sent.';
  return authorName + ' is not receiving more comments on this link for now. Your comment has not been sent.';
}
function noticeOf(n) {
  if (n.state === 'unsent') return h('p', 'notice', icon('wifioff', 14), h('span', '', 'Sends by itself when the connection returns.'));
  if (n.state === 'refused') return h('p', 'notice', icon('ban', 14), h('span', '', refusalText(n.reason)));
  if (n.state === 'accepted' && n.kind === 'edit') return h('p', 'notice', icon('info', 14), h('span', '', 'The text now has your words.'));
  if (n.state === 'failed') return h('p', 'notice', icon('info', 14), h('span', '', 'The text changed before this could be applied. Your wording is kept here.'));
  return null;
}

function cardFor(group) {
  var main = group.notes[0], rest = group.notes.slice(1);
  var replies = replyCount(group);
  var art = h('article', 'nitem card ' + (main.kind === 'edit' ? 'k-edit' : 'k-note'));
  art.setAttribute('data-key', group.key);
  art.setAttribute('data-entries', String(group.notes.length + replies));
  var user = state.fold[group.key];
  if (user) art.setAttribute('data-user', user);
  if (user === 'fold') art.classList.add('is-folded');
  var summary = h('span', 'fl-sum');
  var flst = h('span', 'fl-st');
  if (rest.length || replies) {
    var names = [];
    group.notes.forEach(function (n) { if (names.indexOf(n.name) < 0) names.push(n.name); });
    summary.appendChild(h('b', '', names[0]));
    summary.appendChild(document.createTextNode((names.length > 1 ? ' and ' + (names.length - 1) + ' more' : '') + ' \u00b7 ' + group.notes.length + (group.notes.length === 1 ? ' comment' : ' comments') + (replies ? ' ' : '')));
    if (replies) {
      var rep = h('span', 'fl-rep', icon('reply', 13), String(replies));
      rep.title = replies === 1 ? '1 reply' : replies + ' replies';
      summary.appendChild(rep);
    }
  }
  if (rest.length) {
    var open = group.notes.filter(function (n) { return n.state === 'open'; }).length;
    flst.appendChild(open ? h('span', 'st st-open', icon('open', 14), open + ' open') : status(main.state));
  } else if (replies) {
    flst.appendChild(status(main.state));
  } else {
    summary.appendChild(h('b', '', main.name));
    summary.appendChild(icon(main.kind === 'edit' ? 'pencil' : 'note', 13));
    summary.appendChild(h('span', 'fl-x', main.text));
    flst.appendChild(status(main.state));
  }
  var line = h('button', 'fold-line', icon('right', 15), h('span', 'num', String(group.num)), summary, flst);
  line.type = 'button';
  line.setAttribute('data-act', 'unfold');
  line.setAttribute('aria-expanded', 'false');
  var foldBtn = h('button', 'foldbtn', icon('up', 16));
  foldBtn.type = 'button';
  foldBtn.setAttribute('data-act', 'fold');
  foldBtn.setAttribute('aria-label', 'Fold');
  foldBtn.title = 'Fold';
  var full = h('div', 'card-full',
    h('header', 'c-head', h('span', 'num', String(group.num)), h('span', 'who', main.name), h('span', 'role', 'you'), kindOf(main), foldBtn),
    h('p', 'c-status', status(main.state), h('span', 'when', whenLine(main)), group.changed ? h('span', 'st st-changed', icon('changed', 14), 'Passage changed') : null),
    group.changed || main.state === 'failed' ? h('div', 'written', h('span', 'lab', 'Written on these words'), h('q', '', main.anchor.quote)) : null,
    bodyOf(main, 'c-body'),
    noticeOf(main),
    group.changed ? h('p', 'notice', icon('info', 14), h('span', '', 'Shown beside the nearest passage.')) : null);
  if (rest.length || replies) {
    // The thread: the other notes on these words and the author's replies, oldest first.
    var entries = [];
    group.notes.forEach(function (n, i) {
      if (i > 0) entries.push({ at: n.receivedAt || n.writtenAt || 0, el: h('li', 't-entry',
        h('div', 't-head', icon(n.kind === 'edit' ? 'pencil' : 'note', 13), h('span', 'who', n.name), h('span', 'kind', n.kind === 'edit' ? 'Proposed edit' : 'Comment'), h('span', 'when', whenLine(n)), status(n.state)),
        bodyOf(n, 't-body'),
        noticeOf(n)) });
      (n.replies || []).forEach(function (r) { entries.push({ at: r.at, el: replyEntry(r) }); });
    });
    entries.sort(function (a, b) { return a.at - b.at; });
    var list = h('ol', 'c-thread');
    entries.forEach(function (e) { list.appendChild(e.el); });
    full.appendChild(list);
  }
  var refused = group.notes.filter(function (n) { return n.state === 'refused'; });
  if (refused.length) {
    var acts = h('div', 'c-actions', button('', 'copy-note', [icon('copy', 14), 'Copy your comment']), button('ghost', 'remove-note', ['Remove']));
    acts.setAttribute('data-id', refused[0].id);
    full.appendChild(acts);
  }
  art.appendChild(line);
  art.appendChild(full);
  return art;
}

/* ---------- composers ---------- */
function composerFor(c) {
  var q = c.cap ? c.cap.anchor.quote : '';
  var el;
  if (c.kind === 'choice') {
    el = h('section', 'nitem comp comp-choice',
      h('p', 'cq', h('span', 'lab', 'Selected'), h('q', '', q)),
      h('div', 'acts col', button('b-note', 'note', [icon('noteplus', 15), 'Comment'], 'N'), button('b-edit', 'edit', [icon('pencil', 15), 'Propose edit'], 'E')),
      h('p', 'esc', h('kbd', '', 'Esc'), ' clears the selection'));
    el.setAttribute('aria-label', 'What to do with the selected words');
  } else if (c.kind === 'name') {
    var input = h('input', 'name-field');
    input.id = 'wf-name-field';
    input.maxLength = 60;
    input.autocomplete = 'name';
    input.value = readerName;
    var label = h('label', 'lab', authorName + ' sees this name beside each comment');
    label.htmlFor = input.id;
    el = h('section', 'nitem comp', h('header', 'ch', icon('user', 16), h('b', '', 'Your name')), label, input,
      h('p', 'esc', 'Asked once in this browser. You can change it later.'),
      h('div', 'acts', button('primary', 'continue', ['Continue'], '\u21b5'), button('ghost', 'cancel', ['Cancel'], 'Esc')));
    el.setAttribute('aria-label', 'Your name');
  } else if (c.kind === 'note' || c.kind === 'edit') {
    var area = h('textarea', 'text-field');
    area.id = 'wf-text-field';
    area.rows = c.kind === 'note' ? 4 : 3;
    area.maxLength = 4000;
    area.value = c.text;
    var lab = h('label', 'lab', c.kind === 'note' ? 'Your comment' : 'Change the words');
    lab.htmlFor = area.id;
    var sendBtn = button('primary', 'send', [icon('send', 14), 'Send'], '\u2318\u21b5');
    var parts = [h('header', 'ch', icon(c.kind === 'note' ? 'note' : 'pencil', 16), h('b', '', c.kind === 'note' ? 'Comment' : 'Propose edit'))];
    if (c.kind === 'note') parts.push(h('p', 'cq', h('span', 'lab', 'On these words'), h('q', '', q)));
    parts.push(lab, area);
    if (c.kind === 'edit') parts.push(h('span', 'lab dif-lab', 'Your change, word by word'), h('div', 'difbox'));
    parts.push(h('div', 'acts', sendBtn, button('ghost', 'cancel', ['Cancel'], 'Esc')));
    el = h('section', 'nitem comp k-' + c.kind);
    parts.forEach(function (p) { el.appendChild(p); });
    el.setAttribute('aria-label', c.kind === 'note' ? 'Write a comment' : 'Propose an edit');
  } else if (c.kind === 'too-long') {
    el = h('section', 'nitem comp comp-long',
      h('p', 'refuse', icon('info', 15), h('span', '', 'The selection is too long to comment on. Select fewer words.')),
      h('div', 'acts', button('ghost', 'cancel', ['Close'], 'Esc')));
    el.setAttribute('aria-label', 'The selection is too long to comment on');
    el.setAttribute('role', 'alert');
  } else {
    var kept = h('textarea', 'text-field');
    kept.rows = 3;
    kept.readOnly = true;
    kept.value = c.text;
    el = h('section', 'nitem comp k-' + (c.noteKind === 'edit' ? 'edit' : 'note'),
      h('header', 'ch', icon(c.noteKind === 'edit' ? 'pencil' : 'note', 16), h('b', '', c.noteKind === 'edit' ? 'Propose edit' : 'Comment')),
      h('p', 'cq', h('span', 'lab', 'On these words'), h('q', '', q)),
      kept,
      h('p', 'refuse', icon('ban', 15), h('span', '', refusalText(c.reason))),
      h('div', 'acts', button('', 'copy', [icon('copy', 14), 'Copy your comment']), button('ghost', 'cancel', ['Close'], 'Esc')));
    el.setAttribute('aria-label', 'Comment not sent');
  }
  el.setAttribute('data-comp', c.kind);
  return el;
}
function refreshComposer() {
  var c = state.composer;
  if (!c || !c.el) return;
  var field = c.el.querySelector('textarea.text-field');
  var send = c.el.querySelector('[data-act="send"]');
  if (field && send) {
    var unchanged = c.kind === 'edit' ? norm(field.value) === c.cap.anchor.quote : norm(field.value) === '';
    send.disabled = unchanged || c.sending;
  }
  var dif = c.el.querySelector('.difbox');
  if (dif && field) { dif.textContent = ''; dif.appendChild(wordDiff(c.cap.anchor.quote, field.value)); }
}
function openComposer(kind, cap, extra) {
  if ((kind === 'note' || kind === 'edit') && !readerName) return openComposer('name', cap, { next: kind });
  var c = { kind: kind, cap: cap, text: kind === 'edit' && cap ? cap.anchor.quote : '', next: null, reason: null, noteKind: null };
  Object.keys(extra || {}).forEach(function (k) { c[k] = extra[k]; });
  c.el = composerFor(c);
  state.composer = c;
  refreshComposer();
  render();
  var field = c.el.querySelector('input, textarea:not([readonly])');
  if (field) { field.focus(); if (field.tagName === 'TEXTAREA') field.setSelectionRange(field.value.length, field.value.length); }
}
/**
 * Close the composer. One opened over another (the name, asked while a note was being written)
 * gives that one back as it was, its text with it: an unsent draft is never thrown away.
 */
function closeComposer() {
  var back = state.composer && state.composer.resume;
  state.composer = null;
  if (back) return resumeComposer(back);
  render();
}
function resumeComposer(c) {
  state.composer = c;
  refreshComposer();
  render();
  var field = c.el.querySelector('input, textarea:not([readonly])');
  if (field) { field.focus(); if (field.tagName === 'TEXTAREA') field.setSelectionRange(field.value.length, field.value.length); }
}
function busyComposer() { var c = state.composer; return c && (c.kind === 'name' || c.kind === 'refused' || c.sending || (c.kind === 'note' && norm(c.text)) || (c.kind === 'edit' && norm(c.text) !== c.cap.anchor.quote)); }

/* ---------- the service ---------- */
function post(path, body) {
  return fetch('/s/' + shareId + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error'
  });
}
function asSent(view) { var list = noteList([view], 'open'); return list[0] || null; }
/** Send one note: 'ok', 'refused', 'comments_off', 'invalid', 'off' or 'network'. */
function sendNote(n) {
  var payload = { id: n.id, kind: n.kind, name: n.name, text: n.text, anchor: n.anchor, writtenAt: n.writtenAt, revision: revision };
  return post('/notes', { reader: secret, note: payload }).then(function (res) {
    if (res.status === 200 || res.status === 201) {
      return res.json().then(function (body) {
        var view = body && asSent(body.note);
        outbox = outbox.filter(function (o) { return o.id !== n.id; });
        keepOutbox();
        if (view) { sent = sent.filter(function (s) { return s.id !== view.id; }); sent.push(view); keepSent(); }
        return 'ok';
      });
    }
    if (res.body) res.body.cancel();
    if (res.status === 429) return 'refused';
    if (res.status === 403) return 'comments_off';
    if (res.status === 400) return 'invalid';
    if (res.status === 404) return 'off';
    return 'network';
  }, function () { return 'network'; });
}
function markOutbox(id, reason) {
  outbox.forEach(function (o) { if (o.id === id) { o.state = 'refused'; o.reason = reason; } });
  keepOutbox();
}
function flush() {
  if (state.flushing || state.linkOff) return Promise.resolve();
  var next = outbox.filter(function (o) { return o.state === 'unsent'; })[0];
  if (!next) return Promise.resolve();
  if (navigator.onLine === false) { setOffline(true); return Promise.resolve(); }
  state.flushing = true;
  return sendNote(next).then(function (result) {
    state.flushing = false;
    if (result === 'network') { setOffline(true); render(); return; }
    if (result === 'off') { state.linkOff = true; renderBar(); render(); return; }
    setOffline(false);
    if (result !== 'ok') markOutbox(next.id, result);
    render();
    return flush();
  });
}
function fetchMine() {
  return post('/notes/mine', { reader: secret }).then(function (res) {
    if (res.status === 404) { if (res.body) res.body.cancel(); state.linkOff = true; renderBar(); return; }
    if (res.status !== 200) { if (res.body) res.body.cancel(); return; }
    return res.json().then(function (body) {
      sent = noteList(body && body.notes, 'open');
      keepSent();
      var held = {};
      sent.forEach(function (s) { held[s.id] = true; });
      // A note the service already holds was sent: its answer was lost on the way back.
      outbox = outbox.filter(function (o) { return !held[o.id]; });
      keepOutbox();
      setOffline(false);
      render();
    });
  }, function () { setOffline(true); });
}
function setOffline(value) { if (state.offline !== value) { state.offline = value; renderBar(); } }

/* ---------- sending from the composer ---------- */
function sendComposer() {
  var c = state.composer;
  if (!c || (c.kind !== 'note' && c.kind !== 'edit') || c.sending) return;
  var field = c.el.querySelector('textarea.text-field');
  c.text = field.value;
  refreshComposer();
  var send = c.el.querySelector('[data-act="send"]');
  if (send.disabled) return;
  var n = { id: randomId(16), kind: c.kind, name: readerName, text: c.text.trim(), anchor: c.cap.anchor, writtenAt: Date.now(), receivedAt: null, state: 'unsent', reason: null };
  outbox.push(n);
  keepOutbox();
  if (navigator.onLine === false || state.flushing) { setOffline(navigator.onLine === false || state.offline); closeComposer(); return; }
  c.sending = true;
  refreshComposer();
  sendNote(n).then(function (result) {
    c.sending = false;
    if (result === 'refused' || result === 'comments_off') {
      outbox = outbox.filter(function (o) { return o.id !== n.id; });
      keepOutbox();
      if (state.composer === c) return openComposer('refused', c.cap, { text: n.text, reason: result, noteKind: n.kind });
      return render();
    }
    if (result === 'invalid') markOutbox(n.id, 'invalid');
    if (result === 'network') setOffline(true);
    else if (result === 'off') { state.linkOff = true; renderBar(); }
    else setOffline(false);
    if (state.composer === c) state.composer = null;
    render();
    if (result === 'ok') flush();
  });
}

/* ---------- the reader bar and the notes head ---------- */
var barExtra = null;
function renderBar() {
  if (barExtra) barExtra.forEach(function (el) { el.remove(); });
  barExtra = [];
  if (state.linkOff) barExtra.push(h('span', 'offline', icon('ban', 14), 'This link has been turned off. Comments cannot be sent.'));
  else if (state.offline) barExtra.push(h('span', 'offline', icon('wifioff', 14), 'Offline. Comments are sent when the connection returns.'));
  barExtra.push(h('span', 'spacer'));
  var seg = h('span', 'seg');
  [['margin', 'margin', 'Margin'], ['under', 'rows', 'Inline']].forEach(function (v) {
    var b = h('button', '', icon(v[1], 14), v[2]);
    b.type = 'button';
    b.setAttribute('data-act', 'view');
    b.setAttribute('data-view', v[0]);
    b.setAttribute('aria-pressed', String(state.view === v[0]));
    seg.appendChild(b);
  });
  var k = h('kbd', '', 'V');
  k.title = 'Switch where comments are shown';
  var sw = h('span', 'viewswitch', h('span', '', 'Comments'), seg, k);
  sw.setAttribute('role', 'group');
  sw.setAttribute('aria-label', 'Where comments are shown');
  barExtra.push(sw);
  barExtra.forEach(function (el) { el.classList.add('wf-bar'); rbar.appendChild(el); });
}
function notesHead(count) {
  var rows = [h('div', 'nh-t', h('b', '', 'Comments'), h('span', 'count', String(count)))];
  if (readerName) {
    var change = h('a', '', 'Change name');
    change.setAttribute('data-act', 'rename');
    change.setAttribute('role', 'button');
    change.tabIndex = 0;
    rows.push(h('div', 'nh-r nh-name', icon('user', 14), h('span', '', 'Reading as ', h('b', '', readerName), change)));
  }
  rows.push(h('div', 'nh-r', icon('lock', 14), h('span', '', 'Private comments: only you and ' + (author || 'the author') + ' see your comments.')));
  if (!count) rows.push(h('div', 'nh-r nh-empty', icon('select', 14), h('span', '', 'No comments yet. Select words in the text to leave a comment or propose an edit.')));
  rows.push(h('div', 'nh-r', icon('info', 14), h('span', '', 'Comments are kept in this browser. Open the link here again to see replies.')));
  var head = h('section', 'notes-head');
  rows.forEach(function (r) { head.appendChild(r); });
  head.setAttribute('aria-label', 'Comments');
  return head;
}

/* ---------- rendering ---------- */
function groupsNow() {
  var blocks = allBlocks(content), byKey = {}, groups = [];
  sent.concat(outbox).forEach(function (n) {
    var r = resolveAnchor(content, n.anchor);
    if (!r.block) return;
    var bi = blocks.indexOf(r.block);
    var key = r.changed ? 'c' + bi + ':' + n.anchor.quote : 'a' + bi + ':' + r.start + ':' + r.end;
    var g = byKey[key];
    if (!g) { g = byKey[key] = { key: key, notes: [], block: r.block, bi: bi, start: r.changed ? Infinity : r.start, end: r.end, changed: r.changed }; groups.push(g); }
    g.notes.push(n);
  });
  var order = function (n) { return n.receivedAt || n.writtenAt || 0; };
  groups.forEach(function (g) { g.notes.sort(function (a, b) { return order(a) - order(b); }); });
  groups.sort(function (a, b) { return a.bi - b.bi || a.start - b.start; });
  groups.forEach(function (g, i) { g.num = i + 1; });
  return groups;
}

var items = [], head = null, leaders = null;
function render() {
  unmarkAll(content);
  col.textContent = '';
  if (leaders) leaders.remove();
  var groups = groupsNow();
  items = [];
  var count = sent.length + outbox.length;
  head = notesHead(count);
  groups.forEach(function (g) {
    var el = cardFor(g), anchorEl = g.block;
    if (!g.changed) {
      var marks = markRange(g.block, g.start, g.end, g.notes[0].kind === 'edit' ? 'hl-edit' : 'hl-note', g.key);
      if (marks.length) {
        anchorEl = marks[0];
        var sup = h('sup', 'wf-ui mn', String(g.num));
        var last = marks[marks.length - 1];
        last.parentNode.insertBefore(sup, last.nextSibling);
      }
    }
    items.push({ el: el, a: anchorEl, b: g.block, card: true });
  });
  var c = state.composer;
  if (c) {
    var a = head, b = null;
    if (c.cap && c.cap.block.isConnected) {
      var sel = markRange(c.cap.block, c.cap.start, c.cap.end, 'hl-sel', '');
      a = sel[0] || c.cap.block;
      b = c.cap.block;
    } else if (c.block && c.block.isConnected) { a = c.block; b = c.block; }
    items.push({ el: c.el, a: a, b: b, card: false, composer: true });
  }
  rp.setAttribute('data-view', state.view);
  barExtra && barExtra.forEach(function (el) {
    el.querySelectorAll && [].slice.call(el.querySelectorAll('[data-view]')).forEach(function (btn) { btn.setAttribute('aria-pressed', String(btn.getAttribute('data-view') === state.view)); });
  });
  if (state.view === 'under') layoutUnder(); else layoutMargin();
}

/* ---------- layout: margin ---------- */
var LIMIT = 120, GAP = 10, SVGNS = SVG;
function rectIn(el, base) {
  var r = el.getClientRects()[0] || el.getBoundingClientRect(), b = base.getBoundingClientRect();
  return { top: r.top - b.top, mid: r.top + Math.min(r.height || 0, 26) / 2 - b.top, bottom: r.bottom - b.top, left: r.left - b.left, right: r.right - b.left };
}
function autoFold(el) { if (el.classList.contains('card') && el.getAttribute('data-user') !== 'open' && !el.classList.contains('is-folded')) { el.classList.add('is-folded'); el.setAttribute('data-auto', '1'); } }
function unAuto(el) { if (el.getAttribute('data-auto') === '1') { el.classList.remove('is-folded'); el.removeAttribute('data-auto'); } }
function makeStack(cards) {
  var s = h('div', 'stack nitem wf-ui', h('div', 'stack-head', icon('layers', 14), h('span', 'stack-n', cards.length + ' comments on this paragraph'), h('span', 'hint', 'Open one to read it')));
  cards.forEach(function (el) { autoFold(el); s.appendChild(el); });
  return s;
}
function byBlock(list, base) {
  var arr = list.map(function (it) { return { it: it, y: rectIn(it.a, base).top }; });
  arr.sort(function (x, y) { return x.y - y.y; });
  var out = [];
  arr.forEach(function (o) {
    var last = out[out.length - 1];
    if (last && o.it.b && last.b === o.it.b) last.push(o.it);
    else { var g = [o.it]; g.b = o.it.b; out.push(g); }
  });
  return out;
}
function layoutMargin() {
  col.appendChild(head);
  items.forEach(function (it) { it.el.style.top = '0px'; col.appendChild(it.el); });
  leaders = document.createElementNS(SVGNS, 'svg');
  leaders.setAttribute('class', 'leaders');
  leaders.setAttribute('aria-hidden', 'true');
  rbody.insertBefore(leaders, rbody.firstChild);
  var cursor = head.offsetTop + head.offsetHeight + 18;
  var gs = byBlock(items.filter(function (it) { return it.a !== head; }), col);
  var top = items.filter(function (it) { return it.a === head; });
  top.forEach(function (it) { it.el.style.top = cursor + 'px'; cursor += it.el.offsetHeight + GAP; });
  function desired(it) { return rectIn(it.a, col).top - 12; }
  gs.forEach(function (g, gi) {
    var units, c, level;
    var cards = g.filter(function (it) { return it.card; });
    for (level = 0; level <= 2; level += 1) {
      [].slice.call(col.querySelectorAll('.stack')).forEach(function (s) { if (s._g === gi) { while (s.children.length > 1) col.appendChild(s.lastChild); s.remove(); } });
      g.forEach(function (it) { unAuto(it.el); });
      units = g.map(function (it) { return { el: it.el, it: it }; });
      if (level === 1) cards.forEach(function (it) { if (+it.el.getAttribute('data-entries') > 1) autoFold(it.el); });
      if (level === 2) {
        if (cards.length >= 2) {
          var s = makeStack(cards.map(function (it) { return it.el; }));
          s._g = gi;
          col.appendChild(s);
          units = [{ el: s, it: cards[0] }].concat(g.filter(function (it) { return !it.card; }).map(function (it) { return { el: it.el, it: it }; }));
        } else cards.forEach(function (it) { autoFold(it.el); });
      }
      units.forEach(function (u) { u.el.style.top = '0px'; });
      c = cursor;
      var worst = 0;
      units.forEach(function (u) { var d = desired(u.it), t = Math.max(c, d); worst = Math.max(worst, t - d); u.top = t; c = t + u.el.offsetHeight + GAP; });
      var nx = gs[gi + 1], nd = nx ? desired(nx[0]) : Infinity;
      if ((worst <= LIMIT && c - nd <= LIMIT) || level === 2 || !cards.length) break;
    }
    units.forEach(function (u) {
      u.el.style.top = u.top + 'px';
      var ar = rectIn(u.it.a, rbody), tr = rectIn(content, rbody), cr = rectIn(col, rbody);
      var x1 = tr.right + 8, x2 = cr.left, y1 = ar.mid, y2 = cr.top + u.top + 16, mx = x1 + (x2 - x1) * 0.55;
      var p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', Math.abs(y1 - y2) < 3 ? 'M' + x1 + ' ' + y1 + 'H' + x2 : 'M' + x1 + ' ' + y1 + 'H' + mx + 'V' + y2 + 'H' + x2);
      leaders.appendChild(p);
      var dot = document.createElementNS(SVGNS, 'circle');
      dot.setAttribute('cx', x1); dot.setAttribute('cy', y1); dot.setAttribute('r', 2.5);
      leaders.appendChild(dot);
    });
    cursor = c;
  });
  col.style.minHeight = cursor + 'px';
}

/* ---------- layout: under the passage ---------- */
function placeOf(block) {
  var el = block;
  while (el.parentElement && el.parentElement !== content && !el.parentElement.classList.contains('wf-bundle-section')) el = el.parentElement;
  return el;
}
function layoutUnder() {
  col.style.minHeight = '';
  head.classList.add('wf-ui');
  var hero = kid(content, 'HEADER', 'hero');
  content.insertBefore(head, hero ? hero.nextSibling : content.firstChild);
  var after = {};
  var containers = [];
  items.forEach(function (it) {
    it.el.style.top = '';
    var place = it.a === head ? head : placeOf(it.b);
    var found = containers.filter(function (c) { return c.place === place; })[0];
    if (!found) { found = { place: place, list: [] }; containers.push(found); }
    found.list.push(it);
  });
  containers.forEach(function (c) {
    var box = h('div', 'under wf-ui');
    c.place.parentNode.insertBefore(box, c.place.nextSibling);
    var cards = c.list.filter(function (it) { return it.card; });
    if (cards.length >= 3) box.appendChild(makeStack(cards.map(function (it) { return it.el; })));
    else cards.forEach(function (it) { box.appendChild(it.el); });
    c.list.filter(function (it) { return !it.card; }).forEach(function (it) { box.appendChild(it.el); });
  });
}

/* ---------- views ---------- */
function chooseView() {
  var stored = load(VIEW_KEY, 'margin');
  state.view = narrow && narrow.matches ? 'under' : (stored === 'under' ? 'under' : 'margin');
}
function setView(v) {
  if (narrow && narrow.matches) return;
  save(VIEW_KEY, v);
  state.view = v;
  render();
}

/* ---------- reading the selection ---------- */
function takeSelection() {
  if (busyComposer()) return;
  var sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  var range = sel.getRangeAt(0);
  if (!content.contains(range.commonAncestorContainer)) return;
  var cap = captureSelection(content, range);
  if (!cap) return;
  sel.removeAllRanges();
  if (cap.tooLong) return openComposer('too-long', null, { block: cap.block });
  openComposer('choice', cap);
}
var selTimer = 0;
document.addEventListener('mouseup', function (e) { if (!e.target.closest || !e.target.closest('.comp')) setTimeout(takeSelection, 0); });
document.addEventListener('keyup', function (e) { if (e.shiftKey && !/TEXTAREA|INPUT/.test(e.target.tagName)) takeSelection(); });
document.addEventListener('selectionchange', function () {
  clearTimeout(selTimer);
  // Touch screens: the selection settles while the reader drags its handles.
  selTimer = setTimeout(function () { if (matchMedia('(pointer: coarse)').matches) takeSelection(); }, 700);
});

/* ---------- clicks and keys ---------- */
function act(name, el) {
  var c = state.composer;
  if (name === 'view') return setView(el.getAttribute('data-view'));
  if (name === 'fold' || name === 'unfold') {
    var card = el.closest('.card');
    state.fold[card.getAttribute('data-key')] = name === 'fold' ? 'fold' : 'open';
    return render();
  }
  if (name === 'note' || name === 'edit') return openComposer(name, c && c.cap);
  if (name === 'cancel') return closeComposer();
  if (name === 'rename') {
    // A note on its way finishes first; any other composer is given back after the name.
    if (c && c.sending) return;
    // The name already being asked: asking again changes nothing, so the draft under it still comes back.
    if (c && c.kind === 'name') { var nameField = c.el.querySelector('input'); if (nameField) nameField.focus(); return; }
    return openComposer('name', null, { next: null, resume: c || null });
  }
  if (name === 'continue') {
    var field = c.el.querySelector('input');
    var value = field.value.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!value) { field.focus(); return; }
    readerName = value;
    save(NAME_KEY, readerName);
    if (c.next && c.cap) return openComposer(c.next, c.cap);
    return closeComposer();
  }
  if (name === 'send') return sendComposer();
  if (name === 'copy' || name === 'copy-note') {
    var text = name === 'copy' ? c.text : (outbox.filter(function (o) { return o.id === el.closest('.c-actions').getAttribute('data-id'); })[0] || {}).text || '';
    var done = function () { var s = el.querySelector('span'); if (s) s.textContent = 'Copied'; };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
    return;
  }
  if (name === 'remove-note') {
    var id = el.closest('.c-actions').getAttribute('data-id');
    outbox = outbox.filter(function (o) { return o.id !== id; });
    keepOutbox();
    return render();
  }
}
/*
 * Every action an element asks for goes through here, whatever the event: the element must be one
 * this script made (UI_MADE). The author's HTML is not sanitised and may carry data-act, role or any
 * class; an element of the author's never acts, by click, key or anything else.
 */
function ownedAct(target) {
  var b = target && target.closest ? target.closest('[data-act]') : null;
  return b && UI_MADE.has(b) && rp.contains(b) ? b : null;
}
function dispatch(target) {
  var b = ownedAct(target);
  if (!b) return false;
  act(b.getAttribute('data-act'), b);
  return true;
}
document.addEventListener('click', function (e) { if (ownedAct(e.target)) { e.preventDefault(); dispatch(e.target); } });
document.addEventListener('input', function (e) {
  var c = state.composer;
  if (!c || !c.el.contains(e.target) || !e.target.classList.contains('text-field')) return;
  c.text = e.target.value;
  refreshComposer();
});
document.addEventListener('keydown', function (e) {
  var c = state.composer, inField = /TEXTAREA|INPUT/.test(e.target.tagName);
  if (c && e.key === 'Escape') { e.preventDefault(); closeComposer(); return; }
  if (c && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendComposer(); return; }
  if (c && c.kind === 'name' && e.key === 'Enter' && c.el.contains(e.target)) { e.preventDefault(); act('continue'); return; }
  // A link this script made to act as a button (Change name) acts on Enter and Space, as a button does.
  if ((e.key === 'Enter' || e.key === ' ') && e.target.tagName !== 'BUTTON' && ownedAct(e.target) === e.target) { e.preventDefault(); dispatch(e.target); return; }
  if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
  if (c && c.kind === 'choice' && (e.key === 'n' || e.key === 'e')) { e.preventDefault(); act(e.key === 'n' ? 'note' : 'edit'); return; }
  if (e.key === 'v' && !(narrow && narrow.matches)) setView(state.view === 'margin' ? 'under' : 'margin');
});
document.addEventListener('mouseover', function (e) {
  [].slice.call(rp.querySelectorAll('.is-linked')).forEach(function (x) { x.classList.remove('is-linked'); });
  var card = e.target.closest && e.target.closest('.card[data-key]');
  if (!card) return;
  card.classList.add('is-linked');
  MARKS.forEach(function (m) { if (m.getAttribute('data-key') === card.getAttribute('data-key')) m.classList.add('is-linked'); });
});

/* ---------- connection ---------- */
window.addEventListener('online', function () { setOffline(false); flush(); });
window.addEventListener('offline', function () { setOffline(true); });
setInterval(function () { if (outbox.some(function (o) { return o.state === 'unsent'; })) flush(); }, 20000);

/* ---------- start ---------- */
var resizeTimer = 0;
function relayout() {
  var before = state.view;
  chooseView();
  if (before !== state.view || state.view === 'margin') {
    var focused = document.activeElement, caret = focused && focused.selectionStart;
    render();
    if (focused && focused.isConnected && focused !== document.activeElement) { focused.focus(); if (typeof caret === 'number' && focused.setSelectionRange) focused.setSelectionRange(caret, caret); }
  }
}
window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(relayout, 120); });
if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout);
chooseView();
renderBar();
render();
fetchMine().then(flush);
`

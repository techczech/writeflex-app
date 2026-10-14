/**
 * The agent: the one script of WriteFlex's that runs INSIDE a widget, written as the first <script> of
 * its document so it runs before any script of the page. Ported from TalkWeaver `embed-agent.js` at
 * 6ec8102f, keeping the handshake, the storage stand-ins and Escape forwarding, and dropping capture,
 * replay and the slide-stepping keys.
 *
 * It does these things and nothing else:
 *   0. (before anything of the page runs) removes the constructors that open WebRTC and WebTransport
 *      connections, and removes every frame element the page puts into its document (see the source);
 *   1. removes its own <script> element, and runs once per document;
 *   2. gives the page in-memory `localStorage` / `sessionStorage` and an empty `document.cookie` where
 *      reading the real one throws (an opaque origin), so a widget that uses storage still works and
 *      can reach nothing of the app's;
 *   3. posts `ready` to its parent and accepts one `hello` (the token) from it;
 *   4. tells the parent the page's content height (`height`, with the token) on load and when it
 *      changes, so the block can fit it (integer pixels, throttled);
 *   5. tells the parent about Escape (`key`, with the token). It never calls preventDefault: the page
 *      keeps its own keys.
 *
 * What the page it lives in can do: it shares one script realm with the agent, so it can post its own
 * messages to the parent and may learn the token. Nothing it can send grants it anything (security
 * round 3): Escape only ends an engagement, a height report only sizes the block, and engagement comes
 * from the writer's press on the window's own cover over the widget (widget-frame.ts). The window
 * answers `ready` once per mount, so a page that replaces its document gets no second token.
 *
 * Kept as script TEXT, not as a function's source: the renderer bundle is minified, and a
 * `Function.prototype.toString()` of bundled code is not a stable thing to inline.
 */
import { WIDGET_MESSAGE_TAG, WIDGET_MESSAGE_VERSION } from './widget-protocol'

export const WIDGET_AGENT_SOURCE = `(function () {
"use strict";
var win = window;
var doc = win.document;
try { var own = doc.currentScript; if (own && own.parentNode) own.parentNode.removeChild(own); } catch (e) {}
var marker = Symbol.for("writeflex.widget.agent");
var earlier;
try { earlier = win[marker]; } catch (e) { earlier = null; }
if (earlier !== undefined) return;
try { Object.defineProperty(win, marker, { value: true }); } catch (e) {}

function memoryStorage() {
  var items = new Map();
  var api = {
    getItem: function (key) { key = String(key); return items.has(key) ? items.get(key) : null; },
    setItem: function (key, value) { items.set(String(key), String(value)); },
    removeItem: function (key) { items.delete(String(key)); },
    clear: function () { items.clear(); },
    key: function (index) { var keys = Array.from(items.keys()); return index >= 0 && index < keys.length ? keys[index] : null; }
  };
  return new Proxy(api, {
    get: function (target, name) {
      if (name === "length") return items.size;
      if (typeof name !== "string" || name in target) return target[name];
      return items.has(name) ? items.get(name) : undefined;
    },
    set: function (target, name, value) {
      if (typeof name === "string" && name !== "length" && !(name in target)) items.set(name, String(value));
      return true;
    },
    has: function (target, name) { return name === "length" || name in target || (typeof name === "string" && items.has(name)); },
    deleteProperty: function (target, name) { if (typeof name === "string") items.delete(name); return true; },
    ownKeys: function () { return Array.from(items.keys()); },
    getOwnPropertyDescriptor: function (target, name) {
      return typeof name === "string" && items.has(name) ? { value: items.get(name), writable: true, enumerable: true, configurable: true } : undefined;
    }
  });
}
["localStorage", "sessionStorage"].forEach(function (name) {
  var throws = false;
  try { void win[name]; } catch (e) { throws = true; }
  if (!throws) return;
  try { var store = memoryStorage(); Object.defineProperty(win, name, { configurable: true, enumerable: true, get: function () { return store; } }); } catch (e) {}
});
var cookieThrows = false;
try { void doc.cookie; } catch (e) { cookieThrows = true; }
if (cookieThrows) {
  try { Object.defineProperty(doc, "cookie", { configurable: true, enumerable: true, get: function () { return ""; }, set: function () {} }); } catch (e) {}
}

// No WebRTC, no frames of the widget's own (security fix round). The browser closes WebRTC over UDP for
// the whole window, but not TURN over TCP or TLS, so the constructors that open such connections are
// removed from this page before any of its own scripts run. A frame the page makes has an origin of its
// own (the sandbox gives every document in it a fresh opaque origin), so the page cannot reach into it,
// but a document loaded into it would run scripts of its own, with those constructors intact: main
// refuses data:, blob: and network loads in such frames, and the agent removes every frame element
// (iframe, frame, object, embed) the moment it is put into the page: at once after every DOM insertion
// call, and, for markup the parser inserts, before the frame's document can load (a microtask).
// The functions this relies on are taken now, before the page can replace them.
var apply = Reflect.apply;
var defineProperty = Object.defineProperty;
var getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
var querySelectorAll = Document.prototype.querySelectorAll;
var fragmentQuerySelectorAll = DocumentFragment.prototype.querySelectorAll;
var removeNode = Element.prototype.remove;
// Everything the sweep reads later is taken now too: the page may replace any getter or method on a
// prototype (a NodeList length that says 0, an Array push that drops a shadow root, a documentElement
// getter that says null), and the agent must not consult them after the page has run.
var nodeListLength = getOwnPropertyDescriptor(NodeList.prototype, "length").get;
var documentElementOf = getOwnPropertyDescriptor(Document.prototype, "documentElement").get;
var observe = MutationObserver.prototype.observe;
var Observer = MutationObserver;
var FRAMES = "iframe,frame,object,embed,fencedframe,portal";
// The agent's own listeners. The standard has document.open() (called by the page, or by
// document.write after the page has loaded) erase every listener of the document and its window, the
// agent's too: they are put back after every call that can do that (and after every other DOM call,
// where re-adding is a no-op). Chromium 148 was not seen to erase them; this holds if it starts to.
var addListener = EventTarget.prototype.addEventListener;
var listeners = [];
var listenerCount = 0;
function listen(target, type, fn) {
  defineProperty(listeners, listenerCount, { value: [target, type, fn], writable: false, enumerable: true, configurable: false });
  listenerCount += 1;
  try { apply(addListener, target, [type, fn, true]); } catch (e) {}
}
function relisten() { for (var i = 0; i < listenerCount; i += 1) { try { apply(addListener, listeners[i][0], [listeners[i][1], listeners[i][2], true]); } catch (e) {} } }
var NETWORK_CONSTRUCTORS = ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCIceTransport", "WebTransport"];
var INSERTIONS = [
  ["Node", "appendChild"], ["Node", "insertBefore"], ["Node", "replaceChild"], ["Node", "moveBefore"],
  ["Element", "append"], ["Element", "prepend"], ["Element", "before"], ["Element", "after"], ["Element", "replaceWith"],
  ["Element", "replaceChildren"], ["Element", "insertAdjacentElement"], ["Element", "insertAdjacentHTML"],
  ["Element", "setAttribute"], ["Element", "setAttributeNS"], ["Element", "toggleAttribute"],
  ["Document", "append"], ["Document", "prepend"], ["Document", "replaceChildren"],
  ["Document", "execCommand"], ["Document", "open"], ["CharacterData", "before"], ["CharacterData", "after"], ["CharacterData", "replaceWith"],
  ["DocumentType", "before"], ["DocumentType", "after"], ["DocumentType", "replaceWith"], ["Range", "insertNode"], ["Range", "surroundContents"]
];
// Markup that the parser reads with declarative shadow trees on: their text is given the same treatment
// as the page's own (no shadowrootmode attribute survives), so every shadow tree is one the agent saw
// made (attachShadow) and can sweep.
var MARKUP = [["Document", "write"], ["Document", "writeln"], ["Element", "setHTMLUnsafe"], ["ShadowRoot", "setHTMLUnsafe"]];
var toLower = String.prototype.toLowerCase;
var indexOf = String.prototype.indexOf;
var sliceText = String.prototype.slice;
var StringOf = String;
function inertMarkup(value) {
  var text = StringOf(value);
  var lower = apply(toLower, text, []);
  var out = "";
  var from = 0;
  for (;;) {
    var at = apply(indexOf, lower, ["shadowrootmode", from]);
    if (at < 0) return out + apply(sliceText, text, [from]);
    out += apply(sliceText, text, [from, at]) + "data-wf-inert-";
    from = at;
    out += apply(sliceText, text, [from, from + 14]);
    from += 14;
  }
}
// document.write streams into the parser: an attribute name split across two calls ("shadowroot" then
// "mode") would be put together by the tokenizer after each piece was checked alone. The last letters
// written are kept, and a "shadowrootmode" that forms across the boundary is broken in the new piece.
var WORD = "shadowrootmode";
var writtenTail = "";
function inertStream(value) {
  var text = inertMarkup(value);
  var lower = apply(toLower, text, []);
  var joined = writtenTail + lower;
  var out = text;
  // A match that starts in the tail and ends in this piece: put a breaking letter before its first
  // letter in this piece (once is enough: the word can start in the tail at most once).
  for (var start = 0; start < writtenTail.length; start += 1) {
    if (apply(indexOf, joined, [WORD, start]) === start && start + WORD.length > writtenTail.length) {
      out = "_" + out;
      break;
    }
  }
  var all = writtenTail + apply(toLower, out, []);
  writtenTail = apply(sliceText, all, [all.length > WORD.length - 1 ? all.length - (WORD.length - 1) : 0]);
  return out;
}
var SETTERS = [["Element", "innerHTML"], ["Element", "outerHTML"], ["ShadowRoot", "innerHTML"]];
var shadowRoots = [];
var shadowRootCount = 0;
function keepShadowRoot(root) {
  defineProperty(shadowRoots, shadowRootCount, { value: root, writable: false, enumerable: true, configurable: false });
  shadowRootCount += 1;
}
function dropFrames(root, select) {
  var found;
  var count = 0;
  try { found = apply(select, root, [FRAMES]); count = apply(nodeListLength, found, []); } catch (e) { return; }
  for (var i = 0; i < count; i += 1) { try { apply(removeNode, found[i], []); } catch (e) {} }
}
// A frame the agent cannot find (inside a closed shadow tree the parser made from a declarative
// template) still counts in the window's own frame count, which the page cannot change. If any frame is
// left after the sweep, the page's whole document goes: its frames go with it, before they can load.
var removeDocumentElement = function () { try { var root = apply(documentElementOf, doc, []); if (root) apply(removeNode, root, []); } catch (e) {} };
function frameCount() { try { return win.length; } catch (e) { return 0; } }
function dropAllFrames() {
  dropFrames(doc, querySelectorAll);
  for (var i = 0; i < shadowRootCount; i += 1) dropFrames(shadowRoots[i], fragmentQuerySelectorAll);
  if (frameCount() > 0) removeDocumentElement();
  relisten();
}
function lock(target, name, descriptor) { try { defineProperty(target, name, descriptor); } catch (e) {} }
(function seal() {
  var i;
  for (i = 0; i < NETWORK_CONSTRUCTORS.length; i += 1) lock(win, NETWORK_CONSTRUCTORS[i], { value: undefined, writable: false, enumerable: false, configurable: false });
  for (i = 0; i < INSERTIONS.length; i += 1) {
    (function (owner, name) {
      var proto = null;
      try { proto = win[owner] && win[owner].prototype; } catch (e) { proto = null; }
      var d = proto ? getOwnPropertyDescriptor(proto, name) : null;
      if (!d || typeof d.value !== "function") return;
      var original = d.value;
      var wrapped = { [name]: function () { try { return apply(original, this, arguments); } finally { dropAllFrames(); } } }[name];
      lock(proto, name, { value: wrapped, writable: false, enumerable: d.enumerable, configurable: false });
    })(INSERTIONS[i][0], INSERTIONS[i][1]);
  }
  for (i = 0; i < MARKUP.length; i += 1) {
    (function (owner, name) {
      var proto = null;
      try { proto = win[owner] && win[owner].prototype; } catch (e) { proto = null; }
      var d = proto ? getOwnPropertyDescriptor(proto, name) : null;
      if (!d || typeof d.value !== "function") return;
      var original = d.value;
      var streaming = owner === "Document";
      var wrapped = { [name]: function () {
        // Array literals only: an index assignment could meet a setter the page put on Array.prototype.
        var args;
        if (streaming) {
          // write(a, b) is write(a + b): checked as one piece, and against what was written before.
          var text = "";
          for (var j = 0; j < arguments.length; j += 1) text += StringOf(arguments[j]);
          args = arguments.length > 0 ? [inertStream(text)] : [];
        } else {
          args = arguments.length > 1 ? [inertMarkup(arguments[0]), arguments[1]] : [inertMarkup(arguments[0])];
        }
        try { return apply(original, this, args); } finally { dropAllFrames(); }
      } }[name];
      lock(proto, name, { value: wrapped, writable: false, enumerable: d.enumerable, configurable: false });
    })(MARKUP[i][0], MARKUP[i][1]);
  }
  var parseUnsafe = getOwnPropertyDescriptor(Document, "parseHTMLUnsafe");
  if (parseUnsafe && typeof parseUnsafe.value === "function") {
    var parseOriginal = parseUnsafe.value;
    lock(Document, "parseHTMLUnsafe", { value: function parseHTMLUnsafe(html, options) { return apply(parseOriginal, this, arguments.length > 1 ? [inertMarkup(html), options] : [inertMarkup(html)]); }, writable: false, enumerable: parseUnsafe.enumerable, configurable: false });
  }
  for (i = 0; i < SETTERS.length; i += 1) {
    (function (owner, name) {
      var proto = null;
      try { proto = win[owner] && win[owner].prototype; } catch (e) { proto = null; }
      var d = proto ? getOwnPropertyDescriptor(proto, name) : null;
      if (!d || typeof d.set !== "function") return;
      var set = d.set;
      lock(proto, name, { get: d.get, set: function (value) { try { apply(set, this, [value]); } finally { dropAllFrames(); } }, enumerable: d.enumerable, configurable: false });
    })(SETTERS[i][0], SETTERS[i][1]);
  }
  var attach = getOwnPropertyDescriptor(Element.prototype, "attachShadow");
  if (attach && typeof attach.value === "function") {
    var attachOriginal = attach.value;
    // Every shadow root is made here, kept, and watched. None may be clonable or serializable: a clone of
    // a clonable closed root would be a shadow tree the agent never saw made.
    lock(Element.prototype, "attachShadow", { value: function attachShadow(options) {
      var mode = "open";
      var delegatesFocus = false;
      var slotAssignment = "named";
      try { mode = options && options.mode === "closed" ? "closed" : "open"; delegatesFocus = Boolean(options && options.delegatesFocus); slotAssignment = options && options.slotAssignment === "manual" ? "manual" : "named"; } catch (e) {}
      var root = apply(attachOriginal, this, [{ mode: mode, delegatesFocus: delegatesFocus, slotAssignment: slotAssignment, clonable: false, serializable: false }]);
      keepShadowRoot(root);
      watch(root);
      return root;
    }, writable: false, enumerable: attach.enumerable, configurable: false });
  }
})();
function watch(root) { try { apply(observe, new Observer(dropAllFrames), [root, { childList: true, subtree: true }]); } catch (e) {} }
watch(doc);
listen(doc, "DOMContentLoaded", dropAllFrames);
listen(win, "load", dropAllFrames);

var parentWindow = null;
try { parentWindow = win.parent; } catch (e) { parentWindow = null; }
if (!parentWindow || parentWindow === win) return;

var TAG = ${JSON.stringify(WIDGET_MESSAGE_TAG)};
var VERSION = ${JSON.stringify(WIDGET_MESSAGE_VERSION)};
// The token travels only in messages from the parent, and the page must never read it (with it, it could
// forge a press). The page runs after the agent and can replace any built-in the agent would look up later:
// the MessageEvent getters, Event methods, Object.keys, RegExp.prototype.exec (behind RegExp test),
// String methods. So everything the handshake uses is taken now, and the token is checked by hand.
var messageSource = getOwnPropertyDescriptor(MessageEvent.prototype, "source").get;
var messageData = getOwnPropertyDescriptor(MessageEvent.prototype, "data").get;
var stopNow = Event.prototype.stopImmediatePropagation;
var ownKeys = Object.keys;
var charCode = String.prototype.charCodeAt;
function isToken(value) {
  if (typeof value !== "string" || value.length !== 32) return false;
  for (var i = 0; i < 32; i += 1) {
    var c = apply(charCode, value, [i]);
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false;
  }
  return true;
}
var token = "";
var awaitingHello = false;
function post(message) { try { parentWindow.postMessage(message, "*"); } catch (e) {} }

function onMessage(event) {
  try {
    if (apply(messageSource, event, []) !== parentWindow) return;
    var data = apply(messageData, event, []);
    if (data === null || typeof data !== "object" || data.wf !== TAG) return;
    apply(stopNow, event, []);
    var keys = ownKeys(data);
    if (keys.length !== 4 || data.v !== VERSION || !isToken(data.t)) return;
    if (data.k !== "hello" || !awaitingHello) return;
    awaitingHello = false;
    token = data.t;
    lastHeight = -1;
    reportHeight();
  } catch (e) {}
}
function onKeydown(event) {
  if (token === "" || event.isTrusted !== true) return;
  if (event.key !== "Escape" || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing === true) return;
  post({ wf: TAG, v: VERSION, k: "key", t: token, key: "Escape" });
}
function now() { try { return win.performance.now(); } catch (e) { return Date.now(); } }
var lastHeight = -1;
var heightTimer = 0;
var heightAt = -Infinity;
function measure() {
  try {
    var h = doc.documentElement ? doc.documentElement.getBoundingClientRect().height : 0;
    var b = doc.body ? doc.body.getBoundingClientRect().bottom + (win.scrollY || 0) : 0;
    return Math.ceil(Math.max(h, b));
  } catch (e) { return 0; }
}
function reportHeight() {
  heightTimer = 0;
  if (token === "") return;
  var h = measure();
  if (h < 40 || h > 20000 || h === lastHeight) return;
  lastHeight = h;
  heightAt = now();
  post({ wf: TAG, v: VERSION, k: "height", t: token, h: h });
}
function scheduleHeight() {
  if (heightTimer) return;
  var wait = Math.max(0, 100 - (now() - heightAt));
  heightTimer = win.setTimeout(reportHeight, wait);
}
try {
  if (typeof win.ResizeObserver === "function") {
    var observer = new win.ResizeObserver(scheduleHeight);
    observer.observe(doc.documentElement);
    var watchBody = function () { if (doc.body) observer.observe(doc.body); };
    if (doc.body) watchBody(); else listen(doc, "DOMContentLoaded", watchBody);
  }
  listen(win, "load", scheduleHeight);
} catch (e) {}
listen(win, "message", onMessage);
listen(win, "keydown", onKeydown);
awaitingHello = true;
post({ wf: TAG, v: VERSION, k: "ready" });
})();`

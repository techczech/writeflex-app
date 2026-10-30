// Runs before the comments runtime's early return, so read-only Folios have navigation too.
export const READER_RUNTIME_NAVIGATION = `
(function () {
  if (!rp.classList.contains('folio')) return;
  var sidebar = rp.querySelector(':scope > .rbody > .sidebar');
  var bar = rp.querySelector(':scope > .rbar');
  if (!sidebar || !bar) return;
  var button = bar.querySelector('.contents-button'), current = bar.querySelector('.current-section');
  if (!button || !current) return; // Older stored pages keep their original contents links.
  var close = sidebar.querySelector('.close-contents'), scrim = rp.querySelector(':scope > .contents-scrim');
  var parts = [].slice.call(sidebar.querySelectorAll('.nav-part'));
  var nodes = [].slice.call(sidebar.querySelectorAll('a.nav-link')).map(function (a) {
    var el = document.getElementById(a.hash.slice(1));
    return el ? { a: a, el: el, part: a.closest('.nav-part'), section: a.closest('.nav-section') } : null;
  }).filter(Boolean);
  var lastPart = parts[0] || null, active = null;
  function closeDrawer(restore) {
    rp.classList.remove('nav-open');
    if (button) button.setAttribute('aria-expanded', 'false');
    if (restore && button) button.focus();
  }
  rp.classList.add('nav-ready');
  if (button) button.addEventListener('click', function () {
    if (rp.classList.contains('nav-open')) return closeDrawer(true);
    rp.classList.add('nav-open'); button.setAttribute('aria-expanded', 'true');
    if (close) close.focus();
  });
  if (close) close.addEventListener('click', function () { closeDrawer(true); });
  if (scrim) scrim.addEventListener('click', function () { closeDrawer(true); });
  document.addEventListener('keydown', function (e) {
    if (!rp.classList.contains('nav-open')) return;
    if (e.key === 'Escape') { e.preventDefault(); closeDrawer(true); }
    if (e.key === 'Tab') {
      var focusable = [].slice.call(sidebar.querySelectorAll('button,a[href],summary')).filter(function (el) { return el.getClientRects().length; });
      var first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  function expand(part) {
    if (part === lastPart) return;
    parts.forEach(function (p) { p.open = p === part; });
    lastPart = part;
  }
  sidebar.addEventListener('click', function (e) {
    var a = e.target.closest('a.nav-link');
    if (!a || !sidebar.contains(a)) return;
    var node = nodes.find(function (n) { return n.a === a; });
    if (node) { expand(node.part); node.part.open = true; }
    if (rp.classList.contains('nav-open')) {
      closeDrawer(false);
      if (node) { node.el.setAttribute('tabindex', '-1'); node.el.focus({ preventScroll: true }); }
    }
  });
  function follow() {
    var cur = null;
    nodes.forEach(function (n) { if (n.el.getBoundingClientRect().top <= 110) cur = n; });
    if (current) current.textContent = cur ? (cur.section ? cur.section.querySelector(':scope > .nav-link').textContent : cur.a.textContent) : 'Cover';
    if (cur) expand(cur.part); else if (parts[0]) expand(parts[0]);
    parts.forEach(function (p) {
      [].slice.call(p.querySelectorAll('.nav-section')).forEach(function (s) { s.classList.toggle('is-current', !!cur && cur.section === s); });
    });
    if (active === cur) return;
    if (active) { active.a.classList.remove('active'); active.a.removeAttribute('aria-current'); }
    active = cur;
    if (!cur) return;
    cur.a.classList.add('active'); cur.a.setAttribute('aria-current', 'location');
    var r = cur.a.getBoundingClientRect(), nr = sidebar.getBoundingClientRect();
    if (r.top < nr.top + 60 || r.bottom > nr.bottom - 20) sidebar.scrollTop += r.top - nr.top - nr.height / 2;
  }
  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () { scheduled = false; follow(); });
  }
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  window.addEventListener('load', schedule);
  follow();
})();
`

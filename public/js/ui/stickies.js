/* =========================================================================
   Lístečky — sticky notes over every page, desktop only.

   The header's note button makes one. It floats over whatever view is on
   screen (a fixed layer outside the views), goes where it is dragged by its
   bar, is resized from its corner, and stays put — across views, reloads and
   desktops — until the owner deletes it: × in the corner asks "Smazat
   lísteček?" in a strip under the bar (Nechat · Smazat), every note, until
   answered. The header's bin, there while any note is, deletes them all —
   after its own question. Kacey writes them too (app_sticky).

   Stored on the server, one row per note (stickies.js, /api/stickies). This
   page sends only the fields that changed — the text debounced, a place or
   size when the drag ends — and keeps them while offline, to send when the
   connection is back. A `stickies` frame (Kacey, another desktop) reloads
   the list; the page's own frames are skipped by `origin`. A note without a
   place yet (x/y null: Kacey's) sits in the top right corner until dragged.

   The phone hides the layer: a note placed on a 1920px screen means nothing
   on a 390px one.
   ========================================================================= */

import { $ } from '../core/dom.js';
import { el } from '../core/el.js';
import * as bus from '../core/bus.js';
import { say } from './toast.js';

var MAX = 12;
var W = 240, H = 180;
var ORIGIN = 'p' + Math.random().toString(36).slice(2, 10);

var layer = null;
var notes = [];              // as the server has them, plus this page's unsent changes
var nodes = {};              // id -> { box, text, x, confirm, timer }
var dirty = {};              // id -> the fields not saved yet
var flushTimer = {};         // id -> debounce timer
var drag = null;
var online = typeof navigator === 'undefined' || navigator.onLine !== false;
var offlineSaid = false;
var loadFailed = false;
var creating = false;

function noteOf(id) { return notes.find(function (n) { return n.id === id; }); }

function api(path, opts) {
  return fetch('/api/stickies' + path, Object.assign({ cache: 'no-store' }, opts || {})).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (out) {
      if (!res.ok || out.ok === false) throw Object.assign(new Error(out.error || 'HTTP ' + res.status), { status: res.status });
      return out;
    });
  });
}

function json(method, body) {
  return { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ origin: ORIGIN }, body)) };
}

/* A request that never reached the server, as opposed to one it refused. */
function isNetwork(err) { return !err.status; }

/* ---- loading ------------------------------------------------------------- */

var loadTimer = 0;
function load() {
  return api('').then(function (out) {
    loadFailed = false;
    // The server's list, with what this page has not saved yet on top.
    notes = (out.stickies || []).map(function (n) { return Object.assign({}, n, dirty[n.id] || {}); });
    paint();
  }).catch(function (err) {
    loadFailed = true;
    if (!isNetwork(err)) say('Lístečky se nepodařilo načíst — ' + err.message);
  });
}

function reloadSoon() { clearTimeout(loadTimer); loadTimer = setTimeout(load, 150); }

/* ---- saving -------------------------------------------------------------- */

/** Change a note here at once and on the server soon (`wait` ms; 0 = now). */
function change(id, part, wait) {
  var n = noteOf(id);
  if (!n) return;
  Object.assign(n, part);
  dirty[id] = Object.assign(dirty[id] || {}, part);
  clearTimeout(flushTimer[id]);
  flushTimer[id] = setTimeout(function () { flush(id); }, wait || 0);
}

function flush(id, keepalive) {
  clearTimeout(flushTimer[id]);
  var part = dirty[id];
  if (!part) return Promise.resolve();
  delete dirty[id];
  var opts = json('PATCH', part);
  if (keepalive) opts.keepalive = true;
  return api('/' + encodeURIComponent(id), opts).then(function () {
    if (offlineSaid && !Object.keys(dirty).length) { offlineSaid = false; say('Připojeno — lístečky jsou uložené.'); }
  }).catch(function (err) {
    if (err.status === 404) {
      // Deleted elsewhere in the meantime: it goes here too.
      notes = notes.filter(function (n) { return n.id !== id; });
      paint();
      return;
    }
    // Kept, under anything typed since, for the next try.
    dirty[id] = Object.assign({}, part, dirty[id] || {});
    if (isNetwork(err)) {
      if (!offlineSaid) { offlineSaid = true; say('Jsi offline — lísteček uložím, až se připojím.'); }
    } else say('Lísteček se nepodařilo uložit — ' + err.message);
    clearTimeout(flushTimer[id]);
    flushTimer[id] = setTimeout(function () { flush(id); }, 15000);
  });
}

function flushAll(keepalive) { Object.keys(dirty).forEach(function (id) { flush(id, keepalive); }); }

/* ---- making and deleting ------------------------------------------------- */

function create() {
  if (creating) return;
  if (notes.length >= MAX) { say('Víc lístečků se nevejde — nejdřív nějaký smaž.'); return; }
  if (!online) { say('Jsi offline — lísteček přidám, až se připojím.'); return; }
  var k = notes.length % 6;
  creating = true;
  api('', json('POST', { x: Math.max(0, window.innerWidth - W - 32 - k * 28), y: 72 + k * 28, w: W, h: H }))
    .then(function (out) {
      if (!noteOf(out.sticky.id)) notes.push(out.sticky);
      paint();
      var rec = nodes[out.sticky.id];
      if (rec) rec.text.focus();
    })
    .catch(function (err) {
      say(isNetwork(err) ? 'Jsi offline — lísteček přidám, až se připojím.' : err.message);
    })
    .then(function () { creating = false; });
}

function remove(id) {
  var rec = nodes[id];
  // What is still on its way out goes first, so Vrátit brings back the last text.
  flush(id).then(function () {
    return api('/' + encodeURIComponent(id) + '?origin=' + ORIGIN, { method: 'DELETE' });
  }).then(function (out) {
    gone(id);
    if (out.sticky && out.sticky.text.trim()) offerBack(out.sticky, 'Lísteček smazán.');
  }).catch(function (err) {
    if (err.status === 404) { gone(id); return; }
    if (rec) disarm(rec);
    say(isNetwork(err) ? 'Jsi offline — smazat půjde, až se připojím.' : 'Smazat se nepovedlo — ' + err.message);
  });
}

function gone(id) {
  notes = notes.filter(function (n) { return n.id !== id; });
  delete dirty[id];
  paint();
}

/* ---- Smazat všechny lístečky --------------------------------------------- */

function count(n) { return n === 1 ? '1 lísteček' : n < 5 ? n + ' lístečky' : n + ' lístečků'; }

function askAll(open) {
  var drop = $('stickyAllDrop'), btn = $('stickyAllBtn');
  if (!drop) return;
  if (open && !notes.length) open = false;
  drop.hidden = !open;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    $('stickyAllTitle').textContent = notes.length === 1 ? 'Smazat lísteček?' : 'Smazat všechny lístečky?';
    $('stickyAllSub').textContent = count(notes.length) + ' zmizí ze všech stránek i z ostatních počítačů. Hned potom je půjde vrátit.';
    $('stickyAllGo').textContent = notes.length === 1 ? 'Smazat' : 'Smazat všechny';
    $('stickyAllKeep').focus();
  }
}

/** The header button follows the notes: there while there is any. */
function paintAll() {
  var wrap = $('stickyAll');
  if (!wrap) return;
  wrap.hidden = !notes.length;
  if (!notes.length) askAll(false);
  else if (!$('stickyAllDrop').hidden) askAll(true);
}

function removeAll() {
  if (!online) { askAll(false); say('Jsi offline — smazat půjde, až se připojím.'); return; }
  var go = $('stickyAllGo');
  go.disabled = true;
  // What is still on its way out goes first, so Vrátit brings back the last text.
  Promise.all(Object.keys(dirty).map(function (id) { return flush(id); })).then(function () {
    return api('?origin=' + ORIGIN, { method: 'DELETE' });
  }).then(function (out) {
    var list = out.stickies || [];
    notes = [];
    dirty = {};
    askAll(false);
    paint();
    if (list.length) offerBackAll(list);
  }).catch(function (err) {
    say(isNetwork(err) ? 'Jsi offline — smazat půjde, až se připojím.' : 'Smazat se nepovedlo — ' + err.message);
  }).then(function () { go.disabled = false; });
}

function offerBackAll(list) {
  say(list.length === 1 ? 'Lísteček smazán.' : 'Smazáno ' + count(list.length) + '.', {
    label: 'Vrátit',
    run: function () {
      Promise.all(list.map(function (n) {
        return api('/' + encodeURIComponent(n.id) + '/restore', json('POST', {}))
          .then(function (out) { if (!noteOf(out.sticky.id)) notes.push(out.sticky); });
      })).then(function () { paint(); }).catch(function (err) {
        paint();
        say(isNetwork(err) ? 'Jsi offline — vrátit půjde, až se připojím.' : err.message);
      });
    }
  });
}

function initAll() {
  var btn = $('stickyAllBtn');
  if (!btn) return;
  btn.addEventListener('click', function () { askAll($('stickyAllDrop').hidden); });
  $('stickyAllKeep').addEventListener('click', function () { askAll(false); btn.focus(); });
  $('stickyAllGo').addEventListener('click', removeAll);
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && !$('stickyAllDrop').hidden) askAll(false); });
  document.addEventListener('pointerdown', function (ev) {
    if (!$('stickyAllDrop').hidden && !ev.target.closest('#stickyAll')) askAll(false);
  });
}

function offerBack(note, msg) {
  say(msg, {
    label: 'Vrátit',
    run: function () {
      api('/' + encodeURIComponent(note.id) + '/restore', json('POST', {}))
        .then(function (out) { if (!noteOf(out.sticky.id)) notes.push(out.sticky); paint(); })
        .catch(function (err) { say(isNetwork(err) ? 'Jsi offline — vrátit půjde, až se připojím.' : err.message); });
    }
  });
}

/* ---- drawing ------------------------------------------------------------- */

/* Where a note is drawn: its place, or — before it has one — the top right
   corner, one step down for each such note. Never lost off screen: a note
   placed on a wider window keeps its bar in reach. Only drawn so — the
   stored place stays, for when the window grows. */
function place(box, n, k) {
  var w = n.w || W, h = n.h || H;
  var x = n.x == null ? window.innerWidth - w - 32 - k * 28 : n.x;
  var y = n.y == null ? 72 + k * 28 : n.y;
  box.style.left = Math.max(0, Math.min(x, window.innerWidth - 80)) + 'px';
  box.style.top = Math.max(0, Math.min(y, window.innerHeight - 40)) + 'px';
  box.style.width = w + 'px';
  box.style.height = h + 'px';
}

function disarm(rec) {
  rec.ask.hidden = true;
  rec.box.classList.remove('is-asking');
  rec.x.setAttribute('aria-expanded', 'false');
  rec.x.title = 'Smazat lísteček';
}

function arm(rec) {
  rec.ask.hidden = false;
  rec.box.classList.add('is-asking');
  rec.x.setAttribute('aria-expanded', 'true');
  rec.x.title = 'Nechat';
  rec.keep.focus();
}

function build(n) {
  var id = n.id;
  var rec = {};
  var text = el('textarea.sticky__text', {
    'aria-label': 'Text lístečku', maxlength: '2000',
    placeholder: 'Napiš si, co chceš mít na očích…'
  });
  text.value = n.text || '';
  text.addEventListener('input', function () { change(id, { text: text.value }, 600); });
  text.addEventListener('blur', function () { if (dirty[id]) flush(id); });

  /* × asks first, always — the strip stays until the owner answers. */
  var keep = el('button.btn.btn--sm', { type: 'button', onclick: function () { disarm(rec); text.focus(); } }, 'Nechat');
  var ask = el('div.sticky__ask', { role: 'alertdialog', 'aria-label': 'Smazat lísteček?', hidden: true }, [
    el('b', 'Smazat lísteček?'),
    el('span.sticky__askbtns', [
      keep,
      el('button.btn.btn--sm.btn--dangerfill', { type: 'button', onclick: function () { remove(id); } }, 'Smazat')
    ])
  ]);
  ask.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { ev.stopPropagation(); disarm(rec); text.focus(); } });
  var x = el('button.sticky__x', {
    type: 'button', 'aria-label': 'Smazat lísteček', title: 'Smazat lísteček', 'aria-expanded': 'false',
    onclick: function () { if (ask.hidden) arm(rec); else disarm(rec); }
  }, '×');

  var bar = el('div.sticky__bar', [
    el('span.sticky__kicker', 'LÍSTEČEK'),
    x
  ]);
  var box = el('div.sticky', { role: 'note', 'data-id': id }, [bar, ask, text]);

  // The one touched comes to the top (moved only when it is not already: moving blurs the text).
  box.addEventListener('pointerdown', function () { if (layer.lastChild !== box) layer.appendChild(box); }, true);
  bar.addEventListener('pointerdown', function (ev) {
    if (ev.button !== 0 || ev.target.closest('button')) return;
    ev.preventDefault();
    bar.setPointerCapture(ev.pointerId);
    drag = { id: id, box: box, dx: ev.clientX - parseFloat(box.style.left), dy: ev.clientY - parseFloat(box.style.top) };
    box.classList.add('is-dragging');
  });
  bar.addEventListener('pointermove', function (ev) {
    if (!drag || drag.box !== box) return;
    box.style.left = Math.max(0, Math.min(ev.clientX - drag.dx, window.innerWidth - 80)) + 'px';
    box.style.top = Math.max(0, Math.min(ev.clientY - drag.dy, window.innerHeight - 40)) + 'px';
  });
  function drop() {
    if (!drag || drag.box !== box) return;
    drag = null;
    box.classList.remove('is-dragging');
    var left = Math.round(parseFloat(box.style.left)), top = Math.round(parseFloat(box.style.top));
    var cur = noteOf(id);
    if (cur && (cur.x !== left || cur.y !== top)) change(id, { x: left, y: top });
  }
  bar.addEventListener('pointerup', drop);
  bar.addEventListener('pointercancel', drop);

  /* The corner (CSS resize): saved when the size has really changed, not on
     every frame of the drag and not when paint() sets it. */
  var rt = 0;
  new ResizeObserver(function () {
    clearTimeout(rt);
    rt = setTimeout(function () {
      var cur = noteOf(id);
      if (!cur || !box.isConnected) return;
      var w = box.offsetWidth, h = box.offsetHeight;
      if (Math.abs(w - (cur.w || W)) > 1 || Math.abs(h - (cur.h || H)) > 1) change(id, { w: w, h: h });
    }, 300);
  }).observe(box);

  rec.box = box; rec.text = text; rec.x = x; rec.ask = ask; rec.keep = keep;
  return rec;
}

function paint() {
  if (!layer) return;
  var seen = {};
  var k = 0;
  notes.forEach(function (n) {
    seen[n.id] = true;
    var rec = nodes[n.id];
    if (!rec) { rec = nodes[n.id] = build(n); layer.appendChild(rec.box); }
    if (!drag || drag.id !== n.id) place(rec.box, n, n.x == null ? k : 0);
    if (n.x == null) k++;
    // Never under the cursor: the owner's own typing wins over a stale copy.
    if (document.activeElement !== rec.text && rec.text.value !== (n.text || '')) rec.text.value = n.text || '';
  });
  Object.keys(nodes).forEach(function (id) {
    if (!seen[id]) { nodes[id].box.remove(); delete nodes[id]; }
  });
  paintAll();
}

/* ---- frames and the connection ------------------------------------------- */

function onFrame(msg) {
  if (!msg || msg.origin === ORIGIN) return;
  if (msg.event === 'deleted' && msg.by === 'kacey') {
    var n = noteOf(msg.id);
    if (n && n.text.trim()) offerBack(n, 'Lísteček smazala Kacey.');
  }
  reloadSoon();
}

function onConn(st) {
  // 'connecting' is not offline yet: the HTTP side usually still answers.
  online = st !== 'offline';
  if (st !== 'online') return;
  flushAll();
  if (loadFailed) load();
  // Kacey or another desktop may have changed them while this page was away.
  else reloadSoon();
}

export function initStickies() {
  layer = el('div.stickies', { 'aria-label': 'Lístečky' });
  document.body.appendChild(layer);
  var btn = $('stickyBtn');
  if (btn) btn.addEventListener('click', create);
  initAll();
  bus.on('stickies', onFrame);
  bus.on('conn', onConn);
  window.addEventListener('online', function () { flushAll(); });
  window.addEventListener('pagehide', function () { flushAll(true); });
  window.addEventListener('resize', paint);
  load();
}

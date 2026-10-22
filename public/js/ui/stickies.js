/* =========================================================================
   Lístečky — sticky notes over every page, desktop only.

   The header's note button makes one. It floats over whatever view is on
   screen (a fixed layer outside the views), goes where it is dragged by its
   bar, is resized from its corner, and stays put — across views, reloads and
   desktops — until the owner deletes it: × in the corner, then the
   "Smazat" that appears beside it. An empty note goes on the first ×.

   Stored in settings.stickies: [{ id, text, x, y, w, h }] (x/y from the
   window's top left, in px). Kept by the server across a settings save that
   has none (appstate.js), like the tags. The phone hides the layer: a note
   placed on a 1920px screen means nothing on a 390px one.
   ========================================================================= */

import { $ } from '../core/dom.js';
import { el } from '../core/el.js';
import * as store from '../core/store.js';
import { say } from './toast.js';

var MAX = 12;
var W = 240, H = 180;
var layer = null;
var nodes = {};              // id -> { box, text, x, confirm }
var drag = null;

function list() {
  var s = store.data.settings || {};
  return Array.isArray(s.stickies) ? s.stickies : [];
}

function save(fn) {
  store.patch('settings', function (s) {
    var next = Object.assign({}, s);
    next.stickies = fn(Array.isArray(s.stickies) ? s.stickies.slice() : []);
    return next;
  });
}

function update(id, part) {
  save(function (all) {
    return all.map(function (n) { return n.id === id ? Object.assign({}, n, part) : n; });
  });
}

/* Never lost off screen: a note placed on a wider window keeps its bar in
   reach. Only drawn so — the stored place stays, for when the window grows. */
function place(box, n) {
  var x = Math.max(0, Math.min(n.x, window.innerWidth - 80));
  var y = Math.max(0, Math.min(n.y, window.innerHeight - 40));
  box.style.left = x + 'px';
  box.style.top = y + 'px';
  box.style.width = (n.w || W) + 'px';
  box.style.height = (n.h || H) + 'px';
}

function disarm(rec) {
  clearTimeout(rec.timer);
  rec.confirm.hidden = true;
  rec.x.setAttribute('aria-expanded', 'false');
  rec.x.title = 'Smazat lísteček';
}

function remove(id) {
  var gone = null, at = 0;
  save(function (all) {
    at = all.findIndex(function (n) { return n.id === id; });
    if (at !== -1) gone = all[at];
    return all.filter(function (n) { return n.id !== id; });
  });
  if (gone && gone.text) {
    say('Lísteček smazán.', {
      label: 'Vrátit',
      run: function () { save(function (all) { all.splice(Math.min(at, all.length), 0, gone); return all; }); }
    });
  }
}

function build(n) {
  var rec = {};
  var text = el('textarea.sticky__text', {
    'aria-label': 'Text lístečku', maxlength: '2000',
    placeholder: 'Napiš si, co chceš mít na očích…'
  });
  text.value = n.text || '';
  var t = 0;
  text.addEventListener('input', function () {
    clearTimeout(t);
    t = setTimeout(function () { update(n.id, { text: text.value }); }, 400);
  });
  text.addEventListener('blur', function () {
    clearTimeout(t);
    var cur = list().find(function (m) { return m.id === n.id; });
    if (cur && cur.text !== text.value) update(n.id, { text: text.value });
  });

  var confirm = el('button.btn.btn--sm.btn--dangerfill.sticky__confirm', {
    type: 'button', hidden: true,
    onclick: function () { remove(n.id); }
  }, 'Smazat');
  var x = el('button.sticky__x', {
    type: 'button', 'aria-label': 'Smazat lísteček', title: 'Smazat lísteček', 'aria-expanded': 'false',
    onclick: function () {
      if (!text.value.trim()) { remove(n.id); return; }
      if (!confirm.hidden) { disarm(rec); return; }
      confirm.hidden = false;
      x.setAttribute('aria-expanded', 'true');
      x.title = 'Nechat';
      rec.timer = setTimeout(function () { disarm(rec); }, 5000);
    }
  }, '×');

  var bar = el('div.sticky__bar', [
    el('span.sticky__kicker', 'LÍSTEČEK'),
    confirm,
    x
  ]);
  var box = el('div.sticky', { role: 'note', 'data-id': n.id }, [bar, text]);

  // The one touched comes to the top (moved only when it is not already: moving blurs the text).
  box.addEventListener('pointerdown', function () { if (layer.lastChild !== box) layer.appendChild(box); }, true);
  bar.addEventListener('pointerdown', function (ev) {
    if (ev.button !== 0 || ev.target.closest('button')) return;
    ev.preventDefault();
    bar.setPointerCapture(ev.pointerId);
    drag = { id: n.id, box: box, dx: ev.clientX - parseFloat(box.style.left), dy: ev.clientY - parseFloat(box.style.top) };
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
    update(n.id, { x: parseFloat(box.style.left), y: parseFloat(box.style.top) });
  }
  bar.addEventListener('pointerup', drop);
  bar.addEventListener('pointercancel', drop);

  /* The corner (CSS resize): saved when the size has really changed, not on
     every frame of the drag and not when paint() sets it. */
  var rt = 0;
  new ResizeObserver(function () {
    clearTimeout(rt);
    rt = setTimeout(function () {
      var cur = list().find(function (m) { return m.id === n.id; });
      if (!cur || !box.isConnected) return;
      var w = box.offsetWidth, h = box.offsetHeight;
      if (Math.abs(w - (cur.w || W)) > 1 || Math.abs(h - (cur.h || H)) > 1) update(n.id, { w: w, h: h });
    }, 300);
  }).observe(box);

  rec.box = box; rec.text = text; rec.x = x; rec.confirm = confirm;
  return rec;
}

function paint() {
  if (!layer) return;
  var seen = {};
  list().forEach(function (n) {
    seen[n.id] = true;
    var rec = nodes[n.id];
    if (!rec) { rec = nodes[n.id] = build(n); layer.appendChild(rec.box); }
    if (!drag || drag.id !== n.id) place(rec.box, n);
    // Never under the cursor: the owner's own typing wins over a stale copy.
    if (document.activeElement !== rec.text && rec.text.value !== (n.text || '')) rec.text.value = n.text || '';
  });
  Object.keys(nodes).forEach(function (id) {
    if (!seen[id]) { nodes[id].box.remove(); delete nodes[id]; }
  });
}

function create() {
  var all = list();
  if (all.length >= MAX) { say('Víc lístečků se nevejde — nejdřív nějaký smaž.'); return; }
  var k = all.length % 6;
  var n = {
    id: 's' + Date.now(), text: '',
    x: Math.max(0, window.innerWidth - W - 32 - k * 28), y: 72 + k * 28, w: W, h: H
  };
  save(function (cur) { return cur.concat([n]); });
  var rec = nodes[n.id];
  if (rec) rec.text.focus();
}

export function initStickies() {
  layer = el('div.stickies', { 'aria-label': 'Lístečky' });
  document.body.appendChild(layer);
  var btn = $('stickyBtn');
  if (btn) btn.addEventListener('click', create);
  store.onChange(paint);
  window.addEventListener('resize', paint);
  paint();
}

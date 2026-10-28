/* =========================================================================
   Seznamy jako plovoucí okna — a task's checklist over every page, desktop.

   On a desktop, Seznam / Spustit on a task opens its checklist in a window
   that floats like a lísteček: dragged by its bar, resized from its corner,
   over whatever view is on screen. Several can be open at once, one per task;
   pressing Seznam again on a task whose list is open brings that window to
   the front. Everything the full-screen runner does is here: tick an item,
   add one, Reset, Hotovo, zavřít (the task is done, the window goes). ×
   closes the window and keeps everything, like Pauza did.

   The windows share the lístečky's layer, so the one touched last is on top
   of both. Which lists are open, and where, is this device's choice
   (localStorage), like the tasks view; the lists themselves are the store's
   (kv `checklists`, public/js/core/tasklist.js), so a tick here is a tick on
   the phone's runner, and Kacey's app_task_list redraws an open window.

   Offline a window keeps working: the store keeps the change and sends it
   when the server answers again, and the window says so under its title.
   The lists open at the last reload come back only once the server's tasks
   are here — a page that booted offline must not take "no tasks" for "the
   tasks are gone" and forget them.

   The phone keeps the full-screen runner (views/tasks.js): there is no
   room for a window, and no lístečky either.
   ========================================================================= */

import { el, fill } from '../core/el.js';
import * as bus from '../core/bus.js';
import { MAX_ITEMS, MAX_LABEL, newItemId, progressText } from '../core/tasklist.js';
import { say } from './toast.js';
import { isPhone } from './psheet.js';

var KEY = 'kacey.tasks.runwins';
var MAX = 6;
var W = 340, H = 440;

var deps = null;             // { task(id), items(id), setItems(id, list), finish(id), when(t), ready(), onPaint() }
var layer = null;
var wins = {};               // task id -> { box, ... }
var places = {};             // task id -> { x, y, w, h } as last dragged
var order = [];              // task ids, oldest first
var drag = null;
var offline = false;

function save() {
  try {
    // Lists still waiting for their tasks (an offline boot) are kept, after the open ones.
    var open = order.map(function (id) { return Object.assign({ id: id }, places[id] || {}); });
    var waiting = (pending || []).filter(function (p) { return !wins[p.id]; });
    localStorage.setItem(KEY, JSON.stringify(open.concat(waiting).slice(0, MAX)));
  } catch (e) { /* private mode: this load only */ }
}

function saved() {
  try {
    var list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list.filter(function (p) { return p && typeof p.id === 'string'; }) : [];
  } catch (e) { return []; }
}

/* The lístečky's layer when it is there (ui/stickies.js), so the two stack
   together; a layer of our own otherwise. */
function host() {
  if (layer && layer.isConnected) return layer;
  layer = document.querySelector('.stickies');
  if (!layer) { layer = el('div.stickies', { 'aria-label': 'Seznamy' }); document.body.appendChild(layer); }
  return layer;
}

/* Hidden on a phone (styles.css): there the row's button opens the runner. */
export function isRunWinOpen(id) { return !!wins[id] && !isPhone(); }

/* ---- where a window goes ------------------------------------------------- */

/* A new one opens right of the middle, each next one a step down and left,
   so none hides the one before it. Never lost off screen: the bar stays in
   reach on a smaller window. */
function place(rec) {
  var p = places[rec.id] || {};
  var w = p.w || W, h = Math.min(p.h || H, window.innerHeight - 96);
  var x = p.x == null ? window.innerWidth - w - 300 - rec.k * 28 : p.x;
  var y = p.y == null ? 96 + rec.k * 28 : p.y;
  rec.box.style.left = Math.max(0, Math.min(x, window.innerWidth - 120)) + 'px';
  rec.box.style.top = Math.max(0, Math.min(y, window.innerHeight - 40)) + 'px';
  rec.box.style.width = w + 'px';
  rec.box.style.height = h + 'px';
}

function toFront(rec) {
  var l = host();
  if (l.lastChild !== rec.box) l.appendChild(rec.box);
}

/* ---- one window ---------------------------------------------------------- */

function build(id, k) {
  var rec = { id: id, k: k };

  var count = el('span.runwin__count.num');
  var x = el('button.sticky__x.runwin__x', {
    type: 'button', 'aria-label': 'Zavřít seznam', title: 'Zavřít — nic se neztratí',
    onclick: function () { close(id); }
  }, '×');
  var bar = el('div.sticky__bar.runwin__bar', [el('span.sticky__kicker.runwin__kicker', 'SEZNAM'), count, x]);

  var title = el('h3.runwin__title');
  var meta = el('p.runwin__meta');
  var off = el('p.runwin__off', { role: 'status', hidden: true }, 'Jsi offline — co odškrtneš, uložím, až se připojím.');
  var list = el('div.runwin__list');
  var input = el('input.input', {
    type: 'text', placeholder: 'Přidat položku — „boty“, „ručník“…', autocomplete: 'off', 'aria-label': 'Nová položka',
    maxlength: String(MAX_LABEL)
  });
  var form = el('form.runwin__add', {
    onsubmit: function (ev) {
      ev.preventDefault();
      var text = input.value.trim();
      if (!text) return;
      var items = deps.items(id);
      if (items.length >= MAX_ITEMS) { say('Víc než ' + MAX_ITEMS + ' položek se do jednoho seznamu nevejde.'); return; }
      deps.setItems(id, items.concat([{ id: newItemId(), label: text, note: '', done: false }]));
      input.value = '';
    }
  }, [input, el('button.btn.btn--sm', { type: 'submit' }, 'Přidat')]);
  var fillBar = el('span.bar__fill');
  var foot = el('div.runwin__foot', [
    el('span.bar.bar--grow', [fillBar]),
    el('button.btn.btn--sm', {
      type: 'button', title: 'Odškrtat všechny položky zpátky',
      onclick: function () { deps.setItems(id, deps.items(id).map(function (i) { return Object.assign({}, i, { done: false }); })); }
    }, 'Reset'),
    el('button.btn.btn--sm.btn--accent', {
      type: 'button',
      onclick: function () { close(id); deps.finish(id); say('Hotovo a odškrtnuto.'); }
    }, 'Hotovo, zavřít')
  ]);

  var box = el('section.sticky.runwin', { role: 'dialog', 'aria-label': 'Seznam', 'data-task': id }, [
    bar, el('div.runwin__body', [title, meta, off, list]), form, foot
  ]);
  box.addEventListener('pointerdown', function () { toFront(rec); }, true);
  box.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { ev.stopPropagation(); close(id); }
  });

  bar.addEventListener('pointerdown', function (ev) {
    if (ev.button !== 0 || ev.target.closest('button')) return;
    ev.preventDefault();
    bar.setPointerCapture(ev.pointerId);
    drag = { rec: rec, dx: ev.clientX - parseFloat(box.style.left), dy: ev.clientY - parseFloat(box.style.top) };
    box.classList.add('is-dragging');
  });
  bar.addEventListener('pointermove', function (ev) {
    if (!drag || drag.rec !== rec) return;
    box.style.left = Math.max(0, Math.min(ev.clientX - drag.dx, window.innerWidth - 120)) + 'px';
    box.style.top = Math.max(0, Math.min(ev.clientY - drag.dy, window.innerHeight - 40)) + 'px';
  });
  function drop() {
    if (!drag || drag.rec !== rec) return;
    drag = null;
    box.classList.remove('is-dragging');
    places[id] = Object.assign({}, places[id], { x: Math.round(parseFloat(box.style.left)), y: Math.round(parseFloat(box.style.top)) });
    save();
  }
  bar.addEventListener('pointerup', drop);
  bar.addEventListener('pointercancel', drop);

  /* The corner (CSS resize): kept once the size has really changed. */
  var rt = 0;
  new ResizeObserver(function () {
    clearTimeout(rt);
    rt = setTimeout(function () {
      if (!box.isConnected) return;
      var p = places[id] || {};
      var w = box.offsetWidth, h = box.offsetHeight;
      if (Math.abs(w - (p.w || W)) > 1 || Math.abs(h - (p.h || H)) > 1) {
        places[id] = Object.assign({}, p, { w: w, h: h });
        save();
      }
    }, 300);
  }).observe(box);

  Object.assign(rec, { box: box, count: count, title: title, meta: meta, off: off, list: list, input: input, fillBar: fillBar });
  return rec;
}

function paint(rec) {
  var t = deps.task(rec.id);
  var items = deps.items(rec.id);
  var done = items.filter(function (i) { return i.done; }).length;
  rec.box.setAttribute('aria-label', 'Seznam · ' + (t ? t.label : 'Úkol'));
  rec.count.textContent = progressText(items);
  rec.off.hidden = !offline;
  rec.box.classList.toggle('is-complete', !!items.length && done === items.length);
  rec.title.textContent = t ? t.label : 'Úkol';
  var meta = t ? [deps.when(t), t.meta].filter(Boolean).join(' · ') : '';
  rec.meta.textContent = meta;
  rec.meta.hidden = !meta;
  rec.fillBar.style.width = (items.length ? Math.round(done / items.length * 100) : 0) + '%';
  fill(rec.list, items.length ? items.map(function (item, i) {
    return el('button.runitem.runitem--win' + (item.done ? '.is-done' : ''), {
      type: 'button', 'aria-pressed': String(!!item.done),
      onclick: function () {
        // The list as it is now (Kacey may have changed it since this was drawn), by the item's id.
        deps.setItems(rec.id, deps.items(rec.id).map(function (x, n) {
          return (item.id ? x.id === item.id : n === i) ? Object.assign({}, x, { done: !x.done }) : x;
        }));
      }
    }, [
      el('span.runitem__box', item.done ? '✓' : ''),
      el('span.runitem__label', item.label),
      item.note ? el('span.runitem__note', item.note) : null
    ]);
  }) : el('p.empty.runwin__empty', 'Tenhle úkol zatím nemá seznam. Přidej položky níž, nebo řekni Kacey, co na něj patří.'));
}

/* ---- opening and closing ------------------------------------------------- */

/** Open a task's list as a window, or bring its open one to the front. False on a phone. */
export function openRunWin(id, quiet) {
  if (!deps || isPhone()) return false;
  var rec = wins[id];
  if (rec) {
    toFront(rec);
    rec.box.classList.remove('is-flash');
    void rec.box.offsetWidth;            // restart the flash
    rec.box.classList.add('is-flash');
    rec.input.focus({ preventScroll: true });
    return true;
  }
  if (order.length >= MAX) {
    if (!quiet) say('Víc seznamů najednou se nevejde — nějaký zavři.');
    return true;
  }
  rec = wins[id] = build(id, order.length);
  order.push(id);
  host().appendChild(rec.box);
  place(rec);
  paint(rec);
  if (!quiet) {
    // An empty list asks for its first item; a full one waits to be ticked.
    if (!deps.items(id).length) rec.input.focus({ preventScroll: true });
    save();
    deps.onPaint();
  }
  return true;
}

export function close(id) {
  var rec = wins[id];
  if (!rec) return;
  rec.box.remove();
  delete wins[id];
  delete places[id];
  order = order.filter(function (x) { return x !== id; });
  order.forEach(function (x, n) { wins[x].k = n; });
  save();
  deps.onPaint();
}

/** Every open window again, after the store changed. A task gone or done takes its window with it. */
export function refreshRunWins() {
  if (!deps) return;
  order.slice().forEach(function (id) {
    var t = deps.task(id);
    if (deps.ready() && (!t || t.done)) { close(id); return; }
    paint(wins[id]);
  });
  restore();
}

/* The lists open at the last reload come back once the server's tasks are
   there (deps.ready: the store has heard from it), and on a desktop-wide
   window — a phone-wide one keeps them for later. */
var pending = null;
function restore() {
  if (!pending || !deps.ready() || isPhone()) return;
  var list = pending;
  pending = null;
  list.forEach(function (p) {
    var t = deps.task(p.id);
    if (!t || t.done) return;
    places[p.id] = { x: p.x, y: p.y, w: p.w, h: p.h };
    openRunWin(p.id, true);
  });
  save();
  deps.onPaint();
}

export function initRunWins(d) {
  deps = d;
  pending = saved();
  window.addEventListener('resize', function () {
    order.forEach(function (id) { place(wins[id]); });
    restore();
  });
  // 'connecting' is not offline yet: the HTTP side usually still answers (as ui/stickies.js).
  bus.on('conn', function (st) {
    var was = offline;
    offline = st === 'offline';
    if (offline !== was) order.forEach(function (id) { paint(wins[id]); });
  });
  setTimeout(restore, 0);
}

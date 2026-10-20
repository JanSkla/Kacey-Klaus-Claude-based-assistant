/* =========================================================================
   THE WHITEBOARD.

   One named board over the whole window: a dark plane with a grid of square
   dots that pans and zooms, and on it text cards, coloured rectangles (areas
   that hold what lies in them), images and documents. Arrows are pulled from
   an object's edge to another object — or to empty space, which makes a new
   card at the end.

   The corner button names the board and opens everything else: rename,
   duplicate, all boards, and the sidebar's own navigation. The tools sit at
   the bottom; Kacey's line at the bottom right sends a chat turn that knows
   this board is on screen (state.pageBoard), so "dej to sem" needs no
   question. Her edits arrive as `whiteboard` frames, flash where they landed
   and can be put back from the toast or with Ctrl+Z.

   The document is saved whole, debounced, with the revision it started from
   (whiteboard.js on the server). Where the page was looking stays on this
   device (localStorage), not in the board.
   ========================================================================= */

import { $ } from '../core/dom.js';
import { el, fill } from '../core/el.js';
import * as bus from '../core/bus.js';
import { state } from '../core/state.js';
import {
  GRID, COLORS, SIZES, DEFAULT_COLOR, newId, colorOf, snap, bbox, holds, linkEnds, edgePoint, centre,
} from '../core/board.js';
import { go, onEnter, onLeave, currentView } from '../ui/router.js';
import { say } from '../ui/toast.js';
import { submit, isOnline } from '../net/protocol.js';
import { orbState } from '../ui/orb.js';

var LS_BOARD = 'kacey.board.current';
var LS_VIEW = 'kacey.board.view.';
var MAX_FILE = 25 * 1024 * 1024;
var Z_MIN = 0.2, Z_MAX = 3;
var NS = 'http://www.w3.org/2000/svg';
var ORIGIN = 'pg' + Math.random().toString(36).slice(2, 10);

var wb, world, rectsHost, itemsHost, linkLayer, ghost;
var board = null;                       // { id, name, rev, updated_at }
var doc = { items: [], links: [] };
var view = { x: -96, y: -96, z: 1 };    // the board's point at the window's top left, and the zoom
var nodes = {};                         // id -> element
var sel = [];                           // selected item ids
var selLink = null;
var editing = null;                     // { id, before, created, link }
var tool = 'select';
var undoStack = [], redoStack = [];
var saveTimer = 0, viewTimer = 0, retryTimer = 0;
var saving = false, dirty = false, saveAgain = false, saveFailed = false;
var drag = null, pinch = null;
var pointers = {};
var pendingRemote = null;
var recent = {};                        // board id -> the last change made elsewhere
var fresh = {};                         // ids Kacey just added: they flash
var lastTap = null, lastPointer = 'mouse';
var awaiting = false;
var loadSeq = 0;

/* ---- words ----------------------------------------------------------------------- */

function plural(n, one, few, many) { return n === 1 ? one : n >= 2 && n <= 4 ? few : many; }
function objektu(n) { return n + ' ' + plural(n, 'objekt', 'objekty', 'objektů'); }
function sipek(n) { return n + ' ' + plural(n, 'šipka', 'šipky', 'šipek'); }

function when(iso) {
  var d = new Date(iso);
  if (isNaN(d)) return '';
  var now = new Date();
  var clock = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  var y = new Date(now); y.setDate(now.getDate() - 1);
  var day = d.toDateString() === now.toDateString() ? 'dnes'
    : d.toDateString() === y.toDateString() ? 'včera' : d.getDate() + '. ' + (d.getMonth() + 1) + '.';
  return day + ' ' + clock;
}

function sizeLabel(bytes) {
  if (!bytes) return '';
  return bytes >= 1048576 ? (bytes / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' kB';
}

function extOf(file) {
  var m = /\.([a-z0-9]{1,5})$/i.exec((file && file.name) || '');
  return m ? m[1].toUpperCase() : 'SOUBOR';
}

/* ---- the document ----------------------------------------------------------------- */

function byId(id) {
  for (var i = 0; i < doc.items.length; i++) if (doc.items[i].id === id) return doc.items[i];
  return null;
}

function selected() { return sel.map(byId).filter(Boolean); }

function snapshot() { return JSON.stringify({ items: doc.items, links: doc.links }); }
function restore(s) { var d = JSON.parse(s); doc.items = d.items; doc.links = d.links; prune(); }

function pushUndo(s) {
  undoStack.push(s);
  if (undoStack.length > 80) undoStack.shift();
  redoStack = [];
  paintUndo();
}
function before() { pushUndo(snapshot()); }

function undo() {
  if (!undoStack.length) return;
  finishEdit(true);
  redoStack.push(snapshot());
  restore(undoStack.pop());
  changed();
}
function redo() {
  if (!redoStack.length) return;
  finishEdit(true);
  undoStack.push(snapshot());
  restore(redoStack.pop());
  changed();
}

/* Selection and links that point at things no longer there. */
function prune() {
  sel = sel.filter(function (id) { return byId(id); });
  doc.links = doc.links.filter(function (l) { return byId(l.from) && byId(l.to); });
  if (selLink && !doc.links.some(function (l) { return l.id === selLink; })) selLink = null;
}

function changed() { prune(); render(); scheduleSave(); paintUndo(); }

/* A rectangle carries what lies in it. */
function withContents(items) {
  var out = items.slice(), ids = {};
  items.forEach(function (it) { ids[it.id] = true; });
  items.forEach(function (it) {
    if (it.kind !== 'rect') return;
    doc.items.forEach(function (o) { if (!ids[o.id] && holds(it, o)) { ids[o.id] = true; out.push(o); } });
  });
  return out;
}

/* ---- the view ---------------------------------------------------------------------- */

function W() { return wb.clientWidth || window.innerWidth; }
function H() { return wb.clientHeight || window.innerHeight; }

function local(ev) {
  var r = wb.getBoundingClientRect();
  return { x: ev.clientX - r.left, y: ev.clientY - r.top };
}
function toWorld(p) { return { x: p.x / view.z + view.x, y: p.y / view.z + view.y }; }

function applyView() {
  world.style.transform = 'translate(' + (-view.x * view.z) + 'px,' + (-view.y * view.z) + 'px) scale(' + view.z + ')';
  world.style.setProperty('--z', view.z);
  // The dots stay a dot apart on screen: zoomed far out, every other one goes.
  var step = GRID * view.z;
  while (step < 14) step *= 2;
  wb.style.backgroundSize = step + 'px ' + step + 'px';
  wb.style.backgroundPosition = (-view.x * view.z) + 'px ' + (-view.y * view.z) + 'px';
  $('wbZoom').textContent = Math.round(view.z * 100) + ' %';
  placeSelBar();
  notePage();
  clearTimeout(viewTimer);
  viewTimer = setTimeout(rememberView, 400);
}

function rememberView() {
  if (!board) return;
  try { localStorage.setItem(LS_VIEW + board.id, JSON.stringify(view)); } catch (e) { /* private mode */ }
}

function savedView(id) {
  try {
    var v = JSON.parse(localStorage.getItem(LS_VIEW + id) || 'null');
    if (v && isFinite(v.x) && isFinite(v.y) && v.z >= Z_MIN && v.z <= Z_MAX) return v;
  } catch (e) { /* none */ }
  return null;
}

function zoomAt(z, p) {
  z = Math.max(Z_MIN, Math.min(Z_MAX, z));
  var w = toWorld(p);
  view.z = z;
  view.x = w.x - p.x / z;
  view.y = w.y - p.y / z;
  applyView();
}

/* Everything on the board in the window, clear of the corner button and the tools. */
function fit(items) {
  var b = bbox(items || doc.items);
  if (!b) { view = { x: -96, y: -96, z: 1 }; applyView(); return; }
  var top = 72, bottom = 96, side = 48;
  var z = Math.min((W() - 2 * side) / Math.max(b.w, 1), (H() - top - bottom) / Math.max(b.h, 1), 1);
  z = Math.max(Z_MIN, z);
  view = { z: z, x: b.x - (W() - b.w * z) / 2 / z, y: b.y - (top + (H() - top - bottom - b.h * z) / 2) / z };
  applyView();
}

function visible(it) {
  var x0 = view.x, y0 = view.y, x1 = x0 + W() / view.z, y1 = y0 + H() / view.z;
  return it.x < x1 && it.x + it.w > x0 && it.y < y1 && it.y + it.h > y0;
}

function viewCentre() { return toWorld({ x: W() / 2, y: H() / 2 }); }

/* What Kacey hears with the next turn: this board, what is on screen, what is picked. */
function notePage() {
  state.pageBoard = board && currentView() === 'board'
    ? { id: board.id, view: { x: Math.round(view.x), y: Math.round(view.y), w: Math.round(W() / view.z), h: Math.round(H() / view.z), z: Math.round(view.z * 100) / 100 }, selected: sel.slice(0, 50) }
    : null;
}

/* ---- drawing ----------------------------------------------------------------------- */

function geom(it) {
  return 'left:' + it.x + 'px;top:' + it.y + 'px;width:' + it.w + 'px;height:' + it.h + 'px;--c:' + colorOf(it.color).hex;
}

function ports() {
  return ['n', 'e', 's', 'w'].map(function (s) { return el('span.wbport.wbport--' + s, { 'data-side': s, 'aria-hidden': 'true' }); });
}

function itemNode(it) {
  var parts;
  if (it.kind === 'text') {
    parts = [it.kicker ? el('span.wbitem__kicker', it.kicker) : null, el('div.wbitem__text', it.text)];
  } else if (it.kind === 'rect') {
    parts = [el('div.wbitem__title', [el('span.wbitem__sw', { 'aria-hidden': 'true' }), el('span.wbitem__titletext', it.text || 'Bez názvu')])];
  } else if (it.kind === 'image') {
    var src = it.src || it._up;
    parts = [
      src ? el('img.wbitem__img', { src: src, alt: it.text || '', draggable: 'false' }) : el('span.wbitem__missing', 'Obrázek chybí'),
      it.text ? el('div.wbitem__cap', it.text) : null,
      it._up ? el('span.wbitem__badge', [el('span.wbitem__dot', { 'aria-hidden': 'true' }), 'Nahrávám…']) : null
    ];
  } else {
    var f = it.file || {};
    parts = [
      el('span.wbitem__docicon', { 'aria-hidden': 'true' }, extOf(f)),
      el('span.wbitem__docbody', [
        el('b.wbitem__docname', f.name || 'dokument'),
        el('span.wbitem__docmeta', it._up ? 'Nahrávám…' : [extOf(f), sizeLabel(f.bytes)].filter(Boolean).join(' · '))
      ]),
      f.url && !it._up ? el('a.link.wbitem__docopen', { href: f.url, target: '_blank', rel: 'noopener' }, 'Otevřít') : null
    ];
  }
  var node = el('div.wbitem.wbitem--' + it.kind, { 'data-id': it.id, style: geom(it) }, parts.concat(ports()));
  if (it.kind === 'image' && it.text) node.classList.add('has-cap');
  if (it._up) node.classList.add('is-uploading');
  if (fresh[it.id]) node.classList.add('is-new');
  if (it.kind === 'text' && !it.text) node.classList.add('is-blank');
  nodes[it.id] = node;
  return node;
}

function render() {
  nodes = {};
  var rects = [], rest = [];
  doc.items.forEach(function (it) { (it.kind === 'rect' ? rects : rest).push(it); });
  // The bigger rectangle first, so a smaller one lies on top of it.
  rects.sort(function (a, b) { return b.w * b.h - a.w * a.h; });
  fill(rectsHost, rects.map(itemNode));
  fill(itemsHost, rest.map(itemNode));
  fitHeights();
  renderLinks();
  paintSelection();
  $('wbEmpty').hidden = !board || doc.items.length > 0;
  paintMeta();
}

/* A text card grows to its text. Not an edit: it goes to the server with the next one. */
function fitHeights() {
  doc.items.forEach(function (it) {
    if (it.kind !== 'text') return;
    var node = nodes[it.id];
    if (!node) return;
    var need = node.scrollHeight + 2;
    if (need > it.h + 1) { it.h = Math.ceil(need / GRID) * GRID; node.style.height = it.h + 'px'; }
  });
}

function svgEl(tag, attrs) {
  var n = document.createElementNS(NS, tag);
  for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
  return n;
}

function renderLinks() {
  linkLayer.textContent = '';
  doc.links.forEach(function (l) {
    var a = byId(l.from), b = byId(l.to);
    if (!a || !b) return;
    var e = linkEnds(a, b);
    var d = 'M' + e.a.x + ' ' + e.a.y + 'L' + e.b.x + ' ' + e.b.y;
    var on = selLink === l.id;
    var g = svgEl('g', { 'class': 'wblink' + (on ? ' is-selected' : ''), 'data-id': l.id });
    g.appendChild(svgEl('path', { 'class': 'wblink__hit', d: d }));
    g.appendChild(svgEl('path', { 'class': 'wblink__line', d: d, 'marker-end': on ? 'url(#wbArrowAcc)' : 'url(#wbArrowInk)' }));
    if (l.label) {
      var t = svgEl('text', { 'class': 'wblink__label', x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2, 'text-anchor': 'middle', 'dominant-baseline': 'central' });
      t.textContent = l.label;
      g.appendChild(t);
    }
    linkLayer.appendChild(g);
  });
}

function paintSelection() {
  wb.querySelectorAll('.wbresize').forEach(function (n) { n.remove(); });
  for (var id in nodes) nodes[id].classList.toggle('is-selected', sel.indexOf(id) !== -1);
  if (sel.length === 1 && nodes[sel[0]]) nodes[sel[0]].appendChild(el('span.wbresize', { 'aria-hidden': 'true' }));
  wb.querySelectorAll('.wblink').forEach(function (g) {
    var on = g.getAttribute('data-id') === selLink;
    g.classList.toggle('is-selected', on);
    g.querySelector('.wblink__line').setAttribute('marker-end', on ? 'url(#wbArrowAcc)' : 'url(#wbArrowInk)');
  });
  renderSelBar();
  notePage();
  var n = sel.length;
  $('wbAskInput').placeholder = n ? 'Řekni Kacey, co s vybraným (' + n + ')…' : 'Řekni Kacey, co s plochou…';
}

function paintUndo() {
  $('wbUndo').disabled = !undoStack.length;
  $('wbRedo').disabled = !redoStack.length;
}

function paintSave(st) {
  var mark = $('wbSaveMark');
  mark.setAttribute('data-st', st);
  mark.title = st === 'err' ? 'Neuloženo — uložím, až to půjde' : st === 'busy' ? 'Ukládám…' : 'Uloženo';
}

function paintMeta() {
  if (!board) return;
  $('wbName').textContent = board.name;
  var parts = [objektu(doc.items.length)];
  if (doc.links.length) parts.push(sipek(doc.links.length));
  parts.push(saveFailed ? (isOnline() ? 'neuloženo — zkouším znovu' : 'neuloženo — jsi offline') : dirty || saving ? 'ukládám…' : 'uloženo ' + when(board.updated_at));
  $('wbMeta').textContent = parts.join(' · ');
  $('wbMeta').classList.toggle('is-err', saveFailed);
}

/* ---- the selection bar --------------------------------------------------------------- */

function selBtn(label, fn, cls) {
  return el('button.btn.btn--sm' + (cls || ''), { type: 'button', onclick: fn }, label);
}

function renderSelBar() {
  var bar = $('wbSel');
  if (editing || (drag && drag.moved) || (!sel.length && !selLink)) { bar.hidden = true; return; }
  var kids = [];
  if (selLink) {
    var l = doc.links.filter(function (x) { return x.id === selLink; })[0];
    kids.push(el('span.wbsel__cap', 'ŠIPKA'));
    kids.push(selBtn(l && l.label ? 'Popisek' : '+ Popisek', function () { editLabel(selLink); }));
    kids.push(selBtn('Obrátit', flipLink));
    kids.push(el('span.wbsel__sep', { 'aria-hidden': 'true' }));
    kids.push(selBtn('Smazat', removeSelection, '.btn--dangertext'));
  } else {
    var items = selected();
    var paintable = items.filter(function (it) { return it.kind !== 'image'; });
    if (paintable.length) {
      kids.push(el('span.wbsel__colors', COLORS.map(function (c) {
        var on = paintable.every(function (it) { return it.color === c.key; });
        return el('button.wbsel__sw', {
          type: 'button', style: '--c:' + c.hex, title: c.name, 'aria-label': 'Barva: ' + c.name, 'aria-pressed': String(on),
          onclick: function () { setColor(c.key); }
        });
      })));
      kids.push(el('span.wbsel__sep', { 'aria-hidden': 'true' }));
    }
    if (items.length === 1) {
      var it = items[0];
      if (it.kind === 'doc') {
        if (it.file && it.file.url) kids.push(el('a.btn.btn--sm', { href: it.file.url, target: '_blank', rel: 'noopener' }, 'Otevřít'));
      } else {
        kids.push(selBtn(it.kind === 'image' ? (it.text ? 'Popisek' : '+ Popisek') : it.kind === 'rect' ? 'Přejmenovat' : 'Upravit', function () { startEdit(it.id); }));
      }
    } else {
      kids.push(el('span.wbsel__cap.num', items.length + ' VYBRÁNO'));
    }
    kids.push(selBtn('Duplikovat', duplicateSelection));
    kids.push(selBtn('Kacey…', function () { focusAsk(); }, '.desk-only'));
    kids.push(el('span.wbsel__sep', { 'aria-hidden': 'true' }));
    kids.push(selBtn('Smazat', removeSelection, '.btn--dangertext'));
  }
  fill(bar, kids);
  bar.hidden = false;
  placeSelBar();
}

function placeSelBar() {
  var bar = $('wbSel');
  if (bar.hidden || window.matchMedia('(max-width: 760px)').matches) { bar.style.left = ''; bar.style.top = ''; return; }
  var box;
  if (selLink) {
    var l = doc.links.filter(function (x) { return x.id === selLink; })[0];
    var a = l && byId(l.from), b = l && byId(l.to);
    if (!a || !b) return;
    var e = linkEnds(a, b);
    box = { x: (e.a.x + e.b.x) / 2 - 1, y: (e.a.y + e.b.y) / 2 - 1, w: 2, h: 2 };
  } else {
    box = bbox(selected());
  }
  if (!box) return;
  var sx = (box.x - view.x) * view.z, sy = (box.y - view.y) * view.z;
  var bw = bar.offsetWidth, bh = bar.offsetHeight;
  var left = Math.max(8, Math.min(W() - bw - 8, sx + (box.w * view.z - bw) / 2));
  var top = sy - bh - 14;
  if (top < 64) top = sy + box.h * view.z + 14;
  top = Math.max(64, Math.min(H() - bh - 80, top));
  bar.style.left = left + 'px';
  bar.style.top = top + 'px';
}

/* ---- edits ---------------------------------------------------------------------------- */

function setColor(key) {
  before();
  selected().forEach(function (it) { if (it.kind !== 'image') it.color = key; });
  changed();
}

function removeSelection() {
  if (selLink) {
    before();
    doc.links = doc.links.filter(function (l) { return l.id !== selLink; });
    selLink = null;
    changed();
    return;
  }
  if (!sel.length) return;
  before();
  var gone = {};
  sel.forEach(function (id) { gone[id] = true; });
  doc.items = doc.items.filter(function (it) { return !gone[it.id]; });
  sel = [];
  changed();
}

function duplicateSelection() {
  var items = withContents(selected());
  if (!items.length) return;
  before();
  var map = {};
  var copies = items.map(function (it) {
    var c = JSON.parse(JSON.stringify(it));
    c.id = newId(it.kind[0]);
    c.x += GRID * 2; c.y += GRID * 2;
    delete c.by;
    map[it.id] = c.id;
    return c;
  });
  doc.items = doc.items.concat(copies);
  // Arrows between the copied things come along; arrows out of the group do not.
  var extra = [];
  doc.links.forEach(function (l) {
    if (!map[l.from] || !map[l.to]) return;
    var c = { id: newId('a'), from: map[l.from], to: map[l.to] };
    if (l.label) c.label = l.label;
    extra.push(c);
  });
  doc.links = doc.links.concat(extra);
  sel = sel.map(function (id) { return map[id]; }).filter(Boolean);
  selLink = null;
  changed();
}

function flipLink() {
  var l = doc.links.filter(function (x) { return x.id === selLink; })[0];
  if (!l) return;
  before();
  var t = l.from; l.from = l.to; l.to = t;
  changed();
}

function addItem(kind, at, extra) {
  var size = SIZES[kind];
  var it = Object.assign({
    id: newId(kind[0]), kind: kind, x: snap(at.x - size.w / 2), y: snap(at.y - size.h / 2),
    w: size.w, h: size.h, color: DEFAULT_COLOR[kind], text: ''
  }, extra || {});
  doc.items.push(it);
  return it;
}

function addText(text, at) {
  before();
  var it = addItem('text', at, { text: text.slice(0, 4000) });
  sel = [it.id]; selLink = null;
  changed();
}

function nudge(dx, dy) {
  var items = withContents(selected());
  if (!items.length) return;
  before();
  items.forEach(function (it) { it.x += dx; it.y += dy; });
  changed();
}

/* ---- typing on the board ---------------------------------------------------------------- */

function startEdit(id, created) {
  var it = byId(id), node = nodes[id];
  if (!it || !node || it.kind === 'doc') return;
  finishEdit(true);
  editing = { id: id, before: snapshot(), created: !!created };
  var field;
  if (it.kind === 'text') {
    field = el('textarea.wbedit.wbedit--text', { 'aria-label': 'Text karty', maxlength: '4000', rows: '1' });
    var t = node.querySelector('.wbitem__text');
    t.replaceWith(field);
    field.addEventListener('input', function () {
      var need = field.scrollHeight + (it.kicker ? 20 : 0) + 24;
      if (need > it.h) { it.h = Math.ceil(need / GRID) * GRID; node.style.height = it.h + 'px'; renderLinks(); }
    });
  } else if (it.kind === 'rect') {
    field = el('input.wbedit.wbedit--title', { type: 'text', maxlength: '120', 'aria-label': 'Nadpis obdélníku', placeholder: 'Nadpis' });
    node.querySelector('.wbitem__titletext').replaceWith(field);
  } else {
    field = el('input.wbedit.wbedit--cap', { type: 'text', maxlength: '200', 'aria-label': 'Popisek obrázku', placeholder: 'Popisek' });
    var cap = node.querySelector('.wbitem__cap');
    if (cap) cap.replaceWith(field); else node.appendChild(field);
    node.classList.add('has-cap');
  }
  field.value = it.text || '';
  node.classList.add('is-editing');
  $('wbSel').hidden = true;
  field.addEventListener('keydown', function (ev) {
    ev.stopPropagation();
    if (ev.key === 'Escape' || (ev.key === 'Enter' && (it.kind !== 'text' || ev.ctrlKey || ev.metaKey))) { ev.preventDefault(); finishEdit(); }
  });
  field.addEventListener('blur', function () { setTimeout(function () { if (editing && editing.id === id) finishEdit(); }, 0); });
  field.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
  field.focus();
  var end = field.value.length;
  try { field.setSelectionRange(end, end); } catch (e) { /* not a text field */ }
}

function finishEdit(quiet) {
  if (!editing) return;
  var e = editing;
  editing = null;
  if (e.link) { finishLabel(e); return; }
  var it = byId(e.id);
  var field = wb.querySelector('.wbedit');
  var value = field ? field.value : (it ? it.text : '');
  var did = e.created;
  if (it) {
    if (it.kind === 'text' && !value.trim()) {
      // An empty card is no card. One just made leaves nothing behind, not even an undo step.
      doc.items = doc.items.filter(function (o) { return o !== it; });
      sel = sel.filter(function (id) { return id !== it.id; });
      if (e.created) { undoStack.pop(); paintUndo(); did = false; }
      else { if (!quiet) pushUndo(e.before); did = true; }
    } else if (value !== it.text) {
      if (!e.created) pushUndo(e.before);
      it.text = value.slice(0, 4000);
      did = true;
    }
  }
  if (did || !it) changed();
  else render();
  if (it && byId(it.id)) settle();
}

/* An arrow's label, typed where it sits. */
function editLabel(linkId) {
  var l = doc.links.filter(function (x) { return x.id === linkId; })[0];
  if (!l) return;
  finishEdit(true);
  var a = byId(l.from), b = byId(l.to), e = linkEnds(a, b);
  var input = el('input.wbedit.wbedit--label', { type: 'text', maxlength: '80', 'aria-label': 'Popisek šipky', placeholder: 'popisek' });
  input.value = l.label || '';
  var box = el('div.wblabeledit', { style: 'left:' + ((e.a.x + e.b.x) / 2) + 'px;top:' + ((e.a.y + e.b.y) / 2) + 'px' }, input);
  itemsHost.appendChild(box);
  editing = { link: linkId, before: snapshot(), box: box, input: input };
  $('wbSel').hidden = true;
  input.addEventListener('keydown', function (ev) {
    ev.stopPropagation();
    if (ev.key === 'Enter' || ev.key === 'Escape') { ev.preventDefault(); finishEdit(); }
  });
  input.addEventListener('blur', function () { setTimeout(function () { if (editing && editing.link === linkId) finishEdit(); }, 0); });
  input.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
  input.focus();
  input.select();
}

function finishLabel(e) {
  var l = doc.links.filter(function (x) { return x.id === e.link; })[0];
  var v = e.input.value.trim().slice(0, 80);
  e.box.remove();
  if (l && v !== (l.label || '')) {
    pushUndo(e.before);
    if (v) l.label = v; else delete l.label;
    changed();
  } else {
    render();
  }
  settle();
}

/* ---- pointers ---------------------------------------------------------------------------- */

function setTool(t) {
  tool = t;
  document.querySelectorAll('.wbtool[data-tool]').forEach(function (b) {
    b.setAttribute('aria-pressed', String(b.getAttribute('data-tool') === t));
  });
  wb.setAttribute('data-tool', t);
}

function pointerList() { return Object.keys(pointers).map(function (k) { return pointers[k]; }); }

/* The arrow being pulled is an SVG path: no `hidden` property, only the attribute. */
function showGhost(on) { if (on) ghost.removeAttribute('hidden'); else ghost.setAttribute('hidden', ''); }

function startPinch() {
  if (drag && drag.moved && (drag.type === 'move' || drag.type === 'resize')) changed();
  drag = null;
  showGhost(false);
  var p = pointerList();
  var mid = { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
  pinch = { d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1, z: view.z, world: toWorld(mid) };
}

function onDown(ev) {
  if (ev.button === 2) return;
  lastPointer = ev.pointerType || 'mouse';
  if (ev.target.closest('.wbedit, .wbitem__docopen')) return;
  if (editing) finishEdit();
  // The plane never takes focus (see the mousedown below), so let go of the composer or the name field by hand.
  var active = document.activeElement;
  if (active && active !== document.body && !wb.contains(active) && typeof active.blur === 'function') active.blur();
  openMenu(false);
  pointers[ev.pointerId] = local(ev);
  try { wb.setPointerCapture(ev.pointerId); } catch (e) { /* gone */ }
  if (pointerList().length === 2) { startPinch(); return; }
  if (pointerList().length > 2) return;

  var at = local(ev), p = toWorld(at);
  var port = ev.target.closest('.wbport');
  var resize = ev.target.closest('.wbresize');
  var itemEl = ev.target.closest('.wbitem');
  var linkEl = ev.target.closest('.wblink');
  var base = { sx: at.x, sy: at.y, vx: view.x, vy: view.y, moved: false };

  if (ev.button === 1) { drag = Object.assign({ type: 'pan' }, base); return; }

  if (tool === 'text' && !port && !resize) {
    setTool('select');
    before();
    var t = addItem('text', p);
    sel = [t.id]; selLink = null;
    changed();
    startEdit(t.id, true);
    return;
  }
  if (tool === 'rect') {
    before();
    var r = addItem('rect', p, { x: snap(p.x), y: snap(p.y) });
    sel = [r.id]; selLink = null;
    render();
    drag = Object.assign({ type: 'create', id: r.id, x0: snap(p.x), y0: snap(p.y) }, base);
    return;
  }
  if (port && itemEl) {
    drag = Object.assign({ type: 'link', from: itemEl.getAttribute('data-id') }, base);
    return;
  }
  if (resize && itemEl) {
    var it = byId(itemEl.getAttribute('data-id'));
    drag = Object.assign({ type: 'resize', id: it.id, w0: it.w, h0: it.h, p0: p, snap: snapshot() }, base);
    return;
  }
  if (itemEl) {
    var id = itemEl.getAttribute('data-id'), item = byId(id);
    if (ev.shiftKey) {
      sel = sel.indexOf(id) === -1 ? sel.concat(id) : sel.filter(function (x) { return x !== id; });
      selLink = null;
      paintSelection();
      return;
    }
    // A rectangle's open area pans until the rectangle is picked; its title always moves it.
    if (item.kind === 'rect' && sel.indexOf(id) === -1 && !ev.target.closest('.wbitem__title')) {
      drag = Object.assign({ type: 'pan', pick: id }, base);
      return;
    }
    if (sel.indexOf(id) === -1) { sel = [id]; selLink = null; paintSelection(); }
    var moving = withContents(selected());
    var start = {};
    moving.forEach(function (m) { start[m.id] = { x: m.x, y: m.y }; });
    drag = Object.assign({ type: 'move', ids: moving.map(function (m) { return m.id; }), start: start, p0: p, snap: snapshot(), only: id }, base);
    return;
  }
  if (linkEl) {
    selLink = linkEl.getAttribute('data-id');
    sel = [];
    paintSelection();
    return;
  }
  if (ev.shiftKey && lastPointer === 'mouse') {
    drag = Object.assign({ type: 'marquee', p0: p, keep: sel.slice() }, base);
    return;
  }
  drag = Object.assign({ type: 'pan', clear: true }, base);
}

function onMove(ev) {
  if (!pointers[ev.pointerId]) return;
  var at = local(ev);
  pointers[ev.pointerId] = at;
  if (pinch) {
    var p = pointerList();
    if (p.length < 2) return;
    var mid = { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
    var z = Math.max(Z_MIN, Math.min(Z_MAX, pinch.z * Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) / pinch.d));
    view = { z: z, x: pinch.world.x - mid.x / z, y: pinch.world.y - mid.y / z };
    applyView();
    return;
  }
  if (!drag) return;
  var dist = Math.hypot(at.x - drag.sx, at.y - drag.sy);
  if (!drag.moved && dist < 4) return;
  var firstMove = !drag.moved;
  drag.moved = true;
  var w = toWorld(at);
  var free = ev.altKey;   // Alt: off the grid

  if (drag.type === 'pan') {
    wb.classList.add('is-panning');
    view.x = drag.vx - (at.x - drag.sx) / view.z;
    view.y = drag.vy - (at.y - drag.sy) / view.z;
    applyView();
  } else if (drag.type === 'move') {
    if (firstMove) { pushUndo(drag.snap); $('wbSel').hidden = true; wb.classList.add('is-dragging'); }
    var dx = w.x - drag.p0.x, dy = w.y - drag.p0.y;
    drag.ids.forEach(function (id) {
      var it = byId(id), s = drag.start[id];
      if (!it) return;
      it.x = free ? Math.round(s.x + dx) : snap(s.x + dx);
      it.y = free ? Math.round(s.y + dy) : snap(s.y + dy);
      var n = nodes[id];
      if (n) { n.style.left = it.x + 'px'; n.style.top = it.y + 'px'; }
    });
    renderLinks();
  } else if (drag.type === 'resize') {
    if (firstMove) pushUndo(drag.snap);
    var it = byId(drag.id), n2 = nodes[drag.id];
    var nw = drag.w0 + (w.x - drag.p0.x), nh = drag.h0 + (w.y - drag.p0.y);
    if (it.kind === 'image' && !ev.shiftKey) nh = nw * drag.h0 / drag.w0;    // keeps its shape; Shift frees it
    it.w = Math.max(72, free ? Math.round(nw) : snap(nw));
    it.h = Math.max(it.kind === 'doc' ? 72 : 48, free ? Math.round(nh) : snap(nh));
    n2.style.width = it.w + 'px'; n2.style.height = it.h + 'px';
    renderLinks();
  } else if (drag.type === 'create') {
    var r = byId(drag.id), x1 = snap(w.x), y1 = snap(w.y);
    r.x = Math.min(drag.x0, x1); r.y = Math.min(drag.y0, y1);
    r.w = Math.max(GRID * 4, Math.abs(x1 - drag.x0)); r.h = Math.max(GRID * 3, Math.abs(y1 - drag.y0));
    var n3 = nodes[drag.id];
    if (n3) n3.style.cssText = geom(r);
  } else if (drag.type === 'link') {
    var src = byId(drag.from);
    var target = targetAt(ev, drag.from);
    wb.querySelectorAll('.wbitem.is-target').forEach(function (n) { n.classList.remove('is-target'); });
    var end = w;
    if (target) { nodes[target.id].classList.add('is-target'); end = edgePoint(target, centre(src)); }
    var a = edgePoint(src, end);
    ghost.setAttribute('d', 'M' + a.x + ' ' + a.y + 'L' + end.x + ' ' + end.y);
    showGhost(true);
  } else if (drag.type === 'marquee') {
    var x0 = Math.min(drag.p0.x, w.x), y0 = Math.min(drag.p0.y, w.y);
    var box = { x: x0, y: y0, w: Math.abs(w.x - drag.p0.x), h: Math.abs(w.y - drag.p0.y) };
    var m = $('wbMarquee');
    m.hidden = false;
    m.style.cssText = 'left:' + Math.min(drag.sx, at.x) + 'px;top:' + Math.min(drag.sy, at.y) + 'px;width:' + Math.abs(at.x - drag.sx) + 'px;height:' + Math.abs(at.y - drag.sy) + 'px';
    var hit = doc.items.filter(function (it) {
      return it.x >= box.x && it.y >= box.y && it.x + it.w <= box.x + box.w && it.y + it.h <= box.y + box.h;
    }).map(function (it) { return it.id; });
    sel = drag.keep.concat(hit.filter(function (id) { return drag.keep.indexOf(id) === -1; }));
    selLink = null;
    for (var id in nodes) nodes[id].classList.toggle('is-selected', sel.indexOf(id) !== -1);
  }
}

function targetAt(ev, notId) {
  var hit = document.elementFromPoint(ev.clientX, ev.clientY);
  var n = hit && hit.closest && hit.closest('.wbitem');
  var id = n && n.getAttribute('data-id');
  return id && id !== notId ? byId(id) : null;
}

function onUp(ev) {
  var wasPinch = !!pinch;
  delete pointers[ev.pointerId];
  if (pinch) { if (pointerList().length < 2) pinch = null; return; }
  if (wasPinch) return;
  var d = drag;
  drag = null;
  wb.classList.remove('is-panning', 'is-dragging');
  if (!d) return;
  var at = local(ev), w = toWorld(at);

  if (d.type === 'pan') {
    if (!d.moved) {
      if (d.pick) { sel = [d.pick]; selLink = null; paintSelection(); }
      else if (d.clear && (sel.length || selLink)) { sel = []; selLink = null; paintSelection(); }
      tap(ev, at);
    }
  } else if (d.type === 'move') {
    if (d.moved) changed();
    else {
      if (sel.length > 1) { sel = [d.only]; paintSelection(); }
      tap(ev, at);
    }
  } else if (d.type === 'resize') {
    if (d.moved) changed();
  } else if (d.type === 'create') {
    // The undo step was taken when the drawing began; naming it is part of the same step.
    setTool('select');
    changed();
    startEdit(d.id, true);
  } else if (d.type === 'link') {
    showGhost(false);
    wb.querySelectorAll('.wbitem.is-target').forEach(function (n) { n.classList.remove('is-target'); });
    if (!d.moved) return;
    var target = targetAt(ev, d.from);
    if (target) {
      var dup = doc.links.some(function (l) { return l.from === d.from && l.to === target.id; });
      if (!dup) { before(); doc.links.push({ id: newId('a'), from: d.from, to: target.id }); changed(); }
    } else {
      // Pulled into empty space: a new card at the arrow's end, ready to type.
      before();
      var card = addItem('text', w);
      doc.links.push({ id: newId('a'), from: d.from, to: card.id });
      sel = [card.id]; selLink = null;
      changed();
      startEdit(card.id, true);
    }
  } else if (d.type === 'marquee') {
    $('wbMarquee').hidden = true;
    paintSelection();
  }
}

/* A double tap on a phone (the browser's dblclick does not come through touch-action: none). */
function tap(ev, at) {
  if (lastPointer === 'mouse') return;
  var now = Date.now();
  if (lastTap && now - lastTap.t < 320 && Math.hypot(at.x - lastTap.x, at.y - lastTap.y) < 28) {
    lastTap = null;
    doubleAt(ev, at);
    return;
  }
  lastTap = { t: now, x: at.x, y: at.y };
}

function doubleAt(ev, at) {
  var itemEl = ev.target.closest && ev.target.closest('.wbitem');
  var hit = document.elementFromPoint(ev.clientX, ev.clientY);
  itemEl = itemEl || (hit && hit.closest && hit.closest('.wbitem'));
  var linkEl = hit && hit.closest && hit.closest('.wblink');
  if (itemEl) { var id = itemEl.getAttribute('data-id'); sel = [id]; paintSelection(); startEdit(id); return; }
  if (linkEl) { editLabel(linkEl.getAttribute('data-id')); return; }
  before();
  var t = addItem('text', toWorld(at));
  sel = [t.id]; selLink = null;
  changed();
  startEdit(t.id, true);
}

/* ---- files ---------------------------------------------------------------------------- */

function readBase64(file) {
  return new Promise(function (resolve, reject) {
    var r = new FileReader();
    r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
    r.onerror = function () { reject(new Error('soubor nejde přečíst')); };
    r.readAsDataURL(file);
  });
}

function upload(file) {
  return readBase64(file).then(function (data) {
    return fetch('/api/whiteboard-files', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, type: file.type, data: data })
    });
  }).then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) throw new Error(j.error || 'nepovedlo se');
    return j.file;
  });
}

function addFiles(files, at) {
  var list = Array.prototype.slice.call(files || []);
  if (!list.length || !board) return;
  if (!isOnline()) { say('Jsi offline — soubory přidám, až se připojím.'); return; }
  var p = at || viewCentre();
  before();
  var made = [];
  list.forEach(function (f, i) {
    if (f.size > MAX_FILE) { say('„' + f.name + '“ je větší než 25 MB — ten na plochu nedám.'); return; }
    var spot = { x: p.x + i * GRID * 2, y: p.y + i * GRID * 2 };
    var isImage = /^image\//.test(f.type);
    var it = isImage
      ? addItem('image', spot, { _up: URL.createObjectURL(f) })
      : addItem('doc', spot, { _up: true, file: { name: f.name, type: f.type, bytes: f.size, url: '' } });
    made.push(it.id);
    if (isImage) {
      var img = new Image();
      img.onload = function () {
        if (!img.naturalWidth) return;
        var w = Math.min(SIZES.image.w + GRID * 3, Math.max(GRID * 6, img.naturalWidth));
        it.w = snap(w); it.h = Math.max(GRID * 3, snap(it.w * img.naturalHeight / img.naturalWidth));
        render();
      };
      img.src = it._up;
    }
    upload(f).then(function (file) {
      if (!byId(it.id)) return;          // removed while it was going up
      if (isImage) { URL.revokeObjectURL(it._up); it.src = file.url; }
      else it.file = file;
      delete it._up;
      changed();
    }).catch(function (err) {
      doc.items = doc.items.filter(function (o) { return o !== it; });
      changed();
      say('„' + f.name + '“ se nepodařilo uložit — ' + (isOnline() ? err.message : 'jsi offline') + '.');
    });
  });
  if (!made.length) { undoStack.pop(); paintUndo(); return; }
  sel = made; selLink = null;
  render();
}

/* ---- saving ---------------------------------------------------------------------------- */

function payload() {
  var up = {};
  var items = doc.items.filter(function (it) { if (it._up) up[it.id] = true; return !it._up; });
  return { items: items, links: doc.links.filter(function (l) { return !up[l.from] && !up[l.to]; }) };
}

function scheduleSave() {
  if (!board) return;
  dirty = true;
  paintSave('busy');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 600);
}

function flushSave() {
  clearTimeout(saveTimer);
  if (!board || !dirty) return;
  if (saving) { saveAgain = true; return; }
  dirty = false; saving = true;
  var id = board.id;
  fetch('/api/whiteboards/' + encodeURIComponent(id), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ doc: payload(), rev: board.rev, origin: ORIGIN })
  }).then(function (r) { return r.json(); }).then(function (j) {
    saving = false;
    if (!board || board.id !== id) return;
    if (j.ok) {
      board.rev = j.board.rev; board.updated_at = j.board.updated_at;
      saveFailed = false;
      paintSave(dirty ? 'busy' : 'ok');
      paintMeta();
      if (dirty || saveAgain) { saveAgain = false; flushSave(); }
    } else if (j.conflict && j.board) {
      adopt(j.board);
      say('Whiteboard se mezitím změnil jinde — ukazuju jeho novou podobu.');
    } else {
      throw new Error(j.error || 'chyba');
    }
  }).catch(function () {
    saving = false;
    if (!board || board.id !== id) return;
    dirty = true; saveFailed = true;
    paintSave('err');
    paintMeta();
    clearTimeout(retryTimer);
    retryTimer = setTimeout(flushSave, 5000);
  });
}

function adopt(b) {
  board = { id: b.id, name: b.name, rev: b.rev, updated_at: b.updated_at };
  var keepUp = doc.items.filter(function (it) { return it._up; });
  doc = { items: b.doc.items.concat(keepUp), links: b.doc.links };
  dirty = false; saveFailed = false;
  prune();
  render();
  paintSave('ok');
}

/* ---- opening a board --------------------------------------------------------------------- */

function loading(text, retry) {
  var box = $('wbLoading');
  box.hidden = !text;
  if (!text) return;
  fill(box, [el('p', text), retry ? el('button.btn.btn--sm', { type: 'button', onclick: retry }, 'Zkusit znovu') : null]);
}

export function currentBoardId() { return board ? board.id : null; }

export function openBoard(id) {
  if (!id) return Promise.resolve(false);
  if (board && board.id === id) { if (currentView() !== 'board') go('board'); return Promise.resolve(true); }
  flushSave();
  finishEdit(true);
  var seq = ++loadSeq;
  loading('Načítám whiteboard…');
  return fetch('/api/whiteboards/' + encodeURIComponent(id), { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (seq !== loadSeq) return false;
      if (!j.ok) {
        try { localStorage.removeItem(LS_BOARD); } catch (e) { /* none */ }
        loading('');
        say(j.error || 'Takový whiteboard není.');
        go('boards');
        return false;
      }
      var b = j.board;
      board = { id: b.id, name: b.name, rev: b.rev, updated_at: b.updated_at };
      doc = { items: b.doc.items, links: b.doc.links };
      sel = []; selLink = null; undoStack = []; redoStack = []; fresh = {};
      dirty = false; saveFailed = false;
      try { localStorage.setItem(LS_BOARD, b.id); } catch (e) { /* private mode */ }
      loading('');
      if (currentView() !== 'board') go('board');
      setTool('select');
      render();
      var v = savedView(b.id);
      // Where this device last looked; a board opened here for the first time shows all of itself.
      if (v) { view = v; applyView(); }
      else if (b.doc.items.length) fit();
      else { view = { x: -96, y: -96, z: 1 }; applyView(); }
      paintSave('ok');
      paintUndo();
      var late = recent[b.id];
      if (late && late.board.rev > board.rev) applyRemote(late);
      return true;
    })
    .catch(function () {
      if (seq !== loadSeq) return false;
      loading(isOnline() ? 'Whiteboard se nepodařilo načíst.' : 'Jsi offline — whiteboard načtu, až se připojím.', function () { var want = id; board = null; openBoard(want); });
      return false;
    });
}

/* Entering the screen with no board in hand: the last one, else the newest, else the gallery. */
function enter() {
  notePage();
  if (board) { render(); applyView(); return; }
  var last = null;
  try { last = localStorage.getItem(LS_BOARD); } catch (e) { /* none */ }
  if (last) { openBoard(last); return; }
  loading('Načítám whiteboard…');
  fetch('/api/whiteboards', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
    var first = j.ok && j.boards && j.boards[0];
    if (first) openBoard(first.id);
    else { loading(''); go('boards'); }
  }).catch(function () { loading('Jsi offline — whiteboard načtu, až se připojím.', enter); });
}

/* ---- Kacey's changes ------------------------------------------------------------------------ */

function changeWords(c) {
  if (!c) return 'Kacey upravila whiteboard.';
  var parts = [];
  if (c.added) parts.push(c.added + ' ' + plural(c.added, 'nový', 'nové', 'nových'));
  if (c.changed) parts.push(c.changed + ' ' + plural(c.changed, 'změněný', 'změněné', 'změněných'));
  if (c.removed) parts.push(c.removed + ' pryč');
  return 'Kacey upravila whiteboard' + (parts.length ? ' — ' + parts.join(', ') : '') + '.';
}

function applyRemote(msg) {
  var prev = snapshot();
  var had = {};
  doc.items.forEach(function (it) { had[it.id] = true; });
  adopt(msg.board);
  if (msg.by !== 'kacey') return;
  var added = doc.items.filter(function (it) { return !had[it.id]; });
  fresh = {};
  added.forEach(function (it) { fresh[it.id] = true; });
  render();
  setTimeout(function () { fresh = {}; wb.querySelectorAll('.wbitem.is-new').forEach(function (n) { n.classList.remove('is-new'); }); }, 2600);
  pushUndo(prev);
  if (added.length && !added.some(visible)) fit();
  say(changeWords(msg.changes), {
    label: 'Vrátit',
    run: function () { before(); restore(prev); changed(); say('Vráceno, jak to bylo před Kacey.'); }
  });
}

function onFrame(msg) {
  if (msg.event === 'open' && msg.id) { openBoard(msg.id); return; }
  // Kacey opens a board and draws on it at once: the drawing may land while the board is still loading.
  if (msg.event === 'changed' && msg.board && msg.origin !== ORIGIN) recent[msg.board.id] = msg;
  if (!board || !msg.board || msg.board.id !== board.id) return;
  if (msg.event === 'changed') {
    if (msg.origin === ORIGIN || msg.board.rev <= board.rev) return;
    if (drag || editing) { pendingRemote = msg; return; }
    applyRemote(msg);
  } else if (msg.event === 'renamed') {
    board.name = msg.board.name;
    paintMeta();
    if (!$('wbMenu').hidden && document.activeElement !== $('wbRenameInput')) $('wbRenameInput').value = board.name;
  } else if (msg.event === 'removed') {
    var name = board.name;
    board = null; doc = { items: [], links: [] };
    try { localStorage.removeItem(LS_BOARD); } catch (e) { /* none */ }
    state.pageBoard = null;
    if (currentView() === 'board') { say('Whiteboard „' + name + '“ je smazaný.'); go('boards'); }
  }
}

function settle() {
  if (pendingRemote && !drag && !editing) { var m = pendingRemote; pendingRemote = null; if (board && m.board.rev > board.rev) applyRemote(m); }
}

/* ---- the corner menu ------------------------------------------------------------------------- */

function navCopy() {
  var groups = Array.prototype.map.call(document.querySelectorAll('.sidenav .sidenav__group'), function (g) {
    var c = g.cloneNode(true);
    c.querySelectorAll('[id]').forEach(function (n) { n.removeAttribute('id'); });
    c.querySelectorAll('[aria-current]').forEach(function (n) { n.removeAttribute('aria-current'); });
    return c;
  });
  // The header's gear is not on this screen, so Controller joins the list.
  var last = groups[groups.length - 1];
  if (last) last.appendChild(el('button.sidenav__item', { type: 'button', 'data-go': 'controller' }, 'Controller'));
  return groups;
}

function openMenu(open) {
  var m = $('wbMenu');
  if (!m || m.hidden === !open) return;
  m.hidden = !open;
  $('wbNavBtn').setAttribute('aria-expanded', String(open));
  if (!open) return;
  $('wbRenameInput').value = board ? board.name : '';
  paintMeta();
  fill($('wbMenuNav'), navCopy());
}

function rename() {
  var input = $('wbRenameInput');
  var name = input.value.replace(/\s+/g, ' ').trim();
  if (!board || !name || name === board.name) { if (board) input.value = board.name; return; }
  var id = board.id;
  fetch('/api/whiteboards/' + encodeURIComponent(id), {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name })
  }).then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) throw new Error(j.error);
    if (board && board.id === id) { board.name = j.board.name; input.value = board.name; paintMeta(); }
    say('Přejmenováno na „' + j.board.name + '“.');
  }).catch(function (err) {
    if (board) input.value = board.name;
    say(isOnline() ? 'Přejmenovat se nepovedlo — ' + (err.message || 'zkus to znovu') + '.' : 'Jsi offline — přejmenovat půjde, až se připojím.');
  });
}

/* From the board itself the copy opens (with a way back); from the gallery it stays a tile. */
export function duplicateBoard(id, open) {
  flushSave();
  return fetch('/api/whiteboards/' + encodeURIComponent(id) + '/duplicate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j.ok) throw new Error(j.error);
      if (!open) {
        say('Kopie „' + j.board.name + '“ je hotová.', null, function () { openBoard(j.board.id); });
        return j.board;
      }
      return openBoard(j.board.id).then(function () {
        say('Kopie „' + j.board.name + '“ je otevřená.', { label: 'Zpět na původní', run: function () { openBoard(id); } });
        return j.board;
      });
    })
    .catch(function (err) { say(isOnline() ? 'Duplikovat se nepovedlo — ' + (err.message || 'zkus to znovu') + '.' : 'Jsi offline — duplikovat půjde, až se připojím.'); });
}

export function newBoard() {
  flushSave();
  return fetch('/api/whiteboards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Nový whiteboard' }) })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j.ok) throw new Error(j.error);
      return openBoard(j.board.id).then(function () {
        // A new board wants a name first.
        openMenu(true);
        $('wbRenameInput').focus();
        $('wbRenameInput').select();
      });
    })
    .catch(function () { say(isOnline() ? 'Nový whiteboard se nepodařilo založit.' : 'Jsi offline — založit půjde, až se připojím.'); });
}

/* ---- Kacey's line ------------------------------------------------------------------------------ */

function lastReply() {
  var rows = document.querySelectorAll('#log .msg--assistant .msg__bubble');
  for (var i = rows.length - 1; i >= 0; i--) { var s = rows[i].textContent.trim(); if (s) return s; }
  return '';
}

function showReply(text) {
  $('wbReplyText').textContent = text;
  $('wbReply').hidden = !text;
}

function focusAsk() {
  $('wbAsk').classList.add('is-open');
  $('wbAskToggle').setAttribute('aria-expanded', 'true');
  $('wbAskInput').focus();
}

function initAsk() {
  $('wbAskForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var text = $('wbAskInput').value.trim();
    if (!text) return;
    if (!isOnline()) { say('Jsi offline — Kacey to pošlu, až se připojím.'); return; }
    finishEdit();
    flushSave();
    notePage();
    $('wbAskInput').value = '';
    submit(text);
    awaiting = true;
    showReply('Rozumím, dívám se na plochu…');
  });
  $('wbMic').addEventListener('click', function () { notePage(); var mic = $('mic'); if (mic) mic.click(); });
  $('wbAskToggle').addEventListener('click', function () {
    var open = !$('wbAsk').classList.contains('is-open');
    $('wbAsk').classList.toggle('is-open', open);
    $('wbAskToggle').setAttribute('aria-expanded', String(open));
    if (open) $('wbAskInput').focus();
  });
  bus.on('orb', function () {
    if (currentView() !== 'board') return;
    var s = orbState();
    if (s === 'thinking' && !awaiting) { awaiting = true; showReply('Přemýšlím…'); }
    if (awaiting && s === 'idle') { awaiting = false; var r = lastReply(); if (r) showReply(r); }
  });
}

/* ---- keys ---------------------------------------------------------------------------------------- */

function typing(t) {
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function onKey(ev) {
  if (currentView() !== 'board') return;
  if (ev.key === 'Escape' && !$('wbMenu').hidden) { openMenu(false); $('wbNavBtn').focus(); return; }
  if (typing(ev.target) || document.querySelector('.sheet:not([hidden])')) return;
  var mod = ev.ctrlKey || ev.metaKey, k = ev.key.toLowerCase();
  if (mod && k === 'z') { ev.preventDefault(); if (ev.shiftKey) redo(); else undo(); return; }
  if (mod && k === 'y') { ev.preventDefault(); redo(); return; }
  if (mod && k === 'd') { ev.preventDefault(); duplicateSelection(); return; }
  if (mod && k === 'a') { ev.preventDefault(); sel = doc.items.map(function (it) { return it.id; }); selLink = null; paintSelection(); return; }
  if (mod) return;
  if (ev.key === 'Delete' || ev.key === 'Backspace') { if (sel.length || selLink) { ev.preventDefault(); removeSelection(); } return; }
  if (ev.key === 'Escape') { setTool('select'); sel = []; selLink = null; paintSelection(); return; }
  if (ev.key === 'Enter' && sel.length === 1) { ev.preventDefault(); startEdit(sel[0]); return; }
  var step = ev.shiftKey ? GRID * 4 : GRID;
  if (ev.key === 'ArrowLeft') { ev.preventDefault(); nudge(-step, 0); return; }
  if (ev.key === 'ArrowRight') { ev.preventDefault(); nudge(step, 0); return; }
  if (ev.key === 'ArrowUp') { ev.preventDefault(); nudge(0, -step); return; }
  if (ev.key === 'ArrowDown') { ev.preventDefault(); nudge(0, step); return; }
  if (ev.key === '!' || (ev.shiftKey && ev.code === 'Digit1') || k === '0') { fit(); return; }
  if (k === '+' || k === '=') { zoomAt(view.z * 1.2, { x: W() / 2, y: H() / 2 }); return; }
  if (k === '-') { zoomAt(view.z / 1.2, { x: W() / 2, y: H() / 2 }); return; }
  if (k === 'v') setTool('select');
  else if (k === 't') setTool('text');
  else if (k === 'r') setTool('rect');
  else if (k === 'i') $('wbImageFile').click();
  else if (k === 'd') $('wbDocFile').click();
}

/* ---- wiring ----------------------------------------------------------------------------------------- */

export function initWhiteboard() {
  wb = $('wb');
  if (!wb) return;
  world = $('wbWorld');
  linkLayer = $('wbLinkLayer');
  ghost = $('wbGhost');
  rectsHost = el('div.wb__rects');
  world.insertBefore(rectsHost, $('wbLinks'));
  itemsHost = $('wbItems');

  wb.addEventListener('pointerdown', onDown);
  /* A press on the plane must not move focus: the card just made is being typed
     in, and a tap's late mousedown would blur it (and an empty card goes away). */
  wb.addEventListener('mousedown', function (ev) {
    if (!ev.target.closest('.wbedit, a')) ev.preventDefault();
  });
  wb.addEventListener('pointermove', onMove);
  wb.addEventListener('pointerup', function (ev) { onUp(ev); settle(); });
  wb.addEventListener('pointercancel', function (ev) {
    delete pointers[ev.pointerId];
    pinch = null;
    if (drag && drag.moved && drag.type !== 'pan') changed();
    drag = null;
    showGhost(false);
    $('wbMarquee').hidden = true;
    settle();
  });
  wb.addEventListener('dblclick', function (ev) {
    if (lastPointer !== 'mouse' || ev.target.closest('.wbedit, .wbport, .wbresize, .wbitem__docopen')) return;
    doubleAt(ev, local(ev));
  });
  wb.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    if (ev.ctrlKey || ev.metaKey) {
      // A trackpad pinch arrives as small ctrl-wheel steps, a mouse wheel as big ones.
      var k = Math.abs(ev.deltaY) < 40 ? 0.01 : 0.0025;
      zoomAt(view.z * Math.exp(-ev.deltaY * k), local(ev));
    } else {
      view.x += (ev.shiftKey && !ev.deltaX ? ev.deltaY : ev.deltaX) / view.z;
      view.y += (ev.shiftKey && !ev.deltaX ? 0 : ev.deltaY) / view.z;
      applyView();
    }
  }, { passive: false });

  // Files from the desktop, at the point they are dropped.
  var depth = 0;
  wb.addEventListener('dragenter', function (ev) { if (ev.dataTransfer && Array.prototype.indexOf.call(ev.dataTransfer.types, 'Files') !== -1) { depth++; $('wbDrop').hidden = false; ev.preventDefault(); } });
  wb.addEventListener('dragover', function (ev) { if (!$('wbDrop').hidden) ev.preventDefault(); });
  wb.addEventListener('dragleave', function () { if (--depth <= 0) { depth = 0; $('wbDrop').hidden = true; } });
  wb.addEventListener('drop', function (ev) {
    depth = 0; $('wbDrop').hidden = true;
    if (!ev.dataTransfer || !ev.dataTransfer.files.length) return;
    ev.preventDefault();
    addFiles(ev.dataTransfer.files, toWorld(local(ev)));
  });
  document.addEventListener('paste', function (ev) {
    if (currentView() !== 'board' || typing(ev.target) || !board) return;
    var cd = ev.clipboardData;
    if (!cd) return;
    if (cd.files && cd.files.length) { ev.preventDefault(); addFiles(cd.files); return; }
    var text = cd.getData('text/plain');
    if (text && text.trim()) { ev.preventDefault(); addText(text.trim(), viewCentre()); }
  });
  document.addEventListener('keydown', onKey);

  document.querySelectorAll('.wbtool[data-tool]').forEach(function (b) {
    b.addEventListener('click', function () { setTool(b.getAttribute('data-tool')); });
  });
  $('wbAddImage').addEventListener('click', function () { $('wbImageFile').click(); });
  $('wbAddDoc').addEventListener('click', function () { $('wbDocFile').click(); });
  $('wbImageFile').addEventListener('change', function () { addFiles($('wbImageFile').files); $('wbImageFile').value = ''; });
  $('wbDocFile').addEventListener('change', function () { addFiles($('wbDocFile').files); $('wbDocFile').value = ''; });
  $('wbUndo').addEventListener('click', undo);
  $('wbRedo').addEventListener('click', redo);
  $('wbZoomIn').addEventListener('click', function () { zoomAt(view.z * 1.2, { x: W() / 2, y: H() / 2 }); });
  $('wbZoomOut').addEventListener('click', function () { zoomAt(view.z / 1.2, { x: W() / 2, y: H() / 2 }); });
  $('wbZoom').addEventListener('click', function () { fit(); });

  $('wbNavBtn').addEventListener('click', function () { openMenu($('wbMenu').hidden); });
  document.addEventListener('pointerdown', function (ev) {
    if (!$('wbMenu').hidden && !(ev.target.closest && ev.target.closest('#wbNav'))) openMenu(false);
  });
  $('wbMenu').addEventListener('click', function (ev) { if (ev.target.closest('[data-go]')) openMenu(false); });
  $('wbRenameForm').addEventListener('submit', function (ev) { ev.preventDefault(); rename(); $('wbRenameInput').blur(); });
  $('wbRenameInput').addEventListener('blur', rename);
  $('wbRenameInput').addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { ev.stopPropagation(); if (board) $('wbRenameInput').value = board.name; openMenu(false); }
  });
  $('wbDuplicate').addEventListener('click', function () { if (board) { openMenu(false); duplicateBoard(board.id, true); } });
  $('wbNew').addEventListener('click', function () { openMenu(false); newBoard(); });

  initAsk();
  bus.on('whiteboard', onFrame);
  window.addEventListener('resize', function () { if (currentView() === 'board') applyView(); });
  window.addEventListener('online', function () { if (dirty) flushSave(); });
  window.addEventListener('beforeunload', flushSave);

  setTool('select');
  onEnter('board', enter);
  onLeave('board', function () {
    finishEdit(true);
    flushSave();
    openMenu(false);
    state.pageBoard = null;
  });
}

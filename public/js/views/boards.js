/* =========================================================================
   THE WHITEBOARDS — the gallery of named boards.

   A tile per board, newest change first: a small drawing of what is on it,
   the name, when it changed and how much it holds. A tile opens its board
   (views/whiteboard.js); under it Přejmenovat (in place), Duplikovat and
   Smazat (twice, then a toast with Vrátit — the server keeps a deleted board
   for a week).

   The same drawing marks Kacey's work in the chat: when she changes a board
   from a conversation, a card under her words says which, and opens it.
   ========================================================================= */

import { $ } from '../core/dom.js';
import * as dom from '../core/dom.js';
import { el, fill } from '../core/el.js';
import * as bus from '../core/bus.js';
import { colorOf, bbox, fold, linkEnds } from '../core/board.js';
import { onEnter } from '../ui/router.js';
import { say } from '../ui/toast.js';
import { isOnline } from '../net/protocol.js';
import { openBoard, duplicateBoard, newBoard, currentBoardId } from './whiteboard.js';

var NS = 'http://www.w3.org/2000/svg';
var boards = [];
var loaded = false, failed = false;
var find = '';
var renaming = null, armed = null, armTimer = 0;

/* ---- words ----------------------------------------------------------------- */

function plural(n, one, few, many) { return n === 1 ? one : n >= 2 && n <= 4 ? few : many; }
function whiteboardu(n) { return n + ' ' + plural(n, 'whiteboard', 'whiteboardy', 'whiteboardů'); }
function objektu(n) { return n + ' ' + plural(n, 'objekt', 'objekty', 'objektů'); }

function when(iso) {
  var d = new Date(iso);
  if (isNaN(d)) return '';
  var now = new Date();
  var clock = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  var y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'dnes ' + clock;
  if (d.toDateString() === y.toDateString()) return 'včera ' + clock;
  return d.getDate() + '. ' + (d.getMonth() + 1) + '.' + (d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : '');
}

/* ---- the drawing ------------------------------------------------------------- */

function svgEl(tag, attrs) {
  var n = document.createElementNS(NS, tag);
  for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
  return n;
}

/** A board in miniature: rectangles as tinted areas, cards as bars with their colour edge, arrows as lines. */
export function boardDrawing(preview) {
  var items = (preview && preview.items) || [];
  var svg = svgEl('svg', { 'class': 'wbdraw', 'aria-hidden': 'true', preserveAspectRatio: 'xMidYMid meet' });
  var b = bbox(items);
  if (!b) { svg.setAttribute('viewBox', '0 0 160 100'); return svg; }
  var pad = Math.max(b.w, b.h) * 0.06 + 24;
  svg.setAttribute('viewBox', [b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2].join(' '));
  var stroke = Math.max(b.w, b.h) / 160;
  items.slice().sort(function (a, c) { return (a.kind === 'rect' ? 0 : 1) - (c.kind === 'rect' ? 0 : 1) || c.w * c.h - a.w * a.h; }).forEach(function (it) {
    var hex = colorOf(it.color).hex;
    if (it.kind === 'rect') {
      svg.appendChild(svgEl('rect', { x: it.x, y: it.y, width: it.w, height: it.h, fill: hex, 'fill-opacity': '.16', stroke: hex, 'stroke-opacity': '.7', 'stroke-width': stroke }));
    } else {
      svg.appendChild(svgEl('rect', { 'class': it.kind === 'image' ? 'wbdraw__img' : 'wbdraw__card', x: it.x, y: it.y, width: it.w, height: it.h }));
      if (it.kind !== 'image') svg.appendChild(svgEl('rect', { x: it.x, y: it.y, width: Math.min(it.w, stroke * 4), height: it.h, fill: hex }));
    }
  });
  var ids = (preview && preview.ids) || [];
  (preview.links || []).forEach(function (pair) {
    var a = items[ids.indexOf(pair[0])], c = items[ids.indexOf(pair[1])];
    if (!a || !c) return;
    var e = linkEnds(a, c);
    svg.appendChild(svgEl('line', { 'class': 'wbdraw__link', x1: e.a.x, y1: e.a.y, x2: e.b.x, y2: e.b.y, 'stroke-width': stroke * 1.4 }));
  });
  return svg;
}

/* ---- loading -------------------------------------------------------------------- */

function load() {
  return fetch('/api/whiteboards', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j.ok) throw new Error(j.error);
      boards = j.boards || [];
      loaded = true; failed = false;
      render();
    })
    .catch(function () { failed = true; render(); });
}

function upsert(s) {
  var i = boards.findIndex(function (b) { return b.id === s.id; });
  if (i === -1) boards.unshift(s); else boards[i] = s;
  boards.sort(function (a, c) { return a.updated_at < c.updated_at ? 1 : a.updated_at > c.updated_at ? -1 : 0; });
}

/* ---- the grid -------------------------------------------------------------------- */

function paintCounts() {
  var n = boards.length;
  $('boardsCount').textContent = loaded ? whiteboardu(n) : '—';
  $('boardsStatCount').textContent = loaded ? String(n) : '—';
  var items = boards.reduce(function (s, b) { return s + b.counts.items; }, 0);
  $('boardsStatMeta').textContent = loaded ? (n ? objektu(items) + ' · naposledy ' + when(boards[0].updated_at) : 'zatím žádný') : '—';
  var badge = $('navBadgeBoards');
  if (badge) badge.textContent = n ? String(n) : '';
  var more = $('moreBoardsMeta');
  if (more) more.textContent = n ? whiteboardu(n) : '';
}

function arm(id) {
  armed = id;
  clearTimeout(armTimer);
  armTimer = setTimeout(function () { armed = null; render(); }, 4000);
  render();
}

function remove(b) {
  armed = null;
  fetch('/api/whiteboards/' + encodeURIComponent(b.id), { method: 'DELETE' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j.ok) throw new Error(j.error);
      boards = boards.filter(function (x) { return x.id !== b.id; });
      render();
      say('Whiteboard „' + b.name + '“ smazán.', {
        label: 'Vrátit',
        run: function () {
          fetch('/api/whiteboards/' + encodeURIComponent(b.id) + '/restore', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function (k) { if (!k.ok) throw new Error(k.error); load(); say('Whiteboard „' + k.board.name + '“ je zpátky.'); })
            .catch(function () { say('Vrátit se nepovedlo.'); });
        }
      });
    })
    .catch(function (err) { render(); say(isOnline() ? 'Smazat se nepovedlo — ' + (err.message || 'zkus to znovu') + '.' : 'Jsi offline — smazat půjde, až se připojím.'); });
}

function saveName(b, input) {
  var name = input.value.replace(/\s+/g, ' ').trim();
  renaming = null;
  if (!name || name === b.name) { render(); return; }
  fetch('/api/whiteboards/' + encodeURIComponent(b.id), {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name })
  }).then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok) throw new Error(j.error);
    upsert(j.board);
    render();
  }).catch(function (err) { render(); say(isOnline() ? 'Přejmenovat se nepovedlo — ' + (err.message || 'zkus to znovu') + '.' : 'Jsi offline — přejmenovat půjde, až se připojím.'); });
}

function tile(b) {
  var current = b.id === currentBoardId();
  if (renaming === b.id) {
    var input = el('input.input.wbtile__nameinput', { type: 'text', maxlength: '60', 'aria-label': 'Nové jméno whiteboardu' });
    input.value = b.name;
    var form = el('form.wbtile__rename', {
      onsubmit: function (ev) { ev.preventDefault(); saveName(b, input); }
    }, [
      input,
      el('span.wbtile__renameacts', [
        el('button.btn.btn--sm.btn--accent', { type: 'submit' }, 'Uložit'),
        el('button.btn.btn--sm', { type: 'button', onclick: function () { renaming = null; render(); } }, 'Zrušit')
      ])
    ]);
    input.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { ev.stopPropagation(); renaming = null; render(); } });
    setTimeout(function () { input.focus(); input.select(); }, 0);
    return el('div.wbtile.is-renaming', [el('span.wbtile__frame', boardDrawing(b.preview)), form]);
  }
  var meta = [when(b.updated_at), objektu(b.counts.items)];
  if (b.counts.links) meta.push(b.counts.links + ' ' + plural(b.counts.links, 'šipka', 'šipky', 'šipek'));
  return el('div.wbtile' + (current ? '.is-current' : ''), [
    el('button.wbtile__open', { type: 'button', onclick: function () { openBoard(b.id); }, 'aria-label': 'Otevřít ' + b.name }, [
      el('span.wbtile__frame', [boardDrawing(b.preview), current ? el('span.wbtile__tag', 'naposledy otevřený') : null, !b.counts.items ? el('span.wbtile__blank', 'prázdný') : null]),
      el('span.wbtile__name', b.name),
      el('span.wbtile__meta.num', meta.join(' · '))
    ]),
    el('div.wbtile__acts', [
      el('button.link', { type: 'button', onclick: function () { renaming = b.id; armed = null; render(); } }, 'Přejmenovat'),
      el('button.link', { type: 'button', onclick: function () { duplicateBoard(b.id, false).then(load); } }, 'Duplikovat'),
      armed === b.id
        ? el('button.btn.btn--sm.btn--dangerfill.push', { type: 'button', onclick: function () { remove(b); } }, 'Opravdu smazat?')
        : el('button.link.link--muted.wbtile__del.push', { type: 'button', onclick: function () { arm(b.id); } }, 'Smazat')
    ])
  ]);
}

function render() {
  paintCounts();
  var grid = $('boardsGrid');
  if (!loaded) {
    fill(grid, failed
      ? el('div.galempty', [el('span.galempty__mark.galempty__mark--err', { 'aria-hidden': 'true' }),
        el('h3', isOnline() ? 'Whiteboardy se nepodařilo načíst.' : 'Jsi offline.'),
        el('p', 'Jsou uložené na kaceybody — ukážu je, až se spojení vrátí.'),
        el('button.btn', { type: 'button', onclick: load }, 'Zkusit znovu')])
      : el('p.empty', 'Načítám whiteboardy…'));
    return;
  }
  var want = fold(find);
  var list = want ? boards.filter(function (b) { return fold(b.name).indexOf(want) !== -1; }) : boards;
  var kids = [];
  if (!want) kids.push(el('button.wbtile.wbtile--new', { type: 'button', onclick: newBoard }, [
    el('span.wbtile__plus', { 'aria-hidden': 'true' }, '+'), el('span', 'Nový whiteboard')
  ]));
  kids = kids.concat(list.map(tile));
  if (!boards.length) {
    kids.push(el('div.galempty.boards__empty', [
      el('span.galempty__mark.galempty__mark--board', { 'aria-hidden': 'true' }),
      el('h3', 'Zatím žádný whiteboard.'),
      el('p', 'Plocha na myšlenky: karty s textem, barevné oblasti, obrázky, dokumenty a šipky mezi nimi. Založ první, nebo řekni Kacey „pomoz mi ujasnit si povinnosti“ — rozloží je na plochu sama.')
    ]));
  } else if (want && !list.length) {
    kids.push(el('div.galempty.boards__empty', [
      el('h3', 'Žádný whiteboard se tak nejmenuje.'),
      el('button.btn', { type: 'button', onclick: function () { find = ''; $('boardsFind').value = ''; render(); } }, 'Zrušit hledání')
    ]));
  }
  fill(grid, kids);
}

/* ---- in the chat ---------------------------------------------------------------- */

function chatEdited(msg) {
  var b = msg.board;
  if (!b || !dom.log) return;
  var c = msg.counts || {};
  var parts = [];
  if (c.added) parts.push('přidala ' + objektu(c.added));
  if (c.changed) parts.push('upravila ' + c.changed);
  if (c.removed) parts.push('smazala ' + c.removed);
  var open = function () { openBoard(b.id); };
  dom.log.appendChild(el('li.msg.msg--assistant.msg--notice.msg--gallery', [
    el('p.msg__who', 'Kacey'),
    el('div.gchat.gchat--board', [
      el('button.gchat__thumb.wbtile__frame', { type: 'button', 'aria-label': 'Otevřít whiteboard', onclick: open }, boardDrawing(b.preview)),
      el('div.gchat__body', [
        el('p.gchat__kicker', 'WHITEBOARD · UPRAVENO'),
        el('p.gchat__title', b.name),
        el('p.gchat__caption', (parts.length ? 'Na ploše jsem ' + parts.join(', ') + '. ' : '') + 'Teď na ní je ' + objektu(b.counts.items) + '.'),
        el('button.btn.btn--sm.btn--outlineaccent.msg__act', { type: 'button', onclick: open }, 'Otevřít whiteboard')
      ])
    ])
  ]));
  dom.logwrap.scrollTop = dom.logwrap.scrollHeight;
}

function onFrame(msg) {
  if (msg.event === 'edited_chat') { chatEdited(msg); return; }
  var s = msg.summary || (msg.event !== 'changed' ? msg.board : null);
  if (!s || !loaded) return;
  if (msg.event === 'removed') boards = boards.filter(function (b) { return b.id !== s.id; });
  else upsert(s);
  if (renaming !== s.id) render();
}

/* ---- wiring ---------------------------------------------------------------------- */

export function initBoards() {
  if (!$('boardsGrid')) return;
  $('boardsNew').addEventListener('click', newBoard);
  $('boardsFind').addEventListener('input', function () { find = $('boardsFind').value; render(); });
  bus.on('whiteboard', onFrame);
  // Changes made while the page was away arrive with nobody to frame them: read the list again.
  var away = false;
  bus.on('conn', function (st) {
    if (st === 'offline') away = true;
    else if (st === 'online' && (away || failed)) { away = false; load(); }
  });
  onEnter('boards', load);
  load();
}

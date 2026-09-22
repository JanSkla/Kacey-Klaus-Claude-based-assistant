/* =========================================================================
   THE ROUTINE PLANNER.

   The shape of a normal week, painted rather than typed: days run down, hours
   run across, and you drag sideways to paint a range in fifteen-minute slots.
   A calendar tells you what is booked; this tells Kacey what your week
   normally looks like, so she can book around it and warn when something lands
   on a protected block.

   The grid is a flat map, '<day>-<slot>' -> category, where slot is the index
   of a 15-minute step from midnight (0..95). Flat because that is what makes
   painting cheap: a drag writes single keys, and the contiguous blocks are
   derived on read by blocksFor().

   Sleep hours cannot be painted. That is not a rule about tidiness — the
   calendar lane draws them as hatching and would otherwise show a work block
   inside a night.
   ========================================================================= */

import { $ } from '../core/dom.js';
import { el, fill, hhmm } from '../core/el.js';
import * as store from '../core/store.js';
import { say } from '../ui/toast.js';

export var CATS = {
  routine: { label: 'Rutina', color: '#d2a106' },
  gym:     { label: 'Pohyb',  color: '#ee5396' },
  work:    { label: 'Práce',  color: '#009d9a' },
  study:   { label: 'Studium', color: '#a56eff' },
  free:    { label: 'Volno',  color: '#24a148' },
  commute: { label: 'Cesta',  color: '#8d8d8d' }
};

var DAYS = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];

var brush = 'work';
var noteSel = null;
var painting = false;
var lastSlot = -1;         // where the current drag was last seen
var sheet = null;

/** Monday-first weekday index of a 'YYYY-MM-DD'. Exported for the calendar. */
export function dayIndexOfDate(date) {
  var p = String(date).split('-').map(Number);
  return (new Date(p[0], p[1] - 1, p[2]).getDay() + 6) % 7;
}

/** The contiguous painted blocks of one day, in minutes. */
export function blocksFor(day) {
  var grid = store.data.routine.grid || {};
  var notes = store.data.routine.notes || {};
  var out = [], cur = null;

  for (var i = 0; i < 96; i++) {
    var cat = grid[day + '-' + i];
    if (cat && cur && cur.cat === cat) cur.n++;
    else {
      if (cur) out.push(cur);
      cur = cat ? { cat: cat, i: i, n: 1 } : null;
    }
  }
  if (cur) out.push(cur);

  return out.map(function (b) {
    var key = day + '-' + b.i;
    return { cat: b.cat, key: key, s: b.i * 15, e: (b.i + b.n) * 15, note: notes[key] || '' };
  });
}

/* ---- painting ----------------------------------------------------------- */

/**
 * Paint one slot, and every slot between it and where the drag was last seen.
 *
 * The gap-filling is not a nicety: mouseenter fires per element, and a quick
 * drag across the row skips most of them, which leaves a painted block full of
 * holes. Filling the span is what makes a fast drag paint the same range a slow
 * one does.
 */
function paint(day, slot) {
  var routine = store.data.routine;

  if (brush === 'text') {
    var minute = slot * 15;
    if (minute < routine.wake || minute >= routine.sleep) return;
    var hit = blocksFor(day).filter(function (b) { return minute >= b.s && minute < b.e; })[0];
    noteSel = hit ? hit.key : null;
    render();
    return;
  }

  var from = (painting && lastSlot >= 0) ? Math.min(lastSlot, slot) : slot;
  var to = (painting && lastSlot >= 0) ? Math.max(lastSlot, slot) : slot;
  lastSlot = slot;

  var grid = Object.assign({}, routine.grid);
  var changed = false;

  for (var i = from; i <= to; i++) {
    var m = i * 15;
    if (m < routine.wake || m >= routine.sleep) continue;   // sleep is not paintable
    var key = day + '-' + i;
    if (brush === 'erase') {
      if (!(key in grid)) continue;
      delete grid[key];
    } else {
      if (grid[key] === brush) continue;
      grid[key] = brush;
    }
    changed = true;
  }

  if (changed) store.patch('routine', Object.assign({}, routine, { grid: grid }));
}

/* ---- painting with a finger ---------------------------------------------
   A touch drag fires touchmove and nothing else: mouseenter never happens, so
   the mouse path above paints exactly one cell on a phone and the rest of the
   stroke is lost. A tap still works through synthesised mouse events; this is
   what makes dragging work.

   The gesture is ambiguous at the first move — sideways means "paint this
   range", up and down means "scroll the sheet", and the grid also scrolls
   sideways because it is wider than the screen. So the direction is decided
   once, on the first movement past a small threshold, and then held:

     mostly horizontal -> paint, and preventDefault so the grid stops scrolling
     mostly vertical   -> leave it alone and let the browser scroll

   Deciding once is what stops a stroke turning into a scroll halfway across
   the row. */

function cellAt(x, y) {
  var node = document.elementFromPoint(x, y);
  if (!node || !node.classList || !node.classList.contains('cell')) return null;
  var key = node.getAttribute('data-cell');
  if (!key) return null;
  var parts = key.split('-');
  return { day: Number(parts[0]), slot: Number(parts[1]) };
}

function initTouchPainting(host) {
  var startX = 0, startY = 0;
  var decided = null;          // null | 'paint' | 'scroll'
  var strokeDay = -1;          // a stroke belongs to the row it started in

  host.addEventListener('touchstart', function (ev) {
    if (ev.touches.length !== 1) { decided = 'scroll'; return; }
    startX = ev.touches[0].clientX;
    startY = ev.touches[0].clientY;
    decided = null;
    painting = false;
    lastSlot = -1;
    strokeDay = -1;
  }, { passive: true });

  host.addEventListener('touchmove', function (ev) {
    if (decided === 'scroll' || ev.touches.length !== 1) return;
    var touch = ev.touches[0];

    if (decided === null) {
      var dx = Math.abs(touch.clientX - startX);
      var dy = Math.abs(touch.clientY - startY);
      if (dx < 8 && dy < 8) return;            // too small to read yet
      decided = dx > dy ? 'paint' : 'scroll';
      if (decided === 'scroll') return;

      // Start from where the finger went down, so the first few pixels of the
      // drag are not dropped.
      var origin = cellAt(startX, startY);
      if (!origin) { decided = 'scroll'; return; }
      strokeDay = origin.day;
      paint(origin.day, origin.slot);
      painting = true;
      lastSlot = origin.slot;
    }

    ev.preventDefault();                       // this gesture is ours now
    var cell = cellAt(touch.clientX, touch.clientY);
    // A finger that strays into the row above must not repaint that day.
    if (cell && cell.day === strokeDay) paint(cell.day, cell.slot);
  }, { passive: false });

  function end() {
    if (painting) { painting = false; lastSlot = -1; render(); }
    decided = null;
    strokeDay = -1;
  }
  host.addEventListener('touchend', end);
  host.addEventListener('touchcancel', end);
}

/* ---- rendering ---------------------------------------------------------- */

function renderBrushes() {
  var keys = Object.keys(CATS).concat(['erase', 'text']);
  fill($('brushes'), keys.map(function (k) {
    var on = brush === k;
    var colour = (k === 'erase' || k === 'text') ? 'var(--line2)' : CATS[k].color;
    return el('button.btn.btn--sm', {
      type: 'button', 'aria-pressed': String(on),
      style: 'border-color:' + (on ? colour : 'var(--line2)'),
      onclick: function () { brush = k; renderBrushes(); }
    }, [
      el('i.swatch', { style: 'background:' + (k === 'erase' || k === 'text' ? 'transparent' : colour) + ';border:1px solid ' + colour }),
      k === 'erase' ? 'Guma' : k === 'text' ? 'Poznámka' : CATS[k].label
    ]);
  }));
}

function renderGrid() {
  var routine = store.data.routine;
  var wake = routine.wake, sleep = routine.sleep;

  // Show an hour either side of the waking day, snapped to whole hours.
  var gStart = Math.max(0, Math.floor((wake - 60) / 60) * 60);
  var gEnd = Math.min(1440, Math.ceil((sleep + 60) / 60) * 60);
  var slots = (gEnd - gStart) / 15;
  var todayIdx = dayIndexOfDate(new Date().toISOString().slice(0, 10));

  var heads = el('div.grid__heads', { style: 'grid-template-columns:repeat(' + slots + ',1fr)' },
    Array.from({ length: Math.ceil(slots / 4) }, function (_, i) {
      return el('span', ('0' + Math.floor((gStart + i * 60) / 60)).slice(-2));
    }));

  var nodes = [el('span'), heads, el('span')];

  DAYS.forEach(function (name, day) {
    var blocks = blocksFor(day);
    var hours = Math.round(blocks.reduce(function (a, b) { return a + (b.e - b.s); }, 0) / 6) / 10;

    var cells = [];
    for (var n = 0; n < slots; n++) {
      (function (slot) {
        var minute = slot * 15;
        var asleep = minute < wake || minute >= sleep;
        var cat = store.data.routine.grid[day + '-' + slot];
        var selected = noteSel && blocks.some(function (b) {
          return b.key === noteSel && minute >= b.s && minute < b.e;
        });
        cells.push(el('button.cell' +
          ((slot + 1) % 4 === 0 ? '.is-mark' : '') +
          (asleep ? '.is-asleep' : '') +
          (selected ? '.is-sel' : ''), {
          type: 'button', 'aria-label': 'Natřít ' + name + ' ' + hhmm(minute),
          'data-cell': day + '-' + slot,
          style: asleep ? '' : 'background:' + (cat ? CATS[cat].color + '66' : 'var(--l2)'),
          onmousedown: function (ev) {
            ev.preventDefault();
            painting = false; lastSlot = -1;   // a new drag starts from here
            paint(day, slot);
            painting = true; lastSlot = slot;
          },
          onmouseenter: function () { if (painting) paint(day, slot); }
        }));
      })(gStart / 15 + n);
    }

    nodes.push(el('span.grid__day' + (day === todayIdx ? '.is-today' : ''), name));
    nodes.push(el('div.grid__cells', { style: 'grid-template-columns:repeat(' + slots + ',1fr)' }, cells));
    nodes.push(el('span.grid__hours', hours + ' h'));
  });

  fill($('routineGrid'), nodes);
  $('wakeLabelR').textContent = hhmm(wake);
  $('sleepLabelR').textContent = hhmm(sleep);
}

/* Repaint the cells without rebuilding them.
   A full render mid-drag replaces the very elements the drag is travelling
   over, and the new ones never receive the mouseenter that was already on its
   way — so the stroke dies after one cell. */
function repaintCells() {
  var routine = store.data.routine;
  var cells = $('routineGrid').querySelectorAll('.cell');
  for (var i = 0; i < cells.length; i++) {
    var node = cells[i];
    if (node.classList.contains('is-asleep')) continue;
    var cat = routine.grid[node.getAttribute('data-cell')];
    node.style.background = cat ? CATS[cat].color + '66' : 'var(--l2)';
  }
  renderHourTotals();
}

function renderHourTotals() {
  var labels = $('routineGrid').querySelectorAll('.grid__hours');
  for (var d = 0; d < labels.length; d++) {
    var mins = blocksFor(d).reduce(function (a, b) { return a + (b.e - b.s); }, 0);
    labels[d].textContent = (Math.round(mins / 6) / 10) + ' h';
  }
}

function renderTotals() {
  var rows = Object.keys(CATS).map(function (k) {
    var mins = 0;
    for (var d = 0; d < 7; d++) {
      blocksFor(d).forEach(function (b) { if (b.cat === k) mins += b.e - b.s; });
    }
    return el('span.wtrow', [
      el('i.swatch', { style: 'background:' + CATS[k].color }),
      el('b', CATS[k].label),
      el('span.bar', el('span.bar__fill', {
        // 40 h is a full bar: enough headroom for a working week without
        // flattening everything else against the left edge.
        style: 'width:' + Math.min(100, Math.round(mins / 2400 * 100)) + '%;background:' + CATS[k].color
      })),
      el('em', (Math.round(mins / 6) / 10) + ' h')
    ]);
  });
  fill($('weekTotals'), rows);
}

function renderNote() {
  var bar = $('noteBar');
  bar.hidden = !noteSel;
  if (!noteSel) return;

  var parts = noteSel.split('-');
  var block = blocksFor(Number(parts[0])).filter(function (b) { return b.key === noteSel; })[0];
  $('noteTarget').textContent = block
    ? DAYS[Number(parts[0])] + ' ' + hhmm(block.s) + '–' + hhmm(block.e) + ' · ' + CATS[block.cat].label
    : '';
  $('noteValue').value = (store.data.routine.notes || {})[noteSel] || '';
}

function render() {
  if (!sheet || sheet.hidden) return;
  if (painting) { repaintCells(); renderTotals(); return; }
  renderBrushes();
  renderGrid();
  renderTotals();
  renderNote();
}

/* ---- open / close ------------------------------------------------------- */

export function openRoutine(open) {
  sheet.hidden = !open;
  if (open) render();
  else noteSel = null;
}

/* ---- wiring ------------------------------------------------------------- */

export function initRoutine() {
  sheet = $('routinePanel');
  if (!sheet) return;

  $('openRoutine').addEventListener('click', function () { openRoutine(true); });
  $('routineClose').addEventListener('click', function () { openRoutine(false); });
  $('routineDone').addEventListener('click', function () { openRoutine(false); });
  sheet.addEventListener('click', function (ev) { if (ev.target === sheet) openRoutine(false); });

  /* Capture phase, like the other sheets: Escape has to close this rather than
     reach the interrupt handler on document. */
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && sheet && !sheet.hidden) {
      openRoutine(false);
      ev.stopImmediatePropagation();
      ev.preventDefault();
    }
  }, true);

  initTouchPainting($('routineGrid'));

  // A drag that ends outside the grid still has to stop painting.
  window.addEventListener('mouseup', function () {
    if (!painting) return;
    painting = false; lastSlot = -1;
    render();                         // one full rebuild when the stroke ends
  });

  function shiftTime(key, delta) {
    var r = store.data.routine;
    var next = Object.assign({}, r);
    if (key === 'wake') next.wake = Math.max(180, Math.min(r.sleep - 240, r.wake + delta));
    else next.sleep = Math.max(r.wake + 240, Math.min(1395, r.sleep + delta));
    store.patch('routine', next);
  }

  $('wakeDownR').addEventListener('click', function () { shiftTime('wake', -15); });
  $('wakeUpR').addEventListener('click', function () { shiftTime('wake', 15); });
  $('sleepDownR').addEventListener('click', function () { shiftTime('sleep', -15); });
  $('sleepUpR').addEventListener('click', function () { shiftTime('sleep', 15); });

  $('noteValue').addEventListener('input', function () {
    if (!noteSel) return;
    var value = $('noteValue').value;
    var notes = Object.assign({}, store.data.routine.notes);
    if (value) notes[noteSel] = value; else delete notes[noteSel];
    store.patch('routine', Object.assign({}, store.data.routine, { notes: notes }));
  });
  $('noteClose').addEventListener('click', function () { noteSel = null; render(); });

  $('askClearGrid').addEventListener('click', function () { $('confirmClear').hidden = false; });
  $('cancelClearGrid').addEventListener('click', function () { $('confirmClear').hidden = true; });
  $('clearGrid').addEventListener('click', function () {
    noteSel = null;
    $('confirmClear').hidden = true;
    store.patch('routine', Object.assign({}, store.data.routine, { grid: {}, notes: {} }));
    say('Rutina vymazána. Natři nový týden.');
  });

  store.onChange(render);
}

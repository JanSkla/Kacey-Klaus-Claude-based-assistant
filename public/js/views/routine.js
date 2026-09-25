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
import { isPhone } from '../ui/psheet.js';
import { CATS } from '../core/routine-cats.js';

/* The categories live in core/ so the server (Kacey's tools, the rules)
   reads the same list; re-exported here for the calendar, which has always
   imported them from this module. */
export { CATS };

var DAYS = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];

var brush = 'work';
var noteSel = null;
var noteDraft = null;      // the note being typed, kept across re-renders
var painting = false;
var lastSlot = -1;         // where the current drag was last seen
var sheet = null;
/* The routine as it was when the planner opened. Every stroke is saved as it
   is painted, so "undo" cannot mean "don't save" — it means "put back what
   was there when I opened this", for as long as the planner stays open. */
var snapshot = null;
var phoneDay = (new Date().getDay() + 6) % 7;   // the one day a phone paints at a time

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
    saveNote();
    noteSel = hit ? hit.key : null;
    noteDraft = null;
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

    /* Each block names itself on the row, so the week reads without hovering.
       pointer-events:none in the CSS — the label must not eat the drag. */
    var span = gEnd - gStart;
    var labels = blocks.map(function (b) {
      var len = b.e - b.s;
      return el('span.grid__label', {
        style: 'left:calc(' + ((b.s - gStart) / span * 100) + '% + 1px);' +
               'width:calc(' + (len / span * 100) + '% - 2px);border-left-color:' + CATS[b.cat].color
      }, [
        el('b', b.note || CATS[b.cat].label),
        el('em', len >= 60 ? hhmm(b.s) + '–' + hhmm(b.e) : hhmm(b.s))
      ]);
    });

    var row = [el('div.grid__cells', { style: 'grid-template-columns:repeat(' + slots + ',1fr)' }, cells)].concat(labels);
    var noteBlock = noteSel && blocks.filter(function (b) { return b.key === noteSel; })[0];
    if (noteBlock && !isPhone()) row.push(noteEditor(day, noteBlock, (noteBlock.s - gStart) / span * 100));

    nodes.push(el('span.grid__day' + (day === todayIdx ? '.is-today' : ''), name));
    nodes.push(el('div.grid__row', row));
    nodes.push(el('span.grid__hours', hours + ' h'));
  });

  fill($('routineGrid'), nodes);
  $('wakeLabelR').textContent = hhmm(wake);
  $('sleepLabelR').textContent = hhmm(sleep);
}

/* ---- naming a block -----------------------------------------------------
   Opens under the block it names. The note is saved on Hotovo, on Enter, or
   when another block is picked — not per keystroke: every store write
   rebuilds the grid, and the field would be rebuilt under the cursor. */

function noteEditor(day, block, leftPct, inline) {
  var saved = (store.data.routine.notes || {})[block.key] || '';
  var input = el('input.input#noteValue', {
    type: 'text', autocomplete: 'off', value: noteDraft != null ? noteDraft : saved,
    placeholder: 'Poznámka — „Laborka“…', 'aria-label': 'Poznámka k bloku',
    oninput: function () { noteDraft = input.value; }
  });
  return el('form.noteedit' + (inline ? '.noteedit--inline' : ''), {
    style: (inline ? '' : 'left:clamp(0px, calc(' + leftPct + '% - 0px), calc(100% - 300px));') +
           'border-left-color:' + CATS[block.cat].color,
    onsubmit: function (ev) { ev.preventDefault(); closeNote(); }
  }, [
    el('span.is-acc', DAYS[day] + ' ' + hhmm(block.s) + '–' + hhmm(block.e) + ' · ' + CATS[block.cat].label),
    el('span.row', [input, el('button.btn.btn--accent.btn--sm', { type: 'submit' }, 'Hotovo')])
  ]);
}

function saveNote() {
  if (!noteSel || noteDraft == null) return;
  var notes = Object.assign({}, store.data.routine.notes);
  var value = noteDraft.trim();
  noteDraft = null;
  if ((notes[noteSel] || '') === value) return;
  if (value) notes[noteSel] = value; else delete notes[noteSel];
  store.patch('routine', Object.assign({}, store.data.routine, { notes: notes }));
}

function closeNote() {
  saveNote();
  noteSel = null;
  render();
}

/* ---- undo to the state at open ------------------------------------------ */

function shape(r) {
  return JSON.stringify({ grid: r.grid || {}, notes: r.notes || {}, wake: r.wake, sleep: r.sleep });
}

function isDirty() {
  return !!snapshot && shape(store.data.routine) !== shape(snapshot);
}

function renderDirty() {
  var dirty = isDirty();
  $('routineDirty').hidden = !dirty;
  var btn = $('revertRoutine');
  btn.disabled = !dirty;
  btn.textContent = dirty ? '↶ Vrátit změny' : 'Beze změn';
  btn.classList.toggle('btn--outlineaccent', dirty);
}

function revert() {
  if (!isDirty()) return;
  noteSel = null; noteDraft = null;
  $('confirmClear').hidden = true;
  store.patch('routine', Object.assign({}, store.data.routine, JSON.parse(shape(snapshot))));
  say('Rutina vrácena do stavu při otevření.');
}

/* ---- the phone: one day, top to bottom -----------------------------------
   A week of hours does not fit across 375px, and scrolling a grid sideways
   while painting it is two gestures fighting. So a phone picks a day and
   paints it as one column: the hours run down, the finger drags down. */

function renderDayPainter() {
  var routine = store.data.routine;
  var wake = routine.wake, sleep = routine.sleep;
  var gStart = Math.max(0, Math.floor((wake - 60) / 60) * 60);
  var gEnd = Math.min(1440, Math.ceil((sleep + 60) / 60) * 60);
  var day = phoneDay;
  var blocks = blocksFor(day);

  fill($('routineDays'), DAYS.map(function (name, d) {
    var mins = blocksFor(d).reduce(function (a, b) { return a + (b.e - b.s); }, 0);
    return el('button.daypick__day', {
      type: 'button', 'aria-pressed': String(d === day),
      onclick: function () { saveNote(); noteSel = null; phoneDay = d; render(); }
    }, [el('span', name), el('em', (Math.round(mins / 6) / 10) + ' h')]);
  }));

  var nodes = [];
  for (var slot = gStart / 15; slot < gEnd / 15; slot++) {
    (function (slot) {
      var minute = slot * 15;
      var asleep = minute < wake || minute >= sleep;
      var cat = routine.grid[day + '-' + slot];
      var start = blocks.filter(function (b) { return b.s === minute; })[0];
      var selected = noteSel && blocks.some(function (b) {
        return b.key === noteSel && minute >= b.s && minute < b.e;
      });
      nodes.push(el('button.cell.cell--v' +
        (minute % 60 === 0 ? '.is-hour' : '') + (asleep ? '.is-asleep' : '') + (selected ? '.is-sel' : ''), {
        type: 'button', 'aria-label': 'Natřít ' + DAYS[day] + ' ' + hhmm(minute),
        'data-cell': day + '-' + slot,
        style: asleep ? '' : 'background:' + (cat ? CATS[cat].color + '66' : 'var(--l2)'),
        onmousedown: function (ev) {
          ev.preventDefault();
          painting = false; lastSlot = -1;
          paint(day, slot);
          painting = true; lastSlot = slot;
        },
        onmouseenter: function () { if (painting) paint(day, slot); }
      }, [
        minute % 60 === 0 ? el('span.cell__time', hhmm(minute)) : null,
        start ? el('span.cell__name', (start.note || CATS[start.cat].label) +
          (start.e - start.s >= 60 ? '  ' + hhmm(start.s) + '–' + hhmm(start.e) : '')) : null
      ]));
      if (start && start.key === noteSel && isPhone()) nodes.push(noteEditor(day, start, 0, true));
    })(slot);
  }
  fill($('routineCol'), nodes);
}

/* Touch on the column: every move paints. The cells carry touch-action:none,
   so the browser does not scroll under the finger; the time gutter beside
   them and the rest of the sheet still scroll normally. */
function initColumnTouch(host) {
  var strokeDay = -1;
  host.addEventListener('touchstart', function (ev) {
    var cell = ev.touches.length === 1 && cellAt(ev.touches[0].clientX, ev.touches[0].clientY);
    if (!cell) return;
    ev.preventDefault();
    painting = false; lastSlot = -1;
    paint(cell.day, cell.slot);
    painting = true; lastSlot = cell.slot; strokeDay = cell.day;
  }, { passive: false });
  host.addEventListener('touchmove', function (ev) {
    if (!painting || ev.touches.length !== 1) return;
    ev.preventDefault();
    var cell = cellAt(ev.touches[0].clientX, ev.touches[0].clientY);
    if (cell && cell.day === strokeDay) paint(cell.day, cell.slot);
  }, { passive: false });
  function end() {
    if (painting) { painting = false; lastSlot = -1; render(); }
    strokeDay = -1;
  }
  host.addEventListener('touchend', end);
  host.addEventListener('touchcancel', end);
}

/* Repaint the cells without rebuilding them.
   A full render mid-drag replaces the very elements the drag is travelling
   over, and the new ones never receive the mouseenter that was already on its
   way — so the stroke dies after one cell. */
function repaintCells() {
  var routine = store.data.routine;
  var cells = sheet.querySelectorAll('.cell');
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

function render() {
  if (!sheet || sheet.hidden) return;
  if (painting) { repaintCells(); renderTotals(); renderDirty(); return; }
  var hadFocus = document.activeElement && document.activeElement.id === 'noteValue';
  renderBrushes();
  renderGrid();
  renderDayPainter();
  renderTotals();
  renderDirty();
  if (hadFocus && $('noteValue')) $('noteValue').focus();
}

/* ---- open / close ------------------------------------------------------- */

export function openRoutine(open) {
  if (!open) saveNote();
  sheet.hidden = !open;
  snapshot = open ? JSON.parse(shape(store.data.routine)) : null;
  noteSel = null; noteDraft = null;
  $('confirmClear').hidden = true;
  if (open) render();
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
  initColumnTouch($('routineCol'));

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

  $('revertRoutine').addEventListener('click', revert);
  $('revertRoutineStrip').addEventListener('click', revert);

  $('askClearGrid').addEventListener('click', function () { $('confirmClear').hidden = false; });
  $('cancelClearGrid').addEventListener('click', function () { $('confirmClear').hidden = true; });
  $('clearGrid').addEventListener('click', function () {
    noteSel = null; noteDraft = null;
    $('confirmClear').hidden = true;
    store.patch('routine', Object.assign({}, store.data.routine, { grid: {}, notes: {} }));
    say('Rutina vymazána. Do zavření plánovače jde vrátit.');
  });

  store.onChange(render);
}

/* =========================================================================
   THE CALENDAR.

   Reads /api/calendar, which reads klaus_memory's `calendar_event` table
   directly. Writes go through /api/calendar/:id/{update,delete}, which run
   klaus_memory rather than touching SQLite — conflicts, updated_at and the
   external write-through all belong to it.

   Three things draw from the same fetched month:
     - the month grid, which says which days hold anything;
     - the day lane, an hour-ruled column with the week's routine painted
       underneath and the day's real events sitting on top of it;
     - the "Today" panel on the main view.

   Tasks with a due date are drawn here too, from the store rather than the
   server: one with a time as a dashed block in the lane, one with only a date
   in the all-day strip. Tapping one ticks it off. They are a "source" of their
   own in Zdroje, so they can be switched off like any calendar.

   Kacey also writes the calendar through conversation, so protocol.js calls
   refreshCalendar() when one of her calendar tools finishes; otherwise an open
   view would sit on rows that are no longer true.

   An event can be unsure (Kacey's own flag, `tentative` in the payload): it is
   drawn dotted with a "?" before its title, and the editor settles it.

   The routine under the events is the date's own, not just its weekday's: a
   block cancelled or moved for that day is drawn hollow, one added for it
   carries a "+", and a finished day is drawn from its cemented copy (sent with
   the month). Tapping a block changes it for that one date; "Nemoc / volno"
   cancels a range of days. Everything goes through /api/routine/alter — the
   same alter() Kacey's app_routine_alter calls (routine-days.js) — except
   amending a cemented day, which only Kacey can do.

   Titles come from the model and from external calendars, so every one of them
   reaches the DOM through textContent.
   ========================================================================= */

import { $ } from '../core/dom.js';
import { el, fill, hhmm as fmtMin } from '../core/el.js';
import * as store from '../core/store.js';
import { go, onEnter } from './router.js';
import { say } from './toast.js';
import { CATS } from '../views/routine.js';
import { CATEGORY_KEYS, KINDS } from '../core/routine-cats.js';
import { effectiveDay, isActive, activeBlocks } from '../core/routine-day.js';
import { openSheet, closeSheet, sheetOpen, isPhone } from './psheet.js';
import { tasks, toggleTask, whenText } from '../views/tasks.js';
import { bucketOf, parseDue } from '../core/due.js';

var DOW_SHORT = ['po', 'út', 'st', 'čt', 'pá', 'so', 'ne'];
var DOW_LONG = ['pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota', 'neděle'];
var MON = ['ledna', 'února', 'března', 'dubna', 'května', 'června',
           'července', 'srpna', 'září', 'října', 'listopadu', 'prosince'];
var MON_NOM = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen',
               'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];

/* One pixel-per-minute scale for the lane, and the padding around the waking
   day. 64px an hour is the smallest that still fits a title and a time on a
   half-hour block without clipping. */
var PPM = 64 / 60;
var PAD = 45;

var month = null;          // 'YYYY-MM'; null = whatever the server calls current
var selected = null;       // 'YYYY-MM-DD' — the first day shown in the lane
var span = 1;              // how many days the lane shows, 1..7
var payload = null;        // the month the grid is showing
var payloads = {};         // every month fetched since the last refresh, by 'YYYY-MM'
var fetching = {};         // months on their way
var loading = false;
var pendingDelete = null;  // event_id awaiting its second tap
var dragAnchor = null;     // the day a drag across the month grid started on

/* A range can run past the end of the month on screen — a week from the 29th
   is mostly next month — so the lane reads days from whichever fetched month
   holds them, and asks for a missing one rather than drawing it empty. */

/* ---- helpers ------------------------------------------------------------ */

function shiftMonth(m, delta) {
  var p = m.split('-').map(Number);
  var d = new Date(p[0], p[1] - 1 + delta, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function clockOf(iso) {
  var d = new Date(iso);
  if (isNaN(d)) return '';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function minutesOf(iso) {
  var d = new Date(iso);
  if (isNaN(d)) return 0;
  return d.getHours() * 60 + d.getMinutes();
}

/** Monday-first weekday index of a 'YYYY-MM-DD'. */
function dowOf(date) {
  var p = date.split('-').map(Number);
  return (new Date(p[0], p[1] - 1, p[2]).getDay() + 6) % 7;
}

/** The calendar source an event belongs to — what the sources filter switches. */
function sourceOf(e) {
  return String(e.source || e.origin || 'jiné');
}

/* A stable colour per source. The first source takes the accent (it is the
   personal one in every setup seen so far); the rest get fixed hues, so a
   colour does not change meaning when a calendar is added. */
var SOURCE_COLOURS = ['var(--acc)', '#78a9ff', '#08bdba', '#d2a106', '#ee5396', '#a56eff'];
var sourceOrder = [];

function colourFor(source) {
  if (source === TASKS) return 'var(--acc)';
  var i = sourceOrder.indexOf(source);
  if (i === -1) { sourceOrder.push(source); i = sourceOrder.length - 1; }
  return SOURCE_COLOURS[i % SOURCE_COLOURS.length];
}

/* An unsure event ("?" on a poster, "maybe Saturday") — Kacey's own flag, sent
   by /api/calendar. Dotted instead of solid, and a "?" before the title. */
function unsure(e) { return !!(e && e.tentative); }
function unsureMark(e) {
  return unsure(e) ? el('span.unsure', { title: 'nejisté', 'aria-label': 'nejisté' }, '?') : null;
}
function edge(width, e) {
  return 'border-left:' + width + 'px ' + (unsure(e) ? 'dotted ' : 'solid ') + colourFor(sourceOf(e));
}
function unsureWord(e) { return unsure(e) ? 'nejisté · ' : ''; }

function sourceEnabled(source) {
  var on = store.data.settings.calOn || {};
  return on[source] !== false;      // unknown sources default to visible
}

/** 'YYYY-MM-DD' plus n days. Local dates at noon, so no DST edge can move it. */
function addDays(date, n) {
  var p = date.split('-').map(Number);
  var d = new Date(p[0], p[1] - 1, p[2] + n, 12);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function mondayOf(date) { return addDays(date, -dowOf(date)); }

function rangeDays() {
  var out = [];
  for (var i = 0; i < span; i++) out.push(addDays(selected, i));
  return out;
}

function dayRecord(date) {
  var p = payloads[date.slice(0, 7)];
  if (!p) { fetchMissing(date.slice(0, 7)); return null; }
  for (var i = 0; i < p.days.length; i++) {
    if (p.days[i].date === date) return p.days[i];
  }
  return null;
}

function eventsOn(date) {
  var rec = dayRecord(date);
  if (!rec) return [];
  return rec.events.filter(function (e) { return sourceEnabled(sourceOf(e)); });
}

/** A routine block's room and teacher, "T2:C2-85 · Fischer J.", or ''. */
function whereOf(r) { return [r.room, r.who].filter(Boolean).join(' · '); }

/* ---- the routine on a date ----------------------------------------------- */

/** 'čt 8. 10.' */
function dayWord(date) {
  var p = date.split('-').map(Number);
  return DOW_SHORT[dowOf(date)] + ' ' + p[2] + '. ' + p[1] + '.';
}

/**
 * One date's routine: its cemented copy once the day is over, otherwise the
 * default week with that date's overrides, resolved by the same code the
 * server uses. kind: 'live' (changeable here), 'cemented' (only Kacey can
 * amend it), 'unrecorded' (before the history began — drawn as the default).
 */
function routineDay(date) {
  var p = payloads[date.slice(0, 7)];
  var r = p && p.routine;
  var snap = r && r.days && r.days[date];
  if (snap) {
    return { date: date, kind: 'cemented', blocks: snap.blocks || [], stale: [],
             altered: !!snap.altered, amended_at: snap.amended_at || null };
  }
  var v = effectiveDay(store.data.routine, date);
  var today = payload && payload.today;
  // A day just over and not fetched cemented yet is history all the same.
  if (today && date < today) v.kind = (r && r.since && date >= r.since) ? 'cemented' : 'unrecorded';
  return v;
}

var GONE = { cancelled: true, moved_out: true };

/** '17. 9.' — how the block editor names the one date it changes. */
function dateShort(date) {
  var p = date.split('-').map(Number);
  return p[2] + '. ' + p[1] + '.';
}

/* The block whose editor is open, so the lane can mark it across repaints. */
var openKey = null;

function blockKey(day, r) {
  return day.date + ':' + (r.override_id ? 'o' + r.override_id : 't' + r.s + r.cat);
}

function markOpen(key) {
  openKey = key;
  var lane = $('dayLane');
  if (!lane) return;
  lane.querySelectorAll('.rblock').forEach(function (n) {
    var on = !!key && n.getAttribute('data-rkey') === key;
    n.classList.toggle('is-selected', on);
    n.setAttribute('aria-pressed', String(on));
  });
}

/* The other half of a move: the add it went to, or the cancel it came from.
   Only what the app document carries (today onwards) — older halves are
   simply not named. */
function moveTwin(r) {
  if (r.group_kind !== 'move' || !r.group_id) return null;
  return (store.data.routine.overrides || []).filter(function (o) {
    return o.group_id === r.group_id && o.id !== r.override_id;
  })[0] || null;
}

/** 'čt 18. 18:00' (where it went) or 'út 17. 9. 07:30' (where it came from). */
function twinWord(r, withMonth) {
  var o = moveTwin(r);
  if (!o) return '';
  var p = o.date.split('-').map(Number);
  return DOW_SHORT[dowOf(o.date)] + ' ' + p[2] + '.' + (withMonth ? ' ' + p[1] + '.' : '') + ' ' + fmtMin(o.slot_from * 15);
}

function rclass(r) {
  return (GONE[r.state] ? '.is-cancelled' : '') + (r.src === 'added' ? '.is-added' : '') +
    (r.src === 'added' && r.overlap === 'pending' ? '.is-overlap' : '');
}

/** The block's fill and edge: hollow and dashed once it is not happening. The
    added half of a side-by-side pair is filled stronger, so it reads as on top.
    A class's type (`r.kind`) is a tag over the top of the edge, `tag` px tall
    (8–16, by the block's height). The edge is painted as a background layer
    under a transparent border, so the tag can sit on it: a child element there
    would be clipped by the block's overflow. */
function rpaint(r, width, color, strong, tag) {
  if (GONE[r.state]) return 'background:transparent;border-left:' + width + 'px dashed ' + color;
  var k = KINDS[r.kind];
  var layers = (k && tag ? 'linear-gradient(' + k.color + ',' + k.color + ') 0 0/' + width + 'px ' + tag + 'px no-repeat border-box,' : '') +
    'linear-gradient(' + color + ',' + color + ') 0 0/' + width + 'px 100% no-repeat border-box ' + color + (strong ? '33' : '1f');
  return 'background:' + layers + ';border-left:' + width + 'px solid transparent';
}

/** The tag's height for a block `px` tall: 8–16. */
function tagH(px) { return Math.min(16, Math.max(8, px - 2)); }

/** "+" before a block added for the day; a warn "!" while its overlap waits for Kacey. */
function rmark(r) {
  if (r.src !== 'added') return null;
  if (r.overlap === 'pending') return el('span.rmark.rmark--warn', { 'aria-hidden': 'true' }, '!');
  return el('span.rmark', { 'aria-hidden': 'true' }, '+');
}

/** The block's second line: its time, or what happened to it. */
function rtimeLine(r, half) {
  var cat = CATS[r.cat];
  if (r.state === 'moved_out') { var to = twinWord(r, false); return to ? 'přesunuto → ' + to : 'přesunuto jinam'; }
  if (r.state === 'cancelled') return 'zrušeno' + (r.reason ? ' · ' + r.reason : '');
  if (half) return fmtMin(r.s);
  var range = fmtMin(r.s) + '–' + fmtMin(r.e);
  if (r.src === 'added') { var from = r.state === 'moved_in' ? twinWord(r, true) : ''; return range + (from ? ' · z ' + from : ' · jen dnes'); }
  return range + (r.note ? ' · ' + cat.label : '');
}

/* An added block on top of a default one: the two are drawn side by side
   ('--a' the default, '--b' the added), never one hiding the other. */
function sideBySide(blocks) {
  var out = {};
  blocks.forEach(function (b, i) {
    if (b.src !== 'added' || !b.overlap) return;
    out[i] = '.rblock--b';
    blocks.forEach(function (t, j) {
      if (t.src === 'template' && isActive(t) && t.s < b.e && b.s < t.e) out[j] = '.rblock--a';
    });
  });
  return out;
}

/** The routine blocks of one lane column (or the single-day lane), as buttons. */
function routineNodes(day, b, col, narrow) {
  var side = sideBySide(day.blocks);
  var nodes = [];
  day.blocks.forEach(function (r, i) {
    if (r.e <= b.start || r.s >= b.end) return;
    var cat = CATS[r.cat];
    if (!cat) return;
    var where = whereOf(r);
    var half = side[i] || '';
    var gone = !!GONE[r.state];
    var label = r.note || cat.label;
    var time = rtimeLine(r, !!half);
    var key = blockKey(day, r);
    var on = key === openKey;
    var title = [label, rtimeLine(r, false), KINDS[r.kind] ? KINDS[r.kind].label : '', where, r.src === 'added' && r.overlap === 'pending' ? 'překryv čeká na Kacey' : '']
      .filter(Boolean).join(' · ');
    var ink = gone ? 'var(--ink3)' : (col !== undefined && r.src === 'added' && r.overlap === 'pending' ? 'var(--warn)' : cat.color);
    var open = function () { openBlock(day, r, b.top(r.s), col); };
    var attrs = {
      type: 'button', title: title, 'aria-pressed': String(on), 'data-rkey': key,
      style: 'top:' + b.top(r.s) + 'px;height:' + Math.max(b.height(r.s, r.e), col === undefined ? 18 : 6) + 'px;' +
        rpaint(r, col === undefined && !half ? 6 : 4, cat.color, half === '.rblock--b',
               col === undefined ? tagH(b.height(r.s, r.e)) : 14),
      onclick: open
    };
    var cls = rclass(r) + half + (on ? '.is-selected' : '');
    if (col === undefined) {
      var tall = (r.e - r.s) >= 45;
      nodes.push(el('button.rblock' + cls + (tall ? '' : '.is-short'), attrs, [
        el('b', { style: 'color:' + ink }, [rmark(r), label]),
        el('em', time),
        // Where and with whom — a class from the timetable. Needs ~an hour of height.
        // Two spans, so a phone can stack them in its narrow label strip.
        where && !half && !gone && (r.e - r.s) >= 60
          ? el('em.rblock__where', [r.room ? el('span', r.room) : null, r.who ? el('span', r.who) : null])
          : null
      ]));
      return;
    }
    // A column has no room for the boxed mark: "+" and "!" lead the name as text.
    var lead = r.src === 'added' ? (r.overlap === 'pending' ? '! ' : '+ ') : '';
    nodes.push(el('button.rblock.rblock--col' + cls, attrs, (r.e - r.s) >= 45 && !narrow ? [
      el('b', { style: 'color:' + ink }, lead + label),
      // The room only: a column has no width for the teacher as well.
      r.room && !half && !gone && (r.e - r.s) >= 75 ? el('em.rblock__where', r.room) : null
    ] : null));
  });
  return nodes;
}

function coveredMin(day) {
  return activeBlocks(day).reduce(function (a, r) { return a + (r.e - r.s); }, 0);
}

/* ---- tasks in the calendar ---------------------------------------------- */

var TASKS = 'úkoly';       // their row in Zdroje, and their key in settings.calOn

/** Tasks due on `date`, each with its parsed due (`p`); [] when switched off. */
function tasksOn(date) {
  if (!sourceEnabled(TASKS)) return [];
  return tasks().map(function (t) { return { t: t, p: parseDue(t.due_at) }; })
    .filter(function (x) { return x.p && x.p.date === date; });
}
function timedTasksOn(date) { return tasksOn(date).filter(function (x) { return x.p.time; }); }
function dayTasksOn(date) { return tasksOn(date).filter(function (x) { return !x.p.time; }); }

/** Something to mark the day with in the month grid or the week strip. */
function dayHasAnything(date, rec) {
  return (!!rec && rec.events.some(function (e) { return sourceEnabled(sourceOf(e)); })) ||
    tasksOn(date).some(function (x) { return !x.t.done; });
}

function tickTask(t) {
  toggleTask(t.id);
  say((t.done ? 'Zpět mezi nehotové · ' : 'Hotovo · ') + t.label);
}

/** A timed task in the lane: dashed, with its own checkbox, `duration` tall. */
function taskBlock(x, b, col, narrow) {
  var t = x.t, s = x.p.minutes;
  var en = Math.min(1440, s + (t.duration || 30));
  var h = Math.max(b.height(s, en), col ? 22 : 38);
  var tall = h >= (col ? 44 : 62);
  var late = bucketOf(t) === 'overdue';
  return el('button.eblock.eblock--task' + (col ? '.eblock--col' : '') + (tall ? '' : '.is-short') +
            (t.done ? '.is-done' : '') + (late ? '.is-late' : ''), {
    type: 'button', 'aria-pressed': String(!!t.done),
    title: x.p.time + ' ' + t.label + ' · úkol · ' + (t.done ? 'klepnutím vrátíš' : 'klepnutím odškrtneš'),
    style: 'top:' + b.top(s) + 'px;height:' + h + 'px' + (narrow ? ';left:6px' : ''),
    onclick: function () { tickTask(t); }
  }, [
    el('p', [el('span.eblock__check', { 'aria-hidden': 'true' }, t.done ? '✓' : ''),
             (narrow ? '' : x.p.time + ' ') + t.label]),
    tall ? el('em', 'úkol · ' + (late ? 'po termínu · ' : '') + whenText(t)) : null
  ]);
}

/** A task with a date and no time, in the all-day strip or a column head. */
function dayTaskChip(x, cls) {
  var t = x.t;
  return el('button.' + cls + '.' + cls + '--task' + (t.done ? '.is-done' : ''), {
    type: 'button', 'aria-pressed': String(!!t.done),
    title: t.label + ' · úkol · ' + (t.done ? 'klepnutím vrátíš' : 'klepnutím odškrtneš'),
    onclick: function () { tickTask(t); }
  }, [el('span.eblock__check', { 'aria-hidden': 'true' }, t.done ? '✓' : ''),
      cls === 'allday' ? 'úkol · ' + t.label : t.label]);
}

/* ---- loading ------------------------------------------------------------ */

async function fetchMonth(m) {
  var url = '/api/calendar' + (m ? '?month=' + encodeURIComponent(m) : '');
  var res = await fetch(url);
  var body = await res.json();
  if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
  payloads[body.month] = body;
  return body;
}

/** A range reached into a month nobody has fetched: get it, then redraw. */
function fetchMissing(m) {
  if (fetching[m] || payloads[m]) return;
  fetching[m] = true;
  fetchMonth(m)
    .then(function () { if (payload) render(); })
    .catch(function () { /* the lane just shows those days empty */ })
    .finally(function () { delete fetching[m]; });
}

/** Everything again from the server — Kacey may have just written to it. */
export async function refreshCalendar() {
  payloads = {};
  return showMonth(month);
}

async function showMonth(m) {
  if (loading) return;
  loading = true;
  try {
    var body = (m && payloads[m]) || await fetchMonth(m);
    payload = body;
    month = body.month;
    if (!selected || (selected.slice(0, 7) !== month && addDays(selected, span - 1).slice(0, 7) !== month)) {
      selected = (body.today && body.today.slice(0, 7) === month) ? body.today : month + '-01';
    }
    // Learn the colour order from the data, most-used source first, so it is
    // the same on every load rather than whichever event happened to be first.
    var counts = {};
    payload.days.forEach(function (d) {
      d.events.forEach(function (e) { var s = sourceOf(e); counts[s] = (counts[s] || 0) + 1; });
    });
    sourceOrder = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    render();
  } catch (err) {
    if ($('calMeta')) $('calMeta').textContent = 'Kalendář nelze načíst: ' + err.message;
  } finally {
    loading = false;
  }
}

/* ---- the month grid ----------------------------------------------------- */

function renderMonth() {
  var host = $('calBody');
  if (!host || !payload) return;

  var nodes = DOW_SHORT.map(function (d) { return el('span.monthgrid__dow', d.toUpperCase()[0]); });

  // Lead with blanks so the first day lands under the right weekday.
  var lead = dowOf(payload.days[0].date);
  for (var b = 0; b < lead; b++) nodes.push(el('span'));

  /* Press on a day and drag across others to compare up to seven side by
     side. The drag is mouse only; a tap (and Enter on a focused day, which
     fires click with no mousedown) shows that one day. Mid-drag nothing is
     rebuilt — markRange() only moves classes — because replacing the buttons
     under the pointer loses the mouseenter the next day was about to get. */
  payload.days.forEach(function (d) {
    var n = Number(d.date.slice(8));
    var has = dayHasAnything(d.date, d);
    var cls = '.day';
    if (has) cls += '.has-events';
    if (d.date === payload.today) cls += '.is-today';
    else if (d.date < payload.today) cls += '.is-past';
    nodes.push(el('button' + cls, {
      type: 'button', 'data-date': d.date,
      onmousedown: function (ev) {
        if (ev.button !== 0) return;
        ev.preventDefault();
        dragAnchor = d.date;
        showRange(d.date, 1);
      },
      onmouseenter: function () {
        if (!dragAnchor) return;
        var lo = d.date < dragAnchor ? d.date : dragAnchor;
        var hi = d.date < dragAnchor ? dragAnchor : d.date;
        // Seven at most: the far end follows the pointer, the anchor stays put.
        if (daysBetween(lo, hi) > 6) { if (d.date > dragAnchor) hi = addDays(lo, 6); else lo = addDays(hi, -6); }
        showRange(lo, daysBetween(lo, hi) + 1);
      },
      onclick: function (ev) {
        if (ev.detail === 0) showRange(d.date, 1);
        setMonthOpen(false);           // a phone folds the month away once you pick
      }
    }, String(n)));
  });

  fill(host, nodes);
  markRange();

  $('calMonth').textContent = MON_NOM[Number(month.slice(5)) - 1] + ' ' + month.slice(0, 4);
  $('calMeta').textContent = payload.monthEvents + ' událostí v měsíci · ' + payload.total + ' celkem';

  /* Months that hold anything, so an empty stretch does not have to be clicked
     through one month at a time. */
  var others = (payload.monthsWithEvents || []).filter(function (m) { return m.month !== month; }).slice(-8);
  $('calJumpWrap').hidden = others.length === 0;
  fill($('calJump'), others.map(function (m) {
    return el('button.chip.chip--filter', {
      type: 'button',
      onclick: function () { showMonth(m.month); }
    }, m.month + ' (' + m.count + ')');
  }));
}

function daysBetween(a, b) {
  var pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  return Math.round((new Date(pb[0], pb[1] - 1, pb[2], 12) - new Date(pa[0], pa[1] - 1, pa[2], 12)) / 86400000);
}

function markRange() {
  var last = addDays(selected, span - 1);
  var days = $('calBody').querySelectorAll('.day');
  for (var i = 0; i < days.length; i++) {
    var date = days[i].getAttribute('data-date');
    var inside = date >= selected && date <= last;
    days[i].classList.toggle('is-selected', inside && span === 1);
    days[i].classList.toggle('is-inrange', inside && span > 1);
    days[i].setAttribute('aria-pressed', String(inside));
  }
}

/** Point the lane at a new range without rebuilding the month grid. */
function showRange(start, n) {
  hideCard();
  selected = start; span = n;
  markRange(); renderSpans(); renderLane(); renderWeek();
}

/* ---- the phone's week strip ----------------------------------------------
   A phone shows the week around the range instead of the whole month; the
   month unfolds from its name in the header. Desktop never shows the strip. */

function monthOpen() {
  return $('calBody').closest('.view').getAttribute('data-month') === 'open';
}

function setMonthOpen(open) {
  $('calBody').closest('.view').setAttribute('data-month', open ? 'open' : '');
  $('calMonthToggle').setAttribute('aria-expanded', String(open));
  $('calCaret').textContent = open ? '▴' : '▾';
}

function renderWeek() {
  var host = $('calWeek');
  if (!host || !payload) return;
  var start = mondayOf(selected), last = addDays(selected, span - 1);
  var nodes = [];
  for (var i = 0; i < 7; i++) {
    (function (date) {
      var p = date.split('-').map(Number);
      var rec = dayRecord(date);
      var has = dayHasAnything(date, rec);
      var inside = date >= selected && date <= last;
      nodes.push(el('button.weekday' + (date === payload.today ? '.is-today' : '') + (inside ? '.is-inrange' : ''), {
        type: 'button', 'aria-pressed': String(inside),
        onclick: function () { moveTo(span >= 5 ? mondayOf(date) : date, span); }
      }, [
        el('span', DOW_SHORT[i]),
        el('b', String(p[2])),
        el('i', { 'aria-hidden': 'true', class: has ? 'has' : '' })
      ]));
    })(addDays(start, i));
  }
  fill(host, nodes);
}

function renderSpans() {
  var opts = $('calSpans').querySelectorAll('[data-span]');
  for (var i = 0; i < opts.length; i++) {
    opts[i].setAttribute('aria-pressed', String(Number(opts[i].getAttribute('data-span')) === span));
  }
}

function renderSources() {
  var host = $('calSources');
  if (!host || !payload) return;

  var counts = {};
  payload.days.forEach(function (d) {
    d.events.forEach(function (e) { var s = sourceOf(e); counts[s] = (counts[s] || 0) + 1; });
  });
  var names = Object.keys(counts).sort();

  // Tasks are always offered: a month with none can still get some.
  counts[TASKS] = tasks().filter(function (t) { return (t.due_at || '').slice(0, 7) === month; }).length;
  names.push(TASKS);

  fill(host, names.map(function (s) {
    var on = sourceEnabled(s);
    return el('button.btn.btn--fn', {
      type: 'button', 'aria-pressed': String(on),
      onclick: function () {
        var next = Object.assign({}, store.data.settings.calOn);
        next[s] = !on;
        store.patchSettings({ calOn: next });
        render();
      }
    }, [
      el('i.swatch', { style: 'background:' + (on ? colourFor(s) : 'transparent') + ';border:1px solid ' + colourFor(s) }),
      s + ' · ' + counts[s]
    ]);
  }));
}

/* ---- the day lane ------------------------------------------------------- */

/* ---- the lane: one day, or up to seven side by side ---------------------- */

/** The lane's minute window: the waking day plus a margin, never clipping an event. */
function laneBounds(dates) {
  var routine = store.data.routine;
  var start = Math.max(0, routine.wake - PAD), end = Math.min(1440, routine.sleep + PAD);
  dates.forEach(function (date) {
    eventsOn(date).forEach(function (e) {
      if (e.all_day) return;
      var s = minutesOf(e.starts_at);
      start = Math.min(start, Math.floor(s / 60) * 60);
      // Same end as the block gets: one ending at midnight (or with no end) is
      // drawn 30 minutes long, and the lane must reach that far.
      var en = e.ends_at ? minutesOf(e.ends_at) : s + 30;
      if (en <= s) en = s + 30;
      end = Math.max(end, Math.ceil(en / 60) * 60);
    });
    timedTasksOn(date).forEach(function (x) {
      start = Math.min(start, Math.floor(x.p.minutes / 60) * 60);
      end = Math.max(end, Math.ceil((x.p.minutes + (x.t.duration || 30)) / 60) * 60);
    });
  });
  start = Math.max(0, start); end = Math.min(1440, Math.max(end, start + 120));
  return {
    start: start, end: end,
    top: function (m) { return Math.round((Math.max(m, start) - start) * PPM); },
    height: function (a, b) { return Math.round((Math.min(b, end) - Math.max(a, start)) * PPM); }
  };
}

/** Sleep hatching and hour rules — the furniture both lanes share. */
function laneFrame(b, labelled) {
  var routine = store.data.routine;
  var wake = routine.wake, sleep = routine.sleep;
  var nodes = [];
  if (wake > b.start) {
    nodes.push(el('div.sleepband', { style: 'top:0;height:' + Math.round((wake - b.start) * PPM) + 'px;border-bottom:1px solid var(--line)' },
      labelled ? el('span', 'spánek do ' + fmtMin(wake)) : null));
  }
  if (sleep < b.end) {
    nodes.push(el('div.sleepband', { style: 'top:' + b.top(sleep) + 'px;height:' + Math.round((b.end - sleep) * PPM) + 'px;border-top:1px solid var(--line)' },
      labelled ? el('span', 'spánek od ' + fmtMin(sleep)) : null));
  }
  for (var h = Math.ceil(b.start / 60); h < b.end / 60; h++) {
    nodes.push(el('div.tick' + (h % 2 ? '.tick--odd' : ''), { style: 'top:' + b.top(h * 60) + 'px' },
      el('span', ('0' + h).slice(-2) + ':00')));
  }
  return nodes;
}

function renderLane() {
  if (!$('dayLane') || !payload || !selected) return;
  /* An open editor survives the repaint (the minute tick, a store change);
     without this it vanished under the pointer about to press its button. */
  var editing = $('dayLane').querySelector('.eventedit');
  if (span > 1) renderMulti(); else renderDay();
  if (editing) $('dayLane').appendChild(editing);
  renderRoutineBar();
  fill($('routineLegend'), Object.keys(CATS).map(function (k) {
    return el('span', [el('i', { style: 'background:' + CATS[k].color }), CATS[k].label]);
  }).concat([el('span.legend__kinds', { title: 'Značka nahoře v boční čáře školního bloku' }, Object.keys(KINDS).map(function (k) {
    return el('span', [el('i.legend__kind', { style: 'background:' + KINDS[k].color }), KINDS[k].label]);
  }))]));
}

function renderDay() {
  var host = $('dayLane');
  var events = eventsOn(selected);
  var timed = events.filter(function (e) { return !e.all_day; });
  var allDay = events.filter(function (e) { return e.all_day; });

  var b = laneBounds([selected]);
  var start = b.start, end = b.end, top = b.top, height = b.height;

  host.style.height = Math.round((end - start) * PPM) + 'px';
  $('dayCols').hidden = true;
  $('dayAllDay').hidden = false;

  var nodes = laneFrame(b, true);

  // the date's routine, painted underneath
  var rday = routineDay(selected);
  nodes = nodes.concat(routineNodes(rday, b));

  // the day's real events, on top
  var nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  var isToday = selected === payload.today;

  timed.forEach(function (e) {
    var s = minutesOf(e.starts_at);
    var en = e.ends_at ? minutesOf(e.ends_at) : s + 30;
    if (en <= s) en = s + 30;
    var h = Math.max(height(s, en), 38);
    var tall = h >= 62;
    var running = isToday && nowMin >= s && nowMin < en;
    var past = isToday ? nowMin >= en : selected < payload.today;
    nodes.push(el('button.eblock' + (tall ? '' : '.is-short') + (past ? '.is-past' : '') + (unsure(e) ? '.is-tentative' : ''), {
      type: 'button',
      style: 'top:' + top(s) + 'px;height:' + h + 'px;' + edge(4, e) +
             (running && !unsure(e) ? ';border-color:var(--line2)' : ''),
      onclick: function () { openEvent(e, top(s)); }
    }, [
      el('p', [unsureMark(e), clockOf(e.starts_at) + '  ' + (e.title || '(bez názvu)')]),
      el('em', { style: running ? 'color:var(--acc)' : '' },
        unsureWord(e) + sourceOf(e) + ' · ' + clockOf(e.starts_at) + '–' + clockOf(e.ends_at))
    ]));
  });

  var timedTasks = timedTasksOn(selected), dayTasks = dayTasksOn(selected);
  timedTasks.forEach(function (x) { nodes.push(taskBlock(x, b, false, false)); });

  if (isToday && nowMin >= start && nowMin <= end) {
    nodes.push(el('span.nowline', { style: 'top:' + top(nowMin) + 'px' }));
  }

  fill(host, nodes);

  fill($('dayAllDay'), allDay.map(function (e) {
    return el('button.allday' + (unsure(e) ? '.is-tentative' : ''), {
      type: 'button',
      style: edge(4, e),
      onclick: function () { openEvent(e, 0); }
    }, [unsureMark(e), 'celý den · ' + (e.title || '(bez názvu)')]);
  }).concat(dayTasks.map(function (x) { return dayTaskChip(x, 'allday'); })));

  var p = selected.split('-').map(Number);
  var nTasks = timedTasks.length + dayTasks.length;
  $('dayLabel').textContent = DOW_LONG[dowOf(selected)] + ' ' + p[2] + '. ' + MON[p[1] - 1];
  $('dayMeta').textContent = (events.length || nTasks)
    ? [events.length ? events.length + ' událostí' : '', nTasks ? nTasks + ' úkolů' : '']
        .filter(Boolean).join(' · ') + (isToday ? ' · teď ' + fmtMin(nowMin) : '')
    : 'žádné události';

  var covered = coveredMin(rday);
  $('routineHours').textContent = 'Rutina pokrývá ' + (Math.round(covered / 6) / 10) +
    ' h z tohoto dne. Události kalendáře sedí nahoře.';
}

/* Several days as columns on one shared hour ruler. At five or more columns
   there is no room for words beside a time, so blocks drop to title only and
   the routine loses its labels — the colour still says what it is. */
function renderMulti() {
  var host = $('dayLane');
  var dates = rangeDays();
  var narrow = span >= 5;
  var b = laneBounds(dates);
  var top = b.top, height = b.height;
  var today = payload.today;
  var nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  var total = 0, covered = 0;

  host.style.height = Math.round((b.end - b.start) * PPM) + 'px';
  $('dayAllDay').hidden = true;

  var heads = [], cols = [];
  dates.forEach(function (date, ci) {
    var p = date.split('-').map(Number);
    var events = eventsOn(date);
    var timed = events.filter(function (e) { return !e.all_day; });
    var allDay = events.filter(function (e) { return e.all_day; });
    var wd = dowOf(date);
    var isToday = date === today;
    var timedTasks = timedTasksOn(date), dayTasks = dayTasksOn(date);
    var count = events.length + timedTasks.length + dayTasks.length;
    total += count;

    heads.push(el('div.colhead', [
      el('button.colhead__day' + (isToday ? '.is-today' : ''), {
        type: 'button', title: 'Otevřít jen tento den',
        onclick: function () { showRange(date, 1); }
      }, [
        el('span', DOW_SHORT[wd]),
        el('b', p[2] + ((p[2] === 1 || ci === 0) && !narrow ? '. ' + MON[p[1] - 1].slice(0, 3) : '.'))
      ]),
      el('span.colhead__meta', count ? count + (narrow ? '' : ' položek') : '—'),
      allDay.map(function (e) {
        return el('button.colhead__allday' + (unsure(e) ? '.is-tentative' : ''), {
          type: 'button', title: unsureWord(e) + (e.title || '(bez názvu)'),
          style: edge(3, e),
          onclick: function () { openEvent(e, 0, ci); }
        }, [unsureMark(e), e.title || '(bez názvu)']);
      }),
      dayTasks.map(function (x) { return dayTaskChip(x, 'colhead__allday'); })
    ]));

    var rday = routineDay(date);
    covered += coveredMin(rday);
    var nodes = routineNodes(rday, b, ci, narrow);

    timed.forEach(function (e) {
      var s = minutesOf(e.starts_at);
      var en = e.ends_at ? minutesOf(e.ends_at) : s + 30;
      if (en <= s) en = s + 30;
      var h = Math.max(height(s, en), 22);
      var tall = h >= 44;
      var past = isToday ? nowMin >= en : date < today;
      var title = e.title || '(bez názvu)';
      nodes.push(el('button.eblock.eblock--col' + (tall ? '' : '.is-short') + (past ? '.is-past' : '') + (unsure(e) ? '.is-tentative' : ''), {
        type: 'button',
        title: clockOf(e.starts_at) + ' ' + title + ' · ' + unsureWord(e) + sourceOf(e),
        style: 'top:' + top(s) + 'px;height:' + h + 'px;' + edge(3, e) +
               (narrow ? ';left:6px' : ''),
        onclick: function () { openEvent(e, top(s), ci); }
      }, [
        el('p', [unsureMark(e), (narrow ? '' : clockOf(e.starts_at) + ' ') + title]),
        tall ? el('em', clockOf(e.starts_at) + (narrow ? '' : ' · ' + sourceOf(e))) : null
      ]));
    });

    timedTasks.forEach(function (x) { nodes.push(taskBlock(x, b, true, narrow)); });

    if (isToday && nowMin >= b.start && nowMin <= b.end) {
      nodes.push(el('span.nowline', { style: 'top:' + top(nowMin) + 'px' }));
    }
    cols.push(el('div.lanecol', nodes));
  });

  var grid = 'grid-template-columns:repeat(' + span + ',minmax(0,1fr))';
  var headHost = $('dayCols');
  headHost.hidden = false;
  fill(headHost, el('div.colheads__grid', { style: grid }, heads));
  fill(host, laneFrame(b, false).concat([el('div.lanecols', { style: grid }, cols)]));

  var first = dates[0].split('-').map(Number), lastD = dates[dates.length - 1].split('-').map(Number);
  $('dayLabel').textContent = first[2] + '. ' + (first[1] !== lastD[1] ? MON[first[1] - 1] + ' ' : '') +
    '– ' + lastD[2] + '. ' + MON[lastD[1] - 1];
  $('dayMeta').textContent = span + ' dní · ' + total + ' položek';
  $('routineHours').textContent = 'Rutina pokrývá ' + (Math.round(covered / 6) / 10) +
    ' h v těchto dnech. Klepni na den nahoře a otevřeš jen ten.';
}

/* ---- editing one event --------------------------------------------------
   Renaming and deleting only. Creating and moving stay in the conversation,
   where Kacey can check the routine and the other calendars first — which is
   the whole reason she has the tool. */

function openEvent(e, topPx, col) {
  var lane = $('dayLane');
  var existing = lane.querySelector('.eventedit');
  if (existing) existing.remove();
  markOpen(null);

  var input = el('input.input', { type: 'text', value: e.title || '' });
  // An all-day event has no hours to show ("00:00–00:00" says nothing).
  var hours = e.all_day ? 'celý den' : clockOf(e.starts_at) + '–' + clockOf(e.ends_at);

  /* Opens where the event is. In the column lane it sits over its own day,
     pulled left when that day is near the right edge. */
  var place = 'top:' + (topPx || 0) + 'px';
  if (span > 1) place += ';left:clamp(0px, calc(' + ((col || 0) / span * 100) + '%), calc(100% - 340px))';

  var box = el('div.card.card--pad.eventedit' + (span > 1 ? '.eventedit--col' : ''), {
    style: place
  }, [
    /* An unsure event leads with its "?" and says so; Kacey's reason (the
       note) gets a line of its own under the head. */
    unsure(e)
      ? el('p.label', [unsureMark(e), 'NEJISTÉ · ' + hours.toUpperCase() + ' · ' + sourceOf(e).toUpperCase()])
      : el('p.muted-3', hours + ' · ' + sourceOf(e)),
    unsure(e) && e.tentative_note ? el('p.muted', e.tentative_note) : null,
    input,
    el('div.row', { style: 'margin-top:8px' }, [
      el('button.btn.btn--accent.btn--sm', {
        type: 'button',
        onclick: async function () { await writeEvent(e.event_id, 'update', { title: input.value }); }
      }, 'Uložit název'),
      /* Settling an unsure event (or making one unsure) is Kacey's own flag, so
         it can happen here as well as in the conversation. */
      el('button.btn.btn--sm' + (unsure(e) ? '.btn--outlineaccent' : ''), {
        type: 'button',
        title: unsure(e) ? 'Událost je jistá' : 'Zatím nejisté — v kalendáři tečkovaně',
        onclick: function () { writeEvent(e.event_id, 'tentative', { tentative: !unsure(e) }); }
      }, unsure(e) ? 'Potvrdit' : 'S otazníkem'),
      el('button.btn.btn--sm.btn--dangerghost', {
        type: 'button',
        onclick: function (ev) {
          var btn = ev.currentTarget;
          if (pendingDelete !== e.event_id) {
            pendingDelete = e.event_id;
            btn.textContent = 'Opravdu smazat?';
            setTimeout(function () {
              if (pendingDelete === e.event_id) { pendingDelete = null; btn.textContent = 'Smazat'; }
            }, 4000);
            return;
          }
          pendingDelete = null;
          writeEvent(e.event_id, 'delete');
        }
      }, 'Smazat'),
      el('button.btn.btn--sm', {
        type: 'button', onclick: function () { if (sheetOpen(box)) closeSheet(); else box.remove(); }
      }, 'Zavřít')
    ]),
    el('p.muted-3.eventedit__note', 'Vytvářet a přesouvat události jde jen v konverzaci — Kacey nejdřív zkontroluje rutinu a ostatní kalendáře.')
  ]);

  lane.appendChild(box);
  if (isPhone()) openSheet(box, function () { box.remove(); });
  input.focus();
}

async function writeEvent(id, action, body) {
  try {
    var res = await fetch('/api/calendar/' + encodeURIComponent(id) + '/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    var out = await res.json();
    if (!res.ok || out.ok === false) throw new Error(out.error || ('HTTP ' + res.status));
    closeSheet();
    say(action === 'delete' ? 'Událost smazána.'
      : action === 'tentative' ? (body.tentative ? 'Zatím s otazníkem.' : 'Potvrzeno.')
      : 'Název uložen.');
    refreshCalendar();
  } catch (err) {
    say('Nepovedlo se: ' + err.message);
  }
}

/* ---- changing the routine for one date ------------------------------------
   The same operations Kacey has (app_routine_alter), through the same server
   function. The default week is not touched; the planner still owns that. */

/** The card over the lane (a bottom sheet on a phone). `cls` picks the routine
    variants: '.eventedit--routine' (a block) and '.eventedit--add' (+ Blok). */
function showCard(children, topPx, col, cls) {
  var lane = $('dayLane');
  var existing = lane.querySelector('.eventedit');
  if (existing) existing.remove();
  // Kept inside the lane: a block near midnight opens its card above itself.
  var room = (parseInt(lane.style.height, 10) || 0) - (cls === '.eventedit--add' ? 280 : 300);
  var place = 'top:' + Math.max(0, Math.min(topPx || 0, room)) + 'px';
  if (span > 1) place += ';left:clamp(0px, calc(' + ((col || 0) / span * 100) + '%), calc(100% - 340px))';
  var box = el('div.card.card--pad.eventedit' + (cls || '') + (span > 1 ? '.eventedit--col' : ''), { style: place }, children);
  lane.appendChild(box);
  if (isPhone()) openSheet(box, function () { box.remove(); markOpen(null); });
  return box;
}

function hideCard() {
  markOpen(null);
  var box = $('dayLane') && $('dayLane').querySelector('.eventedit');
  if (!box) return;
  if (sheetOpen(box)) closeSheet(); else box.remove();
}

function button(cls, label, fn) {
  return el('button.btn' + (cls || ''), { type: 'button', onclick: fn }, label);
}

/** A labelled field in the routine cards: an 11px caption over its control. */
function field(caption, control) {
  return el('label.field.field--tight', [el('span.field__cap', caption), control]);
}

/* Sends a message as if typed — protocol.js's submit(), handed in by app.js. */
var sendToKacey = null;

/** Ask Kacey in the conversation — overlaps and history are hers to decide
    (an Opus turn). The calendar stays; the toast leads to her answer. */
function askKacey(text) {
  if (!sendToKacey) return;
  hideCard();
  sendToKacey(text);
  say('Otázka odešla Kacey do konverzace.', { label: 'Otevřít', run: function () { go('main'); } });
}

function overlapQuestion(day, r) {
  var added = r.src === 'added' ? [r] : day.blocks.filter(function (x) {
    return x.src === 'added' && x.overlap === 'pending' && x.s < r.e && r.s < x.e;
  });
  var under = day.blocks.filter(function (x) {
    return x.src === 'template' && isActive(x) && added.some(function (a) { return x.s < a.e && a.s < x.e; });
  });
  var word = function (x) { return (x.note || CATS[x.cat].label) + ' ' + fmtMin(x.s) + '–' + fmtMin(x.e); };
  return 'V rutině se ' + dayWord(day.date) + ' překrývá ' + added.map(word).join(', ') +
    ' (přidané jen na ten den' + (added[0] && added[0].override_id ? ', #' + added[0].override_id : '') + ') s výchozím ' +
    under.map(word).join(', ') + '. Rozhodni, jestli ten výchozí blok na ten den zrušit, nebo nechat obojí.';
}

function historyQuestion(day, r) {
  return 'Chci opravit rutinu ' + dayWord(day.date) + ', ten den už je zapsaný v historii: ' + (r.note || CATS[r.cat].label) + ' ' +
    fmtMin(r.s) + '–' + fmtMin(r.e) + '. Zeptej se mě, co se ten den doopravdy stalo, a oprav ho.';
}

/** The undo for what one alter() just wrote: its new overrides, removed again
    (a sick range as its whole group; a move goes with either half). */
function undoOf(before) {
  var fresh = (store.data.routine.overrides || []).filter(function (o) { return !before[o.id]; });
  if (!fresh.length) return null;
  var range = fresh.filter(function (o) { return o.group_kind === 'range' && o.group_id; })[0];
  return function () {
    if (range) { alterRoutine({ op: 'reset', group_id: range.group_id }, 'Vráceno.'); return; }
    var seen = {};
    fresh.forEach(function (o) {
      if (o.group_id && seen[o.group_id]) return;
      if (o.group_id) seen[o.group_id] = true;
      alterRoutine({ op: 'remove', id: o.id }, 'Vráceno.');
    });
  };
}

/**
 * One change through /api/routine/alter, then a toast. `message` replaces the
 * server's summary; `undo` offers "Vrátit" for what was just written.
 */
async function alterRoutine(op, message, undo) {
  var before = {};
  (store.data.routine.overrides || []).forEach(function (o) { before[o.id] = true; });
  try {
    var res = await fetch('/api/routine/alter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(op)
    });
    var out = await res.json();
    if (!res.ok || !out.ok) throw new Error(out.error || ('HTTP ' + res.status));
    hideCard();
    await store.load();                // the overrides are in the app document; load() repaints
    var back = undo ? undoOf(before) : null;
    say(message || out.summary, back ? { label: 'Vrátit', run: back } : null);
    return out;
  } catch (err) {
    say('Nepovedlo se: ' + err.message);
    return null;
  }
}

/** The week's dates that are still live — where a block can move to. */
function liveWeek(date) {
  var out = [];
  for (var i = 0; i < 7; i++) {
    var d = addDays(mondayOf(date), i);
    if (!payload || d >= payload.today) out.push(d);
  }
  return out;
}

function timeInput(mins) {
  return el('input.input.input--when', { type: 'time', step: '900', value: fmtMin(Math.min(mins, 1439)) });
}

function minutesIn(input) {
  var p = String(input.value || '').split(':').map(Number);
  return p.length === 2 && !isNaN(p[0]) ? p[0] * 60 + p[1] : NaN;
}

/** A tapped routine block: what can change about it on this one date. */
function openBlock(day, r, topPx, col) {
  var key = blockKey(day, r);
  if (key === openKey) { hideCard(); return; }        // a second tap closes it
  var cat = CATS[r.cat];
  var ds = dateShort(day.date);
  var gone = !!GONE[r.state];
  var label = r.note || cat.label;
  var mode = day.kind !== 'live' ? 'past' : gone ? 'cancelled' : r.src === 'added' ? 'added' : 'base';
  var tag = day.kind === 'cemented' ? 'zapsáno' : mode === 'cancelled' ? 'zrušeno ' + ds :
    mode === 'added' ? 'jen ' + ds : 'výchozí týden';
  var from = r.state === 'moved_in' ? twinWord(r, true) : '';
  var to = r.state === 'moved_out' ? twinWord(r, false) : '';
  var sub = [to ? 'přesunuto na ' + to : r.reason, from ? 'přesunuto z ' + from : '', whereOf(r)].filter(Boolean).join(' · ');

  var body = el('div.eventedit__body');
  var close = function () { return button('.push', 'Zavřít', hideCard); };
  var back = function () { return button('.push', 'Zpět', base); };

  function base() {
    var acts = [];
    if (mode === 'base') {
      acts = [button('', 'Zrušit jen tento den', cancelStep), button('', 'Přesunout…', moveStep), close()];
    } else if (mode === 'cancelled') {
      acts.push(button('.btn--outlineaccent', 'Vrátit', function () {
        alterRoutine({ op: 'remove', id: r.override_id }, 'Vráceno podle výchozího týdne.');
      }));
      if (r.group_kind === 'range' && r.group_id) {
        var days = {};
        (store.data.routine.overrides || []).forEach(function (o) { if (o.group_id === r.group_id) days[o.date] = true; });
        var count = Object.keys(days).length;
        if (count > 1) {
          acts.push(button('', 'Vrátit všechny dny (' + count + ')', function () {
            alterRoutine({ op: 'reset', group_id: r.group_id }, 'Rutina vrácena ve všech ' + count + ' dnech.');
          }));
        }
      }
      acts.push(close());
    } else if (mode === 'added') {
      if (r.overlap === 'pending') {
        acts.push(button('', 'Nechat obojí', function () { alterRoutine({ op: 'keep_overlap', id: r.override_id }, 'Necháno obojí.'); }));
        acts.push(button('.btn--outlineaccent', 'Zeptat se Kacey', function () { askKacey(overlapQuestion(day, r)); }));
      }
      acts.push(button('.btn--dangertext', 'Odebrat', function () {
        alterRoutine({ op: 'remove', id: r.override_id }, label + ' odebráno' + (r.state === 'moved_in' ? ' — původní blok je zpátky.' : '.'));
      }));
      acts.push(close());
    } else if (day.kind === 'cemented') {
      acts = [button('.btn--outlineaccent', 'Zeptat se Kacey', function () { askKacey(historyQuestion(day, r)); }), close()];
    } else {
      acts = [close()];
    }

    var over = null;
    if (mode === 'added' && r.overlap === 'pending') {
      var under = day.blocks.filter(function (x) { return x.src === 'template' && isActive(x) && x.s < r.e && r.s < x.e; })[0];
      if (under) {
        over = el('div.eventedit__warn', [el('span.rmark.rmark--warn', { 'aria-hidden': 'true' }, '!'),
          el('p', 'Padne přes ' + (under.note || CATS[under.cat].label) + ' ' + fmtMin(under.s) + '–' + fmtMin(under.e) +
            '. Oba bloky zůstávají vedle sebe, dokud nerozhodneš — nebo se zeptej Kacey.')]);
      }
    }
    var past = mode !== 'past' ? null : el('p.eventedit__text', day.kind === 'cemented'
      ? 'Den je zapsaný v historii. Změnit ho může jen Kacey — z konverzace.'
      : 'Tento den proběhl dřív, než se rutina začala zapisovat do historie.');
    fill(body, [over, past, el('div.row', acts)]);
  }

  function cancelStep() {
    var why = el('input.input', { type: 'text', maxlength: '120', placeholder: 'nemoc, výlet…' });
    var apply = function () {
      alterRoutine({ op: 'cancel', date: day.date, from: fmtMin(r.s), to: fmtMin(r.e), category: r.cat, reason: why.value.trim() || undefined },
        label + ' zrušeno jen pro ' + ds, true);
    };
    why.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') apply(); });
    fill(body, [field('PROČ · NEPOVINNÉ', why), el('div.row', [button('.btn--accent', 'Zrušit ' + ds, apply), back()])]);
    why.focus();
  }

  function moveStep() {
    var week = liveWeek(day.date);
    var pick = week.filter(function (d) { return d !== day.date; })[0] || day.date;
    var target = el('select.select', week.map(function (d) {
      return el('option', { value: d, selected: d === pick }, dayWord(d));
    }));
    var s = timeInput(r.s), e = timeInput(r.e);
    // Moving the start keeps the length, like dragging the block would.
    s.addEventListener('change', function () {
      var m = minutesIn(s);
      if (!isNaN(m)) e.value = fmtMin(Math.min(1439, m + (r.e - r.s)));
    });
    fill(body, [
      el('div.eventedit__grid', [field('DEN', target), field('OD', s), field('DO', e)]),
      el('div.row', [button('.btn--accent', 'Přesunout', function () {
        if (!(minutesIn(e) > minutesIn(s))) { say('Konec musí být po začátku.'); return; }
        var p = target.value.split('-').map(Number);
        alterRoutine({ op: 'move', date: day.date, from: fmtMin(r.s), to: fmtMin(r.e), category: r.cat,
                       to_date: target.value, new_from: s.value, new_to: e.value },
          label + ' přesunuto na ' + DOW_SHORT[dowOf(target.value)] + ' ' + p[2] + '. ' + s.value, true);
      }), back()])
    ]);
    target.focus();
  }

  base();
  showCard([
    el('p.label.eventedit__head', [el('span.rswatch' + (gone ? '.rswatch--hollow' : ''), { 'aria-hidden': 'true', style: '--cat:' + cat.color }),
      (cat.label + ' · ' + fmtMin(r.s) + '–' + fmtMin(r.e) + ' · ' + tag).toUpperCase()]),
    el('p.eventedit__name' + (gone ? '.is-gone' : ''), label),
    sub ? el('p.eventedit__sub', sub) : null,
    body,
    el('p.eventedit__foot', mode === 'past' ? 'Výchozí týden upravíš v Plánovači rutiny.' : 'Platí jen pro ' + ds + ' Výchozí týden se nemění.')
  ], topPx, col, '.eventedit--routine');
  markOpen(key);
}

/** Category chips — one pressed (+ Blok) or several (Nemoc / volno). */
function catChips(host, isOn, onPick) {
  fill(host, CATEGORY_KEYS.map(function (k) {
    return el('button.catpick__opt', {
      type: 'button', 'aria-pressed': String(isOn(k)), style: '--cat:' + CATS[k].color,
      onclick: function () { onPick(k); }
    }, [el('span.catpick__sw', { 'aria-hidden': 'true' }), CATS[k].label]);
  }));
}

/** Where minute `m` sits in the single-day lane, for placing the add card. */
function laneTopOf(m) {
  var b = laneBounds([selected]);
  return b.top(Math.max(b.start, Math.min(m, b.end)));
}

/** "+ Blok": something on this one date only — the default week stays. */
function openAdd(date) {
  var pick = 'free';
  var ds = dateShort(date);
  var cats = el('div.catpick.catpick--chips', { role: 'group', 'aria-label': 'Kategorie' });
  var now = new Date();
  var start = date === (payload && payload.today) ? Math.min(22 * 60, (now.getHours() + 1) * 60) : 15 * 60;
  var from = timeInput(start), to = timeInput(start + 60);
  var note = el('input.input', { type: 'text', maxlength: '80' });
  var hint = el('p.eventedit__hint', { hidden: true });
  var day = routineDay(date);

  function paint() {
    catChips(cats, function (k) { return k === pick; }, function (k) { pick = k; paint(); });
    note.placeholder = CATS[pick].label;
    var s = minutesIn(from), e = minutesIn(to);
    var hit = day.blocks.filter(function (x) { return x.src === 'template' && isActive(x) && x.s < e && s < x.e; })[0];
    hint.hidden = !hit;
    if (hit) {
      fill(hint, [el('span.rmark.rmark--warn', { 'aria-hidden': 'true' }, '!'),
        el('span', 'Padne přes ' + (hit.note || CATS[hit.cat].label) + ' ' + fmtMin(hit.s) + '–' + fmtMin(hit.e) +
          '. Oba bloky zůstanou vedle sebe a Kacey se zeptá, co s tím.')]);
    }
  }
  from.addEventListener('input', paint);
  to.addEventListener('input', paint);
  paint();

  showCard([
    el('p.label.eventedit__head', 'NOVÝ BLOK · JEN ' + ds),
    cats,
    el('div.eventedit__grid.eventedit__grid--name', [field('NÁZEV', note), field('OD', from), field('DO', to)]),
    hint,
    el('div.row', [
      button('.btn--accent', 'Přidat jen na ' + ds, function () {
        if (!(minutesIn(to) > minutesIn(from))) { say('Konec musí být po začátku.'); return; }
        alterRoutine({ op: 'add', date: date, from: from.value, to: to.value, category: pick, note: note.value.trim() || undefined },
          (note.value.trim() || CATS[pick].label) + ' přidáno jen na ' + ds, true);
      }),
      button('.push', 'Zavřít', hideCard)
    ])
  ], laneTopOf(start), undefined, '.eventedit--add');
  note.focus();
}

function changeCount(n) { return n + (n === 1 ? ' změna' : n < 5 ? ' změny' : ' změn'); }

/** The bar over the lane: what the shown days' routine is, and what can be done. */
function renderRoutineBar() {
  if (!$('routineBar') || !payload || !selected) return;
  var days = rangeDays().map(routineDay);
  var stale = days.reduce(function (a, d) { return a + (d.stale || []).length; }, 0);
  var text, tone = 'def';
  if (span === 1) {
    var d = days[0];
    var changes = d.blocks.filter(function (x) { return x.state !== 'template'; }).length;
    if (d.kind === 'cemented') {
      text = 'Zapsáno v historii' + (changes ? ' · ' + changeCount(changes) : '') + (d.amended_at ? ' · opraveno přes Kacey' : '');
      tone = 'past';
    } else if (d.kind === 'unrecorded') { text = 'Výchozí rutina · den před začátkem historie'; tone = 'past'; }
    else if (d.altered) { text = 'Upraveno jen pro tento den · ' + changeCount(changes); tone = 'acc'; }
    else text = 'Výchozí rutina';
  } else {
    var n = days.filter(function (x) { return x.altered; }).length;
    text = n ? n + (n === 1 ? ' upravený den' : n < 5 ? ' upravené dny' : ' upravených dní') + ' v rozsahu' : 'Výchozí rutina ve všech dnech';
    if (n) tone = 'acc';
  }
  if (stale) { text += ' · ' + stale + ' neplatné (výchozí týden se mezitím změnil) — Obnovit výchozí je smaže'; tone = 'stale'; }
  $('routineState').textContent = text;
  $('routineState').className = 'routinebar__state' + (tone === 'acc' ? ' is-altered' : tone === 'stale' ? ' is-stale' : '');
  $('routineDot').className = 'routinebar__dot routinebar__dot--' + tone;
  var live = span === 1 && days[0].kind === 'live';
  $('routineAdd').hidden = !live;
  $('routineReset').hidden = !(live && days[0].altered);
}

/* ---- sick days: the routine cancelled over a range of dates ---------------- */

var sickCats = [];

/** The chosen dates; 'order' when the end is before the start; null when empty. */
function sickRange() {
  var a = $('sickFrom').value, b = $('sickTo').value || a;
  if (!a) return null;
  if (b < a) return 'order';
  var out = [];
  for (var d = a; d <= b && out.length < 62; d = addDays(d, 1)) out.push(d);
  return out;
}

function renderSick() {
  catChips($('sickCats'), function (k) { return sickCats.indexOf(k) !== -1; }, function (k) {
    sickCats = sickCats.indexOf(k) !== -1 ? sickCats.filter(function (x) { return x !== k; }) : sickCats.concat([k]);
    renderSick();
  });

  var dates = sickRange();
  var today = payload ? payload.today : '';
  var text = '', ok = false;
  if (!dates) text = 'Vyber dny.';
  else if (dates === 'order') text = 'Konec je před začátkem.';
  else if (dates[0] < today) text = 'Minulé dny jsou zapsané v historii — změní je jen Kacey. Začni nejdřív ' + dateShort(today);
  else {
    var n = 0;
    dates.forEach(function (d) {
      // The default week's blocks; something added for one day stays until removed.
      n += activeBlocks(effectiveDay(store.data.routine, d)).filter(function (x) {
        return x.src === 'template' && (!sickCats.length || sickCats.indexOf(x.cat) !== -1);
      }).length;
    });
    var what = sickCats.length ? sickCats.map(function (k) { return CATS[k].label.toLowerCase(); }).join(', ') : 'všechno';
    text = dates.length + (dates.length === 1 ? ' den' : dates.length < 5 ? ' dny' : ' dní') + ' · zruší se ' + n +
      (n === 1 ? ' blok' : n > 1 && n < 5 ? ' bloky' : ' bloků') + ' (' + what + '). Události kalendáře zůstanou.';
    ok = n > 0;
  }
  $('sickPreview').textContent = text;
  $('sickPreview').classList.toggle('is-warn', !ok);
  $('sickApply').disabled = !ok;
}

function openSick(open) {
  var sheet = $('sickPanel');
  if (!open) { sheet.hidden = true; return; }
  hideCard();
  var today = payload ? payload.today : selected;
  var from = selected && selected >= today ? selected : today;
  $('sickFrom').value = from;
  $('sickFrom').min = today;
  $('sickTo').value = addDays(from, Math.max(0, span - 1));
  $('sickTo').min = today;
  $('sickReason').value = 'nemoc';
  sickCats = [];
  renderSick();
  sheet.hidden = false;
  $('sickFrom').focus();
}

async function applySick() {
  var dates = sickRange();
  if (!dates || dates === 'order') return;
  var why = $('sickReason').value.trim() || 'volno';
  var n = dates.length;
  var out = await alterRoutine({
    op: 'cancel_range', from_date: dates[0], to_date: dates[n - 1],
    categories: sickCats.length ? sickCats : undefined, reason: why
  }, 'Rutina zrušena na ' + n + (n === 1 ? ' den' : n < 5 ? ' dny' : ' dní') + ' · ' + why, true);
  if (out) openSick(false);
}

/* ---- the day timeline (Claude Design DayTimeline) ----------------------------
   The day as one compact lane: the routine strip on the left, events and timed
   tasks beside it, tasks without a time as chips on top, and the now line. It
   reads the same data as the calendar lane. Two places draw it:
     main's Dnes card     06:00–23:00, 46px an hour, strip 70, 13px
     the morning screen   06:00–22:00, 44px an hour, strip 132, 15px
                          (phone: 38px, strip 92, 13px), rules named
   opts: { start, end, pxh, strip, gutter, fs, metaEl, metaFirst,
           follow (keep "now" nowOffset px from the top every repaint, else
           jump there once a day), nowOffset, ruleName(task) → 'Domácnost' } */

var MAIN_TL = { start: 360, end: 1380, pxh: 46, strip: 70, gutter: 46, fs: 13, nowOffset: 40 };

function plural(n, one, few, many) { return n + ' ' + (n === 1 ? one : n > 1 && n < 5 ? few : many); }

export function renderDayTimeline(host, o) {
  if (!host) return;
  if (!payload) { fill(host, el('p.empty', 'Načítám kalendář…')); return; }
  var top = function (m) { return Math.round((Math.max(o.start, Math.min(m, o.end)) - o.start) * o.pxh / 60); };
  host.style.setProperty('--tl-strip', o.strip + 'px');
  host.style.setProperty('--tl-gutter', o.gutter + 'px');
  host.style.setProperty('--tl-fs', o.fs + 'px');

  var today = payload.today;
  var nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  var events = eventsOn(today);
  var timedTasks = timedTasksOn(today);
  var ruled = function (t) { return t.origin === 'rule' && o.ruleName; };
  // Tasks with no time today, and anything overdue that is still open.
  var chips = dayTasksOn(today).map(function (x) {
    return { t: x.t, meta: ruled(x.t) ? 'pravidlo' + (o.ruleName(x.t) ? ' ' + o.ruleName(x.t) : '') : 'dnes' };
  }).concat(tasks().filter(function (t) { return !t.done && bucketOf(t) === 'overdue'; })
    .map(function (t) { return { t: t, meta: 'po termínu' }; }));

  if (o.metaEl) {
    var nTasks = timedTasks.length + chips.length;
    var parts = [plural(events.length, 'událost', 'události', 'událostí'), plural(nTasks, 'úkol', 'úkoly', 'úkolů')];
    o.metaEl.textContent = o.metaFirst ? ['rutina'].concat(parts).join(' · ') : '· ' + parts.concat(['rutina']).join(' · ');
  }

  var lane = [];
  for (var h = Math.ceil(o.start / 60); h < o.end / 60; h++) {
    lane.push(el('div.daytl__hour', { style: 'top:' + top(h * 60) + 'px' }, el('span', ('0' + h).slice(-2) + ':00')));
  }

  routineDay(today).blocks.forEach(function (r) {
    if (r.e <= o.start || r.s >= o.end) return;
    var cat = CATS[r.cat];
    if (!cat) return;
    var gone = !!GONE[r.state];
    var len = r.e - r.s;
    var name = (r.src === 'added' ? '+ ' : '') + (r.note || cat.label);
    var px = top(r.e) - top(r.s);
    lane.push(el('div.daytl__rblock' + (gone ? '.is-cancelled' : '') + (len >= 45 ? '' : '.is-short'), {
      title: [name, fmtMin(r.s) + '–' + fmtMin(r.e), KINDS[r.kind] ? KINDS[r.kind].label : '', whereOf(r),
              gone ? 'zrušeno jen pro tento den' : r.src === 'added' ? 'přidáno jen pro tento den' : ''].filter(Boolean).join(' · '),
      style: 'top:' + top(r.s) + 'px;height:' + Math.max(px, 14) + 'px;' + rpaint(r, gone ? 4 : 6, cat.color, false, tagH(px))
    }, [
      el('b', { style: 'color:' + (gone ? 'var(--ink3)' : cat.color) }, name),
      el('em', gone ? 'zrušeno' : fmtMin(r.s) + '–' + fmtMin(r.e)),
      !gone && r.room && len >= 75 ? el('em.daytl__where', r.room) : null
    ]));
  });

  events.filter(function (e) { return !e.all_day; }).forEach(function (e) {
    var s = minutesOf(e.starts_at);
    var en = e.ends_at ? minutesOf(e.ends_at) : s + 30;
    if (en <= s) en = s + 30;
    if (en <= o.start || s >= o.end) return;
    var hgt = Math.max(top(en) - top(s), o.fs * 2 + 6);
    var tall = hgt >= o.fs * 3 + 10;
    var running = nowMin >= s && nowMin < en;
    lane.push(el('button.daytl__event' + (tall ? '' : '.is-short') + (running ? '.is-now' : '') + (unsure(e) ? '.is-tentative' : ''), {
      type: 'button', title: clockOf(e.starts_at) + ' ' + (e.title || '(bez názvu)') + ' · ' + sourceOf(e),
      style: 'top:' + top(s) + 'px;height:' + hgt + 'px;' + edge(4, e),
      onclick: function () { selected = today; span = 1; go('calendar'); }
    }, [
      el('b', [unsureMark(e), e.title || '(bez názvu)']),
      tall ? el('em', clockOf(e.starts_at) + ' · ' + unsureWord(e) + (running ? 'zbývá ' + (en - nowMin) + ' min · ' : '') + sourceOf(e)) : null
    ]));
  });

  timedTasks.forEach(function (x) {
    var t = x.t, s = x.p.minutes;
    if (s >= o.end) return;
    var late = bucketOf(t) === 'overdue';
    var hgt = Math.max(top(s + (t.duration || 30)) - top(s), o.fs * 2 + 2);
    lane.push(el('div.daytl__taskwrap', { style: 'top:' + top(s) + 'px' }, [
      el('button.daytl__task' + (t.done ? '.is-done' : '') + (late ? '.is-late' : '') + (t.note ? '.is-warn' : ''), {
        type: 'button', 'aria-pressed': String(!!t.done),
        title: t.label + ' · ' + x.p.time + (t.note ? ' · ' + t.note : '') + ' · ' + (t.done ? 'klepnutím vrátíš' : 'klepnutím odškrtneš'),
        style: 'height:' + hgt + 'px',
        onclick: function () { tickTask(t); }
      }, [el('span.eblock__check', { 'aria-hidden': 'true' }, t.done ? '✓' : ''), el('b', t.label),
          el('em', (ruled(t) ? 'pravidlo · ' : '') + x.p.time)]),
      // A rule's caveat (the night saw an overlap) under the task.
      ruled(t) && t.note ? el('p.daytl__warn', t.note) : null
    ]));
  });

  var showNow = nowMin >= o.start && nowMin <= o.end;
  if (showNow) lane.push(el('span.daytl__now', { style: 'top:' + top(nowMin) + 'px' }, el('span', fmtMin(nowMin))));

  var scroller = el('div.daytl__scroll', el('div.daytl__lane', { style: 'height:' + top(o.end) + 'px' }, lane));
  scroller.addEventListener('scroll', function () { if (scroller.offsetHeight) host._tlPos = scroller.scrollTop; });
  fill(host, [
    chips.length ? el('div.daytl__chips', chips.map(function (c) {
      return el('button.daytl__chip' + (c.t.done ? '.is-done' : ''), {
        type: 'button', 'aria-pressed': String(!!c.t.done), title: 'úkol · klepnutím odškrtneš',
        onclick: function () { tickTask(c.t); }
      }, [el('span.eblock__check', { 'aria-hidden': 'true' }, c.t.done ? '✓' : ''), el('b', c.t.label), el('em', c.meta)]);
    })) : null,
    scroller
  ]);
  // "now" a little below the top: on every repaint when following (the
  // morning), else once a day and then wherever it was scrolled to (main).
  var nowTop = Math.max(0, (showNow ? top(nowMin) : 0) - o.nowOffset);
  if (!host.offsetHeight) return;
  if (o.follow || host._tlDay !== today) {
    scroller.scrollTop = host._tlPos = nowTop;
    host._tlDay = today;
  } else {
    scroller.scrollTop = host._tlPos || 0;
  }
}

function renderTodayTimeline() {
  renderDayTimeline($('todayTimeline'), Object.assign({ metaEl: $('todayMeta') }, MAIN_TL));
}

/* ---- the "Today" panel on the main view --------------------------------- */

export function renderTodayAgenda() {
  renderTodayTimeline();
  var host = $('todayAgenda');
  if (!host) return;
  if (!payload) { fill(host, el('p.empty', 'Načítám kalendář…')); return; }

  var today = payload.today;
  var events = eventsOn(today);
  if (!events.length) {
    fill(host, el('p.empty', today.slice(0, 7) === month
      ? 'Dnes nic v kalendáři.'
      : 'Dnešek je v jiném měsíci — klepni na „dnes“ v kalendáři.'));
    return;
  }

  var nowMin = new Date().getHours() * 60 + new Date().getMinutes();

  fill(host, events.map(function (e) {
    var s = minutesOf(e.starts_at), en = e.ends_at ? minutesOf(e.ends_at) : s + 30;
    var running = !e.all_day && nowMin >= s && nowMin < en;
    var past = !e.all_day && nowMin >= en;
    return el('button.rowbtn' + (running ? '.is-now' : '') + (past ? '.is-past' : '') + (unsure(e) ? '.is-tentative' : ''), {
      type: 'button',
      onclick: function () { selected = today; go('calendar'); }
    }, [
      el('span.rowbtn__time', e.all_day ? 'celý den' : clockOf(e.starts_at)),
      el('span.rowbtn__title', [unsureMark(e), e.title || '(bez názvu)']),
      el('span.rowbtn__meta', unsureWord(e) + (running
        ? (en - nowMin) + ' min zbývá · ' + sourceOf(e)
        : sourceOf(e) + (e.all_day ? '' : ' · ' + clockOf(e.starts_at) + '–' + clockOf(e.ends_at))))
    ]);
  }));
}

/** The next thing in the day, for the main view's rail and the brief. */
export function nextUp() {
  if (!payload) return null;
  var nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  var upcoming = eventsOn(payload.today)
    .filter(function (e) { return !e.all_day && minutesOf(e.starts_at) >= nowMin; })
    .map(function (e) {
      return { at: minutesOf(e.starts_at), title: (unsure(e) ? '? ' : '') + (e.title || '(bez názvu)'), meta: clockOf(e.starts_at) + ' · ' + unsureWord(e) + sourceOf(e), event: e };
    })
    // A task with a time is as much "next" as a meeting is.
    .concat(timedTasksOn(payload.today)
      .filter(function (x) { return !x.t.done && x.p.minutes >= nowMin; })
      .map(function (x) { return { at: x.p.minutes, title: x.t.label, meta: x.p.time + ' · úkol', task: x.t }; }))
    .sort(function (a, b) { return a.at - b.at; });
  return upcoming[0] || null;
}

/** Today's timed events, for the morning's "další: zubař v 10:30": [{ start (min), title }]. */
export function todayEvents() {
  if (!payload) return [];
  return eventsOn(payload.today).filter(function (e) { return !e.all_day; })
    .map(function (e) { return { start: minutesOf(e.starts_at), title: e.title || '(bez názvu)' }; });
}

/** Counts the brief's tiles need. */
export function todaySummary() {
  if (!payload) return { count: 0, first: null };
  var events = eventsOn(payload.today).filter(function (e) { return !e.all_day; })
    .sort(function (a, b) { return minutesOf(a.starts_at) - minutesOf(b.starts_at); });
  return { count: eventsOn(payload.today).length, first: events[0] ? clockOf(events[0].starts_at) : null };
}

/** Move the range; follow it to another month when it starts in one. */
function moveTo(start, n) {
  hideCard();
  selected = start; span = n;
  if (start.slice(0, 7) !== month) showMonth(start.slice(0, 7));
  else render();
}

function render() {
  renderSpans();
  renderMonth();
  renderWeek();
  renderSources();
  renderLane();
  renderTodayAgenda();
}

/* ---- wiring ------------------------------------------------------------- */

export function initCalendar(opts) {
  if (opts && typeof opts.ask === 'function') sendToKacey = opts.ask;
  $('calPrev').addEventListener('click', function () { showMonth(shiftMonth(month, -1)); });
  $('calNext').addEventListener('click', function () { showMonth(shiftMonth(month, 1)); });
  $('calToday').addEventListener('click', function () {
    selected = null;
    showMonth(payload && payload.today ? payload.today.slice(0, 7) : null);
  });

  /* Po–Pá and Týden start on a Monday; Den and 3 dny start where you are.
     The arrows step by the range — Po–Pá by a whole week, to the next one. */
  $('calSpans').addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-span]');
    if (!btn) return;
    var n = Number(btn.getAttribute('data-span'));
    moveTo(n >= 5 ? mondayOf(selected) : selected, n);
  });
  $('rangePrev').addEventListener('click', function () { moveTo(addDays(selected, -(span === 5 ? 7 : span)), span); });
  $('rangeNext').addEventListener('click', function () { moveTo(addDays(selected, span === 5 ? 7 : span), span); });
  window.addEventListener('mouseup', function () { dragAnchor = null; });

  /* The phone's own header controls. With the month unfolded the arrows turn
     months; folded, they step the range — a week, or three days at 3 dny. */
  $('calMonthToggle').addEventListener('click', function () { setMonthOpen(!monthOpen()); });
  function step(dir) {
    if (monthOpen()) { showMonth(shiftMonth(month, dir)); return; }
    moveTo(addDays(selected, dir * (span === 3 ? 3 : 7)), span);
  }
  $('calStepPrev').addEventListener('click', function () { step(-1); });
  $('calStepNext').addEventListener('click', function () { step(1); });
  $('calTodayM').addEventListener('click', function () { $('calToday').click(); });
  $('calSourcesOpen').addEventListener('click', function () { openSheet($('calSourcesSheet')); });
  $('calReloadM').addEventListener('click', function () { refreshCalendar(); say('Kalendář načten znovu.'); });
  $('calReload').addEventListener('click', refreshCalendar);

  /* The routine on the shown date: add for the day, sick days, back to default. */
  $('routineAdd').addEventListener('click', function () { openAdd(selected); });
  $('routineReset').addEventListener('click', function () {
    alterRoutine({ op: 'reset', dates: [selected] }, 'Výchozí rutina obnovena pro ' + dateShort(selected));
  });
  $('routineSick').addEventListener('click', function () { openSick(true); });
  var sick = $('sickPanel');
  $('sickClose').addEventListener('click', function () { openSick(false); });
  $('sickCancel').addEventListener('click', function () { openSick(false); });
  $('sickApply').addEventListener('click', applySick);
  $('sickFrom').addEventListener('input', renderSick);
  $('sickTo').addEventListener('input', renderSick);
  sick.addEventListener('click', function (ev) { if (ev.target === sick) openSick(false); });
  // Capture phase, like the other sheets: Escape closes this, not the conversation.
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !sick.hidden) {
      openSick(false);
      ev.stopImmediatePropagation();
      ev.preventDefault();
    }
  }, true);

  onEnter('calendar', function () { if (!payload) refreshCalendar(); else render(); });
  store.onChange(function () { if (payload) render(); });
  onEnter('main', function () { if (payload) renderTodayTimeline(); });

  refreshCalendar();
  // The "now" line and the "x min left" labels go stale on their own.
  setInterval(function () { if (payload) { renderLane(); renderTodayAgenda(); } }, 60000);
}

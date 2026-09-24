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

   Titles come from the model and from external calendars, so every one of them
   reaches the DOM through textContent.
   ========================================================================= */

import { $ } from '../core/dom.js';
import { el, fill, hhmm as fmtMin } from '../core/el.js';
import * as store from '../core/store.js';
import { go, onEnter } from './router.js';
import { say } from './toast.js';
import { blocksFor, CATS, dayIndexOfDate } from '../views/routine.js';
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
      start = Math.min(start, Math.floor(minutesOf(e.starts_at) / 60) * 60);
      if (e.ends_at) end = Math.max(end, Math.ceil(minutesOf(e.ends_at) / 60) * 60);
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
  if (span > 1) renderMulti(); else renderDay();
  fill($('routineLegend'), Object.keys(CATS).map(function (k) {
    return el('span', [el('i', { style: 'background:' + CATS[k].color }), CATS[k].label]);
  }));
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

  // the week's routine, painted underneath
  var wIdx = dowOf(selected);
  var blocks = blocksFor(wIdx);
  blocks.forEach(function (r) {
    if (r.e <= start || r.s >= end) return;
    var cat = CATS[r.cat];
    if (!cat) return;
    var tall = (r.e - r.s) >= 45;
    nodes.push(el('div.rblock' + (tall ? '' : '.is-short'), {
      style: 'top:' + top(r.s) + 'px;height:' + Math.max(height(r.s, r.e), 18) + 'px;' +
             'background:' + cat.color + '1f;border-left:6px solid ' + cat.color
    }, [
      el('b', { style: 'color:' + cat.color }, r.note || cat.label),
      el('em', fmtMin(r.s) + '–' + fmtMin(r.e) + (r.note ? ' · ' + cat.label : ''))
    ]));
  });

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
    var colour = colourFor(sourceOf(e));

    nodes.push(el('button.eblock' + (tall ? '' : '.is-short') + (past ? '.is-past' : ''), {
      type: 'button',
      style: 'top:' + top(s) + 'px;height:' + h + 'px;border-left:4px solid ' + colour +
             (running ? ';border-color:var(--line2)' : ''),
      onclick: function () { openEvent(e, top(s)); }
    }, [
      el('p', clockOf(e.starts_at) + '  ' + (e.title || '(bez názvu)')),
      el('em', { style: running ? 'color:var(--acc)' : '' },
        sourceOf(e) + ' · ' + clockOf(e.starts_at) + '–' + clockOf(e.ends_at))
    ]));
  });

  var timedTasks = timedTasksOn(selected), dayTasks = dayTasksOn(selected);
  timedTasks.forEach(function (x) { nodes.push(taskBlock(x, b, false, false)); });

  if (isToday && nowMin >= start && nowMin <= end) {
    nodes.push(el('span.nowline', { style: 'top:' + top(nowMin) + 'px' }));
  }

  fill(host, nodes);

  fill($('dayAllDay'), allDay.map(function (e) {
    return el('button.allday', {
      type: 'button',
      style: 'border-left:4px solid ' + colourFor(sourceOf(e)),
      onclick: function () { openEvent(e, 0); }
    }, 'celý den · ' + (e.title || '(bez názvu)'));
  }).concat(dayTasks.map(function (x) { return dayTaskChip(x, 'allday'); })));

  var p = selected.split('-').map(Number);
  var nTasks = timedTasks.length + dayTasks.length;
  $('dayLabel').textContent = DOW_LONG[dowOf(selected)] + ' ' + p[2] + '. ' + MON[p[1] - 1];
  $('dayMeta').textContent = (events.length || nTasks)
    ? [events.length ? events.length + ' událostí' : '', nTasks ? nTasks + ' úkolů' : '']
        .filter(Boolean).join(' · ') + (isToday ? ' · teď ' + fmtMin(nowMin) : '')
    : 'žádné události';

  var covered = blocks.reduce(function (a, r) { return a + (r.e - r.s); }, 0);
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
        return el('button.colhead__allday', {
          type: 'button', title: e.title || '(bez názvu)',
          style: 'border-left-color:' + colourFor(sourceOf(e)),
          onclick: function () { openEvent(e, 0, ci); }
        }, e.title || '(bez názvu)');
      }),
      dayTasks.map(function (x) { return dayTaskChip(x, 'colhead__allday'); })
    ]));

    var nodes = [];
    blocksFor(wd).forEach(function (r) {
      if (r.e <= b.start || r.s >= b.end) return;
      var cat = CATS[r.cat];
      if (!cat) return;
      covered += r.e - r.s;
      nodes.push(el('div.rblock.rblock--col', {
        style: 'top:' + top(r.s) + 'px;height:' + Math.max(height(r.s, r.e), 6) + 'px;' +
               'background:' + cat.color + '1f;border-left:4px solid ' + cat.color
      }, (r.e - r.s) >= 45 && !narrow ? el('b', { style: 'color:' + cat.color }, r.note || cat.label) : null));
    });

    timed.forEach(function (e) {
      var s = minutesOf(e.starts_at);
      var en = e.ends_at ? minutesOf(e.ends_at) : s + 30;
      if (en <= s) en = s + 30;
      var h = Math.max(height(s, en), 22);
      var tall = h >= 44;
      var past = isToday ? nowMin >= en : date < today;
      var title = e.title || '(bez názvu)';
      nodes.push(el('button.eblock.eblock--col' + (tall ? '' : '.is-short') + (past ? '.is-past' : ''), {
        type: 'button',
        title: clockOf(e.starts_at) + ' ' + title + ' · ' + sourceOf(e),
        style: 'top:' + top(s) + 'px;height:' + h + 'px;border-left:3px solid ' + colourFor(sourceOf(e)) +
               (narrow ? ';left:6px' : ''),
        onclick: function () { openEvent(e, top(s), ci); }
      }, [
        el('p', (narrow ? '' : clockOf(e.starts_at) + ' ') + title),
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

  var input = el('input.input', { type: 'text', value: e.title || '' });

  /* Opens where the event is. In the column lane it sits over its own day,
     pulled left when that day is near the right edge. */
  var place = 'top:' + (topPx || 0) + 'px';
  if (span > 1) place += ';left:clamp(0px, calc(' + ((col || 0) / span * 100) + '%), calc(100% - 340px))';

  var box = el('div.card.card--pad.eventedit' + (span > 1 ? '.eventedit--col' : ''), {
    style: place
  }, [
    el('p.muted-3', clockOf(e.starts_at) + '–' + clockOf(e.ends_at) + ' · ' + sourceOf(e)),
    input,
    el('div.row', { style: 'margin-top:8px' }, [
      el('button.btn.btn--accent.btn--sm', {
        type: 'button',
        onclick: async function () { await writeEvent(e.event_id, 'update', { title: input.value }); }
      }, 'Uložit název'),
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
    say(action === 'delete' ? 'Událost smazána.' : 'Název uložen.');
    refreshCalendar();
  } catch (err) {
    say('Nepovedlo se: ' + err.message);
  }
}

/* ---- the "Today" panel on the main view --------------------------------- */

export function renderTodayAgenda() {
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
    return el('button.rowbtn' + (running ? '.is-now' : '') + (past ? '.is-past' : ''), {
      type: 'button',
      onclick: function () { selected = today; go('calendar'); }
    }, [
      el('span.rowbtn__time', e.all_day ? 'celý den' : clockOf(e.starts_at)),
      el('span.rowbtn__title', e.title || '(bez názvu)'),
      el('span.rowbtn__meta', running
        ? (en - nowMin) + ' min zbývá · ' + sourceOf(e)
        : sourceOf(e) + (e.all_day ? '' : ' · ' + clockOf(e.starts_at) + '–' + clockOf(e.ends_at)))
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
      return { at: minutesOf(e.starts_at), title: e.title || '(bez názvu)', meta: clockOf(e.starts_at) + ' · ' + sourceOf(e), event: e };
    })
    // A task with a time is as much "next" as a meeting is.
    .concat(timedTasksOn(payload.today)
      .filter(function (x) { return !x.t.done && x.p.minutes >= nowMin; })
      .map(function (x) { return { at: x.p.minutes, title: x.t.label, meta: x.p.time + ' · úkol', task: x.t }; }))
    .sort(function (a, b) { return a.at - b.at; });
  return upcoming[0] || null;
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

export function initCalendar() {
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
  $('calSync').addEventListener('click', function () { refreshCalendar(); say('Kalendář načten znovu.'); });

  onEnter('calendar', function () { if (!payload) refreshCalendar(); else render(); });
  store.onChange(function () { if (payload) render(); });

  refreshCalendar();
  // The "now" line and the "x min left" labels go stale on their own.
  setInterval(function () { if (payload) { renderLane(); renderTodayAgenda(); } }, 60000);
}

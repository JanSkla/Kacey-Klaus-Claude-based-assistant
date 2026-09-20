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
var selected = null;       // 'YYYY-MM-DD'
var payload = null;
var loading = false;
var pendingDelete = null;  // event_id awaiting its second tap

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
  var i = sourceOrder.indexOf(source);
  if (i === -1) { sourceOrder.push(source); i = sourceOrder.length - 1; }
  return SOURCE_COLOURS[i % SOURCE_COLOURS.length];
}

function sourceEnabled(source) {
  var on = store.data.settings.calOn || {};
  return on[source] !== false;      // unknown sources default to visible
}

function dayRecord(date) {
  if (!payload) return null;
  for (var i = 0; i < payload.days.length; i++) {
    if (payload.days[i].date === date) return payload.days[i];
  }
  return null;
}

function eventsOn(date) {
  var rec = dayRecord(date);
  if (!rec) return [];
  return rec.events.filter(function (e) { return sourceEnabled(sourceOf(e)); });
}

/* ---- loading ------------------------------------------------------------ */

export async function refreshCalendar() {
  if (loading) return;
  loading = true;
  try {
    var url = '/api/calendar' + (month ? '?month=' + encodeURIComponent(month) : '');
    var res = await fetch(url);
    var body = await res.json();
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    payload = body;
    month = body.month;
    if (!selected || selected.slice(0, 7) !== month) {
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

  payload.days.forEach(function (d) {
    var n = Number(d.date.slice(8));
    var has = d.events.some(function (e) { return sourceEnabled(sourceOf(e)); });
    var cls = '.day';
    if (has) cls += '.has-events';
    if (d.date === payload.today) cls += '.is-today';
    else if (d.date < payload.today) cls += '.is-past';
    if (d.date === selected && d.date !== payload.today) cls += '.is-selected';
    nodes.push(el('button' + cls, {
      type: 'button', onclick: function () { selected = d.date; render(); }
    }, String(n)));
  });

  fill(host, nodes);

  $('calMonth').textContent = MON_NOM[Number(month.slice(5)) - 1] + ' ' + month.slice(0, 4);
  $('calMeta').textContent = payload.monthEvents + ' událostí v měsíci · ' + payload.total + ' celkem';

  /* Months that hold anything, so an empty stretch does not have to be clicked
     through one month at a time. */
  var jump = $('calJump');
  var others = (payload.monthsWithEvents || []).filter(function (m) { return m.month !== month; }).slice(-8);
  jump.hidden = others.length === 0;
  fill(jump, others.map(function (m) {
    return el('button.chip', {
      type: 'button',
      onclick: function () { month = m.month; refreshCalendar(); }
    }, m.month + ' (' + m.count + ')');
  }));
}

function renderSources() {
  var host = $('calSources');
  if (!host || !payload) return;

  var counts = {};
  payload.days.forEach(function (d) {
    d.events.forEach(function (e) { var s = sourceOf(e); counts[s] = (counts[s] || 0) + 1; });
  });
  var names = Object.keys(counts).sort();

  fill(host, names.length ? names.map(function (s) {
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
  }) : el('p.muted-3', 'Žádné zdroje v tomto měsíci.'));
}

/* ---- the day lane ------------------------------------------------------- */

function renderLane() {
  var host = $('dayLane');
  if (!host || !payload || !selected) return;

  var routine = store.data.routine;
  var wake = routine.wake, sleep = routine.sleep;
  var events = eventsOn(selected);

  /* The lane covers the waking day plus a margin — but never clips an event, so
     a 06:00 run on a 07:00 wake still has somewhere to sit. */
  var start = Math.max(0, wake - PAD), end = Math.min(1440, sleep + PAD);
  var timed = events.filter(function (e) { return !e.all_day; });
  var allDay = events.filter(function (e) { return e.all_day; });

  timed.forEach(function (e) {
    start = Math.min(start, Math.floor(minutesOf(e.starts_at) / 60) * 60);
    if (e.ends_at) end = Math.max(end, Math.ceil(minutesOf(e.ends_at) / 60) * 60);
  });
  start = Math.max(0, start); end = Math.min(1440, Math.max(end, start + 120));

  var top = function (m) { return Math.round((Math.max(m, start) - start) * PPM); };
  var height = function (a, b) { return Math.round((Math.min(b, end) - Math.max(a, start)) * PPM); };

  host.style.height = Math.round((end - start) * PPM) + 'px';

  var nodes = [];

  // sleep bands
  if (wake > start) {
    nodes.push(el('div.sleepband', { style: 'top:0;height:' + Math.round((wake - start) * PPM) + 'px;border-bottom:1px solid var(--line)' },
      el('span', 'spánek do ' + fmtMin(wake))));
  }
  if (sleep < end) {
    nodes.push(el('div.sleepband', { style: 'top:' + top(sleep) + 'px;height:' + Math.round((end - sleep) * PPM) + 'px;border-top:1px solid var(--line)' },
      el('span', 'spánek od ' + fmtMin(sleep))));
  }

  // hour rules
  for (var h = Math.ceil(start / 60); h < end / 60; h++) {
    nodes.push(el('div.tick' + (h % 2 ? '.tick--odd' : ''), { style: 'top:' + top(h * 60) + 'px' },
      el('span', ('0' + h).slice(-2) + ':00')));
  }

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
      onclick: function () { openEvent(e); }
    }, [
      el('p', clockOf(e.starts_at) + '  ' + (e.title || '(bez názvu)')),
      el('em', { style: running ? 'color:var(--acc)' : '' },
        sourceOf(e) + ' · ' + clockOf(e.starts_at) + '–' + clockOf(e.ends_at))
    ]));
  });

  if (isToday && nowMin >= start && nowMin <= end) {
    nodes.push(el('span.nowline', { style: 'top:' + top(nowMin) + 'px' }));
  }

  fill(host, nodes);

  fill($('dayAllDay'), allDay.map(function (e) {
    return el('button.allday', {
      type: 'button',
      style: 'border-left:4px solid ' + colourFor(sourceOf(e)),
      onclick: function () { openEvent(e); }
    }, 'celý den · ' + (e.title || '(bez názvu)'));
  }));

  var p = selected.split('-').map(Number);
  $('dayLabel').textContent = DOW_LONG[dowOf(selected)] + ' ' + p[2] + '. ' + MON[p[1] - 1];
  $('dayMeta').textContent = events.length
    ? events.length + ' událostí' + (isToday ? ' · teď ' + fmtMin(nowMin) : '')
    : 'žádné události';

  var covered = blocks.reduce(function (a, r) { return a + (r.e - r.s); }, 0);
  $('routineHours').textContent = 'Rutina pokrývá ' + (Math.round(covered / 6) / 10) +
    ' h z tohoto dne. Události kalendáře sedí nahoře.';

  fill($('routineLegend'), Object.keys(CATS).map(function (k) {
    return el('span', [el('i', { style: 'background:' + CATS[k].color }), CATS[k].label]);
  }));
}

/* ---- editing one event --------------------------------------------------
   Renaming and deleting only. Creating and moving stay in the conversation,
   where Kacey can check the routine and the other calendars first — which is
   the whole reason she has the tool. */

function openEvent(e) {
  var lane = $('dayLane');
  var existing = lane.querySelector('.eventedit');
  if (existing) existing.remove();

  var input = el('input.input', { type: 'text', value: e.title || '' });

  var box = el('div.card.card--pad.eventedit', {
    style: 'position:absolute;left:118px;right:10px;top:0;z-index:5'
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
      el('button.btn.btn--sm', { type: 'button', onclick: function () { box.remove(); } }, 'Zavřít')
    ])
  ]);

  lane.appendChild(box);
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
    .sort(function (a, b) { return minutesOf(a.starts_at) - minutesOf(b.starts_at); });
  var e = upcoming[0];
  if (!e) return null;
  return {
    title: e.title || '(bez názvu)',
    meta: clockOf(e.starts_at) + ' · ' + sourceOf(e),
    event: e
  };
}

/** Counts the brief's tiles need. */
export function todaySummary() {
  if (!payload) return { count: 0, first: null };
  var events = eventsOn(payload.today).filter(function (e) { return !e.all_day; })
    .sort(function (a, b) { return minutesOf(a.starts_at) - minutesOf(b.starts_at); });
  return { count: eventsOn(payload.today).length, first: events[0] ? clockOf(events[0].starts_at) : null };
}

function render() {
  renderMonth();
  renderSources();
  renderLane();
  renderTodayAgenda();
}

/* ---- wiring ------------------------------------------------------------- */

export function initCalendar() {
  $('calPrev').addEventListener('click', function () { month = shiftMonth(month, -1); refreshCalendar(); });
  $('calNext').addEventListener('click', function () { month = shiftMonth(month, 1); refreshCalendar(); });
  $('calToday').addEventListener('click', function () {
    month = null; selected = null; refreshCalendar();
  });
  $('calReload').addEventListener('click', refreshCalendar);
  $('calSync').addEventListener('click', function () { refreshCalendar(); say('Kalendář načten znovu.'); });

  onEnter('calendar', function () { if (!payload) refreshCalendar(); else render(); });
  store.onChange(function () { if (payload) render(); });

  refreshCalendar();
  // The "now" line and the "x min left" labels go stale on their own.
  setInterval(function () { if (payload) { renderLane(); renderTodayAgenda(); } }, 60000);
}

/* =========================================================================
   Tasks — the list, the full view, focus mode, and the checklist runner.

   All four read the same array in the store, so ticking something off in focus
   mode is immediately true in the main view's "today" panel.

   A task carries a due date, a due time, or neither (`due_at`, see
   core/due.js). The groups — po termínu, dnes, tento týden — are worked out
   from that and the clock every time the list is drawn, never stored, so a
   task due today is overdue tomorrow without anybody moving it. A task with a
   time is also drawn in the calendar's lane (ui/calendar.js).
   ========================================================================= */

import { $ } from '../core/dom.js';
import { el, fill } from '../core/el.js';
import * as store from '../core/store.js';
import { bucketOf, dueLabel, logicalToday, parseDue, vTime } from '../core/due.js';
import { go, onEnter } from '../ui/router.js';
import { say } from '../ui/toast.js';
import { editRule } from './rules.js';
import { night } from '../net/nightapi.js';
import { ruleOrigin } from '../core/rulewords.js';
import { openDay } from '../ui/calendar.js';
import { isPhone, openSheet, closeSheet } from '../ui/psheet.js';
import { submit, isOnline } from '../net/protocol.js';
import * as bus from '../core/bus.js';
import { orbState } from '../ui/orb.js';

/* `optional` groups only appear when something is in them. */
var GROUPS = [
  { key: 'overdue', name: 'Po termínu', emptyText: 'Nic po termínu. Dobře.' },
  { key: 'today', name: 'Dnes', emptyText: 'Na dnešek nic nezbývá.' },
  { key: 'week', name: 'Tento týden', emptyText: 'Tento týden už nic dalšího.' },
  { key: 'later', name: 'Později', optional: true },
  { key: 'none', name: 'Bez termínu', optional: true },
  { key: 'past', name: 'Hotové dřív', optional: true }
];

var DURATIONS = [15, 30, 60, 90, 120];

/** '15 min', '1 h', '1 h 30'. */
function durWord(m) {
  return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) : '');
}

var showDone = true;
var editingId = null;      // the task whose due date is open for editing
var lastBuckets = '';      // so the minute tick only redraws when a task changed group
var focusId = null, focusSecs = 0, focusTimer = 0;
var runId = null;
var whyOpen = {};          // task id -> the "?" under it is open

export function tasks() { return store.data.tasks || []; }

export function toggleTask(id) {
  store.patch('tasks', function (list) {
    return list.map(function (t) { return t.id === id ? Object.assign({}, t, { done: !t.done }) : t; });
  });
}

export function addTask(label, extra) {
  var text = String(label || '').trim();
  if (!text) return null;
  var task = Object.assign({
    id: 't' + Date.now(), label: text, meta: 'přidáno teď · osobní',
    done: false, due_at: null
  }, extra || {});
  store.patch('tasks', function (list) { return list.concat([task]); });
  // The line opens the new task's due date (Claude Design: toast "open").
  say('Úkol přidán · ' + text + (task.due_at ? ' · ' + dueLabel(task.due_at) : ''), null,
    function () { editingId = task.id; go('tasks'); renderTasks(); });
  return task;
}

function setDue(id, due, duration) {
  store.patch('tasks', function (list) {
    return list.map(function (t) {
      if (t.id !== id) return t;
      var next = Object.assign({}, t, { due_at: due });
      if (duration && (parseDue(due) || {}).time) next.duration = duration; else delete next.duration;
      return next;
    });
  });
}

/** A date input and a time input as a due_at. A time alone means today. */
function dueFrom(date, time) {
  if (!date && !time) return null;
  return (date || logicalToday()) + (time ? 'T' + time : '');
}

/** "dnes 15:00 · 30 min" — the due part of a row's second line. */
export function whenText(t) {
  if (!t.due_at) return '';
  return dueLabel(t.due_at) + (t.duration && parseDue(t.due_at).time ? ' · ' + t.duration + ' min' : '');
}

/** Tasks in the order they come due; undated ones keep the list's order. */
function byDue(a, b) {
  if (a.due_at === b.due_at) return 0;
  if (!a.due_at) return 1;
  if (!b.due_at) return -1;
  // A whole-day task sorts before the timed ones that day.
  return a.due_at < b.due_at ? -1 : 1;
}

/* ---- one row ----------------------------------------------------------- */

function taskRow(t, big) {
  var bucket = bucketOf(t);
  var box = el('button.check' + (big ? '.check--lg' : ''), {
    type: 'button', 'aria-pressed': String(!!t.done), 'aria-label': 'Přepnout úkol',
    onclick: function () { toggleTask(t.id); }
  }, t.done ? '✓' : '');

  /* The due date leads the second line. In the full view it is a button that
     opens the date editor; in the main view's panel it is just words. */
  var when = whenText(t);
  var dueNode = big
    ? el('button.task__due' + (when ? '' : '.is-empty'), {
        type: 'button', 'aria-expanded': String(editingId === t.id),
        onclick: function () { openWhen(t.id); }
      }, when || '+ termín')
    : (when ? el('span.task__due', when) : null);

  /* Made by the night routine (docs/DREAM.md §9): PRAVIDLO for a rule's task,
     KACEY for an accepted proposal, and "?" to say why it is here. On the
     label's row, at its right (Claude Design 5a); the label wraps rather than
     being squeezed. */
  var generated = t.origin === 'rule' || t.origin === 'dream';
  var origin = generated ? el('span.task__origin', [
    el('span.origin' + (t.origin === 'dream' ? '.origin--kacey' : ''), t.origin === 'dream' ? 'KACEY' : 'PRAVIDLO'),
    el('button.origin__why', {
      type: 'button', 'aria-label': 'Proč tento úkol', 'aria-expanded': String(!!whyOpen[t.id]),
      onclick: function () { whyOpen[t.id] = !whyOpen[t.id]; renderToday(); renderTasks(); }
    }, '?')
  ]) : null;

  var kids = [box, el('span.task__text', [
    el('span.task__label', t.label),
    (dueNode || t.meta) ? el('span.task__meta', [dueNode, dueNode && t.meta ? ' · ' : '', t.meta || '']) : null
  ]), origin];

  if (big && !t.done) {
    /* Two ways to start something: run its checklist, or sit with it on a
       clock. A task that already has a list leads with the list, because that
       is the thing the user built. */
    var hasList = checklistFor(t.id).length > 0;
    kids.push(el('button.btn.btn--sm' + (hasList ? '.btn--accent' : ''), {
      type: 'button', onclick: function () { openRunner(t.id); }
    }, hasList ? 'Spustit' : 'Seznam'));
    kids.push(el('button.btn.btn--sm', {
      type: 'button', onclick: function () { openFocus(t.id); }
    }, 'Focus'));
  }

  if (generated && whyOpen[t.id]) kids.push(whyPanel(t));
  if (big && editingId === t.id && !isPhone()) kids.push(dueEditor(t));

  return el('div.task' + (t.done ? '.is-done' : '') + (bucket === 'overdue' ? '.task--overdue' : ''), kids);
}

/** The rule and its set, from what the night state knows: { rule, set }. */
function ruleOf(id) {
  var sets = night.rulesets || [];
  for (var i = 0; i < sets.length; i++) {
    var r = sets[i].rules.filter(function (x) { return x.id === id; })[0];
    if (r) return { rule: r, set: sets[i] };
  }
  return null;
}

/* "ráno 07:12" (before noon), "v 14:05" after. */
function acceptedWord(iso) {
  var d = new Date(iso);
  var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  return d.getHours() < 12 ? 'ráno ' + hm : vTime(hm);
}

/* Why a generated task exists, under its row (Claude Design 5a):
   "Pravidlo Posilovna · Pohyb → ráno v den 07:00. {overlap caveat}" + Upravit pravidlo,
   "Návrh přijatý ráno 07:12 · {reason}" + Otevřít událost. */
function whyPanel(t) {
  if (t.origin === 'rule') {
    var found = t.rule_id ? ruleOf(t.rule_id) : null;
    return el('div.task__why', [
      el('span', (found ? ruleOrigin(found.rule, found.set.name) + '.' : 'Pravidlo · ' + (t.reason || 'bez popisu')) + (t.note ? ' ' + t.note : '')),
      t.rule_id ? el('button.link', { type: 'button', onclick: function () { editRule(t.rule_id); } }, 'Upravit pravidlo') : null
    ]);
  }
  var pr = t.proposal || {};
  var start = pr.about_start ? new Date(pr.about_start) : null;
  var day = start ? start.getFullYear() + '-' + ('0' + (start.getMonth() + 1)).slice(-2) + '-' + ('0' + start.getDate()).slice(-2) : null;
  return el('div.task__why', [
    el('span', (pr.decided_at ? 'Návrh přijatý ' + acceptedWord(pr.decided_at) : 'Návrh od Kacey') + ' · ' + (t.reason || 'bez popisu')),
    el('button.link', { type: 'button', onclick: function () { if (day) openDay(day, pr.about_event); else go('calendar'); } },
      day ? 'Otevřít událost' : 'Otevřít kalendář')
  ]);
}

/** A task's date: inline under its row on desktop, a bottom sheet on the phone (Kacey Phone 3e). */
export function openWhen(id) {
  var t = tasks().filter(function (x) { return x.id === id; })[0];
  if (!t) return;
  if (!isPhone()) { editingId = editingId === id ? null : id; go('tasks'); renderTasks(); return; }
  editingId = id;
  $('whenTitle').textContent = 'Termín · ' + t.label;
  fill($('whenBody'), dueEditor(t, true));
  openSheet($('whenSheet'), function () { editingId = null; });
}

function captioned(word, input) {
  return el('label.field', [el('span', word), input]);
}

/* Under the row it belongs to: a date, an optional time, and — once there is
   a time — how long it takes, which is how tall it is in the calendar. In the
   phone's sheet (`sheet`) the length is always there and × closes it. */
function dueEditor(t, sheet) {
  var p = parseDue(t.due_at) || {};
  var date = el('input.input.input--when', { type: 'date', value: p.date || '', 'aria-label': 'Datum' });
  var time = el('input.input.input--when', { type: 'time', value: p.time || '', step: 300, 'aria-label': 'Čas' });
  // A length set elsewhere (Kacey, an older list) stays choosable.
  var lengths = DURATIONS.indexOf(t.duration || 30) === -1 ? DURATIONS.concat([t.duration]).sort(function (a, b) { return a - b; }) : DURATIONS;
  var dur = el('select.select.input--when', { 'aria-label': 'Délka' }, lengths.map(function (m) {
    return el('option', { value: String(m), selected: (t.duration || 30) === m ? '' : null }, durWord(m));
  }));
  function syncDur() { dur.hidden = !sheet && !time.value; }
  time.addEventListener('input', syncDur);
  syncDur();

  function close() { editingId = null; renderTasks(); }
  if (sheet) {
    return el('form.whensheet', {
      onsubmit: function (ev) {
        ev.preventDefault();
        editingId = null;
        closeSheet();
        setDue(t.id, dueFrom(date.value, time.value), Number(dur.value));
      }
    }, [
      el('p.muted-3.whensheet__now', 'Teď: ' + (whenText(t) || 'bez termínu')),
      el('div.whensheet__grid', [captioned('DATUM', date), captioned('ČAS', time)]),
      captioned('DÉLKA · JEN S ČASEM', dur),
      el('button.btn.btn--accent.btn--block', { type: 'submit' }, 'Uložit'),
      t.due_at ? el('button.btn.btn--block', {
        type: 'button', onclick: function () { editingId = null; closeSheet(); setDue(t.id, null); }
      }, 'Bez termínu') : null,
      el('p.muted-3.whensheet__note', 'S časem se úkol ukáže v kalendáři.')
    ]);
  }
  var form = el('form.taskwhen', {
    onsubmit: function (ev) {
      ev.preventDefault();
      editingId = null;          // before the write: it redraws the list
      setDue(t.id, dueFrom(date.value, time.value), Number(dur.value));
    }
  }, [
    date, time, dur,
    el('div.taskwhen__acts', [
      el('button.btn.btn--sm.btn--accent', { type: 'submit' }, 'Uložit'),
      t.due_at ? el('button.btn.btn--sm', {
        type: 'button', onclick: function () { editingId = null; setDue(t.id, null); }
      }, 'Bez termínu') : null,
      el('button.btn.btn--sm', { type: 'button', onclick: close }, 'Zrušit')
    ]),
    el('p.muted-3.taskwhen__note', 'S časem se úkol ukáže v kalendáři. Esc zavře.')
  ]);
  form.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { ev.stopPropagation(); close(); }
  });
  return form;
}

/* ---- the compact list on the main view --------------------------------- */

/** What the main view's panel and the "done today" ratio count as today's. */
function isToday(t) {
  var b = bucketOf(t);
  return b === 'today' || b === 'overdue';
}

export function renderToday() {
  var host = $('todayTasks');
  if (!host) return;
  var list = tasks().filter(function (t) { return isToday(t) && (showDone || !t.done); }).sort(byDue);
  fill(host, list.length ? list.map(function (t) { return taskRow(t, false); })
                         : el('p.empty', 'Na dnešek nic. Přidej úkol níž, nebo řekni „KC, přidej …“.'));
}

/* ---- the full view ------------------------------------------------------ */

export function renderTasks() {
  var host = $('taskGroups');
  if (!host) return;

  var visible = tasks().filter(function (t) { return showDone || !t.done; });
  if (editingId && !visible.some(function (t) { return t.id === editingId; })) editingId = null;

  fill(host, GROUPS.map(function (g) {
    var items = visible.filter(function (t) { return bucketOf(t) === g.key; }).sort(byDue);
    if (g.optional && !items.length) return null;
    return el('div', [
      el('h3.subhead' + (g.key === 'overdue' ? '.subhead--err' : ''), g.name),
      items.length ? items.map(function (t) { return taskRow(t, true); })
                   : el('p.muted', g.emptyText)
    ]);
  }));

  var s = taskSummary();
  var counts = s.due + ' na dnes · ' + s.open + ' otevřených · ' + s.overdue + ' po termínu';
  $('taskCounts').textContent = counts;
  $('taskCountsM').textContent = counts;
  // The phone carries a second pair of these controls in its summary card.
  var toggles = document.querySelectorAll('#toggleDone, [data-task-act="toggleDone"]');
  for (var i = 0; i < toggles.length; i++) toggles[i].textContent = showDone ? 'Skrýt hotové' : 'Zobrazit hotové';

  var todayAll = tasks().filter(isToday);
  var todayDone = todayAll.filter(function (t) { return t.done; }).length;
  $('doneRatio').textContent = todayDone + ' / ' + todayAll.length;
  $('taskBar').style.width = (todayAll.length ? Math.round(todayDone / todayAll.length * 100) : 0) + '%';
}

/** Counts the brief and the main rail both need. */
export function taskSummary() {
  var all = tasks();
  return {
    due: all.filter(function (t) { return isToday(t) && !t.done; }).length,
    overdue: all.filter(function (t) { return bucketOf(t) === 'overdue'; }).length,
    open: all.filter(function (t) { return !t.done; }).length
  };
}

/** Undone tasks with a time on `date` ('YYYY-MM-DD'), for "next up". */
export function timedTasksOn(date) {
  return tasks().filter(function (t) {
    var p = parseDue(t.due_at);
    return !t.done && p && p.time && p.date === date;
  });
}

/* ---- focus mode --------------------------------------------------------
   One task, one clock, nothing else on screen. The clock is elapsed rather
   than counting down: the point is to notice how long this is taking, not to
   race a deadline. */

function focusTask() {
  return tasks().filter(function (t) { return t.id === focusId; })[0] || null;
}

function paintFocus() {
  var t = focusTask();
  $('focusTitle').textContent = t ? t.label : '—';
  // "dnes 17:45 · seznam 7 položek": when it is due, then the rest.
  $('focusMeta').textContent = t ? [whenText(t), t.meta].filter(Boolean).join(' · ') : '';
  $('focusClock').textContent =
    ('0' + Math.floor(focusSecs / 60)).slice(-2) + ':' + ('0' + (focusSecs % 60)).slice(-2);
}

export function openFocus(id) {
  focusId = id; focusSecs = 0;
  go('focus');
}

function startFocusClock() {
  clearInterval(focusTimer);
  focusTimer = setInterval(function () { focusSecs++; paintFocus(); }, 1000);
  paintFocus();
}

function stopFocusClock() { clearInterval(focusTimer); focusTimer = 0; }

/* ---- the checklist runner ----------------------------------------------
   A task can carry a checklist; running it is a full-screen list with targets
   big enough to hit without looking, because this is the one screen used while
   doing something else. */

export function checklistFor(id) {
  var list = store.data.checklists[id];
  return Array.isArray(list) ? list : [];
}

export function openRunner(id) {
  runId = id;
  go('task');
}

function setChecklist(id, items) {
  store.patch('checklists', function (all) {
    var next = Object.assign({}, all);
    next[id] = items;
    return next;
  });
}

function renderRunner() {
  var t = tasks().filter(function (x) { return x.id === runId; })[0];
  var items = checklistFor(runId);
  var done = items.filter(function (i) { return i.done; }).length;

  $('runTitle').textContent = t ? t.label : 'Úkol';
  $('runMeta').textContent = t ? (t.meta || '') : '';
  $('runCount').textContent = done + ' z ' + items.length + ' hotovo';
  $('runBar').style.width = (items.length ? Math.round(done / items.length * 100) : 0) + '%';

  $('runFinish').disabled = false;

  fill($('runList'), items.length ? items.map(function (item, i) {
    return el('button.runitem' + (item.done ? '.is-done' : ''), {
      type: 'button',
      onclick: function () {
        var next = items.map(function (x, n) { return n === i ? Object.assign({}, x, { done: !x.done }) : x; });
        setChecklist(runId, next);
      }
    }, [
      el('span.runitem__box', item.done ? '✓' : ''),
      el('span.runitem__label', item.label),
      item.note ? el('span.runitem__note', item.note) : null
    ]);
  }) : el('p.empty', 'Tenhle úkol zatím nemá seznam. Přidej položky níž, nebo řekni Kacey, co na něj patří.'));
}

function addChecklistItem(label) {
  var text = String(label || '').trim();
  if (!text || !runId) return false;
  setChecklist(runId, checklistFor(runId).concat([{ id: 'c' + Date.now(), label: text, note: '', done: false }]));
  return true;
}

/* ---- wiring ------------------------------------------------------------- */

/* ---- the phone's task dock (Kacey Phone 3c) ----------------------------- */

var awaitingReply = false;

function lastReply() {
  var rows = document.querySelectorAll('#log .msg--assistant .msg__bubble');
  for (var i = rows.length - 1; i >= 0; i--) { var s = rows[i].textContent.trim(); if (s) return s; }
  return '';
}

function initDock() {
  if (!$('taskAsk')) return;
  $('taskAsk').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var text = $('taskAskInput').value.trim();
    if (!text) return;
    $('taskAskInput').value = '';
    // Offline, the task is still written down — for today, as typed.
    if (!isOnline()) { addTask(text, { due_at: logicalToday() }); return; }
    submit(text);
    awaitingReply = true;
    $('taskReplyText').textContent = 'Rozumím, přidávám…';
    $('taskReply').hidden = false;
  });
  $('taskMic').addEventListener('click', function () { $('mic').click(); });
  bus.on('orb', function () {
    if (!awaitingReply || orbState() !== 'idle') return;
    awaitingReply = false;
    var reply = lastReply();
    if (reply) $('taskReplyText').textContent = reply;
  });
}

export function initTasks() {
  store.setTaskOpener(openWhen);
  initDock();
  $('taskForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var due = dueFrom($('taskDate').value, $('taskTime').value);
    if (addTask($('taskInput').value, { due_at: due })) {
      $('taskInput').value = ''; $('taskDate').value = ''; $('taskTime').value = '';
    }
  });

  $('todayTaskForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    // The today panel adds to today.
    if (addTask($('todayTaskInput').value, { due_at: logicalToday() })) $('todayTaskInput').value = '';
  });

  function toggleDone() {
    showDone = !showDone;
    renderTasks(); renderToday();
  }
  function clearDone() {
    store.patch('tasks', function (list) { return list.filter(function (t) { return !t.done; }); });
    say('Hotové úkoly smazány.');
  }
  $('toggleDone').addEventListener('click', toggleDone);
  $('clearDone').addEventListener('click', clearDone);
  document.querySelector('[data-task-act="toggleDone"]').addEventListener('click', toggleDone);
  document.querySelector('[data-task-act="clearDone"]').addEventListener('click', clearDone);

  $('focusDone').addEventListener('click', function () {
    if (focusId) toggleTaskDone(focusId);
    say('Hotovo a odškrtnuto.');
    go('tasks');
  });
  $('focusLeave').addEventListener('click', function () { go('tasks'); });

  $('runAddForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (addChecklistItem($('runAddInput').value)) $('runAddInput').value = '';
  });

  $('runReset').addEventListener('click', function () {
    setChecklist(runId, checklistFor(runId).map(function (i) { return Object.assign({}, i, { done: false }); }));
  });
  $('runFinish').addEventListener('click', function () {
    if (runId) toggleTaskDone(runId);
    say('Hotovo a odškrtnuto.');
    go('main');
  });

  onEnter('focus', startFocusClock);
  onEnter('task', renderRunner);
  onEnter('tasks', function () { stopFocusClock(); renderTasks(); });
  onEnter('main', stopFocusClock);

  store.onChange(function () {
    renderToday();
    renderTasks();
    if (runId) renderRunner();
    paintFocus();
  });

  /* Groups move with the clock: at 15:01 the 15:00 task is late, and at 04:00
     today's list becomes yesterday's. Redraw only when a task actually changed
     group, so an open date editor is not wiped every minute. */
  setInterval(function () {
    var now = tasks().map(function (t) { return bucketOf(t) + dueLabel(t.due_at); }).join('|');
    if (now === lastBuckets) return;
    lastBuckets = now;
    renderToday(); renderTasks();
  }, 60000);
}

/** Mark done regardless of current value — used when a flow completes. */
function toggleTaskDone(id) {
  store.patch('tasks', function (list) {
    return list.map(function (t) { return t.id === id ? Object.assign({}, t, { done: true }) : t; });
  });
}

/* =========================================================================
   Tasks — the list, the full view, focus mode, and the checklist runner.

   All four read the same array in the store, so ticking something off in focus
   mode is immediately true in the main view's "today" panel. Grouping is
   derived from the task's own `group` field rather than recomputed from dates:
   Kacey writes the group when she adds one by voice, and a task the user calls
   "this week" should stay there even when the week turns over.
   ========================================================================= */

import { $ } from '../core/dom.js';
import { el, fill } from '../core/el.js';
import * as store from '../core/store.js';
import { go, onEnter } from '../ui/router.js';
import { say } from '../ui/toast.js';

var GROUPS = [
  { key: 'overdue', name: 'Po termínu', emptyText: 'Nic po termínu. Dobře.' },
  { key: 'today', name: 'Dnes', emptyText: 'Na dnešek už nic.' },
  { key: 'week', name: 'Tento týden', emptyText: 'Tento týden už nic dalšího.' }
];

var showDone = true;
var focusId = null, focusSecs = 0, focusTimer = 0;
var runId = null;

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
    group: 'today', done: false, today: true
  }, extra || {});
  store.patch('tasks', function (list) { return list.concat([task]); });
  say('Úkol přidán · ' + text);
  return task;
}

/* ---- one row ----------------------------------------------------------- */

function taskRow(t, big) {
  var box = el('button.check' + (big ? '.check--lg' : ''), {
    type: 'button', 'aria-pressed': String(!!t.done), 'aria-label': 'Přepnout úkol',
    onclick: function () { toggleTask(t.id); }
  }, t.done ? '✓' : '');

  var kids = [box, el('span.task__text', [
    el('span.task__label', t.label),
    t.meta ? el('span.task__meta', t.meta) : null
  ])];

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

  return el('div.task' + (t.done ? '.is-done' : '') + (t.group === 'overdue' ? '.task--overdue' : ''), kids);
}

/* ---- the compact list on the main view --------------------------------- */

export function renderToday() {
  var host = $('todayTasks');
  if (!host) return;
  var list = tasks().filter(function (t) { return t.today && (showDone || !t.done); });
  fill(host, list.length ? list.map(function (t) { return taskRow(t, false); })
                         : el('p.empty', 'Na dnešek nic. Přidej úkol níž, nebo řekni „KC, přidej …“.'));
}

/* ---- the full view ------------------------------------------------------ */

export function renderTasks() {
  var host = $('taskGroups');
  if (!host) return;

  var visible = tasks().filter(function (t) { return showDone || !t.done; });

  fill(host, GROUPS.map(function (g) {
    var items = visible.filter(function (t) { return t.group === g.key; });
    return el('div', [
      el('h3.subhead' + (g.key === 'overdue' ? '.subhead--err' : ''), g.name),
      items.length ? items.map(function (t) { return taskRow(t, true); })
                   : el('p.muted', g.emptyText)
    ]);
  }));

  var all = tasks();
  var overdue = all.filter(function (t) { return t.group === 'overdue' && !t.done; }).length;
  var dueToday = all.filter(function (t) { return t.today && !t.done; }).length;
  var open = all.filter(function (t) { return !t.done; }).length;
  $('taskCounts').textContent = dueToday + ' dnes · ' + open + ' otevřených · ' + overdue + ' po termínu';
  $('toggleDone').textContent = showDone ? 'Skrýt hotové' : 'Zobrazit hotové';

  var todayAll = all.filter(function (t) { return t.today; });
  var todayDone = todayAll.filter(function (t) { return t.done; }).length;
  $('doneRatio').textContent = todayDone + ' / ' + todayAll.length;
  $('taskBar').style.width = (todayAll.length ? Math.round(todayDone / todayAll.length * 100) : 0) + '%';
}

/** Counts the brief and the main rail both need. */
export function taskSummary() {
  var all = tasks();
  return {
    due: all.filter(function (t) { return t.today && !t.done; }).length,
    overdue: all.filter(function (t) { return t.group === 'overdue' && !t.done; }).length,
    open: all.filter(function (t) { return !t.done; }).length
  };
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
  $('focusMeta').textContent = t ? (t.meta || '') : '';
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

export function initTasks() {
  $('taskForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (addTask($('taskInput').value)) $('taskInput').value = '';
  });

  $('todayTaskForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (addTask($('todayTaskInput').value)) $('todayTaskInput').value = '';
  });

  $('toggleDone').addEventListener('click', function () {
    showDone = !showDone;
    renderTasks(); renderToday();
  });

  $('clearDone').addEventListener('click', function () {
    store.patch('tasks', function (list) { return list.filter(function (t) { return !t.done; }); });
    say('Hotové úkoly smazány.');
  });

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
}

/** Mark done regardless of current value — used when a flow completes. */
function toggleTaskDone(id) {
  store.patch('tasks', function (list) {
    return list.map(function (t) { return t.id === id ? Object.assign({}, t, { done: true }) : t; });
  });
}

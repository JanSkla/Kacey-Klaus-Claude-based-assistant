/* =========================================================================
   Tasks — the list, the full view, focus mode, and the checklist runner.

   All four read the same array in the store, so ticking something off in focus
   mode is immediately true in the main view's "today" panel.

   A task carries a due date, a due time, or neither (`due_at`, see
   core/due.js). The groups — po termínu, dnes, tento týden — are worked out
   from that and the clock every time the list is drawn, never stored, so a
   task due today is overdue tomorrow without anybody moving it. A task with a
   time is also drawn in the calendar's lane (ui/calendar.js).

   A task also carries a tag — what it belongs to (core/tasktags.js). The
   full view shows the list either way: by when (the groups above) or by tag,
   one group per tag, where a task moves to another tag by dragging its ⋮⋮
   (or a tap on it, which opens the tag chips). The tags themselves are
   renamed, added and deleted right there, in the group heads.
   ========================================================================= */

import { $ } from '../core/dom.js';
import { el, fill } from '../core/el.js';
import * as store from '../core/store.js';
import { bucketOf, dueLabel, logicalToday, parseDue, vTime } from '../core/due.js';
import { guessTag, newTagId, tagById, tagNameProblem, tagsFrom, TAG_NAME_MAX, TAG_HINT_MAX } from '../core/tasktags.js';
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
import { initRunWins, openRunWin, isRunWinOpen, refreshRunWins } from '../ui/runwins.js';

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

/* By when ('time') or by tag ('tag'). This device's choice, like the hue. */
var VIEW_KEY = 'kacey.tasks.view';
var viewMode = (function () { try { return localStorage.getItem(VIEW_KEY) === 'tag' ? 'tag' : 'time'; } catch (e) { return 'time'; } })();
var tagPickId = null;      // the task whose tag chips are open
var editingTag = null;     // the tag whose name is being edited
var addingTag = false;     // the "+ Nový štítek" field is open
var armedTag = null;       // Smazat pressed once: the tag that a second press deletes
var hintOpen = {};         // tag id -> its description is unfolded under the head
var dropping = false;      // a drag ended a moment ago: swallow the click it makes

export function tasks() { return store.data.tasks || []; }

/** The owner's tags (settings.taskTags), the starting five until they change them. */
export function tagList() { return tagsFrom(store.data.settings); }

/** A task's tag, or null for "Bez štítku" (none, or one since deleted). */
function tagOf(t) { return tagById(tagList(), t.tag); }

function setTag(id, tag) {
  store.patch('tasks', function (list) {
    return list.map(function (t) { return t.id === id ? Object.assign({}, t, { tag: tag }) : t; });
  });
}

/** Move a task under another tag, and say so with a way back. */
function moveTask(t, tag) {
  var from = t.tag || null;
  if (from === tag) return;
  setTag(t.id, tag);
  var to = tagById(tagList(), tag);
  say(t.label + ' → ' + (to ? to.name : 'Bez štítku'), { label: 'Vrátit', run: function () { setTag(t.id, from); } });
}

export function toggleTask(id) {
  store.patch('tasks', function (list) {
    return list.map(function (t) { return t.id === id ? Object.assign({}, t, { done: !t.done }) : t; });
  });
}

export function addTask(label, extra) {
  var text = String(label || '').trim();
  if (!text) return null;
  var task = Object.assign({
    id: 't' + Date.now(), label: text, meta: 'přidáno teď',
    done: false, due_at: null
  }, extra || {});
  // Every new task gets a tag: the one picked, or the one its words point at.
  if (!task.tag) task.tag = guessTag(text, tagList());
  store.patch('tasks', function (list) { return list.concat([task]); });
  var tag = tagOf(task);
  // The line opens the new task's due date (Claude Design: toast "open").
  say('Úkol přidán · ' + text + (task.due_at ? ' · ' + dueLabel(task.due_at) : '') + ' · ' + (tag ? tag.name : 'bez štítku'), null,
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

function taskRow(t, big, byTag) {
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

  /* Its tag follows the date: a button that opens the tag chips in the
     full view by when, words in the today panel, and nothing in the view by
     tag, where the group already says it. */
  var tag = tagOf(t);
  var tagNode = byTag ? null : big
    ? el('button.task__due.task__tagbtn' + (tag ? '' : '.is-empty'), {
        type: 'button', 'aria-expanded': String(tagPickId === t.id), title: 'Změnit štítek',
        onclick: function () { pickTag(t.id); }
      }, tag ? tag.name : '+ štítek')
    : (tag ? el('span.task__due', tag.name) : null);
  var metaParts = [dueNode, tagNode, t.meta || null].filter(Boolean);

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
    metaParts.length ? el('span.task__meta', metaParts.reduce(function (out, part, i) {
      return out.concat(i ? [' · ', part] : [part]);
    }, [])) : null
  ]), origin];

  /* By tag, the row is picked up by its ⋮⋮: drag it to another group, or
     tap it (Enter from the keyboard) for the tag chips. */
  var grip = null;
  if (byTag) {
    grip = el('button.task__grip', {
      type: 'button', 'aria-label': 'Přesunout pod jiný štítek', 'aria-expanded': String(tagPickId === t.id),
      title: 'Přetáhni do jiné skupiny, nebo klepni a vyber štítek',
      onclick: function () { if (!dropping) pickTag(t.id); }
    }, '⋮⋮');
    kids.unshift(grip);
  }

  if (big && !t.done) {
    /* Two ways to start something: run its checklist, or sit with it on a
       clock. A task that already has a list leads with the list, because that
       is the thing the user built. */
    var hasList = checklistFor(t.id).length > 0;
    // On a desktop the list opens as a window; while it is open, the button says so.
    var winOpen = isRunWinOpen(t.id);
    kids.push(el('button.btn.btn--sm' + (hasList && !winOpen ? '.btn--accent' : ''), {
      type: 'button', 'aria-pressed': winOpen ? 'true' : null,
      title: winOpen ? 'Seznam je otevřený — ukázat ho' : null,
      onclick: function () { openRunner(t.id); }
    }, hasList ? 'Spustit' : 'Seznam'));
    kids.push(el('button.btn.btn--sm', {
      type: 'button', onclick: function () { openFocus(t.id); }
    }, 'Focus'));
  }

  if (generated && whyOpen[t.id]) kids.push(whyPanel(t));
  if (big && editingId === t.id && !isPhone()) kids.push(dueEditor(t));
  if (big && tagPickId === t.id) kids.push(tagChips(t));

  var row = el('div.task' + (t.done ? '.is-done' : '') + (bucket === 'overdue' ? '.task--overdue' : ''), kids);
  if (generated) longPress(row, function () { whyOpen[t.id] = !whyOpen[t.id]; renderToday(); renderTasks(); });
  if (grip) dragToTag(grip, row, t);
  return row;
}

function pickTag(id) {
  tagPickId = tagPickId === id ? null : id;
  renderTasks();
}

/* Under the row: every tag as a chip, the task's own one pressed. A press
   moves the task there and closes the chips; Escape closes them. */
function tagChips(t) {
  var box = el('div.tasktag', { role: 'group', 'aria-label': 'Štítek' }, [
    el('span.tasktag__cap', 'ŠTÍTEK')
  ].concat(tagList().map(function (g) {
    return el('button.chip.chip--filter', {
      type: 'button', 'aria-pressed': String(t.tag === g.id),
      onclick: function () { tagPickId = null; moveTask(t, g.id); renderTasks(); }
    }, g.name);
  })));
  box.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { ev.stopPropagation(); tagPickId = null; renderTasks(); }
  });
  return box;
}

/* ---- dragging a task to another tag ------------------------------------
   Pointer events on the ⋮⋮, so a mouse and a finger do the same thing (the
   handle is touch-action: none, so a drag on it does not scroll the page).
   The row follows the pointer; the group under it lights up; the move is
   made once, on release. Near the top or bottom edge the list scrolls. */

function scrollerOf(node) {
  for (var n = node; n && n !== document.body; n = n.parentElement) {
    var oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) return n;
  }
  return null;
}

function dragToTag(grip, row, t) {
  grip.addEventListener('pointerdown', function (ev) {
    if (ev.button !== 0) return;
    var host = $('taskGroups');
    var scroller = scrollerOf(host);
    var x0 = ev.clientX, y0 = ev.clientY, top0 = scroller ? scroller.scrollTop : 0;
    var x = x0, y = y0, on = false, target = null, raf = 0;
    grip.setPointerCapture(ev.pointerId);

    function groupAt() {
      var groups = host.querySelectorAll('[data-tag-group]');
      for (var i = 0; i < groups.length; i++) {
        var b = groups[i].getBoundingClientRect();
        if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return groups[i];
      }
      return null;
    }
    function paint() {
      var dy = y - y0 + (scroller ? scroller.scrollTop - top0 : 0);
      row.style.transform = 'translate(' + (x - x0) + 'px,' + dy + 'px)';
      var g = groupAt();
      var next = g && g.getAttribute('data-tag-group') !== (t.tag || '') ? g : null;
      if (next !== target) {
        if (target) target.classList.remove('is-droptarget');
        target = next;
        if (target) target.classList.add('is-droptarget');
      }
    }
    function tick() {
      if (scroller) {
        var b = scroller.getBoundingClientRect();
        var step = y < b.top + 60 ? -12 : y > b.bottom - 60 ? 12 : 0;
        if (step) { scroller.scrollTop += step; paint(); }
      }
      raf = requestAnimationFrame(tick);
    }
    function move(e) {
      x = e.clientX; y = e.clientY;
      if (!on && Math.abs(x - x0) + Math.abs(y - y0) < 6) return;
      if (!on) {
        on = true;
        row.classList.add('is-dragging');
        document.body.classList.add('is-tagdrag');
        raf = requestAnimationFrame(tick);
      }
      paint();
    }
    function up(e) {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      cancelAnimationFrame(raf);
      if (!on) return;             // a tap: the click opens the chips
      dropping = true;
      setTimeout(function () { dropping = false; }, 0);
      row.classList.remove('is-dragging');
      row.style.transform = '';
      document.body.classList.remove('is-tagdrag');
      var to = e.type === 'pointerup' && target ? target.getAttribute('data-tag-group') || null : undefined;
      if (target) target.classList.remove('is-droptarget');
      if (to !== undefined) moveTask(t, to);
    }
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });
}

/* Half a second's press on a phone row, not on one of its buttons. */
function longPress(node, fn) {
  var timer = null;
  function stop() { clearTimeout(timer); timer = null; }
  node.addEventListener('pointerdown', function (ev) {
    if (!isPhone() || ev.target.closest('button, a, input')) return;
    timer = setTimeout(function () { timer = null; fn(); }, 500);
  });
  ['pointerup', 'pointerleave', 'pointercancel', 'pointermove'].forEach(function (e) { node.addEventListener(e, stop); });
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
  if (tagPickId && !visible.some(function (t) { return t.id === tagPickId; })) tagPickId = null;

  host.classList.toggle('groups--tags', viewMode === 'tag');
  fill(host, viewMode === 'tag' ? tagGroups(visible) : GROUPS.map(function (g) {
    var items = visible.filter(function (t) { return bucketOf(t) === g.key; }).sort(byDue);
    if (g.optional && !items.length) return null;
    return el('div', [
      el('h3.subhead' + (g.key === 'overdue' ? '.subhead--err' : ''), g.name),
      items.length ? items.map(function (t) { return taskRow(t, true); })
                   : el('p.muted', g.emptyText)
    ]);
  }));
  paintViewSwitch();
  paintTagSelect();

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

/* ---- the full view by tag ----------------------------------------------- */

/** "1 úkol", "3 úkoly", "5 úkolů". */
function countWord(n) {
  return n + (n === 1 ? ' úkol' : n >= 2 && n <= 4 ? ' úkoly' : ' úkolů');
}

/* Open ones first, in the order they come due; done ones after. */
function byTagOrder(a, b) {
  if (!!a.done !== !!b.done) return a.done ? 1 : -1;
  return byDue(a, b);
}

/* One group per tag, in the owner's order; "Bez štítku" when something is
   in it; then the cell that adds a tag. */
function tagGroups(visible) {
  var tags = tagList();
  var none = !visible.length;
  var out = [];
  /* Nothing to sort: say so once, instead of every group asking for a drag. */
  if (none) out.push(el('p.empty.tasks__none', tasks().length
    ? 'Všechno je hotové a hotové jsou skryté.'
    : 'Žádné úkoly. Přidej úkol, nebo řekni „KC, přidej …“ — Kacey mu štítek vybere sama.'));
  if (!tags.length) out.push(el('p.empty.tasks__none', 'Zatím žádné štítky. Přidej první níž — Kacey pak do nich bude úkoly řadit sama.'));
  out = out.concat(tags.map(function (g) {
    return tagGroup(g, visible.filter(function (t) { return t.tag === g.id; }), none);
  }));
  var loose = visible.filter(function (t) { return !tagById(tags, t.tag); });
  if (loose.length) out.push(tagGroup(null, loose));
  out.push(addingTag ? newTagForm() : el('button.tag__more.tagnew', {
    type: 'button', onclick: function () { addingTag = true; editingTag = null; renderTasks(); focusTagField(); }
  }, '+ Nový štítek'));
  return out;
}

function tagGroup(g, items, none) {
  var open = items.filter(function (t) { return !t.done; }).length;
  function edit(field) {
    return function () { editingTag = g.id; addingTag = false; armedTag = null; renderTasks(); focusTagField(field); };
  }
  var editing = g && editingTag === g.id;
  /* What belongs here, in the owner's words — what Kacey sorts by. Folded
     away behind "Popisek ▾" in the head so the tasks stay easy to read; a
     tag without one shows nothing (Upravit writes it). */
  var hasHint = !!(g && g.hint && !editing);
  var hintShown = hasHint && !!hintOpen[g.id];
  var head = editing ? tagEditForm(g) : el('h3.subhead.subhead--row', [
    el('span.subhead__name', g ? g.name : 'Bez štítku'),
    el('span.subhead__meta.num', open ? countWord(open) : items.length ? 'vše hotovo' : ''),
    hasHint ? el('button.link.link--muted.taghint__toggle.push', {
      type: 'button', 'aria-expanded': String(hintShown), title: hintShown ? 'Skrýt popisek' : 'Co sem patří — popisek pro Kacey',
      onclick: function () { hintOpen[g.id] = !hintOpen[g.id]; renderTasks(); }
    }, hintShown ? 'Popisek ▴' : 'Popisek ▾') : null,
    g ? el(hasHint ? 'button.link' : 'button.link.push', { type: 'button', 'aria-label': 'Upravit štítek ' + g.name, onclick: edit() }, 'Upravit') : null
  ]);
  var hint = hintShown
    ? el('button.taghint', { type: 'button', title: 'Upravit popisek', onclick: edit('hint') }, [
        el('span.taghint__cap', 'PRO KACEY'), el('span.taghint__text', g.hint)
      ])
    : null;
  return el('div', { 'data-tag-group': g ? g.id : '' }, [
    head,
    hint,
    g ? null : el('p.muted-3.tasks__hint', 'Kacey nevěděla, kam patří. Přetáhni je za ⋮⋮ pod štítek.'),
    items.length ? items.sort(byTagOrder).map(function (t) { return taskRow(t, true, true); })
                 : el('p.muted.tasks__drop', none ? 'Prázdné.' : 'Prázdné. Přetáhni sem úkol za ⋮⋮.')
  ]);
}

function focusTagField(field) {
  var f = document.querySelector('#taskGroups .tagedit ' + (field === 'hint' ? '.tagedit__hint' : '.input'));
  if (!f) return;
  f.focus();
  if (field === 'hint') f.setSelectionRange(f.value.length, f.value.length); else f.select();
}

/* The description field, in the edit form and the new-tag cell. */
var HINT_PLACEHOLDER = 'Vlastními slovy, co sem patří — např. „úklid, nákupy do domácnosti, opravy, nájem a energie“';

function hintField(value) {
  return el('textarea.input.tagedit__hint', {
    rows: '3', maxlength: String(TAG_HINT_MAX), placeholder: HINT_PLACEHOLDER, 'aria-label': 'Popisek štítku — co pod něj patří'
  }, value || '');
}

function hintOf(area) { return area.value.replace(/\s+/g, ' ').trim(); }

/** A tag with its new name and description; no `hint` key when it is empty. */
function withHint(g, name, hint) {
  var out = { id: g.id, name: name };
  if (hint) out.hint = hint;
  return out;
}

/* Escape cancels; Ctrl+Enter in the description saves (Enter is a new line there). */
function tagFormKeys(form, close) {
  form.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { ev.stopPropagation(); close(); }
    else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && ev.target.classList.contains('tagedit__hint')) {
      ev.preventDefault(); form.requestSubmit();
    }
  });
}

function saveTags(next) { store.patchSettings({ taskTags: next }); }

/** A name nobody else has, or why not: '' when it is fine. */
function nameProblem(name, exceptId) { return tagNameProblem(name, tagList(), exceptId); }

/* The group head while its tag is being edited: the name, what belongs under
   it (for Kacey), Uložit, Smazat (twice — the tasks stay, under "Bez
   štítku"), Zrušit. Escape cancels. */
function tagEditForm(g) {
  var input = el('input.input', { type: 'text', value: g.name, maxlength: String(TAG_NAME_MAX), 'aria-label': 'Název štítku' });
  var note = el('p.muted-3.tagedit__note', 'Smazáním se úkoly nesmažou — přejdou do Bez štítku.');
  var n = tasks().filter(function (t) { return t.tag === g.id; }).length;
  function close() { editingTag = null; armedTag = null; renderTasks(); }
  var del = el('button.btn.btn--sm.btn--dangerghost', {
    type: 'button',
    onclick: function () {
      if (armedTag !== g.id) {
        armedTag = g.id;
        del.textContent = 'Opravdu smazat?';
        setTimeout(function () { if (armedTag === g.id) { armedTag = null; del.textContent = 'Smazat'; } }, 4000);
        return;
      }
      deleteTag(g);
    }
  }, 'Smazat');
  var hint = hintField(g.hint);
  var form = el('form.tagedit', {
    onsubmit: function (ev) {
      ev.preventDefault();
      var name = input.value.trim();
      var problem = nameProblem(name, g.id);
      if (problem) { note.textContent = problem; note.classList.add('is-err'); input.focus(); return; }
      editingTag = null;
      var about = hintOf(hint);
      saveTags(tagList().map(function (x) { return x.id === g.id ? withHint(x, name, about) : x; }));
      if (about !== (g.hint || '')) say(about ? 'Popisek uložen — Kacey se jím bude řídit.' : 'Popisek smazán.');
    }
  }, [
    input,
    el('span.tagedit__cap', 'CO SEM PATŘÍ · PRO KACEY'),
    hint,
    el('div.tagedit__acts', [
      el('button.btn.btn--sm.btn--accent', { type: 'submit' }, 'Uložit'),
      del,
      el('button.btn.btn--sm', { type: 'button', onclick: close }, 'Zrušit')
    ]),
    el('p.muted-3.tagedit__count', n ? countWord(n) + ' pod tímto štítkem' : 'Zatím pod ním nic není'),
    note
  ]);
  tagFormKeys(form, close);
  return form;
}

function deleteTag(g) {
  var tagsBefore = tagList();
  var moved = tasks().filter(function (t) { return t.tag === g.id; }).map(function (t) { return t.id; });
  editingTag = null; armedTag = null;
  saveTags(tagsBefore.filter(function (x) { return x.id !== g.id; }));
  store.patch('tasks', function (list) {
    return list.map(function (t) { return t.tag === g.id ? Object.assign({}, t, { tag: null }) : t; });
  });
  say('Štítek ' + g.name + ' smazán' + (moved.length ? ' · ' + countWord(moved.length) + ' bez štítku' : ''), {
    label: 'Vrátit',
    run: function () {
      saveTags(tagsBefore);
      store.patch('tasks', function (list) {
        return list.map(function (t) { return moved.indexOf(t.id) !== -1 ? Object.assign({}, t, { tag: g.id }) : t; });
      });
    }
  });
}

/* The last cell: a name and Přidat. The new tag goes to the end. */
function newTagForm() {
  var input = el('input.input', { type: 'text', maxlength: String(TAG_NAME_MAX), placeholder: 'Název — např. Zdraví', 'aria-label': 'Název nového štítku' });
  var note = el('p.muted-3.tagedit__note', 'Kacey do něj bude řadit podle názvu a popisku. Úkoly sem přetáhneš za ⋮⋮.');
  var hint = hintField('');
  function close() { addingTag = false; renderTasks(); }
  var form = el('form.tagedit.tagedit--new', {
    onsubmit: function (ev) {
      ev.preventDefault();
      var name = input.value.trim();
      var problem = nameProblem(name, null);
      if (problem) { note.textContent = problem; note.classList.add('is-err'); input.focus(); return; }
      addingTag = false;
      var tags = tagList();
      saveTags(tags.concat([withHint({ id: newTagId(name, tags) }, name, hintOf(hint))]));
      say('Štítek ' + name + ' přidán.');
    }
  }, [
    el('span.tagedit__cap', 'NOVÝ ŠTÍTEK'),
    input,
    el('span.tagedit__cap', 'CO SEM PATŘÍ · PRO KACEY · NEPOVINNÉ'),
    hint,
    el('div.tagedit__acts', [
      el('button.btn.btn--sm.btn--accent', { type: 'submit' }, 'Přidat'),
      el('button.btn.btn--sm', { type: 'button', onclick: close }, 'Zrušit')
    ]),
    note
  ]);
  tagFormKeys(form, close);
  return form;
}

/* ---- the switch and the add form's tag ---------------------------------- */

function setView(mode) {
  viewMode = mode === 'tag' ? 'tag' : 'time';
  try { localStorage.setItem(VIEW_KEY, viewMode); } catch (e) { /* private mode: this load only */ }
  tagPickId = null; editingTag = null; armedTag = null;
  renderTasks();
}

/* Both copies of the switch: the card head (desktop), the summary card (phone). */
function paintViewSwitch() {
  var opts = document.querySelectorAll('[data-task-view]');
  for (var i = 0; i < opts.length; i++) {
    opts[i].setAttribute('aria-pressed', String(opts[i].getAttribute('data-task-view') === viewMode));
  }
}

var tagTouched = false;    // the owner picked the add form's tag: stop guessing

/* The add form's tag: the owner's tags, and until something is typed, "Štítek
   odhadne Kacey". As the text grows, the guess follows it — until the owner
   picks one themselves. */
function paintTagSelect() {
  var sel = $('taskTag');
  if (!sel) return;
  var keep = sel.value;
  fill(sel, [el('option', { value: '' }, 'Štítek: odhadne Kacey')].concat(tagList().map(function (g) {
    return el('option', { value: g.id }, g.name);
  })));
  sel.value = tagById(tagList(), keep) ? keep : '';
}

function guessIntoSelect() {
  var sel = $('taskTag');
  if (!sel || tagTouched) return;
  var guess = guessTag($('taskInput').value, tagList());
  sel.value = guess || '';
  sel.classList.toggle('is-guess', !!guess);
  sel.title = guess ? 'Odhad podle textu — změň, když nesedí' : '';
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
   A task can carry a checklist. On a desktop it opens as a floating window,
   several at once (ui/runwins.js); on a phone running it is a full-screen
   list with targets big enough to hit without looking, because this is the
   one screen used while doing something else. */

export function checklistFor(id) {
  var list = store.data.checklists[id];
  return Array.isArray(list) ? list : [];
}

export function openRunner(id) {
  if (openRunWin(id)) return;
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
    if (addTask($('taskInput').value, { due_at: due, tag: $('taskTag').value || null })) {
      $('taskInput').value = ''; $('taskDate').value = ''; $('taskTime').value = '';
      tagTouched = false; guessIntoSelect();
    }
  });
  $('taskInput').addEventListener('input', guessIntoSelect);
  $('taskTag').addEventListener('change', function () {
    tagTouched = !!$('taskTag').value;
    $('taskTag').classList.remove('is-guess');
    $('taskTag').title = '';
  });

  document.querySelectorAll('[data-task-view]').forEach(function (b) {
    b.addEventListener('click', function () { setView(b.getAttribute('data-task-view')); });
  });
  $('newTag').addEventListener('click', function () {
    addingTag = true; editingTag = null;
    setView('tag');
    var f = document.querySelector('#taskGroups .tagedit--new .input');
    if (f) { f.scrollIntoView({ block: 'nearest' }); f.focus(); }
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

  initRunWins({
    task: function (id) { return tasks().filter(function (x) { return x.id === id; })[0] || null; },
    items: checklistFor,
    setItems: setChecklist,
    finish: toggleTaskDone,
    when: whenText,
    ready: store.isReady,
    onPaint: renderTasks
  });

  store.onChange(function () {
    refreshRunWins();
    renderToday();
    renderTasks();
    if (runId) renderRunner();
    paintFocus();
  });

  /* Groups move with the clock: at 15:01 the 15:00 task is late, and at 04:00
     today's list becomes yesterday's. Redraw only when a task actually changed
     group, so an open date editor is not wiped every minute. A page coming
     back from the background checks at once (core/clock.js): its timers
     were asleep. */
  function regroup() {
    var now = tasks().map(function (t) { return bucketOf(t) + dueLabel(t.due_at); }).join('|');
    if (now === lastBuckets) return;
    lastBuckets = now;
    renderToday(); renderTasks();
  }
  setInterval(regroup, 60000);
  bus.on('clock', regroup);
}

/** Mark done regardless of current value — used when a flow completes. */
function toggleTaskDone(id) {
  store.patch('tasks', function (list) {
    return list.map(function (t) { return t.id === id ? Object.assign({}, t, { done: true }) : t; });
  });
}

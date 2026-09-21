/* =========================================================================
   The application document, browser side.

   Tasks, journal entries, the routine grid, timer presets and the controller's
   switches. One object, fetched once at boot from /api/app and written back
   section at a time, debounced.

   Views never mutate `data` directly — they call patch(), which writes, saves
   and notifies. That way a change made in the task list repaints the main
   view's "today" panel without either of them knowing about the other.

   The calendar is NOT here. It belongs to klaus_memory and is read through
   /api/calendar by js/ui/calendar.js.
   ========================================================================= */

import { say } from '../ui/toast.js';

var listeners = [];
var pending = {};          // section -> timer
var ready = false;

/* The same shape the server defaults to, so a view rendered before the fetch
   lands (or with the server down) has something coherent to draw. */
export var data = {
  tasks: [],
  journal: { entries: [] },
  routine: { grid: {}, notes: {}, wake: 420, sleep: 1350 },
  timers: { presets: [] },
  checklists: {},
  /* Read-only, from the server: the tools refused by configuration. Not a
     section, so it is never written back. */
  deniedTools: [],
  settings: {
    hue: 193, wakeMin: 405, briefPrompt: '',
    injected: {}, sources: {}, memory: {}, calOn: {}, tools: {}
  }
};

export function isReady() { return ready; }

/** Subscribe to every change. Returns nothing — nothing unsubscribes here. */
export function onChange(fn) { listeners.push(fn); }

export function emit() {
  for (var i = 0; i < listeners.length; i++) {
    try { listeners[i](); } catch (e) { console.error('[kacey] store listener failed', e); }
  }
}

/* Debounced per section: dragging across the routine grid produces a hundred
   changes a second, and every one of them must not become a request. */
function save(section) {
  clearTimeout(pending[section]);
  pending[section] = setTimeout(function () {
    fetch('/api/app/' + section, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: data[section] })
    }).catch(function (err) {
      console.warn('[kacey] could not save ' + section + ': ' + err.message);
    });
  }, 500);
}

/**
 * Replace a section and persist it.
 *
 * `value` may be the new section, or a function taking the old one — the second
 * form is what callers want whenever the new value depends on the old, because
 * a read-modify-write across an await can lose a concurrent edit.
 */
export function patch(section, value) {
  data[section] = typeof value === 'function' ? value(data[section]) : value;
  save(section);
  emit();
}

/** Convenience for the many single-key settings toggles. */
export function patchSettings(partial) {
  patch('settings', Object.assign({}, data.settings, partial));
}

export function flip(group, key) {
  var next = Object.assign({}, data.settings[group]);
  next[key] = !next[key];
  var p = {}; p[group] = next;
  patchSettings(p);
}

/**
 * A section was changed by Kacey's own tools, server side.
 *
 * Reload the whole document rather than trusting a value off the wire: the
 * server is the one that just wrote it, and a partial patch here is how the
 * two copies drift apart. `undo` is the previous value of that section, so the
 * user gets one click to put it back — a routine imported from a screenshot is
 * the case this exists for.
 */
export async function applyRemoteChange(section, undo) {
  await load();

  var names = {
    routine: 'Rutina', tasks: 'Úkoly', journal: 'Deník',
    settings: 'Nastavení', timers: 'Časovače', checklists: 'Seznamy'
  };
  var label = names[section] || 'Aplikace';

  var act = (section && undo !== undefined && undo !== null)
    ? {
        label: 'Vrátit zpět',
        run: function () {
          patch(section, undo);
          say(label + ' vrácena zpět.');
        }
      }
    : null;

  say(label + ' — změnila Kacey.', act);
}

export async function load() {
  try {
    var res = await fetch('/api/app');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var doc = await res.json();
    // Merge rather than assign: a server missing a section must not erase the
    // defaults the views are already drawing from.
    for (var key in data) {
      if (doc[key] === undefined) continue;
      data[key] = (doc[key] && typeof doc[key] === 'object' && !Array.isArray(doc[key]))
        ? Object.assign({}, data[key], doc[key])
        : doc[key];
    }
  } catch (err) {
    console.warn('[kacey] app state unavailable, running on defaults: ' + err.message);
  }
  ready = true;
  emit();
}

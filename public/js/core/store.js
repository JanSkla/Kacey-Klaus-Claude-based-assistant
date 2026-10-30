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
import { tagById, tagsFrom } from './tasktags.js';
import { clampVolume, volumeOf, volumeWords } from './voicevolume.js';

var listeners = [];
var pending = {};          // section -> timer
var ops = {};              // section -> the patches since the last successful save
var unsaved = {};          // section -> its last save failed for want of a connection
var ready = false;
var loaded = false;        // the server has answered at least once

/* The same shape the server defaults to, so a view rendered before the fetch
   lands (or with the server down) has something coherent to draw. */
export var data = {
  tasks: [],
  journal: { entries: [] },
  /* overrides: read-only, from the server — this date's divergences from the
     default week (core/routine-day.js); changed through /api/routine/alter. */
  routine: { grid: {}, notes: {}, info: {}, wake: 420, sleep: 1350, overrides: [] },
  timers: { presets: [] },
  checklists: {},
  /* The morning checklist for the coming mornings (core/checklist.js). */
  morning: { items: [], once: [] },
  /* Read-only, from the server: the tools refused by configuration. Not a
     section, so it is never written back. */
  deniedTools: [],
  /* Read-only, from the server: the revision `tasks` came from. Sent back with
     every tasks save, so a copy that went stale (the night run added tasks
     since) is refused instead of deleting them. */
  tasksRev: 0,
  settings: {
    hue: 193, wakeMin: 405, briefPrompt: '', ttsVolume: 100,
    injected: {}, sources: {}, memory: {}, calOn: {}, tools: {}
  }
};

export function isReady() { return ready; }

/** Whether `data` is the server's, not the defaults of a page that booted
    offline — what may decide that a task is gone. */
export function isLoaded() { return loaded; }

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
  pending[section] = setTimeout(function () { send(section, 0); }, 500);
}

function send(section, attempt) {
  var sent = (ops[section] || []).splice(0);
  var body = { value: data[section] };
  if (section === 'tasks') body.base_rev = data.tasksRev;
  fetch('/api/app/' + section, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function (res) {
    if (res.status === 409 && section === 'tasks') return rebase(section, sent, attempt);
    return res.json().then(function (out) {
      if (!res.ok) throw Object.assign(new Error((out && out.error) || 'HTTP ' + res.status), { refused: true });
      if (section === 'tasks' && out && typeof out.tasksRev === 'number') data.tasksRev = out.tasksRev;
      if (unsaved[section]) {
        delete unsaved[section];
        if (!Object.keys(unsaved).length) say('Připojeno — změny jsou uložené.');
      }
    });
  }).catch(function (err) {
    console.warn('[kacey] could not save ' + section + ': ' + err.message);
    if (err.refused) { say('Tohle se nepovedlo uložit: ' + err.message); return; }
    /* Offline, or the server is restarting: the change stays on screen and
       goes out again once the browser is back online, or in a while. */
    ops[section] = sent.concat(ops[section] || []);
    if (!Object.keys(unsaved).length) say('Jsi offline — změny zatím nejsou uložené. Uložím je, až se připojím.');
    unsaved[section] = true;
    clearTimeout(pending[section]);
    pending[section] = setTimeout(function () { send(section, attempt); }, 15000);
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', function () {
    Object.keys(unsaved).forEach(function (section) { clearTimeout(pending[section]); send(section, 0); });
  });
}

/* The server's list moved on (the night run, Kacey, another page). Fetch it,
   replay this page's edits on top — patch() is called with a function almost
   everywhere, precisely so an edit can be re-applied to a newer list — and
   save again. A whole-value patch cannot be replayed safely; it is dropped
   and said so, rather than allowed to overwrite what changed. */
function rebase(section, sent, attempt) {
  return load().then(function () {
    var all = sent.concat((ops[section] || []).splice(0));
    var lost = false;
    all.forEach(function (op) {
      if (typeof op === 'function') data[section] = op(data[section]);
      else lost = true;
    });
    ops[section] = all.filter(function (op) { return typeof op === 'function'; });
    emit();
    if (lost) say('Úkoly se mezitím změnily — načetla jsem aktuální stav.');
    if (ops[section].length && attempt < 3) send(section, attempt + 1);
  });
}

/**
 * Replace a section and persist it.
 *
 * `value` may be the new section, or a function taking the old one — the second
 * form is what callers want whenever the new value depends on the old, because
 * a read-modify-write across an await can lose a concurrent edit.
 */
export function patch(section, value) {
  (ops[section] || (ops[section] = [])).push(typeof value === 'function' ? value : { value: value });
  var was = data[section];
  data[section] = typeof value === 'function' ? value(data[section]) : value;
  /* Kacey's volume has its own door (setVoiceVolume below) and the server
     keeps it through a settings save — so must this copy, or an undo of
     other settings would show the old volume here. */
  if (section === 'settings') data.settings = Object.assign({}, data.settings, volumeFields(was));
  save(section);
  emit();
}

/** Convenience for the many single-key settings toggles. */
export function patchSettings(partial) {
  patch('settings', Object.assign({}, data.settings, partial));
}

/* ---- Hlasitost Kacey ---------------------------------------------------------
   Not saved with the settings section but through PUT /api/voice/volume
   (core/voicevolume.js says why). Set here at once, so her next sentence
   uses it; offline it waits like a section does and goes out when the
   browser is back, or in a while. */

var volumeWaiting = null;   // the value still to be saved, or null
var volumeTimer = 0;        // set while it waits for a connection
var volumeSending = false;  // one request at a time, so the last value is the one that lands

function volumeFields(s) {
  var out = {};
  ['ttsVolume', 'ttsVolumeBy', 'ttsVolumeAt'].forEach(function (k) { if (s && k in s) out[k] = s[k]; });
  return out;
}

/** Set Kacey's volume (0–100) as the owner. */
export function setVoiceVolume(percent) {
  var v = clampVolume(percent);
  data.settings = Object.assign({}, data.settings, { ttsVolume: v, ttsVolumeBy: 'owner', ttsVolumeAt: new Date().toISOString() });
  emit();
  volumeWaiting = v;
  // Offline it goes out with the retry already waiting; otherwise now.
  if (!volumeTimer) sendVolume();
}

/** Whether the last volume is still waiting for a connection. */
export function voiceVolumeUnsaved() { return volumeTimer !== 0; }

function sendVolume() {
  if (volumeWaiting === null || volumeSending) return;
  var v = volumeWaiting;
  var waited = volumeTimer !== 0;
  clearTimeout(volumeTimer);
  volumeTimer = 0;
  volumeSending = true;
  fetch('/api/voice/volume', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ percent: v })
  }).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (out) {
      if (!res.ok) throw Object.assign(new Error((out && out.error) || 'HTTP ' + res.status), { refused: true });
      volumeSending = false;
      if (volumeWaiting === v) volumeWaiting = null;
      else { sendVolume(); return; }   // moved again while this was on its way
      if (waited) { say('Připojeno — hlasitost ' + volumeWords(v) + ' je uložená.'); emit(); }
    });
  }).catch(function (err) {
    volumeSending = false;
    console.warn('[kacey] could not save the voice volume: ' + err.message);
    if (err.refused) {
      volumeWaiting = null;
      say('Hlasitost se nepovedlo uložit: ' + err.message);
      load();               // show what the server holds
      return;
    }
    if (!waited) say('Jsi offline — hlasitost platí tady, uložím ji, až se připojím.');
    volumeTimer = setTimeout(sendVolume, 15000);
    emit();
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', function () { if (volumeTimer) sendVolume(); });
}

/** Another page moved it (a `voice_volume` frame): follow, unless this one has its own on the way. */
export function noteVoiceVolume(msg) {
  if (!msg || volumeWaiting !== null) return;
  data.settings = Object.assign({}, data.settings, {
    ttsVolume: clampVolume(msg.percent), ttsVolumeBy: msg.by || 'owner', ttsVolumeAt: msg.at || null
  });
  emit();
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
/* Who opens a task's due date — tasks.js sets it, so this module needs no view. */
var taskOpener = null;
export function setTaskOpener(fn) { taskOpener = fn; }

export async function applyRemoteChange(section, undo, quiet) {
  var before = section === 'tasks' && Array.isArray(undo) ? undo.map(function (t) { return t.id; }) : null;
  await load();
  // The owner's own action on another screen (a proposal accepted): reload, say nothing.
  if (quiet) return;

  var names = {
    routine: 'Rutina', routine_days: 'Rutina dne', tasks: 'Úkoly', journal: 'Deník',
    settings: 'Nastavení', timers: 'Časovače', checklists: 'Seznamy', rules: 'Pravidla'
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

  // Kacey added one task: say which, and the line opens its date (Kacey Phone 3d).
  if (before) {
    var added = (data.tasks || []).filter(function (t) { return before.indexOf(t.id) === -1; });
    if (added.length === 1) {
      var t = added[0];
      var tag = tagById(tagsFrom(data.settings), t.tag);
      say('Úkol přidán · ' + t.label + ' · ' + (tag ? tag.name : 'bez štítku'), act, taskOpener ? function () { taskOpener(t.id); } : null);
      return;
    }
  }
  // Kacey set her own volume from the chat (app_voice_volume): say where it landed.
  if (section === 'settings' && undo && typeof undo === 'object' && volumeOf(data.settings) !== volumeOf(undo)) {
    var was = volumeOf(undo);
    say('Hlasitost Kacey · ' + volumeWords(volumeOf(data.settings)) + ' — změnila Kacey.', {
      label: 'Vrátit na ' + volumeWords(was),
      run: function () {
        setVoiceVolume(was);
        say('Hlasitost vrácena na ' + volumeWords(was) + '.');
      }
    });
    return;
  }
  say(label + ' — změnila Kacey.', act);
}

/** Fetch the document. Resolves true when the server answered, false when
    the page went on with what it had (offline, server down). */
export async function load() {
  var fresh = false;
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
    fresh = true;
    loaded = true;
  } catch (err) {
    console.warn('[kacey] app state unavailable, running on defaults: ' + err.message);
  }
  ready = true;
  emit();
  return fresh;
}

/** load() again, unless this page has edits still on their way out — those
    would be overwritten. For a new day: the night run has written since boot.
    Resolves like load(), or null when it did not try for those edits. */
export function reloadIfIdle() {
  var busy = Object.keys(unsaved).length ||
    Object.keys(ops).some(function (section) { return ops[section].length; });
  return busy ? Promise.resolve(null) : load();
}

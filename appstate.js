/**
 * Kacey — the application document.
 *
 * Everything the interface owns but klaus_memory does not: tasks, journal
 * entries, the weekly routine, timer presets, and the controller's switches.
 * The calendar is NOT here — that is klaus_memory's, read through /api/calendar.
 *
 * Stored in SQLite, in klaus_memory's database file, in tables prefixed
 * `kacey_` (see db.js for why that is safe). It used to be a JSON file; the
 * import below moves an existing one across on first boot and then leaves it
 * alone.
 *
 * The shape this module hands out has not changed with the storage. Callers —
 * the HTTP layer, Kacey's own tools, the browser — still see one document with
 * named sections, because that is the shape the interface thinks in. The
 * translation between that and rows lives here and nowhere else.
 *
 * Writes are immediate rather than debounced. A JSON document had to be written
 * whole, so batching was worth it; a row update is cheap enough that the
 * debounce only bought a window in which a crash lost the last edit.
 */

import { readFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';

import { HERE, LOGICAL_DAY_START_HOUR } from './config.js';
import { open, transact, kvGet, kvSet, now, close } from './db.js';
import { dueFromGroup, normalizeDue, parseDue } from './public/js/core/due.js';

/** The JSON document this replaced. Imported once, then renamed aside. */
export const LEGACY_STATE_PATH =
  process.env.KACEY_STATE_PATH || path.join(HERE, 'data', 'app-state.json');

/** Sections a client may replace. Anything else is refused. */
export const SECTIONS = ['tasks', 'journal', 'routine', 'timers', 'checklists', 'settings'];

const DEFAULT_SETTINGS = {
  hue: 193,
  wakeMin: 405,
  briefPrompt: 'Shrň mi den. Mluv, drž se pod třemi minutami, začni tím, co se pohnulo nebo je po termínu.',
  injected: { cal: true, tasks: true, weather: true, mail: false },
  sources: { cal_osobni: true, cal_prace: true, cal_rodina: true, mail: false, health: true, lights: true },
  memory: { people: true, work: true, health: true, journal: true, dreams: false },
  calOn: {},
  tools: {},
};

const DEFAULT_PRESETS = [
  { label: 'Pomodoro', secs: 1500 },
  { label: 'Krátká pauza', secs: 300 },
  { label: 'Steak, každá strana', secs: 240 },
  { label: 'Pračka', secs: 3300 },
  { label: 'Šlofík', secs: 1200 },
];

/* ---- reading ------------------------------------------------------------- */

function readTasks() {
  return open().prepare(
    'SELECT * FROM kacey_task ORDER BY sort_order, created_at',
  ).all().map((r) => ({
    id: r.task_id,
    label: r.label,
    meta: r.meta,
    done: !!r.done,
    /* Which group it shows in (overdue, today, …) is not here: the browser
       works it out from due_at and the clock (public/js/core/due.js). */
    due_at: r.due_at || null,
    ...(r.duration_min ? { duration: r.duration_min } : {}),
    sensitivity: r.sensitivity,
    created: r.created_at,
    /* Read-only: who made it and why (docs/DREAM.md §9). A client may send
       these back; writeTasks() ignores them and keeps the stored ones. */
    origin: r.origin || 'user',
    ...(r.rule_id ? { rule_id: r.rule_id } : {}),
    ...(r.source_key ? { source_key: r.source_key } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.note ? { note: r.note } : {}),
  }));
}

/* ---- the tasks revision ---------------------------------------------------
   The browser saves the whole task list from its own copy. A page loaded
   before the night run would, on its first tick, save a list without the
   tasks the run made — deleting them, and (below) suppressing them for good.
   So every tasks write bumps a revision; the browser sends the revision its
   copy came from, and a stale one is refused (409) instead of written. */

export class ConflictError extends Error {
  constructor(rev) {
    super('Úkoly se mezitím změnily.');
    this.code = 'CONFLICT';
    this.rev = rev;
  }
}

export function tasksRev() { return Number(kvGet('tasks.rev', 0)) || 0; }

/** Bump the revision. Callers that write kacey_task directly (the night run) call this too. */
export function bumpTasksRev() {
  const next = tasksRev() + 1;
  kvSet('tasks.rev', next);
  return next;
}

function readJournal() {
  const entries = open().prepare(
    'SELECT * FROM kacey_journal_entry ORDER BY created_at',
  ).all().map((r) => {
    let tags = [];
    try { tags = JSON.parse(r.tags); } catch { tags = []; }
    return {
      id: r.entry_id,
      created: r.created_at,
      updated: r.updated_at,
      title: r.title,
      text: r.body,
      tags,
      unfinished: !!r.unfinished,
    };
  });
  return { entries };
}

function readRoutine() {
  const grid = {}, notes = {};
  for (const r of open().prepare('SELECT * FROM kacey_routine_block').all()) {
    const key = r.day + '-' + r.slot;
    grid[key] = r.category;
    if (r.note) notes[key] = r.note;
  }
  const hours = kvGet('routine.hours', { wake: 420, sleep: 1350 });
  return { grid, notes, wake: hours.wake, sleep: hours.sleep };
}

/* ---- writing ------------------------------------------------------------- */

/* A task's due date as stored. A task from before due dates (an old JSON
   import, a page loaded before the upgrade) has only a `group`; it gets the
   date that group meant today. Anything unreadable is "whenever" rather than
   an error that would lose the rest of the list. */
function taskDue(t) {
  if (!('due_at' in t) && t.group) return dueFromGroup(t.group, new Date(), LOGICAL_DAY_START_HOUR);
  try { return normalizeDue(t.due_at); } catch { return null; }
}

/**
 * Replace the task list.
 *
 * The generation columns (origin, rule_id, source_key, reason, note) are the
 * night routine's, not the client's: they are carried over from the stored
 * row with the same id, and a new row from a client is always a 'user' task.
 * Without that, every browser save would wipe them.
 *
 * A generated task missing from the new list was deleted by the owner, so its
 * occurrence key is suppressed and the generator never makes it again. This
 * is the one place every kind of delete passes through (the ✕, "Smazat
 * hotové", Kacey's app_task_update).
 *
 * `baseRev` is the revision the caller's list came from; a stale one throws
 * ConflictError and writes nothing. Server-side callers, which hold the
 * current document, pass nothing.
 */
function writeTasks(list, { baseRev } = {}) {
  const stamp = now();
  transact((h) => {
    const rev = tasksRev();
    if (baseRev !== undefined && baseRev !== null && Number(baseRev) !== rev) throw new ConflictError(rev);

    const before = new Map(
      h.prepare('SELECT task_id, origin, rule_id, source_key, reason, note FROM kacey_task').all()
        .map((r) => [r.task_id, r]),
    );
    const incoming = Array.isArray(list) ? list : [];

    h.prepare('DELETE FROM kacey_task').run();
    const insert = h.prepare(
      `INSERT INTO kacey_task
         (task_id, label, meta, done, due_at, duration_min, sensitivity, sort_order, created_at, updated_at,
          origin, rule_id, source_key, reason, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const kept = new Set();
    incoming.forEach((t, i) => {
      const id = String(t.id || ('t' + Date.now() + i));
      if (kept.has(id)) return;              // a duplicated id would abort the whole write
      kept.add(id);
      const due = taskDue(t);
      const timed = !!(parseDue(due) || {}).time;
      const minutes = Math.round(Number(t.duration));
      const gen = before.get(id) || {};
      insert.run(
        id,
        String(t.label || ''),
        String(t.meta || ''),
        t.done ? 1 : 0,
        due,
        timed && minutes >= 5 ? Math.min(minutes, 1440) : null,
        t.sensitivity === 'local_only' ? 'local_only' : 'cloud_safe',
        i,
        String(t.created || stamp),
        stamp,
        gen.origin || 'user',
        gen.rule_id || null,
        gen.source_key || null,
        gen.reason || null,
        gen.note || null,
      );
    });

    const suppress = h.prepare(
      `INSERT OR IGNORE INTO kacey_dream_suppress (source_key, reason, created_at) VALUES (?, 'deleted', ?)`,
    );
    for (const [id, row] of before) {
      if (row.source_key && !kept.has(id)) suppress.run(row.source_key, stamp);
    }
    kvSet('tasks.rev', rev + 1);
  });
}

function writeJournal(value) {
  const stamp = now();
  const entries = (value && Array.isArray(value.entries)) ? value.entries : [];
  transact((h) => {
    h.prepare('DELETE FROM kacey_journal_entry').run();
    const insert = h.prepare(
      `INSERT INTO kacey_journal_entry
         (entry_id, title, body, tags, unfinished, sensitivity, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of entries) {
      insert.run(
        String(e.id || ('j' + Date.now())),
        String(e.title || ''),
        String(e.text || ''),
        JSON.stringify(Array.isArray(e.tags) ? e.tags : []),
        e.unfinished ? 1 : 0,
        e.sensitivity === 'cloud_safe' ? 'cloud_safe' : 'local_only',
        String(e.created || stamp),
        String(e.updated || stamp),
      );
    }
  });
}

function writeRoutine(value) {
  const grid = (value && value.grid) || {};
  const notes = (value && value.notes) || {};
  transact((h) => {
    h.prepare('DELETE FROM kacey_routine_block').run();
    const insert = h.prepare(
      'INSERT INTO kacey_routine_block (day, slot, category, note) VALUES (?, ?, ?, ?)',
    );
    for (const key of Object.keys(grid)) {
      const parts = key.split('-');
      const day = Number(parts[0]), slot = Number(parts[1]);
      // Skip anything malformed rather than letting a CHECK abort the whole write.
      if (!Number.isInteger(day) || !Number.isInteger(slot)) continue;
      if (day < 0 || day > 6 || slot < 0 || slot > 95) continue;
      insert.run(day, slot, String(grid[key]), notes[key] ? String(notes[key]) : null);
    }
  });
  kvSet('routine.hours', {
    wake: Number(value && value.wake) || 420,
    sleep: Number(value && value.sleep) || 1350,
  });
}

/* ---- the document -------------------------------------------------------- */

export function get() {
  importLegacyOnce();
  return {
    version: 2,
    tasks: readTasks(),
    // Not a section: the revision the task list above is at (see writeTasks).
    tasksRev: tasksRev(),
    journal: readJournal(),
    routine: readRoutine(),
    timers: { presets: kvGet('timers.presets', DEFAULT_PRESETS) },
    checklists: kvGet('checklists', {}),
    settings: { ...DEFAULT_SETTINGS, ...kvGet('settings', {}) },
  };
}

export function setSection(name, value, opts = {}) {
  if (!SECTIONS.includes(name)) throw new Error(`unknown section "${name}"`);
  importLegacyOnce();

  switch (name) {
    case 'tasks': writeTasks(value, { baseRev: opts.baseRev }); break;
    case 'journal': writeJournal(value); break;
    case 'routine': writeRoutine(value); break;
    case 'timers': kvSet('timers.presets', (value && value.presets) || []); break;
    case 'checklists': kvSet('checklists', value || {}); break;
    case 'settings': kvSet('settings', value || {}); break;
    default: break;
  }
  return get()[name];
}

/* ---- the one-time import ------------------------------------------------- */

let importChecked = false;

/**
 * Move an existing JSON document into the tables, once.
 *
 * Marked in the database rather than by the file's absence, so a restored
 * backup of app-state.json cannot silently overwrite newer rows. The file is
 * renamed aside afterwards rather than deleted — it is the only copy of
 * somebody's journal until they are sure this worked.
 */
function importLegacyOnce() {
  if (importChecked) return;
  importChecked = true;

  open();
  if (kvGet('migrated.from_json', false)) return;
  if (!existsSync(LEGACY_STATE_PATH)) { kvSet('migrated.from_json', true); return; }

  let doc;
  try {
    doc = JSON.parse(readFileSync(LEGACY_STATE_PATH, 'utf8'));
  } catch (err) {
    console.warn(`[kacey] could not read ${LEGACY_STATE_PATH} (${err.message}); starting empty`);
    kvSet('migrated.from_json', true);
    return;
  }

  try {
    if (Array.isArray(doc.tasks)) writeTasks(doc.tasks);
    if (doc.journal) writeJournal(doc.journal);
    if (doc.routine) writeRoutine(doc.routine);
    if (doc.timers && Array.isArray(doc.timers.presets)) kvSet('timers.presets', doc.timers.presets);
    if (doc.checklists) kvSet('checklists', doc.checklists);
    if (doc.settings) kvSet('settings', doc.settings);
    kvSet('migrated.from_json', true);

    const aside = LEGACY_STATE_PATH + '.migrated';
    renameSync(LEGACY_STATE_PATH, aside);
    console.log(
      `[kacey] imported ${LEGACY_STATE_PATH} into SQLite ` +
      `(${(doc.tasks || []).length} tasks, ${((doc.journal || {}).entries || []).length} journal entries); ` +
      `the file is kept at ${aside}`,
    );
  } catch (err) {
    console.warn(`[kacey] import of ${LEGACY_STATE_PATH} failed: ${err.message}`);
  }
}

/* ---- tools --------------------------------------------------------------- */

/**
 * Seed the tool list from the server's allow-list, so the controller shows the
 * tools this build actually exposes. Existing choices win.
 *
 * Only the allow-list. The disallowed built-ins are policy, not preference:
 * they are refused in server.js whatever this document says, so offering a
 * switch for them would be a switch that lies.
 */
export function seedTools(allowed = []) {
  const settings = { ...DEFAULT_SETTINGS, ...kvGet('settings', {}) };
  const tools = { ...settings.tools };
  let changed = false;

  for (const name of allowed) if (!(name in tools)) { tools[name] = true; changed = true; }
  // Drop anything the server no longer offers — a dead switch is worse than a
  // missing one.
  for (const name of Object.keys(tools)) {
    if (!allowed.includes(name)) { delete tools[name]; changed = true; }
  }
  if (changed) kvSet('settings', { ...settings, tools });
  return tools;
}

/** Is a tool allowed right now? Consulted before the agent is given the list. */
export function toolAllowed(name) {
  const settings = { ...DEFAULT_SETTINGS, ...kvGet('settings', {}) };
  return settings.tools[name] !== false;
}

/** Nothing is buffered any more, but shutdown still calls this. */
export function flushNow() { close(); }

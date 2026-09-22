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

import { HERE } from './config.js';
import { open, transact, kvGet, kvSet, now, close } from './db.js';

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
    group: r.task_group,
    done: !!r.done,
    /* Derived, not stored. It used to be a column of its own and drifted from
       `group` depending on which code path wrote the row. */
    today: r.task_group !== 'week',
    ...(r.due_at ? { due_at: r.due_at } : {}),
  }));
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

function writeTasks(list) {
  const stamp = now();
  transact((h) => {
    h.prepare('DELETE FROM kacey_task').run();
    const insert = h.prepare(
      `INSERT INTO kacey_task
         (task_id, label, meta, task_group, done, due_at, sensitivity, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    (Array.isArray(list) ? list : []).forEach((t, i) => {
      const group = ['overdue', 'today', 'week'].includes(t.group) ? t.group : 'today';
      insert.run(
        String(t.id || ('t' + Date.now() + i)),
        String(t.label || ''),
        String(t.meta || ''),
        group,
        t.done ? 1 : 0,
        t.due_at ? String(t.due_at) : null,
        t.sensitivity === 'local_only' ? 'local_only' : 'cloud_safe',
        i,
        String(t.created || stamp),
        stamp,
      );
    });
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
    journal: readJournal(),
    routine: readRoutine(),
    timers: { presets: kvGet('timers.presets', DEFAULT_PRESETS) },
    checklists: kvGet('checklists', {}),
    settings: { ...DEFAULT_SETTINGS, ...kvGet('settings', {}) },
  };
}

export function setSection(name, value) {
  if (!SECTIONS.includes(name)) throw new Error(`unknown section "${name}"`);
  importLegacyOnce();

  switch (name) {
    case 'tasks': writeTasks(value); break;
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

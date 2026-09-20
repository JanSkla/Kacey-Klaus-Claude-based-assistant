/**
 * Kacey — the application document.
 *
 * Everything the redesigned interface owns but klaus_memory does not: tasks,
 * journal entries, the weekly routine, timer presets, and the controller's
 * switches. The calendar is NOT here — that belongs to klaus_memory and is read
 * through /api/calendar.
 *
 * One JSON file, read once at boot and written back debounced. A document this
 * small does not need a database, and a file can be read, diffed and repaired
 * by hand — which matters more here than write throughput.
 *
 * Writes are section-at-a-time and last-write-wins. Two browsers editing the
 * same section at the same second will lose one of the edits; with a single
 * owner, that is the right trade for keeping the whole thing legible.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

import { HERE } from './config.js';

export const STATE_PATH = process.env.KACEY_STATE_PATH || path.join(HERE, 'data', 'app-state.json');

/** The shape every section must have, and what a fresh install starts from. */
function defaults() {
  const now = Date.now();
  return {
    version: 1,
    tasks: [
      { id: 't' + now, label: 'Otevři Kacey a přidej první úkol', meta: 'osobní', group: 'today', done: false, today: true },
    ],
    journal: {
      entries: [],
    },
    routine: {
      // '<dayIndex>-<quarterHourIndex>': category key
      grid: {},
      notes: {},
      wake: 420,     // 07:00, minutes from midnight
      sleep: 1350,   // 22:30
    },
    timers: {
      // Named presets the user keeps; running timers live in the browser only.
      presets: [
        { label: 'Pomodoro', secs: 1500 },
        { label: 'Krátká pauza', secs: 300 },
        { label: 'Steak, každá strana', secs: 240 },
        { label: 'Pračka', secs: 3300 },
        { label: 'Šlofík', secs: 1200 },
      ],
    },
    checklists: {
      // taskId -> [{ id, label, note, done }]
    },
    settings: {
      hue: 193,
      wakeMin: 405,                 // when the morning brief is read out
      briefPrompt: 'Shrň mi den. Mluv, drž se pod třemi minutami, začni tím, co se pohnulo nebo je po termínu.',
      injected: { cal: true, tasks: true, weather: true, mail: false },
      sources: { cal_osobni: true, cal_prace: true, cal_rodina: true, mail: false, health: true, lights: true },
      memory: { people: true, work: true, health: true, journal: true, dreams: false },
      calOn: { 'osobní': true, 'práce': true, 'rodina': true },
      tools: {},                    // toolName -> allowed; filled from the server's real tool list
    },
  };
}

/** Sections a client may replace. Anything else is refused. */
export const SECTIONS = ['tasks', 'journal', 'routine', 'timers', 'checklists', 'settings'];

let doc = null;
let writeTimer = null;

/* Merge rather than replace: a document written by an older build is missing
   whatever this build added, and a missing section must not crash a view. */
function withDefaults(loaded) {
  const base = defaults();
  if (!loaded || typeof loaded !== 'object') return base;
  const out = { ...base, ...loaded };
  for (const key of ['routine', 'timers', 'settings', 'journal']) {
    out[key] = { ...base[key], ...(loaded[key] && typeof loaded[key] === 'object' ? loaded[key] : {}) };
  }
  if (!Array.isArray(out.tasks)) out.tasks = base.tasks;
  if (!Array.isArray(out.journal.entries)) out.journal.entries = [];
  if (!out.checklists || typeof out.checklists !== 'object') out.checklists = {};
  return out;
}

export function load() {
  if (doc) return doc;
  try {
    doc = withDefaults(JSON.parse(readFileSync(STATE_PATH, 'utf8')));
  } catch {
    doc = defaults();               // missing or corrupt: start clean, keep running
  }
  return doc;
}

/* Write through a temporary file: a crash mid-write leaves the previous
   document intact rather than a half-written one that will not parse. */
function flush() {
  writeTimer = null;
  try {
    mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const tmp = STATE_PATH + '.tmp';
    writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
    renameSync(tmp, STATE_PATH);
  } catch (err) {
    console.warn(`[kacey] could not save app state: ${err.message}`);
  }
}

function save() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, 400);
}

/** Write the whole document out now — used on shutdown. */
export function flushNow() {
  if (writeTimer) { clearTimeout(writeTimer); flush(); }
}

export function get() { return load(); }

export function setSection(name, value) {
  if (!SECTIONS.includes(name)) throw new Error(`unknown section "${name}"`);
  load();
  doc[name] = value;
  save();
  return doc[name];
}

/**
 * Seed the tool list from the server's allow-list, so the controller shows the
 * tools that actually exist instead of a hard-coded guess. Existing choices
 * win — this only adds tools the document has never seen.
 *
 * Only the allow-list. The disallowed built-ins (shell, file access, the web)
 * are policy, not preference: they are refused in server.js whatever this
 * document says, so offering a switch for them would be a switch that lies.
 */
export function seedTools(allowed = []) {
  load();
  const tools = { ...doc.settings.tools };
  let changed = false;
  for (const name of allowed) if (!(name in tools)) { tools[name] = true; changed = true; }
  // Drop anything the server no longer offers, including built-ins seeded by
  // an earlier build — a dead switch is worse than a missing one.
  for (const name of Object.keys(tools)) {
    if (!allowed.includes(name)) { delete tools[name]; changed = true; }
  }
  if (changed) { doc.settings = { ...doc.settings, tools }; save(); }
  return tools;
}

/** Is a tool allowed right now? Consulted before the agent is given the list. */
export function toolAllowed(name) {
  load();
  return doc.settings.tools[name] !== false;
}

export { defaults };

if (!existsSync(path.dirname(STATE_PATH))) {
  try { mkdirSync(path.dirname(STATE_PATH), { recursive: true }); } catch { /* created on first write */ }
}

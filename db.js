/**
 * Kacey — the database.
 *
 * Kacey's own records live in klaus_memory's SQLite file, next to the calendar,
 * so there is one database to back up and one storage approach across the whole
 * assistant. They do NOT live in klaus_memory's tables: every table here is
 * prefixed `kacey_`, and klaus_memory's fifty-odd tables are never touched.
 *
 * That boundary is the whole reason this is safe. klaus_memory owns its schema
 * and migrates it on its own schedule; Kacey owns hers. Neither can break the
 * other by adding a column. The only shared thing is the file.
 *
 * Two processes write it — this one and klaus_memory's Python — which SQLite
 * handles because the file is in WAL mode: many readers, one writer at a time.
 * `busy_timeout` is what makes that invisible rather than an error: a write
 * that lands while the other process holds the lock waits instead of throwing
 * SQLITE_BUSY. Without it, a calendar sync and a ticked checkbox in the same
 * millisecond would lose the checkbox.
 *
 * The conventions follow calendar_event deliberately: TEXT primary keys, ISO-8601
 * timestamps as TEXT, an `updated_at` on everything, and a `sensitivity` column
 * saying whether a row may leave the machine.
 */

import { DatabaseSync } from 'node:sqlite';

import { KLAUS_DB, LOGICAL_DAY_START_HOUR } from './config.js';
import { dueFromGroup, normalizeDue } from './public/js/core/due.js';

let db = null;

/* The task table, by name, so the migration below can build its replacement
   from the same definition the schema uses. */
const taskTable = (name) => `
CREATE TABLE IF NOT EXISTS ${name} (
  task_id      TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  meta         TEXT NOT NULL DEFAULT '',
  done         INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0,1)),
  -- When it is due, local time: 'YYYY-MM-DD' (some time that day) or
  -- 'YYYY-MM-DDTHH:MM' (at that time, and shown in the calendar). NULL is
  -- "whenever". Overdue / today / this week are worked out from this when the
  -- list is shown (public/js/core/due.js), never stored.
  due_at       TEXT,
  -- Only for a timed task: how long it takes, so the calendar can draw it.
  duration_min INTEGER CHECK (duration_min IS NULL OR duration_min BETWEEN 5 AND 1440),
  sensitivity  TEXT NOT NULL DEFAULT 'cloud_safe'
               CHECK (sensitivity IN ('cloud_safe','local_only')),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);`;

/* Kacey's tables. `IF NOT EXISTS` throughout: this runs on every boot and must
   be a no-op once the tables are there. Anything that ever needs to CHANGE a
   table goes in migrate() below. */
const SCHEMA = `
${taskTable('kacey_task')}
CREATE INDEX IF NOT EXISTS kacey_task_due_idx ON kacey_task (due_at);

CREATE TABLE IF NOT EXISTS kacey_journal_entry (
  entry_id     TEXT PRIMARY KEY,
  title        TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  tags         TEXT NOT NULL DEFAULT '[]',        -- JSON array of strings
  unfinished   INTEGER NOT NULL DEFAULT 1 CHECK (unfinished IN (0,1)),
  -- The journal is the most private thing in the app, so it defaults the other
  -- way from everything else: it does not leave the machine unless said so.
  sensitivity  TEXT NOT NULL DEFAULT 'local_only'
               CHECK (sensitivity IN ('cloud_safe','local_only')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS kacey_journal_created_idx ON kacey_journal_entry (created_at);

/* One row per painted quarter-hour. The browser works in a flat
   '<day>-<slot>' map because that is what makes dragging cheap; the database
   works in rows because that is what makes a week queryable. */
CREATE TABLE IF NOT EXISTS kacey_routine_block (
  day        INTEGER NOT NULL CHECK (day  BETWEEN 0 AND 6),
  slot       INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 95),
  category   TEXT NOT NULL,
  note       TEXT,
  PRIMARY KEY (day, slot)
);

/* Everything small and shapeless: wake/sleep times, timer presets, checklists,
   the controller's switches. A table each would be five tables of one row. */
CREATE TABLE IF NOT EXISTS kacey_kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,                       -- JSON
  updated_at TEXT NOT NULL
);
`;

export function now() { return new Date().toISOString(); }

/** Open the database, apply Kacey's schema, and hand back the handle. */
export function open() {
  if (db) return db;

  db = new DatabaseSync(KLAUS_DB);

  /* Wait rather than fail when klaus_memory holds the write lock. Five seconds
     is far longer than any write either side makes, and the alternative is an
     exception on a user's keystroke. */
  db.exec('PRAGMA busy_timeout = 5000');
  /* WAL is klaus_memory's choice and we inherit it; setting it here means a
     fresh database (a test, a new install) behaves the same way. */
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/* ---- migrations -----------------------------------------------------------
   Each one looks at the table itself to decide whether it is needed, rather
   than at a version number: PRAGMA user_version belongs to the whole file, and
   the file is klaus_memory's. */

function migrate(h) {
  const taskCols = h.prepare('PRAGMA table_info(kacey_task)').all().map((c) => c.name);
  if (taskCols.includes('task_group')) dropTaskGroups(h);
}

/* Tasks used to sit in a fixed group — overdue, today, this week — written
   when the task was made and never moved again, so a "today" task was still
   "today" a week later. The group becomes the date it meant on the day this
   runs (today; yesterday for overdue; Sunday for this week), and the column
   goes. SQLite cannot drop a column with a CHECK on it, so the table is
   rebuilt: new table, copy, swap — inside one transaction. */
function dropTaskGroups(h) {
  h.exec('BEGIN IMMEDIATE');
  try {
    const rows = h.prepare('SELECT * FROM kacey_task').all();
    h.exec(taskTable('kacey_task_next'));
    const insert = h.prepare(
      `INSERT INTO kacey_task_next
         (task_id, label, meta, done, due_at, duration_min, sensitivity, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      let due = null;
      try { due = normalizeDue(r.due_at); } catch { /* unreadable: fall back to the group */ }
      insert.run(
        r.task_id, r.label, r.meta, r.done,
        due || dueFromGroup(r.task_group, new Date(), LOGICAL_DAY_START_HOUR),
        r.sensitivity, r.sort_order, r.created_at, r.updated_at,
      );
    }
    h.exec('DROP TABLE kacey_task');
    h.exec('ALTER TABLE kacey_task_next RENAME TO kacey_task');
    h.exec('CREATE INDEX IF NOT EXISTS kacey_task_due_idx ON kacey_task (due_at)');
    h.exec('COMMIT');
    console.log(`[db] tasks: fixed groups became due dates (${rows.length} rows)`);
  } catch (err) {
    try { h.exec('ROLLBACK'); } catch { /* the BEGIN never took */ }
    throw err;
  }
}

export function close() {
  if (!db) return;
  try { db.close(); } catch { /* already gone */ }
  db = null;
}

/* ---- small helpers ------------------------------------------------------- */

export function kvGet(key, fallback) {
  const row = open().prepare('SELECT value FROM kacey_kv WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

export function kvSet(key, value) {
  open().prepare(
    `INSERT INTO kacey_kv (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), now());
}

/** Run `fn` inside a transaction, so a half-written section cannot be read. */
export function transact(fn) {
  const handle = open();
  handle.exec('BEGIN IMMEDIATE');
  try {
    const out = fn(handle);
    handle.exec('COMMIT');
    return out;
  } catch (err) {
    try { handle.exec('ROLLBACK'); } catch { /* the BEGIN never took */ }
    throw err;
  }
}

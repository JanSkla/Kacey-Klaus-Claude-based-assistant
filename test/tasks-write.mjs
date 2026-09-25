// Writing the task list with generated tasks in it — appstate.writeTasks().
// docs/DREAM.md §9: generation columns are carried over, a deleted generated
// task is suppressed, and a stale list is refused. Runs against a throwaway
// database in the OS temp directory; never the real one.
// Run: node test/tasks-write.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(path.join(os.tmpdir(), 'kacey-tasks-'));
process.env.KLAUS_DB = path.join(dir, 'test.db');
// Never let the one-time JSON import find (and rename!) a real app-state.json.
process.env.KACEY_STATE_PATH = path.join(dir, 'no-such-file.json');

/* An old-style task table, from before the night routine, so opening the
   database has to migrate it. */
{
  const old = new DatabaseSync(process.env.KLAUS_DB);
  old.exec(`CREATE TABLE kacey_task (
    task_id TEXT PRIMARY KEY, label TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '',
    done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0,1)), due_at TEXT,
    duration_min INTEGER CHECK (duration_min IS NULL OR duration_min BETWEEN 5 AND 1440),
    sensitivity TEXT NOT NULL DEFAULT 'cloud_safe' CHECK (sensitivity IN ('cloud_safe','local_only')),
    sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  old.prepare(`INSERT INTO kacey_task (task_id, label, created_at, updated_at) VALUES ('t_old', 'Starý úkol', 'x', 'x')`).run();
  old.close();
}

const db = await import('../db.js');
const appstate = await import('../appstate.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.stack}`); process.exitCode = 1; }
}

const h = db.open();
const byId = () => Object.fromEntries(appstate.get().tasks.map((t) => [t.id, t]));
const suppressed = () => h.prepare('SELECT source_key, reason FROM kacey_dream_suppress ORDER BY source_key').all()
  .map((r) => `${r.source_key}:${r.reason}`);

/** A generated task, written the way the night run will: straight into the table. */
function generate(id, key) {
  h.prepare(`INSERT INTO kacey_task (task_id, label, due_at, created_at, updated_at, origin, rule_id, source_key, reason, note)
             VALUES (?, 'Sbalit tašku', '2026-09-30T20:00', 'x', 'x', 'rule', 'rl_gym', ?, 'Posilovna čt 7:00', 'pozn')`).run(id, key);
  appstate.bumpTasksRev();
}

test('opening an old database adds the columns and keeps the rows', () => {
  const cols = h.prepare('PRAGMA table_info(kacey_task)').all().map((c) => c.name);
  for (const c of ['origin', 'rule_id', 'source_key', 'reason', 'note']) assert.ok(cols.includes(c), c);
  assert.equal(byId().t_old.origin, 'user');
  assert.ok(h.prepare("SELECT 1 FROM sqlite_master WHERE name = 'kacey_task_source_idx'").get());
});

test('the partial unique index allows many user tasks but one task per key', () => {
  generate('tr_a', 'r:rl_gym|cal:ev_1');
  assert.throws(() => generate('tr_b', 'r:rl_gym|cal:ev_1'), /UNIQUE/);
});

test('a browser save keeps what it does not know about', () => {
  // The browser's copy has no generation fields — and tries to sneak one in on a new row.
  const list = appstate.get().tasks.map(({ id, label, due_at, done }) => ({ id, label, due_at, done }));
  list.push({ id: 't_new', label: 'Nový', due_at: null, done: false, origin: 'rule', source_key: 'r:fake|x' });
  appstate.setSection('tasks', list);
  const t = byId();
  assert.equal(t.tr_a.origin, 'rule');
  assert.equal(t.tr_a.source_key, 'r:rl_gym|cal:ev_1');
  assert.equal(t.tr_a.reason, 'Posilovna čt 7:00');
  assert.equal(t.tr_a.note, 'pozn');
  assert.equal(t.t_new.origin, 'user', 'a client cannot make a generated task');
  assert.equal(t.t_new.source_key, undefined);
});

test('ticking a generated task keeps it generated', () => {
  appstate.setSection('tasks', appstate.get().tasks.map((x) => (x.id === 'tr_a' ? { ...x, done: true } : x)));
  assert.equal(byId().tr_a.done, true);
  assert.equal(byId().tr_a.origin, 'rule');
});

test('deleting a generated task suppresses its key; deleting a user task does not', () => {
  appstate.setSection('tasks', appstate.get().tasks.filter((x) => x.id !== 'tr_a' && x.id !== 't_new'));
  assert.deepEqual(suppressed(), ['r:rl_gym|cal:ev_1:deleted']);
  assert.equal(byId().tr_a, undefined);
});

test('every write bumps the revision', () => {
  const r0 = appstate.tasksRev();
  appstate.setSection('tasks', appstate.get().tasks);
  assert.equal(appstate.tasksRev(), r0 + 1);
  assert.equal(appstate.get().tasksRev, r0 + 1);
});

test('a stale list is refused and nothing is written', () => {
  const stale = appstate.get();              // the page loads at 22:00
  generate('tr_night', 'r:rl_gym|cal:ev_2'); // the night run adds a task at 00:30
  const tick = stale.tasks.map((x) => ({ ...x, done: true }));
  assert.throws(() => appstate.setSection('tasks', tick, { baseRev: stale.tasksRev }), (e) => e.code === 'CONFLICT');
  assert.ok(byId().tr_night, 'the night task survives');
  assert.ok(!suppressed().includes('r:rl_gym|cal:ev_2:deleted'), 'and is not suppressed');
});

test('a list from the current revision is written', () => {
  const doc = appstate.get();
  appstate.setSection('tasks', doc.tasks.map((x) => ({ ...x, done: true })), { baseRev: doc.tasksRev });
  assert.ok(Object.values(byId()).every((t) => t.done));
});

test('a duplicated id in the incoming list does not abort the write', () => {
  const doc = appstate.get();
  appstate.setSection('tasks', doc.tasks.concat(doc.tasks[0]));
  assert.equal(appstate.get().tasks.length, doc.tasks.length);
});

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`tasks-write: ${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);

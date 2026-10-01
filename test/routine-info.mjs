// A routine block's room and teacher — appstate's routine section and the
// migration that adds the two columns to an older table. Throwaway database.
// Run: node test/routine-info.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(path.join(os.tmpdir(), 'kacey-routine-'));
process.env.KLAUS_DB = path.join(dir, 'test.db');
process.env.KACEY_STATE_PATH = path.join(dir, 'no-such-file.json');

/* The routine table as it was before rooms and teachers. */
{
  const old = new DatabaseSync(process.env.KLAUS_DB);
  old.exec(`CREATE TABLE kacey_routine_block (
    day INTEGER NOT NULL CHECK (day BETWEEN 0 AND 6), slot INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 95),
    category TEXT NOT NULL, note TEXT, PRIMARY KEY (day, slot))`);
  old.prepare("INSERT INTO kacey_routine_block VALUES (0, 37, 'study', 'Stará hodina')").run();
  old.close();
}

const appstate = await import('../appstate.js');
const db = await import('../db.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.stack}`); process.exitCode = 1; }
}

test('an older table gains the columns and keeps its rows', () => {
  const cols = db.open().prepare('PRAGMA table_info(kacey_routine_block)').all().map((c) => c.name);
  assert.ok(cols.includes('room') && cols.includes('who'));
  const r = appstate.get().routine;
  assert.equal(r.grid['0-37'], 'study');
  assert.equal(r.notes['0-37'], 'Stará hodina');
  assert.deepEqual(r.info, {});
});

test('room and teacher round-trip, on the block\'s first slot', () => {
  const grid = { '1-37': 'study', '1-38': 'study', '1-39': 'study', '1-40': 'study', '1-41': 'study', '1-42': 'study' };
  appstate.setSection('routine', {
    grid, notes: { '1-37': 'Návrh vestavných systémů' },
    info: { '1-37': { room: 'T2:C2-85', who: 'Fischer J.' } }, wake: 420, sleep: 1350,
  });
  const r = appstate.get().routine;
  assert.deepEqual(r.info, { '1-37': { room: 'T2:C2-85', who: 'Fischer J.' } });
  assert.equal(r.notes['1-37'], 'Návrh vestavných systémů');
});

test('one of the two alone, blanks and junk dropped', () => {
  appstate.setSection('routine', {
    grid: { '2-37': 'study', '3-37': 'study', '4-37': 'study' }, notes: {},
    info: { '2-37': { room: '  KN:E-107 ' }, '3-37': { room: '', who: '   ' }, '4-37': { room: 42, who: { x: 1 } } },
    wake: 420, sleep: 1350,
  });
  assert.deepEqual(appstate.get().routine.info, { '2-37': { room: 'KN:E-107' } });
});

test('info for a slot nobody painted is not stored', () => {
  appstate.setSection('routine', { grid: {}, notes: {}, info: { '5-40': { room: 'X' } }, wake: 420, sleep: 1350 });
  assert.deepEqual(appstate.get().routine.info, {});
});

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`routine-info: ${passed} passed`);

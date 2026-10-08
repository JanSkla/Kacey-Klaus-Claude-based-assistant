// The editable morning checklist — public/js/core/checklist.js and the
// app section `morning` (appstate.js). Throwaway database.
// Run: node test/checklist.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'kacey-checklist-'));
process.env.KLAUS_DB = path.join(dir, 'test.db');
process.env.KACEY_STATE_PATH = path.join(dir, 'no-such-file.json');

const appstate = await import('../appstate.js');
const db = await import('../db.js');
const { normalizeChecklist, itemsFor, pruneOnce, itemsWord } = await import('../public/js/core/checklist.js');
const { freshRecord, historyEntry } = await import('../morningplan.js');
const { MORNING_ITEMS } = await import('../config.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.stack}`); process.exitCode = 1; }
}

test('until edited, the checklist is config\'s MORNING_ITEMS', () => {
  const m = appstate.get().morning;
  assert.deepEqual(m.items.map((i) => i.key), MORNING_ITEMS.map((i) => i.key));
  assert.deepEqual(m.once, []);
});

test('labels trimmed, empties dropped, keys kept, new rows keyed', () => {
  const out = normalizeChecklist({ items: [{ key: 'teeth', label: '  Zuby  ' }, { label: '' }, { label: 'Léky' }], once: [] });
  assert.equal(out.items.length, 2);
  assert.deepEqual(out.items[0], { key: 'teeth', label: 'Zuby' });
  assert.match(out.items[1].key, /^c[0-9a-z]+$/);
});

test('duplicate keys get a fresh one; a one-off needs a date', () => {
  const out = normalizeChecklist({
    items: [{ key: 'a', label: 'X' }, { key: 'a', label: 'Y' }],
    once: [{ label: 'Bez data' }, { label: 'Kytky', date: '2026-10-09', note: 'Kacey přidala' }],
  });
  assert.notEqual(out.items[0].key, out.items[1].key);
  assert.equal(out.once.length, 1);
  assert.equal(out.once[0].note, 'Kacey přidala');
});

test('a date\'s morning: every morning\'s items, then that date\'s one-offs', () => {
  const list = { items: [{ key: 'a', label: 'A' }], once: [{ key: 'o', label: 'O', date: '2026-10-09' }, { key: 'p', label: 'P', date: '2026-10-10' }] };
  assert.deepEqual(itemsFor(list, '2026-10-09').map((i) => i.key), ['a', 'o']);
  assert.equal(itemsFor(list, '2026-10-09')[1].once, true);
  assert.deepEqual(pruneOnce(list, '2026-10-10').once.map((o) => o.key), ['p']);
});

test('the section round-trips and a record carries the one-off mark', () => {
  appstate.setSection('morning', { items: [{ key: 'teeth', label: 'Vyčistit zuby' }], once: [{ label: 'Zalít kytky', date: '2026-10-09' }] });
  const m = appstate.get().morning;
  assert.equal(m.items.length, 1);
  const rec = freshRecord('2026-10-09', itemsFor(m, '2026-10-09'));
  assert.equal(rec.items[1].once, true);
  assert.deepEqual(historyEntry({ ...rec, items: rec.items.map((i) => ({ ...i, done: true })) }).labels,
    { teeth: 'Vyčistit zuby', [m.once[0].key]: 'Zalít kytky' });
});

test('plural', () => {
  assert.equal(itemsWord(1), '1 položka');
  assert.equal(itemsWord(3), '3 položky');
  assert.equal(itemsWord(6), '6 položek');
});

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`checklist: ${passed} passed`);

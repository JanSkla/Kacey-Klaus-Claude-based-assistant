// The routine on concrete dates: overrides (cancel, sick range, add, move,
// reset), overlaps left for Kacey, cementing finished days, and amending them
// — routine-days.js over public/js/core/routine-day.js. Throwaway database.
// Run: node test/routine-days.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'kacey-rdays-'));
process.env.KLAUS_DB = path.join(dir, 'test.db');
process.env.KACEY_STATE_PATH = path.join(dir, 'no-such-file.json');

const appstate = await import('../appstate.js');
const db = await import('../db.js');
const rd = await import('../routine-days.js');
const core = await import('../public/js/core/routine-day.js');
const { previewRules } = await import('../rules.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.stack}`); process.exitCode = 1; }
}

/* A week: work 08–16 Mon–Fri, a run 18–19 Tue/Wed/Fri, gym 17–18:30 Mon/Thu. */
const grid = {}, notes = {};
function paint(day, from, to, cat, note) {
  for (let s = from * 4; s < to * 4; s++) grid[`${day}-${s}`] = cat;
  if (note) notes[`${day}-${from * 4}`] = note;
}
for (const d of [0, 1, 2, 3, 4]) paint(d, 8, 16, 'work');
for (const d of [1, 2, 4]) paint(d, 18, 19, 'gym', 'Běh');
for (const d of [0, 3]) paint(d, 17, 18.5, 'gym', 'Posilovna');
appstate.setSection('routine', { grid, notes, info: {}, wake: 420, sleep: 1350 });

// Wednesday 7. 10. 2026, noon. History began on Monday.
const NOW = new Date(2026, 9, 7, 12, 0);
db.kvSet('routine.history_since', '2026-10-05');

const active = (v) => core.activeBlocks(v).map((b) => `${b.cat}@${b.s}`);
const view = (d, now = NOW) => rd.dayView(d, now);

test('a date with no overrides is its weekday', () => {
  const v = view('2026-10-09');
  assert.equal(v.kind, 'live');
  assert.deepEqual(active(v), ['work@480', 'gym@1080']);
});

test('cancel one block, matched on its range and category', () => {
  const out = rd.alter({ op: 'cancel', date: '2026-10-07', from: '18:00', to: '19:00', category: 'gym', reason: 'nemoc' }, { now: NOW });
  assert.match(out.summary, /zrušeno/);
  const v = view('2026-10-07');
  assert.deepEqual(active(v), ['work@480']);
  const gone = v.blocks.find((b) => b.cat === 'gym');
  assert.equal(gone.state, 'cancelled');
  assert.equal(gone.reason, 'nemoc');
});

test('a cancel that fits no block is refused and writes nothing', () => {
  assert.throws(() => rd.alter({ op: 'cancel', date: '2026-10-07', from: '18:30', to: '19:00' }, { now: NOW }), /Nic se nezměnilo/);
});

test('a cancel whose block was repainted goes stale, kept but not applied', () => {
  rd.alter({ op: 'cancel', date: '2026-10-12', from: '17:00', to: '18:30', category: 'gym' }, { now: NOW });
  const g2 = { ...appstate.get().routine.grid };
  for (let s = 68; s < 76; s++) g2[`0-${s}`] = 'gym';            // Monday gym now 17:00–19:00
  appstate.setSection('routine', { ...appstate.get().routine, grid: g2 });
  const v = view('2026-10-12');
  assert.equal(v.stale.length, 1);
  assert.ok(active(v).includes('gym@1020'));
  appstate.setSection('routine', { grid, notes, info: {}, wake: 420, sleep: 1350 });
  assert.equal(view('2026-10-12').stale.length, 0);
  rd.alter({ op: 'reset', dates: ['2026-10-12'] }, { now: NOW });
});

test('a sick range cancels the chosen categories on every day, as one group', () => {
  const out = rd.alter({ op: 'cancel_range', from_date: '2026-10-08', to_date: '2026-10-09', categories: ['gym'], reason: 'nemoc' }, { now: NOW });
  assert.deepEqual(out.dates, ['2026-10-08', '2026-10-09']);
  assert.deepEqual(active(view('2026-10-08')), ['work@480']);
  assert.deepEqual(active(view('2026-10-09')), ['work@480']);
  const g = appstate.readOverrides('2026-10-08', '2026-10-09');
  assert.equal(new Set(g.map((o) => o.group_id)).size, 1);
  rd.alter({ op: 'reset', group_id: g[0].group_id }, { now: NOW });
  assert.deepEqual(active(view('2026-10-09')), ['work@480', 'gym@1080']);
});

test('an add on top of a default block sits beside it, overlap pending, until kept', () => {
  const out = rd.alter({ op: 'add', date: '2026-10-08', from: '10:00', to: '11:00', category: 'free', note: 'Doktor' }, { now: NOW });
  assert.equal(out.warnings.length, 1);
  let v = view('2026-10-08');
  assert.deepEqual(active(v), ['work@480', 'free@600', 'gym@1020']);
  assert.equal(v.blocks.find((b) => b.cat === 'free').overlap, 'pending');
  rd.alter({ op: 'keep_overlap', id: out.id }, { now: NOW });
  v = view('2026-10-08');
  assert.equal(v.blocks.find((b) => b.cat === 'free').overlap, 'keep');
});

test('move: a cancel and an add in one group, removed together', () => {
  const out = rd.alter({ op: 'move', date: '2026-10-08', from: '17:00', to: '18:30', new_from: '19:00' }, { now: NOW });
  const v = view('2026-10-08');
  assert.ok(v.blocks.some((b) => b.state === 'moved_out' && b.s === 1020));
  const moved = v.blocks.find((b) => b.state === 'moved_in');
  assert.deepEqual([moved.s, moved.e, moved.note], [1140, 1230, 'Posilovna']);
  rd.alter({ op: 'remove', id: out.id }, { now: NOW });
  assert.ok(!view('2026-10-08').blocks.some((b) => b.state === 'moved_in' || b.state === 'moved_out'));
});

test('move only within the same week', () => {
  assert.throws(() => rd.alter({ op: 'move', date: '2026-10-09', from: '18:00', to: '19:00', new_from: '18:00', to_date: '2026-10-12' }, { now: NOW }), /týdne/);
});

test('reset brings a day back to the default', () => {
  rd.alter({ op: 'reset', dates: ['2026-10-08'] }, { now: NOW });
  const v = view('2026-10-08');
  assert.equal(v.altered, false);
  assert.deepEqual(active(v), ['work@480', 'gym@1020']);
});

test('the night run\'s rules see the cancelled block as gone', () => {
  const rule = {
    id: 'r1', name: 'Běh', trigger: { sources: ['routine'], routine_category: 'gym', routine_note_match: ['běh'] },
    timing: { anchor: 'morning_of', at: '07:00' }, task: { label: 'Vzít boty' },
  };
  const items = previewRules({
    rules: [rule], routine: appstate.get().routine,
    from: new Date(2026, 9, 7, 4), to: new Date(2026, 9, 10, 4), now: new Date(2026, 9, 7, 4),
  });
  // Wed is cancelled (above), Fri is not.
  assert.deepEqual(items.map((i) => i.occurrence_date), ['2026-10-09']);
});

test('finished days cement once; the default no longer reaches them', () => {
  const thu = new Date(2026, 9, 8, 4, 30);
  const done = rd.cementDue(thu);
  assert.deepEqual(done, ['2026-10-05', '2026-10-06', '2026-10-07']);
  assert.deepEqual(rd.cementDue(thu), []);
  assert.equal(rd.snapshot('2026-10-07').source, 'rollover');
  assert.equal(rd.snapshot('2026-10-05').source, 'catchup');
  // Repaint Wednesday's default: the cemented Wednesday keeps what it was.
  const g2 = { ...grid };
  for (let s = 32; s < 64; s++) delete g2[`2-${s}`];
  appstate.setSection('routine', { grid: g2, notes, info: {}, wake: 420, sleep: 1350 });
  const v = view('2026-10-07', thu);
  assert.equal(v.kind, 'cemented');
  assert.ok(v.blocks.some((b) => b.cat === 'work'));
  assert.ok(v.blocks.some((b) => b.cat === 'gym' && b.state === 'cancelled' && b.reason === 'nemoc'));
  appstate.setSection('routine', { grid, notes, info: {}, wake: 420, sleep: 1350 });
});

test('a cemented day: the UI is refused, Kacey amends it and can reset it', () => {
  const thu = new Date(2026, 9, 8, 9, 0);
  assert.throws(() => rd.alter({ op: 'cancel', date: '2026-10-06', from: '18:00', to: '19:00' }, { now: thu }),
    (err) => err.status === 409 && /Kacey/.test(err.message));
  rd.alter({ op: 'cancel', date: '2026-10-06', from: '18:00', to: '19:00', reason: 'zapomněl jsem' }, { origin: 'kacey', now: thu });
  let snap = rd.snapshot('2026-10-06');
  assert.ok(snap.amended_at);
  assert.ok(snap.can_undo_amend);
  assert.ok(snap.blocks.some((b) => b.cat === 'gym' && b.state === 'cancelled'));
  rd.alter({ op: 'reset', dates: ['2026-10-06'] }, { origin: 'kacey', now: thu });
  snap = rd.snapshot('2026-10-06');
  assert.ok(snap.blocks.every((b) => b.state === 'template'));
});

test('before the history began there is nothing to change', () => {
  assert.throws(() => rd.alter({ op: 'cancel', date: '2026-10-01' }, { origin: 'kacey', now: NOW }), /historie/);
  assert.equal(view('2026-10-01').kind, 'unrecorded');
});

test('Kacey reads the days with their ids', () => {
  const text = rd.describeDays({ now: new Date(2026, 9, 8, 9, 0) });
  assert.match(text, /\* dnes 2026-10-08/);
  assert.match(text, /2026-10-07 st 7\. 10\. \[zapsáno v historii\]/);
});

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`routine-days: ${passed} passed`);

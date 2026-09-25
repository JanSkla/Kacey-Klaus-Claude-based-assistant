// Morning mode's decisions — morningplan.js, pure, with a fake clock.
// docs/DREAM.md §12. Run: node test/morning.mjs

import assert from 'node:assert/strict';

import {
  peakInstant, freshRecord, withProposals, allDone, morningStep, historyEntry,
  REFRESH_BEFORE_MIN, LATE_LIMIT_MIN,
} from '../morningplan.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.message}`); process.exitCode = 1; }
}

const D = '2026-10-01';
const at = (h, m = 0) => new Date(2026, 9, 1, h, m);
const ITEMS = [{ key: 'teeth', label: 'Vyčistit zuby' }, { key: 'shower', label: 'Sprcha' }];
const PEAK = at(7, 0);

test('the peak is lightsd\'s HH:MM on the planned date', () => {
  assert.equal(peakInstant(D, '07:00').getTime(), PEAK.getTime());
  assert.equal(peakInstant(D, 'nonsense'), null);
});

test('a fresh record is pending, nothing ticked', () => {
  const r = freshRecord(D, ITEMS);
  assert.equal(r.state, 'pending');
  assert.deepEqual(r.items.map((i) => [i.key, i.done]), [['teeth', false], ['shower', false]]);
});

test('pending: nothing, then the T−5 check, then the morning', () => {
  const r = freshRecord(D, ITEMS);
  assert.deepEqual(morningStep(r, at(6, 54), { peak: PEAK }), {});
  assert.deepEqual(morningStep(r, at(7, 0 - REFRESH_BEFORE_MIN), { peak: PEAK }), { refresh: true });
  assert.deepEqual(morningStep({ ...r, refresh_checked: true }, at(6, 57), { peak: PEAK }), {}, 'checked once');
  assert.deepEqual(morningStep(r, at(7, 0), { peak: PEAK }), { fire: true });
  assert.deepEqual(morningStep(r, at(8, 30), { peak: PEAK }), { fire: true }, 'a restart at 08:30 still plays');
});

test('a peak more than two hours ago is missed, not played', () => {
  const r = freshRecord(D, ITEMS);
  assert.deepEqual(morningStep(r, new Date(PEAK.getTime() + LATE_LIMIT_MIN * 60000), { peak: PEAK }), { end: 'missed' });
});

test('no peak known: nothing happens by itself', () => {
  assert.deepEqual(morningStep(freshRecord(D, ITEMS), at(7, 30), { peak: null }), {});
});

test('the proposals item appears only when some are waiting', () => {
  assert.equal(withProposals(ITEMS, { pending: 0, total: 0 }).length, 2);
  const list = withProposals(ITEMS, { pending: 3, total: 3 });
  const p = list.find((i) => i.key === 'proposals');
  assert.equal(p.label, 'Projít návrhy od Kacey (3)');
  assert.equal(p.done, false);
  assert.equal(p.auto, true);
});

test('it counts down and ticks itself when none are left', () => {
  let list = withProposals(ITEMS, { pending: 3, total: 3 }, at(7, 1));
  list = withProposals(list, { pending: 1, total: 3 }, at(7, 5));
  assert.equal(list.find((i) => i.key === 'proposals').done, false);
  list = withProposals(list, { pending: 0, total: 3 }, at(7, 9));
  const p = list.find((i) => i.key === 'proposals');
  assert.equal(p.done, true);
  assert.equal(p.label, 'Projít návrhy od Kacey (3)', 'the count stays what it was');
  assert.equal(p.done_at, at(7, 9).toISOString());
});

test('active: every item ticked ends it as done', () => {
  const r = { ...freshRecord(D, ITEMS), state: 'active' };
  assert.deepEqual(morningStep(r, at(7, 20), {}), {});
  r.items = r.items.map((i) => ({ ...i, done: true }));
  assert.equal(allDone(r.items), true);
  assert.deepEqual(morningStep(r, at(7, 20), {}), { end: 'done' });
});

test('09:00 with nobody touching it ends it; a touch makes it wait', () => {
  const r = { ...freshRecord(D, ITEMS), state: 'active' };
  assert.deepEqual(morningStep(r, at(8, 59), { morningEnd: '09:00' }), {});
  assert.deepEqual(morningStep(r, at(9, 0), { morningEnd: '09:00' }), { end: 'timeout' });
  assert.deepEqual(morningStep({ ...r, last_interaction_at: at(7, 10).toISOString() }, at(11, 0), { morningEnd: '09:00' }), {});
  assert.deepEqual(morningStep(r, at(9, 20), { morningEnd: '09:30' }), {}, 'the end is a setting');
});

test('the history entry says what was done and how long it took', () => {
  const r = {
    ...freshRecord(D, ITEMS), state: 'done', end_reason: 'done', delivered: true,
    started_at: at(7, 0).toISOString(), ended_at: at(7, 39).toISOString(),
  };
  r.items[0].done = true;
  const h = historyEntry(r);
  assert.deepEqual(h.done, ['teeth']);
  assert.equal(h.total, 2);
  assert.equal(h.minutes, 39);
  assert.equal(h.completed_at, at(7, 39).toISOString());
  assert.equal(historyEntry({ ...r, end_reason: 'timeout' }).completed_at, null);
});

console.log(`morning: ${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);

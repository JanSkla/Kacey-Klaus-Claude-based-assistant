// lightsd statuses -> sleep events: diffLightsd() in lightsd.js.
// The table it implements is docs/DREAM.md §5. Run: node test/lightsd-diff.mjs

import assert from 'node:assert/strict';

import { diffLightsd } from '../lightsd.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.message}`); process.exitCode = 1; }
}

const NOW = new Date(2026, 8, 25, 23, 30);
const ago = (sec) => new Date(NOW.getTime() - sec * 1000).toISOString();

const awakeRoom = { sleep: null, wake_at: '06:30' };
const dark = (held_for, minutes_until_wake = 420) => ({
  sleep: { wake_at: '06:30', held_for, minutes_until_wake }, wake_at: '06:30',
});
const kacey = (state, since = ago(3600)) => ({ state, since });
const ctx = (sleep = kacey('awake')) => ({ now: NOW, sleep });

test('the button: no sleep -> sleep is sleep_start, dated by held_for', () => {
  assert.deepEqual(diffLightsd(awakeRoom, dark(0.4), ctx()), [{ type: 'sleep_start', since: ago(0.4) }]);
});

test('awake early: sleep vanishes long before wake_at', () => {
  assert.deepEqual(diffLightsd(dark(1200, 300), awakeRoom, ctx(kacey('asleep'))), [{ type: 'awake_early' }]);
});

test('sunrise: sleep vanishes at wake_at', () => {
  assert.deepEqual(diffLightsd(dark(25000, 0), awakeRoom, ctx(kacey('asleep'))), [{ type: 'sunrise' }]);
  assert.deepEqual(diffLightsd(dark(25000, 1.8), awakeRoom, ctx(kacey('asleep'))), [{ type: 'sunrise' }]);
});

test('nothing changed, nothing happens', () => {
  assert.deepEqual(diffLightsd(awakeRoom, awakeRoom, ctx()), []);
  assert.deepEqual(diffLightsd(dark(10), dark(10.2), ctx(kacey('winding_down'))), []);
});

test('pressed again while dark: a fresh sleep_start', () => {
  assert.deepEqual(diffLightsd(dark(900), dark(0.2), ctx(kacey('winding_down'))), [{ type: 'sleep_start', since: ago(0.2) }]);
});

test('after a reconnect a vanished sleep is NOT an interaction', () => {
  // lightsd restarted at 02:00 and forgot its sleep; Kacey's night goes on.
  assert.deepEqual(diffLightsd(null, awakeRoom, ctx(kacey('asleep'))), []);
});

test('after a reconnect, a press Kacey missed is taken, backdated', () => {
  assert.deepEqual(diffLightsd(null, dark(600), ctx(kacey('awake', ago(7200)))), [{ type: 'sleep_start', since: ago(600) }]);
});

test('...unless the owner interacted after that press', () => {
  assert.deepEqual(diffLightsd(null, dark(600), ctx(kacey('awake', ago(120)))), []);
});

test('...and not when Kacey already knows about the night', () => {
  assert.deepEqual(diffLightsd(null, dark(600), ctx(kacey('winding_down'))), []);
  assert.deepEqual(diffLightsd(null, dark(6000), ctx(kacey('asleep'))), []);
});

test('an unreadable minutes_until_wake falls to sunrise, the harmless side', () => {
  const odd = { sleep: { held_for: 100 } };
  assert.deepEqual(diffLightsd(odd, awakeRoom, ctx(kacey('asleep'))), [{ type: 'sunrise' }]);
});

console.log(`lightsd-diff: ${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);

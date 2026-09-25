// Sleep detection — the pure state machine in sleep.js, driven by a fake clock.
// No database, no timers, no lightsd: every instant is a Date built here.
// Run: node test/sleep.mjs

import assert from 'node:assert/strict';

import {
  sleepStep, normalizeSleep, initialSleep, targetDate, fallbackDue, clockMinutes,
} from '../sleep.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.message}`); process.exitCode = 1; }
}

/* The fake clock: local wall time, the way the host sees it. */
const at = (y, mo, d, h, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s);
const plus = (date, minutes) => new Date(date.getTime() + minutes * 60000);

const SETTINGS = { sleep_delay_min: 60, fallback: '04:00', enabled: true };
const EVENING = at(2026, 9, 25, 23, 0);

/** Run a list of [event, when] through the machine, like night.js does. */
function run(steps, start = initialSleep(plus(EVENING, -600))) {
  let state = start;
  const effects = [];
  for (const [event, when] of steps) {
    const out = sleepStep(state, event, when, SETTINGS);
    state = out.state;
    effects.push(...out.effects.map((e) => ({ ...e, seen: when })));
  }
  return { state, effects };
}

const press = { type: 'sleep_start' };
const tick = { type: 'tick' };

/* ---- the button and the hour ------------------------------------------- */

test('the button starts winding down and turns the screen off', () => {
  const { state, effects } = run([[press, EVENING]]);
  assert.equal(state.state, 'winding_down');
  assert.equal(state.since, EVENING.toISOString());
  assert.equal(state.until, plus(EVENING, 60).toISOString());
  assert.deepEqual(effects.map((e) => e.type), ['screen_off']);
});

test('an hour of nothing means asleep, and the night run starts', () => {
  const { state, effects } = run([
    [press, EVENING],
    [tick, plus(EVENING, 30)],
    [tick, plus(EVENING, 59.9)],
    [tick, plus(EVENING, 60.3)],
  ]);
  assert.equal(state.state, 'asleep');
  assert.deepEqual(effects.map((e) => e.type), ['screen_off', 'start_run']);
  assert.equal(effects[1].trigger, 'sleep');
  assert.equal(effects[1].at, plus(EVENING, 60).toISOString(), 'the run is dated by the deadline');
});

test('a run started by a late tick still plans the day of the deadline', () => {
  // Asleep at 11:59:30, the tick lands at 12:00:10: the target is the day of the deadline.
  const press1059 = at(2026, 9, 26, 10, 59, 30);
  const { effects } = run([[press, press1059], [tick, at(2026, 9, 26, 12, 0, 10)]]);
  assert.equal(targetDate(new Date(effects[1].at)), '2026-09-26');
});

test('asleep is recorded at the deadline, not at the late tick', () => {
  const { state } = run([[press, EVENING], [tick, plus(EVENING, 60.49)]]);
  assert.equal(state.since, plus(EVENING, 60).toISOString());
});

test('a restart long past the deadline still records the deadline', () => {
  // Kacey was down from 23:10 to 01:30; the stored state comes back as it was.
  const stored = JSON.parse(JSON.stringify(run([[press, EVENING]]).state));
  const { state, effects } = run([[tick, plus(EVENING, 150)]], normalizeSleep(stored, plus(EVENING, 150)));
  assert.equal(state.state, 'asleep');
  assert.equal(state.since, plus(EVENING, 60).toISOString());
  assert.equal(effects[0].type, 'start_run');
});

test('a tick with nothing to do returns the same object', () => {
  const start = run([[press, EVENING]]).state;
  const out = sleepStep(start, tick, plus(EVENING, 10), SETTINGS);
  assert.equal(out.state, start);
  assert.deepEqual(out.effects, []);
});

test('the delay comes from the settings', () => {
  const out = sleepStep(initialSleep(EVENING), press, EVENING, { sleep_delay_min: 2 });
  assert.equal(out.state.until, plus(EVENING, 2).toISOString());
});

/* ---- interaction cancels ----------------------------------------------- */

test('an interaction while winding down cancels it', () => {
  const { state, effects } = run([
    [press, EVENING],
    [{ type: 'interaction', kind: 'pointer' }, plus(EVENING, 20)],
    [tick, plus(EVENING, 61)],
    [tick, plus(EVENING, 180)],
  ]);
  assert.equal(state.state, 'awake');
  assert.equal(state.reason, 'interaction');
  assert.ok(!effects.some((e) => e.type === 'start_run'), 'no run after a cancelled wind-down');
});

test('the next press after an interaction starts a fresh hour', () => {
  const second = plus(EVENING, 25);
  const { state } = run([
    [press, EVENING],
    [{ type: 'interaction', kind: 'wake' }, plus(EVENING, 20)],
    [press, second],
    [tick, plus(EVENING, 61)],
  ]);
  assert.equal(state.state, 'winding_down');
  assert.equal(state.until, plus(second, 60).toISOString());
});

test('pressing again while winding down restarts the hour', () => {
  const { state } = run([[press, EVENING], [press, plus(EVENING, 40)], [tick, plus(EVENING, 70)]]);
  assert.equal(state.state, 'winding_down');
  assert.equal(state.until, plus(EVENING, 100).toISOString());
});

test('awake early in lightsd counts as an interaction', () => {
  const { state } = run([[press, EVENING], [{ type: 'awake_early' }, plus(EVENING, 5)]]);
  assert.equal(state.state, 'awake');
  assert.equal(state.reason, 'interaction');
});

test('an interaction while asleep wakes the state, but emits no second run', () => {
  const { state, effects } = run([
    [press, EVENING],
    [tick, plus(EVENING, 61)],
    [{ type: 'interaction', kind: 'wake' }, plus(EVENING, 200)],
  ]);
  assert.equal(state.state, 'awake');
  assert.equal(effects.filter((e) => e.type === 'start_run').length, 1);
});

test('an interaction while awake changes nothing', () => {
  const start = initialSleep(EVENING);
  assert.equal(sleepStep(start, { type: 'interaction', kind: 'key' }, EVENING, SETTINGS).state, start);
});

/* ---- the morning -------------------------------------------------------- */

test('the sunrise ends the night, and it is not an interaction', () => {
  const { state } = run([[press, EVENING], [tick, plus(EVENING, 61)], [{ type: 'sunrise' }, at(2026, 9, 26, 6, 30)]]);
  assert.equal(state.state, 'awake');
  assert.equal(state.reason, 'sunrise');
});

test('a backdated press (held_for) counts from the press', () => {
  const pressed = plus(EVENING, -50);
  const { state } = run([[{ type: 'sleep_start', since: pressed.toISOString() }, EVENING], [tick, plus(EVENING, 10.2)]]);
  assert.equal(state.state, 'asleep');
  assert.equal(state.since, plus(pressed, 60).toISOString());
});

test('a press cannot be dated in the future', () => {
  const out = sleepStep(initialSleep(EVENING), { type: 'sleep_start', since: plus(EVENING, 90).toISOString() }, EVENING, SETTINGS);
  assert.equal(out.state.since, EVENING.toISOString());
});

/* ---- stored state ------------------------------------------------------- */

test('a stored state survives a JSON round trip', () => {
  const s = run([[press, EVENING]]).state;
  assert.deepEqual(normalizeSleep(JSON.parse(JSON.stringify(s)), EVENING), s);
});

test('garbage in storage means awake, never asleep', () => {
  for (const bad of [null, 'asleep', {}, { state: 'dreaming', since: EVENING.toISOString() },
    { state: 'asleep', since: 'yesterday' }, { state: 'winding_down', since: EVENING.toISOString() }]) {
    assert.equal(normalizeSleep(bad, EVENING).state, 'awake', JSON.stringify(bad));
  }
});

/* ---- which day a run is for (docs/DREAM.md §4) ------------------------- */

test('targetDate follows the noon rule', () => {
  const cases = [
    [at(2026, 9, 25, 23, 50), '2026-09-26'],   // Fri evening, sleep
    [at(2026, 9, 26, 2, 10), '2026-09-26'],    // after midnight, still Friday's logical day
    [at(2026, 9, 26, 3, 59), '2026-09-26'],
    [at(2026, 9, 26, 4, 0), '2026-09-26'],     // the fallback
    [at(2026, 9, 26, 5, 30), '2026-09-26'],    // catch-up
    [at(2026, 9, 26, 11, 59), '2026-09-26'],
    [at(2026, 9, 26, 12, 0), '2026-09-27'],    // from noon: tomorrow
    [at(2026, 9, 26, 15, 0), '2026-09-27'],    // manual
    [at(2026, 12, 31, 23, 30), '2027-01-01'],  // year end
  ];
  for (const [when, want] of cases) assert.equal(targetDate(when), want, when.toString());
});

test('targetDate across the autumn DST change (2026-10-25)', () => {
  assert.equal(targetDate(at(2026, 10, 24, 23, 30)), '2026-10-25');
  assert.equal(targetDate(at(2026, 10, 25, 2, 30)), '2026-10-25');
  assert.equal(targetDate(at(2026, 10, 25, 4, 0)), '2026-10-25');
});

test('targetDate across the spring DST change (2027-03-28)', () => {
  assert.equal(targetDate(at(2027, 3, 27, 23, 30)), '2027-03-28');
  assert.equal(targetDate(at(2027, 3, 28, 1, 30)), '2027-03-28');
  assert.equal(targetDate(at(2027, 3, 28, 4, 0)), '2027-03-28');
});

test('the sleep trigger and the fallback name the same day', () => {
  assert.equal(targetDate(at(2026, 9, 25, 23, 50)), targetDate(at(2026, 9, 26, 4, 0)));
});

/* ---- the 04:00 fallback ------------------------------------------------- */

test('the fallback fires from 04:00 when nothing ran', () => {
  assert.equal(fallbackDue(at(2026, 9, 26, 3, 59), SETTINGS, null), false);
  assert.equal(fallbackDue(at(2026, 9, 26, 4, 0), SETTINGS, null), true);
  assert.equal(fallbackDue(at(2026, 9, 26, 4, 0, 30), SETTINGS, '2026-09-25'), true);
});

test('the fallback does not repeat a run for the same target date', () => {
  // The sleep trigger at 00:40 already ran for Saturday.
  assert.equal(fallbackDue(at(2026, 9, 26, 4, 0), SETTINGS, '2026-09-26'), false);
});

test('the fallback window is an hour: a restart at 04:20 still counts', () => {
  assert.equal(fallbackDue(at(2026, 9, 26, 4, 20), SETTINGS, null), true);
  assert.equal(fallbackDue(at(2026, 9, 26, 4, 59), SETTINGS, null), true);
  assert.equal(fallbackDue(at(2026, 9, 26, 5, 0), SETTINGS, null), false);
});

test('a late boot is not a fallback (that is catch-up, P5)', () => {
  assert.equal(fallbackDue(at(2026, 9, 26, 11, 0), SETTINGS, null), false);
  assert.equal(fallbackDue(at(2026, 9, 26, 12, 0), SETTINGS, null), false);
  assert.equal(fallbackDue(at(2026, 9, 26, 23, 0), SETTINGS, null), false);
});

test('the fallback time is a setting, and the night run can be switched off', () => {
  assert.equal(fallbackDue(at(2026, 9, 26, 3, 0), { fallback: '03:00' }, null), true);
  assert.equal(fallbackDue(at(2026, 9, 26, 2, 59), { fallback: '03:00' }, null), false);
  assert.equal(fallbackDue(at(2026, 9, 26, 4, 0), { ...SETTINGS, enabled: false }, null), false);
  assert.equal(fallbackDue(at(2026, 9, 26, 4, 0), { fallback: 'garbage' }, null), true, 'bad setting falls back to 04:00');
});

test('clockMinutes reads HH:MM and nothing else', () => {
  assert.equal(clockMinutes('04:00'), 240);
  assert.equal(clockMinutes('4:05'), 245);
  assert.equal(clockMinutes('24:00'), null);
  assert.equal(clockMinutes('noon'), null);
});

console.log(`sleep: ${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);

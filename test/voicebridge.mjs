// The music visual's line to Kacey's voice — voicebridge.js, pure, fake clock.
// Run: node test/voicebridge.mjs

import assert from 'node:assert/strict';

import { nextItem, createVoiceBridge, createDucker } from '../voicebridge.js';

let passed = 0;
const pending = [];
function test(name, fn) {
  const run = async () => {
    try { await fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.stack}`); process.exitCode = 1; }
  };
  pending.push(run);
}

const at = (d, h, m = 0) => new Date(2026, 9, d, h, m);
const iso = (d, h, m = 0) => at(d, h, m).toISOString();

/* ---- nextItem -------------------------------------------------------------- */

test('the earliest of events and timed tasks wins', () => {
  const next = nextItem({
    now: at(1, 20),
    events: [{ title: 'Porada', starts_at: iso(2, 9), ends_at: iso(2, 10) }],
    tasks: [{ label: 'Běh', due_at: '2026-10-02T07:30', done: false }],
  });
  assert.equal(next.label, 'zítra 07:30 · Běh');
  assert.equal(next.kind, 'task');
});

test('done tasks, dateless tasks, the past and all-day events are skipped', () => {
  const next = nextItem({
    now: at(1, 20),
    events: [
      { title: 'Svátek', starts_at: iso(2, 0), ends_at: iso(3, 0) },
      { title: 'Ráno', starts_at: iso(1, 8), ends_at: iso(1, 9) },
      { title: 'Kino', starts_at: iso(1, 21), ends_at: iso(1, 23) },
    ],
    tasks: [
      { label: 'Hotovo', due_at: '2026-10-01T20:30', done: true },
      { label: 'Bez času', due_at: '2026-10-01', done: false },
    ],
  });
  assert.equal(next.label, 'dnes 21:00 · Kino');
});

test('after midnight, the morning is still "zítra" (the day starts at 04:00)', () => {
  const next = nextItem({ now: at(2, 1), tasks: [{ label: 'Běh', due_at: '2026-10-02T07:30' }] });
  assert.equal(next.day, 'zítra');
});

test('further out it is a weekday; beyond the horizon, nothing', () => {
  // 2026-10-01 is a Thursday; the 3rd is a Saturday.
  const next = nextItem({ now: at(1, 10), tasks: [{ label: 'Trh', due_at: '2026-10-03T09:00' }] });
  assert.equal(next.label, 'so 09:00 · Trh');
  assert.equal(nextItem({ now: at(1, 10), tasks: [{ label: 'Dál', due_at: '2026-10-09T09:00' }] }), null);
  assert.equal(nextItem({ now: at(1, 10) }), null);
});

/* ---- the bridge ------------------------------------------------------------- */

function bridge() {
  const sent = [];
  const b = createVoiceBridge({ send: (key, frame) => sent.push([key, frame.type]) });
  const seen = [];
  b.subscribe((s) => seen.push(s));
  return { b, sent, seen };
}

test('only a kiosk page that can listen is woken', () => {
  const { b, sent } = bridge();
  b.page('phone', { kiosk: false, available: true });
  assert.equal(b.status().available, false);
  assert.equal(b.wake(), false, 'a phone must not start recording from the bedside');
  b.page('kiosk', { kiosk: true, available: true });
  assert.equal(b.status().available, true);
  assert.equal(b.wake(), true);
  assert.deepEqual(sent, [['kiosk', 'voice_wake']]);
});

test('listening and the transcript reach the subscribers', () => {
  const { b, seen } = bridge();
  b.page('kiosk', { kiosk: true, available: true });
  b.listening('kiosk', true, '');
  b.listening('kiosk', true, 'kolik mám zítra');
  assert.deepEqual(b.status(), { available: true, listening: true, transcript: 'kolik mám zítra' });
  b.listening('kiosk', false);
  assert.equal(b.status().listening, false);
  assert.equal(b.status().transcript, '');
  assert.ok(seen.length >= 3);
});

test('a page that closes mid-sentence stops the listening, and the widget hears it', () => {
  const { b } = bridge();
  b.page('kiosk', { kiosk: true, available: true });
  b.listening('kiosk', true, 'ahoj');
  b.drop('kiosk');
  assert.deepEqual(b.status(), { available: false, listening: false, transcript: '' });
});

test('stop goes to the page that is listening, and only when one is', () => {
  const { b, sent } = bridge();
  b.page('kiosk', { kiosk: true, available: true });
  assert.equal(b.stop(), false);
  b.listening('kiosk', true);
  assert.equal(b.stop(), true);
  assert.deepEqual(sent.at(-1), ['kiosk', 'voice_stop']);
});

/* ---- ducking ---------------------------------------------------------------- */

function fakeNowplaying(initial) {
  const state = { playing: true, volume_percent: initial };
  const posts = [];
  const fetchImpl = async (url, opts = {}) => {
    if (opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      posts.push(body.percent);
      state.volume_percent = body.percent;
    }
    return { ok: true, json: async () => ({ ...state }) };
  };
  return { state, posts, fetchImpl };
}

function manualTimers() {
  const timers = [];
  return {
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: (id) => { timers[id - 1] = null; },
    fire: async () => { const fns = timers.splice(0); for (const fn of fns) if (fn) fn(); },
  };
}

test('listening ducks to 20 %, and the volume comes back after the answer', async () => {
  const np = fakeNowplaying(64);
  const clock = manualTimers();
  const d = createDucker({ url: 'http://np', fetchImpl: np.fetchImpl, ...clock });
  await d.update({ listening: true });
  assert.deepEqual(np.posts, [20]);
  await d.update({ listening: false, speaking: true });   // she answers: stays down
  await clock.fire();
  assert.deepEqual(np.posts, [20]);
  await d.update({ speaking: false });
  await clock.fire();
  await d.update({});                                      // let the queue drain
  assert.deepEqual(np.posts, [20, 64]);
});

test('a volume changed by hand while ducked is left alone', async () => {
  const np = fakeNowplaying(70);
  const clock = manualTimers();
  const d = createDucker({ url: 'http://np', fetchImpl: np.fetchImpl, ...clock });
  await d.update({ listening: true });
  np.state.volume_percent = 45;                            // someone pressed +/−
  await d.update({ listening: false });
  await clock.fire();
  await d.update({});
  assert.deepEqual(np.posts, [20]);
});

test('nothing playing, or already quiet: no ducking at all', async () => {
  const quiet = fakeNowplaying(15);
  const d1 = createDucker({ url: 'http://np', fetchImpl: quiet.fetchImpl, ...manualTimers() });
  await d1.update({ listening: true });
  assert.deepEqual(quiet.posts, []);
  const paused = fakeNowplaying(60);
  paused.state.playing = false;
  const d2 = createDucker({ url: 'http://np', fetchImpl: paused.fetchImpl, ...manualTimers() });
  await d2.update({ listening: true });
  assert.deepEqual(paused.posts, []);
});

test('nowplayingd being down is logged, never thrown', async () => {
  const logs = [];
  const d = createDucker({ url: 'http://np', log: (m) => logs.push(m), ...manualTimers(),
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await d.update({ listening: true });
  assert.match(logs[0], /ECONNREFUSED/);
  assert.equal(d.ducked, false);
});

for (const run of pending) await run();
console.log(`voicebridge: ${passed} passed`);

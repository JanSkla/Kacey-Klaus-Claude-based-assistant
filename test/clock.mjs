// Which day it is, kept current — public/js/core/clock.js (the day watcher and
// what wakes it), due.js dayWords / turnClock (the date in words, and the line
// every one of Kacey's turns carries), and store.js load / reloadIfIdle saying
// whether the document really came back (a new day offline).
// No browser: the page's timers, events and fetch are stand-ins.
// Run: node test/clock.mjs

import assert from 'node:assert/strict';

/* ---- a page, enough of one ------------------------------------------------ */

const RealDate = Date;
let nowMs = new RealDate(2026, 9, 14, 22, 0).getTime();   // Wed 14 Oct, 22:00
class FakeDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [nowMs])); }
  static now() { return nowMs; }
}
globalThis.Date = FakeDate;

const listeners = {};
const target = (name) => ({
  addEventListener(type, fn) { (listeners[name + ':' + type] ||= []).push(fn); },
});
const fire = (name, type) => (listeners[name + ':' + type] || []).forEach((fn) => fn());
globalThis.document = { ...target('document'), hidden: false, getElementById: () => null };
globalThis.window = target('window');

let tick = null;
globalThis.setInterval = (fn) => { tick = fn; return 1; };

const bus = await import('../public/js/core/bus.js');
const clock = await import('../public/js/core/clock.js');
const due = await import('../public/js/core/due.js');
const store = await import('../public/js/core/store.js');

const heard = [];
bus.on('day', (d) => heard.push(['day', d.from, d.to, d.reason]));
bus.on('clock', (c) => heard.push(['clock', c.day, c.reason]));
const at = (h, m = 0, d = 14) => { nowMs = new RealDate(2026, 9, d, h, m).getTime(); };

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (err) { console.error(`FAIL ${name}\n  ${err.stack}`); process.exitCode = 1; }
}

/* ---- the date in words ---------------------------------------------------- */

await test('dayWords says the date in three lengths', () => {
  assert.equal(due.dayWords('2026-10-15'), 'čtvrtek 15. října');
  assert.equal(due.dayWords('2026-10-15', 'medium'), 'čt 15. října');
  assert.equal(due.dayWords('2026-10-15', 'short'), 'čt 15. 10.');
  assert.equal(due.dayWords('2026-03-01'), 'neděle 1. března');
});

await test('turnClock gives the logical day: at 01:30 it is still yesterday', () => {
  const late = new RealDate(2026, 9, 16, 1, 30);
  assert.equal(due.turnClock(late, 4), 'Teď je čtvrtek 15. října (2026-10-15), 01:30.');
  const morning = new RealDate(2026, 9, 16, 9, 5);
  assert.equal(due.turnClock(morning, 4), 'Teď je pátek 16. října (2026-10-16), 09:05.');
});

/* ---- the watcher ---------------------------------------------------------- */

clock.initClock();

await test('the page starts on the logical day, and says nothing', () => {
  assert.equal(clock.today(), '2026-10-14');
  assert.deepEqual(heard, []);
});

/* The page awake: a tick every 30 s up to the given time. */
function walkTo(h, m, d) {
  const end = new RealDate(2026, 9, d, h, m).getTime();
  while (nowMs < end) { nowMs = Math.min(end, nowMs + 30000); tick(); }
}

await test('midnight is not the new day; 04:00 is, on the tick that crosses it', () => {
  walkTo(0, 30, 15);
  walkTo(3, 59, 15);
  assert.equal(clock.today(), '2026-10-14');
  assert.deepEqual(heard, []);                         // ticks on a page awake say nothing
  walkTo(4, 0, 15);
  assert.equal(clock.today(), '2026-10-15');
  assert.deepEqual(heard, [['day', '2026-10-14', '2026-10-15', 'tick'], ['clock', true, 'tick']]);
  heard.length = 0;
  walkTo(4, 30, 15);
  assert.deepEqual(heard, []);
});

await test('a tick far too late is a device waking up, the whole night skipped', () => {
  at(9, 0, 16);             // slept from 04:00 Thursday to 09:00 Friday
  tick();
  assert.equal(clock.today(), '2026-10-16');
  assert.deepEqual(heard, [['day', '2026-10-15', '2026-10-16', 'wake'], ['clock', true, 'wake']]);
  heard.length = 0;
});

await test('shown again: the day is checked at once, before any tick', () => {
  at(10, 0, 17);
  document.hidden = true; fire('document', 'visibilitychange');
  assert.deepEqual(heard, []);                         // going hidden says nothing
  document.hidden = false; fire('document', 'visibilitychange');
  assert.deepEqual(heard, [['day', '2026-10-16', '2026-10-17', 'visible'], ['clock', true, 'visible']]);
  heard.length = 0;
});

await test('the Android app resuming, focus, pageshow and online all check', () => {
  for (const [name, type, reason] of [
    ['window', 'kacey-resume', 'resume'], ['window', 'focus', 'focus'],
    ['window', 'pageshow', 'pageshow'], ['window', 'online', 'online'],
  ]) {
    fire(name, type);
    assert.deepEqual(heard.pop(), ['clock', false, reason], type);   // same day: only 'clock'
  }
  at(4, 1, 18);
  fire('window', 'kacey-resume');
  assert.deepEqual(heard, [['day', '2026-10-17', '2026-10-18', 'resume'], ['clock', true, 'resume']]);
  heard.length = 0;
});

await test('checkDay reports a move once', () => {
  assert.equal(clock.checkDay('tick', new RealDate(2026, 9, 19, 12)), true);
  assert.equal(clock.checkDay('tick', new RealDate(2026, 9, 19, 13)), false);
  assert.equal(clock.today(), '2026-10-19');
  heard.length = 0;
});

/* ---- the document, reloaded for the new day ------------------------------- */

await test('load says whether the server answered', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ tasks: [{ id: 't1', label: 'Nový' }] }) });
  assert.equal(await store.load(), true);
  assert.equal(store.data.tasks[0].label, 'Nový');
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal(await store.reloadIfIdle(), false);     // offline: keeps what it had
  assert.equal(store.data.tasks[0].label, 'Nový');
  globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
  assert.equal(await store.load(), false);
});

globalThis.Date = RealDate;
console.log(`clock: ${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);

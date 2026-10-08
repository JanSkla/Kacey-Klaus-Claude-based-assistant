// Weather for the morning (weather.js): the summary in words, and the fetch
// with a fake network. Never the real one.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'kacey-weather-'));
process.env.KLAUS_DB = path.join(dir, 'test.db');
process.env.KACEY_STATE_PATH = path.join(dir, 'no-such-file.json');

const { summarize, weatherFor, weatherKept, weatherLine } = await import('../weather.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (err) { process.exitCode = 1; console.error(`FAIL ${name}\n  ${err.message}`); }
}

const D = '2026-09-24';
/** 24 hours of Open-Meteo hourly data; `codes(h)` gives the weather code at hour h. */
function hourly(codes, temp = (h) => 8 + h / 4) {
  const time = [], weather_code = [], temperature_2m = [];
  for (let h = 0; h < 24; h++) {
    time.push(`${D}T${String(h).padStart(2, '0')}:00`);
    weather_code.push(codes(h));
    temperature_2m.push(temp(h));
  }
  return { time, weather_code, temperature_2m };
}

await test('showers only in the afternoon say when', () => {
  const w = summarize(hourly((h) => (h >= 13 && h < 17 ? 80 : 2), () => 10.6), D);
  assert.deepEqual(w, { temp_c: 11, summary_day: 'odpoledne přeháňky', summary_short: 'přeháňky' });
  assert.equal(weatherLine(w), '11 °C, odpoledne přeháňky');
});

await test('rain all day, or a dry day, has no time of day', () => {
  assert.equal(summarize(hourly(() => 63), D).summary_day, 'déšť');
  assert.equal(summarize(hourly((h) => (h < 12 ? 0 : 3)), D).summary_day, 'zataženo');
});

await test('no data for the date is no weather', () => {
  assert.equal(summarize(hourly(() => 0), '2026-09-25'), null);
  assert.equal(summarize(null, D), null);
});

await test('fetched once, kept, and the kept one answers when the network fails', async () => {
  let url = '';
  const ok = async (u) => { url = u; return { ok: true, json: async () => ({ hourly: hourly(() => 1) }) }; };
  const w = await weatherFor(D, { fetchImpl: ok });
  assert.equal(w.summary_day, 'polojasno');
  assert.match(url, /latitude=50\.08&longitude=14\.42/);
  assert.match(url, /start_date=2026-09-24&end_date=2026-09-24/);
  assert.equal(weatherKept(D).summary_day, 'polojasno');
  const down = async () => { throw new Error('fetch failed'); };
  assert.equal((await weatherFor(D, { fetchImpl: down })).summary_day, 'polojasno');
  assert.equal(await weatherFor('2026-09-30', { fetchImpl: down }), null);
});

await test('KACEY_WEATHER=off never fetches', async () => {
  process.env.KACEY_WEATHER = 'off';
  let called = false;
  assert.equal(await weatherFor(D, { fetchImpl: async () => { called = true; } }), null);
  assert.equal(called, false);
  delete process.env.KACEY_WEATHER;
});

try { rmSync(dir, { recursive: true, force: true }); } catch { /* the db may still be open on Windows */ }
console.log(`weather: ${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);

/* =========================================================================
   WEATHER FOR THE MORNING — Open-Meteo, no key.

   The morning's date line says it ("Středa 24. září · 11 °C, odpoledne
   přeháňky", Claude Design 1a) and the brief may mention it. One fetch per
   logical date, kept in kv `weather.<date>`; the night run asks for it and
   the morning's T−5 rewrite asks again (a newer forecast replaces the old).

   Where: KACEY_WEATHER_LAT / KACEY_WEATHER_LON (Prague by default), and
   KACEY_WEATHER_PLACE for its name in the Brief view ("Praha").
   KACEY_WEATHER=off turns it off — the tests do that, so they never reach
   the network. Read at call time, not import time.

   Everything here fails quietly: no weather is a missing half-line, never
   an error in the morning.
   ========================================================================= */

import { kvGet, kvSet } from './db.js';

const TIMEOUT_MS = 5000;

/* WMO weather codes → Czech, from calmest to roughest. `rank` decides which
   code speaks for a part of the day: the roughest one does. */
const CODES = [
  { max: 0,  rank: 0, word: 'jasno' },
  { max: 2,  rank: 1, word: 'polojasno' },
  { max: 3,  rank: 2, word: 'zataženo' },
  { max: 48, rank: 3, word: 'mlha' },
  { max: 57, rank: 4, word: 'mrholení' },
  { max: 67, rank: 6, word: 'déšť' },
  { max: 77, rank: 7, word: 'sníh' },
  { max: 82, rank: 5, word: 'přeháňky' },
  { max: 86, rank: 7, word: 'sněhové přeháňky' },
  { max: 99, rank: 8, word: 'bouřky' },
];

export function codeWord(code) {
  const c = CODES.find((x) => code <= x.max);
  return c || CODES[CODES.length - 1];
}

const PARTS = [
  { word: 'dopoledne', from: 6, to: 12 },
  { word: 'odpoledne', from: 12, to: 18 },
  { word: 'večer', from: 18, to: 22 },
];

/**
 * The day in a few words, from Open-Meteo's hourly arrays. Pure.
 * Rain (or worse) in only one part of the day says when: "odpoledne
 * přeháňky"; otherwise the roughest weather of the day: "zataženo".
 * `temp_c` is the temperature at 08:00 — what the morning feels like.
 */
export function summarize(hourly, date) {
  const times = hourly?.time || [];
  const codes = hourly?.weather_code || hourly?.weathercode || [];
  const temps = hourly?.temperature_2m || [];
  const at = (h) => times.indexOf(`${date}T${String(h).padStart(2, '0')}:00`);
  const i8 = at(8);
  if (i8 < 0) return null;
  const roughest = (from, to) => {
    let best = null;
    for (let h = from; h < to; h++) {
      const i = at(h);
      if (i < 0 || codes[i] == null) continue;
      const c = codeWord(codes[i]);
      if (!best || c.rank > best.rank) best = c;
    }
    return best;
  };
  const day = roughest(6, 22);
  if (!day) return null;
  let summary = day.word;
  if (day.rank >= 4) {
    const wet = PARTS.filter((p) => { const c = roughest(p.from, p.to); return c && c.rank >= 4; });
    if (wet.length === 1) summary = `${wet[0].word} ${day.word}`;
  }
  const temp = temps[i8];
  return {
    temp_c: typeof temp === 'number' ? Math.round(temp) : null,
    summary_day: summary,
    summary_short: day.word,
  };
}

/** "11 °C, odpoledne přeháňky" — for the brief's input. */
export function weatherLine(w) {
  if (!w) return '';
  return [w.temp_c != null ? `${w.temp_c} °C` : null, w.summary_day].filter(Boolean).join(', ');
}

function enabled() { return String(process.env.KACEY_WEATHER || '').toLowerCase() !== 'off'; }

function place() {
  const lat = Number(process.env.KACEY_WEATHER_LAT || 50.08);
  const lon = Number(process.env.KACEY_WEATHER_LON || 14.42);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

/** The kept forecast for `date`, or null. Never fetches. */
export function weatherKept(date) {
  return kvGet(`weather.${date}`, null);
}

/**
 * Fetch the forecast for `date` and keep it. Answers the kept one when the
 * network fails, null when there is none. `fetchImpl` is for the tests.
 */
export async function weatherFor(date, { fetchImpl = globalThis.fetch } = {}) {
  if (!enabled() || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return null;
  const p = place();
  if (!p || typeof fetchImpl !== 'function') return weatherKept(date);
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${p.lat}&longitude=${p.lon}&hourly=temperature_2m,weather_code`
    + `&timezone=auto&start_date=${date}&end_date=${date}`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const w = summarize((await res.json()).hourly, date);
    if (!w) return weatherKept(date);
    const out = { ...w, place: process.env.KACEY_WEATHER_PLACE || 'Praha', at: new Date().toISOString() };
    kvSet(`weather.${date}`, out);
    return out;
  } catch {
    return weatherKept(date);
  }
}

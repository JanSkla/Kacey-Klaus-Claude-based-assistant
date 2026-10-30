/**
 * Kacey — "Vypnout vše": every lamp lightsd knows goes off, in one press.
 *
 * lightsd owns the lamps; Kacey only reads it (lightsd.js) — with two
 * exceptions, both at the owner's request and both as an ordinary client of
 * lightsd's per-lamp API: the sunrise shift (server.js) and this. The Lights
 * view's button (POST /api/lights/off) and Kacey's app_lights (from the chat
 * or by voice) both come through allOff().
 *
 * The answer is never a guess. After the off calls lightsd's /api/status is
 * read again and what is still lit is what the pages are told, by name — a
 * lamp that ignored the call shows as lit, not as "vypnuto".
 *
 * The last time it ran is kacey_kv `lights.all_off` ({ at, by, off, total,
 * lit }), so every device can say "zhasnuto ve 23:10" and Kacey can answer
 * "kdy jsem zhasínal?". Every run is reported through onEvent(); server.js
 * broadcasts it as a `lights` frame.
 *
 * A preview of a branch shares the running app's lightsd: there the press is
 * only pretended — the lamps stay as they are and the answer says so.
 */

import { kvGet, kvSet, now } from './db.js';
import { LIGHTSD_URL, PREVIEW } from './config.js';

const LIST_MS = 5000;
const OFF_MS = 5000;

let opts = { url: LIGHTSD_URL, preview: PREVIEW, fetch: (...a) => fetch(...a) };
/** Tests point it at a stand-in lightsd. */
export function configure(next) { opts = { ...opts, ...next }; }

let listener = () => {};
export function onEvent(fn) { listener = typeof fn === 'function' ? fn : () => {}; }
function emit(ev) { try { listener(ev); } catch { /* a page went away */ } }

/** A failure the route and the tool can pass on as it is. */
function problem(message, status, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

/** The lamps in a lightsd status: [{ id, name, on }]. */
export function lampsOf(status) {
  return ((status && status.lights) || []).map((l) => ({
    id: String(l.id ?? ''), name: String(l.name || l.id || 'lampa'), on: !!(l.output && l.output.on),
  }));
}

/** How many lamps are lit in a lightsd status. */
export function countLit(status) {
  return lampsOf(status).filter((l) => l.on).length;
}

/** 1 světlo · 2 světla · 5 světel — the Czech the page and Kacey both say. */
export function lampWords(n) {
  return `${n} ${n === 1 ? 'světlo' : n >= 2 && n <= 4 ? 'světla' : 'světel'}`;
}

/** The last "Vypnout vše", or null. */
export function last() {
  const l = kvGet('lights.all_off', null);
  return l && typeof l.at === 'string' ? l : null;
}

async function lightsd(pathname, init = {}, timeout = LIST_MS) {
  const r = await opts.fetch(`${String(opts.url).replace(/\/+$/, '')}${pathname}`, { ...init, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw problem(`lightsd odpověděl ${r.status}`, 502);
  return r.json();
}

/** lightsd's status, read: { lamps, lit, total }. Throws 502 'unreachable'. */
export async function state() {
  let status;
  try { status = await lightsd('/api/status'); } catch (err) {
    throw problem(`lightsd neodpovídá (${err.message})`, 502, 'unreachable');
  }
  const lamps = lampsOf(status);
  return { status, lamps, lit: lamps.filter((l) => l.on).length, total: lamps.length };
}

/**
 * Every lamp off. Resolves with { off, total, lit, still: [names], already,
 * preview, last }: `off` = lamps lightsd accepted the call for, `lit` and
 * `still` = what lightsd shows lit afterwards. Throws 502 'unreachable' when
 * lightsd does not answer, 502 'refused' when it turned none off.
 * `by` = 'owner' | 'kacey', `origin` = the page, which skips its own frame.
 */
export async function allOff({ by = 'owner', origin = '' } = {}) {
  let list;
  try { list = await lightsd('/api/lights'); } catch (err) {
    throw problem(`lightsd neodpovídá (${err.message})`, 502, 'unreachable');
  }
  const ids = ((list && list.lights) || []).map((l) => String(l.id ?? '')).filter(Boolean);
  if (!ids.length) return { off: 0, total: 0, lit: 0, still: [], already: true, preview: !!opts.preview, last: last() };

  if (opts.preview) {
    const st = await state().catch(() => ({ lit: 0, lamps: [] }));
    const out = { off: 0, total: ids.length, lit: st.lit, still: st.lamps.filter((l) => l.on).map((l) => l.name), already: false, preview: true, last: last() };
    emit({ event: 'all_off', by, origin, ...out });
    return out;
  }

  // All at once: one press should feel like one switch, not a walk through the house.
  const results = await Promise.all(ids.map((id) =>
    opts.fetch(`${String(opts.url).replace(/\/+$/, '')}/api/lights/${encodeURIComponent(id)}/off`, {
      method: 'POST', signal: AbortSignal.timeout(OFF_MS),
    }).then((r) => r.ok, () => false)));
  const off = results.filter(Boolean).length;
  if (!off) throw problem('lightsd žádnou lampu nevypnul', 502, 'refused');

  const after = await state().catch(() => null);
  const still = after ? after.lamps.filter((l) => l.on).map((l) => l.name) : [];
  const rec = { at: now(), by, off, total: ids.length, lit: still.length };
  kvSet('lights.all_off', rec);
  const out = { off, total: ids.length, lit: still.length, still, already: false, preview: false, last: rec };
  emit({ event: 'all_off', by, origin, ...out });
  return out;
}

/** What Kacey reads back after allOff(). */
export function describe(out) {
  if (!out.total) return 'lightsd nemá žádnou lampu — není co zhasínat.';
  if (out.preview) return 'Tohle je náhled vylepšení: světla jsem jen naoko zhasla, doopravdy zůstala, jak byla.';
  if (!out.lit) return `Zhasnuto — vypnula jsem ${lampWords(out.off)} ve všech místnostech.`;
  return `Vypnula jsem ${lampWords(out.off)}, ale pořád svítí: ${out.still.join(', ')}. ` +
    'Pán to může zkusit znovu v Ovládání světel nebo přímo v lightsd.';
}

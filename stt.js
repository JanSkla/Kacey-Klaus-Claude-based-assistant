/**
 * Kacey — přepis řeči: which Whisper writes the owner's words down.
 *
 * The page records one utterance and posts it to /api/stt; the sidecar
 * (voicelab/stt_server.py) transcribes it on this machine with Whisper
 * small (the default: on kaceybody's CPU the large encoder takes ~27 s a
 * sentence), large v3 or its turbo variant. It holds one at a time and needs
 * up to a minute to load another, and meanwhile it cannot transcribe.
 *
 * The owner's choice lives here, in kacey_kv `stt.model` — the Controller's
 * Přepis řeči row and Kacey's app_stt both switch through setModel(). The
 * sidecar keeps its own copy (stt_state.json) only so it comes up with the
 * right model without Kacey; when the two disagree (a reinstalled sidecar, a
 * restored database) health() asks the sidecar for the owner's choice, at
 * most once every few minutes and never while the last attempt is the error
 * the sidecar reports.
 *
 * The last transcription — model, how long it took, how long the audio was —
 * is `stt.last`, so every device shows "věta za 2,4 s", not only the one that
 * spoke. Every switch is reported through onEvent(); server.js broadcasts it
 * as an `stt` frame.
 *
 * A preview of a branch shares the running app's sidecar: there switching is
 * only pretended (a few seconds of "loading"), so a draft never changes the
 * model the live app dictates with.
 */

import { kvGet, kvSet, now } from './db.js';
import { STT_URL, PREVIEW } from './config.js';

export const MODELS = ['small', 'large-v3', 'turbo'];
export const NAMES = { small: 'small', 'large-v3': 'large v3', turbo: 'turbo' };
export const DEFAULT = 'small';
const RECONCILE_MS = 5 * 60 * 1000;
const PREVIEW_LOAD_MS = 6000;

let opts = { url: STT_URL, preview: PREVIEW, fetch: (...a) => fetch(...a) };
/** Tests point it at a stand-in sidecar. */
export function configure(next) { opts = { ...opts, ...next }; }

let listener = () => {};
export function onEvent(fn) { listener = typeof fn === 'function' ? fn : () => {}; }
function emit(ev) { try { listener(ev); } catch { /* a page went away */ } }

const pretend = { model: null, until: 0 };
let reconciledAt = 0;

/** A failure the routes and the tool can pass on as it is. */
function problem(message, status, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

/** The owner's choice: small until they pick another. */
export function choice() {
  const m = kvGet('stt.model', null);
  return MODELS.includes(m) ? m : DEFAULT;
}

/** The last utterance Whisper wrote down, or null. */
export function last() {
  const l = kvGet('stt.last', null);
  return l && Number.isFinite(l.seconds) ? l : null;
}

async function sidecar(pathname, init = {}, timeout = 10000) {
  const r = await opts.fetch(`${opts.url}${pathname}`, { ...init, signal: AbortSignal.timeout(timeout) });
  let body = {};
  try { body = await r.json(); } catch { /* not JSON: the status says enough */ }
  return { status: r.status, ok: r.ok, body };
}

/**
 * What the Přepis řeči row shows: { ok, loading, model (held now), choice
 * (the owner's), error, last, preview }. `ok` = ready to transcribe.
 */
export async function health() {
  const want = choice();
  let side;
  try {
    side = (await sidecar('/health')).body || {};
  } catch {
    side = { ok: false, unreachable: true };
  }
  if (opts.preview) {
    if (!pretend.model) pretend.model = want;
    const loading = Date.now() < pretend.until;
    return {
      ok: !!side.ok && !loading, loading, model: pretend.model, choice: pretend.model,
      error: side.unreachable ? '' : String(side.error || ''), unreachable: !!side.unreachable, last: last(), preview: true,
    };
  }
  const out = {
    ok: !!side.ok, loading: !!side.loading, model: MODELS.includes(side.model) ? side.model : null,
    choice: want, error: String(side.error || ''), unreachable: !!side.unreachable, last: last(),
  };
  // Up and holding something else than the owner chose: ask for theirs.
  const drifted = out.ok && !out.loading && out.model && out.model !== want;
  if (drifted && !out.error && Date.now() - reconciledAt > RECONCILE_MS) {
    reconciledAt = Date.now();
    try {
      const r = await sidecar(`/model?name=${encodeURIComponent(want)}`, { method: 'POST' });
      if (r.ok) Object.assign(out, { ok: false, loading: true });
    } catch { /* the next health() tries again in a few minutes */ }
  }
  return out;
}

/**
 * Switch to `name` and remember it. Resolves when the sidecar has started
 * loading (about a minute); health() says when it is ready. `by` = who
 * asked ('user' | 'kacey'), `origin` = the page, which skips its own frame.
 */
export async function setModel(name, { by = 'user', origin = '' } = {}) {
  const model = String(name || '').trim();
  if (!MODELS.includes(model)) throw problem(`Neznámý model „${model}“ — jde large-v3 nebo turbo.`, 400);
  if (opts.preview) {
    if (model !== (pretend.model || choice())) Object.assign(pretend, { model, until: Date.now() + PREVIEW_LOAD_MS });
    emit({ event: 'switch', choice: model, by, origin, preview: true });
    return { choice: model, loading: Date.now() < pretend.until };
  }
  let r;
  try {
    r = await sidecar(`/model?name=${encodeURIComponent(model)}`, { method: 'POST' });
  } catch {
    throw problem('Whisper na kaceybody neběží', 502, 'unreachable');
  }
  if (r.status === 409) throw problem('Whisper právě načítá jiný model — zkus to za minutu', 409, 'busy');
  if (!r.ok) throw problem(r.body.error || `Whisper odpověděl ${r.status}`, 502);
  kvSet('stt.model', model);
  reconciledAt = Date.now();
  emit({ event: 'switch', choice: model, by, origin });
  return { choice: model, loading: !!r.body.loading };
}

/**
 * One utterance to text. `audio` is the page's WAV, `lang` 'cs' / 'cs-CZ'.
 * Throws with code 'loading' while a model loads (503), 'unreachable' when
 * the sidecar is not there.
 */
export async function transcribe(audio, { lang = 'cs', type = 'audio/wav' } = {}) {
  if (!audio || !audio.length) throw problem('žádný zvuk', 400);
  const code = /^[a-z]{2}(-[A-Z]{2})?$/.test(String(lang)) ? String(lang) : 'cs';
  const started = Date.now();
  let r;
  try {
    r = await sidecar(`/transcribe?lang=${encodeURIComponent(code)}`, {
      method: 'POST', headers: { 'Content-Type': type }, body: audio,
    }, 60000);
  } catch (err) {
    throw problem(`Přepis řeči neodpovídá (${err.message})`, 502, 'unreachable');
  }
  if (r.status === 503) throw problem('Přepis řeči načítá model', 503, 'loading');
  if (!r.ok) throw problem(`Přepis řeči selhal (${r.body.error || r.status})`, 502);
  const out = r.body;
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  kvSet('stt.last', {
    model: MODELS.includes(out.model) ? out.model : null, seconds,
    audio_seconds: Number(out.audio_seconds) || 0, at: now(),
  });
  return { ...out, seconds };
}

function secs(n) { return String(Math.round(n * 10) / 10).replace('.', ',') + ' s'; }

/** The state in one Czech line, for Kacey. */
export function describe(h) {
  const want = NAMES[h.choice] || h.choice;
  const held = NAMES[h.model] || h.model;
  const tail = h.last ? ` Poslední věta (${secs(h.last.audio_seconds)} řeči) se přepisovala ${secs(h.last.seconds)}.` : '';
  if (h.unreachable) return `Whisper na kaceybody neběží — diktování teď přepisuje prohlížeč, kde to umí. Vybraný model: ${want}.`;
  if (h.loading) return `Whisper si načítá ${want} — asi minutu, do té doby přepisuje prohlížeč.`;
  if (h.error && h.model) return `Whisper ${want} se nenačetl (${h.error}), přepisuje dál ${held}.${tail}`;
  if (!h.ok) return `Whisper se nenačetl${h.error ? ` (${h.error})` : ''} — diktování teď přepisuje prohlížeč.`;
  return `Přepis řeči běží na Whisper ${held}, na tomhle počítači.${tail}`;
}

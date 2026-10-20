/**
 * Kacey — syncing the calendars, and the owner's answers to invitations.
 *
 * The calendar is klaus_memory's mirror of Google and TimeTree; only its own
 * sync reaches them wholesale. This runs that sync (tools/calendar_sync.py, a
 * short-lived process like calendar_write.py) at two moments: every night,
 * first thing in the night run (dream.js), so the night plans on fresh data,
 * and when the owner presses Synchronizovat on the calendar page.
 *
 * Each run also stores the owner's answer to every invitation it saw
 * (kacey_event_response): an event still waiting for "Ano" in Google
 * (needsAction) or answered "Možná" (tentative) is drawn with a "?". Answer it
 * in Google and the next sync takes the "?" away.
 *
 * The last run — when, by whom, how it went — is kept in kacey_kv
 * (`calendar.sync`) and broadcast as a `calendar_sync` frame.
 *
 * A preview of a kaceyFeature branch never reaches Google: its sync pretends,
 * and its calendar carries sample invitations (sampleRows) to look at.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { open, now, kvGet, kvSet, transact } from './db.js';
import {
  HERE, PYTHON_BIN, KLAUS_DB, KLAUS_CALENDARS, KLAUS_ENV_FILE, KLAUS_MEMORY_PYTHONPATH, PREVIEW,
} from './config.js';

const log = (...a) => console.log('[calsync]', ...a);

export const STATUSES = ['needsAction', 'tentative', 'accepted', 'declined'];
/** Answers that leave the event open — drawn with a "?". */
export const OPEN_ANSWERS = ['needsAction', 'tentative'];

const TIMEOUT_MS = 120000;

let running = null;            // { by, started_at, promise } while a sync runs
let broadcast = () => {};

export function setBroadcast(fn) { if (typeof fn === 'function') broadcast = fn; }

/* ---- the answers --------------------------------------------------------- */

/** event_id -> status, from the last sync. */
export function responseMap() {
  const out = new Map();
  for (const r of open().prepare('SELECT event_id, status FROM kacey_event_response').all()) out.set(r.event_id, r.status);
  return out;
}

/* Google's own field, if klaus_memory kept it in source_meta: the attendee
   marked `self`, or a flat response_status. */
function fromMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const flat = meta.response_status || meta.responseStatus;
  if (STATUSES.includes(flat)) return flat;
  const self = Array.isArray(meta.attendees) ? meta.attendees.find((a) => a && a.self) : null;
  return self && STATUSES.includes(self.responseStatus) ? self.responseStatus : null;
}

/** The owner's answer to this event, or null when it is not an invitation. */
export function responseOf(eventId, meta, map) {
  return (map && map.get(eventId)) || fromMeta(meta) || null;
}

const EVENT_ID_RE = /^ev_[A-Za-z0-9_-]{4,64}$/;

/**
 * Replace the answers with what this sync saw. `responses` null or not an
 * object means the tool could not read them at all: the old answers stay
 * rather than every "?" vanishing on a hiccup. Returns how many were stored,
 * or null when nothing changed.
 */
export function storeResponses(responses) {
  if (!responses || typeof responses !== 'object' || Array.isArray(responses)) return null;
  const at = now();
  return transact((db) => {
    db.prepare('DELETE FROM kacey_event_response').run();
    const ins = db.prepare('INSERT INTO kacey_event_response (event_id, status, synced_at) VALUES (?, ?, ?)');
    let n = 0;
    for (const [id, status] of Object.entries(responses)) {
      if (EVENT_ID_RE.test(id) && STATUSES.includes(status)) { ins.run(id, status, at); n++; }
    }
    return n;
  });
}

/** Forget an answer — the event was deleted. Never throws. */
export function dropResponse(id) {
  try { open().prepare('DELETE FROM kacey_event_response WHERE event_id = ?').run(String(id)); } catch { /* nothing to drop */ }
}

/* ---- the run ------------------------------------------------------------- */

/** The last run, and whether one is going: what the calendar page shows. */
export function syncState() {
  const last = kvGet('calendar.sync', null);
  return {
    last,
    running: running ? { by: running.by, started_at: running.started_at } : null,
  };
}

function push() {
  try { broadcast({ type: 'calendar_sync', ...syncState() }); } catch (err) { log(`broadcast failed: ${err.message}`); }
}

function runTool() {
  return new Promise((resolve) => {
    const child = spawn(
      PYTHON_BIN,
      [
        path.join(HERE, 'tools', 'calendar_sync.py'), '--db', KLAUS_DB,
        ...(existsSync(KLAUS_CALENDARS) ? ['--calendars', KLAUS_CALENDARS] : []),
        ...(existsSync(KLAUS_ENV_FILE) ? ['--env', KLAUS_ENV_FILE] : []),
      ],
      { env: { ...process.env, PYTHONPATH: KLAUS_MEMORY_PYTHONPATH, PYTHONIOENCODING: 'utf-8' } },
    );
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: `nelze spustit python: ${e.message}` }); });
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out.trim())); } catch { resolve({ ok: false, error: (err || out || 'synchronizace selhala').trim().slice(0, 300) }); }
    });
  });
}

/* The preview never reaches Google: a short pause, then the sample answers. */
function pretend() {
  return new Promise((resolve) => setTimeout(() => resolve({ ok: true, events: 214, responses: {} }), 1600));
}

/** The owner's words for a failed sync, like night.js humanError. */
export function humanError(e) {
  const s = String(e || '');
  if (/timed out|timeout|ETIMEDOUT|killed|SIGTERM/i.test(s)) return 'Google neodpověděl včas';
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|ECONNRESET|getaddrinfo|urlopen error|network|connection|síť/i.test(s)) return 'bez sítě';
  if (/invalid_grant|unauthori[sz]ed|auth|token|credential|\b401\b|\b403\b/i.test(s)) return 'Google chce znovu přihlásit';
  if (/calendars\.json/i.test(s)) return 'kalendáře nejsou nastavené';
  if (/No module named|nelze spustit python|ENOENT/i.test(s)) return 'chybí klaus_memory nebo python';
  return 'kalendář neodpověděl';
}

/**
 * Sync every calendar now. `by` is 'night' or 'user'. One at a time: a press
 * while the night's sync runs joins it rather than starting a second.
 * `opts.tool` stands in for the Python process (the tests).
 */
export function runSync(by = 'user', opts = {}) {
  if (running) return running.promise;
  const started = now();
  const tool = opts.tool || (PREVIEW ? pretend : runTool);
  const promise = Promise.resolve().then(tool).catch((err) => ({ ok: false, error: err.message })).then((r) => {
    const ok = !!(r && r.ok);
    if (ok && !PREVIEW) {
      try {
        const n = storeResponses(r.responses);
        if (n === null) log('the sync read no invitation answers; the previous ones stay');
        // Not even an "accepted": klaus_memory's sync is not passing responseStatus through.
        else if (n === 0) log('no invitation answers in this sync (does klaus_memory keep responseStatus?)');
      } catch (err) { log(`answers not stored: ${err.message}`); }
    }
    let invites = 0;
    try { invites = countOpen(); } catch (err) { log(`open invitations not counted: ${err.message}`); }
    // After a failure the page says which sync the calendar still shows.
    const prev = kvGet('calendar.sync', null);
    const at = now();
    const last = {
      at, started_at: started, by, ok,
      last_ok_at: ok ? at : (prev ? (prev.ok ? prev.at : prev.last_ok_at) : null) || null,
      events: ok && Number.isFinite(r.events) ? r.events : null,
      invites,
      error: ok ? null : String(r && r.error || '').slice(0, 300),
      error_cs: ok ? null : humanError(r && r.error),
    };
    kvSet('calendar.sync', last);
    log(`${by}: ${ok ? `ok${last.events != null ? `, ${last.events} events` : ''}, ${invites} open invitation(s)` : 'FAILED ' + last.error}`);
    return last;
  }).finally(() => { running = null; push(); });
  running = { by, started_at: started, promise };
  push();
  return promise;
}

/**
 * Open invitations that have not ended yet, soonest first — what "2 pozvánky
 * čekají na odpověď" counts and what Kacey reads out. An event deleted in
 * Google drops out through the join.
 */
export function listOpen({ at = new Date(), limit = 50 } = {}) {
  const from = at.toISOString();
  if (PREVIEW) {
    return sampleRows(from.slice(0, 7))
      .filter((r) => OPEN_ANSWERS.includes(r.response) && (r.ends_at || r.starts_at) >= from)
      .slice(0, limit)
      .map((r) => ({ event_id: r.event_id, title: r.title, starts_at: r.starts_at, ends_at: r.ends_at, source: r.source, status: r.response }));
  }
  return open().prepare(
    `SELECT e.event_id, e.title, e.starts_at, e.ends_at, e.source, r.status
       FROM kacey_event_response r JOIN calendar_event e ON e.event_id = r.event_id
      WHERE r.status IN ('needsAction','tentative') AND COALESCE(e.ends_at, e.starts_at) >= ?
      ORDER BY e.starts_at
      LIMIT ?`,
  ).all(from, limit);
}

function countOpen() {
  return listOpen({ limit: 1000 }).length;
}

/* ---- the preview's sample invitations ----------------------------------- */

/** A preview starts as if last night's sync had run at 03:12. */
export function seedPreview() {
  if (!PREVIEW || kvGet('calendar.sync', null)) return;
  const at = new Date();
  if (at.getHours() < 4) at.setDate(at.getDate() - 1);
  at.setHours(3, 12, 0, 0);
  kvSet('calendar.sync', {
    at: at.toISOString(), started_at: new Date(at.getTime() - 9000).toISOString(), by: 'night', ok: true,
    events: 214, invites: countOpen(), error: null, error_cs: null,
  });
}

function iso(date, hm) {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  return new Date(y, m - 1, d, h, mi).toISOString();
}

/**
 * Work-calendar rows for a preview, like the owner's: the morning "PU4
 * Testing" every weekday, still unanswered; "PU4 - UiTesting sync" on Tuesday
 * and Thursday, accepted; one "Retro Q4" answered Možná. Each carries its
 * `response` directly.
 */
export function sampleRows(month) {
  if (!PREVIEW) return [];
  const [y, mo] = month.split('-').map(Number);
  const days = new Date(y, mo, 0).getDate();
  const rows = [];
  const base = { origin: 'sync', sync_state: 'synced', sensitivity: null, sync_error: null, source: 'práce', source_meta: null, updated_at: now() };
  let retro = false;
  for (let d = 1; d <= days; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const dow = new Date(y, mo - 1, d).getDay();
    if (dow === 0 || dow === 6) continue;
    rows.push({ ...base, event_id: `ev_sample_pu4t_${d}`, title: 'PU4 Testing', starts_at: iso(date, '08:30'), ends_at: iso(date, '09:00'), response: 'needsAction' });
    if (dow === 2 || dow === 4) {
      rows.push({ ...base, event_id: `ev_sample_pu4s_${d}`, title: 'PU4 - UiTesting sync', starts_at: iso(date, '10:00'), ends_at: iso(date, '10:30'), response: 'accepted' });
    }
    if (dow === 3 && !retro && d >= 15) {
      retro = true;
      rows.push({ ...base, event_id: `ev_sample_retro_${d}`, title: 'Retro Q4', starts_at: iso(date, '14:00'), ends_at: iso(date, '15:00'), response: 'tentative' });
    }
  }
  return rows;
}

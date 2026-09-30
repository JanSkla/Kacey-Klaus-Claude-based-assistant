/**
 * Kacey — unsure calendar events.
 *
 * klaus_memory's calendar has no status column and syncs to Google and
 * TimeTree, so "this might happen" (an event poster, "maybe Saturday") is kept
 * here, in Kacey's own table (kacey_event_flag), keyed by the event's id. The
 * calendar view draws such an event dotted; Google and TimeTree show it as an
 * ordinary event.
 *
 * Confirming an event deletes its row rather than storing tentative = 0: the
 * default is "settled", so an absent row and a confirmed one mean the same.
 */

import { open, now } from './db.js';

const EVENT_ID_RE = /^ev_[A-Za-z0-9_-]{4,64}$/;

/** event_id -> note for every unsure event. Cheap: the table is a handful of rows. */
export function tentativeMap() {
  const out = new Map();
  for (const r of open().prepare('SELECT event_id, note FROM kacey_event_flag WHERE tentative = 1').all()) {
    out.set(r.event_id, r.note || '');
  }
  return out;
}

/** The calendar event itself, from klaus_memory's table (read only), or null. */
export function eventById(id) {
  if (!EVENT_ID_RE.test(String(id || ''))) return null;
  return open().prepare('SELECT event_id, title, starts_at, ends_at, source FROM calendar_event WHERE event_id = ?').get(id) || null;
}

/** Mark an event unsure (with an optional note) or settle it. Throws on an unknown id. */
export function setTentative(id, tentative, note = '') {
  const ev = eventById(id);
  if (!ev) throw new Error(`událost "${id}" v kalendáři není`);
  if (tentative) {
    open().prepare(
      `INSERT INTO kacey_event_flag (event_id, tentative, note, updated_at) VALUES (?, 1, ?, ?)
         ON CONFLICT(event_id) DO UPDATE SET tentative = 1, note = excluded.note, updated_at = excluded.updated_at`,
    ).run(id, String(note || '').slice(0, 300), now());
  } else {
    open().prepare('DELETE FROM kacey_event_flag WHERE event_id = ?').run(id);
  }
  return ev;
}

/** Forget a flag — the event was deleted. Never throws. */
export function dropFlag(id) {
  try { open().prepare('DELETE FROM kacey_event_flag WHERE event_id = ?').run(String(id)); } catch { /* nothing to drop */ }
}

/** Every unsure event that still exists, soonest first. */
export function listTentative() {
  return open().prepare(
    `SELECT e.event_id, e.title, e.starts_at, e.ends_at, e.source, f.note
       FROM kacey_event_flag f JOIN calendar_event e ON e.event_id = f.event_id
      WHERE f.tentative = 1
      ORDER BY e.starts_at`,
  ).all();
}

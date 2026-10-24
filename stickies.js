/**
 * Kacey — lístečky, sticky notes over every page of the desktop.
 *
 * The owner makes one with the header's note button (public/js/ui/stickies.js),
 * types on it, drags it anywhere and it stays there — across views, reloads
 * and desktops — until it is deleted. Kacey can write one too ("napiš mi
 * lísteček …", app_sticky in app-tools.js) and reads them in app_read.
 *
 * One row per note (db.js, kacey_sticky). Each change is a small write of the
 * fields that changed, so a note dragged on one desktop and typed on in
 * another never overwrite each other's whole list. A deleted note keeps its
 * row for a day, which is what Vrátit restores.
 *
 * Every change is reported through onEvent(); server.js broadcasts it as a
 * `stickies` frame, so every open page redraws its notes. `origin` is the
 * page that made the change: it already shows it and skips the frame.
 */

import { randomBytes } from 'node:crypto';

import { open, now, kvGet, kvSet, transact } from './db.js';

/** At most this many notes: more would cover the screen they are meant to help with. */
export const MAX = 12;
export const TEXT_MAX = 2000;
export const SIZE = { w: 240, h: 180, minW: 180, minH: 110, max: 2000 };
const POS_MAX = 10000;
const KEEP_DELETED_MS = 24 * 3600 * 1000;

let listener = () => {};
export function onEvent(fn) { listener = typeof fn === 'function' ? fn : () => {}; }
function emit(ev) { try { listener(ev); } catch { /* a page went away */ } }

function stickyId() { return 's' + Date.now().toString(36) + randomBytes(3).toString('hex'); }

const int = (v, lo, hi) => (v === null || v === undefined || v === '' || !Number.isFinite(+v) ? null : Math.min(hi, Math.max(lo, Math.round(+v))));
const cleanText = (v) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').slice(0, TEXT_MAX);

function shape(r) {
  if (!r) return null;
  return {
    id: r.sticky_id, text: r.text, x: r.x, y: r.y, w: r.w, h: r.h,
    origin: r.origin, created_at: r.created_at, updated_at: r.updated_at,
  };
}

function row(id) {
  return open().prepare('SELECT * FROM kacey_sticky WHERE sticky_id = ? AND deleted_at IS NULL').get(String(id || ''));
}

export function get(id) { return shape(row(id)); }

function count() { return open().prepare('SELECT COUNT(*) AS n FROM kacey_sticky WHERE deleted_at IS NULL').get().n; }

function purge() {
  const before = new Date(Date.now() - KEEP_DELETED_MS).toISOString();
  open().prepare('DELETE FROM kacey_sticky WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(before);
}

/* The draft of this feature kept the notes in settings.stickies. Moved into
   the table once, then taken out of the settings — appstate.js calls this
   before a settings save, so the save cannot drop them first. */
export function importFromSettings() {
  const s = kvGet('settings', null);
  if (!s || !Array.isArray(s.stickies)) return;
  transact((h) => {
    const ins = h.prepare(
      `INSERT OR IGNORE INTO kacey_sticky (sticky_id, text, x, y, w, h, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const t = now();
    s.stickies.slice(0, MAX).forEach((n) => {
      if (!n || !n.id) return;
      ins.run(String(n.id).slice(0, 40), cleanText(n.text), int(n.x, 0, POS_MAX), int(n.y, 0, POS_MAX),
        int(n.w, SIZE.minW, SIZE.max) ?? SIZE.w, int(n.h, SIZE.minH, SIZE.max) ?? SIZE.h, t, t);
    });
  });
  const { stickies: _gone, ...rest } = s;
  kvSet('settings', rest);
}

/** Every note, oldest first (the page stacks them in this order). */
export function list() {
  importFromSettings();
  purge();
  return open().prepare('SELECT * FROM kacey_sticky WHERE deleted_at IS NULL ORDER BY created_at, sticky_id').all().map(shape);
}

/** A new note. Without x/y the page places it in the top right corner. */
export function create({ text = '', x, y, w, h, by = 'user', origin = '' } = {}) {
  importFromSettings();
  if (count() >= MAX) throw new Error('Víc lístečků se nevejde — nejdřív nějaký smaž.');
  const id = stickyId();
  const t = now();
  open().prepare(
    `INSERT INTO kacey_sticky (sticky_id, text, x, y, w, h, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, cleanText(text), int(x, 0, POS_MAX), int(y, 0, POS_MAX),
    int(w, SIZE.minW, SIZE.max) ?? SIZE.w, int(h, SIZE.minH, SIZE.max) ?? SIZE.h,
    by === 'kacey' ? 'kacey' : 'user', t, t);
  const note = get(id);
  emit({ event: 'created', id, by, origin });
  return note;
}

/** Change what was sent of text, x, y, w, h; the rest stays. Null when there is no such note. */
export function update(id, part = {}, { by = 'user', origin = '' } = {}) {
  const cur = row(id);
  if (!cur) return null;
  const next = { text: cur.text, x: cur.x, y: cur.y, w: cur.w, h: cur.h };
  if ('text' in part) next.text = cleanText(part.text);
  if ('x' in part) next.x = int(part.x, 0, POS_MAX);
  if ('y' in part) next.y = int(part.y, 0, POS_MAX);
  if ('w' in part) next.w = int(part.w, SIZE.minW, SIZE.max) ?? cur.w;
  if ('h' in part) next.h = int(part.h, SIZE.minH, SIZE.max) ?? cur.h;
  open().prepare('UPDATE kacey_sticky SET text = ?, x = ?, y = ?, w = ?, h = ?, updated_at = ? WHERE sticky_id = ?')
    .run(next.text, next.x, next.y, next.w, next.h, now(), cur.sticky_id);
  emit({ event: 'changed', id: cur.sticky_id, by, origin });
  return get(cur.sticky_id);
}

/** Delete a note (kept a day for Vrátit). The note as it was, or null. */
export function remove(id, { by = 'user', origin = '' } = {}) {
  const note = get(id);
  if (!note) return null;
  open().prepare('UPDATE kacey_sticky SET deleted_at = ? WHERE sticky_id = ?').run(now(), note.id);
  emit({ event: 'deleted', id: note.id, by, origin });
  return note;
}

/** Smazat všechny lístečky: every open note at once (each kept a day for Vrátit).
    The notes as they were; one `cleared` frame. */
export function removeAll({ by = 'user', origin = '' } = {}) {
  const notes = list();
  if (!notes.length) return [];
  open().prepare('UPDATE kacey_sticky SET deleted_at = ? WHERE deleted_at IS NULL').run(now());
  emit({ event: 'cleared', ids: notes.map((n) => n.id), by, origin });
  return notes;
}

/** Vrátit: a note deleted within the day comes back where it was. */
export function restore(id, { by = 'user', origin = '' } = {}) {
  const r = open().prepare('SELECT * FROM kacey_sticky WHERE sticky_id = ? AND deleted_at IS NOT NULL').get(String(id || ''));
  if (!r) throw new Error('Ten lísteček už vrátit nejde.');
  if (count() >= MAX) throw new Error('Víc lístečků se nevejde — nejdřív nějaký smaž.');
  open().prepare('UPDATE kacey_sticky SET deleted_at = NULL, updated_at = ? WHERE sticky_id = ?').run(now(), r.sticky_id);
  emit({ event: 'created', id: r.sticky_id, by, origin });
  return get(r.sticky_id);
}

/** The self-update preview: one note by Kacey, so the comparison shows the layer.
    Only into a table that has never had a note. */
export function seedSample() {
  importFromSettings();
  if (open().prepare('SELECT COUNT(*) AS n FROM kacey_sticky').get().n) return 0;
  create({ text: 'Tohle je lísteček — zůstane na každé stránce. Přetáhni ho za lištu, velikost změníš v rohu, × ho smaže.', by: 'kacey' });
  return 1;
}

const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/** A note by its id, or by words from its text ("ten o mámě" finds „Zavolat mámě“).
    With one note only, any reference is that one. */
export function find(ref) {
  const all = list();
  if (!all.length) return null;
  const byId = all.find((n) => n.id === String(ref || '').trim());
  if (byId) return byId;
  const words = fold(ref).split(' ').filter((w) => w.length >= 3).map((w) => w.slice(0, Math.max(3, w.length - 2)));
  if (words.length) {
    const hits = all.map((n) => ({ n, k: words.filter((w) => fold(n.text).includes(w)).length })).filter((m) => m.k);
    hits.sort((a, b) => b.k - a.k);
    if (hits.length && (hits.length === 1 || hits[0].k > hits[1].k)) return hits[0].n;
    if (hits.length) return null;
  }
  return all.length === 1 ? all[0] : null;
}

/** The notes as Kacey reads them: one line each, the text on one line. */
export function describe(all = list()) {
  if (!all.length) return '(žádné)';
  return all.map((n) => {
    const t = n.text.replace(/\s+/g, ' ').trim();
    return `- (${n.id}) ${t ? `„${t.length > 200 ? t.slice(0, 199) + '…' : t}“` : '(prázdný)'}${n.origin === 'kacey' ? ' · napsala Kacey' : ''}`;
  }).join('\n');
}

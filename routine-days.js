/**
 * Kacey — the routine on concrete dates: divergences and cemented history.
 *
 * The weekly routine (kacey_routine_block) is the default week. This module
 * owns the two things layered on it (docs/routine-divergence.drawio):
 *
 *   kacey_routine_override  a change to ONE date — a cancel, an add, a move
 *                           (cancel + add, one group), a sick range (one
 *                           whole-day cancel per date, one group).
 *   kacey_routine_day       a finished day, cemented: written once when its
 *                           logical day ends (04:00 the morning after) and
 *                           never touched by the default week again.
 *
 * Which blocks a date has is decided in public/js/core/routine-day.js, which
 * the browser runs too; this file is storage, the clock, and the one write
 * path. The calendar's buttons (POST /api/routine/alter) and Kacey's
 * app_routine_alter tool both call alter() — same operations, same checks —
 * with one difference: a cemented day can only be amended by Kacey, from the
 * conversation ("I forgot, I was sick yesterday").
 *
 * Dates are the grid's clock days, the same days the calendar lane shows the
 * routine on. "Today" is the logical day (04:00), so at 01:30 yesterday is
 * still live.
 */

import { z } from 'zod';

import { LOGICAL_DAY_START_HOUR } from './config.js';
import { open, transact, kvGet, kvSet, now as stamp } from './db.js';
import * as appstate from './appstate.js';
import { addDays, dowOf, logicalToday, normalizeDue } from './public/js/core/due.js';
import { CATS, CATEGORY_KEYS } from './public/js/core/routine-cats.js';
import {
  templateBlocks, applyOverrides, overridesOn, isActive, cancelHits,
} from './public/js/core/routine-day.js';

const HOUR = 3600000;

/** The logical date it is now. */
export function today(now = new Date()) { return logicalToday(now, LOGICAL_DAY_START_HOUR); }

/** 04:00 on a date, as a Date. */
function logicalStart(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, LOGICAL_DAY_START_HOUR, 0);
}

/* ---- reading the history -------------------------------------------------- */

function parseBlocks(text) {
  try { const v = JSON.parse(text); return Array.isArray(v) ? v : []; } catch { return []; }
}

function rowToDay(r) {
  return {
    date: r.date, blocks: parseBlocks(r.blocks), altered: !!r.altered,
    cemented_at: r.cemented_at, source: r.source, amended_at: r.amended_at || null,
    can_undo_amend: !!r.prev_blocks,
  };
}

export function snapshot(date) {
  const r = open().prepare('SELECT * FROM kacey_routine_day WHERE date = ?').get(date);
  return r ? rowToDay(r) : null;
}

/** Cemented days in [from, to], by date. */
export function snapshots(from, to) {
  const out = {};
  for (const r of open().prepare('SELECT * FROM kacey_routine_day WHERE date >= ? AND date <= ? ORDER BY date').all(from, to)) {
    out[r.date] = rowToDay(r);
  }
  return out;
}

/**
 * The first date with a history. Set the first time anything asks, to that
 * day: dates before it were never recorded, and cementing them now from
 * today's default week would be inventing a past.
 */
export function historySince(now = new Date()) {
  let since = kvGet('routine.history_since', null);
  if (!since) { since = today(now); kvSet('routine.history_since', since); }
  return since;
}

/* ---- cementing -------------------------------------------------------------- */

/** What a block keeps in history: the resolved shape, minus nothing. */
function frozen(b) {
  return {
    cat: b.cat, s: b.s, e: b.e, slot: b.slot, note: b.note || '', room: b.room || '', who: b.who || '',
    src: b.src, state: b.state, reason: b.reason || '', override_id: b.override_id || null,
    group_id: b.group_id || null, group_kind: b.group_kind || null, overlap: b.overlap || null,
  };
}

/** A date resolved live from the default week and its overrides, read from the database. */
function liveDay(date, routine) {
  const rt = routine || appstate.get().routine;
  const own = appstate.readOverrides(date, date);
  const out = applyOverrides(templateBlocks(rt, dowOf(date)), own);
  return { date, kind: 'live', blocks: out.blocks, stale: out.stale, altered: own.length > 0, overrides: own };
}

function cementOne(h, date, routine, source, at) {
  const day = liveDay(date, routine);
  h.prepare(
    `INSERT OR IGNORE INTO kacey_routine_day (date, blocks, altered, cemented_at, source)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(date, JSON.stringify(day.blocks.map(frozen)), day.altered ? 1 : 0, at, source);
}

/**
 * Cement every finished day not cemented yet. Idempotent: the night tick
 * calls it every 30 s and it does nothing until a day has ended; a server that
 * was off over a night catches up the next time it runs. Returns the dates.
 */
export function cementDue(now = new Date()) {
  const since = historySince(now);
  const last = addDays(today(now), -1);
  const through = kvGet('routine.cemented_through', addDays(since, -1));
  if (through >= last) return [];

  const routine = appstate.get().routine;
  const at = stamp();
  const done = [];
  transact((h) => {
    for (let d = addDays(through, 1); d <= last; d = addDays(d, 1)) {
      if (d < since) continue;
      // Within an hour of the day ending is the tick doing its job; later is a catch-up.
      const late = now.getTime() - logicalStart(addDays(d, 1)).getTime() > HOUR;
      cementOne(h, d, routine, late ? 'catchup' : 'rollover', at);
      done.push(d);
    }
    kvSet('routine.cemented_through', last);
  });
  return done;
}

/**
 * One date, the way everything should see it: cemented when it is over and
 * has a history, otherwise live. A finished day that somehow has no copy yet
 * is cemented on the spot.
 */
export function dayView(date, now = new Date()) {
  const t = today(now);
  const since = historySince(now);
  if (date < t && date >= since) {
    let snap = snapshot(date);
    if (!snap) { cementDue(now); snap = snapshot(date); }
    if (snap) return { date, kind: 'cemented', ...snap, stale: [] };
  }
  const live = liveDay(date);
  return { ...live, kind: date < t ? 'unrecorded' : 'live' };
}

/* ---- the operations ----------------------------------------------------------
   One schema for the HTTP endpoint and Kacey's tool. Times are "HH:MM" and snap
   to the quarter-hour grid — outward, so "18:10–19:05" covers the block it
   was meant to. */

const DATE = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'datum musí být YYYY-MM-DD');
const HHMM = z.string().trim().regex(/^([01]?\d|2[0-4]):[0-5]\d$/, 'čas musí být HH:MM');
const Cat = z.enum(CATEGORY_KEYS);
const Text = z.string().trim().max(80);
const Reason = z.string().trim().max(120);

export const OpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('cancel'), date: DATE, from: HHMM.optional(), to: HHMM.optional(), category: Cat.optional(), reason: Reason.optional() }),
  z.object({ op: z.literal('cancel_range'), from_date: DATE, to_date: DATE, categories: z.array(Cat).max(CATEGORY_KEYS.length).optional(), reason: Reason.optional() }),
  z.object({ op: z.literal('add'), date: DATE, from: HHMM, to: HHMM, category: Cat, note: Text.optional(), room: Text.optional(), who: Text.optional(), reason: Reason.optional() }),
  z.object({ op: z.literal('move'), date: DATE, from: HHMM, to: HHMM, category: Cat.optional(), to_date: DATE.optional(), new_from: HHMM, new_to: HHMM.optional(), reason: Reason.optional() }),
  z.object({ op: z.literal('reset'), dates: z.array(DATE).max(62).optional(), from_date: DATE.optional(), to_date: DATE.optional(), group_id: z.number().int().positive().optional() }),
  z.object({ op: z.literal('remove'), id: z.number().int().positive() }),
  z.object({ op: z.literal('keep_overlap'), id: z.number().int().positive() }),
]);

/** A refused operation: the message is Czech and says why, for a toast or for Kacey. */
export class AlterError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function minutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const v = h * 60 + m;
  if (v > 1440) throw new AlterError(`čas mimo den: "${hhmm}"`);
  return v;
}
function slotFrom(hhmm) { return Math.floor(minutes(hhmm) / 15); }
function slotTo(hhmm) { return Math.ceil(minutes(hhmm) / 15); }

function realDate(d) {
  try { normalizeDue(d); } catch (err) { throw new AlterError(err.message); }
  return d;
}

function hhmm(mins) { return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0'); }

const WEEKDAYS = ['po', 'út', 'st', 'čt', 'pá', 'so', 'ne'];
export function dayWord(date) {
  const [, m, d] = date.split('-').map(Number);
  return `${WEEKDAYS[dowOf(date)]} ${d}. ${m}.`;
}

function blockWord(b) {
  return `${CATS[b.cat] ? CATS[b.cat].label : b.cat}${b.note ? ` „${b.note}“` : ''} ${hhmm(b.s)}–${hhmm(b.e)}`;
}

function nextGroup(h) {
  return Number(h.prepare('SELECT COALESCE(MAX(group_id), 0) + 1 AS g FROM kacey_routine_override').get().g);
}

function insertOverride(h, o, origin) {
  const r = h.prepare(
    `INSERT INTO kacey_routine_override
       (date, kind, slot_from, slot_to, category, note, room, who, reason, group_id, group_kind, overlap, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    o.date, o.kind, o.slot_from, o.slot_to, o.category || null, o.note || null, o.room || null, o.who || null,
    o.reason || null, o.group_id || null, o.group_kind || null, o.overlap || null, origin, stamp(),
  );
  return Number(r.lastInsertRowid);
}

/* Which kind of day a date is, for writing: 'live' (overrides), 'cemented'
   (only Kacey may amend), or refused. */
function writable(date, origin, now) {
  const t = today(now);
  if (date >= t) return 'live';
  const since = historySince(now);
  if (date < since) throw new AlterError(`${dayWord(date)} je před začátkem historie rutiny (${dayWord(since)}) — ten den se nezapsal, takže není co měnit.`);
  if (origin !== 'kacey') throw new AlterError(`${dayWord(date)} už je zapsaný v historii. Změnit ho můžeš jen přes Kacey v konverzaci.`, 409);
  cementDue(now);
  return 'cemented';
}

/* ---- amending a cemented day (Kacey only) ------------------------------------ */

function amend(h, date, blocks) {
  const prev = h.prepare('SELECT blocks FROM kacey_routine_day WHERE date = ?').get(date);
  h.prepare('UPDATE kacey_routine_day SET blocks = ?, altered = ?, amended_at = ?, prev_blocks = ? WHERE date = ?')
    .run(JSON.stringify(blocks.map(frozen)), blocks.some((b) => b.state !== 'template') ? 1 : 0, stamp(), prev ? prev.blocks : null, date);
}

function snapBlocks(date) {
  const snap = snapshot(date);
  if (!snap) throw new AlterError(`${dayWord(date)} nemá zapsanou historii.`);
  return snap.blocks.map((b) => ({ ...b }));
}

function cancelInSnapshot(blocks, o) {
  let hit = 0;
  for (const b of blocks) {
    if (!isActive(b) || !cancelHits(o, b)) continue;
    b.state = o.group_kind === 'move' ? 'moved_out' : 'cancelled';
    b.reason = o.reason || '';
    hit++;
  }
  return hit;
}

/* ---- alter ------------------------------------------------------------------- */

/**
 * Apply one operation. `origin` is 'user' (the calendar) or 'kacey' (her
 * tool). Returns { dates, summary, warnings }: the dates touched, one Czech
 * sentence of what happened, and anything the caller should say (an overlap
 * waiting for Kacey's decision, a cancel that hit nothing).
 *
 * Throws AlterError with a readable message when the operation makes no
 * sense, and then nothing was written.
 */
export function alter(input, { origin = 'user', now = new Date() } = {}) {
  const parsed = OpSchema.safeParse(input);
  if (!parsed.success) {
    throw new AlterError((parsed.error.issues || []).map((i) => `${i.path.join('.') || 'op'}: ${i.message}`).join('; '));
  }
  const op = parsed.data;
  const who = origin === 'kacey' ? 'kacey' : 'user';
  for (const k of ['date', 'to_date', 'from_date']) if (op[k]) realDate(op[k]);
  (op.dates || []).forEach(realDate);

  switch (op.op) {
    case 'cancel': return cancelOp(op, who, now);
    case 'cancel_range': return cancelRangeOp(op, who, now);
    case 'add': return addOp(op, who, now);
    case 'move': return moveOp(op, who, now);
    case 'reset': return resetOp(op, who, now);
    case 'remove': return removeOp(op, who, now);
    case 'keep_overlap': return keepOverlapOp(op, who, now);
    default: throw new AlterError(`neznámá operace "${op.op}"`);
  }
}

function overlapWarning(date, add) {
  const day = liveDay(date);
  const mine = day.blocks.find((b) => b.override_id === add);
  if (!mine || mine.overlap !== 'pending') return [];
  const under = day.blocks.filter((b) => b.src === 'template' && b.state === 'template' && b.s < mine.e && mine.s < b.e);
  return [`⚠ ${dayWord(date)}: ${blockWord(mine)} se překrývá s ${under.map(blockWord).join(', ')}. ` +
    `Obojí zůstává vedle sebe; jestli výchozí blok zrušit, rozhodne Kacey (cancel), nebo nechat obojí (keep_overlap id ${add}).`];
}

function cancelOp(op, who, now) {
  const whole = !op.from && !op.to;
  const o = {
    date: op.date, kind: 'cancel',
    slot_from: op.from ? slotFrom(op.from) : 0, slot_to: op.to ? slotTo(op.to) : 96,
    category: op.category || null, reason: op.reason || '',
    group_kind: whole ? 'range' : null,
  };
  if (o.slot_to <= o.slot_from) throw new AlterError(`"${op.from}"–"${op.to}" nedává smysl.`);
  const kind = writable(op.date, who, now);

  if (kind === 'cemented') {
    const blocks = snapBlocks(op.date);
    const hit = cancelInSnapshot(blocks, o);
    if (!hit) throw new AlterError(`${dayWord(op.date)} v tu dobu nic neproběhlo, není co rušit.`);
    transact((h) => amend(h, op.date, blocks));
    return { dates: [op.date], summary: `${dayWord(op.date)} (už zapsaný den) opraven: zrušeno ${hit} ${hit === 1 ? 'blok' : 'bloků'}.`, warnings: [] };
  }

  const hits = liveDay(op.date).blocks.filter((b) => isActive(b) && b.src === 'template' && cancelHits(o, b));
  if (!hits.length && !whole) {
    throw new AlterError(`${dayWord(op.date)} ${op.from || ''}–${op.to || ''} není žádný blok rutiny${op.category ? ` (${CATS[op.category].label})` : ''}, který by se celý vešel do toho času. Nic se nezměnilo.`);
  }
  transact((h) => {
    if (whole) o.group_id = nextGroup(h);
    insertOverride(h, o, who);
  });
  return {
    dates: [op.date],
    summary: hits.length
      ? `${dayWord(op.date)}: zrušeno ${hits.map(blockWord).join(', ')}${op.reason ? ` (${op.reason})` : ''}.`
      : `${dayWord(op.date)}: celý den zrušen, ale nic v něm nebylo.`,
    warnings: [],
  };
}

function cancelRangeOp(op, who, now) {
  if (op.to_date < op.from_date) throw new AlterError('Konec rozsahu je před začátkem.');
  const dates = [];
  for (let d = op.from_date; d <= op.to_date; d = addDays(d, 1)) dates.push(d);
  if (dates.length > 62) throw new AlterError('Nejvýš 62 dní najednou.');
  const kinds = new Map(dates.map((d) => [d, writable(d, who, now)]));
  const cats = op.categories && op.categories.length && op.categories.length < CATEGORY_KEYS.length ? op.categories : [null];

  let count = 0;
  transact((h) => {
    const group = nextGroup(h);
    for (const d of dates) {
      if (kinds.get(d) === 'cemented') {
        const blocks = snapBlocks(d);
        for (const c of cats) count += cancelInSnapshot(blocks, { slot_from: 0, slot_to: 96, category: c, reason: op.reason || '' });
        amend(h, d, blocks);
        continue;
      }
      const live = liveDay(d).blocks;
      for (const c of cats) {
        count += live.filter((b) => isActive(b) && b.src === 'template' && (!c || b.cat === c)).length;
        insertOverride(h, {
          date: d, kind: 'cancel', slot_from: 0, slot_to: 96, category: c,
          reason: op.reason || '', group_id: group, group_kind: 'range',
        }, who);
      }
    }
  });
  const what = cats[0] ? cats.map((c) => CATS[c].label).join(', ') : 'všechno';
  return {
    dates,
    summary: `${dayWord(op.from_date)} – ${dayWord(op.to_date)}: zrušeno ${what}${op.reason ? ` (${op.reason})` : ''}, ${count} ${count === 1 ? 'blok' : 'bloků'}.`,
    warnings: [],
  };
}

function addOp(op, who, now) {
  const o = {
    date: op.date, kind: 'add', slot_from: slotFrom(op.from), slot_to: slotTo(op.to), category: op.category,
    note: op.note || '', room: op.room || '', who: op.who || '', reason: op.reason || '',
  };
  if (o.slot_to <= o.slot_from) throw new AlterError(`"${op.from}"–"${op.to}" nedává smysl.`);
  const kind = writable(op.date, who, now);
  const block = { cat: o.category, s: o.slot_from * 15, e: o.slot_to * 15, note: o.note };

  if (kind === 'cemented') {
    const blocks = snapBlocks(op.date);
    blocks.push({ ...block, slot: o.slot_from, room: o.room, who: o.who, src: 'added', state: 'added', reason: o.reason });
    blocks.sort((a, b) => a.s - b.s);
    transact((h) => amend(h, op.date, blocks));
    return { dates: [op.date], summary: `${dayWord(op.date)} (už zapsaný den) opraven: přidáno ${blockWord(block)}.`, warnings: [] };
  }

  let id;
  transact((h) => { id = insertOverride(h, o, who); });
  return { dates: [op.date], id, summary: `${dayWord(op.date)}: přidáno ${blockWord(block)} (#${id}).`, warnings: overlapWarning(op.date, id) };
}

/** Monday of a date's week. */
function mondayOf(date) { return addDays(date, -dowOf(date)); }

function moveOp(op, who, now) {
  const to = op.to_date || op.date;
  if (mondayOf(to) !== mondayOf(op.date)) throw new AlterError('Přesunout jde jen v rámci téhož týdne (po–ne).');
  const src = { slot_from: slotFrom(op.from), slot_to: slotTo(op.to), category: op.category || null };
  const fromKind = writable(op.date, who, now);
  const toKind = writable(to, who, now);
  if (fromKind !== toKind) throw new AlterError('Přesun mezi už zapsaným dnem a živým dnem nejde — udělej zrušení a přidání zvlášť.');

  const candidates = (fromKind === 'cemented' ? snapBlocks(op.date) : liveDay(op.date).blocks)
    .filter((b) => isActive(b) && (fromKind === 'cemented' || b.src === 'template') && cancelHits(src, b));
  if (!candidates.length) throw new AlterError(`${dayWord(op.date)} ${op.from}–${op.to} není žádný blok rutiny k přesunutí. Nic se nezměnilo.`);
  if (candidates.length > 1) throw new AlterError(`V tom čase je víc bloků (${candidates.map(blockWord).join(', ')}) — upřesni čas nebo kategorii.`);
  const b = candidates[0];

  const newFrom = slotFrom(op.new_from);
  const newTo = op.new_to ? slotTo(op.new_to) : newFrom + (b.e - b.s) / 15;
  if (newTo > 96 || newTo <= newFrom) throw new AlterError('Nový čas nedává smysl (musí skončit do půlnoci).');
  const moved = { cat: b.cat, s: newFrom * 15, e: newTo * 15, note: b.note };

  if (fromKind === 'cemented') {
    const blocks = snapBlocks(op.date);
    const target = blocks.find((x) => x.s === b.s && x.e === b.e && x.cat === b.cat && isActive(x));
    target.state = 'moved_out'; target.reason = op.reason || '';
    blocks.push({ ...target, s: moved.s, e: moved.e, slot: newFrom, src: 'added', state: 'moved_in', overlap: null });
    blocks.sort((x, y) => x.s - y.s);
    transact((h) => amend(h, op.date, blocks));
    return { dates: [op.date], summary: `${dayWord(op.date)} (už zapsaný den) opraven: ${blockWord(b)} přesunuto na ${hhmm(moved.s)}–${hhmm(moved.e)}.`, warnings: [] };
  }

  let id;
  transact((h) => {
    const group = nextGroup(h);
    insertOverride(h, { date: op.date, kind: 'cancel', slot_from: b.s / 15, slot_to: b.e / 15, category: b.cat, reason: op.reason || '', group_id: group, group_kind: 'move' }, who);
    id = insertOverride(h, {
      date: to, kind: 'add', slot_from: newFrom, slot_to: newTo, category: b.cat,
      note: b.note, room: b.room, who: b.who, reason: op.reason || '', group_id: group, group_kind: 'move',
    }, who);
  });
  const where = to === op.date ? '' : ` na ${dayWord(to)}`;
  return {
    dates: [...new Set([op.date, to])], id,
    summary: `${dayWord(op.date)}: ${blockWord(b)} přesunuto${where} na ${hhmm(moved.s)}–${hhmm(moved.e)}.`,
    warnings: overlapWarning(to, id),
  };
}

function resetOp(op, who, now) {
  if (op.group_id) {
    const rows = open().prepare('SELECT DISTINCT date FROM kacey_routine_override WHERE group_id = ?').all(op.group_id).map((r) => r.date);
    if (!rows.length) throw new AlterError(`Skupina ${op.group_id} neexistuje.`);
    const t = today(now);
    const live = rows.filter((d) => d >= t);
    if (!live.length) throw new AlterError('Ta změna se týká jen dní, které už jsou zapsané v historii.', 409);
    transact((h) => h.prepare('DELETE FROM kacey_routine_override WHERE group_id = ? AND date >= ?').run(op.group_id, t));
    return { dates: live, summary: `Vráceno na výchozí rutinu: ${live.map(dayWord).join(', ')}`, warnings: [] };
  }

  let dates = op.dates || [];
  if (op.from_date || op.to_date) {
    const a = op.from_date || op.to_date, b = op.to_date || op.from_date;
    if (b < a) throw new AlterError('Konec rozsahu je před začátkem.');
    for (let d = a; d <= b; d = addDays(d, 1)) dates.push(d);
  }
  dates = [...new Set(dates)].sort();
  if (!dates.length) throw new AlterError('Chybí dny: dates, nebo from_date–to_date, nebo group_id.');
  if (dates.length > 62) throw new AlterError('Nejvýš 62 dní najednou.');
  const kinds = new Map(dates.map((d) => [d, writable(d, who, now)]));

  transact((h) => {
    for (const d of dates) {
      if (kinds.get(d) === 'cemented') {
        // Back to the default the day was cemented with: its own template blocks, untouched.
        const base = snapBlocks(d).filter((b) => b.src === 'template')
          .map((b) => ({ ...b, state: 'template', reason: '', override_id: null, group_id: null, overlap: null }));
        amend(h, d, base);
      } else {
        h.prepare('DELETE FROM kacey_routine_override WHERE date = ?').run(d);
      }
    }
  });
  return { dates, summary: `Vráceno na výchozí rutinu: ${dates.map(dayWord).join(', ')}`, warnings: [] };
}

function rowById(id) {
  const r = open().prepare('SELECT * FROM kacey_routine_override WHERE id = ?').get(id);
  if (!r) throw new AlterError(`Změna #${id} neexistuje.`);
  return r;
}

function removeOp(op, who, now) {
  const r = rowById(op.id);
  writable(r.date, 'user', now);          // a cemented day's rows are its record; amend it instead
  const ids = r.group_kind === 'move'
    ? open().prepare('SELECT id, date FROM kacey_routine_override WHERE group_id = ?').all(r.group_id)
    : [{ id: r.id, date: r.date }];
  const t = today(now);
  if (ids.some((x) => x.date < t)) throw new AlterError('Polovina toho přesunu je už v historii — vrať den přes reset.', 409);
  transact((h) => { for (const x of ids) h.prepare('DELETE FROM kacey_routine_override WHERE id = ?').run(x.id); });
  const dates = [...new Set(ids.map((x) => x.date))];
  return {
    dates,
    summary: r.group_kind === 'move' ? `Přesun vrácen: ${dates.map(dayWord).join(', ')}` : `${dayWord(r.date)}: změna #${r.id} odebrána.`,
    warnings: [],
  };
}

function keepOverlapOp(op, who, now) {
  const r = rowById(op.id);
  if (r.kind !== 'add') throw new AlterError(`#${op.id} není přidaný blok.`);
  writable(r.date, 'user', now);
  transact((h) => h.prepare("UPDATE kacey_routine_override SET overlap = 'keep' WHERE id = ?").run(op.id));
  return { dates: [r.date], summary: `${dayWord(r.date)}: překryv #${op.id} necháno — oba bloky platí.`, warnings: [] };
}

/* ---- describing, for Kacey -------------------------------------------------- */

const STATE_WORDS = { cancelled: 'ZRUŠENO', moved_out: 'PŘESUNUTO PRYČ', added: 'PŘIDÁNO', moved_in: 'PŘESUNUTO SEM' };

function describeBlock(b) {
  const where = [b.room, b.who].filter(Boolean).join(', ');
  const tag = STATE_WORDS[b.state] ? ` [${STATE_WORDS[b.state]}${b.reason ? `: ${b.reason}` : ''}]` : '';
  const id = b.override_id ? ` #${b.override_id}` : '';
  const grp = b.group_id ? ` skupina ${b.group_id}` : '';
  const ov = b.overlap === 'pending' && b.src === 'added' ? ' ⚠ PŘEKRYV čeká na rozhodnutí' : b.overlap === 'keep' && b.src === 'added' ? ' (překryv necháno)' : '';
  return `${hhmm(b.s)}-${hhmm(b.e)} ${b.cat}${b.note ? ` "${b.note}"` : ''}${where ? ` (${where})` : ''}${tag}${id}${grp}${ov}`;
}

/** One date for Kacey: what it is (live / cemented) and every block, cancelled ones too. */
export function describeDay(view) {
  const head = view.kind === 'cemented'
    ? `${view.date} ${dayWord(view.date)} [zapsáno v historii${view.amended_at ? ', opraveno' : ''}]`
    : `${view.date} ${dayWord(view.date)}${view.altered ? ' [upraveno]' : ''}`;
  const stale = (view.stale || []).length ? `\n    ⚠ neplatné změny (výchozí rutina se mezitím změnila): ${view.stale.map((i) => '#' + i).join(', ')}` : '';
  return `${head}: ${view.blocks.length ? view.blocks.map(describeBlock).join('; ') : '(prázdné)'}${stale}`;
}

/** The days around today, for app_read: the last `back` days and the next `ahead`. */
export function describeDays({ back = 7, ahead = 14, now = new Date() } = {}) {
  cementDue(now);
  const t = today(now);
  const lines = [];
  for (let d = addDays(t, -back); d <= addDays(t, ahead); d = addDays(d, 1)) {
    const v = dayView(d, now);
    // The past only when it diverged; the future always, so she sees the week as it will be.
    if (d < t && !v.altered) continue;
    lines.push((d === t ? '* dnes ' : '  ') + describeDay(v));
  }
  return lines.join('\n');
}

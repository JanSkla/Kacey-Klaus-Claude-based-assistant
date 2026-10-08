/* =========================================================================
   One date's routine — shared by the browser and the server.

   The weekly routine is the default: every date starts as its weekday's
   blocks. An override changes ONE date (a run cancelled while sick, the gym
   moved to the evening, a doctor's appointment added), and the day ends up
   as the default minus its cancels plus its adds. Once a day is over it is
   cemented: a frozen copy is written and the default can no longer reach it.
   docs/routine-divergence.drawio draws all of this.

   This file is the "default minus cancels plus adds" part, and nothing else:
   no clock, no storage, no DOM. The calendar lane, the night run's rules and
   Kacey's tools all resolve a date through effectiveDay(), so they cannot
   disagree about whether the gym is on.

   An override, as the server hands it out (routine-days.js):
     { id, date, kind: 'cancel'|'add', slot_from, slot_to, category,
       note, room, who, reason, group_id, group_kind: 'move'|'range'|null,
       overlap: 'pending'|'keep'|null, origin }
   Slots are quarter-hours from midnight, slot_to exclusive. A cancel with no
   category cancels every category inside its range — that is a sick day.

   A resolved block:
     { cat, s, e, slot, note, room, who, kind,
       src:   'template' | 'added',
       state: 'template' | 'cancelled' | 'moved_out' | 'added' | 'moved_in',
       reason, override_id, group_id, group_kind, overlap: 'pending' | 'keep' | null }
   s and e are minutes from midnight.

   ES5 and no DOM, like due.js: server-side modules import it as it is.
   ========================================================================= */

import { dowOf } from './due.js';

/** States in which a block still happens. */
export var ACTIVE = { template: true, added: true, moved_in: true };

export function isActive(b) { return !!ACTIVE[b.state]; }

/** The contiguous painted blocks of one weekday (0 = Monday) in the routine grid. */
export function templateBlocks(routine, day) {
  var grid = (routine && routine.grid) || {};
  var notes = (routine && routine.notes) || {};
  var info = (routine && routine.info) || {};
  var out = [], cur = null;
  for (var i = 0; i < 96; i++) {
    var cat = grid[day + '-' + i];
    if (cat && cur && cur.cat === cat) cur.n++;
    else {
      if (cur) out.push(cur);
      cur = cat ? { cat: cat, i: i, n: 1 } : null;
    }
  }
  if (cur) out.push(cur);
  return out.map(function (b) {
    var key = day + '-' + b.i;
    var where = info[key] || {};
    return {
      cat: b.cat, s: b.i * 15, e: (b.i + b.n) * 15, slot: b.i,
      note: notes[key] || '', room: where.room || '', who: where.who || '', kind: where.kind || '',
      src: 'template', state: 'template', reason: '', override_id: null, group_id: null, group_kind: null, overlap: null
    };
  });
}

/** Does this cancel take this block? The whole block inside its range, and the category if it names one. */
export function cancelHits(o, b) {
  return b.s >= o.slot_from * 15 && b.e <= o.slot_to * 15 && (!o.category || o.category === b.cat);
}

function overlaps(a, b) { return a.s < b.e && b.s < a.e; }

/**
 * A list of blocks with one date's overrides applied.
 *
 * `base` is the template's blocks for that date (or a cemented day's, when
 * Kacey amends history). Returns { blocks, stale }: `stale` holds the ids of
 * single-block cancels that hit nothing — the default was repainted under
 * them. They are kept, shown, and not applied; a range cancel (a sick day)
 * hitting nothing is just a day with nothing to cancel.
 */
export function applyOverrides(base, overrides) {
  var blocks = base.map(function (b) { return Object.assign({}, b); });
  var stale = [];
  var list = (overrides || []).slice().sort(function (a, b) { return a.id - b.id; });

  list.forEach(function (o) {
    if (o.kind !== 'cancel') return;
    var hit = 0;
    blocks.forEach(function (b) {
      if (!isActive(b) || b.src !== 'template' || !cancelHits(o, b)) return;
      b.state = o.group_kind === 'move' ? 'moved_out' : 'cancelled';
      b.reason = o.reason || '';
      b.override_id = o.id;
      b.group_id = o.group_id || null;
      b.group_kind = o.group_kind || null;
      hit++;
    });
    if (!hit && o.group_kind !== 'range') stale.push(o.id);
  });

  list.forEach(function (o) {
    if (o.kind !== 'add') return;
    var add = {
      cat: o.category, s: o.slot_from * 15, e: o.slot_to * 15, slot: o.slot_from,
      note: o.note || '', room: o.room || '', who: o.who || '',
      src: 'added', state: o.group_kind === 'move' ? 'moved_in' : 'added',
      reason: o.reason || '', override_id: o.id, group_id: o.group_id || null, group_kind: o.group_kind || null, overlap: null
    };
    /* Side by side, never hidden: whether the default block it lands on is
       cancelled is Kacey's call (an Opus turn), not this function's. */
    var under = blocks.filter(function (b) { return b.src === 'template' && b.state === 'template' && overlaps(b, add); });
    if (under.length) {
      add.overlap = o.overlap === 'keep' ? 'keep' : 'pending';
      under.forEach(function (b) { if (b.overlap !== 'pending') b.overlap = add.overlap; });
    }
    blocks.push(add);
  });

  blocks.sort(function (a, b) { return a.s - b.s || (a.src === 'template' ? -1 : 1); });
  return { blocks: blocks, stale: stale };
}

/** The overrides that belong to `date`. */
export function overridesOn(overrides, date) {
  return (overrides || []).filter(function (o) { return o.date === date; });
}

/**
 * One date, live: the weekday's default with that date's overrides.
 * `routine.overrides` is where the app document carries them.
 */
export function effectiveDay(routine, date, overrides) {
  var own = overridesOn(overrides || (routine && routine.overrides), date);
  var out = applyOverrides(templateBlocks(routine, dowOf(date)), own);
  return { date: date, kind: 'live', blocks: out.blocks, stale: out.stale, altered: own.length > 0 };
}

/**
 * One date, whichever way it is known: its cemented copy when there is one
 * (`routine.days[date]`), otherwise live. The night run's rules and the
 * calendar lane both call this.
 */
export function dayOf(routine, date) {
  var snap = routine && routine.days && routine.days[date];
  if (snap) {
    return { date: date, kind: 'cemented', blocks: snap.blocks || [], stale: [], altered: !!snap.altered,
             amended_at: snap.amended_at || null };
  }
  return effectiveDay(routine, date);
}

/** Only the blocks that still happen. */
export function activeBlocks(day) {
  return day.blocks.filter(isActive);
}

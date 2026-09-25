/**
 * Kacey — morning mode's decisions. The pure half.
 *
 * When the brief plays (the sunrise peak), when it is rewritten first (T−5),
 * what the fixed checklist holds today, and when the morning is over.
 * morning.js does the I/O; test/morning.mjs tests these with a fake clock.
 * docs/DREAM.md §12.
 */

export const REFRESH_BEFORE_MIN = 5;
/* A peak more than this long ago is not played: the server was down through
   the morning, and a brief at 10:40 about "this morning" is worse than none. */
export const LATE_LIMIT_MIN = 120;
export const PROPOSALS_KEY = 'proposals';

const MIN = 60000;

function at(date, hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(y, mo - 1, d, Number(m[1]), Number(m[2]));
}

/** The sunrise peak for a logical date, from lightsd's 'HH:MM' (inside the wake window, so on that date). */
export function peakInstant(date, hhmm) { return at(date, hhmm); }

/** A fresh morning record: the fixed items, all unticked. */
export function freshRecord(date, items) {
  return {
    logical_date: date,
    state: 'pending',            // pending → active → done | ended; or ended straight away (lid, missed)
    peak_at: null,
    refresh_checked: false,
    rewritten_at: null,
    started_at: null,
    ended_at: null,
    end_reason: null,
    delivered: null,
    why: null,
    last_interaction_at: null,
    items: items.map((i) => ({ key: i.key, label: i.label, done: false, done_at: null })),
  };
}

/**
 * The "Projít návrhy od Kacey (N)" item. It appears when proposals are
 * waiting as the morning starts, counts down as they are decided, and ticks
 * itself when none are left — it cannot be ticked by hand, because deciding
 * is what ticks it.
 */
export function withProposals(items, { pending, total }, now = new Date()) {
  const list = items.filter((i) => i.key !== PROPOSALS_KEY);
  const had = items.find((i) => i.key === PROPOSALS_KEY);
  if (!had && pending === 0) return list;
  const done = pending === 0;
  list.push({
    key: PROPOSALS_KEY,
    label: `Projít návrhy od Kacey (${Math.max(total, pending)})`,
    auto: true,
    pending, total: Math.max(total, pending),
    done,
    done_at: done ? (had && had.done_at) || now.toISOString() : null,
  });
  return list;
}

export function allDone(items) { return items.length > 0 && items.every((i) => i.done); }

/**
 * What the tick should do now.
 *   { refresh: true }   check the brief is still true (T−5)
 *   { fire: true }      start the morning (T)
 *   { end: reason }     'done' | 'timeout' | 'missed'
 *   {}                  nothing
 */
export function morningStep(rec, now, { peak, morningEnd = '09:00' } = {}) {
  const t = now.getTime();
  if (rec.state === 'pending') {
    if (!peak) return {};
    const p = peak.getTime();
    if (t >= p + LATE_LIMIT_MIN * MIN) return { end: 'missed' };
    if (t >= p) return { fire: true };
    if (t >= p - REFRESH_BEFORE_MIN * MIN && !rec.refresh_checked) return { refresh: true };
    return {};
  }
  if (rec.state === 'active') {
    if (allDone(rec.items)) return { end: 'done' };
    /* Nobody touched it since the brief: nobody is there, and a checklist on
       a lit screen all day helps no one. If somebody did, it waits for them. */
    const end = at(rec.logical_date, morningEnd);
    if (end && t >= end.getTime() && !rec.last_interaction_at) return { end: 'timeout' };
  }
  return {};
}

/** The day's history entry, from a finished record. */
export function historyEntry(rec) {
  const started = rec.started_at ? new Date(rec.started_at).getTime() : null;
  const ended = rec.ended_at ? new Date(rec.ended_at).getTime() : null;
  return {
    done: rec.items.filter((i) => i.done).map((i) => i.key),
    total: rec.items.length,
    delivered: rec.delivered,
    why: rec.why,
    end_reason: rec.end_reason,
    started_at: rec.started_at,
    completed_at: rec.end_reason === 'done' ? rec.ended_at : null,
    minutes: started && ended ? Math.round((ended - started) / MIN) : null,
  };
}

/**
 * Kacey — is the person asleep? The pure half.
 *
 * Three states, awake | winding_down | asleep, driven by events: the lightsd
 * sleep button, interaction, the sunrise, and a clock tick. Everything here is
 * a function of (state, event, now, settings) — no database, no timers, no
 * clock of its own — so test/sleep.mjs can drive a whole night with a fake
 * clock in milliseconds. night.js owns the persistence and the effects.
 *
 * Nothing keeps time in memory. A state carries the instants it needs
 * (`until` for the wind-down) and every tick re-evaluates them, so a restart
 * at 00:59 of a 01:00 deadline loses nothing. See docs/DREAM.md §7.
 */

import { addDays } from './public/js/core/due.js';

export const SLEEP_STATES = ['awake', 'winding_down', 'asleep'];

const MIN = 60000;

function iso(d) { return new Date(d).toISOString(); }

/** 'HH:MM' -> minutes since midnight, or null. */
export function clockMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function minutesOf(now) { return now.getHours() * 60 + now.getMinutes(); }

export function initialSleep(now, reason = 'boot') {
  return { state: 'awake', since: iso(now), reason };
}

/**
 * A stored state made safe to use: anything unreadable becomes `awake`, since
 * a garbled record must not leave Kacey believing the owner is asleep all day.
 */
export function normalizeSleep(raw, now) {
  if (!raw || typeof raw !== 'object' || !SLEEP_STATES.includes(raw.state)) return initialSleep(now);
  if (isNaN(Date.parse(raw.since))) return initialSleep(now);
  if (raw.state === 'winding_down' && isNaN(Date.parse(raw.until))) return initialSleep(now);
  return raw;
}

/**
 * The day a run plans (docs/DREAM.md §4). Before noon it is today's logical
 * day — a late run for this morning; from noon it can only mean tomorrow. This
 * is what makes a 23:50 sleep trigger and the 04:00 fallback name the same day.
 *
 * Worked out from the wall clock, not by subtracting hours: the logical day
 * before the boundary is yesterday and the rule then adds one back, so the
 * whole thing reduces to "the calendar date, or tomorrow from noon". Hour
 * arithmetic in milliseconds gets 04:00–04:59 wrong on the spring DST day,
 * when only three wall hours have passed since midnight.
 */
export function targetDate(now) {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return minutesOf(now) >= 12 * 60 ? addDays(today, 1) : today;
}

/**
 * One event in, the next state and what to do about it out.
 *
 *   event: { type: 'sleep_start', since? } | { type: 'interaction', kind }
 *        | { type: 'awake_early' } | { type: 'sunrise' } | { type: 'tick' }
 *   returns { state, effects: [{ type: 'screen_off' } | { type: 'start_run', trigger, at }] }
 *
 * `state` is the SAME object when nothing changed, so the caller can skip the
 * write and the broadcast with an identity check.
 */
export function sleepStep(state, event, now, settings = {}) {
  const t = now.getTime();
  const delay = Math.max(1, Number(settings.sleep_delay_min) || 60) * MIN;

  switch (event && event.type) {
    case 'sleep_start': {
      /* From any state: pressing the button again starts the hour over. The
         start may be backdated (lightsd's held_for, when the press happened
         while Kacey was down) but never into the future. */
      const since = Math.min(t, Date.parse(event.since) || t);
      return {
        state: { state: 'winding_down', since: iso(since), until: iso(since + delay) },
        effects: [{ type: 'screen_off' }],
      };
    }

    case 'interaction':
    case 'awake_early':
      if (state.state === 'awake') return { state, effects: [] };
      // A run already started keeps going; only the wind-down timer dies,
      // and it dies with the state that held it.
      return { state: { state: 'awake', since: iso(t), reason: 'interaction' }, effects: [] };

    case 'sunrise':
      // lightsd let the room go at wake_at. Not an interaction: nobody did anything.
      if (state.state === 'awake') return { state, effects: [] };
      return { state: { state: 'awake', since: iso(t), reason: 'sunrise' }, effects: [] };

    case 'tick':
      if (state.state === 'winding_down' && Date.parse(state.until) <= t) {
        /* Asleep as of the deadline, not as of this tick: a tick up to 30 s
           late, or a restart across the deadline, must not move the bedtime. */
        return {
          state: { state: 'asleep', since: state.until },
          // `at` is the moment of falling asleep: the run's target date comes
          // from that, not from whenever this tick happened to land.
          effects: [{ type: 'start_run', trigger: 'sleep', at: state.until }],
        };
      }
      return { state, effects: [] };

    default:
      return { state, effects: [] };
  }
}

/**
 * Catch-up at boot (docs/DREAM.md §10): the server was down through the night
 * and the fallback window. Worth running only while the morning it plans is
 * still ahead — after the fallback window and before the brief (the sunrise
 * peak, or 09:00 when lightsd never said). Planning a morning that is over
 * would only put stale proposals on the screen.
 */
export function catchupDue(now, { peak, fallback } = {}, startHour = 4) {
  const fb = clockMinutes(fallback);
  const from = (fb === null ? startHour * 60 : fb) + FALLBACK_WINDOW_MIN;
  const until = clockMinutes(peak) ?? 9 * 60;
  const mins = minutesOf(now);
  return mins >= from && mins < Math.min(until, 12 * 60);
}

/** How long after the fallback time it may still fire — a restart at 04:20 still counts. */
export const FALLBACK_WINDOW_MIN = 60;

/**
 * Should the fallback start a run now? Only within an hour of the fallback
 * time, only when nothing has run for today's target date yet, and never with
 * the night run switched off. It does not look at the sleep state on purpose:
 * if the owner is still up at 04:00, the day gets planned anyway.
 *
 * The window is short on purpose. A server that boots at 11:00 must not plan
 * a morning that is already over; a later boot is catch-up's call, which
 * checks whether the brief is still ahead (docs/DREAM.md §10, phase P5).
 */
export function fallbackDue(now, settings = {}, lastRunDate = null, startHour = 4) {
  if (settings.enabled === false) return false;
  const from = clockMinutes(settings.fallback);
  const start = from === null ? startHour * 60 : from;
  const mins = minutesOf(now);
  if (mins < start || mins >= Math.min(start + FALLBACK_WINDOW_MIN, 12 * 60)) return false;
  return lastRunDate !== targetDate(now);
}

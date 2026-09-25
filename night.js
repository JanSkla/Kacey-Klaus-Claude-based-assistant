/**
 * Kacey — the night routine's clock and wiring.
 *
 * sleep.js decides; this carries it out. It holds the one copy of the sleep
 * state (in kacey_kv, `night.sleep`, so a restart does not lose the night),
 * feeds it lightsd's events and the owner's interactions, and runs a 30 s tick
 * that re-evaluates everything from the stored instants. Polling rather than
 * a setTimeout for "an hour from now", for the same reason the wake word is
 * supervised by polling: a timer dies with the process, a tick cannot get
 * wedged.
 *
 * The tick also starts the night run (dream.js) — on falling asleep, at the
 * fallback hour, as a catch-up after a missed night, or as the one automatic
 * retry of a failed run — and expires proposals whose event has passed.
 * docs/DREAM.md §7 and §10.
 */

import { kvGet, kvSet } from './db.js';
import { LIGHTSD_URL, NIGHT_DEFAULTS, NIGHT_TICK_MS, DREAM_STUCK_HOURS } from './config.js';
import { sleepStep, normalizeSleep, targetDate, fallbackDue, catchupDue } from './sleep.js';
import { diffLightsd, makeLightsdClient } from './lightsd.js';
import * as screen from './screen.js';
import * as nightstore from './nightstore.js';
import { runNight } from './dream.js';
import { expiredProposals, decisionsForModel } from './nightplan.js';

const log = (...a) => console.log('[night]', ...a);

/** What the page may report as an interaction. A mouse move is not one. */
export const INTERACTION_KINDS = ['pointer', 'key', 'touch', 'wake', 'message'];

/* A failed run is retried automatically once, but not in a tight loop: a
   model outage at 01:00 is unlikely to be over 30 s later. */
const RETRY_AFTER_MS = 10 * 60000;

let sleep = null;
let lightsd = null;
let lightsdPrev = null;        // the previous lightsd status on the current connection
let tickTimer = null;
let broadcast = () => {};
let deps = {};                 // runner, persona, onWrite — handed to dream.js
let inFlight = null;           // { date, promise } while a run is going in this process

export function settings() {
  const stored = (kvGet('settings', {}) || {}).night;
  return { ...NIGHT_DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {}) };
}

function describe(s) {
  if (s.state === 'winding_down') return `winding_down until ${new Date(s.until).toLocaleTimeString('cs-CZ')}`;
  return `${s.state}${s.reason ? ` (${s.reason})` : ''}`;
}

/* ---- the state machine, applied ---------------------------------------- */

/* What happened each night, for the Brief view's timeline (§12): when the
   button was pressed, when sleep was confirmed, when the sunrise came. Keyed
   by the target date the night plans; kept for three weeks. */
const LOG_DAYS = 21;
function logNight(date, patch) {
  const all = kvGet('night.log', {}) || {};
  all[date] = { ...(all[date] || {}), ...patch };
  const keys = Object.keys(all).sort();
  while (keys.length > LOG_DAYS) delete all[keys.shift()];
  kvSet('night.log', all);
}

export function nightLog(date) { return (kvGet('night.log', {}) || {})[date] || {}; }

function apply(event, now = new Date()) {
  const { state, effects } = sleepStep(sleep, event, now, settings());
  const changed = state !== sleep;       // sleepStep returns the same object for "no change"
  if (changed) {
    log(`${describe(sleep)} -> ${describe(state)} [${event.type}${event.kind ? ':' + event.kind : ''}]`);
    if (state.state === 'winding_down') logNight(targetDate(new Date(state.since)), { winding_at: state.since, asleep_at: null, cancelled_at: null });
    else if (state.state === 'asleep') logNight(targetDate(new Date(state.since)), { asleep_at: state.since });
    else if (sleep.state === 'winding_down' && state.reason === 'interaction') logNight(targetDate(new Date(sleep.since)), { cancelled_at: state.since });
    if (event.type === 'sunrise') logNight(targetDate(now), { sunrise_at: now.toISOString() });
    sleep = state;
    kvSet('night.sleep', sleep);
  }
  for (const effect of effects) {
    if (effect.type === 'screen_off') screen.off('winding_down');
    else if (effect.type === 'start_run') startRun(effect.trigger, effect.at ? new Date(effect.at) : now);
  }
  if (changed) push();
  return state;
}

/* Called on every status from lightsd: turn the difference into events. */
function onLightsdStatus(status, first) {
  const events = diffLightsd(first ? null : lightsdPrev, status, { now: new Date(), sleep });
  lightsdPrev = status;
  rememberLightsd(status);
  for (const ev of events) apply(ev);
}

/* The last clock times lightsd published, kept for the morning (§12), which
   must still know when the sunrise peaks if lightsd is down that night. */
let lastSeen = null;
function rememberLightsd(status) {
  const seen = { wake_at: status.wake_at ?? null, morning_peak_at: status.morning_peak_at ?? null };
  if (lastSeen && lastSeen.wake_at === seen.wake_at && lastSeen.morning_peak_at === seen.morning_peak_at) return;
  lastSeen = seen;
  kvSet('lightsd.last', { ...seen, at: new Date().toISOString() });
}

/* ---- the run ------------------------------------------------------------- */

/**
 * Start the night run for the day `at` plans (the noon rule, sleep.js). One
 * at a time in this process; the database claim in dream.js is what makes
 * it once per date across restarts and races.
 */
export function startRun(trigger, at = new Date(), { force = false, date } = {}) {
  if (trigger !== 'manual' && !settings().enabled) {
    log(`night run skipped (${trigger}): switched off in settings`);
    return null;
  }
  const target = date || targetDate(at);
  if (inFlight) {
    log(`night run for ${target} (${trigger}) not started: ${inFlight.date} is still running`);
    return inFlight.promise;
  }
  if (trigger !== 'manual' && !nightstore.canAutoStart(target)) {
    log(`night run for ${target} already happened; not again (${trigger})`);
    return null;
  }
  const promise = runNight({ date: target, trigger, force }, deps)
    .catch((err) => { log(`night run crashed: ${err.stack || err.message}`); return null; })
    .finally(() => { inFlight = null; push(); });
  inFlight = { date: target, promise };
  push();
  return promise;
}

/* ---- the tick ---------------------------------------------------------- */

function tick() {
  const now = new Date();
  try {
    apply({ type: 'tick' }, now);

    const s = settings();
    const target = targetDate(now);
    if (fallbackDue(now, s, nightstore.canAutoStart(target) ? null : target)) startRun('fallback', now);

    // The one automatic retry of a failed run, while the night is still on.
    const run = nightstore.getRun(target);
    if (run && run.status === 'failed' && !inFlight && nightstore.canAutoStart(target)
        && now.getTime() - new Date(run.finished_at || run.started_at).getTime() > RETRY_AFTER_MS
        && (sleep.state === 'asleep' || fallbackDue(now, s, null))) {
      log(`retrying the failed night run for ${target}`);
      startRun(run.trigger, now);
    }

    const expired = expiredProposals(nightstore.listProposals({ status: 'pending', limit: 200 }), now);
    if (expired.length) {
      nightstore.markExpired(expired.map((p) => p.proposal_id), now);
      log(`${expired.length} proposal(s) expired: their event has passed`);
      if (deps.onWrite) deps.onWrite('proposals');
      push();
    }

    if (deps.onTick) deps.onTick(now);
  } catch (err) {
    // One bad tick must not stop the next one.
    log(`tick failed: ${err.stack || err.message}`);
  }
}

/* A missed night, caught up at boot — only while its morning is still ahead. */
function catchUp(now = new Date()) {
  const target = targetDate(now);
  const peak = (kvGet('lightsd.last', null) || {}).morning_peak_at;
  if (!catchupDue(now, { peak, fallback: settings().fallback })) return;
  if (!nightstore.canAutoStart(target)) return;
  log(`catching up the night run for ${target}`);
  startRun('catchup', now);
}

/* ---- the outside world ------------------------------------------------- */

/** The owner did something: a tap, a key, the wake word, a message. */
export function noteInteraction(kind) {
  if (!sleep || !INTERACTION_KINDS.includes(kind)) return;
  /* Light the panel for whoever is there: the wake word said from bed, or a
     tap or key at the kiosk. On kaceybody nothing else would — the panel is
     dark at the backlight and the OS does not know. A message typed on a
     phone is not somebody at the bedside. */
  if (kind === 'message') screen.noteActivity();
  else screen.wake(kind === 'wake' ? 'wake word' : kind);
  apply({ type: 'interaction', kind });
  if (deps.onInteraction) deps.onInteraction(kind);
}

/**
 * The mouse moved over the kiosk page. Wakes or keeps the panel lit, but is
 * NOT an interaction: a cat on the touchpad must not cancel the night.
 */
export function notePresence() {
  screen.wake('pointer');
}

/** The page started or stopped speaking. Keeps the panel lit; not an interaction. */
export function noteSpeaking(on) {
  screen.setSpeaking(on);
}

/* docs/DREAM.md §6: the wake word only listens while the page is visible, and
   whether Chromium hides a kiosk page when DPMS blanks the panel is something
   to measure on kaceybody, not assume. So the page reports, and this logs. */
export function noteVisibility(state) {
  log(`page visibility: ${state} (screen ${screen.status().state})`);
}

export function runSummary(r) {
  if (!r) return null;
  const rep = r.report || {};
  return {
    logical_date: r.logical_date, status: r.status, trigger: r.trigger, attempts: r.attempts,
    started_at: r.started_at, finished_at: r.finished_at,
    tasks: (rep.rules?.created || []).length, proposals: rep.reasoning?.proposals || 0,
    reasoning: rep.reasoning?.status || null, brief: rep.brief?.status || null,
    error: rep.error || rep.reasoning?.error || (rep.reset === 'stuck' ? 'přerušený běh' : null),
  };
}

/** Everything the readout and the `night_state` frame show. */
export function nightState() {
  const now = new Date();
  const s = settings();
  const last = nightstore.recentRuns(1)[0] || null;
  return {
    sleep,
    screen: screen.status(),
    lightsd: lightsd ? lightsd.status() : { mode: 'down' },
    run: {
      last: runSummary(last),
      running: inFlight ? inFlight.date : null,
      next: { logical_date: targetDate(now), fallback: s.fallback },
    },
    pending_proposals: nightstore.listProposals({ status: 'pending', limit: 200 }).length,
    ...(deps.morningState ? { morning: deps.morningState() } : {}),
    enabled: s.enabled,
  };
}

export function push() {
  try { broadcast({ type: 'night_state', ...nightState() }); } catch (err) { log(`broadcast failed: ${err.message}`); }
}

/**
 *   broadcast  (frame) => void — every open page
 *   runner     the model runner for dream.js (default: the Agent SDK)
 *   persona    (date) => the rendered persona, for the brief
 *   onWrite    (section) => void — app_changed for tasks / proposals
 */
export function startNight(options = {}) {
  if (typeof options.broadcast === 'function') broadcast = options.broadcast;
  /* The learning loop (§13): the last ~30 decisions go into every reasoning
     pass, so what was rejected does not come back. */
  deps = { decisions: () => decisionsForModel(nightstore.recentDecisions(30)), ...deps, ...options };
  sleep = normalizeSleep(kvGet('night.sleep', null), new Date());
  log(`starting: ${describe(sleep)}; lightsd at ${LIGHTSD_URL}`);

  const reset = nightstore.resetStuckRuns(DREAM_STUCK_HOURS);
  if (reset.length) log(`reset stuck run(s): ${reset.join(', ')}`);

  lightsd = makeLightsdClient({ url: LIGHTSD_URL, onStatus: onLightsdStatus, log });
  lightsd.start();
  screen.startScreen({ getIdleMinutes: () => settings().screen_idle_min });

  tick();
  catchUp();
  tickTimer = setInterval(tick, NIGHT_TICK_MS);
}

/** Let later phases (morning.js) add hooks after startNight. */
export function extendNight(more) { deps = { ...deps, ...more }; }

export function stopNight() {
  clearInterval(tickTimer);
  tickTimer = null;
  lightsd?.stop();
  screen.stopScreen();
}

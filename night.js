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
 * The night run itself is a stub until phase P5 (docs/DREAM.md §10): it logs,
 * and records the target date in `night.last_run` so that it happens once per
 * date — which is the part the fallback and the sleep trigger depend on now.
 */

import { kvGet, kvSet } from './db.js';
import { LIGHTSD_URL, LOGICAL_DAY_START_HOUR, NIGHT_DEFAULTS, NIGHT_TICK_MS } from './config.js';
import { sleepStep, normalizeSleep, targetDate, fallbackDue } from './sleep.js';
import { diffLightsd, makeLightsdClient } from './lightsd.js';
import * as screen from './screen.js';

const log = (...a) => console.log('[night]', ...a);

/** What the page may report as an interaction. A mouse move is not one. */
export const INTERACTION_KINDS = ['pointer', 'key', 'touch', 'wake', 'message'];

let sleep = null;
let lightsd = null;
let lightsdPrev = null;        // the previous lightsd status on the current connection
let tickTimer = null;
let broadcast = () => {};

function settings() {
  const stored = (kvGet('settings', {}) || {}).night;
  return { ...NIGHT_DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {}) };
}

function describe(s) {
  if (s.state === 'winding_down') return `winding_down until ${new Date(s.until).toLocaleTimeString('cs-CZ')}`;
  return `${s.state}${s.reason ? ` (${s.reason})` : ''}`;
}

/* ---- the state machine, applied ---------------------------------------- */

function apply(event, now = new Date()) {
  const { state, effects } = sleepStep(sleep, event, now, settings());
  const changed = state !== sleep;       // sleepStep returns the same object for "no change"
  if (changed) {
    log(`${describe(sleep)} -> ${describe(state)} [${event.type}${event.kind ? ':' + event.kind : ''}]`);
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

/* ---- the run (a stub until P5) ----------------------------------------- */

function startRun(trigger, now = new Date()) {
  if (!settings().enabled) {
    log(`night run skipped (${trigger}): switched off in settings`);
    return false;
  }
  const date = targetDate(now);
  const last = kvGet('night.last_run', null);
  if (last && last.logical_date === date) {
    log(`night run for ${date} already happened (${last.trigger}); not again (${trigger})`);
    return false;
  }
  const record = { logical_date: date, trigger, started_at: now.toISOString(), status: 'done', stub: true };
  kvSet('night.last_run', record);
  log(`night run for ${date} (trigger: ${trigger}) — stub, nothing planned yet`);
  push();
  return true;
}

/* ---- the tick ---------------------------------------------------------- */

function tick() {
  const now = new Date();
  try {
    apply({ type: 'tick' }, now);
    const last = kvGet('night.last_run', null);
    if (fallbackDue(now, settings(), last && last.logical_date, LOGICAL_DAY_START_HOUR)) {
      startRun('fallback', now);
    }
  } catch (err) {
    // One bad tick must not stop the next one.
    log(`tick failed: ${err.message}`);
  }
}

/* ---- the outside world ------------------------------------------------- */

/** The owner did something: a tap, a key, the wake word, a message. */
export function noteInteraction(kind) {
  if (!sleep || !INTERACTION_KINDS.includes(kind)) return;
  screen.noteActivity();
  // The wake word is said from bed, in the dark: light the panel for the answer.
  // A tap or a key already woke it through the OS.
  if (kind === 'wake') screen.on('wake word');
  apply({ type: 'interaction', kind });
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

/** Everything the readout and the `night_state` frame show. */
export function nightState() {
  const now = new Date();
  return {
    sleep,
    screen: screen.status(),
    lightsd: lightsd ? lightsd.status() : { mode: 'down' },
    run: {
      last: kvGet('night.last_run', null),
      next: { logical_date: targetDate(now), fallback: settings().fallback },
    },
    enabled: settings().enabled,
  };
}

function push() {
  try { broadcast({ type: 'night_state', ...nightState() }); } catch (err) { log(`broadcast failed: ${err.message}`); }
}

export function startNight({ broadcast: send } = {}) {
  if (typeof send === 'function') broadcast = send;
  sleep = normalizeSleep(kvGet('night.sleep', null), new Date());
  log(`starting: ${describe(sleep)}; lightsd at ${LIGHTSD_URL}`);

  lightsd = makeLightsdClient({ url: LIGHTSD_URL, onStatus: onLightsdStatus, log });
  lightsd.start();
  screen.startScreen({ getIdleMinutes: () => settings().screen_idle_min });

  tick();
  tickTimer = setInterval(tick, NIGHT_TICK_MS);
}

export function stopNight() {
  clearInterval(tickTimer);
  tickTimer = null;
  lightsd?.stop();
  screen.stopScreen();
}

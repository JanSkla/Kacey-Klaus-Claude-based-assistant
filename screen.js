/**
 * Kacey — the bedside screen and the lid.
 *
 * The screen is dark by default and lit by Kacey: for the wake word, a tap, a
 * key, the mouse moving over the kiosk page, speech, and the morning. It goes
 * dark again after the idle timeout (docs/DREAM.md §6).
 *
 * Two ways to switch it, picked at start:
 *
 *   backlight  /sys/class/backlight/<dev>/bl_power (0 = on, 4 = off). What
 *              kaceybody uses: its kiosk is cage on Wayland, which has no
 *              output-power protocol, so the panel can only be darkened at
 *              the backlight. Needs the file writable by Kacey's user — a
 *              udev rule in the runbook. The compositor keeps running with
 *              the backlight off, so the kiosk page still gets pointer and
 *              key events: that is how a dark screen is woken.
 *   xset       `xset dpms force on|off` on an X display, for a desktop setup.
 *              X's own input wakes the panel there, so the idle check also
 *              reads X's idle time (xprintidle) to darken it again.
 *
 * With the backlight, going dark is a 20 s fade rather than a cut: the panel
 * dims down (brightness), then the backlight goes off. Anybody who moves the
 * mouse, taps or talks during the fade gets full brightness back at once, and
 * the fade is the warning that the screen is about to go.
 *
 * "Nechat hrát vinyl" (the music player's button) keeps the panel lit: no idle
 * fade, and the morning's own "back to sleep" is skipped. Only somebody saying
 * so ends it — the button again, "Zpět do klidu", or the night winding down.
 *
 * ONE owner decides when the panel sleeps: this module. Every change is
 * logged with its reason, because "why did the screen come on at three in the
 * morning" has to be answerable from the log alone.
 *
 * Without either (the Windows dev box, a machine without the udev rule) this
 * is a logged no-op rather than an error: the night routine still runs.
 */

import { execFile } from 'node:child_process';
import { accessSync, constants, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { KACEY_DISPLAY, KACEY_XAUTHORITY } from './config.js';

const log = (...a) => console.log('[screen]', ...a);

const IDLE_CHECK_MS = 10000;
const LID_DIR = '/proc/acpi/button/lid';
const BACKLIGHT_DIR = '/sys/class/backlight';
const BL_ON = '0';
const BL_OFF = '4';
const FADE_MS = 20000;             // idle → dark takes this long, not an instant
const FADE_STEP_MS = 250;
const FADE_FLOOR = 0.04;           // the last step before the backlight goes off

let backend = null;                // 'backlight' | 'xset' | 'none', decided on first use
let blPower = null;                // the bl_power file, for the backlight backend
let hasXprintidle = true;
let current = { state: 'unknown', since: null, reason: null };
let lastActivity = Date.now();     // Kacey's own: an interaction, presence, the end of speech, on()
let speaking = false;
let idleTimer = null;
let idleMinutes = () => 2;
let warned = false;
let fade = null;                   // { timer } while the panel is dimming towards off
let keepOn = false;                // "Nechat hrát vinyl": no idle timeout until released
const keepListeners = new Set();

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      env: { ...process.env, DISPLAY: KACEY_DISPLAY, XAUTHORITY: KACEY_XAUTHORITY },
      timeout: 5000,
    }, (err, stdout) => resolve({ err, out: String(stdout || '') }));
  });
}

/** Which backend this machine has. Checked once; a restart picks up a new udev rule. */
function pickBackend() {
  if (backend) return backend;
  if (process.platform !== 'linux') return (backend = 'none');
  try {
    for (const dev of readdirSync(BACKLIGHT_DIR)) {
      const file = path.join(BACKLIGHT_DIR, dev, 'bl_power');
      try { accessSync(file, constants.W_OK); blPower = file; return (backend = 'backlight'); } catch { /* not writable */ }
    }
  } catch { /* no backlight class */ }
  // A backlight exists but is not ours to write: say how to fix it, once.
  try {
    if (readdirSync(BACKLIGHT_DIR).length && !warned) {
      warned = true;
      log(`${BACKLIGHT_DIR}/*/bl_power is not writable — the screen stays as it is until the udev rule from docs/RUNBOOK-kaceybody.md is in place`);
    }
  } catch { /* none */ }
  return (backend = 'xset');
}

/* ---- brightness (backlight backend) ------------------------------------------
   The kiosk never changes brightness otherwise, so "full" is the maximum. */

function brightnessFiles() {
  const dir = path.dirname(blPower);
  return { file: path.join(dir, 'brightness'), max: path.join(dir, 'max_brightness') };
}

function fullBrightness() {
  try { return Number(readFileSync(brightnessFiles().max, 'utf8').trim()) || null; } catch { return null; }
}

function setBrightness(level) {
  try { writeFileSync(brightnessFiles().file, String(Math.max(1, Math.round(level)))); return true; } catch { return false; }
}

/** Dim towards dark over FADE_MS, then switch the backlight off. */
function startFade() {
  if (fade) return;
  const full = fullBrightness();
  if (!full || !setBrightness(full)) { off('idle'); return; }   // cannot dim here: plain off
  const started = Date.now();
  log(`fading (idle, ${FADE_MS / 1000} s)`);
  fade = {
    timer: setInterval(() => {
      const t = (Date.now() - started) / FADE_MS;
      if (t >= 1) {
        clearInterval(fade.timer);
        fade = null;
        off('idle').finally(() => setBrightness(full));   // lit at full next time
        return;
      }
      // Eyes read brightness roughly logarithmically: a squared curve looks even.
      setBrightness(full * (FADE_FLOOR + (1 - FADE_FLOOR) * (1 - t) * (1 - t)));
    }, FADE_STEP_MS),
  };
}

/** Somebody is back during the fade: full brightness now. */
function cancelFade(reason) {
  if (!fade) return;
  clearInterval(fade.timer);
  fade = null;
  const full = fullBrightness();
  if (full) setBrightness(full);
  log(`fade cancelled (${reason})`);
}

function set(state, reason) {
  if (current.state === state && current.reason === reason) return;
  current = { state, since: new Date().toISOString(), reason };
}

async function force(state, reason) {
  if (state === 'on') { lastActivity = Date.now(); cancelFade(reason); }
  const b = pickBackend();
  if (b === 'none') {
    log(`${state} (${reason}) — no-op, no screen control here`);
    set(state, reason);
    return false;
  }
  if (b === 'backlight') {
    if (current.state === state) { set(state, current.reason); return true; }
    try {
      writeFileSync(blPower, state === 'on' ? BL_ON : BL_OFF);
    } catch (err) {
      log(`${state} (${reason}) failed: ${err.message}`);
      return false;
    }
    set(state, reason);
    log(`${state} (${reason})`);
    return true;
  }
  const { err } = await run('xset', ['dpms', 'force', state]);
  if (err) {
    if (err.code === 'ENOENT') { backend = 'none'; log('xset not found — the screen is not controlled on this machine'); }
    else log(`${state} (${reason}) failed: ${String(err.message).trim()}`);
    return false;
  }
  set(state, reason);
  log(`${state} (${reason})`);
  return true;
}

export function on(reason) { return force('on', reason); }

/**
 * Dark now. While the panel is kept lit this is skipped, unless `release`:
 * an off somebody asked for ("Zpět do klidu", the night winding down) ends
 * the keep; an automatic one (the morning is done) does not.
 */
export function off(reason, { release = false } = {}) {
  if (keepOn) {
    if (!release) { log(`off (${reason}) skipped — kept lit`); return Promise.resolve(false); }
    setKeepOn(false, reason);
  }
  return force('off', reason);
}

/* ---- kept lit ("Nechat hrát vinyl") -------------------------------------- */

export function keptOn() { return keepOn; }

export function onKeepChange(fn) {
  keepListeners.add(fn);
  return () => keepListeners.delete(fn);
}

/** Keep the panel lit (and light it now), or hand it back to the idle timeout. */
export function setKeepOn(value, reason = 'button') {
  const next = !!value;
  if (next === keepOn) return keepOn;
  keepOn = next;
  lastActivity = Date.now();          // released: the full timeout from now
  log(keepOn ? `kept lit (${reason})` : `keep released (${reason})`);
  if (keepOn) { cancelFade('kept lit'); if (current.state !== 'on') on('kept lit'); }
  for (const fn of keepListeners) {
    try { fn(keepOn); } catch { /* a closed stream must not stop the rest */ }
  }
  return keepOn;
}

/** Something happened that should keep a lit panel lit for another timeout. */
export function noteActivity() { lastActivity = Date.now(); cancelFade('activity'); }

/**
 * Somebody is at the screen (a tap, a key, the mouse over the kiosk page): keep
 * it lit, and light it if it was dark — with the backlight backend nothing else
 * would, because the OS does not know the panel is off.
 */
export function wake(reason) {
  lastActivity = Date.now();
  cancelFade(reason);
  if (current.state !== 'on') return on(reason);
  return Promise.resolve(true);
}

/** Kacey is speaking: the panel stays on, and the idle clock starts when she stops. */
export function setSpeaking(isOn) {
  speaking = !!isOn;
  lastActivity = Date.now();
  if (speaking) cancelFade('speaking');
}

/* ---- the lid ------------------------------------------------------------ */

/**
 * 'open' | 'closed' | 'unknown'. Unknown (no ACPI lid, not Linux) counts as
 * open wherever a decision depends on it: skipping the brief because we could
 * not read a lid is worse than playing it into a closed laptop.
 */
export function readLid() {
  try {
    for (const dir of readdirSync(LID_DIR)) {
      const text = readFileSync(path.join(LID_DIR, dir, 'state'), 'utf8');
      const m = /state:\s*(open|closed)/i.exec(text);
      if (m) return m[1].toLowerCase();
    }
  } catch { /* no ACPI lid here */ }
  return 'unknown';
}

/* ---- the idle check ----------------------------------------------------- */

/** 'on' | 'off' | null, as the hardware says — the source of truth after a restart. */
async function panelState() {
  if (backend === 'backlight') {
    try { return readFileSync(blPower, 'utf8').trim() === BL_ON ? 'on' : 'off'; } catch { return null; }
  }
  if (backend === 'xset') {
    const { err, out } = await run('xset', ['q']);
    if (err) return null;
    const m = /Monitor is (\w+)/.exec(out);
    return m ? (m[1] === 'On' ? 'on' : 'off') : null;
  }
  return null;
}

/** Milliseconds since the last X input (xset backend only), or null. */
async function xIdleMs() {
  if (backend !== 'xset' || !hasXprintidle) return null;
  const { err, out } = await run('xprintidle', []);
  if (err) {
    if (err.code === 'ENOENT') hasXprintidle = false;
    return null;
  }
  const n = Number(out.trim());
  return Number.isFinite(n) ? n : null;
}

async function checkIdle() {
  const b = pickBackend();
  if (b === 'none') return;
  const panel = await panelState();
  if (panel === null) return;
  if (panel === 'off') { cancelFade('os'); set('off', current.state === 'off' ? current.reason : 'os'); return; }
  if (current.state !== 'on') set('on', 'os');        // woken by something else (X input, a person at the console)
  if (speaking || keepOn) return;

  const kaceyIdle = Date.now() - lastActivity;
  const xIdle = await xIdleMs();
  const idle = xIdle === null ? kaceyIdle : Math.min(kaceyIdle, xIdle);
  const limit = Math.max(0.25, Number(idleMinutes()) || 2) * 60000;
  if (idle < limit) return;
  if (b === 'backlight') startFade();
  else await off('idle');
}

/** Start the idle check. `getIdleMinutes` is read on every check, so the setting applies at once. */
export function startScreen({ getIdleMinutes } = {}) {
  if (typeof getIdleMinutes === 'function') idleMinutes = getIdleMinutes;
  pickBackend();
  log(`backend: ${backend}${blPower ? ` (${blPower})` : ''}`);
  // A restart in the middle of a fade must not leave the panel dim for good.
  if (backend === 'backlight') { const full = fullBrightness(); if (full) setBrightness(full); }
  if (idleTimer) return;
  idleTimer = setInterval(() => { checkIdle().catch((e) => log(`idle check failed: ${e.message}`)); }, IDLE_CHECK_MS);
}

export function stopScreen() {
  clearInterval(idleTimer);
  idleTimer = null;
}

export function status() {
  return { ...current, backend: pickBackend(), available: backend !== 'none', speaking, fading: !!fade, keep_on: keepOn, lid: readLid(), idle_ms: Date.now() - lastActivity };
}

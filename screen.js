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

let backend = null;                // 'backlight' | 'xset' | 'none', decided on first use
let blPower = null;                // the bl_power file, for the backlight backend
let hasXprintidle = true;
let current = { state: 'unknown', since: null, reason: null };
let lastActivity = Date.now();     // Kacey's own: an interaction, presence, the end of speech, on()
let speaking = false;
let idleTimer = null;
let idleMinutes = () => 2;
let warned = false;

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

function set(state, reason) {
  if (current.state === state && current.reason === reason) return;
  current = { state, since: new Date().toISOString(), reason };
}

async function force(state, reason) {
  if (state === 'on') lastActivity = Date.now();
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
export function off(reason) { return force('off', reason); }

/** Something happened that should keep a lit panel lit for another timeout. */
export function noteActivity() { lastActivity = Date.now(); }

/**
 * Somebody is at the screen (a tap, a key, the mouse over the kiosk page): keep
 * it lit, and light it if it was dark — with the backlight backend nothing else
 * would, because the OS does not know the panel is off.
 */
export function wake(reason) {
  lastActivity = Date.now();
  if (current.state !== 'on') return on(reason);
  return Promise.resolve(true);
}

/** Kacey is speaking: the panel stays on, and the idle clock starts when she stops. */
export function setSpeaking(isOn) {
  speaking = !!isOn;
  lastActivity = Date.now();
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
  if (panel === 'off') { set('off', current.state === 'off' ? current.reason : 'os'); return; }
  if (current.state !== 'on') set('on', 'os');        // woken by something else (X input, a person at the console)
  if (speaking) return;

  const kaceyIdle = Date.now() - lastActivity;
  const xIdle = await xIdleMs();
  const idle = xIdle === null ? kaceyIdle : Math.min(kaceyIdle, xIdle);
  const limit = Math.max(0.25, Number(idleMinutes()) || 2) * 60000;
  if (idle >= limit) await off('idle');
}

/** Start the idle check. `getIdleMinutes` is read on every check, so the setting applies at once. */
export function startScreen({ getIdleMinutes } = {}) {
  if (typeof getIdleMinutes === 'function') idleMinutes = getIdleMinutes;
  pickBackend();
  log(`backend: ${backend}${blPower ? ` (${blPower})` : ''}`);
  if (idleTimer) return;
  idleTimer = setInterval(() => { checkIdle().catch((e) => log(`idle check failed: ${e.message}`)); }, IDLE_CHECK_MS);
}

export function stopScreen() {
  clearInterval(idleTimer);
  idleTimer = null;
}

export function status() {
  return { ...current, backend: pickBackend(), available: backend !== 'none', speaking, lid: readLid(), idle_ms: Date.now() - lastActivity };
}

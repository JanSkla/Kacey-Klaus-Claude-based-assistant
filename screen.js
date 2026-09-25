/**
 * Kacey — the bedside screen and the lid.
 *
 * The panel is off by default and turned on by software, through DPMS:
 * `xset dpms force on|off` against the kiosk's X display (docs/DREAM.md §6).
 * Kacey runs as the kiosk user, so this needs no privilege, only DISPLAY and
 * XAUTHORITY, which a systemd service does not inherit and config.js supplies.
 *
 * ONE owner decides when the panel sleeps: this module. X's own DPMS timers
 * are switched off by the runbook (`xset s off; xset dpms 0 0 0`). Mouse and
 * keyboard still wake a dark panel through the OS by themselves, without Kacey
 * hearing about it, so the idle check below looks at the X server's own input
 * idle time (xprintidle) as well as Kacey's events — otherwise a panel the
 * mouse woke would never be turned off again.
 *
 * Every call is logged with its reason: "why did the screen come on at three
 * in the morning" has to be answerable from the log alone.
 *
 * Off Linux (the Windows dev box), or without xset, this is a logged no-op
 * rather than an error: the rest of the night routine must still run there.
 */

import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { KACEY_DISPLAY, KACEY_XAUTHORITY } from './config.js';

const log = (...a) => console.log('[screen]', ...a);

const IDLE_CHECK_MS = 10000;
const LID_DIR = '/proc/acpi/button/lid';

let available = process.platform === 'linux';
let hasXprintidle = available;
let current = { state: 'unknown', since: null, reason: null };
let lastActivity = Date.now();    // Kacey's own: an interaction, the end of speech, on()
let speaking = false;
let idleTimer = null;
let idleMinutes = () => 2;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      env: { ...process.env, DISPLAY: KACEY_DISPLAY, XAUTHORITY: KACEY_XAUTHORITY },
      timeout: 5000,
    }, (err, stdout) => resolve({ err, out: String(stdout || '') }));
  });
}

function set(state, reason) {
  if (current.state === state && current.reason === reason) return;
  current = { state, since: new Date().toISOString(), reason };
}

async function force(state, reason) {
  if (state === 'on') lastActivity = Date.now();
  if (!available) {
    log(`${state} (${reason}) — no-op, no X display here`);
    set(state, reason);
    return false;
  }
  const { err } = await run('xset', ['dpms', 'force', state]);
  if (err) {
    if (err.code === 'ENOENT') {
      available = false;
      log('xset not found — the screen is not controlled on this machine');
    } else {
      log(`${state} (${reason}) failed: ${String(err.message).trim()}`);
    }
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

/** Kacey is speaking: the panel stays on, and the idle clock starts when she stops. */
export function setSpeaking(on) {
  speaking = !!on;
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

/** 'on' | 'off' | null (unreadable), from `xset q`. Standby and suspend count as off. */
async function monitorState() {
  const { err, out } = await run('xset', ['q']);
  if (err) return null;
  const m = /Monitor is (\w+)/.exec(out);
  if (!m) return null;
  return m[1] === 'On' ? 'on' : 'off';
}

/** Milliseconds since the last X input, or null when xprintidle is missing. */
async function xIdleMs() {
  if (!hasXprintidle) return null;
  const { err, out } = await run('xprintidle', []);
  if (err) {
    if (err.code === 'ENOENT') {
      hasXprintidle = false;
      log('xprintidle not found — a panel woken by the mouse is only turned off by Kacey\'s own timer');
    }
    return null;
  }
  const n = Number(out.trim());
  return Number.isFinite(n) ? n : null;
}

async function checkIdle() {
  if (!available) return;
  const mon = await monitorState();
  if (mon === null) return;
  if (mon === 'off') { set('off', current.state === 'off' ? current.reason : 'os'); return; }
  // The OS woke it (a mouse move, a key): say so rather than keep a stale "off".
  if (current.state !== 'on') set('on', 'os');
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
  if (idleTimer) return;
  idleTimer = setInterval(() => { checkIdle().catch((e) => log(`idle check failed: ${e.message}`)); }, IDLE_CHECK_MS);
}

export function stopScreen() {
  clearInterval(idleTimer);
  idleTimer = null;
}

export function status() {
  return { ...current, available, speaking, lid: readLid(), idle_ms: Date.now() - lastActivity };
}

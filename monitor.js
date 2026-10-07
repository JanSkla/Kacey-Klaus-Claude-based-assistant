/**
 * Kacey — the second monitor.
 *
 * kaceybody's panel can stand in as a second monitor for the desktop PC. The
 * PC runs Apollo (a Sunshine fork), which adds a virtual display when a stream
 * starts and removes it when the stream ends; this module starts Moonlight
 * inside the kiosk's compositor to show that display.
 *
 * The kiosk is cage on Wayland (docs/RUNBOOK-kaceybody.md P2). cage shows one
 * window full screen and puts a new one on top, so Moonlight covers the Kacey
 * page while it runs and the page is back the moment it exits. That is the
 * whole switch-back: nothing here has to restore anything. However the stream
 * ends — the switch in the Controller, Ctrl+Alt+Shift+Q on the laptop, Apollo
 * dropping the client on the PC — the process exits and Kacey is on screen.
 *
 * Kacey keeps running (and listening) behind it. While the stream is up the
 * screen is held lit: keys and the touchpad go to Moonlight, so the page sees
 * no presence and the idle fade would otherwise darken a monitor in use.
 *
 * ONE Moonlight at a time, owned here. Off Linux, or without
 * KACEY_MONITOR_HOST, the switch reports itself unavailable instead of failing.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  MONITOR_HOST, MONITOR_APP, MONITOR_CMD, MONITOR_ARGS, KIOSK_WAYLAND_DISPLAY, KIOSK_RUNTIME_DIR,
} from './config.js';
import * as screen from './screen.js';

const log = (...a) => console.log('[monitor]', ...a);

/* Moonlight exiting this soon after the start is a failure (not paired, the
   PC asleep, no decoder), not somebody ending the stream. */
const EARLY_EXIT_MS = 8000;
const TAIL_LINES = 6;

let child = null;
let current = { state: 'off', since: null, error: null };
const listeners = new Set();

function runtimeDir() {
  if (KIOSK_RUNTIME_DIR) return KIOSK_RUNTIME_DIR;
  return typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : null;
}

/** The Moonlight command line, split, and the environment every call of it gets. */
function moonlight(...args) {
  const [cmd, ...pre] = MONITOR_CMD.split(/\s+/).filter(Boolean);
  return { cmd, args: [...pre, ...args] };
}

function moonlightEnv(extra = {}) {
  return {
    ...process.env,
    WAYLAND_DISPLAY: KIOSK_WAYLAND_DISPLAY,
    XDG_RUNTIME_DIR: runtimeDir(),
    QT_QPA_PLATFORM: 'wayland',
    /* SDL would draw the stream window's frame with libdecor's GTK plugin,
       which aborts inside the snap (no icon theme) before the window is ever
       shown: the stream runs, nothing appears. cage draws no frames. */
    SDL_VIDEO_WAYLAND_ALLOW_LIBDECOR: '0',
    /* The snap's launcher rebuilds its MIME cache after an update; without
       fsync that is seconds rather than minutes on this disk. */
    PKGSYSTEM_ENABLE_FSYNC: '0',
    ...extra,
  };
}

/**
 * Close the app on the PC, so Apollo removes the virtual display and the PC's
 * windows go home. Killing Moonlight only drops the connection: the session
 * stays open on the PC, and the next start first spends ~30 s quitting it.
 */
function quitOnHost() {
  const { cmd, args } = moonlight('quit', MONITOR_HOST);
  try {
    const q = spawn(cmd, args, { env: moonlightEnv({ QT_QPA_PLATFORM: 'offscreen' }), stdio: 'ignore' });
    const timer = setTimeout(() => q.kill('SIGKILL'), 60000);
    q.on('exit', (code) => { clearTimeout(timer); log(`quit on ${MONITOR_HOST}: ${code === 0 ? 'done' : `code ${code}`}`); });
    q.on('error', () => clearTimeout(timer));
  } catch { /* nothing to quit with: the next start quits it instead */ }
}

/** Why the switch cannot work here, or null when it can. */
function unavailable() {
  if (process.platform !== 'linux') return 'Druhý monitor jde jen na kaceybody (Linux s kioskem).';
  if (!MONITOR_HOST) return 'Chybí KACEY_MONITOR_HOST — jméno počítače, který se má rozšířit.';
  const sock = path.join(runtimeDir() || '', KIOSK_WAYLAND_DISPLAY);
  if (!existsSync(sock)) return `Kiosk neběží nebo k němu Kacey nemá přístup (${sock}).`;
  return null;
}

function set(state, error = null) {
  current = { state, since: new Date().toISOString(), error };
  for (const fn of listeners) {
    try { fn(status()); } catch { /* one bad listener must not stop the rest */ }
  }
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function status() {
  const why = child ? null : unavailable();
  const { stopping, ...rest } = current;
  return { ...rest, available: !why, why, host: MONITOR_HOST || null, app: MONITOR_APP };
}

/** Start the stream. Resolves with the status; `error` says why it did not start. */
export function start(reason = 'switch') {
  if (child) return status();
  const why = unavailable();
  if (why) { set('off', why); return status(); }

  const { cmd, args } = moonlight('stream', MONITOR_HOST, MONITOR_APP, ...MONITOR_ARGS);
  log(`start (${reason}): ${cmd} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);

  const startedAt = Date.now();
  const tail = [];
  let critical = null;
  const keep = (buf) => {
    for (const line of String(buf).split('\n')) {
      if (!line.trim()) continue;
      tail.push(line.trim());
      if (tail.length > TAIL_LINES) tail.shift();
      /* Moonlight does not exit on an error: it puts a dialog over the kiosk
         and waits for OK ("… has not been paired"). Nobody at the switch can
         press it, so a critical line ends the stream. */
      const m = /Qt Critical:\s*(.*)/.exec(line);
      if (m && !critical && child) {
        critical = m[1].trim();
        child.kill('SIGTERM');
      }
    }
  };

  try {
    child = spawn(cmd, args, { env: moonlightEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    child = null;
    set('off', `Moonlight nejde spustit: ${err.message}`);
    return status();
  }

  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  screen.hold('monitor', true);
  set('on');

  const done = (code, signal, spawnErr) => {
    if (!child) return;
    child = null;
    screen.hold('monitor', false);
    const early = Date.now() - startedAt < EARLY_EXIT_MS && !current.stopping;
    let error = null;
    if (spawnErr) error = spawnErr.code === 'ENOENT'
      ? `Moonlight není nainstalovaný (${cmd}).`
      : `Moonlight nejde spustit: ${spawnErr.message}`;
    else if (critical) error = `Moonlight: ${critical}`;
    else if (early && (code !== 0 || signal)) error = `Moonlight hned skončil: ${tail.at(-1) || `kód ${code ?? signal}`}`;
    log(`ended (${spawnErr ? spawnErr.code : signal || `code ${code}`})${error ? ` — ${error}` : ''}${tail.length ? `\n  ${tail.join('\n  ')}` : ''}`);
    set('off', error);
    if (!spawnErr && !critical) quitOnHost();
  };
  child.on('exit', (code, signal) => done(code, signal));
  child.on('error', (err) => done(null, null, err));
  return status();
}

/** End the stream: Moonlight exits, cage shows Kacey, Apollo drops the virtual display. */
export function stop(reason = 'switch') {
  if (!child) return status();
  log(`stop (${reason})`);
  current = { ...current, stopping: true };
  const proc = child;
  proc.kill('SIGTERM');
  setTimeout(() => { if (child === proc) proc.kill('SIGKILL'); }, 4000).unref();
  return status();
}

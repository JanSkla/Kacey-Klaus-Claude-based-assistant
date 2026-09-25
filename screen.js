/**
 * Kacey — the bedside screen.
 *
 * The panel is off by default and turned on by software, through DPMS:
 * `xset dpms force on|off` against the kiosk's X display (docs/DREAM.md §6).
 * Kacey runs as the kiosk user, so this needs no privilege — only DISPLAY and
 * XAUTHORITY, which a systemd service does not inherit and config.js supplies.
 *
 * Every call is logged with its reason, because "why did the screen come on at
 * three in the morning" has to be answerable from the log alone.
 *
 * Off Linux (the Windows dev box) or without xset, this is a logged no-op
 * rather than an error: the rest of the night routine must still run there.
 *
 * This is the minimal P3 version — on, off and a status. The idle timeout, the
 * X-idle check and the lid arrive with P2.
 */

import { execFile } from 'node:child_process';

import { KACEY_DISPLAY, KACEY_XAUTHORITY } from './config.js';

const log = (...a) => console.log('[screen]', ...a);

let available = process.platform === 'linux';
let current = { state: 'unknown', since: null, reason: null };

function xset(args) {
  return new Promise((resolve) => {
    execFile('xset', args, {
      env: { ...process.env, DISPLAY: KACEY_DISPLAY, XAUTHORITY: KACEY_XAUTHORITY },
      timeout: 5000,
    }, (err) => resolve(err));
  });
}

async function force(state, reason) {
  if (!available) {
    log(`${state} (${reason}) — no-op, no X display here`);
    current = { state, since: new Date().toISOString(), reason };
    return false;
  }
  const err = await xset(['dpms', 'force', state]);
  if (err) {
    if (err.code === 'ENOENT') {
      available = false;
      log('xset not found — the screen is not controlled on this machine');
    } else {
      log(`${state} (${reason}) failed: ${err.message.trim()}`);
    }
    return false;
  }
  current = { state, since: new Date().toISOString(), reason };
  log(`${state} (${reason})`);
  return true;
}

export function on(reason) { return force('on', reason); }
export function off(reason) { return force('off', reason); }

export function status() { return { ...current, available }; }

/**
 * Kacey — listening to lightsd.
 *
 * lightsd owns the lamps and the sleep button; Kacey only reads it. It pushes
 * its whole status over /ws about five times a second, so a press is seen
 * almost at once and a dropped socket is itself the "lightsd went away"
 * signal. While the socket is down, /api/status is polled every 30 s and the
 * socket keeps being retried with backoff. Nothing here ever writes to lightsd.
 *
 * lightsd reports a STATE, not events. diffLightsd() turns two consecutive
 * statuses into the events the sleep machine understands — pure, and tested
 * in test/lightsd-diff.mjs. The rules behind it are in docs/DREAM.md §5.
 */

import WebSocket from 'ws';

/** Wake within this many minutes of wake_at = the sunrise, not "awake early". */
const SUNRISE_MARGIN_MIN = 2;

const POLL_MS = 30000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60000;

/**
 * Events between two statuses of lightsd.
 *
 *   prev   the previous status ON THIS CONNECTION, or null for the first one
 *   next   the status just received
 *   ctx    { now: Date, sleep: Kacey's sleep state }
 *
 * The first status after a (re)connect is a baseline: a sleep that vanished
 * across a gap is NOT an interaction, because lightsd keeps sleep in memory
 * and a restart of lightsd drops it — that must not wake Kacey's night.
 */
export function diffLightsd(prev, next, ctx) {
  const now = ctx.now.getTime();
  const nextSleep = next && next.sleep ? next.sleep : null;
  const startOf = (s) => new Date(now - Math.max(0, Number(s.held_for) || 0) * 1000).toISOString();

  if (!prev) {
    /* The button was pressed while we were not looking. Take it — unless the
       owner has interacted with Kacey since that press, which already
       cancelled that wind-down once. */
    const k = ctx.sleep || {};
    if (nextSleep && k.state === 'awake') {
      const since = startOf(nextSleep);
      if (Date.parse(since) > (Date.parse(k.since) || 0)) return [{ type: 'sleep_start', since }];
    }
    return [];
  }

  const prevSleep = prev.sleep || null;

  if (!prevSleep && nextSleep) return [{ type: 'sleep_start', since: startOf(nextSleep) }];

  if (prevSleep && !nextSleep) {
    /* lightsd does not say why sleep ended; DELETE /api/sleep and reaching
       wake_at look the same. How close wake_at was tells them apart. */
    const left = Number(prevSleep.minutes_until_wake);
    return [{ type: Number.isFinite(left) && left > SUNRISE_MARGIN_MIN ? 'awake_early' : 'sunrise' }];
  }

  // Pressed again while already asleep: lightsd starts a fresh SleepState.
  if (prevSleep && nextSleep && Number(nextSleep.held_for) + 1 < Number(prevSleep.held_for)) {
    return [{ type: 'sleep_start', since: startOf(nextSleep) }];
  }

  return [];
}

/**
 * The live subscription. `onStatus(status, first)` gets every status (first =
 * the baseline of a new connection); the caller runs diffLightsd itself,
 * because only it knows Kacey's sleep state.
 */
export function makeLightsdClient({ url, onStatus, log = () => {} }) {
  const base = String(url).replace(/\/+$/, '');
  const wsUrl = base.replace(/^http/, 'ws') + '/ws';

  let ws = null;
  let mode = 'down';           // 'ws' | 'poll' | 'down'
  let last = null;             // the last status seen, whatever the channel
  let lastAt = null;
  let fresh = true;            // the next status is the first on its channel
  let backoff = BACKOFF_MIN_MS;
  let retryTimer = null;
  let pollTimer = null;
  let stopped = false;
  let warnedDown = false;      // "unreachable" is said once per outage, not every 30 s

  function deliver(status) {
    if (!status || typeof status !== 'object') return;
    const first = fresh;
    fresh = false;
    last = status;
    lastAt = new Date().toISOString();
    try { onStatus(status, first); } catch (err) { log(`lightsd status handler failed: ${err.message}`); }
  }

  async function poll() {
    try {
      const r = await fetch(base + '/api/status', { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const status = await r.json();
      if (mode !== 'ws') mode = 'poll';
      warnedDown = false;
      deliver(status);
    } catch (err) {
      // A missed poll breaks the chain: the next success is a baseline again.
      if (!warnedDown) {
        warnedDown = true;
        log(`lightsd unreachable at ${base} (${err.message}); no sleep signal until it answers`);
      }
      if (mode !== 'ws') mode = 'down';
      fresh = true;
    }
  }

  function startPolling() {
    if (pollTimer || stopped) return;
    fresh = true;
    poll();
    pollTimer = setInterval(poll, POLL_MS);
  }

  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function connect() {
    if (stopped) return;
    let opened = false;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      log(`lightsd ws failed to start (${err.message})`);
      scheduleRetry();
      return;
    }

    ws.on('open', () => {
      opened = true;
      backoff = BACKOFF_MIN_MS;
      stopPolling();
      mode = 'ws';
      fresh = true;
      log(`lightsd connected (${wsUrl})`);
    });

    ws.on('message', (raw) => {
      let status;
      try { status = JSON.parse(raw.toString()); } catch { return; }
      deliver(status);
    });

    ws.on('error', () => { /* 'close' follows; the reason is not actionable */ });

    ws.on('close', () => {
      ws = null;
      // A retry that never opened leaves a working poll alone.
      if (opened) {
        log('lightsd connection lost; polling /api/status meanwhile');
        mode = 'down';
      }
      startPolling();
      scheduleRetry();
    });
  }

  function scheduleRetry() {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, backoff);
    backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
  }

  return {
    start() { stopped = false; connect(); },
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      stopPolling();
      try { ws?.close(); } catch { /* gone */ }
    },
    status() {
      return {
        mode,
        seen_at: lastAt,
        sleeping: !!(last && last.sleep),
        wake_at: last?.wake_at ?? null,
        morning_peak_at: last?.morning_peak_at ?? null,
      };
    },
  };
}

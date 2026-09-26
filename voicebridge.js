/**
 * Kacey — her voice, as seen from the music visual.
 *
 * nowplayingd's corner widget (tools/nowplaying in the lights repo) shows the
 * next thing in the day, a "Mluv" button, and what Kacey is hearing while she
 * listens. None of that lives in nowplayingd: the microphone belongs to the
 * kiosk page, so this module relays between the two.
 *
 *   page  → server   `voice_page` {kiosk, available}: this page can listen
 *   page  → server   `listening` {on, transcript}: what it is doing
 *   server → page    `voice_wake` / `voice_stop`: start or stop listening
 *   widget → server  POST /api/wake, POST /api/voice/stop
 *   server → widget  GET /api/voice/events (a stream of status())
 *
 * Only a kiosk page (`?kiosk=1`) is woken. A phone with Kacey open must not
 * start recording because someone tapped a button on the bedside screen.
 *
 * Also here: nextItem(), the one line of "what's next" the widget shows, and
 * createDucker(), which turns the music down while Kacey listens.
 *
 * nextItem() and the bridge are pure (no I/O); test/voicebridge.mjs covers them.
 */

import { logicalDayOf, calDayOf, isAllDay } from './calendar-days.js';

/* ---- what's next ------------------------------------------------------------ */

const DOW = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];
const TIMED_DUE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/**
 * The next timed thing: a calendar event or a task with a time, whichever
 * comes first, within `horizonDays`. Null when there is none.
 *
 * The day word follows the logical day (it starts at 04:00): at 01:00 a 07:30
 * alarm is still "zítra" to someone who has not slept yet.
 *
 * → { at, time, day, title, kind: 'event'|'task', label: 'zítra 07:30 · Běh' }
 */
export function nextItem({ events = [], tasks = [], now = new Date(), horizonDays = 2 } = {}) {
  const limit = now.getTime() + horizonDays * 86400000;
  const items = [];

  for (const e of events) {
    if (!e?.starts_at || isAllDay(e.starts_at, e.ends_at)) continue;
    const at = new Date(e.starts_at);
    if (isNaN(at) || at < now || at.getTime() > limit) continue;
    items.push({ at, title: e.title || '(bez názvu)', kind: 'event' });
  }
  for (const t of tasks) {
    if (!t || t.done) continue;
    const m = TIMED_DUE.exec(t.due_at || '');
    if (!m) continue;
    const at = new Date(Number(m[1].slice(0, 4)), Number(m[1].slice(5, 7)) - 1, Number(m[1].slice(8, 10)), Number(m[2]), Number(m[3]));
    if (at < now || at.getTime() > limit) continue;
    items.push({ at, title: t.label || '(bez názvu)', kind: 'task' });
  }
  if (!items.length) return null;

  items.sort((a, b) => a.at - b.at);
  const first = items[0];
  const today = logicalDayOf(now.toISOString());
  const itsDay = logicalDayOf(first.at.toISOString());
  const tomorrow = calDayOf(new Date(new Date(`${today}T12:00:00`).getTime() + 86400000));
  const day = itsDay === today ? 'dnes' : itsDay === tomorrow ? 'zítra' : DOW[new Date(`${itsDay}T12:00:00`).getDay()];
  const time = hhmm(first.at);
  return {
    at: first.at.toISOString(), time, day, title: first.title, kind: first.kind,
    label: `${day} ${time} · ${first.title}`,
  };
}

/* ---- the bridge --------------------------------------------------------------- */

/**
 * Which pages can listen, and what the one that is listening hears.
 * Pages are opaque keys (the server passes its per-socket session); `send`
 * delivers a frame to one of them.
 */
export function createVoiceBridge({ send }) {
  const pages = new Map();          // page → { kiosk, available }
  let source = null;                // the page that is listening now
  let transcript = '';
  const subscribers = new Set();

  const listener = () => [...pages].find(([, p]) => p.kiosk && p.available)?.[0] || null;

  function status() {
    return { available: !!listener(), listening: !!source, transcript: source ? transcript : '' };
  }

  function changed() {
    const s = status();
    for (const fn of subscribers) {
      try { fn(s); } catch { /* one broken stream must not stop the rest */ }
    }
  }

  return {
    status,

    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },

    /** A page said whether it can listen (sent on connect, and on change). */
    page(key, { kiosk = false, available = false } = {}) {
      pages.set(key, { kiosk: kiosk === true, available: available === true });
      changed();
    },

    /** A page went away; if it was listening, nobody is now. */
    drop(key) {
      pages.delete(key);
      if (source === key) { source = null; transcript = ''; }
      changed();
    },

    /** A page started or stopped listening, or heard more. */
    listening(key, on, text = '') {
      if (on) {
        source = key;
        transcript = typeof text === 'string' ? text.slice(0, 500) : '';
      } else if (source === key) {
        source = null;
        transcript = '';
      } else {
        return;
      }
      changed();
    },

    /** Ask the kiosk page to listen. False when there is no page that can. */
    wake() {
      const key = listener();
      if (!key) return false;
      send(key, { type: 'voice_wake' });
      return true;
    },

    /** Ask whichever page is listening to stop, dropping what it heard. */
    stop() {
      if (!source) return false;
      send(source, { type: 'voice_stop' });
      return true;
    },
  };
}

/* ---- ducking ------------------------------------------------------------------ */

/**
 * Music down to `level` % while Kacey listens, and back afterwards.
 *
 * It lives here rather than in nowplayingd because this is where "she started
 * listening" is known; nowplayingd only gets `POST /api/volume`.
 *
 * The music stays down through her answer too (`speaking`): turning it up
 * between the question and the reply, only to have her talk over it, is worse
 * than leaving it low. It comes back `holdMs` after both have ended. If
 * someone changed the volume by hand meanwhile, that is left alone.
 */
export function createDucker({ url, level = 20, holdMs = 8000, fetchImpl = fetch, log = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let saved = null;                 // the volume before we ducked, or null
  let listening = false;
  let speaking = false;
  let timer = null;
  let chain = Promise.resolve();    // one volume change at a time

  const call = async (path, body) => {
    const res = await fetchImpl(`${url}${path}`, body === undefined ? { signal: AbortSignal.timeout(4000) } : {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`nowplayingd ${path} ${res.status}`);
    return res.json();
  };

  async function duck() {
    if (saved !== null) return;
    const now = await call('/api/now');
    if (!now?.playing || typeof now.volume_percent !== 'number' || now.volume_percent <= level) return;
    await call('/api/volume', { percent: level });
    saved = now.volume_percent;
    log(`music ducked ${saved}% → ${level}%`);
  }

  async function restore() {
    if (saved === null) return;
    const back = saved;
    saved = null;
    const now = await call('/api/now');
    if (now?.volume_percent !== level) return;       // someone set it by hand
    await call('/api/volume', { percent: back });
    log(`music back to ${back}%`);
  }

  const queue = (fn) => {
    chain = chain.then(fn).catch((err) => log(`ducking: ${err.message}`));
    return chain;
  };

  return {
    update(next) {
      const wasListening = listening;
      if (typeof next.listening === 'boolean') listening = next.listening;
      if (typeof next.speaking === 'boolean') speaking = next.speaking;
      if (listening || speaking) {
        if (timer) { clearTimer(timer); timer = null; }
        if (listening && !wasListening) return queue(duck);
        return chain;
      }
      if (!timer) {
        timer = setTimer(() => { timer = null; queue(restore); }, holdMs);
      }
      return chain;
    },
    get ducked() { return saved !== null; },
  };
}

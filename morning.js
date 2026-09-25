/**
 * Kacey — morning mode.
 *
 * At the sunrise's brightest point (lightsd's morning_peak_at) the bedside
 * screen comes on, the kiosk page opens the morning screen and reads the
 * brief the night wrote, and a fixed checklist waits to be ticked. Five
 * minutes before, the brief is rewritten if the calendar or the tasks changed
 * since the night. docs/DREAM.md §12; the decisions are in morningplan.js.
 *
 * Driven by night.js's 30 s tick, so it keeps no timers of its own that a
 * restart could lose — the record in kv `morning.today` holds everything.
 */

import { kvGet, kvSet } from './db.js';
import { MORNING_ITEMS } from './config.js';
import * as nightstore from './nightstore.js';
import * as screen from './screen.js';
import { writeBrief, currentBriefHash, makeSdkRunner } from './dream.js';
import { logicalDateOf } from './rules.js';
import {
  freshRecord, withProposals, morningStep, historyEntry, peakInstant, PROPOSALS_KEY,
} from './morningplan.js';

const log = (...a) => console.log('[morning]', ...a);

const ACK_TIMEOUT_MS = 30000;
const IDLE_AFTER_DONE_MS = 30000;
const HISTORY_DAYS = 120;

let deps = {};                  // broadcast, push, settings, runner, persona
let refreshing = null;
let ackTimer = null;
let idleTimer = null;

function record() { return kvGet('morning.today', null); }
function save(rec) { kvSet('morning.today', rec); }

function pendingCounts(date) {
  const all = nightstore.listProposals({ date, limit: 200 });
  return { pending: all.filter((p) => p.status === 'pending').length, total: all.length };
}

/* ---- the day ------------------------------------------------------------- */

/** Today's record, rolling yesterday's into the history first when the logical day changed. */
function today(now) {
  const date = logicalDateOf(now);
  let rec = record();
  if (rec && rec.logical_date === date) return rec;
  if (rec) {
    if (rec.state === 'pending' || rec.state === 'active') {
      rec.end_reason = rec.end_reason || (rec.state === 'active' ? 'day_end' : 'missed');
      rec.state = 'ended';
      rec.ended_at = rec.ended_at || now.toISOString();
    }
    archive(rec);
  }
  rec = freshRecord(date, MORNING_ITEMS);
  save(rec);
  return rec;
}

function archive(rec) {
  const hist = kvGet('morning.history', {}) || {};
  hist[rec.logical_date] = historyEntry(rec);
  const keys = Object.keys(hist).sort();
  while (keys.length > HISTORY_DAYS) delete hist[keys.shift()];
  kvSet('morning.history', hist);
}

function peakFor(date) {
  const seen = kvGet('lightsd.last', null) || {};
  return seen.morning_peak_at ? peakInstant(date, seen.morning_peak_at) : null;
}

/* ---- T−5: is the brief still true? -------------------------------------- */

async function refresh(rec, now, why = 'hash') {
  if (refreshing) return refreshing;
  const draft = nightstore.briefDraft();
  const stale = !draft || draft.logical_date !== rec.logical_date || draft.input_hash !== currentBriefHash(rec.logical_date);
  rec.refresh_checked = true;
  save(rec);
  if (!stale) { log(`brief for ${rec.logical_date} still true`); return null; }
  log(`rewriting the brief for ${rec.logical_date} (${draft ? 'the calendar or tasks changed' : 'no draft from the night'})`);
  refreshing = writeBrief({
    date: rec.logical_date, runner: deps.runner || makeSdkRunner(), persona: deps.persona, synth: deps.synth || null,
    trigger: 'refresh', peakAt: rec.peak_at ? rec.peak_at.slice(11, 16) : null,
  }).then((d) => {
    const r = record();
    if (r && r.logical_date === d.logical_date) { r.rewritten_at = new Date().toISOString(); save(r); }
    return d;
  }).catch((err) => { log(`rewrite failed, the night's brief stands: ${err.message}`); return null; })
    .finally(() => { refreshing = null; push(); });
  return refreshing;
}

/* ---- T: the morning ------------------------------------------------------ */

/**
 * Start the morning. `manual` (the Brief view's "Přehrát brief teď") skips
 * the lid check and the clock: the owner is looking at the screen.
 */
export async function startMorning(now = new Date(), { manual = false } = {}) {
  const s = deps.settings ? deps.settings() : {};
  const rec = today(now);
  if (!manual && s.enabled === false) return rec;
  if (!manual && s.lid_check !== false && screen.readLid() === 'closed') {
    Object.assign(rec, { state: 'ended', end_reason: 'lid_closed', delivered: false, why: 'lid_closed', started_at: now.toISOString(), ended_at: now.toISOString() });
    save(rec);
    archive(rec);
    log('lid closed at the peak — no morning today; the brief stays in the Brief view');
    push();
    return rec;
  }
  if (refreshing) await refreshing;             // T waits for a rewrite still in flight

  const draft = nightstore.briefDraft();
  const ours = draft && draft.logical_date === rec.logical_date;
  const lines = ours ? draft.lines : [];
  const audio = ours ? (draft.audio || []) : [];
  rec.items = withProposals(rec.items, pendingCounts(rec.logical_date), now);
  Object.assign(rec, {
    state: 'active', started_at: rec.started_at && manual ? rec.started_at : now.toISOString(),
    ended_at: null, end_reason: null, delivered: false, why: null, last_interaction_at: manual ? now.toISOString() : null,
  });
  save(rec);
  screen.on('morning');
  if (deps.broadcast) {
    deps.broadcast({
      type: 'morning', logical_date: rec.logical_date, lines, audio, checklist: rec.items,
      peak_at: rec.peak_at, rewritten_at: rec.rewritten_at, manual,
    });
  }
  log(`morning for ${rec.logical_date} started${manual ? ' by hand' : ''}: ${lines.length} brief lines, ${rec.items.length} items`);

  clearTimeout(ackTimer);
  ackTimer = setTimeout(() => {
    const r = record();
    if (r && r.logical_date === rec.logical_date && r.state === 'active' && !r.delivered) {
      r.why = 'no_page';
      save(r);
      log('no kiosk page acknowledged the morning — logged as not delivered');
      push();
    }
  }, ACK_TIMEOUT_MS);
  push();
  return rec;
}

/** The kiosk page started playing. */
export function ackMorning(date) {
  const rec = record();
  if (!rec || rec.logical_date !== date) return;
  rec.delivered = true;
  rec.why = null;
  save(rec);
  clearTimeout(ackTimer);
  log(`morning for ${date} delivered`);
  push();
}

function end(rec, reason, now) {
  Object.assign(rec, { state: reason === 'done' ? 'done' : 'ended', end_reason: reason, ended_at: now.toISOString() });
  save(rec);
  archive(rec);
  log(`morning for ${rec.logical_date} over: ${reason}`);
  clearTimeout(idleTimer);
  if (reason === 'done') {
    // "Hotovo, hezký den." stays up for 30 s, then the screen goes back to sleep.
    idleTimer = setTimeout(() => screen.off('morning done'), IDLE_AFTER_DONE_MS);
  } else if (reason === 'timeout') {
    screen.off('morning timeout');
  }
  push();
}

/* ---- the checklist ------------------------------------------------------- */

export function tick(key, done, now = new Date()) {
  const rec = today(now);
  const item = rec.items.find((i) => i.key === key);
  if (!item) throw new Error('taková položka v ranním checklistu není');
  if (item.auto) throw new Error('tahle položka se odškrtne sama, až rozhodneš všechny návrhy');
  item.done = !!done;
  item.done_at = done ? now.toISOString() : null;
  if (rec.state === 'active') rec.last_interaction_at = now.toISOString();
  save(rec);
  const step = morningStep(rec, now, {});
  if (rec.state === 'active' && step.end === 'done') end(rec, 'done', now);
  else push();
  return record();
}

/** Back to idle by hand ("Zpět do klidu"): screen off now. */
export function idle(now = new Date()) {
  const rec = record();
  clearTimeout(idleTimer);
  screen.off('morning: zpět do klidu');
  if (rec && rec.state === 'active') end(rec, 'dismissed', now);
  return record();
}

/* ---- the tick (from night.js) --------------------------------------------- */

export function onTick(now) {
  const s = deps.settings ? deps.settings() : {};
  const rec = today(now);

  // Keep the peak current until the morning starts: the schedule may be edited in the evening.
  if (rec.state === 'pending') {
    const peak = peakFor(rec.logical_date);
    const iso = peak ? peak.toISOString() : null;
    if (iso !== rec.peak_at) { rec.peak_at = iso; save(rec); }
  }
  if (rec.state === 'active') {
    const next = withProposals(rec.items, pendingCounts(rec.logical_date), now);
    if (JSON.stringify(next) !== JSON.stringify(rec.items)) { rec.items = next; save(rec); push(); }
  }

  const step = morningStep(rec, now, { peak: rec.peak_at ? new Date(rec.peak_at) : null, morningEnd: s.morning_end });
  if (step.refresh && s.enabled !== false) refresh(rec, now);
  else if (step.fire) startMorning(now);
  else if (step.end === 'missed') {
    Object.assign(rec, { state: 'ended', end_reason: 'missed', delivered: false, why: 'missed', ended_at: now.toISOString() });
    save(rec); archive(rec);
    log(`morning for ${rec.logical_date} missed: the peak was more than two hours ago`);
    push();
  } else if (step.end) end(rec, step.end, now);
}

/**
 * A proposal was decided: recount the "Projít návrhy" item now rather than at
 * the next tick, and end the morning if that was the last thing left.
 */
export function syncProposals(now = new Date()) {
  const rec = record();
  if (!rec || rec.state !== 'active') return;
  rec.items = withProposals(rec.items, pendingCounts(rec.logical_date), now);
  rec.last_interaction_at = now.toISOString();
  save(rec);
  if (morningStep(rec, now, {}).end === 'done') end(rec, 'done', now);
}

export function onInteraction() {
  const rec = record();
  if (rec && rec.state === 'active') { rec.last_interaction_at = new Date().toISOString(); save(rec); }
}

/** What night_state carries about the morning. */
export function morningState() {
  const rec = today(new Date());
  const draft = nightstore.briefDraft();
  return {
    ...rec,
    brief: draft && draft.logical_date === rec.logical_date
      ? { lines: draft.lines, audio: draft.audio || [], made_at: draft.made_at, trigger: draft.trigger } : null,
  };
}

export function morningHistory() { return kvGet('morning.history', {}) || {}; }

function push() { if (deps.push) deps.push(); }

/** Wire it into night.js: `extendNight(initMorning({...}))`. */
export function initMorning(options = {}) {
  deps = { ...deps, ...options };
  return { onTick, onInteraction: () => onInteraction(), morningState };
}

// Exported for the brief view's "Přehrát brief teď" and tests.
export { PROPOSALS_KEY };

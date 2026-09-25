/* =========================================================================
   THE NIGHT ROUTINE, BROWSER SIDE — its data and its HTTP calls.

   docs/DREAM.md. The server pushes `night_state` (sleep, screen, the last
   run, the morning) on every change and `morning` when the morning starts;
   protocol.js hands both here. The views that draw the night — the morning
   screen, proposal review, the rules editor, the Brief view's timeline, the
   controller — subscribe with onNight() and never talk to the server
   themselves, so there is one copy of each list and one place that fetches it.

   It imports nothing from protocol.js (protocol imports this), so the two do
   not form a cycle; the one frame the morning sends back goes through
   sendFrame() in the view.
   ========================================================================= */

import { state } from '../core/state.js';

export var night = {
  state: null,          // the last night_state frame
  morning: null,        // the last `morning` frame (lines, checklist) — the morning being played
  proposals: [],        // pending first
  rulesets: [],
  cycle: null,          // /api/night/cycle
  morningRec: null      // /api/morning: the record, with the draft's lines
};

var listeners = [];

/** Subscribe to every change. `what` says which part moved. */
export function onNight(fn) { listeners.push(fn); }

function emit(what) {
  for (var i = 0; i < listeners.length; i++) {
    try { listeners[i](what); } catch (e) { console.error('[kacey] night listener failed', e); }
  }
}

function json(url, opts) {
  return fetch(url, opts).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (body) {
      if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
      return body;
    });
  });
}

function send(url, method, body) {
  return json(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
}

/* ---- pushed by the server -------------------------------------------------- */

export function receiveNightState(msg) {
  night.state = msg;
  state.night = msg;
  if (msg && msg.morning) night.morningRec = msg.morning;
  emit('state');
}

export function receiveMorning(msg) {
  night.morning = msg;
  emit('morning');
}

/* ---- fetched ----------------------------------------------------------------- */

export function loadProposals() {
  return json('/api/proposals?limit=100').then(function (b) { night.proposals = b.proposals || []; emit('proposals'); return night.proposals; })
    .catch(function (e) { console.warn('[kacey] proposals unavailable: ' + e.message); return night.proposals; });
}

export function decideProposal(id, body) {
  return send('/api/proposals/' + encodeURIComponent(id), 'POST', body).then(function (b) { return loadProposals().then(function () { return b; }); });
}

export function loadRules() {
  return json('/api/rules').then(function (b) { night.rulesets = b.rulesets || []; emit('rules'); return night.rulesets; })
    .catch(function (e) { console.warn('[kacey] rules unavailable: ' + e.message); return night.rulesets; });
}

function afterRules(b) { night.rulesets = b.rulesets || night.rulesets; emit('rules'); return b; }

export function saveRule(id, body) { return send('/api/rules/' + encodeURIComponent(id || 'new'), 'PUT', body).then(afterRules); }
export function deleteRule(id) { return send('/api/rules/' + encodeURIComponent(id), 'DELETE').then(afterRules); }
export function saveRuleset(id, body) { return send('/api/rules/sets/' + encodeURIComponent(id || 'new'), 'PUT', body).then(afterRules); }
export function deleteRuleset(id) { return send('/api/rules/sets/' + encodeURIComponent(id), 'DELETE').then(afterRules); }

/** What a rule (saved `rule_id`, or a draft `rule`) would create over the next `days`. */
export function previewRule(body) { return send('/api/rules/preview', 'POST', body).then(function (b) { return b.items || []; }); }

export function loadMorning() {
  return json('/api/morning').then(function (b) { night.morningRec = b.morning; emit('morningRec'); return b; })
    .catch(function () { return null; });
}

export function tickMorning(key, done) {
  return send('/api/morning/tick', 'POST', { key: key, done: done }).then(function (b) { night.morningRec = b.morning; emit('morningRec'); return b; });
}

export function startMorningNow() { return send('/api/morning/start', 'POST'); }
export function morningIdle() { return send('/api/morning/idle', 'POST'); }

export function loadCycle() {
  return json('/api/night/cycle').then(function (b) { night.cycle = b; emit('cycle'); return b; })
    .catch(function () { return null; });
}

export function runNightNow(force) { return send('/api/night/run', 'POST', { force: !!force }); }
export function shiftSunrise(minutes) { return send('/api/night/sunrise', 'POST', { minutes: minutes }); }

/** Something changed server-side (app_changed): reload the part that moved. */
export function refresh(section) {
  if (section === 'rules') return loadRules();
  if (section === 'proposals') return loadProposals();
  return null;
}

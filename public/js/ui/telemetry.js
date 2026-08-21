/* =========================================================================
   The telemetry rails.

   Every field is real application state. Nothing here is simulated: a HUD
   full of invented gauges would make the genuine readings untrustworthy,
   which is the opposite of what an instrument panel is for.

   Callers do not touch the counters — they report events (a turn was sent, a
   tool ran, synthesis took this long) and the rails redraw themselves. That
   way the HUD cannot show a number nothing in the app actually believes.
   ========================================================================= */

import { state } from '../core/state.js';
import { $ } from '../core/dom.js';
import { orbState } from './orb.js';

var tm = {
  state: $('tmState'), model: $('tmModel'), mcp: $('tmMcp'), session: $('tmSession'),
  turns: $('tmTurns'), tool: $('tmTool'), toolCount: $('tmToolCount'),
  voice: $('tmVoice'), lang: $('tmLang'), tts: $('tmTts'), synth: $('tmSynth'),
};

var telemetry = { turns: 0, toolCalls: 0, lastTool: '—', lastSynthMs: null, mcp: '—' };

function setTm(el, value, flag) {
  if (!el) return;
  el.textContent = value;
  if (flag === 'warn') el.setAttribute('data-warn', '1');
  else el.removeAttribute('data-warn');
  if (flag === 'bad') el.setAttribute('data-bad', '1');
  else el.removeAttribute('data-bad');
}

/* Subscribed to the orb in app.js, and called directly by the reporters below. */
export function updateTelemetry() {
  var orb = orbState();
  setTm(tm.state, orb.toUpperCase(),
    orb === 'offline' || orb === 'error' ? 'bad' : null);
  setTm(tm.mcp, telemetry.mcp, telemetry.mcp === 'connected' ? null : 'warn');
  setTm(tm.session, state.sessionId ? state.sessionId.slice(0, 8) : '—');
  setTm(tm.turns, String(telemetry.turns));
  setTm(tm.tool, telemetry.lastTool);
  setTm(tm.toolCount, String(telemetry.toolCalls));
  setTm(tm.voice, state.voice === 'browser' ? 'BROWSER' : state.voice);
  setTm(tm.lang, state.lang);
  setTm(tm.tts, String(state.ttsPending), state.ttsPending > 0 ? 'warn' : null);
  setTm(tm.synth, telemetry.lastSynthMs === null ? '—' : telemetry.lastSynthMs + ' ms');
}

/* ---- reporters -------------------------------------------------------- */

/* The model name is the one rail that is not derived from state — it arrives
   once in the `ready` frame and then never changes. */
export function setModel(name) { setTm(tm.model, name); }

export function setMcp(list) {
  telemetry.mcp = (Array.isArray(list) && list.length) ? 'connected' : 'none';
  updateTelemetry();
}

export function noteTurn() {
  telemetry.turns++;
  updateTelemetry();
}

export function noteTool(name) {
  telemetry.toolCalls++;
  telemetry.lastTool = String(name || '—');
  updateTelemetry();
}

/* Real server-measured synthesis time, straight onto the rail. */
export function noteSynthMs(ms) {
  telemetry.lastSynthMs = Number(ms);
  updateTelemetry();
}

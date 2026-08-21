/* =========================================================================
   THE PROTOCOL PIPELINE — one path in, one path out.

   Both transports feed onServer(), and everything the user says leaves through
   submit(). That is deliberate: the mock and the real WebSocket exercise
   exactly the same code, so anything that works in ?mock=1 works for real.

   The frame contract is in README.md. Two rules matter here:
     - `delta` is assistant speech, verbatim, and nothing else ever reaches it.
       The browser speaks it aloud, so a stray status line would be read out.
     - unknown frame types are ignored, not fatal. A newer server must not be
       able to break an older page.
   ========================================================================= */

import { state, MOCK } from '../core/state.js';
import { t } from '../core/i18n.js';
import * as dom from '../core/dom.js';
import { syncOrb } from '../ui/orb.js';
import {
  addMessage, beginAssistant, appendDelta, endAssistant, sealPreamble,
  showAlert, flashHint, unlockHint, clearHintTimer
} from '../ui/log.js';
import { setModel, setMcp, noteTurn, noteTool, updateTelemetry } from '../ui/telemetry.js';
import { cancelSpeech, flushTTS, primeTTS } from '../voice/tts.js';
import {
  recognitionAvailable, stopRecognition, maybeResumeVoiceLoop, clearBaseText
} from '../voice/recognition.js';
import { bargeIn, endListening } from '../voice/commands.js';
import { refreshCalendar } from '../ui/calendar.js';
import { makeSocketTransport } from './transport-socket.js';
import { makeMockTransport } from './transport-mock.js';

var transport = null;
var toolDepth = 0;
var preambleDone = false;   // has this turn already split off its opening line?

/* The one line describing what we are connected to, built when `ready` arrives.
   It lives here because it is protocol knowledge, and it is read by the label
   code so a language change can repaint the pill without restarting a retry
   countdown. */
var info = '';
export function readyInfo() { return info; }

export function onServer(msg) {
  switch (msg.type) {
    case 'ready':
      info = t().readyInfo(
        typeof msg.model === 'string' ? msg.model : '?',
        Array.isArray(msg.mcpServers) ? msg.mcpServers.filter(function (s) { return typeof s === 'string'; }) : []
      );
      dom.connLabel.textContent = t().online;
      dom.conn.title = info;
      setModel(typeof msg.model === 'string' ? msg.model : '?');
      setMcp(msg.mcpServers);
      flashHint(info, false, 4200);
      break;

    case 'session':
      state.sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null;
      if (state.sessionId) dom.conn.title = info + ' · ' + state.sessionId;
      updateTelemetry();
      break;

    case 'thinking':
      state.streaming = true;
      preambleDone = false;          // a fresh turn may open with its own line
      dom.stopBtn.hidden = false;
      dom.sendBtn.hidden = true;
      beginAssistant();
      syncOrb();
      break;

    case 'delta':
      if (!state.streaming) { state.streaming = true; dom.stopBtn.hidden = false; dom.sendBtn.hidden = true; }
      appendDelta(typeof msg.text === 'string' ? msg.text : '');
      syncOrb();
      break;

    case 'tool':
      if (msg.phase === 'start') {
        // Only the FIRST tool of a turn splits the bubble. toolDepth returns
        // to 0 after every tool, so it cannot be used for this — a second
        // lookup would chop the answer itself into fragments.
        if (!preambleDone) { preambleDone = true; sealPreamble(); }
        toolDepth++;
        noteTool(msg.name);
        flashHint(t().tool(String(msg.name || '')), true, 12000);
      }
      else {
        toolDepth = Math.max(0, toolDepth - 1);
        if (!toolDepth) { unlockHint(); clearHintTimer(); syncOrb(); }
        // She writes the calendar through conversation, so an open viewer must
        // pick that up rather than sit on stale rows.
        if (/calendar/i.test(String(msg.name || ''))) refreshCalendar();
      }
      break;

    case 'done':
      toolDepth = 0;
      unlockHint();
      flushTTS();
      endAssistant();
      // muted? then nothing will speak — reopen the mic straight away
      if (state.ttsPending === 0) setTimeout(maybeResumeVoiceLoop, 250);
      break;

    case 'error':
      toolDepth = 0;
      unlockHint();
      cancelSpeech();
      endAssistant(true);
      showAlert(typeof msg.message === 'string' && msg.message ? msg.message : t().errRec, true);
      state.resumeVoiceLoop = false;
      break;

    default:
      break; // unknown frame types are ignored, not fatal
  }
}

var connCountdown = 0;

export function onConn(next, retryMs) {
  state.conn = next;
  dom.conn.setAttribute('data-state', next);
  clearInterval(connCountdown);

  if (next === 'online') {
    dom.connLabel.textContent = info ? t().online : t().connecting;
    dom.input.disabled = false;
    dom.sendBtn.disabled = false;
    if (recognitionAvailable()) dom.micBtn.disabled = false;
  } else if (next === 'connecting') {
    dom.connLabel.textContent = t().connecting;
    dom.input.disabled = false;      // let people type while we reconnect
    dom.sendBtn.disabled = true;
  } else {
    // offline: degrade visibly instead of failing silently
    cancelSpeech();
    stopRecognition(true);
    endAssistant(true);
    dom.input.disabled = true;
    dom.sendBtn.disabled = true;
    dom.micBtn.disabled = true;
    var left = Math.ceil((retryMs || 0) / 1000);
    var paint = function () {
      dom.connLabel.textContent = left > 0 ? t().reconnecting(left) : t().offline;
      if (left-- <= 0) clearInterval(connCountdown);
    };
    paint();
    if (left > 0) connCountdown = setInterval(paint, 1000);
  }
  syncOrb();
}

export function submit(text) {
  var msg = String(text == null ? '' : text).trim();
  if (!msg) return;

  primeTTS();

  /* Commands are intercepted here — before the transport, before the log,
     before telemetry — so nothing about them reaches Kacey or the transcript.
     Checked on the typed path too, so the composer accepts them as well. */
  var cmd = window.KaceyClosing ? window.KaceyClosing.classify(msg) : null;
  if (cmd) {
    // The command IS the composer's contents here, so clear it outright.
    dom.input.value = '';
    clearBaseText();
    dom.input.classList.remove('is-interim');
    if (cmd === 'interrupt') bargeIn();
    else endListening();
    return;
  }

  cancelSpeech();                       // a new message always silences the old answer

  if (state.streaming) {
    transport.send({ type: 'interrupt' });
    endAssistant(true);
  }

  if (!transport.isOpen()) {
    showAlert(t().errOfflineSend);
    return;
  }

  noteTurn();

  addMessage('user', msg);
  dom.input.value = '';
  dom.input.classList.remove('is-interim');
  var ok = transport.send({ type: 'user_message', text: msg });
  if (!ok) showAlert(t().errOfflineSend);
  else syncOrb();
}

export function interrupt() {
  if (!state.streaming && state.ttsPending === 0) return;
  cancelSpeech();
  state.resumeVoiceLoop = false;
  if (state.streaming) transport.send({ type: 'interrupt' });
  endAssistant();
  flashHint(t().interrupted, false, 1800);
}

/* ---- the transport ------------------------------------------------------
   Owned here rather than in app.js: the pipeline is the only thing that talks
   to it, and `submit` has to be handed to the mock so ?say= can drive a turn. */

export function startTransport() {
  transport = MOCK
    ? makeMockTransport(onServer, onConn, submit)
    : makeSocketTransport(onServer, onConn);
  onConn('connecting');
  transport.start();
}

/* One frame out from a caller that is not submit(): the interrupt sent when the
   user talks over a reply. False if there is nowhere to send it. */
export function sendFrame(obj) {
  return !!transport && transport.send(obj);
}

export function stopTransport() { if (transport) transport.stop(); }

/* pagehide -> stop() is permanent, but pagehide also fires when the page enters
   the back/forward cache. pageshow revives it. */
export function resumeTransport() {
  if (transport && transport.resume) transport.resume();
}

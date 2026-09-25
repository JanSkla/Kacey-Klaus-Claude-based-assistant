/* =========================================================================
   Dictation — the microphone the user actually presses.

   One utterance per press: continuous is off, so the engine finalises after a
   pause and onend always fires. That single guarantee is what stops the UI ever
   looking "stuck listening", and every failure mode below routes through it.

   This is one of THREE recognisers in the app, and only one may hold the
   microphone at a time. See wake.js for the arbitration; the rule here is that
   dictation wins — it stops the barge-in listener before taking the device.
   ========================================================================= */

import { state, KIOSK } from '../core/state.js';
import { t } from '../core/i18n.js';
import * as dom from '../core/dom.js';
import { syncOrb } from '../ui/orb.js';
import { showAlert, flashHint } from '../ui/log.js';
import { cancelSpeech, primeTTS } from './tts.js';
import { stopBarge } from './barge.js';
import { submit } from '../net/protocol.js';
import { ServerRecognition, serverSttAvailable, serverSttKnown } from './server-stt.js';

/* Whether the browser has the API at all — read by the wake word, the barge-in
   listener and the mic button, none of which can work without it. */
export var SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;

/* Dictation's engine: the browser's own, or — where there is none (the bedside
   kiosk's Epiphany) or on the kiosk, or when asked with ?stt=server — the
   server's Whisper (server-stt.js), which has the same shape. Only dictation
   uses it: the wake word and barge-in need a continuous native engine and keep
   asking for SR / nativeAvailable(). */
var PREFER_SERVER = KIOSK || /(?:^|[?&])stt=server(?:&|$)/.test(location.search);
function engine() {
  if (serverSttKnown() && (PREFER_SERVER || !SR)) return ServerRecognition;
  return SR;
}
/* Whether Whisper is there is only known after one request; when it is, the
   mic becomes usable on a page that had no engine at load. */
serverSttAvailable().then(function (ok) {
  if (!ok || !dom.micBtn) return;
  if (!SR) {
    dom.micBtn.disabled = false;
    dom.micBtn.removeAttribute('data-unavailable');
  }
  if (!recBlocked) dom.micNote.textContent = t().micHint;
});

var rec = null;
var recBlocked = false;    // permission denied / hardware missing -> stop offering it
var baseText = '';         // whatever the user had typed before dictating

export function recognitionAvailable() { return !!engine() && !recBlocked; }
/** The browser's own engine — what the wake word and barge-in need. */
export function nativeAvailable() { return !!SR && !recBlocked; }
export function micBlocked() { return recBlocked; }

/* The composer prefix is dictation's own state: submit() has to be able to drop
   it when it clears the box, or it gets prepended to the next request. */
export function clearBaseText() { baseText = ''; }

/* ---- where dictated text goes ------------------------------------------
   By default a finished utterance is submitted to Kacey. The journal takes the
   microphone for a different purpose — the words are the journal entry, not a
   request — so it registers a sink and gets the text instead. One sink at a
   time, and clearing it puts the composer back in charge. */

var sink = null;

export function setDictationSink(fn) { sink = typeof fn === 'function' ? fn : null; }
export function dictationSink() { return sink; }

function buildRecognition() {
  var Engine = engine();
  if (!Engine) return null;
  var r = new Engine();
  r._engine = Engine;
  r.lang = state.lang;
  r.continuous = false;      // one utterance per press; onend always resets the UI
  r.interimResults = true;
  r.maxAlternatives = 1;

  r.onstart = function () {
    state.listening = true;
    dom.micBtn.setAttribute('aria-pressed', 'true');
    dom.micBtn.setAttribute('aria-label', t().micStop);
    dom.micNote.textContent = t().listenHold;
    syncOrb();
  };

  r.onaudiostart = function () { cancelSpeech(); };      // user talks -> we shut up
  r.onspeechstart = function () { cancelSpeech(); };

  r.onresult = function (ev) {
    var finalText = '', interim = '';
    for (var i = ev.resultIndex; i < ev.results.length; i++) {
      var alt = ev.results[i][0];
      if (!alt) continue;
      if (ev.results[i].isFinal) finalText += alt.transcript;
      else interim += alt.transcript;
    }
    if (sink) {
      // The journal wants continuous dictation, so it keeps the mic: no
      // submit, no hands-free loop, and the composer is left alone.
      if (interim) sink(interim, false);
      if (finalText.trim()) {
        sink(finalText.trim(), true);
        state.resumeVoiceLoop = false;
      }
      return;
    }
    if (interim) {
      dom.input.value = (baseText ? baseText + ' ' : '') + interim;
      dom.input.classList.add('is-interim');
    }
    if (finalText.trim()) {
      dom.input.classList.remove('is-interim');
      var text = (baseText ? baseText + ' ' : '') + finalText.trim();
      dom.input.value = text;
      baseText = '';
      state.micDesired = false;
      state.resumeVoiceLoop = true;     // keep the hands-free conversation going
      stopRecognition(false);
      submit(text);
    }
  };

  r.onerror = function (ev) {
    var code = (ev && ev.error) || 'unknown';
    switch (code) {
      case 'no-speech':
        flashHint(t().errNoSpeech, false, 3000);
        state.micDesired = false;
        state.resumeVoiceLoop = false;
        break;
      case 'aborted':
        break;                                   // we did it on purpose; stay quiet
      case 'not-allowed':
      case 'service-not-allowed':
        recBlocked = true;
        state.micDesired = false;
        state.resumeVoiceLoop = false;
        showAlert(t().errDenied);
        disableMic(t().errDenied);
        break;
      case 'audio-capture':
        recBlocked = true;
        state.micDesired = false;
        showAlert(t().errAudio);
        disableMic(t().errAudio);
        break;
      case 'network':
        state.micDesired = false;
        state.resumeVoiceLoop = false;
        showAlert(t().errNet);
        break;
      case 'language-not-supported':
        state.micDesired = false;
        showAlert(t().errRec);
        break;
      default:
        state.micDesired = false;
        state.resumeVoiceLoop = false;
        showAlert(t().errRec);
    }
    resetMicUI();
  };

  // Fires on every stop: manual, natural timeout, error, tab switch.
  // This is the one place that guarantees we never look "stuck listening".
  r.onend = function () {
    var wasSuspended = state.ttsSuspendedRec;
    resetMicUI();
    // An interim that never finalised is kept for the user to send or edit —
    // except a command, which clearStaleComposer strips. Left in place it
    // would be adopted as baseText next turn and prepended to the request.
    if (dom.input.classList.contains('is-interim')) clearStaleComposer();
    if (!wasSuspended && !state.resumeVoiceLoop) state.micDesired = false;
  };

  return r;
}

/* Clear the composer of things the user did not mean to leave there — but
   never a draft they typed themselves.

   Two ways rubbish accumulates: an interim transcript that never finalised
   (onend keeps those on purpose, so a half-heard sentence is not lost), and a
   command phrase, which is never a message. Either one is then adopted as
   baseText the next time dictation opens and prepended to the real request —
   which is how "ticho" ended up at the start of the following prompt. */
export function clearStaleComposer() {
  dom.input.classList.remove('is-interim');
  // Only ever a command. An unfinalised interim of real speech is worth more
  // than a clean box — "kolik mám dnes" left showing is a half-heard question
  // the user can finish, not rubbish.
  if (window.KaceyClosing && window.KaceyClosing.classify(dom.input.value)) {
    dom.input.value = '';
    baseText = '';
  }
}

function resetMicUI() {
  state.listening = false;
  dom.micBtn.setAttribute('aria-pressed', 'false');
  dom.micBtn.setAttribute('aria-label', t().micStart);
  if (!recBlocked && engine()) dom.micNote.textContent = t().micHint;
  syncOrb();
}

export function startRecognition() {
  if (!recognitionAvailable()) return;
  if (state.listening) return;
  // Only one recogniser may hold the microphone; the barge-in listener has to
  // let go before dictation can take it.
  stopBarge(true);
  cancelSpeech();
  // Rebuilt when the engine changed (Whisper turned out to be there).
  if (!rec || rec._engine !== engine()) rec = buildRecognition();
  if (!rec) return;
  rec.lang = state.lang;
  /* Whatever is in the composer becomes the prefix of this turn. A command
     must never qualify: it is not a message, and prepending it is exactly the
     bug where "ticho" turned up at the front of the next request. Belt and
     braces — the paths above already clear it, but this is the one line that
     decides, so the guard belongs here too. */
  baseText = dom.input.value.trim();
  if (baseText && window.KaceyClosing && window.KaceyClosing.classify(baseText)) {
    baseText = '';
    dom.input.value = '';
  }
  try {
    rec.start();
  } catch (e) {
    // InvalidStateError: engine still winding down. Rebuild and retry once.
    try { rec.abort(); } catch (e2) {}
    rec = buildRecognition();
    setTimeout(function () {
      if (!rec || state.listening) return;
      try { rec.start(); } catch (e3) { resetMicUI(); showAlert(t().errRec); }
    }, 220);
  }
}

export function stopRecognition(hard) {
  if (!rec) { resetMicUI(); return; }
  try { hard ? rec.abort() : rec.stop(); } catch (e) {}
  if (hard) resetMicUI();
}

export function disableMic(reason) {
  dom.micBtn.disabled = true;
  dom.micBtn.setAttribute('data-unavailable', 'true');
  dom.micNote.textContent = reason;
  resetMicUI();
}

export function toggleMic() {
  primeTTS();
  if (!recognitionAvailable()) return;
  if (state.listening || state.micDesired) {
    state.micDesired = false;
    state.resumeVoiceLoop = false;
    stopRecognition(true);
    return;
  }
  state.micDesired = true;
  startRecognition();
}

/* Hands-free loop: if the turn started with the voice, re-open the mic once
   the answer has been spoken. Only ever while visible + online. */
export function maybeResumeVoiceLoop() {
  if (!state.resumeVoiceLoop && !state.micDesired) return;
  if (document.hidden || state.conn !== 'online' || state.streaming || state.ttsPending > 0) return;
  if (state.listening || !recognitionAvailable()) return;
  state.resumeVoiceLoop = false;
  startRecognition();
}

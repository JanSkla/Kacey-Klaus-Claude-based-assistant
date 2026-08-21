/* =========================================================================
   WAKE WORD — "KC" opens dictation, and the arbitration behind it.

   Exactly one thing may hold the microphone. This module owns that decision:
   superviseWake() is the arbiter, and it picks between the two detectors —
   the voice-template engine in wake-panel.js when it has recordings to compare
   against, and the transcript listener below otherwise.

   The transcript listener is a SECOND SpeechRecognition instance, continuous,
   running only while idle. Rather than hooking every state transition
   (dictation start/stop, TTS, tab switch, reconnect), a 1.5s supervisor
   re-evaluates the conditions. That is dull but it cannot get wedged, which
   matters for something that is supposed to be listening whenever you are not.

   This module and wake-panel.js import each other on purpose: one arbiter, two
   engines, and the button label has to describe whichever one is live. Every
   crossing is a function call made long after both modules have loaded.
   ========================================================================= */

import { state, LS_WAKE } from '../core/state.js';
import { t } from '../core/i18n.js';
import * as dom from '../core/dom.js';
import { flashHint } from '../ui/log.js';
import { primeTTS } from './tts.js';
import { playWakeChime, WAKE_CHIME_MS } from './chime.js';
import { SR, recognitionAvailable, startRecognition } from './recognition.js';
import {
  voiceWakePriority, voiceWakeSupervise, voiceWakeStop, voiceWakeActive,
  refreshVoiceStateLabel, wakeMode, voiceStatus
} from './wake-panel.js';

var WAKE_ENABLED_DEFAULT = true;
var wakeRec = null;
var wakeRunning = false;
var wakeEnabled = WAKE_ENABLED_DEFAULT;
var wakeBlocked = false;      // permission/hardware refusal — stop retrying
var wakeBackoffUntil = 0;
var wakeHits = 0;

/* The voiceprint panel shares both flags: it is the same microphone, so a
   refusal there is a refusal here, and the panel has to grey itself out when
   the wake word is switched off. */
export function wakeIsEnabled() { return wakeEnabled; }
export function wakeIsBlocked() { return wakeBlocked; }
export function setWakeBlocked(yes) { wakeBlocked = !!yes; }

export function restoreWakePref() {
  try {
    var saved = localStorage.getItem(LS_WAKE);
    if (saved !== null) wakeEnabled = saved === '1';
  } catch (e) { /* private mode: the default is fine */ }
}

/* Czech ASR spells "KC" a dozen ways: KC, káčé, kács, káca, Kejsí, Kacey…
   Compare on a stripped form (lowercase, no diacritics, letters only) and match
   whole words, so "kdyby" or "akce" cannot trigger it.

   Entries must be lowercase and diacritic-free — normalizeHeard() strips both,
   so an entry like 'KC' or 'Casey' could never match anything.

   This list is the FALLBACK path. Chasing spellings cannot be made reliable
   for a two-syllable non-word; the voice-template detector in 6c is the real
   answer and takes over as soon as it has recordings to compare against. */
var WAKE_WORDS = [
  'kc', 'kace', 'kacee', 'kacey', 'kaca', 'kaci', 'kacka', 'kacko',
  'kejsi', 'kejsy', 'kejs', 'kejsej', 'kaces', 'kacs', 'casey', 'kejsis'
];

export function normalizeHeard(s) {
  var out = String(s || '').toLowerCase();
  if (out.normalize) out = out.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return out.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isWakePhrase(heard) {
  var n = normalizeHeard(heard);
  if (!n) return false;
  var words = n.split(' ');
  for (var i = 0; i < words.length; i++) {
    if (WAKE_WORDS.indexOf(words[i]) !== -1) return true;
  }
  // "k c" said as two letters
  return /(^|\s)k\s?c(\s|$)/.test(n);
}

function wakeShouldRun() {
  return wakeEnabled && !wakeBlocked && recognitionAvailable() &&
    !state.listening && !state.micDesired &&
    state.ttsPending === 0 &&            // never let it hear Kacey's own voice
    !document.hidden &&
    state.conn === 'online' &&
    Date.now() >= wakeBackoffUntil;
}

function buildWake() {
  if (!SR) return null;
  var r = new SR();
  r.lang = state.lang;
  r.continuous = true;         // keep listening; the engine still stops on its own
  r.interimResults = true;     // interim fires sooner, so the trigger feels instant
  r.maxAlternatives = 1;

  r.onstart = function () { wakeRunning = true; };

  r.onresult = function (ev) {
    var heard = '';
    for (var i = ev.resultIndex; i < ev.results.length; i++) {
      var alt = ev.results[i][0];
      if (alt) heard += ' ' + alt.transcript;
    }
    if (!heard.trim() || !isWakePhrase(heard)) return;

    wakeHits++;
    stopWake(true);
    // Hand the microphone over. micDesired keeps the supervisor from
    // immediately restarting the wake listener underneath dictation.
    state.micDesired = true;
    primeTTS();
    playWakeChime();
    // Wait out the chime as well as the engine release, so the confirmation
    // tone is not sitting inside the first moment of the recording.
    setTimeout(startRecognition, WAKE_CHIME_MS + 60);
  };

  r.onerror = function (ev) {
    var code = (ev && ev.error) || 'unknown';
    if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture') {
      wakeBlocked = true;                  // the mic itself is refused; stop asking
      applyWakeUI();
      return;
    }
    // no-speech and aborted are normal for an idle listener; network deserves a
    // pause so a flaky connection does not become a request storm.
    if (code === 'network') wakeBackoffUntil = Date.now() + 15000;
    else wakeBackoffUntil = Date.now() + 800;
  };

  r.onend = function () { wakeRunning = false; };
  return r;
}

function startWake() {
  if (wakeRunning || !wakeShouldRun()) return;
  if (!wakeRec) wakeRec = buildWake();
  if (!wakeRec) return;
  wakeRec.lang = state.lang;
  try {
    wakeRec.start();
    wakeRunning = true;
  } catch (e) {
    // InvalidStateError — engine winding down. Rebuild and let the supervisor retry.
    try { wakeRec.abort(); } catch (e2) {}
    wakeRec = buildWake();
    wakeRunning = false;
    wakeBackoffUntil = Date.now() + 600;
  }
}

function stopWake(hard) {
  if (!wakeRec) { wakeRunning = false; return; }
  try { hard ? wakeRec.abort() : wakeRec.stop(); } catch (e) {}
  wakeRunning = false;
}

/* Exactly one detector may hold the microphone. The voice-template detector
   wins whenever it is usable; the transcript path stays as the fallback for a
   browser without AudioWorklet, or before anything has been enrolled. */
export function superviseWake() {
  if (voiceWakePriority()) {
    if (wakeRunning) stopWake(true);
    voiceWakeSupervise();
    return;
  }
  voiceWakeStop();
  if (wakeShouldRun()) startWake();
  else if (wakeRunning) stopWake(true);
}

export function applyWakeUI() {
  if (!dom.wakeBtn) return;
  var on = wakeEnabled && !wakeBlocked;
  dom.wakeBtn.setAttribute('aria-pressed', String(on));
  var label = wakeBlocked ? t().wakeBlocked
    : !on ? t().wakeOff
    : voiceWakeActive() ? t().wakeOnVoice : t().wakeOn;
  dom.wakeBtn.setAttribute('aria-label', label);
  dom.wakeBtn.title = label + ' · ' + t().wakeCfgHint;
  dom.wakeBtn.disabled = !SR || wakeBlocked;
  refreshVoiceStateLabel();
}

export function toggleWake() {
  if (wakeBlocked) return;
  wakeEnabled = !wakeEnabled;
  try { localStorage.setItem(LS_WAKE, wakeEnabled ? '1' : '0'); } catch (e) {}
  applyWakeUI();
  if (!wakeEnabled) stopWake(true);
  else { wakeBackoffUntil = 0; superviseWake(); }
  flashHint(wakeEnabled ? t().wakeOn : t().wakeOff, false, 2200);
}

/* ---- console surface --------------------------------------------------- */

export function wakeStatus() {
  return {
    enabled: wakeEnabled, running: wakeRunning, blocked: wakeBlocked,
    shouldRun: wakeShouldRun(), hits: wakeHits,
    mode: wakeMode(),
    voice: voiceStatus()
  };
}

/* Simulate what the engine would have heard, so the trigger path can be tested
   without a microphone. */
export function feedWake(text) {
  if (!isWakePhrase(text)) return false;
  stopWake(true);
  state.micDesired = true;
  playWakeChime();
  setTimeout(startRecognition, WAKE_CHIME_MS + 60);
  return true;
}

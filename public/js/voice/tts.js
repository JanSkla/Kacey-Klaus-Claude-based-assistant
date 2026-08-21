/* =========================================================================
   Speaking the reply out loud.

   Two engines behind one interface. The browser's speechSynthesis is instant
   and always there; the XTTS voices are synthesised locally by xtts_server.py
   and sound like a person, at the cost of a round trip per sentence. Which one
   is in use is a user preference, so every path here has to work for both.

   Three things this module is responsible for beyond making sound:
     - it never lets the microphone hear us. Dictation is stopped before an
       utterance starts and re-opened once the queue drains.
     - it never strands the orb in "speaking". Every finish path is guarded,
       including the engines that silently drop their end event.
     - it speaks sentences in the order they were produced, even though
       synthesis is asynchronous and slow.
   ========================================================================= */

import { state } from '../core/state.js';
import { t } from '../core/i18n.js';
import { syncOrb } from '../ui/orb.js';
import { showAlert, flashHint } from '../ui/log.js';
import { noteSynthMs } from '../ui/telemetry.js';
import { uiAudio } from './chime.js';
import { takeSentences } from './sentences.js';
import { noteSpoken, clearSpoken } from './barge.js';
import { stopRecognition, maybeResumeVoiceLoop } from './recognition.js';

var synth = window.speechSynthesis || null;
var ttsBuf = '';
var voices = [];
var ttsPrimed = false;

function loadVoices() {
  if (!synth) return;
  try { voices = synth.getVoices() || []; } catch (e) { voices = []; }
}
if (synth) {
  loadVoices();
  // getVoices() is empty until this fires in Chrome/Edge
  if ('onvoiceschanged' in synth) synth.onvoiceschanged = function () { loadVoices(); };
  else setTimeout(loadVoices, 400);
}

function pickVoice(lang) {
  if (!voices.length) loadVoices();
  if (!voices.length) return null;
  var want = lang.toLowerCase();
  var base = want.split('-')[0];
  var norm = function (v) { return (v.lang || '').replace('_', '-').toLowerCase(); };
  var pool = voices.filter(function (v) { return norm(v) === want; });
  if (!pool.length) pool = voices.filter(function (v) { return norm(v).indexOf(base) === 0; });
  if (!pool.length) {
    if (!state.voiceWarned) { state.voiceWarned = true; flashHint(t().errNoVoice(lang), false, 4500); }
    return null;
  }
  var local = pool.filter(function (v) { return v.localService; });
  return (local[0] || pool[0]);
}

/* A single <audio> element reused for every XTTS clip. It must be created AND
   played once inside a real user gesture — a freshly constructed Audio() is not
   unlocked by an earlier gesture on iOS, so playback would silently reject. */
var ttsEl = null;
var SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAABErAAABAAgAZGF0YQAAAAA=';

function audioEl() {
  if (!ttsEl) {
    ttsEl = new Audio();
    ttsEl.preload = 'auto';
  }
  return ttsEl;
}

/* Unlock audio on the first real user gesture (Safari/iOS refuse otherwise).
   Primes BOTH engines: speechSynthesis for the browser voice, and the shared
   <audio> element for the XTTS voices. */
export function primeTTS() {
  if (ttsPrimed) return;
  ttsPrimed = true;
  if (synth) {
    try {
      var u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      synth.speak(u);
    } catch (e) { /* non-fatal */ }
  }
  try {
    var a = audioEl();
    a.src = SILENT_WAV;
    var p = a.play();
    if (p && p.catch) p.catch(function () { /* still locked; reported on real use */ });
  } catch (e) { /* non-fatal */ }
  // The wake chime uses Web Audio, which needs its own unlock — otherwise the
  // very first confirmation after a page load would be silently swallowed.
  uiAudio();
}


// An XTTS voice does not need the browser engine at all, so only require
// `synth` when the browser voice is the one selected.
function ttsAvailable() { return state.voice !== 'browser' || !!synth; }

export function feedTTS(chunk) {
  if (!ttsAvailable() || state.muted) return;
  ttsBuf += chunk;
  var r = takeSentences(ttsBuf, false);
  ttsBuf = r.rest;
  for (var i = 0; i < r.sentences.length; i++) speakChunk(r.sentences[i]);
}

export function flushTTS() {
  if (!ttsAvailable() || state.muted) { ttsBuf = ''; return; }
  var r = takeSentences(ttsBuf, true);
  ttsBuf = '';
  for (var i = 0; i < r.sentences.length; i++) speakChunk(r.sentences[i]);
}

/* ---- XTTS voice ------------------------------------------------------
   The five studio voices chosen in the Voice Lab, synthesised locally by
   xtts_server.py. Sentences must be spoken in the order they were produced,
   but synthesis is slow and asynchronous, so each one is chained onto the
   previous rather than fired off in parallel. A generation token lets an
   interrupt orphan everything still queued. ---------------------------- */

var xttsChain = Promise.resolve();
var xttsToken = 0;
var xttsAudio = null;

function speakChunkXtts(text) {
  var token = xttsToken;
  noteSpoken(text);                  // self-hearing guard for the barge-in listener
  state.ttsPending++;
  syncOrb();

  var finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    state.ttsPending = Math.max(0, state.ttsPending - 1);
    syncOrb();
    if (state.ttsPending === 0) onAllSpeechDone();
  }

  xttsChain = xttsChain.then(function () {
    if (token !== xttsToken) { finish(); return; }
    return fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, voice: state.voice }),
    })
      .then(function (r) {
        if (!r.ok) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            throw new Error(j.error || ('HTTP ' + r.status));
          });
        }
        // real server-measured synthesis time, straight onto the rail
        var ms = r.headers.get('X-Tts-Ms');
        if (ms) noteSynthMs(ms);
        return r.blob();
      })
      .then(function (blob) {
        if (token !== xttsToken) { finish(); return; }
        return new Promise(function (resolve) {
          var a = audioEl();                  // the primed element, not a new one
          var url = URL.createObjectURL(blob);
          xttsAudio = a;
          a.onended = function () { URL.revokeObjectURL(url); finish(); resolve(); };
          a.onerror = function () { URL.revokeObjectURL(url); finish(); resolve(); };
          a.src = url;
          var p = a.play();
          if (p && p.catch) {
            p.catch(function (err) {
              // Autoplay refusal used to vanish here, which reads as "the app
              // has no sound". Say it out loud instead.
              URL.revokeObjectURL(url);
              showAlert(
                err && err.name === 'NotAllowedError'
                  ? 'Prohlížeč zablokoval přehrání zvuku. Klepni kamkoli do stránky a zkus to znovu.'
                  : 'Zvuk se nepodařilo přehrát: ' + (err && err.message ? err.message : '?'),
              );
              finish();
              resolve();
            });
          }
        });
      })
      .catch(function (err) {
        // One failed sentence must not strand the orb or stall the rest.
        showAlert(err && err.message ? err.message : t().errNoTTS);
        finish();
      });
  });
}

function speakChunk(text) {
  if (state.muted || !text || !text.trim()) return;
  if (state.voice !== 'browser') {
    // Feedback-loop guard applies to both engines.
    if (state.listening) { state.ttsSuspendedRec = true; stopRecognition(false); }
    return speakChunkXtts(text);
  }
  if (!synth) return;

  // Feedback-loop guard: never let the mic hear our own voice.
  if (state.listening) {
    state.ttsSuspendedRec = true;
    stopRecognition(false);
  }

  noteSpoken(text);                  // self-hearing guard for the barge-in listener

  var u;
  try { u = new SpeechSynthesisUtterance(text); } catch (e) { return; }
  u.lang = state.lang;
  var v = pickVoice(state.lang);
  if (v) u.voice = v;
  u.rate = 1.02; u.pitch = 1; u.volume = 1;

  var done = false, guard = 0;
  function finish() {
    if (done) return;
    done = true;
    clearTimeout(guard);
    state.ttsPending = Math.max(0, state.ttsPending - 1);
    syncOrb();
    if (state.ttsPending === 0) onAllSpeechDone();
  }
  u.onend = finish;
  u.onerror = finish;                       // includes 'interrupted' / 'canceled'
  // Watchdog: some engines silently drop onend. Never strand the orb in "speaking".
  guard = setTimeout(finish, 4000 + text.length * 130);

  state.ttsPending++;
  syncOrb();
  try { synth.speak(u); } catch (e) { finish(); }
}

export function cancelSpeech() {
  ttsBuf = '';
  clearSpoken();
  if (synth) { try { synth.cancel(); } catch (e) {} }
  // Orphan anything queued or in flight on the XTTS chain, and stop audio now.
  xttsToken++;
  if (xttsAudio) { try { xttsAudio.pause(); } catch (e) {} xttsAudio = null; }
  state.ttsPending = 0;
  syncOrb();
}

function onAllSpeechDone() {
  if (state.ttsSuspendedRec || state.resumeVoiceLoop) {
    state.ttsSuspendedRec = false;
    // short pause so the speaker tail does not get picked up
    setTimeout(maybeResumeVoiceLoop, 400);
  }
}


/* Whether the browser engine exists at all. The mute button and the voice
   picker both have to say so plainly rather than offering a dead control. */
export function hasSynth() { return !!synth; }

/* Silence the browser engine and nothing else. Used on pagehide, where the
   point is to stop the speakers, not to tidy up state the page is about to
   throw away — cancelSpeech() would repaint an orb nobody will see. */
export function stopSynth() {
  if (synth) { try { synth.cancel(); } catch (e) {} }
}

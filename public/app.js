/* =========================================================================
   Kacey — frontend entry point.

   Vanilla JS, native ES modules, no build step and no dependencies. The browser
   loads this one file and resolves the rest; there is nothing to compile and
   nothing to install.

   This file does one job: boot. Restore preferences, subscribe the orb's
   followers, wire the DOM, start the transport — in that order, because the
   order is the only part of it that can be wrong.

   Everything else is in js/, grouped by what a module talks to:

     core/   nothing outside itself
       state.js       the shared state bag, the storage keys, the mock switch
       i18n.js        every user-visible string, in both languages
       dom.js         the elements of the main chrome
       bus.js         where the orb's followers subscribe

     ui/     the DOM — what is on screen and how it is labelled
       orb.js         the state machine every other module reports into
       log.js         the transcript, the status line, the alert strip
       telemetry.js   the HUD rails
       labels.js      re-labelling the chrome when language or mute changes
       theme.js       one hue drives the whole interface
       voice-picker.js the voice select, and its fallback when XTTS is down
       calendar.js    the calendar viewer

     voice/  the microphone and the speakers, and who may hold them
       sentences.js   sentence boundaries — pure, no DOM, no state
       chime.js       the two confirmation sounds
       tts.js         speaking the reply aloud: browser engine or XTTS
       recognition.js dictation — the microphone the user presses
       commands.js    "to je vše" / "ticho" — said to the interface, not to Kacey
       barge.js       hearing "ticho" while she is still talking
       wake.js        the wake word, and which detector holds the microphone
       wake-panel.js  the voice-template detector and its tuning sheet

     net/    the wire
       transport-socket.js / transport-mock.js  two takes on one interface
       protocol.js    the frame pipeline both transports feed

     debug.js  window.kacey / window.kaceyWake — reaches across all four, which
               is exactly why it sits outside them.

   wake-voice.js, wake-worklet.js and closing.js are NOT modules. They stay
   classic scripts loaded before this one (see index.html) because the Node
   tests in test/ load them by evaluating the source, and the worklet is fetched
   by relative URL at runtime.
   ========================================================================= */

import { state, MOCK, LANGS, LS_LANG, LS_MUTED, LS_VOICE } from './js/core/state.js';
import { t } from './js/core/i18n.js';
import * as dom from './js/core/dom.js';
import * as bus from './js/core/bus.js';
import { syncOrb, startAmpLoop, stopAmpLoop } from './js/ui/orb.js';
import { followOrbHint } from './js/ui/log.js';
import { updateTelemetry } from './js/ui/telemetry.js';
import { applyLangToUI, applyMuteToUI } from './js/ui/labels.js';
import { cancelSpeech, primeTTS, stopSynth } from './js/voice/tts.js';
import {
  SR, toggleMic, startRecognition, stopRecognition, disableMic
} from './js/voice/recognition.js';
import { superviseBarge } from './js/voice/barge.js';
import { superviseWake, applyWakeUI, toggleWake, restoreWakePref } from './js/voice/wake.js';
import { initVoiceWake, openVoicePanel } from './js/voice/wake-panel.js';
import { initTheme } from './js/ui/theme.js';
import { initVoicePicker } from './js/ui/voice-picker.js';
import {
  submit, interrupt, startTransport, stopTransport, resumeTransport
} from './js/net/protocol.js';
import { initCalendar } from './js/ui/calendar.js';
import { installDebugSurface } from './js/debug.js';

/* =======================================================================
   1. THE ORB'S FOLLOWERS

   Registered first, and in this order, so nothing that runs during boot can
   change the orb before the things that track it are listening.
   ======================================================================= */

bus.on('orb', updateTelemetry);
bus.on('orb', superviseBarge);
bus.on('orb', followOrbHint);

/* =======================================================================
   2. PERSISTED PREFERENCES

   All defaults are usable, so a browser in private mode (where reading
   localStorage throws) is not a broken one.
   ======================================================================= */

try {
  var savedLang = localStorage.getItem(LS_LANG);
  if (savedLang && LANGS.indexOf(savedLang) !== -1) state.lang = savedLang;
  state.muted = localStorage.getItem(LS_MUTED) === '1';
  var savedVoice = localStorage.getItem(LS_VOICE);
  if (savedVoice) state.voice = savedVoice;
} catch (e) { /* private mode: defaults are fine */ }

restoreWakePref();     // the wake word owns its own key

/* =======================================================================
   3. WIRING

   initVoiceWake() before initTheme(): both register a capture-phase Escape
   handler, and with the voiceprint sheet open on top of Settings the inner one
   has to win. Whoever registers first gets to stop propagation.
   ======================================================================= */

initVoicePicker();
initVoiceWake();
initTheme();           // restores the hue, wires the dial, paints once
initCalendar();

dom.form.addEventListener('submit', function (ev) {
  ev.preventDefault();
  submit(dom.input.value);
});

dom.input.addEventListener('input', function () {
  dom.input.classList.remove('is-interim');
  state.resumeVoiceLoop = false;      // typing opts out of the hands-free loop
});

dom.sendBtn.addEventListener('click', primeTTS);
// Any first interaction counts — tapping the orb or the page is enough, so a
// voice-only user who never touches the send button still gets audio unlocked.
document.addEventListener('pointerdown', primeTTS, { once: true });
document.addEventListener('keydown', primeTTS, { once: true });
dom.stopBtn.addEventListener('click', interrupt);
dom.micBtn.addEventListener('click', toggleMic);

dom.muteBtn.addEventListener('click', function () {
  state.muted = !state.muted;
  try { localStorage.setItem(LS_MUTED, state.muted ? '1' : '0'); } catch (e) {}
  if (state.muted) cancelSpeech(); else primeTTS();
  applyMuteToUI();
});

dom.langSel.addEventListener('change', function () {
  var v = dom.langSel.value;
  if (LANGS.indexOf(v) === -1) return;
  state.lang = v;
  try { localStorage.setItem(LS_LANG, v); } catch (e) {}
  state.voiceWarned = false;
  cancelSpeech();
  applyLangToUI();
  if (state.listening) {           // restart recognition in the new language
    stopRecognition(true);
    setTimeout(function () { if (state.micDesired) startRecognition(); }, 260);
  }
  syncOrb();
});

/* ---- the wake button --------------------------------------------------- */

if (dom.wakeBtn) {
  /* Long-press reaches the voiceprint panel. A sixth icon in the top bar would
     crowd it, and the panel is also reachable from Settings. */
  var lpTimer = 0, lpFired = false;
  dom.wakeBtn.addEventListener('pointerdown', function () {
    lpFired = false;
    clearTimeout(lpTimer);
    lpTimer = setTimeout(function () { lpFired = true; openVoicePanel(true); }, 550);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (evName) {
    dom.wakeBtn.addEventListener(evName, function () { clearTimeout(lpTimer); });
  });
  // Registered before the toggle below, so it can cancel it.
  dom.wakeBtn.addEventListener('click', function (ev) {
    if (!lpFired) return;
    lpFired = false;
    ev.preventDefault();
    ev.stopImmediatePropagation();
  });

  dom.wakeBtn.addEventListener('click', toggleWake);
  applyWakeUI();
  // Dull but unwedgeable: re-evaluate rather than hooking every transition
  // (dictation start/stop, TTS, tab switch, reconnect, engine timeout).
  setInterval(superviseWake, 1500);
  superviseWake();
}

/* Barge-in gets its own, faster supervisor — and one that does not depend on
   the wake button existing, since it has nothing to do with it.

   syncOrb alone was not enough, and that is why "ticho" only worked after the
   reply: the single start attempt lands in the exact window where dictation
   has been told to stop but its onend has not fired yet, so the microphone is
   still taken and the start is refused. Nothing then asked again. A reply
   lasts seconds, so this polls in fractions of one. */
setInterval(superviseBarge, 300);

/* ---- global keys and page lifecycle ----------------------------------- */

document.addEventListener('keydown', function (ev) {
  if (ev.key === 'Escape') {
    if (state.listening) { toggleMic(); return; }
    interrupt();
  }
});

document.addEventListener('visibilitychange', function () {
  document.body.classList.toggle('is-hidden', document.hidden);
  if (document.hidden) {
    state.micDesired = false;
    stopRecognition(true);           // mobile browsers kill it anyway
    stopAmpLoop();
  } else {
    startAmpLoop();
  }
});

dom.reduceMotion.addEventListener && dom.reduceMotion.addEventListener('change', function () {
  if (dom.reduceMotion.matches) stopAmpLoop(true);
  else startAmpLoop();
});

window.addEventListener('pagehide', function () {
  stopSynth();
  stopRecognition(true);
  stopTransport();
});

// Restored from the back/forward cache (or a hidden pane that fired pagehide):
// pagehide killed the transport permanently, so bring it back.
window.addEventListener('pageshow', resumeTransport);

/* =======================================================================
   4. BOOT
   ======================================================================= */

/* Mic availability is decided once, up front — never show a dead button.
   Speech recognition needs a secure context. Served from a desktop over plain
   http://<lan-ip> the API often exists but silently never fires, which reads as
   a broken mic rather than a browser policy — so say so plainly instead. */
if (!SR) disableMic(t().errUnsupported);
else if (!window.isSecureContext) disableMic(t().errInsecure);

applyLangToUI();
if (MOCK) dom.mockBadge.hidden = false;
// the page can be loaded while already backgrounded — visibilitychange never fires then
document.body.classList.toggle('is-hidden', document.hidden);

startTransport();
syncOrb();

installDebugSurface();
